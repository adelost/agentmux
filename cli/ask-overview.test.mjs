import { feature, unit, expect } from "bdd-vitest";
import {
  buildAskOverview,
  compactAskOverviewText,
  formatAskOverview,
} from "./ask-overview.mjs";

const row = ({ agent, pane, minutes, prompt, reply = "", status = "answered", open = false }) => ({
  agent,
  pane,
  key: `${agent}:${pane}`,
  tsMs: 1_000_000 - minutes * 60_000,
  ageMs: minutes * 60_000,
  prompt,
  reply,
  status,
  open,
});

feature("ask overview", () => {
  unit("groups by agent and keeps the latest ask for each recent pane", {
    given: ["multiple asks across two agents and repeated panes", () => [
      row({ agent: "claw", pane: 1, minutes: 20, prompt: "older", status: "unverified", open: true }),
      row({ agent: "claw", pane: 1, minutes: 2, prompt: "latest claw one", status: "working", open: true }),
      row({ agent: "claw", pane: 3, minutes: 5, prompt: "latest claw three", status: "done" }),
      row({ agent: "skydive", pane: 7, minutes: 1, prompt: "latest skydive", status: "needs-you", open: true }),
    ]],
    when: ["building a two-pane-per-agent overview", (rows) => buildAskOverview(rows, { perAgent: 2 })],
    then: ["agents are activity-sorted and counts include hidden history", (groups) => {
      expect(groups.map((group) => group.agent)).toEqual(["skydive", "claw"]);
      expect(groups[1]).toMatchObject({ total: 3, open: 2, paneCount: 2, hiddenAsks: 1 });
      expect(groups[1].recentAsks.map((entry) => entry.prompt)).toEqual([
        "latest claw one", "latest claw three",
      ]);
    }],
  });

  unit("removes voice and path chrome while retaining the end of a long ask", {
    when: ["compacting a decorated voice ask", () => compactAskOverviewText(
      "[transcribed voice, may contain speech-to-text errors — interpret intent] "
      + "Jag beskriver först väldigt mycket bakgrund som inte får äta hela raden. "
      + "Kan ni fixa den viktiga sista detaljen?\n"
      + "[image attached: /tmp/private-proof.png]",
      80,
    )],
    then: ["the useful text and opaque attachment count remain", (text) => {
      expect(text).not.toContain("transcribed voice");
      expect(text).not.toContain("/tmp/private-proof.png");
      expect(text).toContain("Jag beskriver");
      expect(text).toContain("sista detaljen?");
      expect(text).toContain("[bild]");
      expect(text.length).toBeLessThanOrEqual(80);
    }],
  });

  unit("renders status, latest ask and reply under each agent with exact drilldown", {
    when: ["formatting one open pane", () => formatAskOverview([
      row({ agent: "claw", pane: 3, minutes: 3, prompt: "Bygg översikten", reply: "Jag bygger den", status: "working", open: true }),
    ])],
    then: ["the output is compact but actionable", (text) => {
      expect(text).toContain("Agentöversikt");
      expect(text).toContain("claw: 1 unresolved");
      expect(text).toContain("claw:3");
      expect(text).toContain("← Bygg översikten");
      expect(text).toContain("→ Jag bygger den");
      expect(text).toContain("amux asks claw --list");
    }],
  });
});
