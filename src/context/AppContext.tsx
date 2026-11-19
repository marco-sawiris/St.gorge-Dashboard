import React, { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Student,
  SheetName,
  AppFilterState,
  APPROVED_SHEETS,
  LIVE_GOOGLE_SHEET_TABS,
  INACTIVE_STUDENT_CLASSIFICATION
} from '../types/student';
import { CENTRAL_SPREADSHEET_ID } from '../config/centralSheetConfig';
import { FollowupRecord, CallOutcome } from '../types/followup';
import { AppNotification, MutationStageTimings, OfflineMutation, AuthUser, SyncOutcomeStatus } from '../types/auth';
import {
  DynamicAlphabetBucket,
  extractDynamicAlphabetBuckets,
  normalizeArabicText,
  normalizeArabicInitial,
  getNearestFridayString,
  getLatestHeldFridayString,
  getCairoDateParts,
  resolveFollowupCairoDates,
  computeMonthlyAttendanceSummary
} from '../utils/arabicUtils';
import {
  validateRemotePersistenceProof,
  validateTimeoutIdempotencyEntry,
  buildUnverifiedRemoteErrorMessage,
  buildTimeoutOutcomeErrorMessage,
  RemotePersistenceProof,
  TimeoutVerificationItemResult
} from '../services/remotePersistenceVerification';
import {
  executeSafeClearMutations,
  buildLocalSavedNotification,
  buildRemoteVerifiedNotification,
  QueueBackupDownloader,
  SafeClearQueueResult
} from '../services/queueRecoveryService';
import { generateUUID } from '../utils/uuid';
import {
  buildApiUrl,
  getAuthHeaders,
  getEffectiveAppsScriptUrl,
  getEffectiveRelayKey,
  DEFAULT_APPS_SCRIPT_URL,
  hasConfiguredRemoteBackend,
  isNativeCapacitorRuntime,
  safeGetLocalStorage,
  toSafeHeaderAscii
} from '../services/apiConfig';
import {
  idbGetStudents,
  idbSaveStudents,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbRemoveMutation,
  idbRemoveMutationsBatch,
  idbMarkMutationConflict,
  idbAtomicAddStudentWithMutation,
  idbAtomicUpdateStudentWithMutation,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicBatchRecordAttendanceWithMutations,
  idbAtomicDeleteStudentWithMutation,
  idbAtomicRecordFollowupWithMutation,
  idbReconcileStudents,
  idbPurgeMockRecords,
  idbSaveRemoteFollowupRecords,
  idbGetAttendanceHistory,
  idbUpdateMutationError,
  idbUpdateMutationsBatchState,
  idbResetMutationRetry,
  consumePendingManualRetryTarget,
  idbMigrateLegacyStudentIds,
  AttendanceHistoryRecord,
  PullVerificationProof,
  FollowupPullVerificationProof
} from '../services/indexedDbService';
import { computeDeterministicImportKey } from '../services/pdfAttendanceImportService';
import { syncWeeklyNotificationSchedules } from '../services/weeklyNotificationService';
import {
  clearDeliveredNativeNotificationsOnce,
  clearReadNotificationsFromList,
  computeNotificationDedupKey,
  CURRENT_NOTIFICATIONS_VERSION,
  deduplicateNotifications,
  loadAndMigrateNotifications,
  saveNotificationsToStorage,
  upsertDeduplicatedNotification
} from '../services/notificationStorageService';
import {
  fetchSheetStudentsViaGviz,
  fetchFollowupLogViaGvizDetailed
} from '../services/googleSheetParser';
import { useAuth } from './AuthContext';

export const SPREADSHEET_ID = CENTRAL_SPREADSHEET_ID;

export function formatPullWithPendingQueueMessage(
  remainingMutations: ReadonlyArray<OfflineMutation>,
  isPartialPull: boolean = false
): string {
  const count = remainingMutations.length;
  const queueError = remainingMutations.find((mutation) => mutation.lastError)?.lastError;
  const pullPrefix = isPartialPull
    ? 'تم سحب بيانات الفصول المتاحة مع حماية الفصول غير المؤكدة'
    : 'تم سحب وتحديث البيانات من Google Sheets بنجاح';
  if (queueError) {
    return `${pullPrefix}، والسبب التالي يخص (${count}) عملية كتابة معلقة في طابور الإرسال (محفوظة محلياً): ${queueError}`;
  }
  return `${pullPrefix}، وما زالت هناك ${count} عملية كتابة معلقة لم يتم تأكيد إرسالها إلى Google Sheets.`;
}

/**
 * Pure helper function to compute the mathematically latest timestamp between push and pull.
 */
export function computeLatestSyncTime(
  lastSuccessfulPullTime: string | null,
  lastSuccessfulPushTime: string | null
): string | null {
  if (!lastSuccessfulPullTime && !lastSuccessfulPushTime) return null;
  if (!lastSuccessfulPullTime) return lastSuccessfulPushTime;
  if (!lastSuccessfulPushTime) return lastSuccessfulPullTime;

  const pullTs = new Date(lastSuccessfulPullTime).getTime();
  const pushTs = new Date(lastSuccessfulPushTime).getTime();

  if (isNaN(pullTs) && isNaN(pushTs)) return null;
  if (isNaN(pullTs)) return lastSuccessfulPushTime;
  if (isNaN(pushTs)) return lastSuccessfulPullTime;

  return pushTs >= pullTs ? lastSuccessfulPushTime : lastSuccessfulPullTime;
}

const ARABIC_SYNC_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
];

export function formatLastSyncDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const day = d.getDate();
  const month = ARABIC_SYNC_MONTHS[d.getMonth()];
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? 'م' : 'ص';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${day} ${month} • ${hours}:${minutes} ${period}`;
}

export function formatLastSyncCompact(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const day = d.getDate();
  const month = d.getMonth() + 1;
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? 'م' : 'ص';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${day}/${month} ${hours}:${minutes} ${period}`;
}

/**
 * Pure Single Active Edit guard:
 * Guarantees only ONE student card can be open for editing at any moment.
 */
export function evaluateSingleActiveEditLock(
  currentActiveId: string | null,
  requestedStudentId: string,
  isAddModalOpen: boolean = false
): { allowed: boolean; reason?: string } {
  if (isAddModalOpen) {
    return {
      allowed: false,
      reason: 'يرجى إغلاق أو حفظ نافذة إضافة المخدوم الحالي قبل فتح كارت آخر للتعديل.'
    };
  }
  if (currentActiveId && currentActiveId !== requestedStudentId) {
    return {
      allowed: false,
      reason: 'يوجد كارت واحد مفتوح للتعديل حالياً. يرجى حفظ التعديلات أو إلغاؤها قبل تعديل كارت آخر.'
    };
  }
  return { allowed: true };
}

export interface SyncQueueExecutionReport {
  success: boolean;
  outcome: SyncOutcomeStatus;
  sentCount: number;
  deduplicatedCount: number;
  verifiedPostTimeoutCount: number;
  remainingCount: number;
  unknownResultCount: number;
  failedCount: number;
  conflictCount: number;
  mode: 'batch' | 'single' | 'mixed';
  totalDurationMs: number;
  stageSummary?: {
    prepMs: number;
    networkMs: number;
    verifyMs: number;
    serverMs: number;
  };
  lastError?: string;
}

export type AppSyncState =
  | 'connected'
  | 'syncing'
  | 'synced'
  | 'partial'
  | 'failed'
  | 'offline'
  | 'pending';

export type SyncExecutionOutcome = boolean | 'partial';

export interface PartialSyncInfo {
  skippedSheets: string[];
  appliedSheets: string[];
  timestamp: string;
}

export interface AppContextType {
  students: Student[];
  filteredStudents: Student[];
  availableAlphabetBuckets: DynamicAlphabetBucket[];
  followupRecords: FollowupRecord[];
  notifications: AppNotification[];
  filters: AppFilterState;
  activeView: 'cards' | 'table' | 'charts' | 'followup';
  isSyncing: boolean;
  isOnline: boolean;
  lastSyncError: string | null;
  lastSyncReport: SyncQueueExecutionReport | null;
  partialSyncInfo?: PartialSyncInfo | null;
  syncState: AppSyncState;
  lastSyncAttemptTime: string | null; // Full ISO timestamp
  lastSuccessfulPushTime: string | null; // Full ISO timestamp
  lastSuccessfulPullTime: string | null; // Full ISO timestamp
  lastSuccessfulSyncTime: string | null; // Formatted date & time display
  lastSuccessfulSyncCompact: string | null; // Compact mobile date & time display
  pendingMutationsCount: number;
  activeEditingId: string | null;
  hasUnsavedEditChanges: boolean;
  isSidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  isInitialLoading: boolean;
  isAssistantOpen: boolean;
  isNotificationsOpen: boolean;
  notificationsActiveTab: 'feed' | 'settings';
  isAreaModalOpen: boolean;
  isAboutModalOpen: boolean;
  isAppearanceModalOpen: boolean;
  isPdfImportModalOpen: boolean;
  isAddModalOpen: boolean;
  isSyncModalOpen: boolean;
  isQueueModalOpen: boolean;
  isBackupModalOpen?: boolean;
  setFilters: React.Dispatch<React.SetStateAction<AppFilterState>>;
  setActiveView: (view: 'cards' | 'table' | 'charts' | 'followup') => void;
  setActiveEditingId: (id: string | null) => void;
  setHasUnsavedEditChanges: (dirty: boolean) => void;
  requestEditStudent: (studentId: string) => boolean;
  cancelEditing: () => void;
  setIsSidebarOpen: (open: boolean) => void;
  setIsSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setIsAssistantOpen: (open: boolean) => void;
  setIsNotificationsOpen: (open: boolean) => void;
  setNotificationsActiveTab: React.Dispatch<React.SetStateAction<'feed' | 'settings'>>;
  setIsAreaModalOpen: (open: boolean) => void;
  setIsAboutModalOpen: (open: boolean) => void;
  setIsAppearanceModalOpen: (open: boolean) => void;
  setIsPdfImportModalOpen: (open: boolean) => void;
  setIsAddModalOpen: (open: boolean) => void;
  setIsSyncModalOpen: (open: boolean) => void;
  setIsQueueModalOpen: (open: boolean) => void;
  setIsBackupModalOpen?: (open: boolean) => void;
  reloadLocalDatabaseState?: () => Promise<void>;
  syncData: (overrideSheet?: SheetName) => Promise<boolean>;
  markAttendance: (studentId: string, isPresent: boolean, targetFridayDate?: string) => Promise<boolean>;
  importAttendanceBatch: (
    entries: Array<{ studentId: string; fridayDate: string; isPresent: boolean; sourceSheet?: string }>,
    options?: { operationId?: string }
  ) => Promise<{
    success: boolean;
    appliedCount: number;
    skippedDuplicateCount: number;
    blockedCount: number;
    futureBlockedCount: number;
    queuedCount: number;
    syncReport?: SyncQueueExecutionReport;
    error?: string;
  }>;
  recordFollowup: (
    studentId: string,
    method: string,
    notes?: string,
    options?: { callOutcome?: CallOutcome }
  ) => Promise<boolean>;
  updateStudent: (studentId: string, updatedFields: Partial<Student>) => Promise<boolean>;
  addNewStudent: (studentData: Partial<Student>) => Promise<boolean>;
  deleteStudent: (studentId: string) => Promise<boolean>;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearReadNotifications: () => void;
  addNotification: (
    title: string,
    desc?: string,
    type?: 'info' | 'warn' | 'success' | 'danger',
    options?: { id?: string; dedupKey?: string }
  ) => void;
  processOfflineQueue: () => Promise<SyncQueueExecutionReport>;
  clearOfflineQueue: (options?: {
    targetMutationIds?: string[];
    confirmed?: boolean;
    downloader?: QueueBackupDownloader;
  }) => Promise<{
    clearedCount: number;
    verifiedEmpty: boolean;
    ok?: boolean;
    cancelled?: boolean;
    remainingCount?: number;
    backupFileName?: string;
    backupCreatedAt?: string;
    clearedStudentIds?: string[];
    protectedStudentIds?: string[];
    error?: string;
  }>;
  inFlightStudentIds: string[];
  syncedStudentIds: string[];
  pendingStudentIds: string[];
  isQueueProcessing: boolean;
  triggerAutoProcessQueue: (isImmediateUserAction?: boolean) => Promise<SyncQueueExecutionReport | void>;
  activeToast: AppNotification | null;
  dismissToast: () => void;
}

export const AppContext = createContext<AppContextType | null>(null);

export function isValidTargetTabName(rawSheet: unknown): boolean {
  if (rawSheet === null || rawSheet === undefined) return false;
  const s = String(rawSheet).trim();
  if (
    !s ||
    s === '__ALL__' ||
    /^undefined$/i.test(s) ||
    /^null$/i.test(s) ||
    /^nan$/i.test(s) ||
    /^\[object\s+object\]$/i.test(s)
  ) {
    return false;
  }
  return true;
}

export function resolveValidSheetName(rawSheet: unknown, fallback: string = 'نشط'): string {
  if (!isValidTargetTabName(rawSheet)) return fallback;
  return String(rawSheet).trim();
}

export function normalizeStudentRecord(raw: Partial<Student>): Student {
  const safeAtt: Record<string, boolean> =
    raw.att && typeof raw.att === 'object' ? { ...raw.att } : {};
  const safeFu: Record<string, string> =
    raw.fu && typeof raw.fu === 'object' ? { ...raw.fu } : {};
  const safeFuOutcomes =
    raw.fuOutcomes && typeof raw.fuOutcomes === 'object' ? { ...raw.fuOutcomes } : undefined;
  const parsedTotal = Number(raw.attendanceTotal);
  const parsedMonth = Number(raw.attendanceMonth);
  const parsedVersion = Number(raw.version);

  return {
    id: String(raw.id || ''),
    code: String(raw.code || ''),
    name: String(raw.name || ''),
    servant: String(raw.servant || '').trim() || 'غير محدد',
    phoneStudent: String(raw.phoneStudent || ''),
    phoneParent1: String(raw.phoneParent1 || ''),
    phoneParent2: String(raw.phoneParent2 || ''),
    birthDate: String(raw.birthDate || ''),
    area: String(raw.area || '').trim() || 'غير محددة',
    address: String(raw.address || ''),
    notes: String(raw.notes || ''),
    followupStatus: String(raw.followupStatus || 'بدون'),
    attendanceTotal: Number.isFinite(parsedTotal) ? Math.max(0, parsedTotal) : 0,
    attendanceMonth: Number.isFinite(parsedMonth) ? Math.max(0, parsedMonth) : 0,
    attendanceStatus: raw.attendanceStatus === 'حاضر' ? 'حاضر' : 'غائب',
    lastAttendance: raw.lastAttendance || undefined,
    lastFollowup: raw.lastFollowup || undefined,
    sourceSheet: resolveValidSheetName(raw.sourceSheet, 'نشط'),
    version: Number.isFinite(parsedVersion) && parsedVersion >= 1 ? parsedVersion : 1,
    ...(typeof raw.hasRemoteVersion === 'boolean' ? { hasRemoteVersion: raw.hasRemoteVersion } : {}),
    ...(typeof raw.hasUnsyncedLocalChanges === 'boolean'
      ? { hasUnsyncedLocalChanges: raw.hasUnsyncedLocalChanges }
      : {}),
    ...(raw.identityQuality ? { identityQuality: raw.identityQuality } : {}),
    att: safeAtt,
    fu: safeFu,
    ...(safeFuOutcomes ? { fuOutcomes: safeFuOutcomes } : {}),
    ...(raw.lastCallOutcome ? { lastCallOutcome: raw.lastCallOutcome } : {})
  };
}

export interface BatchAttendanceEntryInput {
  studentId: string;
  fridayDate: string;
  isPresent: boolean;
  sourceSheet?: string;
}

export interface PreparedBatchAttendancePlan {
  updatedStudents: Student[];
  historyRecords: AttendanceHistoryRecord[];
  mutations: OfflineMutation[];
  appliedCount: number;
  skippedDuplicateCount: number;
  blockedCount: number;
  futureBlockedCount: number;
  invalidSheetCount?: number;
}

/**
 * Pure atomic batch attendance planner:
 * - Preserves historical attendance records without overwriting unrelated dates
 * - Skips identical duplicate dates (idempotent re-upload)
 * - Increments OCC expectedVersion sequentially per student so Code.gs & Express approve all N dates cleanly
 * - Assigns strictly increasing FIFO timestamps across the batch
 */
