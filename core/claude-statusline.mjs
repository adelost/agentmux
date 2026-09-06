import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/iu;
const MODEL_TOKEN = /^[a-z0-9][a-z0-9._[\]/-]{0,159}$/iu;

/** WHAT: Normalizes one provider-reported effort label. WHY: Keeps display metadata bounded without freezing future effort names. */
export function normalizeClaudeEffort(value) {
  if (typeof value !== "string") return null;
  const effort = value.trim().toLowerCase();
  return EFFORT_TOKEN.test(effort) ? effort : null;
}

/** WHAT: Reads quality from the current Claude footer. WHY: Separates live model evidence from expired idle context caches. */
export function readClaudeScreenQuality(screen) {
  const lines = String(screen || "").trimEnd().split("\n");
  const prompt = lines.findLastIndex((line) => /^\s*❯/u.test(line));
  if (prompt < 0) return null;
  for (const line of lines.slice(Math.max(prompt + 1, lines.length - 15))) {
    if (!/[█▓▒░│|]/u.test(line) || !/\b\d{1,3}\s*%/u.test(line)) continue;
    const model = line.match(/(?:^|[│|]\s*)(claude-[\w.\[\]-]+|(?:Fable|Mythos|Opus|Sonnet|Haiku)\s+\d+(?:[.\-]\d+)*(?:\s*\(1M context\))?)(?=\s*[│|])/iu)?.[1];
    const effort = normalizeClaudeEffort(line.match(/\b(?:thinking|effort)\s*:\s*([\w-]+)\b/iu)?.[1]);
    if (model && effort) return { model, effort, source: "claude-live-statusline" };
  }
  return null;
}

function normalizeModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return MODEL_TOKEN.test(model) ? model : null;
}

/** WHAT: Validates Claude's session key. WHY: Keeps statusline input from escaping the temp bridge directory. */
function cleanSessionId(value) {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 160 || /[/\\]|\.\./u.test(sessionId)) return null;
  return sessionId;
}

function finitePercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? Math.round(percent)
    : null;
}

/** WHAT: Formats Claude's observed effort beside the delegated statusline. WHY: Keeps effort visibility consistent across engines. */
export function decorateClaudeStatusline(output, effort) {
  const text = String(output || "").trimEnd();
  const observed = normalizeClaudeEffort(effort);
  if (!observed || new RegExp(`(?:thinking|effort)\\s*:\\s*${observed}\\b`, "iu").test(text)) return text;
  return `${text}${text ? " · " : ""}thinking: ${observed}`;
}

/** WHAT: Stores Claude's official statusline observation. WHY: Keeps pane-local effort separate from global defaults. */
export function writeClaudeStatuslineBridge(data, {
  directory = tmpdir(),
  nowSeconds = () => Math.floor(Date.now() / 1000),
} = {}) {
  const sessionId = cleanSessionId(data?.session_id);
  if (!sessionId) return null;
  const path = join(directory, `claude-ctx-${sessionId}.json`);
  let previous = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) previous = parsed;
  } catch { /* the delegate may not publish context metrics */ }

  const used = finitePercent(previous.used_pct)
    ?? finitePercent(data?.context_window?.used_percentage)
    ?? (() => {
      const remaining = finitePercent(data?.context_window?.remaining_percentage);
      return remaining == null ? null : 100 - remaining;
    })();
  const effort = normalizeClaudeEffort(data?.effort?.level);
  const model = normalizeModel(data?.model?.id);
  const record = {
    ...previous,
    session_id: sessionId,
    ...(used == null ? {} : { used_pct: used }),
    effort,
    model,
    timestamp: nowSeconds(),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, path);
  return { path, record };
}
