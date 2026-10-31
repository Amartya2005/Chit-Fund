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

  const selectGroup = async (grp: any) => {
    setSelectedGroupId(grp.id);
    setSelectedGroup(grp);
    setAuctionInstNo(String(grp.currentInstallmentNo || 1));
    try {
      const res = await api.get(`/chit-groups/${grp.id}`);
      if (res.data.success) {
        const memberships = res.data.data.members || res.data.data.memberships || [];
        setEnrolledMembers(memberships);
        // Default winner to first non-prized member
        const nonPrized = memberships.find((m: any) => !m.isPrized);
        if (nonPrized) {
          setWinningSubId(nonPrized.subscriberId);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Calculations (AC-24, AC-25)
  const chitValue = selectedGroup?.chitValue || selectedGroup?.totalChitValue || 100000;
  const numMembers = selectedGroup?.maxMembers || 20;
  const discount = Number(winningDiscount) || 0;
  const commissionRate = selectedGroup?.foremanCommissionPct || selectedGroup?.foremanCommissionRate || 5;
  const foremanCommission = (chitValue * commissionRate) / 100; // 5%
  const totalDividend = Math.max(0, discount - foremanCommission);
  const dividendPerMember = numMembers > 0 ? totalDividend / numMembers : 0;
  const netPrizeAmount = chitValue - discount;

  // AC-23, AC-24, AC-25: Confirm Auction & Post Allocation
  const handleConfirmAuction = async () => {
    if (!selectedGroupId || !winningSubId || !winningDiscount) {
      alert('Group, Winner, and Bid Discount are required');
      return;
    }
    if (discount < foremanCommission) {
      alert(`Winning bid discount cannot be less than 5% foreman commission (₹${foremanCommission.toLocaleString()})`);
      return;
    }
    try {
      setSubmitting(true);
      const res = await api.post('/auctions/confirm', {
        groupId: selectedGroupId,
        installmentNo: Number(auctionInstNo),
        auctionDate,
        winningBidDiscount: discount,
        winningSubscriberId: winningSubId,
      });

      if (res.data.success) {
        alert(
          `🎉 Auction confirmed successfully!\n\n` +
          `Net Prize Payable: ₹${netPrizeAmount.toLocaleString()}\n` +
          `Foreman Commission: ₹${foremanCommission.toLocaleString()}\n` +
          `Dividend Per Member: ₹${dividendPerMember.toLocaleString()}\n\n` +
          `Prize payout record created and pending disbursement.`
        );
        fetchData();
        setSubTab('PAYOUTS');
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to confirm auction');
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
                Chit Value: ₹{chitValue.toLocaleString()} • Members: {numMembers} • Monthly Due: ₹{(selectedGroup.monthlyInstallment || 0).toLocaleString()}
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

              {/* Dynamic Calculation Box (AC-24, AC-25) */}
              <View
                style={{
                  backgroundColor: '#F8FAFC',
                  borderRadius: 10,
                  padding: 16,
                  borderWidth: 1,
                  borderColor: '#E2E8F0',
                  marginVertical: 12,
                }}
              >
                <Text style={{ fontWeight: '800', fontSize: 14, color: '#0F2F52', marginBottom: 10 }}>
                  📊 Contractual Rules & Dividend Split Breakdown:
                </Text>
                <View style={{ gap: 6 }}>
                  <Text style={{ fontSize: 13, color: '#334155' }}>
                    • Total Gross Chit Pot Value: <Text style={{ fontWeight: '700' }}>₹{chitValue.toLocaleString()}</Text>
                  </Text>
                  <Text style={{ fontSize: 13, color: '#334155' }}>
                    • Winning Bid Discount Given Up: <Text style={{ fontWeight: '700', color: '#D97706' }}>₹{discount.toLocaleString()}</Text>
                  </Text>
                  <Text style={{ fontSize: 13, color: '#334155' }}>
                    • Net Prize Payout To Winner: <Text style={{ fontWeight: '800', color: '#16A34A' }}>₹{netPrizeAmount.toLocaleString()}</Text>
                  </Text>
                  <Text style={{ fontSize: 13, color: '#334155' }}>
                    • Foreman Commission ({commissionRate}%): <Text style={{ fontWeight: '700', color: '#2563EB' }}>₹{foremanCommission.toLocaleString()}</Text>
                  </Text>
                  <Text style={{ fontSize: 13, color: '#334155' }}>
                    • Distributable Dividend Pool: <Text style={{ fontWeight: '700', color: '#7C3AED' }}>₹{totalDividend.toLocaleString()}</Text>
                  </Text>
                  <Text style={{ fontSize: 14, color: '#0F172A', fontWeight: '800', marginTop: 4 }}>
                    • 💰 Dividend Credit Per Member: <Text style={{ color: '#16A34A' }}>₹{dividendPerMember.toLocaleString()}</Text>
                  </Text>
                </View>
              </View>

              <Text style={mStyles.label}>Winning Subscriber (Eligible Non-Prized Members) *</Text>
              <View style={{ maxHeight: 160, marginBottom: 16 }}>
                <ScrollView nestedScrollEnabled style={{ borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8 }}>
                  {enrolledMembers
                    .filter((m) => !m.isPrized)
                    .map((m) => (
                      <TouchableOpacity
                        key={m.subscriberId}
                        style={{
                          padding: 10,
                          backgroundColor: winningSubId === m.subscriberId ? '#DCFCE7' : '#FFF',
                          borderBottomWidth: 1,
                          borderBottomColor: '#F1F5F9',
                        }}
                        onPress={() => setWinningSubId(m.subscriberId)}
                      >
                        <Text style={{ fontWeight: winningSubId === m.subscriberId ? '700' : '500', color: '#0F172A', fontSize: 13 }}>
                          Ticket #{m.ticketNo ?? m.ticketNumber}: {m.subscriber?.fullName} [{m.subscriber?.subscriberCode}]
                        </Text>
                      </TouchableOpacity>
                    ))}
                </ScrollView>
              </View>

              <TouchableOpacity
                style={[mStyles.primaryBtn, { alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 24 }]}
                disabled={submitting}
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
