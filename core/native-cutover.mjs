import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { expandTilde, regenerateAgentsYaml } from "../sync.mjs";
import { nativeProjectKey } from "./native-runtime-client.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CUTOVER_SCHEMA_VERSION = 1;

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const clone = (value) => structuredClone(value);

export function normalizeCutoverRuntimeUrl(value) {
  const url = new URL(String(value || "http://127.0.0.1:8811"));
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("cutover runtime must be a plain loopback http origin");
  }
  return url.origin;
}

/** Preserve the pane source path under the field consumed by session-import. */
export function cutoverSessionEvidence(identity, sourceCwd, model, first) {
  if (!identity?.sessionId || !sourceCwd) throw new Error("cutover session evidence is incomplete");
  return {
    ...identity,
    sourceCwd,
    ...model,
    first,
    fresh: false,
  };
}

const paneCounts = (source) => {
  const claude = Number(source.panes ?? source.claude ?? (source.codex ? 0 : 1));
  const codex = Number(source.codex ?? 0);
  return { claude, codex, coding: claude + codex };
};

/** Pure fail-closed plan. No runtime, tmux or config state is changed here. */
export function planNativeCutover({
  sourceDoc,
  generatedConfig,
  names = [],
  all = false,
  runtimeUrl,
  manageServices = false,
  dropServices = false,
  dropShells = false,
} = {}) {
  const runtime = normalizeCutoverRuntimeUrl(runtimeUrl);
  const configuredNames = Object.keys(sourceDoc?.agents || {});
  const requested = all
    ? configuredNames.filter((name) => (sourceDoc.agents[name]?.backend ?? "tmux") !== "native")
    : [...new Set(names.map(String))];
  const blockers = [];
  const warnings = [];
  const targets = [];
  if (!all && requested.length === 0) blockers.push("choose one or more agents, or pass --all");

  for (const name of requested) {
    const source = sourceDoc?.agents?.[name];
    const generated = generatedConfig?.[name];
    if (!source || !generated) {
      blockers.push(`${name}: missing from ${!source ? "agentmux.yaml" : "agents.yaml"}`);
      continue;
    }
    if ((source.backend ?? "tmux") === "native") {
      blockers.push(`${name}: already uses the native backend`);
      continue;
    }
    const counts = paneCounts(source);
    if (![counts.claude, counts.codex, counts.coding].every(Number.isSafeInteger)
        || counts.claude < 0 || counts.codex < 0 || counts.coding < 1) {
      blockers.push(`${name}: invalid Claude/Codex pane counts`);
      continue;
    }
    const services = Array.isArray(source.services) ? source.services : [];
    const shells = Number(source.shells ?? 0);
    if (services.length && manageServices && dropServices) {
      blockers.push(`${name}: choose --manage-services or --drop-services, not both`);
    } else if (services.length && !dropServices && !manageServices) {
      blockers.push(`${name}: ${services.length} service pane(s) need --manage-services or --drop-services`);
    }
    if (shells > 0 && !dropShells) {
      blockers.push(`${name}: ${shells} shell pane(s) need --drop-shells`);
    }
    if (services.length && dropServices) warnings.push(`${name}: dropping ${services.length} service pane(s)`);
    if (services.length && manageServices) warnings.push(`${name}: moving ${services.length} service pane(s) to the native supervisor`);
    if (shells > 0 && dropShells) warnings.push(`${name}: dropping ${shells} shell pane(s)`);

    const generatedPanes = Array.isArray(generated.panes) ? generated.panes : [];
    const codingPanes = generatedPanes.slice(0, counts.coding);
    if (codingPanes.length !== counts.coding) {
      blockers.push(`${name}: generated config has ${codingPanes.length}/${counts.coding} coding panes`);
      continue;
    }
    const dir = expandTilde(source.dir);
    for (let pane = 0; pane < codingPanes.length; pane += 1) {
      const expectedEngine = pane < counts.claude ? "claude" : "codex";
      const cmd = String(codingPanes[pane]?.cmd || "");
      if (!cmd.includes(expectedEngine)) {
        blockers.push(`${name}:${pane}: generated command does not match ${expectedEngine}`);
      }
    }
    targets.push({
      name,
      dir,
      runtimeUrl: runtime,
      generatedId: generated.id,
      counts,
      services: [...services],
      shells,
      panes: codingPanes.map((paneConfig, pane) => ({
        pane,
        engine: pane < counts.claude ? "claude" : "codex",
        sourceCwd: join(dir, ".agents", String(pane)),
        paneConfig,
      })),
    });
  }
  return Object.freeze({ runtimeUrl: runtime, targets, blockers, warnings });
}

