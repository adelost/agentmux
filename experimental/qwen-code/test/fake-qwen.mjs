// No models or network. A real child process exercising the public stream boundary.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--input-format --output-format --resume --approval-mode --max-session-turns --max-tool-calls --max-wall-time --exclude-tools --version');
  process.exit(0);
}
if (args.includes('--version')) { console.log('0.23.0'); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const resumeAt = args.indexOf('--resume');
const sid = resumeAt >= 0 ? args[resumeAt + 1] : '12345678-1234-4234-8234-123456789abc';
const modelAt = args.indexOf('--model');
const model = modelAt >= 0 ? args[modelAt + 1] : 'fixture-model';
const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
if (prompt === 'hang-before-handshake') { setInterval(() => {}, 1000); }
else {
  emit({ type: 'system', subtype: 'session_start', uuid: 'start-1', session_id: sid, model });
  if (prompt === 'hang-after-handshake') setInterval(() => {}, 1000);
  else if (prompt === 'auth-failure') { process.stderr.write('PRIVATE-KEY-AND-PROVIDER-MESSAGE'); process.exitCode = 1; }
  else if (prompt === 'no-result') process.exitCode = 0;
  else if (prompt === 'bad-json') process.stdout.write('not json\n');
  else if (prompt === 'wrong-session') emit({ type: 'result', subtype: 'success', session_id: 'abcdefab-1234-4234-8234-123456789abc', is_error: false, result: 'wrong' });
  else if (prompt === 'api-error') emit({ type: 'result', subtype: 'success', session_id: sid, is_error: false, result: '[API Error: 401 status code (no body)]', usage: { input_tokens: 0, output_tokens: 0 } });
  else if (prompt === 'subagent') emit({ type: 'assistant', session_id: sid, parent_tool_use_id: 'tool-parent', message: { role: 'assistant', content: [] } });
  else if (prompt === 'permission-denial') emit({ type: 'result', session_id: sid, subtype: 'success', is_error: false, result: 'Finished with one denied tool',
    permission_denials: [{ tool_name: 'run_shell_command', tool_use_id: 'tool1', tool_input: { command: 'private command' } }],
    terminal_reason: 'completed', num_turns: 2, duration_ms: 12, duration_api_ms: 8,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, total_tokens: 160 } });
  else {
    emit({ type: 'assistant', session_id: sid, uuid: 'message-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hej ö!' }] } });
    emit({ type: 'result', session_id: sid, subtype: 'success', is_error: false, result: `fixture:${prompt}`,
      permission_denials: [], terminal_reason: 'completed', num_turns: 1, duration_ms: 5, duration_api_ms: 3,
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } });
  }
}