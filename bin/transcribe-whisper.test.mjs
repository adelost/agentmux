import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAttachmentHandler } from "../attachments.mjs";
import { createDiscordInboundStore } from "../core/discord-inbound-store.mjs";
import { createInboundReconciler } from "../core/inbound-reconciler.mjs";

const wrapperPath = process.env.AMUX_TRANSCRIBE_SCRIPT || resolve("bin/transcribe-whisper.sh");

describe("the existing voice wrapper bounds long clips", () => {
  it("joins 110 seconds in order and durably fences a partial UNKNOWN without replay", async () => {
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
  part-0002:*:yes) echo 'provider unavailable' >&2; exit 1 ;;
esac
echo "$part"
`, { mode: 0o700 });
      const audio = join(root, "long.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "flite=text=This is a short spoken sentence:voice=slt,aloop=loop=-1:size=32000", "-t", "110", "-c:a", "libopus", audio]);
      const run = (fail, input = audio) => spawnSync("bash", [wrapperPath, input], {
        env: { ...process.env, HOME: root, PYTHONUSERBASE: join(homedir(), ".local"), AMUX_STT_PRIMARY: "gemini", FAIL_PART: fail ? "yes" : "no" }, encoding: "utf8", timeout: 20000,
      });
      const complete = run(false);
      expect(complete.status, complete.stderr).toBe(0);
      expect(complete.stdout.trim()).toBe("part-0000 part-0001 part-0002 part-0003 part-0004");
      let attempts = 0, partial;
      const store = createDiscordInboundStore({ rootDir: join(root, "inbound"), downloadBuffer: async () => readFileSync(audio) });
      const handler = createAttachmentHandler({ transcribeScript: wrapperPath, run: async command => {
        attempts++;
        partial = run(true, command.match(/'([^']+)'\s*$/)[1]);
        if (partial.status) throw Object.assign(new Error("partial STT outcome"), { code: partial.status });
        return partial;
      } });
      const prompts = [], notices = [];
      const reconciler = createInboundReconciler({ store, resolveTarget: () => ({ agentName: "lsrc", pane: 7 }),
        onMessage: async msg => { const prompt = await handler.buildPrompt(msg, []); if (prompt) prompts.push(prompt); return { delivered: true }; } });
      const voice = { id: "long", channelId: "channel", text: "", attachments: [
        { id: "long-audio", name: "long.ogg", contentType: "audio/ogg", url: "fixture" },
      ] };
      const channel = { async send(_id, payload) { notices.push(payload); } };
      await reconciler.enqueue(voice, channel); await reconciler.enqueue(voice, channel);
      expect(partial.status).toBe(22); expect(partial.stdout).toBe("");
      expect(attempts).toBe(1); expect(prompts).toEqual([]); expect(notices).toHaveLength(1);
      expect(store.read("channel", "long").status).toBe("completed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60000);
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
  const run = (audio, env = {}, script = wrapperPath) => spawnSync("bash", [script, audio], {
    env: { ...process.env, HOME: root, PYTHONUSERBASE: join(homedir(), ".local"), AMUX_STT_PRIMARY: "gemini", ...env }, encoding: "utf8", timeout: 15_000,
  });
  const calls = () => { try { return readFileSync(join(root, "calls"), "utf8").trim().split("\n"); } catch { return []; } };
  return { root, run, calls, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("silent voice parts, skyvw:0 2026-10-17", () => {
  it("skips a relative quiet middle part but keeps a uniformly quiet file", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "mixed.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "flite=text=This is a short spoken sentence:voice=slt,aloop=loop=-1:size=32000", "-t", "75", "-af", "volume=if(between(t\\,24.8\\,50.2)\\,0\\,1):eval=frame", audio]);
      const mixed = fx.run(audio, { EMPTY_PART: "part-0001" });
      expect(mixed.status, mixed.stderr).toBe(0);
      expect(mixed.stdout.trim()).toBe("part-0000 part-0002");
      expect(fx.calls()).not.toContain("part-0001");
      const quiet = join(fx.root, "quiet.wav");
      execFileSync("ffmpeg", ["-v", "error", "-i", audio, "-ss", "25", "-t", "25", quiet]);
      const before = fx.calls().length, silent = fx.run(quiet);
      expect(silent.status, silent.stderr).toBe(0); expect(silent.stdout.trim()).toBe("[stt:no_speech]");
      expect(fx.calls()).toHaveLength(before);
    } finally { fx.close(); }
  });
  // Mattias 2026-10-17: "fixar så inte meddelandena failar på samma sätt igen". Gemini answering
  // "no words" twice is an answer, not an outage; failing the message made every retry repeat it.
  // Since sandman:0 1 Nov, whisper1 hears it too before the range is marked: two Gemini tries, then whisper1.
  it("marks audible audio without words after one more try instead of failing the message", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "audible.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "flite=text=ya:voice=slt", audio]);
      const result = fx.run(audio, { EMPTY_AUDIBLE: "yes" });
      expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("[stt:no_speech]");
      expect(fx.calls()).toEqual(["audible"]);
    } finally { fx.close(); }
  });
  it("delivers the rest of a long message around an audible part without words", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "noisy.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "flite=text=This is a short spoken sentence:voice=slt,aloop=loop=-1:size=32000", "-t", "75", audio]);
      const result = fx.run(audio, { EMPTY_PART: "part-0001" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("part-0000 part-0002");
    } finally { fx.close(); }
  });
  it("does not treat an isolated click as speech", () => {
    const fx = silenceFixture();
    try {
      const audio = join(fx.root, "brief.wav");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "aevalsrc=if(lt(t\\,0.00001)\\,0.2\\,0):s=16000:d=25", audio]);
      const result = fx.run(audio);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("[stt:no_speech]");
      expect(fx.calls()).toEqual([]);
    } finally { fx.close(); }
  });
  it("preserves uniformly quiet audio before and after splitting", () => {
    const fx = silenceFixture();
    try {
      for (const duration of [2, 56]) {
        const audio = join(fx.root, `quiet-${duration}.wav`);
        execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "flite=text=This is a short spoken sentence:voice=slt,aloop=loop=-1:size=32000", "-t", String(duration),
          "-af", "volume=-33dB", audio]);
        const result = fx.run(audio);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("[tyst");
        expect(result.stdout.trim()).toBe(duration === 2 ? "quiet-2" : "part-0000 part-0001 part-0002");
      }
    } finally { fx.close(); }
  });
  it.skipIf(!process.env.AMUX_QUIET_SPEECH_DIR)("keeps the public quiet-speech counterexample at every measured level", () => {
    const fx = silenceFixture();
    try {
      for (const file of ["dialogue.wav", "dialogue-30.wav", "dialogue-33.wav", "dialogue-36.wav", "long-33.wav"]) {
        const before = fx.calls().length;
        const result = fx.run(join(process.env.AMUX_QUIET_SPEECH_DIR, file), {}, process.env.AMUX_TRANSCRIBE_SCRIPT || wrapperPath);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("[tyst"); expect(fx.calls().length).toBeGreaterThan(before);
      }
    } finally { fx.close(); }
  });
  for (const [key, emptyPart, count] of [["AMUX_VOICE_FIXTURE", "part-0004", 10], ["AMUX_VOICE_FIXTURE_2", "part-0002", 7]]) {
    it.skipIf(!process.env[key])(`replays private original ${key} without provider calls or transcript logging`, () => {
      const fx = silenceFixture();
      try {
        const result = fx.run(process.env[key], { EMPTY_PART: emptyPart }, process.env.AMUX_TRANSCRIBE_SCRIPT || wrapperPath);
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

function providerFixture(fakeTranscribe, seconds = 3) {
  const root = mkdtempSync(join(tmpdir(), "voice-provider-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/transcribe"), `#!/bin/bash
backend=$(sed -n 's/.*--backend \\([a-z0-9]*\\).*/\\1/p' <<< "$*")
echo "$backend" >> "$HOME/calls"
${fakeTranscribe}
`, { mode: 0o700 });
  const audio = join(root, "clip.ogg");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "flite=text=This is a short spoken sentence:voice=slt,aloop=loop=-1:size=32000", "-t", String(seconds), "-c:a", "libopus", audio]);
  const run = (env = {}, input = audio) => spawnSync("bash", [wrapperPath, input], {
    env: { ...process.env, HOME: root, PYTHONUSERBASE: join(homedir(), ".local"), AMUX_STT_PRIMARY: "gemini", ...env }, encoding: "utf8", timeout: 20_000,
  });
  const calls = () => readFileSync(join(root, "calls"), "utf8").trim().split("\n");
  const args = () => readFileSync(join(root, "args"), "utf8").trim().split("\n");
  const failures = (backend = "gemini") => readFileSync(join(root, `.agentmux/stt-${backend}-failures.jsonl`), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  return { run, calls, args, failures, root, audio, close: () => rmSync(root, { recursive: true, force: true }) };
}

// Row 151 supersedes retry-on-empty and retry-on-timeout: neither proves an outage.
describe("primary calls are never repeated after uncertain outcomes", () => {
  it("does not replace a timed-out Gemini job", () => {
    const fx = providerFixture(`[ "$backend" = gemini ] && exec sleep 30`);
    try {
      const result = fx.run({ AMUX_STT_GEMINI_CAP_S: "1" });
      expect(result.status).toBe(22); expect(result.stdout).toBe("");
      expect(fx.calls()).toEqual(["gemini"]);
    } finally { fx.close(); }
  });
  it("does not infer unavailability from a generic provider error", () => {
    const fx = providerFixture(`echo "503 UNAVAILABLE" >&2; exit 1`);
    try {
      const result = fx.run();
      expect(result.status).toBe(22); expect(fx.calls()).toEqual(["gemini"]);
      expect(fx.failures()).toHaveLength(1);
    } finally { fx.close(); }
  });
});

// Mattias 2026-10-30: the API, not Gemini 2.5 Pro, transcribes voice; whisper1 stays the fallback.
describe("api.v1d.io is the primary transcriber", () => {
  const v1d = { AMUX_STT_PRIMARY: "v1d" };
  it("is the default and gets a 110 s message whole, in one call", () => {
    const fx = providerFixture(`echo "$backend $(basename "\${@: -1}" | sed 's/[.].*//')"`, 110);
    try {
      const result = fx.run({ AMUX_STT_PRIMARY: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("v1d clip");
      expect(fx.calls()).toEqual(["v1d"]);
    } finally { fx.close(); }
  });
  it("splits only a message longer than the API's 240 s parts", () => {
    const fx = providerFixture(`echo "$backend $(basename "\${@: -1}" | sed 's/[.].*//')"`, 250);
    try {
      const result = fx.run(v1d);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("v1d part-0000 v1d part-0001");
      expect(fx.calls()).toEqual(["v1d", "v1d"]);
    } finally { fx.close(); }
  });
  it("hands a failed call to whisper1 at once, logs why without the words, and never sends it again", () => {
    const fx = providerFixture(`if [ "$backend" = v1d ]; then
  echo "v1d 503 provider_unavailable: refused before submit" >&2; exit 21
fi
echo "whisper words"`);
    try {
      const result = fx.run(v1d);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("[stt-fallback:whisper1] whisper words");
      expect(fx.calls()).toEqual(["v1d", "whisper1"]);
      const log = fx.failures("v1d");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ backend: "v1d", attempt: 1, exit: 21, reason: expect.stringContaining("503 provider_unavailable") });
      expect(JSON.stringify(log)).not.toContain("whisper words");
    } finally { fx.close(); }
  });
  // sandman:0 1 Nov: the API answered Mattias' clear 13 s message of 20:40Z without words, and it
  // reached his pane as [ohörbart 0:00–0:12]. whisper1 hears a wordless answer before it is marked.
  it("stops a wordless primary answer without a second provider", () => {
    const fx = providerFixture(`[ "$backend" = v1d ] && exit 0
echo "whisper words"`);
    try {
      const result = fx.run(v1d);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("[stt:no_speech]");
      expect(fx.calls()).toEqual(["v1d"]);
    } finally { fx.close(); }
  });
  it("marks a clip inaudible only when whisper1 hears no words either", () => {
    const fx = providerFixture(`exit 0`);
    try {
      const result = fx.run(v1d);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("[stt:no_speech]");
      expect(fx.calls()).toEqual(["v1d"]);
    } finally { fx.close(); }
  });
  it("still marks a clip the API heard without words when whisper1 cannot answer", () => {
    const fx = providerFixture(`[ "$backend" = v1d ] && exit 0
echo "401 insufficient_quota" >&2; exit 1`);
    try {
      const result = fx.run(v1d);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("[stt:no_speech]");
      expect(fx.calls()).toEqual(["v1d"]);
    } finally { fx.close(); }
  });
  it("refuses an unknown primary instead of guessing one", () => {
    const fx = providerFixture(`echo words`);
    try {
      const result = fx.run({ AMUX_STT_PRIMARY: "pro" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown AMUX_STT_PRIMARY");
    } finally { fx.close(); }
  });
});

describe("151 terminal speech outcomes", () => {
  for (const code of [20, 22, 23]) it(`does not fall back for terminal exit ${code}`, () => {
    const fx = providerFixture(`[ "$backend" = v1d ] && exit ${code}\necho invented`);
    try {
      const result = fx.run({ AMUX_STT_PRIMARY: "v1d" });
      expect(fx.calls()).toEqual(["v1d"]);
      expect(result.stdout.trim()).toBe(code === 20 ? "[stt:no_speech]" : "");
      expect(result.status).toBe(code === 20 ? 0 : code);
    } finally { fx.close(); }
  });
  it("blocks real silence and noise before Whisper, but preserves short and quiet speech", () => {
    const fx = providerFixture(`[ "$backend" = v1d ] && exit 21\necho ja`);
    try {
      for (const [name, source] of [["noise", "anoisesrc=color=white:amplitude=0.1:sample_rate=16000"], ["silence", "anullsrc=r=16000:cl=mono"]]) {
        const audio = join(fx.root, `${name}.wav`);
        execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, "-t", "1", audio]);
        const result = fx.run({ AMUX_STT_PRIMARY: "v1d" }, audio);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("[stt:no_speech]");
      }
      const quiet = join(fx.root, "quiet-speech.wav");
      execFileSync("ffmpeg", ["-v", "error", "-i", fx.audio, "-af", "volume=-33dB", quiet]);
      const result = fx.run({ AMUX_STT_PRIMARY: "v1d" }, quiet);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("[stt-fallback:whisper1] ja");
      expect(fx.calls().filter(x => x === "whisper1")).toHaveLength(1);
    } finally { fx.close(); }
  }, 15000);
});

describe("151 gateway adapter contract, real codec and stubbed HTTP only", () => {
  for (const [scenario, expected, text] of [
    ["no_speech", 0, ""], ["too_short", 0, ""], ["unknown", 22, null],
    ["outage", 21, null], ["content", 23, null], ["auth", 23, null], ["quota", 23, null], ["outage_run", 22, null], ["http_unknown", 22, null], ["proofread", 0, "ja"],
  ]) it(`preserves ${scenario} semantics`, () => {
    const root = mkdtempSync(join(tmpdir(), "voice-adapter-"));
    try {
      const audio = join(root, "input.wav"), out = join(root, "out.json"), key = join(root, "key");
      writeFileSync(key, "stub-key");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "flite=text=ya:voice=slt", audio]);
      const code = readFileSync(process.env.AMUX_TRANSCRIBE_SOURCE || resolve("bin/transcribe"), "utf8").split("<<'PY'\nimport base64,")[1].split("\nPY\n}")[0];
      const runner = `import json, sys, io, urllib.request, urllib.error\nfrom unittest.mock import patch\nscenario=sys.argv[3]\ncalls=[]\nclass Response(io.BytesIO):\n status=200\ndef request(req, **kwargs):\n calls.append(req.method)\n if req.full_url.endswith('/v1/transcribe'): assert json.loads(req.data)['preset'] == 'standard-guard-1'\n if req.full_url.endswith('/v1/proofread'): raise TimeoutError('secondary only')\n if scenario in ('no_speech','too_short','outage','content','auth','quota','outage_run','http_unknown'):\n  code=scenario if scenario != 'outage' else 'provider_unavailable'\n  status={'auth':401,'quota':429,'outage':503,'outage_run':503,'http_unknown':503}.get(scenario,422)\n  body={'error':{'type':'unknown_outcome' if scenario == 'http_unknown' else 'provider_unavailable' if scenario in ('outage','outage_run') else 'invalid_request','code':code}}\n  if scenario in ('outage','outage_run'):\n   body['error']={'type':'provider_unavailable','message':'The provider could not be reached; the run did not start (ledger-unavailable).'}\n   if scenario == 'outage_run': body['error']['run_id']='run_unknown'\n  raise urllib.error.HTTPError(req.full_url,status,'stub',{},io.BytesIO(json.dumps(body).encode()))\n return Response(json.dumps({'id':'run_stub','status':'unknown' if scenario == 'unknown' else 'succeeded','error':None,'output':None if scenario == 'unknown' else {'text':'ja'}}).encode())\ntry:\n with patch('urllib.request.urlopen', request): exec('import base64,'+sys.stdin.read())\nfinally:\n print(json.dumps({'http_calls':calls}))\n`;
      const result = spawnSync("python3", ["-c", runner, audio, out, scenario], {
        input: code, encoding: "utf8", timeout: 20000,
        env: { ...process.env, WORK: root, V1D_KEY_FILE: key, LANG: "sv", V1D_CONTEXT: "ja", V1D_HINTS: "" },
      });
      expect(result.status, result.stderr).toBe(expected);
      if (text !== null) expect(JSON.parse(readFileSync(out)).text).toBe(text);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1)).http_calls).toEqual(scenario === "proofread" ? ["POST", "POST"] : ["POST"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
