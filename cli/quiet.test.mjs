import { component, feature, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdQuiet, sendThroughAmux } from "./quiet.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createQuietStore } from "../core/quiet-episodes.mjs";
import {
  ACTIVE_PANES, CLAW_156, LINES, ROSTER, askRow, ms, postRow, replyEndingWith, writeLedger,
} from "../test/fixtures/quiet-ledger.mjs";

// Guards I-2, UC-1, UC-2, UC-4, UC-6 and R-4 of docs/DESIGN-quiet-panes.md. The ledger is synthetic, written by the real
// writers; the send call is a double that records what would have left, and says how the delivery ended.
const CLAW_UNTIL_THIRD_REPLY = CLAW_156.filter((row) => Date.parse(row.ts) < ms("09:37:38"));

function world({ rows, now, status = () => "idle", outcome = "sent", park = {}, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "amux-quiet-cli-"));
  const ledger = writeLedger(rows);
  const sent = [];
  const out = [];
  let clock = ms(now);
  const store = createQuietStore({ seenPath: join(dir, "quiet-seen.json"), handsPath: join(dir, "quiet-hands.json"), now: () => clock });
  const deps = {
    now: () => clock,
    ledgerPath: ledger.path,
    paneStatus: async (agent, pane) => status(`${agent}:${pane}`),
    send: async (message) => { sent.push(message); return { outcome: typeof outcome === "function" ? outcome(message) : outcome }; },
    parkStore: { read: (agent, pane) => park[`${agent}:${pane}`] || null },
    store,
    rosterText: ROSTER,
    env,
    out: (line) => out.push(line),
  };
  return {
    sent, out, store, ledger,
    at: (clockTime) => { clock = ms(clockTime); },
    run: (args, extra = {}) => cmdQuiet(args, {}, { ...deps, ...extra }),
    text: () => out.join("\n"),
    remove: () => { ledger.remove(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// Design v4: in the replay of 06:00 to 10:00Z, claw:0 asked one decision in two wordings (09:10 and 09:19Z) and both
// were forwarded within 9 minutes.
const TWO_WORDINGS = [
  postRow("claw:4", "09:10:00", replyEndingWith("- **Utan ditt ja** blir det ett klipp utan röster.")),
  askRow("claw:4", "09:15:00", "[from skydive:2]\n\nStatus på tåget?"),
  postRow("claw:4", "09:19:00", replyEndingWith(LINES.decision)),
];

feature("amux quiet --act: the one obvious action", () => {
  component("forwards one decision per pane until the delegate has answered it", {
    given: ["claw:4 asks a yes or no at 09:10 and again in other words at 09:19, once with lsrc:0 answering in between", () => ({
      unanswered: world({ rows: [...TWO_WORDINGS, ...ACTIVE_PANES], now: "09:14:00" }),
      answered: world({ rows: [...TWO_WORDINGS, askRow("claw:4", "09:16:00", "[from lsrc:0]\n\nVänta med det."), ...ACTIVE_PANES], now: "09:14:00" }),
    })],
    when: ["the cron runs at 09:14 and at 09:23 in both", async (worlds) => {
      for (const w of Object.values(worlds)) { await w.run(["--act"]); w.at("09:23:00"); await w.run(["--act"]); }
      return worlds;
    }],
    then: ["one forward while unanswered; a new wording after an answer is forwarded again", ({ unanswered, answered }) => {
      try {
        const toDelegate = (w) => w.sent.filter((message) => message.agent === "lsrc" && message.pane === 0).length;
        expect([toDelegate(unanswered), toDelegate(answered)]).toEqual([1, 2]);
      } finally { unanswered.remove(); answered.remove(); }
    }],
  });

  component("forwards a decision once and reminds once", {
    given: ["claw:0 with the same decision line in three replies, and lsrc:0 active", () => world({ rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES], now: "09:34:00" })],
    when: ["the cron runs at 09:34, 09:36, 10:05 and 10:30", async (w) => {
      await w.run(["--act"]);
      w.at("09:36:00"); await w.run(["--act"]);
      w.at("10:05:00"); await w.run(["--act"]);
      w.at("10:30:00"); await w.run(["--act"]);
      return w;
    }],
    then: ["one forward to lsrc:0 at once, one reminder 30 minutes later, and nothing else", (w) => {
      try {
        expect(w.sent.map(({ agent, pane, key }) => ({ target: `${agent}:${pane}`, key }))).toEqual([
          { target: "lsrc:0", key: expect.stringMatching(/^quiet:claw:0:[0-9a-f]{10}$/u) },
          { target: "lsrc:0", key: expect.stringMatching(/^quiet:claw:0:[0-9a-f]{10}:reminder$/u) },
        ]);
        const [forward, reminder] = w.sent;
        expect(reminder.key).toBe(`${forward.key}:reminder`);
        expect(forward.text).toMatch(/^\[quiet\] claw:0 waits for a decision you can make \(09:19Z\): "Väntar på dig\. Ja eller nej .*" Reply to claw:0\.$/u);
        expect(forward.text.length).toBeLessThanOrEqual(400);
        expect(reminder.text).toBe("[quiet] reminder: claw:0 still waits for your decision since 09:19Z (forwarded 09:34Z).");
      } finally { w.remove(); }
    }],
  });

  component("does not remind when lsrc:0 has already answered the pane", {
    given: ["a forwarded decision, an answer from lsrc:0 at 09:50, and the pane ending with the same line again at 09:52", () => {
      const w = world({ rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES], now: "09:34:00" });
      return w;
    }],
    when: ["the cron forwards, the answer and the repeated line arrive, and the cron runs at 10:30", async (w) => {
      await w.run(["--act"]);
      w.ledger.append(askRow("claw:0", "09:50:00", "[from lsrc:0]\n\nJa, kör på det."));
      w.ledger.append(postRow("claw:0", "09:52:00", replyEndingWith(LINES.decision)));
      w.at("10:30:00");
      await w.run(["--act"]);
      return w;
    }],
    then: ["only the forward was sent", (w) => {
      try { expect(w.sent).toHaveLength(1); } finally { w.remove(); }
    }],
  });

  // The cron's clock is 20 minutes after the stop since design v4, where work left counts as quiet only then.
  component("nudges an active lead once for work left", {
    given: ["claw:3 stopped with work left at 09:40, and claw:0, its lead by the roster's pane 0 rule, active at 09:30", () => world({
      rows: [postRow("claw:3", "09:40:00", `NOW: zon 3 byggs\n${LINES.left}`), askRow("claw:0", "09:30:00", "Läget?")], now: "10:01:00",
    })],
    when: ["the cron runs twice", async (w) => { await w.run(["--act"]); w.at("10:03:00"); await w.run(["--act"]); return w; }],
    then: ["one nudge to claw:0 that quotes the LEFT line", (w) => {
      try {
        expect(w.sent).toHaveLength(1);
        expect(w.sent[0]).toMatchObject({ agent: "claw", pane: 0, key: expect.stringMatching(/^quiet:claw:3:[0-9a-f]{10}$/u) });
        expect(w.sent[0].text).toBe("[quiet] claw:3 stopped at 09:40Z with work left and no blocker: \"LEFT: bygg zon 4 och kör gränstesten\". Restart it or hand the work on.");
      } finally { w.remove(); }
    }],
  });

  component("never nudges a dormant lead", {
    given: ["claw:3 stopped with work left at 09:40, and claw:0 last seen at 07:30", () => world({
      rows: [postRow("claw:3", "09:40:00", `NOW: zon 3 byggs\n${LINES.left}`), askRow("claw:0", "07:30:00", "Läget?")], now: "10:01:00",
    })],
    when: ["the cron runs", async (w) => { await w.run(["--act"]); return w; }],
    then: ["nothing is sent and nothing is marked as sent, so a lead that wakes is still told", (w) => {
      try {
        expect(w.sent).toEqual([]);
        expect(w.store.seen()).toEqual({});
        expect(w.text()).toContain("lead claw:0 is dormant");
      } finally { w.remove(); }
    }],
  });

  component("marks an unknown outcome as sent", {
    given: ["a decision forward whose delivery ends unverified", () => world({
      rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES], now: "09:34:00", outcome: "unknown",
    })],
    when: ["the cron runs twice", async (w) => { await w.run(["--act"]); w.at("09:36:00"); await w.run(["--act"]); return w; }],
    then: ["the send was tried once, the key is kept as unknown, and it is never resent", (w) => {
      try {
        expect(w.sent).toHaveLength(1);
        expect(Object.values(w.store.seen())).toEqual([expect.objectContaining({ state: "unknown", target: "lsrc:0", kind: "forward" })]);
      } finally { w.remove(); }
    }],
  });

  component("retries a refused send 10 minutes apart, gives up after three, and never marks it as sent", {
    given: ["a decision forward that the queue refuses", () => world({
      rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES], now: "09:34:00", outcome: "failed",
    })],
    when: ["the cron runs at 09:34, 09:36, 09:44, 09:54 and 10:04", async (w) => {
      for (const clock of ["09:34:00", "09:36:00", "09:44:00", "09:54:00", "10:04:00"]) { w.at(clock); await w.run(["--act"]); }
      return w;
    }],
    then: ["it tried at 09:34, 09:44 and 09:54 and no more, and the key says failed", (w) => {
      try {
        expect(w.sent).toHaveLength(3);
        expect(Object.values(w.store.seen())).toEqual([expect.objectContaining({ state: "failed", attempts: 3 })]);
      } finally { w.remove(); }
    }],
  });

  component("maps the outcome of amux's own send to sent, unknown or failed, with the key", {
    given: ["the four ways sendToPane ends: queued, unverified, refused and thrown, and a double that records what it was asked", () => {
      const asked = [];
      const ending = (result) => async (...call) => { asked.push(call); if (result instanceof Error) throw result; return result; };
      return { asked, queued: ending({ delivered: true, pending: true }), unverified: ending({ delivered: true, unverified: true }),
        refused: ending({ delivered: false, blocked: true, reason: "human-quote" }), thrown: ending(new Error("unknown agent 'x'")) };
    }],
    when: ["sending one message through each", async ({ queued, unverified, refused, thrown }) => {
      const message = { agent: "lsrc", pane: 0, text: "[quiet] test", key: "quiet:claw:0:abc" };
      return Promise.all([queued, unverified, refused, thrown].map((deliverTo) => sendThroughAmux({}, message, deliverTo)));
    }],
    then: ["queued is sent, unverified is unknown and never resent, a refusal or an exception is failed, and the key rides along", (outcomes, { asked }) => {
      expect(outcomes.map(({ outcome }) => outcome)).toEqual(["sent", "unknown", "failed", "failed"]);
      expect(outcomes[2].detail).toBe("human-quote");
      expect(asked.every(([, agent, pane, , options]) => agent === "lsrc" && pane === 0 && options.idempotencyKey === "quiet:claw:0:abc")).toBe(true);
    }],
  });

  component("sends through amux's own delivery queue, one job per key", {
    given: ["an empty delivery queue in its own folder, and a message with its key", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-quiet-queue-"));
      const queue = createDeliveryQueue({ rootDir: join(dir, "queue") });
      return { dir, queue, ctx: { deliveryQueue: queue, deliveryWaitMs: 0 },
        message: { agent: "quiettest", pane: 0, text: "[quiet] claw:0 waits for a decision you can make (09:19Z): \"Väntar på dig.\" Reply to claw:0.", key: "quiet:claw:0:abc1234567" } };
    }],
    when: ["the same message is sent twice, and another key once", async ({ ctx, message }) => [
      await sendThroughAmux(ctx, message), await sendThroughAmux(ctx, message),
      await sendThroughAmux(ctx, { ...message, key: `${message.key}:reminder`, text: "[quiet] reminder" }),
    ]],
    then: ["every send is queued and sent, and the queue holds one job for the key and one for the other key", (outcomes, { queue, dir, message }) => {
      try {
        expect(outcomes.map(({ outcome }) => outcome)).toEqual(["sent", "sent", "sent"]);
        const jobs = queue.list("quiettest", 0);
        expect(jobs.map(({ idempotencyKey, text }) => ({ idempotencyKey, text })).sort((a, b) => a.text.length - b.text.length)).toEqual([
          { idempotencyKey: `${message.key}:reminder`, text: "[quiet] reminder" },
          { idempotencyKey: message.key, text: message.text },
        ]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("lists his hands without a message", {
    given: ["skyvw:0 waiting for a login at 08:12", () => world({ rows: [postRow("skyvw:0", "08:12:00", replyEndingWith(LINES.login))], now: "08:20:00" })],
    when: ["the cron runs, lsrc:0 reads the list, then a message reaches skyvw:0 and the cron runs again", async (w) => {
      await w.run(["--act"]);
      const listed = w.store.hands();
      w.out.length = 0;
      await w.run(["--hands"]);
      const printed = w.text();
      w.ledger.append(askRow("skyvw:0", "08:30:00", "[from lsrc:0]\n\nInloggad, kör."));
      w.at("08:40:00");
      await w.run(["--act"]);
      return { w, listed, printed, after: w.store.hands() };
    }],
    then: ["no message left, the line shows with its pane, time and kind, and the entry goes with the next ask", ({ w, listed, printed, after }) => {
      try {
        expect(w.sent).toEqual([]);
        expect(listed["skyvw:0"]).toMatchObject({ since: ms("08:12:00"), what: "login" });
        expect(printed).toBe("skyvw:0 · since 08:12Z · login: \"Logga in på Play Console i din webbläsare, sedan kör jag vidare.\"");
        expect(after).toEqual({});
      } finally { w.remove(); }
    }],
  });

  component("does not act on a pane that is working, and acts when it is quiet", {
    given: ["the claw:0 decision, while tmux says claw:0 is working", () => {
      const state = { claw: "working" };
      const w = world({ rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES], now: "09:34:00", status: (pane) => (pane === "claw:0" ? state.claw : "idle") });
      return { w, state };
    }],
    when: ["the cron runs while it works, and again after it stops", async ({ w, state }) => {
      await w.run(["--act"]);
      const whileWorking = [...w.sent];
      state.claw = "idle";
      w.at("09:36:00");
      await w.run(["--act"]);
      return { w, whileWorking };
    }],
    then: ["nothing left while it worked, and nothing was marked, so the forward goes once it is quiet", ({ w, whileWorking }) => {
      try {
        expect(whileWorking).toEqual([]);
        expect(w.sent).toHaveLength(1);
      } finally { w.remove(); }
    }],
  });

  component("AMUX_QUIET=0 shows what it would send and sends and marks nothing", {
    given: ["the claw:0 decision", () => world({ rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES], now: "09:34:00" })],
    when: ["the cron runs with the switch off, then with it on", async (w) => {
      await w.run(["--act"], { env: { AMUX_QUIET: "0" } });
      const dry = { sent: [...w.sent], seen: w.store.seen(), text: w.text() };
      await w.run(["--act"], { env: {} });
      return { w, dry };
    }],
    then: ["the dry run prints the forward and leaves no mark, so the real run still sends it", ({ w, dry }) => {
      try {
        expect(dry.sent).toEqual([]);
        expect(dry.seen).toEqual({});
        expect(dry.text).toMatch(/AMUX_QUIET=0.*forward to lsrc:0/su);
        expect(w.sent).toHaveLength(1);
      } finally { w.remove(); }
    }],
  });

  component("keeps lsrc:0's own decision line away from lsrc:0", {
    given: ["lsrc:0 ending a turn with a yes or no for the delegate, beside claw:0's decision", () => world({
      rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES, postRow("lsrc:0", "09:40:00", replyEndingWith(LINES.decision))], now: "09:44:00",
    })],
    when: ["the cron runs", async (w) => { await w.run(["--act"]); return w; }],
    then: ["only claw:0's decision is forwarded", (w) => {
      try {
        expect(w.sent.map(({ key }) => key.split(":").slice(1, 3).join(":"))).toEqual(["claw:0"]);
      } finally { w.remove(); }
    }],
  });

  component("leaves a parked pane to the quota park", {
    given: ["the claw:0 decision while the park store holds claw:0, beside the same line from skyvw:2, which is not parked", () => world({
      rows: [...CLAW_UNTIL_THIRD_REPLY, ...ACTIVE_PANES, postRow("skyvw:2", "09:31:00", replyEndingWith(LINES.decision))], now: "09:44:00",
      park: { "claw:0": { agentName: "claw", pane: 0, state: "parked", parkedAt: "2026-10-20T09:00:00.000Z" } },
    })],
    when: ["the cron runs", async (w) => { await w.run(["--act"]); return w; }],
    then: ["only skyvw:2's decision is forwarded", (w) => {
      try {
        expect(w.sent.map(({ key }) => key.split(":").slice(1, 3).join(":"))).toEqual(["skyvw:2"]);
      } finally { w.remove(); }
    }],
  });
});

feature("amux quiet --replay: what the cron would have done", () => {
  // A login at skyvw:0 and a bare question at lsrc:2, each after a message of his, beside claw:0's three replies.
  const replayWorld = () => world({
    rows: [
      ...CLAW_156, ...ACTIVE_PANES,
      askRow("skyvw:0", "09:40:00", "Hur går uppladdningen?", { source: "discord" }),
      postRow("skyvw:0", "09:42:00", replyEndingWith(LINES.login)),
      askRow("lsrc:2", "09:50:00", "Hur ser PR 7 ut?", { source: "discord" }),
      postRow("lsrc:2", "09:51:00", LINES.question),
    ],
    now: "12:00:00",
  });
  const replay = async (w) => {
    await w.run(["--replay", "--since", "2026-10-20T09:00:00Z", "--until", "2026-10-20T10:00:00Z"], {
      send: async () => { throw new Error("replay must not send"); },
    });
    return w;
  };

  component("replay sends nothing", {
    given: ["a ledger with a decision, a login and a bare question, and a send that throws if it is called", replayWorld],
    when: ["replaying 09:00 to 10:00", replay],
    then: ["nothing was sent, and neither the seen file nor the hands list was written", (w) => {
      try {
        expect(w.sent).toEqual([]);
        expect(w.store.seen()).toEqual({});
        expect(w.store.hands()).toEqual({});
      } finally { w.remove(); }
    }],
  });

  component("the replay forwards claw:0's line once and counts needs-you before and after", {
    given: ["claw:0's three replies, a login at skyvw:0 and a bare question at lsrc:2", replayWorld],
    when: ["replaying 09:00 to 10:00", replay],
    then: ["one forward for claw:0, one hands and one decision episode, needs-you 2 before and 1 after, and the former ones by pane and time", (w) => {
      try {
        const text = w.text();
        expect(text.match(/forward to lsrc:0/gu)).toHaveLength(1);
        expect(text).toMatch(/^09:2\dZ claw:0 +decision +forward to lsrc:0/mu);
        expect(text).toMatch(/09:00–10:00Z · \d+ episodes · hands 1 · decision 1 · quota 0 · left work 0 · done 0 · unclear \d+/u);
        expect(text).toMatch(/needs-you in asks: before 2, after 1/u);
        expect(text).toMatch(/^ {2}claw:0 09:15Z → delegate$/mu);
        expect(text).toMatch(/^ {2}lsrc:2 09:50Z → answered$/mu);
        expect(text).toMatch(/^needs-you now: skyvw:0 09:40Z$/mu);
      } finally { w.remove(); }
    }],
  });
});
