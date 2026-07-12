// Locks the tmux adapter's command strings — especially escaping, which is
// the historical bug class this module exists to contain. A fake exec
// records every command; assertions are exact-string so a quoting regression
// fails loudly instead of shipping.

import { feature, unit, expect } from "bdd-vitest";
import { createTmuxAdapter } from "./tmux.mjs";

function fakeTmux({ stdout = "" } = {}) {
  const calls = [];
  const exec = async (cmd) => { calls.push(cmd); return { stdout, stderr: "" }; };
  const t = createTmuxAdapter({ socket: "/tmp/amux.sock", exec });
  return { t, calls };
}

const PREFIX = `tmux -S '/tmp/amux.sock' `;

feature("tmux adapter: command strings", () => {
  unit("escapes single quotes in targets", {
    given: ["an adapter with a recording exec", () => fakeTmux()],
    when: ["sending Enter to a quoted target", async ({ t, calls }) => {
      await t.sendEnter("o'brien:.0");
      return calls;
    }],
    then: ["the quote is shell-escaped", (calls) =>
      expect(calls[0]).toBe(PREFIX + `send-keys -t 'o'\\''brien:.0' Enter`)],
  });

  unit("killSession quotes the configured session name", {
    given: ["an adapter", () => fakeTmux()],
    when: ["killing one fleet session", async ({ t, calls }) => {
      await t.killSession("o'brien");
      return calls;
    }],
    then: ["only that session is targeted", (calls) =>
      expect(calls[0]).toBe(PREFIX + `kill-session -t 'o'\\''brien'`)],
  });

  unit("sendLiteral escapes text and uses -l -- so option parsing stops", {
    given: ["an adapter", () => fakeTmux()],
    when: ["sending literal text with quotes and dashes", async ({ t, calls }) => {
      await t.sendLiteral("claw:.1", "don't --help me");
      return calls;
    }],
    then: ["text is escaped behind -l --", (calls) =>
      expect(calls[0]).toBe(PREFIX + `send-keys -t 'claw:.1' -l -- 'don'\\''t --help me'`)],
  });

  unit("clearInputLine sends Ctrl-U without submitting", {
    given: ["adapter", () => fakeTmux()],
    when: ["clearing the composer", async ({ t, calls }) => {
      await t.clearInputLine("claw:.1");
      return calls;
    }],
    then: ["uses the terminal clear-line key", (calls) =>
      expect(calls[0]).toBe(PREFIX + `send-keys -t 'claw:.1' C-u`)],
  });

  unit("runShell wraps the line verbatim (config cmds may hold quotes)", {
    given: ["an adapter", () => fakeTmux()],
    when: ["running a shell line with double quotes", async ({ t, calls }) => {
      await t.runShell("claw:.2", 'cd /a/b && npm run dev -- --port "3000"');
      return calls;
    }],
    then: ["line is single-quoted verbatim + Enter", (calls) =>
      expect(calls[0]).toBe(
        PREFIX + `send-keys -t 'claw:.2' 'cd /a/b && npm run dev -- --port "3000"' Enter`,
      )],
  });

  unit("cancelCopyMode uses -X so no keystroke can leak to the app", {
    given: ["an adapter", () => fakeTmux()],
    when: ["cancelling copy mode", async ({ t, calls }) => {
      await t.cancelCopyMode("claw:.0");
      return calls;
    }],
    then: ["-X cancel is dispatched", (calls) =>
      expect(calls[0]).toBe(PREFIX + `send-keys -X -t 'claw:.0' cancel`)],
  });

  unit("capture joins wrapped lines by default and respects depth", {
    given: ["an adapter", () => fakeTmux({ stdout: "line" })],
    when: ["capturing 200 lines", async ({ t, calls }) => {
      await t.capture("claw:.3", { lines: 200 });
      return calls;
    }],
    then: ["-J present, -S -200", (calls) =>
      expect(calls[0]).toBe(PREFIX + `capture-pane -t 'claw:.3' -J -p -S -200`)],
  });

  unit("capture can skip -J for raw geometry reads", {
    given: ["an adapter", () => fakeTmux()],
    when: ["capturing without join", async ({ t, calls }) => {
      await t.capture("claw:.3", { lines: 10, join: false });
      return calls;
    }],
    then: ["no -J flag", (calls) =>
      expect(calls[0]).toBe(PREFIX + `capture-pane -t 'claw:.3' -p -S -10`)],
  });

  unit("captureScreen excludes scrollback so respawn readiness cannot use stale UI", {
    given: ["an adapter", () => fakeTmux({ stdout: "screen" })],
    when: ["capturing the visible screen", async ({ t, calls }) => {
      await t.captureScreen("ai:.4");
      return calls;
    }],
    then: ["no -S history range is present", (calls) =>
      expect(calls[0]).toBe(PREFIX + `capture-pane -t 'ai:.4' -J -p`)],
  });

  unit("respawnPane composes kill and cwd flags", {
    given: ["an adapter", () => fakeTmux()],
    when: ["respawning with and without options", async ({ t, calls }) => {
      await t.respawnPane("claw:.4", { kill: true, cwd: "/repo/.agents/4" });
      await t.respawnPane("claw:.4");
      return calls;
    }],
    then: ["flags match exactly", (calls) => {
      expect(calls[0]).toBe(PREFIX + `respawn-pane -k -t 'claw:.4' -c '/repo/.agents/4'`);
      expect(calls[1]).toBe(PREFIX + `respawn-pane -t 'claw:.4'`);
    }],
  });

  unit("splitWindowRight pins cwd (the pane-N-wrong-jsonl fix)", {
    given: ["an adapter", () => fakeTmux()],
    when: ["splitting", async ({ t, calls }) => {
      await t.splitWindowRight("claw:.1", "/repo/.agents/2");
      return calls;
    }],
    then: ["-h -c with escaped cwd", (calls) =>
      expect(calls[0]).toBe(PREFIX + `split-window -t 'claw:.1' -h -c '/repo/.agents/2'`)],
  });

  unit("sendKeys passes key specs verbatim (dismiss sequences)", {
    given: ["an adapter", () => fakeTmux()],
    when: ["sending a two-key spec", async ({ t, calls }) => {
      await t.sendKeys("claw:.0", "Down Enter");
      return calls;
    }],
    then: ["spec is untouched", (calls) =>
      expect(calls[0]).toBe(PREFIX + `send-keys -t 'claw:.0' Down Enter`)],
  });

  unit("resizeWindow coerces geometry to numbers (no injection via strings)", {
    given: ["an adapter", () => fakeTmux()],
    when: ["resizing with string geometry", async ({ t, calls }) => {
      await t.resizeWindow("claw", "240", "60");
      return calls;
    }],
    then: ["numbers in the command", (calls) =>
      expect(calls[0]).toBe(PREFIX + `resize-window -t 'claw' -x 240 -y 60`)],
  });

  unit("picker zoom uses the target pane and exposes its prior state", {
    given: ["an unzoomed pane", () => fakeTmux({ stdout: "0\n" })],
    when: ["reading and toggling zoom", async ({ t, calls }) => ({
      zoomed: await t.paneZoomed("ai:.5"),
      calls: (await t.togglePaneZoom("ai:.5"), calls),
    })],
    then: ["the flag read and toggle are exact", ({ zoomed, calls }) => {
      expect(zoomed).toBe(false);
      expect(calls[0]).toBe(PREFIX + `display-message -t 'ai:.5' -p '#{window_zoomed_flag}'`);
      expect(calls[1]).toBe(PREFIX + `resize-pane -Z -t 'ai:.5'`);
    }],
  });

  unit("primitives survive destructuring (no this-binding)", {
    given: ["a destructured primitive", () => {
      const { t, calls } = fakeTmux({ stdout: "1\n" });
      const { paneDead, sendEnter } = t;
      return { paneDead, sendEnter, calls };
    }],
    when: ["calling them bare", async ({ paneDead, sendEnter, calls }) => {
      const dead = await paneDead("claw:.0");
      await sendEnter("claw:.0");
      return { dead, calls };
    }],
    then: ["they work without their object", ({ dead, calls }) => {
      expect(dead).toBe(true);
      expect(calls[1]).toBe(PREFIX + `send-keys -t 'claw:.0' Enter`);
    }],
  });
});

