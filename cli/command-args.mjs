// Lifecycle help must be recognized before config bootstrap or command effects.
// Deliberately scoped: other commands keep their own help, agent text stays text.
const LIFECYCLE_COMMANDS = new Set([
  "restart", "reload", "sync", "stop", "serve", "runtime", "services",
  "add", "rm", "reconcile", "revive", "sleep", "wake", "sleep-watch", "cutover",
  "say",
]);

/** WHAT: Checks lifecycle/global help arguments. WHY: Prevents syntax probes from invoking lifecycle or config effects. */
export function isDispatchHelp([command, ...args]) {
  if (["help", "--help", "-h"].includes(command)) return true;
  if (!LIFECYCLE_COMMANDS.has(command)) return false;
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

const LONG_FLAG_WITH_ATTACHED_VALUE = /^--([^=\s]+)=(.*)$/;
const SHORT_FLAG_WITH_ATTACHED_VALUE = /^-([A-Za-z])(.+)$/;
/** A lone token that reads as a flag: no whitespace, so real prose never matches. */
const FLAG_SHAPED_TOKEN = /^-{1,2}[A-Za-z][^\s]*$/;

const takesValue = (spec, name) => name in spec && spec[name] !== "boolean";
const coerceFlagValue = (type, raw) => (type === "number" ? parseInt(raw) : raw);

/**
 * WHAT: Reads a flag whose value sits in the same token (`-p2`, `--pane=2`).
 * WHY: These are the forms people actually type. Unrecognized, the token falls
 *      through to `positional` and on the send path positionals ARE the message,
 *      so a routing flag turns into prompt text and delivery drops to pane 0.
 * Returns { name, value }, or null when the token carries no attached value.
 */
function readAttachedFlagValue(arg, spec) {
  const long = arg.match(LONG_FLAG_WITH_ATTACHED_VALUE);
  if (long && takesValue(spec, long[1])) return { name: long[1], value: long[2] };
  const short = arg.match(SHORT_FLAG_WITH_ATTACHED_VALUE);
  if (short && takesValue(spec, short[1])) return { name: short[1], value: short[2] };
  return null;
}

/**
 * WHAT: Filters unclaimed flag-shaped prompt tokens.
 * WHY: Prevents routing flag typos from silently becoming delivered message text.
 */
export const flagShapedPromptTokens = (positional) =>
  positional.filter((token) => FLAG_SHAPED_TOKEN.test(token));

/** WHAT: Parses CLI flags and positionals. WHY: Preserves literal arguments after --. */
export function parseFlags(args, spec = {}) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const attached = readAttachedFlagValue(arg, spec);
    if (attached) {
      flags[attached.name] = coerceFlagValue(spec[attached.name], attached.value);
      i++;
      continue;
    }
    // Check for --flag and -f variants
    const flagName = arg.startsWith("--") ? arg.slice(2) : arg.startsWith("-") ? arg.slice(1) : null;
    if (flagName && flagName in spec) {
      if (spec[flagName] === "boolean") {
        flags[flagName] = true;
        i++;
      } else {
        flags[flagName] = coerceFlagValue(spec[flagName], args[i + 1]);
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { flags, positional };
}
