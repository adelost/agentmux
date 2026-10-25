import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createState } from "./state.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const store = (root, project, cycle) => createState(join(root, `${project}-${cycle.at}.json`));

/** WHAT: Returns a bounded page of immutable answer identities and full-text references. WHY: Keeps a large canonical answer set below transport buffers without losing records or rereading it per page. */
export function onTrackAnswerPage({ root, project, cycle, cursor = null, readEntries, now = Date.now() }) {
  const state = store(root, project, cycle);
  let selection;
  if (cursor) {
    if (!/^[A-Za-z0-9_-]{1,1000}$/u.test(cursor)) throw Error("invalid answer cursor");
    selection = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!/^[a-f0-9-]{36}$/u.test(selection.snapshot || "")) throw Error("invalid answer snapshot identity");
  } else {
    selection = { snapshot: randomUUID(), offset: 0 };
    const entries = readEntries();
    state.updateKey("index", old => {
      const data = old || { records: {}, snapshots: {} };
      const ids = [];
      for (const p of entries) {
        data.records[p.id] = { id: p.id, at: p.ts, agent: p.agent, pane: p.pane, source: p.ledgerPath,
          messageId: p.messageId, textPreview: Array.from(String(p.text || "")).slice(0, 160).join(""), textBytes: Buffer.byteLength(p.text || ""), textSha256: hash(p.text || "") };
        ids.push(p.id);
      }
      data.snapshots[selection.snapshot] = { at: new Date(now).toISOString(), ids };
      return data;
    });
  }
  const data = state.get("index"), snapshot = data?.snapshots[selection.snapshot];
  if (!snapshot || !Number.isSafeInteger(selection.offset) || selection.offset < 0 || selection.offset > snapshot.ids.length) throw Error("answer snapshot or cursor is unavailable");
  const answers = []; let bytes = 1024, offset = selection.offset;
  for (; offset < snapshot.ids.length; offset++) {
    const answer = data.records[snapshot.ids[offset]], size = Buffer.byteLength(JSON.stringify(answer)) + 1;
    if (bytes + size > 128 * 1024) { if (!answers.length) throw Error("single answer reference exceeds page bound"); break; }
    answers.push(answer); bytes += size;
  }
  const nextCursor = offset < snapshot.ids.length ? Buffer.from(JSON.stringify({ snapshot: selection.snapshot, offset })).toString("base64url") : null;
  return { project, cycle: cycle.id, snapshotAt: snapshot.at, total: snapshot.ids.length, offset: selection.offset, answers, nextCursor };
}

/** WHAT: Reads one actual canonical answer and verifies its captured full-text identity. WHY: Keeps previews from replacing source text and refuses a changed source record. */
export function readIndexedOnTrackAnswer({ root, project, cycle, id }) {
  const meta = store(root, project, cycle).get("index")?.records[id];
  if (!meta) throw Error("answer identity not captured in this cycle");
  for (const line of readFileSync(meta.source, "utf8").split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.id !== id) continue;
    if (hash(row.text || "") !== meta.textSha256) throw Error("canonical answer changed after capture");
    return { ...meta, text: row.text, files: row.files };
  }
  throw Error("canonical answer source no longer contains the captured identity");
}
