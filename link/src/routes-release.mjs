// Read-only release channel routes (client update contract v1).

import { json } from "./util.mjs";

/** WHAT: Routes one signed release object from R2 with its exact content type. WHY: Prevents a tampered or missing artifact from installing. */
export async function handleReleaseRoutes({ request, env, url }) {
  if (!url.pathname.startsWith("/releases/") || request.method !== "GET") return null;
  const key = url.pathname.slice("/releases/".length);
  if (!/^[\w./-]{1,200}$/u.test(key) || key.includes("..")) {
    return json(null, 400, { error: "release-key-invalid" });
  }
  const object = await env.LINK_RELEASES.get(key);
  if (!object) return json(null, 404, { error: "release-not-found" });
  const type = key.endsWith(".apk")
    ? "application/vnd.android.package-archive"
    : key.endsWith(".sig")
      ? "text/plain; charset=utf-8"
      : "application/json";
  return new Response(object.body, {
    headers: {
      "content-type": type,
      "cache-control": key.endsWith(".apk") ? "public, max-age=3600" : "no-store",
    },
  });
}
