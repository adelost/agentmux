import { homedir } from "node:os";
import { join } from "node:path";

/** WHAT: Resolves the append-only ask bindings file. WHY: All readers share closure evidence without copying conversation text. */
export function defaultAskBindingsPath(home = homedir()) {
  return process.env.AMUX_ASK_BINDINGS_PATH || join(home, ".agentmux", "ask-bindings.jsonl");
}
