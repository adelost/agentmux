import { expect, feature, unit } from "bdd-vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");

feature("Android audio inbox source contract", () => {
  unit("the npm release excludes the standalone Android project", {
    then: ["the root package cannot accidentally ship Gradle or APK files", () => {
      expect(read(".npmignore").split("\n")).toContain("android/");
    }],
  });

  unit("the playback service is private and Tailnet discovery is explicit", {
    then: ["manifest and startup wiring preserve the intended boundary", () => {
      const manifest = read("android/audio-inbox/app/src/main/AndroidManifest.xml");
      const discovery = read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/ServerDiscovery.java",
      );
      const startup = read("index.mjs");
      const focus = read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/SpeechAudioFocus.java",
      );
      expect(manifest).toContain('android:name=".AudioInboxService"');
      expect(manifest).toContain('android:exported="false"');
      expect(manifest).toContain("android.permission.RECORD_AUDIO");
      expect(discovery).toContain('"agentmux-audio-inbox"');
      expect(discovery).toContain('"https://abyss-wsl.tail13cb13.ts.net:8443"');
      expect(startup).toContain("AUDIO_INBOX_SERVER_ID");
      expect(startup).toContain("AUDIO_INBOX_TARGET");
      expect(startup).toContain("AUDIO_INBOX_TARGETS");
      expect(startup).toContain("${process.env.HOME}/.local/bin");
      expect(focus).toContain("AUDIOFOCUS_GAIN_TRANSIENT");
      expect(focus).not.toContain("AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK");
      expect(read("channels/voice.mjs")).toContain('path === "/api/audio/send"');
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/PushToTalkController.java",
      )).toContain("MotionEvent.ACTION_UP");
      expect(discovery).toContain('"agentmux-windows-manager-audio"');
      expect(discovery).toContain('"http://abyss-win.tail13cb13.ts.net:8081"');
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/ConversationPanel.java",
      )).toContain('"Read replies aloud"');
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/ConversationPanel.java",
      )).toContain('KEY_CONVERSATION_TARGET, "lsrc:3"');
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/ConversationController.java",
      )).toContain("awaitAgentReply");
      expect(read("channels/voice-input.mjs")).not.toContain("answer normally, then send");
      expect(read("channels/voice-input.mjs")).not.toContain("ptt-echo-");
    }],
  });

  unit("every Android Java source stays within the repository size limit", {
    then: ["no source file exceeds 500 lines", () => {
      const directory = new URL(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/",
        ROOT,
      );
      const counts = Object.fromEntries(
        readdirSync(directory)
          .filter((name) => name.endsWith(".java"))
          .map((name) => {
            const source = readFileSync(join(directory.pathname, name), "utf8");
            const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
            return [name, lines];
          }),
      );
      expect(counts).toEqual(expect.objectContaining({
        "AudioInboxHttpClient.java": expect.any(Number),
        "AudioInboxService.java": expect.any(Number),
        "MainActivity.java": expect.any(Number),
        "ConversationPanel.java": expect.any(Number),
        "ServerDiscovery.java": expect.any(Number),
      }));
      expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(500);
    }],
  });
});
