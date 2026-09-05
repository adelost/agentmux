import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, parseFlags } from "../cli/commands.mjs";
import { isDispatchHelp } from "../cli/command-args.mjs";

const effects = vi.hoisted(() => ({
  serve: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), revive: vi.fn(), sleep: vi.fn(),
  startRuntime: vi.fn(), stopRuntime: vi.fn(), startServices: vi.fn(), stopServices: vi.fn(),
  send: vi.fn(), spawn: vi.fn(), exec: vi.fn(),
}));
vi.mock("../cli/bridge.mjs", () => ({ createBridgeLifecycle: () => effects }));
vi.mock("../cli/stop-all.mjs", () => ({ runStopAll: effects.stopAll }));
vi.mock("../cli/revive.mjs", () => ({ cmdRevive: effects.revive }));
vi.mock("../cli/sleep.mjs", () => ({ cmdSleep: effects.sleep, cmdWake: effects.sleep, cmdSleepWatch: effects.sleep }));
vi.mock("../cli/native-runtime-service.mjs", async (original) => ({
  ...await original(), startNativeRuntime: effects.startRuntime, stopNativeRuntime: effects.stopRuntime,
}));
vi.mock("../cli/native-service-manager.mjs", async (original) => ({
  ...await original(), startNativeServices: effects.startServices, stopNativeServices: effects.stopServices,
}));
vi.mock("../cli/tmux.mjs", async (original) => ({ ...await original(), sendToPane: effects.send }));
vi.mock("child_process", async (original) => ({ ...await original(), spawn: effects.spawn, execSync: effects.exec }));

describe("help precedes lifecycle effects", () => {
  let root, ctx, kill, output;
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "amux-help-"));
    ctx = { configPath: join(root, "agents.yaml"), sourceConfigPath: join(root, "agentmux.yaml"),
      lastFile: join(root, "last"), bridgeDir: root };
    writeFileSync(ctx.configPath, "claw:\n  dir: /tmp/fake-claw\n  panes: []\n");
    writeFileSync(ctx.sourceConfigPath, "agents: {}\n");
    writeFileSync(join(root, "bridge.pid"), "4242\n");
    vi.stubEnv("PIDFILE", join(root, "bridge.pid"));
    vi.stubEnv("AMUX_FLEET_RESTART_REQUEST", join(root, "restart.json"));
    vi.stubEnv("TMUX", "");
    kill = vi.spyOn(process, "kill").mockReturnValue(true);
    output = vi.spyOn(console, "log").mockImplementation(() => {});
    effects.send.mockResolvedValue({ delivered: true });
    effects.startRuntime.mockResolvedValue({ url: "http://fake.invalid", pid: 4242 });
    effects.stopRuntime.mockResolvedValue({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const commands = [
    ["restart", "--all"], ["reload"], ["sync"], ["sync", "--offline"],
    ["stop"], ["stop", "--all"], ["stop", "claw"], ["serve", "--detach"],
    ["runtime", "start"], ["runtime", "stop", "--force"], ["runtime", "restart"],
    ["services", "start"], ["services", "stop"], ["add", "new", "/tmp/fake"],
    ["rm", "claw"], ["reconcile", "claw"], ["revive", "--all"],
    ["sleep", "claw"], ["wake", "claw"], ["sleep-watch", "--apply"], ["cutover", "--apply"],
  ];
  for (const args of commands) for (const help of ["--help", "-h"]) {
    it(`${args.join(" ")} ${help} prints help without signal/process/config effects`, async () => {
      const before = [ctx.configPath, ctx.sourceConfigPath].map((path) => readFileSync(path, "utf8"));
      await dispatch([...args, help], ctx);
      expect(output.mock.calls.flat().join("\n")).toContain("Usage:");
      expect(kill).not.toHaveBeenCalled();
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
      expect([ctx.configPath, ctx.sourceConfigPath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
      expect(existsSync(join(root, "restart.json"))).toBe(false);
      expect(existsSync(ctx.lastFile)).toBe(false);
    });
  }

  it("still routes an actual runtime restart through stop then start (fakes only)", async () => {
    await dispatch(["runtime", "restart", "--port", "9911"], ctx);
    expect(effects.stopRuntime).toHaveBeenCalledWith(expect.objectContaining({ port: 9911 }));
    expect(effects.startRuntime).toHaveBeenCalledWith(expect.objectContaining({ port: 9911 }));
    expect(effects.stopRuntime.mock.invocationCallOrder[0]).toBeLessThan(effects.startRuntime.mock.invocationCallOrder[0]);
  });

  it("does not treat help after -- as a request for help", async () => {
    await dispatch(["restart", "--", "--help"], ctx);
    expect(kill).toHaveBeenCalledWith(4242, "SIGUSR2");
    expect(output.mock.calls.flat().join("\n")).not.toContain("Usage:");
    expect(parseFlags(["-p", "2", "--", "--help", "-p", "9"], { p: "number" }))
      .toEqual({ flags: { p: 2 }, positional: ["--help", "-p", "9"] });
  });

  it.each([
    [["-p", "2", "Explain --help and -h"], "Explain --help and -h"],
    [["-p", "2", "--", "--help", "-h", "--force"], "--help -h --force"],
  ])("delivers agent text literally: %j", async (args, prompt) => {
    await dispatch(["claw", ...args], ctx);
    expect(effects.send).toHaveBeenCalledWith(ctx, "claw", 2, prompt, expect.objectContaining({ force: false }));
    expect(output.mock.calls.flat().join("\n")).not.toContain("Usage:");
  });

  it("still rejects typo flags before -- and leaves command-specific help alone", async () => {
    await expect(dispatch(["claw", "--typo", "--", "--help"], ctx)).rejects.toThrow("unknown option --typo");
    expect(effects.send).not.toHaveBeenCalled();
    expect(isDispatchHelp(["dream", "--help"])).toBe(false);
    expect(isDispatchHelp(["runtime", "--help", "restart"])).toBe(true);
    expect(isDispatchHelp(["claw", "--help"])).toBe(false);
  });
});
