import { feature, unit, expect } from "bdd-vitest";
import { classifyQuiet } from "./quiet-classify.mjs";
import { AMUX_PANE_TAGS, isHumanAsk } from "./ask-origin.mjs";
import { LINES, replyEndingWith } from "../test/fixtures/quiet-ledger.mjs";

// Guards UC-1, UC-2, UC-4, UC-5, UC-3, R-1 and R-3 of docs/DESIGN-quiet-panes.md. Every reply here is invented; the
// shapes are the ones the panes write (a status block, then the line the pane ends with).
const OPERATOR = "Mattias";
const classify = (reply, options = {}) => classifyQuiet(reply, { operator: OPERATOR, ...options });

feature("quiet: why a pane went quiet", () => {
  unit("the claw:0 line is a decision", {
    given: ["a reply that ends with a bold waiting line, a yes or no and a cost, after a NOW line that waits on gates", () => replyEndingWith(LINES.decision)],
    when: ["classifying it", (reply) => classify(reply)],
    then: ["it is a decision for the delegate, and it quotes the waiting line, not the NOW line", (verdict) => {
      expect(verdict.class).toBe("decision");
      expect(verdict.line).toContain("Väntar på dig");
      expect(verdict.line).not.toContain("zon 3");
    }],
  });

  unit("a login is his hands", {
    given: ["a reply that asks him to sign in to a console in his browser", () => replyEndingWith(LINES.login)],
    when: ["classifying it", (reply) => classify(reply)],
    then: ["it is his hands, a login, quoting the line", (verdict) => {
      expect(verdict).toMatchObject({ class: "hands", what: "login" });
      expect(verdict.line).toContain("Logga in på Play Console");
    }],
  });

  unit("hands win over a decision", {
    given: ["a reply that wants a login and then a yes or no", () => replyEndingWith(LINES.both)],
    when: ["classifying it", (reply) => classify(reply)],
    then: ["he must act anyway, so it is his hands", (verdict) => expect(verdict.class).toBe("hands")],
  });

  unit("LEFT without a blocker is left work", {
    given: ["a reply with a LEFT line that has content and no blocker", () => `NOW: zon 3 byggd\n${LINES.left}`],
    when: ["classifying it", (reply) => classify(reply)],
    then: ["it is left work and quotes the LEFT line", (verdict) => {
      expect(verdict).toMatchObject({ class: "left", line: LINES.left });
    }],
  });

  unit("a blocker or an empty LEFT is not left work", {
    given: ["a LEFT beside a BLOCKED line, one that waits on another pane, and four empty LEFT lines", () => ({
      blocked: `BLOCKED: nyckeln saknas i builden\n${LINES.left}`,
      waitsOnPane: `${LINES.left}\nNOW: claw:5 väntar på grindarna`,
      empty: ["LEFT: none", "LEFT: inget.", "**LEFT:** ingenting", "LEFT: -"],
    })],
    when: ["classifying each", ({ blocked, waitsOnPane, empty }) => ({
      blocked: classify(blocked).class, waitsOnPane: classify(waitsOnPane).class, empty: empty.map((reply) => classify(reply).class),
    })],
    then: ["none of them is left work", (classes) => {
      expect(classes.blocked).not.toBe("left");
      expect(classes.waitsOnPane).not.toBe("left");
      expect(classes.empty).not.toContain("left");
    }],
  });

  unit("DONE with OPEN none is done", {
    given: ["a completion report", () => LINES.done],
    when: ["classifying it, and a reply that only says it is shipped", (reply) => [classify(reply).class, classify("Allt är klart och pushat.").class]],
    then: ["both are done", (classes) => expect(classes).toEqual(["done", "done"])],
  });

  unit("a question alone is unclear", {
    given: ["a bare question to nobody in particular", () => LINES.question],
    when: ["classifying it", (reply) => classify(reply)],
    then: ["it is unclear, so the pane sleeps", (verdict) => expect(verdict).toMatchObject({ class: "unclear", line: null })],
  });

  unit("a parked pane is quota, whatever it says", {
    given: ["a decision line from a pane the quota park holds", () => replyEndingWith(LINES.decision)],
    when: ["classifying it with and without the park", (reply) => [classify(reply, { parked: true }).class, classify(reply).class]],
    then: ["the park wins, and nothing new is done for it", (classes) => expect(classes).toEqual(["quota", "decision"])],
  });

  unit("his name in the decision words follows the configured operator", {
    given: ["a reply that waits on the operator by name", () => "Beslut för Ada: ska vi släppa i kväll?"],
    when: ["classifying it for two operators", (reply) => [classify(reply, { operator: "Ada" }).class, classify(reply, { operator: "Bo" }).class]],
    then: ["only the configured name makes it a decision", (classes) => expect(classes).toEqual(["decision", "unclear"])],
  });

  unit("[quiet] is among amux's own tags, so a pane's copy of a notice is never his", {
    given: ["a pane-hook row that starts with the tag, and the tag list", () => ({
      row: { source: "pane-hook", verbatim: "[quiet] claw:0 waits for a decision you can make (09:19Z): \"Väntar på dig.\" Reply to claw:0." },
      list: AMUX_PANE_TAGS,
    })],
    when: ["asking whether the row is a message of his", ({ row }) => isHumanAsk(row)],
    then: ["it is not, and the tag names the file that sends it", (isHis, { list }) => {
      expect(isHis).toBe(false);
      expect(list.find(({ tag }) => tag === "[quiet]")).toMatchObject({ sender: expect.stringMatching(/^(cli|core)\/quiet/u) });
    }],
  });
});
