import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { writeDreamOwnerInput } from "../core/dream-owner.mjs";
import { checkDreamCuration } from "../core/dream-curation-check.mjs";
import { buildCodexLaunchCommand } from "../core/agent-launch-command.mjs";
import { notifyDreamFailure } from "../core/dream-failure-notice.mjs";

it("accepts another process's reference and own daily heading while the curator finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dream-concurrent-"));
  try {
    const workspace = join(root, "workspace"), memory = join(workspace, "memory"), dateKey = "2026-10-24";
    mkdirSync(join(memory, "references"), { recursive: true });
    const memPath = join(memory, dateKey + ".md"), memoryBefore = "# " + dateKey + "\n<!-- amux-dream-summary:2026-10-23 -->\nOld fact.\n<!-- /amux-dream-summary:2026-10-23 -->\n";
    writeFileSync(memPath, memoryBefore);
    const owner = { agent: "dream", pane: 1, engine: "codex" };
    const input = writeDreamOwnerInput({ dateKey, workspace, memoryGuard: { effects: true, sandbox: true } }, { rootDir: join(root, "input") });
    writeFileSync(input.outputPath, `> Kuraterad av dream:1 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Verified result.\n`);
    execFileSync("python3", ["-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); (p/'references'/'other.md').write_text('Other verified fact.'); f=p/'2026-10-24.md'; f.write_text(f.read_text()+'\\n## Other panel\\nOwn note.\\n')", memory]);
    const sandboxProof = { ...input.sandbox, runId: input.runId, inputSha256: input.sha256, sessionId: "test-session", status: "running", kernelVerified: true };
    const options = { owner, sessionId: "test-session", prompt: "fixture", dateKey, input, memPath, workspace, memoryBefore,
      sandboxProof, getProof: async () => ({ sessionId: "test-session", ownerTexts: [], sandboxDenied: false }) };
    const result = await checkDreamCuration(options);
    expect(result.product.ok).toBe(true);
    expect(readFileSync(memPath, "utf8")).toContain("Own note.");
    expect(readFileSync(join(memory, "references", "other.md"), "utf8")).toBe("Other verified fact.");
    await expect(checkDreamCuration({ ...options, sandboxProof: null })).rejects.toThrow("sandbox-unattested");
    writeFileSync(memPath, readFileSync(memPath, "utf8").replace("Old fact.", "Altered fact."));
    await expect(checkDreamCuration(options)).rejects.toThrow("protected-block-changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("denies the curator's real OS write and sends one existing failure notification", async () => {
  const root = mkdtempSync(join(tmpdir(), "dream-denied-"));
  try {
    const work = join(root, "artifacts"), memory = join(root, "memory.md");
    mkdirSync(work); writeFileSync(memory, "Original fact.");
    // The provider is doubled; both argument parsing and the installed OS sandbox are real.
    const command = buildCodexLaunchCommand({ profileHome: root, allowFreshBootstrap: true,
      model: "gpt-6.1-sol", dreamSandbox: { profile: "amux_dream_test", root: work } });
    const args = execFileSync("bash", ["--noprofile", "--norc", "-c", 'codex() { printf "%s\\0" "$@"; }; ' + command])
      .toString().split("\0").slice(0, -1);
    const configs = args.flatMap((arg, i) => arg === "-c" ? [args[i + 1]] : []);
    const active = configs.find(value => value.startsWith("default_permissions="));
    const code = "import pathlib,sys,json; p=pathlib.Path(sys.argv[1]); out={}\ntry:p.write_text('curator changed memory');out['denied']=False\nexcept OSError as e:out={'denied':True,'errno':e.errno}\nprint(json.dumps(out))";
    const argv = active ? ["sandbox", "-P", "amux_dream_test", ...configs.flatMap(value => ["-c", value]), "--", "python3", "-c", code, memory]
      : ["-c", code, memory];
    const run = spawnSync(active ? "codex" : "python3", argv, { encoding: "utf8", timeout: 20000 });
    if (run.status !== 0) throw Error(run.stderr || run.error?.message);
    const outcome = JSON.parse(run.stdout); let notices = 0;
    if (outcome.denied) {
      const notify = async () => { notices++; return { sent: true, messageId: "fixture-notice" }; };
      await notifyDreamFailure({ dateKey: "2026-10-24", home: root, reason: "dream-sandbox-denied", notify });
      await notifyDreamFailure({ dateKey: "2026-10-24", home: root, reason: "dream-sandbox-denied", notify });
    }
    expect(readFileSync(memory, "utf8")).toBe("Original fact.");
    expect(outcome.denied).toBe(true);
    expect(notices).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