export function prepareBatchAttendanceMutations(
  entries: ReadonlyArray<BatchAttendanceEntryInput>,
  students: ReadonlyArray<Student>,
  canPerformAction: (action: 'attendance', servantName?: string) => { allowed: boolean; reason?: string },
  cairoTodayIso: string = getCairoDateParts().isoDate,
  operationId?: string,
  existingQueuedMutations: ReadonlyArray<OfflineMutation> = []
): PreparedBatchAttendancePlan {
  const studentsById = new Map(students.map((s) => [s.id, s]));
  const grouped = new Map<string, BatchAttendanceEntryInput[]>();
  const seenKeys = new Set<string>();
  const queuedAttendanceByLogicalKey = new Map<string, OfflineMutation>();
  for (const m of existingQueuedMutations) {
    if (m.action !== 'attendance') continue;
    const mFri = String(m.payload?.friday || m.payload?.date || '').trim();
    if (m.studentId && mFri) {
      queuedAttendanceByLogicalKey.set(`${m.studentId}__${mFri}`, m);
    }
  }

  let skippedDuplicateCount = 0;
  let blockedCount = 0;
  let futureBlockedCount = 0;
  let invalidSheetCount = 0;

  for (const rawEntry of entries) {
    const friday = String(rawEntry.fridayDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(friday)) continue;

    const logicalKey = `${rawEntry.studentId}__${friday}`;
    if (seenKeys.has(logicalKey)) continue;
    seenKeys.add(logicalKey);

    const queuedExisting = queuedAttendanceByLogicalKey.get(logicalKey);
    if (queuedExisting) {
      const queuedPresent = Boolean(queuedExisting.payload?.isPresent ?? queuedExisting.payload?.present);
      if (queuedPresent === Boolean(rawEntry.isPresent) || queuedExisting.status !== 'pending') {
        skippedDuplicateCount++;
        continue;
      }
    }

    const student = studentsById.get(rawEntry.studentId);
    if (!student) continue;

    if (!canPerformAction('attendance', student.servant).allowed) {
      blockedCount++;
      continue;
    }

    const explicitSheet = rawEntry.sourceSheet !== undefined ? resolveValidSheetName(rawEntry.sourceSheet, '') : '';
    const resolvedEntrySheet = explicitSheet || resolveValidSheetName(student.sourceSheet, '');
    if (!resolvedEntrySheet || (rawEntry.sourceSheet !== undefined && !explicitSheet)) {
      invalidSheetCount++;
      continue;
    }

    if (friday > cairoTodayIso) {
      futureBlockedCount++;
      continue;
    }

    if (student.att?.[friday] === rawEntry.isPresent) {
      skippedDuplicateCount++;
      continue;
    }

    if (!grouped.has(student.id)) grouped.set(student.id, []);
    grouped.get(student.id)!.push({
      studentId: student.id,
      fridayDate: friday,
      isPresent: rawEntry.isPresent,
      sourceSheet: resolvedEntrySheet
    });
  }

  const updatedStudents: Student[] = [];
  const historyRecords: AttendanceHistoryRecord[] = [];
  const mutations: OfflineMutation[] = [];
  let seqTimestamp = Date.now();
  let appliedCount = 0;

  for (const [studentId, studentEntries] of grouped.entries()) {
    const student = studentsById.get(studentId);
    if (!student || studentEntries.length === 0) continue;

    // Sort chronologically for deterministic version chaining & lastAttendance calculation
    studentEntries.sort((a, b) => a.fridayDate.localeCompare(b.fridayDate));

    const nextAtt: Record<string, boolean> = { ...(student.att || {}) };
    const baseVersion = student.version || 1;
    let totalDelta = 0;
    const safeStudentId = toSafeHeaderAscii(studentId);
    const validSheet = resolveValidSheetName(studentEntries[0]?.sourceSheet || student.sourceSheet, 'نشط');

    studentEntries.forEach((entry, idx) => {
      const entrySheet = resolveValidSheetName(entry.sourceSheet || validSheet, validSheet);
      const prevVal = nextAtt[entry.fridayDate];
      if (entry.isPresent && prevVal !== true) totalDelta += 1;
      else if (!entry.isPresent && prevVal === true) totalDelta -= 1;

      nextAtt[entry.fridayDate] = entry.isPresent;

      const mutationId = operationId
        ? computeDeterministicImportKey(operationId, studentId, entry.fridayDate)
        : `ATT_${safeStudentId}_${entry.fridayDate}_${generateUUID()}`;
      mutations.push({
        id: mutationId,
        action: 'attendance',
        studentId,
        studentCode: student.code,
        studentName: student.name,
        sourceSheet: entrySheet,
        payload: { friday: entry.fridayDate, isPresent: entry.isPresent },
        expectedVersion: baseVersion + idx,
        timestamp: seqTimestamp++,
        retryCount: 0,
        status: 'pending'
      });

      historyRecords.push({
        id: `${studentId}__${entry.fridayDate}`,
        studentId,
        studentCode: student.code,
        fridayDate: entry.fridayDate,
        status: entry.isPresent,
        recordedAt: seqTimestamp,
        sourceSheet: entrySheet
      });

      appliedCount++;
    });

    const latestHeldPresentDates = Object.keys(nextAtt)
      .filter((d) => nextAtt[d] === true && d <= cairoTodayIso)
      .sort();
    const computedLastAttendance =
      latestHeldPresentDates.length > 0
        ? latestHeldPresentDates[latestHeldPresentDates.length - 1]
        : student.lastAttendance || '';

    const latestHeldFriday = getLatestHeldFridayString();
    const attendanceStatus: 'حاضر' | 'غائب' =
      typeof nextAtt[latestHeldFriday] === 'boolean'
        ? nextAtt[latestHeldFriday]
          ? 'حاضر'
          : 'غائب'
        : student.attendanceStatus === 'حاضر'
        ? 'حاضر'
        : 'غائب';

    const monthlySummary = computeMonthlyAttendanceSummary(nextAtt);

    updatedStudents.push({
      ...student,
      att: nextAtt,
      attendanceStatus,
      attendanceTotal: Math.max(0, (student.attendanceTotal || 0) + totalDelta),
      attendanceMonth: monthlySummary.presentCount,
      lastAttendance: computedLastAttendance,
      version: baseVersion + studentEntries.length,
      hasUnsyncedLocalChanges: true
    });
  }

  return {
    updatedStudents,
    historyRecords,
    mutations,
    appliedCount,
    skippedDuplicateCount,
    blockedCount,
    futureBlockedCount,
    invalidSheetCount
  };
}

export function getAvailableAlphabetBuckets(
  students: Student[],
  filters: Pick<AppFilterState, 'sheet' | 'servant' | 'area'>
): DynamicAlphabetBucket[] {
  const targetServant = filters.servant ? filters.servant.trim() : '';
  const targetArea = filters.area ? filters.area.trim() : '';
  const targetSheet = filters.sheet;

  const scoped = students.filter((s) => {
    if (targetSheet !== '__ALL__' && s.sourceSheet !== targetSheet) return false;
    if (targetServant && s.servant.trim() !== targetServant) return false;
    if (targetArea && s.area.trim() !== targetArea) return false;
    return true;
  });

  return extractDynamicAlphabetBuckets(scoped);
}

export function resolveValidAlphabetFilter(
  currentLetter: string | null,
  availableBuckets: ReadonlyArray<DynamicAlphabetBucket>
): string | null {
  if (!currentLetter) return null;
  return availableBuckets.some((b) => b.letter === currentLetter) ? currentLetter : null;
}

export function filterStudentsByAppFilters(students: Student[], filters: AppFilterState): Student[] {
  const q = normalizeArabicText(filters.searchQuery);
  const targetServant = filters.servant ? filters.servant.trim() : '';
  const targetArea = filters.area ? filters.area.trim() : '';
  const availableBuckets = getAvailableAlphabetBuckets(students, filters);
  const targetLetter = resolveValidAlphabetFilter(filters.alphabetLetter, availableBuckets);
  const targetSheet = filters.sheet;

  return students.filter((s) => {
    if (targetSheet !== '__ALL__' && s.sourceSheet !== targetSheet) {
      return false;
    }
    if (targetServant && s.servant.trim() !== targetServant) {
      return false;
    }
    if (targetArea && s.area.trim() !== targetArea) {
      return false;
    }
    if (targetLetter) {
      const initial = normalizeArabicInitial(s.name);
      if (initial !== targetLetter) return false;
    }
    if (q) {
      const nameMatch = normalizeArabicText(s.name).includes(q);
      const codeMatch = normalizeArabicText(s.code).includes(q);
      const notesMatch = normalizeArabicText(s.notes).includes(q);
      const areaMatch = normalizeArabicText(s.area).includes(q);
      if (!nameMatch && !codeMatch && !notesMatch && !areaMatch) {
        return false;
      }
    }
    return true;
  });
}

// ============================================================================
// Core Production Engines for Queue and Sync (Exported for Direct Verification)
// ============================================================================

let queueExecutionTail: Promise<void> = Promise.resolve();
const batchUnsupportedEndpoints = new Set<string>();

export const MAX_AUTO_MUTATION_RETRIES = 10;
export const OFFLINE_QUEUE_LOCK_NAME = 'stgorge_offline_queue_lock';

export function clearBatchUnsupportedCache(): void {
  batchUnsupportedEndpoints.clear();
}

export function computeExponentialBackoffDelayMs(retryCount: number): number {
  const safeCount = Math.max(1, Math.floor(retryCount || 1));
  return Math.min(60_000, 2000 * Math.pow(2, safeCount - 1));
}

/**
 * Distinguishes permanent (non-retryable automatically) errors from transient failures
 * (network errors, timeouts, 5xx, 429, or recoverable auth expiry).
 */
export function isPermanentMutationFailure(
  httpStatus?: number,
  errorMessage?: string,
  action?: string
): boolean {
  if (action === 'delete') return true;
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404 || httpStatus === 422) {
    return true;
  }
  const msg = String(errorMessage || '');
  if (!msg) return false;
  return (
    /حذف المخدومين محظور/i.test(msg) ||
    /اسم التاب غير محدد أو غير صالح/i.test(msg) ||
    /اسم الفصل غير معتمد/i.test(msg) ||
    /التاب مش موجود/i.test(msg) ||
    /غير مصرح|لا يملك صلاحية/i.test(msg) ||
    /تاريخ غير صحيح|تاريخ غير صالح/i.test(msg) ||
    /الاسم غير موجود|الطالب غير موجود|المخدوم غير موجود/i.test(msg)
  );
}

export interface QueueEligibilityResult {
  eligible: OfflineMutation[];
  deferred: OfflineMutation[];
  conflicts: OfflineMutation[];
  permanentFailures: OfflineMutation[];
  exhaustedRetries: OfflineMutation[];
  blockedBySameStudent: OfflineMutation[];
  blockedStudentIds: Set<string>;
  nextEarliestRetryAt: number | null;
  targetBlockedReason?: string;
}

/**
 * Pure, deterministic queue eligibility evaluator shared across the processor and ALL automatic triggers:
 * - Respects nextRetryAt strictly (never sends early)
 * - Never auto-retries conflicts, permanent errors, or mutations exceeding maxAutoRetries
 * - Enforces strict chronological per-student ordering while allowing independent students to proceed
 * - Supports targeted single-item manual retry without bypassing earlier same-student operations
 */
export function evaluateQueueMutationEligibility(
  pending: OfflineMutation[],
  options?: {
    nowMs?: number;
    targetMutationId?: string;
    maxAutoRetries?: number;
  }
): QueueEligibilityResult {
  const nowMs = typeof options?.nowMs === 'number' ? options.nowMs : Date.now();
  const maxAutoRetries = options?.maxAutoRetries ?? MAX_AUTO_MUTATION_RETRIES;
  const targetMutationId = options?.targetMutationId;

  const eligible: OfflineMutation[] = [];
  const deferred: OfflineMutation[] = [];
  const conflicts: OfflineMutation[] = [];
  const permanentFailures: OfflineMutation[] = [];
  const exhaustedRetries: OfflineMutation[] = [];
  const blockedBySameStudent: OfflineMutation[] = [];
  const blockedStudentIds = new Set<string>();
  let nextEarliestRetryAt: number | null = null;

  const trackBlockedStudent = (studentId?: string) => {
    if (studentId) blockedStudentIds.add(studentId);
  };

  if (targetMutationId) {
    const targetIdx = pending.findIndex((m) => m.id === targetMutationId);
    if (targetIdx === -1) {
      return {
        eligible: [],
        deferred: [],
        conflicts: [],
        permanentFailures: [],
        exhaustedRetries: [],
        blockedBySameStudent: [],
        blockedStudentIds,
        nextEarliestRetryAt: null,
        targetBlockedReason: 'العملية المحددة غير موجودة في طابور الانتظار.'
      };
    }

    const target = pending[targetIdx];
    const earlierSameStudent = pending
      .slice(0, targetIdx)
      .find((m) => m.studentId && target.studentId && m.studentId === target.studentId);

    if (earlierSameStudent) {
      trackBlockedStudent(target.studentId);
      blockedBySameStudent.push(target);
      return {
        eligible: [],
        deferred: [],
        conflicts: earlierSameStudent.status === 'conflict' ? [earlierSameStudent] : [],
        permanentFailures:
          earlierSameStudent.isPermanentError || earlierSameStudent.errorCategory === 'permanent'
            ? [earlierSameStudent]
            : [],
        exhaustedRetries: [],
        blockedBySameStudent,
        blockedStudentIds,
        nextEarliestRetryAt: null,
        targetBlockedReason: `لا يمكن تجاوز عملية أقدم غير مكتملة لنفس المخدوم (${target.studentName || target.studentId}). يرجى معالجة العملية الأقدم أولاً.`
      };
    }

    return {
      eligible: [target],
      deferred: [],
      conflicts: [],
      permanentFailures: [],
      exhaustedRetries: [],
      blockedBySameStudent: [],
      blockedStudentIds,
      nextEarliestRetryAt: null
    };
  }

  for (const mut of pending) {
    const sid = mut.studentId || '';

    // Per-student chronological isolation: a later op for a blocked/deferred/conflicting student MUST wait
    if (sid && blockedStudentIds.has(sid)) {
      blockedBySameStudent.push(mut);
      continue;
    }

    if (mut.status === 'conflict') {
      conflicts.push(mut);
      trackBlockedStudent(sid);
      continue;
    }

    if (mut.isPermanentError === true || mut.errorCategory === 'permanent') {
      permanentFailures.push(mut);
      trackBlockedStudent(sid);
      continue;
    }

    if ((mut.retryCount || 0) >= maxAutoRetries) {
      exhaustedRetries.push(mut);
      trackBlockedStudent(sid);
      continue;
    }

    if (typeof mut.nextRetryAt === 'number' && Number.isFinite(mut.nextRetryAt) && mut.nextRetryAt > nowMs) {
      deferred.push(mut);
      trackBlockedStudent(sid);
      if (nextEarliestRetryAt === null || mut.nextRetryAt < nextEarliestRetryAt) {
        nextEarliestRetryAt = mut.nextRetryAt;
      }
      continue;
    }

    eligible.push(mut);
  }

  return {
    eligible,
    deferred,
    conflicts,
    permanentFailures,
    exhaustedRetries,
    blockedBySameStudent,
    blockedStudentIds,
    nextEarliestRetryAt
  };
}

export function hasDueQueueMutations(
  pending: OfflineMutation[],
  nowMs: number = Date.now(),
  maxAutoRetries: number = MAX_AUTO_MUTATION_RETRIES
): boolean {
  return evaluateQueueMutationEligibility(pending, { nowMs, maxAutoRetries }).eligible.length > 0;
}

/**
 * Unified serialization lock for ALL offline queue execution entry points:
 * - Chains an in-tab FIFO promise mutex (works in all runtimes including Node/tests/WebViews)
 * - Coordinates across browser tabs via Web Locks API (navigator.locks) when supported
 * - Always releases cleanly on BOTH success and thrown failure without deadlocks
 */
export async function withOfflineQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  let releaseLock!: () => void;
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const prevLock = queueExecutionTail;
  queueExecutionTail = prevLock.then(() => nextLock, () => nextLock);
  await prevLock;

  try {
    const lockManager =
      typeof navigator !== 'undefined' &&
      navigator.locks &&
      typeof navigator.locks.request === 'function'
        ? navigator.locks
        : null;

    if (lockManager) {
      let callbackInvoked = false;
      try {
        return await lockManager.request(
          OFFLINE_QUEUE_LOCK_NAME,
          { mode: 'exclusive' },
          async () => {
            callbackInvoked = true;
            return await fn();
          }
        );
      } catch (lockErr: any) {
        if (callbackInvoked) {
          throw lockErr;
        }
        // Fallback cleanly to the in-tab mutex if the environment denied Web Locks before invoking fn()
        return await fn();
      }
    }

    return await fn();
  } finally {
    releaseLock();
  }
}

function isAbortOrTimeoutError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || '');
  return /abort|timeout|timed out|مهلة/i.test(msg);
}

export function buildAppsScriptSinglePayload(mutation: OfflineMutation, relayKey: string): Record<string, any> {
  const payloadFriday = String(mutation.payload?.friday || '').trim();
  const payloadDate = String(mutation.payload?.date || payloadFriday).trim();
  const effectiveFriday = payloadFriday || payloadDate;
  const payloadPresent = mutation.payload?.isPresent ?? mutation.payload?.present ?? false;
  const followupStatus = mutation.payload?.status || mutation.payload?.method || mutation.payload?.type;
  const payloadRecordId =
    typeof mutation.payload?.recordId === 'string' && mutation.payload.recordId.trim()
      ? mutation.payload.recordId.trim()
      : undefined;
  const fields = mutation.payload?.fields || {
    name: mutation.studentName || '',
    servant: mutation.payload?.servant || '',
    code: mutation.studentCode || mutation.payload?.code || '',
    phoneStudent: mutation.payload?.phoneStudent || '',
    phoneParent1: mutation.payload?.phoneParent1 || '',
    phoneParent2: mutation.payload?.phoneParent2 || '',
    birthDate: mutation.payload?.birthDate || '',
    area: mutation.payload?.area || '',
    address: mutation.payload?.address || '',
    notes: mutation.payload?.notes || '',
    status: followupStatus || 'بدون',
    ...(typeof mutation.payload === 'object' && mutation.payload !== null ? mutation.payload : {})
  };

  const safeSheet = resolveValidSheetName(mutation.sourceSheet, 'نشط');

  return {
    sheet: safeSheet,
    sourceSheet: safeSheet,
    tab: safeSheet,
    name: mutation.studentName || '',
    studentName: mutation.studentName || '',
    studentId: mutation.studentId || '',
    studentCode: mutation.studentCode || '',
    action: mutation.action,
    // Strictly preserve original mutation friday and Cairo calendar date across all retries & timeout checks
    date: payloadDate,
    friday: effectiveFriday,
    ...(payloadRecordId ? { recordId: payloadRecordId } : {}),
    present: payloadPresent,
    isPresent: payloadPresent,
    token: relayKey,
    relayKey,
    idempotencyKey: mutation.id,
    id: mutation.id,
    expectedVersion: mutation.expectedVersion || 1,
    payload: {
      ...(mutation.payload || {}),
      ...(effectiveFriday ? { friday: effectiveFriday } : {}),
      ...(payloadDate ? { date: payloadDate } : {}),
      ...(payloadRecordId ? { recordId: payloadRecordId } : {})
    },
    type: followupStatus,
    status: followupStatus,
    followupStatus: followupStatus,
    callOutcome: mutation.payload?.callOutcome || undefined,
    notes: mutation.payload?.notes || '',
    fields: fields,
    mutation: {
      ...mutation,
      id: mutation.id,
      sourceSheet: safeSheet,
      studentName: mutation.studentName || '',
      payload: {
        ...(mutation.payload || {}),
        ...(effectiveFriday ? { friday: effectiveFriday } : {}),
        ...(payloadDate ? { date: payloadDate } : {}),
        ...(payloadRecordId ? { recordId: payloadRecordId } : {}),
        status: followupStatus,
        method: followupStatus,
        ...(mutation.payload?.callOutcome ? { callOutcome: mutation.payload.callOutcome } : {}),
        fields: fields
      }
    }
  };
}

/**
 * Verifies post-timeout (Unknown Result) whether timed-out operations were actually persisted
 * on the remote server BEFORE allowing deletion or retry.
 *
 * Phase 4.3.3 fail-closed contract:
 * - Supports BOTH attendance and followup (as well as update/add/delete) via exact mutation identity.
 * - Confirms persistence ONLY when remote idempotency lookup returns a valid RemotePersistenceProof
 *   matching mutationId, persisted: true, operation, studentId, sheetName, and friday/recordId.
 * - Distinguishes strictly between: verified_persisted, not_found_retryable, unknown,
 *   verification_unavailable, and conflict.
 * - NEVER falls back to unverified student-row existence or approximate name matching.
 */
