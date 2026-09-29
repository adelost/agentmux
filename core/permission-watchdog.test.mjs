import { describe, expect, it } from "vitest";
import { classifyPermissionPrompt, detectPermissionPrompt, nextPromptStep, parsePermissionWatchdogConfig } from "./permission-watchdog.mjs";

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

// skyvw:2 on 2026-09-13 13:18: the command is verbatim from its transcript, the
// frame is reconstructed in the boxed layout (no screen capture was kept).
const SKYVW2_SEP13_SCREEN = `
   │ ADB=/home/adelost/android-dev/sdk/platform-tools/adb; S="-s emulator-5556";
   │ D=/home/adelost/lsrc/.artifacts/home-reach-2026-09-13/conservative; rm -f $D/*.png
   │ $ADB $S shell am broadcast -a com.adelost.skydivealtimeter.QAWEATHER --es command refresh >/dev/null
   Run shell command
 │ Dangerous rm operation on possibly-empty variable path: $D/*.png
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend`;

describe("the 13 Sep artifact rm", () => {
  it("answers a glob under a variable assigned a literal artifact folder in the same command", () => {
    const prompt = detectPermissionPrompt(SKYVW2_SEP13_SCREEN);
    expect(prompt.reason).toBe("Dangerous rm operation on possibly-empty variable path: $D/*.png");
    expect(classifyPermissionPrompt(prompt, { home: "/home/adelost", holdsKeptFiles: () => false }))
      .toMatchObject({ action: "answer", keys: "1" });
  });
});

describe("nextPromptStep", () => {
  const config = { autoAnswer: true, answerAgeMs: 10_000, promptAgeMs: 120_000, humanAgeMs: 600_000 };
  const open = { answered: false, orchestratorNotified: false, humanNotified: false };

  it("hands an unsafe prompt to the orchestrator first and to the human only after the human delay", () => {
    const step = (ageMs, state = open) => nextPromptStep({ ageMs, answerable: false, hasOrchestrator: true, state, config });
    expect(step(119_000)).toBeNull();
    expect(step(121_000)).toBe("orchestrator");
    expect(step(300_000, { ...open, orchestratorNotified: true })).toBeNull();
    expect(step(601_000, { ...open, orchestratorNotified: true })).toBe("human");
    expect(step(900_000, { ...open, orchestratorNotified: true, humanNotified: true })).toBeNull();
  });

  it("goes straight to the human after the prompt delay when no orchestrator can take it", () => {
    expect(nextPromptStep({ ageMs: 121_000, answerable: false, hasOrchestrator: false, state: open, config })).toBe("human");
  });

  it("answers a safe prompt once after the answer delay", () => {
    expect(nextPromptStep({ ageMs: 11_000, answerable: true, hasOrchestrator: true, state: open, config })).toBe("answer");
    expect(nextPromptStep({ ageMs: 11_000, answerable: true, hasOrchestrator: true, state: { ...open, answered: true }, config })).toBeNull();
  });
});