/** Materialize imported native ids into the source config. */
export function sourceAfterNativeCutover(sourceDoc, plan, importedIds, {
  dropServices = false,
  dropShells = false,
} = {}) {
  const next = clone(sourceDoc);
  for (const target of plan.targets) {
    const source = next.agents[target.name];
    const ids = importedIds[target.name];
    if (!ids || Object.keys(ids).length !== target.counts.coding) {
      throw new Error(`${target.name}: incomplete imported native id set`);
    }
    source.backend = "native";
    source.runtime = target.runtimeUrl;
    const adoptedIds = Object.fromEntries(Object.entries(ids)
      .filter(([, id]) => typeof id === "string" && id.length > 0)
      .sort(([left], [right]) => Number(left) - Number(right)));
    if (Object.keys(adoptedIds).length) source.nativeAgentIds = adoptedIds;
    else delete source.nativeAgentIds;
    if (dropServices) delete source.services;
    if (dropShells) delete source.shells;
    if (source.labels && typeof source.labels === "object") {
      source.labels = Object.fromEntries(Object.entries(source.labels)
        .filter(([index]) => Number(index) < target.counts.coding));
      if (!Object.keys(source.labels).length) delete source.labels;
    }
  }
  return next;
}

export function materializeCutoverConfigs({ sourceDoc, currentGeneratedYaml }) {
  const sourceYaml = yaml.dump(sourceDoc, { lineWidth: -1, quotingType: '"' });
  return {
    sourceYaml,
    generatedYaml: regenerateAgentsYaml(sourceYaml, currentGeneratedYaml),
  };
}

const atomicWrite = (path, content) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
};

/** Two-file write with an immediate byte-exact rollback on the second failure. */
export function writeCutoverConfigs({ sourcePath, generatedPath, sourceYaml, generatedYaml }) {
  const before = {
    sourceYaml: readFileSync(sourcePath, "utf8"),
    generatedYaml: readFileSync(generatedPath, "utf8"),
  };
  try {
    atomicWrite(sourcePath, sourceYaml);
    atomicWrite(generatedPath, generatedYaml);
  } catch (error) {
    atomicWrite(sourcePath, before.sourceYaml);
    atomicWrite(generatedPath, before.generatedYaml);
    throw error;
  }
  return before;
}

export function restoreCutoverConfigs({ sourcePath, generatedPath, sourceYaml, generatedYaml }) {
  atomicWrite(sourcePath, sourceYaml);
  atomicWrite(generatedPath, generatedYaml);
}

export function createCutoverReceipt({ plan, sourcePath, generatedPath, sourceYaml, generatedYaml }) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: CUTOVER_SCHEMA_VERSION,
    id: randomUUID(),
    status: "prepared",
    createdAt,
    updatedAt: createdAt,
    runtimeUrl: plan.runtimeUrl,
    targets: plan.targets.map((target) => ({
      name: target.name,
      dir: target.dir,
      services: target.services,
      panes: target.panes.map(({ pane, engine, sourceCwd }) => ({ pane, engine, sourceCwd })),
    })),
    paths: { sourcePath: resolve(sourcePath), generatedPath: resolve(generatedPath) },
    original: {
      sourceYaml,
      generatedYaml,
      sourceSha256: hash(sourceYaml),
      generatedSha256: hash(generatedYaml),
    },
    imports: {},
    phases: [{ at: createdAt, phase: "prepared" }],
  };
}

export function defaultCutoverReceiptDir() {
  return process.env.AMUX_CUTOVER_RECEIPT_DIR || join(homedir(), ".agentmux", "native-cutovers");
}

export function writeCutoverReceipt(receipt, path = null) {
  const receiptPath = path || join(defaultCutoverReceiptDir(), `${receipt.createdAt.replace(/[:.]/g, "-")}-${receipt.id}.json`);
  receipt.updatedAt = new Date().toISOString();
  atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  try { chmodSync(receiptPath, 0o600); } catch {}
  return receiptPath;
}

export function readCutoverReceipt(path) {
  const receipt = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (receipt?.schemaVersion !== CUTOVER_SCHEMA_VERSION || !receipt?.original?.sourceYaml
      || !receipt?.original?.generatedYaml) {
    throw new Error("unsupported or incomplete native cutover receipt");
  }
  return receipt;
}

export function recordCutoverPhase(receipt, phase, detail = {}) {
  const at = new Date().toISOString();
  receipt.status = phase;
  receipt.updatedAt = at;
  receipt.phases.push({ at, phase, ...detail });
  return receipt;
}

export async function nativeCutoverRequest(runtimeUrl, path, {
  method = "GET",
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${normalizeCutoverRuntimeUrl(runtimeUrl)}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      throw new Error(`native runtime ${payload?.error || `http-${response.status}`}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("native runtime request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureCutoverProject(target, fetchImpl = globalThis.fetch) {
  return nativeCutoverRequest(target.runtimeUrl, "/api/projects", {
    method: "POST",
    fetchImpl,
    body: {
      idempotencyKey: nativeProjectKey(target.name, { id: target.generatedId, dir: target.dir }),
      name: `AMUX · ${target.name}`,
      cwd: target.dir,
    },
  });
}
