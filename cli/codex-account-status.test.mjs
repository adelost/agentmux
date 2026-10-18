import { describe, it, expect } from "vitest";
import { accountSwitchStatus, registerAccountSwitchBatch, switchStatusCommand } from "./codex-account-status.mjs";

function fixture() {
  const data = {}, writes = [];
  const state = { get: (key, fallback) => data[key] ?? fallback, all: () => ({ ...data }),
    set: (key, value) => { writes.push(key); data[key] = value; },
    updateAll: change => { writes.push("transaction"); change(data); } };
  return { data, writes, state };
}
describe("durable account batch receipts", () => {
  it("registers all intended requests atomically and retains superseded terminal receipts", () => {
    const fx = fixture(), first = { id: "first", target: "2", requestedAt: "original", phase: "complete", result: { kind: "selected", dormant: true } };
    registerAccountSwitchBatch(fx.state, { id: "batch", target: "2", requestedAt: "original", requests: [["pane:1", first]] });
    expect(fx.writes).toEqual(["transaction"]);
    registerAccountSwitchBatch(fx.state, { id: "other", target: "1", requests: [["pane:1", { id: "next", target: "1", phase: "pending" }]] });
    const result = accountSwitchStatus(fx, { requestId: "batch" });
    expect(result).toMatchObject({ status: "COMPLETE", summary: { total: 1, complete: 1, dormantSelected: 1 }, rows: [{ id: "first", mode: "selected-next-start" }] });
  });
  it("status polling and unknown lookups do not write or infer success from missing evidence", () => {
    const fx = fixture(), output = [];
    const result = switchStatusCommand(fx, ["--json", "--request-id", "missing"], { output: value => output.push(value) });
    expect(result).toMatchObject({ status: "NOT_FOUND", found: false, rows: [] });
    expect(JSON.parse(output[0]).found).toBe(false);
    expect(fx.writes).toEqual([]);
  });
});
