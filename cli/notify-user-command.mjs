// `amux notifyuser`: one high-signal push to the human.

import { parseFlags } from "./command-args.mjs";

/** DTO: The notifyuser usage text. */
export const NOTIFY_USER_USAGE = `Usage: amux notifyuser "message" [--level info|done|warn|error] [--title TITLE]
                       [--idempotency-key KEY] [--force] [--dry] [--test]
Sends a direct message to the operator. --dry prints the text without sending.`;

const wantsHelp = (args) => args.some((arg) => arg === "--help" || arg === "-h");

/**
 * WHAT: Dispatches one operator notification from the CLI.
 * WHY: Keeps a help request from becoming a DM (2026-10-10: `amux notifyuser --help` sent "--help" to Mattias).
 */
export async function cmdNotifyUser(args, {
  send = async (text, options) => (await import("./send-notify.mjs")).notifyUser(text, options),
  render = async (text, options) => (await import("./send-notify.mjs")).formatUserNotification(text, options),
  output = console.log,
  fail = (message) => { console.error(message); process.exit(1); },
} = {}) {
  if (wantsHelp(args)) { output(NOTIFY_USER_USAGE); return { help: true }; }
  const { flags, positional } = parseFlags(args, {
    level: "string", l: "string",
    title: "string",
    user: "string", u: "string",
    channel: "string", c: "string",
    force: "boolean", f: "boolean",
    dry: "boolean",
    test: "boolean",
    "idempotency-key": "string",
  });
  const text = flags.test ? "Test notification from amux notifyuser." : positional.join(" ").trim();
  if (!text) return fail(NOTIFY_USER_USAGE);
  const options = {
    level: flags.level || flags.l || "info",
    title: flags.title || "amux",
    userId: flags.user || flags.u,
    channel: flags.channel || flags.c,
    idempotencyKey: flags["idempotency-key"],
    force: !!(flags.force || flags.f || flags.test),
  };
  if (flags.dry) { output(await render(text, options)); return { dry: true }; }
  const result = await send(text, options);
  output(result.deduped ? "notifyuser skipped duplicate"
    : `notifyuser sent → ${result.target}${result.fallback ? " (fallback)" : ""}`);
  return result;
}
