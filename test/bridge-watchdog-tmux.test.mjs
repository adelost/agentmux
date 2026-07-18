import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, feature, integration } from "bdd-vitest";

feature("outside tmux watchdog", () => {
  integration("three consecutive socket failures queue one whole-fleet rebuild", {
    given: ["a real Unix socket whose tmux probe always times out", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-tmux-watchdog-"));
      const home = join(root, "home");
      const fakeBin = join(root, "bin");
      const socket = join(root, "tmux.sock");
      mkdirSync(home, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, "timeout"), "#!/usr/bin/env bash\nexit 124\n");
      writeFileSync(join(fakeBin, "ps"), `#!/usr/bin/env bash
echo "99999999 99999999 ${process.getuid?.() ?? 1000} tmux tmux -S ${socket} new-session -d -s test"
`);
      chmodSync(join(fakeBin, "timeout"), 0o755);
      chmodSync(join(fakeBin, "ps"), 0o755);
      const server = net.createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socket, resolveListen);
      });
      return { root, home, fakeBin, socket, server };
    }],
    when: ["the external watchdog runs three times", (ctx) => {
      const env = {
        ...process.env,
        HOME: ctx.home,
        TMUX_SOCKET: ctx.socket,
        PATH: `${ctx.fakeBin}:${process.env.PATH}`,
      };
      const script = resolve("bin/bridge-watchdog-cron.sh");
      execFileSync("bash", [script], { env });
      const afterOne = readFileSync(join(ctx.home, ".agentmux", "tmux-watchdog-failures"), "utf8").trim();
      execFileSync("bash", [script], { env });
      const afterTwo = readFileSync(join(ctx.home, ".agentmux", "tmux-watchdog-failures"), "utf8").trim();
      execFileSync("bash", [script], { env });
      const request = JSON.parse(readFileSync(
        join(ctx.home, ".agentmux", "fleet-restart-request.json"), "utf8",
      ));
      return { afterOne, afterTwo, request };
    }],
    then: ["one and two failures remain suspicion while the third persists watchdog provenance", async (result, ctx) => {
      expect(result.afterOne).toBe("1");
      expect(result.afterTwo).toBe("2");
      expect(result.request).toMatchObject({ version: 1, source: "watchdog" });
      await new Promise((resolveClose) => ctx.server.close(resolveClose));
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
