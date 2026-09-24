import { component, expect, feature } from "bdd-vitest";
import { findBlockingPrompt } from "./dismiss.mjs";

const activeSafetyReview = `
Additional safety checks
This request requires additional safety checks, which can take extra time.

› 1. Retry with a faster model
  2. Keep waiting
  3. Learn more

Press enter to confirm or esc to go back
`;


// Captured from api:0 on 2026-09-14: a fresh project directory stopped every
// Discord and Link message because this menu preselects "No, exit".
const workspaceTrustMenu = `
────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/adelost/lsrc/decl-worker-api/.agents/0

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open
 source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const codexUpdateMenu = `
  Update available! 0.155.1 -> 0.156.1
› 1. Update now (runs npm install)
  2. Skip
  3. Skip until next version
  Press enter to continue
`;

const pausedGoalMenu = `
  Resume paused goal?
  Goal: Sample task, currently paused
› 1. Resume goal   Mark it active and continue when idle
  2. Leave paused  Keep it paused; use /goal resume later
  Press enter to confirm or esc to go back
`;

feature("blocking prompt recognition", () => {
  component("Codex startup skips an update without installing it", {
    when: ["the update menu is active", () => findBlockingPrompt(codexUpdateMenu)],
    then: ["Skip, not Update now, is selected", prompt =>
      expect(prompt).toMatchObject({ name: "codex-update", keys: "Down Enter" })],
  });
  component("Codex startup preserves an existing paused goal", {
    when: ["the goal resume menu is active", () => findBlockingPrompt(pausedGoalMenu)],
    then: ["Leave paused is selected", prompt =>
      expect(prompt).toMatchObject({ name: "codex-paused-goal", keys: "Down Enter" })],
  });
  component("an old goal menu in scrollback cannot activate navigation", {
    when: ["the menu is followed by a real composer", () => findBlockingPrompt(
      `${pausedGoalMenu}\n› Ask Codex to do anything\n`,
    )],
    then: ["no menu action is inferred", prompt => expect(prompt).toBeNull()],
  });
  component("additional safety review keeps waiting without changing model", {
    when: ["the exact active provider menu is visible", () => findBlockingPrompt(activeSafetyReview)],
    then: ["the non-bypass continuation choice is selected", (prompt) => {
      expect(prompt).toMatchObject({
        name: "additional-safety-check",
        keys: "Down Enter",
      });
    }],
  });

  component("stale safety prose never receives navigation keys", {
    when: ["the old menu is followed by a real composer", () => findBlockingPrompt(
      `${activeSafetyReview}\n› write a new request\n`,
    )],
    then: ["no active blocker is inferred from scrollback", (prompt) => {
      expect(prompt).toBeNull();
    }],
  });
  component("a new pane's workspace trust menu moves off the preselected exit and trusts its own folder", {
    when: ["the menu is active with No, exit selected", () => findBlockingPrompt(workspaceTrustMenu)],
    then: ["the cursor moves down to trust before confirming", (prompt) => {
      expect(prompt).toMatchObject({ name: "workspace-trust", keys: "Down Enter" });
    }],
  });

  component("a trust menu already on trust is confirmed as it stands", {
    when: ["the cursor is on Yes", () => findBlockingPrompt(
      workspaceTrustMenu.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust this folder", "❯ Yes, I trust this folder"),
    )],
    then: ["only Enter is sent", (prompt) => {
      expect(prompt).toMatchObject({ name: "workspace-trust", keys: "Enter" });
    }],
  });

  component("an old trust menu in scrollback above a shell gets no keys", {
    when: ["the pane has returned to its shell", () => findBlockingPrompt(
      `${workspaceTrustMenu}adelost@Abyss:~/lsrc/decl-worker-api/.agents/0$\n`,
    )],
    then: ["no blocker is inferred", (prompt) => {
      expect(prompt).toBeNull();
    }],
  });
});
