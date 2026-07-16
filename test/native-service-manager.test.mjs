import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeServiceStatus,
  startNativeService,
  stopNativeService,
} from "../cli/native-service-manager.mjs";

const live = [];

afterEach(async () => {
  while (live.length) await stopNativeService({ ...live.pop(), force: true }).catch(() => {});
});

describe("tmux-free native service manager", () => {
  it("starts one owned process group, replays start, and stops only that identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-service-"));
    const spec = {
      agentName: "ai",
      index: 0,
      command: "sleep 30",
      cwd: root,
      stateDir: join(root, "state"),
    };
    live.push(spec);
    const started = await startNativeService({ ...spec, startupMs: 50 });
    expect(started).toMatchObject({ started: true, managed: true, matchesConfig: true });
    const replay = await startNativeService({ ...spec, startupMs: 10 });
    expect(replay).toMatchObject({ alreadyRunning: true, managed: true });
    expect(replay.record.pid).toBe(started.record.pid);

    const mismatch = nativeServiceStatus({ ...spec, command: "sleep 31" });
    expect(mismatch).toMatchObject({ managed: true, matchesConfig: false });
    await expect(stopNativeService({ ...spec, command: "sleep 31" }))
      .rejects.toThrow("ownership does not match config");

    const stopped = await stopNativeService(spec);
    expect(stopped.stopped).toBe(true);
    expect(nativeServiceStatus(spec).managed).toBe(false);
    live.pop();
  });
});
