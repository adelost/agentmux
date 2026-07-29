// Publishes one signed app release to the public Link release channel.
// Usage: node link/scripts/publish-release.mjs --apk <path> --version-code N --version-name X [--changelog "..."] [--dry]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as signEd, verify as verifyEd, createPrivateKey, createPublicKey } from "node:crypto";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

/** WHAT: Formats one payload as canonical JCS-like JSON. WHY: Keeps every signer and verifier byte-identical. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const CHANNEL_PACKAGES = {
  phone: "io.agentmux.audioinbox",
  wear: "io.agentmux.audioinbox.wear",
};

/** WHAT: Builds the signed release payload for one APK and channel. WHY: Keeps the client contract exactly verifiable per device family. */
export function buildReleasePayload({ apkBytes, versionCode, versionName, changelog = "", createdAt, expiresAt, channel = "phone" }) {
  const packageName = CHANNEL_PACKAGES[channel];
  if (!packageName) throw new Error(`unknown release channel: ${channel}`);
  return {
    schemaVersion: 1,
    packageName,
    versionCode,
    versionName,
    apk: {
      url: `https://link.v1d.io/releases/agentmux-link/${channel}/app-${versionCode}.apk`,
      sizeBytes: apkBytes.length,
      sha256: createHash("sha256").update(apkBytes).digest("hex"),
    },
    changelog,
    createdAt,
    expiresAt,
  };
}

/** WHAT: Builds the Ed25519 signature for one payload with the ops key. WHY: Keeps release authority off the client device. */
export function signRelease(privateKeyPem, payload) {
  return signEd(null, Buffer.from(canonicalJson(payload), "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}

/** WHAT: Checks one signed release payload. WHY: Prevents a tampered manifest from ever installing. */
export function verifyRelease(publicKeyPem, payload, signatureB64) {
  return verifyEd(null, Buffer.from(canonicalJson(payload), "utf8"),
    createPublicKey(publicKeyPem), Buffer.from(String(signatureB64 || ""), "base64"));
}

/** WHAT: Builds the upload steps in immutable-first order. WHY: Prevents a fresh manifest from ever pointing at missing artifacts. */
export function releaseUploadPlan({ channel, versionCode }) {
  const manifestName = `agentmux-link/${channel}/manifest-v1.json`;
  return [
    { put: `link-releases/agentmux-link/${channel}/app-${versionCode}.apk`, contentType: "application/vnd.android.package-archive" },
    { put: `link-releases/${manifestName}.sig`, contentType: "text/plain" },
    { put: `link-releases/${manifestName}`, contentType: "application/json" },
  ];
}

/** WHAT: Builds one production R2 upload command. WHY: Prevents local Wrangler storage from impersonating the public channel. */
export function wranglerPutArgs({ step, file }) {
  return ["wrangler", "r2", "object", "put", step.put, "--remote",
    "--file", file, "--content-type", step.contentType];
}

/** WHAT: Reads the public release back after upload. WHY: Keeps publication acknowledgement behind exact public-byte proof. */
export async function verifyPublishedRelease({ payload, signature, channel, fetchImpl = fetch }) {
  const root = `https://link.v1d.io/releases/agentmux-link/${channel}`;
  const [manifestResponse, signatureResponse, apkResponse] = await Promise.all([
    fetchImpl(`${root}/manifest-v1.json`, { cache: "no-store" }),
    fetchImpl(`${root}/manifest-v1.json.sig`, { cache: "no-store" }),
    fetchImpl(payload.apk.url, { cache: "no-store" }),
  ]);
  if (!manifestResponse.ok || !signatureResponse.ok || !apkResponse.ok) {
    throw new Error(`public release verification failed: manifest=${manifestResponse.status} signature=${signatureResponse.status} apk=${apkResponse.status}`);
  }
  const publicPayload = await manifestResponse.json();
  const publicSignature = (await signatureResponse.text()).trim();
  const publicApk = Buffer.from(await apkResponse.arrayBuffer());
  const publicSha = createHash("sha256").update(publicApk).digest("hex");
  if (canonicalJson(publicPayload) !== canonicalJson(payload)) throw new Error("public release manifest mismatch");
  if (publicSignature !== signature) throw new Error("public release signature mismatch");
  if (publicApk.length !== payload.apk.sizeBytes || publicSha !== payload.apk.sha256) {
    throw new Error("public release apk mismatch");
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const apkPath = argValue("--apk");
  const versionCode = Number(argValue("--version-code"));
  const versionName = argValue("--version-name");
  const changelog = argValue("--changelog") || "";
  const keyPath = argValue("--key") || `${process.env.HOME}/.agentmux/secrets/link-release-ed25519.pem`;
  if (!apkPath || !Number.isInteger(versionCode) || !versionName) {
    throw new Error("usage: --apk <path> --version-code N --version-name X [--changelog ...] [--key path] [--dry]");
  }
  const channel = argValue("--channel") || "phone";
  const apkBytes = readFileSync(apkPath);
  const now = new Date();
  const payload = buildReleasePayload({
    apkBytes,
    versionCode,
    versionName,
    changelog,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString(),
    channel,
  });
  const signature = signRelease(readFileSync(keyPath, "utf8"), payload);
  const outDir = join(process.cwd(), ".link-release");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest-v1.json"), JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(join(outDir, "manifest-v1.json.sig"), `${signature}\n`, "utf8");
  if (process.argv.includes("--dry")) {
    console.log(JSON.stringify({ dry: true, manifest: payload, signature }, null, 2));
    return;
  }
  const plan = releaseUploadPlan({ channel, versionCode });
  const files = [apkPath, join(outDir, "manifest-v1.json.sig"), join(outDir, "manifest-v1.json")];
  for (const [index, step] of plan.entries()) {
    execFileSync("npx", wranglerPutArgs({ step, file: files[index] }), { stdio: "inherit" });
  }
  await verifyPublishedRelease({ payload, signature, channel });
  console.log(`published ${basename(apkPath)} as ${channel} versionCode ${versionCode}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();

export const __keygen = () => generateKeyPairSync("ed25519");
