import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAskLedger, appendPost, readWindow, ledgerSpans } from "./ask-ledger.mjs";

feature("one canonical log file per UTC day", () => {
  component("a writer crosses midnight without rotating or losing prior input, files or tool mirrors", {
    given: ["an isolated daily ledger directory", () => {
      const root = mkdtempSync(join(tmpdir(), "daily-ledger-"));
      return { root, path: join(root, "ask-ledger") };
    }],
    when: ["recording both sides of UTC midnight", fx => {
      appendAskLedger({ agent: "ai", pane: 3, source: "discord", verbatim: "behåll åäö", ts: "2026-10-21T23:59:59Z" }, { path: fx.path });
      appendPost({ agent: "ai", pane: 3, channelId: "c", via: "bridge", kind: "reply", payload: "`Run existing proof`", ts: "2026-10-22T00:00:01Z" }, { path: fx.path });
      appendPost({ agent: "ai", pane: 3, channelId: "c", via: "bridge", kind: "file", payload: { files: ["/proof.png"] }, ts: "2026-10-22T00:00:02Z" }, { path: fx.path });
      return { names: readdirSync(fx.path), spans: ledgerSpans(fx.path),
        log: readWindow({ path: fx.path, since: "2026-10-21T00:00:00Z", until: "2026-10-23T00:00:00Z" }) };
    }],
    then: ["both dated files and all three records remain normally readable", (result, fx) => {
      expect(result.names).toEqual(["2026-10-21.jsonl", "2026-10-22.jsonl"]);
      expect(result.log.asks.map(row => row.verbatim)).toEqual(["behåll åäö"]);
      expect(result.log.posts.map(row => row.kind)).toEqual(["reply", "file"]);
      expect(readFileSync(join(fx.path, "2026-10-22.jsonl"), "utf8")).toContain("`Run existing proof`");
      expect(result.spans[0].lastMs).toBe(Date.parse("2026-10-22T00:00:00Z") - 1);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
