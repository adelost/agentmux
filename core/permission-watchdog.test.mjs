import { describe, expect, it } from "vitest";
import { classifyPermissionPrompt, detectPermissionPrompt, parsePermissionWatchdogConfig } from "./permission-watchdog.mjs";

// The screen lsrc:0 sat on for 21 minutes on 2026-09-12 (captured with amux log --tmux).
const LSRC0_SCREEN = `
──────────────────────────────────────────────
 Bash command

   │ cd /home/adelost/lsrc/.agents/0/gemma-style-test
   │ rm -f out-modal-31b-v8.tar.gz
   │ setsid nohup uvx --from modal==1.5.5 modal run modal_gemma.py --payload
   │ pilot-v8.json --tag 31b-v8 --execute > modal-run-v8.log 2>&1 < /dev/null &
   │ disown
   │ sleep 5; pgrep -f "modal run modal_gemma.py --payload pilot-v8" >/dev/null
   │ && echo "modal client running"
   │ Q=/mnt/q/Chathelper-traningsdata-2026-09-10/GEMMA-4-TEST/TRANINGSDATA; rm -f
   │ "$Q"/*.md "$Q"/traningsdata.json && python3 export_review.py "$Q"
   │ pilot-v8.json 2>&1 | tail -1
   Relaunch the v8 training on Modal and re-export the 827-row set to Q

 Dangerous rm operation on possibly-empty variable path: "$Q"/*.md

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend`;

describe("detectPermissionPrompt", () => {
  it("recognises the live lsrc:0 prompt with its reason and command", () => {
    const p = detectPermissionPrompt(LSRC0_SCREEN);
    expect(p).not.toBeNull();
    expect(p.reason).toBe('Dangerous rm operation on possibly-empty variable path: "$Q"/*.md');
    expect(p.command).toContain("Q=/mnt/q/Chathelper-traningsdata-2026-09-10/GEMMA-4-TEST/TRANINGSDATA; rm -f");
    expect(p.options).toEqual(["❯ 1. Yes", "2. No"]);
  });

  it("ignores the same text once a composer prompt sits below it (scrollback)", () => {
    expect(detectPermissionPrompt(LSRC0_SCREEN + "\n\n❯ \n")).toBeNull();
    expect(detectPermissionPrompt(LSRC0_SCREEN + "\n❯ Press up to edit queued messages\n")).toBeNull();
  });

  it("ignores prose that merely mentions the question", () => {
    expect(detectPermissionPrompt("● Bash\n  Do you want to proceed? asked the doc\n❯ ")).toBeNull();
  });
});

describe("classifyPermissionPrompt", () => {
  it("answers yes when the variable is set to a deep literal path in the same command", () => {
    const p = detectPermissionPrompt(LSRC0_SCREEN);
    expect(classifyPermissionPrompt(p)).toMatchObject({ action: "answer", keys: "1" });
  });

  it("notifies when the variable is not assigned in the command", () => {
    const r = classifyPermissionPrompt({ reason: 'Dangerous rm operation on possibly-empty variable path: "$OUT"/*.md', command: "rm -f \"$OUT\"/*.md" });
    expect(r.action).toBe("notify");
  });

  it("notifies when the path is shallow or built from another variable", () => {
    expect(classifyPermissionPrompt({ reason: 'Dangerous rm operation on possibly-empty variable path: "$D"/*', command: "D=/tmp; rm -rf \"$D\"/*" }).action).toBe("notify");
    expect(classifyPermissionPrompt({ reason: 'Dangerous rm operation on possibly-empty variable path: "$D"/x', command: "D=$HOME/work/x; rm -rf \"$D\"/x" }).action).toBe("notify");
  });

  it("notifies when the rm target is the bare variable", () => {
    expect(classifyPermissionPrompt({ reason: 'Dangerous rm operation on possibly-empty variable path: "$D"', command: "D=/mnt/q/a/b; rm -rf \"$D\"" }).action).toBe("notify");
  });

  it("notifies for every other permission reason", () => {
    expect(classifyPermissionPrompt({ reason: "Claude wants to run: git push --force", command: "git push --force" }).action).toBe("notify");
  });
});

describe("parsePermissionWatchdogConfig", () => {
  it("reads env with safe defaults", () => {
    expect(parsePermissionWatchdogConfig({})).toEqual({ enabled: true, autoAnswer: true, pollMs: 30_000, promptAgeMs: 120_000 });
    expect(parsePermissionWatchdogConfig({ AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER: "false", AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS: "5000" })).toMatchObject({ autoAnswer: false, promptAgeMs: 5000 });
  });
});
