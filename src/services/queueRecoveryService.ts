import { OfflineMutation, RemoteVerificationOutcome } from '../types/auth';
import {
  idbGetPendingMutations,
  idbClearSelectedMutations,
  ClearSelectedMutationsResult
} from './indexedDbService';

export type QueueDisplayStateKey =
  | 'verified_persisted'
  | 'conflict'
  | 'verification_unavailable'
  | 'timeout_unknown'
  | 'permanent_failure'
  | 'retrying_scheduled'
  | 'pending';

export type QueueBadgeTone = 'success' | 'info' | 'warning' | 'danger';

export interface MutationDisplayState {
  stateKey: QueueDisplayStateKey;
  arabicLabel: string;
  badgeTone: QueueBadgeTone;
  description: string;
  isVerifiedRemotely: boolean;
  isPermanentFailure: boolean;
  isConflict: boolean;
  isTimeoutUnknown: boolean;
  isVerificationUnavailable: boolean;
  errorCategoryLabel: string;
  verificationOutcomeLabel: string;
  autoRetryExplanation?: string;
  canManualRetry: boolean;
  manualRetryBlockedReason?: string;
  isBlockedByEarlierSameStudent: boolean;
  earlierBlockingMutationId?: string;
}

export interface QueueBreakdownSummary {
  total: number;
  pending: number;
  retrying: number;
  failed: number;
  permanentFailed: number;
  transientFailed: number;
  conflict: number;
  timeoutUnknown: number;
  verificationUnavailable: number;
  verifiedPersisted: number;
}

export interface QueueClearBackupPayload {
  kind: 'stgorge_queue_recovery_backup';
  schemaVersion: 1;
  createdAt: string;
  databaseName: 'StGorgeServiceDB';
  mutationCount: number;
  mutationIds: string[];
  mutations: OfflineMutation[];
}

export interface QueueBackupValidationResult {
  valid: boolean;
  backup?: QueueClearBackupPayload;
  error?: string;
}

export type QueueBackupDownloader = (artifact: {
  fileName: string;
  jsonString: string;
  backup: QueueClearBackupPayload;
}) => boolean | void | Promise<boolean | void>;

export interface SafeClearQueueOptions {
  targetMutationIds?: string[];
  confirmed: boolean;
  downloader?: QueueBackupDownloader;
  nowMs?: number;
  maxBackupAgeMs?: number;
  backupJsonOverride?: string;
}

export interface SafeClearQueueResult {
  ok: boolean;
  cancelled?: boolean;
  clearedCount: number;
  remainingCount: number;
  verifiedEmpty: boolean;
  backupFileName?: string;
  backupCreatedAt?: string;
  clearedStudentIds?: string[];
  protectedStudentIds?: string[];
  error?: string;
}

export const DEFAULT_QUEUE_BACKUP_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const FUTURE_CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 1 minute

export function getErrorCategoryArabicLabel(mutation: OfflineMutation): string {
  if (mutation.status === 'conflict' || mutation.errorCategory === 'conflict') {
    return 'تعارض إصدار (409)';
  }
  if (mutation.isPermanentError === true || mutation.errorCategory === 'permanent') {
    return 'خطأ دائم (يتطلب مراجعة)';
  }
  if (mutation.status === 'timeout_unknown' || mutation.errorCategory === 'timeout') {
    return 'انتهاء مهلة الاتصال (نتيجة غير مؤكدة)';
  }
  if (mutation.errorCategory === 'transient' || mutation.lastError) {
    return 'خطأ مؤقت (شبكة أو خادم)';
  }
  return 'لا يوجد خطأ';
}

export function getVerificationOutcomeArabicLabel(outcome?: RemoteVerificationOutcome): string {
  switch (outcome) {
    case 'verified_persisted':
      return 'تم إثبات الحفظ على Google Sheets';
    case 'not_found_retryable':
      return 'غير موجود على الخادم — قابل لإعادة الإرسال';
    case 'unknown':
      return 'نتيجة غير مؤكدة — بانتظار التحقق';
    case 'verification_unavailable':
      return 'تعذر التحقق من الخادم حالياً';
    case 'conflict':
      return 'تعارض إصدار على الخادم (409)';
    default:
      return 'لم يتم التحقق من الخادم بعد (محفوظ محلياً)';
  }
}

