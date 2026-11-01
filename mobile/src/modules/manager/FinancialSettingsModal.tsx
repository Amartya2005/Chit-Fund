import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Modal } from 'react-native';
import { api } from '../../services/api';
import { mStyles } from './commonStyles';

/**
 * Read-only "Financial settings" for one chit group (P2).
 * Shows the effective configuration resolved by the backend (GET /financial-policies/effective),
 * where each value comes from, which business decisions are still open, and the version history.
 * Nothing is calculated or decided here; editing screens arrive with the group settings wizard (P5).
 */

type Source = { level: 'COMPANY' | 'GROUP' | 'GROUP_RECORD' | 'LEGAL_LIMITS'; version?: number };
type Issue = { code: string; path: string; message: string };
type Bound = { type: 'AMOUNT' | 'PERCENT_OF_CHIT'; value: string } | null | undefined;

const inr = (v: string | number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const bound = (b: Bound) => (b === null ? 'No limit (set for this group)' : !b ? undefined : b.type === 'AMOUNT' ? inr(b.value) : `${b.value}% of the chit value`);

const LABELS: Record<string, Record<string, string>> = {
  'commission.basis': { CHIT_VALUE: 'Percentage of the chit value', DISCOUNT: 'Percentage of the winning discount', FIXED_AMOUNT: 'Fixed amount' },
  'commission.source': { FROM_DISCOUNT: 'Paid out of the discount (the rest is shared)', FROM_PRIZE: 'Deducted from the winner’s prize' },
  'commission.rounding': { HALF_UP: 'Nearest paisa (half up)', HALF_EVEN: 'Nearest paisa (half to even)', DOWN: 'Paisa, rounded down', UP: 'Paisa, rounded up' },
  'commission.whenDiscountBelowCommission': { REJECT: 'Auction cannot be settled', CAP_TO_DISCOUNT: 'Fee limited to the discount' },
  'dividend.divisor': { SEATS: 'All seats in the group', ACTIVE_TICKETS: 'Active tickets only', ACTIVE_NON_PRIZED_TICKETS: 'Active tickets that have not won' },
  'dividend.timing': { NEXT_PERIOD_CREDIT: 'Reduces next instalment', SAME_PERIOD_CREDIT: 'Reduces this instalment', CASH_PAYOUT: 'Paid out in cash' },
  'dividend.unallocatedDestination': { PENDING_DECISION: 'Kept aside, pending a decision', ROUNDING_RESERVE: 'Kept in a rounding reserve' },
  'contribution.rounding': { PAISE_HALF_UP: 'Nearest paisa', PAISE_DOWN: 'Paisa, rounded down', RUPEE_HALF_UP: 'Nearest rupee' },
  'contribution.differenceHandling': { TRACK: 'Tracked (shown, not adjusted)', LAST_PERIOD_ADJUSTS: 'Last instalment adjusts' },
  'contribution.paymentAllocation': { TAGGED_PERIOD: 'To the instalment the collector picks', OLDEST_FIRST: 'Oldest unpaid instalment first' },
  'penalty.mode': { NONE: 'No penalties', FLAT_PER_PERIOD: 'Fixed amount per missed instalment', PERCENT_OF_OVERDUE: 'Percentage of the overdue amount' },
  'settlement.settlementApproval': { NONE: 'Not needed', SECOND_PERSON: 'Always a second manager', ABOVE_THRESHOLD: 'A second manager above a prize amount' },
  'settlement.adjustmentApproval': { NONE: 'Not needed', SECOND_PERSON: 'A second manager' },
  'settlement.prizeDeductions': { NONE: 'Nothing deducted', OVERDUE_DUES: 'Overdue dues are deducted' },
  'scheduling.mode': { OFFLINE: 'At the office', ONLINE: 'Online', HYBRID: 'Online and at the office' },
  'scheduling.lockPoint': { AT_OPEN: 'When the auction opens', AT_RESULT_ENTRY: 'When the result is entered' },
  'scheduling.noBidRule': { CANCEL_SESSION: 'Auction is cancelled', CARRY_FORWARD: 'Marked “no bid” and carried forward' },
  'bidding.format': { OPEN_ASCENDING: 'Open — everyone sees the best bid', SEALED: 'Sealed until closing' },
  'bidding.showBidderAs': { TICKET_NUMBER: 'Ticket number', NAME: 'Name' },
  'bidding.proxyBidding': { NOT_ALLOWED: 'Not allowed', MANAGER_ON_BEHALF: 'Manager may bid for a member' },
};

const SECTIONS: { title: string; hint: string; rows: { path: string; label: string }[] }[] = [
  {
    title: 'Foreman’s fee (commission)',
    hint: 'What the foreman earns from each auction.',
    rows: [
      { path: 'commission.basis', label: 'Calculated as' },
      { path: 'commission.ratePercent', label: 'Rate' },
      { path: 'commission.fixedAmount', label: 'Fixed fee' },
      { path: 'commission.source', label: 'Who pays it' },
      { path: 'commission.rounding', label: 'Rounding' },
      { path: 'commission.whenDiscountBelowCommission', label: 'If the discount is smaller than the fee' },
    ],
  },
  {
    title: 'Auction limits (discount)',
    hint: 'Amount the winner gives up.',
    rows: [
      { path: 'discount.min', label: 'Minimum discount' },
      { path: 'discount.max', label: 'Maximum discount' },
      { path: 'discount.step', label: 'Bids in steps of' },
    ],
  },
  {
    title: 'Shared back to members (dividend)',
    hint: 'How the rest of the discount is shared.',
    rows: [
      { path: 'dividend.divisor', label: 'Shared among' },
      { path: 'dividend.winnerSharesCurrentDividend', label: 'Winner shares this auction’s dividend' },
      { path: 'dividend.timing', label: 'Members benefit' },
      { path: 'dividend.unallocatedDestination', label: 'Paise left over / unfilled seats' },
    ],
  },
  {
    title: 'Instalments (contribution)',
    hint: 'How the chit value is split into instalments.',
    rows: [
      { path: 'contribution.rounding', label: 'Rounding' },
      { path: 'contribution.differenceHandling', label: 'Rounding difference' },
    ],
  },
  {
    title: 'Collections & penalties',
    hint: 'How payments are applied and what happens when an instalment is late.',
    rows: [
      { path: 'contribution.paymentAllocation', label: 'A payment goes' },
      { path: 'penalty.mode', label: 'Late payment' },
      { path: 'penalty.flatAmount', label: 'Penalty per missed instalment' },
      { path: 'penalty.percent', label: 'Penalty (% of overdue)' },
      { path: 'penalty.graceDays', label: 'Grace days' },
      { path: 'penalty.maxPerPeriod', label: 'Penalty cap per instalment' },
    ],
  },
  {
    title: 'Auctions & approvals',
    hint: 'How auctions run, who may win, who must approve.',
    rows: [
      { path: 'scheduling.mode', label: 'Auctions are held' },
      { path: 'scheduling.lockPoint', label: 'Settings are frozen' },
      { path: 'scheduling.noBidRule', label: 'If nobody bids' },
      { path: 'eligibility.maxWinsPerTicket', label: 'Wins allowed per ticket' },
      { path: 'eligibility.maxOverdueAmount', label: 'Highest overdue amount to win' },
      { path: 'eligibility.requireKycVerified', label: 'KYC must be verified' },
      { path: 'settlement.settlementApproval', label: 'Result approval' },
      { path: 'settlement.approvalThreshold', label: 'Approval needed above' },
      { path: 'settlement.adjustmentApproval', label: 'Waiver approval' },
      { path: 'settlement.prizeDeductions', label: 'From the prize' },
    ],
  },
  {
    title: 'Online bidding',
    hint: 'Only used for online and hybrid auctions.',
    rows: [
      { path: 'bidding.format', label: 'Bids are' },
      { path: 'bidding.minIncrement', label: 'Minimum raise' },
      { path: 'bidding.antiSnipingWindowSeconds', label: 'Late-bid window (seconds)' },
      { path: 'bidding.extensionSeconds', label: 'Extension (seconds)' },
      { path: 'bidding.maxExtensions', label: 'Maximum extensions' },
      { path: 'bidding.showBidderAs', label: 'Bidders are shown by' },
      { path: 'bidding.proxyBidding', label: 'Bidding for someone else' },
    ],
  },
  {
    title: 'Legal limits (set by the administrator)',
    hint: 'Ceilings no setting may exceed. Entered only after legal validation.',
    rows: [
      { path: 'legalLimits.maxDiscount', label: 'Maximum discount' },
      { path: 'legalLimits.maxCommissionPercentOfChit', label: 'Maximum fee (% of chit value)' },
    ],
  },
];

const SOURCE_LABEL: Record<Source['level'], { text: string; bg: string; fg: string }> = {
  COMPANY: { text: 'Company default', bg: '#EFF6FF', fg: '#1D4ED8' },
  GROUP: { text: 'This group', bg: '#F0FDF4', fg: '#15803D' },
  GROUP_RECORD: { text: 'Group record', bg: '#F1F5F9', fg: '#475569' },
  LEGAL_LIMITS: { text: 'Legal limit', bg: '#FAF5FF', fg: '#7E22CE' },
};

function display(path: string, values: any): string | undefined {
  const [section, key] = path.split('.');
  const v = values?.[section]?.[key];
  if (v === undefined) return undefined;
  if (key === 'step') return v === null ? 'No step (set for this group)' : inr(v);
  if (['fixedAmount', 'flatAmount', 'approvalThreshold', 'minIncrement'].includes(key)) return inr(v);
  if (key === 'maxPerPeriod') return v === null ? 'No cap' : inr(v);
  if (key === 'percent') return `${v}%`;
  if (key === 'maxWinsPerTicket') return v === 'UNLIMITED' ? 'Unlimited' : String(v);
  if (key === 'maxOverdueAmount') return v === 'NOT_CHECKED' ? 'Not checked' : inr(v);
  if (key === 'min' || key === 'max' || key === 'maxDiscount') return bound(v);
  if (key === 'ratePercent' || key === 'maxCommissionPercentOfChit') return `${v}%`;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return LABELS[path]?.[v] ?? String(v);
}

const STATUS_STYLE: Record<string, [object, object]> = {
  ACTIVE: [mStyles.badgeSuccess, mStyles.badgeSuccessText],
  DRAFT: [mStyles.badgeInfo, mStyles.badgeInfoText],
  SUPERSEDED: [mStyles.badgeNeutral, mStyles.badgeNeutralText],
  REJECTED: [mStyles.badgeDanger, mStyles.badgeDangerText],
};

export function FinancialSettingsModal({ group, visible, onClose, canSeeHistory }: { group: any; visible: boolean; onClose: () => void; canSeeHistory: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [eff, setEff] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    if (!visible || !group?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [e, h] = await Promise.all([
          api.get('/financial-policies/effective', { params: { groupId: group.id } }),
          canSeeHistory ? api.get('/financial-policies') : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setEff(e.data.data);
        const rows = (h?.data?.data || []).filter((v: any) => v.scopeKey === 'COMPANY' || v.groupId === group.id);
        setHistory(rows);
      } catch (err: any) {
        if (!cancelled) setError(err?.response?.data?.message || 'Could not load the financial settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, group?.id, canSeeHistory]);

  const missing = new Set<string>([...(eff?.missing || []), ...(eff?.legalLimits?.missing || [])]);
  const basis = eff?.values?.commission?.basis;
  const hidden = (path: string) =>
    (path === 'commission.fixedAmount' && basis !== 'FIXED_AMOUNT') ||
    (path === 'commission.ratePercent' && basis === 'FIXED_AMOUNT') ||
    (path === 'dividend.winnerSharesCurrentDividend' && eff?.values?.dividend?.divisor !== 'ACTIVE_NON_PRIZED_TICKETS') ||
    (path === 'penalty.flatAmount' && eff?.values?.penalty?.mode !== 'FLAT_PER_PERIOD') ||
    (path === 'penalty.percent' && eff?.values?.penalty?.mode !== 'PERCENT_OF_OVERDUE') ||
    (['penalty.graceDays', 'penalty.maxPerPeriod'].includes(path) && (!eff?.values?.penalty?.mode || eff.values.penalty.mode === 'NONE')) ||
    (path === 'settlement.approvalThreshold' && eff?.values?.settlement?.settlementApproval !== 'ABOVE_THRESHOLD') ||
    (path.startsWith('bidding.') && !['ONLINE', 'HYBRID'].includes(eff?.values?.scheduling?.mode));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={mStyles.modalBackdrop}>
        <View style={[mStyles.modalBox, { maxWidth: 720 }]}>
          <View style={mStyles.modalHeader}>
            <Text style={mStyles.modalTitle} accessibilityRole="header">
              ⚙️ Financial settings{group ? ` — ${group.name}` : ''}
            </Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close financial settings" style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={mStyles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color="#0070BA" style={{ marginVertical: 30 }} />
          ) : error ? (
            <Text style={{ color: '#B91C1C', marginVertical: 12 }}>{error}</Text>
          ) : eff ? (
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ backgroundColor: '#F8FAFC', borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0' }}>
                <Text style={{ fontSize: 13, color: '#334155' }}>
                  {eff.groupEngineVersion === 'ENGINE_V1'
                    ? 'Read-only view. This group runs on the auction engine; each new auction freezes these settings when it locks.'
                    : 'Read-only view. This group uses the existing auction workflow; these settings apply once it is moved to the engine.'}
                </Text>
                <Text style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
                  {eff.complete ? '✓ Every business decision is set.' : `⚠ ${eff.missing.length} business decision(s) not made yet.`}{' '}
                  {eff.legalLimits.set ? '✓ Legal limits set.' : '⚠ Legal limits not set by the administrator.'}{' '}
                  {eff.readyForLock ? '✓ Ready to be used once auctions move to the new engine.' : ''}
                </Text>
              </View>

              {(eff.violations || []).map((v: Issue, i: number) => (
                <View key={`v${i}`} style={{ backgroundColor: '#FEF2F2', borderColor: '#FCA5A5', borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <Text style={{ color: '#991B1B', fontWeight: '700', fontSize: 13 }}>✕ Not allowed</Text>
                  <Text style={{ color: '#991B1B', fontSize: 13 }}>{v.message}</Text>
                </View>
              ))}
              {(eff.warnings || [])
                .filter((w: Issue) => w.code !== 'LEGAL_LIMITS_NOT_SET')
                .map((w: Issue, i: number) => (
                  <View key={`w${i}`} style={{ backgroundColor: '#FFFBEB', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                    <Text style={{ color: '#92400E', fontSize: 13 }}>⚠ {w.message}</Text>
                  </View>
                ))}

              {SECTIONS.map((s) => (
                <View key={s.title} style={{ marginBottom: 14 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#0F172A' }}>{s.title}</Text>
                  <Text style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>{s.hint}</Text>
                  {s.rows
                    .filter((r) => !hidden(r.path))
                    .map((r) => {
                      const value = display(r.path, eff.values);
                      const src: Source | undefined = eff.sources?.[r.path];
                      const isMissing = missing.has(r.path);
                      const chip = src ? SOURCE_LABEL[src.level] : null;
                      return (
                        <View
                          key={r.path}
                          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', gap: 6 }}
                        >
                          <Text style={{ fontSize: 13, color: '#334155', flexShrink: 1, minWidth: 160 }}>{r.label}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: isMissing ? '#B45309' : value === undefined ? '#94A3B8' : '#0F172A' }}>
                              {isMissing ? '⚠ Not decided' : value ?? 'Not set (optional)'}
                            </Text>
                            {chip ? (
                              <View style={{ backgroundColor: chip.bg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                                <Text style={{ fontSize: 11, color: chip.fg, fontWeight: '700' }}>
                                  {chip.text}
                                  {src?.version ? ` v${src.version}` : ''}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
                </View>
              ))}

              {canSeeHistory ? (
                <View style={{ marginBottom: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#0F172A', marginBottom: 6 }}>Change history</Text>
                  {history.length === 0 ? (
                    <Text style={{ fontSize: 12, color: '#64748B' }}>No setting versions yet.</Text>
                  ) : (
                    history.map((v) => {
                      const [bg, fg] = STATUS_STYLE[v.status] || STATUS_STYLE.SUPERSEDED;
                      return (
                        <View key={v.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <View style={[mStyles.badge, bg]}>
                              <Text style={[mStyles.badgeText, fg]}>{v.status}</Text>
                            </View>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                              {v.kind.replace(/_/g, ' ').toLowerCase()} v{v.version}
                            </Text>
                            <Text style={{ fontSize: 12, color: '#64748B' }}>{v.kind === 'LEGAL_LIMITS' ? 'Legal limits (administrator)' : v.scopeKey === 'COMPANY' ? 'Company default' : 'This group'}</Text>
                          </View>
                          <Text style={{ fontSize: 12, color: '#64748B' }}>
                            {String(v.createdAt).slice(0, 10)} by {v.createdBy?.fullName || '—'}
                            {v.reason ? ` — ${v.reason}` : ''}
                          </Text>
                        </View>
                      );
                    })
                  )}
                </View>
              ) : null}
              <Text style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>Engine {eff.engineVersion} · settings fingerprint {String(eff.hash).slice(0, 12)}</Text>
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
