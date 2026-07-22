import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { ContractError, parseMachineResultV03, sha256 } from './contracts.mjs';
import { createDagRuntime, scavengeSupervisorRuntimes } from './dag.mjs';
import { prepareV03Request } from './request-preparer.mjs';

const MAX_FRAME_BYTES = 2_300_000;

function endpointFor(directory) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\handoff-${process.pid}-${randomUUID()}`
    : join(directory, 'mailbox');
}

function terminalState(result) {
  return ['succeeded', 'blocked', 'failed', 'timed_out', 'cancelled', 'rejected', 'not_run'].includes(result.status) ? result.status : 'failed';
}

function exactObject(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(`${where} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new ContractError(`${where} contains unknown field(s): ${unknown.join(', ')}`);
}

export class HandoffSupervisor {
  constructor({ rootPrepared, executeMachineRun, prepareRequest = prepareV03Request, cleanup = true }) {
    if (typeof executeMachineRun !== 'function') throw new ContractError('supervisor requires an injected executeMachineRun authority');
    this.rootPrepared = rootPrepared;
    this.executeMachineRun = executeMachineRun;
    this.prepareRequest = prepareRequest;
    this.cleanup = cleanup;
    this.runtime = createDagRuntime(rootPrepared.request);
    this.endpoint = endpointFor(this.runtime.directory);
    this.capabilities = new Map();
    this.active = new Set();
    this.server = null;
    this.poller = null;
    this.polling = false;
    this.mailboxHandlers = new Set();
    this.closed = false;
    this.rootDeadline = Date.now() + rootPrepared.request.budgets.limits.rootTimeoutMs;
    scavengeSupervisorRuntimes();
  }

  issueCapability({ parentRunId, callerHarness, parentGrants, parentDelegation, maxUses = this.rootPrepared.request.budgets.limits.maxNodes }) {
    if (this.closed) throw new ContractError('supervisor is closed');
    if (parentDelegation?.mode !== 'advice-only') throw new ContractError('parent request does not authorize nested advice');
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(token, {
      parentRunId,
      callerHarness,
      parentGrants: structuredClone(parentGrants),
      parentDelegation: structuredClone(parentDelegation),
      allowedOperations: ['advice'],
      remainingUses: maxUses,
      nonces: new Set(),
    });
    return token;
  }

  contextForRoot() {
    const request = this.rootPrepared.request;
    if (request.delegation.mode !== 'advice-only') throw new ContractError('plain handoff has no supervisor capability');
    const token = this.issueCapability({
      parentRunId: request.lineage.runId,
      callerHarness: request.target.harness,
      parentGrants: request.grants,
      parentDelegation: request.delegation,
    });
    return JSON.stringify({
      schemaVersion: 'handoff.supervisor-context.v0.3',
      endpoint: this.endpoint,
      token,
      callerHarness: request.target.harness,
      rootRunId: request.lineage.rootRunId,
      allowedOperations: ['advice'],
    });
  }

