// A synthetic ledger for the quiet tests (docs/DESIGN-quiet-panes.md, chapter 12).
// Every line below is invented; none is a pane's or his real text. The shapes are the real ones: claw:0 ends three
// turns with the same waiting line while other panes keep sending it asks, a long reply is split in Discord-sized
// chunks, and the bridge posts a short context footer (kind notice) after a reply.
//
// `askRow` and `postRow` build rows in the shape readWindow returns, for the pure tests. `writeLedger` writes the same
// rows through the real writers (test/fixtures/conversation-log.mjs) for the tests that read a file.

import { createLog } from "./conversation-log.mjs";

export const DAY = "2026-10-20";
export const at = (clock) => `${DAY}T${clock}${clock.length === 5 ? ":00" : ""}Z`;
export const ms = (clock) => Date.parse(at(clock));

/** The pane lines the scenarios end with. */
export const LINES = Object.freeze({
  decision: "- **Väntar på dig.** Ja eller nej till ett liveparti med AI-röster för rad 42, högst cirka 1 USD. Jag rekommenderar ja.",
  login: "Logga in på Play Console i din webbläsare, sedan kör jag vidare.",
  both: "Logga in på Play Console i din webbläsare, sedan väntar jag på ditt ja eller nej till uppladdningen.",
  left: "LEFT: bygg zon 4 och kör gränstesten",
  done: "DONE: zon 3 byggd och pushad\nVERIFIED: gränstesten grön\nOPEN: none",
  question: "Vill du att jag tar rad 7 först?",
});

/** A reply as the pane writes it: some status, then the line it ends with. */
export const replyEndingWith = (line) => `NOW: zon 3 byggs, claw:5 väntar på grindarna\n- **Läge.** Zon 3 är byggd, test pågår.\n${line}\n- Ledgern är abc1234.`;

const split = (pane) => { const [agent, index] = pane.split(":"); return { agent, pane: Number(index) }; };

/** One ask to a pane, in readWindow's shape. */
export const askRow = (pane, clock, text = "Nästa uppgift i kön, rapportera när den är klar", extra = {}) => ({
  event: "ask", version: 1, id: `ask:${pane}:${clock}`, ts: at(clock), ...split(pane), source: "cli", verbatim: text, ...extra,
});

/** One post of a pane, in readWindow's shape. */
export const postRow = (pane, clock, text, kind = "reply", extra = {}) => ({
  event: "post", version: 1, id: `post:${pane}:${clock}:${kind}`, ts: at(clock), ...split(pane), kind, status: "sent",
  text, files: [], channelId: "channel", via: "bridge", ...extra,
});

/** A reply, and the context footer (kind notice) the bridge posts a second after it. */
export const replyWithFooter = (pane, clock, text) => {
  const reply = postRow(pane, clock, text);
  return [reply, postRow(pane, clock, "-# ctx 41%", "notice", { ts: new Date(Date.parse(reply.ts) + 1000).toISOString() })];
};

/** The rows readWindow would return for these rows. */
export const toLog = (rows) => ({
  asks: rows.filter((row) => row.event === "ask"),
  posts: rows.filter((row) => row.event === "post"),
});

/**
 * claw:0 on 20 Oct: three turns end with the same line, and asks from other panes arrive between them. The first
 * reply is quiet for 3 min 36 s before the next ask, the second for 2 min 40 s, and the third until 09:37:38.
 */
export const CLAW_156 = Object.freeze([
  askRow("claw:0", "09:15:10", "Hur går det med rad 42?", { source: "discord" }),
  ...replyWithFooter("claw:0", "09:19:34", replyEndingWith(LINES.decision)),
  askRow("claw:0", "09:23:10", "[from lsrc:2]\n\nVad är status på rad 41?"),
  askRow("claw:0", "09:23:24", "[from lsrc:1]\n\nKolla grindarna igen"),
  ...replyWithFooter("claw:0", "09:26:52", replyEndingWith(LINES.decision)),
  askRow("claw:0", "09:29:32", "[from lsrc:2]\n\nOch rad 43?"),
  ...replyWithFooter("claw:0", "09:30:21", replyEndingWith(LINES.decision)),
  askRow("claw:0", "09:37:38", "[from lsrc:1]\n\nTack, fortsätt med resten"),
]);

/** Panes that were active at 09:00 to 09:10, so none of them is dormant when a notice is due. */
export const ACTIVE_PANES = Object.freeze(["lsrc:0", "lsrc:1", "claw:0", "claw:3", "skyvw:0"].flatMap((pane) => [
  askRow(pane, "09:00:00", "Vad är läget?"),
  postRow(pane, "09:10:00", "Läget är under kontroll."),
]));

/** The roster as ~/.agentmux/ROSTER.md writes it: a lead and the builders of each project. */
export const ROSTER = `# Fleet roster

## Projects now

| Project | Repo | Ledger | Lead | Builders now | Current work |
|---|---|---|---|---|---|
| Cutkit | ~/lsrc/cutkit | docs/TASKS.md | skyvw:0 (Opus) | skyvw:1 (Sonnet), lsrc:1, lsrc:2 (Opus) | rows |
| Haunt | haunt-lab | TASKS.md | claw:0 (Opus) | claw:1 trains, claw:2 3D dolls, skydive:0, claw:6 and claw:5 (Codex) | train 17 |
| Fleet dispatch | ~/.agentmux/PRIORITIES.md | daily log | lsrc:0 | | his single contact |
`;

/**
 * Writes rows through the real writers into a ledger file of its own and returns where it is. `append` adds a row later,
 * as a pane would. Posts get the id the writer makes up, so a test that needs an id reads the rows back.
 */
export function writeLedger(rows) {
  const log = createLog();
  const append = (row) => {
    if (row.event === "ask") {
      log.ask({ id: row.id, ts: row.ts, agent: row.agent, pane: row.pane, source: row.source, sender: row.sender, text: row.verbatim });
    } else {
      log.post({ agent: row.agent, pane: row.pane, ts: row.ts, text: row.text, kind: row.kind, status: row.status });
    }
  };
  rows.forEach(append);
  return { path: log.path, append, remove: () => log.remove() };
}
