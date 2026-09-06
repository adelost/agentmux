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

/** WHAT: Reads the current Claude footer. WHY: Keeps live context/model evidence out of earlier scrollback. */
export function readClaudeScreenStatus(screen) {
  const lines = String(screen || "").trimEnd().split("\n");
  const prompt = lines.findLastIndex((line) => /^\s*❯/u.test(line));
  if (prompt < 0) return null;
  const footer = lines.slice(Math.max(prompt + 1, lines.length - 15));
  for (const line of footer) {
    if (!/[█▓▒░│|]/u.test(line) || !/\b\d{1,3}\s*%/u.test(line)) continue;
    const model = line.match(/(?:^|[│|]\s*)(claude-[\w.\[\]-]+|(?:Fable|Mythos|Opus|Sonnet|Haiku)\s+\d+(?:[.\-]\d+)*(?:\s*\(1M context\))?)(?=\s*[│|])/iu)?.[1];
    const effort = normalizeClaudeEffort(line.match(/\b(?:thinking|effort)\s*:\s*([\w-]+)\b/iu)?.[1]);
    const percent = Number(line.match(/\b(\d{1,3})\s*%/u)?.[1]);
    if (model && Number.isFinite(percent) && percent <= 100) {
      const counter = footer.findLast((entry) => /^\s*\d+\s+tokens\s*$/u.test(entry));
      const tokens = counter ? Number(counter.trim().split(/\s/u)[0]) : null;
      return { model, effort, percent, tokens, source: "claude-live-statusline" };
    }
  }
  return null;
}

/** WHAT: Reads actual effort for Dream. WHY: Keeps context visibility separate from the curator's quality fence. */
export function readClaudeScreenQuality(screen) {
  const status = readClaudeScreenStatus(screen);
  return status?.effort ? { model: status.model, effort: status.effort, source: status.source } : null;
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
  if (value == null || value === "" || typeof value === "boolean") return null;
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
  delegatedSince = null,
} = {}) {
  const sessionId = cleanSessionId(data?.session_id);
  if (!sessionId) return null;
  const path = join(directory, `claude-ctx-${sessionId}.json`);
  let previous = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) previous = parsed;
  } catch { /* the delegate may not publish context metrics */ }

  // A delegate may report a scaled percentage. Keep it only when THIS
  // invocation produced it; never timestamp yesterday's cache as fresh.
  const freshDelegate = Number.isFinite(delegatedSince)
    && previous.session_id === sessionId && Number(previous.timestamp) >= delegatedSince;
  const used = (freshDelegate ? finitePercent(previous.used_pct) : null)
    ?? finitePercent(data?.context_window?.used_percentage)
    ?? (() => {
      const remaining = finitePercent(data?.context_window?.remaining_percentage);
      return remaining == null ? null : 100 - remaining;
    })();
  const effort = normalizeClaudeEffort(data?.effort?.level);
  const model = normalizeModel(data?.model?.id);
  const record = {
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