/**
 * Classifies a single queue mutation into one of the 7 explicit Phase 4.3.4 display states,
 * enforcing:
 * - Green/verified status ONLY when valid remote persistence proof exists (`verified_persisted` + `verifiedAt`)
 * - Clear Arabic distinction between pending, scheduled retry, permanent failure, conflict 409,
 *   timeout/unknown, verification unavailable, and verified remote persistence
 * - Per-student chronological ordering protection for manual retry
 */
export function classifyMutationDisplayState(
  mutation: OfflineMutation,
  allMutations: OfflineMutation[] = [],
  options?: { nowMs?: number }
): MutationDisplayState {
  const nowMs = typeof options?.nowMs === 'number' ? options.nowMs : Date.now();
  const list = Array.isArray(allMutations) ? allMutations : [];
  const idx = list.findIndex((m) => m.id === mutation.id);

  let earlierBlockingMutation: OfflineMutation | undefined;
  if (idx > 0 && mutation.studentId) {
    earlierBlockingMutation = list
      .slice(0, idx)
      .find((m) => m.studentId && m.studentId === mutation.studentId);
  }

  const isBlockedByEarlierSameStudent = Boolean(earlierBlockingMutation);
  const manualRetryBlockedReason = isBlockedByEarlierSameStudent
    ? `توجد عملية أقدم غير مكتملة لنفس المخدوم (${mutation.studentName || mutation.studentId}) — يجب معالجة العملية الأقدم أولاً حفاظاً على ترتيب البيانات.`
    : undefined;

  const errorCategoryLabel = getErrorCategoryArabicLabel(mutation);
  const verificationOutcomeLabel = getVerificationOutcomeArabicLabel(mutation.verificationOutcome);

  // 1. Verified remote persistence — STRICTLY gated on verified_persisted + verifiedAt proof
  const hasValidRemoteProof =
    mutation.verificationOutcome === 'verified_persisted' &&
    typeof mutation.verifiedAt === 'string' &&
    mutation.verifiedAt.trim().length > 0;

  if (hasValidRemoteProof) {
    return {
      stateKey: 'verified_persisted',
      arabicLabel: 'تم تأكيد الحفظ على Google Sheets',
      badgeTone: 'success',
      description: 'تم استلام إثبات رسمي من الخادم بأن هذه العملية حُفظت بنجاح.',
      isVerifiedRemotely: true,
      isPermanentFailure: false,
      isConflict: false,
      isTimeoutUnknown: false,
      isVerificationUnavailable: false,
      errorCategoryLabel,
      verificationOutcomeLabel,
      canManualRetry: false,
      manualRetryBlockedReason: 'تم تأكيد حفظ هذه العملية بالفعل على Google Sheets.',
      isBlockedByEarlierSameStudent: false
    };
  }

  // 2. Conflict 409
  if (
    mutation.status === 'conflict' ||
    mutation.errorCategory === 'conflict' ||
    mutation.verificationOutcome === 'conflict'
  ) {
    return {
      stateKey: 'conflict',
      arabicLabel: 'تعارض إصدار (409)',
      badgeTone: 'danger',
      description: 'تم تعديل سجل المخدوم من جهاز آخر قبل وصول هذه العملية.',
      isVerifiedRemotely: false,
      isPermanentFailure: false,
      isConflict: true,
      isTimeoutUnknown: false,
      isVerificationUnavailable: false,
      errorCategoryLabel,
      verificationOutcomeLabel,
      autoRetryExplanation:
        'لا يُعاد إرسال عمليات التعارض تلقائياً حتى لا يتم استبدال تحديث أحدث على Google Sheets. يُنصح بمراجعة السجل قبل أي إعادة محاولة يدوية.',
      canManualRetry: !isBlockedByEarlierSameStudent,
      manualRetryBlockedReason,
      isBlockedByEarlierSameStudent,
      earlierBlockingMutationId: earlierBlockingMutation?.id
    };
  }

  // 3. Verification unavailable
  if (mutation.verificationOutcome === 'verification_unavailable') {
    return {
      stateKey: 'verification_unavailable',
      arabicLabel: 'تعذر التحقق من الخادم',
      badgeTone: 'warning',
      description:
        'انتهت المهلة أو تعذر الوصول لخدمة التحقق من الحفظ، لذلك تبقى العملية محفوظة محلياً دون حذف حتى يتوفر إثبات رسمي.',
      isVerifiedRemotely: false,
      isPermanentFailure: false,
      isConflict: false,
      isTimeoutUnknown: mutation.status === 'timeout_unknown',
      isVerificationUnavailable: true,
      errorCategoryLabel,
      verificationOutcomeLabel,
      autoRetryExplanation:
        'لن تُحذف العملية ولن تُعتبر متزامنة حتى يتمكن النظام من التحقق من حالتها على الخادم.',
      canManualRetry: !isBlockedByEarlierSameStudent,
      manualRetryBlockedReason,
      isBlockedByEarlierSameStudent,
      earlierBlockingMutationId: earlierBlockingMutation?.id
    };
  }

  // 4. Timeout / Unknown remote outcome
  if (
    mutation.status === 'timeout_unknown' ||
    mutation.errorCategory === 'timeout' ||
    mutation.verificationOutcome === 'unknown'
  ) {
    return {
      stateKey: 'timeout_unknown',
      arabicLabel: 'نتيجة غير مؤكدة — انتهاء المهلة',
      badgeTone: 'warning',
      description:
        'انتهت مهلة الاتصال قبل استلام تأكيد الحفظ من Google Sheets. تبقى العملية محفوظة محلياً وسيتم التحقق منها بالمعرّف الثابت لمنع التكرار.',
      isVerifiedRemotely: false,
      isPermanentFailure: false,
      isConflict: false,
      isTimeoutUnknown: true,
      isVerificationUnavailable: false,
      errorCategoryLabel,
      verificationOutcomeLabel,
      autoRetryExplanation:
        'عند المحاولة التالية يتم التحقق من وجود المعرّف الثابت على الخادم قبل إعادة الإرسال.',
      canManualRetry: !isBlockedByEarlierSameStudent,
      manualRetryBlockedReason,
      isBlockedByEarlierSameStudent,
      earlierBlockingMutationId: earlierBlockingMutation?.id
    };
  }

  // 5. Permanent failure
  if (mutation.isPermanentError === true || mutation.errorCategory === 'permanent') {
    return {
      stateKey: 'permanent_failure',
      arabicLabel: 'فشل دائم — يتطلب مراجعة',
      badgeTone: 'danger',
      description:
        'رفض الخادم هذه العملية بسبب خطأ دائم (مثل صلاحيات الحساب أو بيانات غير صالحة).',
      isVerifiedRemotely: false,
      isPermanentFailure: true,
      isConflict: false,
      isTimeoutUnknown: false,
      isVerificationUnavailable: false,
      errorCategoryLabel,
      verificationOutcomeLabel,
      autoRetryExplanation:
        'الخطأ الدائم لا يُعاد إرساله تلقائياً على عكس الأعطال المؤقتة للشبكة. راجع سبب الخطأ أو قم بمسح العملية بأمان بعد حفظ نسخة احتياطية.',
      canManualRetry: !isBlockedByEarlierSameStudent,
      manualRetryBlockedReason,
      isBlockedByEarlierSameStudent,
      earlierBlockingMutationId: earlierBlockingMutation?.id
    };
  }

  // 6. Retrying / Waiting for retry time (or transient failure)
  const hasFutureRetrySchedule =
    typeof mutation.nextRetryAt === 'number' &&
    Number.isFinite(mutation.nextRetryAt) &&
    mutation.nextRetryAt > nowMs;

  if (mutation.status === 'retrying' || mutation.status === 'failed' || hasFutureRetrySchedule) {
    const isTransientFailed = mutation.status === 'failed';
    return {
      stateKey: 'retrying_scheduled',
      arabicLabel: hasFutureRetrySchedule
        ? 'بانتظار وقت إعادة المحاولة'
        : isTransientFailed
        ? 'فشل مؤقت — قابل لإعادة المحاولة'
        : 'إعادة محاولة مجدولة',
      badgeTone: isTransientFailed ? 'warning' : 'info',
      description: hasFutureRetrySchedule
        ? 'تعثر الإرسال بسبب خطأ مؤقت، وتم جدولة إعادة المحاولة تلقائياً وفق نظام التأخير المتدرج.'
        : 'تعثر الإرسال بسبب عطل مؤقت في الشبكة أو الخادم ويمكن إعادة المحاولة.',
      isVerifiedRemotely: false,
      isPermanentFailure: false,
      isConflict: false,
      isTimeoutUnknown: false,
      isVerificationUnavailable: false,
      errorCategoryLabel,
      verificationOutcomeLabel,
      autoRetryExplanation:
        'خطأ مؤقت (شبكة/خادم) — يُعاد الإرسال تلقائياً عند حلول وقت المحاولة المجدول أو عبر إعادة المحاولة اليدوية.',
      canManualRetry: !isBlockedByEarlierSameStudent,
      manualRetryBlockedReason,
      isBlockedByEarlierSameStudent,
      earlierBlockingMutationId: earlierBlockingMutation?.id
    };
  }

  // 7. Pending (saved locally, waiting for sync)
  return {
    stateKey: 'pending',
    arabicLabel: 'قيد الانتظار — محفوظ محلياً',
    badgeTone: 'info',
    description: 'العملية محفوظة محلياً في IndexedDB وبانتظار إرسالها وتأكيد حفظها في Google Sheets.',
    isVerifiedRemotely: false,
    isPermanentFailure: false,
    isConflict: false,
    isTimeoutUnknown: false,
    isVerificationUnavailable: false,
    errorCategoryLabel,
    verificationOutcomeLabel,
    canManualRetry: !isBlockedByEarlierSameStudent,
    manualRetryBlockedReason,
    isBlockedByEarlierSameStudent,
    earlierBlockingMutationId: earlierBlockingMutation?.id
  };
}

