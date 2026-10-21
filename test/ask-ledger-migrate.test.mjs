import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAskLedger, appendPost, readWindow } from "../core/ask-ledger.mjs";
import { migrateDailyLedger } from "../core/ask-ledger-migrate.mjs";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-import-"));
  return { root, path: join(root, "ask-ledger"), legacy: join(root, "ask-ledger.jsonl") };
};

feature("retained conversation is split losslessly by UTC day", () => {
  component("a late legacy append refuses completion and a later pass resumes without doubling prior rows", {
    given: ["an old writer that appends during the copy", () => {
      const fx = fixture();
      appendAskLedger({ id: "before", agent: "ai", pane: 3, verbatim: "before", ts: "2026-10-21T11:00:00Z" }, { path: fx.legacy });
      return fx;
    }],
    when: ["the source changes after it was copied", async fx => {
      let stopped;
      try { await migrateDailyLedger(fx.path, { apply: true, progress: () => {
        appendAskLedger({ id: "after", agent: "ai", pane: 3, verbatim: "after", ts: "2026-10-21T12:00:00Z" }, { path: fx.legacy });
      } }); } catch (error) { stopped = error.message; }
      const marked = existsSync(join(fx.path, "legacy-import.json"));
      const resumed = await migrateDailyLedger(fx.path, { apply: true });
      return { stopped, marked, resumed, log: readWindow({ path: fx.path }) };
    }],
    then: ["no changing source is hidden and both original inputs survive", ({ stopped, marked, resumed, log }) => {
      expect(stopped).toContain("ledger-import-source-changed"); expect(marked).toBe(false);
      expect(resumed.writtenRows).toBe(1);
      expect(log.asks.map(row => row.verbatim)).toEqual(["before", "after"]);
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("retains malformed legacy bytes without inventing a UTC day", {
    given: ["a complete but malformed old line", () => {
      const fx = fixture(); fx.before = Buffer.from('{broken åäö}\n'); writeFileSync(fx.legacy, fx.before); return fx;
    }],
    when: ["partitioning the old file", fx => migrateDailyLedger(fx.path, { apply: true })],
    then: ["both originals and the explicit unassigned copy retain every byte", (result, fx) => {
      expect(result.days["legacy-unassigned"]).toBe(1);
      expect(readFileSync(fx.legacy)).toEqual(fx.before);
      expect(readFileSync(join(fx.path, "legacy-unassigned.jsonl"))).toEqual(fx.before);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("keeps native appends, old duplicate occurrences, files and tool posts across an idempotent import", {
    given: ["legacy input and posts plus an already active daily writer", () => {
      const fx = fixture();
      appendAskLedger({ id: "old-ask", agent: "ai", pane: 3, source: "discord", verbatim: "behåll åäö", ts: "2026-10-20T23:59:59Z" }, { path: fx.legacy });
      const askBytes = readFileSync(fx.legacy);
      appendPost({ agent: "ai", pane: 3, channelId: "c", via: "bridge", kind: "file", payload: { files: ["/proof.png"] }, ts: "2026-10-21T00:00:01Z" }, { path: fx.legacy });
      writeFileSync(fx.legacy, Buffer.concat([readFileSync(fx.legacy), askBytes]));
      fx.before = readFileSync(fx.legacy);
      appendPost({ agent: "ai", pane: 3, channelId: "c", via: "bridge", kind: "reply", payload: "`Run exact proof`", ts: "2026-10-21T01:00:00Z" }, { path: fx.path });
      return fx;
    }],
    when: ["importing twice beside the live daily data", async fx => {
      const first = await migrateDailyLedger(fx.path, { apply: true });
      const second = await migrateDailyLedger(fx.path, { apply: true });
      return { first, second, log: readWindow({ path: fx.path }) };
    }],
    then: ["all raw old rows survive exactly once per old occurrence and normal reads retain all content", ({ first, second, log }, fx) => {
      expect(first.writtenRows).toBe(3);
      expect(second.writtenRows).toBe(0);
      expect(readFileSync(fx.legacy)).toEqual(fx.before);
      expect(readFileSync(join(fx.path, "2026-10-20.jsonl"))).toEqual(Buffer.concat([fx.before.subarray(0, fx.before.indexOf(10) + 1), fx.before.subarray(0, fx.before.indexOf(10) + 1)]));
      expect(log.asks.map(row => row.verbatim)).toEqual(["behåll åäö"]);
      expect(log.posts.map(row => row.kind)).toEqual(["file", "reply"]);
      expect(log.posts[0].files).toEqual(["/proof.png"]);
      expect(log.posts[1].text).toBe("`Run exact proof`");
      expect(log.files.every(file => file.startsWith(fx.path + "/"))).toBe(true);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("an incomplete source is retained and cannot publish an import-complete marker", {
    given: ["a legacy writer's incomplete final row", () => {
      const fx = fixture(); writeFileSync(fx.legacy, '{"version":1,"event":"ask"'); return fx;
    }],
    when: ["trying the import", async fx => {
      try { await migrateDailyLedger(fx.path, { apply: true }); } catch (error) { return error.message; }
    }],
    then: ["the uncertainty remains explicit and originals stay readable", (reason, fx) => {
      expect(reason).toContain("ledger-import-incomplete-line");
      expect(readFileSync(fx.legacy, "utf8")).toBe('{"version":1,"event":"ask"');
      expect(existsSync(join(fx.path, "legacy-import.json"))).toBe(false);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("a second importer cannot take an existing import lock", {
    given: ["an active or unverified prior importer", () => {
      const fx = fixture(); mkdirSync(join(fx.path, "import.lock"), { recursive: true }); return fx;
    }],
    when: ["trying to import concurrently", async fx => {
      try { await migrateDailyLedger(fx.path, { apply: true }); } catch (error) { return error.code; }
    }],
    then: ["the old lock remains and no result is forged", (code, fx) => {
      expect(code).toBe("EEXIST"); expect(existsSync(join(fx.path, "import.lock"))).toBe(true);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
