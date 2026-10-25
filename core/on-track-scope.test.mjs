import { feature, unit, expect } from "bdd-vitest";
import { onTrackOriginalAsk, onTrackProjectAsk } from "./on-track-scope.mjs";

const human = extra => ({ id: "original", source: "discord", agent: "lsrc", pane: 0, verbatim: "Export Bumbi", ...extra });
const project = { askAgents: ["lsrc"], askPanels: ["skyvw:0"], askTerms: ["cut", "cutkit", "export", "bumbi", "modal-wrapper"] };
feature("C1 counts original human project orders", () => {
  unit("provider mirrors and cron are outside C1 without filtering the human words", {
    when: ["checking original and mirror copies of identical words", () => [human(), human({ source: "pane-hook" }), human({ source: "cli" }), human({ source: "on-track" })].map(onTrackOriginalAsk)],
    then: ["only the original channel counts", r => expect(r).toEqual([true, false, false, false])],
  });
  unit("direct project panels and explicit project terms qualify independently", {
    when: ["checking original routed orders and another project", () => [
      human({ agent: "skyvw", pane: 0, verbatim: "Less text in Find" }), human({ verbatim: "Make the Cutkit export precise" }), human({ verbatim: "Husets dolls" }),
    ].map(ask => onTrackProjectAsk(project, ask))],
    then: ["the two project orders remain", r => expect(r).toEqual([true, true, false])],
  });
  unit("a real other-project binding outranks a generic overlapping word", {
    when: ["an export belongs to another repository", () => onTrackProjectAsk(project, human(), { otherProject: true })],
    then: ["its own reviewer gets it", r => expect(r).toBe(false)],
  });
  unit("agent relays and explicit machine notices are excluded", {
    when: ["checking peer and machine inputs", () => [human({ verbatim: "[from claw:0]\nExport Bumbi" }), human({ verbatim: "[quiet] Export Bumbi" }), human({ verbatim: "[idle-capacity] Export Bumbi" })].map(onTrackOriginalAsk)],
    then: ["none is a human order", r => expect(r).toEqual([false, false, false])],
  });
});
