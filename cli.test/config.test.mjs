import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ensureConfig, loadConfig, saveConfig, getAgent, listAgents,
  addAgent, removeAgent, resolveAgent, saveLast, getLast,
} from "../cli/config.mjs";

let root;
const setup = () => {
  root = mkdtempSync(join(tmpdir(), "agentmux-config-test-"));
  return join(root, "agents.yaml");
};
const cleanup = () => rmSync(root, { recursive: true, force: true });

const SAMPLE_YAML = `
ai:
  dir: /home/user/ai
  id: uuid-ai
  panes:
    - name: claude
      cmd: claude --continue
claw:
  dir: /home/user/claw
  id: uuid-claw
  panes:
    - name: claude
      cmd: claude --continue
    - name: claude-2
      cmd: claude
      defer: true
`;

feature("ensureConfig", () => {
  component("creates config file if missing", {
    given: ["a non-existent path", setup],
    when: ["ensuring config", (path) => { ensureConfig(path); return path; }],
    then: ["file exists", (path) => {
      expect(existsSync(path)).toBe(true);
      cleanup();
    }],
  });
});

feature("loadConfig", () => {
  component("parses yaml into object", {
    given: ["a config file", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["loading", (path) => loadConfig(path)],
    then: ["returns agents", (config) => {
      expect(config.ai.dir).toBe("/home/user/ai");
      expect(config.claw.panes).toHaveLength(2);
      cleanup();
    }],
  });

  component("returns empty object for missing file", {
    given: ["a non-existent path", () => "/tmp/nonexistent-agentmux-test.yaml"],
    when: ["loading", (path) => loadConfig(path)],
    then: ["returns {}", (config) => expect(config).toEqual({})],
  });
});

feature("getAgent", () => {
  component("returns agent config", {
    given: ["a config with agents", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["getting ai", (path) => getAgent(path, "ai")],
    then: ["returns agent with name and dir", (agent) => {
      expect(agent.name).toBe("ai");
      expect(agent.dir).toBe("/home/user/ai");
      cleanup();
    }],
  });

  component("throws for missing agent", {
    given: ["a config without target", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["getting nonexistent", (path) => () => getAgent(path, "nope")],
    then: ["throws", (fn) => expect(fn).toThrow("not found")],
  });
});

feature("listAgents", () => {
  component("returns sorted agents", {
    given: ["a config with agents", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["listing", (path) => listAgents(path)],
    then: ["sorted alphabetically with index", (agents) => {
      expect(agents[0].name).toBe("ai");
      expect(agents[0].index).toBe(1);
      expect(agents[1].name).toBe("claw");
      expect(agents[1].index).toBe(2);
      cleanup();
    }],
  });
});

feature("addAgent + removeAgent", () => {
  component("adds agent with UUID and default pane", {
    given: ["an empty config", () => {
      const path = setup();
      ensureConfig(path);
      return path;
    }],
    when: ["adding agent", (path) => { addAgent(path, "test", "/tmp/test"); return path; }],
    then: ["agent exists in config", (path) => {
      const agent = getAgent(path, "test");
      expect(agent.dir).toBe("/tmp/test");
      expect(agent.id).toBeTruthy();
      expect(agent.panes[0].cmd).toContain("claude");
      cleanup();
    }],
  });

  component("removeAgent deletes entry", {
    given: ["a config with an agent", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["removing ai", (path) => { removeAgent(path, "ai"); return path; }],
    then: ["ai is gone", (path) => {
      const agents = listAgents(path);
      expect(agents.map((a) => a.name)).not.toContain("ai");
      cleanup();
    }],
  });
});

feature("resolveAgent", () => {
  component(":1 returns first sorted agent", {
    given: ["a config with agents", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["resolving :1", (path) => resolveAgent(":1", path)],
    then: ["returns ai (first alphabetically)", (name) => {
      expect(name).toBe("ai");
      cleanup();
    }],
  });

  component(":2 returns second sorted agent", {
    given: ["a config with agents", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["resolving :2", (path) => resolveAgent(":2", path)],
    then: ["returns claw", (name) => {
      expect(name).toBe("claw");
      cleanup();
    }],
  });

  component("plain name passes through", {
    given: ["a config", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["resolving plain name", (path) => resolveAgent("claw", path)],
    then: ["returns same name", (name) => {
      expect(name).toBe("claw");
      cleanup();
    }],
  });

  component("invalid index throws", {
    given: ["a config with 2 agents", () => {
      const path = setup();
      require("fs").writeFileSync(path, SAMPLE_YAML);
      return path;
    }],
    when: ["resolving :99", (path) => () => resolveAgent(":99", path)],
    then: ["throws", (fn) => expect(fn).toThrow("No agent at index")],
  });
});

feature("saveLast + getLast", () => {
  component("round-trips last agent name", {
    given: ["a temp dir", () => join(setup(), ".last")],
    when: ["saving and loading", (path) => { saveLast(path, "myagent"); return getLast(path); }],
    then: ["returns saved name", (name) => {
      expect(name).toBe("myagent");
      cleanup();
    }],
  });

  component("getLast returns null for missing file", {
    given: ["nonexistent path", () => "/tmp/nonexistent-last-test"],
    when: ["loading", (path) => getLast(path)],
    then: ["returns null", (result) => expect(result).toBeNull()],
  });
});
