import { unit, feature, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createState } from "./state.mjs";
import { openWatcherJournal } from "./watcher-journal.mjs";

const tempState = () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-watcher-journal-"));
  return { dir, path: join(dir, "agentmux-state.json") };
};

feature("watcher journal", () => {
  unit("posted ids and the work row survive a restart outside the state file", {
    given: ["a state file that still holds posted ids", () => {
      const ctx = tempState();
      writeFileSync(ctx.path, JSON.stringify({ watcher_posted_item_ids: { ch: ["a", "b"] }, other: 1 }));
      const journal = openWatcherJournal({ state: createState(ctx.path) });
      journal.setPosted("ch", ["a", "b", "c"]);
      journal.setWork("ch", { messageId: "m1", turnKey: "t1", count: 3, seen: ["x"] });
      return ctx;
    }],
    when: ["the bridge starts again on the same state file", ({ path }) => openWatcherJournal({ state: createState(path) })],
    then: ["the journal has both and the state file has neither", (journal, { dir, path }) => {
      try {
        expect(journal.posted("ch")).toEqual(["a", "b", "c"]);
        expect(journal.work("ch")).toEqual({ messageId: "m1", turnKey: "t1" });
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: 1 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  // defect: channel_last_mirror_ts made the state file the busiest writer after 1.25.387 (10 of 16 saves in 10 s).
  unit("mirror stamps leave the state file even when the journal already exists", {
    given: ["a journal from an earlier release and a state file with stamps", () => {
      const ctx = tempState();
      writeFileSync(join(ctx.dir, "watcher-journal.jsonl"), `${JSON.stringify({ c: "ch", postedAll: ["a"] })}\n`);
      writeFileSync(ctx.path, JSON.stringify({ channel_last_mirror_ts: { ch: "2026-10-27T22:00:00.000Z" }, other: 1 }));
      return ctx;
    }],
    when: ["the bridge starts and stamps another channel", ({ path }) => {
      const journal = openWatcherJournal({ state: createState(path) });
      journal.setMirrorTs("ch2", "2026-10-27T22:30:00.000Z");
      return openWatcherJournal({ state: createState(path) });
    }],
    then: ["both stamps are in the journal and none in the state file", (journal, { dir, path }) => {
      try {
        expect([journal.mirrorTs("ch"), journal.mirrorTs("ch2"), journal.posted("ch")])
          .toEqual(["2026-10-27T22:00:00.000Z", "2026-10-27T22:30:00.000Z", ["a"]]);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: 1 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  unit("the journal file stays under its cap and keeps the newest ids", {
    given: ["a journal capped at 4 KB", () => {
      const ctx = tempState(), state = createState(ctx.path);
      const journal = openWatcherJournal({ state, maxBytes: 4096 });
      const ids = [];
      for (let i = 0; i < 400; i++) { ids.push(`id-${i}`); journal.setPosted("ch", ids.slice(-1000)); }
      return { ...ctx, state };
    }],
    when: ["it is read back after a restart", ({ path }) => openWatcherJournal({ state: createState(path) })],
    then: ["the newest id is there and the file is small", (journal, { dir }) => {
      try {
        expect(journal.posted("ch").at(-1)).toBe("id-399");
        expect(journal.posted("ch")).toHaveLength(400);
        expect(statSync(join(dir, "watcher-journal.jsonl")).size).toBeLessThan(8192);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });
});
