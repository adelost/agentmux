import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readQuotaRecoveryHeartbeat,
  writeQuotaRecoveryHeartbeat,
} from "./quota-recovery-heartbeat.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("quota recovery heartbeat", () => {
  it("atomically records the latest completed tick", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-quota-heartbeat-"));
    roots.push(root);
    const path = join(root, "heartbeat.json");

    writeQuotaRecoveryHeartbeat({ state: "ok", targets: 2 }, { path, now: 1_700_000_000_000 });

    expect(readQuotaRecoveryHeartbeat(path)).toMatchObject({
      state: "ok",
      targets: 2,
      ts: "2023-11-14T22:13:20.000Z",
    });
    expect(readFileSync(path, "utf8")).toMatch(/\n$/u);
  });
});
