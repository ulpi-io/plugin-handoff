import { ContractError } from './contracts.mjs';

export const HARNESSES = Object.freeze(['codex', 'grok', 'kiro', 'claude', 'opencode', 'cursor']);
export const OPERATIONS = Object.freeze(['advice', 'handoff']);
export const MODES = Object.freeze(['build', 'phase', 'review', 'verify']);
export const ROOT_VERBS = Object.freeze(['advice', 'run', 'run-with-advice']);
export const DELEGATION_MODES = Object.freeze(['none', 'advice-only']);

export const DEFAULT_BUDGETS = Object.freeze({
  maxDepth: 3,
  maxNodes: 16,
  maxAdviceNodes: 12,
  maxHandoffNodes: 4,
  maxConcurrency: 4,
  rootTimeoutMs: 1_800_000,
  timeoutMs: 600_000,
});

const EFFORTS = Object.freeze({
  codex: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  grok: Object.freeze(['low', 'medium', 'high']),
  kiro: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  claude: Object.freeze(['low', 'medium', 'high', 'max']),
  opencode: Object.freeze(['low', 'medium', 'high', 'max']),
  cursor: Object.freeze([]),
});

export function resolveDelegation({ verb, parent = null }) {
  if (parent !== null) {
    if (verb !== 'advice') throw new ContractError('nested Handoff permits advice only');
    if (!parent || parent.mode !== 'advice-only') throw new ContractError('nested advice requires an advice-only parent capability');
    return Object.freeze({ mode: 'advice-only', provenance: 'parent-attenuated' });
  }
  if (!ROOT_VERBS.includes(verb)) throw new ContractError(`root verb must be ${ROOT_VERBS.join('|')}`);
  return Object.freeze({
    mode: verb === 'run' ? 'none' : 'advice-only',
    provenance: 'verb-derived',
  });
}

export const SELECTION_CAPABILITIES = Object.freeze(Object.fromEntries(HARNESSES.map((harness) => [harness, Object.freeze({
  model: true,
  effort: EFFORTS[harness].length > 0,
  efforts: EFFORTS[harness],
  maxTurns: harness === 'grok' || harness === 'claude',
})])));

function safeValue(value, label, max) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.startsWith('-') || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContractError(`${label} is unsafe or invalid`);
  }
  return value;
}

export function validateOperation({ operation, callerHarness, targetHarness, mode, provenance = 'root-asserted' }) {
  if (!OPERATIONS.includes(operation)) throw new ContractError(`operation must be ${OPERATIONS.join('|')}`);
  if (!HARNESSES.includes(callerHarness)) throw new ContractError(`caller harness must be ${HARNESSES.join('|')}`);
  if (!HARNESSES.includes(targetHarness)) throw new ContractError(`target harness must be ${HARNESSES.join('|')}`);
  if (!['root-asserted', 'supervisor-derived'].includes(provenance)) throw new ContractError('caller provenance is unsupported');
  if (operation === 'advice' && mode !== null && mode !== undefined) throw new ContractError('advice does not accept a mode');
  if (operation === 'handoff') {
    if (!MODES.includes(mode)) throw new ContractError(`handoff mode must be ${MODES.join('|')}`);
    if (!['codex', 'claude'].includes(callerHarness)) throw new ContractError('handoff callers must be codex|claude');
  }
}

export function resolveSelection({ operation, targetHarness, model, effort, maxTurns }) {
  if (!OPERATIONS.includes(operation)) throw new ContractError(`operation must be ${OPERATIONS.join('|')}`);
  if (!HARNESSES.includes(targetHarness)) throw new ContractError(`target harness must be ${HARNESSES.join('|')}`);
  const capability = SELECTION_CAPABILITIES[targetHarness];
  const requested = {
    model: model ?? null,
    effort: effort ?? null,
    maxTurns: maxTurns ?? null,
  };
  if (model !== undefined && model !== null) safeValue(model, '--model', 256);
  if (effort !== undefined && effort !== null) {
    safeValue(effort, '--effort', 64);
    if (!capability.effort) throw new ContractError(`--effort is unsupported for ${targetHarness}`);
    if (!capability.efforts.includes(effort)) throw new ContractError(`--effort for ${targetHarness} must be ${capability.efforts.join('|')}`);
  }
  if (maxTurns !== undefined && maxTurns !== null) {
    if (!capability.maxTurns) throw new ContractError(`--max-turns is unsupported for ${targetHarness}`);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new ContractError('--max-turns must be an integer from 1 through 100');
  }
  const operationEffort = operation === 'advice' && ['codex', 'claude', 'kiro'].includes(targetHarness) ? 'max' : null;
  const operationTurns = ['grok', 'claude'].includes(targetHarness) ? (operation === 'advice' ? 32 : 12) : null;
  return Object.freeze({
    requested: Object.freeze(requested),
    resolved: Object.freeze({
      model: model ?? 'provider-default',
      effort: effort ?? operationEffort ?? 'provider-default',
      maxTurns: maxTurns ?? operationTurns,
    }),
    provenance: Object.freeze({
      model: model == null ? 'provider-default' : 'explicit',
      effort: effort == null ? (operationEffort ? 'operation-default' : 'provider-default') : 'explicit',
      maxTurns: maxTurns == null ? (operationTurns ? 'operation-default' : 'provider-default') : 'explicit',
    }),
  });
}

export function resolveBudgets(overrides = {}) {
  const allowed = Object.keys(DEFAULT_BUDGETS);
  const unknown = Object.keys(overrides).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ContractError(`unknown budget field(s): ${unknown.join(', ')}`);
  const limits = { ...DEFAULT_BUDGETS, ...overrides };
  const bounds = {
    maxDepth: [0, 32], maxNodes: [1, 256], maxAdviceNodes: [0, 256], maxHandoffNodes: [0, 256],
    maxConcurrency: [1, 32], rootTimeoutMs: [100, 86_400_000], timeoutMs: [100, 3_600_000],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new ContractError(`${key} must be an integer from ${min} through ${max}`);
  }
  if (limits.maxAdviceNodes + limits.maxHandoffNodes < limits.maxNodes) {
    throw new ContractError('maxAdviceNodes + maxHandoffNodes must cover maxNodes');
  }
  if (limits.timeoutMs > limits.rootTimeoutMs) throw new ContractError('timeoutMs must not exceed rootTimeoutMs');
  return Object.freeze(limits);
}
