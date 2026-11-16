import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfCompactStore } from "./self-compact.mjs";

const NOW = Date.parse("2026-10-11T09:30:00Z");

function store() {
  const dir = mkdtempSync(join(tmpdir(), "amux-self-compact-"));
  return { requests: createSelfCompactStore({ dir, now: () => NOW }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Row 214, the owner's decision of 16 Nov 2026: a pane at work is never compacted under 400k; finished is proven by rest.
// The existing cases moved from 60k and 300k accordingly: a pane's own request is stored only above 400k.
feature("a pane's request to be compacted at a stage boundary", () => {
  const PATH = "/projects/lsrc-0/s1.jsonl";
  const HANDOFF = { continuation: "continue row 214", identity: { sessionId: "s1", path: PATH }, cursor: { positions: { [PATH]: 0 } } };
  for (const [label, tokens, extra, expected] of [
    ["deep:0's case of 16 Nov 2026, a bare request at 185k, is not stored", 185_000, {}, "at-work"],
    ["a small context at 60k is not stored", 60_000, {}, "at-work"],
    ["a request with a handoff at 300k is not stored", 300_000, HANDOFF, "at-work"],
    ["a request at exactly 400 000 is not stored", 400_000, {}, "at-work"],
    ["a request at 400 001 is stored", 400_001, {}, "stored"],
    ["a request with a handoff at 450k is stored", 450_000, HANDOFF, "stored"],
    ["an origin the bridge does not file is a pane's and is not stored at 120k", 120_000, { origin: "something-else" }, "at-work"],
    ["a quota park's own request at 120k is stored as before", 120_000, { origin: "quota-park" }, "stored"],
    ["a wind-down's own request at 120k is stored as before", 120_000, { origin: "quota-wind-down" }, "stored"],
    ["a quota park's own request at 79 999 is refused as before", 79_999, { origin: "quota-park" }, "under-budget"],
  ]) component(`the owner's decision of 16 Nov 2026: ${label}`, {
    given: [`lsrc:0 at ${tokens} tokens`, store],
    when: ["asking", ({ requests }) => ({ result: requests.request({ agent: "lsrc", pane: 0, tokens, ...extra }), pending: requests.list() })],
    then: ["a pane's request is stored only above 400k; the bridge's own keeps 80k", ({ result, pending }, { cleanup }) => {
      try {
        if (expected === "stored") { expect(result.ok).toBe(true); return expect(pending).toHaveLength(1); }
        expect(result).toMatchObject({ ok: false, cell: expected });
        expect(pending).toEqual([]);
        if (expected === "at-work") expect(result.detail).toBe(`${tokens} tokens is not above 400000. This is not an error: a pane at work is not compacted under that `
          + "(owner's decision 16 Nov 2026), and AMUX compacts the pane by itself once it has rested (Claude after 50 min from 80k, Codex after 25 min from 150k)");
      } finally { cleanup(); }
    }],
  });
  component("a second compact within 30 minutes is refused at once", {
    given: ["lsrc:0 at 450k, compacted 10 minutes ago", store],
    when: ["asking", ({ requests }) => requests.request({ agent: "lsrc", pane: 0, tokens: 450_000, lastCompactAt: NOW - 10 * 60_000 })],
    then: ["refused with the spacing rule", (result, { cleanup }) => {
      try { expect(result).toMatchObject({ ok: false, cell: "spacing", detail: expect.stringContaining("10 min ago") }); }
      finally { cleanup(); }
    }],
  });
  component("an admitted request is stored once with its focus", {
    given: ["lsrc:0 at 450k, last compact 40 minutes ago", store],
    when: ["asking twice", ({ requests }) => {
      requests.request({ agent: "lsrc", pane: 0, tokens: 450_000, lastCompactAt: NOW - 40 * 60_000, focus: "first" });
      requests.request({ agent: "lsrc", pane: 0, tokens: 450_000, lastCompactAt: NOW - 40 * 60_000, focus: "G4-siffrorna" });
      return requests.list();
    }],
    then: ["one pending request, the latest focus", (pending, { cleanup }) => {
      try { expect(pending).toEqual([{ agent: "lsrc", pane: 0, focus: "G4-siffrorna", tokens: 450_000, requestedAt: new Date(NOW).toISOString() }]); }
      finally { cleanup(); }
    }],
  });
});
