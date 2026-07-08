// Pane-chrome stripper: drops lines that are Claude Code UI rendering
// rather than agent speech (model+context footers, progress bars, spinner
// glyphs, composer prompts). Used by every downstream-text path — the tmux
// extraction fallback (agent.mjs), the voice/TTS route (channels/voice.mjs)
// — so a chrome pattern learned once protects them all. This used to be two
// byte-identical private copies; a model-name added to one and not the
// other (fable) is exactly how footers leak into Discord replies and TTS.

// Model names that appear in status footers. "claude"/"codex" cover the
// prefixed ids (claude-fable-5[1m]); the bare family names cover short
// renderings ("fable-5 · context: 51%").
const MODEL_NAMES = "opus|sonnet|haiku|fable|gpt-?\\d|claude|codex";

const MODEL_FOOTER_LINE = new RegExp(
  `^[│|]?\\s*(${MODEL_NAMES})[\\s\\d.()xMK,a-zA-Z-]*(\\(.*context\\).*|│.*\\d+%?\\s*$)?$`, "i",
);
const MODEL_CONTEXT_LINE = new RegExp(`(${MODEL_NAMES}).*\\(.*context\\).*`, "i");
// Custom-statusline format: "fable-5 · context: 51% (508k)". Anchored model
// name + explicit separator so prose that merely mentions a model survives.
const MODEL_STATUSLINE = new RegExp(
  `^[│|]?\\s*(${MODEL_NAMES})[-\\w.\\[\\]]*\\s*[·|:]\\s*.*\\d+\\s*%`, "i",
);

export function stripPaneChrome(input) {
  const lines = String(input).split("\n");
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { kept.push(""); continue; }
    if (MODEL_FOOTER_LINE.test(line)) continue;
    if (MODEL_CONTEXT_LINE.test(line)) continue;
    if (MODEL_STATUSLINE.test(line)) continue;
    if (/^[█▓▒░\s│|·▏▎▍▌▋▊▉]+(\d+\s*%)?$/.test(line)) continue;
    if (/[█▓▒░]{2,}/.test(line) && line.length < 80) continue;
    if (/^[✻✢⏵⎿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line)) continue;
    if (/(esc to interrupt|tokens?\s*[\)·]|still thinking|thought for)/i.test(line)) continue;
    if (/bypass permissions on/i.test(line)) continue;
    if (/shift\+tab to cycle/i.test(line)) continue;
    if (/^[❯>$]\s*$/.test(line)) continue;
    if (/^[─━═-]+$/.test(line)) continue;
    kept.push(raw);
  }
  return kept.join("\n").trim();
}
