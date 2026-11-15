import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import {
  AssistantMessage,
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
import {
  Bot,
  X,
  Send,
  Copy,
  Check,
  MessageSquare,
  RotateCcw,
  RefreshCw,
  Sparkles,
  History,
  Plus,
  Trash2,
  Clock
} from 'lucide-react';
import { generateUUID } from '../../utils/uuid';
import { formatWhatsAppUrl } from '../../utils/arabicUtils';

const QUICK_PROMPTS = [
  { label: '🎂 أعياد الميلاد', query: 'أعياد الميلاد' },
  { label: '🎉 رسالة تهنئة', query: 'رسالة عيد ميلاد' },
  { label: '💙 رسالة افتقاد', query: 'رسالة افتقاد' },
  { label: '🌟 رسالة تشجيع', query: 'رسالة تشجيع' },
  { label: '📊 إحصائيات', query: 'إحصائيات' },
  { label: '⚠️ الغائبون', query: 'الغائبون' },
  { label: '✅ الحضور اليوم', query: 'مين حضر النهارده؟' },
  { label: '🎂 الشهر القادم', query: 'أعياد الميلاد الشهر القادم' },
  { label: '📞 افتقاد هذا الأسبوع', query: 'مين نسيت افتقدهم الأسبوع ده؟' },
  { label: '📉 حضور ضعيف', query: 'الأولاد اللي حضورهم مش قوي' },
  { label: '🕒 سجل المحادثات', query: 'سجل المحادثات' },
  { label: '❓ مساعدة', query: 'مساعدة' }
];

export const AssistantModal: React.FC = () => {
  const {
    isAssistantOpen,
    setIsAssistantOpen,
    students,
    filters,
    lastSuccessfulSyncTime,
    syncData,
    isSyncing,
    isOnline,
    markAttendance,
    recordFollowup,
    processOfflineQueue,
    requestEditStudent,
    setFilters,
    setActiveView,
    addNotification
  } = useApp();
  const { user } = useAuth();

  // Fresh session state - each session has its own unique ID and isolated messages
  const [session, setSession] = useState<AssistantSession>(() => createFreshAssistantSession());
  const [messages, setMessages] = useState<AssistantMessage[]>(() => session.messages);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  /**
   * Fresh Session Lifecycle:
   * Every time the assistant modal opens from a closed state,
   * a brand-new, isolated session is generated with a fresh Session ID,
   * fresh welcome message, and zero leakage from prior sessions.
   * When closing, any session containing user questions is safely archived.
   */
  useEffect(() => {
    if (isAssistantOpen) {
      if (!prevOpenRef.current) {
        // Just opened from closed state: Start a clean fresh session
        const fresh = createFreshAssistantSession();
        setSession(fresh);
        currentSessionRef.current = fresh;
        setMessages(fresh.messages);
        messagesRef.current = fresh.messages;
        setInput('');
        setIsTyping(false);
        setShowHistory(false);
        setViewingPastSessionId(null);
        setStoredSessions(getStoredAssistantSessions());
      }
    } else {
      if (prevOpenRef.current) {
        // Just closed from open state: Archive current session if it has user messages
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
  }, [isAssistantOpen, messages, isTyping, showHistory]);

  if (!isAssistantOpen) return null;

  /**
   * Explicitly starts a brand-new session on user request.
   */
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
    setStoredSessions(getStoredAssistantSessions());
  };

  /**
   * Safely closes the modal, preserving active session to history if dirty.
   */
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
    // If active fresh session had user interactions, save it first
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

    // If currently inspecting a past session and user asks something new, fork into a fresh session
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

    // Update title from first user query if still default
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
          lastSyncLabel: lastSuccessfulSyncTime,
          servantName: filters.servant || user?.assignedServantName || undefined,
          sessionMessages: updatedMessages, // strictly messages from THIS session
          includePastHistory: explicitHistory,
          pastSessions: explicitHistory ? getStoredAssistantSessions() : undefined
        });

        // Attendance Command Handling
        if (response.command?.type === 'markAttendance') {
          const command = response.command;
          const currentStudent = students.find((s) => s.id === command.studentId);
          const existing = currentStudent?.att?.[command.targetFridayDate];
          if (existing === command.isPresent) {
            response = {
              text: `ℹ️ ${command.studentName} مسجل بالفعل كـ${command.isPresent ? 'حاضر' : 'غائب'} عن ${command.targetFridayDate}. لم أضف سجلًا مكررًا.`
            };
          } else {
            const saved = await markAttendance(command.studentId, command.isPresent, command.targetFridayDate);
            if (!saved) {
              response = {
                text: `تعذر تسجيل ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName}. راجع تنبيه التطبيق وحالة المزامنة، ولم أعتبر العملية ناجحة.`
              };
            } else if (isOnline) {
              try {
                const syncResult = await processOfflineQueue();
                response = {
                  text: syncResult.success && syncResult.remainingCount === 0
                    ? `✅ تم تسجيل ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} عن ${command.targetFridayDate}، وتم إرسال العملية بنجاح إلى المزامنة.\n\nعدد العمليات المعلقة الآن: 0.`
                    : `✅ تم حفظ ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} محليًا عن ${command.targetFridayDate}. لكن المزامنة لم تكتمل بعد؛ العمليات المعلقة: ${syncResult.remainingCount}. لن أفترض أن Google Sheets تم تحديثه.`
                };
              } catch (error) {
                console.error('Assistant attendance sync failed:', error);
                response = {
                  text: `✅ تم حفظ ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} محليًا عن ${command.targetFridayDate}، لكن تعذر تأكيد المزامنة. البيانات محفوظة في طابور الإرسال للمحاولة لاحقًا.`
                };
              }
            } else {
              response = {
                text: `✅ تم حفظ ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} محليًا عن ${command.targetFridayDate}. الجهاز غير متصل، وسيتم إرسال العملية عند عودة الإنترنت.`
              };
            }
          }
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
          timestamp: Date.now()
        };

        const finalMessages = [...updatedMessages, botMsg];
        setMessages(finalMessages);
        messagesRef.current = finalMessages;
        setIsTyping(false);

        // Auto-save active session to storage
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
    }, 140);
  };

  const handleCopy = async (id: string, textToCopy: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedId(id);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 2000);
    } catch {}
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none"
      role="dialog"
      aria-modal="true"
      aria-label="المساعد الذكي"
    >
      <div className="w-full max-w-2xl h-[min(90dvh,760px)] max-h-[90dvh] min-w-0 glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow-lg)] overflow-hidden flex flex-col animate-wordIn">
        {/* Header */}
        <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--border-color)] flex items-center justify-between bg-[var(--surface-primary)]/50 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative w-10 h-10 rounded-2xl bg-gradient-to-br from-[#123fce] via-[#267aff] to-[#20c7e8] flex items-center justify-center text-white shadow-[0_0_16px_rgba(32,199,232,0.45)] shrink-0">
              <Bot className="w-5 h-5" />
              <span
                className="absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full bg-[#20c7e8] border-2 border-[#071B3B] shadow-[0_0_8px_#20c7e8]"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="font-extrabold text-sm sm:text-base text-[var(--text-primary)] m-0 truncate">
                  المساعد الذكي
                </h3>
                <Sparkles className="w-3.5 h-3.5 text-[#20c7e8] shrink-0" />
              </div>
              <p className="text-[11px] text-[var(--text-muted)] m-0 truncate">
                {viewingPastSessionId
                  ? 'استعراض جلسة سابقة مؤرشفة'
                  : `جلسة مستقلة جديدة • ${students.length} مخدوم محمل`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* History Toggle Button */}
            <button
              type="button"
              onClick={handleToggleHistory}
              title={showHistory ? 'العودة للمحادثة' : 'سجل المحادثات السابقة'}
              className={`glass-btn w-8 h-8 rounded-xl flex items-center justify-center cursor-pointer transition-colors ${
                showHistory
                  ? 'text-[#20c7e8] bg-[#20c7e8]/20 border border-[#20c7e8]/50'
                  : 'text-[var(--text-muted)] hover:text-[#20c7e8]'
              }`}
            >
              <History className="w-4 h-4" />
            </button>

            {/* New Session Button */}
            <button
              type="button"
              onClick={handleStartNewSession}
              title="بدء محادثة جديدة مستقلة"
              className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] hover:text-[#20c7e8] flex items-center justify-center cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* Close Modal Button */}
            <button
              type="button"
              onClick={handleCloseModal}
              title="إغلاق"
              className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Viewing Past Session Banner */}
        {viewingPastSessionId && !showHistory && (
          <div className="mx-3.5 mt-2.5 px-3.5 py-2 rounded-2xl bg-[#20c7e8]/10 border border-[#20c7e8]/30 flex items-center justify-between gap-3 text-xs text-[var(--text-primary)] shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Clock className="w-4 h-4 text-[#20c7e8] shrink-0" />
              <span className="truncate">
                أنت تستعرض محادثة سابقة: <strong>{session.title}</strong>
              </span>
            </div>
            <button
              type="button"
              onClick={handleStartNewSession}
              className="btn--lens px-2.5 py-1 rounded-xl bg-gradient-to-r from-[#123fce] to-[#267aff] text-white text-[11px] font-bold shrink-0 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>محادثة جديدة</span>
            </button>
          </div>
        )}

        {/* Content Area: Either History Drawer or Active Chat Messages */}
        {showHistory ? (
          <div className="flex-1 overflow-y-auto p-3.5 sm:p-5 space-y-3 bg-[var(--app-bg)]/40 animate-fadeIn">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border-color)]">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-[#20c7e8]" />
                <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                  سجل المحادثات السابقة ({storedSessions.length})
                </h4>
              </div>
              <button
                type="button"
                onClick={handleStartNewSession}
                className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-[#20c7e8] flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ محادثة جديدة</span>
              </button>
            </div>

            {storedSessions.length === 0 ? (
              <div className="py-16 text-center text-[var(--text-muted)] space-y-2">
                <Clock className="w-10 h-10 mx-auto opacity-30 text-[#20c7e8]" />
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
                          ? 'bg-[#20c7e8]/15 border-[#20c7e8]/50 shadow-[0_0_12px_rgba(32,199,232,0.15)]'
                          : 'bg-[var(--surface-primary)] border-[var(--border-color)] hover:border-[#20c7e8]/40 hover:bg-[var(--surface-secondary)]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <MessageSquare className="w-3.5 h-3.5 text-[#20c7e8] shrink-0" />
                          <span className="font-bold text-xs sm:text-sm text-[var(--text-primary)] truncate">
                            {s.title}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                          <span>{dateStr}</span>
                          <span>•</span>
                          <span>{userCount} سؤال</span>
                          {isSelected && (
                            <span className="text-[#20c7e8] font-bold">معروض حالياً</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => handleDeletePastSession(e, s.id)}
                          title="حذف الجلسة من السجل"
                          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer transition-colors"
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
          <div className="flex-1 overflow-y-auto p-3.5 sm:p-4 space-y-3 bg-[var(--app-bg)]/35">
            {messages.map((msg) => {
              const isBot = msg.role === 'bot';
              const waUrl = msg.whatsappText
                ? formatWhatsAppUrl(msg.whatsappPhone, msg.whatsappText)
                : null;

              return (
                <div
                  key={msg.id}
                  className={`word-in flex flex-col ${isBot ? 'items-start' : 'items-end'}`}
                >
                  <div
                    className={`max-w-[90%] sm:max-w-[82%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-[13px] leading-relaxed whitespace-pre-wrap select-text shadow-xs ${
                      isBot
                        ? 'bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-tr-sm'
                        : 'bg-gradient-to-l from-[#123fce] to-[#267aff] text-white border border-[#20c7e8]/30 rounded-tl-sm'
                    }`}
                  >
                    {msg.text}

                    {/* Utility Actions for Bot Answers (Copy / WhatsApp / Follow-up Chips) */}
                    {isBot && (msg.copyText || waUrl || (msg.actions && msg.actions.length > 0)) && (
                      <div className="mt-2.5 pt-2 border-t border-[var(--border-color)] flex flex-wrap items-center gap-1.5 select-none">
                        {msg.copyText && (
                          <button
                            type="button"
                            onClick={() => handleCopy(msg.id, msg.copyText!)}
                            className="px-2.5 py-1 rounded-lg bg-[var(--surface-secondary)] hover:border-[#20c7e8]/60 border border-[var(--border-color)] text-[11px] font-bold text-[var(--text-primary)] flex items-center gap-1 cursor-pointer transition-colors"
                          >
                            {copiedId === msg.id ? (
                              <>
                                <Check className="w-3 h-3 text-[#20c7e8]" />
                                <span>تم النسخ</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3 text-[#20c7e8]" />
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
                            className="px-2.5 py-1 rounded-lg bg-[#20c7e8]/15 hover:bg-[#20c7e8]/25 border border-[#20c7e8]/40 text-[11px] font-bold text-[#20c7e8] flex items-center gap-1 transition-colors"
                          >
                            <MessageSquare className="w-3 h-3" />
                            <span>إرسال واتساب</span>
                          </a>
                        )}

                        {msg.actions?.map((act, idx) =>
                          act.type === 'sync' ? (
                            <button
                              key={idx}
                              type="button"
                              disabled={isSyncing}
                              onClick={() => syncData('__ALL__')}
                              className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-[#123fce] to-[#267aff] text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                            >
                              <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                              <span>{act.label}</span>
                            </button>
                          ) : (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => submitQuery(act.payload)}
                              className="px-2.5 py-1 rounded-lg bg-[var(--surface-secondary)] hover:border-[#20c7e8]/60 border border-[var(--border-color)] text-[11px] font-bold text-[var(--accent-secondary)] cursor-pointer transition-colors"
                            >
                              {act.label}
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {isTyping && (
              <div className="flex items-start">
                <div className="px-3.5 py-2 rounded-2xl rounded-tr-sm bg-[var(--surface-primary)] border border-[var(--border-color)] text-xs font-bold text-[#20c7e8] animate-pulse">
                  يكتب...
                </div>
              </div>
            )}
            <div ref={listEndRef} />
          </div>
        )}

        {/* Quick Prompts Strip */}
        <div className="px-3.5 py-2 border-t border-[var(--border-color)] bg-[var(--surface-primary)]/40 flex flex-wrap justify-center items-center gap-1.5 shrink-0">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.label}
              type="button"
              onClick={() => {
                if (showHistory) setShowHistory(false);
                submitQuery(qp.query);
              }}
              className="glass-btn px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-[var(--text-primary)] whitespace-nowrap cursor-pointer shrink-0"
            >
              {qp.label}
            </button>
          ))}
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (showHistory) setShowHistory(false);
            submitQuery(input);
          }}
          className="p-3 border-t border-[var(--border-color)] bg-[var(--surface-primary)]/60 flex items-center gap-2 shrink-0"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="اسأل عن الحضور والغياب وأعياد الميلاد، أو قل: سجل حضور + اسم المخدوم..."
            className="flex-1 min-w-0 h-10 px-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs sm:text-sm font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[#20c7e8]"
            dir="rtl"
          />
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="btn--lens h-10 px-4 rounded-xl bg-gradient-to-r from-[#123fce] to-[#267aff] text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-45 active:scale-95 border border-[#20c7e8]/30 shrink-0"
            aria-label="إرسال"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">إرسال</span>
          </button>
        </form>
      </div>
    </div>
  );
};
