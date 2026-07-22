import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ContractError, DAG_SCHEMA_VERSION_V03, parseDagSnapshot, sha256 } from './contracts.mjs';
import { atomicWritePrivateFile, createSupervisorRuntimeDirectory } from './paths.mjs';
import { resolveBudgets } from './selection.mjs';

const TERMINAL = new Set(['succeeded', 'blocked', 'failed', 'timed_out', 'cancelled', 'rejected', 'not_run']);

function iso() { return new Date().toISOString(); }

function nodeFromRequest(request, state = 'pending') {
  return {
    runId: request.lineage.runId,
    parentRunId: request.lineage.parentRunId,
    depth: request.lineage.depth,
    operation: request.operation,
    callerHarness: request.caller.harness,
    targetHarness: request.target.harness,
    mode: request.mode,
    delegation: structuredClone(request.delegation),
    intentHash: request.intentHash,
    dependencies: structuredClone(request.lineage.dependencies),
    state,
    requestHash: null,
    resultHash: null,
    startedAt: state === 'running' ? iso() : null,
    finishedAt: null,
  };
}

export class DagStore {
  constructor({ rootRequest, auditPath, limits = rootRequest.budgets.limits }) {
    this.auditPath = auditPath;
    this.limits = resolveBudgets(limits);
    this.rootRunId = rootRequest.lineage.rootRunId;
    this.nodes = new Map();
    this.revision = 0;
    this.status = 'running';
    const root = nodeFromRequest(rootRequest, 'running');
    if (root.runId !== this.rootRunId || root.parentRunId !== null || root.depth !== 0) throw new ContractError('DAG root request has inconsistent lineage');
    this.nodes.set(root.runId, root);
    this.write();
  }

  counts() {
    let advice = 0;
    let handoff = 0;
    let active = 0;
    for (const node of this.nodes.values()) {
      if (node.operation === 'advice') advice += 1;
      else handoff += 1;
      if (node.state === 'running') active += 1;
    }
    return { advice, handoff, active };
  }

  snapshot() {
    const counts = this.counts();
    return {
      schemaVersion: DAG_SCHEMA_VERSION_V03,
      rootRunId: this.rootRunId,
      revision: this.revision,
      status: this.status,
      limits: { ...this.limits },
      remaining: {
        nodes: this.limits.maxNodes - this.nodes.size,
        adviceNodes: this.limits.maxAdviceNodes - counts.advice,
        handoffNodes: this.limits.maxHandoffNodes - counts.handoff,
      },
      activeCount: counts.active,
      nodes: [...this.nodes.values()].map((node) => structuredClone(node)),
    };
  }

  write() {
    const snapshot = this.snapshot();
    parseDagSnapshot(Buffer.from(JSON.stringify(snapshot)));
    atomicWritePrivateFile(this.auditPath, `${JSON.stringify(snapshot)}\n`);
    return snapshot;
  }

  ancestors(parentRunId) {
    const values = [];
    let current = parentRunId;
    const visited = new Set();
    while (current !== null) {
      if (visited.has(current)) throw new ContractError('DAG parent ancestry contains a cycle');
      visited.add(current);
      const node = this.nodes.get(current);
      if (!node) throw new ContractError(`DAG parent '${current}' does not exist`);
      values.push(node);
      current = node.parentRunId;
    }
    return values;
  }

