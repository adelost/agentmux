import { feature, unit, expect } from "bdd-vitest";
import { promptEventMatches } from "./claude-prompt-text.mjs";

const prompt = "Vad är nästa steg?\n[file attached: /tmp/inbox/notes.txt]";
const pasted = (text, closeId = "0b44") =>
  `\n\n<pasted_content id="0b44">\n${text}\n</pasted_content id="${closeId}">\n`;
const userEvent = (text) => ({ type: "user", message: { content: text } });

feature("Claude pasted-content delivery receipts", () => {
  unit("Claude's removed discretionary soft hyphens do not hide the whole received prompt", {
    given: ["a complete paste recorded without its invisible U+00AD layout hints", () => ({
      sent: "in\u00adgen ändring: först\u00adgång, keep ordinary-hyphen",
      received: userEvent(pasted("ingen ändring: förstgång, keep ordinary-hyphen")),
    })],
    when: ["matching the actual recorded paste, never a substring", ({ sent, received }) => ({
      exactVisibleText: promptEventMatches(received, sent),
      changedHyphen: promptEventMatches(received, sent.replace("ordinary-hyphen", "ordinaryhyphen")),
      changedJoiner: promptEventMatches(received, sent.replace("först", "först\u200d")),
    })],
    then: ["only the observed presentation rewrite is accepted", (result) => expect(result).toEqual({
      exactVisibleText: true, changedHyphen: false, changedJoiner: false,
    })],
  });
  for (const [name, event] of [
    ["direct user text", userEvent(pasted(prompt))],
    ["text content parts", { type: "user", message: { content: [{ type: "text", text: pasted(prompt) }] } }],
    ["queued input", { type: "queue-operation", operation: "enqueue", content: pasted(prompt) }],
    ["queued-command attachment", { type: "attachment", attachment: { type: "queued_command", prompt: pasted(prompt) } }],
    ["sender inside the paste", userEvent(pasted(`[from ai:1]\n\n${prompt}`))],
    ["image marker before the paste", { type: "user", message: { content: [{ type: "text", text: `[Image #53]${pasted(prompt)}` }, { type: "image" }] } }],
  ]) {
    unit(`${name} acknowledges the complete delivered prompt`, {
      given: ["Claude's observed pasted_content envelope around the sent text", () => event],
      when: ["checking the durable receipt", (value) => promptEventMatches(value, prompt)],
      then: ["the received prompt releases its delivery queue", (received) => expect(received).toBe(true)],
    });
  }

  // Recorded by the real Claude Code 2.1.296 in an isolated pane on 2026-10-10 after amux pasted this
  // message in two parts (a line ends in .png). Queued while busy, Claude stores the same envelopes
  // without the outer line breaks (skyvw:0's JSONL, 07:35:20Z).
  const splitMessage = "[from skyvw:1]\n\nÖverlämning för provet: skissen för Mark-sidan ligger i samma mapp.\n\n"
    + "I samma mapp:\n- arken: mark-in-cutkit-style-en.png och pieces-how-to-use-en.png\n"
    + "- skissen, ritad med Cutkits egna CSS-filer\n\nDela ut P1 till P3. Frågor om designen tar du med mig.\n";
  const storedInTwoEnvelopes = "\n\n<pasted_content id=\"130a\">\n[from skyvw:1]\n\nÖverlämning för provet: skissen för Mark-sidan ligger i samma mapp.\n\n"
    + "I samma mapp:\n- arken: mark-in-cutkit-style-en.png och pieces-how-to-use-en.\n</pasted_content id=\"130a\">\n\n\n"
    + "<pasted_content id=\"130a\">\npng\n- skissen, ritad med Cutkits egna CSS-filer\n\nDela ut P1 till P3. Frågor om designen tar du med mig.\n</pasted_content id=\"130a\">\n";
  for (const [name, event] of [
    ["a direct user turn", userEvent(storedInTwoEnvelopes)],
    ["queued input", { type: "queue-operation", operation: "enqueue", content: storedInTwoEnvelopes.trim() }],
    ["a queued-command attachment", { type: "attachment", attachment: { type: "queued_command", prompt: storedInTwoEnvelopes.trim() } }],
  ]) {
    unit(`a message amux pasted in two parts acknowledges once from ${name}`, {
      given: ["Claude's record of the message as two envelopes split mid-word", () => event],
      when: ["checking the durable receipt", (value) => promptEventMatches(value, splitMessage)],
      then: ["the delivered message releases its queue instead of being pasted again", (received) => expect(received).toBe(true)],
    });
  }
  // Same session: a message ending in an image path. Claude keeps the short last part as typed text.
  const endsInImagePath = "[from lsrc:1]\n\nHär är bilden från provkörningen, före och efter:\n"
    + "/home/adelost/lsrc/.artifacts/cutkit-quality-2026-10-09/e283-share/e283-fore-efter-390.png\n";
  unit("a message ending in an image path acknowledges once the path is split from its extension", {
    given: ["Claude's record of the path's last part outside the envelope", () => userEvent(
      "\n\n<pasted_content id=\"ee29\">\n[from lsrc:1]\n\nHär är bilden från provkörningen, före och efter:\n"
      + "/home/adelost/lsrc/.artifacts/cutkit-quality-2026-10-09/e283-share/e283-fore-efter-390.\n</pasted_content id=\"ee29\">\n\npng")],
    when: ["checking the durable receipt", (event) => promptEventMatches(event, endsInImagePath)],
    then: ["the delivered message releases its queue instead of being pasted again", (received) => expect(received).toBe(true)],
  });
  for (const [name, stored] of [
    ["only the first part", storedInTwoEnvelopes.slice(0, storedInTwoEnvelopes.indexOf("\n\n\n<pasted_content"))],
    ["text between the parts", storedInTwoEnvelopes.replace("\n\n\n<pasted_content", "\nmore\n<pasted_content")],
  ]) {
    unit(`a split message with ${name} does not acknowledge`, {
      given: ["a record that is not exactly the two delivered parts", () => userEvent(stored)],
      when: ["checking the durable receipt", (event) => promptEventMatches(event, splitMessage)],
      then: ["the pending message remains unacknowledged", (received) => expect(received).toBe(false)],
    });
  }

  for (const [name, text] of [
    ["different text", pasted(prompt.replace("nästa", "första"))],
    ["different attachment", pasted(prompt.replace("notes.txt", "other.txt"))],
    ["only a substring", pasted(`Quoted earlier:\n${prompt}\nDo something else.`)],
    ["mismatched envelope identity", pasted(prompt, "ffff")],
    ["incomplete envelope", `<pasted_content id="0b44">\n${prompt}`],
    ["additional text outside the envelope", `${pasted(prompt)}Do something else.`],
  ]) {
    unit(`${name} does not acknowledge the pending prompt`, {
      given: ["a receipt that is not the exact sent message", () => userEvent(text)],
      when: ["checking the durable receipt", (event) => promptEventMatches(event, prompt)],
      then: ["the pending message remains unacknowledged", (received) => expect(received).toBe(false)],
    });
  }
});
