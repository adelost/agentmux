// Pane-chrome stripper: drops lines that are Claude Code UI rendering
// rather than agent speech (model+context footers, progress bars, spinner
// glyphs, composer prompts). Used by every downstream-text path — the tmux
// extraction fallback (agent.mjs), the voice/TTS route (channels/voice.mjs)
// — so a chrome pattern learned once protects them all. This used to be two
// byte-identical private copies; a model-name added to one and not the
// other (fable) is exactly how footers leak into Discord replies and TTS.

// STRUCTURAL chrome detection: the model name is not the load-bearing
// signal (a name list rots — fable leaked for weeks because nobody added
// it). What actually identifies a status footer is its SHAPE: a short line
// whose payload is metrics ("context" + a percent, token counts, id
// suffixes like [1m]). A future model family is chrome on day one.
//
// A legacy name alternation is kept as belt-and-braces for old renderings
// that carry a bare name without metrics, but nothing depends on it.
const LEGACY_MODEL_NAMES = "opus|sonnet|haiku|fable|gpt-?\\d|claude|codex";

// Any prefixed model id ("claude-muse-3[1m]") regardless of family.
const CLAUDE_MODEL_ID = /\bclaude-[\w.[\]-]+/i;
// "…context: 51%" / "…context 51%" on a short line — the statusline shape,
// whatever the model is called ("muse-3 · context: 51% (508k)").
const CONTEXT_PERCENT_LINE = /^.{0,60}\bcontext:?\s*\d{1,3}\s*%/i;
// "(1M context)" + a percent somewhere on the line — the classic footer
// shape. Requiring BOTH keeps prose that merely says "(in context)" alive.
const PAREN_CONTEXT_WITH_METRIC = /\(.*context\).*\d{1,3}\s*%/i;

const MODEL_FOOTER_LINE = new RegExp(
  `^[│|]?\\s*(${LEGACY_MODEL_NAMES})[\\s\\d.()xMK,a-zA-Z-]*(\\(.*context\\).*|│.*\\d+%?\\s*$)?$`, "i",
);
const MODEL_STATUSLINE = new RegExp(
  `^[│|]?\\s*(${LEGACY_MODEL_NAMES})[-\\w.\\[\\]]*\\s*[·|:]\\s*.*\\d+\\s*%`, "i",
);

export function stripPaneChrome(input) {
  const lines = String(input).split("\n");
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { kept.push(""); continue; }
    if (CONTEXT_PERCENT_LINE.test(line)) continue;
    if (PAREN_CONTEXT_WITH_METRIC.test(line)) continue;
    if (CLAUDE_MODEL_ID.test(line) && /\d\s*%|\[\d+m\]|tokens/i.test(line)) continue;
    if (MODEL_FOOTER_LINE.test(line)) continue;
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
