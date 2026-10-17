// Mattias 2026-10-17: no emoji in any bridge text, so the level is named in words only.
/** WHAT: Formats the full direct notification. WHY: Keeps the original title, level and complete message visible. */
export function formatUserNotification(message, { level = "info", title = "" } = {}) {
  const clean = String(message || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("notifyuser message is empty");
  const normalized = String(level || "info").toLowerCase();
  const label = normalized === "warning" ? "warn" : normalized;
  const heading = title ? `**${title}** (${label})` : `**amux** (${label})`;
  return `${heading}\n${clean}`.slice(0, 1900);
}
