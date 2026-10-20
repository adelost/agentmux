import { component, feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuietStore, openEpisodes, quietEpisodes, unsentEpisodes } from "./quiet-episodes.mjs";
import { CLAW_156, LINES, askRow, ms, postRow, replyEndingWith, toLog } from "../test/fixtures/quiet-ledger.mjs";

// Guards I-1, UC-1 and R-2 of docs/DESIGN-quiet-panes.md. The ledger is synthetic; the claw:0 scenario has the real
// shape: three turns end with one line, asks from other panes arrive between them, and a footer follows each reply.
const OPERATOR = "Mattias";
const visibleAt = (rows, clock) => toLog(rows.filter((row) => Date.parse(row.ts) <= ms(clock)));
const scan = (rows, clock) => quietEpisodes(visibleAt(rows, clock), { untilMs: ms(clock), operator: OPERATOR });

feature("quiet: one episode per pane and waiting line", () => {
  unit("sends one forward for three replies with the same line", {
    given: ["claw:0's three replies with one line, and a cron that looks every 2 minutes from 09:20 to 09:40", () => ({
      rows: CLAW_156,
      ticks: Array.from({ length: 11 }, (_, index) => new Date(ms("09:20") + index * 120_000).toISOString().slice(11, 19)),
    })],
    when: ["every look forwards each open episode whose key is not yet seen, and marks it", ({ rows, ticks }) => {
      const seen = {};
      const forwards = [];
      for (const tick of ticks) {
        for (const episode of unsentEpisodes(openEpisodes(scan(rows, tick)), seen)) {
          forwards.push({ tick, key: episode.key, class: episode.verdict.class });
          seen[episode.key] = true;
        }
      }
      return { forwards, all: scan(rows, "10:00") };
    }],
    then: ["one forward, at the first look after the last reply was quiet for 3 minutes, and every quiet reply shares its key", ({ forwards, all }) => {
      expect(forwards).toEqual([{ tick: "09:34:00", key: expect.stringMatching(/^quiet:claw:0:[0-9a-f]{10}$/u), class: "decision" }]);
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(new Set(all.map((episode) => episode.key)).size).toBe(1);
      expect(all[0].sinceMs).toBe(ms("09:19:34"));
    }],
  });

  unit("a new ask ends the episode", {
    given: ["claw:3 quiet since 11:00, then asked at 11:12", () => {
      const reply = postRow("claw:3", "11:00:00", replyEndingWith(LINES.left));
      return { quiet: [reply], asked: [reply, askRow("claw:3", "11:12:00")] };
    }],
    when: ["looking at 11:10 before the ask and at 11:20 after it", ({ quiet, asked }) => ({
      before: openEpisodes(scan(quiet, "11:10")),
      after: openEpisodes(scan(asked, "11:20")),
      closed: scan(asked, "11:20"),
    })],
    then: ["the pane is an open episode until the ask, then none is open and the old one records when it ended", ({ before, after, closed }) => {
      expect(before.map((episode) => episode.pane)).toEqual(["claw:3"]);
      expect(after).toEqual([]);
      expect(closed.map((episode) => episode.endedMs)).toEqual([ms("11:12:00")]);
    }],
  });

  unit("a pane still working has no episode", {
    given: ["three panes at 12:00: a reply 2 minutes ago, a reply and another reply a minute ago, and a reply, an ask and a reply", () => [
      [postRow("claw:1", "11:58:00", "Zon 3 klar.")],
      [postRow("claw:2", "11:50:00", "Startar bygget."), postRow("claw:2", "11:59:00", "Bygget går.")],
      [postRow("claw:3", "11:50:00", "Klart för nu."), askRow("claw:3", "11:52:00"), postRow("claw:3", "11:58:00", "Tar nästa.")],
    ]],
    when: ["looking at 12:00", (cases) => cases.map((rows) => openEpisodes(scan(rows, "12:00")))],
    then: ["none of them is quiet for 3 minutes, so none is an episode", (episodes) => expect(episodes).toEqual([[], [], []])],
  });

  unit("a reply that Discord split in chunks is one reply, and a footer does not end it", {
    given: ["a 1 900 character chunk, its tail 500 ms later, and a footer", () => [
      postRow("claw:4", "10:00:00", `${"Bakgrund. ".repeat(190)}`),
      postRow("claw:4", "10:00:00", `Sist.\n${LINES.login}`, "reply", { ts: new Date(ms("10:00:00") + 500).toISOString(), id: "post:claw:4:tail" }),
      postRow("claw:4", "10:00:01", "-# ctx 40%", "notice"),
    ]],
    when: ["looking at 10:10", (rows) => scan(rows, "10:10")],
    then: ["one open episode that holds both chunks and is judged on the whole reply", (episodes) => {
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({ pane: "claw:4", endedMs: null, startMs: ms("10:00:00"), endMs: ms("10:00:00") + 500 });
      expect(episodes[0].reply).toContain("Bakgrund.");
      expect(episodes[0].verdict).toMatchObject({ class: "hands" });
    }],
  });

  unit("a reply with no waiting line is its own episode, keyed by the reply", {
    given: ["two done reports from one pane, 20 minutes apart", () => [
      postRow("claw:5", "10:00:00", LINES.done), postRow("claw:5", "10:20:00", LINES.done),
    ]],
    when: ["looking at 10:30", (rows) => scan(rows, "10:30")],
    then: ["two episodes with two keys, both closed or open by their own replies", (episodes) => {
      expect(episodes).toHaveLength(2);
      expect(new Set(episodes.map((episode) => episode.key)).size).toBe(2);
    }],
  });

  component("keeps the sent keys and his hands in files only he can read, and forgets keys after a day", {
    given: ["a store in its own folder", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-quiet-store-"));
      let clock = ms("09:00:00");
      const paths = { seenPath: join(dir, "quiet-seen.json"), handsPath: join(dir, "quiet-hands.json") };
      return { dir, paths, tick: (add) => { clock += add; }, make: () => createQuietStore({ ...paths, now: () => clock }) };
    }],
    when: ["marking a key, listing a pane, reopening the store a day later and marking another key", ({ make, tick, paths }) => {
      const store = make();
      store.markSeen("quiet:claw:0:aaaaaaaaaa", { at: ms("09:22:00"), state: "sent", target: "lsrc:0", kind: "forward" });
      store.setHands({ "skyvw:0": { since: ms("08:12:00"), line: LINES.login, what: "login", key: "quiet:skyvw:0:bbbbbbbbbb" } });
      const fresh = make();
      const reopened = { seen: fresh.seen(), hands: fresh.hands() };
      const modes = [paths.seenPath, paths.handsPath].map((path) => statSync(path).mode & 0o777);
      tick(25 * 3_600_000);
      store.markSeen("quiet:claw:0:cccccccccc", { at: ms("09:22:00") + 25 * 3_600_000, state: "unknown", target: "lsrc:0", kind: "forward" });
      return { reopened, modes, later: make().seen() };
    }],
    then: ["both files are mode 600, a reopened store sees them, and a day later only the new key is left", ({ reopened, modes, later }, { dir }) => {
      try {
        expect(modes).toEqual([0o600, 0o600]);
        expect(Object.keys(reopened.seen)).toEqual(["quiet:claw:0:aaaaaaaaaa"]);
        expect(reopened.hands["skyvw:0"]).toMatchObject({ what: "login" });
        expect(Object.keys(later)).toEqual(["quiet:claw:0:cccccccccc"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });
});
