// Locks the tmux adapter's command strings — especially escaping, which is
// the historical bug class this module exists to contain. A fake exec
// records every command; assertions are exact-string so a quoting regression
// fails loudly instead of shipping.

import { describe, it, expect } from "vitest";
import { createTmuxAdapter } from "./tmux.mjs";

function fakeTmux({ stdout = "" } = {}) {
  const calls = [];
  const exec = async (cmd) => { calls.push(cmd); return { stdout, stderr: "" }; };
  const t = createTmuxAdapter({ socket: "/tmp/amux.sock", exec });
  return { t, calls };
}

const PREFIX = `tmux -S '/tmp/amux.sock' `;

describe("tmux adapter: command strings", () => {
  it("escapes single quotes in targets", async () => {
    const { t, calls } = fakeTmux();
    await t.sendEnter("o'brien:.0");
    expect(calls[0]).toBe(PREFIX + `send-keys -t 'o'\\''brien:.0' Enter`);
  });

  it("sendLiteral escapes text and uses -l -- so option parsing stops", async () => {
    const { t, calls } = fakeTmux();
    await t.sendLiteral("claw:.1", "don't --help me");
    expect(calls[0]).toBe(PREFIX + `send-keys -t 'claw:.1' -l -- 'don'\\''t --help me'`);
  });

  it("runShell wraps the line verbatim (config cmds may hold quotes)", async () => {
    const { t, calls } = fakeTmux();
    await t.runShell("claw:.2", 'cd /a/b && npm run dev -- --port "3000"');
    expect(calls[0]).toBe(
      PREFIX + `send-keys -t 'claw:.2' 'cd /a/b && npm run dev -- --port "3000"' Enter`,
    );
  });

  it("cancelCopyMode uses -X so no keystroke can leak to the app", async () => {
    const { t, calls } = fakeTmux();
    await t.cancelCopyMode("claw:.0");
    expect(calls[0]).toBe(PREFIX + `send-keys -X -t 'claw:.0' cancel`);
  });

  it("capture joins wrapped lines by default and respects lines depth", async () => {
    const { t, calls } = fakeTmux({ stdout: "line" });
    await t.capture("claw:.3", { lines: 200 });
    expect(calls[0]).toBe(PREFIX + `capture-pane -t 'claw:.3' -J -p -S -200`);
  });

  it("capture can skip -J for raw geometry reads", async () => {
    const { t, calls } = fakeTmux();
    await t.capture("claw:.3", { lines: 10, join: false });
    expect(calls[0]).toBe(PREFIX + `capture-pane -t 'claw:.3' -p -S -10`);
  });

  it("respawnPane composes kill and cwd flags", async () => {
    const { t, calls } = fakeTmux();
    await t.respawnPane("claw:.4", { kill: true, cwd: "/repo/.agents/4" });
    await t.respawnPane("claw:.4");
    expect(calls[0]).toBe(PREFIX + `respawn-pane -k -t 'claw:.4' -c '/repo/.agents/4'`);
    expect(calls[1]).toBe(PREFIX + `respawn-pane -t 'claw:.4'`);
  });

  it("splitWindowRight pins cwd (the pane-N-wrong-jsonl fix)", async () => {
    const { t, calls } = fakeTmux();
    await t.splitWindowRight("claw:.1", "/repo/.agents/2");
    expect(calls[0]).toBe(PREFIX + `split-window -t 'claw:.1' -h -c '/repo/.agents/2'`);
  });

  it("sendKeys passes key specs verbatim (dismiss sequences)", async () => {
    const { t, calls } = fakeTmux();
    await t.sendKeys("claw:.0", "Down Enter");
    expect(calls[0]).toBe(PREFIX + `send-keys -t 'claw:.0' Down Enter`);
  });

  it("resizeWindow coerces geometry to numbers (no injection via strings)", async () => {
    const { t, calls } = fakeTmux();
    await t.resizeWindow("claw", "240", "60");
    expect(calls[0]).toBe(PREFIX + `resize-window -t 'claw' -x 240 -y 60`);
  });
});

describe("tmux adapter: parsed reads", () => {
  it("hasSession maps exit code to boolean", async () => {
    const calls = [];
    const exec = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("missing")) throw new Error("no such session");
      return { stdout: "" };
    };
    const t = createTmuxAdapter({ socket: "s", exec });
    expect(await t.hasSession("claw")).toBe(true);
    expect(await t.hasSession("missing")).toBe(false);
  });

  it("globalEnvNames returns names only", async () => {
    const { t } = fakeTmux({ stdout: "CLAUDECODE=1\nPATH=/usr/bin\nAI_AGENT=x\n" });
    expect(await t.globalEnvNames()).toEqual(["CLAUDECODE", "PATH", "AI_AGENT"]);
  });

  it("paneCount counts list-panes lines", async () => {
    const { t } = fakeTmux({ stdout: "0: ...\n1: ...\n2: ...\n" });
    expect(await t.paneCount("claw")).toBe(3);
  });

  it("paneInMode and paneDead parse the display flag", async () => {
    const { t } = fakeTmux({ stdout: "1\n" });
    expect(await t.paneInMode("claw:.0")).toBe(true);
    expect(await t.paneDead("claw:.0")).toBe(true);
  });

  it("display trims the formatted value", async () => {
    const { t } = fakeTmux({ stdout: "  bash \n" });
    expect(await t.display("claw:.0", "#{pane_current_command}")).toBe("bash");
  });
});
