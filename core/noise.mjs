// Shared noise patterns for Claude Code terminal output.
// Used by both extract.mjs (response parsing) and lib.mjs (activity peek).

export const UI_NOISE = [
  /^[─━═▪ ]{3,}$/,
  /^[❯›]/,                     // Claude Code (❯) and Codex (›) prompts
  /^[✻✢✽✶✷✸✹✺✿❋⚙◉∗⊛·˙] /,  // thinking animation (Herding, Cogitated, etc)
  /^[A-Z][\w-]*(?:ing|ed)…/,    // thinking words: "Musing…", "Topsy-turvying… (4s)"
  /thinking with high effort/,
  /thought for \d+s/,
  /^[A-Z][a-z]+ for \d+[ms] /,    // "Cogitated for 14s ..."
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
  /^\s*[▐▛▝▜▘█▌▙▟]{2}/,           // Claude Code banner art (any leading whitespace)
  /^-dangerously-skip-permissions/,
  /^Claude Code v[\d.]+/,
  /^(Opus|Sonnet|Haiku|Claude) [\d.]+ ·/,
  /^>_ OpenAI Codex/,             // Codex startup banner
  /^gpt-[\d.]+ \w+ ·/,            // Codex status line (gpt-5.4 xhigh · 99% left)
  /^model:\s/,                     // Codex config line
  /^directory:\s/,                 // Codex config line
  /^╭|^╰|^│/,                     // Codex box drawing
  /^Tip: /,                        // Codex tips
  /Press enter to continue/,
  /Do you trust the contents/,
  /bubblewrap/,
  /^~\//,
  /^context: \d+%/,
  /^\[(image|file) attached:/,   // injected attachment paths from Agentus
];

// Tool calls: ● ToolName(args) or summary lines like ● Searched for N...
export const TOOL_CALL = /^● (?:[A-Za-z]+\(|Searched for \d|Wrote \d|Read \d|Edit \d)/;

export const isNoise = (line) => UI_NOISE.some((p) => p.test(line));
