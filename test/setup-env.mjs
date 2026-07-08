// Global test setup: every worker gets its own events ledger.
//
// Without this, any code path that records to the ledger (delivery
// receipts, hook events) would append to the REAL ~/.agentmux/events.jsonl
// during tests — fake "claw:1 NOT delivered" rows would then surface in
// the user's live `amux done`/`timeline`. Tests that need a specific
// ledger still pass their own path explicitly.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.AMUX_EVENTS_PATH = join(
  mkdtempSync(join(tmpdir(), "amux-test-ledger-")),
  "events.jsonl",
);
