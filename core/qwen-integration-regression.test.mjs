import { component, expect, feature } from "bdd-vitest";
import * as reader from "./qwen-jsonl-reader.mjs";
import { createQwenAgentRuntime } from "./qwen-agent-runtime.mjs";
import { qwenReaderCases } from "../test/qwen-review-reader-cases.mjs";
import { qwenRuntimeCases } from "../test/qwen-review-runtime-cases.mjs";

feature("Qwen persistent-pane identity and journal regressions", () => {
  for (const { id, run } of [
    ...qwenReaderCases(reader),
    ...qwenRuntimeCases(createQwenAgentRuntime, reader),
  ]) {
    component(id, {
      when: ["the real reader/runtime consumes the isolated protocol fixture", run],
      then: ["the asserted ownership and output contract holds", (passed) => expect(passed).toBe(true)],
    });
  }
});
