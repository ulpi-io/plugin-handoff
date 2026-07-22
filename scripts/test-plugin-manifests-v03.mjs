import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const targets = ['claude', 'codex', 'cursor', 'grok', 'kiro', 'opencode'];
const skills = ['get-advice', 'handoff-run', 'handoff-run-with-advice', ...targets.flatMap((target) => [`handoff-${target}`, `handoff-${target}-with-advice`])];
const commandModes = { claude: ['build', 'review'], codex: ['build', 'review'], cursor: ['build', 'review'], grok: ['build', 'review'], kiro: ['review'], opencode: ['build', 'review'] };

test('Claude and Codex manifests expose the same shared skill root and no executable registration', () => {
  const claude = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  const codex = JSON.parse(readFileSync('.codex-plugin/plugin.json', 'utf8'));
  assert.equal(claude.version, '0.4.0');
  assert.equal(codex.version, '0.4.0');
  assert.equal(claude.skills, './skills');
  assert.equal(codex.skills, './skills/');
  assert.equal(claude.commands, './commands');
  for (const manifest of [claude, codex]) {
    assert.match(manifest.description, /plain and with-advice/u);
    for (const forbidden of ['bin', 'mcpServers', 'executables', 'path']) assert.equal(Object.hasOwn(manifest, forbidden), false, forbidden);
  }
  for (const skill of skills) assert.equal(existsSync(join('skills', skill, 'SKILL.md')), true, skill);
});

test('Claude manifest command root reaches all eleven plain and eleven with-advice commands', () => {
  for (const [target, modes] of Object.entries(commandModes)) {
    for (const mode of modes) {
      assert.equal(existsSync(join('commands', `${target}-${mode}.md`)), true);
      assert.equal(existsSync(join('commands', `${target}-${mode}-with-advice.md`)), true);
    }
  }
});
