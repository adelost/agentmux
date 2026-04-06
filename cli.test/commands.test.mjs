import { feature, unit, component, expect } from "bdd-vitest";
import { parseFlags } from "../cli/commands.mjs";

feature("parseFlags", () => {
  unit("extracts string flags", {
    given: ["args with -n channel", () => ["-n", "notify", "hello"]],
    when: ["parsing with string spec", (args) => parseFlags(args, { n: "string" })],
    then: ["flag extracted, rest is positional", ({ flags, positional }) => {
      expect(flags.n).toBe("notify");
      expect(positional).toEqual(["hello"]);
    }],
  });

  unit("extracts number flags", {
    given: ["args with -p 2", () => ["-p", "2", "prompt"]],
    when: ["parsing with number spec", (args) => parseFlags(args, { p: "number" })],
    then: ["flag is number", ({ flags, positional }) => {
      expect(flags.p).toBe(2);
      expect(positional).toEqual(["prompt"]);
    }],
  });

  unit("extracts boolean flags", {
    given: ["args with -q", () => ["-q", "prompt"]],
    when: ["parsing with boolean spec", (args) => parseFlags(args, { q: "boolean" })],
    then: ["flag is true", ({ flags, positional }) => {
      expect(flags.q).toBe(true);
      expect(positional).toEqual(["prompt"]);
    }],
  });

  unit("handles multiple flags", {
    given: ["args with -n, -p, -q", () => ["-n", "dev", "-p", "1", "-q", "fix bug"]],
    when: ["parsing", (args) => parseFlags(args, { n: "string", p: "number", q: "boolean" })],
    then: ["all flags extracted", ({ flags, positional }) => {
      expect(flags.n).toBe("dev");
      expect(flags.p).toBe(1);
      expect(flags.q).toBe(true);
      expect(positional).toEqual(["fix bug"]);
    }],
  });

  unit("handles --long flags", {
    given: ["args with --full", () => ["--full", "test"]],
    when: ["parsing", (args) => parseFlags(args, { full: "boolean" })],
    then: ["long flag extracted", ({ flags }) => expect(flags.full).toBe(true)],
  });

  unit("unknown flags become positional", {
    given: ["args with unknown flag", () => ["-x", "value"]],
    when: ["parsing with empty spec", (args) => parseFlags(args, {})],
    then: ["both in positional", ({ positional }) => expect(positional).toEqual(["-x", "value"])],
  });

  unit("no args returns empty", {
    given: ["empty args", () => []],
    when: ["parsing", (args) => parseFlags(args, { n: "string" })],
    then: ["empty flags and positional", ({ flags, positional }) => {
      expect(flags).toEqual({});
      expect(positional).toEqual([]);
    }],
  });
});
