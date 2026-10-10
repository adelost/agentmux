// Discord `/help` text for the bridge commands.

/** DTO: The command list `/help` replies with. */
export const HELP_TEXT = [
  "**Commands:**",
  "`/help`: show this message",
  "`/peek`: last response from agent",
  "`/raw`: last 50 lines of tmux pane (raw)",
  "`/status`: native Codex account, model, context and usage limits",
  "`/quota`: shared account quota per account, and which panes run on it",
  "`/byt <login|email>`: plan for moving the Claude panes to that account (changes nothing); `/byt <login> ok` switches",
  "`/switch`: toggle this Codex pane between account profiles 1 and 2",
  "`/model`: show current model; Codex aliases: astra/gpt-6/sol; Claude: fable/opus/sonnet/haiku",
  "`/restore`: restore the model that was active before the latest downgrade",
  "`/dismiss`: dismiss blocking prompt (survey etc.)",
  "`/esc`: interrupt (send Escape)",
  "`/use <agent>[.pane]`: switch channel target",
  "`/use reset`: back to yaml default",
  "`/thinking`: toggle real-time text streaming (default: on)",
  "`/follow`: toggle: stream output even when typing in tmux",
  "`/tts`: toggle text-to-speech for this channel",
  "`/sync`: create/sync Discord channels from agentmux.yaml",
  "`/reload`: reload agents.yaml",
  "`/restart`: restart agentmux bridge",
  "`/restart all`: recreate every configured tmux session + restart bridge (interrupts active work)",
  "",
  "Prefix with `.N` to target pane N (e.g. `.1 /raw`)",
].join("\n");