  async start() {
    if (this.server || this.poller) throw new ContractError('supervisor is already started');
    if (process.platform !== 'win32') {
      mkdirSync(join(this.endpoint, 'requests'), { recursive: true, mode: 0o700 });
      mkdirSync(join(this.endpoint, 'replies'), { recursive: true, mode: 0o700 });
      this.poller = setInterval(() => { void this.pollMailbox(); }, 10);
      this.poller.unref?.();
      return this;
    }
    this.server = createServer((socket) => {
      let bytes = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > MAX_FRAME_BYTES) socket.destroy(new Error('supervisor request frame exceeds limit'));
        const newline = bytes.indexOf(10);
        if (newline === -1) return;
        const frame = bytes.subarray(0, newline);
        const trailing = bytes.subarray(newline + 1);
        if (trailing.length) { socket.destroy(new Error('supervisor accepts exactly one frame')); return; }
        socket.pause();
        this.handleFrame(frame).then((response) => {
          socket.end(`${JSON.stringify(response)}\n`);
        }).catch((error) => {
          socket.end(`${JSON.stringify({ schemaVersion: 'handoff.supervisor-reply.v0.3', ok: false, error: error.message })}\n`);
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    return this;
  }

  async pollMailbox() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const requests = join(this.endpoint, 'requests');
      const replies = join(this.endpoint, 'replies');
      for (const name of readdirSync(requests).filter((entry) => /^request-[0-9a-f-]{36}\.json$/u.test(entry)).sort()) {
        const requestPath = join(requests, name);
        let frame;
        try {
          frame = readFileSync(requestPath);
          if (frame.length > MAX_FRAME_BYTES) throw new ContractError('supervisor request frame exceeds limit');
        } finally {
          rmSync(requestPath, { force: true });
        }
        const replyName = name.replace(/^request-/u, 'reply-');
        const handler = (async () => {
          let response;
          try { response = await this.handleFrame(frame); }
          catch (error) { response = { schemaVersion: 'handoff.supervisor-reply.v0.3', ok: false, error: error.message }; }
          writeFileSync(join(replies, replyName), `${JSON.stringify(response)}\n`, { mode: 0o600, flag: 'wx' });
        })();
        this.mailboxHandlers.add(handler);
        void handler.then(
          () => this.mailboxHandlers.delete(handler),
          () => this.mailboxHandlers.delete(handler),
        );
      }
    } finally {
      this.polling = false;
    }
  }

  async handleFrame(frame) {
    if (this.closed) throw new ContractError('supervisor is terminal');
    if (Date.now() >= this.rootDeadline) throw new ContractError('supervisor root timeout is exhausted');
    let message;
    try { message = JSON.parse(frame.toString('utf8')); } catch { throw new ContractError('supervisor request is not valid JSON'); }
    const keys = ['schemaVersion', 'token', 'nonce', 'operation', 'targetHarness', 'mode', 'cwd', 'instructions', 'selection', 'grants', 'mcp', 'dependencies'];
    exactObject(message, keys, 'supervisor request');
    if (message.schemaVersion !== 'handoff.supervisor-request.v0.3') throw new ContractError('supervisor request version drift');
    const capability = this.capabilities.get(message.token);
    if (!capability) throw new ContractError('supervisor capability token is invalid');
    if (message.operation !== 'advice' || !capability.allowedOperations.includes(message.operation)) throw new ContractError('supervisor capability permits nested advice only');
    if (typeof message.nonce !== 'string' || !message.nonce || capability.nonces.has(message.nonce)) throw new ContractError('supervisor request nonce is invalid or replayed');
    if (capability.remainingUses < 1) throw new ContractError('supervisor capability is exhausted');
    capability.nonces.add(message.nonce);
    capability.remainingUses -= 1;
    const parent = this.runtime.store.nodes.get(capability.parentRunId);
    if (!parent) throw new ContractError('supervisor capability parent is missing');
    const runId = `run-${randomUUID()}`;
    const instructionPath = join(this.runtime.directory, `instructions-${runId}.txt`);
    if (typeof message.instructions !== 'string' || !message.instructions.trim() || Buffer.byteLength(message.instructions) > 2_000_000) throw new ContractError('nested instructions are empty or oversized');
    writeFileSync(instructionPath, message.instructions, { mode: 0o600, flag: 'wx' });
    let mcpPath;
    if (message.mcp !== null && message.mcp !== undefined) {
      if (typeof message.mcp !== 'string' || Buffer.byteLength(message.mcp, 'base64') > 256_000) throw new ContractError('nested MCP descriptor is invalid or oversized');
      mcpPath = join(this.runtime.directory, `mcp-source-${runId}.json`);
      writeFileSync(mcpPath, Buffer.from(message.mcp, 'base64'), { mode: 0o600, flag: 'wx' });
    }
    const snapshot = this.runtime.store.snapshot();
    const lineage = {
      rootRunId: snapshot.rootRunId,
      runId,
      parentRunId: capability.parentRunId,
      depth: parent.depth + 1,
      dependencies: Array.isArray(message.dependencies) ? message.dependencies : [],
    };
    const timeoutMs = Math.min(snapshot.limits.timeoutMs, Math.max(100, this.rootDeadline - Date.now()));
    const prepared = this.prepareRequest({
      verb: 'advice',
      operation: message.operation,
      callerHarness: capability.callerHarness,
      targetHarness: message.targetHarness,
      mode: message.mode,
      cwd: message.cwd,
      instructionsPath: instructionPath,
      model: message.selection?.model,
      effort: message.selection?.effort,
      maxTurns: message.selection?.maxTurns,
      bash: message.grants?.bash,
      webSearch: message.grants?.webSearch,
      mcpConfig: mcpPath,
      parentGrants: capability.parentGrants,
      parentDelegation: capability.parentDelegation,
      provenance: 'supervisor-derived',
      lineage,
      limits: snapshot.limits,
      budgets: { limits: snapshot.limits, remaining: snapshot.remaining },
      tempRoot: this.runtime.directory,
    });
    this.runtime.store.register(prepared.request, prepared.requestHash);
    const requestPath = join(this.runtime.directory, `request-${runId}.json`);
    const resultPath = join(this.runtime.directory, `result-${runId}.json`);
    writeFileSync(requestPath, prepared.bytes, { mode: 0o600, flag: 'wx' });
    const execution = this.executeMachineRun({
      command: 'run',
      provider: prepared.request.target.harness,
      role: prepared.request.operation === 'advice' ? 'review' : prepared.request.mode,
      cwd: prepared.request.cwd,
      request: requestPath,
      result: resultPath,
      runtime: { supervisorContext: this.childContext(prepared.request), mcp: prepared.internal, dagSnapshot: () => this.runtime.store.snapshot() },
    });
    this.active.add(execution);
    let machine;
    try { machine = await execution; }
    finally { this.active.delete(execution); }
    const resultBytes = readFileSync(resultPath);
    const result = parseMachineResultV03(resultBytes);
    const dag = this.runtime.store.terminalize(runId, { state: terminalState(result), resultBytes });
    return {
      schemaVersion: 'handoff.supervisor-reply.v0.3',
      ok: true,
      exitCode: machine.exitCode,
      result: resultBytes.toString('base64'),
      resultHash: sha256(resultBytes),
      dagRevision: dag.revision,
    };
  }

  childContext(request) {
    const token = this.issueCapability({
      parentRunId: request.lineage.runId,
      callerHarness: request.target.harness,
      parentGrants: request.grants,
      parentDelegation: request.delegation,
    });
    return JSON.stringify({
      schemaVersion: 'handoff.supervisor-context.v0.3',
      endpoint: this.endpoint,
      token,
      callerHarness: request.target.harness,
      rootRunId: request.lineage.rootRunId,
      allowedOperations: ['advice'],
    });
  }

  async close(status = 'cancelled') {
    if (this.closed) return this.runtime.store.snapshot();
    this.closed = true;
    this.capabilities.clear();
    const final = this.runtime.store.close(status);
    if (this.poller) clearInterval(this.poller);
    while (this.polling) await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.allSettled([...this.mailboxHandlers]);
    await new Promise((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
    if (this.cleanup) { try { rmSync(this.runtime.directory, { recursive: true, force: true }); } catch { /* exact runtime directory only */ } }
    return final;
  }
}
