// The fleet's own list reaches the Link worker (row 184). What the voice PWA
// offers and what the connector announces come from one function, and the poll
// carries it when it changed, so TALK TO stops being three ids in a Cloudflare
// variable without turning every poll into sixty-five D1 writes.

import { expect, feature, unit, component } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { phoneTargets } from "./audio-targets.mjs";
import { announcedLinkTargets } from "./link-connector-start.mjs";
import { runLinkConnectorCycle } from "./link-connector.mjs";

const AGENTS = {
  lsrc: {
    dir: "/tmp/lsrc",
    discord: { "1502949109491961917": 3, "1528238682744557598": 10 },
    panes: Array.from({ length: 11 }, (_, index) => ({ label: index === 3 ? "L-source 3" : null })),
  },
  skyvw: {
    dir: "/tmp/skyvw",
    discord: { "1490784814641451159": 0, "1490784816012984502": 1, "1490784817305096202": 2 },
    panes: [{ label: "Skyvw orchestrator" }, { label: null }, { label: "Skydive worker two" }],
  },
};

const DISCOVERY = {
  target: "1502949109491961917",
  targets: ["1528238682744557598"],
};

feature("the phone's target list is the fleet's", () => {
  unit("every pane with a Discord channel becomes a target, labelled from agents.yaml", {
    then: ["ids are agent:pane, labels are the pane's own, the primary is the favourite", () => {
      const targets = phoneTargets(DISCOVERY, AGENTS);
      expect(targets.map((target) => target.id))
        .toEqual(["lsrc:3", "lsrc:10", "skyvw:0", "skyvw:1", "skyvw:2"]);
      expect(targets.find((target) => target.id === "skyvw:2").label).toBe("Skydive worker two");
      // A pane without a label still gets an honest address, never a blank row.
      expect(targets.find((target) => target.id === "skyvw:1").label).toBe("skyvw:1");
      expect(targets.filter((target) => target.favorite).map((target) => target.id)).toEqual(["lsrc:3"]);
    }],
  });

  unit("the configured ids are the floor, the fleet is the rest", {
    given: ["a temporary agents.yaml", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-link-announce-"));
      const agentsYamlPath = join(root, "agents.yaml");
      writeFileSync(agentsYamlPath, JSON.stringify(AGENTS), "utf-8");
      return { root, agentsYamlPath };
    }],
    then: ["seeded ids stay and gain labels, mapped panes join, a missing file keeps the seed", ({ root, agentsYamlPath }) => {
      const announced = announcedLinkTargets({
        seed: ["lsrc:3", "windows"], agentsYamlPath, audioDiscovery: DISCOVERY,
      });
      expect(announced.map((target) => target.id))
        .toEqual(["lsrc:3", "windows", "lsrc:10", "skyvw:0", "skyvw:1", "skyvw:2"]);
      expect(announced.find((target) => target.id === "lsrc:3").label).toBe("L-source 3");
      expect(announcedLinkTargets({
        seed: ["lsrc:3"], agentsYamlPath: join(root, "gone.yaml"), audioDiscovery: DISCOVERY,
      })).toEqual([{ id: "lsrc:3", label: "lsrc:3" }]);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  component("the poll announces the list when it changed, and hourly", {
    given: ["a connector whose targets are read fresh each cycle", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-link-poll-"));
      const statePath = join(root, "connector.json");
      const posts = [];
      let listed = [{ id: "lsrc:3", label: "L-source 3" }];
      return {
        root,
        posts,
        relabel: () => { listed = [{ id: "lsrc:3", label: "L-source 3" }, { id: "skyvw:2", label: "Skydive worker two" }]; },
        // Move the journal's announce stamp back, the way an hour of polling does.
        age: (ms) => {
          const journal = JSON.parse(readFileSync(statePath, "utf8"));
          journal.announce.atMs -= ms;
          writeFileSync(statePath, JSON.stringify(journal), "utf8");
        },
        deps: {
          fetchImpl: async (url, init) => {
            posts.push({ url, body: JSON.parse(init.body || "{}") });
            return { ok: true, json: async () => ({ messages: [] }) };
          },
          linkBase: "https://link.v1d.io",
          token: "wsl-token",
          targets: () => listed,
          agent: { hasResponseForPrompt: () => false },
          deliveryBroker: { enqueue: () => ({ id: "job-1" }) },
          statePath,
          sleep: async () => {},
        },
      };
    }],
    when: ["four cycles run: first, unchanged, changed, then an hour later", async (harness) => {
      await runLinkConnectorCycle(harness.deps);
      await runLinkConnectorCycle(harness.deps);
      harness.relabel();
      await runLinkConnectorCycle(harness.deps);
      harness.age(61 * 60_000);
      await runLinkConnectorCycle(harness.deps);
      rmSync(harness.root, { recursive: true, force: true });
      return harness.posts;
    }],
    then: ["the list is sent when it changed and once an hour, never every poll", (posts) => {
      expect(posts).toHaveLength(4);
      expect(posts[0].url).toContain("/api/link/connector/poll");
      expect(posts[0].body.targets).toEqual([{ id: "lsrc:3", label: "L-source 3" }]);
      // Unchanged list: the poll carries no targets at all.
      expect(posts[1].body.targets).toBeUndefined();
      expect(posts[2].body.targets).toEqual([
        { id: "lsrc:3", label: "L-source 3" },
        { id: "skyvw:2", label: "Skydive worker two" },
      ]);
      // An hour on, the same list is re-announced so the worker's window holds.
      expect(posts[3].body.targets).toEqual(posts[2].body.targets);
    }],
  });

  component("a model-only change is announced without waiting an hour", {
    given: ["one target whose model projection changes", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-link-model-poll-"));
      const statePath = join(root, "connector.json");
      const posts = [];
      let status = "current";
      return {
        root,
        posts,
        stale: () => { status = "stale"; },
        deps: {
          fetchImpl: async (url, init) => {
            posts.push(JSON.parse(init.body || "{}"));
            return { ok: true, json: async () => ({ messages: [] }) };
          },
          linkBase: "https://link.v1d.io",
          token: "wsl-token",
          targets: () => [{
            id: "lsrc:3",
            label: "L-source 3",
            model: { status, observed: { model: "gpt-5.6-sol", effort: "xhigh" }, configured: null },
          }],
          agent: { hasResponseForPrompt: () => false },
          deliveryBroker: { enqueue: () => ({ id: "job-1" }) },
          statePath,
          sleep: async () => {},
        },
      };
    }],
    when: ["two cycles straddle the session qualification change", async (harness) => {
      await runLinkConnectorCycle(harness.deps);
      harness.stale();
      await runLinkConnectorCycle(harness.deps);
      rmSync(harness.root, { recursive: true, force: true });
      return harness.posts;
    }],
    then: ["both cycles carry their distinct model truth", (posts) => {
      expect(posts[0].targets[0].model.status).toBe("current");
      expect(posts[1].targets[0].model.status).toBe("stale");
    }],
  });
});
