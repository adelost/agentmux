import { parseFlags } from "./command-args.mjs";

const flags = {
  since: "string", workspace: "string", dry: "boolean", q: "boolean", quiet: "boolean", recover: "string",
  "source-sha256": "string", "memory-sha256": "string", "import-historical": "boolean", retry: "boolean",
  "defer-sentinel": "boolean", deferSentinel: "boolean", help: "boolean", h: "boolean",
  "setup-care": "boolean", "care-root": "string", "care-reference": "string",
};

/** WHAT: Reads the Dream command's explicit flags. WHY: Prevents an unknown configuration argument from starting a nightly model turn. */
export function parseDreamArgs(args) {
  const parsed = parseFlags(args, flags);
  if (parsed.positional.length) throw new Error("Unknown dream argument; use amux dream --help");
  return parsed.flags;
}
