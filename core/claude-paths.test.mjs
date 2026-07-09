import { unit, feature, expect } from "bdd-vitest";
import { claudeProjectSlug, claudeProjectDir, classifyHistoryRead } from "./claude-paths.mjs";

feature("claude path encoding — the one truth", () => {
  unit("slash and dot both become dash", {
    given: ["a pane dir with dots and slashes", () => "/home/user/lsrc/.agents/1"],
    when: ["encoding", (d) => claudeProjectSlug(d)],
    then: ["matches Claude Code's on-disk convention", (s) => {
      expect(s).toBe("-home-user-lsrc--agents-1");
    }],
  });

  unit("project dir joins home + .claude/projects + slug", {
    given: ["pane dir and explicit home", () => ({ dir: "/ws/.agents/3", home: "/home/u" })],
    when: ["resolving", ({ dir, home }) => claudeProjectDir(dir, home)],
    then: ["full project path", (p) => {
      expect(p).toBe("/home/u/.claude/projects/-ws--agents-3");
    }],
  });
});

feature("classifyHistoryRead — ENOENT is the only silent miss", () => {
  const enoent = () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
  const eio = () => { const e = new Error("EIO: i/o error"); e.code = "EIO"; throw e; };

  unit("jsonl present means history", {
    given: ["a dir listing with a session file", () => ({ readdir: () => ["a.jsonl", "x.txt"] })],
    when: ["classifying", (deps) => classifyHistoryRead("/p", deps)],
    then: ["history true, no error", (r) => {
      expect(r.history).toBe(true);
      expect(r.error).toBeUndefined();
    }],
  });

  unit("no jsonl means no history", {
    given: ["a dir listing without session files", () => ({ readdir: () => ["notes.md"] })],
    when: ["classifying", (deps) => classifyHistoryRead("/p", deps)],
    then: ["history false, no error", (r) => {
      expect(r.history).toBe(false);
      expect(r.error).toBeUndefined();
    }],
  });

  unit("ENOENT is a legitimately new pane, not an error", {
    given: ["readdir throwing ENOENT", () => ({ readdir: enoent })],
    when: ["classifying", (deps) => classifyHistoryRead("/p", deps)],
    then: ["history false, error absent", (r) => {
      expect(r.history).toBe(false);
      expect(r.error).toBeUndefined();
    }],
  });

  unit("any other failure surfaces as error (silent downgrade = context loss)", {
    given: ["readdir throwing EIO", () => ({ readdir: eio })],
    when: ["classifying", (deps) => classifyHistoryRead("/p", deps)],
    then: ["history false AND error present for the caller to shout about", (r) => {
      expect(r.history).toBe(false);
      expect(r.error).toBeDefined();
      expect(r.error.code).toBe("EIO");
    }],
  });
});
