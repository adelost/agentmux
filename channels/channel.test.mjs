import { unit, feature, expect } from "bdd-vitest";
import { validateChannel } from "./channel.mjs";

feature("validateChannel", () => {
  unit("accepts complete implementation", {
    given: ["a channel with all required fields", () => ({
      name: "test",
      onMessage: () => {},
      start: async () => {},
      stop: () => {},
    })],
    when: ["validating", (ch) => validateChannel(ch)],
    then: ["passes", (result) => {
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    }],
  });

  unit("rejects missing onMessage", {
    given: ["a channel without onMessage", () => ({
      name: "bad",
      start: async () => {},
      stop: () => {},
    })],
    when: ["validating", (ch) => validateChannel(ch)],
    then: ["fails with onMessage missing", (result) => {
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("onMessage");
    }],
  });

  unit("rejects missing name", {
    given: ["a channel without name", () => ({
      onMessage: () => {},
      start: async () => {},
      stop: () => {},
    })],
    when: ["validating", (ch) => validateChannel(ch)],
    then: ["fails with name missing", (result) => {
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("name");
    }],
  });

  unit("rejects null input", {
    when: ["validating null", () => validateChannel(null)],
    then: ["fails with all fields missing", (result) => {
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["name", "onMessage", "start", "stop"]);
    }],
  });

  unit("rejects non-function start", {
    given: ["a channel with string start", () => ({
      name: "bad",
      onMessage: () => {},
      start: "not-a-function",
      stop: () => {},
    })],
    when: ["validating", (ch) => validateChannel(ch)],
    then: ["fails with start missing", (result) => {
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("start");
    }],
  });
});
