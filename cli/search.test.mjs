import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { cmdSearch } from "./search.mjs";

feature("search CLI contract", () => {
  unit("help is handled before config access", {
    when: ["requesting help without a CLI context", async () => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      await cmdSearch({}, "", { help: true });
      const text = output.mock.calls.flat().join("\n");
      output.mockRestore();
      return text;
    }],
    then: ["usage explains both history modes", (text) => {
      expect(text).toContain("amux search \"term\" --show N");
      expect(text).toContain("durable AMUX delivery ledger");
    }],
  });

  component("one invocation searches and expands a durable delivery", {
    given: ["a legacy config without a ledger root and one delivered request", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-search-cli-"));
      const configPath = join(root, "agentmux.yaml");
      const eventsPath = join(root, "events.jsonl");
      writeFileSync(configPath, "search:\n  roots: []\nagents: {}\n");
      writeFileSync(eventsPath, JSON.stringify({
        ts: "2026-07-20T21:41:47Z",
        event: "delivery_queue",
        state: "enqueued",
        session: "skyvw",
        pane: 6,
        jobId: "sundial-request",
        detail: "Skriv klockan ovanför soluret så tiden blir kompakt.",
      }));
      return { root, configPath, eventsPath };
    }],
    when: ["searching a paraphrase with --show", async (fixture) => {
      const previous = process.env.AMUX_EVENTS_PATH;
      process.env.AMUX_EVENTS_PATH = fixture.eventsPath;
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdSearch({ configPath: fixture.configPath }, "flytta in klockan i soluret", {
          fast: true,
          show: "1",
        });
        return { fixture, text: output.mock.calls.flat().join("\n") };
      } finally {
        output.mockRestore();
        if (previous === undefined) delete process.env.AMUX_EVENTS_PATH;
        else process.env.AMUX_EVENTS_PATH = previous;
      }
    }],
    then: ["the exact receipt is shown from the ledger", ({ fixture, text }) => {
      expect(text).toContain("Skriv klockan ovanför soluret");
      expect(text).toContain("skyvw:6");
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});
