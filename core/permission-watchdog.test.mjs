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

// The screen claw:0 sat on 2026-09-14 (captured with amux log --tmux): newer Claude
// Code puts the reason inside the box and wraps the target onto its own line.
const CLAW0_SCREEN = `
   │ open("prefs.xml","w").write(prefs)
   │ EOF
   │ ls reply-audio | wc -l
   Run shell command
 │ Dangerous rm operation on statically-unresolvable target:
 │ /home/adelost/.openclaw/workspace/.agents/0/reply-audio/*
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend`;

const HOME = "/home/adelost";
const untracked = { home: HOME, holdsKeptFiles: () => false };
const rm = (target, command = "") => ({ reason: `Dangerous rm operation on statically-unresolvable target: ${target}`, command });
const varRm = (target, command) => ({ reason: `Dangerous rm operation on possibly-empty variable path: ${target}`, command });

describe("detectPermissionPrompt, boxed reason", () => {
  it("reads the reason and its wrapped target from inside the box", () => {
    const p = detectPermissionPrompt(CLAW0_SCREEN);
    expect(p).not.toBeNull();
    expect(p.reason).toBe("Dangerous rm operation on statically-unresolvable target: /home/adelost/.openclaw/workspace/.agents/0/reply-audio/*");
    expect(p.command).toContain("ls reply-audio | wc -l");
    expect(p.command).not.toContain("Dangerous rm operation");
  });
});

describe("classifyPermissionPrompt", () => {
  it("answers yes when the variable is set to a deep literal path in the same command", () => {
    const p = detectPermissionPrompt(LSRC0_SCREEN);
    expect(classifyPermissionPrompt(p, untracked)).toMatchObject({ action: "answer", keys: "1" });
  });

  it("answers yes for the claw:0 glob on an untracked scratch folder", () => {
    const p = detectPermissionPrompt(CLAW0_SCREEN);
    expect(classifyPermissionPrompt(p, untracked)).toMatchObject({ action: "answer", keys: "1" });
  });

  it("answers yes for ~ and for a relative folder under a literal cd", () => {
    expect(classifyPermissionPrompt(rm("~/lsrc/.agents/0/out/*"), untracked).action).toBe("answer");
    expect(classifyPermissionPrompt(rm("build/*", "cd /home/adelost/lsrc/.agents/0/proj && rm -rf build/*"), untracked).action).toBe("answer");
  });

  // Mattias 2026-09-14: "Kan du inte bygga in i amux att den godkänner RM automatiskt ...
  // Kan du fixa till det så det löser sig automatiskt ordentligt." A literal folder that
  // is deep enough and holds nothing git keeps is now answered like any other target.
  it("answers yes when the bare variable is a deep literal folder", () => {
    expect(classifyPermissionPrompt(varRm('"$D"', 'D=/mnt/q/a/b; rm -rf "$D"'), untracked).action).toBe("answer");
  });

  it("notifies when the variable is not assigned in the command", () => {
    expect(classifyPermissionPrompt(varRm('"$OUT"/*.md', 'rm -f "$OUT"/*.md'), untracked).action).toBe("notify");
  });

  it("notifies when the path is shallow or built from another variable", () => {
    expect(classifyPermissionPrompt(varRm('"$D"/*', 'D=/tmp; rm -rf "$D"/*'), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(varRm('"$D"/x', 'D=$HOME/work/x; rm -rf "$D"/x'), untracked).action).toBe("notify");
  });

  it("notifies for home, a top folder in home or on a drive, the whole working directory and an unknown cwd", () => {
    expect(classifyPermissionPrompt(rm("/home/adelost/*"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(rm("/home/adelost/lsrc/*"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(rm("~/lsrc/*"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(rm("/mnt/q/apps/*"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(rm("*", "cd /home/adelost/lsrc/.agents/0/proj && rm -rf *"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(rm("../x/*", "cd /home/adelost/lsrc/.agents/0/proj && rm -rf ../x/*"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt(rm("build/*", "rm -rf build/*"), untracked).action).toBe("notify");
  });

  it("notifies when the target holds files git keeps (tracked, or untracked and not ignored)", () => {
    const tracked = { home: HOME, holdsKeptFiles: (path) => path.startsWith("/home/adelost/.openclaw/workspace/memory") };
    expect(classifyPermissionPrompt(rm("/home/adelost/.openclaw/workspace/memory/2026-09-1*.md"), tracked).action).toBe("notify");
  });

  it("notifies when the target comes from command substitution", () => {
    expect(classifyPermissionPrompt(rm("$(find . -name x)"), untracked).action).toBe("notify");
    expect(classifyPermissionPrompt({ reason: "Dangerous rm operation on possibly-empty variable path inside command substitution: $X", command: "" }, untracked).action).toBe("notify");
  });

  it("notifies for every other permission reason", () => {
    expect(classifyPermissionPrompt({ reason: "Claude wants to run: git push --force", command: "git push --force" }, untracked).action).toBe("notify");
  });
});

describe("parsePermissionWatchdogConfig", () => {
  it("reads env with safe defaults", () => {
    expect(parsePermissionWatchdogConfig({})).toEqual({ enabled: true, autoAnswer: true, pollMs: 10_000, answerAgeMs: 10_000, promptAgeMs: 120_000 });
    expect(parsePermissionWatchdogConfig({ AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER: "false", AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS: "5000" })).toMatchObject({ autoAnswer: false, promptAgeMs: 5000 });
  });
});