feature("tmux adapter: parsed reads", () => {
  unit("hasSession maps exit code to boolean", {
    given: ["an exec that throws for missing sessions", () => {
      const exec = async (cmd) => {
        if (cmd.includes("missing")) throw new Error("no such session");
        return { stdout: "" };
      };
      return createTmuxAdapter({ socket: "s", exec });
    }],
    when: ["checking both sessions", async (t) => ({
      exists: await t.hasSession("claw"),
      missing: await t.hasSession("missing"),
    })],
    then: ["true/false respectively", (r) => {
      expect(r.exists).toBe(true);
      expect(r.missing).toBe(false);
    }],
  });

  unit("globalEnvNames returns names only", {
    given: ["show-environment output", () =>
      fakeTmux({ stdout: "CLAUDECODE=1\nPATH=/usr/bin\nAI_AGENT=x\n" })],
    when: ["listing env names", ({ t }) => t.globalEnvNames()],
    then: ["names without values", (names) =>
      expect(names).toEqual(["CLAUDECODE", "PATH", "AI_AGENT"])],
  });

  unit("paneCount counts list-panes lines", {
    given: ["three panes listed", () => fakeTmux({ stdout: "0: ...\n1: ...\n2: ...\n" })],
    when: ["counting", ({ t }) => t.paneCount("claw")],
    then: ["3", (n) => expect(n).toBe(3)],
  });

  unit("paneInMode and paneDead parse the display flag", {
    given: ["display returning 1", () => fakeTmux({ stdout: "1\n" })],
    when: ["reading both flags", async ({ t }) => ({
      inMode: await t.paneInMode("claw:.0"),
      dead: await t.paneDead("claw:.0"),
    })],
    then: ["both true", (r) => {
      expect(r.inMode).toBe(true);
      expect(r.dead).toBe(true);
    }],
  });

  unit("display trims the formatted value", {
    given: ["padded display output", () => fakeTmux({ stdout: "  bash \n" })],
    when: ["reading a format value", ({ t }) => t.display("claw:.0", "#{pane_current_command}")],
    then: ["trimmed", (v) => expect(v).toBe("bash")],
  });
});
