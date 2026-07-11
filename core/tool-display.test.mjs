import { feature, unit, expect } from "bdd-vitest";
import { describeCustomExec, describeToolCall, extractNestedToolCalls } from "./tool-display.mjs";

feature("tool display: provider-neutral vocabulary", () => {
  unit("Claude Bash becomes Run", {
    when: ["describing", () => describeToolCall("Bash", { command: "git status --short" })],
    then: ["semantic output", (result) => expect(result).toEqual({ content: "Run git status --short", kind: "tool" })],
  });

  unit("Claude Grep becomes Search", {
    when: ["describing", () => describeToolCall("Grep", { pattern: "predictedSpot", path: "app/src" })],
    then: ["semantic output", (result) => expect(result.content).toBe("Search predictedSpot in app/src")],
  });

  unit("quoted Codex exec_command JSON becomes Run", {
    given: ["modern wrapper source", () => 'const r = await tools.exec_command({"cmd":"git status --short","workdir":"/repo"}); text(r.output);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["inner command", (result) => expect(result).toEqual({ content: "Run git status --short", kind: "tool" })],
  });

  unit("multi-line search reports the leading action and command count", {
    given: ["a claw:9-shaped command", () => 'const r = await tools.exec_command({"cmd":"rg -n \\\"heading\\\" app/src\\nsed -n \\\"1,120p\\\" app/src/Dial.kt","workdir":"/repo"}); text(r.output);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["concise search summary", (result) => {
      expect(result.content).toContain("Search");
      expect(result.content).toContain("+1 commands");
      expect(result.content).not.toBe("exec");
    }],
  });

  unit("unquoted JavaScript fields still expose a viewed image name", {
    given: ["tool source", () => 'const r = await tools.view_image({path:"/tmp/proof.png", detail:"high"}); image(r.image_url);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["view output", (result) => expect(result.content).toBe("View image /tmp/proof.png")],
  });

  unit("dynamic image paths do not produce a duplicated placeholder", {
    given: ["a loop variable passed as path", () => 'const r = await tools.view_image({path, detail:"original"}); image(r.image_url);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["honest generic label", (result) => expect(result.content).toBe("View image")],
  });

  unit("web orchestration is labeled by intent", {
    given: ["a web search", () => 'const r = await tools.web__run({"search_query":[{"q":"wind direction"}]}); text(r);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["search label", (result) => expect(result.content).toBe("Search web")],
  });

  unit("write_stdin polling is classified as Wait", {
    given: ["poll source", () => 'const r = await tools.write_stdin({"session_id":91516,"chars":""}); text(r.output);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["wait output", (result) => expect(result).toEqual({ content: "Wait for process 91516", kind: "wait" })],
  });

  unit("multi-file patch names files without exposing hunks", {
    given: ["patch wrapper", () => String.raw`const patch = "*** Begin Patch\n*** Update File: /repo/ui/A.kt\n@@\n-secret\n+new\n*** Update File: /repo/ui/B.kt\n@@\n-old\n+new\n*** End Patch"; text(await tools.apply_patch(patch));`],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["edit summary", (result) => expect(result.content).toBe("Edit 2 files: A.kt | B.kt")],
  });

  unit("inter-agent command is recognized as Send", {
    given: ["send wrapper", () => 'const r = await tools.exec_command({"cmd":"amux lsrc -p 0 \\\"review images\\\""}); text(r.output);'],
    when: ["unwrapping", (source) => describeCustomExec(source)],
    then: ["send output", (result) => expect(result).toEqual({ content: "Send -> lsrc:0", kind: "inter-agent-send" })],
  });

  unit("scanner ignores tool-looking text inside strings", {
    given: ["patch text plus real apply", () => 'const patch = "mention tools.exec_command({})"; text(await tools.apply_patch(patch));'],
    when: ["extracting", (source) => extractNestedToolCalls(source)],
    then: ["only real outer call", (calls) => expect(calls.map((call) => call.name)).toEqual(["apply_patch"])],
  });

  unit("unknown wrappers never leak bare exec", {
    when: ["unwrapping", () => describeCustomExec("const answer = 42;")],
    then: ["honest fallback", (result) => expect(result.content).toBe("Run internal operation (details unavailable)")],
  });
});