export async function verifyMutationsAfterTimeout(
  timedOutMutations: OfflineMutation[],
  appsScriptUrl: string,
  user: AuthUser | null,
  verifyTimeoutMs: number
): Promise<{
  verifiedIds: string[];
  verifiedProofs: Record<string, RemotePersistenceProof>;
  outcomes: Record<string, TimeoutVerificationItemResult>;
  unconfirmedMutations: OfflineMutation[];
  conflictMutations: Array<{ mutation: OfflineMutation; error: string }>;
  verifyDurationMs: number;
}> {
  const verifyStart = Date.now();
  const keys = timedOutMutations.map((m) => m.id).filter(Boolean);
  const outcomes: Record<string, TimeoutVerificationItemResult> = {};
  const verifiedProofs: Record<string, RemotePersistenceProof> = {};

  if (keys.length === 0) {
    return {
      verifiedIds: [],
      verifiedProofs,
      outcomes,
      unconfirmedMutations: timedOutMutations,
      conflictMutations: [],
      verifyDurationMs: 0
    };
  }

  const markAllUnavailable = (reason: string) => {
    for (const m of timedOutMutations) {
      outcomes[m.id] = {
        mutationId: m.id,
        outcome: 'verification_unavailable',
        reason
      };
    }
  };

  try {
    let checkResp: Response;
    let checkJson: any = null;

    if (appsScriptUrl) {
      const relayKey = getEffectiveRelayKey();
      const firstValidSheet = resolveValidSheetName(timedOutMutations[0]?.sourceSheet, 'نشط');
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), verifyTimeoutMs);
      try {
        checkResp = await fetch(appsScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'checkIdempotency',
            sheet: firstValidSheet,
            sourceSheet: firstValidSheet,
            tab: firstValidSheet,
            relayKey,
            token: relayKey,
            keys,
            mutations: timedOutMutations.map((m) => ({
              mutationId: m.id,
              operation: m.action,
              studentId: m.studentId,
              sheetName: resolveValidSheetName(m.sourceSheet, firstValidSheet),
              friday: String(m.payload?.friday || m.payload?.date || '').trim() || undefined,
              date: String(m.payload?.date || '').trim() || undefined,
              recordId: m.payload?.recordId || undefined
            }))
          }),
          signal: controller.signal
        });
        checkJson = await checkResp.json().catch(() => null);
      } finally {
        clearTimeout(tId);
      }
    } else {
      const encodedKeys = encodeURIComponent(keys.join(','));
      const checkUrl = buildApiUrl(`/api/sheets/idempotency?keys=${encodedKeys}`);
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), verifyTimeoutMs);
      try {
        checkResp = await fetch(checkUrl, {
          method: 'GET',
          headers: getAuthHeaders(user?.token),
          signal: controller.signal
        });
        checkJson = await checkResp.json().catch(() => null);
      } finally {
        clearTimeout(tId);
      }
    }

    const endpointUnsupported =
      checkResp.status === 404 ||
      String(checkJson?.error || '').includes('action غير معروف') ||
      String(checkJson?.error || '').includes('التاب مش موجود');

    if (endpointUnsupported) {
      markAllUnavailable('verification_endpoint_unsupported');
    } else if (!checkResp.ok) {
      markAllUnavailable(`verification_http_${checkResp.status}`);
    } else if (!checkJson || checkJson.ok !== true || !checkJson.results || typeof checkJson.results !== 'object') {
      markAllUnavailable('invalid_verification_payload');
    } else {
      for (const mut of timedOutMutations) {
        const itemResult = validateTimeoutIdempotencyEntry(mut, checkJson.results[mut.id]);
        outcomes[mut.id] = itemResult;
        if (itemResult.outcome === 'verified_persisted' && itemResult.proof) {
          verifiedProofs[mut.id] = itemResult.proof;
        }
      }
    }
  } catch (verifyErr: any) {
    console.warn('[StGeorge Sync] Post-timeout verification check unavailable:', verifyErr);
    markAllUnavailable(isAbortOrTimeoutError(verifyErr) ? 'verification_timeout' : 'verification_network_error');
  }

  const verifiedIds: string[] = [];
  const conflictMutations: Array<{ mutation: OfflineMutation; error: string }> = [];
  const unconfirmedMutations: OfflineMutation[] = [];

  for (const mut of timedOutMutations) {
    const res = outcomes[mut.id] || {
      mutationId: mut.id,
      outcome: 'unknown' as const,
      reason: 'missing_verification_result'
    };
    if (res.outcome === 'verified_persisted' && verifiedProofs[mut.id]) {
      verifiedIds.push(mut.id);
    } else if (res.outcome === 'conflict') {
      conflictMutations.push({
        mutation: mut,
        error: res.conflictError || 'تعارض في التعديل المتزامن (HTTP 409)'
      });
    } else {
      unconfirmedMutations.push(mut);
    }
  }

  return {
    verifiedIds,
    verifiedProofs,
    outcomes,
    unconfirmedMutations,
    conflictMutations,
    verifyDurationMs: Date.now() - verifyStart
  };
}

export interface ProcessOfflineQueueCallbacks {
  onMutationStart?: (mutation: OfflineMutation) => void;
  onMutationSuccess?: (mutation: OfflineMutation) => void;
  onMutationError?: (mutation: OfflineMutation, error: string) => void;
  silent?: boolean;
  disableBatch?: boolean;
  batchSize?: number;
  singleTimeoutMs?: number;
  batchTimeoutMs?: number;
  verifyTimeoutMs?: number;
  targetMutationId?: string;
  nowMs?: number;
  maxAutoRetries?: number;
  isAutoTrigger?: boolean;
}

export async function executeProcessOfflineQueue(
  user: AuthUser | null,
  _isPreviewMode: boolean = false,
  onNotify?: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void,
  onRecordPushTime?: (pushIso: string) => void,
  callbacks?: ProcessOfflineQueueCallbacks
): Promise<SyncQueueExecutionReport> {
  return withOfflineQueueLock(() =>
    runProcessOfflineQueueSerial(
      user,
      _isPreviewMode,
      onNotify,
      onRecordPushTime,
      callbacks
    )
  );
}

