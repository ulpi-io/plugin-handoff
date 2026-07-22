#!/usr/bin/env node
// Hermetic executable for every provider adapter. It exercises real argv/stdin/stdout/file/process
// boundaries without network, authentication, provider state, or global configuration.
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const executable = basename(process.argv[1]);

if (process.env.HANDOFF_FAKE_ANY_INVOKE_MARKER) {
  writeFileSync(process.env.HANDOFF_FAKE_ANY_INVOKE_MARKER, 'invoked\n');
}
if (process.env.HANDOFF_FAKE_INVOCATION_CAPTURE) {
  writeFileSync(process.env.HANDOFF_FAKE_INVOCATION_CAPTURE, JSON.stringify({
    executable,
    args,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('OPENCODE_') || key.startsWith('XDG_') || key.startsWith('HANDOFF_'))),
  }));
}

function has(flag) { return args.includes(flag); }
function after(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

if (has('--version') || has('-V')) {
  process.stdout.write(`${executable} 99.0.0-fake\n`);
  process.exit(0);
}

if (has('--help') || has('-h')) {
  if (process.env.HANDOFF_FAKE_MODE === 'help-missing') {
    process.stdout.write('--sandbox\n');
    process.exit(0);
  }
  const help = {
    codex: '--config --strict-config --sandbox --cd --ephemeral --ignore-user-config --ignore-rules --disable --output-schema --output-last-message',
    grok: '--allow --cwd --deny --disable-web-search --json-schema --max-turns --no-memory --no-plan --no-subagents --permission-mode --prompt-file --sandbox --tools --verbatim',
    'kiro-cli': '--effort --model --no-interactive --require-mcp-startup --trust-tools --wrap',
    claude: '--allowedTools --bare --disable-slash-commands --json-schema --mcp-config --no-chrome --no-session-persistence --output-format --permission-mode --safe-mode --settings --strict-mcp-config --tools',
    opencode: args.includes('run') ? '--agent --dir --format' : '--pure',
    'cursor-agent': args.includes('sandbox') ? '--allow-paths --network --readonly-paths --sandbox' : '--approve-mcps --force --output-format --print',
  }[executable];
  process.stdout.write(`${help || ''}\n`);
  process.exit(0);
}

if (args.includes('handoff_capability_probe_unknown=true')) {
  const field = process.env.HANDOFF_FAKE_MODE === 'config-missing'
    ? 'project_doc_max_bytes'
    : 'handoff_capability_probe_unknown';
  process.stderr.write(`Error loading config.toml: unknown configuration field \`${field}\` in -c/--config override\n`);
  process.exit(1);
}

if (args.includes('handoff-invalid-json')) {
  if (process.env.HANDOFF_FAKE_MODE === 'sandbox-missing') {
    process.stderr.write('warning: sandbox could not be applied; refusing to start\n');
  } else {
    process.stderr.write('Error: --json-schema: invalid JSON: expected value at line 1 column 1\n');
  }
  process.exit(1);
}

if (args.includes('debug') && args.includes('config')) {
  if (process.env.HANDOFF_FAKE_MODE === 'policy-missing') {
    process.stdout.write(JSON.stringify({ agent: {} }));
  } else {
    process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  }
  process.exit(0);
}

if (process.env.HANDOFF_CURSOR_SANDBOX_PROBE === '1') {
  const expectedWrite = process.env.HANDOFF_CURSOR_EXPECT_WRITE === '1';
  const targetWrite = process.env.HANDOFF_FAKE_MODE === 'sandbox-missing' ? !expectedWrite : expectedWrite;
  if (targetWrite) writeFileSync(args.at(-1), 'probe');
  process.stdout.write(JSON.stringify({ targetRead: true, targetWrite }));
  process.exit(0);
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

let prompt = '';
const promptFile = after('--prompt-file');
if (promptFile) prompt = readFileSync(promptFile, 'utf8');
else prompt = await stdinText();
if (process.env.HANDOFF_FAKE_PROMPT_CAPTURE) {
  writeFileSync(process.env.HANDOFF_FAKE_PROMPT_CAPTURE, prompt);
}

const role = prompt.match(/machine role '([^']+)'/u)?.[1] || prompt.match(/in mode '([^']+)'/u)?.[1] || 'review';
const cwd = after('--cd') || after('--cwd') || after('--dir') || after('-C') || process.cwd();
const mode = process.env.HANDOFF_FAKE_MODE || 'success';
let changedPath = null;

if ((role === 'build' || role === 'phase') && mode === 'success') {
  changedPath = `fake-${role}.txt`;
  writeFileSync(join(cwd, changedPath), `${role} change\n`);
}
if (mode === 'untracked') {
  changedPath = 'untracked only.txt';
  writeFileSync(join(cwd, changedPath), 'untracked\n');
}
if (mode === 'review-mutation') {
  changedPath = 'reviewer mutation.txt';
  writeFileSync(join(cwd, changedPath), 'mutation\n');
}
if (mode === 'symlink-change') {
  changedPath = 'unsafe-link';
  symlinkSync('../outside-target', join(cwd, changedPath));
}
if (mode === 'hang') {
  if (process.env.HANDOFF_FAKE_READY_FILE) writeFileSync(process.env.HANDOFF_FAKE_READY_FILE, 'ready\n');
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

const output = {
  schemaVersion: 'handoff.provider-output.v0.3',
  status: mode === 'exit' ? 'failed' : 'completed',
  response: mode === 'exit' ? 'fake provider failure' : `fake ${role} completed`,
  evidence: changedPath ? [{ kind: 'file-change', path: changedPath, summary: 'fake changed a file' }] : [],
  findings: [],
  usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
};

let serialized = JSON.stringify(output);
if (mode === 'prose') serialized = 'Everything looks good.';
if (mode === 'oversized') serialized = JSON.stringify({ ...output, response: 'x'.repeat(300_000) });
if (mode === 'schema-drift') serialized = JSON.stringify({ ...output, schemaVersion: 'handoff.provider-output.v9' });
if (mode === 'unknown-field') serialized = JSON.stringify({ ...output, surprise: true });
if (mode === 'unsafe-evidence-path') serialized = JSON.stringify({
  ...output,
  evidence: [{ kind: 'file-change', path: '../escape', summary: 'unsafe' }],
});

if (mode === 'stderr-secret') {
  process.stderr.write('api_key=super-secret-value Bearer abcdefghijklmnopqrstuvwxyz\n');
}
if (mode === 'runtime-sandbox-missing') {
  process.stderr.write('warning: sandbox could not be applied; refusing to start rather than run unsandboxed\n');
}

function providerStdout() {
  if (executable === 'grok') {
    let structuredOutput;
    try { structuredOutput = JSON.parse(serialized); }
    catch { structuredOutput = null; }
    if (mode === 'grok-envelope-missing') structuredOutput = null;
    const envelopeValue = {
      text: serialized,
      stopReason: 'EndTurn',
      sessionId: 'fake-grok-session',
      requestId: 'fake-grok-request',
      thought: null,
      num_turns: 7,
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 3,
        output_tokens: 7,
        total_tokens: 21,
      },
      total_cost_usd: 0.001,
      total_cost_usd_ticks: 10_000_000,
      modelUsage: {
        'fake-grok': {
          inputTokens: 11,
          cacheReadInputTokens: 3,
          outputTokens: 7,
          modelCalls: 7,
        },
      },
      structuredOutput,
      structuredOutputError: mode === 'grok-envelope-error'
        ? 'model did not produce structured output'
        : null,
    };
    if (mode === 'grok-envelope-metadata-drift') {
      delete envelopeValue.stopReason;
      delete envelopeValue.sessionId;
      envelopeValue.requestId = null;
      envelopeValue.num_turns = '7';
    }
    if (mode === 'grok-envelope-empty') {
      envelopeValue.text = '';
      envelopeValue.structuredOutput = null;
    }
    const envelope = JSON.stringify(envelopeValue);
    return mode === 'noisy' ? `provider noise\n${envelope}` : envelope;
  }
  if (executable === 'claude') {
    let structuredOutput;
    try { structuredOutput = JSON.parse(serialized); }
    catch { structuredOutput = null; }
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: serialized,
      structured_output: structuredOutput,
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    return mode === 'noisy' ? `provider noise\n${envelope}` : envelope;
  }
  if (executable === 'cursor-agent') {
    const envelope = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 5,
      result: serialized, session_id: 'fake-cursor-session',
    });
    return mode === 'noisy' ? `provider noise\n${envelope}` : envelope;
  }
  if (executable === 'opencode') {
    const events = [
      { type: 'step_start', timestamp: 1, sessionID: 'fake-opencode-session', part: { type: 'step-start' } },
      { type: 'text', timestamp: 2, sessionID: 'fake-opencode-session', part: { type: 'text', text: serialized, time: { end: 2 } } },
      { type: 'step_finish', timestamp: 3, sessionID: 'fake-opencode-session', part: { type: 'step-finish', tokens: { input: 11, output: 7 } } },
    ];
    const stream = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    return mode === 'noisy' ? `provider noise\n${stream}` : stream;
  }
  if (executable === 'kiro-cli') {
    const decorated = `Reading files with trusted tools\n\n\x1b[m> \x1b[0mReview complete; here is the machine result.\n\n${serialized}`;
    return mode === 'noisy' ? `${decorated}\nprovider noise` : decorated;
  }
  return mode === 'noisy' ? `provider noise\n${serialized}` : serialized;
}

const resultFile = after('--output-last-message');
if (mode !== 'missing') {
  if (mode === 'invalid-utf8') {
    const valid = Buffer.from(serialized);
    const outputKey = v03 ? 'response' : 'summary';
    const outputStart = valid.indexOf(Buffer.from(`"${outputKey}":"`)) + Buffer.byteLength(`"${outputKey}":"`);
    const invalid = Buffer.concat([valid.subarray(0, outputStart), Buffer.from([0xff]), valid.subarray(outputStart + 1)]);
    if (resultFile) writeFileSync(resultFile, invalid);
    else process.stdout.write(invalid);
  } else if (resultFile) writeFileSync(resultFile, mode === 'noisy' ? `provider noise\n${serialized}` : serialized);
  else process.stdout.write(providerStdout());
}

process.exit(mode === 'exit' ? Number(process.env.HANDOFF_FAKE_EXIT || 23) : 0);
