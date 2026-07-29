// Auth routes: the v1d identity leg and the app exchange leg.

import { beginLinkLogin, completeLinkLogin, issueSession } from "./auth.mjs";
import { targetsForApp, privateDiscoveryUrlsForApp } from "./config.mjs";
import { json, pkceChallenge, randomId, sha256Hex } from "./util.mjs";

/** WHAT: Routes one auth request through login, callback, exchange, or revoke. WHY: Keeps the two PKCE legs behind one handler. */
export async function handleAuthRoutes({ request, env, store, url, nowMs }) {
  if (url.pathname === "/auth/start" && request.method === "GET") {
    const challenge = String(url.searchParams.get("challenge") || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(challenge)) return json(null, 400, { error: "challenge-required" });
    return Response.redirect(await beginLinkLogin({ env, challenge, client: "android" }), 302);
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const completed = await completeLinkLogin({ env, url });
    if (!completed.ok) return json(null, 403, { error: completed.reason });
    const allowed = await store.identityFor(completed.principal.identityId);
    if (!allowed) return json(null, 403, { error: "identity-not-allowed" });
    const code = `xch_${randomId(24)}`;
    await store.insertExchangeCode({
      codeHash: await sha256Hex(code),
      challenge: completed.challenge,
      identityId: completed.principal.identityId,
      verifiedEmail: completed.principal.email || "",
      nowMs,
      ttlSeconds: Number(env.EXCHANGE_CODE_TTL_SECONDS) || 60,
    });
    const target = new URL("agentmux://auth");
    target.searchParams.set("code", code);
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Agentmux Link</title>`
      + `<p>Login klart. <a href="${target}">Öppna Agentmux Link</a></p>`
      + `<script>location.href=${JSON.stringify(target.toString())}</script>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (url.pathname === "/auth/exchange" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const code = String(body.code || "");
    const verifier = String(body.verifier || "");
    if (!code || !/^[A-Za-z0-9_-]{32,128}$/u.test(verifier)) {
      return json(null, 400, { error: "code-and-verifier-required" });
    }
    const taken = await store.takeExchangeCode(await sha256Hex(code), await pkceChallenge(verifier), nowMs);
    if (!taken) return json(null, 403, { error: "code-invalid-or-used" });
    if (taken.verifiedEmail) {
      const existing = await store.bindingFor(taken.identityId);
      if (existing && existing.verifiedEmail !== taken.verifiedEmail) {
        return json(null, 409, { error: "identity-already-bound" });
      }
      if (!existing) {
        await store.bindOnce({ identityId: taken.identityId, verifiedEmail: taken.verifiedEmail, nowMs });
      }
    }
    const session = await issueSession({
      store,
      identityId: taken.identityId,
      nowMs,
      ttlSeconds: Number(env.SESSION_TTL_SECONDS) || 2_592_000,
    });
    return json(null, 200, {
      session,
      identityId: taken.identityId,
      targets: targetsForApp(env),
      privateDiscoveryUrls: privateDiscoveryUrlsForApp(env),
    });
  }

  if (url.pathname === "/auth/revoke" && request.method === "POST") {
    const header = request.headers.get("authorization") || "";
    const match = /^Bearer\s+(lnk_\S+)$/u.exec(header.trim());
    if (match) await store.revokeSession(await sha256Hex(match[1]), nowMs);
    return json(null, 200, { ok: true });
  }

  return null;
}
