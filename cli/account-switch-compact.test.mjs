import { feature, unit, expect } from "bdd-vitest";
import { compactBeforeSwitch } from "./account-switch-compact.mjs";

const target = { agent: { name: "lsrc" }, pane: { index: 0 } };
const runReturning = (row) => async () => ({ rows: [{ pane: "lsrc:0", ...row }] });

feature("the compact step of an account switch", () => {
  unit("a session with nothing to compact may switch: there is no cache to lose", {
    when: ["Claude answered Not enough messages to compact", () =>
      compactBeforeSwitch({ deliveryQueue: {} }, target, { run: runReturning({ status: "nothing-to-compact" }) })],
    then: ["the pane may move", (result) => expect(result).toMatchObject({ ok: true, status: "nothing-to-compact" })],
  });

  unit("an unverified compact still keeps the pane on its source", {
    when: ["the boundary never came", () =>
      compactBeforeSwitch({ deliveryQueue: {} }, target, { run: runReturning({ status: "failed", reason: "compact-boundary-missing" }) })],
    then: ["the reason is kept", (result) => expect(result).toEqual({ ok: false, reason: "compact-failed:compact-boundary-missing" })],
  });
});
