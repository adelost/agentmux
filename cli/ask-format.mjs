// Text-only rendering for durable ask rows.

/** WHAT: Maps an ask state to stable terminal chrome. WHY: Keeps archived/live presentation out of collection logic. */
export function formatAskStatus(status) {
  switch (status) {
    case "open": return "⚠️ open";
    case "working": return "🟡 working";
    case "partial": return "⚠️ partial";
    case "needs-you": return "🔴 needs-you";
    case "done": return "✅ done";
    case "answered": return "☑️ answered";
    case "unverified": return "❔ unverified";
    case "archived": return "🗄 archived";
    default: return status || "unknown";
  }
}

/** WHAT: Collapses prompt whitespace for a bounded grep needle. WHY: Keeps multiline asks usable in one copyable command. */
function compactText(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

/** WHAT: Formats minute age at human scale. WHY: Keeps ask rows compact across month-long retention. */
function relativeMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "?";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** WHAT: Escapes a literal for regex lookup. WHY: Keeps prompt punctuation from changing log search meaning. */
function escapeRegexLiteral(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

/** WHAT: Quotes one POSIX shell argument. WHY: Keeps rendered log commands copy-safe for apostrophes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/** WHAT: Formats one durable ask with optional live/session provenance. WHY: Keeps CLI orchestration separate from row formatting. */
export function formatAskEntry(entry) {
  const ts = entry.timestamp
    ? new Date(entry.tsMs).toISOString().slice(5, 16).replace("T", " ")
    : "-- --:--";
  const age = Number.isFinite(entry.ageMs)
    ? relativeMinutes(Math.round(entry.ageMs / 60000))
    : "?";
  const status = formatAskStatus(entry.status).padEnd(13);
  const needle = compactText(entry.prompt).slice(0, 70);
  const origin = entry.origin === "agent" ? "agent"
    : entry.origin === "system" ? "system"
      : "human";
  const lines = [
    `${status}  ${ts}  ${entry.key.padEnd(10)}  ${age}  [${origin}]`,
    `    > ${entry.promptPreview}`,
  ];
  if (entry.replyPreview) lines.push(`    → ${entry.replyPreview}`);
  if (entry.jsonlFile) {
    const location = entry.jsonlLine
      ? `${entry.jsonlFile}:${entry.jsonlLine}`
      : entry.jsonlFile;
    lines.push(`    jsonl: ${location}${entry.timestamp ? ` @ ${entry.timestamp}` : ""}`);
  }
  if (!entry.jsonlFile && entry.sessionFile) {
    lines.push(`    session: ${entry.sessionFile} (no matching completion found)`);
  }
  if (entry.status === "unverified") {
    const delivery = entry.deliveryStatus ? `delivery ${entry.deliveryStatus}` : "delivery recorded";
    lines.push(`    evidence: ${delivery}; no completion evidence`);
  }
  if (entry.deliveryPath) lines.push(`    delivery: ${entry.deliveryPath}`);
  if (entry.ledgerPath) lines.push(`    ledger: ${entry.ledgerPath}`);
  lines.push(`    log: amux log ${entry.agent} -p ${entry.pane} --grep ${shellQuote(escapeRegexLiteral(needle))} -n 5`);
  return lines.join("\n");
}
