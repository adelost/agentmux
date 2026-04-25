import { feature, component, expect } from "bdd-vitest";
import {
  parseConfig,
  generateChannelNames,
  buildSyncPlan,
  generateAgentsYaml,
  regenerateAgentsYaml,
  expandTilde,
  classifyAgentChannel,
  classifyExistingChannels,
  buildMigrationPlan,
} from "./sync.mjs";

// --- Helpers ---

const minimalYaml = `
guild: "123456"
category: "Agent Cave"
agents:
  skybar:
    dir: ~/lsrc/skybar
    claude: 3
`;

const fullYaml = `
guild: "123456"
category: "My Agents"
agents:
  ai:
    dir: ~/lsrc/ai-dsl
    claude: 3
    services:
      - make ui
      - make api
    layout: main-vertical
  claw:
    dir: ~/.openclaw/workspace
    claude: 3
    shells: 2
  skybar:
    dir: ~/lsrc/skybar
    claude: 2
    services:
      - npm run dev
`;

// --- Tests ---

feature("expandTilde", () => {
  component("expands ~ to HOME", {
    given: ["a path starting with ~", () => "~/lsrc/skybar"],
    when: ["expanding", (p) => expandTilde(p)],
    then: ["starts with HOME", (result) => {
      expect(result).toBe(`${process.env.HOME}/lsrc/skybar`);
    }],
  });

  component("leaves absolute paths unchanged", {
    given: ["an absolute path", () => "/home/user/project"],
    when: ["expanding", (p) => expandTilde(p)],
    then: ["unchanged", (result) => expect(result).toBe("/home/user/project")],
  });
});

feature("parseConfig", () => {
  component("parses minimal config", {
    given: ["minimal yaml", () => minimalYaml],
    when: ["parsing", (y) => parseConfig(y)],
    then: ["returns guild, category, and agent", (config) => {
      expect(config.guild).toBe("123456");
      expect(config.category).toBe("Agent Cave");
      expect(config.agents.size).toBe(1);
      const skybar = config.agents.get("skybar");
      expect(skybar.panes).toBe(3);
      expect(skybar.dir).toBe(`${process.env.HOME}/lsrc/skybar`);
    }],
  });

  component("parses full config with services and shells", {
    given: ["full yaml", () => fullYaml],
    when: ["parsing", (y) => parseConfig(y)],
    then: ["all agents parsed correctly", (config) => {
      expect(config.agents.size).toBe(3);
      const ai = config.agents.get("ai");
      expect(ai.panes).toBe(3);
      expect(ai.services).toEqual(["make ui", "make api"]);
      expect(ai.layout).toBe("main-vertical");
      const claw = config.agents.get("claw");
      expect(claw.shells).toBe(2);
      expect(claw.layout).toBe("main-vertical"); // auto: has shells
    }],
  });

  component("defaults agents to 1 when omitted", {
    given: ["yaml with no agents field", () => `guild: "1"\nagents:\n  test:\n    dir: /tmp\n`],
    when: ["parsing", (y) => parseConfig(y)],
    then: ["agents defaults to 1", (config) => {
      expect(config.agents.get("test").panes).toBe(1);
    }],
  });

  component("defaults category to 'Agents' when omitted", {
    given: ["yaml without category", () => `guild: "1"\nagents:\n  test:\n    dir: /tmp\n`],
    when: ["parsing", (y) => parseConfig(y)],
    then: ["category is Agents", (config) => expect(config.category).toBe("Agents")],
  });

  component("throws on missing guild", {
    given: ["yaml without guild", () => `agents:\n  test:\n    dir: /tmp\n`],
    when: ["parsing", (y) => () => parseConfig(y)],
    then: ["throws", (fn) => expect(fn).toThrow("guild")],
  });

  component("throws on missing dir", {
    given: ["yaml with agent missing dir", () => `guild: "1"\nagents:\n  test:\n    claude: 3\n`],
    when: ["parsing", (y) => () => parseConfig(y)],
    then: ["throws", (fn) => expect(fn).toThrow("dir")],
  });

  component("throws on missing agents section", {
    given: ["yaml without agents", () => `guild: "1"\n`],
    when: ["parsing", (y) => () => parseConfig(y)],
    then: ["throws", (fn) => expect(fn).toThrow("agents")],
  });
});

