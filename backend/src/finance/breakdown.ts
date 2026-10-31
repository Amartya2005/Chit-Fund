import { Dec } from './decimal.js';

/** One step of a calculation, recorded for auditability (FR-FIN-04). All numbers are exact strings. */
export interface CalcStep {
  step: string;
  formula: string;
  inputs?: Record<string, string>;
  unrounded?: string;
  rounding?: string;
  result: string;
}

export class StepRecorder {
  readonly steps: CalcStep[] = [];

  add(step: string, formula: string, result: Dec | string, extra: { inputs?: Record<string, Dec | string | number>; unrounded?: Dec; rounding?: string } = {}) {
    const inputs = extra.inputs
      ? Object.fromEntries(Object.entries(extra.inputs).map(([k, v]) => [k, typeof v === 'object' ? v.toString() : String(v)]))
      : undefined;
    this.steps.push({
      step,
      formula,
      ...(inputs ? { inputs } : {}),
      ...(extra.unrounded !== undefined ? { unrounded: extra.unrounded.toString() } : {}),
      ...(extra.rounding ? { rounding: extra.rounding } : {}),
      result: typeof result === 'string' ? result : result.toString(),
    });
  }
}
