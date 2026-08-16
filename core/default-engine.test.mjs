import { expect, test } from "vitest";
import { defaultCodingEngine } from "./default-engine.mjs";

const options = (available) => ({ env: { PATH: "/bin" }, exists: (path) => available.has(path) });

test("starter engine follows the installed CLI rather than one vendor", () => {
  expect(defaultCodingEngine(options(new Set(["/bin/claude", "/bin/codex"])))).toBe("claude");
  expect(defaultCodingEngine(options(new Set(["/bin/codex"])))).toBe("codex");
  expect(defaultCodingEngine(options(new Set(["/bin/kimi-code"])))).toBe("kimi");
  expect(defaultCodingEngine({ env: { PATH: "", HOME: "/home/tester" },
    exists: (path) => path === "/home/tester/.kimi-code/bin/kimi" })).toBe("kimi");
  expect(() => defaultCodingEngine(options(new Set()))).toThrow("no supported coding engine");
});
