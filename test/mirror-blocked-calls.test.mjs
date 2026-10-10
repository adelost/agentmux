import { expect, feature, unit } from "bdd-vitest";
import { groupIntoTurns } from "../core/jsonl-reader.mjs";

// Mattias 2026-10-10 22:18Z after "Delegate to fork" in #api-0, a fork the guard had refused: "Borde vi ändra så
// att Discord skriver ut rätt liksom så att UX:en där är på, ja, kanske på engelska men att det står att den är mer
// rätt också så att det inte förvirrar lika mycket i framtiden."
const FORK_GUARD = `p=$(cat); case "$p" in *fork*) printf '%s' "$p" | exec node "/pkg/bin/fork-guard.mjs";; esac`;
const HOTSPOT_GUARD = `p=$(cat); case "$p" in *commit*) printf '%s' "$p" | exec node "/pkg/bin/hotspot-commit-guard.mjs";; esac`;
const call = (id, name, input) => ({ type: "assistant", uuid: `a-${id}`, timestamp: "2026-10-10T22:12:00.000Z",
  message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, isError) => ({ type: "user", timestamp: "2026-10-10T22:12:01.000Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const prompt = { type: "user", timestamp: "2026-10-10T22:11:00.000Z", message: { role: "user", content: "prove the ban" } };

feature("the Discord mirror shows a call a hook refused as refused", () => {
  unit("a refused fork reads as blocked with the guard's reason", {
    when: ["the real 22:12Z journal records are grouped", () => groupIntoTurns([prompt,
      call("toolu_fork", "Agent", { description: "Fork ban live test", subagent_type: "fork", prompt: "Reply OK" }),
      result("toolu_fork", `PreToolUse:Agent hook error: [${FORK_GUARD}]: BLOCKED: Forks are banned in this fleet (Mattias 2026-10-10: "vi borde väl förbjuda det helt"): a fork copies this whole session into every call of the subagent. Start a fresh subagent instead.\n`, true),
      call("toolu_fresh", "Agent", { description: "Fresh subagent live test", subagent_type: "general-purpose", prompt: "Reply OK" }),
      result("toolu_fresh", [{ type: "text", text: "Async agent launched successfully." }], undefined),
    ])],
    then: ["only the refused call is marked, in short English", ([turn]) => expect(turn.items.map((item) => item.content))
      .toEqual(["Delegate to fork · blocked: Forks are banned in this fleet", "Delegate to general-purpose"])],
  });

  unit("every hook refusal is marked, not only forks", {
    when: ["a commit the hotspot guard refused is grouped", () => groupIntoTurns([prompt,
      call("toolu_commit", "Bash", { command: "git commit -m x", description: "Commit the fix" }),
      result("toolu_commit", `PreToolUse:Bash hook error: [${HOTSPOT_GUARD}]: BLOCKED: /home/adelost/lsrc/pl4n Hotspot reflection needed (a function has 6+ trunk commits).`, true),
    ])],
    then: ["the reason drops the path", ([turn]) => expect(turn.items[0].content).toMatch(/ · blocked: Hotspot reflection needed$/u)],
  });

  unit("an ordinary failed command is not called blocked", {
    when: ["a command that exited non-zero is grouped", () => groupIntoTurns([prompt,
      call("toolu_fail", "Bash", { command: "false", description: "Fail" }),
      result("toolu_fail", "Exit code 1", true),
    ])],
    then: ["its label is unchanged", ([turn]) => expect(turn.items[0].content).not.toContain("blocked")],
  });
});
