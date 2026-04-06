// Shared noise patterns for Claude Code terminal output.
// Used by both extract.mjs (response parsing) and lib.mjs (activity peek).

export const UI_NOISE = [
  /^[─━═▪ ]{3,}$/,
  /^❯/,
  /^[✻✢✽✶✷✸✹✺✿❋⚙◉∗⊛·˙] /,  // thinking animation (Herding, Cogitated, etc)
  /^[A-Z][a-z]+(?:ing|ed)…$/,  // bare thinking words: "Musing…", "Cogitated…"
  /How is Claude doing/,
  /^\s+\d+: (Bad|Fine|Good|Dismiss)/,
  /💡 agent log/,
  /bypass permissions/,
  /esc to interrupt/,
  /Enter to select/,
  /Esc to cancel/,
  /Allow once|Allow always/,
  /^\s*ctrl\+o to expand/,
  /^(Read|Wrote|Edit|Searched for) \d+.+\(ctrl/,
  /^cd \//,
  /^conda:/,
  /^Overriding existing handler/,
  /^Set JSC_SIGNAL/,
  /^\w+@\S+[:\$]/,          // shell prompt (user@host)
  /^[▐▛▝▜▘]{2}/,
  /^Claude Code v[\d.]+/,
  /^(Opus|Sonnet|Haiku|Claude) [\d.]+ ·/,
  /^~\//,
  /^context: \d+%/,
  /^\[(image|file) attached:/,   // injected attachment paths from Agentus
];

// Tool calls: ● ToolName(args) or summary lines like ● Searched for N...
export const TOOL_CALL = /^● (?:[A-Za-z]+\(|Searched for \d|Wrote \d|Read \d|Edit \d)/;

export const isNoise = (line) => UI_NOISE.some((p) => p.test(line));
