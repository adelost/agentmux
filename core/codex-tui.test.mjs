import { feature, unit, expect } from "bdd-vitest";
import {
  clearCodexComposerDraft,
  confirmCodexDraftReleased,
  codexComposerContainsPrompt,
  codexComposerEndsWithPrompt,
  codexComposerHasPasteBlock,
  codexComposerMatchesOwnedDraft,
  codexComposerText,
  isCodexBacktrackPager,
  isCodexFullscreenPager,
  isCodexTranscriptView,
  prepareCodexIdle,
  rescueCodexSubmitIfConfirmed,
  shouldRescueCodexSubmit,
  verifiedEmptyCodexComposer,
} from "./codex-tui.mjs";

function fakeAgent({ frames, busy = false, busyError = null }) {
  let index = 0;
  const keys = [];
  return {
    keys,
    isBusy: async () => {
      if (busyError) throw busyError;
      return busy;
    },
    capturePane: async () => frames[Math.min(index++, frames.length - 1)],
    sendEscape: async () => keys.push("<esc>"),
    sendTab: async () => keys.push("<tab>"),
    typeLiteral: async (_name, value) => keys.push(value),
  };
}

const noSleep = () => Promise.resolve();

feature("Codex composer truth", () => {
  unit("exact rotating placeholders count as an empty composer", {
    when: ["reading Codex 0.144.x's exact placeholder inventory", () => [
      "Explain this codebase",
      "Summarize recent commits",
      "Implement {feature}",
      "Find and fix a bug in @filename",
      "Write tests for @filename",
      "Improve documentation in @filename",
      "Run /review on my current changes",
      "Use /skills to list available skills",
      "Check recently modified functions for compatibility",
      "How many files have been modified?",
      "Will this algorithm scale well?",
    ].map((hint) => codexComposerText(`\n› ${hint}\n  gpt-5.6-sol xhigh · ~/x\n`))],
    then: ["all normalize to empty", (values) => expect(values).toEqual(Array(11).fill(""))],
  });

  unit("cursor-painted cells in an exact rotating placeholder still count as empty", {
    given: ["the live claw:11 capture that blocked v1.21.2 delivery", () =>
      "\n› Impr─ve d─cumentation i──@filename\n  gpt-5.6-sol max · ~/x\n"],
    when: ["reading the composer", (snapshot) => codexComposerText(snapshot)],
    then: ["the four transient paint cells do not become a fake human draft", (value) =>
      expect(value).toBe("")],
  });

  unit("ordinary edits and heavily corrupted text never impersonate a placeholder", {
    when: ["reading non-Codex-owned drafts", () => [
      codexComposerText("\n› Improve docs in @filename\n"),
      codexComposerText("\n› ─────── documentation in @filename\n"),
    ]],
    then: ["both drafts are preserved", (values) =>
      expect(values).toEqual(["Improve docs in @filename", "─────── documentation in @filename"])],
  });

  unit("a human draft is preserved as non-empty", {
    when: ["reading a draft", () => verifiedEmptyCodexComposer("\n› please keep this draft\n")],
    then: ["the draft is returned", (value) => expect(value).toBe("please keep this draft")],
  });

  unit("a historical › user cell followed by an assistant bullet is not a draft", {
    when: ["reading replayed transcript without a composer", () => codexComposerText(`
› [from ai:3]
  claim text

• Ingen WIP-kollision.
`)],
    then: ["no composer is reported", (value) => expect(value).toBeNull()],
  });

  unit("the exact post-turn Escape receipt proves neutral state", {
    when: ["reading a composerless idle receipt", () =>
      verifiedEmptyCodexComposer("\nanswer\n\nesc again to edit previous message\n")],
    then: ["it is empty", (value) => expect(value).toBe("")],
  });

  unit("narrow-pane cursor paint inside the idle receipt is tolerated", {
    when: ["reading the observed editoprevious capture", () =>
      verifiedEmptyCodexComposer("\nanswer\n\nesc again to editoprevious message\n")],
    then: ["it is still the exact neutral receipt", (value) => expect(value).toBe("")],
  });

  unit("fresh session's no-previous-message receipt is neutral", {
    when: ["reading Codex's fresh-session Escape response", () =>
      verifiedEmptyCodexComposer("\n• No previous message to edit.\n")],
    then: ["it is empty", (value) => expect(value).toBe("")],
  });

  unit("an old neutral receipt in scrollback does not hide a missing live composer", {
    when: ["reading a stale startup receipt followed by later output", () =>
      verifiedEmptyCodexComposer(`
• No previous message to edit.
• Ran tests
  └ green
• Wrote summary
  more output
  final output
  cursor debris
`)],
    then: ["composer state stays unknown so the idle reveal gate can act", (value) =>
      expect(value).toBeNull()],
  });

  unit("the full-screen transcript viewer is not mistaken for a historical draft", {
    given: ["Codex transcript chrome", () => `
› old prompt
• old answer
/ T R A N S C R I P T /
q to quit   esc/← to edit prev
`],
    when: ["detecting", (text) => ({ view: isCodexTranscriptView(text), composer: codexComposerText(text) })],
    then: ["view is explicit and composer unknown", (result) => {
      expect(result).toEqual({ view: true, composer: null });
    }],
  });

  unit("submit rescue accepts an exact idle draft or Codex's explicit busy queue editor", {
    given: ["the same draft in idle, generic busy, queued, and historical screens", () => ({
      prompt: "[krasch-recovery] återuppta",
      draft: "\n› [krasch-recovery] återuppta\n",
      queue: "\n› [krasch-recovery] återuppta\n\n  tab to queue message 42% context left\n",
      history: "\n› [krasch-recovery] återuppta\n• Working (2s)\n",
    })],
    when: ["evaluating rescue safety", ({ prompt, draft, queue, history }) => [
      shouldRescueCodexSubmit({ snapshot: draft, prompt, busy: false }),
      shouldRescueCodexSubmit({ snapshot: draft, prompt, busy: true }),
      shouldRescueCodexSubmit({ snapshot: queue, prompt, busy: true }),
      shouldRescueCodexSubmit({ snapshot: queue, prompt: `${prompt} annan`, busy: true }),
      shouldRescueCodexSubmit({ snapshot: history, prompt, busy: false }),
    ]],
    then: ["only an exact live submit surface may receive Enter", (result) =>
      expect(result).toEqual([true, false, true, false, false])],
  });

  unit("a long paste block receives one busy queue rescue", {
    given: ["Codex's collapsed atomic paste inside the queue editor", () => ({
      prompt: "x".repeat(900),
      snapshot: "\n› [Pasted Content 900 chars]\n\n  tab to queue message 38% context left\n",
    })],
    when: ["checking the busy submit gate", ({ prompt, snapshot }) => ({
      queued: shouldRescueCodexSubmit({ snapshot, prompt, busy: true }),
      genericBusy: shouldRescueCodexSubmit({
        snapshot: "\n› [Pasted Content 900 chars]\n",
        prompt,
        busy: true,
      }),
    })],
    then: ["only the explicit queue editor earns Enter", (result) =>
      expect(result).toEqual({ queued: true, genericBusy: false })],
  });

  unit("one stuck frame followed by a cleared composer never earns rescue Enter", {
    given: ["a torn post-submit repaint", () => {
      const prompt = "send this once";
      const frames = [
        { snapshot: `\n› ${prompt}\n`, busy: false },
        { snapshot: "\n› Explain this codebase\n", busy: false },
      ];
      let index = 0;
      let rescues = 0;
      return {
        prompt,
        observe: async () => frames[Math.min(index++, frames.length - 1)],
        submitted: async () => false,
        rescue: async () => { rescues++; },
        get rescues() { return rescues; },
      };
    }],
    when: ["confirming the suspected stuck draft", (ctx) =>
      rescueCodexSubmitIfConfirmed({ ...ctx, sleep: noSleep })],
    then: ["the repaint clears without an extra Enter", (result, ctx) => {
      expect(result).toEqual({ rescued: false, via: "torn-repaint" });
      expect(ctx.rescues).toBe(0);
    }],
  });

  unit("fresh JSONL wins after two stuck-looking frames", {
    given: ["two matching frames while the user event becomes durable", () => {
      const prompt = "already submitted";
      let jsonlChecks = 0;
      let rescues = 0;
      return {
        prompt,
        observe: async () => ({ snapshot: `\n› ${prompt}\n`, busy: false }),
        submitted: async () => ++jsonlChecks >= 2,
        rescue: async () => { rescues++; },
        get rescues() { return rescues; },
      };
    }],
    when: ["checking durable evidence immediately before intervention", (ctx) =>
      rescueCodexSubmitIfConfirmed({ ...ctx, sleep: noSleep })],
    then: ["no rescue is sent through the torn pane", (result, ctx) => {
      expect(result).toEqual({ rescued: false, via: "jsonl" });
      expect(ctx.rescues).toBe(0);
    }],
  });

  unit("two stable stuck frames with no JSONL evidence earn one rescue", {
    given: ["a genuinely unsubmitted exact draft", () => {
      const prompt = "press enter again";
      let rescues = 0;
      return {
        prompt,
        observe: async () => ({ snapshot: `\n› ${prompt}\n`, busy: false }),
        submitted: async () => false,
        rescue: async () => { rescues++; },
        get rescues() { return rescues; },
      };
    }],
    when: ["confirming twice before intervention", (ctx) =>
      rescueCodexSubmitIfConfirmed({ ...ctx, sleep: noSleep })],
    then: ["exactly one rescue Enter is allowed", (result, ctx) => {
      expect(result).toEqual({ rescued: true, via: "confirmed-stuck" });
      expect(ctx.rescues).toBe(1);
    }],
  });

  unit("an idle atomic paste cannot become submitted from one torn empty frame", {
    given: ["a long owned prompt whose collapsed paste block repaints after Enter", () => {
      let observations = 0;
      let waits = 0;
      return {
        prompt: "x".repeat(1_400),
        initiallyComposed: false,
        submitted: async () => false,
        observeComposed: async () => { observations++; return true; },
        sleep: async () => { waits++; },
        counts: () => ({ observations, waits }),
      };
    }],
    when: ["confirming the apparent submit before releasing the durable FIFO", (ctx) =>
      confirmCodexDraftReleased(ctx)],
    then: ["the resurfaced draft remains owned and receives no submitted receipt", (result, ctx) => {
      expect(result).toEqual({ released: false, via: "resurfaced" });
      expect(ctx.counts()).toEqual({ observations: 1, waits: 1 });
    }],
  });

  unit("two empty atomic-paste observations or fresh JSONL can prove submit", {
    given: ["one confirmed-empty path and one receipt that lands during settlement", () => {
      let emptyLooks = 0;
      let jsonlChecks = 0;
      return {
        prompt: "y".repeat(1_400),
        empty: {
          initiallyComposed: false,
          submitted: async () => false,
          observeComposed: async () => { emptyLooks++; return false; },
          sleep: noSleep,
        },
        jsonl: {
          initiallyComposed: false,
          submitted: async () => ++jsonlChecks >= 2,
          observeComposed: async () => { throw new Error("JSONL should avoid a second pane read"); },
          sleep: noSleep,
        },
        counts: () => ({ emptyLooks, jsonlChecks }),
      };
    }],
    when: ["confirming both authoritative submit paths", async ({ prompt, empty, jsonl }) => [
      await confirmCodexDraftReleased({ prompt, ...empty }),
      await confirmCodexDraftReleased({ prompt, ...jsonl }),
    ]],
    then: ["both release once and the ordinary short path is untouched", (result, ctx) => {
      expect(result).toEqual([
        { released: true, via: "confirmed-empty" },
        { released: true, via: "jsonl" },
      ]);
      expect(ctx.counts()).toEqual({ emptyLooks: 1, jsonlChecks: 2 });
    }],
  });

  unit("short prompts retain the zero-wait submit fast path", {
    given: ["an ordinary one-line prompt", () => {
      let touched = false;
      return {
        prompt: "quick message",
        initiallyComposed: false,
        observeComposed: async () => { touched = true; return false; },
        submitted: async () => { touched = true; return false; },
        sleep: async () => { touched = true; },
        touched: () => touched,
      };
    }],
    when: ["confirming its already-empty composer", (ctx) => confirmCodexDraftReleased(ctx)],
    then: ["no recovery observation or wait is added", (result, ctx) => {
      expect(result).toEqual({ released: true, via: "single-empty" });
      expect(ctx.touched()).toBe(false);
    }],
  });

  unit("composer identity rejects recovery prompts that share only a short prefix", {
    given: ["two pane-specific recovery prompts", () => ({
      current: "[krasch-recovery] Värden startade om 15:14 mitt i din pågående turn (din prompt 15:06 fick aldrig avslut).",
      incoming: "[krasch-recovery] Värden startade om 15:14 mitt i din pågående turn (din prompt 15:09 fick aldrig avslut).",
    })],
    when: ["matching the incoming prompt against the stale composer", ({ current, incoming }) => ({
      exact: codexComposerContainsPrompt(`\n› ${incoming}\n`, incoming),
      stale: codexComposerContainsPrompt(`\n› ${current}\n`, incoming),
    })],
    then: ["only the full identity matches", (result) =>
      expect(result).toEqual({ exact: true, stale: false })],
  });

  unit("exact identity spans wrapped envelope paragraphs", {
    given: ["a CLI sender envelope wrapped across physical rows", () => ({
      prompt: "[from claw:9]\n\n[delivery-gate] This exact long transport prompt must be verified before Enter is sent to Codex.",
      snapshot: `
› [from claw:9]

  [delivery-gate] This exact long transport prompt must be verified before Enter is sent to Codex.

  gpt-5.6-sol max · ~/workspace/.agents/11
`,
    })],
    when: ["checking the complete normalized draft", ({ prompt, snapshot }) => ({
      text: codexComposerText(snapshot),
      exact: codexComposerContainsPrompt(snapshot, prompt),
    })],
    then: ["wrapped content is preserved without swallowing the footer", (result) => {
      expect(result.text).toBe("[from claw:9] [delivery-gate] This exact long transport prompt must be verified before Enter is sent to Codex.");
      expect(result.exact).toBe(true);
    }],
  });

  unit("busy queue chrome is excluded from the exact draft identity", {
    given: ["the live short queued-prompt shape", () => ({
      prompt: "kan jag ändå få testa..",
      snapshot: [
        "• Working (4m 22s)",
        "",
        "› kan jag ändå få testa..",
        "",
        "  tab to queue message                                 46% context left",
      ].join("\n"),
    })],
    when: ["reading and matching the composer", ({ snapshot, prompt }) => ({
      text: codexComposerText(snapshot),
      exact: codexComposerContainsPrompt(snapshot, prompt),
    })],
    then: ["only the user text remains", (result) => expect(result).toEqual({
      text: "kan jag ändå få testa..",
      exact: true,
    })],
  });

  unit("tmux-joined queue chrome is excluded from the prompt row", {
    given: ["the captureScreen -J shape seen during live recovery", () => ({
      prompt: "kan jag ändå få testa..",
      snapshot: "\n› kan jag ändå få testa.. tab to queue message                46% context left\n",
    })],
    when: ["reading and matching", ({ snapshot, prompt }) => ({
      text: codexComposerText(snapshot),
      exact: codexComposerContainsPrompt(snapshot, prompt),
    })],
    then: ["the suffix is not treated as human text", (result) => expect(result).toEqual({
      text: "kan jag ändå få testa..",
      exact: true,
    })],
  });

  unit("multiline queue footer cannot corrupt the prompt tail", {
    given: ["a wrapped long queued prompt", () => ({
      prompt: "first long instruction second exact tail",
      snapshot: [
        "› first long instruction",
        "  second exact tail",
        "",
        "  tab to queue message                               40% context left",
      ].join("\n"),
    })],
    when: ["matching the full prompt", ({ snapshot, prompt }) =>
      codexComposerContainsPrompt(snapshot, prompt)],
    then: ["the draft is exact", (matched) => expect(matched).toBe(true)],
  });

  unit("visual wrapping inside an image path does not block delivery", {
    // Live lsrc:3 capture 2026-07-13: tiled width made Ratatui split the
    // attachment id after a hyphen. The application-rendered continuation is
    // not joined by tmux -J, so the old whitespace-collapsing comparison saw
    // a different path, withheld Enter, and cleared a complete draft.
    given: ["an image prompt whose unbroken path wraps across logical rows", () => ({
      prompt: "Ser du denna bilden? =====\n[image attached: /tmp/discord-media-1526100616894742528-1526100616630374491.png]",
      snapshot: `
› Ser du denna bilden? =====
  [image attached: /tmp/discord-media-1526100616894742528-
  1526100616630374491.png]

  gpt-5.6-sol xhigh · ~/lsrc/.agents/3
`,
    })],
    when: ["checking the fully painted narrow-pane draft", ({ prompt, snapshot }) =>
      codexComposerContainsPrompt(snapshot, prompt)],
    then: ["visual whitespace inside the path is ignored", (matches) =>
      expect(matches).toBe(true)],
  });

  unit("non-whitespace identity still rejects another attachment", {
    given: ["two paths that differ only in the attachment id", () => ({
      incoming: "[image attached: /tmp/discord-media-1526100616894742528-1526100616630374491.png]",
      snapshot: "\n› [image attached: /tmp/discord-media-1526100616894742528-\n  9999999999999999999.png]\n",
    })],
    when: ["checking the wrong wrapped attachment", ({ incoming, snapshot }) =>
      codexComposerContainsPrompt(snapshot, incoming)],
    then: ["the different non-whitespace bytes do not match", (matches) =>
      expect(matches).toBe(false)],
  });

  unit("a truncated multiline head is not mistaken for the complete prompt", {
    given: ["a failed clear that left only the beginning of a long draft", () => ({
      prompt: "[from claw:3]\n\n" + "beginning ".repeat(30) + "COMPLETE_TAIL",
      snapshot: "\n› [from claw:3]\n\n  " + "beginning ".repeat(8) + "\n  gpt-5.6-sol xhigh · ~/x\n",
    })],
    when: ["checking full-prompt identity", ({ prompt, snapshot }) =>
      codexComposerContainsPrompt(snapshot, prompt)],
    then: ["prefix residue stays unverified", (matches) => expect(matches).toBe(false)],
  });

  unit("extra composer bytes never count as the exact prompt", {
    given: ["the requested prompt with stale text before and after it", () => ({
      prompt: "deliver this exact text",
      prefixed: "\n› stale prefix deliver this exact text\n",
      suffixed: "\n› deliver this exact text stale suffix\n",
    })],
    when: ["checking exact identity", ({ prompt, prefixed, suffixed }) => [
      codexComposerContainsPrompt(prefixed, prompt),
      codexComposerContainsPrompt(suffixed, prompt),
    ]],
    then: ["neither corrupted draft can be submitted", (matches) =>
      expect(matches).toEqual([false, false])],
  });

  unit("a tall atomic paste is verified by its exact visible tail", {
    // Live lsrc:3 capture 2026-07-13: the 11-line prompt head scrolled out of
    // Codex's internal composer viewport, which starts the visible draft at
    // Rad 07. The old prefix-only verifier waited 2.5 seconds, withheld Enter,
    // and then partially cleared the otherwise complete prompt.
    given: ["the observed scrolled composer and its complete source prompt", () => ({
      prompt: [
        "AMUX_LONG_HEAD transportdiagnos.",
        "Rad 02 verifierar den fullständiga atomiska nyttolasten.",
        "Rad 03 alpha bravo charlie delta echo foxtrot.",
        "Rad 04 juliet kilo lima mike november oscar.",
        "Rad 05 sierra tango uniform victor whiskey xray.",
        "Rad 06 början har nu rullat ut ur vyn.",
        "Rad 07 testar att transporten fortfarande kan bevisa att hela den atomiska pasten kom fram.",
        "Rad 08 får aldrig blandas med en gammal lokal draft och Enter får bara skickas efter verifiering.",
        "Rad 09 gör nyttolasten tillräckligt lång för att reproducera det verkliga Discord-felet.",
        "Rad 10 är näst sista raden och har kontrollorden citron granit midnatt kobolt sextant.",
        "AMUX_LONG_TAIL fullständig atomisk nyttolast slutmarkör.",
      ].join("\n"),
      snapshot: `
› Rad 07 testar att transporten fortfarande kan bevisa att hela den
  atomiska pasten kom fram.
  Rad 08 får aldrig blandas med en gammal lokal draft och Enter får
  bara skickas efter verifiering.
  Rad 09 gör nyttolasten tillräckligt lång för att reproducera det
  verkliga Discord-felet.
  Rad 10 är näst sista raden och har kontrollorden citron granit
  midnatt kobolt sextant.
  AMUX_LONG_TAIL fullständig atomisk nyttolast slutmarkör.

  gpt-5.6-sol xhigh · ~/lsrc/.agents/3
`,
    })],
    when: ["checking full visibility and the atomic tail receipt", ({ prompt, snapshot }) => ({
      full: codexComposerContainsPrompt(snapshot, prompt),
      tail: codexComposerEndsWithPrompt(snapshot, prompt),
      wrong: codexComposerEndsWithPrompt(snapshot, `${prompt} CORRUPTED`),
      rescue: shouldRescueCodexSubmit({ snapshot, prompt, busy: false }),
      busyRescue: shouldRescueCodexSubmit({ snapshot, prompt, busy: true }),
    })],
    then: ["only the exact tail proves the scrolled paste", (result) =>
      expect(result).toEqual({
        full: false,
        tail: true,
        wrong: false,
        rescue: true,
        busyRescue: false,
      })],
  });

  unit("a durable atomic draft can recover from one long interior viewport", {
    given: ["an immutable source whose head and tail are both scrolled away", () => {
      const head = "BEGIN " + "alpha ".repeat(80);
      const middle = "OWNED_INTERIOR " + "bravo charlie delta ".repeat(18);
      const tail = " omega".repeat(80) + " END";
      return {
        prompt: `${head}${middle}${tail}`,
        snapshot: `\n› ${middle}\n\n  tab to queue message 38% context left\n`,
      };
    }],
    when: ["matching only after durable ownership exists", ({ prompt, snapshot }) => ({
      initialExact: codexComposerContainsPrompt(snapshot, prompt),
      initialTail: codexComposerEndsWithPrompt(snapshot, prompt),
      owned: codexComposerMatchesOwnedDraft(snapshot, prompt),
    })],
    then: ["the recovery-only identity accepts the exact interior window", (result) =>
      expect(result).toEqual({ initialExact: false, initialTail: false, owned: true })],
  });

  unit("owned-draft recovery rejects residue and concatenated copies", {
    given: ["one long source plus unsafe composer variants", () => {
      const prompt = "BEGIN " + "safe payload ".repeat(90) + " END";
      return {
        prompt,
        shortResidue: `\n› ${prompt.slice(0, 100)}\n`,
        duplicated: `\n› ${prompt}${prompt}\n`,
      };
    }],
    when: ["matching the unsafe variants", ({ prompt, shortResidue, duplicated }) => [
      codexComposerMatchesOwnedDraft(shortResidue, prompt),
      codexComposerMatchesOwnedDraft(duplicated, prompt),
    ]],
    then: ["neither may receive Enter", (result) => expect(result).toEqual([false, false])],
  });

  unit("multiline cleanup repeats until the composer is actually empty", {
    given: ["a long draft whose first clear exposes an earlier prefix", () => {
      const frames = [
        "\n› late rows of our draft\n  gpt-5.6-sol xhigh · ~/x\n",
        "\n› [from claw:3]\n  early rows of our draft\n  gpt-5.6-sol xhigh · ~/x\n",
        "\n› Explain this codebase\n  gpt-5.6-sol xhigh · ~/x\n",
      ];
      let captureIndex = 0;
      let clears = 0;
      return {
        get clears() { return clears; },
        capture: async () => frames[Math.min(captureIndex++, frames.length - 1)],
        clear: async () => { clears++; },
      };
    }],
    when: ["clearing with capture verification after every pass", (ctx) =>
      clearCodexComposerDraft({ ...ctx, sleep: noSleep })],
    then: ["both visible portions are removed before success", (result, ctx) => {
      expect(result).toEqual({ ok: true, passes: 2 });
      expect(ctx.clears).toBe(2);
    }],
  });

  unit("cleanup never clears a human draft that appears after empty", {
    given: ["a human types during the empty confirmation gap", () => {
      const frames = [
        "\n› stale agentmux draft\n",
        "\n› Explain this codebase\n",
        "\n› my private unsent human note\n",
      ];
      let captureIndex = 0;
      let clears = 0;
      return {
        get clears() { return clears; },
        capture: async () => frames[Math.min(captureIndex++, frames.length - 1)],
        clear: async () => { clears++; },
        ownsResurfacedDraft: async () => false,
      };
    }],
    when: ["cleanup rechecks after the first empty frame", (ctx) =>
      clearCodexComposerDraft({ ...ctx, sleep: noSleep })],
    then: ["it fails closed without touching the foreign draft", (result, ctx) => {
      expect(result).toEqual({
        ok: false,
        passes: 1,
        error: "composer changed after an empty clear observation",
      });
      expect(ctx.clears).toBe(1);
    }],
  });

  unit("cleanup remains bounded when an owned draft never clears", {
    given: ["a composer that stays non-empty", () => {
      let clears = 0;
      return {
        get clears() { return clears; },
        capture: async () => "\n› persistent owned draft\n",
        clear: async () => { clears++; },
      };
    }],
    when: ["cleanup reaches its pass cap", (ctx) =>
      clearCodexComposerDraft({ ...ctx, sleep: noSleep, maxPasses: 2 })],
    then: ["it stops instead of looping or sending another destructive key", (result, ctx) => {
      expect(result).toEqual({
        ok: false,
        passes: 2,
        error: "composer remained non-empty after bounded clear",
      });
      expect(ctx.clears).toBe(2);
    }],
  });

  unit("cleanup requires two empty frames across a torn repaint", {
    given: ["an empty-looking frame followed by resurfaced draft text", () => {
      const frames = [
        "\n› stale tail\n",
        "\n› Explain this codebase\n",
        "\n› stale prefix resurfaced\n",
        "\n› Explain this codebase\n",
        "\n› Explain this codebase\n",
      ];
      let captureIndex = 0;
      let clears = 0;
      return {
        get clears() { return clears; },
        capture: async () => frames[Math.min(captureIndex++, frames.length - 1)],
        clear: async () => { clears++; },
        ownsResurfacedDraft: async ({ composer }) => composer === "stale prefix resurfaced",
      };
    }],
    when: ["clearing through the repaint", (ctx) =>
      clearCodexComposerDraft({ ...ctx, sleep: noSleep })],
    then: ["the resurfaced prefix is cleared before two stable empty looks", (result, ctx) => {
      expect(result).toEqual({ ok: true, passes: 2 });
      expect(ctx.clears).toBe(2);
    }],
  });

  unit("cleanup fails closed when composer state cannot be captured", {
    given: ["a capture failure", () => {
      let clears = 0;
      return {
        get clears() { return clears; },
        capture: async () => { throw new Error("pane vanished"); },
        clear: async () => { clears++; },
      };
    }],
    when: ["attempting cleanup", (ctx) => clearCodexComposerDraft({ ...ctx, sleep: noSleep })],
    then: ["no blind destructive key is sent", (result, ctx) => {
      expect(result).toEqual({ ok: false, passes: 0, error: "pane vanished" });
      expect(ctx.clears).toBe(0);
    }],
  });

  unit("cleanup never treats a missing composer as proof of an empty one", {
    given: ["a screen with no live composer marker", () => {
      let clears = 0;
      return {
        get clears() { return clears; },
        capture: async () => "assistant output without a composer",
        clear: async () => { clears++; },
      };
    }],
    when: ["attempting cleanup", (ctx) => clearCodexComposerDraft({ ...ctx, sleep: noSleep })],
    then: ["cleanup stops without a blind key sequence", (result, ctx) => {
      expect(result).toEqual({
        ok: false,
        passes: 0,
        error: "could not identify composer while clearing",
      });
      expect(ctx.clears).toBe(0);
    }],
  });

  unit("placeholder glued to the post-Esc idle hint reads as empty, not a draft", {
    // api:4 live (2026-07-12): one reveal-Escape left the composer showing its
    // ghost placeholder plus "esc again to edit previous message" on the next
    // row. tmux -J glued them into one value that matched no single hint, so
    // delivery reported "composer is not empty" and Escaped again into the pager.
    when: ["reading the neutral composer", () =>
      codexComposerText("\n› Use /skills todlist available skills\n\n  esc again to edit previous message\n")],
    then: ["the idle hint proves it is empty", (value) => expect(value).toBe("")],
  });

  unit("the backtrack / edit-previous pager is recognised and never a composer", {
    // claw:9 live (2026-07-12): the reveal-Escape opened Codex's full-screen
    // "edit a previous message" overlay. It has no › composer, so it must be
    // closed with q like the transcript view, not Escaped deeper.
    given: ["Codex's backtrack overlay chrome", () => [
      " ↑/↓ to scroll   pgup/pgdn to page   home/end to jump",
      " q to quit   esc/← to edit prev   → to edit next   enter to edit message──── 100% ─",
    ].join("\n")],
    when: ["detecting", (text) => ({
      pager: isCodexBacktrackPager(text),
      fullscreen: isCodexFullscreenPager(text),
      composer: codexComposerText(text),
    })],
    then: ["it is a pager to quit, not a draft", (result) =>
      expect(result).toEqual({ pager: true, fullscreen: true, composer: null })],
  });

  unit("a live composer that merely mentions quitting is not a pager", {
    when: ["detecting a normal composer draft", () =>
      isCodexBacktrackPager("\n› remember to add a q to quit hint later\n• gpt-5.6-sol xhigh · ~/x\n")],
    then: ["no edit-nav footer means no pager", (value) => expect(value).toBe(false)],
  });

  unit("a collapsed large paste is recognised so delivery can submit it", {
    // Live capture 2026-07-12: a >500-char paste renders only as the block, so
    // the exact-text check never confirms and Enter is withheld forever.
    when: ["detecting the paste block vs an ordinary draft", () => ({
      block: codexComposerHasPasteBlock("\n› [Pasted Content 1024 chars]\n  gpt-5.6-sol xhigh · ~/x\n"),
      blockWithPrefix: codexComposerHasPasteBlock("\n› f[Pasted Content 1415 chars]\n  gpt-5.6-sol xhigh · ~/x\n"),
      ordinary: codexComposerHasPasteBlock("\n› just a normal typed message\n  gpt-5.6-sol xhigh · ~/x\n"),
      empty: codexComposerHasPasteBlock("\n›\n"),
    })],
    then: ["only a real paste block matches", (r) =>
      expect(r).toEqual({ block: true, blockWithPrefix: true, ordinary: false, empty: false })],
  });
});

