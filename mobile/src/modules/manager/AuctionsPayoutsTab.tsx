import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Alert,
} from 'react-native';
import { api } from '../../services/api';
import { mStyles } from './commonStyles';

// INR with Indian digit grouping, e.g. ₹1,00,000 (P0: E10 for this screen).
const inr = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function AuctionsPayoutsTab({ user }: { user: any }) {
  const [subTab, setSubTab] = useState<'AUCTIONS' | 'PAYOUTS'>('AUCTIONS');
  const [groups, setGroups] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [subscribers, setSubscribers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Auction State (AC-23, AC-24, AC-25)
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const [auctionInstNo, setAuctionInstNo] = useState('1');
  const [auctionDate, setAuctionDate] = useState(new Date().toISOString().split('T')[0]);
  const [winningDiscount, setWinningDiscount] = useState('20000');
  const [winningSubId, setWinningSubId] = useState('');
  const [enrolledMembers, setEnrolledMembers] = useState<any[]>([]);
  const [eligibilityInfo, setEligibilityInfo] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Payout State (AC-26, AC-27)
  const [selectedPayout, setSelectedPayout] = useState<any>(null);
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutStatus, setPayoutStatus] = useState<'APPROVED' | 'DISBURSED' | 'REJECTED'>('APPROVED');
  const [payoutMode, setPayoutMode] = useState('BANK_TRANSFER');
  const [payoutDeductions, setPayoutDeductions] = useState('0');
  const [payoutTxRef, setPayoutTxRef] = useState('');

  const [submitting, setSubmitting] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [gRes, pRes, sRes] = await Promise.all([
        api.get('/chit-groups'),
        api.get('/payouts'),
        api.get('/subscribers'),
      ]);
      if (gRes.data.success) {
        setGroups(gRes.data.data || []);
        if (gRes.data.data.length > 0 && !selectedGroupId) {
          selectGroup(gRes.data.data[0]);
        }
      }
      if (pRes.data.success) setPayouts(pRes.data.data || []);
      if (sRes.data.success) {
        setSubscribers(sRes.data.data || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Ticket list with eligibility derived by the backend from database records.
  const loadEligibility = async (groupId: string) => {
    const res = await api.get(`/auctions/group/${groupId}/eligibility`);
    if (res.data.success) {
      const info = res.data.data;
      setEligibilityInfo(info);
      setEnrolledMembers(info.tickets || []);
      return info;
    }
    return null;
  };

  const selectGroup = async (grp: any) => {
    setSelectedGroupId(grp.id);
    setSelectedGroup(grp);
    setPreview(null);
    try {
      const info = await loadEligibility(grp.id);
      if (info) {
        setAuctionInstNo(String(info.nextInstallmentNo || 1));
        // Default selection: first eligible ticket that has not won yet (a convenience only —
        // repeat wins are not blocked by the system; see eligibility notes).
        const tickets = info.tickets || [];
        const preferred = tickets.find((t: any) => t.eligible && !t.isPrized) || tickets.find((t: any) => t.eligible);
        setWinningSubId(preferred ? preferred.subscriberId : '');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const chitValue = selectedGroup?.chitValue || 0;
  const numMembers = selectedGroup?.maxMembers || 0;
  const discount = Number(winningDiscount) || 0;
  const selectedTicket = enrolledMembers.find((t: any) => t.subscriberId === winningSubId);

  // Financial preview is calculated by the backend (same code path as confirmation).
  useEffect(() => {
    if (!selectedGroupId || winningDiscount === '' || !auctionInstNo) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setPreviewLoading(true);
        const res = await api.post('/auctions/preview', {
          groupId: selectedGroupId,
          installmentNo: Number(auctionInstNo),
          winningBidDiscount: winningDiscount,
          winnerSubscriberId: winningSubId || undefined,
        });
        if (!cancelled && res.data.success) setPreview(res.data.data);
      } catch (e: any) {
        if (!cancelled) setPreview({ valid: false, errors: [{ code: e.response?.data?.code || 'ERROR', message: e.response?.data?.message || 'Could not calculate preview' }] });
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedGroupId, winningDiscount, auctionInstNo, winningSubId]);

  const calc = preview?.calculation;
  const canConfirm = !!preview?.valid && !!selectedTicket && !submitting;

  // AC-23, AC-24, AC-25: Confirm Auction & Post Allocation
  const handleConfirmAuction = async () => {
    if (!selectedGroupId || !winningSubId || winningDiscount === '') {
      alert('Group, Winner, and Bid Discount are required');
      return;
    }
    if (!preview?.valid) {
      alert((preview?.errors || []).map((e: any) => e.message).join('\n') || 'Please review the auction details.');
      return;
    }
    try {
      setSubmitting(true);
      const res = await api.post('/auctions/confirm', {
        groupId: selectedGroupId,
        installmentNo: Number(auctionInstNo),
        auctionDate,
        winningBidDiscount: winningDiscount,
        winnerSubscriberId: winningSubId,
        winnerMemberId: selectedTicket?.memberId,
      });

      if (res.data.success) {
        const d = res.data.data;
        alert(
          `🎉 Auction confirmed successfully!\n\n` +
          `Winner: Ticket #${d.winner?.ticketNumber} — ${d.winner?.subscriber?.fullName || ''}\n` +
          `Gross Prize Payable: ${inr(d.payout?.grossBidAmount)}\n` +
          `Foreman Commission: ${inr(d.foremanCommission)}\n` +
          `Dividend Per Ticket: ${inr(d.dividendPerMember)}\n` +
          (d.pendingDecisionTotal > 0 ? `Dividend pending decision (not credited): ${inr(d.pendingDecisionTotal)}\n` : '') +
          `\nPrize payout record created and pending disbursement.`
        );
        fetchData();
        setSubTab('PAYOUTS');
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to confirm auction');
      if (selectedGroupId) loadEligibility(selectedGroupId).catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };

  // AC-26, AC-27: Update Payout Status & Disburse
  const handleUpdatePayout = async () => {
    if (!selectedPayout) return;
    try {
      setSubmitting(true);
      const res = await api.patch(`/payouts/${selectedPayout.id}/status`, {
        status: payoutStatus,
        deductions: Number(payoutDeductions),
        paymentMode: payoutMode,
        transactionRef: payoutTxRef.trim() || undefined,
      });

      if (res.data.success) {
        alert(`Payout status updated to ${payoutStatus}`);
        setShowPayoutModal(false);
        fetchData();
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to update payout');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={mStyles.container}>
      {/* Header */}
      <View style={mStyles.headerRow}>
        <View>
          <Text style={mStyles.headerTitle}>🎯 Auctions, Dividends & Prize Payouts</Text>
          <Text style={mStyles.headerSubtitle}>
            AC-23 Auction Roster, AC-24 Calculations, AC-25 Dividends & AC-26/27 Prize Payouts
          </Text>
        </View>
      </View>

      {/* Sub Tabs */}
      <View style={mStyles.subTabs}>
        <TouchableOpacity
          style={[mStyles.subTabItem, subTab === 'AUCTIONS' && mStyles.subTabItemActive]}
          onPress={() => setSubTab('AUCTIONS')}
        >
          <Text style={[mStyles.subTabText, subTab === 'AUCTIONS' && mStyles.subTabTextActive]}>
            🎯 1. Conduct Auction & Dividend (AC-23/24/25)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[mStyles.subTabItem, subTab === 'PAYOUTS' && mStyles.subTabItemActive]}
          onPress={() => setSubTab('PAYOUTS')}
        >
          <Text style={[mStyles.subTabText, subTab === 'PAYOUTS' && mStyles.subTabTextActive]}>
            🏆 2. Prize Payouts (AC-26/27)
          </Text>
        </TouchableOpacity>
      </View>

      {/* --- SUB TAB 1: CONDUCT AUCTION & DIVIDEND --- */}
      {subTab === 'AUCTIONS' && (
        <View>
          <Text style={mStyles.label}>Select Chit Group *</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {groups.map((g) => (
              <TouchableOpacity
                key={g.id}
                style={[mStyles.chip, selectedGroupId === g.id && mStyles.chipActive]}
                onPress={() => selectGroup(g)}
              >
                <Text style={[mStyles.chipText, selectedGroupId === g.id && mStyles.chipTextActive]}>
                  {g.name} ({g.groupCode})
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {selectedGroup && (
            <View style={mStyles.card}>
              <Text style={[mStyles.cardTitle, { marginBottom: 4 }]}>
                Auction Execution Roster & Calculation Engine (AC-23, AC-24)
              </Text>
              <Text style={{ fontSize: 12, color: '#64748B', marginBottom: 16 }}>
                Chit Value: {inr(chitValue)} • Seats: {numMembers} • Monthly Due: {inr(selectedGroup.monthlyInstallment || 0)}
              </Text>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Installment Number *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    placeholder="1"
                    value={auctionInstNo}
                    onChangeText={setAuctionInstNo}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Auction Date *</Text>
                  <TextInput
                    style={mStyles.input}
                    placeholder="YYYY-MM-DD"
                    value={auctionDate}
                    onChangeText={setAuctionDate}
                  />
                </View>
              </View>

              <Text style={mStyles.label}>Winning Bid Discount (₹) *</Text>
              <TextInput
                style={mStyles.input}
                keyboardType="numeric"
                placeholder="Discount bid by member e.g. 25000"
                value={winningDiscount}
                onChangeText={setWinningDiscount}
              />

              {/* Calculation preview from the backend (AC-24, AC-25) */}
              <View
                style={{
                  backgroundColor: '#F8FAFC',
                  borderRadius: 10,
                  padding: 16,
                  borderWidth: 1,
                  borderColor: preview && !preview.valid ? '#FCA5A5' : '#E2E8F0',
                  marginVertical: 12,
                }}
              >
                <Text style={{ fontWeight: '800', fontSize: 14, color: '#0F2F52', marginBottom: 10 }}>
                  📊 Calculation Preview {previewLoading ? '(updating…)' : ''}
                </Text>
                {calc ? (
                  <View style={{ gap: 6 }}>
                    <Text style={{ fontSize: 13, color: '#334155' }}>
                      • Total Gross Chit Pot Value: <Text style={{ fontWeight: '700' }}>{inr(calc.inputs?.chitValue)}</Text>
                    </Text>
                    <Text style={{ fontSize: 13, color: '#334155' }}>
                      • Winning Bid Discount Given Up: <Text style={{ fontWeight: '700', color: '#D97706' }}>{inr(calc.inputs?.discount)}</Text>
                    </Text>
                    <Text style={{ fontSize: 13, color: '#334155' }}>
                      • Gross Prize Payout To Winner: <Text style={{ fontWeight: '800', color: '#16A34A' }}>{inr(calc.grossPrize)}</Text>
                    </Text>
                    <Text style={{ fontSize: 13, color: '#334155' }}>
                      • Foreman Commission ({calc.inputs?.foremanCommissionPct}%): <Text style={{ fontWeight: '700', color: '#2563EB' }}>{inr(calc.foremanCommission)}</Text>
                    </Text>
                    <Text style={{ fontSize: 13, color: '#334155' }}>
                      • Distributable Dividend Pool: <Text style={{ fontWeight: '700', color: '#7C3AED' }}>{inr(calc.dividendPool)}</Text>
                    </Text>
                    <Text style={{ fontSize: 14, color: '#0F172A', fontWeight: '800', marginTop: 4 }}>
                      • 💰 Dividend Credit Per Ticket: <Text style={{ color: '#16A34A' }}>{inr(calc.dividendPerTicket)}</Text>
                      <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '500' }}>  (pool ÷ {numMembers} seats)</Text>
                    </Text>
                    <Text style={{ fontSize: 13, color: '#334155' }}>
                      • Credited to {calc.inputs?.activeTicketCount} active ticket(s): <Text style={{ fontWeight: '700' }}>{inr(calc.creditedTotal)}</Text>
                      {calc.nextInstallmentNetDue !== null ? `  → next instalment due ${inr(calc.nextInstallmentNetDue)}` : ''}
                    </Text>
                    {calc.pendingDecisionTotal > 0 && (
                      <Text style={{ fontSize: 13, color: '#B45309' }}>
                        • Not credited — pending business decision: <Text style={{ fontWeight: '700' }}>{inr(calc.pendingDecisionTotal)}</Text>
                        {'\n'}
                        {(calc.allocations || [])
                          .filter((a: any) => a.status === 'PENDING_DECISION')
                          .map((a: any) => `   ${a.kind === 'VACANT_SEATS' ? 'Unfilled seats' : a.kind === 'ROUNDING_REMAINDER' ? 'Rounding remainder' : 'Final auction (no next instalment)'}: ${inr(a.amount)}`)
                          .join('\n')}
                      </Text>
                    )}
                  </View>
                ) : (
                  <Text style={{ fontSize: 13, color: '#64748B' }}>Enter a discount to see the calculation.</Text>
                )}
                {preview && !preview.valid && (preview.errors || []).length > 0 && (
                  <View style={{ marginTop: 10, backgroundColor: '#FEF2F2', borderRadius: 8, padding: 10 }}>
                    {(preview.errors || []).map((e: any, i: number) => (
                      <Text key={i} style={{ fontSize: 12, color: '#B91C1C', marginBottom: 2 }}>
                        ⚠️ {e.message}
                      </Text>
                    ))}
                  </View>
                )}
              </View>

              <Text style={mStyles.label}>Winning Ticket *</Text>
              {eligibilityInfo && (
                <Text style={{ fontSize: 11, color: '#64748B', marginBottom: 6 }}>
                  {eligibilityInfo.activeTickets} active ticket(s) of {eligibilityInfo.maxMembers} seats • Repeat wins are currently permitted (policy pending decision)
                </Text>
              )}
              <View style={{ maxHeight: 220, marginBottom: 16 }}>
                <ScrollView nestedScrollEnabled style={{ borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8 }}>
                  {enrolledMembers.length === 0 && (
                    <Text style={{ padding: 10, fontSize: 13, color: '#64748B' }}>No tickets in this group yet.</Text>
                  )}
                  {enrolledMembers.map((m: any) => {
                    const selected = winningSubId === m.subscriberId;
                    const blocking = (m.reasons || []).filter((r: any) => r.blocking);
                    return (
                      <TouchableOpacity
                        key={m.memberId}
                        disabled={!m.eligible}
                        accessibilityState={{ disabled: !m.eligible, selected }}
                        style={{
                          padding: 10,
                          backgroundColor: selected ? '#DCFCE7' : m.eligible ? '#FFF' : '#F1F5F9',
                          borderBottomWidth: 1,
                          borderBottomColor: '#F1F5F9',
                          opacity: m.eligible ? 1 : 0.7,
                        }}
                        onPress={() => setWinningSubId(m.subscriberId)}
                      >
                        <Text style={{ fontWeight: selected ? '700' : '500', color: '#0F172A', fontSize: 13 }}>
                          Ticket #{m.ticketNumber}: {m.subscriber?.fullName} [{m.subscriber?.subscriberCode}]
                          {m.membershipStatus !== 'ACTIVE' ? `  (${m.membershipStatus})` : ''}
                        </Text>
                        {m.isPrized && (
                          <Text style={{ fontSize: 11, color: '#B45309', marginTop: 2 }}>
                            🏆 Already won auction #{(m.prizedInstallmentNos || []).join(', #')}
                          </Text>
                        )}
                        {blocking.length > 0 && (
                          <Text style={{ fontSize: 11, color: '#B91C1C', marginTop: 2 }}>
                            ⛔ Not eligible: {blocking.map((r: any) => r.message).join(' ')}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              <TouchableOpacity
                style={[mStyles.primaryBtn, { alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 24, opacity: canConfirm ? 1 : 0.5 }]}
                disabled={!canConfirm}
                onPress={handleConfirmAuction}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Text style={[mStyles.primaryBtnText, { fontSize: 14 }]}>
                    ✓ Confirm Auction & Post Member Dividend Allocations (AC-25)
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* --- SUB TAB 2: PRIZE PAYOUTS --- */}
      {subTab === 'PAYOUTS' && (
        <View>
          <View style={{ marginBottom: 14 }}>
            <Text style={{ fontSize: 13, color: '#64748B' }}>
              Track prize payouts, document verification, statutory deductions, approval, and bank execution tracking (AC-26, AC-27).
            </Text>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color="#0070BA" style={{ marginVertical: 40 }} />
          ) : payouts.length === 0 ? (
            <View style={[mStyles.card, { alignItems: 'center', paddingVertical: 40 }]}>
              <Text style={{ color: '#64748B' }}>No prize payouts on record.</Text>
            </View>
          ) : (
            <View style={mStyles.table}>
              <View style={mStyles.tableHeader}>
                <Text style={[mStyles.tableHeaderCell, { width: 130 }]}>Winner</Text>
                <Text style={[mStyles.tableHeaderCell, { width: 110 }]}>Group</Text>
                <Text style={[mStyles.tableHeaderCell, { width: 60 }]}>Inst #</Text>
                <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Gross Bid</Text>
                <Text style={[mStyles.tableHeaderCell, { width: 90 }]}>Deductions</Text>
                <Text style={[mStyles.tableHeaderCell, { width: 110 }]}>Net Payout</Text>
                <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Status</Text>
                <Text style={[mStyles.tableHeaderCell, { flex: 1 }]}>Action</Text>
              </View>
              {payouts.map((p) => (
                <View key={p.id} style={mStyles.tableRow}>
                  <Text style={[mStyles.tableCell, { width: 130, fontWeight: '700' }]}>
                    {p.subscriber?.fullName}
                  </Text>
                  <Text style={[mStyles.tableCell, { width: 110, fontSize: 12 }]}>
                    {p.auction?.group?.name}
                  </Text>
                  <Text style={[mStyles.tableCell, { width: 60 }]}>#{p.auction?.installmentNo}</Text>
                  <Text style={[mStyles.tableCell, { width: 100 }]}>₹{p.grossBidAmount?.toLocaleString()}</Text>
                  <Text style={[mStyles.tableCell, { width: 90, color: '#DC2626' }]}>
                    -₹{p.deductions?.toLocaleString()}
                  </Text>
                  <Text style={[mStyles.tableCell, { width: 110, fontWeight: '800', color: '#16A34A' }]}>
                    ₹{p.netPayoutAmount?.toLocaleString()}
                  </Text>
                  <View style={{ width: 100 }}>
                    <View
                      style={[
                        mStyles.badge,
                        p.status === 'DISBURSED'
                          ? mStyles.badgeSuccess
                          : p.status === 'APPROVED'
                          ? mStyles.badgeInfo
                          : p.status === 'REJECTED'
                          ? mStyles.badgeDanger
                          : mStyles.badgeWarning,
                      ]}
                    >
                      <Text
                        style={[
                          mStyles.badgeText,
                          p.status === 'DISBURSED'
                            ? mStyles.badgeSuccessText
                            : p.status === 'APPROVED'
                            ? mStyles.badgeInfoText
                            : p.status === 'REJECTED'
                            ? mStyles.badgeDangerText
                            : mStyles.badgeWarningText,
                        ]}
                      >
                        {p.status}
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={mStyles.secondaryBtn}
                    onPress={() => {
                      setSelectedPayout(p);
                      setPayoutStatus(p.status === 'DISBURSED' ? 'DISBURSED' : 'DISBURSED');
                      setPayoutDeductions(String(p.deductions || 0));
                      setPayoutMode(p.paymentMode || 'BANK_TRANSFER');
                      setPayoutTxRef(p.transactionRef || '');
                      setShowPayoutModal(true);
                    }}
                  >
                    <Text style={[mStyles.secondaryBtnText, { fontSize: 11 }]}>⚙️ Process (AC-27)</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* --- MODAL 1: PROCESS PAYOUT (AC-26, AC-27) --- */}
      <Modal visible={showPayoutModal} transparent animationType="fade">
        <View style={mStyles.modalBackdrop}>
          <View style={mStyles.modalBox}>
            <View style={mStyles.modalHeader}>
              <Text style={mStyles.modalTitle}>🏆 Execute Prize Payout (AC-26, AC-27)</Text>
              <TouchableOpacity onPress={() => setShowPayoutModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {selectedPayout && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={{ backgroundColor: '#F8FAFC', padding: 12, borderRadius: 8, marginBottom: 14 }}>
                  <Text style={{ fontWeight: '700', fontSize: 14, color: '#0F172A' }}>
                    Winner: {selectedPayout.subscriber?.fullName}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#64748B' }}>
                    Gross Bid Prize: ₹{selectedPayout.grossBidAmount?.toLocaleString()}
                  </Text>
                </View>

                <Text style={mStyles.label}>Payout Status Decision *</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  {(['APPROVED', 'DISBURSED', 'REJECTED'] as const).map((st) => (
                    <TouchableOpacity
                      key={st}
                      style={[mStyles.chip, payoutStatus === st && mStyles.chipActive]}
                      onPress={() => setPayoutStatus(st)}
                    >
                      <Text style={[mStyles.chipText, payoutStatus === st && mStyles.chipTextActive]}>{st}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={mStyles.label}>Statutory / Arrears Deductions (₹)</Text>
                    <TextInput
                      style={mStyles.input}
                      keyboardType="numeric"
                      placeholder="0"
                      value={payoutDeductions}
                      onChangeText={setPayoutDeductions}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={mStyles.label}>Payment Method</Text>
                    <TextInput
                      style={mStyles.input}
                      placeholder="BANK_TRANSFER / CHEQUE"
                      value={payoutMode}
                      onChangeText={setPayoutMode}
                    />
                  </View>
                </View>

                <Text style={mStyles.label}>Bank UTR / Transaction Reference ID *</Text>
                <TextInput
                  style={mStyles.input}
                  placeholder="e.g. UTR-2026-CHIT-99281"
                  value={payoutTxRef}
                  onChangeText={setPayoutTxRef}
                />

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
                  <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowPayoutModal(false)}>
                    <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[mStyles.primaryBtn, submitting && { opacity: 0.7 }]}
                    disabled={submitting}
                    onPress={handleUpdatePayout}
                  >
                    <Text style={mStyles.primaryBtnText}>✓ Confirm Execution</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>

  );
}
