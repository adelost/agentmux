import { expect, feature, integration } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

feature("claim workers do not start bridge preloads", () => {
  integration("the checker excludes parent service startup flags", {
    given: ["a safe stand-in for a bridge-only preload", () => {
      const dir = mkdtempSync(join(tmpdir(), "claim-worker-"));
      const preload = join(dir, "service.mjs"), entry = join(dir, "entry.mjs");
      writeFileSync(preload, "import {isMainThread} from 'node:worker_threads'; if(!isMainThread) throw Error('service preload entered claim worker');");
      writeFileSync(entry, `import {createClaimEvaluator} from ${JSON.stringify(new URL("./claim-evaluator.mjs", import.meta.url).href)};
        const alive=setTimeout(()=>{},4000);
        try { const result=await createClaimEvaluator([])('Tjänsten är live.'); console.log(result.verdict); }
        finally { clearTimeout(alive); }`);
      return { dir, preload, entry };
    }],
    when: ["a real child uses argv or NODE_OPTIONS preloads", ({ preload, entry }) => [
      spawnSync(process.execPath, ["--import", preload, entry], { encoding: "utf8", timeout: 5000, env: { ...process.env, NODE_OPTIONS: "" } }),
      spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 5000, env: { ...process.env, NODE_OPTIONS: `--import=${preload}` } }),
    ]],
    then: ["both workers check without running service startup", results => {
      expect(results.map(result => ({ status: result.status, output: result.stdout.trim(), error: result.stderr.trim() })))
        .toEqual([{ status: 0, output: "hold", error: "" }, { status: 0, output: "hold", error: "" }]);
    }],
    cleanup: ({ dir }) => rmSync(dir, { recursive: true, force: true }),
  });
});
