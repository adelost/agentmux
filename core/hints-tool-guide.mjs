// WHAT: Defines a bounded AMUX entry point. WHY: Prevents CLI detail from
// crowding repository instructions out of an engine's startup context.
export const TOOL_GUIDE_HINTS = `# agentmux

Use installed \`amux --help\` and \`amux <cmd> --help\` for syntax; \`ax\` is
an alias. This is an entry point, not an exhaustive manual. Load an applicable
skill when needed; do not load every guide on startup.

## Orient, then act

- \`amux done\`: current work and your own pane's recovery entry point.
  Follow More commands; inspect an owner's work before intervening.
- \`amux log PROJECT -p N -n 3\`: journal history. Narrow with \`--grep\` or
  \`--since\`. Use \`--tmux -s 60\` for live TUI/modal inspection.
  **Never use raw \`tmux ... capture-pane\`.**
- \`amux asks --open\`: candidate unresolved requests. Read original human
  instructions and later replies before reviving a waiter. Unverified does not
  prove unfinished work. \`amux ps\` distinguishes configured/selected,
  historical and running model/context evidence.
- \`amux search "specific terms"\`, then \`amux search --show N\`: retrieve
  memory/history. Ranking is not authority: check sources, dates and later
  corrections. Semantic/deep search is optional when ordinary retrieval misses.

## Send without corruption or duplicate execution

Write exact UTF-8 text with the file-editing tool, then use
\`amux PROJECT -p N --stdin < /absolute/path/to/message.txt\`.
Never construct prompt text in bash: backticks, dollar signs and quotes expand.
Sends mirror to Discord with provenance. Short slash commands are raw engine
commands; verify consumption. \`amux queue\` separates enqueue, submission and
receipt. Unknown post-submit outcome is not permission to resend or delete fences.

## Relevant health and maintenance

- \`amux doctor\`: classify before restarting. Installed CLI, running bridge
  and product-only merges can differ. Do not start disabled services for green.
- \`amux quota\`: actual provider/window, not a guessed reading of an error.
- \`amux compact --dry\`: inspect eligibility; preserve task evidence. Never
  force compact/respawn through active work.
- \`amux memory status\` and \`amux dream --help\`: the existing memory/digest
  workflow. A scheduled invocation is not proof of a saved digest.
- \`amux wait PROJECT -p N -t 45\`: bounded waiting at a real handoff.
- Lifecycle commands (restart/stop/serve/runtime/emulator/esc/select) affect
  other work: read help, verify the target and coordinate its owner. Never
  replace a manual bridge with a detached daemon without authorization.

## User-visible evidence

Post requested images using \`amux image /absolute/path/image.png\` or
\`[image: /absolute/path/image.png]\`; a saved path alone is not delivery.
Label synthetic inputs/incomplete captures. Read applicable browser/repo QA
instructions before choosing a browser or emulator. \`amux notifyuser\` is for
requested or important timely attention, not routine progress. Do not claim
ongoing monitoring without an actual running wait/monitoring mechanism.
`;
