// Official Codex subscription quota read through the local app-server.
//
// This starts no model turn. CODEX_HOME binds each read to one provider-owned
// login profile, and only normalized identity/limits leave this module.

import { spawn } from "node:child_process";
import readline from "node:readline";
import { quotaObservation } from "./quota-observation.mjs";

/** WHAT: Defines official Codex observation provenance. WHY: Keeps it distinct from rollout fallback. */
export const CODEX_APP_SERVER_SOURCE = "codex.app_server.rate_limits";
const REQUEST_IDS = Object.freeze({ initialize: 1, account: 2, limits: 3 });

const isoFromEpoch = (value) => Number.isFinite(Number(value))
  ? new Date(Number(value) * 1000).toISOString()
  : null;

const windowsFor = (snapshot) => ["primary", "secondary"].flatMap((id) => {
  const window = snapshot?.[id];
  if (!window || !Number.isFinite(Number(window.usedPercent))) return [];
  return [{
    id,
    usedPercent: Number(window.usedPercent),
    windowMinutes: Number.isFinite(Number(window.windowDurationMins))
      ? Number(window.windowDurationMins) : null,
    resetsAt: isoFromEpoch(window.resetsAt),
  }];
});

/** WHAT: Normalizes Codex account limits. WHY: Keeps app-server wire fields out of shared consumers. */
export function normalizeCodexAppServerQuota(profile, accountResult, rateLimitResult, observedAt) {
  const account = accountResult?.account;
  if (!account) {
    return { ok: false, engine: "codex", provider: "codex",
      profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
      error: "login_required" };
  }
  const snapshots = Object.values(rateLimitResult?.rateLimitsByLimitId || {});
  const fallback = rateLimitResult?.rateLimits;
  if (fallback && !snapshots.some((row) => row?.limitId === fallback.limitId)) snapshots.push(fallback);
  const limits = snapshots.flatMap((snapshot) => {
    const windows = windowsFor(snapshot);
    return windows.length ? [{
      capturedAt: observedAt,
      limitId: snapshot.limitId || "codex",
      limitName: snapshot.limitName || null,
      planType: snapshot.planType || account.planType || null,
      windows,
    }] : [];
  }).sort((left, right) => Number(right.limitId === "codex") - Number(left.limitId === "codex"));
  if (!limits.length) {
    return { ok: false, engine: "codex", provider: "codex",
      profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
      account: { email: account.email || null, plan: account.planType || null },
      error: "no_rate_limits" };
  }
  const headlineLimit = limits.find((row) => row.limitId === "codex") ?? limits[0];
  const headline = headlineLimit.windows.find((row) => row.windowMinutes === 10_080)
    ?? headlineLimit.windows[0];
  return {
    ok: true,
    engine: "codex",
    provider: "codex",
    profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
    account: { email: account.email || null, plan: account.planType || null },
    observation: quotaObservation({
      source: CODEX_APP_SERVER_SOURCE,
      observedAt,
      usedPercent: headline.usedPercent,
      resetsAt: headline.resetsAt,
    }),
    limits,
  };
}

const protocolRead = (profile, {
  spawnImpl = spawn,
  timeoutMs = 12_000,
  env = process.env,
} = {}) => new Promise((resolve) => {
  let child;
  try {
    child = spawnImpl("codex", ["app-server", "--listen", "stdio://"], {
      env: { ...env, CODEX_HOME: profile.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    resolve({ ok: false, error: "app_server_unavailable" });
    return;
  }

  let settled = false;
  let initialized = false;
  let timer = null;
  const responses = new Map();
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    lines.close();
    child.kill?.("SIGTERM");
    resolve(result);
  };
  const send = (message) => {
    try { child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { finish({ ok: false, error: "app_server_write_failed" }); }
  };
  const protocolError = (message, fallback) => {
    const detail = JSON.stringify(message?.error || {});
    return /(?:401|auth|login|token)/iu.test(detail) ? "login_required" : fallback;
  };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id == null) return;
    responses.set(message.id, message);
    if (message.id === REQUEST_IDS.initialize && !initialized) {
      if (message.error || !message.result) {
        finish({ ok: false, error: "app_server_initialize_failed" });
        return;
      }
      initialized = true;
      send({ method: "initialized", params: {} });
      send({ method: "account/read", id: REQUEST_IDS.account, params: { refreshToken: true } });
      send({ method: "account/rateLimits/read", id: REQUEST_IDS.limits, params: null });
    }
    const account = responses.get(REQUEST_IDS.account);
    const limits = responses.get(REQUEST_IDS.limits);
    if (!account || !limits) return;
    if (account.error) finish({ ok: false, error: protocolError(account, "account_read_failed") });
    else if (limits.error) finish({ ok: false, error: protocolError(limits, "rate_limits_read_failed") });
    else finish({ ok: true, account: account.result, limits: limits.result });
  });
  child.on?.("error", () => finish({ ok: false, error: "app_server_unavailable" }));
  child.on?.("exit", () => finish({ ok: false, error: "app_server_exited" }));
  timer = setTimeout(() => finish({ ok: false, error: "app_server_timeout" }), timeoutMs);
  timer.unref?.();
  send({
    method: "initialize",
    id: REQUEST_IDS.initialize,
    params: { clientInfo: { name: "agentmux", title: "Agentmux", version: "1" } },
  });
});

/** WHAT: Reads one Codex profile without a model turn. WHY: Keeps quota checks cheap and exact. */
export async function readCodexAccountQuota(profile, options = {}) {
  const protocol = await protocolRead(profile, options);
  if (!protocol.ok) {
    return { ok: false, engine: "codex", provider: "codex",
      profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
      error: protocol.error };
  }
  const observedAt = new Date((options.now ?? Date.now)()).toISOString();
  return normalizeCodexAppServerQuota(profile, protocol.account, protocol.limits, observedAt);
}
