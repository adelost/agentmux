import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
awk -v d="$duration" 'BEGIN { exit !(d <= 25.1) }' || { echo '504 DEADLINE_EXCEEDED' >&2; exit 1; }
part=$(basename "$file"); part="\${part%.*}"
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
      expect(complete.stdout.trim()).toBe("[stt-fallback:whisper1] part-0000 part-0001 part-0002 part-0003 part-0004");
      const partial = run(true);
      expect(partial.status).toBe(1);
      expect(partial.stdout).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function silenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "voice-silence-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/transcribe"), `#!/bin/bash
file="\${@: -1}"
part=$(basename "$file"); part="\${part%.*}"
echo "$part" >> "$HOME/calls"
if [[ "$part" == "$EMPTY_PART" || "$EMPTY_AUDIBLE" == yes ]]; then exit 0; fi
echo "$part"
`, { mode: 0o700 });
  const run = (audio, env = {}, script = resolve("bin/transcribe-whisper.sh")) => spawnSync("bash", [script, audio], {
    env: { ...process.env, HOME: root, ...env }, encoding: "utf8", timeout: 15_000,
  });
  const calls = () => { try { return readFileSync(join(root, "calls"), "utf8").trim().split("\n"); } catch { return []; } };
  return { root, run, calls, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("silent voice parts, skyvw:0 2026-10-17", () => {
  it("skips a quiet middle part using the same preflight rule as a quiet file", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "mixed.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "aevalsrc=if(between(t\\,24.8\\,50.2)\\,0.0005\\,0.1)*sin(440*2*PI*t):s=16000:d=75", audio]);
      const mixed = fx.run(audio, { EMPTY_PART: "part-0001" });
      expect(mixed.status, mixed.stderr).toBe(0);
      expect(mixed.stdout.trim()).toBe("part-0000 [tyst 0:25–0:50] part-0002");
      expect(fx.calls()).not.toContain("part-0001");
      const quiet = join(fx.root, "quiet.wav");
      execFileSync("ffmpeg", ["-v", "error", "-i", audio, "-ss", "25", "-t", "25", quiet]);
      const before = fx.calls().length, silent = fx.run(quiet);
      expect(silent.status, silent.stderr).toBe(0); expect(silent.stdout.trim()).toBe("[tyst 0:00–0:25]");
      expect(fx.calls()).toHaveLength(before);
    } finally { fx.close(); }
  });
  it("keeps empty text from audible audio as an error", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "audible.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]);
      const result = fx.run(audio, { EMPTY_AUDIBLE: "yes" });
      expect(result.status).toBe(1); expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain("empty segment transcript");
    } finally { fx.close(); }
  });
  it("keeps a short audible peak even with a low whole-file mean", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "brief.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "aevalsrc=if(lt(t\\,0.00001)\\,0.2\\,0):s=16000:d=25", audio]);
      const result = fx.run(audio);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("brief");
      expect(fx.calls()).toEqual(["brief"]);
    } finally { fx.close(); }
  });
  for (const [key, emptyPart, count] of [["AMUX_VOICE_FIXTURE", "part-0004", 10], ["AMUX_VOICE_FIXTURE_2", "part-0002", 7]]) {
    it.skipIf(!process.env[key])(`replays private original ${key} without provider calls or transcript logging`, () => {
      const fx = silenceFixture();
      try {
        const result = fx.run(process.env[key], { EMPTY_PART: emptyPart }, process.env.AMUX_TRANSCRIBE_SCRIPT || resolve("bin/transcribe-whisper.sh"));
        expect(result.status, result.stderr).toBe(0);
        const expected = Array.from({ length: count }, (_, i) => `part-${String(i).padStart(4, "0")}`).filter(name => name !== emptyPart);
        const marker = key === "AMUX_VOICE_FIXTURE" ? "[tyst 1:40–2:05]" : "[tyst 0:50–1:15]";
        const text = Array.from({ length: count }, (_, i) => `part-${String(i).padStart(4, "0")}`).map(name => name === emptyPart ? marker : name).join(" ");
        expect(result.stdout.trim()).toBe(text);
        expect(fx.calls().sort()).toEqual(expected);
      } finally { fx.close(); }
    });
  }
});
