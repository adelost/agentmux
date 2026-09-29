import { describe, expect, it } from "vitest";
import { formatRmRefusal, stoppingRmTargets } from "./rm-target-guard.mjs";

const targets = (command) => stoppingRmTargets(command).map((f) => f.target);

describe("stoppingRmTargets", () => {
  // The commands that stopped panes: lsrc:1 2026-09-29, lsrc:0 2026-09-12, skyvw:2 2026-09-13, claw:0 2026-09-14.
  it("finds the targets that stopped panes, with the form the check accepts", () => {
    const [lsrc1] = stoppingRmTargets('S=/tmp/x/scratchpad/a23; for pair in "8865 p-ws1-cut v2"; do set -- $pair; rm -rf $S/$2; $S/make_copy.sh $S/$2; done');
    expect(lsrc1).toMatchObject({ target: "$S/$2", rewrite: '"${S:?}"/$2' });
    expect(stoppingRmTargets('Q=/mnt/q/x; rm -f "$Q"/*.md "$Q"/traningsdata.json && python3 export_review.py "$Q"')[0])
      .toMatchObject({ target: '"$Q"/*.md', rewrite: '"${Q:?}"/*.md' });
    expect(targets("D=/home/adelost/lsrc/.artifacts/x; rm -f $D/*.png\n$ADB shell am broadcast")).toEqual(["$D/*.png"]);
    expect(targets("cd /home/adelost/.openclaw/workspace/.agents/0 && rm -rf reply-audio/* && ls reply-audio | wc -l")).toEqual(["reply-audio/*"]);
  });

  it("finds them inside loops, groups, sudo, sh -c and after a newline", () => {
    expect(targets("for d in a b; do rm -rf ${OUT}/$d; done")).toEqual(["${OUT}/$d"]);
    expect(targets("{ sudo rm -rf $X/*; }")).toEqual(["$X/*"]);
    expect(targets("bash -c 'rm -rf $1/*' _ /tmp/y")).toEqual(["$1/*"]);
    expect(targets("echo start\nrm -r -- $T/")).toEqual(["$T/"]);
    expect(targets("rm -rf $(find . -name '*.tmp')")).toEqual(["$(find . -name '*.tmp')"]);
  });

  it("leaves what the check accepts: guarded, literal, a literal after the variable, no rm", () => {
    expect(targets('rm -rf "${S:?}"/$2 "${D:?}/x"')).toEqual([]);
    expect(targets("rm -rf /tmp/claude-1000/x/scratchpad/a23/p-ws1-cut")).toEqual([]);
    expect(targets('rm -rf "$TMPDIR"/build $HOME/.cache/x')).toEqual([]);
    expect(targets("rm -f *.o build/*.o")).toEqual([]);
    expect(targets('echo "rm -rf $X/*"; git commit -m "rm -rf $Y/"')).toEqual([]);
    expect(targets("npm run rm-cache -- --dir $X/")).toEqual([]);
  });

  it("does not read a heredoc body or a comment as commands", () => {
    expect(targets("cat > s.sh <<'EOF'\nrm -rf $X/*\nEOF\nbash s.sh")).toEqual([]);
    expect(targets("python3 - <<EOF\nimport os; os.system('rm -rf $X/')\nEOF")).toEqual([]);
    expect(targets("# rm -rf $X/*\nls")).toEqual([]);
  });

  it("tells the agent nothing ran and what to write instead", () => {
    const text = formatRmRefusal(stoppingRmTargets("rm -rf $S/$2"));
    expect(text).toContain("Nothing ran.");
    expect(text).toContain('$S/$2 as "${S:?}"/$2');
  });
});
