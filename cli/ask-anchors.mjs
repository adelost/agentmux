// Finds where each displayed ask sits in its provider session file, so `amux asks --raw --full` can print file:line.

import { readFileSync } from "node:fs";
import { askAnchorKey, attachAskLineAnchors } from "../core/ask-history.mjs";

function promptFromJsonlLine(event) {
  if (event?.type === "user" && typeof event.message?.content === "string") {
    return { timestamp: event.timestamp || null, prompt: event.message.content };
  }
  if (event?.type === "event_msg" && event.payload?.type === "user_message" && typeof event.payload.message === "string") {
    return { timestamp: event.timestamp || null, prompt: event.payload.message };
  }
  return null;
}

function collectAskLineAnchors(jsonlFile) {
  const out = new Map();
  if (!jsonlFile) return out;
  let text;
  try { text = readFileSync(jsonlFile, "utf-8"); }
  catch { return out; }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let event;
    try { event = JSON.parse(lines[i]); } catch { continue; }
    const anchor = promptFromJsonlLine(event);
    if (!anchor?.prompt) continue;
    const key = askAnchorKey(anchor.timestamp, anchor.prompt);
    if (!out.has(key)) out.set(key, i + 1);
  }
  return out;
}

/** WHAT: Maps each displayed ask to its line in the session file. WHY: Keeps the file scan out of the command and reads each session file once. */
export function attachDisplayedAskLineAnchors(rows) {
  const cache = new Map();
  return rows.map((row) => {
    if (!row.jsonlFile) return row;
    if (!cache.has(row.jsonlFile)) {
      cache.set(row.jsonlFile, collectAskLineAnchors(row.jsonlFile));
    }
    return attachAskLineAnchors([row], cache.get(row.jsonlFile))[0];
  });
}
