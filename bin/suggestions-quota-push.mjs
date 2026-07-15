#!/usr/bin/env node
// Push the local weekly-quota snapshot to the Suggestions board.
// Counterpart of the board's POST/GET /api/ops/quota: the board stores the
// latest snapshot and shows the hint only to the authority owner. Freshness
// is cron-paced by design ("behöver inte vara instant", Mattias 2026-07-15).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { createSuggestionsHttpClient } from "../core/suggestions-http.mjs";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "agent", "suggestions-quota-push.yaml");
const PUSH_TIMEOUT_MS = 15_000;

const expandHome = (value) =>
  typeof value === "string" && value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;

export function loadPushConfig(raw) {
  const parsed = yaml.load(raw);
  const baseUrl = typeof parsed?.baseUrl === "string" ? parsed.baseUrl.replace(/\/+$/u, "") : "";
  const credentialFile = expandHome(parsed?.adminCredentialFile);
  if (!baseUrl || typeof credentialFile !== "string" || !credentialFile) {
    throw new Error("config requires baseUrl and adminCredentialFile");
  }
  return { baseUrl, credentialFile };
}

export function quotaPushSummary(snapshot) {
  const engineState = (engine) =>
    snapshot[engine]?.ok ? `${engine} ok` : `${engine} ${snapshot[engine]?.error || "missing"}`;
  return `pushed quota snapshot (${engineState("claude")}, ${engineState("codex")})`;
}

export async function pushSuggestionsQuota({ config, token, snapshot,
  httpClient = createSuggestionsHttpClient({ source: "quota-push" }) }) {
  await httpClient.requestJson(`${config.baseUrl}/api/ops/quota`, {
    token,
    method: "POST",
    body: { version: 1, snapshot },
    timeoutMs: PUSH_TIMEOUT_MS,
    expectedStatus: 204,
    headers: { "user-agent": "agentmux-quota-push/1" },
  });
  return quotaPushSummary(snapshot);
}

async function main() {
  const configPath = process.argv[2] || DEFAULT_CONFIG_PATH;
  const config = loadPushConfig(readFileSync(configPath, "utf-8"));
  const token = readFileSync(config.credentialFile, "utf-8").trim();
  if (!token) throw new Error(`empty admin token in ${config.credentialFile}`);

  const snapshot = await readQuotaSnapshot();
  console.log(await pushSuggestionsQuota({ config, token, snapshot }));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && basename(invokedPath) === basename(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`suggestions-quota-push: ${error.message}`);
    process.exitCode = 1;
  });
}
