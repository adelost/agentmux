import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { afterAll, vi } from "vitest";
import { buildQuotaOverview } from "./quota-overview.mjs";
import { createSentNoticeStore, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";

vi.stubEnv("TZ", "Europe/Stockholm");
afterAll(() => vi.unstubAllEnvs());
const NOW = Date.parse("2026-10-17T10:20:00Z"), MINUTE = 60_000;
const config = parseQuotaWarningConfig({});
const reading = (at, extra) => ({ ok: true, account: { email: `${extra.login}@example.test`, plan: extra.plan },
  inUse: extra.panes, activeInUse: extra.panes, observation: { observedAt: new Date(at).toISOString() } });
const codex = (id, login, plan, usedPercent, resetsAt, panes = [], at = NOW) => ({ ...reading(at, { login, plan, panes }),
  provider: "codex", profile: { id }, limits: [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent, resetsAt }] }] });
const claude = (login, plan, usedPercent, resetsAt, panes = [], at = NOW) => ({ ...reading(at, { login, plan, panes }),
  provider: "claude", profile: { id: login }, limits: [{ kind: "weekly_all", usedPercent, resetsAt }] });
// The readings lsrc:0 sent with the layout, 2026-10-17 12:20 CEST.
const today = ({ codexUsed = 93, claudeUsed = 23, at = NOW } = {}) => ({ accounts: [
  codex("1", "adelost", "pro", codexUsed, "2026-10-22T06:13:29Z", ["lsrc:3", "lsrc:7"], at),
  codex("2", "mattias.wetterlind", "prolite", 100, "2026-10-22T09:28:56Z", [], at),
  claude("adelost", "max", 95, "2026-10-21T00:00:00Z", [], at),
  claude("mattias.wetterlind", "max", claudeUsed, "2026-10-21T07:00:00Z", ["lsrc:0", "skyvw:0"], at),
  { ok: false, provider: "claude", account: { email: "logged-out@example.test" }, error: "login_expired", inUse: [] },
] });
const overview = accounts => buildQuotaOverview({ accounts }, { config, now: NOW }).text.split("\n").at(-1);
const store = () => createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "quota-overview-")), "sent.json"));

feature("one quota overview for both engines, Mattias via lsrc:0 2026-10-17", () => {
  unit("the posted notice is the English overview with one recommendation", {
    when: ["Codex 1 warns with today's readings", async () => {
      const notify = vi.fn(async () => ({}));
      await postDueQuotaWarnings({ snapshot: today(), sent: store(), notify, now: NOW });
      return notify;
    }],
    then: ["each engine shows its account in use, the others and what they add", notify => expect(notify.mock.calls.map(call => call[0])).toEqual([[
      "Codex: in use Codex 1 adelost (Pro) · 93% · resets Oct 22 08:13 · runs out ~16:00 today",
      "  Codex 2 wetterlind (Pro Lite) · 100% · resets Oct 22 11:28 · adds 0%",
      "Claude: in use Claude wetterlind (Max) · 23% · resets Oct 21 09:00 · lasts until reset",
      "  Claude adelost (Max) · 95% · resets Oct 21 02:00 · adds 5%",
      "Recommendation: free reset for Codex 1 adelost at chatgpt.com/settings/usage when it hits 100%.",
    ].join("\n")])],
  });
  unit("the run-out time follows the last readings, not the week's average", {
    when: ["Claude wetterlind climbs 6 points in 70 minutes after the fleet moved to it", async () => {
      const sent = store(), notify = vi.fn(async () => ({ id: "overview", channelId: "human" })), editNotice = vi.fn(async () => {});
      await postDueQuotaWarnings({ snapshot: today(), sent, notify, editNotice, now: NOW });
      const later = NOW + 70 * MINUTE;
      await postDueQuotaWarnings({ snapshot: today({ codexUsed: 95, claudeUsed: 29, at: later }), sent, notify, editNotice, now: later });
      return editNotice;
    }],
    then: ["the edited overview says it runs out tonight", editNotice => expect(editNotice.mock.calls[0][1].split("\n")[2])
      .toBe("Claude: in use Claude wetterlind (Max) · 29% · resets Oct 21 09:00 · runs out ~03:00 tomorrow")],
  });
  unit("a Claude account with room gets the exact switch and the panes it moves", {
    when: ["wetterlind runs out and adelost has room", () => overview([
      claude("mattias.wetterlind", "max", 90, "2026-10-21T07:00:00Z", ["lsrc:0", "skyvw:0"]), claude("adelost", "max", 20, "2026-10-21T00:00:00Z"),
    ])],
    then: ["the recommendation is the /byt command", line => expect(line)
      .toBe("Recommendation: `/byt adelost`, then `/byt adelost ok`, moves lsrc:0, skyvw:0 to Claude adelost.")],
  });
  unit("one pane left on a full-up account is moved, not reset", {
    when: ["ai:2 alone runs on Claude adelost at 95 percent", () => buildQuotaOverview({ accounts: [
      claude("adelost", "max", 95, "2026-10-21T00:00:00Z", ["ai:2"]),
      claude("mattias.wetterlind", "max", 7, "2026-10-21T07:00:00Z", ["skyvw:0", "claw:2"]),
    ] }, { config, now: NOW }).text.split("\n")],
    then: ["its line names the pane and the advice moves it", lines => expect(lines.slice(1)).toEqual([
      "  Claude adelost (Max) · 95% · resets Oct 21 02:00 · adds 5% · in use by ai:2",
      "Recommendation: `/byt wetterlind`, then `/byt wetterlind ok`, moves ai:2 to Claude wetterlind.",
    ])],
  });
  unit("a Codex account with room gets the per-channel switch", {
    when: ["Codex 1 runs out and Codex 2 has room", () => overview([
      codex("1", "adelost", "pro", 93, "2026-10-22T06:13:29Z", ["lsrc:3", "lsrc:7"]), codex("2", "mattias.wetterlind", "prolite", 10, "2026-10-22T09:28:56Z"),
    ])],
    then: ["the recommendation names the command and its panes", line => expect(line)
      .toBe("Recommendation: `//switch 2` in the channels of lsrc:3, lsrc:7 moves them to Codex 2 wetterlind.")],
  });
  unit("an unreadable account its panes use stays visible", {
    when: ["Claude's usage read fails while 12 panes run on wetterlind, as at 10:45Z", () => buildQuotaOverview({ accounts: [
      codex("1", "adelost", "pro", 94, "2026-10-22T06:13:29Z", ["lsrc:3"]),
      { ok: false, provider: "claude", profile: { id: "wetterlind" }, error: "network_error", account: { email: "mattias.wetterlind@example.test", plan: "max" },
        inUse: Array.from({ length: 12 }, (_, i) => `test:${i}`) },
      { ok: false, provider: "claude", profile: { id: "2" }, error: "login_expired", account: { email: "logged-out@example.test" }, inUse: [] },
    ] }, { config, now: NOW }).text.split("\n")],
    then: ["Claude says it cannot be read and the logged-out login stays hidden", lines => {
      expect(lines[1]).toBe("Claude: in use Claude wetterlind (Max) · usage not readable right now");
      expect(lines).toHaveLength(3);
    }],
  });
  unit("accounts that last until their reset need nothing", {
    when: ["every account in use runs slower than its week", () => overview([
      codex("1", "adelost", "pro", 30, "2026-10-22T06:13:29Z", ["lsrc:3"]), claude("mattias.wetterlind", "max", 23, "2026-10-21T07:00:00Z", ["lsrc:0"]),
    ])],
    then: ["the last line says so", line => expect(line).toBe("Recommendation: no action needed.")],
  });
});
