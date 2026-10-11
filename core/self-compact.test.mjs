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

feature("a pane's request to be compacted at a stage boundary", () => {
  component("a small context is refused at once", {
    given: ["lsrc:0 at 60k tokens", store],
    when: ["asking", ({ requests }) => ({ result: requests.request({ agent: "lsrc", pane: 0, tokens: 60_000 }), pending: requests.list() })],
    then: ["refused under 80k and nothing is stored", ({ result, pending }, { cleanup }) => {
      try {
        expect(result).toMatchObject({ ok: false, cell: "under-budget" });
        expect(pending).toEqual([]);
      } finally { cleanup(); }
    }],
  });
  component("a second compact within 30 minutes is refused at once", {
    given: ["lsrc:0 at 300k, compacted 10 minutes ago", store],
    when: ["asking", ({ requests }) => requests.request({ agent: "lsrc", pane: 0, tokens: 300_000, lastCompactAt: NOW - 10 * 60_000 })],
    then: ["refused with the spacing rule", (result, { cleanup }) => {
      try { expect(result).toMatchObject({ ok: false, cell: "spacing", detail: expect.stringContaining("10 min ago") }); }
      finally { cleanup(); }
    }],
  });
  component("an admitted request is stored once with its focus", {
    given: ["lsrc:0 at 300k, last compact 40 minutes ago", store],
    when: ["asking twice", ({ requests }) => {
      requests.request({ agent: "lsrc", pane: 0, tokens: 300_000, lastCompactAt: NOW - 40 * 60_000, focus: "first" });
      requests.request({ agent: "lsrc", pane: 0, tokens: 300_000, lastCompactAt: NOW - 40 * 60_000, focus: "G4-siffrorna" });
      return requests.list();
    }],
    then: ["one pending request, the latest focus", (pending, { cleanup }) => {
      try { expect(pending).toEqual([{ agent: "lsrc", pane: 0, focus: "G4-siffrorna", tokens: 300_000, requestedAt: new Date(NOW).toISOString() }]); }
      finally { cleanup(); }
    }],
  });
});
