import { feature, unit, expect } from "bdd-vitest";
import { parseArgs } from "./amux-suggest.mjs";

const base = ["--method", "POST", "--path", "/api/agent/tickets/AI-0023/triage-retry?project=ai",
  "--body-file", "body.json"];

feature("Reaching an agent route through the sanctioned client", () => {
  unit("carries the agent identity the /api/agent routes authenticate against", {
    given: ["a call that names the calling pane", () => [...base, "--agent-id", "ai:0"]],
    when: ["the arguments are parsed", (argv) => parseArgs(argv)],
    then: ["the header the library whitelists is the one that gets set", (options) =>
      expect(options.requestHeaders).toEqual({ "x-agent-id": "ai:0" })],
  });

  unit("adds no header when no identity was asked for", {
    given: ["a plain admin-path call", () => base],
    when: ["the arguments are parsed", (argv) => parseArgs(argv)],
    then: ["nothing is invented", (options) => expect(options.requestHeaders).toBeUndefined()],
  });

  unit("still rejects a flag it does not know, rather than dropping it silently", {
    given: ["a call with an invented header flag", () => [...base, "--x-secret", "value"]],
    when: ["the arguments are parsed", (argv) => {
      try { parseArgs(argv); return null; } catch (error) { return error.message; }
    }],
    then: ["it fails loud and names the flag", (message) => expect(message).toContain("--x-secret")],
  });

  unit("keeps the flags the verbatim contract depends on", {
    given: ["a call using expect-file and read-path together", () => parseArgs([
      ...base, "--expect-file", "quote.txt", "--read-path", "/api/tickets/AI-0023?project=ai",
    ])],
    when: ["reading back what was parsed", (options) => options],
    then: ["the UTF-8 proof path is intact alongside the new flag", (options) => {
      expect(options.expectFiles).toEqual(["quote.txt"]);
      expect(options.readPath).toBe("/api/tickets/AI-0023?project=ai");
    }],
  });
});
