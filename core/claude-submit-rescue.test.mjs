import { unit, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir } from "./claude-paths.mjs";
import { captureClaudePromptEchoCursor } from "./jsonl-reader.mjs";
import { createClaudeSubmitRescue } from "./claude-submit-rescue.mjs";

const PROMPT = "deploy the fix to the test account";
const PANE_DIR = "/fake/lsrc/.agents/3";
const promptEvent = (uuid) => `${JSON.stringify({ uuid, timestamp: new Date().toISOString(), type: "user", message: { content: PROMPT } })}\n`;

/** A pane whose journal already holds the same prompt from an earlier turn, and the cursor this send fixed before its paste. */
function paneThatSentThisPromptBefore() {
  const home = mkdtempSync(join(tmpdir(), "amux-submit-rescue-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
  const journal = join(claudeProjectDir(PANE_DIR, home), "session-1.jsonl");
  mkdirSync(claudeProjectDir(PANE_DIR, home), { recursive: true });
  writeFileSync(journal, promptEvent("earlier-turn"));
  const echoCursor = captureClaudePromptEchoCursor(PANE_DIR, PROMPT);
  const cleanup = () => { process.env.HOME = origHome; rmSync(home, { recursive: true, force: true }); };
  return { journal, echoCursor, cleanup };
}

/** The rescue around a composer that still shows the pasted prompt; `onEnter` is what Claude does with each Enter. */
function rescueOverStuckPaste(onEnter) {
  return createClaudeSubmitRescue({
    t: { sendEnter: async () => onEnter() },
    wait: async () => {},
    paneDir: () => PANE_DIR,
    agentConfig: () => ({ dir: "/fake/lsrc" }),
    paneDialectName: () => "claude",
    isBusy: async () => false,
    capturePane: async () => `> ${PROMPT}`,
  });
}

unit("an earlier identical prompt does not count as this send having landed", {
  given: ["a journal holding the same prompt from an earlier turn, and a paste Claude never submits", () => {
    const ctx = paneThatSentThisPromptBefore();
    ctx.enters = 0;
    ctx.rescue = rescueOverStuckPaste(() => { ctx.enters += 1; });
    return ctx;
  }],
  when: ["the rescue checks after Enter", async (ctx) => {
    await ctx.rescue("lsrc", 3, "lsrc:.3", PROMPT, { echoCursor: ctx.echoCursor });
    return ctx.enters;
  }],
  then: ["it presses Enter on both attempts", (enters, { cleanup }) => {
    expect(enters).toBe(2);
    cleanup();
  }],
});

unit("the prompt landing after the cursor stops the rescue", {
  given: ["a journal holding the same prompt from an earlier turn, and a paste Claude submits on the first Enter", () => {
    const ctx = paneThatSentThisPromptBefore();
    ctx.enters = 0;
    ctx.rescue = rescueOverStuckPaste(() => { ctx.enters += 1; appendFileSync(ctx.journal, promptEvent("this-send")); });
    return ctx;
  }],
  when: ["the rescue checks after Enter", async (ctx) => {
    await ctx.rescue("lsrc", 3, "lsrc:.3", PROMPT, { echoCursor: ctx.echoCursor });
    return ctx.enters;
  }],
  then: ["it presses Enter once", (enters, { cleanup }) => {
    expect(enters).toBe(1);
    cleanup();
  }],
});
