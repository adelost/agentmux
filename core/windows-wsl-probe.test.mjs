import { expect, feature, unit } from "bdd-vitest";
import { buildWslObservation } from "./windows-wsl-probe.mjs";

feature("Windows WSL observation", () => {
  unit("healthy status requires heartbeat liveness and exact release identity", {
    then: ["the observation projects boot, bridge, release, and memory truth", () => {
      const nowMs = Date.parse("2026-07-20T15:00:00Z");
      expect(buildWslObservation({
        bootId: "boot-1",
        heartbeat: {
          ts: new Date(nowMs - 1_000).toISOString(),
          pid: 42,
          version: "1.2.3",
          sourceSha: "a".repeat(40),
        },
        pidAlive: true,
        identity: {
          ok: true,
          packageVersion: "1.2.3",
          sourceSha: "a".repeat(40),
          issues: [],
        },
        memoryState: { level: "normal", observedAt: nowMs - 2_000 },
        memoryStale: false,
        nowMs,
      })).toMatchObject({
        schemaVersion: 1,
        wslReachable: true,
        bootId: "boot-1",
        bridge: { state: "ok" },
        release: { allowRevive: true, reason: "ok", sourceSha: "a".repeat(40) },
        memory: { level: "normal", stale: false },
      });
    }],
  });

  unit("a live pid never hides a stale heartbeat or invalid identity", {
    then: ["hung and release refusal remain visible", () => {
      const nowMs = Date.parse("2026-07-20T15:00:00Z");
      expect(buildWslObservation({
        bootId: "boot-2",
        heartbeat: {
          ts: new Date(nowMs - 10 * 60_000).toISOString(),
          pid: 42,
          version: "1.2.3",
          sourceSha: "a".repeat(40),
        },
        pidAlive: true,
        identity: {
          ok: false,
          packageVersion: "1.2.3",
          sourceSha: "a".repeat(40),
          issues: [{ code: "package-content", detail: "bytes differ" }],
        },
        memoryState: null,
        memoryStale: true,
        nowMs,
      })).toMatchObject({
        bridge: { state: "hung" },
        release: { allowRevive: false, reason: "package-content" },
        memory: { level: "unknown", stale: true },
      });
    }],
  });
});