/**
 * Summarizes queue breakdown counts across all categories for Queue UI & Safe Clear confirmations.
 */
export function summarizeQueueMutations(
  mutations: OfflineMutation[],
  nowMs: number = Date.now()
): QueueBreakdownSummary {
  const summary: QueueBreakdownSummary = {
    total: 0,
    pending: 0,
    retrying: 0,
    failed: 0,
    permanentFailed: 0,
    transientFailed: 0,
    conflict: 0,
    timeoutUnknown: 0,
    verificationUnavailable: 0,
    verifiedPersisted: 0
  };

  if (!Array.isArray(mutations)) return summary;
  summary.total = mutations.length;

  for (const m of mutations) {
    const info = classifyMutationDisplayState(m, mutations, { nowMs });
    switch (info.stateKey) {
      case 'verified_persisted':
        summary.verifiedPersisted += 1;
        break;
      case 'conflict':
        summary.conflict += 1;
        break;
      case 'verification_unavailable':
        summary.verificationUnavailable += 1;
        summary.timeoutUnknown += 1;
        break;
      case 'timeout_unknown':
        summary.timeoutUnknown += 1;
        break;
      case 'permanent_failure':
        summary.permanentFailed += 1;
        summary.failed += 1;
        break;
      case 'retrying_scheduled':
        if (m.status === 'failed') {
          summary.transientFailed += 1;
          summary.failed += 1;
        } else {
          summary.retrying += 1;
        }
        break;
      case 'pending':
      default:
        summary.pending += 1;
        break;
    }
  }

  return summary;
}

