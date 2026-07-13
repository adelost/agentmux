import { feature, unit, component, expect } from "bdd-vitest";
import { existsSync, readFileSync } from "fs";
import { pastePrompt, promptRequiresAtomicPaste } from "./prompt-paste.mjs";

feature("atomic prompt paste", () => {
  unit("uses paste for multiline provenance briefs and long prompts", {
    given: ["short, inter-agent, image and long prompts", () => [
      "short prompt",
      "[from claw:0]\n\nclaim respected",
      "inspect this\n[image attached: /tmp/proof.png]",
      "x".repeat(501),
    ]],
    when: ["choosing the input transport", (prompts) => prompts.map(promptRequiresAtomicPaste)],
    then: ["only input vulnerable to partial painting requires atomic paste", (choices) => {
      expect(choices).toEqual([false, true, true, true]);
    }],
  });

  component("keeps concurrent prompt payloads isolated and removes temporary files", {
    given: ["two simultaneous prompt pastes", () => {
      const loaded = [];
      const pasted = [];
      const tmux = {
        loadBuffer: async (buffer, file) => {
          await Promise.resolve();
          loaded.push({ buffer, file, content: readFileSync(file, "utf-8") });
        },
        pasteBuffer: async (buffer, target) => pasted.push({ buffer, target }),
      };
      return { loaded, pasted, tmux };
    }],
    when: ["both payloads are pasted", async (fixture) => {
      await Promise.all([
        pastePrompt({ tmux: fixture.tmux, target: "claw:.3", prompt: "first", sleep: async () => {} }),
        pastePrompt({ tmux: fixture.tmux, target: "claw:.4", prompt: "second", sleep: async () => {} }),
      ]);
      return fixture;
    }],
    then: ["each target receives its own buffer and no payload file remains", (fixture) => {
      expect(new Set(fixture.loaded.map(({ file }) => file)).size).toBe(2);
      expect(fixture.loaded.map(({ content }) => content).sort()).toEqual(["first", "second"]);
      expect(fixture.pasted).toHaveLength(2);
      expect(fixture.loaded.every(({ file }) => !existsSync(file))).toBe(true);
    }],
  });

  component("cleans up the payload when tmux paste fails", {
    given: ["a tmux adapter that rejects paste", () => {
      let file = null;
      return {
        get file() { return file; },
        tmux: {
          loadBuffer: async (_buffer, path) => { file = path; },
          pasteBuffer: async () => { throw new Error("paste failed"); },
        },
      };
    }],
    when: ["pasting", async (fixture) => {
      let error = null;
      try {
        await pastePrompt({ tmux: fixture.tmux, target: "claw:.3", prompt: "brief", sleep: async () => {} });
      } catch (cause) {
        error = cause;
      }
      return { fixture, error };
    }],
    then: ["the error is visible and the temporary file is gone", ({ fixture, error }) => {
      expect(error?.message).toBe("paste failed");
      expect(existsSync(fixture.file)).toBe(false);
    }],
  });
});
