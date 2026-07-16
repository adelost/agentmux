// Exact Cloudflare Durable Object rows-read observability. This module reports
// evidence only; it never attributes usage to a caller without request-level
// analytics or code proof.

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { createDeliveryQueue, waitForDeliveryJob } from "./delivery-queue.mjs";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const MAX_ANALYTICS_BYTES = 2 * 1024 * 1024;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const expandPath = (path, home) => String(path) === "~" ? home
  : String(path).startsWith("~/") ? resolve(home, String(path).slice(2)) : resolve(String(path));

export function loadSuggestionsUsageConfig(path, { home = homedir() } = {}) {
  let raw;
  try { raw = yaml.load(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`usage config: cannot read ${path}: ${error.message}`); }
  if (!isObject(raw)) throw new Error("usage config must be an object");
  const accountId = String(raw.accountId ?? "");
  const period = String(raw.period ?? "");
  const budgetRows = Number(raw.budgetRows);
  const warnAt = Number(raw.warnAt);
  const criticalAt = Number(raw.criticalAt);
  const agent = String(raw.agent ?? "");
  const pane = Number(raw.pane);
  const deliveryWaitMs = Number(raw.deliveryWaitMs ?? 12_000);
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw new Error("usage config accountId is invalid");
  if (!new Set(["daily", "monthly"]).has(period)) {
    throw new Error("usage config period must be daily or monthly");
  }
  classifyRowsReadUsage({ rowsRead: 0, budgetRows, warnAt, criticalAt });
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(agent) || !Number.isSafeInteger(pane)
    || pane < 0 || pane > 128) throw new Error("usage config agent/pane is invalid");
  if (!Number.isSafeInteger(deliveryWaitMs) || deliveryWaitMs < 0 || deliveryWaitMs > 60_000) {
    throw new Error("usage config deliveryWaitMs must be 0-60000");
  }
  return Object.freeze({ accountId, period, budgetRows, warnAt, criticalAt, agent, pane,
    deliveryWaitMs, credentialFile: expandPath(raw.credentialFile
      ?? "~/.config/agent/cloudflare-analytics-token", home) });
}

export function loadCloudflareAnalyticsCredential(path, { uid = process.getuid?.() } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new Error(`analytics credential: cannot stat ${path}: ${error.code || error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("analytics credential must be a regular non-symlink file");
  }
  if (uid != null && stat.uid !== uid) throw new Error("analytics credential owner is invalid");
  if ((stat.mode & 0o077) !== 0) throw new Error("analytics credential file must be mode 0600");
  const raw = readFileSync(path, "utf8");
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (raw !== token && raw !== `${token}\n`) throw new Error("analytics credential must be one line");
  if (token.length < 32 || token.length > 512 || /\s/u.test(token)) {
    throw new Error("analytics credential must be a bounded token");
  }
  return token;
}

export function usagePeriodWindow(period, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) throw new Error("usage timestamp is invalid");
  let start;
  if (period === "daily") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  } else if (period === "monthly") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else {
    throw new Error("usage period must be daily or monthly");
  }
  return {
    key: period === "daily" ? start.toISOString().slice(0, 10) : start.toISOString().slice(0, 7),
    start: start.toISOString(),
    end: now.toISOString(),
  };
}

export function classifyRowsReadUsage({ rowsRead, budgetRows, warnAt, criticalAt }) {
  if (!Number.isSafeInteger(rowsRead) || rowsRead < 0
    || !Number.isSafeInteger(budgetRows) || budgetRows < 1
    || !Number.isFinite(warnAt) || !Number.isFinite(criticalAt)
    || warnAt <= 0 || warnAt >= criticalAt || criticalAt >= 1) {
    throw new Error("rows-read usage policy is invalid");
  }
  const ratio = Math.round((rowsRead / budgetRows) * 10_000) / 10_000;
  const tier = ratio >= 1 ? "exhausted"
    : ratio >= criticalAt ? "critical"
      : ratio >= warnAt ? "warning" : "ok";
  return { tier, rowsRead, budgetRows, ratio,
    remainingRows: Math.max(0, budgetRows - rowsRead) };
}

const QUERY = `query DurableRowsRead($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: 10000
      ) {
        dimensions { namespaceId name }
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

const readBoundedText = async (response, maxBytes = MAX_ANALYTICS_BYTES) => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Cloudflare analytics response exceeds limit");
    }
    chunks.push(Buffer.from(value));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
};

export async function queryDurableObjectsRowsRead({
  accountId,
  token,
  period,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (!/^[0-9a-f]{32}$/u.test(accountId ?? "") || typeof token !== "string" || token.length < 32) {
    throw new Error("Cloudflare analytics account and credential are required");
  }
  const window = usagePeriodWindow(period, nowMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: {
        accountTag: accountId, start: window.start, end: window.end,
      } }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Cloudflare analytics request failed: ${error?.name === "AbortError"
      ? "timeout" : error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await readBoundedText(response);
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`Cloudflare analytics returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok || !isObject(payload) || Array.isArray(payload.errors) && payload.errors.length) {
    const message = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => String(error?.message ?? "unknown")).join("; ")
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare analytics query failed: ${message.slice(0, 240)}`);
  }
  const accounts = payload?.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) throw new Error("Cloudflare analytics account payload is missing");
  const totals = new Map();
  for (const row of accounts.flatMap((account) =>
    Array.isArray(account?.durableObjectsPeriodicGroups)
      ? account.durableObjectsPeriodicGroups : [])) {
    const namespaceId = String(row?.dimensions?.namespaceId ?? "");
    const name = String(row?.dimensions?.name ?? "");
    const rowsRead = Number(row?.sum?.rowsRead);
    const rowsWritten = Number(row?.sum?.rowsWritten);
    if (!namespaceId || !name || !Number.isSafeInteger(rowsRead) || rowsRead < 0
      || !Number.isSafeInteger(rowsWritten) || rowsWritten < 0) {
      throw new Error("Cloudflare analytics row payload is invalid");
    }
    const key = `${namespaceId}\0${name}`;
    const current = totals.get(key) ?? { namespaceId, name, rowsRead: 0, rowsWritten: 0 };
    current.rowsRead += rowsRead;
    current.rowsWritten += rowsWritten;
    totals.set(key, current);
  }
  const groups = [...totals.values()].sort((left, right) => right.rowsRead - left.rowsRead
    || left.namespaceId.localeCompare(right.namespaceId) || left.name.localeCompare(right.name));
  return {
    periodKey: window.key,
    start: window.start,
    end: window.end,
    rowsRead: groups.reduce((sum, group) => sum + group.rowsRead, 0),
    rowsWritten: groups.reduce((sum, group) => sum + group.rowsWritten, 0),
    groups,
  };
}

