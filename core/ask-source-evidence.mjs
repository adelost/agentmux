import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { authoredPromptText } from "./system-noise.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const ids = row => [...new Set([row.id, ...(row.observationIds || [])])];

/** WHAT: Reads a bounded native journal tail for positive source evidence. WHY: Keeps historical ambiguity from triggering unbounded journal rereads or hiding real asks. */
function nativeEvents(path, wantedTexts) {
  const size = statSync(path).size, start = Math.max(0, size - 16 * 1024 * 1024);
  const fd = openSync(path, "r"), bytes = Buffer.alloc(size - start);
  try { readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
  const lines = bytes.toString("utf8").split("\n");
  if (start) lines.shift();
  return lines.flatMap(line => {
    if (!line.includes('"user"')) return [];
    try {
      const row = JSON.parse(line);
      if (row.type === "user" && row.uuid && row.message?.role === "user") {
        const content = row.message.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
        const prompt = authoredPromptText(text);
        if (!wantedTexts.has(prompt)) return [];
        return [{ id: row.uuid, at: row.timestamp, text: prompt, scheduled: row.isMeta === true
          && (row.turnOrigin === "scheduled" || row.wakeupSource === "schedule_wakeup") && row.promptSource === "system",
        native: { isMeta: row.isMeta, turnOrigin: row.turnOrigin, wakeupSource: row.wakeupSource, promptSource: row.promptSource, scheduledTaskId: row.scheduledTaskId } }];
      }
      if (row.type === "event_msg" && row.payload?.type === "user_message" && wantedTexts.has(authoredPromptText(row.payload.message || ""))) return [{
        id: `codex:${row.timestamp}:${hash(row.payload.message || "")}`, at: row.timestamp,
        text: authoredPromptText(row.payload.message || ""), scheduled: false,
      }];
      return [];
    } catch { return []; }
  });
}

/** WHAT: Reads explicitly registered automation namespaces and their source hashes. WHY: Prevents arbitrary prompt wording from becoming an exclusion rule. */
export function readAskProducers(path = join(homedir(), ".agentmux", "ask-producers.json")) {
  let rows;
  try { rows = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!Array.isArray(rows)) throw Error("ask producers must be an array");
  return rows.filter(p => typeof p.keyPrefix === "string" && p.keyPrefix && p.sourceFile && p.sourceSha256 && p.authority).map(p => {
    try { return hash(readFileSync(p.sourceFile)) === p.sourceSha256 ? p : null; }
    catch { return null; }
  }).filter(Boolean);
}

/** WHAT: Builds positive native and transport provenance with proven event aliases. WHY: Keeps scheduled wakeups separate from human identities and unknown sources. */
export function resolveAskSourceEvidence(rows, { readNative = nativeEvents, producers = readAskProducers(),
  queueRoot = join(homedir(), ".agentmux", "delivery-queue"), readJob = path => JSON.parse(readFileSync(path, "utf8")) } = {}) {
  const files = new Map(), resolved = [];
  const wanted = new Map();
  for (const row of rows) for (const observed of [...(row.observations || []), { sessionFile: row.sessionFile }]) {
    if (!observed.sessionFile) continue;
    if (!wanted.has(observed.sessionFile)) wanted.set(observed.sessionFile, new Set());
    wanted.get(observed.sessionFile).add(authoredPromptText(row.verbatim));
  }
  for (const original of rows) {
    const row = { ...original, observationIds: ids(original), sourceEvidenceRead: true };
    if (row.deliveryId) {
      try {
        const path = join(queueRoot, `${encodeURIComponent(row.agent)}--p${row.pane}`, `${row.deliveryId}.json`);
        const job = readJob(path);
        const producer = producers.find(p => job.id === row.deliveryId && job.agentName === row.agent && Number(job.pane) === Number(row.pane)
          && job.text === row.verbatim && String(job.idempotencyKey || "").startsWith(p.keyPrefix));
        if (producer) row.originEvidence = { kind: "registered-producer", path, jobId: job.id, key: job.idempotencyKey,
          producer: producer.id, sourceFile: producer.sourceFile, sourceSha256: producer.sourceSha256, authority: producer.authority };
      } catch { /* No positive transport evidence means no source exclusion. */ }
    }
    const observations = [...(row.observations || []), { sessionFile: row.sessionFile, ts: row.ts }];
    const matches = [];
    for (const observed of observations) {
      if (!observed.sessionFile) continue;
      if (!files.has(observed.sessionFile)) {
        try { files.set(observed.sessionFile, readNative(observed.sessionFile, wanted.get(observed.sessionFile))); }
        catch { files.set(observed.sessionFile, []); }
      }
      for (const event of files.get(observed.sessionFile)) {
        if (event.text === authoredPromptText(row.verbatim) && Math.abs(Date.parse(event.at) - Date.parse(observed.ts)) <= 5000) matches.push({ ...event, path: observed.sessionFile });
      }
    }
    const unique = [...new Map(matches.map(m => [`${m.path}:${m.id}`, m])).values()];
    if (unique.length === 1) {
      const event = unique[0];
      row.nativeEvent = { path: event.path, id: event.id, at: event.at };
      if (event.scheduled) row.originEvidence = { kind: "native-scheduled", ...row.nativeEvent, fields: event.native };
    }
    const alias = row.nativeEvent && resolved.find(previous => previous.agent === row.agent && previous.pane === row.pane
      && previous.nativeEvent?.id === row.nativeEvent.id && previous.nativeEvent.path === row.nativeEvent.path);
    if (alias) {
      alias.observationIds = [...new Set([...ids(alias), ...ids(row)])];
      alias.originEvidence ||= row.originEvidence;
      if ((row.deliveryId && !alias.deliveryId) || (alias.source === "engine-backfill" && row.source !== "engine-backfill")) {
        alias.observationIds = [...new Set([...alias.observationIds, alias.id])];
        alias.id = row.id; alias.deliveryId = row.deliveryId; alias.source = row.source; alias.ts = row.ts;
        alias.deliveryPath = row.deliveryPath || alias.deliveryPath;
      }
    } else resolved.push(row);
  }
  return resolved;
}

/** WHAT: Returns source classification backed by native or registered transport evidence. WHY: Keeps source evidence separate from guesses about the prompt's wording. */
export function observedAskOrigin(ask, infer) {
  if (["native-scheduled", "registered-producer"].includes(ask.originEvidence?.kind)) return "system";
  const inferred = infer({ source: ask.source, sender: ask.sender, prompt: ask.verbatim });
  if (inferred === "human" && ask.sourceEvidenceRead
    && (ask.source === "cli" || ask.source === "engine-backfill" || (ask.source === "pane-hook" && !ask.nativeEvent))) return "unknown";
  return inferred;
}
