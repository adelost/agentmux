import { feature, unit, component, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHumanQuotes, readRecentHumanMessages, refuseHumanQuote } from "./human-quote-guard.mjs";

// Synthetic stand-ins for his voice messages; the real ones never enter this public repo.
const NOW = Date.parse("2026-10-19T06:00:00Z");
const delegation = { ts: NOW - 2 * 3_600_000, to: "lsrc:0", text: "[transcribed voice, may contain speech-to-text errors;"
  + " interpret intent] Jag tycker att ni ska bestämma åt mig, så får jag rätta till det efteråt om något blir fel." };
const order = { ts: NOW - 3_600_000, to: "lsrc:0", text: "Kör det ni rekommenderar och motivera varför ni väljer som ni gör. "
  + "Bilden ligger här /home/x/.agentmux/discord-inbound/assets/1526179429137518653/a.jpg och länken https://example.test/a/b/c/d/e/f" };
const messages = [delegation, order];

const pasted = "[from lsrc:0]\n\nAuthority, Mattias, verbatim: \"JAG TYCKER att ni ska bestämma åt mig — så får jag rätta till det"
  + " efteråt!\" And: \"Kör det ni rekommenderar och motivera varför ni väljer.\"\n1. Give row 21 a builder now.";
const rewritten = "[from lsrc:0]\n\nAuthority: on 19 Oct Mattias handed these decisions to the fleet; decide for him, run"
  + " what you recommend with the reason, and he corrects afterwards (decision log 2026-10-19).\n1. Give row 21 a builder now.";

feature("refusing a send that pastes his words", () => {
  unit("a brief with eight or more of his consecutive words is refused and every run is named", {
    when: ["the guard reads a brief that quotes two of his messages", () => refuseHumanQuote(pasted, { enabled: true, messages: () => messages })],
    then: ["case, dashes and punctuation do not hide either quote, and åäö survive", (refusal) => {
      expect(refusal).toContain("amux: refused. This message pastes Mattias's own words:");
      expect(refusal).toContain("\"jag tycker att ni ska bestämma åt mig så får jag rätta till det efteråt\" (15 words, his message to lsrc:0, 2026-10-19 04:00Z)");
      expect(refusal).toContain("\"kör det ni rekommenderar och motivera varför ni väljer\" (9 words, his message to lsrc:0, 2026-10-19 05:00Z)");
      expect(refusal).toContain("point to the original conversation through amux search.");
      expect(refusal).toContain("Do not copy his words into another log, plan or send.");
    }],
  });

  unit("the same meaning in the sender's own words passes", {
    when: ["the guard reads the rewritten brief", () => refuseHumanQuote(rewritten, { enabled: true, messages: () => messages })],
    then: ["nothing is refused", (refusal) => expect(refusal).toBeNull()],
  });

  unit("seven words, the bridge's own tags, his links and his paths are not quotes", {
    when: ["the guard reads text that shares only those with him", () => findHumanQuotes(
      "[from claw:0] [transcribed voice, may contain speech-to-text errors; interpret intent] is the tag;"
        + " see /home/x/.agentmux/discord-inbound/assets/1526179429137518653/a.jpg and https://example.test/a/b/c/d/e/f;"
        + " he said kör det ni rekommenderar och motivera varför.", messages)],
    then: ["no run is found", (runs) => expect(runs).toEqual([])],
  });

  unit("the operator switch turns the guard off", {
    when: ["the guard is disabled", () => refuseHumanQuote(pasted, { enabled: false, messages: () => messages })],
    then: ["the send is not checked", (refusal) => expect(refusal).toBeNull()],
  });
});

feature("his recent messages from the ask ledgers", () => {
  const ask = (ts, source, text, agent = "lsrc") => `${JSON.stringify({ version: 1, event: "ask", ts: new Date(ts).toISOString(),
    agent, pane: 0, source, verbatim: text })}\n`;

  component("keeps quote checks on UTC day files while they append", {
    given: ["a daily log with yesterday's human input and today's agent input", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-daily-quote-")), ledgerPath = join(dir, "ask-ledger");
      mkdirSync(ledgerPath);
      writeFileSync(join(ledgerPath, "2026-10-18.jsonl"), ask(NOW - 20 * 3_600_000, "discord", delegation.text));
      const today = join(ledgerPath, "2026-10-19.jsonl");
      writeFileSync(today, ask(NOW - 60_000, "cli", "[from ai:3] a safe report"));
      return { dir, ledgerPath, today };
    }],
    when: ["a second human input arrives before the next agent send", ({ dir, ledgerPath, today }) => {
      try {
        readRecentHumanMessages({ ledgerPath, now: NOW });
        appendFileSync(today, ask(NOW - 30_000, "discord", order.text));
        const recent = readRecentHumanMessages({ ledgerPath, now: NOW });
        return { quoted: refuseHumanQuote(pasted, { enabled: true, messages: () => recent }),
          safe: refuseHumanQuote(rewritten, { enabled: true, messages: () => recent }) };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
    then: ["both copied messages remain refused and a report in the agent's own words passes", ({ quoted, safe }) => {
      expect(quoted).toContain("(15 words, his message to lsrc:0");
      expect(quoted).toContain("(9 words, his message to lsrc:0");
      expect(safe).toBeNull();
    }],
  });

  component("live and rotated ledgers give his Discord messages of two weeks, and an append is read on the next send", {
    given: ["a live ledger, a rotated one, an old message, an agent send and a post", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-quote-guard-"));
      const ledgerPath = join(dir, "ask-ledger.jsonl");
      writeFileSync(join(dir, "ask-ledger.2026-10-18T17-53-19-416Z.1.abc.jsonl"),
        ask(NOW - 20 * 3_600_000, "discord", "rotated message from him") + ask(NOW - 20 * 24 * 3_600_000, "discord", "too old"));
      writeFileSync(ledgerPath, ask(NOW - 3_600_000, "discord", "live message from him")
        + ask(NOW - 3_600_000, "cli", "[from lsrc:0] an agent send")
        + `${JSON.stringify({ version: 1, event: "post", ts: new Date(NOW).toISOString(), source: "discord", text: "a post" })}\n`);
      return { dir, ledgerPath };
    }],
    when: ["reading twice with a new message in between", ({ dir, ledgerPath }) => {
      const first = readRecentHumanMessages({ ledgerPath, now: NOW });
      appendFileSync(ledgerPath, ask(NOW - 60_000, "discord", "newest message from him"));
      const second = readRecentHumanMessages({ ledgerPath, now: NOW });
      rmSync(dir, { recursive: true, force: true });
      return { first, second };
    }],
    then: ["only his messages in the window, the newest included the second time", ({ first, second }) => {
      expect(first.map((message) => message.text).sort()).toEqual(["live message from him", "rotated message from him"]);
      expect(second.map((message) => message.text).sort())
        .toEqual(["live message from him", "newest message from him", "rotated message from him"]);
    }],
  });
});
