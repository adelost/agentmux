import { feature, unit, expect } from "bdd-vitest";
import { parseFlags, flagShapedPromptTokens } from "./commands.mjs";

const SEND_LIKE = { p: "number", t: "number", stdin: "boolean", q: "boolean", "idempotency-key": "string" };

feature("CLI flag parsing", () => {
  unit("reads a short flag whose value is attached to the same token", {
    given: ["the compact form people actually type", () => ["-p2", "kör testerna"]],
    when: ["parsing with the send spec", (args) => parseFlags(args, SEND_LIKE)],
    then: ["pane 2 is selected and nothing leaks into the prompt", (parsed) => {
      expect(parsed.flags.p).toBe(2);
      expect(parsed.positional).toEqual(["kör testerna"]);
    }],
  });

  unit("reads a long flag written with an equals sign", {
    given: ["--flag=value form", () => ["--idempotency-key=abc123", "text"]],
    when: ["parsing with the send spec", (args) => parseFlags(args, SEND_LIKE)],
    then: ["the value is claimed by the flag", (parsed) => {
      expect(parsed.flags["idempotency-key"]).toBe("abc123");
      expect(parsed.positional).toEqual(["text"]);
    }],
  });

  unit("still reads the separated form", {
    given: ["the documented spelling", () => ["-p", "3", "--stdin"]],
    when: ["parsing with the send spec", (args) => parseFlags(args, SEND_LIKE)],
    then: ["both flags land unchanged", (parsed) => {
      expect(parsed.flags.p).toBe(3);
      expect(parsed.flags.stdin).toBe(true);
      expect(parsed.positional).toEqual([]);
    }],
  });

  unit("never attaches a value to a boolean flag", {
    given: ["a boolean flag with trailing characters", () => ["-q2"]],
    when: ["parsing with the send spec", (args) => parseFlags(args, SEND_LIKE)],
    then: ["it is not silently read as the boolean", (parsed) => {
      expect(parsed.flags.q).toBeUndefined();
      expect(parsed.positional).toEqual(["-q2"]);
    }],
  });
});

feature("Send-path protection against misrouted flags", () => {
  unit("flags a lone token that reads as an option", {
    given: ["an unknown option left among the prompt words", () => ["-x2", "gör", "detta"]],
    when: ["scanning the prompt", (positional) => flagShapedPromptTokens(positional)],
    then: ["the stray token is reported", (stray) => expect(stray).toEqual(["-x2"])],
  });

  unit("leaves ordinary prose alone", {
    given: ["a prompt that merely mentions a flag", () => ["kolla -p2 i loggen", "- och punktlistan"]],
    when: ["scanning the prompt", (positional) => flagShapedPromptTokens(positional)],
    then: ["nothing is reported, because both tokens contain whitespace", (stray) => expect(stray).toEqual([])],
  });
});
