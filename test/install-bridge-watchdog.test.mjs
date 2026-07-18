import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, feature, integration } from "bdd-vitest";

feature("bridge watchdog cron installer", () => {
  integration("replaces disposable worktree rows with the active immutable release", {
    given: ["a stale cron row and an amux binary from the installed package", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-watchdog-install-"));
      const fakeBin = join(root, "bin");
      const installed = join(root, "global", "agentmux");
      const crontab = join(root, "crontab");
      mkdirSync(join(installed, "bin"), { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(installed, "bin", "agent-cli.mjs"), "#!/usr/bin/env node\n");
      writeFileSync(join(installed, "bin", "bridge-watchdog-cron.sh"), "#!/usr/bin/env bash\n");
      chmodSync(join(installed, "bin", "agent-cli.mjs"), 0o755);
      symlinkSync(join(installed, "bin", "agent-cli.mjs"), join(fakeBin, "amux"));
      writeFileSync(join(fakeBin, "crontab"), `#!/usr/bin/env bash
if [ "\${1:-}" = "-l" ]; then cat "$FAKE_CRONTAB" 2>/dev/null; exit 0; fi
cat > "$FAKE_CRONTAB"
`);
      chmodSync(join(fakeBin, "crontab"), 0o755);
      writeFileSync(crontab, "11 * * * * keep-me\n*/5 * * * * bash /tmp/worktree/bin/bridge-watchdog-cron.sh\n");
      return { root, fakeBin, installed, crontab };
    }],
    when: ["running the installer twice", (ctx) => {
      const env = { ...process.env, FAKE_CRONTAB: ctx.crontab, PATH: `${ctx.fakeBin}:${process.env.PATH}` };
      execFileSync("bash", [resolve("bin/install-bridge-watchdog.sh")], { env });
      const first = readFileSync(ctx.crontab, "utf8");
      execFileSync("bash", [resolve("bin/install-bridge-watchdog.sh")], { env });
      return { ...ctx, first, second: readFileSync(ctx.crontab, "utf8") };
    }],
    then: ["one stable release-pinned row survives beside unrelated cron work", (ctx) => {
      const expected = `*/5 * * * * bash ${ctx.installed}/bin/bridge-watchdog-cron.sh`;
      expect(ctx.first).toBe(ctx.second);
      expect(ctx.second).toContain("11 * * * * keep-me");
      expect(ctx.second).toContain(expected);
      expect(ctx.second).not.toContain("/tmp/worktree");
      expect(ctx.second.match(/bridge-watchdog-cron\.sh/gu)).toHaveLength(1);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
