// Lazy orientation is part of a real delivery, never a separate model turn.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readMemoryContext } from "./memory-context.mjs";
import { latestCodexSessionIdentity, readLastTurnsCodex } from "./codex-jsonl-reader.mjs";
import { latestKimiSessionIdentity, readLastTurnsKimi } from "./kimi-jsonl-reader.mjs";
import { isWorkDirective } from "./system-noise.mjs";

const READERS = {
  codex: { identity: latestCodexSessionIdentity, read: readLastTurnsCodex },
  kimi: { identity: latestKimiSessionIdentity, read: readLastTurnsKimi },
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const IDLE_MS = 30 * 60_000;

/** WHAT: Reads one engine's existing orientation identity. WHY: Keeps memory lookup from creating a pane or crossing into another session. */
export function createPaneMemorySnapshot({ configFor, dialectFor, workspace, readers = READERS } = {}) {
  return (name, pane) => {
    const engine = dialectFor(name, pane);
    // Claude already owns SessionStart/UserPromptSubmit; do not double-inject.
    const reader = readers[engine];
    if (!reader) return null;
    const dir = join(configFor(name).dir, ".agents", String(pane));
    const before = reader.identity(dir);
    if (!before?.sessionId) return null;
    const recent = reader.read(dir, { limit: 1, tailBytes: 1024 * 1024 });
    const after = reader.identity(dir);
    if (before.sessionId !== after?.sessionId || before.path !== after?.path
        || recent?.jsonlFile !== after.path) return null;
    return {
      engine, sessionId: after.sessionId, sessionPath: after.path,
      compactEpoch: recent.compactions?.at(-1)?.timestamp || null,
      context: readMemoryContext(workspace, { pane: `${name}:${pane}` }),
    };
  };
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

/** WHAT: Builds a bounded pointer for the next real queued prompt. WHY: Keeps retry bytes, original asks and receipt authority intact without waking dormant engines. */
export function createDeliveryMemoryContext({
  agent, queue, now = Date.now, log = () => {},
  stateDir = join(homedir(), ".agentmux", "memory-context", "delivery"),
} = {}) {
  const statePath = (key) => join(stateDir, `${key}.json`);

  function prepare(job) {
    if (job.kind !== "prompt" || !isWorkDirective(job.verifyText)
        || job.source === "drift-guard" || /^AMUX-PROBE /u.test(job.verifyText)
        || job.draftOwned || !["pending", "delivering"].includes(job.status)
        || job.metadata?.memoryContext || typeof agent.memorySnapshot !== "function") return job;
    try {
      const snapshot = agent.memorySnapshot(job.agentName, job.pane);
      if (!snapshot?.sessionId || !snapshot.sessionPath || !snapshot.context?.version) return job;
      const { context } = snapshot;
      const key = hash(JSON.stringify([context.workspace, job.agentName, job.pane,
        snapshot.engine, snapshot.sessionId, snapshot.sessionPath]));
      const previous = readState(statePath(key));
      // A compact marker can age out of the bounded tail; that is not a new epoch.
      const compactEpoch = snapshot.compactEpoch || previous?.compactEpoch || null;
      const hinted = !previous || previous.version !== context.version
        || previous.compactEpoch !== compactEpoch
        || now() - Number(previous.lastDeliveryAt || 0) >= IDLE_MS;
      const hint = `[amux orientation, memory ${context.version.slice(0, 16)}]\n`
        + `Before resuming old work, run amux memory context -p ${job.agentName}:${job.pane}. `
        + "Read only relevant sections and current repo instructions. The current request wins; do not revive old tasks or other panes.";
      if (Buffer.byteLength(hint) > 512) throw new Error("memory pointer exceeds 512 bytes");
      const memoryContext = {
        key, version: context.version, engine: snapshot.engine,
        sessionId: snapshot.sessionId, sessionPath: snapshot.sessionPath,
        compactEpoch, hinted, preparedAt: now(),
      };
      // Freeze the complete physical payload before any paste. verifyText and
      // the append-only ask ledger retain the original request byte for byte.
      return queue.update(job, {
        text: hinted ? `${job.text}\n\n${hint}` : job.text,
        metadata: { memoryContext },
      });
    } catch (error) {
      log(`memory orientation unavailable for ${job.agentName}:${job.pane}: ${error.message}`);
      return job; // Optional context must never block the user's actual message.
    }
  }

  function acknowledged(job) {
    const context = job.metadata?.memoryContext;
    if (job.status !== "acknowledged" || !/^[a-f0-9]{64}$/u.test(context?.key || "")) return;
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const path = statePath(context.key);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...context,
        lastDeliveryAt: job.acknowledgedAt, jobId: job.id,
      }) + "\n", { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      log(`memory orientation receipt unavailable for ${job.id}: ${error.message}`);
    }
  }

  return { prepare, acknowledged };
}