feature("prepareCodexIdle", () => {
  unit("idle empty pane passes without keystrokes", {
    given: ["an empty composer", () => ({ agent: fakeAgent({ frames: ["\n›\n"] }) })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["success and no Escape", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("composerless completed turn gets one verified reveal", {
    given: ["a missing composer followed by Codex's receipt", () => ({
      agent: fakeAgent({ frames: ["\ncompleted output\n", "\nesc again to edit previous message\n"] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["one Escape and success", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual(["<esc>"]);
    }],
  });

  unit("typing gate waits past a neutral receipt for the real composer", {
    given: ["resume frames where the receipt paints before input", () => ({
      agent: fakeAgent({ frames: [
        "\ncompleted output\n",
        "\n• No previous message to edit.\n",
        "\n• No previous message to edit.\n",
        "\n› Improve documentation in @filename\n",
      ] }),
    })],
    when: ["requiring a visible composer", ({ agent }) => prepareCodexIdle({
      agent, name: "claw", pane: 9, sleep: noSleep, requireVisibleComposer: true,
    })],
    then: ["it waits and succeeds only on the placeholder", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(result.snapshot).toContain("› Improve documentation");
      expect(agent.keys).toEqual(["<esc>"]);
    }],
  });

  unit("typing gate rejects a receipt when input never paints", {
    given: ["a permanently composerless receipt", () => ({
      agent: fakeAgent({ frames: [
        "\ncompleted output\n",
        "\n• No previous message to edit.\n",
      ] }),
    })],
    when: ["requiring a visible composer", ({ agent }) => prepareCodexIdle({
      agent, name: "claw", pane: 9, sleep: noSleep, requireVisibleComposer: true,
    })],
    then: ["it fails instead of typing into another TUI row", (result) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
    }],
  });

  unit("transcript viewer is closed with exact q before composer inspection", {
    given: ["transcript view followed by an empty composer", () => ({
      agent: fakeAgent({ frames: [
        "/ T R A N S C R I P T /\nq to quit   esc/← to edit prev\n",
        "\n› Explain this codebase\n",
      ] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["q exits and no Escape is sent", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual(["q"]);
    }],
  });

  unit("a pane wedged in the backtrack pager recovers with q, not Escape", {
    // The claw:9 fleet-breaker: a prior reveal-Escape parked the pane in the
    // edit-previous overlay. Every send then reported "could not identify the
    // Codex composer". prepareCodexIdle must q out of it and find the composer.
    given: ["backtrack overlay followed by the recovered composer", () => ({
      agent: fakeAgent({ frames: [
        " ↑/↓ to scroll   pgup/pgdn to page   home/end to jump\n q to quit   esc/← to edit prev   → to edit next   enter to edit message──── 100% ─\n",
        "\n› Explain this codebase\n",
      ] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["q exits the pager and no Escape wedges it deeper", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual(["q"]);
    }],
  });

  unit("busy pane fails before capture or input", {
    given: ["a working pane", () => ({ agent: fakeAgent({ frames: ["\n›\n"], busy: true }) })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["busy failure and no keys", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "busy" });
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("busy-safe command may proceed only when an empty composer is visible", {
    given: ["a working pane with an empty composer", () => ({
      agent: fakeAgent({ frames: ["\n› Explain this codebase\n"], busy: true }),
    })],
    when: ["checking for an official during-task slash command", ({ agent }) =>
      prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep, allowBusy: true })],
    then: ["success records that the pane was busy", (result, { agent }) => {
      expect(result).toMatchObject({ ok: true, busy: true });
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("busy-safe command never uses Escape to reveal a missing composer", {
    given: ["a working pane without a visible composer", () => ({
      agent: fakeAgent({ frames: ["\nstreaming output\n"], busy: true }),
    })],
    when: ["checking", ({ agent }) =>
      prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep, allowBusy: true })],
    then: ["it fails without interrupting", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("busy prompt opens Codex's advertised queue composer with Tab", {
    given: ["a working pane showing the queue hint, followed by its empty queue editor", () => ({
      agent: fakeAgent({
        frames: ["\n• Working\n\n  tab to queue message\n", "\n› Write tests for @filename\n"],
        busy: true,
      }),
    })],
    when: ["preparing a safe busy prompt", ({ agent }) => prepareCodexIdle({
      agent,
      name: "lsrc",
      pane: 3,
      sleep: noSleep,
      allowBusy: true,
      requireVisibleComposer: true,
    })],
    then: ["Tab opens the queue without an interrupting Escape", (result, { agent }) => {
      expect(result).toMatchObject({ ok: true, busy: true });
      expect(agent.keys).toEqual(["<tab>"]);
    }],
  });

  unit("busy prompt opens the queue while its hint is between paints", {
    given: ["a working prompt pane whose queue hint is temporarily absent", () => ({
      agent: fakeAgent({
        frames: ["\n• Working\n\nstreaming tool output\n", "\n› Write tests for @filename\n"],
        busy: true,
      }),
    })],
    when: ["preparing actual prompt input", ({ agent }) => prepareCodexIdle({
      agent,
      name: "claw",
      pane: 3,
      sleep: noSleep,
      allowBusy: true,
      requireVisibleComposer: true,
      openBusyQueue: true,
    })],
    then: ["Tab opens the non-interrupting queue immediately", (result, { agent }) => {
      expect(result).toMatchObject({ ok: true, busy: true });
      expect(agent.keys).toEqual(["<tab>"]);
    }],
  });

  unit("unknown UI fails closed after one reveal attempt", {
    given: ["no composer and no receipt", () => ({
      agent: fakeAgent({ frames: ["\nunknown\n", "\nstill unknown\n"] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["compose failure", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
      expect(agent.keys).toEqual(["<esc>"]);
    }],
  });
});

// Live incident 2026-07-14 (delivery blackhole, api:4 + ai:4): in a NARROW
// tmux pane Ratatui soft-wraps its own placeholder / idle-hint rows. Those
// wraps are application-rendered, so tmux -J cannot rejoin them; the
// continuation lands at column 0 and codexComposerText stopped collecting.
// The truncated value ("Summarize recent commit", "Find and fix a bug in @
// esc again to edit previo") matched no known placeholder and was treated as
// a human draft — delivery blocked forever (attempt→blocked, 65 min FIFO rot)
// and the usage-limit banner made the layout wrap more often.
feature("narrow-pane Ratatui wrap tolerance (delivery blackhole 2026-07-14)", () => {
  const AI4_FRAME = [
    "• You have 3 usage limit resets available. Run /usage to use one.",
    "",
    "⚠ Heads up, you have less than 10% of your weekly limit left. Run /status",
    "for a breakdown.",
    "",
    "› Summarize recent commit",
    "s",
    "",
    "  gpt-5.6-sol max · ~/lsrc/ai-dsl",
  ].join("\n");

  const API4_FRAME = [
    "• You have 3 usage limit resets available. Run /",
    "usage to use one.",
    "",
    "› Find and fix a bug in @",
    "",
    "  esc again to edit previo",
    "us message",
  ].join("\n");

  unit("a wrap-truncated rotating placeholder is an empty composer", {
    when: ["reading the exact ai:4 incident frame", () => codexComposerText(AI4_FRAME)],
    then: ["the composer is verified empty", (value) => expect(value).toBe("")],
  });

  unit("placeholder plus wrap-truncated idle hint is an empty composer", {
    when: ["reading the exact api:4 incident frame", () => codexComposerText(API4_FRAME)],
    then: ["the composer is verified empty", (value) => expect(value).toBe("")],
  });

  unit("a real draft that merely resembles a placeholder still blocks", {
    when: ["reading a frame with a genuine human draft", () => codexComposerText([
      "› Summarize recent commits and also deploy everything to prod",
      "",
      "  gpt-5.6-sol max · ~/lsrc/ai-dsl",
    ].join("\n"))],
    then: ["the draft is preserved verbatim", (value) =>
      expect(value).toBe("Summarize recent commits and also deploy everything to prod")],
  });

  unit("a short real draft is never mistaken for a placeholder prefix", {
    when: ["reading a frame with a short human draft", () => codexComposerText([
      "› Summarize rec",
      "",
      "  gpt-5.6-sol max · ~/lsrc/ai-dsl",
    ].join("\n"))],
    then: ["the short draft blocks delivery", (value) => expect(value).toBe("Summarize rec")],
  });

  unit("verifiedEmptyCodexComposer accepts a tail hint wrapped mid-word", {
    when: ["reading a neutral receipt whose hint wrapped at pane width", () =>
      verifiedEmptyCodexComposer([
        "some scrollback",
        "",
        "  esc again to edit previo",
        "us message",
      ].join("\n"))],
    then: ["the receipt proves an empty composer", (value) => expect(value).toBe("")],
  });

  unit("prepareCodexIdle delivers into the exact api:4 incident frame", {
    given: ["an idle pane painted exactly like the incident", () => ({
      agent: fakeAgent({ frames: [API4_FRAME] }),
    })],
    when: ["running the prompt readiness gate", ({ agent }) => prepareCodexIdle({
      agent, name: "api", pane: 4, sleep: noSleep,
      allowBusy: true, requireVisibleComposer: true, openBusyQueue: true,
    })],
    then: ["the pane is ready instead of blocked", (result) =>
      expect(result).toMatchObject({ ok: true })],
  });
});
