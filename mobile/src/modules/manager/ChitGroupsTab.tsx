import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { api } from '../../services/api';
import { mStyles } from './commonStyles';
import { FinancialSettingsModal } from './FinancialSettingsModal';

export function ChitGroupsTab({ user }: { user: any }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [subscribers, setSubscribers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'UPCOMING' | 'COMPLETED' | 'CLOSED'>('ALL');
  const isManagerOrAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'MANAGER';
  const isStaff = user?.role === 'COLLECTION_STAFF';
  const [assignmentScope, setAssignmentScope] = useState<'ALL' | 'ASSIGNED_TO_ME'>(isStaff ? 'ASSIGNED_TO_ME' : 'ALL');

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showViewMembersModal, setShowViewMembersModal] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<any>(null);

  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const [selectedViewGroup, setSelectedViewGroup] = useState<any>(null);
  const [groupToDelete, setGroupToDelete] = useState<any>(null);
  const [assignGroup, setAssignGroup] = useState<any>(null);
  const [scheduleData, setScheduleData] = useState<any>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');

  // Available staff members for assignment (at most 1 staff per chit group)
  const [staffMembers, setStaffMembers] = useState<any[]>([]);
  const [createStaffId, setCreateStaffId] = useState<string | null>(null);
  const [editStaffId, setEditStaffId] = useState<string | null>(null);
  const [modalStaffId, setModalStaffId] = useState<string | null>(null);

  // Quick Member Registration state inside Enroll Modal
  const [isQuickRegistering, setIsQuickRegistering] = useState(false);
  const [quickFullName, setQuickFullName] = useState('');
  const [quickPhone, setQuickPhone] = useState('');
  const [quickAadhaar, setQuickAadhaar] = useState('');
  const [quickPan, setQuickPan] = useState('');
  const [quickAddress, setQuickAddress] = useState('');
  const [quickRegistering, setQuickRegistering] = useState(false);
  const [quickError, setQuickError] = useState('');

  // Helper: Actual current date in YYYY-MM-DD (Asia/Kolkata / local timezone)
  const getActualTodayDate = (): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  };

  const formatActualTimestamp = (dateStr?: string | Date): string => {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return String(dateStr);
    }
  };

  // Helper: Format commencement date to Indian standard (DD-MM-YYYY)
  const formatCommencementDate = (dateStr?: string): string => {
    if (!dateStr) {
      const d = new Date();
      return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    }
    if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) return dateStr;
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    const parts = cleanDate.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      const [y, m, d] = parts;
      return `${d}-${m}-${y}`;
    }
    return dateStr;
  };

  // Create Group Form (AC-05, AC-06)
  const actualToday = getActualTodayDate();
  const [groupName, setGroupName] = useState('');
  const [durationMonths, setDurationMonths] = useState('20');
  const [monthlyInstallment, setMonthlyInstallment] = useState('5000');
  const [maxMembers, setMaxMembers] = useState('20');
  const [foremanCommissionRate, setForemanCommissionRate] = useState('5');
  const [startDate, setStartDate] = useState(actualToday); // Actual date, editable

  // Edit Group Form
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  const [editChitValue, setEditChitValue] = useState('');
  const [editDurationMonths, setEditDurationMonths] = useState('');
  const [editMonthlyInstallment, setEditMonthlyInstallment] = useState('');
  const [editMaxMembers, setEditMaxMembers] = useState('');
  const [editForemanCommissionRate, setEditForemanCommissionRate] = useState('5');
  const [editStartDate, setEditStartDate] = useState('');
  const [editStatus, setEditStatus] = useState('ACTIVE');

  // Enroll Member Form (AC-03)
  const [selectedSubscriberId, setSelectedSubscriberId] = useState('');
  const [ticketNo, setTicketNo] = useState('');

  const fetchGroups = async () => {
    try {
      setLoading(true);
      const [gRes, sRes, staffRes] = await Promise.all([
        api.get('/chit-groups'),
        api.get('/subscribers'),
        api.get('/auth/users').catch(() => ({ data: { data: [] } })),
      ]);
      if (gRes.data.success) {
        setGroups(gRes.data.data || []);
      }
      if (sRes.data.success) {
        setSubscribers(sRes.data.data || []);
        if (sRes.data.data.length > 0 && !selectedSubscriberId) {
          setSelectedSubscriberId(sRes.data.data[0].id);
        }
      }
      if (staffRes.data.success) {
        const allUsers = staffRes.data.data || [];
        const eligible = allUsers.filter(
          (u: any) => u.role === 'COLLECTION_STAFF' || u.role === 'MANAGER' || u.role === 'SUPER_ADMIN'
        );
        if (user && !eligible.some((u: any) => u.id === user.id)) {
          eligible.unshift(user);
        }
        setStaffMembers(eligible);
      }
    } catch (e) {
      console.error('Error fetching chit group data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, []);

  const updateCreateDuration = (val: string) => {
    setDurationMonths(val);
    setMaxMembers(val); // default maxMembers to duration
  };

  // Auto-calculate monthly installment on edit
  const updateEditChitValue = (val: string) => {
    setEditChitValue(val);
    const cv = Number(val) || 0;
    const dm = Number(editDurationMonths) || 1;
    if (dm > 0) setEditMonthlyInstallment(String(Math.round(cv / dm)));
  };

  const updateEditDuration = (val: string) => {
    setEditDurationMonths(val);
    const cv = Number(editChitValue) || 0;
    const dm = Number(val) || 1;
    if (dm > 0) setEditMonthlyInstallment(String(Math.round(cv / dm)));
  };

  // AC-05: Create Chit Group (commencement date locked to actual date)
  const handleCreateGroup = async () => {
    if (!groupName.trim() || !durationMonths || !monthlyInstallment) {
      alert('Please fill all mandatory group configuration fields');
      return;
    }
    const computedPoolValue = (Number(monthlyInstallment) || 0) * (Number(durationMonths) || 0);
    try {
      setSubmitting(true);
      const res = await api.post('/chit-groups', {
        name: groupName.trim(),
        chitValue: computedPoolValue,
        totalMonths: Number(durationMonths),
        monthlyInstallment: Number(monthlyInstallment),
        maxMembers: Number(maxMembers || durationMonths),
        foremanCommissionPct: Number(foremanCommissionRate),
        startDate: startDate || actualToday, // Actual commencement date
        assignedStaffId: createStaffId || null,
        assignedStaffIds: createStaffId ? [createStaffId] : [],
      });

      if (res.data.success) {
        alert('Chit group created successfully: ' + res.data.data.name);
        setShowCreateModal(false);
        setGroupName('');
        setCreateStaffId(null);
        fetchGroups();
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to create chit group');
    } finally {
      setSubmitting(false);
    }
  };

  // Open Edit Modal
  const handleOpenEdit = (grp: any) => {
    setEditGroupId(grp.id);
    setEditGroupName(grp.name || '');
    setEditChitValue(String(grp.chitValue ?? grp.totalChitValue ?? 100000));
    setEditDurationMonths(String(grp.totalMonths ?? grp.durationMonths ?? 20));
    setEditMonthlyInstallment(String(grp.monthlyInstallment ?? 5000));
    setEditMaxMembers(String(grp.maxMembers ?? 20));
    setEditForemanCommissionRate(String(grp.foremanCommissionPct ?? grp.foremanCommissionRate ?? 5));
    setEditStartDate(grp.startDate || actualToday);
    setEditStatus(grp.status || 'ACTIVE');

    // Current assigned staff ID (at most 1 staff per chit group)
    const currentAssignedId =
      grp.assignedStaffId ||
      grp.assignedStaff?.id ||
      grp.staffAssignments?.[0]?.staffId ||
      grp.staffAssignments?.[0]?.staff?.id ||
      null;
    setEditStaffId(currentAssignedId);
    setShowEditModal(true);
  };

  // Update Chit Group
  const handleUpdateGroup = async () => {
    if (!editGroupId || !editGroupName.trim() || !editChitValue || !editDurationMonths) {
      alert('Please fill all required group configuration fields');
      return;
    }
    try {
      setSubmitting(true);
      const res = await api.put(`/chit-groups/${editGroupId}`, {
        name: editGroupName.trim(),
        chitValue: Number(editChitValue),
        totalMonths: Number(editDurationMonths),
        monthlyInstallment: Number(editMonthlyInstallment),
        maxMembers: Number(editMaxMembers),
        foremanCommissionPct: Number(editForemanCommissionRate),
        status: editStatus,
        startDate: editStartDate || actualToday,
        assignedStaffId: editStaffId || null,
        assignedStaffIds: editStaffId ? [editStaffId] : [],
      });

      if (res.data.success) {
        alert('Chit group updated successfully: ' + res.data.data.name);
        setShowEditModal(false);
        fetchGroups();
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to update chit group');
    } finally {
      setSubmitting(false);
    }
  };

  // Open Quick Staff Assignment Modal
  const handleOpenAssignStaff = (grp: any) => {
    setAssignGroup(grp);
    const currentAssignedId =
      grp.assignedStaffId ||
      grp.assignedStaff?.id ||
      grp.staffAssignments?.[0]?.staffId ||
      grp.staffAssignments?.[0]?.staff?.id ||
      null;
    setModalStaffId(currentAssignedId);
    setShowAssignModal(true);
  };

  // Save Staff Assignments for Group
  const handleSaveAssignStaff = async () => {
    if (!assignGroup) return;
    try {
      setAssigning(true);
      const res = await api.post(`/chit-groups/${assignGroup.id}/assign-staff`, {
        assignedStaffId: modalStaffId || null,
        staffIds: modalStaffId ? [modalStaffId] : [],
      });
      if (res.data.success) {
        alert(res.data.message || `Staff assignment updated successfully for group "${assignGroup.name}".`);
        setShowAssignModal(false);
        setAssignGroup(null);
        fetchGroups();
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to assign staff to chit group');
    } finally {
      setAssigning(false);
    }
  };

  // Open Delete Confirmation
  const handleOpenDelete = (grp: any) => {
    setGroupToDelete(grp);
    setShowDeleteModal(true);
  };

  // Confirm Delete Chit Group
  const handleConfirmDelete = async () => {
    if (!groupToDelete) return;
    try {
      setSubmitting(true);
      const res = await api.delete(`/chit-groups/${groupToDelete.id}`);
      if (res.data.success) {
        alert(res.data.message || `Chit group '${groupToDelete.name}' deleted successfully.`);
        setShowDeleteModal(false);
        setGroupToDelete(null);
        fetchGroups();
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to delete chit group');
    } finally {
      setSubmitting(false);
    }
  };

  // AC-03: Enroll Member
  const handleEnrollMember = async () => {
    if (!selectedGroup || !selectedSubscriberId) {
      alert('Please select both a subscriber and ticket number');
      return;
    }
    try {
      setSubmitting(true);
      const res = await api.post('/chit-groups/enroll', {
        groupId: selectedGroup.id,
        subscriberId: selectedSubscriberId,
        ticketNo: ticketNo ? Number(ticketNo) : undefined,
      });

      if (res.data.success) {
        alert(`Member successfully enrolled with Ticket #${res.data.data.ticketNumber || res.data.data.ticketNo}`);
        setShowEnrollModal(false);
        setTicketNo('');
        setSelectedSubscriberId('');
        await fetchGroups();

        // Open view members modal with updated data
        const currentGroupId = selectedGroup.id;
        const updatedRes = await api.get('/chit-groups').catch(() => null);
        if (updatedRes?.data?.data) {
          const updatedGrp = updatedRes.data.data.find((g: any) => g.id === currentGroupId);
          if (updatedGrp) {
            setSelectedViewGroup(updatedGrp);
            setShowViewMembersModal(true);
          }
        }
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to enroll member');
    } finally {
      setSubmitting(false);
    }
  };

  // Open Enrolled / Assigned Members View
  const handleOpenViewMembers = (grp: any) => {
    setSelectedViewGroup(grp);
    setShowViewMembersModal(true);
  };

  // AC-07: View Installment Schedule
  const handleOpenSchedule = async (grp: any) => {
    setSelectedGroup(grp);
    setShowScheduleModal(true);
    try {
      setModalLoading(true);
      const res = await api.get(`/chit-groups/${grp.id}`);
      if (res.data.success) {
        setScheduleData(res.data.data);
      }
    } catch (e: any) {
      alert(e.response?.data?.message || 'Failed to fetch schedule');
    } finally {
      setModalLoading(false);
    }
  };

  const isGroupAssignedToUser = (grp: any) => {
    if (!user?.id) return false;
    if (grp.assignedStaffId === user.id) return true;
    if (grp.staffAssignments && Array.isArray(grp.staffAssignments)) {
      return grp.staffAssignments.some((sa: any) => sa.staffId === user.id || sa.staff?.id === user.id);
    }
    return false;
  };

  const handleQuickRegisterAndEnroll = async () => {
    if (!selectedGroup) return;
    setQuickError('');
    if (!quickFullName.trim() || !quickPhone.trim()) {
      setQuickError('Full Name and Phone Number are required.');
      return;
    }
    try {
      setQuickRegistering(true);
      // 1. Create Subscriber & Enroll into this group (pass groupId so backend automatically enrolls even if member exists)
      const subRes = await api.post('/subscribers', {
        fullName: quickFullName.trim(),
        phone: quickPhone.trim(),
        address: quickAddress.trim() || undefined,
        aadhaarNo: quickAadhaar.trim() || undefined,
        groupId: selectedGroup.id,
      });

      const memberData = subRes.data?.data;
      const isAlreadyRegistered = subRes.data?.alreadyRegistered;

      alert(
        isAlreadyRegistered
          ? `Existing member "${memberData?.fullName}" (${memberData?.subscriberCode}) successfully enrolled into group "${selectedGroup.name}"!`
          : `Member "${memberData?.fullName}" (${memberData?.subscriberCode}) registered and enrolled into group "${selectedGroup.name}"!`
      );
      setShowEnrollModal(false);
      setIsQuickRegistering(false);
      setQuickFullName('');
      setQuickPhone('');
      setQuickAadhaar('');
      setQuickPan('');
      setQuickAddress('');
      setTicketNo('');

      // Refresh groups list
      await fetchGroups();

      // Open assigned members view so staff can immediately view the list of members assigned to them!
      const currentGroupId = selectedGroup.id;
      const updatedRes = await api.get('/chit-groups').catch(() => null);
      if (updatedRes?.data?.data) {
        const updatedGrp = updatedRes.data.data.find((g: any) => g.id === currentGroupId);
        if (updatedGrp) {
          setSelectedViewGroup(updatedGrp);
          setShowViewMembersModal(true);
        }
      }
    } catch (e: any) {
      setQuickError(e.response?.data?.message || e.message || 'Failed to register and enroll member');
    } finally {
      setQuickRegistering(false);
    }
  };

  const filtered = groups.filter((g) => {
    const matchesSearch =
      g.name?.toLowerCase().includes(search.toLowerCase()) ||
      g.groupCode?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || g.status === statusFilter;
    // Staff can ONLY work in their own assigned group(s)
    const matchesScope = isStaff
      ? isGroupAssignedToUser(g)
      : (assignmentScope === 'ALL' || isGroupAssignedToUser(g));
    return matchesSearch && matchesStatus && matchesScope;
  });

  const myAssignedGroups = groups.filter(isGroupAssignedToUser);
  const myAssignedCount = myAssignedGroups.length;
  const myAssignedMembersCount = myAssignedGroups.reduce(
    (acc, g) => acc + (g.members?.length ?? g.memberships?.length ?? g._count?.members ?? 0),
    0
  );

  return (
    <ScrollView style={mStyles.container}>
      {/* Header */}
      <View style={mStyles.headerRow}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={mStyles.headerTitle}>
            {isStaff ? '💰 Your Assigned Chit Groups' : '💰 Chit Groups & Scheme Management'}
          </Text>
          <Text style={mStyles.headerSubtitle}>
            {isStaff
              ? 'You can only view and manage collections for your assigned chit groups'
              : 'Create schemes, edit configuration parameters, enroll members, assign staff, and manage installment schedules'}
          </Text>
        </View>
        {isManagerOrAdmin && (
          <TouchableOpacity style={mStyles.primaryBtn} onPress={() => setShowCreateModal(true)}>
            <Text style={mStyles.primaryBtnText}>➕ Create Chit Group</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Staff Assignment Scope Pills (All Groups removed for Staff dashboard) */}
      {isStaff ? (
        <View style={{ marginBottom: 14 }}>
          <View
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 20,
              backgroundColor: '#0284C7',
              alignSelf: 'flex-start',
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#FFF' }}>
              🏃 Your Assigned Groups ({myAssignedCount})
            </Text>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          <TouchableOpacity
            style={[
              {
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: assignmentScope === 'ALL' ? '#0F2F52' : '#E2E8F0',
              },
            ]}
            onPress={() => setAssignmentScope('ALL')}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '700',
                color: assignmentScope === 'ALL' ? '#FFF' : '#334155',
              }}
            >
              🌐 All Groups ({groups.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              {
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: assignmentScope === 'ASSIGNED_TO_ME' ? '#0284C7' : '#E2E8F0',
              },
            ]}
            onPress={() => setAssignmentScope('ASSIGNED_TO_ME')}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '700',
                color: assignmentScope === 'ASSIGNED_TO_ME' ? '#FFF' : '#334155',
              }}
            >
              🏃 Assigned to Me ({myAssignedCount} Groups • {myAssignedMembersCount} Members)
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* KPI Counters: All Groups shows global totals; Assigned to Me shows manager's own enrolled members and group counts */}
      {assignmentScope === 'ALL' ? (
        <View style={mStyles.kpiRow}>
          <View style={mStyles.kpiCard}>
            <Text style={mStyles.kpiLabel}>Total Groups</Text>
            <Text style={[mStyles.kpiVal, { color: '#0F2F52' }]}>
              {groups.length}
            </Text>
          </View>
          <View style={mStyles.kpiCard}>
            <Text style={mStyles.kpiLabel}>Active Groups</Text>
            <Text style={[mStyles.kpiVal, { color: '#16A34A' }]}>
              {groups.filter((g) => g.status === 'ACTIVE').length}
            </Text>
          </View>
          <View style={mStyles.kpiCard}>
            <Text style={mStyles.kpiLabel}>Total Scheme Value</Text>
            <Text style={[mStyles.kpiVal, { color: '#0070BA' }]}>
              ₹{groups
                .reduce((acc, g) => acc + (g.chitValue || g.totalChitValue || 0), 0)
                .toLocaleString()}
            </Text>
          </View>
        </View>
      ) : isManagerOrAdmin ? (
        <View style={mStyles.kpiRow}>
          <View style={mStyles.kpiCard}>
            <Text style={mStyles.kpiLabel}>Enrolled in My Chit Groups</Text>
            <Text style={[mStyles.kpiVal, { color: '#0F2F52' }]}>
              {myAssignedMembersCount} Members
            </Text>
          </View>
          <View style={mStyles.kpiCard}>
            <Text style={mStyles.kpiLabel}>My Assigned Groups</Text>
            <Text style={[mStyles.kpiVal, { color: '#16A34A' }]}>
              {myAssignedCount}
            </Text>
          </View>
          <View style={mStyles.kpiCard}>
            <Text style={mStyles.kpiLabel}>My Schemes Value</Text>
            <Text style={[mStyles.kpiVal, { color: '#0070BA' }]}>
              ₹{myAssignedGroups
                .reduce((acc, g) => acc + (g.chitValue || g.totalChitValue || 0), 0)
                .toLocaleString()}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Search & Filter Bar */}
      <View style={[mStyles.filterRow, { alignItems: 'center', gap: 10, marginBottom: 16 }]}>
        <TextInput
          style={mStyles.searchBar}
          placeholder="Search by scheme name or code (e.g. CG-2026, Gold Chit)..."
          placeholderTextColor="#94A3B8"
          value={search}
          onChangeText={setSearch}
        />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {(['ALL', 'ACTIVE', 'UPCOMING', 'COMPLETED', 'CLOSED'] as const).map((st) => (
            <TouchableOpacity
              key={st}
              style={[
                {
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 20,
                  backgroundColor: statusFilter === st ? '#0A2540' : '#E2E8F0',
                },
              ]}
              onPress={() => setStatusFilter(st)}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '700',
                  color: statusFilter === st ? '#FFF' : '#475569',
                }}
              >
                {st}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Group Cards */}
      {loading ? (
        <ActivityIndicator size="large" color="#0070BA" style={{ marginVertical: 40 }} />
      ) : filtered.length === 0 ? (
        <View style={[mStyles.card, { alignItems: 'center', paddingVertical: 40 }]}>
          <Text style={{ color: '#64748B', fontSize: 15 }}>
            {isStaff
              ? 'No chit groups are currently assigned to you. Your manager will assign chit groups to your account.'
              : 'No chit groups found matching your criteria.'}
          </Text>
        </View>
      ) : (
        filtered.map((grp) => {
          const enrolledCount = grp.members?.length ?? grp.memberships?.length ?? grp._count?.members ?? 0;
          const isFull = enrolledCount >= (grp.maxMembers || 20);
          const poolValue = grp.chitValue ?? grp.totalChitValue ?? 0;
          const monthly = grp.monthlyInstallment ?? Math.round(poolValue / (grp.totalMonths || 20));
          const duration = grp.totalMonths ?? grp.durationMonths ?? 20;

          return (
            <View key={grp.id} style={mStyles.card}>
              <View style={mStyles.cardRow}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={mStyles.cardTitle}>{grp.name}</Text>
                    <Text style={{ color: '#0284C7', fontWeight: '700', fontSize: 13 }}>
                      [{grp.groupCode}]
                    </Text>
                    {isGroupAssignedToUser(grp) && (
                      <View style={{ backgroundColor: '#DCFCE7', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#86EFAC' }}>
                        <Text style={{ fontSize: 11, color: '#166534', fontWeight: '800' }}>⭐ Assigned to You ({enrolledCount} Enrolled)</Text>
                      </View>
                    )}
                    <View
                      style={[
                        mStyles.badge,
                        grp.status === 'ACTIVE'
                          ? mStyles.badgeSuccess
                          : grp.status === 'COMPLETED'
                          ? mStyles.badgeInfo
                          : mStyles.badgeNeutral,
                      ]}
                    >
                      <Text
                        style={[
                          mStyles.badgeText,
                          grp.status === 'ACTIVE'
                            ? mStyles.badgeSuccessText
                            : grp.status === 'COMPLETED'
                            ? mStyles.badgeInfoText
                            : mStyles.badgeNeutralText,
                        ]}
                      >
                        {grp.status}
                      </Text>
                    </View>
                  </View>

                  <Text style={mStyles.cardSubtitle}>
                    Chit Value: ₹{poolValue.toLocaleString()} • Monthly: ₹{monthly.toLocaleString()} • Duration: {duration} Months
                  </Text>
                  <Text style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
                    {isManagerOrAdmin ? (
                      <>👥 Enrolled: {enrolledCount} / {grp.maxMembers} Members {isFull ? '(FULL CAPACITY)' : ''} • </>
                    ) : null}
                    🔒 Commencement Date: <Text style={{ fontWeight: '700', color: '#0F172A' }}>{formatCommencementDate(grp.startDate)}</Text> (Actual Date) • Commission: {grp.foremanCommissionPct ?? grp.foremanCommissionRate ?? 5}%
                  </Text>
                  {grp.createdAt ? (
                    <Text style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>
                      🕒 Registered Timestamp: <Text style={{ fontWeight: '600', color: '#334155' }}>{formatActualTimestamp(grp.createdAt)}</Text>
                    </Text>
                  ) : null}

                  {/* Assigned Collection Staff Display (Single Staff In-Charge) */}
                  {(() => {
                    const assigned =
                      grp.assignedStaff ||
                      grp.staffAssignments?.[0]?.staff ||
                      null;

                    return (
                      <View style={{ marginTop: 8, padding: 8, backgroundColor: '#F0F9FF', borderRadius: 8, borderWidth: 1, borderColor: '#BAE6FD' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#0369A1' }}>
                            🏃 Assigned Staff (In-Charge):
                          </Text>
                          {isManagerOrAdmin && (
                            <TouchableOpacity
                              onPress={() => handleOpenAssignStaff(grp)}
                              style={{ backgroundColor: '#0284C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 }}
                            >
                              <Text style={{ fontSize: 11, color: '#FFF', fontWeight: '700' }}>
                                {assigned ? '🔄 Change Staff' : '👥 Assign Staff'}
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                        {!assigned ? (
                          <Text style={{ fontSize: 11, color: '#94A3B8', fontStyle: 'italic' }}>
                            ⚠️ No staff currently assigned. Click "👥 Assign Staff" to assign.
                          </Text>
                        ) : (
                          <View style={{ backgroundColor: '#E0F2FE', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#0369A1' }}>
                              👤 {assigned.fullName || assigned.username} (@{assigned.username})
                            </Text>
                          </View>
                        )}
                      </View>
                    );
                  })()}
                </View>
              </View>

              {/* Action Buttons: Enroll (Staff & Manager), Schedule (Both), Manager Only (Assign Staff, Edit, Delete) */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                {(!isStaff || isGroupAssignedToUser(grp)) && (
                  <TouchableOpacity
                    style={[mStyles.primaryBtn, { paddingVertical: 8, paddingHorizontal: 12 }, isFull && { opacity: 0.5 }]}
                    disabled={isFull}
                    onPress={() => {
                      setSelectedGroup(grp);
                      setTicketNo(String(enrolledCount + 1));
                      setIsQuickRegistering(isStaff ? true : false);
                      setMemberSearchQuery('');
                      setShowEnrollModal(true);
                    }}
                  >
                    <Text style={mStyles.primaryBtnText}>👤 Enroll Member</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[mStyles.secondaryBtn, { paddingVertical: 8, paddingHorizontal: 12, borderColor: '#0284C7', backgroundColor: '#F0F9FF' }]}
                  onPress={() => handleOpenViewMembers(grp)}
                >
                  <Text style={[mStyles.secondaryBtnText, { color: '#0369A1', fontWeight: '700' }]}>
                    👥 {isStaff ? 'Assigned Members' : 'View Members'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[mStyles.secondaryBtn, { paddingVertical: 8, paddingHorizontal: 12 }]}
                  onPress={() => handleOpenSchedule(grp)}
                >
                  <Text style={mStyles.secondaryBtnText}>📅 Schedules</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[mStyles.secondaryBtn, { paddingVertical: 8, paddingHorizontal: 12 }]}
                  onPress={() => setSettingsGroup(grp)}
                  accessibilityLabel={`Financial settings for ${grp.name}`}
                >
                  <Text style={mStyles.secondaryBtnText}>⚙️ Financial Settings</Text>
                </TouchableOpacity>

                {isManagerOrAdmin && (
                  <>
                    <TouchableOpacity
                      style={[mStyles.secondaryBtn, { paddingVertical: 8, paddingHorizontal: 12, borderColor: '#0284C7', backgroundColor: '#F0F9FF' }]}
                      onPress={() => handleOpenAssignStaff(grp)}
                    >
                      <Text style={[mStyles.secondaryBtnText, { color: '#0369A1', fontWeight: '700' }]}>👥 Assign Staff</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[mStyles.secondaryBtn, { paddingVertical: 8, paddingHorizontal: 12, borderColor: '#0284C7', backgroundColor: '#F0F9FF' }]}
                      onPress={() => handleOpenEdit(grp)}
                    >
                      <Text style={[mStyles.secondaryBtnText, { color: '#0369A1', fontWeight: '700' }]}>✏️ Edit Group</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[mStyles.dangerBtn, { paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#FEF2F2', borderColor: '#F87171', borderWidth: 1 }]}
                      onPress={() => handleOpenDelete(grp)}
                    >
                      <Text style={{ color: '#DC2626', fontWeight: '700', fontSize: 13 }}>🗑️ Delete</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          );
        })
      )}

      <FinancialSettingsModal group={settingsGroup} visible={!!settingsGroup} onClose={() => setSettingsGroup(null)} canSeeHistory={isManagerOrAdmin} />

      {/* --- MODAL 1: CREATE CHIT GROUP --- */}
      <Modal visible={showCreateModal} transparent animationType="fade" onRequestClose={() => setShowCreateModal(false)}>
        <View style={mStyles.modalBackdrop}>
          <View style={mStyles.modalBox}>
            <View style={mStyles.modalHeader}>
              <Text style={mStyles.modalTitle}>➕ Create New Chit Group</Text>
              <TouchableOpacity onPress={() => setShowCreateModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 520 }}>
              <Text style={mStyles.label}>Group Scheme Name *</Text>
              <TextInput
                style={mStyles.input}
                placeholder="e.g. Gold Chit Scheme - Batch A"
                value={groupName}
                onChangeText={setGroupName}
              />


              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Monthly Installment (₹) *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    placeholder="5000"
                    value={monthlyInstallment}
                    onChangeText={setMonthlyInstallment}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Duration (Months) *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    placeholder="20"
                    value={durationMonths}
                    onChangeText={updateCreateDuration}
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Member Capacity *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    placeholder="20"
                    value={maxMembers}
                    onChangeText={setMaxMembers}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Foreman Commission (%) *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    placeholder="5"
                    value={foremanCommissionRate}
                    onChangeText={setForemanCommissionRate}
                  />
                </View>
              </View>

              <View style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={mStyles.label}>Commencement Date (YYYY-MM-DD) *</Text>
                  <TouchableOpacity onPress={() => setStartDate(actualToday)}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#0284C7' }}>⚡ Use Today ({formatCommencementDate(actualToday)})</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={[mStyles.input, { fontWeight: '700', color: '#0F172A' }]}
                  placeholder="YYYY-MM-DD e.g. 2026-10-15"
                  value={startDate}
                  onChangeText={setStartDate}
                />
                <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                  Formatted: {formatCommencementDate(startDate || actualToday)} (Actual scheme start date)
                </Text>
              </View>

              {/* Staff Assignment on Create */}
              <View style={{ marginBottom: 14 }}>
                <Text style={mStyles.label}>Assign Staff / Manager to this Chit Group</Text>
                <Text style={{ fontSize: 11, color: '#64748B', marginBottom: 6 }}>
                  Select a staff member or yourself (in-charge). Only one staff can be assigned per chit group. (A staff member can manage multiple chit groups).
                </Text>
                {staffMembers.length === 0 ? (
                  <Text style={{ fontSize: 12, color: '#94A3B8', fontStyle: 'italic' }}>No staff members available. You can assign staff later.</Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {staffMembers.map((stf) => {
                      const isSelected = createStaffId === stf.id;
                      const isSelf = stf.id === user?.id;
                      return (
                        <TouchableOpacity
                          key={stf.id}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: isSelected ? '#0284C7' : '#CBD5E1',
                            backgroundColor: isSelected ? '#E0F2FE' : '#FFF',
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 4,
                          }}
                          onPress={() => {
                            setCreateStaffId((prev) => (prev === stf.id ? null : stf.id));
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '700', color: isSelected ? '#0369A1' : '#475569' }}>
                            {isSelected ? '✓ ' : '+ '} {isSelf ? `👑 ${stf.fullName || stf.username} (You - Manager)` : `${stf.fullName || stf.username} (@${stf.username})`}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>

              {/* Auto-calculated pool value summary card */}
              <View
                style={{
                  backgroundColor: '#F0F9FF',
                  borderColor: '#BAE6FD',
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 14,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <Text style={{ fontSize: 11, color: '#0369A1', fontWeight: '700', textTransform: 'uppercase' }}>
                      Calculated Total Scheme Value
                    </Text>
                    <Text style={{ fontSize: 18, color: '#0284C7', fontWeight: '800', marginTop: 2 }}>
                      ₹{((Number(monthlyInstallment) || 0) * (Number(durationMonths) || 0)).toLocaleString()}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 12, color: '#64748B' }}>
                    ₹{Number(monthlyInstallment || 0).toLocaleString()} × {durationMonths || 0} mos
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowCreateModal(false)}>
                  <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[mStyles.primaryBtn, submitting && { opacity: 0.7 }]}
                  disabled={submitting}
                  onPress={handleCreateGroup}
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Text style={mStyles.primaryBtnText}>✓ Create & Launch Group</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* --- MODAL 2: EDIT CHIT GROUP --- */}
      <Modal visible={showEditModal} transparent animationType="fade" onRequestClose={() => setShowEditModal(false)}>
        <View style={mStyles.modalBackdrop}>
          <View style={mStyles.modalBox}>
            <View style={mStyles.modalHeader}>
              <Text style={mStyles.modalTitle}>✏️ Edit Chit Group Configuration</Text>
              <TouchableOpacity onPress={() => setShowEditModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 520 }}>
              <Text style={mStyles.label}>Group Scheme Name *</Text>
              <TextInput
                style={mStyles.input}
                placeholder="Scheme Name"
                value={editGroupName}
                onChangeText={setEditGroupName}
              />

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Total Chit Value (₹) *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    value={editChitValue}
                    onChangeText={updateEditChitValue}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Duration (Months) *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    value={editDurationMonths}
                    onChangeText={updateEditDuration}
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Monthly Installment (₹) *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    value={editMonthlyInstallment}
                    onChangeText={setEditMonthlyInstallment}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Member Capacity *</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    value={editMaxMembers}
                    onChangeText={setEditMaxMembers}
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={mStyles.label}>Foreman Commission (%)</Text>
                  <TextInput
                    style={mStyles.input}
                    keyboardType="numeric"
                    value={editForemanCommissionRate}
                    onChangeText={setEditForemanCommissionRate}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={mStyles.label}>Commencement Date (YYYY-MM-DD)</Text>
                  </View>
                  <TextInput
                    style={[mStyles.input, { fontWeight: '700', color: '#0F172A' }]}
                    placeholder="YYYY-MM-DD"
                    value={editStartDate}
                    onChangeText={setEditStartDate}
                  />
                  <Text style={{ fontSize: 10, color: '#64748B', marginTop: -6 }}>
                    Actual: {formatCommencementDate(editStartDate || actualToday)}
                  </Text>
                </View>
              </View>

              {/* Staff Assignment on Edit */}
              <View style={{ marginBottom: 14 }}>
                <Text style={mStyles.label}>Assigned Staff / Manager Member</Text>
                <Text style={{ fontSize: 11, color: '#64748B', marginBottom: 6 }}>
                  Select the staff member or yourself to handle this group. Only one staff can be assigned per chit group.
                </Text>
                {staffMembers.length === 0 ? (
                  <Text style={{ fontSize: 12, color: '#94A3B8', fontStyle: 'italic' }}>No staff members available.</Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {staffMembers.map((stf) => {
                      const isSelected = editStaffId === stf.id;
                      const isSelf = stf.id === user?.id;
                      return (
                        <TouchableOpacity
                          key={stf.id}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: isSelected ? '#0284C7' : '#CBD5E1',
                            backgroundColor: isSelected ? '#E0F2FE' : '#FFF',
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 4,
                          }}
                          onPress={() => {
                            setEditStaffId((prev) => (prev === stf.id ? null : stf.id));
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '700', color: isSelected ? '#0369A1' : '#475569' }}>
                            {isSelected ? '✓ ' : '+ '} {isSelf ? `👑 ${stf.fullName || stf.username} (You - Manager)` : `${stf.fullName || stf.username} (@${stf.username})`}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>

              <Text style={mStyles.label}>Group Status *</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                {(['ACTIVE', 'UPCOMING', 'COMPLETED', 'CLOSED'] as const).map((st) => (
                  <TouchableOpacity
                    key={st}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: editStatus === st ? '#0284C7' : '#CBD5E1',
                      backgroundColor: editStatus === st ? '#E0F2FE' : '#FFF',
                    }}
                    onPress={() => setEditStatus(st)}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: editStatus === st ? '#0369A1' : '#475569' }}>
                      {st}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowEditModal(false)}>
                  <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[mStyles.primaryBtn, submitting && { opacity: 0.7 }]}
                  disabled={submitting}
                  onPress={handleUpdateGroup}
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Text style={mStyles.primaryBtnText}>✓ Save Changes</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* --- MODAL 3: DELETE CHIT GROUP CONFIRMATION --- */}
      <Modal visible={showDeleteModal} transparent animationType="fade" onRequestClose={() => setShowDeleteModal(false)}>
        <View style={mStyles.modalBackdrop}>
          <View style={[mStyles.modalBox, { maxWidth: 480 }]}>
            <View style={mStyles.modalHeader}>
              <Text style={[mStyles.modalTitle, { color: '#DC2626' }]}>🗑️ Delete Chit Group</Text>
              <TouchableOpacity onPress={() => setShowDeleteModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {groupToDelete && (
              <View style={{ paddingVertical: 8 }}>
                <Text style={{ fontSize: 14, color: '#1E293B', marginBottom: 10, lineHeight: 20 }}>
                  Are you sure you want to delete the chit group{' '}
                  <Text style={{ fontWeight: '800' }}>"{groupToDelete.name}"</Text> (
                  <Text style={{ color: '#0284C7', fontWeight: '700' }}>{groupToDelete.groupCode}</Text>)?
                </Text>
                <View style={{ backgroundColor: '#FEF2F2', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#FCA5A5', marginBottom: 16 }}>
                  <Text style={{ fontSize: 12, color: '#B91C1C', lineHeight: 18 }}>
                    ⚠️ Note: Groups with recorded financial transactions or auctions cannot be deleted to preserve audit compliance.
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
                  <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowDeleteModal(false)}>
                    <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[mStyles.dangerBtn, submitting && { opacity: 0.7 }]}
                    disabled={submitting}
                    onPress={handleConfirmDelete}
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                      <Text style={mStyles.dangerBtnText}>Yes, Delete Group</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* --- MODAL 4: ENROLL MEMBER (AC-03) --- */}
      <Modal visible={showEnrollModal} transparent animationType="fade" onRequestClose={() => setShowEnrollModal(false)}>
        <View style={mStyles.modalBackdrop}>
          <View style={mStyles.modalBox}>
            <View style={mStyles.modalHeader}>
              <Text style={mStyles.modalTitle}>👤 Enroll Member into Chit Group (AC-03)</Text>
              <TouchableOpacity onPress={() => setShowEnrollModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {selectedGroup && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={{ backgroundColor: '#F8FAFC', padding: 12, borderRadius: 8, marginBottom: 14 }}>
                  <Text style={{ fontWeight: '700', fontSize: 14, color: '#0F172A' }}>
                    Group: {selectedGroup.name} ({selectedGroup.groupCode})
                  </Text>
                  <Text style={{ fontSize: 12, color: '#64748B' }}>
                    Chit Value: ₹{(selectedGroup.chitValue ?? selectedGroup.totalChitValue)?.toLocaleString()} • Monthly: ₹{(selectedGroup.monthlyInstallment)?.toLocaleString()}{isManagerOrAdmin ? ` • Enrolled: ${(selectedGroup.members?.length ?? selectedGroup.memberships?.length ?? 0)} / ${selectedGroup.maxMembers}` : ''}
                  </Text>
                </View>

                {/* Manager: Directly selects registered member (Register & Enroll removed in Manager Dashboard) */}
                {isManagerOrAdmin && (
                  <View style={{ marginBottom: 12, backgroundColor: '#F0FDF4', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#BBF7D0' }}>
                    <Text style={{ fontWeight: '700', fontSize: 13, color: '#15803D' }}>
                      👤 Select Registered Member to Enroll
                    </Text>
                    <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                      Pick an existing member from the registry. (Members can join multiple chit groups). To register brand new members globally, use the Members tab.
                    </Text>
                  </View>
                )}

                {/* Staff: Registers and assigns member directly into this chit group */}
                {isStaff && (
                  <View style={{ marginBottom: 12, backgroundColor: '#F0F9FF', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#BAE6FD' }}>
                    <Text style={{ fontWeight: '700', fontSize: 13, color: '#0369A1' }}>
                      ➕ Register & Enroll Member into {selectedGroup.name}
                    </Text>
                    <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                      Fill in the member particulars below to register and assign them to your group. (Members can join multiple chit groups).
                    </Text>
                  </View>
                )}

                {isManagerOrAdmin ? (
                  <>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <Text style={mStyles.label}>Select Registered Member *</Text>
                      <Text style={{ fontSize: 11, color: '#0284C7', fontStyle: 'italic' }}>
                        (Members can join multiple chit groups)
                      </Text>
                    </View>

                    {/* Quick Search for Registered Members */}
                    <TextInput
                      style={[mStyles.input, { marginBottom: 8, fontSize: 12, paddingVertical: 6 }]}
                      placeholder="🔍 Search member by name, code, or phone..."
                      placeholderTextColor="#94A3B8"
                      value={memberSearchQuery}
                      onChangeText={setMemberSearchQuery}
                    />

                    <View style={{ maxHeight: 220, marginBottom: 14 }}>
                      <ScrollView nestedScrollEnabled style={{ borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8 }}>
                        {subscribers
                          .filter((sub) => {
                            if (!memberSearchQuery.trim()) return true;
                            const q = memberSearchQuery.toLowerCase();
                            return (
                              sub.fullName?.toLowerCase().includes(q) ||
                              sub.subscriberCode?.toLowerCase().includes(q) ||
                              sub.phone?.includes(q)
                            );
                          })
                          .map((sub) => {
                            const isAlreadyEnrolled =
                              selectedGroup.members?.some((m: any) => m.subscriberId === sub.id) ||
                              selectedGroup.memberships?.some((m: any) => m.subscriberId === sub.id);
                            const isSelected = selectedSubscriberId === sub.id;

                            return (
                              <TouchableOpacity
                                key={sub.id}
                                disabled={isAlreadyEnrolled}
                                style={{
                                  padding: 10,
                                  borderBottomWidth: 1,
                                  borderBottomColor: '#F1F5F9',
                                  backgroundColor: isAlreadyEnrolled ? '#F8FAFC' : isSelected ? '#E0F2FE' : '#FFF',
                                  opacity: isAlreadyEnrolled ? 0.6 : 1,
                                }}
                                onPress={() => !isAlreadyEnrolled && setSelectedSubscriberId(sub.id)}
                              >
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <Text style={{ fontWeight: isSelected ? '700' : '500', fontSize: 13, color: isAlreadyEnrolled ? '#94A3B8' : '#0F172A' }}>
                                    {sub.fullName} [{sub.subscriberCode}]
                                  </Text>
                                  {isAlreadyEnrolled ? (
                                    <View style={{ backgroundColor: '#F1F5F9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                                      <Text style={{ fontSize: 10, color: '#64748B', fontWeight: '700' }}>ALREADY ENROLLED</Text>
                                    </View>
                                  ) : (
                                    <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '600' }}>
                                      {sub.memberships?.length ? `In ${sub.memberships.length} other group(s)` : 'Available'}
                                    </Text>
                                  )}
                                </View>
                                <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                                  📱 {sub.phone} {sub.address ? `• 📍 ${sub.address}` : ''}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                      </ScrollView>
                    </View>

                    <Text style={mStyles.label}>Assigned Ticket / Membership Number *</Text>
                    <TextInput
                      style={mStyles.input}
                      keyboardType="numeric"
                      placeholder="e.g. 1, 2, 3..."
                      value={ticketNo}
                      onChangeText={setTicketNo}
                    />

                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                      <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowEnrollModal(false)}>
                        <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[mStyles.primaryBtn, submitting && { opacity: 0.7 }]}
                        disabled={submitting}
                        onPress={handleEnrollMember}
                      >
                        {submitting ? (
                          <ActivityIndicator size="small" color="#FFF" />
                        ) : (
                          <Text style={mStyles.primaryBtnText}>✓ Confirm Enrollment</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    {quickError ? (
                      <View style={{ backgroundColor: '#FEF2F2', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#FCA5A5', marginBottom: 12 }}>
                        <Text style={{ fontSize: 12, color: '#B91C1C', fontWeight: '600' }}>⚠️ {quickError}</Text>
                      </View>
                    ) : null}

                    <Text style={mStyles.label}>Full Legal Name *</Text>
                    <TextInput
                      style={mStyles.input}
                      placeholder="e.g. Anand Verma"
                      value={quickFullName}
                      onChangeText={setQuickFullName}
                    />

                    <Text style={mStyles.label}>Mobile Phone Number *</Text>
                    <TextInput
                      style={mStyles.input}
                      keyboardType="phone-pad"
                      placeholder="10-digit mobile number"
                      value={quickPhone}
                      onChangeText={setQuickPhone}
                    />

                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={mStyles.label}>Aadhaar Card No</Text>
                        <TextInput
                          style={mStyles.input}
                          keyboardType="numeric"
                          placeholder="12-digit Aadhaar"
                          value={quickAadhaar}
                          onChangeText={setQuickAadhaar}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={mStyles.label}>PAN Card No</Text>
                        <TextInput
                          style={mStyles.input}
                          autoCapitalize="characters"
                          placeholder="10-char PAN"
                          value={quickPan}
                          onChangeText={(t) => setQuickPan(t.toUpperCase())}
                        />
                      </View>
                    </View>

                    <Text style={mStyles.label}>Residential Address</Text>
                    <TextInput
                      style={mStyles.input}
                      placeholder="House / Street, City, State, PIN"
                      value={quickAddress}
                      onChangeText={setQuickAddress}
                    />

                    <Text style={mStyles.label}>Assigned Ticket / Membership Number</Text>
                    <TextInput
                      style={mStyles.input}
                      keyboardType="numeric"
                      placeholder="e.g. 1, 2, 3..."
                      value={ticketNo}
                      onChangeText={setTicketNo}
                    />

                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                      <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowEnrollModal(false)}>
                        <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[mStyles.primaryBtn, quickRegistering && { opacity: 0.7 }]}
                        disabled={quickRegistering}
                        onPress={handleQuickRegisterAndEnroll}
                      >
                        {quickRegistering ? (
                          <ActivityIndicator size="small" color="#FFF" />
                        ) : (
                          <Text style={mStyles.primaryBtnText}>✓ Register & Enroll</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* --- MODAL 5: INSTALLMENT SCHEDULE (AC-07) --- */}
      <Modal visible={showScheduleModal} transparent animationType="fade" onRequestClose={() => setShowScheduleModal(false)}>
        <View style={mStyles.modalBackdrop}>
          <View style={[mStyles.modalBox, { maxWidth: 850 }]}>
            <View style={mStyles.modalHeader}>
              <Text style={mStyles.modalTitle}>📅 Installment Schedule & Member Roster (AC-07)</Text>
              <TouchableOpacity onPress={() => setShowScheduleModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {modalLoading ? (
              <ActivityIndicator size="large" color="#0070BA" style={{ marginVertical: 30 }} />
            ) : scheduleData ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={{ backgroundColor: '#F1F5F9', padding: 12, borderRadius: 8, marginBottom: 14 }}>
                  <Text style={{ fontWeight: '800', fontSize: 15, color: '#0F172A' }}>
                    {scheduleData.name} [{scheduleData.groupCode}]
                  </Text>
                  <Text style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                    Chit Value: ₹{(scheduleData.chitValue ?? scheduleData.totalChitValue)?.toLocaleString()} • Monthly Installment: ₹{(scheduleData.monthlyInstallment)?.toLocaleString()} • Duration: {scheduleData.totalMonths ?? scheduleData.durationMonths} Months
                  </Text>
                </View>

                <Text style={{ fontSize: 14, fontWeight: '700', marginBottom: 8, color: '#0F172A' }}>
                  Enrolled Members ({scheduleData.activeTickets ?? (scheduleData.members || scheduleData.memberships || []).filter((x: any) => (x.membershipStatus ?? x.status ?? 'ACTIVE') === 'ACTIVE').length} / {scheduleData.maxMembers})
                </Text>
                <View style={mStyles.table}>
                  <View style={mStyles.tableHeader}>
                    <Text style={[mStyles.tableHeaderCell, { width: 70 }]}>Ticket #</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 140 }]}>Member Name</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Code</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 110 }]}>Phone</Text>
                    <Text style={[mStyles.tableHeaderCell, { flex: 1 }]}>Prize Status</Text>
                  </View>
                  {(scheduleData.members || scheduleData.memberships)?.map((m: any) => (
                    <View key={m.id} style={mStyles.tableRow}>
                      <Text style={[mStyles.tableCell, { width: 70, fontWeight: '700', color: '#0284C7' }]}>
                        #{m.ticketNumber ?? m.ticketNo}
                      </Text>
                      <Text style={[mStyles.tableCell, { width: 140, fontWeight: '600' }]}>
                        {m.subscriber?.fullName}
                      </Text>
                      <Text style={[mStyles.tableCell, { width: 100, fontSize: 12 }]}>
                        {m.subscriber?.subscriberCode}
                      </Text>
                      <Text style={[mStyles.tableCell, { width: 110, fontSize: 12 }]}>
                        {m.subscriber?.phone}
                      </Text>
                      <Text style={[mStyles.tableCell, { flex: 1, fontSize: 12, color: (m.membershipStatus ?? 'ACTIVE') !== 'ACTIVE' ? '#B91C1C' : m.isPrized ? '#16A34A' : '#64748B' }]}>
                        {(m.membershipStatus ?? 'ACTIVE') !== 'ACTIVE'
                          ? `${m.membershipStatus}${m.exitedAt ? ` (${String(m.exitedAt).slice(0, 10)})` : ''}${m.isPrized ? ` • was PRIZED (Inst #${m.prizedInstallmentNo})` : ''}`
                          : m.isPrized
                          ? `PRIZED (Inst #${(m.prizedInstallmentNos || [m.prizedInstallmentNo]).join(', #')})`
                          : 'Non-prized (Active bidder)'}
                      </Text>
                    </View>
                  ))}
                </View>

                <Text style={{ fontSize: 14, fontWeight: '700', marginTop: 14, marginBottom: 8, color: '#0F172A' }}>
                  Completed & Upcoming Auctions
                </Text>
                <View style={mStyles.table}>
                  <View style={mStyles.tableHeader}>
                    <Text style={[mStyles.tableHeaderCell, { width: 60 }]}>Inst #</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Date</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Bid Discount</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Commission</Text>
                    <Text style={[mStyles.tableHeaderCell, { width: 100 }]}>Dividend / Mem</Text>
                    <Text style={[mStyles.tableHeaderCell, { flex: 1 }]}>Winner</Text>
                  </View>
                  {scheduleData.auctions?.map((a: any) => (
                    <View key={a.id} style={mStyles.tableRow}>
                      <Text style={[mStyles.tableCell, { width: 60, fontWeight: '700' }]}>#{a.installmentNo}</Text>
                      <Text style={[mStyles.tableCell, { width: 100, fontSize: 12 }]}>{a.auctionDate}</Text>
                      <Text style={[mStyles.tableCell, { width: 100, color: '#D97706' }]}>₹{a.winningBidDiscount?.toLocaleString()}</Text>
                      <Text style={[mStyles.tableCell, { width: 100, color: '#2563EB' }]}>₹{a.foremanCommission?.toLocaleString()}</Text>
                      <Text style={[mStyles.tableCell, { width: 100, color: '#16A34A', fontWeight: '700' }]}>₹{a.dividendPerSubscriber?.toLocaleString()}</Text>
                      <Text style={[mStyles.tableCell, { flex: 1, fontSize: 12 }]}>{a.winnerSubscriber?.fullName || a.winningSubscriber?.fullName || 'N/A'}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* --- MODAL 6: QUICK ASSIGN STAFF TO CHIT GROUP --- */}
      <Modal visible={showAssignModal} transparent animationType="fade" onRequestClose={() => setShowAssignModal(false)}>
        <View style={mStyles.modalBackdrop}>
          <View style={[mStyles.modalBox, { maxWidth: 540 }]}>
            <View style={mStyles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={mStyles.modalTitle}>👥 Assign Staff to Chit Group</Text>
              </View>
              <TouchableOpacity onPress={() => setShowAssignModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {assignGroup && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={{ backgroundColor: '#F0F9FF', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#BAE6FD', marginBottom: 14 }}>
                  <Text style={{ fontWeight: '800', fontSize: 15, color: '#0369A1' }}>
                    {assignGroup.name} [{assignGroup.groupCode}]
                  </Text>
                  <Text style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                    Chit Value: ₹{(assignGroup.chitValue ?? assignGroup.totalChitValue)?.toLocaleString()} • Commencement: {formatCommencementDate(assignGroup.startDate)} (Actual Date)
                  </Text>
                </View>

                <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A', marginBottom: 4 }}>
                  Select Staff / Manager Member ({modalStaffId ? '1' : '0'} Selected)
                </Text>
                <Text style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>
                  Multiple staff cannot be assigned to a single chit group (only 1 staff in-charge per group). Click on a staff name or yourself to select or change. A single staff member can manage multiple chit groups.
                </Text>

                {staffMembers.length === 0 ? (
                  <View style={{ padding: 16, backgroundColor: '#F8FAFC', borderRadius: 8, alignItems: 'center' }}>
                    <Text style={{ color: '#64748B', fontSize: 13 }}>No staff accounts registered yet. Create staff from the Staff tab first.</Text>
                  </View>
                ) : (
                  <View style={{ gap: 8, marginBottom: 18 }}>
                    {staffMembers.map((stf) => {
                      const isAssigned = modalStaffId === stf.id;
                      const isSelf = stf.id === user?.id;
                      const otherGroupsCount = groups.filter((g) => {
                        if (assignGroup && g.id === assignGroup.id) return false;
                        if (g.assignedStaffId === stf.id) return true;
                        if (g.staffAssignments && Array.isArray(g.staffAssignments)) {
                          return g.staffAssignments.some((sa: any) => sa.staffId === stf.id || sa.staff?.id === stf.id);
                        }
                        return false;
                      }).length;

                      return (
                        <TouchableOpacity
                          key={stf.id}
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            borderWidth: 1.5,
                            borderColor: isAssigned ? '#0284C7' : '#E2E8F0',
                            backgroundColor: isAssigned ? '#F0F9FF' : '#FFF',
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                          onPress={() => {
                            setModalStaffId((prev) => (prev === stf.id ? null : stf.id));
                          }}
                        >
                          <View style={{ flex: 1, marginRight: 10 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <Text style={{ fontWeight: '700', fontSize: 14, color: isAssigned ? '#0369A1' : '#0F172A' }}>
                                {stf.fullName || stf.username}
                              </Text>
                              {isSelf && (
                                <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                                  <Text style={{ fontSize: 10, fontWeight: '800', color: '#B45309' }}>👑 YOU (MANAGER)</Text>
                                </View>
                              )}
                            </View>
                            <Text style={{ fontSize: 12, color: '#64748B' }}>
                              @{stf.username} • {stf.role?.replace('_', ' ')} • 📱 {stf.phone || '-'}
                            </Text>
                            {stf.address ? (
                              <Text style={{ fontSize: 11, color: '#475569', marginTop: 2 }} numberOfLines={1}>
                                🏠 {stf.address}
                              </Text>
                            ) : null}
                            <Text style={{ fontSize: 11, color: otherGroupsCount > 0 ? '#0284C7' : '#64748B', marginTop: 3, fontWeight: '600' }}>
                              ⚡ Assigned to {otherGroupsCount} other chit group(s)
                            </Text>
                          </View>
                          <View
                            style={{
                              paddingHorizontal: 12,
                              paddingVertical: 6,
                              borderRadius: 20,
                              backgroundColor: isAssigned ? '#0284C7' : '#F1F5F9',
                            }}
                          >
                            <Text style={{ fontSize: 12, fontWeight: '700', color: isAssigned ? '#FFF' : '#64748B' }}>
                              {isAssigned ? '✓ Selected' : '+ Select'}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
                  <TouchableOpacity style={mStyles.secondaryBtn} onPress={() => setShowAssignModal(false)}>
                    <Text style={mStyles.secondaryBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[mStyles.primaryBtn, assigning && { opacity: 0.7 }]}
                    disabled={assigning}
                    onPress={handleSaveAssignStaff}
                  >
                    {assigning ? (
                      <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                      <Text style={mStyles.primaryBtnText}>✓ Save Assignments</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* --- MODAL 7: VIEW GROUP MEMBERS (Assigned to Staff / Enrolled) --- */}
      <Modal
        visible={showViewMembersModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowViewMembersModal(false)}
      >
        <View style={mStyles.modalBackdrop}>
          <View style={[mStyles.modalBox, { maxWidth: 650, maxHeight: '85%' }]}>
            <View style={mStyles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={mStyles.modalTitle}>
                  👥 {isStaff ? 'My Assigned Group Members' : 'Enrolled Chit Members'}
                </Text>
                {selectedViewGroup && (
                  <Text style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                    Group: {selectedViewGroup.name} ({selectedViewGroup.groupCode}) • Scheme: ₹{(selectedViewGroup.chitValue ?? selectedViewGroup.totalChitValue)?.toLocaleString()}
                  </Text>
                )}
              </View>
              <TouchableOpacity onPress={() => setShowViewMembersModal(false)}>
                <Text style={mStyles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {selectedViewGroup && (
              <ScrollView showsVerticalScrollIndicator={false}>
                {isManagerOrAdmin && (
                  <View style={{ backgroundColor: '#F8FAFC', padding: 10, borderRadius: 8, marginBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#0F172A' }}>
                      Enrolled: {selectedViewGroup.members?.length || 0} / {selectedViewGroup.maxMembers} Members
                    </Text>
                    <Text style={{ fontSize: 11, color: '#64748B' }}>
                      Monthly Installment: ₹{(selectedViewGroup.monthlyInstallment)?.toLocaleString()}
                    </Text>
                  </View>
                )}

                {isStaff && (
                  <View style={{ backgroundColor: '#F0F9FF', padding: 10, borderRadius: 8, marginBottom: 12, borderWidth: 1, borderColor: '#BAE6FD' }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#0369A1' }}>
                      📋 Members assigned to you in this chit group:
                    </Text>
                    <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                      Monthly Installment: ₹{(selectedViewGroup.monthlyInstallment)?.toLocaleString()}
                    </Text>
                  </View>
                )}

                {(!selectedViewGroup.members || selectedViewGroup.members.length === 0) ? (
                  <View style={{ padding: 24, alignItems: 'center', backgroundColor: '#F8FAFC', borderRadius: 8, marginBottom: 14 }}>
                    <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '600' }}>
                      No members enrolled in this chit group yet.
                    </Text>
                  </View>
                ) : (
                  <View style={{ gap: 8, marginBottom: 14 }}>
                    {selectedViewGroup.members.map((m: any, idx: number) => {
                      const sub = m.subscriber || m;
                      const ticket = m.ticketNumber ?? m.ticketNo ?? (idx + 1);
                      return (
                        <View
                          key={m.id || idx}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: '#E2E8F0',
                            backgroundColor: '#FFF',
                          }}
                        >
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <View style={{ backgroundColor: '#0284C7', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 }}>
                                <Text style={{ color: '#FFF', fontSize: 11, fontWeight: '800' }}>
                                  Ticket #{ticket}
                                </Text>
                              </View>
                              <Text style={{ fontWeight: '700', fontSize: 14, color: '#0F172A' }}>
                                {sub.fullName}
                              </Text>
                              <Text style={{ fontSize: 11, color: '#64748B' }}>
                                [{sub.subscriberCode}]
                              </Text>
                            </View>
                            <View
                              style={{
                                paddingHorizontal: 6,
                                paddingVertical: 2,
                                borderRadius: 4,
                                backgroundColor: sub.kycStatus === 'VERIFIED' ? '#DCFCE7' : '#FEF3C7',
                              }}
                            >
                              <Text
                                style={{
                                  fontSize: 10,
                                  fontWeight: '700',
                                  color: sub.kycStatus === 'VERIFIED' ? '#166534' : '#B45309',
                                }}
                              >
                                {sub.kycStatus || 'VERIFIED'}
                              </Text>
                            </View>
                          </View>

                          <Text style={{ fontSize: 12, color: '#334155', marginTop: 2 }}>
                            📱 {sub.phone} {sub.email ? `• ✉️ ${sub.email}` : ''}
                          </Text>
                          {sub.address ? (
                            <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                              📍 {sub.address}
                            </Text>
                          ) : null}
                          {(sub.aadhaarNo || sub.panNo) ? (
                            <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                              {sub.aadhaarNo ? `Aadhaar: ${sub.aadhaarNo} ` : ''}
                              {sub.panNo ? `• PAN: ${sub.panNo}` : ''}
                            </Text>
                          ) : null}
                          {m.enrolledAt ? (
                            <Text style={{ fontSize: 10, color: '#94A3B8', marginTop: 4 }}>
                              Enrolled on: {new Date(m.enrolledAt).toLocaleDateString('en-IN')}
                            </Text>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                )}

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 }}>
                  <TouchableOpacity
                    style={mStyles.secondaryBtn}
                    onPress={() => setShowViewMembersModal(false)}
                  >
                    <Text style={mStyles.secondaryBtnText}>Close</Text>
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
