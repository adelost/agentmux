import { readSync } from "node:fs";

/** WHAT: Reads only the writer's bounded leading fields. WHY: Prevents quoted types inside text from authorizing an oversized-input skip. */
export function classifyCodexRecordPrefix(header) {
  const prefix = /^\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"([\w]+)"\s*,\s*/u.exec(header);
  if (!prefix) return null;
  const type = prefix[1];
  const payload = /^"payload"\s*:\s*\{\s*"type"\s*:\s*"([\w]+)"\s*[,}]/u.exec(header.slice(prefix[0].length));
  // These envelopes can contain authored input or model evidence. Without a
  // leading subtype they cannot be classified safely within the byte bound.
  if ((type === "event_msg" || type === "response_item") && !payload) return null;
  return { type, payloadType: payload?.[1] ?? null };
}

/** WHAT: Reads at most 512 bytes at a record boundary. WHY: Prevents irrelevant image/tool data from requiring full JSON allocation or a growing whitelist. */
export function readCodexRecordPrefix(fd, offset) {
  const bytes = Buffer.alloc(512);
  return classifyCodexRecordPrefix(bytes.toString("utf8", 0, readSync(fd, bytes, 0, bytes.length, offset)));
}
