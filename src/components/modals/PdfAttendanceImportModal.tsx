import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSpreadsheet,
  FileUp,
  HelpCircle,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserCheck,
  Users,
  X,
  XCircle
} from 'lucide-react';
import { useApp, SyncQueueExecutionReport } from '../../context/AppContext';
import { Student } from '../../types/student';
import {
  ParsedPdfAttendanceReport,
  ParsedPdfStudentRow,
  parseAttendancePdfFile
} from '../../services/pdfAttendanceParser';
import {
  buildAttendanceImportPlan,
  createInitialPdfResolutionState,
  getEffectiveCellStatus,
  getEffectiveMatchedStudentId,
  PdfImportResolutionState
} from '../../services/pdfAttendanceImportService';
import {
  AttendanceHistoryRecord,
  idbGetAttendanceHistory
} from '../../services/indexedDbService';
import { generateUUID } from '../../utils/uuid';

type RowFilterTab = 'all' | 'review' | 'matched';

interface ImportExecutionSummary {
  appliedCount: number;
  skippedDuplicateCount: number;
  blockedCount: number;
  futureBlockedCount: number;
  queuedCount: number;
  wasOffline: boolean;
  syncReport?: SyncQueueExecutionReport;
  error?: string;
}

export const PdfAttendanceImportModal: React.FC = () => {
  const {
    isPdfImportModalOpen,
    setIsPdfImportModalOpen,
    students,
    importAttendanceBatch,
    isOnline,
    pendingMutationsCount,
    syncState,
    setIsSyncModalOpen,
    processOfflineQueue
  } = useApp();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [isParsing, setIsParsing] = useState(false);
  const [parseProgressPct, setParseProgressPct] = useState(0);
  const [parseProgressMsg, setParseProgressMsg] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [report, setReport] = useState<ParsedPdfAttendanceReport | null>(null);
  const [resolution, setResolution] = useState<PdfImportResolutionState>(() =>
    createInitialPdfResolutionState()
  );
  const [rowFilter, setRowFilter] = useState<RowFilterTab>('all');
  const [isApplying, setIsApplying] = useState(false);
  const [executionResult, setExecutionResult] = useState<ImportExecutionSummary | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [existingHistory, setExistingHistory] = useState<AttendanceHistoryRecord[]>([]);
  const [importOperationId, setImportOperationId] = useState<string>('');
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);

  const studentsById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);

  const sortedAllStudents = useMemo(
    () => [...students].sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    [students]
  );

  const plan = useMemo(() => {
    if (!report) return null;
    return buildAttendanceImportPlan(report, students, resolution, existingHistory);
  }, [report, students, resolution, existingHistory]);

  const visibleRows = useMemo(() => {
    if (!report) return [];
    return report.rows.filter((row) => {
      if (rowFilter === 'all') return true;
      const effectiveMatchedId = getEffectiveMatchedStudentId(
        row.rowKey,
        row.matchedStudentId,
        resolution
      );
      const hasUnresolvedCell = report.extractedDates.some((d) => {
        const eff = getEffectiveCellStatus(
          row.rowKey,
          d.date,
          row.cells[d.date]?.status || 'empty',
          resolution
        );
        return eff === 'unknown' || eff === 'ambiguous';
      });
      if (rowFilter === 'review') {
        return !effectiveMatchedId || hasUnresolvedCell || row.hasAbsenceCountMismatch;
      }
      return Boolean(effectiveMatchedId) && !resolution.excludedRowKeys[row.rowKey];
    });
  }, [report, rowFilter, resolution]);

  if (!isPdfImportModalOpen) return null;

  const handleClose = () => {
    if (isParsing || isApplying) return;
    setIsPdfImportModalOpen(false);
  };

  const handleReset = () => {
    setReport(null);
    setParseError(null);
    setExecutionResult(null);
    setResolution(createInitialPdfResolutionState());
    setExistingHistory([]);
    setImportOperationId('');
    setShowOverwriteConfirm(false);
    setParseProgressPct(0);
    setParseProgressMsg('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCancelImport = () => {
    if (isParsing || isApplying) return;
    handleReset();
    setIsPdfImportModalOpen(false);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    setParseError(null);
    setExecutionResult(null);
    setReport(null);
    setResolution(createInitialPdfResolutionState());
    setShowOverwriteConfirm(false);
    setImportOperationId(generateUUID());
    setParseProgressPct(5);
    setParseProgressMsg('جاري فتح ملف الـ PDF...');

    try {
      const [parsed, historyRecords] = await Promise.all([
        parseAttendancePdfFile(file, students, {
          onProgress: (pct, msg) => {
            setParseProgressPct(pct);
            setParseProgressMsg(msg);
          }
        }),
        idbGetAttendanceHistory().catch(() => [] as AttendanceHistoryRecord[])
      ]);
      setExistingHistory(historyRecords);

      if (parsed.rows.length === 0 || parsed.extractedDates.length === 0) {
        const stageLabelMap: Record<string, string> = {
          pdf_load: 'تحميل ملف PDF',
          text_extraction: 'استخراج النصوص (getTextContent)',
          row_clustering: 'تجميع الصفوف بإحداثيات Y',
          header_detection: 'اكتشاف صف رؤوس الجدول',
          date_detection: 'اكتشاف أعمدة التواريخ',
          student_extraction: 'استخراج أسماء المخدومين',
          completed: 'مكتمل'
        };
        const stageText = parsed.diagnostics.failureStage
          ? `المرحلة [${stageLabelMap[parsed.diagnostics.failureStage] || parsed.diagnostics.failureStage}]: `
          : '';
        setParseError(
          `${stageText}${parsed.diagnostics.failureReason || parsed.warnings[0] || 'لم يتم التعرف على أعمدة تواريخ الحضور أو أسماء المخدومين داخل هذا الملف.'}`
        );
        setShowDiagnostics(true);
      } else {
        setShowDiagnostics(false);
      }
      setReport(parsed);
    } catch (err: any) {
      setParseError(err?.message || 'تعذر قراءة ملف PDF، تأكد من صلاحية الملف والمحاولة مرة أخرى.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleSelectStudentMapping = (rowKey: string, studentId: string) => {
    setResolution((prev) => ({
      ...prev,
      rowMappings: {
        ...prev.rowMappings,
        [rowKey]: studentId || null
      }
    }));
  };

  const handleToggleExcludeRow = (rowKey: string) => {
    setResolution((prev) => ({
      ...prev,
      excludedRowKeys: {
        ...prev.excludedRowKeys,
        [rowKey]: !prev.excludedRowKeys[rowKey]
      }
    }));
  };

  const handleSetCellOverride = (
    rowKey: string,
    dateIso: string,
    value: 'present' | 'absent' | 'ignored' | ''
  ) => {
    const key = `${rowKey}__${dateIso}`;
    setResolution((prev) => {
      const next = { ...prev.cellOverrides };
      if (!value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return {
        ...prev,
        cellOverrides: next
      };
    });
  };

  const handleSetConflictDecision = (
    conflictKey: string,
    decision: 'keep_existing' | 'overwrite_with_pdf'
  ) => {
    setResolution((prev) => ({
      ...prev,
      conflictDecisions: {
        ...prev.conflictDecisions,
        [conflictKey]: decision
      }
    }));
  };

  const handleBulkConflictsDecision = (decision: 'keep_existing' | 'overwrite_with_pdf') => {
    if (!plan) return;
    setResolution((prev) => {
      const next = { ...prev.conflictDecisions };
      for (const c of plan.conflicts) {
        next[c.key] = decision;
      }
      return {
        ...prev,
        conflictDecisions: next
      };
    });
  };

  const executeImportEntries = async (mode: 'new_only' | 'all_selected') => {
    if (!plan || isApplying) return;
    const stableOpId = importOperationId || generateUUID();
    if (!importOperationId) {
      setImportOperationId(stableOpId);
    }

    const baseEntries =
      mode === 'new_only'
        ? plan.toApply.filter((item) => !item.isOverwrite)
        : plan.toApply;

    if (baseEntries.length === 0) return;

    setIsApplying(true);
    setShowOverwriteConfirm(false);
    try {
      const entries = baseEntries.map((item) => ({
        studentId: item.studentId,
        fridayDate: item.fridayDate,
        isPresent: item.isPresent
      }));

      const res = await importAttendanceBatch(entries, { operationId: stableOpId });
      setExecutionResult({
        appliedCount: res.appliedCount,
        skippedDuplicateCount: res.skippedDuplicateCount + plan.unchangedDuplicates.length,
        blockedCount: res.blockedCount,
        futureBlockedCount: res.futureBlockedCount,
        queuedCount: res.queuedCount,
        wasOffline: !isOnline,
        syncReport: res.syncReport,
        error: res.error
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleConfirmNewOnlyImport = async () => {
    await executeImportEntries('new_only');
  };

  const handleConfirmSelectedOverwrite = async () => {
    if (!plan || isApplying) return;
    // If conflicts exist and none were manually toggled yet, promote them when the user explicitly confirms re-registration
    const hasSelectedOverwrites = plan.toApply.some((item) => item.isOverwrite);
    if (!hasSelectedOverwrites && plan.conflicts.length > 0) {
      const promotedConflicts = plan.conflicts.map((c) => ({
        studentId: c.studentId,
        fridayDate: c.fridayDate,
        isPresent: c.incomingPresent
      }));
      const newEntries = plan.toApply
        .filter((item) => !item.isOverwrite)
        .map((item) => ({
          studentId: item.studentId,
          fridayDate: item.fridayDate,
          isPresent: item.isPresent
        }));
      const mergedEntries = [...newEntries, ...promotedConflicts];
      if (mergedEntries.length === 0) return;

      const stableOpId = importOperationId || generateUUID();
      if (!importOperationId) setImportOperationId(stableOpId);

      setIsApplying(true);
      setShowOverwriteConfirm(false);
      try {
        handleBulkConflictsDecision('overwrite_with_pdf');
        const res = await importAttendanceBatch(mergedEntries, { operationId: stableOpId });
        setExecutionResult({
          appliedCount: res.appliedCount,
          skippedDuplicateCount: res.skippedDuplicateCount + plan.unchangedDuplicates.length,
          blockedCount: res.blockedCount,
          futureBlockedCount: res.futureBlockedCount,
          queuedCount: res.queuedCount,
          wasOffline: !isOnline,
          syncReport: res.syncReport,
          error: res.error
        });
      } finally {
        setIsApplying(false);
      }
      return;
    }

    await executeImportEntries('all_selected');
  };

  const renderStudentSelect = (row: ParsedPdfStudentRow, effectiveMatchedId: string | null) => {
    const candidates: Student[] = [];
    const seen = new Set<string>();
    for (const cid of row.candidateStudentIds) {
      const st = studentsById.get(cid);
      if (st && !seen.has(st.id)) {
        seen.add(st.id);
        candidates.push(st);
      }
    }
    const others = sortedAllStudents.filter((s) => !seen.has(s.id));

    return (
      <select
        aria-label={`اختيار المخدوم المطابق للصف ${row.extractedName}`}
        value={effectiveMatchedId || ''}
        onChange={(e) => handleSelectStudentMapping(row.rowKey, e.target.value)}
        className="w-full min-w-[165px] min-h-[40px] h-auto py-1.5 px-2.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] select-text focus:outline-none focus:border-[var(--accent-secondary)]"
      >
        <option value="">-- غير مطابق (لن يُستورد) --</option>
        {candidates.length > 0 && (
          <optgroup label="أسماء مرشحة مقترحة">
            {candidates.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name} ({st.code || 'بدون كود'})
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="جميع المخدومين">
          {others.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name} ({st.code || 'بدون كود'})
            </option>
          ))}
        </optgroup>
      </select>
    );
  };

  const renderCellBadgeAndControl = (row: ParsedPdfStudentRow, dateIso: string) => {
    const origCell = row.cells[dateIso];
    if (!origCell) {
      return <span className="text-[11px] text-[var(--text-muted)]">—</span>;
    }
    const effective = getEffectiveCellStatus(row.rowKey, dateIso, origCell.status, resolution);
    const hasOverride = Boolean(resolution.cellOverrides[`${row.rowKey}__${dateIso}`]);

    if (effective === 'present') {
      return (
        <div className="inline-flex flex-col items-center gap-1">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/15 border border-emerald-500/35 text-emerald-500 text-[11px] font-extrabold">
            <CheckCircle2 className="w-3 h-3 shrink-0" />
            حاضر
          </span>
          {hasOverride && (
            <button
              type="button"
              onClick={() => handleSetCellOverride(row.rowKey, dateIso, '')}
              className="text-[10px] text-[var(--text-muted)] hover:underline cursor-pointer"
            >
              تراجع
            </button>
          )}
        </div>
      );
    }

    if (effective === 'absent') {
      return (
        <div className="inline-flex flex-col items-center gap-1">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-500/15 border border-rose-500/35 text-rose-400 text-[11px] font-extrabold">
            <XCircle className="w-3 h-3 shrink-0" />
            غائب
          </span>
          {hasOverride && (
            <button
              type="button"
              onClick={() => handleSetCellOverride(row.rowKey, dateIso, '')}
              className="text-[10px] text-[var(--text-muted)] hover:underline cursor-pointer"
            >
              تراجع
            </button>
          )}
        </div>
      );
    }

    if (effective === 'empty' || effective === 'ignored') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-lg bg-[var(--surface-inset)] border border-[var(--border-color)] text-[var(--text-muted)] text-[10.5px] font-semibold">
          {effective === 'ignored' ? 'متجاهل' : 'فارغ'}
        </span>
      );
    }

    // 'unknown' or 'ambiguous' — strictly requires explicit review!
    return (
      <div className="flex flex-col items-center gap-1">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/15 border border-amber-400/45 text-[var(--warning-text)] text-[10.5px] font-extrabold">
          <HelpCircle className="w-3 h-3 shrink-0" />
          {origCell.rawText ? `مراجعة (${origCell.rawText})` : 'مراجعة'}
        </span>
        <div className="flex flex-wrap items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => handleSetCellOverride(row.rowKey, dateIso, 'present')}
            className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500 border border-emerald-500/30 text-[10px] font-bold cursor-pointer"
          >
            ح
          </button>
          <button
            type="button"
            onClick={() => handleSetCellOverride(row.rowKey, dateIso, 'absent')}
            className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30 text-[10px] font-bold cursor-pointer"
          >
            غ
          </button>
          <button
            type="button"
            onClick={() => handleSetCellOverride(row.rowKey, dateIso, 'ignored')}
            className="px-1.5 py-0.5 rounded bg-[var(--surface-inset)] text-[var(--text-muted)] border border-[var(--border-color)] text-[10px] font-bold cursor-pointer"
          >
            تجاهل
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-import-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/75 backdrop-blur-md animate-fadeIn select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="w-full max-w-6xl glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col max-h-[92vh] animate-wordIn">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 p-4 border-b border-[var(--border-color)] bg-[var(--surface-secondary)]/70 shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shrink-0">
              <FileUp className="w-5 h-5 shrink-0" />
            </div>
            <div className="min-w-0">
              <h3
                id="pdf-import-modal-title"
                className="font-extrabold text-base text-[var(--text-primary)] m-0 leading-snug"
              >
                استيراد كشف الحضور والغياب (PDF)
              </h3>
              <p className="text-[11px] font-semibold text-[var(--text-muted)] m-0 mt-0.5 break-words leading-snug">
                قراءة متعددة الصفحات والتواريخ RTL مع التحقق ومطابقة الأسماء والمزامنة الآمنة
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            disabled={isParsing || isApplying}
            aria-label="إغلاق نافذة استيراد PDF"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-secondary)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer shrink-0 disabled:opacity-50"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 overflow-y-auto space-y-4 flex-1 text-xs sm:text-sm">
          {/* File Upload Box */}
          {!report && !isParsing && (
            <div className="p-6 sm:p-8 rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface-primary)]/70 text-center space-y-3">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-[var(--surface-inset)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)]">
                <Upload className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-extrabold text-[var(--text-primary)] m-0">
                  اختر ملف PDF لكشف حضور وغياب المخدومين
                </p>
                <p className="text-xs text-[var(--text-muted)] m-0 max-w-xl mx-auto leading-relaxed">
                  يدعم الكشوف متعددة الصفحات وأعمدة التواريخ المتعددة (ح / غ) والبحث النصي أو OCR العربي للنسخ المصورة تلقائياً.
                </p>
              </div>
              <div className="pt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={handleFileChange}
                  className="hidden"
                  id="attendance-pdf-file-input"
                />
                <label
                  htmlFor="attendance-pdf-file-input"
                  className="glass-btn--primary btn--lens inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-extrabold cursor-pointer min-h-[42px]"
                >
                  <FileUp className="w-4 h-4" />
                  <span>اختيار ملف PDF من الجهاز</span>
                </label>
              </div>
            </div>
          )}

          {/* Parsing Progress */}
          {isParsing && (
            <div className="p-6 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-3 text-center">
              <Loader2 className="w-8 h-8 text-[var(--accent-secondary)] animate-spin mx-auto" />
              <p className="text-sm font-extrabold text-[var(--text-primary)] m-0">
                {parseProgressMsg || 'جاري قراءة وتحليل ملف الـ PDF...'}
              </p>
              <div className="w-full max-w-md mx-auto h-2.5 rounded-full bg-[var(--surface-inset)] overflow-hidden border border-[var(--border-color)]">
                <div
                  className="h-full bg-gradient-to-l from-[#20C7E8] to-[#267AFF] transition-all duration-300"
                  style={{ width: `${Math.max(8, parseProgressPct)}%` }}
                />
              </div>
              <p className="text-[11px] font-mono text-[var(--text-muted)] m-0 tabular-nums">
                {parseProgressPct}%
              </p>
            </div>
          )}

          {/* Parse Error */}
          {parseError && (
            <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/35 text-rose-400 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <p className="font-extrabold text-xs m-0">ملاحظة أثناء قراءة الملف</p>
                <p className="text-xs m-0 leading-relaxed">{parseError}</p>
              </div>
              <button
                type="button"
                onClick={handleReset}
                className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 cursor-pointer"
              >
                ملف آخر
              </button>
            </div>
          )}

          {/* Post-Import Result Summary */}
          {executionResult && (
            <div
              className={`p-4 rounded-2xl border space-y-2.5 ${
                executionResult.error
                  ? 'bg-rose-500/10 border-rose-500/40'
                  : executionResult.syncReport?.outcome === 'timeout_unknown'
                  ? 'bg-amber-500/10 border-amber-500/40'
                  : 'bg-[var(--surface-primary)] border-[var(--accent-secondary)]/50'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {executionResult.error ? (
                    <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
                  ) : executionResult.syncReport?.outcome === 'timeout_unknown' ? (
                    <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                  ) : (
                    <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0" />
                  )}
                  <h4 className="text-sm font-extrabold text-[var(--text-primary)] m-0">
                    {executionResult.error
                      ? 'تعذر إتمام الاستيراد'
                      : executionResult.wasOffline
                      ? 'تم الحفظ محلياً في وضع عدم الاتصال'
                      : executionResult.syncReport?.success
                      ? 'تم الاستيراد وتأكيد التسجيل في Google Sheets بنجاح'
                      : executionResult.syncReport?.outcome === 'timeout_unknown'
                      ? 'تم الحفظ محلياً — انتهت مهلة الاتصال (العملية معلقة لإعادة التحقق)'
                      : executionResult.syncReport?.outcome === 'failed'
                      ? 'تم الحفظ محلياً — تعذر الإرسال للشيت مؤقتاً'
                      : 'تم حفظ السجلات محلياً وإدراجها في طابور المزامنة'}
                  </h4>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsSyncModalOpen(true)}
                    className="glass-btn min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${syncState === 'syncing' ? 'animate-spin' : ''}`} />
                    <span>تفاصيل المزامنة ({pendingMutationsCount} معلق)</span>
                  </button>
                  {isOnline && pendingMutationsCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void processOfflineQueue()}
                      className="glass-btn--primary min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-extrabold cursor-pointer"
                    >
                      إرسال للشيت الآن
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)]">
                  <span className="block text-[10px] text-[var(--text-muted)]">سجلات محفوظة</span>
                  <strong className="font-mono tabular-nums text-emerald-500 text-sm">
                    {executionResult.appliedCount}
                  </strong>
                </div>
                <div className="p-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)]">
                  <span className="block text-[10px] text-[var(--text-muted)]">مؤكد بالخادم</span>
                  <strong className="font-mono tabular-nums text-emerald-500 text-sm">
                    {executionResult.syncReport?.sentCount ?? 0}
                  </strong>
                </div>
                <div className="p-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)]">
                  <span className="block text-[10px] text-[var(--text-muted)]">مكرر تم تخطيه</span>
                  <strong className="font-mono tabular-nums text-[var(--text-primary)] text-sm">
                    {executionResult.skippedDuplicateCount}
                  </strong>
                </div>
                <div className="p-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)]">
                  <span className="block text-[10px] text-[var(--text-muted)]">معلق للمزامنة</span>
                  <strong className="font-mono tabular-nums text-[var(--accent-secondary)] text-sm">
                    {pendingMutationsCount}
                  </strong>
                </div>
              </div>

              {executionResult.syncReport && (
                <p className="text-[11px] font-mono text-[var(--text-secondary)] m-0">
                  الوضع: {executionResult.syncReport.mode === 'batch' ? 'دفعة مجمعة' : executionResult.syncReport.mode === 'mixed' ? 'مختلط' : 'فردي'}
                  {' · '}الزمن: {executionResult.syncReport.totalDurationMs}ms
                  {executionResult.syncReport.verifiedPostTimeoutCount > 0
                    ? ` · تم تأكيد ${executionResult.syncReport.verifiedPostTimeoutCount} بالتحقق بعد Timeout`
                    : ''}
                  {executionResult.syncReport.lastError ? ` · ${executionResult.syncReport.lastError}` : ''}
                </p>
              )}

              {executionResult.error && (
                <p className="text-xs text-rose-400 m-0">{executionResult.error}</p>
              )}
            </div>
          )}

          {/* Main Report & Plan Review */}
          {report && plan && (
            <>
              {/* Report Meta + Diagnostics Toggle + Switch File */}
              <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-xs min-w-0">
                  <span className="inline-flex items-center gap-1.5 font-extrabold text-[var(--text-primary)] min-w-0 break-all">
                    <FileSpreadsheet className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
                    {report.fileName}
                  </span>
                  <span className="text-[11px] font-bold text-[var(--text-muted)] tabular-nums">
                    {report.pageCount} صفحات ·{' '}
                    {report.extractionMode === 'ocr' ? 'OCR عربي' : 'استخراج نصي + إحداثيات'}
                    {report.diagnostics?.tableDirection && report.diagnostics.tableDirection !== 'unknown'
                      ? ` · ${report.diagnostics.tableDirection.toUpperCase()}`
                      : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowDiagnostics((v) => !v)}
                    className="glass-btn min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                    <span>{showDiagnostics ? 'إخفاء التشخيص' : 'التقرير التشخيصي للجدول'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={isApplying}
                    className="glass-btn min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer"
                  >
                    اختيار ملف آخر
                  </button>
                </div>
              </div>

              {/* Mandatory Extraction Diagnostic Report */}
              {showDiagnostics && report.diagnostics && (
                <section
                  aria-label="التقرير التشخيصي لتحليل جدول الـ PDF"
                  className="p-4 rounded-2xl bg-[var(--surface-inset)] border border-[var(--border-strong)] space-y-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-color)] pb-2">
                    <strong className="text-[var(--text-primary)] font-extrabold">
                      التقرير التشخيصي لتحليل الجدول (PDF.js Coordinates Diagnostic)
                    </strong>
                    <span className="font-mono text-[11px] text-[var(--text-muted)] tabular-nums">
                      المرحلة: {report.diagnostics.stageReached} · الاتجاه: {report.diagnostics.tableDirection}
                    </span>
                  </div>

                  {report.diagnostics.failureReason && (
                    <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/35 text-rose-400 font-bold">
                      سبب التوقف ({report.diagnostics.failureStage}): {report.diagnostics.failureReason}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">عدد الصفحات</span>
                      <strong className="font-mono tabular-nums text-[var(--text-primary)]">
                        {report.diagnostics.pageCount}
                      </strong>
                    </div>
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">Text Items</span>
                      <strong className="font-mono tabular-nums text-[var(--text-primary)]">
                        {report.diagnostics.totalTextItems}
                      </strong>
                    </div>
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">الصفوف المجمعة</span>
                      <strong className="font-mono tabular-nums text-[var(--text-primary)]">
                        {report.diagnostics.totalRowClusters}
                      </strong>
                    </div>
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">الأسماء المستخرجة</span>
                      <strong className="font-mono tabular-nums text-[var(--accent-secondary)]">
                        {report.diagnostics.extractedStudentsCount}
                      </strong>
                    </div>
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">حالات الحضور (ح)</span>
                      <strong className="font-mono tabular-nums text-emerald-500">
                        {report.diagnostics.presentCount}
                      </strong>
                    </div>
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">حالات الغياب (غ)</span>
                      <strong className="font-mono tabular-nums text-rose-400">
                        {report.diagnostics.absentCount}
                      </strong>
                    </div>
                    <div className="p-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10px] text-[var(--text-muted)]">الخلايا الفارغة</span>
                      <strong className="font-mono tabular-nums text-[var(--text-muted)]">
                        {report.diagnostics.emptyCount}
                      </strong>
                    </div>
                  </div>

                  {report.diagnostics.issues.length > 0 && (
                    <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-400/35 text-[var(--warning-text)] space-y-1">
                      <strong className="block text-[11px]">ملاحظات وتعارضات إعادة البناء:</strong>
                      {report.diagnostics.issues.map((issue, idx) => (
                        <p key={idx} className="m-0 text-[11px]">
                          • {issue}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {report.diagnostics.pages.map((pg) => (
                      <div
                        key={pg.pageNumber}
                        className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <strong className="text-[var(--text-primary)]">
                            صفحة {pg.pageNumber} ({pg.pageWidth}×{pg.pageHeight})
                          </strong>
                          <span className="font-mono text-[var(--text-muted)] tabular-nums">
                            عناصر: {pg.textItemsCount} · صفوف: {pg.rowClustersCount} · خطوط شبكة: V{pg.verticalGridLinesCount}/H{pg.horizontalGridLinesCount} · أسماء: {pg.extractedStudentsCount} · ح:{pg.presentCount} غ:{pg.absentCount} فارغ:{pg.emptyCount}
                          </span>
                        </div>
                        {pg.detectedDates.length > 0 && (
                          <div className="text-[10.5px] text-[var(--text-secondary)] font-mono flex flex-wrap gap-2">
                            <span>التواريخ:</span>
                            {pg.dateColumnCoordinates.map((dc) => (
                              <span
                                key={dc.dateIso}
                                className="px-1.5 py-0.5 rounded bg-[var(--surface-inset)] border border-[var(--border-color)]"
                              >
                                {dc.headerLabel} [X:{dc.xMin}..{dc.xMax}]
                              </span>
                            ))}
                          </div>
                        )}
                        {pg.sampleExtractedLines.length > 0 && (
                          <div className="text-[10.5px] text-[var(--text-muted)] space-y-0.5">
                            <span className="font-bold">عينة صفوف مستخرجة:</span>
                            {pg.sampleExtractedLines.slice(0, 3).map((line, lIdx) => (
                              <p key={lIdx} className="m-0 truncate font-mono text-[10px]">
                                {lIdx + 1}: {line}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Overall Extraction Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                  <span className="block text-[11px] text-[var(--text-muted)]">إجمالي المخدومين بالملف</span>
                  <strong className="text-base font-extrabold font-mono tabular-nums text-[var(--text-primary)]">
                    {report.stats.totalStudents}
                  </strong>
                </div>
                <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                  <span className="block text-[11px] text-[var(--text-muted)]">أعمدة التواريخ</span>
                  <strong className="text-base font-extrabold font-mono tabular-nums text-[var(--accent-secondary)]">
                    {report.extractedDates.length}
                  </strong>
                </div>
                <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                  <span className="block text-[11px] text-[var(--text-muted)]">مطابقة تلقائية</span>
                  <strong className="text-base font-extrabold font-mono tabular-nums text-emerald-500">
                    {report.stats.matchedCount}
                  </strong>
                </div>
                <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                  <span className="block text-[11px] text-[var(--text-muted)]">يحتاج مراجعة اسم</span>
                  <strong className="text-base font-extrabold font-mono tabular-nums text-[var(--warning-text)]">
                    {report.stats.needsReviewCount}
                  </strong>
                </div>
                <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                  <span className="block text-[11px] text-[var(--text-muted)]">خلايا غير واضحة/فارغة</span>
                  <strong className="text-base font-extrabold font-mono tabular-nums text-[var(--text-primary)]">
                    {report.stats.unknownOrAmbiguousCellsCount} / {report.stats.emptyCellsCount}
                  </strong>
                </div>
                <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                  <span className="block text-[11px] text-[var(--text-muted)]">سيتم حفظه الآن</span>
                  <strong className="text-base font-extrabold font-mono tabular-nums text-emerald-500">
                    {plan.toApply.length}
                  </strong>
                </div>
              </div>

              {/* Dynamic Per-Date Breakdown */}
              {report.extractedDates.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-extrabold text-[var(--text-secondary)] m-0 flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5 text-[var(--accent-secondary)]" />
                    تفصيل كل تاريخ حضور مُستخرج ديناميكياً
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    {report.extractedDates.map((dCol) => {
                      const dStats = report.stats.perDateStats[dCol.date] || {
                        present: 0,
                        absent: 0,
                        empty: 0,
                        review: 0
                      };
                      const planStats = plan.summaryByDate[dCol.date] || {
                        newCount: 0,
                        overwriteCount: 0,
                        duplicateCount: 0,
                        conflictCount: 0
                      };
                      return (
                        <div
                          key={dCol.date}
                          className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <strong className="font-mono tabular-nums text-xs text-[var(--text-primary)]">
                              {dCol.headerLabel}
                            </strong>
                            <span className="font-mono text-[10px] text-[var(--text-muted)]">{dCol.date}</span>
                          </div>
                          <div className="grid grid-cols-4 gap-1 text-center text-[10.5px] font-bold">
                            <div className="p-1 rounded-lg bg-emerald-500/10 text-emerald-500 tabular-nums">
                              ح: {dStats.present}
                            </div>
                            <div className="p-1 rounded-lg bg-rose-500/10 text-rose-400 tabular-nums">
                              غ: {dStats.absent}
                            </div>
                            <div className="p-1 rounded-lg bg-[var(--surface-inset)] text-[var(--text-muted)] tabular-nums">
                              ف: {dStats.empty}
                            </div>
                            <div className="p-1 rounded-lg bg-amber-500/10 text-[var(--warning-text)] tabular-nums">
                              م: {dStats.review}
                            </div>
                          </div>
                          <p className="text-[10px] text-[var(--text-muted)] m-0 tabular-nums">
                            جديد: {planStats.newCount} · مكرر: {planStats.duplicateCount} · تعارض: {planStats.conflictCount}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Pre-Check Alert when previously recorded attendance is detected (Student ID + Attendance Date) */}
              {plan.hasPreviouslyRecordedData && (
                <section
                  aria-label="تنبيه: توجد بيانات مسجلة بالفعل"
                  className="p-4 rounded-2xl bg-amber-500/12 border border-amber-500/45 space-y-3 shadow-xs"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-[var(--warning-text)] shrink-0 mt-0.5" />
                    <div className="space-y-1 flex-1">
                      <h4 className="text-sm font-extrabold text-[var(--warning-text)] m-0">
                        تنبيه: توجد بيانات مسجلة بالفعل
                      </h4>
                      <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                        تم فحص الملف بالكامل ومطابقة كل مخدوم عبر المعرف الفعلي وتاريخ الجمعة قبل الحفظ لمنع التكرار أو استبدال السجلات القديمة تلقائياً.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[11px] text-[var(--text-muted)]">عدد السجلات الموجودة بالفعل</span>
                      <strong className="font-mono tabular-nums text-base text-[var(--text-primary)]">
                        {plan.existingRecordedCount}
                      </strong>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[11px] text-[var(--text-muted)]">عدد السجلات الجديدة</span>
                      <strong className="font-mono tabular-nums text-base text-emerald-500">
                        {plan.newRecordsCount}
                      </strong>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[11px] text-[var(--text-muted)]">عدد السجلات المتعارضة في الحالة</span>
                      <strong className="font-mono tabular-nums text-base text-[var(--warning-text)]">
                        {plan.conflictingRecordsCount}
                      </strong>
                    </div>
                  </div>

                  {/* Three Explicit User Choices */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={isApplying || plan.newRecordsCount === 0}
                      onClick={handleConfirmNewOnlyImport}
                      className="glass-btn--primary btn--lens px-4 py-2 rounded-xl text-xs font-extrabold cursor-pointer min-h-[40px] inline-flex items-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>إضافة السجلات الجديدة فقط ({plan.newRecordsCount})</span>
                    </button>

                    {(plan.conflictingRecordsCount > 0 || plan.toApply.some((item) => item.isOverwrite)) && (
                      <button
                        type="button"
                        disabled={isApplying}
                        onClick={() => setShowOverwriteConfirm(true)}
                        className="glass-btn px-4 py-2 rounded-xl text-xs font-extrabold text-[var(--warning-text)] border-amber-500/45 cursor-pointer min-h-[40px] inline-flex items-center gap-1.5 disabled:opacity-45"
                      >
                        <RefreshCw className="w-4 h-4 shrink-0" />
                        <span>إعادة تسجيل السجلات المحددة</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isApplying}
                      onClick={handleCancelImport}
                      className="glass-btn px-4 py-2 rounded-xl text-xs font-bold text-rose-400 border-rose-500/35 cursor-pointer min-h-[40px] inline-flex items-center gap-1.5"
                    >
                      <XCircle className="w-4 h-4 shrink-0" />
                      <span>إلغاء الاستيراد</span>
                    </button>
                  </div>
                </section>
              )}

              {/* Verification & Absence Discrepancy Warnings */}
              {report.warnings.length > 0 && (
                <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-400/40 text-[var(--warning-text)] space-y-1">
                  {report.warnings.map((w, idx) => (
                    <p key={idx} className="text-xs font-bold m-0 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </p>
                  ))}
                </div>
              )}

              {/* Explicit Conflict Resolution Panel */}
              {plan.conflicts.length > 0 && (
                <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-amber-400/45 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--warning-text)]">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>
                        يوجد {plan.conflicts.length} تعارض مع سجلات حضور مسجلة مسبقاً في النظام
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleBulkConflictsDecision('keep_existing')}
                        className="glass-btn px-2.5 py-1 rounded-xl text-[11px] font-bold cursor-pointer"
                      >
                        الاحتفاظ بالحالي للكل
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBulkConflictsDecision('overwrite_with_pdf')}
                        className="glass-btn px-2.5 py-1 rounded-xl text-[11px] font-bold text-amber-500 cursor-pointer"
                      >
                        اعتماد PDF للكل
                      </button>
                    </div>
                  </div>

                  <div className="max-h-44 overflow-y-auto space-y-1.5">
                    {plan.conflicts.map((c) => (
                      <div
                        key={c.key}
                        className="p-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <strong className="text-[var(--text-primary)]">{c.studentName}</strong>{' '}
                          <span className="font-mono text-[11px] text-[var(--text-muted)]">({c.fridayDate})</span>
                          <span className="block text-[11px] text-[var(--text-secondary)]">
                            الحالي: {c.existingPresent ? 'حاضر' : 'غائب'} ← الـ PDF: {c.incomingPresent ? 'حاضر' : 'غائب'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleSetConflictDecision(c.key, 'keep_existing')}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer ${
                              c.decision === 'keep_existing'
                                ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]'
                                : 'bg-[var(--surface-primary)] text-[var(--text-secondary)] border-[var(--border-color)]'
                            }`}
                          >
                            إبقاء الحالي
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetConflictDecision(c.key, 'overwrite_with_pdf')}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer ${
                              c.decision === 'overwrite_with_pdf'
                                ? 'bg-amber-600 text-white border-amber-600'
                                : 'bg-[var(--surface-primary)] text-[var(--text-secondary)] border-[var(--border-color)]'
                            }`}
                          >
                            استبدال بالـ PDF
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Filter Tabs for Extracted Rows */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRowFilter('all')}
                    className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer ${
                      rowFilter === 'all'
                        ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]'
                        : 'bg-[var(--surface-primary)] text-[var(--text-secondary)] border-[var(--border-color)]'
                    }`}
                  >
                    الكل ({report.rows.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setRowFilter('review')}
                    className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer ${
                      rowFilter === 'review'
                        ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]'
                        : 'bg-[var(--surface-primary)] text-[var(--text-secondary)] border-[var(--border-color)]'
                    }`}
                  >
                    يحتاج مراجعة
                  </button>
                  <button
                    type="button"
                    onClick={() => setRowFilter('matched')}
                    className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer ${
                      rowFilter === 'matched'
                        ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]'
                        : 'bg-[var(--surface-primary)] text-[var(--text-secondary)] border-[var(--border-color)]'
                    }`}
                  >
                    مطابق ({report.rows.filter((r) => Boolean(getEffectiveMatchedStudentId(r.rowKey, r.matchedStudentId, resolution))).length})
                  </button>
                </div>

                <span className="text-[11px] font-semibold text-[var(--text-muted)]">
                  لا يتم المساس بأرقام التليفونات أو العناوين عند الاستيراد
                </span>
              </div>

              {/* Mobile Review Cards (< lg) */}
              <div className="lg:hidden space-y-2.5">
                {visibleRows.map((row) => {
                  const effectiveMatchedId = getEffectiveMatchedStudentId(
                    row.rowKey,
                    row.matchedStudentId,
                    resolution
                  );
                  const isExcluded = Boolean(resolution.excludedRowKeys[row.rowKey]);

                  return (
                    <article
                      key={row.rowKey}
                      className={`p-3 rounded-2xl border space-y-2.5 ${
                        isExcluded
                          ? 'opacity-55 bg-[var(--surface-inset)] border-[var(--border-color)]'
                          : 'bg-[var(--surface-primary)] border-[var(--border-color)]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[10px] font-mono text-[var(--text-muted)] m-0">
                            صفحة {row.pageNumber} · {row.matchStatus === 'exact' ? 'مطابقة دقيقة' : row.matchStatus === 'ambiguous' ? 'تشابه أسماء' : row.matchStatus === 'needs_review' ? 'اسم قريب يحتاج تأكيد' : 'غير مطابق'}
                          </p>
                          <h5 className="text-xs font-extrabold text-[var(--text-primary)] m-0 break-words">
                            {row.extractedName}
                          </h5>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleExcludeRow(row.rowKey)}
                          className="glass-btn px-2.5 py-1 rounded-lg text-[11px] font-bold shrink-0 cursor-pointer"
                        >
                          {isExcluded ? 'إعادة تضمين' : 'استبعاد'}
                        </button>
                      </div>

                      {!isExcluded && renderStudentSelect(row, effectiveMatchedId)}

                      <div className="grid grid-cols-2 gap-1.5">
                        {report.extractedDates.map((dCol) => (
                          <div
                            key={dCol.date}
                            className="p-2 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)] flex items-center justify-between gap-1"
                          >
                            <span className="font-mono text-[10.5px] font-bold text-[var(--text-secondary)]">
                              {dCol.headerLabel}
                            </span>
                            {renderCellBadgeAndControl(row, dCol.date)}
                          </div>
                        ))}
                      </div>

                      {row.reportedAbsenceCount !== null && (
                        <p
                          className={`text-[10.5px] font-bold m-0 tabular-nums ${
                            row.hasAbsenceCountMismatch ? 'text-[var(--warning-text)]' : 'text-[var(--text-muted)]'
                          }`}
                        >
                          تحقق الغياب: محسوب {row.extractedAbsentCount} / بالكشف {row.reportedAbsenceCount}
                          {row.hasAbsenceCountMismatch ? ' (اختلاف للتحقق فقط)' : ''}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>

              {/* Desktop Review Table (>= lg) */}
              <div className="hidden lg:block overflow-x-auto rounded-2xl border border-[var(--border-color)] bg-[var(--surface-primary)]">
                <table className="w-full text-right text-xs border-collapse">
                  <thead>
                    <tr className="bg-[var(--table-header-bg)] border-b border-[var(--border-color)] text-[var(--text-secondary)] font-extrabold">
                      <th className="py-2.5 px-3">الصفحة</th>
                      <th className="py-2.5 px-3">الاسم بالكشف</th>
                      <th className="py-2.5 px-3">المطابقة في النظام</th>
                      {report.extractedDates.map((dCol) => (
                        <th key={dCol.date} className="py-2.5 px-2.5 text-center font-mono whitespace-nowrap">
                          {dCol.headerLabel}
                        </th>
                      ))}
                      <th className="py-2.5 px-2.5 text-center whitespace-nowrap">تحقق الغياب</th>
                      <th className="py-2.5 px-2.5 text-center">تضمين</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-color)]">
                    {visibleRows.map((row) => {
                      const effectiveMatchedId = getEffectiveMatchedStudentId(
                        row.rowKey,
                        row.matchedStudentId,
                        resolution
                      );
                      const isExcluded = Boolean(resolution.excludedRowKeys[row.rowKey]);

                      return (
                        <tr
                          key={row.rowKey}
                          className={`${isExcluded ? 'opacity-50' : 'hover:bg-[var(--table-row-hover)]'} transition-colors`}
                        >
                          <td className="py-2.5 px-3 font-mono text-[var(--text-muted)] tabular-nums">
                            {row.pageNumber}
                          </td>
                          <td className="py-2.5 px-3">
                            <span className="block font-extrabold text-[var(--text-primary)]">{row.extractedName}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">
                              {row.matchStatus === 'exact' ? (
                                <span className="inline-flex items-center gap-1 text-emerald-500 font-bold">
                                  <UserCheck className="w-3 h-3" /> مطابقة دقيقة
                                </span>
                              ) : row.matchStatus === 'ambiguous' ? (
                                <span className="text-[var(--warning-text)] font-bold">اسم مكرر بالقاعدة</span>
                              ) : row.matchStatus === 'needs_review' ? (
                                <span className="text-[var(--warning-text)] font-bold">مرشح تقريبي (يتطلب تأكيد)</span>
                              ) : (
                                <span className="text-rose-400 font-bold">غير موجود بالقاعدة</span>
                              )}
                            </span>
                          </td>
                          <td className="py-2.5 px-3">
                            {isExcluded ? (
                              <span className="text-[11px] text-[var(--text-muted)]">مستبعد من الاستيراد</span>
                            ) : (
                              renderStudentSelect(row, effectiveMatchedId)
                            )}
                          </td>
                          {report.extractedDates.map((dCol) => (
                            <td key={dCol.date} className="py-2.5 px-2.5 text-center">
                              {renderCellBadgeAndControl(row, dCol.date)}
                            </td>
                          ))}
                          <td className="py-2.5 px-2.5 text-center font-mono tabular-nums">
                            {row.reportedAbsenceCount === null ? (
                              <span className="text-[var(--text-muted)]">—</span>
                            ) : (
                              <span
                                className={
                                  row.hasAbsenceCountMismatch
                                    ? 'text-[var(--warning-text)] font-extrabold'
                                    : 'text-[var(--text-secondary)] font-bold'
                                }
                              >
                                {row.extractedAbsentCount}/{row.reportedAbsenceCount}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleToggleExcludeRow(row.rowKey)}
                              className="glass-btn px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer"
                            >
                              {isExcluded ? 'تضمين' : 'استبعاد'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Explicit Confirmation Dialog for Re-registering Selected Old Records */}
        {showOverwriteConfirm && plan && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pdf-overwrite-confirm-title"
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn"
          >
            <div className="w-full max-w-md glass-strong rounded-3xl p-5 border border-amber-500/45 shadow-[var(--shadow-lg)] space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center text-[var(--warning-text)] shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div className="space-y-1.5">
                  <h4 id="pdf-overwrite-confirm-title" className="text-sm font-extrabold text-[var(--text-primary)] m-0">
                    تأكيد إعادة تسجيل السجلات المحددة
                  </h4>
                  <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                    سيؤدي هذا الإجراء إلى تعديل واستبدال السجلات القديمة المسجلة مسبقاً بنفس تاريخ الحضور بناءً على بيانات ملف الـ PDF:
                  </p>
                  <ul className="text-xs text-[var(--text-secondary)] m-0 pr-4 space-y-1">
                    <li>
                      • سجلات متعارضة سيتم تحديث حالتها:{' '}
                      <strong className="font-mono text-[var(--warning-text)]">
                        {plan.toApply.some((i) => i.isOverwrite)
                          ? plan.toApply.filter((i) => i.isOverwrite).length
                          : plan.conflictingRecordsCount}
                      </strong>
                    </li>
                    <li>
                      • سجلات جديدة ستُضاف معها:{' '}
                      <strong className="font-mono text-emerald-500">{plan.newRecordsCount}</strong>
                    </li>
                    <li>• السجلات المطابقة تماماً بدون اختلاف ستظل محمية دون تكرار.</li>
                  </ul>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--border-color)]">
                <button
                  type="button"
                  disabled={isApplying}
                  onClick={() => setShowOverwriteConfirm(false)}
                  className="glass-btn px-4 py-2 rounded-xl text-xs font-bold cursor-pointer min-h-[40px]"
                >
                  تراجع
                </button>
                <button
                  type="button"
                  disabled={isApplying}
                  onClick={handleConfirmSelectedOverwrite}
                  className="glass-btn--primary btn--lens px-4 py-2 rounded-xl text-xs font-extrabold cursor-pointer min-h-[40px] inline-flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>موافق — تنفيذ التعديل والاستيراد</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="p-3.5 border-t border-[var(--border-color)] flex flex-wrap items-center justify-between gap-3 bg-[var(--surface-secondary)]/70 shrink-0">
          <div className="text-[11px] text-[var(--text-muted)] font-semibold flex items-center gap-2 min-w-0">
            <Users className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
            {plan ? (
              <span className="min-w-0 break-words">
                جاهز للحفظ: <strong className="text-[var(--text-primary)] tabular-nums">{plan.toApply.length}</strong> سجل
                {plan.unresolvedCellsCount > 0 ? ` · ${plan.unresolvedCellsCount} خلية لم تُحسم` : ''}
                {plan.skippedUnmatchedRowsCount > 0 ? ` · ${plan.skippedUnmatchedRowsCount} صف غير مطابق` : ''}
              </span>
            ) : (
              <span>ارفع كشف PDF لمعاينة التواريخ والمطابقة قبل أي حفظ</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={report ? handleCancelImport : handleClose}
              disabled={isParsing || isApplying}
              className="glass-btn px-4 py-2 rounded-xl text-xs font-bold cursor-pointer min-h-[40px]"
            >
              {report ? 'إلغاء الاستيراد' : 'إغلاق'}
            </button>
            {report && plan && (
              <>
                {plan.toApply.some((i) => i.isOverwrite) ? (
                  <button
                    type="button"
                    disabled={isApplying || plan.toApply.length === 0}
                    onClick={() => setShowOverwriteConfirm(true)}
                    className="glass-btn--primary btn--lens px-5 py-2 rounded-xl text-xs font-extrabold cursor-pointer min-h-[40px] inline-flex items-center gap-2 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {isApplying ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        <span>جاري الحفظ...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>إعادة تسجيل السجلات المحددة ({plan.toApply.length})</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isApplying || plan.newRecordsCount === 0}
                    onClick={handleConfirmNewOnlyImport}
                    className="glass-btn--primary btn--lens px-5 py-2 rounded-xl text-xs font-extrabold cursor-pointer min-h-[40px] inline-flex items-center gap-2 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {isApplying ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        <span>جاري الحفظ...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>
                          {plan.hasPreviouslyRecordedData
                            ? `إضافة السجلات الجديدة فقط (${plan.newRecordsCount})`
                            : `تأكيد واستيراد (${plan.toApply.length})`}
                        </span>
                      </>
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
