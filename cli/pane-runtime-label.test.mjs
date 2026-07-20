import { describe, expect, it } from "vitest";
import { paneRuntimeLabel } from "./pane-runtime-label.mjs";

describe("pane runtime identity", () => {
  it("makes engine and transport explicit for coding, shell and service panes", () => {
    expect(paneRuntimeLabel("kimi")).toBe("kimi/tmux");
    expect(paneRuntimeLabel("claude", "native")).toBe("claude/native");
    expect(paneRuntimeLabel(null, "tmux", true)).toBe("shell/tmux");
    expect(paneRuntimeLabel(null)).toBe("svc/tmux");
  });
});
