import { feature, unit, expect } from "bdd-vitest";
import { afterAll, vi } from "vitest";
import { buildQuotaOverview } from "./quota-overview.mjs";
import { parseQuotaWarningConfig } from "./quota-warning.mjs";

vi.stubEnv("TZ", "Europe/Stockholm");
afterAll(() => vi.unstubAllEnvs());
// 13:50 local, while Claude W's five-hour window is used up until 14:40.
const NOW = Date.parse("2026-10-17T11:50:00Z");
const config = parseQuotaWarningConfig({});
const panes = (project, count) => Array.from({ length: count }, (_, pane) => `${project}:${pane}`);
const codex = (id, login, usedPercent, resetsAt, inUse = [], more = {}) => ({ ok: true, provider: "codex", profile: { id },
  account: { email: `${login}@example.test` }, inUse, ...more, limits: [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent, resetsAt }] }] });
const claude = (login, usedPercent, resetsAt, inUse = [], { session = null, ...more } = {}) => ({ ok: true, provider: "claude",
  profile: { id: login }, account: { email: `${login}@example.test` }, inUse, ...more, limits: [{ kind: "weekly_all", usedPercent, resetsAt },
    ...(session ? [{ kind: "session", usedPercent: session.usedPercent, resetsAt: session.resetsAt }] : [])] });
// The readings behind lsrc:0's layout for Mattias, 2026-10-17.
const example = () => [
  codex("1", "adelost", 0, "2026-10-24T11:35:12Z", panes("lsrc", 12)),
  codex("2", "mattias.wetterlind", 100, "2026-10-22T09:28:56Z"),
  claude("mattias.wetterlind", 36, "2026-10-21T07:00:00Z", panes("api", 12), { session: { usedPercent: 100, resetsAt: "2026-10-17T12:40:00Z" } }),
  claude("adelost", 96, "2026-10-21T00:00:00Z", ["lsrc:0", "skyvw:0"]),
  { ok: false, provider: "claude", account: { email: "attrois@example.test" }, error: "login_expired", inUse: [] },
];
const render = (accounts, now = NOW) => buildQuotaOverview({ accounts }, { config, now }).text.split("\n");