describe("detectPermissionPrompt, boxed reason", () => {
  it("reads the reason and its wrapped target from inside the box", () => {
    const p = detectPermissionPrompt(CLAW0_SCREEN);
    expect(p).not.toBeNull();
    expect(p.reason).toBe("Dangerous rm operation on statically-unresolvable target: /home/adelost/.openclaw/workspace/.agents/0/reply-audio/*");
    expect(p.command).toContain("ls reply-audio | wc -l");
    expect(p.command).not.toContain("Dangerous rm operation");
  });

  it("uses only the latest live modal when an older modal remains in scrollback", () => {
    const prompt = detectPermissionPrompt(`${LSRC0_SCREEN}\n${CLAW0_SCREEN}`);
    expect(prompt.reason).toContain("/home/adelost/.openclaw/workspace/.agents/0/reply-audio/*");
    expect(prompt.command).toBe('open("prefs.xml","w").write(prefs)\nEOF\nls reply-audio | wc -l');
    expect(prompt.command).not.toContain("modal_gemma.py");
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

// lsrc:1 on 2026-09-29 (Claude Code 2.1.284): a background agent's command, verbatim from its transcript, stopped the
// pane 6 minutes behind this prompt until Mattias answered it himself: "jag tycker inte den ska pausa". Newer Claude
// Code quotes the rm and a hint after the target, and $2 comes from `set -- $pair` in a loop over literal words.
const LSRC1_COMMAND = String.raw`S=/tmp/claude-1000/-home-adelost-lsrc--agents-1/cc72f53f-04fd-4096-936c-82d153278adc/scratchpad/a23; D=$S/ws1; for p in 8865 8866; do pid=$(ss -ltnpH "sport = :$p" | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1); [ -n "$pid" ] && kill $pid; done; sleep 1; for pair in "8865 p-ws1-cut v2-a23-timeline" "8866 p-ws1-cut-base v2-a23-timeline-base"; do set -- $pair; rm -rf $S/$2; $S/make_copy.sh $S/$2 > /dev/null; cd ~/lsrc/cutkit-wt/$3 && (python3 tools/studio.py $S/$2 --marks marks-points.yaml --port $1 --no-open > $S/$2.log 2>&1 &); done; for p in 8865 8866; do for i in $(seq 1 60); do curl -s -o /dev/null -w "%{http_code}" "localhost:$p/api/recipe?name=edl-film-1752.yaml" 2>/dev/null | grep -q 200 && break; sleep 1; done; done; for pair in "8865 p-ws1-cut v2-a23-timeline mine" "8866 p-ws1-cut-base v2-a23-timeline-base base"; do set -- $pair; rm -rf $D/cut2-$4; mkdir -p $D/cut2-$4; cd ~/lsrc/cutkit-wt/$3 && FX=$S/$2 PORT=$1 OUT=$D/cut2-$4 SIZE=1600x950 timeout 590 node tools/dev/drive.mjs $D/moves-variant2.mjs > $D/moves2-$4.txt 2>&1; echo "== $4 moves 2-5: $(grep -c 'STEP FAILED' $D/moves2-$4.txt) failed, starts: $(head -c 20 $D/moves2-$4.txt | tr '\n' ' ')"; grep -A2 "STEP FAILED" $D/moves2-$4.txt | cut -c1-600 | head -3; ls $D/cut2-$4 | tr '\n' ' '; echo; done`;
const LSRC1_REASON = 'Dangerous rm operation on possibly-empty variable path: $S/$2 in `rm -rf $S/$2` (bind $2 and rewrite its $S as "${S:?}" or use a literal path)';
const LSRC1_SCRATCH = "/tmp/claude-1000/-home-adelost-lsrc--agents-1/cc72f53f-04fd-4096-936c-82d153278adc/scratchpad/a23";

/** The dialog as Claude Code draws it: the command and the reason in a box, wrapped between words at `width`. */
function dialog(command, description, reason, width = 150) {
  const wrap = (text) => text.split("\n").flatMap((para) => {
    const lines = [];
    let line = "";
    for (const word of para.split(" ")) {
      if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    return [...lines, line];
  });
  return [
    ...wrap(command).map((l) => `   │ ${l}`),
    `   ${description}`,
    ...wrap(reason).map((l) => ` │ ${l}`),
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");
}

describe("the 29 Sep loop rm (lsrc:1)", () => {
  const screen = dialog(LSRC1_COMMAND, "Run moves 2 to 5 on fresh copies of mine and base", LSRC1_REASON);

  it("reads the whole reason and the command off the screen", () => {
    const p = detectPermissionPrompt(screen);
    expect(p.reason).toBe(LSRC1_REASON);
    expect(p.command.replace(/\s+/gu, " ")).toBe(LSRC1_COMMAND.replace(/\s+/gu, " "));
  });

  it("answers yes: the target is $S/$2 alone, and $2 is one of the loop's literal words under the scratch folder", () => {
    const decision = classifyPermissionPrompt(detectPermissionPrompt(screen), untracked);
    expect(decision).toMatchObject({ action: "answer", keys: "1" });
    expect(decision.why).toContain(`${LSRC1_SCRATCH}/p-ws1-cut,`);
    expect(decision.why).toContain(`${LSRC1_SCRATCH}/p-ws1-cut-base`);
  });

  it("reads the target alone from the newer reason for a variable assigned a literal path", () => {
    const reason = "Dangerous rm operation on possibly-empty variable path: $D/*.png in `rm -f $D/*.png` (rewrite it as \"${D:?}\" or use a literal path: when $D is empty this removes /*.png)";
    expect(classifyPermissionPrompt({ reason, command: "D=/home/adelost/lsrc/.artifacts/home-reach/conservative; rm -f $D/*.png" }, untracked).action).toBe("answer");
  });
});

describe("rm targets bound by a loop", () => {
  const loopRm = (target, command) => classifyPermissionPrompt(varRm(target, command), untracked);

  it("answers yes for a loop variable over literal words, and for $N after set -- $loopvar", () => {
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/scratchpad; for d in out 'cache' \"logs\"; do rm -rf $S/$d; done").action).toBe("answer");
    expect(loopRm("$S/$1", "set -euo pipefail; S=/tmp/claude-1000/x/scratchpad; for pair in \"a 1\" \"b 2\"; do set -- $pair; rm -rf $S/$1; done").action).toBe("answer");
  });

  it("notifies when the loop runs over a command substitution, a variable, a glob or a brace", () => {
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in $(ls); do rm -rf $S/$d; done").action).toBe("notify");
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in $LIST; do rm -rf $S/$d; done").action).toBe("notify");
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in *; do rm -rf $S/$d; done").action).toBe("notify");
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in {a,b}; do rm -rf $S/$d; done").action).toBe("notify");
  });

  it("notifies when a loop word climbs out with .., even one broken across two lines", () => {
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in a ../../../../home/adelost; do rm -rf $S/$d; done").action).toBe("notify");
    expect(loopRm("$S/$2", "S=/tmp/claude-1000/x/y; for p in \"1 .\n./../../home\"; do set -- $p; rm -rf $S/$2; done").action).toBe("notify");
  });

  it("notifies when the loop variable is also assigned, a word holds a space, or the positionals move", () => {
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in a; do d=$HOME; rm -rf $S/$d; done").action).toBe("notify");
    expect(loopRm("$S/$d", "S=/tmp/claude-1000/x/y; for d in \"a b\"; do rm -rf $S/$d; done").action).toBe("notify");
    expect(loopRm("$S/$2", "S=/tmp/claude-1000/x/y; for p in \"1 a\"; do set -- $p; shift; rm -rf $S/$2; done").action).toBe("notify");
    expect(loopRm("$S/$1", "S=/tmp/claude-1000/x/y; set -- $(cat list); rm -rf $S/$1").action).toBe("notify");
    expect(loopRm("$S/$1", "S=/tmp/claude-1000/x/y; rm -rf $S/$1").action).toBe("notify");
  });
});

describe("parsePermissionWatchdogConfig", () => {
  it("reads env with safe defaults", () => {
    // humanAgeMs: skyvw:0's order for Mattias 2026-09-15, "Mattias gets the DM only if the prompt is still open N minutes later (default 10)".
    expect(parsePermissionWatchdogConfig({})).toEqual({ enabled: true, autoAnswer: true, pollMs: 10_000, answerAgeMs: 10_000, promptAgeMs: 120_000, humanAgeMs: 600_000 });
    expect(parsePermissionWatchdogConfig({ AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER: "false", AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS: "5000" })).toMatchObject({ autoAnswer: false, promptAgeMs: 5000 });
  });
});
