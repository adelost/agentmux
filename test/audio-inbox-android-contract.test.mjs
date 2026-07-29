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
      expect(manifest).toContain('android:scheme="agentmux"');
      expect(manifest).toContain('android:host="auth"');
      expect(discovery).toContain('"agentmux-audio-inbox"');
      expect(discovery).toContain('"https://abyss-wsl.tail13cb13.ts.net:8443"');
      expect(startup).toContain("AUDIO_INBOX_SERVER_ID");
      expect(startup).toContain("AUDIO_INBOX_TARGET");
      expect(startup).toContain("AUDIO_INBOX_TARGETS");
      expect(startup).toContain("${process.env.HOME}/.local/bin");
      expect(focus).toContain("AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK");
      const notifier = read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/AudioServiceNotifier.java",
      );
      expect(notifier).toContain("Notification.MediaStyle");
      expect(notifier).toContain("session.getPlatformToken()");
      expect(notifier).toContain('"Stop"');
      expect(notifier).toContain("AppContract.ACTION_STOP_AUDIO");
      const phone = read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/LinkPhoneScreen.kt",
      );
      expect(phone).toContain("PlaybackPhase.PAUSED -> RingPlaybackState.PAUSED");
      expect(phone).toContain("PlaybackPhase.PAUSED -> onResume");
      expect(phone).toContain("RingPlaybackControls(");
      expect(read("channels/voice.mjs")).toContain('path === "/api/audio/send"');
      const ptt = read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/PttDisc.kt",
      );
      expect(ptt).toContain("RingPressLifecycle(");
      expect(ptt).toContain("RingPressLifecycleSpec(");
      expect(ptt).toContain("onBegin = onBegin");
      expect(ptt).toContain("onRelease = onRelease");
      expect(ptt).toContain("onCancel = onCancel");
      expect(discovery).toContain('"agentmux-windows-manager-audio"');
      expect(discovery).toContain('"http://abyss-win.tail13cb13.ts.net:8081"');
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/LinkPhoneSettings.kt",
      )).toContain('"READ REPLIES"');
      expect(read(
        "android/audio-inbox/link-core/src/main/kotlin/io/agentmux/linkcore/LinkState.kt",
      )).toContain('selectedTargetId: String = "lsrc:3"');
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/TailnetConversationTransport.java",
      )).toContain("awaitAgentReply");
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/PublicConversationTransport.java",
      )).toContain('return "public-link"');
      expect(read(
        "android/audio-inbox/link-core/src/main/kotlin/io/agentmux/linkcore/VoiceUploadPolicy.kt",
      )).toContain("PUBLIC_MAX_BYTES: Long = 5L * 1024 * 1024");
      expect(read("docs/link-internet-v1.md")).not.toContain("Upload ≤ 60 s");
      expect(read(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/ConversationController.java",
      )).toContain("replies.execute");
      expect(read("channels/voice-input.mjs")).not.toContain("answer normally, then send");
      expect(read("channels/voice-input.mjs")).not.toContain("ptt-echo-");
    }],
  });

  unit("every touched Android source stays within the repository size limit", {
    then: ["no source file exceeds 500 lines", () => {
      const appDirectory = new URL(
        "android/audio-inbox/app/src/main/java/io/agentmux/audioinbox/",
        ROOT,
      );
      const coreDirectory = new URL(
        "android/audio-inbox/link-core/src/main/kotlin/io/agentmux/linkcore/",
        ROOT,
      );
      const wearDirectory = new URL(
        "android/audio-inbox/wear/src/main/java/io/agentmux/audioinbox/wear/",
        ROOT,
      );
      const counts = Object.fromEntries(
        [
          ...readdirSync(appDirectory).map((name) => [appDirectory, name]),
          ...readdirSync(coreDirectory).map((name) => [coreDirectory, name]),
          ...readdirSync(wearDirectory).map((name) => [wearDirectory, name]),
        ]
          .filter(([, name]) => name.endsWith(".java") || name.endsWith(".kt"))
          .map(([directory, name]) => {
            const source = readFileSync(join(directory.pathname, name), "utf8");
            const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
            return [name, lines];
          }),
      );
      expect(counts).toEqual(expect.objectContaining({
        "AudioInboxHttpClient.java": expect.any(Number),
        "AudioInboxService.java": expect.any(Number),
        "MainActivity.kt": expect.any(Number),
        "LinkPhoneScreen.kt": expect.any(Number),
        "LinkState.kt": expect.any(Number),
        "WearLinkScreen.kt": expect.any(Number),
        "ServerDiscovery.java": expect.any(Number),
      }));
      expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(500);
    }],
  });
});