function canonicalizeForComparison(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForComparison(item));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) {
        sorted[key] = canonicalizeForComparison(v);
      }
    }
    return sorted;
  }
  return value;
}

function deepCloneMutation(m: OfflineMutation): OfflineMutation {
  return JSON.parse(JSON.stringify(m));
}

export function createQueueClearBackup(
  targetMutations: OfflineMutation[],
  options?: { nowIso?: string }
): {
  backup: QueueClearBackupPayload;
  jsonString: string;
  fileName: string;
} {
  const createdAt = options?.nowIso || new Date().toISOString();
  const cloned = (targetMutations || []).map((m) => deepCloneMutation(m));
  const backup: QueueClearBackupPayload = {
    kind: 'stgorge_queue_recovery_backup',
    schemaVersion: 1,
    createdAt,
    databaseName: 'StGorgeServiceDB',
    mutationCount: cloned.length,
    mutationIds: cloned.map((m) => m.id),
    mutations: cloned
  };
  const jsonString = JSON.stringify(backup, null, 2);
  const safeStamp = createdAt.replace(/[:.]/g, '-');
  const fileName = `stgorge-queue-recovery-backup-${safeStamp}.json`;
  return { backup, jsonString, fileName };
}

/**
 * Strictly validates a queue recovery backup JSON string against the exact mutations being cleared:
 * - Must parse cleanly as JSON with expected schema envelope
 * - Must be freshly created (rejects historical/stale backups & fixtures)
 * - Must contain EVERY target mutation ID with exact deep-matching payload and identity fields
 */
