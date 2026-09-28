import { feature, unit, expect } from "bdd-vitest";
import { eraseKeys, submitCheckOrErase } from "./delivery-fence.mjs";

feature("a refused maintenance submit erases its own command", () => {
  unit("erase keys match the typed characters", {
    when: ["building keys for /compact and a two-emoji text", () => [eraseKeys("/compact"), eraseKeys("🦀🦀")]],
    then: ["one backspace per character", ([compact, emoji]) => {
      expect(compact.split(" ")).toEqual(Array(8).fill("BSpace"));
      expect(emoji).toBe("BSpace BSpace");
    }],
  });

  unit("a passing check erases nothing", {
    when: ["the check passes", async () => {
      const erased = [];
      await submitCheckOrErase(async () => {}, async () => erased.push("erased"));
      return erased;
    }],
    then: ["the typed command stays for Enter", (erased) => expect(erased).toEqual([])],
  });

  unit("a refusing check erases and still fails", {
    when: ["the check refuses", async () => {
      const erased = [];
      const error = await submitCheckOrErase(async () => { throw new Error("state-changed"); },
        async () => erased.push("erased")).catch((caught) => caught.message);
      return { erased, error };
    }],
    then: ["the command is erased and the refusal is reported", ({ erased, error }) => {
      expect(erased).toEqual(["erased"]);
      expect(error).toBe("state-changed");
    }],
  });

  unit("a failed erase is named in the refusal", {
    when: ["the erase itself fails", () => submitCheckOrErase(
      async () => { throw new Error("state-changed"); },
      async () => { throw new Error("tmux gone"); },
    ).catch((caught) => caught.message)],
    then: ["both causes are visible", (message) => expect(message).toBe("state-changed; typed command not erased: tmux gone")],
  });
});
