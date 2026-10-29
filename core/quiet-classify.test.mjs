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

  // Design v4, from the review of the 06:00 to 10:00Z replay: three of the six forwards were a report, an explanation and
  // a reply to another pane. A decision asks for a yes or no, or names one for the operator, on a line that asks.
  unit("a waiting line without a yes or no is not a decision", {
    given: ["a reply to another pane that waits on its line, and a report that rows wait on him", () => [
      "Jag uppdaterar den sparade pausen och väntar på din rad om att värden är fri.",
      "SUMMARY: rapporten är skickad.\nOPEN: Raderna 17 och 92 stänger jag efter stämpeln. 71 och 79 väntar på Mattias.",
    ]],
    when: ["classifying each", (replies) => replies.map((reply) => classify(reply).class)],
    then: ["neither is a decision", (classes) => expect(classes).not.toContain("decision")],
  });

  unit("a summary that explains a rule needing his yes is not a decision", {
    given: ["a SUMMARY line that names his yes in passing, and a GOAL line that restates one", () => [
      "SUMMARY: rad 47 är struken, eftersom din regel kräver ditt ja för varje verktyg.\nDONE: raden struken.",
      "GOAL: ditt ja eller nej på rad 12 inhämtat.\nNOW: läser koden.",
    ]],
    when: ["classifying each", (replies) => replies.map((reply) => classify(reply).class)],
    then: ["neither is a decision", (classes) => expect(classes).not.toContain("decision")],
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

  // Departure from the design, found by the replay of 06:00 to 10:00Z: a word of the list inside a file name or a GOAL line
  // made a tool trace and a restated goal look like a request for his hands.
  unit("a file name or a GOAL line that holds a hands word is not a request for his hands", {
    given: ["a tool trace with film-card-picture.ts and a GOAL line about his phone, and four real requests, three ending a sentence on a listed word and one with the word after a hyphen", () => ({
      traces: ["`Run git show a83d8ae3b:cloud/src/film-card-picture.ts`", "Edit core/api-key-store.mjs and hardware-probe.mjs", "Run curl https://host/login.json"],
      goal: "GOAL: Förklara varför din telefon visar en tom bildyta.",
      requests: ["Du måste testa själv.", "Koppla in din telefon.", "Det behövs ett betalkort.", "Mattias egen Google-inloggning återstår."],
    })],
    when: ["classifying each", ({ traces, goal, requests }) => ({
      traces: traces.map((reply) => classify(reply).class), goal: classify(goal).class, requests: requests.map((reply) => classify(reply).class),
    })],
    then: ["the traces and the GOAL line are not hands, and the requests are", (classes) => {
      expect(classes.traces).not.toContain("hands");
      expect(classes.goal).not.toBe("hands");
      expect(classes.requests).toEqual(["hands", "hands", "hands", "hands"]);
    }],
  });

  // 29 Oct: a status that reported what his phone picture showed, and ended saying no action was needed from him, went on
  // the hands list at 00:40Z; the pane's wait loops had hung, and nobody was told for 7 h.
  unit("a reply that says nothing is needed from him is left work, not his hands", {
    given: ["a status with work LEFT that reports what his phone picture showed and ends with no action needed from him, in Swedish and in English", () => [
      "SUMMARY: Skalet är byggt.\nLEFT: röktest, granskning, deploy.\n- Fynd: därför visade din telefonbild en röd smet.\nNEXT: röktest och deploy. Ingen åtgärd från dig behövs än.",
      "SUMMARY: The shell is built.\nLEFT: smoke, review, deploy.\n- Not flown on your hardware yet.\nNEXT: smoke and deploy. No action needed from you yet.",
    ]],
    when: ["classifying each", (replies) => replies.map((reply) => classify(reply).class)],
    then: ["both are left work, so the lead gets the nudge", (classes) => expect(classes).toEqual(["left", "left"])],
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
