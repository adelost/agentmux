import { expect, test } from "vitest";
import {
  DEFAULT_OPERATOR_NAME,
  DEFAULT_TMUX_SOCKET,
  DEFAULT_TTS_VOICE,
  defaultTodosPath,
  defaultWorkspace,
  normalizeServiceBaseUrl,
  operatorName,
} from "./runtime-defaults.mjs";

test("standalone defaults contain no private product identity", () => {
  expect(DEFAULT_TMUX_SOCKET).toMatch(/agentmux-tmux\.sock$/u);
  expect(DEFAULT_TTS_VOICE).toBe("en-US-AriaNeural");
  expect(DEFAULT_OPERATOR_NAME).toBe("the operator");
  expect(`${DEFAULT_TMUX_SOCKET} ${DEFAULT_TTS_VOICE} ${DEFAULT_OPERATOR_NAME}`)
    .not.toMatch(/openclaw|mattias|v1d\.io/iu);
});

test("memory and task defaults belong to AMUX", () => {
  expect(defaultWorkspace("/home/tester")).toBe("/home/tester/.agentmux/workspace");
  expect(defaultTodosPath("/home/tester")).toBe("/home/tester/.agentmux/workspace/memory/tasks.md");
});

test("service origins are explicit, self-hostable, and fail closed", () => {
  expect(normalizeServiceBaseUrl("https://tasks.example.test/", "Suggestions base URL"))
    .toBe("https://tasks.example.test");
  expect(() => normalizeServiceBaseUrl(undefined, "Suggestions base URL"))
    .toThrow("is not configured");
  expect(() => normalizeServiceBaseUrl("http://tasks.example.test", "Suggestions base URL"))
    .toThrow("must use HTTPS");
  expect(normalizeServiceBaseUrl("http://127.0.0.1:8787", "Suggestions base URL", {
    allowHttpLoopback: true,
  })).toBe("http://127.0.0.1:8787");
  expect(() => normalizeServiceBaseUrl("https://tasks.example.test/api", "Suggestions base URL"))
    .toThrow("without a path");
});

test("operator identity is configured rather than authored into core", () => {
  expect(operatorName({})).toBe("the operator");
  expect(operatorName({ AMUX_OPERATOR_NAME: "Ada" })).toBe("Ada");
});