export function validateQueueClearBackup(
  rawJson: string,
  expectedMutations: OfflineMutation[],
  options?: { maxAgeMs?: number; nowMs?: number }
): QueueBackupValidationResult {
  if (!Array.isArray(expectedMutations) || expectedMutations.length === 0) {
    return { valid: false, error: 'لا توجد عمليات محددة للتحقق منها في النسخة الاحتياطية.' };
  }

  if (typeof rawJson !== 'string' || !rawJson.trim()) {
    return { valid: false, error: 'ملف النسخة الاحتياطية للطابور فارغ أو غير صالح.' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { valid: false, error: 'فشل تحليل ملف النسخة الاحتياطية للطابور (JSON غير صالح).' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'بنية ملف النسخة الاحتياطية للطابور غير صالحة.' };
  }

  if (parsed.kind !== 'stgorge_queue_recovery_backup') {
    return { valid: false, error: 'نوع النسخة الاحتياطية غير مطابق لنسخة حماية طابور العمليات.' };
  }

  if (parsed.schemaVersion !== 1 || parsed.databaseName !== 'StGorgeServiceDB') {
    return { valid: false, error: 'إصدار أو اسم قاعدة البيانات في النسخة الاحتياطية غير مطابق.' };
  }

  // Freshness validation: strictly reject stale historical backups / test fixtures
  const createdAtMs = typeof parsed.createdAt === 'string' ? Date.parse(parsed.createdAt) : NaN;
  if (!Number.isFinite(createdAtMs)) {
    return { valid: false, error: 'تاريخ إنشاء النسخة الاحتياطية غير صالح أو مفقود.' };
  }

  const nowMs = typeof options?.nowMs === 'number' ? options.nowMs : Date.now();
  const maxAgeMs =
    typeof options?.maxAgeMs === 'number' ? options.maxAgeMs : DEFAULT_QUEUE_BACKUP_MAX_AGE_MS;

  const ageMs = nowMs - createdAtMs;
  if (ageMs > maxAgeMs) {
    return {
      valid: false,
      error: 'النسخة الاحتياطية قديمة ولا تُعد نسخة حديثة للعمليات الحالية — تم رفضها لحماية البيانات.'
    };
  }
  if (ageMs < -FUTURE_CLOCK_SKEW_TOLERANCE_MS) {
    return {
      valid: false,
      error: 'تاريخ إنشاء النسخة الاحتياطية غير منطقي (في المستقبل) — تم رفضها.'
    };
  }

  if (!Array.isArray(parsed.mutations) || !Array.isArray(parsed.mutationIds)) {
    return { valid: false, error: 'النسخة الاحتياطية تفتقد قائمة العمليات أو معرّفاتها.' };
  }

  if (
    parsed.mutationCount !== expectedMutations.length ||
    parsed.mutations.length !== expectedMutations.length ||
    parsed.mutationIds.length !== expectedMutations.length
  ) {
    return {
      valid: false,
      error: `عدد العمليات في النسخة الاحتياطية (${parsed.mutations.length}) لا يطابق عدد العمليات المستهدفة (${expectedMutations.length}).`
    };
  }

  const backupById = new Map<string, OfflineMutation>();
  for (const item of parsed.mutations) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) {
      return { valid: false, error: 'تحتوي النسخة الاحتياطية على عملية غير صالحة أو بدون معرّف.' };
    }
    if (backupById.has(item.id)) {
      return { valid: false, error: `توجد عملية مكررة في النسخة الاحتياطية (${item.id}).` };
    }
    backupById.set(item.id, item as OfflineMutation);
  }

  const idListSet = new Set<string>(parsed.mutationIds);
  for (const expected of expectedMutations) {
    if (!idListSet.has(expected.id)) {
      return {
        valid: false,
        error: `معرّف العملية (${expected.id}) مفقود من فهرس النسخة الاحتياطية.`
      };
    }
    const backed = backupById.get(expected.id);
    if (!backed) {
      return {
        valid: false,
        error: `العملية (${expected.id}) غير موجودة داخل النسخة الاحتياطية.`
      };
    }

    if (
      backed.action !== expected.action ||
      backed.studentId !== expected.studentId ||
      backed.studentCode !== expected.studentCode ||
      backed.studentName !== expected.studentName ||
      backed.sourceSheet !== expected.sourceSheet ||
      backed.timestamp !== expected.timestamp ||
      backed.status !== expected.status ||
      backed.expectedVersion !== expected.expectedVersion
    ) {
      return {
        valid: false,
        error: `بيانات هوية العملية (${expected.id}) في النسخة الاحتياطية لا تطابق العملية المستهدفة.`
      };
    }

    const expectedPayloadCanonical = JSON.stringify(canonicalizeForComparison(expected.payload));
    const backedPayloadCanonical = JSON.stringify(canonicalizeForComparison(backed.payload));
    if (expectedPayloadCanonical !== backedPayloadCanonical) {
      return {
        valid: false,
        error: `محتوى العملية (${expected.id}) في النسخة الاحتياطية لا يطابق الحمولة الفعلية للعملية.`
      };
    }
  }

  return {
    valid: true,
    backup: parsed as QueueClearBackupPayload
  };
}

