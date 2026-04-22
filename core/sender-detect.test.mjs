import { unit, feature, expect } from "bdd-vitest";
import { detectSenderFromEnv, prependSenderHeader } from "./sender-detect.mjs";

// Helper: build an exec mock that returns different values for #S / #P queries
const makeExec = ({ session = "claw", pane = "0", throwOn } = {}) => (cmd) => {
  if (throwOn && cmd.includes(throwOn)) throw new Error("mock throw");
  if (cmd.includes("#S")) return `${session}\n`;
  if (cmd.includes("#P")) return `${pane}\n`;
  return "";
};

feature("detectSenderFromEnv", () => {
  unit("returns null when TMUX env not set", {
    given: ["env without TMUX", () => ({ env: {}, exec: makeExec() })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns null", (result) => expect(result).toBeNull()],
  });

  unit("returns session:paneIndex when in tmux pane 0 (orchestrator)", {
    given: ["TMUX set + claw session + pane 0", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: makeExec({ session: "claw", pane: "0" }),
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns claw:0", (result) => expect(result).toBe("claw:0")],
  });

  unit("returns distinct pane index for non-orchestrator senders", {
    given: ["caller is tmux pane 4", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: makeExec({ session: "claw", pane: "4" }),
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns claw:4", (result) => expect(result).toBe("claw:4")],
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

  unit("returns null when pane index is non-numeric", {
    given: ["exec returns garbage for pane index", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: (cmd) => {
        if (cmd.includes("#S")) return "claw\n";
        if (cmd.includes("#P")) return "not-a-number\n";
        return "";
      },
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns null (safe fallback)", (result) => expect(result).toBeNull()],
  });

  unit("trims whitespace from tmux output", {
    given: ["exec returns padded strings", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: (cmd) => {
        if (cmd.includes("#S")) return "  api  \n";
        if (cmd.includes("#P")) return "  3  \n";
        return "";
      },
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns api:3 (whitespace trimmed)", (result) => expect(result).toBe("api:3")],
  });

  unit("handles double-digit pane index", {
    given: ["caller in pane 12", () => ({
      env: { TMUX: "/tmp/sock,1234,0" },
      exec: makeExec({ session: "claw", pane: "12" }),
    })],
    when: ["detecting sender", ({ env, exec }) => detectSenderFromEnv(env, exec)],
    then: ["returns claw:12", (result) => expect(result).toBe("claw:12")],
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
