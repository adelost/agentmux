import { component, expect, feature } from "bdd-vitest";
import { findBlockingPrompt } from "./dismiss.mjs";
import { readFileSync } from "node:fs";

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

// Codex 0.162.1, skydive:3 on the second account, 2026-10-15.
const folderAccessMenu = `
  Folder access
  /project/.agents/3
  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:
  /project
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
  Folder settings can run code automatically, even without a model request.
  Continue only if you trust these files. Your trust decision will be saved.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit
`;

// Captured from lsrc:3 on 2026-10-11 (Codex 0.162.1), goal text replaced.
// The menu is an overlay above the composer: transcript text bleeds into its
// left margin, and the hint sits above the composer instead of at the bottom.
// Every /model switch restarted into this menu and rolled back.
const pausedGoalOverlay = `
  [amux orientation, memory 34502aefdc64d878]
  Befo                                                                        ant
  sect  Resume paused goal?                                                   ive
  old   Goal: Finish the first sellable release within the agreed scope,
        use the other panes where they help, write pseudocode before each
        change, and verify polish, performance and stability until every
■ You’  agreed criterion holds and the rating is at least nine out of ten.    chase
more c  Finish the remaining safe work and the customer trial, verify the
        rollout within the existing mandate, and keep real operator or key
• Cont  blockers apart from finished work. No invented ratings, no wider
        payment mandate, and no features outside the first release.
  Work  This goal text runs as long as the real one did.

• Cont
      › 1. Resume goal   Mark it active and continue when idle
  Work  2. Leave paused  Keep it paused; use /goal resume later

        enter select · esc back
› Ask Codex to do anything

  GPT-6-Astra xhigh · ~/lsrc/.agents/3 · Uppg… Goal hit usage limits (/goal resume)
  ? for shortcuts                                           ⚠ 1 warning · f2 to view
`;

feature("blocking prompt recognition", () => {
  component("the current Codex folder menu accepts its selected trust option", {
    when: ["the configured folder's trust menu is the active screen", () => findBlockingPrompt(folderAccessMenu)],
    then: ["only Enter is sent, never the quitting Escape", prompt =>
      expect(prompt).toMatchObject({ name: "trust-directory", keys: "Enter" })],
  });
  component("the current Codex folder menu moves off Quit before accepting", {
    when: ["Quit is selected", () => findBlockingPrompt(folderAccessMenu
      .replace("› 1.", "  1.").replace("  2.", "› 2."))],
    then: ["trust is selected before Enter", prompt =>
      expect(prompt).toMatchObject({ name: "trust-directory", keys: "Up Enter" })],
  });
  component("historical folder access text receives no trust action", {
    when: ["a composer or shell follows the old menu", () => [
      `${folderAccessMenu}\n› Ask Codex to do anything\n`,
      `${folderAccessMenu}\nuser@host:~/project$\n`,
      folderAccessMenu.replace("› 1.", "  1."),
    ].map(findBlockingPrompt)],
    then: ["the recognizer requires an active menu and a known selection", prompts =>
      expect(prompts).toEqual([null, null, null])],
  });
  component("Codex 0.162's overlay goal menu is left paused", {
    when: ["the overlay menu sits above the composer", () => findBlockingPrompt(pausedGoalOverlay)],
    then: ["Leave paused is selected", prompt =>
      expect(prompt).toMatchObject({ name: "codex-paused-goal", keys: "Down Enter" })],
  });
  component("an overlay goal menu already on Leave paused is confirmed", {
    when: ["the cursor is on option 2", () => findBlockingPrompt(pausedGoalOverlay
      .replace("      › 1. Resume goal", "        1. Resume goal")
      .replace("  Work  2. Leave paused", "  Work› 2. Leave paused"))],
    then: ["only Enter is sent", prompt =>
      expect(prompt).toMatchObject({ name: "codex-paused-goal", keys: "Enter" })],
  });
  component("an overlay goal menu with a newer turn below it gets no keys", {
    when: ["a prompt and its work follow the old menu", () => findBlockingPrompt(pausedGoalOverlay.replace(
      "› Ask Codex to do anything\n",
      "› fix the build\n\n• Working (5s • esc to interrupt)\n\n• Ran npm test\n\n› Ask Codex to do anything\n",
    ))],
    then: ["no menu action is inferred", prompt => expect(prompt).toBeNull()],
  });
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


// Codex 0.163.0: composer and option 2 share a row; the hint shares status.
// The private captured frame can replace this deidentified structural fixture.
const currentGoalOverlay = process.env.AMUX_PAUSED_GOAL_CAPTURE
  ? JSON.parse(readFileSync(process.env.AMUX_PAUSED_GOAL_CAPTURE, "utf8")).frame
  : ["  >_ OpenAI Codex", "  prior text  Resume paused goal?",
    ...Array.from({ length: 24 }, () => "              Goal: previously paused work"),
    "                    › 1. Resume goal   Mark it active and continue when idle",
    "› Ask Codex to do an  2. Leave paused  Keep it paused; use /goal resume later",
    "  GPT-6.1-Sol xhigh   enter select · esc back                  led (/goal resume)",
    "  ? for shortcuts                                         ⚠ 2 warnings · f2 to view"].join("\n");

feature("Codex 0.163 mixed startup overlay", () => {
  component("the captured menu leaves the existing goal paused", {
    when: ["the composer is before the mixed status hint", () => findBlockingPrompt(currentGoalOverlay)],
    then: ["only the Leave paused navigation is selected", prompt =>
      expect(prompt).toMatchObject({ name: "codex-paused-goal", keys: "Down Enter" })],
  });
  component("the mixed menu already on Leave paused receives only Enter", {
    when: ["option two has the selection cursor", () => findBlockingPrompt(currentGoalOverlay
      .replace("› 1. Resume goal", "  1. Resume goal").replace("2. Leave paused", "› 2. Leave paused"))],
    then: ["the paused choice is confirmed", prompt => expect(prompt?.keys).toBe("Enter")],
  });
  component("a later composer, shell or work row makes the captured menu stale", {
    when: ["new input follows the old overlay", () => [
      "› Ask Codex to do anything", "› new user input", "user@host:~/project$", "• Working (2s • esc to interrupt)",
    ].map(tail => findBlockingPrompt(`${currentGoalOverlay}\n${tail}`)).concat([
      findBlockingPrompt(currentGoalOverlay.replace("› Ask Codex to do an", "› unsent private input")),
      findBlockingPrompt(pausedGoalOverlay.replace("› Ask Codex to do anything", "› unsent private input")),
    ])],
    then: ["none receives keys", prompts => expect(prompts).toEqual([null, null, null, null, null, null])],
  });
});

feature("existing Codex composer placeholders", () => {
  component("the older live overlay still accepts a known empty placeholder", {
    when: ["the composer shows the existing follow-up hint", () => findBlockingPrompt(
      pausedGoalOverlay.replace("› Ask Codex to do anything", "› Ask a follow-up question"),
    )],
    then: ["Leave paused is still the safe selection", prompt =>
      expect(prompt).toMatchObject({ name: "codex-paused-goal", keys: "Down Enter" })],
  });
});
