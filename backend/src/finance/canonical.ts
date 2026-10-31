import { createHash } from 'node:crypto';
import { D } from './decimal.js';
import { FINANCE_ENGINE_VERSION } from './version.js';

/**
 * Canonical JSON: object keys sorted recursively, decimals as strings, no whitespace.
 * Two semantically identical inputs always produce byte-identical text (INV-G2).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof D) return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => [k, normalize(obj[k])])
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number in canonical JSON');
  return value;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface CalculationRecord<I, P, O> {
  engine: 'CHIT';
  kind: string;
  engineVersion: string;
  inputs: I;
  policy: P;
  outputs: O;
  inputHash: string;
  policyHash: string;
  outputHash: string;
}

/** Everything needed to reproduce and verify a calculation later (FR-FIN-05). */
export function buildCalculationRecord<I, P, O>(kind: string, inputs: I, policy: P, outputs: O): CalculationRecord<I, P, O> {
  return {
    engine: 'CHIT',
    kind,
    engineVersion: FINANCE_ENGINE_VERSION,
    inputs,
    policy,
    outputs,
    inputHash: sha256(canonicalize(inputs)),
    policyHash: sha256(canonicalize(policy)),
    outputHash: sha256(canonicalize(outputs)),
  };
}

/**
 * Re-run a stored calculation and confirm it reproduces the stored output exactly.
 * Returns false (never throws) when the output differs or the record was produced by a
 * different engine version.
 */
export function verifyCalculationRecord<I, P, O>(record: CalculationRecord<I, P, O>, recompute: (inputs: I, policy: P) => O): { reproducible: boolean; reason?: string } {
  if (record.engineVersion !== FINANCE_ENGINE_VERSION) {
    return { reproducible: false, reason: `record engine ${record.engineVersion} ≠ current ${FINANCE_ENGINE_VERSION}` };
  }
  if (sha256(canonicalize(record.inputs)) !== record.inputHash || sha256(canonicalize(record.policy)) !== record.policyHash) {
    return { reproducible: false, reason: 'stored inputs or policy do not match their hashes' };
  }
  const out = recompute(record.inputs, record.policy);
  return sha256(canonicalize(out)) === record.outputHash ? { reproducible: true } : { reproducible: false, reason: 'recomputed output differs' };
}
