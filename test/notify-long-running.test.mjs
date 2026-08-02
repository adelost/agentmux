import { describe, expect, it, vi } from "vitest";
import { eventCategory, createEventLogger } from "../cli/events.mjs";
import { longRunningEvent } from "../cli/notify.mjs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("long-running pane notifications", () => {
  it("keeps an active turn compact instead of raising a timeout warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-monitoring-"));
    const notify = vi.fn(async () => {});
    const log = createEventLogger({ logFile: join(root, "events.log"), notify });
    const event = longRunningEvent(600);

    log(event.icon, "skyvw", 4, event.event, event.detail);
    await Promise.resolve();

    expect(event).toEqual({
      icon: "⏳",
      event: "MONITORING",
      detail: "10m 0s elapsed, still monitoring",
    });
    expect(eventCategory(event.event)).toBe("compact");
    expect(notify).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });
});
