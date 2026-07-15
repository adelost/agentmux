// Parsers for real-engine rollback evidence. Claude's `-p --output-format
// json` has emitted both a single result object and an array of lifecycle
// events across CLI versions, so the release gate accepts both shapes while
// still requiring an exact engine session id.

export function claudePrintSessionId(text) {
  const payload = JSON.parse(String(text));
  const events = Array.isArray(payload) ? payload : [payload];
  return [...events].reverse()
    .find((event) => event?.type === "result" && event.session_id)?.session_id
    || [...events].reverse().find((event) => event?.session_id)?.session_id
    || null;
}

export function codexJsonlThreadId(text) {
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event?.type === "thread.started" && event.thread_id) return event.thread_id;
  }
  return null;
}
