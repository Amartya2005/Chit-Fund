import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { DECIMAL_FIELDS, ENGINE_DECIMAL_MODELS } from '../../src/config/prisma.js';

describe('Prisma money field configuration', () => {
  it('converts every legacy Decimal column back to a number; engine models stay exact', () => {
    const fromSchema: Record<string, string[]> = {};
    for (const model of Prisma.dmmf.datamodel.models) {
      const decimals = model.fields.filter((f) => f.type === 'Decimal').map((f) => f.name);
      if (decimals.length && !ENGINE_DECIMAL_MODELS.includes(model.name)) fromSchema[model.name] = decimals.sort();
    }
    // engine models are never converted to floats
    for (const m of ENGINE_DECIMAL_MODELS) expect(DECIMAL_FIELDS[m], m).toBeUndefined();
    const configured = Object.fromEntries(Object.entries(DECIMAL_FIELDS).map(([k, v]) => [k, [...v].sort()]));
    expect(configured).toEqual(fromSchema);
  });

  it('has no floating point money columns left', () => {
    const floats = Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.filter((f) => f.type === 'Float').map((f) => `${m.name}.${f.name}`));
    expect(floats).toEqual([]);
  });
});
