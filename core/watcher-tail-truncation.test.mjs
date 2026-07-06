import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readLastTurns } from "./jsonl-reader.mjs";
import { planPaneMirrorStep, applyPostSuccess } from "./watcher-engine.mjs";

// Regression: a turn whose >4MB tool_results push its user-prompt marker out of
// the 4MB tail window must still mirror its FINAL text. Before the fix the turn
// could not be reconstructed (orphaned assistant events -> turns=0) OR the
// positional posted-count drifted under the sliding window and the final text
// was skipped forever. See W-WATCHER-TAIL.

// Window << turn is the invariant under test; absolute size is irrelevant, so
// use a small window + a turn that outgrows it (keeps the test fast: a real
// 4MB/15MB repro is covered by the standalone harness).
const TAIL = 256 * 1024;
const PANE_DIR = "/repro/pane";
const SLUG = PANE_DIR.replace(/[\/\.]/g, "-");

let uuidN = 0;
const uuid = () => `uuid-${String(++uuidN).padStart(6, "0")}`;
const line = (o) => JSON.stringify(o) + "\n";

function buildBigTurnSession(dir) {
  uuidN = 0;
  let clock = Date.parse("2026-07-06T10:00:00.000Z");
  const ts = () => new Date((clock += 1000)).toISOString();
  const projDir = join(dir, ".claude", "projects", SLUG);
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, "session.jsonl");

  const userPrompt = (t) => line({ type: "user", uuid: uuid(), timestamp: ts(), message: { role: "user", content: t } });
  const asstText = (t, stop = null) => line({ type: "assistant", uuid: uuid(), timestamp: ts(), message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text: t }] } });
  const asstTool = (n) => line({ type: "assistant", uuid: uuid(), timestamp: ts(), message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", name: n, id: uuid(), input: {} }] } });
  const bigResult = (bytes) => line({ type: "user", uuid: uuid(), timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "image", source: { data: "A".repeat(bytes) } }] }] } });

  // A prior, already-posted turn, then the big screenshot turn.
  writeFileSync(file, userPrompt("earlier") + asstText("earlier reply", "end_turn"));
  const cursorSeed = clock; // checkpoint sits just before the big turn starts
  let big = userPrompt("take 10 screenshots and summarize");
  for (let i = 0; i < 8; i++) { big += asstTool("screenshot"); big += bigResult(200_000); }
  big += asstText("Here are the shots. All correct. [FINAL SUMMARY]", "end_turn");
  appendFileSync(file, big);
  return { file, cursorSeed };
}

function drivePolls(dir, file, cursorSeed) {
  const state = { lastPostedMs: cursorSeed, postedItemIds: [], retryUntilMs: null };
  const posted = [];
  let now = Date.parse("2026-07-06T11:00:00.000Z");
  const poll = () => {
    now += 10_000;
    const res = readLastTurns(PANE_DIR, { limit: 20, tailBytes: TAIL, headless: true });
    const planned = planPaneMirrorStep({
      turns: res?.turns || [],
      lastPostedMs: state.lastPostedMs,
      postedItemIds: state.postedItemIds,
      truncated: statSync(file).size > TAIL,
      retryUntilMs: state.retryUntilMs,
      nowMs: now,
      latestMtimeMs: now - 60_000,
      completionGraceMs: 5_000,
      maxPostActions: 3,
    });
    state.lastPostedMs = planned.nextState.lastPostedMs;
    state.postedItemIds = planned.nextState.postedItemIds;
    state.retryUntilMs = planned.nextState.retryUntilMs;
    for (const a of planned.actions) {
      for (const it of a.turn.items) posted.push(it.content);
      Object.assign(state, applyPostSuccess(state, a));
    }
  };
  poll(); // big turn complete, head truncated
  appendFileSync(file, line({ type: "user", uuid: uuid(), timestamp: new Date().toISOString(), message: { role: "user", content: "next" } }));
  poll(); // window slides forward
  poll(); // and again — must NOT re-post
  return posted;
}

feature("watcher tail-window truncation (W-WATCHER-TAIL)", () => {
  unit("mirrors the final text of a >4MB-tool-result turn exactly once", {
    given: ["a session whose big screenshot turn outgrows the 4MB tail window", () => {
      const home = mkdtempSync(join(tmpdir(), "wtt-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      const { file, cursorSeed } = buildBigTurnSession(home);
      return { home, prevHome, file, cursorSeed };
    }],
    when: ["driving three polls across the sliding window", (ctx) => {
      try {
        const posted = drivePolls(ctx.home, ctx.file, ctx.cursorSeed);
        return { posted };
      } finally {
        process.env.HOME = ctx.prevHome;
        rmSync(ctx.home, { recursive: true, force: true });
      }
    }],
    then: ["the final summary posts exactly once, never skipped, never duplicated", ({ posted }) => {
      const finals = posted.filter((t) => t.includes("[FINAL SUMMARY]"));
      expect(finals).toHaveLength(1);
    }],
  });
});

feature("watcher engine: id-based dedupe survives the sliding window", () => {
  const item = (content, id) => ({ type: content === "final" ? "text" : "tool", content, id });
  const complete = (items) => ({
    timestamp: "2026-07-06T10:00:10.000Z",
    endTimestamp: "2026-07-06T10:00:20.000Z",
    userPrompt: null,
    headless: true,
    isComplete: true,
    items,
  });
  const cursor = new Date("2026-07-06T10:00:05.000Z").getTime();

  unit("a final item still unposted is posted even when earlier items scrolled out", {
    given: ["poll 1 shows [toolA, toolB, final]; a slide will drop toolA", () => ({
      poll1: complete([item("toolA", "u1:0"), item("toolB", "u2:0"), item("final", "u3:0")]),
    })],
    when: ["planning poll 1, then poll 2 where the window dropped toolA (final not yet posted there)", ({ poll1 }) => {
      const p1 = planPaneMirrorStep({ turns: [poll1], lastPostedMs: cursor, postedItemIds: ["u1:0", "u2:0"], truncated: true });
      // p1 should post `final` (u3:0). Simulate the slide: window now shows only [toolB, final].
      const slid = complete([item("toolB", "u2:0"), item("final", "u3:0")]);
      const postedAfterP1 = ["u1:0", "u2:0", ...p1.actions.flatMap((a) => a.postedIds)];
      const p2 = planPaneMirrorStep({ turns: [slid], lastPostedMs: cursor, postedItemIds: postedAfterP1, truncated: true });
      return { p1, p2 };
    }],
    then: ["poll 1 posts the final once; poll 2 posts nothing (no duplicate) and holds the truncated turn", ({ p1, p2 }) => {
      expect(p1.actions).toHaveLength(1);
      expect(p1.actions[0].turn.items.map((i) => i.content)).toEqual(["final"]);
      expect(p2.actions).toHaveLength(0);
      expect(p2.notes.some((n) => n.type === "hold-truncated")).toBe(true);
      expect(p2.notes.some((n) => n.type === "advance-empty")).toBe(false);
    }],
  });
});