feature("the quota box leads with each account's week, lsrc:0 for Mattias 2026-10-17", () => {
  unit("lsrc:0's example renders as a table and one action", {
    when: ["rendering the example's readings", () => render(example())],
    then: ["names, panes, week left, reset, the blocking five-hour window and when it is back", lines => expect(lines).toEqual([
      "```",
      "         panes  left  reset",
      "Codex A     12  100%  Sat 13:35",
      // 09:28:56Z is shown to the nearest minute.
      "Codex W      0    0%  Thu 11:29",
      "Claude W    12   64%  Wed 09:00",
      "    5h 0% until 14:40",
      "Claude A     2    4%  Wed 02:00",
      "```",
      "→ Claude W back at 14:40",
    ])],
  });
  // lsrc:0 2026-10-19 read Claude S's 63% as used; its detail line said 37 % used.
  unit("the percent column is named for what it shows: the week left", {
    when: ["Claude S has used 37 % of its week", () => render([
      claude("attrois", 37, "2026-10-21T07:00:00Z", panes("lsrc", 3), { name: "Claude S" })])],
    then: ["the column says left above 63%", lines => expect(lines.slice(1, 3)).toEqual([
      "         panes  left  reset",
      "Claude S     3   63%  Wed 09:00",
    ])],
  });
  unit("no line is wider than a phone's 32 characters", {
    when: ["rendering 99 panes on both Claude accounts and a switch", () => render([
      claude("mattias.wetterlind", 85, "2026-10-21T07:00:00Z", panes("a", 99)),
      claude("adelost", 10, "2026-10-21T00:00:00Z", panes("b", 99)),
    ])],
    then: ["every line fits", lines => {
      expect(lines.at(-1)).toBe("→ Use Claude A: /byt adelost");
      expect(lines.filter(line => [...line].length > 32)).toEqual([]);
    }],
  });
  unit("a Codex account with room gets the switch command", {
    when: ["Codex A's working panes near the limit while Codex W has room", () => render([
      codex("1", "adelost", 90, "2026-10-24T11:35:12Z", ["lsrc:3", "lsrc:7"]),
      codex("2", "mattias.wetterlind", 40, "2026-10-22T09:28:56Z"),
    ])],
    then: ["the action is the slot command for Codex W", lines => expect(lines.at(-1)).toBe("→ Use Codex W: //switch 2")],
  });
  unit("a lone pane on a nearly full Claude account is moved to the one with room", {
    when: ["ai:2 works alone on Claude A at 95 percent", () => render([
      claude("adelost", 95, "2026-10-21T00:00:00Z", ["ai:2"]), claude("mattias.wetterlind", 7, "2026-10-21T07:00:00Z", ["skyvw:0", "claw:2"]),
    ])],
    then: ["the pane counts show where the panes run and /byt names the login", lines => expect(lines.slice(2)).toEqual([
      "Claude W     2   93%  Wed 09:00",
      "Claude A     1    5%  Wed 02:00",
      "```",
      "→ Use Claude W: /byt wetterlind",
    ])],
  });
  unit("an idle pane's account gets no advice", {
    when: ["ai:2 runs on Claude A but has not worked in the last hour", () => render([
      claude("adelost", 95, "2026-10-21T00:00:00Z", ["ai:2"], { activeInUse: [] }), claude("mattias.wetterlind", 7, "2026-10-21T07:00:00Z", []),
    ])],
    then: ["the table ends the notice", lines => expect(lines.at(-1)).toBe("```")],
  });
  unit("a used-up account with no room elsewhere says to reset now", {
    when: ["16 panes have just reached the weekly limit", () => render([claude("mattias.wetterlind", 100, "2026-10-21T07:00:00Z", panes("test", 16))])],
    then: ["nothing is left and the free reset is now", lines => expect(lines.slice(2)).toEqual([
      "Claude W    16    0%  Wed 09:00",
      "```",
      "→ Free reset Claude W now",
    ])],
  });
  unit("an unreadable account its panes use stays visible", {
    when: ["Claude W's usage read fails while panes run on it", () => render([
      codex("1", "adelost", 30, "2026-10-24T11:35:12Z", ["lsrc:3"]),
      { ok: false, provider: "claude", profile: { id: "wetterlind" }, error: "network_error",
        account: { email: "mattias.wetterlind@example.test" }, inUse: panes("test", 12) },
    ])],
    then: ["it says so, and nothing else is advised", lines => expect(lines.slice(1)).toEqual([
      "         panes  left  reset",
      "Codex A      1   70%  Sat 13:35",
      "Claude W    12  unreadable",
      "```",
    ])],
  });
  // Mattias 14:17Z: when the subscription ends and whether resets are left, also when the reading failed.
  unit("a login's renewal date and free resets get a short second line", {
    when: ["two logins have entries, one of them unreadable", () => render([
      { ...codex("1", "adelost", 8, "2026-10-24T11:35:12Z", panes("lsrc", 12)),
        subscription: { renewsOn: "2026-10-20", freeResetsLeft: 0, freeResetsReadOn: "2026-10-17" } },
      { ok: false, provider: "claude", profile: { id: "wetterlind" }, error: "network_error",
        account: { email: "mattias.wetterlind@example.test" }, inUse: panes("api", 15), subscription: { renewsOn: "2026-11-05" } },
      { ...claude("adelost", 97, "2026-10-21T00:00:00Z"), subscription: { freeResetsLeft: 1, freeResetsReadOn: "2026-10-17" } },
    ])],
    then: ["each line fits a phone", lines => {
      expect(lines.slice(1, -1)).toEqual([
        "         panes  left  reset",
        "Codex A     12   92%  Sat 13:35",
        "  renews Oct 20 · 0 free resets",
        "Claude W    15  unreadable",
        "  renews Nov 5",
        "Claude A     0    3%  Wed 02:00",
        "  1 free reset",
      ]);
      expect(lines.filter(line => [...line].length > 32)).toEqual([]);
    }],
  });
  // lsrc:0 2026-10-17: Codex W's two resets end Oct 29 20:24 and Nov 7 00:48 (GMT+1); the box shows the first.
  unit("the day the first free reset ends joins its count, and a renewal that no longer fits gets its own line", {
    when: ["Codex W has two resets that end, and Codex A a renewal beside one", () => render([
      { ...codex("1", "adelost", 8, "2026-10-24T11:35:12Z", panes("lsrc", 12)), subscription: { renewsOn: "2026-11-03",
        freeResetsLeft: 1, freeResetsReadOn: "2026-10-17", freeResetsExpire: ["2026-11-07T00:48+01:00"] } },
      { ...codex("2", "mattias.wetterlind", 100, "2026-10-22T09:28:56Z"), subscription: { freeResetsLeft: 2,
        freeResetsReadOn: "2026-10-17", freeResetsExpire: ["2026-10-29T20:24+01:00", "2026-11-07T00:48+01:00"] } },
    ])],
    then: ["each line fits a phone", lines => {
      expect(lines.slice(1, -1)).toEqual([
        "        panes  left  reset",
        "Codex A    12   92%  Sat 13:35",
        "  renews Nov 3",
        "  1 free reset, ends Nov 7",
        "Codex W     0    0%  Thu 11:29",
        "  2 free resets, 1st ends Oct 29",
      ]);
      expect(lines.filter(line => [...line].length > 32)).toEqual([]);
    }],
  });
});
