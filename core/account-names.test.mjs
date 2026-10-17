import { feature, unit, expect } from "bdd-vitest";
import { accountName, loginOfEmail, withAccountEntries } from "./account-names.mjs";

const account = (provider, email, id = "1") => ({ provider, profile: { id }, account: email ? { email } : undefined });

// Mattias 2026-10-17 13:04Z: Claude A, Claude W, Codex A and Codex W everywhere.
feature("account names by engine and login", () => {
  unit("the login's initial names the account, whatever slot it runs in", {
    when: ["naming two Codex slots whose labels were swapped", () => {
      const codex = [account("codex", "adelost@example.test", "2"), account("codex", "mattias.wetterlind@example.test", "1")];
      return codex.map(item => accountName(item, codex));
    }],
    then: ["the names follow the login", names => expect(names).toEqual(["Codex A", "Codex W"])],
  });
  unit("two logins sharing an initial keep their whole login", {
    when: ["naming adelost next to attrois and a Codex adelost", () => {
      const accounts = [account("claude", "adelost@example.test"), account("claude", "attrois@example.test"), account("codex", "anna@example.test")];
      return accounts.map(item => accountName(item, accounts));
    }],
    then: ["only the clashing engine spells the logins out", names => expect(names).toEqual(["Claude adelost", "Claude attrois", "Codex A"])],
  });
  unit("an account without a known login is named by its slot", {
    when: ["naming a logged-out Kimi slot", () => accountName(account("kimi", null, "2"))],
    then: ["the slot names it", name => expect(name).toBe("Kimi 2")],
  });
  unit("the login is the address's last dotted name", {
    when: ["reading three addresses", () => ["mattias.wetterlind@example.test", "adelost@example.test", ""].map(loginOfEmail)],
    then: ["wetterlind, adelost and nothing", logins => expect(logins).toEqual(["wetterlind", "adelost", null])],
  });
});

feature("each account carries its login's entry", () => {
  unit("the entry's name and subscription apply, also to a failed reading", {
    when: ["merging entries into a live-shaped snapshot", () => withAccountEntries([
      account("claude", "adelost@example.test"),
      { ...account("claude", "mattias.wetterlind@example.test", "wetterlind"), ok: false, error: "network_error" },
      { ...account("claude", "attrois@example.test", "2"), ok: false, error: "login_expired" },
    ], new Map([["claude:wetterlind", { name: "Claude W", subscription: { renewsOn: "2026-11-05" } }]]))],
    then: ["W keeps its renewal date though unreadable, and the logged-out attrois spells A out by itself", (accounts) => {
      expect(accounts.map((item) => [item.name, item.subscription ?? null])).toEqual([
        ["Claude A", null], ["Claude W", { renewsOn: "2026-11-05" }], ["Claude attrois", null]]);
    }],
  });
});