async function runProcessOfflineQueueSerial(
  user: AuthUser | null,
  _isPreviewMode: boolean = false,
  onNotify?: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void,
  onRecordPushTime?: (pushIso: string) => void,
  callbacks?: ProcessOfflineQueueCallbacks
): Promise<SyncQueueExecutionReport> {
  const runStartMs = Date.now();
  const nowMs = typeof callbacks?.nowMs === 'number' ? callbacks.nowMs : runStartMs;
  const maxAutoRetries = callbacks?.maxAutoRetries ?? MAX_AUTO_MUTATION_RETRIES;
  const stageTotals = { prepMs: 0, networkMs: 0, verifyMs: 0, serverMs: 0 };

  // Capture targeted single-mutation manual retry ONLY for manual invocations (never stolen by background triggers)
  const effectiveTargetMutationId =
    callbacks?.targetMutationId ||
    (!callbacks?.isAutoTrigger ? consumePendingManualRetryTarget() || undefined : undefined);

  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    onNotify?.('وضع عدم الاتصال', 'لا يوجد اتصال بالإنترنت لإرسال العمليات المعلقة', 'warn');
    const pending = await idbGetPendingMutations();
    return {
      success: false,
      outcome: 'pending',
      sentCount: 0,
      deduplicatedCount: 0,
      verifiedPostTimeoutCount: 0,
      remainingCount: pending.length,
      unknownResultCount: pending.filter((m) => m.status === 'timeout_unknown').length,
      failedCount: pending.filter((m) => m.status === 'failed').length,
      conflictCount: pending.filter((m) => m.status === 'conflict').length,
      mode: 'single',
      totalDurationMs: Date.now() - runStartMs
    };
  }

  const appsScriptUrl = getEffectiveAppsScriptUrl();

  if (!appsScriptUrl && !hasConfiguredRemoteBackend() && isNativeCapacitorRuntime()) {
    onNotify?.('مطلوب رابط المزامنة', 'يرجى ضبط رابط Google Apps Script في تفاصيل المزامنة. العمليات محفوظة محلياً بأمان.', 'warn');
    const pending = await idbGetPendingMutations();
    for (const m of pending) {
      await idbUpdateMutationError(m.id, 'يرجى ضبط رابط Google Apps Script في تفاصيل المزامنة للمزامنة مع الشيت', 'failed');
    }
    return {
      success: false,
      outcome: 'failed',
      sentCount: 0,
      deduplicatedCount: 0,
      verifiedPostTimeoutCount: 0,
      remainingCount: pending.length,
      unknownResultCount: 0,
      failedCount: pending.length,
      conflictCount: 0,
      mode: 'single',
      totalDurationMs: Date.now() - runStartMs,
      lastError: 'مطلوب رابط المزامنة'
    };
  }

  const prepStart = Date.now();
  const pending = await idbGetPendingMutations();
  stageTotals.prepMs += Date.now() - prepStart;

  if (pending.length === 0) {
    return {
      success: true,
      outcome: 'success',
      sentCount: 0,
      deduplicatedCount: 0,
      verifiedPostTimeoutCount: 0,
      remainingCount: 0,
      unknownResultCount: 0,
      failedCount: 0,
      conflictCount: 0,
      mode: 'single',
      totalDurationMs: Date.now() - runStartMs,
      stageSummary: { ...stageTotals }
    };
  }

  const eligibility = evaluateQueueMutationEligibility(pending, {
    nowMs,
    targetMutationId: effectiveTargetMutationId,
    maxAutoRetries
  });

  if (effectiveTargetMutationId && eligibility.targetBlockedReason) {
    if (!callbacks?.silent) {
      onNotify?.('تعذر إعادة المحاولة', eligibility.targetBlockedReason, 'warn');
    }
    const unknownResultCount = pending.filter((m) => m.status === 'timeout_unknown').length;
    const failedCount = pending.filter((m) => m.status === 'failed').length;
    const conflictCount = pending.filter((m) => m.status === 'conflict').length;
    return {
      success: false,
      outcome: conflictCount > 0 ? 'conflict' : unknownResultCount > 0 ? 'timeout_unknown' : failedCount > 0 ? 'failed' : 'pending',
      sentCount: 0,
      deduplicatedCount: 0,
      verifiedPostTimeoutCount: 0,
      remainingCount: pending.length,
      unknownResultCount,
      failedCount,
      conflictCount,
      mode: 'single',
      totalDurationMs: Date.now() - runStartMs,
      stageSummary: { ...stageTotals },
      lastError: eligibility.targetBlockedReason
    };
  }

  const workQueue = eligibility.eligible;
  if (workQueue.length === 0) {
    const unknownResultCount = pending.filter((m) => m.status === 'timeout_unknown').length;
    const failedCount = pending.filter((m) => m.status === 'failed').length;
    const conflictCount = pending.filter((m) => m.status === 'conflict').length;
    const firstErr = pending.find((m) => m.lastError)?.lastError;
    return {
      success: false,
      outcome: conflictCount > 0 ? 'conflict' : unknownResultCount > 0 ? 'timeout_unknown' : failedCount > 0 ? 'failed' : 'pending',
      sentCount: 0,
      deduplicatedCount: 0,
      verifiedPostTimeoutCount: 0,
      remainingCount: pending.length,
      unknownResultCount,
      failedCount,
      conflictCount,
      mode: 'single',
      totalDurationMs: Date.now() - runStartMs,
      stageSummary: { ...stageTotals },
      lastError: firstErr
    };
  }

  const endpointKey = appsScriptUrl || buildApiUrl('/api/sheets');
  const maxChunkSize = Math.max(3, Math.min(30, callbacks?.batchSize ?? 15));
  const singleTimeoutMs = callbacks?.singleTimeoutMs ?? (appsScriptUrl ? 35000 : 25000);
  const batchTimeoutMs = callbacks?.batchTimeoutMs ?? (appsScriptUrl ? 55000 : 45000);
  const verifyTimeoutMs = callbacks?.verifyTimeoutMs ?? 15000;

  let sentCount = 0;
  let deduplicatedCount = 0;
  let verifiedPostTimeoutCount = 0;
  let usedBatch = false;
  let usedSingle = false;
  let lastErrorMsg: string | undefined;

  // Dynamic per-student isolation barrier during this pass:
  // Any student whose op fails/conflicts/times-out is added here so later ops for THAT student
  // cannot overtake it, while independent students proceed without Head-of-Line Blocking.
  const runtimeBlockedStudents = new Set<string>(eligibility.blockedStudentIds);

  const recordPushSuccessNow = () => {
    const nowIso = new Date().toISOString();
    try {
      localStorage.setItem('stgorge_last_successful_push_iso', nowIso);
    } catch {}
    onRecordPushTime?.(nowIso);
  };

  let cursor = 0;
  while (cursor < workQueue.length) {
    const head = workQueue[cursor];

    if (head.studentId && runtimeBlockedStudents.has(head.studentId)) {
      cursor++;
      continue;
    }

    const headResolvedSheet = resolveValidSheetName(head.sourceSheet, '');
    if (!headResolvedSheet) {
      const invalidErr = `اسم التاب غير محدد أو غير صالح (${String(head.sourceSheet)}) — تم إيقاف الإرسال قبل الوصول للخادم`;
      lastErrorMsg = invalidErr;
      if (head.studentId) runtimeBlockedStudents.add(head.studentId);
      await idbUpdateMutationError(head.id, invalidErr, 'failed', {
        nextRetryAt: null,
        isPermanentError: true,
        errorCategory: 'permanent'
      });
      callbacks?.onMutationError?.(head, invalidErr);
      cursor++;
      continue;
    }

    // Check if we can process a contiguous eligible attendance chunk in batch mode
    // (>= 3 consecutive same-sheet attendance ops; never batch in targeted single-retry mode)
    const canTryBatch =
      !effectiveTargetMutationId &&
      !callbacks?.disableBatch &&
      !batchUnsupportedEndpoints.has(endpointKey) &&
      head.action === 'attendance';

    let batchSlice: OfflineMutation[] = [];
    if (canTryBatch) {
      const targetSheet = headResolvedSheet;
      for (let j = cursor; j < workQueue.length && batchSlice.length < maxChunkSize; j++) {
        const candidate = workQueue[j];
        const candidateSheet = resolveValidSheetName(candidate.sourceSheet, '');
        if (
          candidate.action !== 'attendance' ||
          !candidateSheet ||
          candidateSheet !== targetSheet ||
          (candidate.studentId && runtimeBlockedStudents.has(candidate.studentId))
        ) {
          break;
        }
        batchSlice.push(candidate);
      }
    }

    if (batchSlice.length >= 3) {
      const chunkStartMs = Date.now();
      for (const m of batchSlice) callbacks?.onMutationStart?.(m);

      let fallbackToSingle = false;
      try {
        const netStart = Date.now();
        let response: Response;
        if (appsScriptUrl) {
          const relayKey = getEffectiveRelayKey();
          const chunkPayload = {
            action: 'batch',
            sheet: headResolvedSheet,
            sourceSheet: headResolvedSheet,
            tab: headResolvedSheet,
            relayKey,
            token: relayKey,
            mutations: batchSlice.map((m) => buildAppsScriptSinglePayload(m, relayKey))
          };
          const controller = new AbortController();
          const tId = setTimeout(() => controller.abort(), batchTimeoutMs);
          try {
            response = await fetch(appsScriptUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify(chunkPayload),
              signal: controller.signal
            });
          } finally {
            clearTimeout(tId);
          }
        } else {
          const batchUrl = buildApiUrl('/api/sheets/mutate-batch');
          const controller = new AbortController();
          const tId = setTimeout(() => controller.abort(), batchTimeoutMs);
          try {
            response = await fetch(batchUrl, {
              method: 'POST',
              headers: getAuthHeaders(user?.token),
              body: JSON.stringify({
                sheet: headResolvedSheet,
                sourceSheet: headResolvedSheet,
                tab: headResolvedSheet,
                mutations: batchSlice.map((m) => ({
                  ...m,
                  sourceSheet: resolveValidSheetName(m.sourceSheet, headResolvedSheet),
                  idempotencyKey: m.id
                }))
              }),
              signal: controller.signal
            });
          } finally {
            clearTimeout(tId);
          }
        }
        const netMs = Date.now() - netStart;
        stageTotals.networkMs += netMs;

        const resultJson = await response.json().catch(() => null);
        const batchUnsupported =
          response.status === 404 ||
          String(resultJson?.error || '').includes('action غير معروف');

        if (batchUnsupported) {
          batchUnsupportedEndpoints.add(endpointKey);
          fallbackToSingle = true;
          console.info('[StGeorge Sync] Remote endpoint returned unsupported batch; seamlessly falling back to single mode.');
        } else if (!response.ok || !resultJson?.ok || !Array.isArray(resultJson.results)) {
          let errDetail = resultJson?.error || `استجاب الخادم برمز خطأ (HTTP ${response.status})`;
          if (response.status === 401) {
            errDetail = 'يتطلب إرسال التعديلات للشيت تفعيل رابط Google Apps Script في إعدادات المنظومة أو تسجيل دخول موثق';
          } else if (response.status === 403) {
            errDetail = 'غير مصرح: الحساب الحالي لا يملك صلاحية تعديل هذا المخدوم';
          } else if (response.status >= 500) {
            errDetail = `الخادم غير متاح مؤقتاً (HTTP ${response.status})، سيُعاد الإرسال تلقائياً`;
          }
          lastErrorMsg = errDetail;
          const totalChunkMs = Date.now() - chunkStartMs;
          const isPermanentChunkErr = isPermanentMutationFailure(response.status, errDetail);
          const updates = batchSlice.map((m) => {
            if (m.studentId) runtimeBlockedStudents.add(m.studentId);
            const nextRetry = (m.retryCount || 0) + 1;
            const permanent = isPermanentChunkErr || isPermanentMutationFailure(response.status, errDetail, m.action);
            return {
              id: m.id,
              errorMessage: errDetail,
              status: 'failed' as const,
              meta: {
                nextRetryAt: permanent ? null : nowMs + computeExponentialBackoffDelayMs(nextRetry),
                isPermanentError: permanent,
                errorCategory: (permanent ? 'permanent' : 'transient') as 'permanent' | 'transient',
                lastDurationMs: totalChunkMs,
                stageTimingsMs: {
                  networkMs: netMs,
                  totalMs: totalChunkMs,
                  mode: 'batch' as const,
                  batchSize: batchSlice.length
                }
              }
            };
          });
          await idbUpdateMutationsBatchState(updates);
          for (const m of batchSlice) callbacks?.onMutationError?.(m, errDetail);
          if (response.status === 401 || response.status >= 500) {
            break;
          }
          cursor += batchSlice.length;
          continue;
        } else {
          usedBatch = true;
          if (typeof resultJson.serverDurationMs === 'number') {
            stageTotals.serverMs += resultJson.serverDurationMs;
          }

          // Inspect ALL batch results independently with strict per-item Remote Persistence Proof
          const confirmedEntries: Array<{ mut: OfflineMutation; proof: RemotePersistenceProof }> = [];
          const conflictHits: Array<{ mut: OfflineMutation; msg: string }> = [];
          const unverifiedHits: Array<{ mut: OfflineMutation; msg: string; outcome: TimeoutVerificationItemResult['outcome'] }> = [];
          const failedHits: Array<{ mut: OfflineMutation; msg: string; permanent: boolean }> = [];

          for (let k = 0; k < batchSlice.length; k++) {
            const itemMut = batchSlice[k];
            const itemRes = resultJson.results[k];
            if (itemRes?.status === 409 || itemRes?.outcome === 'conflict') {
              conflictHits.push({
                mut: itemMut,
                msg: itemRes?.error || 'تعارض في التعديل المتزامن (HTTP 409)'
              });
            } else if (
              itemRes?.outcome === 'timeout_unknown' ||
              itemRes?.status === 408 ||
              itemRes?.status === 504
            ) {
              unverifiedHits.push({
                mut: itemMut,
                msg:
                  itemRes?.error ||
                  buildTimeoutOutcomeErrorMessage('unknown', 'batch_item_timeout_unknown'),
                outcome: 'unknown'
              });
            } else if (itemRes?.ok) {
              const proofValidation = validateRemotePersistenceProof(itemMut, itemRes);
              if (proofValidation.valid && proofValidation.outcome === 'verified_persisted' && proofValidation.proof) {
                confirmedEntries.push({ mut: itemMut, proof: proofValidation.proof });
                if (itemRes.deduplicated || proofValidation.proof?.deduplicated) deduplicatedCount++;
              } else if (proofValidation.outcome === 'conflict') {
                conflictHits.push({
                  mut: itemMut,
                  msg: itemRes?.error || 'تعارض في التعديل المتزامن (HTTP 409)'
                });
              } else {
                unverifiedHits.push({
                  mut: itemMut,
                  msg: buildUnverifiedRemoteErrorMessage(proofValidation.reason),
                  outcome: proofValidation.outcome
                });
              }
            } else {
              const msg = itemRes?.error || 'رفض الخادم حفظ أحد سجلات الدفعة';
              const permanent = isPermanentMutationFailure(itemRes?.status, msg, itemMut.action);
              failedHits.push({ mut: itemMut, msg, permanent });
            }
          }

          if (confirmedEntries.length > 0) {
            await idbRemoveMutationsBatch(confirmedEntries.map((entry) => entry.mut.id));
            sentCount += confirmedEntries.length;
            recordPushSuccessNow();
            for (const entry of confirmedEntries) {
              callbacks?.onMutationSuccess?.({
                ...entry.mut,
                syncOutcome: 'success',
                verificationOutcome: 'verified_persisted',
                verifiedAt: entry.proof.verifiedAt || new Date().toISOString(),
                remoteRecordId: entry.proof.recordId
              });
            }
          }

          console.info(
            `[StGeorge Sync Telemetry] Batch chunk (${confirmedEntries.length}/${batchSlice.length} verified) | unverified=${unverifiedHits.length} | network=${netMs}ms | server=${resultJson.serverDurationMs ?? '-'}ms`
          );

          for (const hit of conflictHits) {
            lastErrorMsg = hit.msg;
            if (hit.mut.studentId) runtimeBlockedStudents.add(hit.mut.studentId);
            await idbMarkMutationConflict(hit.mut.id, hit.msg);
            onNotify?.('تعارض في التعديل', `العملية (${hit.mut.action}) تحتاج مراجعة أمين الخدمة: ${hit.msg}`, 'danger');
            callbacks?.onMutationError?.(hit.mut, hit.msg);
          }

          if (unverifiedHits.length > 0) {
            const totalChunkMs = Date.now() - chunkStartMs;
            const unverifiedUpdates = unverifiedHits.map((hit) => {
              lastErrorMsg = hit.msg;
              if (hit.mut.studentId) runtimeBlockedStudents.add(hit.mut.studentId);
              const nextRetry = (hit.mut.retryCount || 0) + 1;
              return {
                id: hit.mut.id,
                errorMessage: hit.msg,
                status: 'timeout_unknown' as const,
                meta: {
                  syncOutcome: 'timeout_unknown' as const,
                  verificationOutcome: hit.outcome,
                  nextRetryAt: nowMs + computeExponentialBackoffDelayMs(nextRetry),
                  isPermanentError: false,
                  errorCategory: 'timeout' as const,
                  lastDurationMs: totalChunkMs,
                  stageTimingsMs: {
                    networkMs: netMs,
                    totalMs: totalChunkMs,
                    mode: 'batch' as const,
                    batchSize: batchSlice.length
                  }
                }
              };
            });
            await idbUpdateMutationsBatchState(unverifiedUpdates);
            for (const hit of unverifiedHits) {
              callbacks?.onMutationError?.(hit.mut, hit.msg);
            }
          }

          if (failedHits.length > 0) {
            const totalChunkMs = Date.now() - chunkStartMs;
            const failedUpdates = failedHits.map((hit) => {
              lastErrorMsg = hit.msg;
              if (hit.mut.studentId) runtimeBlockedStudents.add(hit.mut.studentId);
              const nextRetry = (hit.mut.retryCount || 0) + 1;
              return {
                id: hit.mut.id,
                errorMessage: hit.msg,
                status: 'failed' as const,
                meta: {
                  nextRetryAt: hit.permanent ? null : nowMs + computeExponentialBackoffDelayMs(nextRetry),
                  isPermanentError: hit.permanent,
                  errorCategory: (hit.permanent ? 'permanent' : 'transient') as 'permanent' | 'transient',
                  lastDurationMs: totalChunkMs,
                  stageTimingsMs: {
                    networkMs: netMs,
                    totalMs: totalChunkMs,
                    mode: 'batch' as const,
                    batchSize: batchSlice.length
                  }
                }
              };
            });
            await idbUpdateMutationsBatchState(failedUpdates);
            for (const hit of failedHits) {
              callbacks?.onMutationError?.(hit.mut, hit.msg);
            }
          }

          cursor += batchSlice.length;
          continue;
        }
      } catch (batchNetErr: any) {
        const netMs = Date.now() - chunkStartMs;
        stageTotals.networkMs += netMs;

        if (isAbortOrTimeoutError(batchNetErr)) {
          // Critical: Server may have executed before response returned. Verify strict persistence proof FIRST!
          const initialTimeoutUpdates = batchSlice.map((m) => ({
            id: m.id,
            errorMessage: 'انتهت مهلة الاتصال بالخادم (Timeout) — جاري التحقق من إثبات حفظ الدفعة على الخادم قبل أي إعادة إرسال',
            status: 'timeout_unknown' as const,
            meta: {
              incrementRetry: true,
              errorCategory: 'timeout' as const,
              verificationOutcome: 'unknown' as const,
              lastDurationMs: netMs,
              stageTimingsMs: { networkMs: netMs, totalMs: netMs, mode: 'batch' as const, batchSize: batchSlice.length }
            }
          }));
          await idbUpdateMutationsBatchState(initialTimeoutUpdates);

          const verification = await verifyMutationsAfterTimeout(batchSlice, appsScriptUrl, user, verifyTimeoutMs);
          stageTotals.verifyMs += verification.verifyDurationMs;

          if (verification.verifiedIds.length > 0) {
            const verifiedIdSet = new Set(verification.verifiedIds);
            await idbRemoveMutationsBatch(verification.verifiedIds);
            sentCount += verification.verifiedIds.length;
            verifiedPostTimeoutCount += verification.verifiedIds.length;
            recordPushSuccessNow();
            for (const m of batchSlice) {
              if (verifiedIdSet.has(m.id)) {
                const verifiedProof = verification.verifiedProofs[m.id];
                callbacks?.onMutationSuccess?.({
                  ...m,
                  syncOutcome: 'success',
                  verificationOutcome: 'verified_persisted',
                  verifiedAt: verifiedProof?.verifiedAt || new Date().toISOString(),
                  remoteRecordId: verifiedProof?.recordId
                });
              }
            }
            console.info(
              `[StGeorge Sync Telemetry] Post-timeout verification confirmed ${verification.verifiedIds.length}/${batchSlice.length} batch mutations with valid persistence proof (verify=${verification.verifyDurationMs}ms)`
            );
          }

          for (const conflictHit of verification.conflictMutations) {
            lastErrorMsg = conflictHit.error;
            if (conflictHit.mutation.studentId) runtimeBlockedStudents.add(conflictHit.mutation.studentId);
            await idbMarkMutationConflict(conflictHit.mutation.id, conflictHit.error);
            onNotify?.('تعارض في التعديل', `العملية (${conflictHit.mutation.action}) تحتاج مراجعة أمين الخدمة: ${conflictHit.error}`, 'danger');
            callbacks?.onMutationError?.(conflictHit.mutation, conflictHit.error);
          }

          if (verification.unconfirmedMutations.length > 0) {
            await idbUpdateMutationsBatchState(
              verification.unconfirmedMutations.map((m) => {
                if (m.studentId) runtimeBlockedStudents.add(m.studentId);
                const retryNum = (m.retryCount || 0) + 1;
                const itemOutcome = verification.outcomes[m.id];
                const resolvedOutcome = itemOutcome?.outcome || 'unknown';
                const errMsg = buildTimeoutOutcomeErrorMessage(resolvedOutcome, itemOutcome?.reason || 'unconfirmed');
                lastErrorMsg = errMsg;
                return {
                  id: m.id,
                  errorMessage: errMsg,
                  status: 'timeout_unknown' as const,
                  meta: {
                    incrementRetry: false,
                    syncOutcome: 'timeout_unknown' as const,
                    verificationOutcome: resolvedOutcome,
                    errorCategory: 'timeout' as const,
                    nextRetryAt: nowMs + computeExponentialBackoffDelayMs(retryNum),
                    lastDurationMs: Date.now() - chunkStartMs,
                    stageTimingsMs: {
                      networkMs: netMs,
                      verifyMs: verification.verifyDurationMs,
                      totalMs: Date.now() - chunkStartMs,
                      mode: 'batch' as const,
                      batchSize: batchSlice.length
                    }
                  }
                };
              })
            );
            for (const um of verification.unconfirmedMutations) {
              const itemOutcome = verification.outcomes[um.id];
              const errMsg = buildTimeoutOutcomeErrorMessage(
                itemOutcome?.outcome || 'unknown',
                itemOutcome?.reason || 'unconfirmed'
              );
              callbacks?.onMutationError?.(um, errMsg);
            }
            break;
          }

          // All items in chunk were resolved (verified or conflict)! Advance cursor without re-executing!
          usedBatch = true;
          cursor += batchSlice.length;
          continue;
        }

        const errMsg = `تعذر الاتصال بالشبكة لإرسال الدفعة: ${batchNetErr?.message || 'انقطع الاتصال'}`;
        lastErrorMsg = errMsg;
        await idbUpdateMutationsBatchState(
          batchSlice.map((m) => {
            if (m.studentId) runtimeBlockedStudents.add(m.studentId);
            const nextRetry = (m.retryCount || 0) + 1;
            return {
              id: m.id,
              errorMessage: errMsg,
              status: 'failed' as const,
              meta: {
                nextRetryAt: nowMs + computeExponentialBackoffDelayMs(nextRetry),
                isPermanentError: false,
                errorCategory: 'transient' as const,
                lastDurationMs: Date.now() - chunkStartMs,
                stageTimingsMs: { networkMs: netMs, totalMs: Date.now() - chunkStartMs, mode: 'batch', batchSize: batchSlice.length }
              }
            };
          })
        );
        for (const m of batchSlice) callbacks?.onMutationError?.(m, errMsg);
        break;
      }

      if (!fallbackToSingle) {
        continue;
      }
    }

    // Single-mutation path (for single items, non-attendance ops, targeted manual retry, or fallback)
    const mutation = workQueue[cursor];
    const resolvedSingleSheet = resolveValidSheetName(mutation.sourceSheet, '');
    if (!resolvedSingleSheet) {
      const invalidErr = `اسم التاب غير محدد أو غير صالح (${String(mutation.sourceSheet)}) — تم إيقاف الإرسال`;
      lastErrorMsg = invalidErr;
      if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
      await idbUpdateMutationError(mutation.id, invalidErr, 'failed', {
        nextRetryAt: null,
        isPermanentError: true,
        errorCategory: 'permanent'
      });
      callbacks?.onMutationError?.(mutation, invalidErr);
      cursor++;
      continue;
    }

    const singleStartMs = Date.now();
    usedSingle = true;
    callbacks?.onMutationStart?.(mutation);
    try {
      const netStart = Date.now();
      let response: Response;
      if (appsScriptUrl) {
        const relayKey = getEffectiveRelayKey();
        const appsScriptBody = buildAppsScriptSinglePayload(
          { ...mutation, sourceSheet: resolvedSingleSheet },
          relayKey
        );
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), singleTimeoutMs);
        try {
          response = await fetch(appsScriptUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain;charset=utf-8'
            },
            body: JSON.stringify(appsScriptBody),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        const mutateUrl = buildApiUrl('/api/sheets/mutate');
        const headers: Record<string, string> = {
          ...getAuthHeaders(user?.token),
          'X-Idempotency-Key': toSafeHeaderAscii(mutation.id)
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), singleTimeoutMs);
        try {
          response = await fetch(mutateUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...mutation, sourceSheet: resolvedSingleSheet }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }
      const netMs = Date.now() - netStart;
      stageTotals.networkMs += netMs;

      if (response.status === 409) {
        const result = await response.json().catch(() => null);
        const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (HTTP 409)';
        lastErrorMsg = conflictMsg;
        if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
        await idbMarkMutationConflict(mutation.id, conflictMsg);
        onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة أمين الخدمة: ${conflictMsg}`, 'danger');
        callbacks?.onMutationError?.(mutation, conflictMsg);
        cursor++;
        continue;
      }

      if (response.ok) {
        const result = await response.json().catch(() => null);
        if (result && result.status === 409) {
          const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (409)';
          lastErrorMsg = conflictMsg;
          if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
          await idbMarkMutationConflict(mutation.id, conflictMsg);
          onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة: ${conflictMsg}`, 'danger');
          callbacks?.onMutationError?.(mutation, conflictMsg);
          cursor++;
          continue;
        }
        if (result && result.ok) {
          const proofValidation = validateRemotePersistenceProof(mutation, result);
          if (proofValidation.valid && proofValidation.outcome === 'verified_persisted' && proofValidation.proof) {
            await idbRemoveMutation(mutation.id);
            sentCount++;
            if (result.deduplicated || proofValidation.proof?.deduplicated) deduplicatedCount++;
            if (typeof result.serverDurationMs === 'number') {
              stageTotals.serverMs += result.serverDurationMs;
            }

            recordPushSuccessNow();
            callbacks?.onMutationSuccess?.({
              ...mutation,
              syncOutcome: 'success',
              verificationOutcome: 'verified_persisted',
              verifiedAt: proofValidation.proof.verifiedAt || new Date().toISOString(),
              remoteRecordId: proofValidation.proof.recordId
            });
            cursor++;
          } else if (proofValidation.outcome === 'conflict') {
            const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (409)';
            lastErrorMsg = conflictMsg;
            if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
            await idbMarkMutationConflict(mutation.id, conflictMsg);
            onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة: ${conflictMsg}`, 'danger');
            callbacks?.onMutationError?.(mutation, conflictMsg);
            cursor++;
            continue;
          } else {
            // Fail closed: generic `{ ok: true }` without valid persistence proof MUST NOT delete the mutation!
            const unverifiedMsg = buildUnverifiedRemoteErrorMessage(proofValidation.reason);
            lastErrorMsg = unverifiedMsg;
            console.warn(
              `[StGeorge Sync] Retaining unverified mutation ${mutation.id} (${proofValidation.reason})`
            );
            if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
            const nextRetry = (mutation.retryCount || 0) + 1;
            await idbUpdateMutationError(mutation.id, unverifiedMsg, 'timeout_unknown', {
              syncOutcome: 'timeout_unknown',
              verificationOutcome: proofValidation.outcome,
              nextRetryAt: nowMs + computeExponentialBackoffDelayMs(nextRetry),
              isPermanentError: false,
              errorCategory: 'timeout',
              lastDurationMs: Date.now() - singleStartMs,
              stageTimingsMs: { networkMs: netMs, totalMs: Date.now() - singleStartMs, mode: 'single' }
            });
            callbacks?.onMutationError?.(mutation, unverifiedMsg);
            cursor++;
            continue;
          }
        } else {
          const errMsg = result?.error || 'رفض Google Sheets العملية';
          lastErrorMsg = errMsg;
          console.warn(`Server rejected mutation ${mutation.id}:`, errMsg);
          if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
          const nextRetry = (mutation.retryCount || 0) + 1;
          const permanent = isPermanentMutationFailure(result?.status, errMsg, mutation.action);
          await idbUpdateMutationError(mutation.id, errMsg, 'failed', {
            nextRetryAt: permanent ? null : nowMs + computeExponentialBackoffDelayMs(nextRetry),
            isPermanentError: permanent,
            errorCategory: permanent ? 'permanent' : 'transient',
            lastDurationMs: Date.now() - singleStartMs,
            stageTimingsMs: { networkMs: netMs, totalMs: Date.now() - singleStartMs, mode: 'single' }
          });
          callbacks?.onMutationError?.(mutation, errMsg);
          cursor++;
          continue;
        }
      } else {
        let errDetail = `استجاب الخادم برمز خطأ (HTTP ${response.status})`;
        if (response.status === 401) {
          errDetail = 'يتطلب إرسال التعديلات للشيت تفعيل رابط Google Apps Script في إعدادات المنظومة أو تسجيل دخول موثق';
        } else if (response.status === 403) {
          errDetail = 'غير مصرح: الحساب الحالي لا يملك صلاحية تعديل هذا المخدوم';
        } else if (response.status >= 500) {
          errDetail = `الخادم غير متاح مؤقتاً (HTTP ${response.status})، سيُعاد الإرسال تلقائياً`;
        }
        lastErrorMsg = errDetail;
        console.warn(`Failed to sync mutation ${mutation.id}, HTTP status: ${response.status}`);
        if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
        const nextRetry = (mutation.retryCount || 0) + 1;
        const permanent = isPermanentMutationFailure(response.status, errDetail, mutation.action);
        await idbUpdateMutationError(mutation.id, errDetail, 'failed', {
          nextRetryAt: permanent ? null : nowMs + computeExponentialBackoffDelayMs(nextRetry),
          isPermanentError: permanent,
          errorCategory: permanent ? 'permanent' : 'transient',
          lastDurationMs: Date.now() - singleStartMs,
          stageTimingsMs: { networkMs: netMs, totalMs: Date.now() - singleStartMs, mode: 'single' }
        });
        callbacks?.onMutationError?.(mutation, errDetail);
        if (response.status === 401) {
          break;
        }
        cursor++;
        continue;
      }
    } catch (networkError: any) {
      const netMs = Date.now() - singleStartMs;
      stageTotals.networkMs += netMs;

      if (isAbortOrTimeoutError(networkError)) {
        // Post-timeout check BEFORE leaving as unconfirmed/retryable
        await idbUpdateMutationError(
          mutation.id,
          'انتهت مهلة الاتصال بالخادم (Timeout) — جاري التحقق من إثبات حفظ العملية على الخادم لتجنب التكرار',
          'timeout_unknown',
          {
            incrementRetry: true,
            verificationOutcome: 'unknown',
            errorCategory: 'timeout',
            lastDurationMs: netMs,
            stageTimingsMs: { networkMs: netMs, totalMs: netMs, mode: 'single' }
          }
        );

        const verification = await verifyMutationsAfterTimeout([mutation], appsScriptUrl, user, verifyTimeoutMs);
        stageTotals.verifyMs += verification.verifyDurationMs;

        if (verification.verifiedIds.includes(mutation.id)) {
          await idbRemoveMutation(mutation.id);
          sentCount++;
          verifiedPostTimeoutCount++;
          recordPushSuccessNow();
          const verifiedProof = verification.verifiedProofs[mutation.id];
          callbacks?.onMutationSuccess?.({
            ...mutation,
            syncOutcome: 'success',
            verificationOutcome: 'verified_persisted',
            verifiedAt: verifiedProof?.verifiedAt || new Date().toISOString(),
            remoteRecordId: verifiedProof?.recordId
          });
          cursor++;
          continue;
        }

        if (verification.conflictMutations.length > 0) {
          const conflictErr = verification.conflictMutations[0].error;
          lastErrorMsg = conflictErr;
          if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
          await idbMarkMutationConflict(mutation.id, conflictErr);
          onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة أمين الخدمة: ${conflictErr}`, 'danger');
          callbacks?.onMutationError?.(mutation, conflictErr);
          cursor++;
          continue;
        }

        const itemOutcome = verification.outcomes[mutation.id];
        const resolvedOutcome = itemOutcome?.outcome || 'unknown';
        const unknownErrMsg = buildTimeoutOutcomeErrorMessage(
          resolvedOutcome,
          itemOutcome?.reason || 'unconfirmed'
        );
        lastErrorMsg = unknownErrMsg;
        if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
        const retryNum = (mutation.retryCount || 0) + 1;
        await idbUpdateMutationError(mutation.id, unknownErrMsg, 'timeout_unknown', {
          incrementRetry: false,
          syncOutcome: 'timeout_unknown',
          verificationOutcome: resolvedOutcome,
          errorCategory: 'timeout',
          nextRetryAt: nowMs + computeExponentialBackoffDelayMs(retryNum),
          lastDurationMs: Date.now() - singleStartMs,
          stageTimingsMs: {
            networkMs: netMs,
            verifyMs: verification.verifyDurationMs,
            totalMs: Date.now() - singleStartMs,
            mode: 'single'
          }
        });
        callbacks?.onMutationError?.(mutation, unknownErrMsg);
        break;
      }

      const errMsg = `تعذر الاتصال بالشبكة لإرسال العملية: ${networkError?.message || 'انقطع الاتصال'}`;
      lastErrorMsg = errMsg;
      console.warn(`Network failure syncing mutation ${mutation.id}:`, networkError);
      if (mutation.studentId) runtimeBlockedStudents.add(mutation.studentId);
      const nextRetry = (mutation.retryCount || 0) + 1;
      await idbUpdateMutationError(mutation.id, errMsg, 'failed', {
        nextRetryAt: nowMs + computeExponentialBackoffDelayMs(nextRetry),
        isPermanentError: false,
        errorCategory: 'transient',
        lastDurationMs: Date.now() - singleStartMs,
        stageTimingsMs: { networkMs: netMs, totalMs: Date.now() - singleStartMs, mode: 'single' }
      });
      callbacks?.onMutationError?.(mutation, errMsg);
      break;
    }
  }

  const remaining = await idbGetPendingMutations();
  const unknownResultCount = remaining.filter((m) => m.status === 'timeout_unknown').length;
  const failedCount = remaining.filter((m) => m.status === 'failed').length;
  const conflictCount = remaining.filter((m) => m.status === 'conflict').length;
  const mode: 'batch' | 'single' | 'mixed' = usedBatch && usedSingle ? 'mixed' : usedBatch ? 'batch' : 'single';
  const totalDurationMs = Date.now() - runStartMs;

  const outcome: SyncOutcomeStatus =
    remaining.length === 0
      ? 'success'
      : conflictCount > 0
      ? 'conflict'
      : unknownResultCount > 0
      ? 'timeout_unknown'
      : failedCount > 0
      ? 'failed'
      : 'pending';

  if (sentCount > 0 && remaining.length === 0) {
    if (!callbacks?.silent) {
      onNotify?.('اكتمل إرسال العمليات', `تم تأكيد إرسال ${sentCount} عملية بنجاح للشيت`, 'success');
    }
    return {
      success: true,
      outcome: 'success',
      sentCount,
      deduplicatedCount,
      verifiedPostTimeoutCount,
      remainingCount: 0,
      unknownResultCount: 0,
      failedCount: 0,
      conflictCount: 0,
      mode,
      totalDurationMs,
      stageSummary: { ...stageTotals }
    };
  }

  if (effectiveTargetMutationId && sentCount > 0) {
    if (!callbacks?.silent) {
      onNotify?.('تمت إعادة المحاولة بنجاح', 'تم تأكيد إرسال العملية المحددة بنجاح إلى Google Sheets', 'success');
    }
    return {
      success: true,
      outcome: 'success',
      sentCount,
      deduplicatedCount,
      verifiedPostTimeoutCount,
      remainingCount: remaining.length,
      unknownResultCount,
      failedCount,
      conflictCount,
      mode,
      totalDurationMs,
      stageSummary: { ...stageTotals }
    };
  }

  if (sentCount > 0 && !callbacks?.silent) {
    onNotify?.('مزامنة جزئية', `تم إرسال ${sentCount} عملية بنجاح، ومتبقي ${remaining.length} عملية بالطابور`, 'warn');
  }

  return {
    success: false,
    outcome,
    sentCount,
    deduplicatedCount,
    verifiedPostTimeoutCount,
    remainingCount: remaining.length,
    unknownResultCount,
    failedCount,
    conflictCount,
    mode,
    totalDurationMs,
    stageSummary: { ...stageTotals },
    lastError: lastErrorMsg
  };
}

