import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("the existing voice wrapper bounds long clips", () => {
  it("joins all 110 seconds in order, marks any fallback, and refuses partial success", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-parts-"));
    try {
      mkdirSync(join(root, "bin"));
      // Only the provider boundary is fake; splitting and wrapper retries are real.
      writeFileSync(join(root, "bin/transcribe"), `#!/bin/bash
file="\${@: -1}"
duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file")
awk -v d="$duration" 'BEGIN { exit !(d <= 60) }' || { echo '504 DEADLINE_EXCEEDED' >&2; exit 1; }
part=$(basename "$file" .wav)
case "$part:$*:$(printenv FAIL_PART)" in
  part-0001:*gemini*) echo '504 DEADLINE_EXCEEDED' >&2; exit 1 ;;
  part-0002:*:yes) echo 'provider unavailable' >&2; exit 1 ;;
esac
echo "$part"
`, { mode: 0o700 });
      const audio = join(root, "long.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=110", "-c:a", "libopus", audio]);
      const run = fail => spawnSync("bash", [resolve("bin/transcribe-whisper.sh"), audio], {
        env: { ...process.env, HOME: root, FAIL_PART: fail ? "yes" : "no" }, encoding: "utf8", timeout: 10000,
      });
      const complete = run(false);
      expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stdout.trim()).toBe("[stt-fallback:whisper1] part-0000 part-0001 part-0002");
      const partial = run(true);
      expect(partial.status).toBe(1);
      expect(partial.stdout).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
