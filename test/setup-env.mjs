// Global test setup: every worker gets its own events ledger.
//
// Without this, any code path that records to the ledger (delivery
// receipts, hook events) would append to the REAL ~/.agentmux/events.jsonl
// during tests — fake "claw:1 NOT delivered" rows would then surface in
// the user's live `amux done`/`timeline`. Tests that need a specific
// ledger still pass their own path explicitly.
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.AMUX_EVENTS_PATH = join(
  mkdtempSync(join(tmpdir(), "amux-test-ledger-")),
  "events.jsonl",
);

// Same for the conversation (ask) ledger: Discord sends record post rows there.
process.env.AMUX_ASK_LEDGER_PATH = join(
  mkdtempSync(join(tmpdir(), "amux-test-asks-")),
  "ask-ledger.jsonl",
);
// Binding tests must never close real asks through the user's append-only evidence file.
process.env.AMUX_ASK_BINDINGS_PATH = join(mkdtempSync(join(tmpdir(), "amux-test-bindings-")), "bindings.jsonl");

// And for the compact log: the rotation tests wrote 539 false lsrc:0 compacts into ~/.agentmux/compacts.jsonl (11 Nov).
process.env.AMUX_COMPACT_LOG_PATH = join(mkdtempSync(join(tmpdir(), "amux-test-compacts-")), "compacts.jsonl");

// And for the day files of his messages that amux search writes next to the log: a test that searches must not write
// his words into ~/.agentmux/search-human.
process.env.AMUX_SEARCH_HUMAN_DIR = join(
  mkdtempSync(join(tmpdir(), "amux-test-human-")),
  "search-human",
);

// Same for the generated pane config and the bridge state. On 2026-10-19 a
// test started the checkout's CLI under a temporary HOME with the shell's
// AGENTS_YAML, and it regenerated the live channel map from the checkout's
// July agentmux.yaml. Explicit env also beats the checkout's own .env.
const runtime = mkdtempSync(join(tmpdir(), "amux-test-runtime-"));
process.env.AGENTS_YAML = join(runtime, "agents.yaml");
process.env.STATE_FILE = join(runtime, "state.json");

// And for the config: queue-stall-watch.mjs reads agentmux.yaml's queue_stall_watch, so a broker test with an old held head enqueued a real notice to
// the user's watcher (sandman:0, 12 Nov). A test that needs a config passes its own path.
{
  const dir = mkdtempSync(join(tmpdir(), "amux-test-config-"));
  writeFileSync(join(dir, "agentmux.yaml"), "agents: {}\n");
  process.env.AGENTMUX_YAML = join(dir, "agentmux.yaml");
}
