import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, TextInput } from 'react-native';
import { mStyles } from '../manager/commonStyles';

/** Shared bits for the engine screens (manager + member). Amounts come from the server as exact strings. */
export const inr = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v))
    ? '—'
    : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const apiError = (e: any, fallback = 'Something went wrong') => e?.response?.data?.message || fallback;

/** Random id for idempotent requests (bids). */
export const requestId = () =>
  'r' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '-' + Math.random().toString(36).slice(2, 10);

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const STATUS_COLORS: Record<string, [string, string]> = {
  SCHEDULED: ['#EFF6FF', '#1D4ED8'],
  OPEN: ['#F0FDF4', '#15803D'],
  CLOSED: ['#FFFBEB', '#B45309'],
  PENDING_APPROVAL: ['#FFF7ED', '#C2410C'],
  SETTLED: ['#F1F5F9', '#334155'],
  CANCELLED: ['#FEF2F2', '#B91C1C'],
  NO_BID: ['#FEF2F2', '#B91C1C'],
  PAID: ['#F0FDF4', '#15803D'],
  PARTIAL: ['#FFFBEB', '#B45309'],
  OVERDUE: ['#FEF2F2', '#B91C1C'],
  DUE: ['#FFF7ED', '#C2410C'],
  UPCOMING: ['#EFF6FF', '#1D4ED8'],
  ENGINE_V1: ['#F0FDF4', '#15803D'],
  LEGACY: ['#F1F5F9', '#475569'],
};

export function Pill({ value, label }: { value: string; label?: string }) {
  const [bg, fg] = STATUS_COLORS[value] || ['#F1F5F9', '#334155'];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: '700' }}>{label ?? value.replace(/_/g, ' ')}</Text>
    </View>
  );
}

export function Btn({ title, onPress, kind = 'secondary', disabled, label }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; label?: string }) {
  const style = kind === 'primary' ? mStyles.primaryBtn : kind === 'danger' ? mStyles.dangerBtn : mStyles.secondaryBtn;
  const textStyle = kind === 'primary' ? mStyles.primaryBtnText : kind === 'danger' ? mStyles.dangerBtnText : mStyles.secondaryBtnText;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      disabled={disabled}
      onPress={onPress}
      style={[style, { paddingVertical: 8, paddingHorizontal: 12, minHeight: 40, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={textStyle}>{title}</Text>
    </TouchableOpacity>
  );
}

export function Sheet({ title, visible, onClose, children, maxWidth = 760 }: { title: string; visible: boolean; onClose: () => void; children: React.ReactNode; maxWidth?: number }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={mStyles.modalBackdrop}>
        <View style={[mStyles.modalBox, { maxWidth }]}>
          <View style={mStyles.modalHeader}>
            <Text style={mStyles.modalTitle} accessibilityRole="header">
              {title}
            </Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close dialog" style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={mStyles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function Field({ label, value, onChangeText, placeholder, keyboardType }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; keyboardType?: 'numeric' | 'default' }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={mStyles.label}>{label}</Text>
      <TextInput style={mStyles.input} value={value} onChangeText={onChangeText} placeholder={placeholder} keyboardType={keyboardType ?? 'default'} accessibilityLabel={label} />
    </View>
  );
}

export function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', gap: 8 }}>
      <Text style={{ fontSize: 13, color: '#475569', flexShrink: 1 }}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? <Text style={{ fontSize: 13, color: '#0F172A', fontWeight: strong ? '800' : '600' }}>{value}</Text> : value}
    </View>
  );
}

export function Notice({ kind, text }: { kind: 'error' | 'warning' | 'info' | 'success'; text: string }) {
  const c = { error: ['#FEF2F2', '#991B1B'], warning: ['#FFFBEB', '#92400E'], info: ['#EFF6FF', '#1E40AF'], success: ['#F0FDF4', '#166534'] }[kind];
  return (
    <View style={{ backgroundColor: c[0], borderRadius: 8, padding: 10, marginBottom: 8 }} accessibilityRole="alert">
      <Text style={{ color: c[1], fontSize: 13 }}>{text}</Text>
    </View>
  );
}
