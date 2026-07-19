import { feature, component, expect } from "bdd-vitest";
import yaml from "js-yaml";
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
      expect(claw.layout).toBe("tiled");
      expect(config.agents.get("skybar").layout).toBe("tiled");
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

  component("parses claude + codex panes side by side", {
    given: ["yaml with both", () => `
guild: "1"
agents:
  ai:
    dir: /tmp/ai
    claude: 3
    codex: 2
`],
    when: ["parsing", (y) => parseConfig(y)],
    then: ["panes=5, claudeCount=3, codexCount=2", (config) => {
      const ai = config.agents.get("ai");
      expect(ai.panes).toBe(5);
      expect(ai.claudeCount).toBe(3);
      expect(ai.codexCount).toBe(2);
    }],
  });

  component("codex-only agent (no claude key) starts at index 0", {
    given: ["yaml with only codex", () => `
guild: "1"
agents:
  ai:
    dir: /tmp/ai
    codex: 2
`],
    when: ["parsing", (y) => parseConfig(y)],
    then: ["panes=2, claudeCount=0, codexCount=2", (config) => {
      const ai = config.agents.get("ai");
      expect(ai.panes).toBe(2);
      expect(ai.claudeCount).toBe(0);
      expect(ai.codexCount).toBe(2);
    }],
  });

  component("parses an isolated native runtime fleet", {
    given: ["native Claude + Codex config", () => `
guild: "1"
agents:
  skybar-canary:
    dir: /tmp/skybar-canary
    backend: native
    runtime: http://127.0.0.1:9911/
    claude: 1
    codex: 1
    claudeModel: claude-opus-4-8
    codexModel: gpt-5.6-sol
    effort: high
    nativeAgentIds:
      "1": 22222222-2222-4222-8222-222222222222
`],
    when: ["parsing", (source) => parseConfig(source).agents.get("skybar-canary")],
    then: ["native metadata is explicit and normalized", (agent) => {
      expect(agent).toMatchObject({
        backend: "native",
        runtimeUrl: "http://127.0.0.1:9911",
        panes: 2,
        claudeCount: 1,
        codexCount: 1,
        effort: "high",
        nativeAgentIds: { 1: "22222222-2222-4222-8222-222222222222" },
      });
    }],
  });

  component("rejects an empty native target before it can fall through to tmux", {
    given: ["native config with no engines", () => `
guild: "1"
agents:
  empty-native:
    dir: /tmp/empty-native
    backend: native
    claude: 0
    codex: 0
`],
    when: ["parsing", (source) => () => parseConfig(source)],
    then: ["the missing native pane is explicit", (parse) => {
      expect(parse).toThrow(/needs at least one Claude or Codex pane/);
    }],
  });

  component("native fleets keep managed services out of agent addresses", {
    given: ["a native agent with an externally supervised service", () => `
guild: "1"
agents:
  mixed:
    dir: /tmp/mixed
    backend: native
    claude: 1
    services: [npm run dev]
`],
    when: ["parsing and generating", (source) => {
      const parsed = parseConfig(source);
      return {
        parsed: parsed.agents.get("mixed"),
        generated: yaml.load(generateAgentsYaml(parsed.agents, new Map(), new Map())).mixed,
      };
    }],
    then: ["the command remains supervisor input but never becomes a fake native pane", ({ parsed, generated }) => {
      expect(parsed.services).toEqual(["npm run dev"]);
      expect(generated.panes).toEqual([expect.objectContaining({ cmd: "native:claude" })]);
    }],
  });

  component("native fleets reject interactive shell panes", {
    given: ["a native agent with an unsupported interactive shell", () => `
guild: "1"
agents:
  mixed:
    dir: /tmp/mixed
    backend: native
    claude: 1
    shells: 1
`],
    when: ["parsing", (source) => () => parseConfig(source)],
    then: ["fails clearly", (run) => expect(run).toThrow("cannot define tmux shell panes")],
  });

  component("preserves an explicit non-default layout", {
    given: ["an agent that explicitly requests main-vertical", () => `
guild: "1"
agents:
  ai:
    dir: /tmp/ai
    claude: 3
    codex: 4
    layout: main-vertical
`],
    when: ["parsing the source config", (source) => parseConfig(source).agents.get("ai")],
    then: ["the explicit layout wins over the tiled default", (agent) => {
      expect(agent.layout).toBe("main-vertical");
    }],
  });
});

