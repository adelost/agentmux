import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimScheduledDream, runScheduledDream } from "./dream-schedule.mjs";

const roots = [];
const now = new Date("2026-09-09T07:00:00Z");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dream-schedule-")); roots.push(home);
  const workspace = join(home, "workspace"); mkdirSync(join(workspace, "memory"), { recursive: true });
  return { home, workspace, now, healthOptions: {
    config: { dream: { agent: "test", pane: 0 } }, env: { HOME: home, OPENCLAW_WORKSPACE: workspace },
    readCrontab: () => "CRON_TZ=Europe/Stockholm\n0 4 * * * /fake/dream-cron.sh\n*/10 * * * * /fake/dream-catchup.sh\n",
  } };
}
function finish(fx, dateKey = "2026-09-09") {
  writeFileSync(join(fx.workspace, "memory", `${dateKey}.md`), `<!-- amux-dream-run:${dateKey} 04:00 (0 panes ok / 0 failed) -->\n`);
}
function run(fx, body = () => 0) {
  return async ({ dateKey, ...admission }) => {
    const claim = claimScheduledDream(fx.workspace, dateKey, { ...fx, ...admission });
    if (claim.skipped) return 0;
    return body({ ...claim, dateKey });
  };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("missed Dream admission", () => {
  it("catches the missed 04 run at 09, keeping the original source window", async () => {
    const fx = fixture();
    const result = await runScheduledDream({ ...fx, mode: "catch-up", run: run(fx, ({ dateKey }) => { finish(fx, dateKey); return 0; }) });
    expect(result.state).toBe("completed");
    expect(result.since).toBe("2026-09-08T02:00:00.000Z");
    expect(JSON.parse(readFileSync(result.path)).state).toBe("completed");
  });
  it("does nothing before 04, and dry-run creates no intent or model call", async () => {
    const fx = fixture(); let calls = 0;
    expect((await runScheduledDream({ ...fx, now: new Date("2026-09-09T01:59:00Z"), run: () => calls++ })).skipped).toBe("not-due");
    const dry = await runScheduledDream({ ...fx, dry: true, run: () => calls++ });
    expect(dry.due).toBe(true); expect(existsSync(dry.path)).toBe(false); expect(calls).toBe(0);
  });
  it("never repeats a completed, failed, or interrupted automatic attempt", async () => {
    for (const failure of [false, true]) {
      const fx = fixture(); let calls = 0;
      const first = await runScheduledDream({ ...fx, run: run(fx, () => { calls++; return failure ? 1 : 0; }) });
      expect(first.state).toBe("unresolved");
      expect((await runScheduledDream({ ...fx, run: () => calls++ })).skipped).toBe("already-attempted");
      expect(calls).toBe(1);
    }
    const fx = fixture();
    const claim = claimScheduledDream(fx.workspace, "2026-09-09", { ...fx, token: "interrupted", mode: "scheduled" });
    expect(JSON.parse(readFileSync(claim.path)).state).toBe("started");
    expect((await runScheduledDream({ ...fx, run: () => { throw new Error("must not run"); } })).skipped).toBe("already-attempted");
  });
  it("two automatic callers admit one model, and a lock-held caller consumes no attempt", async () => {
    const fx = fixture(); let calls = 0, release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const first = runScheduledDream({ ...fx, run: run(fx, async () => { calls++; await waiting; finish(fx); return 0; }) });
    const other = await runScheduledDream({ ...fx, run: () => calls++ });
    expect(other.skipped).toBe("already-attempted"); release(); await first; expect(calls).toBe(1);
    const fresh = fixture();
    expect((await runScheduledDream({ ...fresh, run: async () => 0 })).skipped).toBe("not-admitted");
    expect((await runScheduledDream({ ...fresh, dry: true })).due).toBe(true);
  });
  it("keeps digest success separate from unresolved compact without retry", async () => {
    const fx = fixture();
    const result = await runScheduledDream({ ...fx, run: run(fx, () => { finish(fx); return 1; }) });
    expect(result.digest.ok).toBe(true); expect(result.state).toBe("maintenance-unresolved"); expect(result.exitCode).toBe(1);
    const bytes = readFileSync(result.path);
    expect((await runScheduledDream({ ...fx, run: () => { throw new Error("must not run"); } })).skipped).toBe("already-validated");
    expect(readFileSync(result.path)).toEqual(bytes);
  });
  it("fences partial manual commits, gap markers and prepared inputs without rebasing memory", async () => {
    for (const marker of ["<!-- amux-dream-failed:2026-09-09 04:00 quota -->", "<!-- amux-dream-run:2026-09-09 04:00 (1 panes ok / 0 failed) -->"]) {
      const fx = fixture(); writeFileSync(join(fx.workspace, "memory", "2026-09-09.md"), marker);
      expect((await runScheduledDream({ ...fx, dry: true })).skipped).toBe("prior-run-needs-inspection");
    }
    const fx = fixture(), input = join(fx.home, ".agentmux", "dream-input"); mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "2026-09-09-pending.json"), JSON.stringify({ workspace: fx.workspace }));
    expect((await runScheduledDream({ ...fx, dry: true })).skipped).toBe("prior-input-needs-recovery");
    expect(claimScheduledDream(fx.workspace, "2026-09-09", { ...fx, token: "race" }).skipped).toBe("prior-input-needs-recovery");
  });
  it("rechecks manual completion immediately before claiming; the next day is eligible again", async () => {
    const fx = fixture();
    const result = await runScheduledDream({ ...fx, run: async (admission) => {
      finish(fx);
      expect(claimScheduledDream(fx.workspace, admission.dateKey, { ...fx, ...admission }).skipped).toBe("already-validated");
      return 0;
    } });
    expect(result.skipped).toBe("not-admitted");
    expect((await runScheduledDream({ ...fx, now: new Date("2026-09-10T07:00:00Z"), dry: true })).due).toBe(true);
  });
  it("fails closed for an unknown schedule and never touches yesterday over midnight", async () => {
    const fx = fixture();
    await expect(runScheduledDream({ ...fx, observe: () => ({ state: "warn", detail: "unknown schedule" }) })).rejects.toThrow("unknown schedule");
    expect((await runScheduledDream({ ...fx, now: new Date("2026-09-09T22:05:00Z"),
      observe: () => ({ startMs: now.getTime(), dateKey: "2026-09-09" }) })).skipped).toBe("not-due");
  });
});
