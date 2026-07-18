// Keep a live tmux server across destructive fleet replacement.
//
// Without a temporary session, killing the final configured session exits the
// server. The next new-session then reloads ~/.tmux.conf and tmux-continuum can
// asynchronously resurrect the old fleet over the new one. Holding one
// unconfigured shell session keeps server configuration and layout ownership
// stable until the replacement fleet exists.

/** WHAT: Returns a temporary tmux server-hold session.
 *  WHY: Prevents restore plugins from overwriting a replacement fleet. */
export async function createTmuxServerHold(tmux, sessionNames, pid = process.pid) {
  let serverIsLive = false;
  for (const name of sessionNames) {
    if (await tmux.hasSession(name)) {
      serverIsLive = true;
      break;
    }
  }
  if (!serverIsLive) return { name: null, release: async () => {} };

  const name = `__amux_restart_hold_${pid}`;
  if (await tmux.hasSession(name)) await tmux.killSession(name);
  await tmux.newSession(name);
  return { name, release: () => tmux.killSession(name) };
}
