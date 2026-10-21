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

`;
