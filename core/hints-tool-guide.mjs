// WHAT: Defines a bounded AMUX entry point. WHY: Prevents CLI detail from
// crowding repository instructions out of an engine's startup context.
export const TOOL_GUIDE_HINTS = `# agentmux

\`amux --help\` documents every command (alias \`ax\`); load only the skills needed.

## Orient, then act

- \`amux done\`: your work and recovery entry; inspect an owner's work before
  intervening.
- \`amux log PROJECT -p N -n 3\` (\`--grep\`, \`--since\`): conversation; \`--raw\`: engine journal;
  \`--tmux -s 60\`: live TUI. **Never use raw \`tmux ... capture-pane\`.**
- \`amux asks --open\`: candidate open requests; read the original instructions
  and later replies before reviving a waiter; unverified is not
  unfinished. \`amux ps\`: configured, historical and running model/context.
- Earlier people, projects and decisions: \`amux search "specific terms"\`, then
  \`amux search --show N\`. Check original sources, dates and later corrections;
  ranking is not authority. If hits do not answer the question, refine the terms
  or use \`--semantic\`/\`--deep\`; report remaining gaps instead of guessing.
- Current implementation: \`rg\` and Git in the repository, then read the source.
  Memory hits are not proof of current code.
- On a \`[drift-guard]\` reminder, re-read the section it names. Manual refresh:
  \`amux remind <agent> -p <pane>\` (\`--all\` / \`--stale\` still require the staffing policy's scope).

## Send exactly once, uncorrupted

Write exact UTF-8 text with the file-editing tool, then \`amux PROJECT -p N
--stdin < /absolute/path/message.txt\`; never build prompt text in bash
(backticks, $ and quotes expand). Sends mirror to Discord. Short
slash commands are raw engine commands: verify consumption. \`amux queue\`
separates enqueue, submission and receipt; an unknown post-submit outcome is
not permission to resend or delete fences.

## Health and maintenance

- \`amux doctor\` classifies before any restart (installed CLI, running bridge
  and merges can differ); never start disabled services for green.
- \`amux quota\`: the actual provider/window, never a guess from an error;
  accounts and switching: amux-accounts skill.
- \`amux compact --dry\`: eligibility; never force compact/respawn through active work.
- \`amux memory status\`, \`amux memory context\` (sections on demand, never whole
  daily files), \`amux dream --help\`; a scheduled run is not proof of a saved digest.
- \`amux wait PROJECT -p N -t 45\`: bounded wait at a real handoff.
- Lifecycle commands (restart/stop/serve/runtime/emulator/esc/select) affect
  other work: read help, verify the target, coordinate its owner; never replace
  a manual bridge with a detached daemon without authorization.

## User-visible evidence

Requested speech/TTS: \`amux say --stdin < speech.txt\` in the requested
language/voice, delivery verified; hands-free means hearing the answer, not
shorter text; no automatic voice surprises. Requested images: \`amux image
/absolute/path.png\` or \`[image: /absolute/path.png]\`; a saved path alone is
not delivery. Label synthetic inputs and incomplete captures. Read
browser/repo QA instructions before choosing a browser or emulator.
\`amux notifyuser\`: requested or important timely attention, not routine
progress. Never claim ongoing monitoring without a running wait or monitor.
`;
