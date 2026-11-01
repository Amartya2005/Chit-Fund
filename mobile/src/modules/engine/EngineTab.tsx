import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { api } from '../../services/api';
import { mStyles } from '../manager/commonStyles';
import { Btn, Field, Notice, Pill, Row, Sheet, apiError, fmtTime, inr } from './ui';

/**
 * Manager screen for the auction & financial engine (P3–P8). Every amount shown here is computed by the
 * backend engine; this screen never calculates money.
 */
type SubTab = 'groups' | 'auctions' | 'approvals';

export function EngineTab({ user }: { user: any }) {
  const [tab, setTab] = useState<SubTab>('groups');
  return (
    <ScrollView style={mStyles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={mStyles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={mStyles.headerTitle} accessibilityRole="header">⚙️ Auction Engine</Text>
          <Text style={mStyles.headerSubtitle}>Per-ticket dues, scheduled auctions, results and approvals for groups converted to the engine.</Text>
        </View>
      </View>
      <View style={mStyles.subTabs}>
        {(['groups', 'auctions', 'approvals'] as SubTab[]).map((t) => (
          <TouchableOpacity key={t} onPress={() => setTab(t)} style={[mStyles.subTabItem, tab === t && mStyles.subTabItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={[mStyles.subTabText, tab === t && mStyles.subTabTextActive]}>{t === 'groups' ? 'Groups & dues' : t === 'auctions' ? 'Auctions' : 'Approvals'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {tab === 'groups' && <GroupsPanel />}
      {tab === 'auctions' && <AuctionsPanel />}
      {tab === 'approvals' && <ApprovalsPanel userId={user?.id} />}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------
function GroupsPanel() {
  const [groups, setGroups] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [convert, setConvert] = useState<any>(null);
  const [dues, setDues] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get('/chit-groups');
      setGroups(r.data.data || []);
    } catch (e) {
      setError(apiError(e, 'Could not load groups'));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <Notice kind="error" text={error} />;
  if (!groups) return <ActivityIndicator style={{ marginTop: 30 }} color="#0070BA" />;
  return (
    <View>
      {groups.length === 0 && <Notice kind="info" text="No chit groups yet." />}
      {groups.map((g) => (
        <View key={g.id} style={mStyles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <Text style={mStyles.cardTitle}>
              {g.name} <Text style={{ color: '#64748B', fontSize: 12 }}>[{g.groupCode}]</Text>
            </Text>
            <Pill value={g.engineVersion || 'LEGACY'} label={g.engineVersion === 'ENGINE_V1' ? 'On engine' : 'Existing workflow'} />
          </View>
          <Text style={mStyles.cardSubtitle}>
            {inr(g.chitValue)} · {g.maxMembers} tickets · {g.totalMonths} instalments
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {g.engineVersion === 'ENGINE_V1' ? (
              <>
                <Btn title="📒 Dues" onPress={() => setDues(g)} />
                <Btn title="🗓️ Plan auctions" onPress={() => setPlan(g)} />
              </>
            ) : (
              <Btn title="🔁 Move to engine…" onPress={() => setConvert(g)} />
            )}
          </View>
        </View>
      ))}
      {convert && <ConvertSheet group={convert} onClose={() => { setConvert(null); load(); }} />}
      {dues && <DuesSheet group={dues} onClose={() => setDues(null)} />}
      {plan && <PlanSheet group={plan} onClose={() => setPlan(null)} />}
    </View>
  );
}

function ConvertSheet({ group, onClose }: { group: any; onClose: () => void }) {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api.post(`/engine/groups/${group.id}/convert`, { dryRun: true }).then((r) => setReport(r.data.data), (e) => setError(apiError(e)));
  }, [group.id]);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/engine/groups/${group.id}/convert`, {});
      setDone(true);
    } catch (e) {
      setError(apiError(e));
    } finally {
      setBusy(false);
    }
  };
  const rep = report?.report;
  return (
    <Sheet title={`Move ${group.name} to the engine`} visible onClose={onClose}>
      {error ? <Notice kind="error" text={error} /> : null}
      {done && <Notice kind="success" text="The group now runs on the engine. Its history was carried over exactly as previewed." />}
      {!rep && !error && <ActivityIndicator color="#0070BA" />}
      {rep && !done && (
        <View>
          <Notice kind="info" text="Preview only — nothing changes until you confirm. Past payments stay on the instalment they were recorded for." />
          {rep.blocking.map((b: any, i: number) => <Notice key={`b${i}`} kind="error" text={b.message} />)}
          {rep.warnings.map((w: any, i: number) => <Notice key={`w${i}`} kind="warning" text={w.message} />)}
          <Row label="Instalment periods" value={rep.periods} />
          <Row label="Active tickets / others" value={`${rep.tickets.active} / ${rep.tickets.notActive}`} />
          <Row label="Verified payments" value={`${rep.payments.verifiedCount} · ${inr(rep.payments.verifiedTotal)}`} />
          <Row label="Applied to dues" value={inr(rep.payments.allocatedToDues)} />
          <Row label="Kept as advance" value={inr(rep.payments.advance)} />
          <Row label="Exited tickets' payments" value={inr(rep.payments.exitedTickets)} />
          <Row label="Waiting for approval (not moved)" value={rep.payments.excludedPending} />
          <Row label="Dividends already credited" value={inr(rep.dividends.creditedTotal)} />
          <Row label="Amounts pending a business decision" value={`${rep.pendingDividendDecisions.count} · ${inr(rep.pendingDividendDecisions.total)}`} />
          <Row label="Reconciled" value={rep.reconciled ? '✓ yes' : '✕ no'} strong />
          <View style={{ marginTop: 12 }}>
            <Btn title={busy ? 'Moving…' : 'Confirm and move to the engine'} kind="primary" disabled={busy || !report.canConvert} onPress={run} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

function DuesSheet({ group, onClose }: { group: any; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(() => {
    api.get(`/engine/groups/${group.id}/dues`).then((r) => setData(r.data.data), (e) => setMsg({ kind: 'error', text: apiError(e) }));
  }, [group.id]);
  useEffect(load, [load]);
  const penalties = async () => {
    try {
      const r = await api.post(`/engine/groups/${group.id}/penalties/run`, {});
      setMsg({ kind: 'success', text: r.data.data.mode === 'NONE' ? 'Penalties are switched off for this group.' : `${r.data.data.charged.length} penalty charge(s), total ${inr(r.data.data.total)}.` });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: apiError(e) });
    }
  };
  return (
    <Sheet title={`Dues — ${group.name}`} visible onClose={onClose} maxWidth={900}>
      {msg && <Notice kind={msg.kind} text={msg.text} />}
      {!data ? (
        <ActivityIndicator color="#0070BA" />
      ) : (
        <View>
          <Text style={{ fontSize: 12, color: '#64748B', marginBottom: 8 }}>As of {data.asOf}. Due today is shown as due, not overdue.</Text>
          <View style={mStyles.table}>
            <View style={mStyles.tableHeader}>
              {['Ticket', 'Member', 'Overdue', 'Due today', 'Upcoming', 'Advance'].map((h, i) => (
                <Text key={h} style={[mStyles.tableHeaderCell, i === 1 ? { flex: 1, minWidth: 120 } : { width: 90 }]}>{h}</Text>
              ))}
            </View>
            {data.tickets.map((t: any) => (
              <View key={t.memberId} style={mStyles.tableRow}>
                <Text style={[mStyles.tableCell, { width: 90, fontWeight: '700' }]}>#{t.ticketNumber}</Text>
                <Text style={[mStyles.tableCell, { flex: 1, minWidth: 120 }]}>{t.subscriber.fullName}{t.status !== 'ACTIVE' ? ` (${t.status.toLowerCase()})` : ''}</Text>
                <Text style={[mStyles.tableCell, { width: 90, color: Number(t.totals.overdue) > 0 ? '#B91C1C' : '#0F172A' }]}>{inr(t.totals.overdue)}</Text>
                <Text style={[mStyles.tableCell, { width: 90 }]}>{inr(t.totals.dueToday)}</Text>
                <Text style={[mStyles.tableCell, { width: 90 }]}>{inr(t.totals.upcoming)}</Text>
                <Text style={[mStyles.tableCell, { width: 90 }]}>{inr(t.advance)}</Text>
              </View>
            ))}
          </View>
          <View style={{ marginTop: 12, flexDirection: 'row', gap: 8 }}>
            <Btn title="Apply penalties for today" onPress={penalties} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

function PlanSheet({ group, onClose }: { group: any; onClose: () => void }) {
  const [date, setDate] = useState('');
  const [opens, setOpens] = useState('18:00');
  const [closes, setCloses] = useState('19:00');
  const [monthDay, setMonthDay] = useState('');
  const [count, setCount] = useState('');
  const [holiday, setHoliday] = useState<'NEXT_BUSINESS_DAY' | 'PREVIOUS_BUSINESS_DAY' | 'SKIP' | 'IGNORE'>('NEXT_BUSINESS_DAY');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'warning'; text: string } | null>(null);
  const single = async () => {
    try {
      await api.post(`/engine/groups/${group.id}/sessions`, { date, opensAtLocal: opens, closesAtLocal: closes });
      setMsg({ kind: 'success', text: `Auction added on ${date}.` });
    } catch (e) {
      setMsg({ kind: 'error', text: apiError(e) });
    }
  };
  const monthly = async () => {
    try {
      const r = await api.post(`/engine/groups/${group.id}/schedules`, {
        frequency: 'MONTHLY_BY_DAY', byMonthDays: [Number(monthDay)], startDate: date, maxOccurrences: Number(count), opensAtLocal: opens, closesAtLocal: closes, holidayPolicy: holiday,
      });
      const w = r.data.data.warnings?.[0]?.message;
      setMsg({ kind: w ? 'warning' : 'success', text: `${r.data.data.planned} auctions planned, ${r.data.data.materialized} created for the next 60 days.${w ? ' ' + w : ''}` });
    } catch (e) {
      setMsg({ kind: 'error', text: apiError(e) });
    }
  };
  return (
    <Sheet title={`Plan auctions — ${group.name}`} visible onClose={onClose}>
      {msg && <Notice kind={msg.kind} text={msg.text} />}
      <Field label="Date (YYYY-MM-DD) — single auction, or the first day of a monthly plan" value={date} onChangeText={setDate} placeholder="2026-12-20" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Opens (HH:mm, IST)" value={opens} onChangeText={setOpens} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Closes (HH:mm, IST)" value={closes} onChangeText={setCloses} />
        </View>
      </View>
      <Btn title="Add one auction on this date" kind="primary" onPress={single} />
      <View style={{ height: 1, backgroundColor: '#E2E8F0', marginVertical: 14 }} />
      <Text style={{ fontWeight: '700', marginBottom: 6 }}>Monthly plan</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Day of month (1–31; 31 = last day)" value={monthDay} onChangeText={setMonthDay} keyboardType="numeric" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Number of auctions" value={count} onChangeText={setCount} keyboardType="numeric" />
        </View>
      </View>
      <Text style={mStyles.label}>On a holiday</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {(['NEXT_BUSINESS_DAY', 'PREVIOUS_BUSINESS_DAY', 'SKIP', 'IGNORE'] as const).map((h) => (
          <TouchableOpacity key={h} onPress={() => setHoliday(h)} style={[mStyles.chip, holiday === h && mStyles.chipActive]} accessibilityRole="radio" accessibilityState={{ selected: holiday === h }}>
            <Text style={[mStyles.chipText, holiday === h && mStyles.chipTextActive]}>{h === 'NEXT_BUSINESS_DAY' ? 'Next working day' : h === 'PREVIOUS_BUSINESS_DAY' ? 'Previous working day' : h === 'SKIP' ? 'Skip' : 'Hold anyway'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Btn title="Create monthly plan" kind="primary" onPress={monthly} disabled={!monthDay || !count || !date} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------
function AuctionsPanel() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);
  const [liveFor, setLiveFor] = useState<any>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get('/engine/sessions');
      setRows(r.data.data);
    } catch (e) {
      setError(apiError(e, 'Could not load auctions'));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (s: any, action: string, body: any = {}) => {
    try {
      await api.post(`/engine/sessions/${s.id}/${action}`, body);
      setNotice({ kind: 'success', text: `Auction #${s.sequenceNo} (${s.group.name}): ${action.replace('-', ' ')} done.` });
      load();
    } catch (e) {
      setNotice({ kind: 'error', text: apiError(e) });
    }
  };
  if (error) return <Notice kind="error" text={error} />;
  if (!rows) return <ActivityIndicator style={{ marginTop: 30 }} color="#0070BA" />;
  return (
    <View>
      {notice && <Notice kind={notice.kind} text={notice.text} />}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        <Btn title="↻ Run scheduler now" onPress={async () => { try { await api.post('/engine/scheduler/run', {}); load(); } catch (e) { setNotice({ kind: 'error', text: apiError(e) }); } }} />
      </View>
      {rows.length === 0 && <Notice kind="info" text="No auctions yet — plan them from Groups & dues." />}
      {rows.map((s) => (
        <View key={s.id} style={mStyles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <Text style={mStyles.cardTitle}>
              {s.group.name} · Auction #{s.sequenceNo}
            </Text>
            <Pill value={s.status} />
          </View>
          <Text style={mStyles.cardSubtitle}>
            {s.scheduledDate} · {fmtTime(s.opensAt)} – {fmtTime(s.extendedUntil || s.closesAt)} IST · {s.mode.toLowerCase()}
            {s.statusReason ? ` · ${s.statusReason}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {s.status === 'SCHEDULED' && <Btn title="Open" kind="primary" onPress={() => act(s, 'open')} />}
            {s.status === 'OPEN' && s.mode !== 'OFFLINE' && <Btn title="📡 Live" onPress={() => setLiveFor(s)} />}
            {s.status === 'OPEN' && <Btn title="Close" onPress={() => act(s, 'close')} />}
            {s.status === 'CLOSED' && s.mode === 'OFFLINE' && <Btn title="Enter result" kind="primary" onPress={() => setResult(s)} />}
            {s.status === 'CLOSED' && s.mode !== 'OFFLINE' && <Btn title="Settle with best bid" kind="primary" onPress={() => api.post(`/engine/sessions/${s.id}/result-from-bids`, {}).then(load, (e) => setNotice({ kind: 'error', text: apiError(e) }))} />}
            {(s.status === 'OPEN' || s.status === 'CLOSED') && <Btn title="No bid" onPress={() => act(s, 'no-bid')} />}
            {['SCHEDULED', 'OPEN', 'CLOSED'].includes(s.status) && <Btn title="Cancel" kind="danger" onPress={() => act(s, 'cancel', { reason: 'Cancelled by manager' })} />}
          </View>
        </View>
      ))}
      {result && <ResultSheet session={result} onClose={() => { setResult(null); load(); }} />}
      {liveFor && <LiveSheet session={liveFor} onClose={() => { setLiveFor(null); load(); }} />}
    </View>
  );
}

function ResultSheet({ session, onClose }: { session: any; onClose: () => void }) {
  const [tickets, setTickets] = useState<any[]>([]);
  const [winner, setWinner] = useState('');
  const [discount, setDiscount] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<any>(null);
  useEffect(() => {
    api.get(`/engine/groups/${session.groupId}/dues`).then((r) => setTickets(r.data.data.tickets), (e) => setError(apiError(e)));
  }, [session.groupId]);
  const doPreview = async () => {
    setError('');
    setPreview(null);
    try {
      const r = await api.post(`/engine/sessions/${session.id}/preview`, { winnerMemberId: winner, discount });
      setPreview(r.data.data);
    } catch (e) {
      setError(apiError(e));
    }
  };
  const submit = async () => {
    try {
      const r = await api.post(`/engine/sessions/${session.id}/result`, { winnerMemberId: winner, discount });
      setSaved(r.data.data);
    } catch (e) {
      setError(apiError(e));
    }
  };
  const o = preview?.outcome;
  return (
    <Sheet title={`Result — ${session.group.name} · Auction #${session.sequenceNo}`} visible onClose={onClose}>
      {error ? <Notice kind="error" text={error} /> : null}
      {saved ? (
        <Notice kind="success" text={saved.status === 'PENDING_APPROVAL' ? 'Result saved — waiting for a second person to approve it.' : `Settled. Winner receives ${inr(saved.netPrize)}; dividends credited to members.`} />
      ) : (
        <View>
          <Text style={mStyles.label}>Winning ticket</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {tickets.filter((t) => t.status === 'ACTIVE').map((t) => (
              <TouchableOpacity key={t.memberId} onPress={() => { setWinner(t.memberId); setPreview(null); }} style={[mStyles.chip, winner === t.memberId && mStyles.chipActive]} accessibilityRole="radio" accessibilityState={{ selected: winner === t.memberId }}>
                <Text style={[mStyles.chipText, winner === t.memberId && mStyles.chipTextActive]}>#{t.ticketNumber} {t.subscriber.fullName}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Field label="Amount the winner gives up (discount, ₹)" value={discount} onChangeText={(v) => { setDiscount(v); setPreview(null); }} keyboardType="numeric" />
          <Btn title="Preview calculation" onPress={doPreview} disabled={!winner || !discount} />
          {o && (
            <View style={{ marginTop: 12 }}>
              {!o.valid && o.errors.map((e: any, i: number) => <Notice key={i} kind="error" text={e.message} />)}
              <Row label="Foreman's fee (commission)" value={inr(o.commission)} />
              <Row label="Shared back to members (dividend pool)" value={inr(o.dividendPool)} />
              <Row label={`Per ticket${preview.targetPeriodNo ? ` (off instalment #${preview.targetPeriodNo})` : ''}`} value={inr(o.dividendPerShare)} />
              <Row label="Kept aside (pending a decision / rounding)" value={inr(o.unallocatedTotal)} />
              <Row label="Prize" value={inr(o.grossPrize)} />
              <Row label="Deducted dues" value={inr(o.deductionsTotal)} />
              <Row label="Winner receives" value={inr(o.netPrize)} strong />
              {preview.approvalNeeded && <Notice kind="info" text="A second person must approve this result before it takes effect." />}
              <View style={{ marginTop: 12 }}>
                <Btn title="Save result" kind="primary" onPress={submit} disabled={!preview.valid} />
              </View>
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}

function LiveSheet({ session, onClose }: { session: any; onClose: () => void }) {
  const [state, setState] = useState<any>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.get(`/engine/sessions/${session.id}/live`);
        if (!stop) setState(r.data.data);
      } catch {}
      if (!stop) setTimeout(tick, 3000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [session.id]);
  return (
    <Sheet title={`Live — ${session.group.name} · Auction #${session.sequenceNo}`} visible onClose={onClose}>
      {!state ? (
        <ActivityIndicator color="#0070BA" />
      ) : (
        <View>
          <Row label="Status" value={<Pill value={state.status} />} />
          <Row label="Closes" value={`${fmtTime(state.closesAt)} IST${state.extensions ? ` (extended ${state.extensions}×)` : ''}`} />
          <Row label="Accepted bids" value={state.acceptedBids} />
          <Row label="Best bid" value={state.best ? `${inr(state.best.amount)} · ticket #${state.best.ticketNumber}${state.best.name ? ` · ${state.best.name}` : ''}` : '—'} strong />
        </View>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------
function ApprovalsPanel({ userId }: { userId?: string }) {
  const [pending, setPending] = useState<any[] | null>(null);
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.get('/engine/sessions', { params: { status: 'PENDING_APPROVAL' } }), api.get('/engine/adjustments', { params: { status: 'REQUESTED' } })]);
      const details = await Promise.all(s.data.data.map((x: any) => api.get(`/engine/sessions/${x.id}`).then((r) => r.data.data)));
      setPending(details);
      setAdjustments(a.data.data);
    } catch (e) {
      setNotice({ kind: 'error', text: apiError(e) });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const decide = async (path: string, ok: string) => {
    try {
      await api.post(path, {});
      setNotice({ kind: 'success', text: ok });
      load();
    } catch (e) {
      setNotice({ kind: 'error', text: apiError(e) });
    }
  };
  if (!pending) return <ActivityIndicator style={{ marginTop: 30 }} color="#0070BA" />;
  return (
    <View>
      {notice && <Notice kind={notice.kind} text={notice.text} />}
      <Text style={{ fontWeight: '800', marginBottom: 6 }}>Auction results</Text>
      {pending.length === 0 && <Notice kind="info" text="Nothing waiting for approval." />}
      {pending.map((s) => {
        const st = s.settlements.find((x: any) => x.status === 'PENDING_APPROVAL');
        if (!st) return null;
        const mine = st.submittedById === userId;
        return (
          <View key={s.id} style={mStyles.card}>
            <Text style={mStyles.cardTitle}>{s.group.name} · Auction #{s.sequenceNo}</Text>
            <Row label="Discount" value={inr(st.winningDiscount)} />
            <Row label="Commission" value={inr(st.commission)} />
            <Row label="Dividend per ticket" value={inr(st.dividendPerShare)} />
            <Row label="Winner receives" value={inr(st.netPrize)} strong />
            {mine && <Notice kind="info" text="You entered this result; another manager must approve it." />}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn title="Approve" kind="primary" disabled={mine} onPress={() => decide(`/engine/settlements/${st.id}/approve`, 'Result approved and settled.')} />
              <Btn title="Reject" kind="danger" disabled={mine} onPress={() => decide(`/engine/settlements/${st.id}/reject`, 'Result rejected; the auction can be re-entered.')} />
            </View>
          </View>
        );
      })}
      <Text style={{ fontWeight: '800', marginVertical: 6 }}>Waivers</Text>
      {adjustments.length === 0 && <Notice kind="info" text="No waiver requests." />}
      {adjustments.map((a) => (
        <View key={a.id} style={mStyles.card}>
          <Text style={mStyles.cardTitle}>{a.type === 'PENALTY_WAIVER' ? 'Penalty waiver' : 'Instalment waiver'} · {inr(a.amount)}</Text>
          <Text style={mStyles.cardSubtitle}>Instalment #{a.due?.periodNo} · requested by {a.requestedBy?.fullName} · “{a.reason}”</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn title="Approve" kind="primary" disabled={a.requestedBy?.id === userId} onPress={() => decide(`/engine/adjustments/${a.id}/approve`, 'Waiver applied.')} />
            <Btn title="Reject" kind="danger" disabled={a.requestedBy?.id === userId} onPress={() => decide(`/engine/adjustments/${a.id}/reject`, 'Waiver rejected.')} />
          </View>
        </View>
      ))}
    </View>
  );
}