  register(request, requestHash) {
    if (this.status !== 'running') throw new ContractError('DAG is terminal');
    const node = nodeFromRequest(request);
    if (this.nodes.has(node.runId)) throw new ContractError(`DAG run ID '${node.runId}' already exists`);
    if (node.parentRunId === null) throw new ContractError('nested DAG node requires a parent');
    const parent = this.nodes.get(node.parentRunId);
    if (!parent) throw new ContractError(`DAG parent '${node.parentRunId}' does not exist`);
    if (node.depth !== parent.depth + 1 || node.depth > this.limits.maxDepth) throw new ContractError('nested DAG depth is invalid or exhausted');
    if (node.callerHarness !== parent.targetHarness) throw new ContractError('nested caller harness must be derived from the parent target harness');
    if (parent.delegation.mode !== 'advice-only') throw new ContractError('DAG parent does not authorize nested operations');
    if (node.operation !== 'advice' || node.delegation.mode !== 'advice-only' || node.delegation.provenance !== 'parent-attenuated') throw new ContractError('DAG permits nested advice-only delegation only');
    if (this.nodes.size >= this.limits.maxNodes) throw new ContractError('DAG maxNodes budget is exhausted');
    const counts = this.counts();
    if (node.operation === 'advice' && counts.advice >= this.limits.maxAdviceNodes) throw new ContractError('DAG maxAdviceNodes budget is exhausted');
    if (counts.active >= this.limits.maxConcurrency) throw new ContractError('DAG maxConcurrency budget is exhausted');
    if (this.ancestors(node.parentRunId).some((ancestor) => ancestor.intentHash === node.intentHash)) throw new ContractError('DAG rejects repeated intent in its ancestry');
    for (const dependency of node.dependencies) {
      if (dependency.runId === node.runId) throw new ContractError('DAG node cannot depend on itself');
      const dependencyNode = this.nodes.get(dependency.runId);
      if (!dependencyNode) throw new ContractError(`DAG dependency '${dependency.runId}' does not exist`);
      if (!TERMINAL.has(dependencyNode.state)) throw new ContractError(`DAG dependency '${dependency.runId}' is incomplete`);
      if (dependency.type === 'requires' && dependencyNode.state !== 'succeeded') throw new ContractError(`required DAG dependency '${dependency.runId}' did not succeed`);
    }
    node.requestHash = requestHash;
    node.state = 'running';
    node.startedAt = iso();
    this.nodes.set(node.runId, node);
    this.revision += 1;
    this.write();
    return structuredClone(node);
  }

  terminalize(runId, { state, resultBytes = null }) {
    if (!TERMINAL.has(state)) throw new ContractError('DAG terminal state is invalid');
    const node = this.nodes.get(runId);
    if (!node) throw new ContractError(`DAG run ID '${runId}' does not exist`);
    if (TERMINAL.has(node.state)) throw new ContractError(`DAG run ID '${runId}' is already terminal`);
    node.state = state;
    node.resultHash = resultBytes ? sha256(resultBytes) : null;
    node.finishedAt = iso();
    this.revision += 1;
    return this.write();
  }

  close(state) {
    if (!['succeeded', 'blocked', 'failed', 'timed_out', 'cancelled'].includes(state)) throw new ContractError('DAG root terminal state is invalid');
    for (const node of this.nodes.values()) {
      if (!TERMINAL.has(node.state)) {
        node.state = state === 'cancelled' ? 'cancelled' : 'blocked';
        node.finishedAt = iso();
      }
    }
    this.status = state;
    this.revision += 1;
    return this.write();
  }
}

export function createDagRuntime(rootRequest) {
  const directory = createSupervisorRuntimeDirectory();
  const auditPath = join(directory, 'dag.json');
  return { directory, auditPath, store: new DagStore({ rootRequest, auditPath }) };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function scavengeSupervisorRuntimes({ base = join(tmpdir(), 'handoff-supervisors'), now = Date.now(), minimumAgeMs = 86_400_000 } = {}) {
  if (!existsSync(base)) return [];
  const baseReal = resolve(base);
  const removed = [];
  for (const name of readdirSync(base)) {
    const match = /^handoff-v03-(\d+)-(\d+)-[A-Za-z0-9]+$/u.exec(name);
    if (!match) continue;
    const target = join(baseReal, name);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) continue;
    if (Number(match[1]) !== process.getuid?.() || processAlive(Number(match[2])) || now - stat.mtimeMs < minimumAgeMs) continue;
    if (dirname(target) !== baseReal || basename(target) !== name) continue;
    rmSync(target, { recursive: true, force: false });
    removed.push(target);
  }
  return removed;
}
