import { api, bearer } from './helpers.js';

/**
 * Engine test helpers. The policy values below are TEST CHOICES used to exercise the engine,
 * not business recommendations; legal limit values are placeholders.
 */
export const P = '/api/v1/financial-policies';
export const E = '/api/v1/engine';

export async function activatePolicy(token: string, body: Record<string, unknown>) {
  const c = await api().post(P).set(bearer(token)).send(body);
  if (c.status !== 201) throw new Error(`policy create failed ${c.status} ${JSON.stringify(c.body)}`);
  const a = await api().post(`${P}/${c.body.data.id}/activate`).set(bearer(token)).send({});
  if (a.status !== 200) throw new Error(`policy activate failed ${a.status} ${JSON.stringify(a.body)}`);
  return a.body.data;
}

export type Overrides = Partial<Record<'CHIT_ECONOMICS' | 'AUCTION_RULES' | 'DIVIDEND' | 'CONTRIBUTION' | 'PENALTY' | 'SETTLEMENT' | 'SCHEDULING' | 'ELIGIBILITY' | 'BIDDING', Record<string, unknown>>>;

export const TEST_POLICIES = (): Required<Omit<Overrides, 'AUCTION_RULES' | 'BIDDING'>> => ({
  CHIT_ECONOMICS: { basis: 'CHIT_VALUE', source: 'FROM_DISCOUNT', rounding: 'HALF_UP', whenDiscountBelowCommission: 'REJECT' },
  DIVIDEND: { divisor: 'SEATS', unallocatedDestination: 'PENDING_DECISION', timing: 'NEXT_PERIOD_CREDIT' },
  CONTRIBUTION: { rounding: 'PAISE_HALF_UP', differenceHandling: 'TRACK', paymentAllocation: 'TAGGED_PERIOD' },
  PENALTY: { mode: 'NONE' },
  SETTLEMENT: { settlementApproval: 'NONE', adjustmentApproval: 'SECOND_PERSON', prizeDeductions: 'NONE' },
  SCHEDULING: { mode: 'OFFLINE', lockPoint: 'AT_RESULT_ENTRY', noBidRule: 'CANCEL_SESSION' },
  ELIGIBILITY: { maxWinsPerTicket: 1, maxOverdueAmount: 'NOT_CHECKED', requireKycVerified: false, overridableRules: [] },
});

/** Activate a complete company configuration (+ legal limits by the super admin). */
export async function configureCompany(managerToken: string, saToken: string, companyId: string, overrides: Overrides = {}) {
  const base = TEST_POLICIES() as Overrides;
  for (const [kind, values] of Object.entries({ ...base, ...overrides })) {
    await activatePolicy(managerToken, { scope: 'COMPANY', kind, values: { ...(base as any)[kind], ...values } });
  }
  await activatePolicy(saToken, {
    scope: 'COMPANY',
    kind: 'LEGAL_LIMITS',
    companyId,
    values: { maxDiscount: { type: 'PERCENT_OF_CHIT', value: '40' }, maxCommissionPercentOfChit: '5' },
  });
}

export async function enableEngine(saToken: string, companyId: string) {
  const r = await api().patch(`${E}/companies/${companyId}/settings`).set(bearer(saToken)).send({ engineEnabled: true });
  if (r.status !== 200) throw new Error(`enable failed ${JSON.stringify(r.body)}`);
}

export async function convertGroup(token: string, groupId: string) {
  const r = await api().post(`${E}/groups/${groupId}/convert`).set(bearer(token)).send({});
  if (r.status !== 200) throw new Error(`convert failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export async function addMember(token: string, groupId: string, name: string, phone: string) {
  const res = await api().post('/api/v1/subscribers').set(bearer(token)).send({ fullName: name, phone, groupId });
  if (res.status !== 201) throw new Error(`addMember failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export async function createGroup(token: string, body: Record<string, unknown>) {
  const res = await api().post('/api/v1/chit-groups').set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`createGroup failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}
