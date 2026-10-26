import { expect, feature, unit } from "bdd-vitest";
import { restartGate } from "./restart-gate.mjs";

const NOW = Date.parse("2026-10-26T13:42:00Z");
const BRIDGE = 39295;
const deadWriter = { pane: "api:3", pid: 1827397, at: Date.parse("2026-10-25T20:07:30Z") };

function gate({ jobs = [], attempts = {}, alive = () => false } = {}) {
  const queue = { targets: () => [{ agentName: "api", pane: 3 }], list: () => jobs };
  const state = { get: (key, fallback) => (key === "context_maintenance_by_pane_v1" ? attempts : fallback) };
  return restartGate({ queue, state, bridgePid: BRIDGE, now: NOW, alive });
}
const attempt = ({ pid, at }) => ({ sessionId: "one", status: "ATTEMPTING", pid, at });

feature("the bridge restart gate", () => {
  unit("ignores a compact marker whose writer is gone (row 101)", {
    given: ["api:3's marker from 25 Oct, its pid no longer running", () => ({ "api:3": attempt(deadWriter) })],
    when: ["the gate checks an empty queue", attempts => gate({ attempts })],
    then: ["it allows the restart and lists no maintenance", result => expect(result).toEqual({ allowed: true, jobs: [], maintenance: [] })],
  });

  unit("still stops for a marker whose writer lives and is recent", {
    given: ["a compact started a minute ago by a running process", () => ({ "lsrc:2": attempt({ pid: 4242, at: NOW - 60_000 }) })],
    when: ["the gate checks", attempts => gate({ attempts, alive: pid => pid === 4242 })],
    then: ["it refuses and names the pane", result => {
      expect(result.allowed).toBe(false);
      expect(result.maintenance).toEqual([{ pane: "lsrc:2", pid: 4242, at: NOW - 60_000 }]);
    }],
  });

  unit("still stops for the bridge's own marker, however old", {
    given: ["a marker the bridge wrote three hours ago", () => ({ "api:0": attempt({ pid: BRIDGE, at: NOW - 3 * 3_600_000 }) })],
    when: ["the gate checks", attempts => gate({ attempts, alive: () => true })],
    then: ["it refuses", result => expect(result.maintenance.map(m => m.pane)).toEqual(["api:0"])],
  });

  unit("ignores a marker older than 40 minutes even when its pid lives, as the compact rule does", {
    given: ["a marker an hour old whose pid is still running", () => ({ "skyvw:4": attempt({ pid: 5151, at: NOW - 3_600_000 }) })],
    when: ["the gate checks", attempts => gate({ attempts, alive: () => true })],
    then: ["it allows, as compactWriterGone treats it as abandoned", result => expect(result.allowed).toBe(true)],
  });

  unit("stops for a pending or in-flight delivery and ignores a finished one", {
    given: ["three jobs: pending, delivering, acknowledged", () => [
      { id: "a", status: "pending" }, { id: "b", status: "delivering" }, { id: "c", status: "acknowledged" }]],
    when: ["the gate checks with no markers", jobs => gate({ jobs })],
    then: ["it refuses and lists the two open jobs", result => {
      expect(result.allowed).toBe(false);
      expect(result.jobs.map(job => job.id)).toEqual(["a", "b"]);
    }],
  });

  unit("fails loud without the bridge pid", {
    given: ["a call that forgot it", () => () => restartGate({ queue: { targets: () => [] }, state: { get: () => ({}) } })],
    when: ["it runs", call => call],
    then: ["it throws", call => expect(call).toThrow(/bridge pid/u)],
  });
});
