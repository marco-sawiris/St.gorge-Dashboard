import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import {
  BackupPreviewSummary,
  LastBackupMeta,
  exportAndDownloadBackup,
  loadLastBackupMeta,
  previewBackupRestore,
  restoreVerifiedBackupFromJson
} from '../../services/backupService';
import { DatabaseStoreSummary, SafeMergeRestoreResult, idbInspectDatabaseSummary } from '../../services/indexedDbService';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  HardDriveDownload,
  History,
  ShieldCheck,
  Upload,
  X
} from 'lucide-react';

function formatArabicDateTime(iso?: string | null): string {
  if (!iso) return 'لم يتم إنشاء نسخة احتياطية بعد';
  try {
    return new Date(iso).toLocaleString('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  } catch {
    return iso;
  }
}

export const BackupRestoreModal: React.FC = () => {
  const {
    isBackupModalOpen,
    setIsBackupModalOpen,
    reloadLocalDatabaseState,
    addNotification
  } = useApp();

  const [dbSummary, setDbSummary] = useState<DatabaseStoreSummary | null>(null);
  const [lastBackupMeta, setLastBackupMeta] = useState<LastBackupMeta | null>(() => loadLastBackupMeta());
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{
    type: 'success' | 'danger';
    message: string;
    meta?: LastBackupMeta;
  } | null>(null);

  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [pendingRawJson, setPendingRawJson] = useState<string | null>(null);
  const [restorePreview, setRestorePreview] = useState<BackupPreviewSummary | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [verifiedRestoreResult, setVerifiedRestoreResult] = useState<SafeMergeRestoreResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshAuditSummary = async () => {
    try {
      const summary = await idbInspectDatabaseSummary();
      setDbSummary(summary);
    } catch {
      // Non-fatal UI refresh error
    }
    setLastBackupMeta(loadLastBackupMeta());
  };

  useEffect(() => {
    if (!isBackupModalOpen) return;
    setExportStatus(null);
    setRestoreError(null);
    setVerifiedRestoreResult(null);
    void refreshAuditSummary();
  }, [isBackupModalOpen]);

  if (!isBackupModalOpen) return null;

  const handleClose = () => {
    if (isExporting || isRestoring) return;
    setPendingRawJson(null);
    setRestorePreview(null);
    setSelectedFileName('');
    setRestoreError(null);
    setIsBackupModalOpen?.(false);
  };

  const handleCreateBackup = async () => {
    if (isExporting || isRestoring) return;
    setIsExporting(true);
    setExportStatus(null);
    try {
      const res = await exportAndDownloadBackup();
      if (!res.ok || !res.meta) {
        setExportStatus({
          type: 'danger',
          message: res.error || 'تعذر التحقق من إنشاء وتنزيل النسخة الاحتياطية.'
        });
        return;
      }

      setLastBackupMeta(res.meta);
      await refreshAuditSummary();
      setExportStatus({
        type: 'success',
        message: `تم إنشاء النسخة الاحتياطية والتحقق من سلامتها وتنزيلها بنجاح (${res.meta.totalRecords} سجل).`,
        meta: res.meta
      });
      addNotification(
        'تم إنشاء نسخة احتياطية JSON',
        `تم حفظ وتنزيل ${res.meta.totalRecords} سجل في ${res.meta.fileName}`,
        'success'
      );
    } catch (err: any) {
      setExportStatus({
        type: 'danger',
        message: err?.message || 'حدث خطأ غير متوقع أثناء إنشاء النسخة الاحتياطية.'
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleSelectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setRestoreError(null);
    setVerifiedRestoreResult(null);
    setRestorePreview(null);
    setPendingRawJson(null);
    setSelectedFileName(file.name);

    try {
      const rawText = await file.text();
      const previewResult = await previewBackupRestore(rawText);
      if (!previewResult.valid) {
        setRestoreError(previewResult.error);
        return;
      }
      setPendingRawJson(rawText);
      setRestorePreview(previewResult.preview);
    } catch (err: any) {
      setRestoreError(err?.message || 'تعذر قراءة ملف النسخة الاحتياطية المحدد.');
    }
  };

  const handleCancelRestorePreview = () => {
    setPendingRawJson(null);
    setRestorePreview(null);
    setSelectedFileName('');
    setRestoreError(null);
  };

  const handleConfirmRestore = async () => {
    if (!pendingRawJson || isRestoring || isExporting) return;
    setIsRestoring(true);
    setRestoreError(null);
    setVerifiedRestoreResult(null);

    try {
      const result = await restoreVerifiedBackupFromJson(pendingRawJson);
      if (!result.ok || !result.mergeResult || !result.mergeResult.verified) {
        setRestoreError(result.error || 'تعذر إتمام الاستعادة أو التحقق من سلامتها. تم الاحتفاظ ببياناتك الحالية.');
        return;
      }

      if (reloadLocalDatabaseState) {
        await reloadLocalDatabaseState();
      }
      await refreshAuditSummary();

      setVerifiedRestoreResult(result.mergeResult);
      setPendingRawJson(null);
      setRestorePreview(null);

      const addedTotal =
        result.mergeResult.stats.students.inserted +
        result.mergeResult.stats.followup.inserted +
        result.mergeResult.stats.mutations.inserted +
        result.mergeResult.stats.attendance_history.inserted;

      const updatedTotal =
        result.mergeResult.stats.students.updated +
        result.mergeResult.stats.followup.updated +
        result.mergeResult.stats.mutations.updated +
        result.mergeResult.stats.attendance_history.updated;

      addNotification(
        'تمت استعادة النسخة الاحتياطية بأمان',
        `تم التحقق من الدمج الآمن محلياً: إضافة ${addedTotal} سجل، وتحديث ${updatedTotal} سجل، مع حماية كافة البيانات الحالية.`,
        'success'
      );
    } catch (err: any) {
      setRestoreError(err?.message || 'حدث خطأ أثناء الاستعادة. لم يتم تعديل بياناتك الحالية.');
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-restore-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-md animate-fadeIn select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div className="w-full max-w-2xl glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="px-4 sm:px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between gap-2 bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shrink-0">
              <HardDriveDownload className="w-5 h-5 shrink-0" />
            </div>
            <div className="min-w-0">
              <h3
                id="backup-restore-modal-title"
                className="font-extrabold text-base text-[var(--text-primary)] m-0 leading-snug"
              >
                النسخ الاحتياطي والاستعادة الآمنة (JSON)
              </h3>
              <p className="text-[11.5px] font-semibold text-[var(--text-muted)] m-0 mt-0.5 leading-snug">
                تصدير Snapshot متسق واستعادة بالدمج الآمن محلياً بدون مسح البيانات أو تعديل Google Sheets
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            disabled={isExporting || isRestoring}
            aria-label="إغلاق نافذة النسخ الاحتياطي والاستعادة"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-secondary)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer shrink-0 disabled:opacity-50"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1 text-xs sm:text-sm">
          {/* Last Backup Info & Current Local DB Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--accent-secondary)]">
                <History className="w-4 h-4 shrink-0" />
                <span>تاريخ آخر نسخة احتياطية</span>
              </div>
              <p className="text-xs font-bold text-[var(--text-primary)] m-0 break-words">
                {formatArabicDateTime(lastBackupMeta?.backupDate)}
              </p>
              {lastBackupMeta && (
                <p className="text-[11px] font-mono text-[var(--text-muted)] m-0">
                  عدد السجلات داخل النسخة: <strong className="text-[var(--text-primary)]">{lastBackupMeta.totalRecords}</strong> سجل
                </p>
              )}
            </div>

            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--accent-primary)]">
                <Database className="w-4 h-4 shrink-0" />
                <span>السجلات المحفوظة حالياً على الجهاز</span>
              </div>
              <p className="text-xs font-mono font-bold text-[var(--text-primary)] m-0">
                الإجمالي: {dbSummary?.totalRecords ?? '...'} سجل
              </p>
              {dbSummary && (
                <p className="text-[11px] text-[var(--text-muted)] m-0 leading-relaxed">
                  مخدومون: {dbSummary.counts.students} · افتقاد: {dbSummary.counts.followup} · طابور: {dbSummary.counts.mutations} · حضور تاريخي: {dbSummary.counts.attendance_history}
                </p>
              )}
            </div>
          </div>

          {/* Export Section */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0 flex items-center gap-2">
                  <FileJson className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
                  <span>إنشاء نسخة احتياطية JSON</span>
                </h4>
                <p className="text-[11.5px] text-[var(--text-secondary)] m-0 leading-relaxed">
                  يشمل كافة الجداول المحلية (المخدومون، سجل الافتقاد، طابور العمليات، سجل الحضور التاريخي) والإعدادات غير الحساسة فقط.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCreateBackup}
                disabled={isExporting || isRestoring}
                className="glass-btn--primary btn--lens min-h-[42px] px-4 py-2 rounded-xl text-xs font-extrabold text-white flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span>{isExporting ? 'جاري التحقق والتصدير...' : 'إنشاء نسخة احتياطية JSON'}</span>
              </button>
            </div>

            {exportStatus && (
              <div
                className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                  exportStatus.type === 'success'
                    ? 'bg-[var(--success-bg)] border-[var(--success-border)] text-[var(--success-text)]'
                    : 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger-text)]'
                }`}
              >
                {exportStatus.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1 min-w-0 flex-1">
                  <p className="m-0 font-bold">{exportStatus.message}</p>
                  {exportStatus.meta && (
                    <p className="m-0 font-mono text-[11px] opacity-90 break-words">
                      الملف: {exportStatus.meta.fileName} · مخدومون {exportStatus.meta.counts.students} · افتقاد {exportStatus.meta.counts.followup} · طابور {exportStatus.meta.counts.mutations} · حضور {exportStatus.meta.counts.attendance_history}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Restore Section */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0 flex items-center gap-2">
                  <Upload className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
                  <span>استعادة نسخة احتياطية JSON</span>
                </h4>
                <p className="text-[11.5px] text-[var(--text-secondary)] m-0 leading-relaxed">
                  يفحص ملف JSON وإصدار المخطط ويعرض ملخصاً مفصلاً قبل تنفيذ الدمج الذري الآمن.
                </p>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleSelectFile}
                className="hidden"
                aria-label="اختيار ملف نسخة احتياطية JSON"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isExporting || isRestoring}
                className="glass-btn min-h-[42px] px-4 py-2 rounded-xl text-xs font-extrabold text-[var(--accent-secondary)] border-[var(--accent-secondary)]/40 flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50"
              >
                <Upload className="w-4 h-4 shrink-0" />
                <span>استعادة نسخة احتياطية JSON</span>
              </button>
            </div>

            {restoreError && (
              <div className="p-3 rounded-xl bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger-text)] text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="space-y-0.5 min-w-0 flex-1">
                  <p className="m-0 font-extrabold">تعذر قبول ملف الاستعادة {selectedFileName ? `(${selectedFileName})` : ''}</p>
                  <p className="m-0">{restoreError}</p>
                </div>
              </div>
            )}

            {/* Pre-Restore Preview & Explicit Warning */}
            {restorePreview && (
              <div className="p-3.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--warning-border)] space-y-3">
                <div className="p-3 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning-text)] text-xs flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1 min-w-0 flex-1">
                    <p className="m-0 font-extrabold">تحذير مهم قبل الاستعادة:</p>
                    <p className="m-0 leading-relaxed">
                      ستتم الاستعادة بطريقة <strong>الدمج الآمن (Safe Merge)</strong> داخل معاملة ذرية واحدة: لن يتم حذف أي سجل موجود حالياً، ولن يُستبدل أي سجل أحدث بسجل أقدم، ولن يتم إرسال أي بيانات إلى Google Sheets أو تغيير إعدادات الاتصال.
                    </p>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
                    <span>الملف: <strong className="text-[var(--text-primary)] font-mono">{selectedFileName}</strong></span>
                    <span>تاريخ النسخة: <strong className="text-[var(--text-primary)]">{formatArabicDateTime(restorePreview.backupDate)}</strong></span>
                    <span>مخطط النسخة: <strong className="font-mono text-[var(--text-primary)]">v{restorePreview.schemaVersion}</strong></span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10.5px] text-[var(--text-muted)]">المخدومون</span>
                      <strong className="font-mono text-xs text-[var(--text-primary)]">
                        {restorePreview.backupCounts.students} في النسخة
                      </strong>
                      <span className="block text-[10px] font-mono text-[var(--text-muted)]">
                        الحالي: {restorePreview.localCounts.students}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10.5px] text-[var(--text-muted)]">سجلات الافتقاد</span>
                      <strong className="font-mono text-xs text-[var(--text-primary)]">
                        {restorePreview.backupCounts.followup} في النسخة
                      </strong>
                      <span className="block text-[10px] font-mono text-[var(--text-muted)]">
                        الحالي: {restorePreview.localCounts.followup}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10.5px] text-[var(--text-muted)]">طابور العمليات</span>
                      <strong className="font-mono text-xs text-[var(--text-primary)]">
                        {restorePreview.backupCounts.mutations} في النسخة
                      </strong>
                      <span className="block text-[10px] font-mono text-[var(--text-muted)]">
                        الحالي: {restorePreview.localCounts.mutations}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="block text-[10.5px] text-[var(--text-muted)]">الحضور التاريخي</span>
                      <strong className="font-mono text-xs text-[var(--text-primary)]">
                        {restorePreview.backupCounts.attendance_history} في النسخة
                      </strong>
                      <span className="block text-[10px] font-mono text-[var(--text-muted)]">
                        الحالي: {restorePreview.localCounts.attendance_history}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCancelRestorePreview}
                    disabled={isRestoring}
                    className="glass-btn min-h-[38px] px-4 py-1.5 rounded-xl text-xs font-bold text-[var(--text-secondary)] cursor-pointer"
                  >
                    إلغاء
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmRestore}
                    disabled={isRestoring}
                    className="glass-btn--primary btn--lens min-h-[38px] px-4 py-1.5 rounded-xl text-xs font-extrabold text-white cursor-pointer disabled:opacity-50"
                  >
                    {isRestoring ? 'جاري الدمج والتحقق...' : 'تأكيد الاستعادة والدمج الآمن'}
                  </button>
                </div>
              </div>
            )}

            {/* Verified Restore Outcome */}
            {verifiedRestoreResult && (
              <div className="p-3.5 rounded-xl bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success-text)] text-xs space-y-1.5">
                <div className="flex items-center gap-2 font-extrabold">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>تمت الاستعادة والتحقق الفعلي من سلامة البيانات محلياً</span>
                </div>
                <p className="m-0 font-mono text-[11px]">
                  المخدومون (+{verifiedRestoreResult.stats.students.inserted} / دمج {verifiedRestoreResult.stats.students.updated}) ·
                  الافتقاد (+{verifiedRestoreResult.stats.followup.inserted} / دمج {verifiedRestoreResult.stats.followup.updated}) ·
                  الطابور (+{verifiedRestoreResult.stats.mutations.inserted}) ·
                  الحضور التاريخي (+{verifiedRestoreResult.stats.attendance_history.inserted} / دمج {verifiedRestoreResult.stats.attendance_history.updated})
                </p>
              </div>
            )}
          </div>

          {/* Security & Non-Mutation Notice */}
          <div className="p-3 rounded-2xl bg-[var(--surface-inset)] border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] leading-relaxed flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-secondary)] shrink-0 mt-0.5" />
            <div>
              <strong className="text-[var(--text-primary)]">حماية المفاتيح والمزامنة: </strong>
              لا تتضمن النسخة الاحتياطية أي مفاتيح سرية أو Relay Keys، ولا تعدّل رابط Google Apps Script أو إعدادات المزامنة أو ملف Google Sheets.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-5 py-3.5 border-t border-[var(--border-color)] flex justify-end bg-[var(--surface-secondary)] shrink-0">
          <button
            type="button"
            onClick={handleClose}
            disabled={isExporting || isRestoring}
            className="glass-btn min-h-[40px] px-5 py-2 rounded-xl font-bold text-xs text-[var(--text-secondary)] cursor-pointer disabled:opacity-50"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
