import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const targets = ['claude', 'codex', 'cursor', 'grok', 'kiro', 'opencode'];
const skills = [
  'get-advice', 'handoff-run', 'handoff-run-with-advice',
  ...targets.flatMap((target) => [`handoff-${target}`, `handoff-${target}-with-advice`]),
].sort();
const commandModes = Object.freeze({ claude: ['build', 'review'], codex: ['build', 'review'], cursor: ['build', 'review'], grok: ['build', 'review'], kiro: ['review'], opencode: ['build', 'review'] });
const commands = Object.entries(commandModes).flatMap(([target, modes]) => modes.flatMap((mode) => [`${target}-${mode}.md`, `${target}-${mode}-with-advice.md`])).sort();

test('shared skills expose exactly the generic and six paired provider families', () => {
  assert.deepEqual(readdirSync('skills', { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), skills);
  for (const name of skills) {
    const path = join('skills', name, 'SKILL.md');
    const metadata = join('skills', name, 'agents', 'openai.yaml');
    assert.equal(existsSync(path), true, path);
    assert.equal(existsSync(metadata), true, metadata);
    const source = readFileSync(path, 'utf8');
    assert.match(source, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`, 'u'), path);
    const yaml = readFileSync(metadata, 'utf8');
    for (const key of ['display_name:', 'short_description:', 'default_prompt:']) assert.match(yaml, new RegExp(key, 'u'), metadata);
    assert.doesNotMatch(source, /\b(?:codex|grok|kiro-cli|claude|opencode|cursor-agent)\s+(?:exec|run|agent|--)/u, `${path} invokes a provider directly`);
  }
});

test('provider skills route one exact target and one explicit root family', () => {
  for (const target of targets) {
    const plain = readFileSync(join('skills', `handoff-${target}`, 'SKILL.md'), 'utf8');
    const enabled = readFileSync(join('skills', `handoff-${target}-with-advice`, 'SKILL.md'), 'utf8');
    assert.match(plain, new RegExp(`handoff\\.mjs" run \\\\\\n[\\s\\S]*--harness ${target}`, 'u'));
    assert.doesNotMatch(plain, /handoff\.mjs" run-with-advice/u);
    assert.match(enabled, new RegExp(`handoff\\.mjs" run-with-advice \\\\\\n[\\s\\S]*--harness ${target}`, 'u'));
    assert.doesNotMatch(enabled, /handoff\.mjs" run \\/u);
  }
  const genericPlain = readFileSync('skills/handoff-run/SKILL.md', 'utf8');
  const genericEnabled = readFileSync('skills/handoff-run-with-advice/SKILL.md', 'utf8');
  assert.match(genericPlain, /handoff\.mjs" run \\/u);
  assert.doesNotMatch(genericPlain, /handoff\.mjs" run-with-advice/u);
  assert.match(genericEnabled, /handoff\.mjs" run-with-advice \\/u);
  assert.match(genericEnabled, /only nested command is:[\s\S]*handoff\.mjs" advice/u);
  assert.doesNotMatch(genericEnabled, /nested[\s\S]{0,80}handoff\.mjs" run/u);
});

test('Claude command matrix has eleven plain and eleven paired with-advice routes', () => {
  assert.deepEqual(readdirSync('commands').filter((name) => name.endsWith('.md')).sort(), commands);
  for (const [target, modes] of Object.entries(commandModes)) {
    for (const mode of modes) {
      const plain = readFileSync(join('commands', `${target}-${mode}.md`), 'utf8');
      const enabled = readFileSync(join('commands', `${target}-${mode}-with-advice.md`), 'utf8');
      assert.match(plain, new RegExp(`handoff\\.mjs run --caller-harness claude --harness ${target} --mode ${mode}`, 'u'));
      assert.doesNotMatch(plain, /run-with-advice/u);
      assert.match(enabled, new RegExp(`handoff\\.mjs run-with-advice --caller-harness claude --harness ${target} --mode ${mode}`, 'u'));
    }
  }
  assert.equal(commands.some((name) => /-(?:phase|verify)(?:-with-advice)?\.md$/u.test(name)), false);
});
