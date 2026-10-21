import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverLateDream } from "../core/dream-late-recovery.mjs";

function fixture({ invalid = false, second = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "late-dream-")), workspace = join(home, "workspace");
  const root = join(home, ".agentmux", "dream-input");
  mkdirSync(workspace); mkdirSync(root, { recursive: true });
  const dateKey = "2026-10-21", owner = { agent: "test", pane: 0 }, calls = [];
  const add = runId => {
    const path = join(root, `${dateKey}-${runId}.json`);
    const bytes = JSON.stringify({ workspace, dateKey, owner });
    writeFileSync(path, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(path.replace(/\.json$/u, ".summary.md"), invalid ? "unverified" :
      `> Kuraterad av test:0 efter verifierad kompaktering · run \`${runId}\` · source \`${sha}\`.\n- Finished work.`);
    return { path, sha, runId };
  };
  const input = add("11111111-1111-1111-1111-111111111111");
  if (second) add("22222222-2222-2222-2222-222222222222");
  return { home, workspace, dateKey, calls, input, run: async args => { calls.push(args); return 0; },
    success: () => ({ ok: true, runId: input.runId }) };
}

feature("late Dream product recovery", () => {
  component("calls only checked recovery with the immutable source hash", {
    given: ["one valid existing curator product", () => fixture()],
    when: ["recovering the late result", fx => recoverLateDream(fx)],
    then: ["the normal CLI verifies the original run, without a new curation", (result, fx) => {
      expect(result.recovered).toBe(true);
      expect(fx.calls).toEqual([["dream", "--recover", fx.input.path, "--source-sha256", fx.input.sha, "--workspace", fx.workspace]]);
    }],
    cleanup: fx => rmSync(fx.home, { recursive: true, force: true }),
  });
  for (const options of [{ invalid: true }, { second: true }]) component(`refuses unverified or ambiguous products ${JSON.stringify(options)}`, {
    given: ["no unique verified existing product", () => fixture(options)],
    when: ["checking for late work", fx => recoverLateDream(fx)],
    then: ["no command or model is dispatched", (result, fx) => {
      expect(result.skipped).toBe(options.invalid ? "no-late-product" : "ambiguous-late-products");
      expect(fx.calls).toHaveLength(0);
    }],
    cleanup: fx => rmSync(fx.home, { recursive: true, force: true }),
  });
  component("a zero command exit without a matching saved digest is not completion", {
    given: ["a recovery command that could not commit its product", () => ({ ...fixture(), success: () => ({ ok: false }) })],
    when: ["checking the recovery outcome", fx => recoverLateDream(fx)],
    then: ["completion stays false", result => expect(result.recovered).toBe(false)],
    cleanup: fx => rmSync(fx.home, { recursive: true, force: true }),
  });
});