function defaultBrowserJsonDownloader(artifact: {
  fileName: string;
  jsonString: string;
  backup: QueueClearBackupPayload;
}): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('بيئة التنزيل غير متاحة لحفظ ملف النسخة الاحتياطية.');
  }
  const blob = new Blob([artifact.jsonString], { type: 'application/json;charset=utf-8' });
  if (blob.size === 0) {
    throw new Error('حجم ملف النسخة الاحتياطية صفر بايت.');
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    return true;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function exportAndValidateQueueClearBackup(
  targetMutations: OfflineMutation[],
  options?: {
    downloader?: QueueBackupDownloader;
    nowMs?: number;
    maxAgeMs?: number;
    backupJsonOverride?: string;
  }
): Promise<{
  ok: boolean;
  backup?: QueueClearBackupPayload;
  jsonString?: string;
  fileName?: string;
  error?: string;
}> {
  const nowMs = typeof options?.nowMs === 'number' ? options.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const created = createQueueClearBackup(targetMutations, { nowIso });
  const jsonToValidate =
    typeof options?.backupJsonOverride === 'string'
      ? options.backupJsonOverride
      : created.jsonString;

  const validation = validateQueueClearBackup(jsonToValidate, targetMutations, {
    nowMs,
    maxAgeMs: options?.maxAgeMs
  });

  if (!validation.valid || !validation.backup) {
    return {
      ok: false,
      error: validation.error || 'فشل التحقق من سلامة النسخة الاحتياطية قبل المسح.'
    };
  }

  const downloader = options?.downloader || defaultBrowserJsonDownloader;
  try {
    const downloadOutcome = await downloader({
      fileName: created.fileName,
      jsonString: jsonToValidate,
      backup: validation.backup
    });
    if (downloadOutcome === false) {
      return {
        ok: false,
        error: 'فشل حفظ ملف النسخة الاحتياطية على الجهاز — تم إلغاء المسح ولم تُحذف أي عملية.'
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      error:
        err?.message ||
        'تعذر تنزيل النسخة الاحتياطية قبل المسح — تم إلغاء المسح ولم تُحذف أي عملية.'
    };
  }

  return {
    ok: true,
    backup: validation.backup,
    jsonString: jsonToValidate,
    fileName: created.fileName
  };
}

/**
 * Executes the Phase 4.3.4 safe clear workflow:
 * 1. Requires explicit `confirmed === true` (cancels with 0 deletions otherwise)
 * 2. Creates and strictly validates a fresh backup containing ALL target mutation IDs & payloads
 * 3. Exports/downloads the backup; if backup or validation or export fails -> cancels with 0 deletions
 * 4. Atomically removes ONLY the backed-up target mutations and recalculates `hasUnsyncedLocalChanges`
 * 5. Never marks discarded mutations as remotely synchronized
 */
export async function executeSafeClearMutations(
  options: SafeClearQueueOptions
): Promise<SafeClearQueueResult> {
  const currentMutations = await idbGetPendingMutations();

  if (!options?.confirmed) {
    return {
      ok: false,
      cancelled: true,
      clearedCount: 0,
      remainingCount: currentMutations.length,
      verifiedEmpty: currentMutations.length === 0,
      error: 'تم إلغاء العملية: يتطلب المسح تأكيداً صريحاً من المستخدم.'
    };
  }

  const targetIdSet =
    Array.isArray(options.targetMutationIds) && options.targetMutationIds.length > 0
      ? new Set(options.targetMutationIds)
      : null;

  const targetMutations = targetIdSet
    ? currentMutations.filter((m) => targetIdSet.has(m.id))
    : currentMutations;

  if (targetMutations.length === 0) {
    return {
      ok: true,
      clearedCount: 0,
      remainingCount: currentMutations.length,
      verifiedEmpty: currentMutations.length === 0
    };
  }

  const backupExport = await exportAndValidateQueueClearBackup(targetMutations, {
    downloader: options.downloader,
    nowMs: options.nowMs,
    maxAgeMs: options.maxBackupAgeMs,
    backupJsonOverride: options.backupJsonOverride
  });

  if (!backupExport.ok || !backupExport.backup) {
    return {
      ok: false,
      clearedCount: 0,
      remainingCount: currentMutations.length,
      verifiedEmpty: false,
      error:
        backupExport.error ||
        'فشل إنشاء أو التحقق من النسخة الاحتياطية — تم إيقاف المسح ولم تُحذف أي عملية.'
    };
  }

  const targetIds = targetMutations.map((m) => m.id);
  const clearResult: ClearSelectedMutationsResult = await idbClearSelectedMutations(targetIds);

  const postRemaining = await idbGetPendingMutations();
  const stillPresent = postRemaining.filter((m) => targetIds.includes(m.id));
  if (stillPresent.length > 0) {
    return {
      ok: false,
      clearedCount: clearResult.clearedCount,
      remainingCount: postRemaining.length,
      verifiedEmpty: false,
      backupFileName: backupExport.fileName,
      backupCreatedAt: backupExport.backup.createdAt,
      error: 'تعذر التحقق من إزالة جميع العمليات المحددة من الطابور.'
    };
  }

  return {
    ok: true,
    clearedCount: clearResult.clearedCount,
    remainingCount: postRemaining.length,
    verifiedEmpty: postRemaining.length === 0,
    backupFileName: backupExport.fileName,
    backupCreatedAt: backupExport.backup.createdAt,
    clearedStudentIds: clearResult.clearedStudentIds,
    protectedStudentIds: clearResult.protectedStudentIds
  };
}

/**
 * Notification builders enforcing clear Arabic separation between:
 * - Local save / waiting for synchronization (`type: 'info'`)
 * - Confirmed remote persistence (`type: 'success'` — ONLY after valid Phase 4.3.3 proof)
 */
export function buildLocalSavedNotification(
  action: 'attendance' | 'followup' | 'update' | 'add',
  studentName: string,
  detail?: string
): { title: string; desc: string; type: 'info' } {
  const safeName = studentName || 'المخدوم';
  const suffix = ' — محفوظ محلياً وبانتظار المزامنة مع Google Sheets';
  switch (action) {
    case 'followup':
      return {
        title: 'تم حفظ الافتقاد محلياً',
        desc: `${safeName}${detail ? `: ${detail}` : ''}${suffix}`,
        type: 'info'
      };
    case 'attendance':
      return {
        title: 'تم حفظ الحضور محلياً',
        desc: `${safeName}${detail ? ` (${detail})` : ''}${suffix}`,
        type: 'info'
      };
    case 'update':
      return {
        title: 'تم حفظ التعديل محلياً',
        desc: `تم حفظ تعديل بيانات ${safeName}${suffix}`,
        type: 'info'
      };
    case 'add':
      return {
        title: 'تم حفظ المخدوم محلياً',
        desc: `تم تسجيل ${safeName}${suffix}`,
        type: 'info'
      };
  }
}

export function buildRemoteVerifiedNotification(
  confirmedCount: number,
  detail?: string
): { title: string; desc: string; type: 'success' } {
  return {
    title: 'تم تأكيد الحفظ على Google Sheets',
    desc:
      detail ||
      `تم التحقق وتأكيد حفظ ${confirmedCount} عملية في Google Sheets بنجاح.`,
    type: 'success'
  };
}
