#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { BUNDLE_DIGEST_PATH, BUNDLE_FILES, computeBundleDigest, readBundleDigest } from './lib/bundle.mjs';
import { BUNDLE_VERSION } from './lib/contracts.mjs';

const mode = process.argv[2] || '--check';
if (!['--check', '--write', '--json'].includes(mode) || process.argv.length > 3) {
  console.error('usage: node scripts/bundle-digest.mjs [--check|--write|--json]');
  process.exitCode = 5;
} else if (mode === '--check') {
  try {
    const manifest = readBundleDigest();
    process.stdout.write(`${manifest.digest}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  const manifest = {
    schemaVersion: 'handoff.bundle-digest.v0.3',
    bundleVersion: BUNDLE_VERSION,
    algorithm: 'sha256',
    files: [...BUNDLE_FILES],
    digest: computeBundleDigest(),
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (mode === '--write') writeFileSync(BUNDLE_DIGEST_PATH, serialized);
  process.stdout.write(mode === '--write' ? `${manifest.digest}\n` : serialized);
}