feature("generateChannelNames", () => {
  component("single agent with 3 panes", {
    given: ["one agent", () => new Map([["skybar", { panes: 3 }]])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["returns 3 channels, 0-indexed", (channels) => {
      expect(channels).toEqual([
        { agentName: "skybar", channelName: "skybar-0", pane: 0, dialect: "claude" },
        { agentName: "skybar", channelName: "skybar-1", pane: 1, dialect: "claude" },
        { agentName: "skybar", channelName: "skybar-2", pane: 2, dialect: "claude" },
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

  component("codex panes get -codex suffix after claude panes", {
    given: ["agent with claude+codex split", () => new Map([
      ["ai", { panes: 5, claudeCount: 3, codexCount: 2 }],
    ])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["ai-0..2 are claude, ai-3-codex/ai-4-codex are codex", (channels) => {
      expect(channels.map((c) => c.channelName)).toEqual([
        "ai-0", "ai-1", "ai-2", "ai-3-codex", "ai-4-codex",
      ]);
      expect(channels.map((c) => c.dialect)).toEqual([
        "claude", "claude", "claude", "codex", "codex",
      ]);
    }],
  });

  component("Kimi panes follow Claude and Codex with a visible suffix", {
    given: ["agent with all three engines", () => new Map([
      ["lsrc", { panes: 4, claudeCount: 1, codexCount: 2, kimiCount: 1 }],
    ])],
    when: ["generating names", (agents) => generateChannelNames(agents)],
    then: ["Kimi gets pane 3 and a -kimi channel", (channels) => {
      expect(channels.map((c) => c.channelName)).toEqual([
        "lsrc-0", "lsrc-1-codex", "lsrc-2-codex", "lsrc-3-kimi",
      ]);
      expect(channels.at(-1).dialect).toBe("kimi");
    }],
  });
});

feature("classifyAgentChannel", () => {
  component("new format: agent-0 maps to pane 0", {
    given: ["channel ai-0 with agent ai", () => ({ ch: "ai-0", agents: ["ai"], existing: new Set(["ai-0"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["new format, pane 0", (r) => {
      expect(r).toEqual({ agentName: "ai", pane: 0, format: "new", dialect: "claude" });
    }],
  });

  component("legacy format: bare agent name = pane 0", {
    given: ["channel claw (bare)", () => ({ ch: "claw", agents: ["claw"], existing: new Set(["claw", "claw-2"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["legacy pane 0", (r) => {
      expect(r).toEqual({ agentName: "claw", pane: 0, format: "legacy", dialect: "claude" });
    }],
  });

  component("legacy format: agent-2 maps to pane 1 when bare exists", {
    given: ["channel claw-2 with legacy bare claw", () => ({ ch: "claw-2", agents: ["claw"], existing: new Set(["claw", "claw-2"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["legacy pane 1", (r) => {
      expect(r).toEqual({ agentName: "claw", pane: 1, format: "legacy", dialect: "claude" });
    }],
  });

  component("new format without legacy: agent-2 is pane 2", {
    given: ["channel ai-2 with no bare ai", () => ({ ch: "ai-2", agents: ["ai"], existing: new Set(["ai-0", "ai-1", "ai-2"]) })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["new pane 2", (r) => {
      expect(r).toEqual({ agentName: "ai", pane: 2, format: "new", dialect: "claude" });
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

  component("codex suffix maps to codex dialect", {
    given: ["channel ai-3-codex", () => ({
      ch: "ai-3-codex",
      agents: ["ai"],
      existing: new Set(["ai-0", "ai-3-codex"]),
    })],
    when: ["classifying", ({ ch, agents, existing }) => classifyAgentChannel(ch, agents, existing)],
    then: ["pane 3, dialect codex", (r) => {
      expect(r).toEqual({ agentName: "ai", pane: 3, format: "new", dialect: "codex" });
    }],
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
  component("carries search.roots from source yaml into generated agents.yaml", {
    given: ["a source with a search section and one agent", () => `
guild: "1"
search:
  roots:
    - name: memory
      path: ~/mem
      glob: "*.md"
      weight: 3
      semantic: true
agents:
  claw:
    dir: /tmp/claw
    panes: 1
`],
    when: ["regenerating agents.yaml (the amux label path)", (source) =>
      regenerateAgentsYaml(source, null)],
    then: ["the search section survives regeneration", (output) => {
      expect(output).toContain("search:");
      expect(output).toContain("path: ~/mem");
      expect(output).toContain("semantic: true");
    }],
  });

  component("a source without search regenerates cleanly with no search key", {
    given: ["a source with only agents", () => `
guild: "1"
agents:
  claw:
    dir: /tmp/claw
    panes: 1
`],
    when: ["regenerating agents.yaml", (source) => regenerateAgentsYaml(source, null)],
    then: ["no empty search stub is emitted", (output) => {
      expect(output).not.toContain("search:");
    }],
  });

  component("materializes native backend metadata without tmux commands", {
    given: ["parsed native fleet", () => {
      const source = `
guild: "1"
agents:
  skybar-canary:
    dir: /tmp/skybar-canary
    backend: native
    runtime: http://127.0.0.1:8811
    claude: 1
    codex: 1
    effort: high
    nativeAgentIds:
      "1": 22222222-2222-4222-8222-222222222222
`;
      return parseConfig(source).agents;
    }],
    when: ["generating agents.yaml", (agents) => generateAgentsYaml(
      agents,
      new Map(),
      new Map([["skybar-canary", "canary-id"]]),
    )],
    then: ["both panes use the native adapter", (output) => {
      expect(output).toContain("backend: native");
      expect(output).toContain("runtimeUrl: http://127.0.0.1:8811");
      expect(output).toContain("cmd: native:claude");
      expect(output).toContain("cmd: native:codex");
      expect(output).toContain("effort: high");
      expect(output).toContain("nativeAgentId: 22222222-2222-4222-8222-222222222222");
      expect(output).not.toContain("dangerously-skip-permissions");
      expect(output).not.toContain("--yolo");
    }],
  });

  component("all generated Codex panes use the shared yolo contract", {
    given: ["an agent with two Codex panes", () => ({
      agents: new Map([["claw", {
        dir: "/tmp/claw",
        panes: 3,
        claudeCount: 1,
        codexCount: 2,
        services: [],
        shells: 0,
        layout: "tiled",
      }]]),
      channelMap: new Map(),
      agentIds: new Map([["claw", "uuid"]]),
    })],
    when: ["generating the runtime config", ({ agents, channelMap, agentIds }) =>
      generateAgentsYaml(agents, channelMap, agentIds)],
    then: ["every Codex command is a fresh yolo launch, never resume --last", (yamlStr) => {
      expect(yamlStr.match(/cmd: codex --yolo/g)).toHaveLength(2);
      expect(yamlStr).not.toContain("resume --last");
      expect(yamlStr).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    }],
  });

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
      expect(yamlStr).toContain("claude --continue --dangerously-skip-permissions --model claude-opus-4-8");
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
