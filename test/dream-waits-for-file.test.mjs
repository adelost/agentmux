import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDream } from "../cli/dream.mjs";
import { writeDreamOwnerInput } from "../core/dream-owner.mjs";

// Night of 2026-09-05: Stockholm is UTC+2, so 12:00 local is 10:00Z.
const START = new Date("2026-09-05T02:00:00Z");
const MIN = 60_000;
const roots = [], saved = { home: process.env.HOME, janitor: process.env.AMUX_JANITOR_ENABLED };
afterEach(() => {
  process.env.HOME = saved.home;
  if (saved.janitor === undefined) delete process.env.AMUX_JANITOR_ENABLED; else process.env.AMUX_JANITOR_ENABLED = saved.janitor;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * One whole night with a virtual clock. The controller really waits (real wait
 * functions); only time, the pane and the queue are fakes.
 */
function night({ fileAt = null, submitAt = 0, busyForever = false, noReceipt = false, proofFails = false, curatorWrites = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dream-wait-"));
  roots.push(root);
  process.env.HOME = root; process.env.AMUX_JANITOR_ENABLED = "false";
  const workspace = join(root, "workspace");
  let clock = START.getTime(), input = null, written = false;
  const owner = { agent: "sandman", pane: 0, engine: "claude", paneDir: join(root, "pane") };
  const notices = [], sleeps = [], prompts = [];
  const jobId = "a".repeat(32);
  const queue = {
    findById: vi.fn(id => ({ id, status: clock - START.getTime() >= submitAt ? "submitted" : "pending" })),
    requestCancellation: vi.fn((id, request) => ({ id, ...request, cancelRequestStatus: "requested" })),
  };
  const curate = () => {
    written = true;
    writeFileSync(input.outputPath,
      `> Kuraterad av sandman:0 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Natten sammanfattad.\n`);
    if (curatorWrites) {
      mkdirSync(join(workspace, "memory", "references"), { recursive: true });
      writeFileSync(join(workspace, "memory", "references", "care-2026-09-05.md"), "> summary: x\n> why: y\n");
      writeFileSync(join(workspace, "memory", "2026-09-05.md"), `${readFileSync(join(workspace, "memory", "2026-09-05.md"), "utf8")}\nCuratorns egen anteckning.\n`);
      writeFileSync(join(workspace, "MEMORY.md"), "- [care](memory/references/care-2026-09-05.md)\n");
    }
  };
  const deps = {
    now: START, agents: [], runtimeConfig: {}, candidates: [owner],
    nowMs: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; if (fileAt !== null && !written && clock - START.getTime() >= fileAt) curate(); },
    readReceipts: () => ({ schemaVersion: 1, panes: {} }),
    collectSources: () => ({ sources: [{ agent: "skyvw", pane: 3, engine: "codex", turns: 1,
      activityCursor: "2026-09-04T20:00:00Z", latestMs: Date.parse("2026-09-04T20:00:00Z"), filesOmitted: 0,
      entries: [{ timestamp: "2026-09-04T20:00:00Z", userPrompt: "Fix DSL", items: [{ type: "text", content: "Shipped fix." }] }] }],
    omitted: [], unreadable: [], skipped: [] }),
    getStatus: async () => "idle",
    getContext: () => ({ model: "claude-opus-5-5", effort: "max", sessionId: "s1" }),
    compactClaude: async () => ({ ok: true, sessionId: "s1", compactBoundary: true }),
    writeInput: document => (input = writeDreamOwnerInput(document, { rootDir: join(root, "input") })),
    mirrorPrompt: async (_ctx, _owner, prompt) => { prompts.push(prompt); return { channelId: "visible", messages: 1 }; },
    send: async () => (submitAt > 0
      ? { delivered: true, pending: true, queueState: "pending", jobId }
      : { delivered: true, pending: false, queueState: "acknowledged", jobId }),
    notifyUser: async text => { notices.push(text); return { sent: true }; },
    nightlyCompact: async () => {},
    recordReceipts: () => {},
    ...(proofFails && { getProof: async () => { throw new Error("dream-original-terminal-receipt-unverified"); } }),
    ...(!proofFails && { getProof: async () => ({ sessionId: "s1", ownerTexts: [] }) }),
  };
  const ctx = { configPath: "unused", deliveryQueue: queue, agent: {
    ensureReady: async () => {},
    isBusy: async () => busyForever,
    getResponseStreamWithRaw: async () => ({ source: "jsonl", items: noReceipt ? [{ type: "text", content: "klar" }] : [{ type: "text", content: `DREAM_OK 2026-09-05 ${input?.runId}` }] }),
  } };
  return { root, workspace, queue, notices, sleeps, prompts, jobId, ctx, deps, elapsed: () => clock - START.getTime(),
    run: () => cmdDream(ctx, { workspace, quiet: true }, deps),
    digest: () => readdirSync(join(workspace, "memory", "dream")).map(name => readFileSync(join(workspace, "memory", "dream", name), "utf8")).join("\n") };
}

describe("Dream waits for the file, not for the clock or the journal", () => {
  it("publishes a file that arrives after 15 minutes but before 12:00 local", async () => {
    const fx = night({ fileAt: 20 * MIN });
    const result = await fx.run();
    expect(result.included).toHaveLength(1);
    expect(fx.digest()).toContain("Natten sammanfattad");
  });

  it("checks once a minute", async () => {
    const fx = night({ fileAt: 5 * MIN });
    await fx.run();
    expect(new Set(fx.sleeps)).toEqual(new Set([MIN]));
  });

  it("publishes a valid file although the final reply is not DREAM_OK and the pane stays busy", async () => {
    const fx = night({ fileAt: 3 * MIN, noReceipt: true, busyForever: true });
    await fx.run();
    expect(fx.digest()).toContain("Natten sammanfattad");
  });

  it("publishes a valid file although the journal proof cannot be found", async () => {
    const fx = night({ fileAt: 3 * MIN, proofFails: true });
    await fx.run();
    expect(fx.digest()).toContain("Natten sammanfattad");
  });

  it("tells the curator it may write in the workspace and to write the result file first", async () => {
    const fx = night({ fileAt: 3 * MIN });
    await fx.run();
    const [prompt] = fx.prompts;
    expect(prompt).toContain(`Du får skriva i workspace-filer`);
    expect(prompt).toContain("memory/references/");
    expect(prompt).toContain("och skriv den först");
    expect(prompt).not.toMatch(/Ändra INTE|ENDAST resultatfilen|Rör inga minnesfiler/u);
  });

  it("publishes when the curator also wrote in memory/ and MEMORY.md", async () => {
    const fx = night({ fileAt: 3 * MIN, curatorWrites: true });
    await fx.run();
    expect(fx.digest()).toContain("Natten sammanfattad");
    expect(readFileSync(join(fx.workspace, "memory", "2026-09-05.md"), "utf8")).toContain("Curatorns egen anteckning");
    expect(existsSync(join(fx.workspace, "memory", "references", "care-2026-09-05.md"))).toBe(true);
  });
});

describe("a job still in the queue is not a sent prompt", () => {
  it("keeps polling until the job is submitted, then publishes the file", async () => {
    const fx = night({ submitAt: 40 * MIN, fileAt: 45 * MIN });
    await fx.run();
    expect(fx.queue.findById.mock.calls.length).toBeGreaterThan(30);
    expect(fx.queue.requestCancellation).not.toHaveBeenCalled();
    expect(fx.digest()).toContain("Natten sammanfattad");
  });

  it("removes a job that never left the queue at 12:00 local and says why", async () => {
    const fx = night({ submitAt: 10 * 60 * MIN });
    await expect(fx.run()).rejects.toThrow("dream-owner-prompt-pending");
    expect(fx.queue.requestCancellation).toHaveBeenCalledTimes(1);
    expect(fx.queue.requestCancellation.mock.calls[0][0]).toBe(fx.jobId);
    expect(fx.notices.join(" ")).toContain("dream-owner-prompt-pending");
    expect(existsSync(join(fx.workspace, "memory", "dream"))).toBe(false);
  });

  it("leaves a submitted job alone at 12:00 and reports the missing file", async () => {
    const fx = night({ submitAt: 5 * MIN });
    await expect(fx.run()).rejects.toThrow("dream-output-missing");
    expect(fx.elapsed()).toBeGreaterThanOrEqual(8 * 60 * MIN);
    expect(fx.queue.requestCancellation).not.toHaveBeenCalled();
    expect(fx.notices.join(" ")).toContain("dream-output-missing");
  });
});
