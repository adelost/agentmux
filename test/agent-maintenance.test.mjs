import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../agent.mjs";

feature("maintenance transport never repairs or starts a pane", () => {
  for (const failure of ["paste", "submit", "copy-mode", null]) {
    component(`existing-only transport with ${failure || "one successful submit"}`, {
      when: ["sending through the real shared agent transport", async () => {
        const root = mkdtempSync(join(tmpdir(), "amux-maintenance-"));
        const configPath = join(root, "agents.yaml");
        writeFileSync(configPath, `probe:\n  dir: ${root}\n  panes:\n    - {cmd: claude}\n`);
        const calls = [], stages = [];
        let pasted = false, submitted = false, error = null;
        const agent = createAgent({ configPath, tmuxSocket: "/unused", delay: async () => {},
          run: async () => ({ stdout: "" }),
          tmuxExec: async (command) => {
            calls.push(command);
            if (command.includes("pane_current_command")) return { stdout: "claude\n" };
            if (command.includes("pane_in_mode")) return { stdout: failure === "copy-mode" ? "1\n" : "0\n" };
            if (command.includes("capture-pane")) return { stdout: `❯ ${pasted && !submitted ? "/compact" : ""}\n────────\nOpus 5 thinking: xhigh` };
            if (/send-keys.* -l /u.test(command)) pasted = true;
            if (/send-keys.* Enter$/u.test(command)) submitted = true;
            return { stdout: "" };
          },
        });
        try {
          await agent.sendOnly("probe", "/compact", 0, { existingOnly: true,
            maintenanceGuard: async (stage) => { stages.push(stage); if (stage === failure) throw new Error(`changed-${stage}`); },
          });
        } catch (caught) { error = caught.message; }
        finally { rmSync(root, { recursive: true, force: true }); }
        return { calls, stages, error, pasted, submitted };
      }],
      then: ["it never restarts, clears, dismisses, or repeats Enter", ({ calls, stages, error, pasted, submitted }) => {
        expect(calls.some((call) => /new-session|respawn-pane|split-window|show-environment|C-u|C-c|Escape|-X cancel/u.test(call))).toBe(false);
        if (failure === "paste" || failure === "copy-mode") expect(pasted).toBe(false);
        if (failure) { expect(error).toBeTruthy(); expect(submitted).toBe(false); }
        else { expect(error).toBeNull(); expect(stages).toEqual(["paste", "submit"]); expect(submitted).toBe(true); }
        expect(calls.filter((call) => /send-keys.* Enter$/u.test(call))).toHaveLength(failure ? 0 : 1);
      }],
    });
  }
});
