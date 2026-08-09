import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  blockingAndroidHostWork,
  ensureAndroidEmulator,
  headlessEmulatorEnv,
  headlessEmulatorsFromRows,
  parseGuestIdle,
  parseProcessRows,
  readAndroidEmulatorState,
  sweepAndroidEmulators,
} from "./android-emulator-lifecycle.mjs";

const PROCESS_TEXT = `
1810791 70000 /sdk/qemu-system-x86_64-headless -avd wear34 -no-window -port 5554
2141289 65000 /sdk/qemu-system-x86_64-headless -avd pixel35 -port 5556 -no-window
105014 88000 adb -L tcp:5037 fork-server server --reply-fd 4
`;

describe("Android emulator idle lifecycle", () => {
  it("discovers only headless AVDs and derives their stable serials", () => {
    const rows = parseProcessRows(`${PROCESS_TEXT}99 2 /sdk/emulator -avd visible -port 5558\n`);
    expect(headlessEmulatorsFromRows(rows).map(({ avd, serial }) => ({ avd, serial }))).toEqual([
      { avd: "wear34", serial: "emulator-5554" },
      { avd: "pixel35", serial: "emulator-5556" },
    ]);
  });

  it("starts a headless emulator with no display to connect to", () => {
    // A dead WSLg X server leaves its socket in /tmp/.X11-unix, so -no-window
    // still connects to DISPLAY and blocks with nothing to time it out: the
    // process lives, never opens its ports, and the log just stops. Removing
    // the handle is what makes headless actually headless.
    const env = headlessEmulatorEnv({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      PATH: "/usr/bin",
      ANDROID_SDK_ROOT: "/sdk",
    });
    expect(env).toEqual({ PATH: "/usr/bin", ANDROID_SDK_ROOT: "/sdk" });
  });

  it("does not mutate the caller's environment while stripping the display", () => {
    const caller = { DISPLAY: ":0", PATH: "/usr/bin" };
    headlessEmulatorEnv(caller);
    expect(caller.DISPLAY).toBe(":0");
  });

  it("uses guest uptime minus Android's last user activity, not host process age", () => {
    expect(parseGuestIdle(
      "mLastUserActivityTime(excludingAttention)=68182270\nlastUserActivityTime=65181358",
      "69797.99 249214.37",
    )).toEqual({ uptimeMs: 69_797_990, lastUserActivityMs: 68_182_270, idleMs: 1_615_720 });
  });

  it("distinguishes active clients from idle adb and Gradle daemons", () => {
    const rows = parseProcessRows(`${PROCESS_TEXT}
12 50 java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.11.1
13 4 java org.gradle.wrapper.GradleWrapperMain connectedDebugAndroidTest
14 1 adb -s emulator-5554 shell input tap 1 1
`);
    expect(blockingAndroidHostWork(rows).map((row) => row.pid)).toEqual([13, 14]);
  });

  it("arms on one stale observation and only stops gracefully after the second", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-emulator-guard-"));
    const statePath = join(root, "state.json");
    const rows = parseProcessRows(PROCESS_TEXT).slice(0, 1);
    const readIdle = () => ({ uptimeMs: 10_000_000, lastUserActivityMs: 1_000_000, idleMs: 9_000_000 });
    const stop = vi.fn(async () => ({ stopped: true }));
    try {
      const first = await sweepAndroidEmulators({ now: 100_000, idleMs: 60_000, confirmMs: 5_000, statePath, rows, readIdle, stop });
      expect(first.results[0].action).toBe("arm");
      expect(stop).not.toHaveBeenCalled();
      const second = await sweepAndroidEmulators({ now: 106_000, idleMs: 60_000, confirmMs: 5_000, statePath, rows, readIdle, stop });
      expect(second.results[0].action).toBe("stopped");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(readAndroidEmulatorState(statePath).emulators.wear34.status).toBe("asleep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can scope a manual sweep to one named AVD", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-emulator-scope-"));
    try {
      const result = await sweepAndroidEmulators({
        now: 100_000,
        idleMs: 60_000,
        onlyAvd: "pixel35",
        statePath: join(root, "state.json"),
        rows: parseProcessRows(PROCESS_TEXT),
        readIdle: () => ({ uptimeMs: 10_000_000, lastUserActivityMs: 1_000_000, idleMs: 9_000_000 }),
      });
      expect(result.results.map((item) => item.avd)).toEqual(["pixel35"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on observation errors and active Android build work", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-emulator-blocked-"));
    const statePath = join(root, "state.json");
    const stop = vi.fn(async () => ({ stopped: true }));
    try {
      const broken = await sweepAndroidEmulators({
        now: 100_000,
        idleMs: 1,
        statePath,
        rows: parseProcessRows(PROCESS_TEXT).slice(0, 1),
        readIdle: () => { throw new Error("offline"); },
        stop,
      });
      expect(broken.results[0]).toMatchObject({ action: "blocked", reason: "observation-failed:offline" });
      const busyRows = parseProcessRows(`${PROCESS_TEXT}77 2 java org.gradle.wrapper.GradleWrapperMain test\n`).slice(0, 4);
      const busy = await sweepAndroidEmulators({
        now: 200_000,
        idleMs: 1,
        statePath,
        rows: busyRows,
        readIdle: () => ({ idleMs: 10_000, uptimeMs: 20_000, lastUserActivityMs: 10_000 }),
        stop,
      });
      expect(busy.results.every((result) => result.reason === "android-host-work-active")).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands the spawned emulator an environment with no display handle", async () => {
    // The wiring, not the helper: a passing headlessEmulatorEnv() unit test
    // proves nothing if the spawn call stops passing it. Deleting `env:` from
    // the spawn options must fail here.
    const root = mkdtempSync(join(tmpdir(), "amux-emulator-display-"));
    const statePath = join(root, "state.json");
    writeFileSync(statePath, `${JSON.stringify({ version: 1, emulators: {} })}\n`);
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: () => {} }));
    const original = process.env.DISPLAY;
    process.env.DISPLAY = ":0";
    try {
      await ensureAndroidEmulator("wear34", {
        statePath,
        port: 5554,
        waitForBoot: false,
        logPath: join(root, "emulator.log"),
        tools: { emulator: process.execPath, adb: "/bin/true" },
        readRows: () => [],
        exec: () => "wear34\n",
        spawnProcess,
      });
      const options = spawnProcess.mock.calls[0]?.[2];
      expect(options?.env, "spawn must receive an explicit env").toBeDefined();
      expect("DISPLAY" in options.env).toBe(false);
      expect("WAYLAND_DISPLAY" in options.env).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses the exact AVD and records a wake lease without spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-emulator-ensure-"));
    const statePath = join(root, "state.json");
    writeFileSync(statePath, `${JSON.stringify({ version: 1, emulators: { wear34: { avd: "wear34", port: 5554 } } })}\n`);
    const spawnProcess = vi.fn();
    try {
      const result = await ensureAndroidEmulator("wear34", {
        statePath,
        now: 42_000,
        readRows: () => parseProcessRows(PROCESS_TEXT).slice(0, 1),
        spawnProcess,
      });
      expect(result).toMatchObject({ reused: true, serial: "emulator-5554", pid: 1810791 });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(statePath, "utf8")).emulators.wear34).toMatchObject({
        port: 5554,
        pid: 1810791,
        lastUseAt: 42_000,
        status: "awake",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
