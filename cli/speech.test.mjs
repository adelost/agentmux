import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import {
  cleanSpeechText,
  MAX_SPEECH_CHARS,
  publishSpeechEvent,
  synthesizeSpeech,
} from "./speech.mjs";

feature("explicit speech synthesis", () => {
  component("voice and text are passed as process arguments without a shell", {
    given: ["a voice containing shell syntax and formatted Swedish text", () => ({
      calls: [],
      voice: "sv-SE-Test'; touch /tmp/not-run; '",
      text: " **Hej** ",
    })],
    when: ["speech is synthesized by an injected process runner", (ctx) => {
      const speech = synthesizeSpeech(ctx.text, {
        voice: ctx.voice,
        run: (...args) => ctx.calls.push(args),
      });
      return { ...ctx, speech };
    }],
    then: ["the untrusted voice remains one argv value and cleanup removes the file directory", (ctx) => {
      const [command, args] = ctx.calls[0];
      expect(command).toBe("edge-tts");
      expect(args).toEqual([
        "--voice", ctx.voice,
        "--text", "Hej",
        "--write-media", ctx.speech.mediaPath,
      ]);
      const tempDir = ctx.speech.mediaPath.slice(0, -"/speech.mp3".length);
      ctx.speech.cleanup();
      expect(existsSync(tempDir)).toBe(false);
    }],
  });

  component("spoken text has one deterministic short-message boundary", {
    given: ["markdown and more text than a mobile clip permits", () =>
      `*${"a".repeat(MAX_SPEECH_CHARS + 20)}*`],
    when: ["the text is normalized", (text) => cleanSpeechText(text)],
    then: ["formatting is removed and the result is capped", (clean) => {
      expect(clean).toHaveLength(MAX_SPEECH_CHARS);
      expect(clean).not.toContain("*");
    }],
  });

  component("a failed synthesizer cannot strand its temporary directory", {
    given: ["an isolated temporary root", () => mkdtempSync(join(tmpdir(), "amux-say-test-"))],
    when: ["the process runner writes a partial file and then fails", (tempRoot) => {
      let mediaPath;
      expect(() => synthesizeSpeech("Hej", {
        tempRoot,
        run: (_command, args) => {
          mediaPath = args.at(-1);
          writeFileSync(mediaPath, "partial");
          throw new Error("synthetic failure");
        },
      })).toThrow("edge-tts failed: synthetic failure");
      return { mediaPath, tempRoot };
    }],
    then: ["the per-call directory and partial media are gone", ({ mediaPath, tempRoot }) => {
      expect(existsSync(mediaPath)).toBe(false);
      expect(existsSync(mediaPath.slice(0, -"/speech.mp3".length))).toBe(false);
      rmSync(tempRoot, { recursive: true, force: true });
    }],
  });

  component("one explicit say publishes one target-bound event", {
    given: ["an injected outbox", () => ({
      calls: [],
      outbox: {
        publish(event) {
          this.calls?.push(event);
          return { event: { ...event, eventId: "event-1" } };
        },
      },
    })],
    when: ["the CLI speech seam publishes", (ctx) => {
      ctx.outbox.calls = ctx.calls;
      return { ctx, event: publishSpeechEvent("Hej", "channel-1", ctx.outbox) };
    }],
    then: ["exactly one event carries the resolved target", ({ ctx, event }) => {
      expect(ctx.calls).toEqual([{
        text: "Hej",
        target: { type: "discord-channel", id: "channel-1" },
      }]);
      expect(event.eventId).toBe("event-1");
    }],
  });
});
