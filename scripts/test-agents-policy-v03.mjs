import test from 'node:test';
import assert from 'node:assert/strict';
import { bindCodexCoordinatorApproval, codexApprovalSubjectHash } from './lib/agents-policy.mjs';
import { prepareV03Request } from './lib/request-preparer.mjs';

const cwd = process.cwd();
const instructionsPath = new URL('../README.md', import.meta.url).pathname;

test('v0.3 Codex approvals bind the unsigned request and semantic authority', () => {
  const prepared = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'codex', cwd, instructionsPath, tempRoot: '/tmp' });
  const bound = bindCodexCoordinatorApproval({ request: prepared.request, role: 'review', cwd, requestHash: prepared.requestHash });
  assert.equal(bound.subjectHash, prepared.request.coordinatorApproval.subjectHash);
  const changed = structuredClone(prepared.request);
  changed.grants.resolved.bash = false;
  assert.throws(() => bindCodexCoordinatorApproval({ request: changed, role: 'review', cwd, requestHash: prepared.requestHash }), /requestHash|subjectHash/);
});

test('lineage and dependency changes alter the v0.3 approval subject', () => {
  const prepared = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'codex', cwd, instructionsPath, tempRoot: '/tmp' });
  const approval = prepared.request.coordinatorApproval;
  const original = codexApprovalSubjectHash({ request: prepared.request, approval });
  const changed = structuredClone(prepared.request);
  changed.lineage.dependencies = [{ type: 'advises', runId: 'prior-run' }];
  assert.notEqual(codexApprovalSubjectHash({ request: changed, approval }), original);
});

test('delegation changes alter the coordinator approval subject', () => {
  const prepared = prepareV03Request({ verb: 'advice', operation: 'advice', callerHarness: 'grok', targetHarness: 'codex', cwd, instructionsPath, tempRoot: '/tmp' });
  const approval = prepared.request.coordinatorApproval;
  const changed = structuredClone(prepared.request);
  changed.delegation.mode = 'none';
  assert.notEqual(codexApprovalSubjectHash({ request: changed, approval }), codexApprovalSubjectHash({ request: prepared.request, approval }));
});
