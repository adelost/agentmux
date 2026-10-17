/** WHAT: Formats a direct notice on one line. WHY: Keeps notifications from repeating headings or adding another symbol. */
export function formatUserNotification(message, { level = "info", title = "" } = {}) {
  const clean = String(message || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("notifyuser message is empty");
  const normalized = String(level || "info").toLowerCase();
  const icon = {
    info: "🔔",
    done: "✅",
    warn: "⚠️",
    warning: "⚠️",
    error: "🚨",
    urgent: "🚨",
  }[normalized] || "🔔";
  return `${icon} ${title ? `${title}: ` : ""}${clean}`.slice(0, 1900);
}
