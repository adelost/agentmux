import { component, feature, expect } from "bdd-vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { lexicalSearch, expandHit, formatHits } from "./search.mjs";
import { readSearchRecords } from "./search-jsonl.mjs";

const modern = (text, timestamp = "2026-09-05T10:00:00.000Z", kind = "user.text") => ({
  timestamp, type: "response_item", payload: { type: "message", role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] } },
});
const legacy = (text, timestamp) => ({ timestamp, type: "event_msg",
  payload: { type: "user_message", message: text } });
const output = (text) => ({ timestamp: "2026-09-05T10:01:00.000Z", type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

function fixture(events) {
  const dir = fs.mkdtempSync(join(tmpdir(), "amux-search-events-"));
  const path = join(dir, "rollout-2026-07-14.jsonl");
  fs.writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return { dir, path, roots: [{ name: "sessions", path: dir, glob: "*.jsonl", exclude: [], weight: 1 }] };
}

feature("journal retrieval preserves event identity and bounded evidence", () => {
  component("latest distinct events outrank old matches in an old-named journal", {
    given: ["old decisions followed by a replacement and two real equal inputs", () => fixture([
      modern("Beslutet är gammalt", "2026-07-14T10:00:00.000Z"),
      modern("Beslutet är äldre", "2026-07-15T10:00:00.000Z"),
      modern("Beslutet är ändrat", "2026-09-05T10:00:00.000Z"),
      legacy("Beslutet är ändrat", "2026-09-05T10:00:00.000Z"),
      output("Klart"),
      modern("Beslutet är ändrat", "2026-09-05T10:02:00.000Z"),
      modern("Beslutet är ändrat", "2026-09-05T10:02:00.000Z"),
    ])],
    when: ["searching with only three candidate slots", (f) => {
      try { return lexicalSearch("Beslutet", f.roots, { maxPerRoot: 3 }); }
      finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["new events retain actual time and separate source lines, but not the mirror", (hits) => {
      expect(hits.map((hit) => hit.line)).toEqual([7, 6, 3]);
      expect(hits.map((hit) => hit.date)).toEqual([
        "2026-09-05T10:02:00.000Z", "2026-09-05T10:02:00.000Z", "2026-09-05T10:00:00.000Z",
      ]);
      expect(new Set(hits.map((hit) => hit.dedupeKey)).size).toBe(3);
      expect(formatHits(hits)).toContain("2026-09-05T10:02:00.000Z");
      expect(formatHits(hits)).toContain(".jsonl:7");
    }],
  });

  component("exact authored quotes decode without confusing setup or output with human input", {
    given: ["a multiline quote longer than the former raw-JSON limit and nonhuman lookalikes", () => {
      const quote = 'Åäö: "behåll detta" och `kod`.\n' + "Hela citatet skall bevaras. ".repeat(120);
      return { ...fixture([modern(quote), modern(quote, undefined, "environment"), output(quote),
        { type: "response_item", payload: { type: "custom_tool_call_output", output: quote } }]), quote };
    }],
    when: ["searching and expanding only the authored input", (f) => {
      try {
        const hits = lexicalSearch("Åäö", f.roots);
        const hit = hits.find((item) => item.line === 1);
        return { quote: f.quote, hits, text: expandHit(hit, { context: 0 }) };
      } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["the quote is exact and each other role remains distinct", ({ quote, hits, text }) => {
      expect(hits.find((hit) => hit.line === 1)?.role).toBe("USER");
      expect(hits.find((hit) => hit.line === 2)?.role).toBe("CONTEXT");
      expect(hits.find((hit) => hit.line === 3)?.role).toBe("ASSI");
      expect(hits.find((hit) => hit.line === 4)?.role).toBe("TOOL");
      expect(text).toContain(quote);
      expect(text).toContain("▶");
      expect(text).toContain("2026-09-05T10:00:00.000Z USER:");
      expect(text).not.toContain("CONTEXT:");
      expect(text).not.toContain("internal_chat_message_metadata");
    }],
  });

  component("event word-AND never joins unrelated turns or borrows filename dates", {
    given: ["separate words in separate inputs and an undated input", () => fixture([
      modern("Tess nämnde modellen"), modern("Åttio-tjugo gäller här"),
      { type: "event_msg", payload: { type: "user_message", message: "Odokumenterat datum" } },
    ])],
    when: ["querying both topics and the undated input", (f) => {
      try { return { combined: lexicalSearch("Tess Åttio-tjugo", f.roots),
        undated: lexicalSearch("Odokumenterat", f.roots) }; }
      finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["unrelated inputs do not combine and unknown time remains unknown", ({ combined, undated }) => {
      expect(combined).toEqual([]);
      expect(undated[0].date).toBeNull();
    }],
  });

  component("expansion seeks a bounded neighborhood even after seventy megabytes", {
    given: ["a stored byte-position in a large journal", () => {
      const f = fixture([]);
      const offset = 70 * 1024 * 1024;
      const fd = fs.openSync(f.path, "w");
      const body = [modern("Exakt åäö-citat"), output("Grannsvaret")].map(JSON.stringify).join("\n") + "\n";
      fs.writeSync(fd, Buffer.from("\n" + body), 0, Buffer.byteLength("\n" + body), offset - 1);
      fs.closeSync(fd);
      return { ...f, hit: { path: f.path, line: 2, byteOffset: offset } };
    }],
    when: ["expanding without whole-file reads", (f) => {
      const whole = vi.spyOn(fs, "readFileSync");
      const read = vi.spyOn(fs, "readSync");
      try {
        const text = expandHit(f.hit, { context: 0 });
        return { text, wholeReads: whole.mock.calls.filter(([path]) => path === f.path).length,
          bytes: read.mock.results.reduce((sum, result) => sum + (result.value || 0), 0) };
      } finally { whole.mockRestore(); read.mockRestore(); fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["only the local input is shown with less than one megabyte read", ({ text, wholeReads, bytes }) => {
      expect(text).toContain("Exakt åäö-citat");
      expect(text).not.toContain("Grannsvaret");
      expect(wholeReads).toBe(0);
      expect(bytes).toBeLessThan(1024 * 1024);
    }],
  });

  component("escaped Unicode and explicit file roots use the same decoded matches", {
    given: ["an escaped quote and a second explicit-file event", () => {
      const f = fixture([modern("ÅÄÖ besked"), modern("ÅÄÖ nytt besked")]);
      fs.writeFileSync(f.path, fs.readFileSync(f.path, "utf8").replaceAll("ÅÄÖ", "\\u00c5\\u00c4\\u00d6"));
      return f;
    }],
    when: ["searching the file directly with lowercase letters", (f) => {
      try { return lexicalSearch("åäö", [{ ...f.roots[0], path: f.path }]); }
      finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["both events are decoded, not supplemented by raw file matches", (hits) => {
      expect(hits.map((hit) => hit.line)).toEqual([2, 1]);
      expect(hits.every((hit) => hit.role === "USER" && hit.snippet.includes("ÅÄÖ"))).toBe(true);
    }],
  });

  component("bounded noisy neighbors cannot consume the selected quote and rewritten hits fail visibly", {
    given: ["twenty large assistant neighbors around one exact quote", () => fixture([
      ...Array.from({ length: 10 }, () => output("before ".repeat(3000))), modern("Bevara åäö exakt"),
      ...Array.from({ length: 10 }, () => output("after ".repeat(3000))),
    ])],
    when: ["expanding and then checking the hit after a rewrite", (f) => {
      try {
        const [hit] = lexicalSearch("Bevara", f.roots);
        const text = expandHit(hit, { context: 10 });
        fs.writeFileSync(f.path, "changed\n".repeat(30));
        return { text, stale: expandHit(hit, { context: 0 }) };
      } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["the marked input survives the output cap and stale evidence is rejected", ({ text, stale }) => {
      expect(text).toContain("▶ 11 2026-09-05T10:00:00.000Z USER: Bevara åäö exakt");
      expect(text).toContain("[truncated");
      expect(text.length).toBeLessThanOrEqual(32_000);
      expect(stale).toMatch(/Source (changed|no longer)/);
    }],
  });

  component("oversized events are explicit gaps and cannot hide later matching inputs", {
    given: ["an oversized event before a normal quote", () => fixture([
      modern("gräns " + "x".repeat(4 * 1024 * 1024)), modern("gräns: senare citat"),
    ])],
    when: ["searching across the oversized event", (f) => {
      try {
        const warnings = [];
        const hits = lexicalSearch("gräns", f.roots, { onWarning: (message) => warnings.push(message) });
        return { hits, warnings, context: expandHit(hits[0], { context: 1 }) };
      } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["the gap is explicit while the later exact quote remains available", ({ hits, warnings, context }) => {
      expect(hits.map((hit) => hit.line)).toEqual([2]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(".jsonl:1");
      expect(warnings[0]).toContain("Search incomplete");
      expect(context).toContain("[event omitted:");
      expect(context).toContain("gräns: senare citat");
    }],
  });

  component("a live writer cannot extend the reader's starting byte boundary", {
    given: ["a journal that grows just after the first read", () => fixture([modern("snapshot first")])],
    when: ["reading while one extra event is appended", (f) => {
      const read = fs.readSync;
      let appended = false;
      const spy = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
        const count = read(...args);
        if (!appended && count > 0) {
          appended = true;
          fs.appendFileSync(f.path, JSON.stringify(modern("snapshot later")) + "\n");
        }
        return count;
      });
      try { return [...readSearchRecords(f.path)].map((record) => record.line); }
      finally { spy.mockRestore(); fs.rmSync(f.dir, { recursive: true, force: true }); }
    }],
    then: ["this read stops at its original boundary; new events belong to the next search", (lines) => {
      expect(lines).toEqual([1]);
    }],
  });
});
