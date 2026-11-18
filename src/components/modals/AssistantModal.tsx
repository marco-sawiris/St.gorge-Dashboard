import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import {
  AssistantAction,
  AssistantMessage,
  prepareVerifiedAssistantAttendanceBatch,
  processAssistantQuery
} from '../../services/assistantEngine';
import {
  AssistantSession,
  createFreshAssistantSession,
  getStoredAssistantSessions,
  saveAssistantSession,
  deleteAssistantSession,
  isExplicitHistoryRequest
} from '../../services/assistantSessionService';
import { idbGetPendingMutations } from '../../services/indexedDbService';
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Cake,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  History,
  MessageSquare,
  PhoneCall,
  PhoneOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  UserCheck,
  UserX,
  X,
  XCircle
} from 'lucide-react';
import { generateUUID } from '../../utils/uuid';
import { formatWhatsAppUrl, getLatestHeldFridayString } from '../../utils/arabicUtils';

interface QuickPromptItem {
  id: string;
  label: string;
  query: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}

const QUICK_PROMPTS: QuickPromptItem[] = [
  { id: 'unrecorded', label: 'غير المسجلين', query: 'مين اللي لم يسجل بعد؟', icon: UserX, accent: 'text-[var(--warning-text)]' },
  { id: 'present', label: 'الحاضرون', query: 'مين اللي حضر؟', icon: UserCheck, accent: 'text-[var(--success-text)]' },
  { id: 'absent', label: 'الغائبون', query: 'مين الغايب؟', icon: AlertTriangle, accent: 'text-[var(--danger-text)]' },
  { id: 'no_reply', label: 'لم يتم التواصل', query: 'مين محدش رد عليه؟', icon: PhoneOff, accent: 'text-orange-700 dark:text-orange-300' },
  { id: 'followup_missing', label: 'باقي الافتقاد', query: 'مين نسيت افتقدهم الأسبوع ده؟', icon: PhoneCall, accent: 'text-[var(--info-text)]' },
  { id: 'summary', label: 'ملخص الخدمة', query: 'اعرض ملخص الخدمة', icon: BarChart3, accent: 'text-[var(--accent-primary)]' },
  { id: 'birthdays', label: 'أعياد الميلاد', query: 'أعياد الميلاد', icon: Cake, accent: 'text-pink-700 dark:text-pink-300' },
  { id: 'history', label: 'سجل المحادثات', query: 'سجل المحادثات', icon: History, accent: 'text-indigo-700 dark:text-indigo-300' }
];

interface DraftConfirmationState {
  msgId: string;
  targetFriday: string;
  title: string;
  selections: Array<{ studentId: string; studentName: string; studentCode: string; isPresent: boolean }>;
  skippedAlreadyRecorded: Array<{ studentId: string; studentName: string; existingPresent: boolean; reason: string }>;
  skippedAlreadyQueued: Array<{ studentId: string; studentName: string; reason: string }>;
}

function getActionIcon(action: AssistantAction): React.ComponentType<{ className?: string }> {
  const txt = `${action.label} ${action.payload}`;
  if (action.type === 'sync') return RefreshCw;
  if (action.variant === 'present' || txt.includes('تأكيد') || txt.includes('حاضر')) return CheckCircle2;
  if (action.variant === 'absent' || txt.includes('غائب') || txt.includes('غياب')) return AlertTriangle;
  if (action.variant === 'danger' || txt.includes('إلغاء')) return XCircle;
  if (txt.includes('غير المسجلين') || txt.includes('لم يسجل')) return UserX;
  if (txt.includes('افتقاد') || txt.includes('تواصل')) return PhoneCall;
  if (txt.includes('ميلاد') || txt.includes('تهنئة')) return Cake;
  if (txt.includes('محادثة جديدة')) return RotateCcw;
  if (txt.includes('كشف') || txt.includes('إحصائي') || txt.includes('ملخص') || txt.includes('فصول')) return BarChart3;
  return Sparkles;
}

function getActionButtonClasses(action: AssistantAction): string {
  switch (action.variant) {
    case 'present':
      return 'bg-[var(--success-bg)] hover:opacity-95 border-[var(--success-border)] text-[var(--success-text)]';
    case 'absent':
      return 'bg-[var(--warning-bg)] hover:opacity-95 border-[var(--warning-border)] text-[var(--warning-text)]';
    case 'danger':
      return 'bg-[var(--danger-bg)] hover:opacity-95 border-[var(--danger-border)] text-[var(--danger-text)]';
    case 'primary':
      return 'bg-[var(--info-bg)] hover:opacity-95 border-[var(--info-border)] text-[var(--info-text)]';
    default:
      return 'bg-[var(--surface-secondary)] hover:border-[var(--info-border)] border-[var(--border-color)] text-[var(--text-primary)]';
  }
}

