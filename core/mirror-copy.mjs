/** WHAT: Formats one report's first line with its real sender and recipient. WHY: Keeps full inter-agent briefs in the canonical log instead of repeating pages in Discord. */
export function mirrorLine({ sender, target, text, max = 120 }) {
  const lines = String(text || "").replace(/^\[from [^\]]+\]\s*/u, "").split("\n");
  const first = (lines.find(line => line.trim()) || "").trim().replace(/^SUMMARY:\s*/u, "").replace(/\s+/gu, " ");
  const preview = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return `${sender || "amux"} → ${target}: ${preview}`;
}