export async function executeSyncData(
  targetSheet: SheetName,
  user: AuthUser | null,
  _isPreviewMode: boolean = false,
  syncInProgressRef: { current: boolean },
  onNotify?: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void,
  onUpdateStudents?: (students: Student[]) => void,
  onRecordTimes?: (pullIso: string) => void,
  onRecordPushTime?: (pushIso: string) => void,
  onRecordError?: (errorMsg: string | null) => void,
  onUpdateFollowups?: (records: FollowupRecord[]) => void,
  onRecordPartialSync?: (info: PartialSyncInfo | null) => void
): Promise<SyncExecutionOutcome> {
  // Prevent concurrent sync executions
  if (syncInProgressRef.current) {
    console.warn('Sync is already in progress, skipping concurrent call.');
    return false;
  }

  syncInProgressRef.current = true;

  // Ensure critical/partial sync notifications always surface even during startup sync when onNotify is omitted
  const emitNotificationWithFallback = (
    title: string,
    desc: string,
    type: 'info' | 'warn' | 'success' | 'danger'
  ) => {
    if (typeof onNotify === 'function') {
      onNotify(title, desc, type);
      return;
    }
    try {
      const { notifications: existingNotifs } = loadAndMigrateNotifications();
      const dedupKey = computeNotificationDedupKey(title, desc, type);
      const nextNotif: AppNotification = {
        id: generateUUID(),
        dedupKey,
        title,
        desc,
        type,
        timestamp: Date.now(),
        unread: true,
        appVersion: CURRENT_NOTIFICATIONS_VERSION
      };
      saveNotificationsToStorage(upsertDeduplicatedNotification(existingNotifs, nextNotif));
    } catch {}
  };

  // Tag Relay / Express incoming student records with explicit version provenance:
  // A default version: 1 without an authoritative version column must NEVER be treated as newer proof.
  const tagNonGvizStudentsProvenance = (rawList: any[], explicitHasVersionColumn?: boolean): Student[] => {
    return rawList.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      if (typeof raw.hasRemoteVersion === 'boolean') return raw as Student;
      const parsedVer = Number(raw.version);
      const safeVer = Number.isFinite(parsedVer) && parsedVer >= 1 ? Math.floor(parsedVer) : 1;
      const hasAuthoritativeVersion =
        explicitHasVersionColumn === true
          ? Number.isFinite(parsedVer) && parsedVer >= 1
          : Number.isFinite(parsedVer) && parsedVer > 1;
      return {
        ...raw,
        version: safeVer,
        hasRemoteVersion: hasAuthoritativeVersion
      } as Student;
    });
  };

  const applyVerifiedGvizFollowups = async (
    roster: Student[],
    fallbackProbe?: any
  ): Promise<FollowupRecord[]> => {
    const fuRes = await fetchFollowupLogViaGvizDetailed(SPREADSHEET_ID, roster, fallbackProbe).catch((error) => {
      console.warn('Gviz follow-up log read failed:', error);
      return null;
    });
    if (!fuRes) return [];
    if (!fuRes.verified || !fuRes.isComplete || fuRes.isPartialParse) {
      console.warn(
        `[SafePull] Skipping unverified/partial Gviz follow-up log (${fuRes.reason || 'unverified'}); preserving local follow-up records.`
      );
      return [];
    }
    if (fuRes.records.length > 0) {
      const fuProof: FollowupPullVerificationProof = {
        verified: true,
        isComplete: true,
        isPartialParse: false,
        source: 'gviz',
        reason: fuRes.reason
      };
      const reconciledFu = await idbSaveRemoteFollowupRecords(fuRes.records, fuProof).catch(() => null);
      if (reconciledFu) {
        onUpdateFollowups?.(reconciledFu);
        return reconciledFu;
      }
    }
    return fuRes.records;
  };

  const applyVerifiedRelayFollowups = async (payloadData: any, source: 'relay' | 'express'): Promise<void> => {
    if (!Array.isArray(payloadData?.followupRecords) || payloadData.followupRecords.length === 0) return;
    const isVerified = payloadData.followupVerified !== false;
    const isComplete = payloadData.followupComplete !== false && payloadData.isComplete !== false;
    const isPartialParse = payloadData.followupPartialParse === true;
    if (!isVerified || !isComplete || isPartialParse) {
      console.warn(
        `[SafePull] Skipping unverified/partial ${source} follow-up log; preserving local follow-up records.`
      );
      return;
    }
    const fuProof: FollowupPullVerificationProof = {
      verified: true,
      isComplete: true,
      isPartialParse: false,
      source
    };
    const reconciledFu = await idbSaveRemoteFollowupRecords(payloadData.followupRecords, fuProof).catch(() => null);
    if (reconciledFu) {
      onUpdateFollowups?.(reconciledFu);
    }
  };

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
      throw new Error('لا يوجد اتصال بالإنترنت حالياً');
    }

    const appsScriptUrl = getEffectiveAppsScriptUrl();
    const relayKey = getEffectiveRelayKey();

    const hasExpressCredentials = Boolean(user?.token || relayKey || buildApiUrl('/api/sheets/data').startsWith('https://'));

    let data: any;

    if (appsScriptUrl) {
      // Path A: Direct Private Google Apps Script Relay (Reads + Writes + Private Sheet)
      const queueResult = await executeProcessOfflineQueue(user, false, onNotify, onRecordPushTime, {
        isAutoTrigger: true
      });
      if (!queueResult.success && queueResult.remainingCount > 0) {
        onNotify?.(
          'مزامنة مع حفظ المعلق',
          `توجد عمليات معلقة لم يتم تأكيد إرسالها بعد (${queueResult.remainingCount} متبقية)، جاري جلب أحدث البيانات مع الحفاظ على العمليات المحلية.`,
          'info'
        );
      }

      // Apps Script is the authenticated write relay. Read from it only when a client key
      // is configured and its response matches the current students contract.
      let relayReadSucceeded = false;
      if (relayKey) {
        try {
          const separator = appsScriptUrl.includes('?') ? '&' : '?';
          const relayQuery = `${appsScriptUrl}${separator}action=getStudents&sheet=${encodeURIComponent(targetSheet)}&t=${Date.now()}&relayKey=${encodeURIComponent(relayKey)}`;
          const res = await fetch(relayQuery, { method: 'GET' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const relayData = await res.json();
          if (!relayData || relayData.ok === false || !Array.isArray(relayData.students)) {
            throw new Error(relayData?.error || 'استجابة Apps Script لا تحتوي على students');
          }
          data = {
            ...relayData,
            source: relayData.source || 'relay',
            students: tagNonGvizStudentsProvenance(relayData.students, relayData.hasVersionColumn)
          };
          relayReadSucceeded = true;
        } catch (relayReadError: any) {
          console.warn('Apps Script read unavailable; falling back to Google Sheets Gviz:', relayReadError);
          onNotify?.('تعذر استخدام وسيط القراءة', 'سيتم جلب البيانات مباشرة من Google Sheets مع استمرار التحقق من عمليات الكتابة بشكل منفصل.', 'info');
        }
      } else {
        console.warn('RELAY_KEY is not configured; skipping Apps Script read and using Gviz. Queued writes remain protected.');
      }

      // Gviz is the read fallback (and the normal read path when the relay key is absent).
      // Every requested sheet must be confirmed before reconciliation can modify local data.
      const existingList = await idbGetStudents().catch(() => []);
      const mergeForFollowupLinking = (freshList: Student[]): Student[] => {
        const byId = new Map<string, Student>();
        existingList.forEach((s) => { if (s?.id) byId.set(s.id, s); });
        freshList.forEach((s) => { if (s?.id) byId.set(s.id, s); });
        return Array.from(byId.values());
      };

      if (!relayReadSucceeded) {
        const existingMap = new Map(existingList.map((student) => [student.id, student]));
        const gvizResult = await fetchSheetStudentsViaGviz(SPREADSHEET_ID, targetSheet, existingMap);
        const linkRoster = mergeForFollowupLinking(gvizResult.students);
        const remoteFollowups = await applyVerifiedGvizFollowups(linkRoster, gvizResult.fallbackProbe);
        const allRequestedVerified =
          gvizResult.unverifiedSheets.length === 0 &&
          gvizResult.failedSheets.length === 0 &&
          gvizResult.confirmedSheets.length > 0;
        data = {
          ok: allRequestedVerified,
          source: 'gviz',
          targetSheet,
          sheet: targetSheet,
          isComplete: allRequestedVerified,
          confirmedComplete: allRequestedVerified,
          confirmedSheets: gvizResult.confirmedSheets,
          confirmedEmptySheets: gvizResult.confirmedEmptySheets,
          unverifiedSheets: gvizResult.unverifiedSheets,
          failedSheets: gvizResult.failedSheets,
          sheetsMeta: gvizResult.sheetsMeta,
          students: gvizResult.students,
          followupRecords: remoteFollowups
        };
      } else if (Array.isArray(data.followupRecords) && data.followupRecords.length > 0) {
        await applyVerifiedRelayFollowups(data, 'relay');
      } else if (typeof onUpdateFollowups === 'function') {
        const linkRoster = mergeForFollowupLinking(Array.isArray(data.students) ? data.students : []);
        await applyVerifiedGvizFollowups(linkRoster);
      }
    } else if (!hasExpressCredentials && (isNativeCapacitorRuntime() || typeof window !== 'undefined')) {
      // Path B: Direct Real Google Sheets Visualization Reader (gviz/tq) when Relay/Express Auth not configured
      const existingList = await idbGetStudents().catch(() => []);
      const existingMap = new Map(existingList.map((s) => [s.id, s]));
      const gvizResult = await fetchSheetStudentsViaGviz(SPREADSHEET_ID, targetSheet, existingMap);
      const mergedMap = new Map(existingList.map((s) => [s.id, s]));
      gvizResult.students.forEach((s) => mergedMap.set(s.id, s));
      await applyVerifiedGvizFollowups(Array.from(mergedMap.values()), gvizResult.fallbackProbe);
      const allRequestedVerified =
        gvizResult.unverifiedSheets.length === 0 &&
        gvizResult.failedSheets.length === 0 &&
        gvizResult.confirmedSheets.length > 0;
      data = {
        ok: allRequestedVerified,
        source: 'gviz',
        targetSheet,
        sheet: targetSheet,
        isComplete: allRequestedVerified,
        confirmedComplete: allRequestedVerified,
        confirmedSheets: gvizResult.confirmedSheets,
        confirmedEmptySheets: gvizResult.confirmedEmptySheets,
        unverifiedSheets: gvizResult.unverifiedSheets,
        failedSheets: gvizResult.failedSheets,
        sheetsMeta: gvizResult.sheetsMeta,
        students: gvizResult.students
      };
    } else {
      if (!hasConfiguredRemoteBackend() && isNativeCapacitorRuntime()) {
        const msg = 'يرجى ضبط رابط Google Apps Script الآمن في تفاصيل المزامنة للاتصال بملف Google Sheets.';
        onNotify?.('مطلوب رابط المزامنة', msg, 'warn');
        onRecordError?.(msg);
        return false;
      }

      // Path C: Hosted Express Backend Proxy
      const healthCheckUrl = buildApiUrl('/api/health');
      let isBackendAlive = false;
      try {
        const healthRes = await fetch(healthCheckUrl, { method: 'GET' });
        isBackendAlive = healthRes.ok;
      } catch {
        isBackendAlive = false;
      }

      if (!isBackendAlive) {
        onNotify?.(
          'الخادم غير متصل',
          'فشل الاتصال الفعلي بالوسيط. تم إيقاف المزامنة والاحتفاظ بكافة العمليات المعلقة محلياً في IndexedDB.',
          'warn'
        );
        onRecordError?.('الخادم غير متصل (Server unreachable)');
        return false;
      }

      const queueResult = await executeProcessOfflineQueue(user, false, onNotify, onRecordPushTime, {
        isAutoTrigger: true
      });

      if (!queueResult.success && queueResult.remainingCount > 0) {
        onNotify?.(
          'مزامنة مع حفظ المعلق',
          `توجد عمليات معلقة لم يتم تأكيد إرسالها بعد (${queueResult.remainingCount} متبقية)، جاري جلب أحدث البيانات مع الحفاظ على العمليات المحلية.`,
          'info'
        );
      }

      const dataUrl = buildApiUrl(`/api/sheets/data?sheet=${encodeURIComponent(targetSheet)}&t=${Date.now()}`);
      const res = await fetch(dataUrl, {
        headers: getAuthHeaders(user?.token)
      });

      if (!res.ok) {
        throw new Error(`استجاب السيرفر بخطأ (HTTP ${res.status})`);
      }

      const rawData = await res.json();
      if (!rawData || !Array.isArray(rawData.students)) {
        throw new Error('بيانات الاستجابة من الشيت غير صالحة');
      }

      data = {
        ...rawData,
        source: rawData.source || 'express',
        students: tagNonGvizStudentsProvenance(rawData.students, rawData.hasVersionColumn)
      };

      if (Array.isArray(data.followupRecords) && data.followupRecords.length > 0) {
        await applyVerifiedRelayFollowups(data, 'express');
      } else {
        await applyVerifiedGvizFollowups(data.students);
      }
    }

    // Check remaining pending mutations after queue flush attempt
    const remainingMutations = await idbGetPendingMutations();

    let finalStudents: Student[];
    if (targetSheet === '__ALL__') {
      // Group incoming students by their sourceSheet to avoid bulk wipe and enforce strict sheet scoping
      const bySheet = new Map<string, Student[]>();
      for (const s of data.students) {
        if (s && s.sourceSheet) {
          if (!bySheet.has(s.sourceSheet)) bySheet.set(s.sourceSheet, []);
          bySheet.get(s.sourceSheet)!.push(s);
        }
      }

      // Explicitly include all live Google Sheet tabs and any verified sheets returned by server.
      // Never force in-app 'غير نشط' classification as a mandatory tab during __ALL__ sync.
      const sheetsToProcess = new Set<string>();
      LIVE_GOOGLE_SHEET_TABS.forEach((s) => sheetsToProcess.add(s));
      for (const sheetName of bySheet.keys()) {
        if (sheetName === INACTIVE_STUDENT_CLASSIFICATION) {
          const inactiveMeta = data?.sheetsMeta?.[INACTIVE_STUDENT_CLASSIFICATION];
          if (inactiveMeta?.verified === true && inactiveMeta?.isComplete === true) {
            sheetsToProcess.add(sheetName);
          }
        } else {
          sheetsToProcess.add(sheetName);
        }
      }

      // Uniform completeness criteria for BOTH Gviz and Relay/Express:
      // Every requested sheet MUST be independently verified before modifying its local records,
      // and ANY skipped/unverified/unconfirmed-empty sheet MUST be recorded in skippedUnverifiedSheets.
      const isGvizSource = data?.source === 'gviz';
      const appliedSheets: string[] = [];
      const skippedUnverifiedSheets: string[] = [];

      for (const sheetName of sheetsToProcess) {
        const sheetStudents = bySheet.get(sheetName) || [];
        const isSheetEmpty = sheetStudents.length === 0;
        const sheetMeta = data?.sheetsMeta?.[sheetName];

        const isExplicitlyUnverifiedOrFailed = Boolean(
          sheetMeta?.verified === false ||
          sheetMeta?.isComplete === false ||
          sheetMeta?.status === 'unverified' ||
          sheetMeta?.status === 'failed' ||
          (Array.isArray(data?.unverifiedSheets) && data.unverifiedSheets.includes(sheetName)) ||
          (Array.isArray(data?.failedSheets) && data.failedSheets.includes(sheetName))
        );

        if (isExplicitlyUnverifiedOrFailed) {
          console.warn(
            `[SafePull] Skipping unverified/incomplete sheet "${sheetName}" (${sheetMeta?.reason || 'unverified'}); preserving local IndexedDB data.`
          );
          skippedUnverifiedSheets.push(sheetName);
          continue;
        }

        if (isGvizSource && !(sheetMeta?.verified === true && sheetMeta?.isComplete === true && sheetMeta?.status === 'verified')) {
          console.warn(
            `[SafePull] Gviz pull for sheet "${sheetName}" lacks strict verification; preserving local IndexedDB data.`
          );
          skippedUnverifiedSheets.push(sheetName);
          continue;
        }

        if (
          !isGvizSource &&
          (data?.isComplete === false || data?.confirmedComplete === false) &&
          !(sheetMeta?.verified === true && sheetMeta?.isComplete === true)
        ) {
          console.warn(
            `[SafePull] Non-Gviz pull marked incomplete for sheet "${sheetName}"; preserving local IndexedDB data.`
          );
          skippedUnverifiedSheets.push(sheetName);
          continue;
        }

        // Specific independent confirmation for this sheetName:
        const isSheetConfirmedComplete = Boolean(
          data && (
            (Array.isArray(data.confirmedEmptySheets) && data.confirmedEmptySheets.includes(sheetName)) ||
            (Array.isArray(data.confirmedSheets) && data.confirmedSheets.includes(sheetName)) ||
            sheetMeta?.isComplete === true ||
            sheetMeta?.confirmedComplete === true
          )
        );

        if (isSheetEmpty && isSheetConfirmedComplete !== true) {
          // Unconfirmed empty response: PRESERVE local sheet data AND record in skippedUnverifiedSheets!
          console.warn(`Unconfirmed empty server response for sheet ${sheetName}; preserving local data.`);
          skippedUnverifiedSheets.push(sheetName);
          continue;
        }

        const effectiveComplete = isSheetEmpty ? isSheetConfirmedComplete : true;
        const pullProof: PullVerificationProof = {
          verified: true,
          isComplete: effectiveComplete,
          sheetName,
          source: isGvizSource ? 'gviz' : 'relay',
          reason: sheetMeta?.reason
        };

        const sheetHasPending = remainingMutations.some(
          (m) => !m.sourceSheet || m.sourceSheet === sheetName
        );

        if (sheetHasPending || remainingMutations.length > 0) {
          await idbReconcileStudents(sheetStudents, remainingMutations, sheetName, effectiveComplete, pullProof);
        } else {
          await idbSaveStudents(sheetStudents, sheetName, effectiveComplete, pullProof);
        }
        appliedSheets.push(sheetName);
      }

      if (appliedSheets.length === 0) {
        const msg = 'فشل التحقق من هوية أو أعمدة أي فصل من Google Sheets؛ تم الاحتفاظ بكافة البيانات المحلية دون تعديل.';
        onRecordPartialSync?.(null);
        onRecordError?.(msg);
        emitNotificationWithFallback('تعذر التحقق من بيانات الشيت', msg, 'warn');
        return false;
      }

      finalStudents = await idbGetStudents();
      onUpdateStudents?.(finalStudents);

      const nowIso = new Date().toISOString();

      // PARTIAL SYNC: One or more requested sheets were skipped/unverified.
      // CRITICAL: Do NOT update Last Successful Sync Time (onRecordTimes) and do NOT return true!
      if (skippedUnverifiedSheets.length > 0) {
        onRecordPartialSync?.({
          skippedSheets: skippedUnverifiedSheets,
          appliedSheets,
          timestamp: nowIso
        });
        emitNotificationWithFallback(
          'مزامنة جزئية — تم حماية الفصول غير المؤكدة',
          `تم تحديث الفصول المؤكدة فقط (${appliedSheets.join('، ')}) مع الإبقاء على البيانات المحلية للفصول غير المؤكدة (${skippedUnverifiedSheets.join('، ')}). لم يتم تحديث وقت آخر مزامنة مكتملة.`,
          'warn'
        );

        if (remainingMutations.length > 0) {
          const partialError = formatPullWithPendingQueueMessage(remainingMutations, true);
          onRecordError?.(partialError);
          return false;
        }

        onRecordError?.(null);
        return 'partial';
      }

      // FULL SYNC: All requested sheets were verified and applied.
      onRecordPartialSync?.(null);
      onRecordTimes?.(nowIso);

      if (remainingMutations.length === 0) {
        onRecordError?.(null);
        onNotify?.('تم التحديث بنجاح', 'تم تحديث جميع الفصول بنجاح دون المساس بأي بيانات محلية', 'success');
        return true;
      } else {
        const partialError = formatPullWithPendingQueueMessage(remainingMutations, false);
        onRecordError?.(partialError);
        onNotify?.(
          'المزامنة غير مكتملة',
          `تم سحب بيانات الفصول، لكن فشل تأكيد إرسال العمليات المعلقة (${remainingMutations.length}). لم يتم حذف أي عملية محلية.`,
          'warn'
        );
        return false;
      }
    } else {
      // Single sheet handling
      const isGvizSource = data?.source === 'gviz';
      const isSheetEmpty = data.students.length === 0;
      const targetMeta = data?.sheetsMeta?.[targetSheet];

      const isTargetExplicitlyUnverifiedOrFailed = Boolean(
        targetMeta?.verified === false ||
        targetMeta?.isComplete === false ||
        targetMeta?.status === 'unverified' ||
        targetMeta?.status === 'failed' ||
        (Array.isArray(data?.unverifiedSheets) && data.unverifiedSheets.includes(targetSheet)) ||
        (Array.isArray(data?.failedSheets) && data.failedSheets.includes(targetSheet)) ||
        (isGvizSource && !(targetMeta?.verified === true && targetMeta?.isComplete === true && targetMeta?.status === 'verified')) ||
        (!isGvizSource && (data?.isComplete === false || data?.confirmedComplete === false))
      );

      if (isTargetExplicitlyUnverifiedOrFailed) {
        const reasonDetail = targetMeta?.reason ? ` (${targetMeta.reason})` : '';
        const msg = `تم رفض استبدال بيانات فصل (${targetSheet}) لأن استجابة السحب غير مُتحقَّق منها أو غير مكتملة${reasonDetail}. تم الاحتفاظ بكافة البيانات المحلية.`;
        onRecordError?.(msg);
        emitNotificationWithFallback('تم حماية البيانات المحلية', msg, 'warn');
        return false;
      }

      // Completeness confirmation MUST be explicitly linked to targetSheet:
      // A generic data.isComplete or data.confirmedComplete without explicit sheet association is strictly rejected!
      const isTargetSheetConfirmedComplete = Boolean(
        data && (
          ((data.targetSheet === targetSheet || data.sheet === targetSheet || data.sheetName === targetSheet) &&
            (data.isComplete === true || data.confirmedComplete === true)) ||
          (Array.isArray(data.confirmedEmptySheets) && data.confirmedEmptySheets.includes(targetSheet)) ||
          (Array.isArray(data.confirmedSheets) && data.confirmedSheets.includes(targetSheet)) ||
          targetMeta?.isComplete === true ||
          targetMeta?.confirmedComplete === true
        )
      );

      if (isSheetEmpty && isTargetSheetConfirmedComplete !== true) {
        onRecordError?.(`استجابة فارغة غير مؤكدة لفصل (${targetSheet})`);
        emitNotificationWithFallback(
          'استجابة فارغة غير مؤكدة',
          `استجابة السيرفر لفصل (${targetSheet}) فارغة دون دليل اكتمال الجلب لفصل (${targetSheet}) تحديداً. تم الاحتفاظ بالبيانات المحلية كاملة منعاً لأي مسح غير مقصود.`,
          'warn'
        );
        return false;
      }

      const effectiveComplete = isSheetEmpty ? isTargetSheetConfirmedComplete : true;
      const pullProof: PullVerificationProof = {
        verified: true,
        isComplete: effectiveComplete,
        sheetName: targetSheet,
        source: isGvizSource ? 'gviz' : 'relay',
        reason: targetMeta?.reason
      };

      if (remainingMutations.length > 0) {
        finalStudents = await idbReconcileStudents(
          data.students,
          remainingMutations,
          targetSheet,
          effectiveComplete,
          pullProof
        );
        onUpdateStudents?.(finalStudents);
        const nowIso = new Date().toISOString();
        onRecordTimes?.(nowIso);
        const partialError = formatPullWithPendingQueueMessage(remainingMutations, false);
        onRecordError?.(partialError);
        onNotify?.(
          'المزامنة غير مكتملة',
          `تم سحب بيانات الفصل، لكن فشل تأكيد إرسال العمليات المعلقة (${remainingMutations.length}). لم يتم حذف أي عملية.`,
          'warn'
        );
        return false;
      } else {
        await idbSaveStudents(data.students, targetSheet, effectiveComplete, pullProof);
        finalStudents = await idbGetStudents();
        onUpdateStudents?.(finalStudents);

        const nowIso = new Date().toISOString();
        onRecordTimes?.(nowIso);

        onRecordError?.(null);
        onNotify?.('تم التحديث بنجاح', `تم تحديث فصل (${targetSheet}) بنجاح دون المساس بالفصول الأخرى`, 'success');
        return true;
      }
    }
  } catch (err: any) {
    onRecordError?.(err?.message || 'تعذر الاتصال بالخادم، المعروض هو آخر كاش محلي');
    emitNotificationWithFallback('فشل التحديث', err?.message || 'تعذر الاتصال بالخادم، المعروض هو آخر كاش محلي', 'danger');
    return false;
  } finally {
    syncInProgressRef.current = false;
  }
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isPreviewMode, canPerformAction } = useAuth();

  const [students, setStudents] = useState<Student[]>([]);
  const [followupRecords, setFollowupRecords] = useState<FollowupRecord[]>([]);
  const didMigrateNotificationsRef = useRef<boolean>(false);
  const [notifications, setNotifications] = useState<AppNotification[]>(() => {
    const migration = loadAndMigrateNotifications();
    didMigrateNotificationsRef.current = migration.didMigrate;
    return migration.notifications;
  });

  const [filters, setFilters] = useState<AppFilterState>({
    searchQuery: '',
    sheet: 'نشط',
    servant: '',
    area: '',
    alphabetLetter: null
  });

  const [activeView, setActiveViewState] = useState<'cards' | 'table' | 'charts' | 'followup'>('cards');
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const syncInProgressLock = useRef<boolean>(false);

  // Separation of Full ISO Timestamps: Attempt, Push (Mutations out), and Pull (Data in)
  const [lastSyncAttemptTime, setLastSyncAttemptTime] = useState<string | null>(null);
  const [lastSuccessfulPushTime, setLastSuccessfulPushTime] = useState<string | null>(() => {
    return safeGetLocalStorage('stgorge_last_successful_push_iso');
  });
  const [lastSuccessfulPullTime, setLastSuccessfulPullTime] = useState<string | null>(() => {
    return safeGetLocalStorage('stgorge_last_successful_pull_iso');
  });

  // Display sync string: chooses mathematically latest timestamp between push and pull (Date + Time)
  const latestSyncIso = useMemo(() => {
    return computeLatestSyncTime(lastSuccessfulPullTime, lastSuccessfulPushTime);
  }, [lastSuccessfulPullTime, lastSuccessfulPushTime]);

  const lastSuccessfulSyncTime = useMemo(() => {
    return formatLastSyncDateTime(latestSyncIso);
  }, [latestSyncIso]);

  const lastSuccessfulSyncCompact = useMemo(() => {
    return formatLastSyncCompact(latestSyncIso);
  }, [latestSyncIso]);

  const [pendingMutationsCount, setPendingMutationsCount] = useState<number>(0);
  const [inFlightStudentIds, setInFlightStudentIds] = useState<string[]>([]);
  const [syncedStudentIds, setSyncedStudentIds] = useState<string[]>([]);
  const [pendingStudentIds, setPendingStudentIds] = useState<string[]>([]);
  const [isQueueProcessing, setIsQueueProcessing] = useState<boolean>(false);
  const [lastSyncReport, setLastSyncReport] = useState<SyncQueueExecutionReport | null>(null);
  const queueLockRef = useRef<boolean>(false);
  const queueNeedsRerunRef = useRef<boolean>(false);
  const backoffRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerAutoProcessQueueRef = useRef<((isImmediateUserAction?: boolean) => Promise<SyncQueueExecutionReport | void>) | null>(null);

  const refreshPendingState = useCallback(async () => {
    try {
      const pending = await idbGetPendingMutations();
      setPendingMutationsCount(pending.length);
      const studentIds = Array.from(new Set(pending.map((m) => m.studentId).filter(Boolean)));
      setPendingStudentIds(studentIds);
      return pending;
    } catch (e) {
      console.warn('Could not refresh pending list:', e);
      return [];
    }
  }, []);

  const [activeEditingId, setActiveEditingId] = useState<string | null>(null);
  const [hasUnsavedEditChanges, setHasUnsavedEditChanges] = useState<boolean>(false);
  const activeEditingIdRef = useRef<string | null>(null);
  const hasUnsavedEditChangesRef = useRef<boolean>(false);
  activeEditingIdRef.current = activeEditingId;
  hasUnsavedEditChangesRef.current = hasUnsavedEditChanges;

  const [activeToast, setActiveToast] = useState<AppNotification | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (backoffRetryTimerRef.current) {
        clearTimeout(backoffRetryTimerRef.current);
        backoffRetryTimerRef.current = null;
      }
      syncedTimersRef.current.forEach((timer) => clearTimeout(timer));
      syncedTimersRef.current.clear();
    };
  }, []);

  // Online status detection
  const [isOnline, setIsOnline] = useState<boolean>(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return true;
  });

  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [partialSyncInfo, setPartialSyncInfo] = useState<PartialSyncInfo | null>(null);
  const addNotificationRef = useRef<
    ((title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void) | null
  >(null);

  // Modals & Drawers state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    return safeGetLocalStorage('stgorge_sidebar_collapsed') === '1';
  });
  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notificationsActiveTab, setNotificationsActiveTab] = useState<'feed' | 'settings'>('feed');
  const [isAreaModalOpen, setIsAreaModalOpen] = useState(false);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
  const [isAppearanceModalOpen, setIsAppearanceModalOpen] = useState(false);
  const [isPdfImportModalOpen, setIsPdfImportModalOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpenState] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('stgorge_sidebar_collapsed', isSidebarCollapsed ? '1' : '0');
      }
    } catch {}
  }, [isSidebarCollapsed]);

  // Computed Sync Status reflecting 7 real states (including persistent 'partial' state)
  const syncState = useMemo<AppSyncState>(() => {
    if (!isOnline) return 'offline';
    if (isSyncing || isQueueProcessing) return 'syncing';
    if (lastSyncError) return 'failed';
    if (pendingMutationsCount > 0) return 'pending';
    if (partialSyncInfo && partialSyncInfo.skippedSheets.length > 0) return 'partial';
    if (lastSuccessfulSyncTime) return 'synced';
    return 'connected';
  }, [isOnline, isSyncing, isQueueProcessing, lastSyncError, pendingMutationsCount, partialSyncInfo, lastSuccessfulSyncTime]);

  // Online / Offline window listeners & backoff-aware auto-drain
  useEffect(() => {
    const triggerIfDue = () => {
      if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
        return;
      }
      idbGetPendingMutations()
        .then((pending) => {
          if (hasDueQueueMutations(pending)) {
            void triggerAutoProcessQueueRef.current?.(false);
          }
        })
        .catch(() => {});
    };

    const handleOnline = () => {
      setIsOnline(true);
      setLastSyncError(null);
      triggerIfDue();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        triggerIfDue();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const interval = setInterval(() => {
      triggerIfDue();
    }, 20000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(interval);
    };
  }, []);

  // Keep Weekly Local Notifications synced cleanly with Africa/Cairo clock & DST (no past missed triggers)
  // On upgrade migration, clear stale already-delivered shade items once while preserving channels/permissions.
  useEffect(() => {
    if (didMigrateNotificationsRef.current) {
      didMigrateNotificationsRef.current = false;
      void clearDeliveredNativeNotificationsOnce();
    }
    void syncWeeklyNotificationSchedules().catch(() => {});
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void syncWeeklyNotificationSchedules().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Load real cached IndexedDB data first, purge any legacy mock records, then sync real Google Sheets data
  useEffect(() => {
    let mounted = true;
    async function loadCacheAndInitialSync() {
      try {
        // Remove any leftover legacy mock records (`mock-*`) cleanly
        await idbPurgeMockRecords().catch(() => 0);

        // Atomically migrate any legacy row-indexed student IDs (`gs_<sheet>_<code>_<row>`)
        // to stable code-based IDs across all 4 IndexedDB stores before reading state.
        await idbMigrateLegacyStudentIds().catch(() => null);

        const [cachedStudents, historyRecords] = await Promise.all([
          idbGetStudents(),
          idbGetAttendanceHistory().catch(() => [])
        ]);

        if (mounted && cachedStudents.length > 0) {
          // Overlay any locally stored historical attendance records not yet merged
          if (historyRecords.length > 0) {
            const histByStudent = new Map<string, Record<string, boolean>>();
            for (const h of historyRecords) {
              if (!histByStudent.has(h.studentId)) histByStudent.set(h.studentId, {});
              histByStudent.get(h.studentId)![h.fridayDate] = h.status;
            }
            const merged = cachedStudents.map((st) => {
              const localHist = histByStudent.get(st.id);
              if (!localHist) return normalizeStudentRecord(st);
              const nextAtt = { ...localHist, ...(st.att || {}) };
              return normalizeStudentRecord({
                ...st,
                att: nextAtt,
                attendanceMonth: computeMonthlyAttendanceSummary(nextAtt).presentCount
              });
            });
            setStudents(merged);
          } else {
            setStudents(cachedStudents.map((st) => normalizeStudentRecord(st)));
          }
        }
        const cachedFollowup = await idbGetFollowupRecords();
        if (mounted && cachedFollowup.length > 0) {
          setFollowupRecords(cachedFollowup);
        }
        await refreshPendingState();

        // Pull authoritative real data from Google Sheets when online (never invent mock data on failure).
        // NOTE: executeSyncData already runs a single unified offline-queue flush before pulling;
        // do NOT call triggerAutoProcessQueueRef separately here to prevent duplicate startup processing.
        const onlineNow = typeof navigator === 'undefined' || navigator.onLine !== false;
        if (mounted && onlineNow) {
          setIsSyncing(true);
          setLastSyncAttemptTime(new Date().toISOString());
          const targetOnBoot: SheetName = '__ALL__';
          const startupNotify = (
            title: string,
            desc?: string,
            type: 'info' | 'warn' | 'success' | 'danger' = 'info'
          ) => {
            if (!mounted) return;
            if (type === 'warn' || type === 'danger') {
              addNotificationRef.current?.(title, desc, type);
            }
          };
          const ok = await executeSyncData(
            targetOnBoot,
            user,
            false,
            syncInProgressLock,
            startupNotify,
            (fresh) => {
              if (mounted) setStudents(fresh.map((s) => normalizeStudentRecord(s)));
            },
            (nowIso) => {
              if (mounted) {
                setLastSuccessfulPullTime(nowIso);
                setLastSyncError(null);
                try {
                  localStorage.setItem('stgorge_last_successful_pull_iso', nowIso);
                } catch {}
              }
            },
            (pushIso) => {
              if (mounted) setLastSuccessfulPushTime(pushIso);
            },
            (errorMsg) => {
              if (mounted) setLastSyncError(errorMsg);
            },
            (freshFollowups) => {
              if (mounted) setFollowupRecords(freshFollowups);
            },
            (partialInfo) => {
              if (mounted) setPartialSyncInfo(partialInfo);
            }
          );
          if (mounted) {
            if (ok === true || ok === 'partial') setLastSyncError(null);
            setIsSyncing(false);
            const postPending = await idbGetPendingMutations().catch(() => []);
            if (mounted) {
              setPendingMutationsCount(postPending.length);
              const postEval = evaluateQueueMutationEligibility(postPending);
              if (postEval.nextEarliestRetryAt !== null && !backoffRetryTimerRef.current) {
                const delayMs = Math.max(1000, Math.min(60000, postEval.nextEarliestRetryAt - Date.now()));
                backoffRetryTimerRef.current = setTimeout(() => {
                  backoffRetryTimerRef.current = null;
                  void triggerAutoProcessQueueRef.current?.(false);
                }, delayMs);
              }
            }
          }
        } else if (mounted && cachedStudents.length === 0) {
          setLastSyncError('تعذر تحميل البيانات: لا يوجد اتصال بالإنترنت ولا توجد بيانات محفوظة محلياً.');
        }
      } catch (err: any) {
        console.warn('Initial real data load warning:', err);
        if (mounted) {
          setLastSyncError(err?.message || 'تعذر تحميل البيانات من Google Sheets');
          setIsSyncing(false);
        }
      } finally {
        if (mounted) {
          setIsInitialLoading(false);
        }
      }
    }
    loadCacheAndInitialSync();
    return () => {
      mounted = false;
    };
  }, []);

  const reloadLocalDatabaseState = useCallback(async () => {
    const [cachedStudents, historyRecords, cachedFollowup] = await Promise.all([
      idbGetStudents(),
      idbGetAttendanceHistory().catch(() => []),
      idbGetFollowupRecords()
    ]);

    if (historyRecords.length > 0) {
      const histByStudent = new Map<string, Record<string, boolean>>();
      for (const h of historyRecords) {
        if (!histByStudent.has(h.studentId)) histByStudent.set(h.studentId, {});
        histByStudent.get(h.studentId)![h.fridayDate] = h.status;
      }
      setStudents(
        cachedStudents.map((st) => {
          const localHist = histByStudent.get(st.id);
          if (!localHist) return normalizeStudentRecord(st);
          const nextAtt = { ...localHist, ...(st.att || {}) };
          return normalizeStudentRecord({
            ...st,
            att: nextAtt,
            attendanceMonth: computeMonthlyAttendanceSummary(nextAtt).presentCount
          });
        })
      );
    } else {
      setStudents(cachedStudents.map((st) => normalizeStudentRecord(st)));
    }

    setFollowupRecords(cachedFollowup);
    await refreshPendingState();
    const migrated = loadAndMigrateNotifications();
    if (Array.isArray(migrated.notifications) && migrated.notifications.length > 0) {
      setNotifications((prev) => deduplicateNotifications([...prev, ...migrated.notifications]));
    }
  }, [refreshPendingState]);

  // Sync notifications to localStorage (deduplicated)
  useEffect(() => {
    saveNotificationsToStorage(notifications);
  }, [notifications]);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setActiveToast(null);
  }, []);

  const addNotification = useCallback(
    (
      title: string,
      desc?: string,
      type: 'info' | 'warn' | 'success' | 'danger' = 'info',
      options?: { id?: string; dedupKey?: string }
    ) => {
      const dedupKey = computeNotificationDedupKey(title, desc, type, options?.dedupKey);
      const newNotif: AppNotification = {
        id: options?.id?.trim() || generateUUID(),
        dedupKey,
        title,
        desc,
        type,
        timestamp: Date.now(),
        unread: true,
        appVersion: CURRENT_NOTIFICATIONS_VERSION
      };
      setNotifications((prev) => upsertDeduplicatedNotification(prev, newNotif));
      setActiveToast(newNotif);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        setActiveToast(null);
      }, 4500);
    },
    []
  );
  addNotificationRef.current = addNotification;

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
  }, []);

  const clearReadNotifications = useCallback(() => {
    setNotifications((prev) => {
      const unreadOnly = clearReadNotificationsFromList(prev);
      saveNotificationsToStorage(unreadOnly);
      return unreadOnly;
    });
  }, []);

  // Single Active Edit Guard & Safe Add Modal Wrapper
  const setIsAddModalOpen = useCallback(
    (open: boolean) => {
      if (open && activeEditingId) {
        addNotification(
          'يوجد كارت قيد التعديل',
          'يرجى حفظ أو إلغاء تعديل الكارت المفتوح حالياً قبل إضافة مخدوم جديد.',
          'warn'
        );
        return;
      }
      if (!open) {
        setHasUnsavedEditChanges(false);
      }
      setIsAddModalOpenState(open);
    },
    [activeEditingId, addNotification]
  );

  const requestEditStudent = useCallback(
    (studentId: string): boolean => {
      const check = evaluateSingleActiveEditLock(activeEditingId, studentId, isAddModalOpen);
      if (!check.allowed) {
        const activeStudent = students.find((s) => s.id === activeEditingId);
        const detail = activeStudent
          ? `لديك كارت قيد التعديل حالياً (${activeStudent.name}). يرجى الحفظ أو الإلغاء أولاً.`
          : check.reason || 'يوجد كارت آخر قيد التعديل.';
        addNotification('كارت واحد فقط للتعديل', detail, 'warn');
        return false;
      }
      setActiveEditingId(studentId);
      setHasUnsavedEditChanges(false);
      return true;
    },
    [activeEditingId, isAddModalOpen, students, addNotification]
  );

  const cancelEditing = useCallback(() => {
    setActiveEditingId(null);
    setHasUnsavedEditChanges(false);
    setIsAddModalOpenState(false);
  }, []);

  const setActiveView = useCallback(
    (nextView: 'cards' | 'table' | 'charts' | 'followup') => {
      if ((activeEditingIdRef.current || isAddModalOpen) && hasUnsavedEditChangesRef.current) {
        addNotification(
          'يوجد تعديل غير محفوظ',
          'يرجى حفظ التعديلات أو إلغاؤها أولاً قبل الانتقال لتبويب آخر حتى لا تفقد بياناتك.',
          'warn'
        );
        return;
      }
      if (activeEditingIdRef.current || isAddModalOpen) {
        setActiveEditingId(null);
        setHasUnsavedEditChanges(false);
        setIsAddModalOpenState(false);
      }
      setActiveViewState(nextView);
    },
    [isAddModalOpen, addNotification]
  );

  const availableAlphabetBuckets = useMemo(() => {
    return getAvailableAlphabetBuckets(students, filters);
  }, [students, filters.sheet, filters.servant, filters.area]);

  // Automatically reset selected letter to All (null) if the last matching student disappears
  useEffect(() => {
    if (!filters.alphabetLetter) return;
    const stillExists = availableAlphabetBuckets.some((b) => b.letter === filters.alphabetLetter);
    if (!stillExists) {
      setFilters((prev) => (prev.alphabetLetter === filters.alphabetLetter ? { ...prev, alphabetLetter: null } : prev));
    }
  }, [filters.alphabetLetter, availableAlphabetBuckets]);

  // Filtered Students logic
  const filteredStudents = useMemo(() => {
    return filterStudentsByAppFilters(students, filters);
  }, [students, filters]);

  // 1. Automatic Real-Time Queue Processor with Unified Lock, Eligibility Guard & Backoff Scheduler
  const triggerAutoProcessQueue = useCallback(
    async (isImmediateUserAction: boolean = false): Promise<SyncQueueExecutionReport | void> => {
      if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
        setIsOnline(false);
        await refreshPendingState();
        if (isImmediateUserAction) {
          addNotification(
            'محفوظة في الانتظار',
            'تم تسجيل العملية محلياً بأمان، وستتم المزامنة تلقائياً مع Google Sheets فور توفر الاتصال بالإنترنت.',
            'info'
          );
        }
        return;
      }

      // Check eligibility BEFORE clearing any active backoff timer so background triggers never cancel backoff
      const initialPending = await refreshPendingState();
      const initialEligibility = evaluateQueueMutationEligibility(initialPending);
      if (initialEligibility.eligible.length === 0) {
        if (initialEligibility.nextEarliestRetryAt !== null && !backoffRetryTimerRef.current) {
          const delayMs = Math.max(1000, Math.min(60000, initialEligibility.nextEarliestRetryAt - Date.now()));
          backoffRetryTimerRef.current = setTimeout(() => {
            backoffRetryTimerRef.current = null;
            void triggerAutoProcessQueueRef.current?.(false);
          }, delayMs);
        }
        return;
      }

      if (backoffRetryTimerRef.current) {
        clearTimeout(backoffRetryTimerRef.current);
        backoffRetryTimerRef.current = null;
      }

      if (queueLockRef.current) {
        queueNeedsRerunRef.current = true;
        return;
      }

      queueLockRef.current = true;
      setIsQueueProcessing(true);
      let latestReport: SyncQueueExecutionReport | undefined;

      try {
        do {
          queueNeedsRerunRef.current = false;
          const pending = await refreshPendingState();
          if (!hasDueQueueMutations(pending)) break;

          latestReport = await executeProcessOfflineQueue(
            user,
            isPreviewMode,
            addNotification,
            (pushIso) => {
              setLastSuccessfulPushTime(pushIso);
            },
            {
              isAutoTrigger: true,
              silent: isImmediateUserAction && pending.length === 1,
              onMutationStart: (mut) => {
                if (mut.studentId) {
                  setInFlightStudentIds((prev) => Array.from(new Set([...prev, mut.studentId])));
                }
              },
              onMutationSuccess: (mut) => {
                if (mut.studentId) {
                  setInFlightStudentIds((prev) => prev.filter((id) => id !== mut.studentId));
                  setSyncedStudentIds((prev) => Array.from(new Set([...prev, mut.studentId])));
                  const prevTimer = syncedTimersRef.current.get(mut.studentId);
                  if (prevTimer) clearTimeout(prevTimer);
                  const timer = setTimeout(() => {
                    syncedTimersRef.current.delete(mut.studentId);
                    setSyncedStudentIds((prev) => prev.filter((id) => id !== mut.studentId));
                  }, 3500);
                  syncedTimersRef.current.set(mut.studentId, timer);
                }
                if (
                  isImmediateUserAction &&
                  pending.length === 1 &&
                  (mut.action === 'followup' || mut.action === 'update' || mut.action === 'add')
                ) {
                  const actionLabel =
                    mut.action === 'followup'
                      ? 'الافتقاد'
                      : mut.action === 'update'
                      ? 'تعديل البيانات'
                      : 'إضافة المخدوم';
                  const verifiedNotif = buildRemoteVerifiedNotification(
                    1,
                    `تم تأكيد حفظ ${actionLabel} للمخدوم ${mut.studentName || mut.studentId} على Google Sheets بنجاح.`
                  );
                  addNotification(verifiedNotif.title, verifiedNotif.desc, verifiedNotif.type);
                }
              },
              onMutationError: (mut, err) => {
                if (mut.studentId) {
                  setInFlightStudentIds((prev) => prev.filter((id) => id !== mut.studentId));
                }
                if (isImmediateUserAction && pending.length <= 2) {
                  addNotification(
                    'محفوظة في الانتظار',
                    `تعذر إرسال العملية للشيت حالياً (${err})، تم حفظها محلياً بأمان وستتم المزامنة تلقائياً.`,
                    'warn'
                  );
                }
              }
            }
          );

          setLastSyncReport(latestReport);
          if (latestReport.success) {
            setLastSyncError(null);
          } else if (latestReport.lastError) {
            setLastSyncError(latestReport.lastError);
          }

          await refreshPendingState();
        } while (queueNeedsRerunRef.current);

        // Schedule Exponential Backoff auto-retry ONLY for deferred transient retryable items
        // (strictly excludes conflicts, permanent failures, and exhausted retries)
        const remainingAfterRun = await idbGetPendingMutations().catch(() => []);
        const postEval = evaluateQueueMutationEligibility(remainingAfterRun);
        if (
          postEval.nextEarliestRetryAt !== null &&
          (typeof navigator === 'undefined' || navigator.onLine !== false)
        ) {
          if (backoffRetryTimerRef.current) {
            clearTimeout(backoffRetryTimerRef.current);
          }
          const delayMs = Math.max(1000, Math.min(60000, postEval.nextEarliestRetryAt - Date.now()));
          backoffRetryTimerRef.current = setTimeout(() => {
            backoffRetryTimerRef.current = null;
            void triggerAutoProcessQueueRef.current?.(false);
          }, delayMs);
        }
      } catch (err) {
        console.warn('Auto queue execution error:', err);
      } finally {
        queueLockRef.current = false;
        setIsQueueProcessing(false);
        setInFlightStudentIds([]);
        await refreshPendingState();
      }
      return latestReport;
    },
    [user, isPreviewMode, addNotification, refreshPendingState]
  );
  triggerAutoProcessQueueRef.current = triggerAutoProcessQueue;

  // Manual trigger from Modals / UI (routes through the exact same unified lock & respects targeted single retry)
  const processOfflineQueue = useCallback(async (): Promise<SyncQueueExecutionReport> => {
    const manualTargetId = consumePendingManualRetryTarget() || undefined;
    setIsQueueProcessing(true);
    try {
      const res = await executeProcessOfflineQueue(
        user,
        isPreviewMode,
        addNotification,
        (pushIso) => {
          setLastSuccessfulPushTime(pushIso);
        },
        manualTargetId ? { targetMutationId: manualTargetId } : undefined
      );
      setLastSyncReport(res);
      if (res.success) {
        setLastSyncError(null);
      } else if (res.lastError) {
        setLastSyncError(res.lastError);
      }
      const postRemaining = await refreshPendingState();
      const postEval = evaluateQueueMutationEligibility(postRemaining);
      if (
        postEval.nextEarliestRetryAt !== null &&
        !backoffRetryTimerRef.current &&
        (typeof navigator === 'undefined' || navigator.onLine !== false)
      ) {
        const delayMs = Math.max(1000, Math.min(60000, postEval.nextEarliestRetryAt - Date.now()));
        backoffRetryTimerRef.current = setTimeout(() => {
          backoffRetryTimerRef.current = null;
          void triggerAutoProcessQueueRef.current?.(false);
        }, delayMs);
      }
      return res;
    } finally {
      setIsQueueProcessing(false);
    }
  }, [user, isPreviewMode, addNotification, refreshPendingState]);

  // Safe queue clear: requires explicit confirmation + fresh validated backup export before removing
  // targeted (or all) mutations, atomically recalculates student hasUnsyncedLocalChanges flags, and
  // NEVER marks discarded operations as remotely synchronized.
  const clearOfflineQueue = useCallback(
    async (options?: {
      targetMutationIds?: string[];
      confirmed?: boolean;
      downloader?: QueueBackupDownloader;
    }): Promise<SafeClearQueueResult> => {
      const result = await executeSafeClearMutations({
        targetMutationIds: options?.targetMutationIds,
        confirmed: options?.confirmed === true,
        downloader: options?.downloader
      });

      if (!result.ok) {
        await refreshPendingState();
        return result;
      }

      if (backoffRetryTimerRef.current) {
        clearTimeout(backoffRetryTimerRef.current);
        backoffRetryTimerRef.current = null;
      }

      setInFlightStudentIds([]);
      const remaining = await refreshPendingState();

      // Reload students from IndexedDB so React state immediately reflects recalculated hasUnsyncedLocalChanges
      try {
        const freshStudents = await idbGetStudents();
        if (!hasUnsavedEditChangesRef.current) {
          setStudents(freshStudents.map((s) => normalizeStudentRecord(s)));
        }
      } catch (reloadErr) {
        console.warn('Failed to reload student flags after safe queue clear:', reloadErr);
      }

      return {
        ...result,
        remainingCount: remaining.length,
        verifiedEmpty: remaining.length === 0
      };
    },
    [refreshPendingState]
  );

  // 2. Sync Data: Delegates to production engine + protects open edit session
  const syncData = useCallback(async (overrideSheet?: SheetName): Promise<boolean> => {
    if (activeEditingIdRef.current && hasUnsavedEditChangesRef.current) {
      addNotification(
        'تم تأجيل المزامنة مؤقتاً',
        'لديك كارت به تعديلات غير محفوظة. احفظ التعديلات أو ألغها ثم أعد المزامنة.',
        'warn'
      );
      return false;
    }

    setIsSyncing(true);
    const attemptIso = new Date().toISOString();
    setLastSyncAttemptTime(attemptIso);

    const requestedTarget = overrideSheet || filters.sheet;
    const res = await executeSyncData(
      requestedTarget,
      user,
      isPreviewMode,
      syncInProgressLock,
      addNotification,
      (fresh) => {
        if (!hasUnsavedEditChangesRef.current) {
          setStudents(fresh.map((s) => normalizeStudentRecord(s)));
        }
      },
      (nowIso) => {
        setLastSuccessfulPullTime(nowIso);
        setLastSyncError(null);
        try {
          localStorage.setItem('stgorge_last_successful_pull_iso', nowIso);
        } catch {}
      },
      (pushIso) => {
        setLastSuccessfulPushTime(pushIso);
      },
      (errorMsg) => {
        setLastSyncError(errorMsg);
      },
      setFollowupRecords,
      (partialInfo) => {
        setPartialSyncInfo(partialInfo);
      }
    );

    if (res === true || res === 'partial') {
      setLastSyncError(null);
    }
    if (requestedTarget !== '__ALL__' && res === true) {
      setPartialSyncInfo((prev) => {
        if (!prev) return null;
        const remainingSkipped = prev.skippedSheets.filter((s) => s !== requestedTarget);
        if (remainingSkipped.length === 0) return null;
        return {
          ...prev,
          skippedSheets: remainingSkipped,
          appliedSheets: Array.from(new Set([...prev.appliedSheets, requestedTarget]))
        };
      });
    }

    setIsSyncing(false);
    try {
      const pending = await idbGetPendingMutations();
      setPendingMutationsCount(pending.length);
    } catch {}
    return res === true;
  }, [filters.sheet, user, isPreviewMode, addNotification]);

  // 3. Mark Attendance: Unique UUID per intentional action, Africa/Cairo Friday dates, atomic history + deduplicated queue
  const markAttendance = useCallback(
    async (studentId: string, isPresent: boolean, targetFridayDate?: string): Promise<boolean> => {
      const student = students.find((s) => s.id === studentId);
      if (!student) return false;

      // Granular RBAC check
      const permission = canPerformAction('attendance', student.servant);
      if (!permission.allowed) {
        addNotification('غير مصرح', permission.reason || 'العملية تتطلب تسجيل دخول موثق', 'warn');
        return false;
      }

      const cairoTodayIso = getCairoDateParts().isoDate;
      const friday = targetFridayDate || getLatestHeldFridayString();

      // Strictly disallow marking attendance on future Fridays that have not been held yet
      if (friday > cairoTodayIso) {
        addNotification('جمعة مستقبلية', 'لا يمكن تسجيل حضور لجمعة لم تنعقد بعد.', 'warn');
        return false;
      }

      const prevVal = student.att?.[friday];
      if (prevVal === isPresent) return true; // Already recorded with exact same state

      // Each distinct intentional action gets a unique operation ID (RFC 4122 UUID)
      const opId = generateUUID();
      const safeStudentId = toSafeHeaderAscii(studentId);
      const idempotencyKey = `ATT_${safeStudentId}_${friday}_${opId}`;

      const nextAtt: Record<string, boolean> = { ...(student.att || {}), [friday]: isPresent };
      const monthlySummary = computeMonthlyAttendanceSummary(nextAtt);
      const totalDelta = isPresent ? (prevVal === true ? 0 : 1) : (prevVal === true ? -1 : 0);

      // Compute most accurate lastAttendance date
      let computedLastAttendance = student.lastAttendance;
      if (isPresent) {
        if (!student.lastAttendance || friday >= student.lastAttendance) {
          computedLastAttendance = friday;
        }
      } else if (student.lastAttendance === friday) {
        const priorAttDates = Object.keys(nextAtt)
          .filter((d) => nextAtt[d] === true && d <= cairoTodayIso)
          .sort();
        computedLastAttendance = priorAttDates.length > 0 ? priorAttDates[priorAttDates.length - 1] : '';
      }

      const updatedStudent: Student = {
        ...student,
        att: nextAtt,
        attendanceStatus: isPresent ? 'حاضر' : 'غائب',
        attendanceTotal: Math.max(0, student.attendanceTotal + totalDelta),
        attendanceMonth: monthlySummary.presentCount,
        lastAttendance: computedLastAttendance,
        version: (student.version || 1) + 1,
        hasUnsyncedLocalChanges: true
      };

      const mutation: OfflineMutation = {
        id: idempotencyKey,
        action: 'attendance',
        studentId,
        studentCode: student.code,
        studentName: student.name,
        sourceSheet: student.sourceSheet,
        payload: { friday, isPresent },
        expectedVersion: student.version,
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending'
      };

      const historyRecord = {
        id: `${studentId}__${friday}`,
        studentId,
        studentCode: student.code,
        fridayDate: friday,
        status: isPresent,
        recordedAt: Date.now(),
        sourceSheet: student.sourceSheet
      };

      const priorStudents = students;
      try {
        const persisted = await idbAtomicRecordAttendanceWithMutation(updatedStudent, historyRecord, mutation);
        setStudents((prev) => prev.map((s) => (s.id === studentId ? persisted.student : s)));

        await refreshPendingState();
        void triggerAutoProcessQueue(true);

        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('فشل الحفظ في قاعدة البيانات', err?.message || 'تعذر تسجيل الحضور محلياً', 'danger');
        return false;
      }
    },
    [students, isPreviewMode, canPerformAction, addNotification, refreshPendingState, triggerAutoProcessQueue]
  );

  // 3b. Batch Attendance Import (Multi-Date PDF Sheet): Atomic single-transaction write + OCC-chained chunked queue
  const importAttendanceBatch = useCallback(
    async (
      entries: BatchAttendanceEntryInput[],
      options?: { operationId?: string }
    ): Promise<{
      success: boolean;
      appliedCount: number;
      skippedDuplicateCount: number;
      blockedCount: number;
      futureBlockedCount: number;
      queuedCount: number;
      syncReport?: SyncQueueExecutionReport;
      error?: string;
    }> => {
      const existingPending = await idbGetPendingMutations().catch(() => [] as OfflineMutation[]);
      const plan = prepareBatchAttendanceMutations(
        entries,
        students,
        canPerformAction,
        getCairoDateParts().isoDate,
        options?.operationId,
        existingPending
      );
      const extraQueuedSkipped = 0;

      if ((plan.invalidSheetCount || 0) > 0 && plan.appliedCount === 0) {
        const badTabMsg = 'تعذر إرسال سجلات الحضور: اسم التاب المستهدف غير محدد أو غير صالح (undefined).';
        addNotification('تاب غير صالح للاستيراد', badTabMsg, 'danger');
        return {
          success: false,
          appliedCount: 0,
          skippedDuplicateCount: plan.skippedDuplicateCount + extraQueuedSkipped,
          blockedCount: plan.blockedCount,
          futureBlockedCount: plan.futureBlockedCount,
          queuedCount: 0,
          error: badTabMsg
        };
      }

      if (plan.mutations.some((m) => !isValidTargetTabName(m.sourceSheet))) {
        const badMutMsg = 'تم إيقاف الحفظ: توجد عمليات بدون اسم تاب صحيح في ملف الاستيراد.';
        addNotification('تاب غير صالح للاستيراد', badMutMsg, 'danger');
        return {
          success: false,
          appliedCount: 0,
          skippedDuplicateCount: plan.skippedDuplicateCount + extraQueuedSkipped,
          blockedCount: plan.blockedCount,
          futureBlockedCount: plan.futureBlockedCount,
          queuedCount: 0,
          error: badMutMsg
        };
      }

      if (plan.appliedCount === 0) {
        if (plan.blockedCount > 0 && plan.skippedDuplicateCount === 0) {
          addNotification(
            'غير مصرح',
            'لا يملك الحساب الحالي صلاحية تعديل حضور هؤلاء المخدومين.',
            'warn'
          );
          return {
            success: false,
            appliedCount: 0,
            skippedDuplicateCount: plan.skippedDuplicateCount + extraQueuedSkipped,
            blockedCount: plan.blockedCount,
            futureBlockedCount: plan.futureBlockedCount,
            queuedCount: 0,
            error: 'غير مصرح بتعديل سجلات هؤلاء المخدومين'
          };
        }
        return {
          success: true,
          appliedCount: 0,
          skippedDuplicateCount: plan.skippedDuplicateCount + extraQueuedSkipped,
          blockedCount: plan.blockedCount,
          futureBlockedCount: plan.futureBlockedCount,
          queuedCount: 0
        };
      }

      const priorStudents = students;
      try {
        await idbAtomicBatchRecordAttendanceWithMutations(
          plan.updatedStudents,
          plan.historyRecords,
          plan.mutations
        );

        const updatedMap = new Map(plan.updatedStudents.map((s) => [s.id, s]));
        setStudents((prev) => prev.map((s) => updatedMap.get(s.id) || s));

        await refreshPendingState();

        const onlineNow = typeof navigator === 'undefined' || navigator.onLine !== false;
        let syncReport: SyncQueueExecutionReport | undefined;
        if (!onlineNow) {
          addNotification(
            'تم الحفظ محلياً في انتظار الشبكة',
            `تم حفظ ${plan.appliedCount} سجل حضور محلياً في IndexedDB، وستتم مزامنتها تلقائياً مع Google Sheets عند عودة الاتصال.`,
            'info'
          );
        } else {
          const maybeReport = await triggerAutoProcessQueue(true);
          if (maybeReport) {
            syncReport = maybeReport;
          }
          if (!syncReport) {
            addNotification(
              'تم الحفظ محلياً وجاري المزامنة',
              `تم حفظ ${plan.appliedCount} سجل حضور وإدراجها في طابور المزامنة مع Google Sheets.`,
              'info'
            );
          } else if (syncReport.success) {
            addNotification(
              'تم تأكيد استيراد ومزامنة الحضور',
              `تم إرسال وتأكيد كتابة ${syncReport.sentCount} سجل في الشيت خلال ${(syncReport.totalDurationMs / 1000).toFixed(1)} ث.`,
              'success'
            );
          } else if (syncReport.outcome === 'timeout_unknown') {
            addNotification(
              'انتهت المهلة — محفوظ بأمان',
              syncReport.lastError || `متبقي ${syncReport.remainingCount} سجل بحالة نتيجة غير مؤكدة وسيتم التحقق وإعادة الإرسال تلقائياً.`,
              'warn'
            );
          } else {
            addNotification(
              'تم الحفظ محلياً مع تعثر المزامنة',
              syncReport.lastError || `متبقي ${syncReport.remainingCount} سجل بالطابور لإعادة الإرسال تلقائياً.`,
              'warn'
            );
          }
        }

        return {
          success: true,
          appliedCount: plan.appliedCount,
          skippedDuplicateCount: plan.skippedDuplicateCount + extraQueuedSkipped,
          blockedCount: plan.blockedCount,
          futureBlockedCount: plan.futureBlockedCount,
          queuedCount: plan.mutations.length,
          syncReport
        };
      } catch (err: any) {
        setStudents(priorStudents);
        const msg = err?.message || 'تعذر حفظ دفعة الحضور المستوردة في IndexedDB';
        addNotification('فشل حفظ استيراد الحضور', msg, 'danger');
        return {
          success: false,
          appliedCount: 0,
          skippedDuplicateCount: plan.skippedDuplicateCount + extraQueuedSkipped,
          blockedCount: plan.blockedCount,
          futureBlockedCount: plan.futureBlockedCount,
          queuedCount: 0,
          error: msg
        };
      }
    },
    [students, canPerformAction, addNotification, refreshPendingState, triggerAutoProcessQueue]
  );

  // 4. Record Followup: Atomic multi-store transaction (Students + Followup + Mutations)
  const recordFollowup = useCallback(
    async (
      studentId: string,
      method: string,
      notes?: string,
      options?: { callOutcome?: CallOutcome }
    ): Promise<boolean> => {
      const student = students.find((s) => s.id === studentId);
      if (!student) return false;

      const permission = canPerformAction('followup', student.servant);
      if (!permission.allowed) {
        addNotification('غير مصرح', permission.reason || 'العملية تتطلب تسجيل دخول موثق', 'warn');
        return false;
      }

      const { date: cairoDate, friday } = resolveFollowupCairoDates();
      const opId = generateUUID();
      const recordId = generateUUID();
      const safeStudentId = toSafeHeaderAscii(studentId);
      const idempotencyKey = `FU_${safeStudentId}_${opId}`;
      const cleanNotes = (notes || '').trim();
      const isPhoneFollowup = method === 'تم تليفونياً' || method === 'اتصال تليفوني' || method === 'اتصال هاتفي';
      const validOutcome: CallOutcome | undefined =
        isPhoneFollowup && (options?.callOutcome === 'تم التواصل' || options?.callOutcome === 'لم يتم التواصل')
          ? options.callOutcome
          : undefined;

      const updatedStudent: Student = {
        ...student,
        followupStatus: method,
        fu: { ...student.fu, [friday]: method },
        ...(validOutcome
          ? {
              fuOutcomes: { ...(student.fuOutcomes || {}), [friday]: validOutcome },
              lastCallOutcome: validOutcome
            }
          : {}),
        ...(cleanNotes ? { notes: cleanNotes } : {}),
        version: (student.version || 1) + 1,
        hasUnsyncedLocalChanges: true
      };

      const newRecord: FollowupRecord = {
        id: recordId,
        date: cairoDate,
        fridayDate: friday,
        studentId,
        studentCode: student.code,
        studentName: student.name,
        servant: student.servant,
        type: method,
        ...(validOutcome ? { callOutcome: validOutcome } : {}),
        notes: cleanNotes || `افتقاد عبر ${method}`
      };

      const mutation: OfflineMutation = {
        id: idempotencyKey,
        action: 'followup',
        studentId,
        studentCode: student.code,
        studentName: student.name,
        sourceSheet: student.sourceSheet,
        payload: {
          friday,
          date: cairoDate,
          method,
          recordId,
          ...(validOutcome ? { callOutcome: validOutcome } : {}),
          ...(cleanNotes ? { notes: cleanNotes } : {})
        },
        expectedVersion: student.version,
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending'
      };

      const priorStudents = students;
      const priorFollowup = followupRecords;

      try {
        await idbAtomicRecordFollowupWithMutation(updatedStudent, newRecord, mutation);

        setStudents((prev) => prev.map((s) => (s.id === studentId ? updatedStudent : s)));
        setFollowupRecords((prev) => [newRecord, ...prev]);
        await refreshPendingState();
        const localFollowupNotif = buildLocalSavedNotification(
          'followup',
          student.name,
          validOutcome ? `${method} (${validOutcome})` : method
        );
        addNotification(localFollowupNotif.title, localFollowupNotif.desc, localFollowupNotif.type);
        void triggerAutoProcessQueue(true);
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        setFollowupRecords(priorFollowup);
        addNotification('خطأ في قاعدة البيانات', err?.message || 'تعذر حفظ الافتقاد في IndexedDB', 'danger');
        return false;
      }
    },
    [students, followupRecords, isPreviewMode, canPerformAction, addNotification, refreshPendingState, triggerAutoProcessQueue]
  );

  // 5. Update Student: Single atomic transaction with UUID mutation
  const updateStudent = useCallback(
    async (studentId: string, updatedFields: Partial<Student>): Promise<boolean> => {
      const student = students.find((s) => s.id === studentId);
      if (!student) return false;

      const permission = canPerformAction('edit_student', student.servant);
      if (!permission.allowed) {
        addNotification('غير مصرح', permission.reason || 'العملية تتطلب تسجيل دخول موثق', 'warn');
        return false;
      }

      const priorStudents = students;
      const updatedStudent: Student = {
        ...student,
        ...updatedFields,
        version: (student.version || 1) + 1,
        hasUnsyncedLocalChanges: true
      };

      const opId = generateUUID();
      const safeStudentId = toSafeHeaderAscii(studentId);
      const mutation: OfflineMutation = {
        id: `UPD_${safeStudentId}_${opId}`,
        action: 'update',
        studentId,
        studentCode: student.code,
        studentName: student.name,
        sourceSheet: student.sourceSheet,
        payload: updatedFields,
        expectedVersion: student.version,
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending'
      };

      try {
        await idbAtomicUpdateStudentWithMutation(updatedStudent, mutation);
        setStudents((prev) => prev.map((s) => (s.id === studentId ? updatedStudent : s)));
        await refreshPendingState();
        const localUpdateNotif = buildLocalSavedNotification('update', student.name);
        addNotification(localUpdateNotif.title, localUpdateNotif.desc, localUpdateNotif.type);
        void triggerAutoProcessQueue(true);
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('خطأ في التخزين', err?.message || 'تعذر تعديل المخدوم في IndexedDB', 'danger');
        return false;
      }
    },
    [students, isPreviewMode, canPerformAction, addNotification, refreshPendingState, triggerAutoProcessQueue]
  );

  // 6. Add New Student: UUID student ID & mutation ID
  const addNewStudent = useCallback(
    async (studentData: Partial<Student>): Promise<boolean> => {

      const permission = canPerformAction('add_student', studentData.servant);
      if (!permission.allowed) {
        addNotification('غير مصرح', permission.reason || 'إضافة مخدومين مقتصرة على أمين الخدمة (Admin)', 'warn');
        return false;
      }

      const newUUID = generateUUID();
      const opId = generateUUID();

      const newStudent: Student = {
        id: newUUID,
        code: studentData.code || 'SG-' + (students.length + 101),
        name: studentData.name || '',
        servant: studentData.servant || 'غير محدد',
        phoneStudent: studentData.phoneStudent || '',
        phoneParent1: studentData.phoneParent1 || '',
        phoneParent2: studentData.phoneParent2 || '',
        birthDate: studentData.birthDate || '',
        area: studentData.area || 'غير محددة',
        address: studentData.address || 'العنوان غير مسجل',
        notes: studentData.notes || '',
        followupStatus: studentData.followupStatus || 'بدون',
        attendanceTotal: 0,
        attendanceMonth: 0,
        attendanceStatus: 'غائب',
        sourceSheet: studentData.sourceSheet || (filters.sheet === '__ALL__' ? 'نشط' : filters.sheet),
        version: 1,
        hasUnsyncedLocalChanges: true,
        att: {},
        fu: {}
      };

      const mutation: OfflineMutation = {
        id: `ADD_${newUUID}_${opId}`,
        action: 'add',
        studentId: newUUID,
        studentCode: newStudent.code,
        studentName: newStudent.name,
        sourceSheet: newStudent.sourceSheet,
        payload: newStudent,
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending'
      };

      const priorStudents = students;
      try {
        await idbAtomicAddStudentWithMutation(newStudent, mutation);
        setStudents((prev) => [newStudent, ...prev]);
        await refreshPendingState();
        const localAddNotif = buildLocalSavedNotification('add', newStudent.name);
        addNotification(localAddNotif.title, localAddNotif.desc, localAddNotif.type);
        void triggerAutoProcessQueue(true);
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('خطأ في الإضافة', err?.message || 'تعذر إضافة المخدوم في IndexedDB', 'danger');
        return false;
      }
    },
    [students, filters.sheet, isPreviewMode, canPerformAction, addNotification, refreshPendingState, triggerAutoProcessQueue]
  );

  // 7. Delete Student: Admin only, formally typed delete action without 'as any'
  const deleteStudent = useCallback(
    async (studentId: string): Promise<boolean> => {
      if (isPreviewMode) {
        addNotification('وضع المعاينة للقراءة فقط', 'لا يمكن حذف المخدوم في وضع المعاينة', 'warn');
        return false;
      }

      const student = students.find((s) => s.id === studentId);
      if (!student) return false;

      const permission = canPerformAction('delete_student', student.servant);
      if (!permission.allowed) {
        addNotification('غير مصرح', permission.reason || 'حذف السجلات يتطلب صلاحية أمين الخدمة (Admin)', 'danger');
        return false;
      }

      const opId = generateUUID();
      const mutation: OfflineMutation = {
        id: `DEL_${studentId}_${opId}`,
        action: 'delete', // Formally typed in OfflineMutation
        studentId,
        studentCode: student.code,
        studentName: student.name,
        sourceSheet: student.sourceSheet,
        payload: { id: studentId, code: student.code },
        expectedVersion: student.version,
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending'
      };

      const priorStudents = students;
      try {
        await idbAtomicDeleteStudentWithMutation(studentId, mutation);
        setStudents((prev) => prev.filter((s) => s.id !== studentId));
        await refreshPendingState();
        addNotification('تم الحذف', `تم حذف سجل ${student.name}`, 'info');
        void triggerAutoProcessQueue(true);
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('خطأ في الحذف', err?.message || 'تعذر حذف السجل من IndexedDB', 'danger');
        return false;
      }
    },
    [students, isPreviewMode, canPerformAction, addNotification, refreshPendingState, triggerAutoProcessQueue]
  );

  return (
    <AppContext.Provider
      value={{
        students,
        filteredStudents,
        availableAlphabetBuckets,
        followupRecords,
        notifications,
        filters,
        activeView,
        isSyncing,
        isOnline,
        lastSyncError,
        lastSyncReport,
        partialSyncInfo,
        syncState,
        lastSyncAttemptTime,
        lastSuccessfulPushTime,
        lastSuccessfulPullTime,
        lastSuccessfulSyncTime,
        lastSuccessfulSyncCompact,
        pendingMutationsCount,
        inFlightStudentIds,
        syncedStudentIds,
        pendingStudentIds,
        isQueueProcessing,
        activeEditingId,
        hasUnsavedEditChanges,
        isSidebarOpen,
        isSidebarCollapsed,
        isInitialLoading,
        isAssistantOpen,
        isNotificationsOpen,
        notificationsActiveTab,
        isAreaModalOpen,
        isAboutModalOpen,
        isAppearanceModalOpen,
        isPdfImportModalOpen,
        isAddModalOpen,
        isSyncModalOpen,
        isQueueModalOpen,
        isBackupModalOpen,
        setFilters,
        setActiveView,
        setActiveEditingId,
        setHasUnsavedEditChanges,
        requestEditStudent,
        cancelEditing,
        setIsSidebarOpen,
        setIsSidebarCollapsed,
        setIsAssistantOpen,
        setIsNotificationsOpen,
        setNotificationsActiveTab,
        setIsAreaModalOpen,
        setIsAboutModalOpen,
        setIsAppearanceModalOpen,
        setIsPdfImportModalOpen,
        setIsAddModalOpen,
        setIsSyncModalOpen,
        setIsQueueModalOpen,
        setIsBackupModalOpen,
        reloadLocalDatabaseState,
        syncData,
        markAttendance,
        importAttendanceBatch,
        recordFollowup,
        updateStudent,
        addNewStudent,
        deleteStudent,
        markNotificationRead,
        markAllNotificationsRead,
        clearReadNotifications,
        addNotification,
        processOfflineQueue,
        clearOfflineQueue,
        triggerAutoProcessQueue,
        activeToast,
        dismissToast
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
