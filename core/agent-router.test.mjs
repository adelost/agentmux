import { describe, expect, it, vi } from "vitest";
import { createAgentRouter } from "./agent-router.mjs";

describe("agent backend router", () => {
  it("routes only opted-in panes and leaves fleet lifecycle on tmux", async () => {
    const tmuxAgent = {
      capturePane: vi.fn(async () => "tmux"),
      getResponse: vi.fn(async () => "tmux-response"),
      sendEscape: vi.fn(async () => "tmux-escape"),
      restartPaneExact: vi.fn(async () => "tmux-restart"),
      reconcileSession: vi.fn(async () => "tmux-reconcile"),
      ensureReady: vi.fn(async () => "tmux-ready"),
    };
    const nativeRuntime = {
      isNativeTarget: vi.fn((name) => name === "skybar-canary"),
      capturePane: vi.fn(async () => "native"),
      getResponse: vi.fn(async () => "native-response"),
      sendEscape: vi.fn(async () => "native-interrupt"),
      ensureSession: vi.fn(async () => [{ agent: { id: "one" } }, { agent: { id: "two" } }]),
      ensureTarget: vi.fn(async () => ({ agent: { id: "one" } })),
      deliverQueued: vi.fn(),
      deliveryStatus: vi.fn(async () => ({ state: "completed", code: 0 })),
    };
    const agent = createAgentRouter({ tmuxAgent, nativeRuntime });

    await expect(agent.capturePane("skybar-canary", 0)).resolves.toBe("native");
    await expect(agent.capturePane("claw", 3)).resolves.toBe("tmux");
    await expect(agent.getResponse("skybar-canary", 0)).resolves.toBe("native-response");
    await expect(agent.sendEscape("skybar-canary", 0)).resolves.toBe("native-interrupt");
    await expect(agent.restartPaneExact("claw", 3, { expectedDraft: "owned" }))
      .resolves.toBe("tmux-restart");
    expect(tmuxAgent.restartPaneExact).toHaveBeenCalledWith("claw", 3, { expectedDraft: "owned" });
    await expect(agent.reconcileSession("skybar-canary")).resolves.toMatchObject({
      name: "skybar-canary", native: true, skipped: true, provisioned: 2,
    });
    await expect(agent.ensureReady("skybar-canary", 1)).resolves.toMatchObject({ agent: { id: "one" } });
    const nativeJob = { id: "native-job", metadata: { deliveryTransport: "native" } };
    await expect(agent.deliveryStatus(nativeJob)).resolves.toEqual({ state: "completed", code: 0 });
    expect(nativeRuntime.deliveryStatus).toHaveBeenCalledWith(nativeJob);
    await expect(agent.reconcileSession("claw")).resolves.toBe("tmux-reconcile");
    expect(tmuxAgent.reconcileSession).toHaveBeenCalledOnce();
    expect(tmuxAgent.ensureReady).not.toHaveBeenCalled();
  });
});
