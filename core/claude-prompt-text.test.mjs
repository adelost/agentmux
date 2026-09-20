import { feature, unit, expect } from "bdd-vitest";
import { promptEventMatches } from "./claude-prompt-text.mjs";

const prompt = "Vad är nästa steg?\n[file attached: /tmp/inbox/notes.txt]";
const pasted = (text, closeId = "0b44") =>
  `\n\n<pasted_content id="0b44">\n${text}\n</pasted_content id="${closeId}">\n`;
const userEvent = (text) => ({ type: "user", message: { content: text } });

feature("Claude pasted-content delivery receipts", () => {
  for (const [name, event] of [
    ["direct user text", userEvent(pasted(prompt))],
    ["text content parts", { type: "user", message: { content: [{ type: "text", text: pasted(prompt) }] } }],
    ["queued input", { type: "queue-operation", operation: "enqueue", content: pasted(prompt) }],
    ["queued-command attachment", { type: "attachment", attachment: { type: "queued_command", prompt: pasted(prompt) } }],
    ["sender inside the paste", userEvent(pasted(`[from ai:1]\n\n${prompt}`))],
  ]) {
    unit(`${name} acknowledges the complete delivered prompt`, {
      given: ["Claude's observed pasted_content envelope around the sent text", () => event],
      when: ["checking the durable receipt", (value) => promptEventMatches(value, prompt)],
      then: ["the received prompt releases its delivery queue", (received) => expect(received).toBe(true)],
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
