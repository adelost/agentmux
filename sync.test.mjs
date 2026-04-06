import { feature, component, expect } from "bdd-vitest";
import { parseAgentusConfig, generateChannelNames, buildSyncPlan, generateAgentsYaml, expandTilde } from "./sync.mjs";

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

feature("parseAgentusConfig", () => {
  component("parses minimal config", {
    given: ["minimal yaml", () => minimalYaml],
    when: ["parsing", (y) => parseAgentusConfig(y)],
    then: ["returns guild, category, and agent", (config) => {
      expect(config.guild).toBe("123456");
      expect(config.category).toBe("Agent Cave");
      expect(config.agents.size).toBe(1);
      const skybar = config.agents.get("skybar");
      expect(skybar.claude).toBe(3);
      expect(skybar.dir).toBe(`${process.env.HOME}/lsrc/skybar`);
    }],
  });

  component("parses full config with services and shells", {
    given: ["full yaml", () => fullYaml],
    when: ["parsing", (y) => parseAgentusConfig(y)],
    then: ["all agents parsed correctly", (config) => {
      expect(config.agents.size).toBe(3);
      const ai = config.agents.get("ai");
      expect(ai.claude).toBe(3);
      expect(ai.services).toEqual(["make ui", "make api"]);
      expect(ai.layout).toBe("main-vertical");
      const claw = config.agents.get("claw");
      expect(claw.shells).toBe(2);
      expect(claw.layout).toBe("main-vertical"); // auto: has shells
    }],
  });

  component("defaults claude to 1 when omitted", {
    given: ["yaml with no claude field", () => `guild: "1"\nagents:\n  test:\n    dir: /tmp\n`],
    when: ["parsing", (y) => parseAgentusConfig(y)],
    then: ["claude defaults to 1", (config) => {
      expect(config.agents.get("test").claude).toBe(1);
    }],
  });

  component("defaults category to 'Agents' when omitted", {
    given: ["yaml without category", () => `guild: "1"\nagents:\n  test:\n    dir: /tmp\n`],
    when: ["parsing", (y) => parseAgentusConfig(y)],
    then: ["category is Agents", (config) => expect(config.category).toBe("Agents")],
  });

  component("throws on missing guild", {
    given: ["yaml without guild", () => `agents:\n  test:\n    dir: /tmp\n`],
    when: ["parsing", (y) => () => parseAgentusConfig(y)],
    then: ["throws", (fn) => expect(fn).toThrow("guild")],
  });

  component("throws on missing dir", {
    given: ["yaml with agent missing dir", () => `guild: "1"\nagents:\n  test:\n    claude: 3\n`],
    when: ["parsing", (y) => () => parseAgentusConfig(y)],
    then: ["throws", (fn) => expect(fn).toThrow("dir")],
  });

  component("throws on missing agents section", {
    given: ["yaml without agents", () => `guild: "1"\n`],
    when: ["parsing", (y) => () => parseAgentusConfig(y)],
    then: ["throws", (fn) => expect(fn).toThrow("agents")],
  });
});

feature("generateChannelNames", () => {
  component("single agent with 3 claude panes", {
    given: ["one agent", () => new Map([["skybar", { claude: 3 }]])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["returns 3 channels with correct names", (channels) => {
      expect(channels).toEqual([
        { agentName: "skybar", channelName: "skybar", pane: 0 },
        { agentName: "skybar", channelName: "skybar-2", pane: 1 },
        { agentName: "skybar", channelName: "skybar-3", pane: 2 },
      ]);
    }],
  });

  component("single agent with 1 claude pane", {
    given: ["one agent", () => new Map([["api", { claude: 1 }]])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["returns 1 channel", (channels) => {
      expect(channels).toHaveLength(1);
      expect(channels[0].channelName).toBe("api");
    }],
  });

  component("multiple agents sorted alphabetically", {
    given: ["three agents", () => new Map([
      ["skybar", { claude: 2 }],
      ["ai", { claude: 1 }],
      ["claw", { claude: 1 }],
    ])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["sorted: ai, claw, skybar, skybar-2", (channels) => {
      expect(channels.map((c) => c.channelName)).toEqual(["ai", "claw", "skybar", "skybar-2"]);
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
        ["skybar", { dir: "/home/user/skybar", claude: 2, services: ["npm run dev"], shells: 0, layout: "main-vertical" }],
      ]);
      const channelMap = new Map([["skybar", "100"], ["skybar-2", "101"]]);
      const agentIds = new Map([["skybar", "uuid-1"]]);
      return { agents, channelMap, agentIds };
    }],
    when: ["generating yaml", ({ agents, channelMap, agentIds }) => generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["contains correct fields", (yamlStr) => {
      expect(yamlStr).toContain("# Auto-generated by Agentus");
      expect(yamlStr).toContain("dir: /home/user/skybar");
      expect(yamlStr).toContain("id: uuid-1");
      expect(yamlStr).toContain('"100": 0');
      expect(yamlStr).toContain('"101": 1');
      expect(yamlStr).toContain("claude --continue --dangerously-skip-permissions");
      expect(yamlStr).toContain("npm run dev");
    }],
  });

  component("first claude pane has no defer, rest have defer", {
    given: ["agent with 3 claude panes", () => {
      const agents = new Map([["test", { dir: "/tmp", claude: 3, services: [], shells: 0 }]]);
      return { agents, channelMap: new Map(), agentIds: new Map([["test", "uuid"]]) };
    }],
    when: ["generating yaml", ({ agents, channelMap, agentIds }) => generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["pane 0 no defer, pane 1+ defer", (yamlStr) => {
      // Parse back to verify structure
      const lines = yamlStr.split("\n");
      // First claude pane should NOT have defer
      const firstClaudeIdx = lines.findIndex((l) => l.includes("name: claude"));
      const secondClaudeIdx = lines.findIndex((l) => l.includes("name: claude-2"));
      // Check no defer between first and second
      const between = lines.slice(firstClaudeIdx, secondClaudeIdx).join("\n");
      expect(between).not.toContain("defer");
      // Check defer exists after second
      const afterSecond = lines.slice(secondClaudeIdx, secondClaudeIdx + 3).join("\n");
      expect(afterSecond).toContain("defer: true");
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
});
