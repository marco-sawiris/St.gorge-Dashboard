import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import {
  AssistantMessage,
  processAssistantQuery
} from '../../services/assistantEngine';
import {
  Bot,
  X,
  Send,
  Copy,
  Check,
  MessageSquare,
  RotateCcw,
  RefreshCw,
  Sparkles
} from 'lucide-react';
import { generateUUID } from '../../utils/uuid';

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
  { label: '❓ مساعدة', query: 'مساعدة' }
];

const INITIAL_BOT_MESSAGE: AssistantMessage = {
  id: 'welcome-msg',
  role: 'bot',
  text: 'سلام ونعمة ✝️ أنا المساعد الذكي لفصل الشهيد مارجرجس.\nأفهم بيانات المخدومين والحضور والغياب وأعياد الميلاد والافتقاد، وأقدر أنفذ أوامر واضحة لتسجيل الحضور والغياب والافتقاد الجماعي (مكالمة أو واتساب أو زيارة منزلية)، وأفتح كروت المخدومين للتعديل، مع استخدام قاعدة البيانات المحلية وطابور المزامنة.',
  actions: [
    { label: '📊 عرض الإحصائيات', type: 'prompt', payload: 'إحصائيات' },
    { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' },
    { label: '⚠️ الغائبون', type: 'prompt', payload: 'الغائبون' }
  ],
  timestamp: Date.now()
};

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

  const [messages, setMessages] = useState<AssistantMessage[]>([INITIAL_BOT_MESSAGE]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isAssistantOpen) {
      setTimeout(() => {
        listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    }
  }, [isAssistantOpen, messages, isTyping]);

  if (!isAssistantOpen) return null;

  const submitQuery = (rawQuery: string) => {
    const clean = rawQuery.trim();
    if (!clean) return;

    const userMsg: AssistantMessage = {
      id: generateUUID(),
      role: 'user',
      text: clean,
      timestamp: Date.now()
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    setTimeout(() => {
      void (async () => {
        let response = processAssistantQuery(clean, students, {
          lastSyncLabel: lastSuccessfulSyncTime,
          servantName: filters.servant || user?.assignedServantName || undefined
        });

        // Explicit, uniquely matched attendance commands write through the same
        // IndexedDB + offline mutation queue used by the student card controls.
        if (response.command?.type === 'markAttendance') {
          const command = response.command;
          const currentStudent = students.find((s) => s.id === command.studentId);
          const existing = currentStudent?.att?.[command.targetFridayDate];
          if (existing === command.isPresent) {
            response = {
              text: `\u2139\ufe0f ${command.studentName} مسجل بالفعل كـ${command.isPresent ? 'حاضر' : 'غائب'} عن ${command.targetFridayDate}. لم أضف سجلًا مكررًا.`
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
                    ? `\u2705 تم تسجيل ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} عن ${command.targetFridayDate}، وتم إرسال العملية بنجاح إلى المزامنة.\n\nعدد العمليات المعلقة الآن: 0.`
                    : `\u2705 تم حفظ ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} محليًا عن ${command.targetFridayDate}. لكن المزامنة لم تكتمل بعد؛ العمليات المعلقة: ${syncResult.remainingCount}. لن أفترض أن Google Sheets تم تحديثه.`
                };
              } catch (error) {
                console.error('Assistant attendance sync failed:', error);
                response = {
                  text: `\u2705 تم حفظ ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} محليًا عن ${command.targetFridayDate}، لكن تعذر تأكيد المزامنة. البيانات محفوظة في طابور الإرسال للمحاولة لاحقًا.`
                };
              }
            } else {
              response = {
                text: `\u2705 تم حفظ ${command.isPresent ? 'حضور' : 'غياب'} ${command.studentName} محليًا عن ${command.targetFridayDate}. الجهاز غير متصل، وسيتم إرسال العملية عند عودة الإنترنت.`
              };
            }
          }
        } else if (response.command?.type === 'recordFollowupBatch') {
          const command = response.command;
          const savedNames: string[] = [];
          const failedNames: string[] = [];
          for (const target of command.students) {
            const currentStudent = students.find((s) => s.id === target.id);
            if (!currentStudent) { failedNames.push(target.name + ' (غير موجود)'); continue; }
            if (currentStudent.fu?.[command.weekFridayDate]) {
              failedNames.push(target.name + ' (مسجل بالفعل هذا الأسبوع)');
              continue;
            }
            try {
              const saved = await recordFollowup(target.id, command.method, 'تم التسجيل بواسطة المساعد الذكي — ' + command.weekFridayDate);
              if (saved) savedNames.push(target.name); else failedNames.push(target.name);
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
            text: 'نتيجة تسجيل الافتقاد (' + command.method + '):\nتم الحفظ: ' + savedNames.length + '\n' + (savedNames.length ? savedNames.map((name) => '• ' + name).join('\n') : 'لا توجد أسماء محفوظة.') +
              (failedNames.length ? '\n\nلم يتم الحفظ (' + failedNames.length + '):\n' + failedNames.map((name) => '• ' + name).join('\n') : '') + syncSummary
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
            setIsAssistantOpen(false);
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
        setMessages((prev) => [...prev, botMsg]);
        setIsTyping(false);
      })();
    }, 140);
  };

  const handleCopy = async (id: string, textToCopy: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedId(id);
      setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 2000);
    } catch {}
  };

  const handleReset = () => {
    setMessages([{ ...INITIAL_BOT_MESSAGE, timestamp: Date.now() }]);
    setInput('');
    setIsTyping(false);
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
              {/* Strictly Zero Green: Cyan online dot */}
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
                مساعد محلي فوري • {students.length} مخدوم محمل
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleReset}
              title="بدء محادثة جديدة"
              className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] hover:text-[#20c7e8] flex items-center justify-center cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setIsAssistantOpen(false)}
              title="إغلاق"
              className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-3.5 sm:p-4 space-y-3 bg-[var(--app-bg)]/35">
          {messages.map((msg) => {
            const isBot = msg.role === 'bot';
            const waUrl = msg.whatsappText
              ? msg.whatsappPhone
                ? `https://wa.me/2${msg.whatsappPhone}?text=${encodeURIComponent(msg.whatsappText)}`
                : `https://wa.me/?text=${encodeURIComponent(msg.whatsappText)}`
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

        {/* Quick Prompts Strip */}
        <div className="px-3.5 py-2 border-t border-[var(--border-color)] bg-[var(--surface-primary)]/40 flex flex-wrap justify-center items-center gap-1.5 shrink-0">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.label}
              type="button"
              onClick={() => submitQuery(qp.query)}
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
