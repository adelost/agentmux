import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverNativeRuntimes,
  formatNativeRuntimeStatuses,
  nativeRuntimeEnvironment,
  nativeRuntimeStatus,
  startNativeRuntime,
  stopNativeRuntime,
} from "../cli/native-runtime-service.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const availablePort = () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once("error", rejectPort);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

describe("native runtime detached lifecycle", () => {
  it("enumerates every managed runtime data directory and formats one truthful row each", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-discovery-"));
    const firstState = join(root, "web-runtime-8811");
    const secondState = join(root, "nested", "runtime");
    mkdirSync(firstState, { recursive: true });
    mkdirSync(secondState, { recursive: true });
    writeFileSync(join(firstState, "process.json"), JSON.stringify({
      pid: 11,
      port: 8811,
      serverPath: "/runtime/server.mjs",
      dataDir: "/data/web-ui",
    }));
    writeFileSync(join(secondState, "process.json"), JSON.stringify({
      pid: 13,
      port: 8813,
      serverPath: "/runtime/server.mjs",
      dataDir: "/data/code-pilot",
    }));
    const statusImpl = vi.fn(async ({ port, stateDir, dataDir }) => ({
      port,
      url: `http://127.0.0.1:${port}`,
      managed: true,
      online: true,
      pid: port === 8811 ? 11 : 13,
      health: {
        bootId: `boot-${port}`,
        projects: port === 8811 ? 1 : 4,
        agents: port === 8811 ? 3 : 15,
        running: 0,
      },
      paths: { root: stateDir, dataDir, logPath: join(stateDir, "runtime.log") },
    }));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));

    const statuses = await discoverNativeRuntimes({ stateRoot: root, statusImpl });
    expect(statusImpl).toHaveBeenCalledTimes(2);
    expect(statuses.map((status) => [status.port, status.paths.dataDir])).toEqual([
      [8811, "/data/web-ui"],
      [8813, "/data/code-pilot"],
    ]);
    expect(formatNativeRuntimeStatuses(statuses).split("\n")).toEqual([
      "Native runtimes: 2 managed",
      "✅ :8811 · pid 11 · boot boot-8811 · 1 project · 3 agents · 0 running · data /data/web-ui",
      "✅ :8813 · pid 13 · boot boot-8813 · 4 projects · 15 agents · 0 running · data /data/code-pilot",
    ]);
  });

  it("starts without tmux, reports health and stops only its managed process", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-service-"));
    const port = await availablePort();
    const options = {
      port,
      stateDir: join(root, "state"),
      dataDir: join(root, "data"),
      legacyDataDir: null,
    };
    const serverPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../spikes/web-ui/server.mjs",
    );
    cleanups.push(async () => {
      await stopNativeRuntime({ ...options, force: true }).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    });

    const started = await startNativeRuntime({ ...options, serverPath });
    expect(started).toMatchObject({ online: true, managed: true, started: true });
    expect(started.pid).toBeGreaterThan(0);
    const status = await nativeRuntimeStatus(options);
    expect(status.health).toMatchObject({ ok: true, projects: 0, agents: 0, running: 0 });
    const statusWithoutRepeatedDataDir = await nativeRuntimeStatus({
      port,
      stateDir: options.stateDir,
    });
    expect(statusWithoutRepeatedDataDir).toMatchObject({
      managed: true,
      paths: { dataDir: resolve(options.dataDir) },
    });

    const stopped = await stopNativeRuntime(options);
    expect(stopped.stopped).toBe(true);
    await expect(nativeRuntimeStatus(options)).resolves.toMatchObject({
      online: false,
      managed: false,
    });
  });

  it("makes legacy migration an explicit opt-out for isolated runtimes", () => {
    expect(nativeRuntimeEnvironment({
      port: 8812,
      dataDir: "/tmp/native-isolated",
      legacyDataDir: null,
      eventsPath: "/tmp/native-isolated/events.jsonl",
      baseEnv: { PATH: "/usr/bin" },
    })).toEqual({
      PATH: "/usr/bin",
      AMUX_WEB_PORT: "8812",
      AMUX_WEB_DATA_DIR: "/tmp/native-isolated",
      AMUX_EVENTS_PATH: "/tmp/native-isolated/events.jsonl",
      AMUX_WEB_LEGACY_DATA_DIR: "off",
    });
    expect(nativeRuntimeEnvironment({
      port: 8811,
      dataDir: "/tmp/native-upgrade",
      baseEnv: {},
    })).not.toHaveProperty("AMUX_WEB_LEGACY_DATA_DIR");
  });

  it("does not claim or signal a live process whose pid was reused", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-foreign-pid-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "process.json"), JSON.stringify({
      pid: process.pid,
      port: 65_534,
      serverPath: "/definitely/not/the/current/process.mjs",
    }));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));

    await expect(nativeRuntimeStatus({ port: 65_534, stateDir })).resolves.toMatchObject({
      managed: false,
      stalePid: true,
    });
    await expect(stopNativeRuntime({ port: 65_534, stateDir })).resolves.toMatchObject({
      alreadyStopped: true,
    });
  });

  it("re-verifies process identity immediately before SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-stop-race-"));
    const stateDir = join(root, "state");
    const pidPath = join(stateDir, "process.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(pidPath, JSON.stringify({
      pid: 42_424,
      port: 8_812,
      serverPath: "/runtime/server.mjs",
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const killImpl = vi.fn();

    await expect(stopNativeRuntime({
      port: 8_812,
      stateDir,
      statusImpl: async () => ({
        managed: true,
        online: true,
        pid: 42_424,
        health: { running: 0 },
        paths: { pidPath },
      }),
      processMatchesImpl: () => false,
      killImpl,
    })).rejects.toThrow(/ownership changed before SIGTERM/);
    expect(killImpl).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(true);
  });

  it("re-verifies process identity again before a forced SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-kill-race-"));
    const stateDir = join(root, "state");
    const pidPath = join(stateDir, "process.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(pidPath, JSON.stringify({
      pid: 43_434,
      port: 8_813,
      serverPath: "/runtime/server.mjs",
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const matches = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const killImpl = vi.fn();

    await expect(stopNativeRuntime({
      port: 8_813,
      stateDir,
      force: true,
      timeoutMs: 0,
      statusImpl: async () => ({
        managed: true,
        online: true,
        pid: 43_434,
        health: { running: 0 },
        paths: { pidPath },
      }),
      processMatchesImpl: matches,
      processAliveImpl: () => true,
      killImpl,
    })).rejects.toThrow(/ownership changed before SIGKILL/);
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(43_434, "SIGTERM");
    expect(existsSync(pidPath)).toBe(true);
  });
});
