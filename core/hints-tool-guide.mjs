// WHAT: Defines a bounded AMUX entry point. WHY: Prevents CLI detail from
// crowding repository instructions out of an engine's startup context.
export const TOOL_GUIDE_HINTS = `# agentmux

\`amux --help\` documents every command; \`ax\` is an alias. Load only the skills
the task needs.

## Orient, then act

- \`amux done\`: current work and your pane's recovery entry point; follow More
  commands and inspect an owner's work before intervening.
- \`amux log PROJECT -p N -n 3\`: history (\`--grep\`, \`--since\`; \`--raw\` engine
  journals, \`--tmux -s 60\` the live TUI). **Never use raw \`tmux ... capture-pane\`.**
- \`amux asks --open\`: candidate unresolved requests. Read the original
  instructions and later replies before reviving a waiter; unverified does not
  prove unfinished. \`amux ps\` separates configured, historical and running
  model/context evidence.
- Earlier people, projects and decisions: \`amux search "specific terms"\`, then
  \`amux search --show N\`. Check original sources, dates and later corrections;
  ranking is not authority. If hits do not answer the question, refine the terms
  or use \`--semantic\`/\`--deep\`; report remaining gaps instead of guessing.
- Current implementation: \`rg\` and Git in the repository, then read the source.
  Memory hits are not proof of current code.

## Send without corruption or duplicate execution

Write exact UTF-8 text with the file-editing tool, then
\`amux PROJECT -p N --stdin < /absolute/path/message.txt\`. Never build prompt
text in bash: backticks, dollar signs and quotes expand. Sends mirror to Discord
with provenance. Short slash commands are raw engine commands: verify
consumption. \`amux queue\` separates enqueue, submission and receipt; an unknown
post-submit outcome is not permission to resend or delete fences.

## Relevant health and maintenance

- \`amux doctor\` classifies before any restart; installed CLI, running bridge
  and merges can differ. Do not start disabled services for green.
- \`amux quota\`: the actual provider/window, never a guess from an error.
  Accounts and switching: the amux-accounts skill.
- \`amux compact --dry\`: eligibility. Never force compact/respawn through active work.
- \`amux memory status\`, \`amux memory context\` (retrieve sections on demand,
  never whole daily files) and \`amux dream --help\`. A scheduled run is not
  proof of a saved digest.
- \`amux wait PROJECT -p N -t 45\`: bounded waiting at a real handoff.
- Lifecycle commands (restart/stop/serve/runtime/emulator/esc/select) affect
  other work: read help, verify the target, coordinate its owner. Never replace
  a manual bridge with a detached daemon without authorization.

## User-visible evidence

Requested speech/TTS: \`amux say --stdin < speech.txt\` in the requested
language/voice, delivery verified; hands-free means hearing the answer, not
shorter text; no automatic voice surprises. Requested images: \`amux image
/absolute/path.png\` or \`[image: /absolute/path.png]\`; a saved path alone is
not delivery. Label synthetic inputs and incomplete captures. Read the
browser/repo QA instructions before choosing a browser or emulator. \`amux
notifyuser\` is for requested or important timely attention, not routine
progress. Never claim ongoing monitoring without a running wait or monitor.
`;