export const AssistantModal: React.FC = () => {
  const {
    isAssistantOpen,
    setIsAssistantOpen,
    students,
    followupRecords,
    filters,
    lastSuccessfulSyncTime,
    lastSyncError,
    syncData,
    isSyncing,
    isOnline,
    pendingMutationsCount,
    importAttendanceBatch,
    recordFollowup,
    processOfflineQueue,
    requestEditStudent,
    setFilters,
    setActiveView,
    addNotification
  } = useApp();
  const { user, canPerformAction } = useAuth();

  // Fresh session state - each session has its own unique ID and isolated messages
  const [session, setSession] = useState<AssistantSession>(() => createFreshAssistantSession());
  const [messages, setMessages] = useState<AssistantMessage[]>(() => session.messages);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showQuickPrompts, setShowQuickPrompts] = useState(true);

  // Interactive per-message individual/multi-select draft state (zero writes until confirmed)
  const [expandedIndividualMsgs, setExpandedIndividualMsgs] = useState<Record<string, boolean>>({});
  const [selectedIdsByMsg, setSelectedIdsByMsg] = useState<Record<string, Record<string, boolean>>>({});
  const [draftStatusByMsg, setDraftStatusByMsg] = useState<Record<string, Record<string, boolean>>>({});
  const [pendingDraftConfirm, setPendingDraftConfirm] = useState<DraftConfirmationState | null>(null);
  const [isExecutingAttendance, setIsExecutingAttendance] = useState(false);

  // History Drawer state
  const [showHistory, setShowHistory] = useState(false);
  const [storedSessions, setStoredSessions] = useState<AssistantSession[]>([]);
  const [viewingPastSessionId, setViewingPastSessionId] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const prevOpenRef = useRef<boolean>(false);
  const currentSessionRef = useRef<AssistantSession>(session);
  const messagesRef = useRef<AssistantMessage[]>(messages);
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    currentSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (isAssistantOpen) {
      if (!prevOpenRef.current) {
        const fresh = createFreshAssistantSession();
        setSession(fresh);
        currentSessionRef.current = fresh;
        setMessages(fresh.messages);
        messagesRef.current = fresh.messages;
        setInput('');
        setIsTyping(false);
        setShowHistory(false);
        setViewingPastSessionId(null);
        setExpandedIndividualMsgs({});
        setSelectedIdsByMsg({});
        setDraftStatusByMsg({});
        setPendingDraftConfirm(null);
        setStoredSessions(getStoredAssistantSessions());
      }
    } else {
      if (prevOpenRef.current) {
        if (
          viewingPastSessionId === null &&
          currentSessionRef.current &&
          messagesRef.current.some((m) => m.role === 'user')
        ) {
          saveAssistantSession({
            ...currentSessionRef.current,
            messages: messagesRef.current,
            updatedAt: Date.now()
          });
        }
        setShowHistory(false);
        setViewingPastSessionId(null);
      }
    }
    prevOpenRef.current = isAssistantOpen;
  }, [isAssistantOpen, viewingPastSessionId]);

  useEffect(() => {
    if (isAssistantOpen && !showHistory) {
      const scrollTimer = setTimeout(() => {
        listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
      return () => clearTimeout(scrollTimer);
    }
  }, [isAssistantOpen, messages, isTyping, showHistory, pendingDraftConfirm]);

  if (!isAssistantOpen) return null;

  const appendBotResultMessage = (text: string, baseMsgs?: AssistantMessage[]) => {
    const activeSession = currentSessionRef.current;
    const base = baseMsgs || messagesRef.current;
    const resultMsg: AssistantMessage = {
      id: generateUUID(),
      role: 'bot',
      text,
      timestamp: Date.now()
    };
    const nextMessages = [...base, resultMsg];
    setMessages(nextMessages);
    messagesRef.current = nextMessages;
    const saved = {
      ...activeSession,
      messages: nextMessages,
      updatedAt: Date.now()
    };
    setSession(saved);
    currentSessionRef.current = saved;
    saveAssistantSession(saved);
    setStoredSessions(getStoredAssistantSessions());
  };

  /**
   * Shared verified batch attendance executor:
   * - Re-checks live students + IndexedDB pending queue using Student ID + Friday Date
   * - Excludes anyone already recorded or already queued
   * - Writes atomically through importAttendanceBatch (IndexedDB + Offline Queue + Relay Key)
   * - Reports clear success & skipped/failure breakdown with reasons
   */
  const executeVerifiedAttendanceEntries = async (
    requestedSelections: Array<{ studentId: string; isPresent: boolean }>,
    targetFridayDate: string,
    opTag: string
  ): Promise<string> => {
    const existingPending = await idbGetPendingMutations().catch(() => []);
    const verification = prepareVerifiedAssistantAttendanceBatch(
      requestedSelections,
      students,
      targetFridayDate,
      existingPending,
      canPerformAction
    );

    const skippedReasons: string[] = [];
    if (verification.skippedAlreadyRecorded.length > 0) {
      skippedReasons.push(
        `• مسجل بالفعل في قاعدة البيانات (${verification.skippedAlreadyRecorded.length}): ${verification.skippedAlreadyRecorded
          .map((s) => `${s.studentName} [${s.existingPresent ? 'حاضر' : 'غائب'}]`)
          .join('، ')}`
      );
    }
    if (verification.skippedAlreadyQueued.length > 0) {
      skippedReasons.push(
        `• موجود بالفعل في طابور المزامنة (${verification.skippedAlreadyQueued.length}): ${verification.skippedAlreadyQueued
          .map((s) => s.studentName)
          .join('، ')}`
      );
    }
    if (verification.blockedUnauthorized.length > 0) {
      skippedReasons.push(
        `• غير مصرح بتعديل سجلاتهم (${verification.blockedUnauthorized.length}): ${verification.blockedUnauthorized
          .map((s) => `${s.studentName} (${s.reason})`)
          .join('، ')}`
      );
    }
    if (verification.notFoundIds.length > 0) {
      skippedReasons.push(`• تعذر العثور على ${verification.notFoundIds.length} مخدوم في البيانات المحملة.`);
    }

    if (verification.validEntries.length === 0) {
      return [
        `ℹ️ لم يتم تسجيل أي سجل جديد لتاريخ ${targetFridayDate}؛ لا توجد سجلات ناقصة قابلة للتسجيل.`,
        skippedReasons.length > 0 ? `\nتفاصيل الاستبعاد/التعذر:\n${skippedReasons.join('\n')}` : ''
      ]
        .filter(Boolean)
        .join('\n');
    }

    const batchResult = await importAttendanceBatch(
      verification.validEntries.map((e) => ({
        studentId: e.studentId,
        fridayDate: e.fridayDate,
        isPresent: e.isPresent
      })),
      { operationId: `AST_${targetFridayDate}_${opTag}` }
    );

    if (!batchResult.success) {
      return [
        `❌ تعذر تسجيل ${verification.validEntries.length} مخدوم عن ${targetFridayDate}: ${batchResult.error || 'فشل الحفظ المحلي في قاعدة البيانات'}.`,
        skippedReasons.length > 0 ? `\nملاحظات إضافية:\n${skippedReasons.join('\n')}` : ''
      ]
        .filter(Boolean)
        .join('\n');
    }

    const presentSaved = verification.validEntries.filter((e) => e.isPresent);
    const absentSaved = verification.validEntries.filter((e) => !e.isPresent);
    const summaryParts: string[] = [];
    if (presentSaved.length > 0) {
      summaryParts.push(`• حضور (${presentSaved.length}): ${presentSaved.map((e) => e.studentName).join('، ')}`);
    }
    if (absentSaved.length > 0) {
      summaryParts.push(`• غياب (${absentSaved.length}): ${absentSaved.map((e) => e.studentName).join('، ')}`);
    }

    let syncLine = '';
    if (!isOnline) {
      syncLine = '\n📡 الجهاز غير متصل بالإنترنت: تم الحفظ محلياً في IndexedDB وإدراج العمليات في طابور الإرسال للمزامنة عند عودة الاتصال.';
    } else if (batchResult.syncReport?.success && batchResult.syncReport.remainingCount === 0) {
      syncLine = '\n✅ تمت مزامنة جميع السجلات مع Google Sheets بنجاح (العمليات المعلقة: 0).';
    } else if (batchResult.syncReport) {
      syncLine = `\n⚠️ تم الحفظ في IndexedDB بنجاح، لكن لم تكتمل المزامنة مع Google Sheets (${batchResult.syncReport.lastError || 'العمليات محفوظة في طابور الإرسال'}) — متبقي بالطابور: ${batchResult.syncReport.remainingCount}.`;
    } else {
      syncLine = '\n⏳ تم الحفظ في IndexedDB وإدراج السجلات في طابور المزامنة مع Google Sheets.';
    }

    const failedOrSkippedNote =
      skippedReasons.length > 0
        ? `\n\n⚠️ مستبعد / تعذر تسجيله (${
            verification.skippedAlreadyRecorded.length +
            verification.skippedAlreadyQueued.length +
            verification.blockedUnauthorized.length +
            verification.notFoundIds.length
          }):\n${skippedReasons.join('\n')}`
        : '';

    return [
      `✅ تم تسجيل ${batchResult.appliedCount} مخدوم عن ${targetFridayDate} بنجاح:`,
      ...summaryParts,
      syncLine,
      failedOrSkippedNote
    ]
      .filter(Boolean)
      .join('\n');
  };

  /**
   * Opens a clean confirmation preview before writing ANY bulk or multi-select attendance.
   */
  const openDraftConfirmation = async (
    msgId: string,
    targetFriday: string,
    title: string,
    requestedSelections: Array<{ studentId: string; isPresent: boolean }>
  ) => {
    if (isExecutingAttendance) return;
    const existingPending = await idbGetPendingMutations().catch(() => []);
    const verification = prepareVerifiedAssistantAttendanceBatch(
      requestedSelections,
      students,
      targetFriday,
      existingPending,
      canPerformAction
    );

    setPendingDraftConfirm({
      msgId,
      targetFriday,
      title,
      selections: verification.validEntries.map((e) => ({
        studentId: e.studentId,
        studentName: e.studentName,
        studentCode: e.studentCode,
        isPresent: e.isPresent
      })),
      skippedAlreadyRecorded: verification.skippedAlreadyRecorded,
      skippedAlreadyQueued: verification.skippedAlreadyQueued
    });
  };

  const handleConfirmPendingDraft = async () => {
    if (!pendingDraftConfirm || isExecutingAttendance) return;
    setIsExecutingAttendance(true);
    const snapshot = pendingDraftConfirm;
    setPendingDraftConfirm(null);

    try {
      const outcomeText = await executeVerifiedAttendanceEntries(
        snapshot.selections.map((s) => ({ studentId: s.studentId, isPresent: s.isPresent })),
        snapshot.targetFriday,
        snapshot.selections.every((s) => s.isPresent)
          ? 'all_p'
          : snapshot.selections.every((s) => !s.isPresent)
            ? 'all_a'
            : 'mixed'
      );

      // Clear draft selections for executed students only
      setSelectedIdsByMsg((prev) => {
        const next = { ...prev };
        delete next[snapshot.msgId];
        return next;
      });
      setDraftStatusByMsg((prev) => {
        const next = { ...prev };
        delete next[snapshot.msgId];
        return next;
      });

      appendBotResultMessage(outcomeText);
    } finally {
      setIsExecutingAttendance(false);
    }
  };

  const handleStartNewSession = () => {
    if (
      viewingPastSessionId === null &&
      currentSessionRef.current &&
      messagesRef.current.some((m) => m.role === 'user')
    ) {
      saveAssistantSession({
        ...currentSessionRef.current,
        messages: messagesRef.current,
        updatedAt: Date.now()
      });
    }

    const fresh = createFreshAssistantSession();
    setSession(fresh);
    currentSessionRef.current = fresh;
    setMessages(fresh.messages);
    messagesRef.current = fresh.messages;
    setInput('');
    setIsTyping(false);
    setShowHistory(false);
    setViewingPastSessionId(null);
    setExpandedIndividualMsgs({});
    setSelectedIdsByMsg({});
    setDraftStatusByMsg({});
    setPendingDraftConfirm(null);
    setStoredSessions(getStoredAssistantSessions());
  };

  const handleCloseModal = () => {
    if (
      viewingPastSessionId === null &&
      currentSessionRef.current &&
      messagesRef.current.some((m) => m.role === 'user')
    ) {
      saveAssistantSession({
        ...currentSessionRef.current,
        messages: messagesRef.current,
        updatedAt: Date.now()
      });
    }
    setIsAssistantOpen(false);
  };

  const handleToggleHistory = () => {
    if (!showHistory) {
      setStoredSessions(getStoredAssistantSessions());
    }
    setShowHistory((prev) => !prev);
  };

  const handleSelectPastSession = (pastSession: AssistantSession) => {
    if (
      viewingPastSessionId === null &&
      currentSessionRef.current &&
      messagesRef.current.some((m) => m.role === 'user')
    ) {
      saveAssistantSession({
        ...currentSessionRef.current,
        messages: messagesRef.current,
        updatedAt: Date.now()
      });
    }

    setViewingPastSessionId(pastSession.id);
    setSession(pastSession);
    currentSessionRef.current = pastSession;
    setMessages(pastSession.messages);
    messagesRef.current = pastSession.messages;
    setShowHistory(false);
    setPendingDraftConfirm(null);
    setInput('');
  };

  const handleDeletePastSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteAssistantSession(sessionId);
    setStoredSessions(getStoredAssistantSessions());
    if (viewingPastSessionId === sessionId) {
      handleStartNewSession();
    }
  };

  const submitQuery = (rawQuery: string) => {
    const clean = rawQuery.trim();
    if (!clean) return;

    if (clean === 'محادثة جديدة' || clean === 'بدء محادثة جديدة' || clean === 'جلسة جديدة') {
      handleStartNewSession();
      return;
    }
    if (clean === 'سجل المحادثات' || clean === 'فتح سجل المحادثات') {
      handleToggleHistory();
      return;
    }

    let activeSession = currentSessionRef.current;
    let baseMessages = messagesRef.current;

    if (viewingPastSessionId !== null) {
      activeSession = createFreshAssistantSession();
      baseMessages = activeSession.messages;
      setViewingPastSessionId(null);
    }

    const userMsg: AssistantMessage = {
      id: generateUUID(),
      role: 'user',
      text: clean,
      timestamp: Date.now()
    };

    const updatedMessages = [...baseMessages, userMsg];
    setMessages(updatedMessages);
    messagesRef.current = updatedMessages;
    setInput('');
    setIsTyping(true);
    setPendingDraftConfirm(null);

    if (activeSession.title === 'محادثة جديدة') {
      activeSession.title = clean.length > 34 ? `${clean.slice(0, 32)}...` : clean;
    }
    setSession(activeSession);
    currentSessionRef.current = activeSession;

    if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
    submitTimerRef.current = setTimeout(() => {
      void (async () => {
        const explicitHistory = isExplicitHistoryRequest(clean);

        let response = processAssistantQuery(clean, students, {
          sessionId: activeSession.id,
          referenceDate: new Date(),
          selectedFridayDate: getLatestHeldFridayString(),
          classScope: filters.sheet !== '__ALL__' ? filters.sheet : undefined,
          lastSyncLabel: lastSuccessfulSyncTime,
          lastSyncError,
          isSyncing,
          isOnline,
          pendingMutationsCount,
          followupRecords,
          servantName: filters.servant || user?.assignedServantName || undefined,
          sessionMessages: updatedMessages,
          includePastHistory: explicitHistory,
          pastSessions: explicitHistory ? getStoredAssistantSessions() : undefined
        });

        // Single Attendance Command Handling (via explicit command with duplicate + queue protection)
        if (response.command?.type === 'markAttendance') {
          const command = response.command;
          const resultText = await executeVerifiedAttendanceEntries(
            [{ studentId: command.studentId, isPresent: command.isPresent }],
            command.targetFridayDate,
            command.isPresent ? 'single_p' : 'single_a'
          );
          response = { text: resultText, meta: response.meta };
        } else if (response.command?.type === 'markAttendanceBatch') {
          const command = response.command;
          const resultText = await executeVerifiedAttendanceEntries(
            command.entries.map((e) => ({ studentId: e.studentId, isPresent: e.isPresent })),
            command.targetFridayDate,
            command.isPresent ? 'batch_p' : 'batch_a'
          );
          response = { text: resultText, meta: response.meta };
        } else if (response.command?.type === 'recordFollowupBatch') {
          const command = response.command;
          const savedNames: string[] = [];
          const failedNames: string[] = [];
          for (const target of command.students) {
            const currentStudent = students.find((s) => s.id === target.id);
            if (!currentStudent) {
              failedNames.push(target.name + ' (غير موجود)');
              continue;
            }
            if (currentStudent.fu?.[command.weekFridayDate]) {
              failedNames.push(target.name + ' (مسجل بالفعل هذا الأسبوع)');
              continue;
            }
            try {
              const saved = await recordFollowup(target.id, command.method);
              if (saved) savedNames.push(target.name);
              else failedNames.push(target.name);
            } catch (error) {
              console.error('Assistant follow-up save failed for ' + target.name, error);
              failedNames.push(target.name);
            }
          }
          let syncSummary = '';
          if (savedNames.length && isOnline) {
            try {
              const syncResult = await processOfflineQueue();
              syncSummary = syncResult.success && syncResult.remainingCount === 0
                ? '\nتمت مزامنة كل العمليات بنجاح.'
                : '\nتم الحفظ محليًا، لكن توجد عمليات لم تكتمل مزامنتها: ' + syncResult.remainingCount + '. لا أؤكد تحديث Google Sheets بعد.';
            } catch (error) {
              console.error('Assistant follow-up batch sync failed:', error);
              syncSummary = '\nتم الحفظ محليًا، لكن تعذر تأكيد المزامنة.';
            }
          } else if (savedNames.length) {
            syncSummary = '\nالجهاز غير متصل؛ ستتم المزامنة عند عودة الإنترنت.';
          }
          response = {
            text:
              'نتيجة تسجيل الافتقاد (' +
              command.method +
              '):\nتم الحفظ: ' +
              savedNames.length +
              '\n' +
              (savedNames.length ? savedNames.map((name) => '• ' + name).join('\n') : 'لا توجد أسماء محفوظة.') +
              (failedNames.length ? '\n\nلم يتم الحفظ (' + failedNames.length + '):\n' + failedNames.map((name) => '• ' + name).join('\n') : '') +
              syncSummary
          };
        } else if (response.command?.type === 'openEdit') {
          const command = response.command;
          setActiveView('cards');
          const opened = requestEditStudent(command.studentId);
          if (opened) {
            setFilters((prev) => ({
              ...prev,
              searchQuery: command.studentName,
              sheet: '__ALL__',
              servant: '',
              area: '',
              alphabetLetter: null
            }));
            addNotification('تم فتح كارت المخدوم', `كارت ${command.studentName} جاهز للتعديل. احفظ التغييرات من الكارت.`, 'success');
            handleCloseModal();
          } else {
            response = {
              text: `لم أفتح كارت ${command.studentName} لأن هناك كارتًا آخر قيد التعديل أو تغييرات غير محفوظة. احفظ التعديل الحالي أو ألغِه أولاً.`
            };
          }
        }

        const botMsg: AssistantMessage = {
          id: generateUUID(),
          role: 'bot',
          text: response.text,
          copyText: response.copyText,
          whatsappText: response.whatsappText,
          whatsappPhone: response.whatsappPhone,
          actions: response.actions,
          command: response.command,
          meta: response.meta,
          timestamp: Date.now()
        };

        const finalMessages = [...updatedMessages, botMsg];
        setMessages(finalMessages);
        messagesRef.current = finalMessages;
        setIsTyping(false);

        const savedSession = {
          ...activeSession,
          messages: finalMessages,
          updatedAt: Date.now()
        };
        setSession(savedSession);
        currentSessionRef.current = savedSession;
        saveAssistantSession(savedSession);
        setStoredSessions(getStoredAssistantSessions());
      })();
    }, 120);
  };

  const handleCopy = async (id: string, textToCopy: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedId(id);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 2000);
    } catch {}
  };

  const toggleStudentSelected = (msgId: string, studentId: string) => {
    setSelectedIdsByMsg((prev) => {
      const currMsgMap = prev[msgId] || {};
      return {
        ...prev,
        [msgId]: { ...currMsgMap, [studentId]: !currMsgMap[studentId] }
      };
    });
  };

  const setStudentDraftStatus = (msgId: string, studentId: string, isPresent: boolean) => {
    setSelectedIdsByMsg((prev) => ({
      ...prev,
      [msgId]: { ...(prev[msgId] || {}), [studentId]: true }
    }));
    setDraftStatusByMsg((prev) => ({
      ...prev,
      [msgId]: { ...(prev[msgId] || {}), [studentId]: isPresent }
    }));
  };

  const applyStatusToSelectedInMsg = (msgId: string, studentIds: string[], isPresent: boolean) => {
    setDraftStatusByMsg((prev) => {
      const nextMap = { ...(prev[msgId] || {}) };
      for (const id of studentIds) {
        nextMap[id] = isPresent;
      }
      return { ...prev, [msgId]: nextMap };
    });
  };

  const studentsByIdMap = new Map(students.map((s) => [s.id, s]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none"
      role="dialog"
      aria-modal="true"
      aria-label="المساعد الذكي"
    >
      <div className="w-full max-w-2xl h-[min(92dvh,780px)] max-h-[92dvh] min-w-0 glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow-lg)] overflow-hidden flex flex-col animate-wordIn">
        {/* Header */}
        <div className="px-4 sm:px-5 py-3 border-b border-[var(--border-color)] flex items-center justify-between gap-2 bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="relative w-10 h-10 rounded-2xl bg-gradient-to-br from-[#123fce] via-[#267aff] to-[#0369a1] flex items-center justify-center text-white shadow-[0_0_16px_rgba(32,199,232,0.35)] shrink-0">
              <Bot className="w-5 h-5 shrink-0" />
              <span
                className="absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full bg-[#38BDF8] border-2 border-[var(--surface-primary)] shadow-[0_0_8px_#38BDF8]"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="font-extrabold text-sm sm:text-base text-[var(--text-primary)] m-0 truncate">
                  المساعد الذكي
                </h3>
                <Sparkles className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
              </div>
              <p className="text-[11px] text-[var(--text-muted)] m-0 truncate">
                {viewingPastSessionId
                  ? 'استعراض جلسة سابقة مؤرشفة'
                  : `جلسة مستقلة جديدة • ${students.length} مخدوم محمل`}
              </p>
            </div>
          </div>

          <div className="flex flex-row items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={handleToggleHistory}
              title={showHistory ? 'العودة للمحادثة' : 'سجل المحادثات السابقة'}
              className={`glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl flex items-center justify-center cursor-pointer transition-colors shrink-0 ${
                showHistory
                  ? 'text-[var(--info-text)] !bg-[var(--info-bg)] border border-[var(--info-border)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--accent-secondary)]'
              }`}
            >
              <History className="w-4 h-4 shrink-0" />
            </button>

            <button
              type="button"
              onClick={handleStartNewSession}
              title="بدء محادثة جديدة مستقلة"
              className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-muted)] hover:text-[var(--accent-secondary)] flex items-center justify-center cursor-pointer shrink-0"
            >
              <RotateCcw className="w-4 h-4 shrink-0" />
            </button>

            <button
              type="button"
              onClick={handleCloseModal}
              title="إغلاق"
              className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer shrink-0"
            >
              <X className="w-4 h-4 shrink-0" />
            </button>
          </div>
        </div>

        {/* Viewing Past Session Banner */}
        {viewingPastSessionId && !showHistory && (
          <div className="mx-3.5 mt-2.5 px-3.5 py-2 rounded-2xl bg-[var(--info-bg)] border border-[var(--info-border)] flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-primary)] shrink-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Clock className="w-4 h-4 text-[var(--info-text)] shrink-0" />
              <span className="truncate">
                أنت تستعرض محادثة سابقة: <strong>{session.title}</strong>
              </span>
            </div>
            <button
              type="button"
              onClick={handleStartNewSession}
              className="btn--lens min-h-[34px] px-2.5 py-1 rounded-xl bg-gradient-to-r from-[#123fce] to-[#1d4ed8] text-white text-[11px] font-bold shrink-0 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              <span>محادثة جديدة</span>
            </button>
          </div>
        )}

        {/* Content Area */}
        {showHistory ? (
          <div className="flex-1 overflow-y-auto p-3.5 sm:p-5 space-y-3 bg-[var(--app-bg)] animate-fadeIn">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[var(--border-color)]">
              <div className="flex items-center gap-2 min-w-0">
                <History className="w-4 h-4 text-[var(--info-text)] shrink-0" />
                <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                  سجل المحادثات السابقة ({storedSessions.length})
                </h4>
              </div>
              <button
                type="button"
                onClick={handleStartNewSession}
                className="glass-btn min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--info-text)] flex items-center gap-1.5 cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span>محادثة جديدة</span>
              </button>
            </div>

            {storedSessions.length === 0 ? (
              <div className="py-16 text-center text-[var(--text-muted)] space-y-2">
                <Clock className="w-10 h-10 mx-auto opacity-45 text-[var(--accent-secondary)]" />
                <p className="text-xs font-semibold m-0 text-[var(--text-primary)]">
                  لا توجد محادثات سابقة مؤرشفة حتى الآن.
                </p>
                <p className="text-[11px] text-[var(--text-muted)] m-0">
                  كل مرة تفتح المساعد تبدأ جلسة جديدة ومستقلة، وتُحفظ الجلسات تلقائياً في السجل عند احتوائها على أسئلة.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {storedSessions.map((s) => {
                  const userCount = s.messages.filter((m) => m.role === 'user').length;
                  const dateStr = new Date(s.updatedAt || s.createdAt).toLocaleDateString('ar-EG', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  });
                  const isSelected = viewingPastSessionId === s.id;

                  return (
                    <div
                      key={s.id}
                      onClick={() => handleSelectPastSession(s)}
                      className={`p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                        isSelected
                          ? 'bg-[var(--info-bg)] border-[var(--info-border)] shadow-xs'
                          : 'bg-[var(--surface-primary)] border-[var(--border-color)] hover:border-[var(--info-border)] hover:bg-[var(--surface-secondary)]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <MessageSquare className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                          <span className="font-bold text-xs sm:text-sm text-[var(--text-primary)] truncate">
                            {s.title}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                          <span>{dateStr}</span>
                          <span>•</span>
                          <span>{userCount} سؤال</span>
                          {isSelected && (
                            <span className="text-[var(--info-text)] font-bold">معروض حالياً</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => handleDeletePastSession(e, s.id)}
                          title="حذف الجلسة من السجل"
                          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger-text)] hover:bg-[var(--danger-bg)] cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* Messages Area */
          <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 bg-[var(--app-bg)]/35">
            {messages.map((msg) => {
              const isBot = msg.role === 'bot';
              const waUrl = msg.whatsappText
                ? formatWhatsAppUrl(msg.whatsappPhone, msg.whatsappText)
                : null;

              const interactiveData = msg.meta?.interactiveAttendance;
              const isInteractiveAttendance = Boolean(isBot && interactiveData && interactiveData.students.length > 0);
              const liveUnrecordedRows = interactiveData
                ? interactiveData.students.filter((st) => {
                    const live = studentsByIdMap.get(st.id);
                    return live && typeof live.att?.[interactiveData.targetFriday] !== 'boolean';
                  })
                : [];
              const liveAlreadyRecordedCount = interactiveData
                ? interactiveData.students.length - liveUnrecordedRows.length
                : 0;

              const msgSelectedMap = selectedIdsByMsg[msg.id] || {};
              const msgDraftStatusMap = draftStatusByMsg[msg.id] || {};
              const selectedUnrecIds = liveUnrecordedRows
                .filter((st) => msgSelectedMap[st.id])
                .map((st) => st.id);
              const stagedIndividualEntries = liveUnrecordedRows
                .filter((st) => typeof msgDraftStatusMap[st.id] === 'boolean')
                .map((st) => ({
                  studentId: st.id,
                  isPresent: Boolean(msgDraftStatusMap[st.id])
                }));
              const isIndividualExpanded = Boolean(expandedIndividualMsgs[msg.id]);

              // When interactiveAttendance card is present, bulk buttons are rendered inside the interactive card so secondary actions stay uncluttered
              const displayActions = isInteractiveAttendance
                ? (msg.actions || []).filter(
                    (a) => a.payload !== 'تسجيل الكل حضور' && a.payload !== 'تسجيل الكل غياب'
                  )
                : msg.actions || [];

              return (
                <div
                  key={msg.id}
                  className={`word-in flex flex-col ${isBot ? 'items-start' : 'items-end'}`}
                >
                  <div
                    className={`max-w-[94%] sm:max-w-[88%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-[13px] leading-relaxed whitespace-pre-wrap select-text shadow-xs ${
                      isBot
                        ? 'bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-tr-sm'
                        : 'bg-gradient-to-l from-[#123fce] to-[#1d4ed8] text-white border border-[#38bdf8]/40 rounded-tl-sm'
                    }`}
                  >
                    {msg.text}

                    {/* Interactive Unrecorded Attendance Panel (Bulk + Individual Multi-Select with Pre-Save Confirmation) */}
                    {isInteractiveAttendance && interactiveData && (
                      <div className="mt-3 pt-2.5 border-t border-[var(--border-color)] space-y-2.5 select-none">
                        {/* Live Unrecorded Status Header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <span className="font-extrabold text-[var(--text-primary)] flex items-center gap-1.5">
                            <UserX className="w-3.5 h-3.5 text-[var(--warning-text)] shrink-0" />
                            <span>
                              متبقي بدون تسجيل الآن ({liveUnrecordedRows.length}) • {interactiveData.targetFriday}
                            </span>
                          </span>
                          {liveAlreadyRecordedCount > 0 && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--success-bg)] text-[var(--success-text)] border border-[var(--success-border)]">
                              سُجّل بالفعل: {liveAlreadyRecordedCount}
                            </span>
                          )}
                        </div>

                        {liveUnrecordedRows.length > 0 ? (
                          <>
                            {/* Primary Bulk Choices: تسجيل الكل حضور / تسجيل الكل غياب */}
                            <div className="grid grid-cols-2 gap-1.5">
                              <button
                                type="button"
                                disabled={isExecutingAttendance}
                                onClick={() =>
                                  void openDraftConfirmation(
                                    msg.id,
                                    interactiveData.targetFriday,
                                    'تأكيد تسجيل جميع غير المسجلين كـ «حضور»',
                                    liveUnrecordedRows.map((st) => ({ studentId: st.id, isPresent: true }))
                                  )
                                }
                                className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[var(--success-bg)] hover:opacity-95 border border-[var(--success-border)] text-[11px] sm:text-xs font-extrabold text-[var(--success-text)] flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
                              >
                                <CheckCircle2 className="w-4 h-4 shrink-0" />
                                <span className="truncate">تسجيل الكل حضور</span>
                              </button>

                              <button
                                type="button"
                                disabled={isExecutingAttendance}
                                onClick={() =>
                                  void openDraftConfirmation(
                                    msg.id,
                                    interactiveData.targetFriday,
                                    'تأكيد تسجيل جميع غير المسجلين كـ «غياب»',
                                    liveUnrecordedRows.map((st) => ({ studentId: st.id, isPresent: false }))
                                  )
                                }
                                className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[var(--warning-bg)] hover:opacity-95 border border-[var(--warning-border)] text-[11px] sm:text-xs font-extrabold text-[var(--warning-text)] flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
                              >
                                <XCircle className="w-4 h-4 shrink-0" />
                                <span className="truncate">تسجيل الكل غياب</span>
                              </button>
                            </div>

                            {/* Individual / Multi-Select Expander */}
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedIndividualMsgs((prev) => ({
                                    ...prev,
                                    [msg.id]: !prev[msg.id]
                                  }))
                                }
                                className="w-full min-h-[34px] px-3 py-1.5 rounded-xl bg-[var(--surface-secondary)] hover:border-[var(--info-border)] border border-[var(--border-color)] text-[11px] font-bold text-[var(--info-text)] flex items-center justify-between gap-2 cursor-pointer transition-colors"
                              >
                                <span className="flex items-center gap-1.5">
                                  <CheckSquare className="w-3.5 h-3.5 shrink-0" />
                                  <span>تحديد فردي أو اختيار عدة مخدومين ({liveUnrecordedRows.length})</span>
                                </span>
                                {isIndividualExpanded ? (
                                  <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                                )}
                              </button>
                            </div>

                            {/* Expanded Multi-Select & Individual Status Controls */}
                            {isIndividualExpanded && (
                              <div className="p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--border-color)] space-y-2">
                                {/* Multi-select batch toolbar */}
                                <div className="flex flex-wrap items-center justify-between gap-1.5 pb-1.5 border-b border-[var(--border-color)]">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const allSelected = liveUnrecordedRows.every((s) => msgSelectedMap[s.id]);
                                      const nextMap: Record<string, boolean> = {};
                                      if (!allSelected) {
                                        for (const s of liveUnrecordedRows) nextMap[s.id] = true;
                                      }
                                      setSelectedIdsByMsg((prev) => ({ ...prev, [msg.id]: nextMap }));
                                    }}
                                    className="px-2 py-1 rounded-lg bg-[var(--surface-primary)] border border-[var(--border-color)] text-[10.5px] font-bold text-[var(--text-primary)] cursor-pointer"
                                  >
                                    {liveUnrecordedRows.every((s) => msgSelectedMap[s.id]) ? 'إلغاء التحديد' : 'تحديد الكل'}
                                  </button>

                                  {selectedUnrecIds.length > 0 && (
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => applyStatusToSelectedInMsg(msg.id, selectedUnrecIds, true)}
                                        className="px-2 py-1 rounded-lg bg-[var(--success-bg)] border border-[var(--success-border)] text-[10.5px] font-bold text-[var(--success-text)] cursor-pointer"
                                      >
                                        تعيين المحدد ({selectedUnrecIds.length}) حضور
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => applyStatusToSelectedInMsg(msg.id, selectedUnrecIds, false)}
                                        className="px-2 py-1 rounded-lg bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[10.5px] font-bold text-[var(--warning-text)] cursor-pointer"
                                      >
                                        غياب
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* Individual Student Cards */}
                                <div className="max-h-72 sm:max-h-80 overflow-y-auto space-y-2 pr-0.5">
                                  {liveUnrecordedRows.map((st) => {
                                    const isChecked = Boolean(msgSelectedMap[st.id]);
                                    const draftVal = msgDraftStatusMap[st.id];
                                    const cardBorderClasses =
                                      draftVal === true
                                        ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
                                        : draftVal === false
                                          ? 'border-[var(--warning-border)] bg-[var(--warning-bg)]'
                                          : isChecked
                                            ? 'border-[var(--info-border)] bg-[var(--info-bg)]'
                                            : 'border-[var(--border-color)] bg-[var(--surface-primary)]';
                                    return (
                                      <div
                                        key={st.id}
                                        data-testid="assistant-individual-student-card"
                                        className={`flex flex-col gap-2.5 p-3 rounded-2xl border transition-colors ${cardBorderClasses}`}
                                      >
                                        {/* Row 1: Full Name (Untruncated, Multi-line Allowed) */}
                                        <button
                                          type="button"
                                          onClick={() => toggleStudentSelected(msg.id, st.id)}
                                          className="flex items-start justify-between gap-2 w-full text-right cursor-pointer"
                                        >
                                          <span className="flex items-start gap-2 min-w-0 flex-1">
                                            {isChecked ? (
                                              <CheckSquare className="w-4 h-4 text-[var(--accent-secondary)] shrink-0 mt-0.5" />
                                            ) : (
                                              <Square className="w-4 h-4 text-[var(--text-muted)] shrink-0 mt-0.5" />
                                            )}
                                            <span className="text-xs sm:text-[13px] font-extrabold text-[var(--text-primary)] leading-relaxed whitespace-normal break-words">
                                              {st.name}
                                            </span>
                                          </span>
                                          {st.code && (
                                            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-[var(--surface-secondary)] text-[var(--text-muted)] border border-[var(--border-color)] shrink-0 mt-0.5">
                                              {st.code}
                                            </span>
                                          )}
                                        </button>

                                        {/* Row 2: Side-by-side حاضر / غائب Options */}
                                        <div className="grid grid-cols-2 gap-2 w-full">
                                          <button
                                            type="button"
                                            aria-pressed={draftVal === true}
                                            onClick={() => setStudentDraftStatus(msg.id, st.id, true)}
                                            className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-extrabold border flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                                              draftVal === true
                                                ? 'bg-emerald-700 text-white border-emerald-600 shadow-xs ring-2 ring-emerald-500/30'
                                                : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:border-[var(--success-border)] hover:text-[var(--success-text)]'
                                            }`}
                                          >
                                            <CheckCircle2 className="w-4 h-4 shrink-0" />
                                            <span>حاضر</span>
                                          </button>
                                          <button
                                            type="button"
                                            aria-pressed={draftVal === false}
                                            onClick={() => setStudentDraftStatus(msg.id, st.id, false)}
                                            className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-extrabold border flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                                              draftVal === false
                                                ? 'bg-amber-700 text-white border-amber-600 shadow-xs ring-2 ring-amber-500/30'
                                                : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:border-[var(--warning-border)] hover:text-[var(--warning-text)]'
                                            }`}
                                          >
                                            <XCircle className="w-4 h-4 shrink-0" />
                                            <span>غائب</span>
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                {/* Review Draft Before Confirming */}
                                {stagedIndividualEntries.length > 0 && (
                                  <div className="pt-1.5 flex items-center justify-between gap-2">
                                    <span className="text-[10.5px] font-bold text-[var(--text-secondary)]">
                                      جاهز للمراجعة: {stagedIndividualEntries.filter((e) => e.isPresent).length} حضور •{' '}
                                      {stagedIndividualEntries.filter((e) => !e.isPresent).length} غياب
                                    </span>
                                    <button
                                      type="button"
                                      disabled={isExecutingAttendance}
                                      onClick={() =>
                                        void openDraftConfirmation(
                                          msg.id,
                                          interactiveData.targetFriday,
                                          'مراجعة وتأكيد الاختيارات الفردية المحددة',
                                          stagedIndividualEntries
                                        )
                                      }
                                      className="btn--lens min-h-[34px] px-3 py-1 rounded-xl bg-gradient-to-r from-[#123fce] to-[#1d4ed8] text-white text-[11px] font-extrabold cursor-pointer disabled:opacity-50"
                                    >
                                      مراجعة وتأكيد ({stagedIndividualEntries.length})
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-[11px] font-bold text-[var(--success-text)] m-0">
                            ✅ تم استكمال تسجيل جميع المخدومين في هذه القائمة.
                          </p>
                        )}
                      </div>
                    )}

                    {/* Utility Row (Copy / WhatsApp) + Balanced Action Grid */}
                    {isBot && (msg.copyText || waUrl || displayActions.length > 0) && (
                      <div className="mt-2.5 pt-2 border-t border-[var(--border-color)] space-y-2 select-none">
                        {(msg.copyText || waUrl) && (
                          <div className="flex flex-row items-center gap-1.5 flex-wrap">
                            {msg.copyText && (
                              <button
                                type="button"
                                onClick={() => handleCopy(msg.id, msg.copyText!)}
                                className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[var(--surface-secondary)] hover:border-[#20c7e8]/60 border border-[var(--border-color)] text-[11px] font-bold text-[var(--text-primary)] flex items-center gap-1.5 cursor-pointer transition-colors"
                              >
                                {copiedId === msg.id ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-[var(--info-text)] shrink-0" />
                                    <span>تم النسخ</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5 text-[var(--info-text)] shrink-0" />
                                    <span>نسخ</span>
                                  </>
                                )}
                              </button>
                            )}

                            {waUrl && (
                              <a
                                href={waUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[var(--info-bg)] hover:opacity-95 border border-[var(--info-border)] text-[11px] font-bold text-[var(--info-text)] flex items-center gap-1.5 transition-colors"
                              >
                                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                                <span>إرسال واتساب</span>
                              </a>
                            )}
                          </div>
                        )}

                        {displayActions.length > 0 && (
                          <div
                            className={
                              displayActions.length === 1
                                ? 'flex flex-row items-center'
                                : displayActions.length === 2 || displayActions.length === 4
                                  ? 'grid grid-cols-2 gap-1.5'
                                  : 'grid grid-cols-2 sm:grid-cols-3 gap-1.5'
                            }
                          >
                            {displayActions.map((act, idx) => {
                              const ActIcon = getActionIcon(act);
                              if (act.type === 'sync') {
                                return (
                                  <button
                                    key={idx}
                                    type="button"
                                    disabled={isSyncing}
                                    onClick={() => syncData('__ALL__')}
                                    className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-gradient-to-r from-[#123fce] to-[#1d4ed8] text-white text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                  >
                                    <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
                                    <span className="truncate">{act.label}</span>
                                  </button>
                                );
                              }
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => submitQuery(act.payload)}
                                  className={`min-h-[36px] px-2.5 py-1.5 rounded-xl border text-[11px] font-bold flex items-center justify-start gap-1.5 cursor-pointer text-right transition-colors ${getActionButtonClasses(
                                    act
                                  )}`}
                                >
                                  <ActIcon className="w-3.5 h-3.5 shrink-0" />
                                  <span className="truncate">{act.label}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Interactive Pre-Save Confirmation Dialog inside Chat */}
            {pendingDraftConfirm && (
              <div
                role="alertdialog"
                aria-label="تأكيد تسجيل الحضور"
                className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border-2 border-[var(--info-border)] shadow-md space-y-2.5"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-[var(--warning-text)] shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1 space-y-1 text-xs">
                    <h4 className="font-extrabold text-[var(--text-primary)] m-0">
                      {pendingDraftConfirm.title}
                    </h4>
                    <p className="text-[11px] text-[var(--text-secondary)] m-0">
                      • عدد المخدومين الجاهزين للتسجيل: <strong>{pendingDraftConfirm.selections.length}</strong> | التاريخ:{' '}
                      <span className="font-mono font-bold">{pendingDraftConfirm.targetFriday}</span>
                    </p>
                    {pendingDraftConfirm.selections.length > 0 && (
                      <div className="text-[11px] text-[var(--text-secondary)] bg-[var(--surface-inset)] p-2 rounded-xl border border-[var(--border-color)] max-h-32 overflow-y-auto space-y-1">
                        {pendingDraftConfirm.selections.map((item, idx) => (
                          <div key={item.studentId} className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {idx + 1}. {item.studentName} {item.studentCode ? `(${item.studentCode})` : ''}
                            </span>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0 ${
                                item.isPresent
                                  ? 'bg-[var(--success-bg)] text-[var(--success-text)]'
                                  : 'bg-[var(--warning-bg)] text-[var(--warning-text)]'
                              }`}
                            >
                              {item.isPresent ? 'حضور' : 'غياب'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(pendingDraftConfirm.skippedAlreadyRecorded.length > 0 ||
                      pendingDraftConfirm.skippedAlreadyQueued.length > 0) && (
                      <p className="text-[10.5px] font-bold text-[var(--warning-text)] m-0">
                        ℹ️ تم استبعاد{' '}
                        {pendingDraftConfirm.skippedAlreadyRecorded.length +
                          pendingDraftConfirm.skippedAlreadyQueued.length}{' '}
                        مخدوم لأنه مسجل بالفعل أو موجود بطابور المزامنة.
                      </p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    disabled={isExecutingAttendance || pendingDraftConfirm.selections.length === 0}
                    onClick={() => void handleConfirmPendingDraft()}
                    className="btn--lens min-h-[38px] px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#123fce] to-[#1d4ed8] text-white text-xs font-extrabold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>{isExecutingAttendance ? 'جاري التنفيذ...' : 'تأكيد التسجيل الآن'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isExecutingAttendance}
                    onClick={() => setPendingDraftConfirm(null)}
                    className="glass-btn min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--text-secondary)] flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <XCircle className="w-4 h-4 shrink-0" />
                    <span>تراجع / إلغاء</span>
                  </button>
                </div>
              </div>
            )}

            {isTyping && (
              <div className="flex items-start">
                <div className="px-3.5 py-2 rounded-2xl rounded-tr-sm bg-[var(--surface-primary)] border border-[var(--border-color)] text-xs font-bold text-[var(--info-text)] animate-pulse">
                  يكتب...
                </div>
              </div>
            )}
            <div ref={listEndRef} />
          </div>
        )}

        {/* Quick Prompts Balanced Grid Strip */}
        <div className="px-3 sm:px-4 py-2 border-t border-[var(--border-color)] bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[11px] font-extrabold text-[var(--text-muted)] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[var(--info-text)] shrink-0" />
              <span>الأوامر السريعة</span>
            </span>
            <button
              type="button"
              onClick={() => setShowQuickPrompts((prev) => !prev)}
              className="text-[11px] font-bold text-[var(--info-text)] hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>{showQuickPrompts ? 'إخفاء' : 'عرض الأوامر'}</span>
              {showQuickPrompts ? (
                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5 shrink-0" />
              )}
            </button>
          </div>
          {showQuickPrompts && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 max-h-[144px] sm:max-h-none overflow-y-auto">
              {QUICK_PROMPTS.map((qp) => {
                const QIcon = qp.icon;
                return (
                  <button
                    key={qp.id}
                    type="button"
                    onClick={() => {
                      if (showHistory) setShowHistory(false);
                      submitQuery(qp.query);
                    }}
                    className="glass-btn min-h-[38px] sm:min-h-[40px] w-full px-2.5 py-1.5 rounded-xl text-[11px] sm:text-xs font-bold text-[var(--text-primary)] flex items-center justify-start gap-2 cursor-pointer text-right overflow-hidden hover:border-[#20c7e8]/50 transition-colors"
                  >
                    <QIcon className={`w-4 h-4 shrink-0 ${qp.accent}`} />
                    <span className="truncate">{qp.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (showHistory) setShowHistory(false);
            submitQuery(input);
          }}
          className="p-3 border-t border-[var(--border-color)] bg-[var(--surface-secondary)] flex items-center gap-2 shrink-0"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="اسأل عن الحضور، الغياب، أو من لم يسجل بعد..."
            className="flex-1 min-w-0 min-h-[42px] h-auto py-2 px-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs sm:text-sm font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)]"
            dir="rtl"
          />
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="btn--lens min-h-[42px] h-auto py-2 px-4 rounded-xl bg-gradient-to-r from-[#123fce] to-[#1d4ed8] text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-45 active:scale-95 border border-[var(--info-border)] shrink-0"
            aria-label="إرسال"
          >
            <Send className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">إرسال</span>
          </button>
        </form>
      </div>
    </div>
  );
};
