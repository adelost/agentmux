// Release channel: canonical JSON, Ed25519 signature, and the read-only route.

import { expect, feature, component } from "bdd-vitest";
import worker from "./index.mjs";
import {
  buildReleasePayload, canonicalJson, signRelease, verifyPublishedRelease,
  verifyRelease, wranglerPutArgs, __keygen,
} from "../scripts/publish-release.mjs";
import { createTestDb } from "./testdb.mjs";

const NOW = "2026-07-28T12:00:00.000Z";
const PUBLIC_ORIGIN = "https://link.example.test";

feature("release payload and signature", () => {
  component("canonical JSON is stable and the signature verifies, tamper fails", {
    given: ["a payload and a keypair", () => {
      const { publicKey, privateKey } = __keygen();
      const payload = buildReleasePayload({
        apkBytes: Buffer.from("FAKE-APK"),
        versionCode: 42,
        versionName: "1.2.0",
        changelog: "test",
        createdAt: NOW,
        expiresAt: "2026-08-11T12:00:00.000Z",
        publicOrigin: PUBLIC_ORIGIN,
      });
      return { publicKey: publicKey.export({ type: "spki", format: "pem" }), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }), payload };
    }],
    when: ["signing and verifying intact and tampered", (ctx) => {
      const signature = signRelease(ctx.privateKey, ctx.payload);
      return {
        signature,
        payload: ctx.payload,
        ok: verifyRelease(ctx.publicKey, ctx.payload, signature),
        tampered: verifyRelease(ctx.publicKey, { ...ctx.payload, versionCode: 43 }, signature),
        wrongKey: verifyRelease(__keygen().publicKey.export({ type: "spki", format: "pem" }), ctx.payload, signature),
        canonicalTwice: canonicalJson(ctx.payload) === canonicalJson(ctx.payload),
      };
    }],
    then: ["exact verification contract", (r) => {
      expect(r.ok).toBe(true);
      expect(r.tampered).toBe(false);
      expect(r.wrongKey).toBe(false);
      expect(r.canonicalTwice).toBe(true);
      expect(r.payload.apk.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.payload.apk.url).toBe(`${PUBLIC_ORIGIN}/releases/agentmux-link/phone/app-42.apk`);
    }],
  });

  component("production upload is explicitly remote", {
    given: ["one release upload", () => ({
      step: { put: "link-releases/agentmux-link/phone/app-42.apk", contentType: "application/vnd.android.package-archive" },
      file: "/tmp/app.apk",
    })],
    when: ["building Wrangler arguments", (input) => wranglerPutArgs(input)],
    then: ["remote storage is mandatory", (args) => {
      expect(args).toContain("--remote");
      expect(args).toContain("link-releases/agentmux-link/phone/app-42.apk");
    }],
  });

  component("publication acknowledgement requires exact public bytes", {
    given: ["one signed public release", () => {
      const payload = buildReleasePayload({
        apkBytes: Buffer.from("APK"),
        versionCode: 42,
        versionName: "1.2.0",
        createdAt: NOW,
        expiresAt: "2026-08-11T12:00:00.000Z",
        publicOrigin: PUBLIC_ORIGIN,
      });
      const responses = new Map([
        ["manifest-v1.json", new Response(JSON.stringify(payload))],
        ["manifest-v1.json.sig", new Response("signature\n")],
        ["app-42.apk", new Response("APK")],
      ]);
      return {
        payload,
        signature: "signature",
        fetchImpl: async (url) => responses.get(url.split("/").at(-1)) || new Response("", { status: 404 }),
      };
    }],
    when: ["verifying the public channel", (input) => verifyPublishedRelease({
      ...input, channel: "phone", publicOrigin: PUBLIC_ORIGIN,
    })],
    then: ["all public bytes match", (result) => {
      expect(result).toBeUndefined();
    }],
  });
});

feature("release route", () => {
  component("serves manifest, sig, and apk with correct types and honest 404s", {
    given: ["an env with release objects", () => {
      const objects = new Map([
        ["agentmux-link/phone/manifest-v1.json", { body: "{\"schemaVersion\":1}" }],
        ["agentmux-link/phone/manifest-v1.json.sig", { body: "c2ln\n" }],
        ["agentmux-link/phone/app-42.apk", { body: "APK-BYTES" }],
      ]);
      return {
        env: {
          LINK_DB: createTestDb(),
          LINK_RELEASES: { get: async (key) => objects.get(key) || null },
        },
      };
    }],
    when: ["fetching all three plus a missing and a bad key", async ({ env }) => ({
      manifest: await worker.fetch(new Request("https://link.v1d.io/releases/agentmux-link/phone/manifest-v1.json"), env),
      sig: await worker.fetch(new Request("https://link.v1d.io/releases/agentmux-link/phone/manifest-v1.json.sig"), env),
      apk: await worker.fetch(new Request("https://link.v1d.io/releases/agentmux-link/phone/app-42.apk"), env),
      missing: await worker.fetch(new Request("https://link.v1d.io/releases/agentmux-link/nope.json"), env),
      badKey: await worker.fetch(new Request("https://link.v1d.io/releases/..%2Fsecret"), env),
    })],
    then: ["exact content types and fail-closed 404", async (r) => {
      expect(r.manifest.headers.get("content-type")).toBe("application/json");
      expect(r.sig.headers.get("content-type")).toContain("text/plain");
      expect(r.apk.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(r.apk.headers.get("cache-control")).toContain("max-age=3600");
      expect(await r.apk.text()).toBe("APK-BYTES");
      expect(r.missing.status).toBe(404);
      expect(r.badKey.status).toBe(400);
    }],
  });
});
