#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRequest, JevError, MAX_INPUT_BYTES, MAX_RESPONSE_BYTES, parseResponse, shadowReport } from './contract.mjs';
import { createJevObserver } from './jev.mjs';

const HELP = `Experimental Jev shadow classifier. NEVER dispatches or changes AMUX.

  node spikes/jev-shadow/cli.mjs --demo
  node spikes/jev-shadow/cli.mjs --input input.json
  node spikes/jev-shadow/cli.mjs --input input.json --response response.json
  node spikes/jev-shadow/cli.mjs --input input.json --live --allow-remote

--demo       Replay synthetic example input/response, offline. Not an AI test.
--input      Read ONLY this explicit JSON file. Default: print prepared request, offline.
--response   Replay a saved provider response, offline.
--live       At most ONE real API request; can incur cost.
--allow-remote  Consent to send this input's text and labels to TypeSafe.
Live also requires AMUX_JEV_ORIGIN=https://api.typesafe.ai and TYPESAFE_API_KEY.
No retries, microphone, pane capture, shell action, auto-routing or background hook.
Do not put secrets into input files. Prepared requests display input locally.
`;

async function readBoundedJson(path, limit) {
  let handle;
  try {
    handle = await open(path, 'r');
    if (!(await handle.stat()).isFile()) throw new JevError('LOCAL_FILE', 'Input must be a regular JSON file.');
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new JevError('LOCAL_FILE', 'JSON file exceeds the local byte limit.');
    try { return JSON.parse(buffer.subarray(0, offset).toString('utf8')); }
    catch { throw new JevError('LOCAL_FILE', 'Could not parse the supplied JSON file.'); }
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError('LOCAL_FILE', 'Could not read the supplied JSON file.');
  } finally { await handle?.close(); }
}

/** WHAT: Runs only the explicit experiment command. WHY: Installing/importing it must not activate a provider. */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let observer;
  try {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) { stdout.write(HELP); return 0; }
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
      const flag = argv[i];
      if (!['--demo', '--input', '--response', '--live', '--allow-remote'].includes(flag) || Object.hasOwn(flags, flag)) {
        throw new JevError('USAGE', 'Unknown or repeated flag. Run with --help.');
      }
      if (['--input', '--response'].includes(flag)) {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new JevError('USAGE', 'A file argument is missing.');
        flags[flag] = value;
      } else flags[flag] = true;
    }
    if (flags['--demo'] && Object.keys(flags).length !== 1) throw new JevError('USAGE', '--demo cannot be combined with other modes.');
    if (flags['--live'] && flags['--response']) throw new JevError('USAGE', 'Live and replay cannot be combined.');
    if (flags['--allow-remote'] && !flags['--live']) throw new JevError('USAGE', '--allow-remote requires --live.');
    const demo = flags['--demo'] === true;
    const inputPath = demo ? fileURLToPath(new URL('./examples/input.json', import.meta.url)) : flags['--input'];
    if (!inputPath) throw new JevError('USAGE', 'Choose --demo or an explicit --input JSON file.');
    const input = await readBoundedJson(inputPath, MAX_INPUT_BYTES);
    const request = buildRequest(input);
    let output;
    if (flags['--live']) {
      observer = createJevObserver({ enabled: true, allowDataTransfer: flags['--allow-remote'] === true,
        origin: env.AMUX_JEV_ORIGIN, apiKey: env.TYPESAFE_API_KEY });
      const stop = new AbortController();
      const interrupt = () => stop.abort();
      process.once('SIGINT', interrupt);
      try { output = await observer.observe(input, { signal: stop.signal }); }
      finally { process.removeListener('SIGINT', interrupt); }
    } else if (demo || flags['--response']) {
      const responsePath = demo ? fileURLToPath(new URL('./examples/response.json', import.meta.url)) : flags['--response'];
      const raw = await readBoundedJson(responsePath, MAX_RESPONSE_BYTES);
      output = shadowReport(input, request, parseResponse(raw, request), { transport: demo ? 'synthetic-demo' : 'replay' });
    } else {
      output = { mode: 'prepare-only', action: 'NO_DISPATCH', networkCalls: 0, request };
    }
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof JevError ? error : new JevError('LOCAL_ERROR', 'Experiment failed; details withheld.');
    stderr.write(`${JSON.stringify({ mode: 'error', action: 'NO_DISPATCH', error: safe.code, message: safe.message,
      attempts: observer?.stats().attempts ?? 0 })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
