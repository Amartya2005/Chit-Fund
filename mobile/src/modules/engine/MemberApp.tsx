import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, SafeAreaView } from 'react-native';
import { api } from '../../services/api';
import { mStyles } from '../manager/commonStyles';
import { Btn, Field, Notice, Pill, Row, Sheet, apiError, fmtTime, inr, requestId } from './ui';

/** Member portal (P7) with the live auction room (P8). Shows only the signed-in member's own data. */
type Tab = 'home' | 'dues' | 'auctions' | 'receipts';

export function MemberApp({ user, logout }: { user: any; logout: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }}>
      <View style={{ backgroundColor: '#0A2540', padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 16 }} accessibilityRole="header">{user.company?.name || 'ChitKart'}</Text>
          <Text style={{ color: '#CBD5E1', fontSize: 12 }}>Member · {user.fullName}</Text>
        </View>
        <TouchableOpacity onPress={logout} style={{ padding: 10, minHeight: 44, justifyContent: 'center' }} accessibilityRole="button">
          <Text style={{ color: '#FCA5A5', fontWeight: '700' }}>Logout</Text>
        </TouchableOpacity>
      </View>
      <View style={[mStyles.subTabs, { marginHorizontal: 12, marginTop: 12 }]}>
        {(['home', 'dues', 'auctions', 'receipts'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} onPress={() => setTab(t)} style={[mStyles.subTabItem, tab === t && mStyles.subTabItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={[mStyles.subTabText, tab === t && mStyles.subTabTextActive]}>{{ home: 'Home', dues: 'My dues', auctions: 'Auctions', receipts: 'Receipts' }[t]}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        {tab === 'home' && <Home />}
        {tab === 'dues' && <Dues />}
        {tab === 'auctions' && <Auctions />}
        {tab === 'receipts' && <Receipts />}
      </ScrollView>
    </SafeAreaView>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get(path).then((r) => setData(r.data.data), (e) => setError(apiError(e)));
  }, [path]);
  useEffect(load, [load]);
  return { data, error, reload: load };
}

function Home() {
  const { data, error } = useLoad<any>('/me/member/summary');
  if (error) return <Notice kind="error" text={error} />;
  if (!data) return <ActivityIndicator color="#0070BA" />;
  return (
    <View>
      {data.tickets.length === 0 && <Notice kind="info" text="You are not enrolled in a chit group yet." />}
      {data.tickets.map((t: any) => (
        <View key={t.memberId} style={mStyles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <Text style={mStyles.cardTitle}>{t.group.name}</Text>
            {t.prized ? <Pill value="SETTLED" label="Prize received" /> : <Pill value="UPCOMING" label="Not yet won" />}
          </View>
          <Text style={mStyles.cardSubtitle}>Ticket #{t.ticketNumber} · chit value {inr(t.group.chitValue)}</Text>
          {t.dues ? (
            <View style={{ marginTop: 8 }}>
              <Row label="Overdue" value={inr(t.dues.overdue)} strong={Number(t.dues.overdue) > 0} />
              <Row label="Due today" value={inr(t.dues.dueToday)} />
              <Row label="Next instalment" value={t.dues.next ? `${inr(t.dues.next.outstanding)} on ${t.dues.next.dueDate}` : 'All paid'} />
              {Number(t.dues.advance) > 0 && <Row label="Paid in advance" value={inr(t.dues.advance)} />}
            </View>
          ) : (
            <Text style={{ fontSize: 12, color: '#64748B', marginTop: 8 }}>Dues for this group are shown at the office.</Text>
          )}
        </View>
      ))}
    </View>
  );
}

function Dues() {
  const { data, error } = useLoad<any>('/me/member/dues');
  if (error) return <Notice kind="error" text={error} />;
  if (!data) return <ActivityIndicator color="#0070BA" />;
  if (data.tickets.length === 0) return <Notice kind="info" text="No instalment details are available online yet." />;
  return (
    <View>
      {data.tickets.map((t: any) => (
        <View key={t.group.id} style={mStyles.card}>
          <Text style={mStyles.cardTitle}>{t.group.name} · Ticket #{t.ticketNumber}</Text>
          {t.dues.map((d: any) => (
            <View key={d.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: '700' }}>Instalment #{d.periodNo} · {d.dueDate}</Text>
                <Pill value={d.status} />
              </View>
              <Text style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                {inr(d.grossAmount)}
                {Number(d.dividendCredit) > 0 ? ` − dividend ${inr(d.dividendCredit)}` : ''}
                {Number(d.penaltyAmount) - Number(d.penaltyWaived) > 0 ? ` + penalty ${inr(Number(d.penaltyAmount) - Number(d.penaltyWaived))}` : ''} = {inr(d.netAmount)} · paid {inr(d.paidAmount)}
                {Number(d.outstanding) > 0 ? ` · to pay ${inr(d.outstanding)}` : ''}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Auctions() {
  const { data, error, reload } = useLoad<any[]>('/me/member/auctions');
  const [room, setRoom] = useState<any>(null);
  if (error) return <Notice kind="error" text={error} />;
  if (!data) return <ActivityIndicator color="#0070BA" />;
  return (
    <View>
      {data.length === 0 && <Notice kind="info" text="No auctions scheduled for your groups." />}
      {data.map((s) => (
        <View key={s.id} style={mStyles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <Text style={mStyles.cardTitle}>{s.group.name} · Auction #{s.sequenceNo}</Text>
            <Pill value={s.status} />
          </View>
          <Text style={mStyles.cardSubtitle}>
            {fmtTime(s.opensAt)} – {fmtTime(s.closesAt)} IST · {s.mode === 'OFFLINE' ? 'held at the office' : 'online'}
          </Text>
          {s.myEligibility && !s.myEligibility.eligible && <Notice kind="warning" text={`You cannot win this auction: ${(s.myEligibility.results || []).filter((r: any) => !r.passed).map((r: any) => r.message).join(' ')}`} />}
          {s.result && (
            <Text style={{ fontSize: 13, marginTop: 6 }}>
              {s.result.iWon ? '🎉 You won this auction.' : `Won by ticket #${s.result.winningTicketNumber}.`} Dividend {inr(s.result.dividendPerTicket)} off instalment #{s.result.creditedToPeriod}.
            </Text>
          )}
          {s.status === 'OPEN' && s.mode !== 'OFFLINE' && (
            <View style={{ marginTop: 8 }}>
              <Btn title="Enter the auction room" kind="primary" onPress={() => setRoom(s)} />
            </View>
          )}
        </View>
      ))}
      {room && <AuctionRoom session={room} onClose={() => { setRoom(null); reload(); }} />}
    </View>
  );
}

function AuctionRoom({ session, onClose }: { session: any; onClose: () => void }) {
  const [state, setState] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'warning'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.get(`/engine/member/sessions/${session.id}/live`);
        if (!stop) {
          skew.current = Date.parse(r.data.data.serverTime) - Date.now();
          setState(r.data.data);
        }
      } catch (e) {
        if (!stop) setMsg({ kind: 'error', text: apiError(e) });
      }
      if (!stop) setTimeout(tick, 2000);
    };
    tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(clock);
    };
  }, [session.id]);
  const left = state ? Math.max(0, Math.floor((Date.parse(state.closesAt) - (now + skew.current)) / 1000)) : 0;
  const minNext = state?.rules?.format === 'OPEN_ASCENDING' && state.best ? Number(state.best.amount) + Number(state.rules.minIncrement) : null;
  const place = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/engine/member/sessions/${session.id}/bids`, { discount: amount, clientRequestId: requestId() });
      setMsg({ kind: 'success', text: `Your bid of ${inr(amount)} was accepted.` });
      setAmount('');
    } catch (e: any) {
      const reason = e?.response?.data?.data?.bid?.rejectReason;
      setMsg({ kind: 'warning', text: reason ? `Bid not accepted: ${REASONS[reason.split(':')[0]] || reason}` : apiError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`${session.group.name} · Auction #${session.sequenceNo}`} visible onClose={onClose} maxWidth={520}>
      {!state ? (
        <ActivityIndicator color="#0070BA" />
      ) : (
        <View>
          <View style={{ alignItems: 'center', marginBottom: 10 }}>
            <Text style={{ fontSize: 12, color: '#64748B' }}>{state.status === 'OPEN' ? 'Time left' : 'Status'}</Text>
            <Text style={{ fontSize: 28, fontWeight: '800', color: left < 60 ? '#B91C1C' : '#0F172A' }} accessibilityLiveRegion="polite" accessibilityLabel={`${Math.floor(left / 60)} minutes ${left % 60} seconds left`}>
              {state.status === 'OPEN' ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : state.status.replace('_', ' ')}
            </Text>
            {state.extensions > 0 && <Text style={{ fontSize: 12, color: '#B45309' }}>Extended {state.extensions}× after late bids</Text>}
          </View>
          <Row label="Highest discount so far" value={state.best ? `${inr(state.best.amount)} · ticket #${state.best.ticketNumber}${state.best.isMine ? ' (you)' : ''}` : state.rules?.format === 'SEALED' ? 'Sealed until the auction closes' : 'No bids yet'} strong />
          <Row label="Bids received" value={state.acceptedBids} />
          <Row label="Minimum raise" value={inr(state.rules?.minIncrement)} />
          {msg && <View style={{ marginTop: 10 }}><Notice kind={msg.kind} text={msg.text} /></View>}
          {state.status === 'OPEN' && (
            <View style={{ marginTop: 10 }}>
              <Field label="Discount you offer (₹ you give up from the prize)" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder={minNext ? `at least ${minNext}` : ''} />
              <Btn title={busy ? 'Sending…' : 'Place bid'} kind="primary" onPress={place} disabled={busy || !amount} />
            </View>
          )}
          {state.myBids.length > 0 && (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontWeight: '700', marginBottom: 4 }}>My bids</Text>
              {state.myBids.map((b: any, i: number) => (
                <Text key={i} style={{ fontSize: 12, color: b.status === 'ACCEPTED' ? '#166534' : '#991B1B' }}>
                  {inr(b.amount)} — {b.status === 'ACCEPTED' ? 'accepted' : REASONS[(b.rejectReason || '').split(':')[0]] || b.rejectReason}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}

const REASONS: Record<string, string> = {
  BELOW_MIN_INCREMENT: 'it must beat the highest bid by the minimum raise',
  BELOW_OWN_BID_PLUS_INCREMENT: 'it must be higher than your previous bid by the minimum raise',
  COMMISSION_EXCEEDS_DISCOUNT: 'the discount must at least cover the foreman’s fee',
  DISCOUNT_ABOVE_LEGAL_LIMIT: 'it is above the legal maximum discount',
  DISCOUNT_ABOVE_MAX: 'it is above the maximum discount for this group',
  DISCOUNT_BELOW_MIN: 'it is below the minimum discount for this group',
  DISCOUNT_NOT_MULTIPLE_OF_STEP: 'it must be a multiple of the bid step',
  AUCTION_CLOSED: 'the auction has closed',
  NOT_STARTED: 'the auction has not started',
  NOT_ELIGIBLE: 'you are not eligible to win this auction',
};

function Receipts() {
  const { data, error } = useLoad<any[]>('/me/member/payments');
  if (error) return <Notice kind="error" text={error} />;
  if (!data) return <ActivityIndicator color="#0070BA" />;
  return (
    <View style={mStyles.card}>
      {data.length === 0 && <Text style={{ color: '#64748B' }}>No receipts yet.</Text>}
      {data.map((p) => (
        <Row key={p.id} label={`${p.receiptNo} · ${p.group.name}${p.installmentNo ? ` · #${p.installmentNo}` : ''} · ${String(p.createdAt).slice(0, 10)}`} value={`${inr(p.amount)}${p.isReversed ? ' (reversed)' : p.verificationStatus !== 'VERIFIED' ? ' (pending)' : ''}`} />
      ))}
    </View>
  );
}
