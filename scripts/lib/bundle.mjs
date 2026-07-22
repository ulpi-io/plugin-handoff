import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_VERSION } from './contracts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const BUNDLE_FILES = Object.freeze([
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'commands/claude-build.md',
  'commands/claude-build-with-advice.md',
  'commands/claude-review.md',
  'commands/claude-review-with-advice.md',
  'commands/codex-build.md',
  'commands/codex-build-with-advice.md',
  'commands/codex-review.md',
  'commands/codex-review-with-advice.md',
  'commands/cursor-build.md',
  'commands/cursor-build-with-advice.md',
  'commands/cursor-review.md',
  'commands/cursor-review-with-advice.md',
  'commands/grok-build.md',
  'commands/grok-build-with-advice.md',
  'commands/grok-review.md',
  'commands/grok-review-with-advice.md',
  'commands/kiro-review.md',
  'commands/kiro-review-with-advice.md',
  'commands/opencode-build.md',
  'commands/opencode-build-with-advice.md',
  'commands/opencode-review.md',
  'commands/opencode-review-with-advice.md',
  'contracts/v0.3/capabilities.schema.json',
  'contracts/v0.3/dag.schema.json',
  'contracts/v0.3/mcp.schema.json',
  'contracts/v0.3/provider-output.schema.json',
  'contracts/v0.3/request.schema.json',
  'contracts/v0.3/result.schema.json',
  'scripts/handoff.mjs',
  'scripts/lib/agents-policy.mjs',
  'scripts/lib/bundle.mjs',
  'scripts/lib/capability-grants.mjs',
  'scripts/lib/contracts.mjs',
  'scripts/lib/dag.mjs',
  'scripts/lib/frontend.mjs',
  'scripts/lib/git.mjs',
  'scripts/lib/invocation-authority.mjs',
  'scripts/lib/machine.mjs',
  'scripts/lib/nested-client.mjs',
  'scripts/lib/paths.mjs',
  'scripts/lib/provider-preflight.mjs',
  'scripts/lib/request-preparer.mjs',
  'scripts/lib/selection.mjs',
  'scripts/lib/supervisor.mjs',
  'scripts/lib/which.mjs',
  'scripts/lib/providers/claude.mjs',
  'scripts/lib/providers/codex.mjs',
  'scripts/lib/providers/cursor.mjs',
  'scripts/lib/providers/grok.mjs',
  'scripts/lib/providers/kiro.mjs',
  'scripts/lib/providers/opencode.mjs',
  'skills/get-advice/SKILL.md',
  'skills/get-advice/agents/openai.yaml',
  'skills/handoff-claude/SKILL.md',
  'skills/handoff-claude/agents/openai.yaml',
  'skills/handoff-claude-with-advice/SKILL.md',
  'skills/handoff-claude-with-advice/agents/openai.yaml',
  'skills/handoff-codex/SKILL.md',
  'skills/handoff-codex/agents/openai.yaml',
  'skills/handoff-codex-with-advice/SKILL.md',
  'skills/handoff-codex-with-advice/agents/openai.yaml',
  'skills/handoff-cursor/SKILL.md',
  'skills/handoff-cursor/agents/openai.yaml',
  'skills/handoff-cursor-with-advice/SKILL.md',
  'skills/handoff-cursor-with-advice/agents/openai.yaml',
  'skills/handoff-grok/SKILL.md',
  'skills/handoff-grok/agents/openai.yaml',
  'skills/handoff-grok-with-advice/SKILL.md',
  'skills/handoff-grok-with-advice/agents/openai.yaml',
  'skills/handoff-kiro/SKILL.md',
  'skills/handoff-kiro/agents/openai.yaml',
  'skills/handoff-kiro-with-advice/SKILL.md',
  'skills/handoff-kiro-with-advice/agents/openai.yaml',
  'skills/handoff-opencode/SKILL.md',
  'skills/handoff-opencode/agents/openai.yaml',
  'skills/handoff-opencode-with-advice/SKILL.md',
  'skills/handoff-opencode-with-advice/agents/openai.yaml',
  'skills/handoff-run/SKILL.md',
  'skills/handoff-run/agents/openai.yaml',
  'skills/handoff-run-with-advice/SKILL.md',
  'skills/handoff-run-with-advice/agents/openai.yaml',
]);

export const BUNDLE_DIGEST_PATH = resolve(root, 'bundle-digest.json');

function add(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(size).update(bytes);
}
export function computeBundleDigest() {
  const hash = createHash('sha256');
  for (const file of BUNDLE_FILES) {
    add(hash, file);
    add(hash, readFileSync(resolve(root, file)));
  }
  return `sha256:${hash.digest('hex')}`;
}

export function readBundleDigest() {
  let manifest;
  try { manifest = JSON.parse(readFileSync(BUNDLE_DIGEST_PATH, 'utf8')); }
  catch (error) { throw new Error(`bundle digest manifest is unreadable: ${error.message}`); }
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['algorithm', 'bundleVersion', 'digest', 'files', 'schemaVersion'])) {
    throw new Error('bundle digest manifest has unknown or missing fields');
  }
  if (manifest.schemaVersion !== 'handoff.bundle-digest.v0.3' || manifest.bundleVersion !== BUNDLE_VERSION || manifest.algorithm !== 'sha256') {
    throw new Error('bundle digest manifest version drift');
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(BUNDLE_FILES)) throw new Error('bundle digest file-set drift');
  const computed = computeBundleDigest();
  if (manifest.digest !== computed) throw new Error('bundle digest mismatch');
  return manifest;
}
