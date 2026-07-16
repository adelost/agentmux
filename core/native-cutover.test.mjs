import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  materializeCutoverConfigs,
  normalizeCutoverRuntimeUrl,
  planNativeCutover,
  restoreCutoverConfigs,
  sourceAfterNativeCutover,
  writeCutoverConfigs,
} from "./native-cutover.mjs";

const sourceDoc = () => ({
  guild: "guild",
  category: "Agents",
  agents: {
    claw: { dir: "/workspace/claw", claude: 1, codex: 1 },
    ai: {
      dir: "/workspace/ai",
      claude: 1,
      codex: 1,
      services: ["make api"],
      shells: 2,
      labels: { 0: "broker", 2: "api service", 3: "shell" },
    },
  },
});

const generated = () => ({
  claw: {
    id: "11111111-1111-4111-8111-111111111111",
    dir: "/workspace/claw",
    panes: [{ cmd: "claude --continue" }, { cmd: "codex --yolo" }],
  },
  ai: {
    id: "22222222-2222-4222-8222-222222222222",
    dir: "/workspace/ai",
    panes: [
      { cmd: "claude --continue" }, { cmd: "codex --yolo" },
      { cmd: "make api" }, { cmd: "bash" }, { cmd: "bash" },
    ],
  },
});

describe("native fleet cutover planning", () => {
  it("requires an explicit local runtime and refuses hidden pane loss", () => {
    expect(() => normalizeCutoverRuntimeUrl("https://code.example.test"))
      .toThrow("loopback");
    const plan = planNativeCutover({
      sourceDoc: sourceDoc(),
      generatedConfig: generated(),
      names: ["ai"],
      runtimeUrl: "http://127.0.0.1:8813",
    });
    expect(plan.blockers).toEqual([
      "ai: 1 service pane(s) need --manage-services or --drop-services",
      "ai: 2 shell pane(s) need --drop-shells",
    ]);
  });

  it("materializes only complete imported identity sets", () => {
    const original = sourceDoc();
    const plan = planNativeCutover({
      sourceDoc: original,
      generatedConfig: generated(),
      names: ["ai"],
      runtimeUrl: "http://localhost:8813/",
      dropServices: true,
      dropShells: true,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toHaveLength(2);
    expect(() => sourceAfterNativeCutover(original, plan, { ai: { 0: "only-one" } }, {
      dropServices: true,
      dropShells: true,
    })).toThrow("incomplete imported");

    const next = sourceAfterNativeCutover(original, plan, {
      ai: {
        0: "33333333-3333-4333-8333-333333333333",
        1: "44444444-4444-4444-8444-444444444444",
      },
    }, { dropServices: true, dropShells: true });
    expect(next.agents.ai).toMatchObject({
      backend: "native",
      runtime: "http://localhost:8813",
      nativeAgentIds: {
        0: "33333333-3333-4333-8333-333333333333",
        1: "44444444-4444-4444-8444-444444444444",
      },
      labels: { 0: "broker" },
    });
    expect(next.agents.ai.services).toBeUndefined();
    expect(next.agents.ai.shells).toBeUndefined();
    expect(original.agents.ai.backend).toBeUndefined();

    const configs = materializeCutoverConfigs({
      sourceDoc: next,
      currentGeneratedYaml: yaml.dump(generated()),
    });
    const parsed = yaml.load(configs.generatedYaml);
    expect(parsed.ai.panes.map((pane) => pane.cmd)).toEqual(["native:claude", "native:codex"]);
    expect(parsed.ai.panes.map((pane) => pane.nativeAgentId)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("keeps service commands when the native supervisor owns them", () => {
    const original = sourceDoc();
    const plan = planNativeCutover({
      sourceDoc: original,
      generatedConfig: generated(),
      names: ["ai"],
      runtimeUrl: "http://127.0.0.1:8813",
      manageServices: true,
      dropShells: true,
    });
    expect(plan.blockers).toEqual([]);
    const next = sourceAfterNativeCutover(original, plan, {
      ai: {
        0: "33333333-3333-4333-8333-333333333333",
        1: "44444444-4444-4444-8444-444444444444",
      },
    }, { dropShells: true });
    expect(next.agents.ai.services).toEqual(["make api"]);
    expect(next.agents.ai.shells).toBeUndefined();
  });

  it("omits adoption ids for explicitly proven-empty panes", () => {
    const original = sourceDoc();
    const plan = planNativeCutover({
      sourceDoc: original,
      generatedConfig: generated(),
      names: ["claw"],
      runtimeUrl: "http://127.0.0.1:8813",
    });
    const next = sourceAfterNativeCutover(original, plan, {
      claw: {
        0: "33333333-3333-4333-8333-333333333333",
        1: null,
      },
    });
    expect(next.agents.claw.nativeAgentIds).toEqual({
      0: "33333333-3333-4333-8333-333333333333",
    });
    const configs = materializeCutoverConfigs({
      sourceDoc: next,
      currentGeneratedYaml: yaml.dump(generated()),
    });
    const panes = yaml.load(configs.generatedYaml).claw.panes;
    expect(panes[0].nativeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(panes[1].nativeAgentId).toBeUndefined();
  });

  it("keeps byte-exact originals available for rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-cutover-config-"));
    const sourcePath = join(root, "agentmux.yaml");
    const generatedPath = join(root, "agents.yaml");
    writeFileSync(sourcePath, "# hand-authored\nsource: old\n");
    writeFileSync(generatedPath, "# generated\nagents: old\n");
    const before = writeCutoverConfigs({
      sourcePath,
      generatedPath,
      sourceYaml: "source: native\n",
      generatedYaml: "agents: native\n",
    });
    expect(readFileSync(sourcePath, "utf8")).toBe("source: native\n");
    restoreCutoverConfigs({ sourcePath, generatedPath, ...before });
    expect(readFileSync(sourcePath, "utf8")).toBe("# hand-authored\nsource: old\n");
    expect(readFileSync(generatedPath, "utf8")).toBe("# generated\nagents: old\n");
  });
});