feature("generateChannelNames", () => {
  component("single agent with 3 panes", {
    given: ["one agent", () => new Map([["skybar", { panes: 3 }]])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["returns 3 channels, 0-indexed", (channels) => {
      expect(channels).toEqual([
        { agentName: "skybar", channelName: "skybar-0", pane: 0 },
        { agentName: "skybar", channelName: "skybar-1", pane: 1 },
        { agentName: "skybar", channelName: "skybar-2", pane: 2 },
      ]);
    }],
  });

  component("single agent with 1 pane", {
    given: ["one agent", () => new Map([["api", { panes: 1 }]])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["returns 1 channel with -0 suffix", (channels) => {
      expect(channels).toHaveLength(1);
      expect(channels[0].channelName).toBe("api-0");
    }],
  });

  component("multiple agents sorted alphabetically", {
    given: ["three agents", () => new Map([
      ["skybar", { panes: 2 }],
      ["ai", { panes: 1 }],
      ["claw", { panes: 1 }],
    ])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["sorted: ai-0, claw-0, skybar-0, skybar-1", (channels) => {
      expect(channels.map((c) => c.channelName)).toEqual(["ai-0", "claw-0", "skybar-0", "skybar-1"]);
    }],
  });
});

feature("classifyAgentChannel", () => {
  component("new format: agent-0 maps to pane 0", {
    given: ["channel ai-0 with agent ai", () => ({ ch: "ai-0", agents: ["ai"], existing: new Set(["ai-0"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["new format, pane 0", (r) => {
      expect(r).toEqual({ agentName: "ai", pane: 0, format: "new" });
    }],
  });

  component("legacy format: bare agent name = pane 0", {
    given: ["channel claw (bare)", () => ({ ch: "claw", agents: ["claw"], existing: new Set(["claw", "claw-2"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["legacy pane 0", (r) => {
      expect(r).toEqual({ agentName: "claw", pane: 0, format: "legacy" });
    }],
  });

  component("legacy format: agent-2 maps to pane 1 when bare exists", {
    given: ["channel claw-2 with legacy bare claw", () => ({ ch: "claw-2", agents: ["claw"], existing: new Set(["claw", "claw-2"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["legacy pane 1", (r) => {
      expect(r).toEqual({ agentName: "claw", pane: 1, format: "legacy" });
    }],
  });

  component("new format without legacy: agent-2 is pane 2", {
    given: ["channel ai-2 with no bare ai", () => ({ ch: "ai-2", agents: ["ai"], existing: new Set(["ai-0", "ai-1", "ai-2"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["new pane 2", (r) => {
      expect(r).toEqual({ agentName: "ai", pane: 2, format: "new" });
    }],
  });

  component("orphan channels return null", {
    given: ["channel with no agent match", () => ({ ch: "general", agents: ["ai", "claw"], existing: new Set(["general"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["returns null", (r) => expect(r).toBe(null)],
  });

  component("longest agent name wins on prefix collision", {
    given: ["channel api-proxy-0 with agents api and api-proxy", () => ({
      ch: "api-proxy-0",
      agents: ["api", "api-proxy"],
      existing: new Set(["api-proxy-0"]),
    })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["matches api-proxy", (r) => expect(r.agentName).toBe("api-proxy")],
  });
});

feature("classifyExistingChannels", () => {
  component("groups by agent, separates orphans", {
    given: ["mixed channels", () => ({
      existing: [
        { name: "ai-0", id: "1", parentId: null },
        { name: "ai-1", id: "2", parentId: null },
        { name: "general", id: "3", parentId: null },
      ],
      agents: ["ai", "claw"],
    })],
    when: ["classifying", ({ existing, agents }) => classifyExistingChannels(existing, agents)],
    then: ["ai grouped, general orphan", ({ byAgent, orphans }) => {
      expect(byAgent.get("ai")).toHaveLength(2);
      expect(byAgent.get("claw")).toBeUndefined();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].name).toBe("general");
    }],
  });
});

feature("buildMigrationPlan", () => {
  component("legacy channels produce rename actions", {
    given: ["legacy claw channels", () => ({
      agents: new Map([["claw", { panes: 3 }]]),
      existing: [
        { name: "claw", id: "A", parentId: "cat-old" },
        { name: "claw-2", id: "B", parentId: "cat-old" },
        { name: "claw-3", id: "C", parentId: "cat-old" },
      ],
    })],
    when: ["planning", ({ agents, existing }) => buildMigrationPlan(agents, existing)],
    then: ["3 renames, 0 creates", (plan) => {
      expect(plan.renames).toHaveLength(3);
      expect(plan.creates).toHaveLength(0);
      const renameMap = Object.fromEntries(plan.renames.map((r) => [r.from, r.to]));
      expect(renameMap).toEqual({ "claw": "claw-0", "claw-2": "claw-1", "claw-3": "claw-2" });
    }],
  });

  component("already-migrated channels produce keep actions", {
    given: ["new-format claw channels", () => ({
      agents: new Map([["claw", { panes: 2 }]]),
      existing: [
        { name: "claw-0", id: "A", parentId: "cat" },
        { name: "claw-1", id: "B", parentId: "cat" },
      ],
    })],
    when: ["planning", ({ agents, existing }) => buildMigrationPlan(agents, existing)],
    then: ["2 keep, 0 renames, 0 creates", (plan) => {
      expect(plan.renames).toHaveLength(0);
      expect(plan.keep).toHaveLength(2);
      expect(plan.creates).toHaveLength(0);
    }],
  });

  component("adds creates for missing panes", {
    given: ["1 existing, config wants 3", () => ({
      agents: new Map([["ai", { panes: 3 }]]),
      existing: [{ name: "ai-0", id: "A", parentId: null }],
    })],
    when: ["planning", ({ agents, existing }) => buildMigrationPlan(agents, existing)],
    then: ["ai-1 and ai-2 created", (plan) => {
      expect(plan.creates.map((c) => c.channelName).sort()).toEqual(["ai-1", "ai-2"]);
    }],
  });

  component("extra channels beyond configured panes are reported", {
    given: ["5 existing, config wants 2", () => ({
      agents: new Map([["ai", { panes: 2 }]]),
      existing: [
        { name: "ai-0", id: "A", parentId: null },
        { name: "ai-1", id: "B", parentId: null },
        { name: "ai-2", id: "C", parentId: null },
        { name: "ai-3", id: "D", parentId: null },
      ],
    })],
    when: ["planning", ({ agents, existing }) => buildMigrationPlan(agents, existing)],
    then: ["ai-2 and ai-3 are extras", (plan) => {
      expect(plan.keep).toHaveLength(2);
      expect(plan.extras).toHaveLength(2);
      expect(plan.extras.map((c) => c.name).sort()).toEqual(["ai-2", "ai-3"]);
    }],
  });
});

feature("buildSyncPlan", () => {
  const desired = [
    { agentName: "ai", channelName: "ai", pane: 0 },
    { agentName: "ai", channelName: "ai-2", pane: 1 },
    { agentName: "skybar", channelName: "skybar", pane: 0 },
  ];

  component("all channels new", {
    given: ["desired channels and empty existing", () => ({ desired, existing: [] })],
    when: ["building plan", ({ desired, existing }) => buildSyncPlan(desired, existing)],
    then: ["all in toCreate", (plan) => {
      expect(plan.toCreate).toHaveLength(3);
      expect(plan.existing).toHaveLength(0);
      expect(plan.orphaned).toHaveLength(0);
    }],
  });

  component("all channels already exist", {
    given: ["desired and matching existing", () => ({
      desired,
      existing: [
        { name: "ai", id: "100" },
        { name: "ai-2", id: "101" },
        { name: "skybar", id: "200" },
      ],
    })],
    when: ["building plan", ({ desired, existing }) => buildSyncPlan(desired, existing)],
    then: ["none to create, all existing", (plan) => {
      expect(plan.toCreate).toHaveLength(0);
      expect(plan.existing).toHaveLength(3);
      expect(plan.existing[0].id).toBe("100");
    }],
  });

  component("mix of new and existing", {
    given: ["desired with one existing", () => ({
      desired,
      existing: [{ name: "ai", id: "100" }],
    })],
    when: ["building plan", ({ desired, existing }) => buildSyncPlan(desired, existing)],
    then: ["1 existing, 2 to create", (plan) => {
      expect(plan.existing).toHaveLength(1);
      expect(plan.toCreate).toHaveLength(2);
    }],
  });

  component("orphaned channels detected", {
    given: ["desired and extra existing", () => ({
      desired: [{ agentName: "ai", channelName: "ai", pane: 0 }],
      existing: [
        { name: "ai", id: "100" },
        { name: "old-agent", id: "999" },
      ],
    })],
    when: ["building plan", ({ desired, existing }) => buildSyncPlan(desired, existing)],
    then: ["orphaned detected", (plan) => {
      expect(plan.orphaned).toHaveLength(1);
      expect(plan.orphaned[0].name).toBe("old-agent");
    }],
  });

  component("case-insensitive matching", {
    given: ["desired lowercase, existing mixed case", () => ({
      desired: [{ agentName: "ai", channelName: "ai", pane: 0 }],
      existing: [{ name: "AI", id: "100" }],
    })],
    when: ["building plan", ({ desired, existing }) => buildSyncPlan(desired, existing)],
    then: ["matched", (plan) => {
      expect(plan.existing).toHaveLength(1);
      expect(plan.toCreate).toHaveLength(0);
    }],
  });

  component("idempotent: second run creates nothing", {
    given: ["same desired and existing", () => {
      const all = [
        { name: "ai", id: "100" },
        { name: "ai-2", id: "101" },
        { name: "skybar", id: "200" },
      ];
      return { desired, existing: all };
    }],
    when: ["building plan twice", ({ desired, existing }) => buildSyncPlan(desired, existing)],
    then: ["nothing to create", (plan) => expect(plan.toCreate).toHaveLength(0)],
  });
});

feature("generateAgentsYaml", () => {
  component("generates correct structure", {
    given: ["agents with channels and IDs", () => {
      const agents = new Map([
        ["skybar", { dir: "/home/user/skybar", panes: 2, services: ["npm run dev"], shells: 0, layout: "main-vertical" }],
      ]);
      const channelMap = new Map([["skybar-0", "100"], ["skybar-1", "101"]]);
      const agentIds = new Map([["skybar", "uuid-1"]]);
      return { agents, channelMap, agentIds };
    }],
    when: ["generating yaml", ({ agents, channelMap, agentIds }) => generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["contains correct fields", (yamlStr) => {
      expect(yamlStr).toContain("# Auto-generated by agentmux");
      expect(yamlStr).toContain("dir: /home/user/skybar");
      expect(yamlStr).toContain("id: uuid-1");
      expect(yamlStr).toContain('"100": 0');
      expect(yamlStr).toContain('"101": 1');
      expect(yamlStr).toContain("claude --continue --dangerously-skip-permissions");
      expect(yamlStr).toContain("npm run dev");
    }],
  });

  component("all claude panes start immediately (no defer)", {
    given: ["agent with 3 claude panes", () => {
      const agents = new Map([["test", { dir: "/tmp", claude: 3, services: [], shells: 0 }]]);
      return { agents, channelMap: new Map(), agentIds: new Map([["test", "uuid"]]) };
    }],
    when: ["generating yaml", ({ agents, channelMap, agentIds }) => generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["no defer on any pane (session isolation makes it safe)", (yamlStr) => {
      expect(yamlStr).not.toContain("defer");
    }],
  });

  component("includes shells as bash panes", {
    given: ["agent with shells", () => {
      const agents = new Map([["test", { dir: "/tmp", claude: 1, services: [], shells: 2 }]]);
      return { agents, channelMap: new Map(), agentIds: new Map([["test", "uuid"]]) };
    }],
    when: ["generating yaml", ({ agents, channelMap, agentIds }) => generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["contains bash shell panes", (yamlStr) => {
      expect(yamlStr).toContain("name: shell-1");
      expect(yamlStr).toContain("name: shell-2");
      expect(yamlStr).toContain("cmd: bash");
    }],
  });

  component("agents sorted alphabetically", {
    given: ["multiple agents", () => {
      const agents = new Map([
        ["skybar", { dir: "/a", claude: 1, services: [], shells: 0 }],
        ["ai", { dir: "/b", claude: 1, services: [], shells: 0 }],
      ]);
      return { agents, channelMap: new Map(), agentIds: new Map([["skybar", "u1"], ["ai", "u2"]]) };
    }],
    when: ["generating yaml", ({ agents, channelMap, agentIds }) => generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["ai comes before skybar", (yamlStr) => {
      const aiPos = yamlStr.indexOf("ai:");
      const skybarPos = yamlStr.indexOf("skybar:");
      expect(aiPos).toBeLessThan(skybarPos);
    }],
  });

  component("preserves per-pane labels from existing yaml", {
    given: ["config + existing yaml with labels on some panes", () => {
      const agents = new Map([
        ["ai", { dir: "/tmp", panes: 2, services: ["npm dev"], shells: 1, layout: "main-vertical" }],
      ]);
      const channelMap = new Map();
      const agentIds = new Map([["ai", "uuid"]]);
      const existingYaml = {
        ai: {
          panes: [
            { name: "claude", cmd: "claude", label: "agentmux dev" },
            { name: "claude-2", cmd: "claude" },             // no label
            { name: "service-1", cmd: "npm dev", label: "dev server" },
            { name: "shell-1", cmd: "bash" },                 // no label
          ],
        },
      };
      return { agents, channelMap, agentIds, existingYaml };
    }],
    when: ["regenerating yaml", ({ agents, channelMap, agentIds, existingYaml }) =>
      generateAgentsYaml(agents, channelMap, agentIds, existingYaml)],
    then: ["labels survive at correct pane positions", (yamlStr) => {
      expect(yamlStr).toMatch(/label:\s*(?:"agentmux dev"|agentmux dev)/);
      expect(yamlStr).toMatch(/label:\s*(?:"dev server"|dev server)/);
      // Position matters: label should be attached to claude (pane 0),
      // not claude-2 (pane 1)
      const claudeIdx = yamlStr.indexOf("name: claude\n");
      const claude2Idx = yamlStr.indexOf("name: claude-2\n");
      const devLabelIdx = yamlStr.search(/label:\s*(?:"agentmux dev"|agentmux dev)/);
      expect(devLabelIdx).toBeGreaterThan(claudeIdx);
      expect(devLabelIdx).toBeLessThan(claude2Idx);
    }],
  });

  component("no existingYaml = no label fields (backward-compat)", {
    given: ["config but no prior yaml", () => ({
      agents: new Map([["ai", { dir: "/tmp", panes: 1, services: [], shells: 0 }]]),
      channelMap: new Map(),
      agentIds: new Map([["ai", "uuid"]]),
    })],
    when: ["generating without existingYaml", ({ agents, channelMap, agentIds }) =>
      generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["output has no label field", (yamlStr) => {
      expect(yamlStr).not.toContain("label:");
    }],
  });

  component("source labels (config.labels) override existingYaml labels", {
    given: ["source says 'from source', existing says 'from old'", () => {
      const agents = new Map([
        ["ai", { dir: "/tmp", panes: 1, services: [], shells: 0, labels: { 0: "from source" } }],
      ]);
      const existingYaml = {
        ai: { panes: [{ name: "claude", cmd: "claude", label: "from old" }] },
      };
      return { agents, channelMap: new Map(), agentIds: new Map([["ai", "uuid"]]), existingYaml };
    }],
    when: ["regenerating", ({ agents, channelMap, agentIds, existingYaml }) =>
      generateAgentsYaml(agents, channelMap, agentIds, existingYaml)],
    then: ["source wins", (yamlStr) => {
      expect(yamlStr).toContain("from source");
      expect(yamlStr).not.toContain("from old");
    }],
  });
});

feature("parseConfig: labels", () => {
  component("reads per-pane labels from source yaml", {
    given: ["source with labels", () => `
guild: "12345"
agents:
  claw:
    dir: /tmp/claw
    panes: 3
    labels:
      0: "tandem-tagger deploy"
      2: "agentmux dev"
`],
    when: ["parsing", (src) => parseConfig(src)],
    then: ["labels parsed by pane index", (result) => {
      const claw = result.agents.get("claw");
      expect(claw.labels).toEqual({ 0: "tandem-tagger deploy", 2: "agentmux dev" });
    }],
  });

  component("missing labels section = null (signals legacy fallback OK)", {
    given: ["source without labels", () => `
guild: "12345"
agents:
  claw:
    dir: /tmp/claw
    panes: 1
`],
    when: ["parsing", (src) => parseConfig(src)],
    then: ["labels is null (distinct from empty {} which is authoritative)", (result) => {
      expect(result.agents.get("claw").labels).toBeNull();
    }],
  });

  component("empty labels block = authoritative empty {}", {
    given: ["source with empty labels", () => `
guild: "12345"
agents:
  claw:
    dir: /tmp/claw
    panes: 1
    labels: {}
`],
    when: ["parsing", (src) => parseConfig(src)],
    then: ["labels is {} (not null)", (result) => {
      expect(result.agents.get("claw").labels).toEqual({});
    }],
  });

  component("empty-string label value is dropped (noise filter)", {
    given: ["source with empty label", () => `
guild: "12345"
agents:
  claw:
    dir: /tmp
    panes: 2
    labels:
      0: ""
      1: "real label"
`],
    when: ["parsing", (src) => parseConfig(src)],
    then: ["only non-empty labels kept", (result) => {
      expect(result.agents.get("claw").labels).toEqual({ 1: "real label" });
    }],
  });
});

feature("regenerateAgentsYaml", () => {
  component("writes source labels into agents.yaml without needing Discord", {
    given: ["source yaml + existing agents.yaml with channel mappings", () => {
      const sourceYaml = `
guild: "12345"
agents:
  claw:
    dir: /tmp/claw
    panes: 2
    labels:
      0: "main dev"
`;
      const existingYaml = `
claw:
  dir: /tmp/claw
  id: claw-uuid
  discord:
    "channel-a": 0
    "channel-b": 1
  panes:
    - name: claude
      cmd: claude
      label: old-label
    - name: claude-2
      cmd: claude
`;
      return { sourceYaml, existingYaml };
    }],
    when: ["regenerating", ({ sourceYaml, existingYaml }) =>
      regenerateAgentsYaml(sourceYaml, existingYaml)],
    then: ["source label wins, channel-IDs carried over", (out) => {
      expect(out).toContain("main dev");
      expect(out).not.toContain("old-label");
      expect(out).toMatch(/channel-a["']?\s*:\s*0/);
      expect(out).toContain("claw-uuid");
    }],
  });

  component("first-run (no existing agents.yaml) works", {
    given: ["source yaml only", () => `
guild: "12345"
agents:
  claw:
    dir: /tmp/claw
    panes: 1
    labels:
      0: "fresh"
`],
    when: ["regenerating without existing", (sourceYaml) =>
      regenerateAgentsYaml(sourceYaml, null)],
    then: ["label lands in output", (out) => {
      expect(out).toContain("fresh");
    }],
  });
});
