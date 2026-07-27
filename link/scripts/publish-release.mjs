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

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
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
  const manifestName = `agentmux-link/${channel}/manifest-v1.json`;
  writeFileSync(join(outDir, "manifest-v1.json"), JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(join(outDir, "manifest-v1.json.sig"), `${signature}\n`, "utf8");
  if (process.argv.includes("--dry")) {
    console.log(JSON.stringify({ dry: true, manifest: payload, signature }, null, 2));
    return;
  }
  execFileSync("npx", ["wrangler", "r2", "object", "put", `link-releases/${manifestName}`, "--file", join(outDir, "manifest-v1.json"), "--content-type", "application/json"], { stdio: "inherit" });
  execFileSync("npx", ["wrangler", "r2", "object", "put", `link-releases/${manifestName}.sig`, "--file", join(outDir, "manifest-v1.json.sig"), "--content-type", "text/plain"], { stdio: "inherit" });
  execFileSync("npx", ["wrangler", "r2", "object", "put", `link-releases/agentmux-link/${channel}/app-${versionCode}.apk`, "--file", apkPath, "--content-type", "application/vnd.android.package-archive"], { stdio: "inherit" });
  console.log(`published ${basename(apkPath)} as ${channel} versionCode ${versionCode}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main();

export const __keygen = () => generateKeyPairSync("ed25519");
