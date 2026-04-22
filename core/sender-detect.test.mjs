import { unit, feature, expect } from "bdd-vitest";
import { detectSenderFromEnv, prependSenderHeader } from "./sender-detect.mjs";

feature("detectSenderFromEnv", () => {
  unit("returns null when TMUX env not set", {
    given: ["env without TMUX", () => ({ env: {}, exec: () => "claw\n" })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns null", (result) => expect(result).toBeNull()],
  });

  unit("returns session:windowIdx when in tmux", {
    given: ["TMUX set + tmux returns claw session + window 2", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: (cmd) => {
        if (cmd.includes("#S")) return "claw\n";
        if (cmd.includes("#I")) return "2\n";
        return "";
      },
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns claw:2", (result) => expect(result).toBe("claw:2")],
  });

  unit("returns null when tmux command throws", {
    given: ["TMUX set but exec throws", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: () => { throw new Error("tmux not responsive"); },
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns null (silent fallback)", (result) => expect(result).toBeNull()],
  });

  unit("returns null when tmux returns empty session", {
    given: ["exec returns empty strings", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: () => "\n",
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns null", (result) => expect(result).toBeNull()],
  });

  unit("handles pane index 0", {
    given: ["orchestrator in pane 0", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: (cmd) => cmd.includes("#S") ? "claw\n" : "0\n",
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns claw:0", (result) => expect(result).toBe("claw:0")],
  });

  unit("trims whitespace from tmux output", {
    given: ["exec returns padded strings", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: (cmd) => cmd.includes("#S") ? "  api  \n" : "  3  \n",
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns api:3 with no whitespace", (result) => expect(result).toBe("api:3")],
  });
});

feature("prependSenderHeader", () => {
  unit("returns text unchanged when sender null", {
    given: ["a brief with no sender", () => ({ text: "do the thing", sender: null })],
    when: ["prepending", ({ text, sender }) => prependSenderHeader(text, sender)],
    then: ["returns brief as-is", (result) => expect(result).toBe("do the thing")],
  });

  unit("prepends [from sender] with blank-line separator", {
    given: ["brief + sender claw:0", () => ({ text: "run the tests", sender: "claw:0" })],
    when: ["prepending", ({ text, sender }) => prependSenderHeader(text, sender)],
    then: ["header + blank line + brief", (result) => {
      expect(result).toBe("[from claw:0]\n\nrun the tests");
    }],
  });

  unit("preserves multiline brief body", {
    given: ["multiline brief", () => ({
      text: "line 1\nline 2\nline 3",
      sender: "api:2",
    })],
    when: ["prepending", ({ text, sender }) => prependSenderHeader(text, sender)],
    then: ["header then full body preserved", (result) => {
      expect(result).toBe("[from api:2]\n\nline 1\nline 2\nline 3");
    }],
  });

  unit("empty brief still gets header", {
    given: ["empty text + sender", () => ({ text: "", sender: "claw:0" })],
    when: ["prepending", ({ text, sender }) => prependSenderHeader(text, sender)],
    then: ["header with trailing blank line", (result) => {
      expect(result).toBe("[from claw:0]\n\n");
    }],
  });
});
