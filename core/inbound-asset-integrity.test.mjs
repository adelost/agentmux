import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";

// Unit level. Guards defect 31 Oct 2026: WSL restarted minutes after a voice
// note's bytes were journaled, the durable file came back empty, and every
// retry fed that empty file to STT (164 tries, the note never arrived).
describe("a journaled attachment whose durable copy lost its bytes", () => {
  it("is downloaded again before its message is prepared", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-inbound-asset-"));
    try {
      const voice = Buffer.from("opus voice bytes");
      let downloads = 0;
      const store = createDiscordInboundStore({
        rootDir: root,
        downloadBuffer: async () => { downloads += 1; return voice; },
      });
      const record = store.observe({
        id: "1565968094726332438", channelId: "500", text: "", isBot: false, authorId: "human",
        createdTimestamp: 1, attachments: [{
          id: "voice-1", name: "voice-message.ogg", url: "signed-voice", contentType: "audio/ogg",
        }],
      }, { agentName: "sandman", pane: 0, dir: "/workspace" });
      const prepared = await store.prepareAttachments(record);
      writeFileSync(prepared.attachments[0].durablePath, Buffer.alloc(0));

      const again = await store.prepareAttachments(prepared);

      expect(statSync(again.attachments[0].durablePath).size).toBe(voice.length);
      expect(downloads).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