const count = (value) => Number(value).toLocaleString("en-US");

export function buildRowsReadAlert(snapshot) {
  const percent = Math.round(snapshot.ratio * 10_000) / 100;
  const top = snapshot.groups.slice(0, 5)
    .map((group) => `${group.name}=${count(group.rowsRead)}`)
    .join(", ");
  return {
    idempotencyKey: `suggestions-rows-read:${snapshot.periodKey}:${snapshot.tier}`,
    prompt: `[Suggestions rows-read ${snapshot.tier.toUpperCase()}]\n`
      + `Cloudflare Analytics visar ${count(snapshot.rowsRead)} / ${count(snapshot.budgetRows)} `
      + `rows read (${percent}%, ${count(snapshot.remainingRows)} kvar) för period ${snapshot.periodKey}.\n`
      + `Största observerade objekt: ${top || "inga grupper"}.\n`
      + "Orsaksattribution: okänd. Kräver request-level Cloudflare Analytics eller kodbevis. "
      + "Kontrollera last och circuit/backoff före cliffen.",
  };
}

export function createRowsReadAlertDeliverer({
  queue = createDeliveryQueue(),
  agent,
  pane,
  waitMs = 12_000,
} = {}) {
  return async ({ prompt, idempotencyKey, tier, periodKey }) => {
    const accepted = queue.enqueue({
      agentName: agent,
      pane,
      text: prompt,
      verifyText: prompt,
      kind: "prompt",
      source: "suggestions-rows-read",
      idempotencyKey,
      metadata: { tier, periodKey },
    });
    if (accepted.idempotencyKey !== idempotencyKey || accepted.text !== prompt
      || accepted.agentName !== agent || Number(accepted.pane) !== pane) {
      throw new Error("rows-read alert idempotency payload conflict");
    }
    const settled = await waitForDeliveryJob(queue, accepted.id, { timeoutMs: waitMs }) || accepted;
    if (settled.status !== "acknowledged" || !Number.isFinite(settled.acknowledgedAt)) {
      throw new Error(`rows-read alert remains ${settled.status}`);
    }
    return { jobId: accepted.id, acknowledgedAt: Number(settled.acknowledgedAt) };
  };
}

export async function observeDurableObjectsRowsRead({
  config,
  token,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  deliver,
} = {}) {
  const analytics = await queryDurableObjectsRowsRead({
    accountId: config.accountId,
    token,
    period: config.period,
    nowMs,
    fetchImpl,
  });
  const usage = classifyRowsReadUsage({ rowsRead: analytics.rowsRead,
    budgetRows: config.budgetRows, warnAt: config.warnAt, criticalAt: config.criticalAt });
  const snapshot = Object.freeze({ ...analytics, ...usage });
  if (usage.tier === "ok") return { snapshot, delivery: null };
  if (typeof deliver !== "function") throw new Error("rows-read warning has no delivery owner");
  const alert = { ...buildRowsReadAlert(snapshot), tier: usage.tier,
    periodKey: analytics.periodKey };
  return { snapshot, delivery: await deliver(alert) };
}
