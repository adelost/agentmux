import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  it("starts without tmux, reports health and stops only its managed process", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-service-"));
    const port = await availablePort();
    const options = {
      port,
      stateDir: join(root, "state"),
      dataDir: join(root, "data"),
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

    const stopped = await stopNativeRuntime(options);
    expect(stopped.stopped).toBe(true);
    await expect(nativeRuntimeStatus(options)).resolves.toMatchObject({
      online: false,
      managed: false,
    });
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
});
