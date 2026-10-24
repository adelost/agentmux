import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeartbeat } from "./heartbeat.mjs";

afterEach(() => vi.useRealTimers());
describe("quota-floor checks use the existing bridge heartbeat", () => {
  it("runs the callback on its existing tick with one timer", async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const stop = startHeartbeat({ version: "synthetic", path: join(mkdtempSync(join(tmpdir(), "quota-beat-")), "beat.json"), onTick });
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect(onTick).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    } finally { stop(); }
  });
});
