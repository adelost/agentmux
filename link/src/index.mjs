// Agentmux Link worker: thin route dispatcher (docs/link-internet-v1.md).

import { configured } from "./config.mjs";
import { createLinkStore } from "./store.mjs";
import { json } from "./util.mjs";
import { handleAuthRoutes } from "./routes-auth.mjs";
import { handleAppRoutes } from "./routes-app.mjs";
import { handleConnectorRoutes } from "./routes-connector.mjs";
import { handleReleaseRoutes } from "./routes-release.mjs";

const ROUTES = [handleReleaseRoutes, handleAuthRoutes, handleAppRoutes, handleConnectorRoutes];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      const ok = configured(env);
      return json(null, ok ? 200 : 503, { ok, service: "agentmux-link" });
    }
    const store = createLinkStore(env.LINK_DB);
    const nowMs = Date.now();
    for (const handler of ROUTES) {
      const response = await handler({ request, env, store, url, nowMs });
      if (response) return response;
    }
    return json(null, 404, { error: "route-not-found" });
  },
};
