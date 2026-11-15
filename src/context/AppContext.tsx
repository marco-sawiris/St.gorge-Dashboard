import React, { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Student, SheetName, AppFilterState, APPROVED_SHEETS } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { AppNotification, OfflineMutation, AuthUser } from '../types/auth';
import {
  DynamicAlphabetBucket,
  extractDynamicAlphabetBuckets,
  normalizeArabicText,
  normalizeArabicInitial,
  getNearestFridayString,
  getLatestHeldFridayString,
  getCairoDateParts,
  computeMonthlyAttendanceSummary
} from '../utils/arabicUtils';
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
  idbMarkMutationConflict,
  idbAtomicAddStudentWithMutation,
  idbAtomicUpdateStudentWithMutation,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicDeleteStudentWithMutation,
  idbAtomicRecordFollowupWithMutation,
  idbReconcileStudents,
  idbPurgeMockRecords,
  idbSaveRemoteFollowupRecords,
  idbGetAttendanceHistory,
  idbUpdateMutationError,
  idbResetMutationRetry
} from '../services/indexedDbService';
import { syncWeeklyNotificationSchedules } from '../services/weeklyNotificationService';
import {
  clearDeliveredNativeNotificationsOnce,
  computeNotificationDedupKey,
  CURRENT_NOTIFICATIONS_VERSION,
  loadAndMigrateNotifications,
  saveNotificationsToStorage,
  upsertDeduplicatedNotification
} from '../services/notificationStorageService';
import { fetchSheetStudentsViaGviz, fetchFollowupLogViaGviz } from '../services/googleSheetParser';
import { useAuth } from './AuthContext';

export const SPREADSHEET_ID = '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0';

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

interface AppContextType {
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
  syncState: 'connected' | 'syncing' | 'synced' | 'failed' | 'offline' | 'pending';
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
  isAddModalOpen: boolean;
  isSyncModalOpen: boolean;
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
  setIsAddModalOpen: (open: boolean) => void;
  setIsSyncModalOpen: (open: boolean) => void;
  isQueueModalOpen: boolean;
  setIsQueueModalOpen: (open: boolean) => void;
  syncData: (overrideSheet?: SheetName) => Promise<boolean>;
  markAttendance: (studentId: string, isPresent: boolean, targetFridayDate?: string) => Promise<boolean>;
  recordFollowup: (studentId: string, method: string, notes?: string) => Promise<boolean>;
  updateStudent: (studentId: string, updatedFields: Partial<Student>) => Promise<boolean>;
  addNewStudent: (studentData: Partial<Student>) => Promise<boolean>;
  deleteStudent: (studentId: string) => Promise<boolean>;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  addNotification: (
    title: string,
    desc?: string,
    type?: 'info' | 'warn' | 'success' | 'danger',
    options?: { id?: string; dedupKey?: string }
  ) => void;
  processOfflineQueue: () => Promise<{ success: boolean; sentCount: number; remainingCount: number }>;
  inFlightStudentIds: string[];
  syncedStudentIds: string[];
  pendingStudentIds: string[];
  isQueueProcessing: boolean;
  triggerAutoProcessQueue: (isImmediateUserAction?: boolean) => Promise<void>;
  activeToast: AppNotification | null;
  dismissToast: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

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

export async function executeProcessOfflineQueue(
  user: AuthUser | null,
  _isPreviewMode: boolean = false,
  onNotify?: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void,
  onRecordPushTime?: (pushIso: string) => void,
  callbacks?: {
    onMutationStart?: (mutation: OfflineMutation) => void;
    onMutationSuccess?: (mutation: OfflineMutation) => void;
    onMutationError?: (mutation: OfflineMutation, error: string) => void;
    silent?: boolean;
  }
): Promise<{ success: boolean; sentCount: number; remainingCount: number }> {
  let releaseLock!: () => void;
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const prevLock = queueExecutionTail;
  queueExecutionTail = prevLock.then(() => nextLock, () => nextLock);
  await prevLock;

  try {
    return await runProcessOfflineQueueSerial(
      user,
      _isPreviewMode,
      onNotify,
      onRecordPushTime,
      callbacks
    );
  } finally {
    releaseLock();
  }
}

async function runProcessOfflineQueueSerial(
  user: AuthUser | null,
  _isPreviewMode: boolean = false,
  onNotify?: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void,
  onRecordPushTime?: (pushIso: string) => void,
  callbacks?: {
    onMutationStart?: (mutation: OfflineMutation) => void;
    onMutationSuccess?: (mutation: OfflineMutation) => void;
    onMutationError?: (mutation: OfflineMutation, error: string) => void;
    silent?: boolean;
  }
): Promise<{ success: boolean; sentCount: number; remainingCount: number }> {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    onNotify?.('وضع عدم الاتصال', 'لا يوجد اتصال بالإنترنت لإرسال العمليات المعلقة', 'warn');
    const pending = await idbGetPendingMutations();
    return { success: false, sentCount: 0, remainingCount: pending.length };
  }

  const appsScriptUrl = getEffectiveAppsScriptUrl();
  const relayKey = getEffectiveRelayKey();

  if (!appsScriptUrl && !hasConfiguredRemoteBackend() && isNativeCapacitorRuntime()) {
    onNotify?.('مطلوب رابط المزامنة', 'يرجى ضبط رابط Google Apps Script في تفاصيل المزامنة. العمليات محفوظة محلياً بأمان.', 'warn');
    const pending = await idbGetPendingMutations();
    for (const m of pending) {
      await idbUpdateMutationError(m.id, 'يرجى ضبط رابط Google Apps Script في تفاصيل المزامنة للمزامنة مع الشيت', 'failed');
    }
    return { success: false, sentCount: 0, remainingCount: pending.length };
  }

  const pending = await idbGetPendingMutations();
  if (pending.length === 0) {
    return { success: true, sentCount: 0, remainingCount: 0 };
  }

  let sentCount = 0;

  for (const mutation of pending) {
    callbacks?.onMutationStart?.(mutation);
    try {
      let response: Response;
      if (appsScriptUrl) {
        const relayKey = getEffectiveRelayKey();
        const payloadDate = String(mutation.payload?.friday || mutation.payload?.date || '').trim();
        const payloadPresent = mutation.payload?.isPresent ?? mutation.payload?.present ?? false;
        const followupStatus = mutation.payload?.status || mutation.payload?.method || mutation.payload?.type;
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

        const appsScriptBody = {
          // Legacy Google Apps Script contract (deployed web app)
          sheet: mutation.sourceSheet || 'نشط',
          sourceSheet: mutation.sourceSheet || 'نشط',
          name: mutation.studentName || '',
          studentName: mutation.studentName || '',
          studentId: mutation.studentId || '',
          studentCode: mutation.studentCode || '',
          action: mutation.action,
          date: payloadDate,
          friday: payloadDate,
          present: payloadPresent,
          isPresent: payloadPresent,
          token: relayKey,
          relayKey,
          idempotencyKey: mutation.id,
          id: mutation.id,
          expectedVersion: mutation.expectedVersion || 1,
          payload: mutation.payload || {},
          type: followupStatus,
          status: followupStatus,
          followupStatus: followupStatus,
          notes: mutation.payload?.notes || '',
          fields: fields,
          // Modern Code.gs envelope
          mutation: {
            ...mutation,
            id: mutation.id,
            sourceSheet: mutation.sourceSheet || 'نشط',
            studentName: mutation.studentName || '',
            payload: {
              ...(mutation.payload || {}),
              status: followupStatus,
              method: followupStatus,
              fields: fields
            }
          }
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
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
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
          response = await fetch(mutateUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(mutation),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }

      if (response.status === 409) {
        // Version Conflict: Zero data loss - mark conflict and STOP loop to preserve FIFO dependencies
        const result = await response.json().catch(() => null);
        const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (HTTP 409)';
        await idbMarkMutationConflict(mutation.id, conflictMsg);
        onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة أمين الخدمة: ${conflictMsg}`, 'danger');
        callbacks?.onMutationError?.(mutation, conflictMsg);
        break; // Crucial: Do NOT skip past a conflict to send dependent operations!
      }

      if (response.ok) {
        const result = await response.json().catch(() => null);
        if (result && result.status === 409) {
          const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (409)';
          await idbMarkMutationConflict(mutation.id, conflictMsg);
          onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة: ${conflictMsg}`, 'danger');
          callbacks?.onMutationError?.(mutation, conflictMsg);
          break;
        }
        if (result && result.ok) {
          // ONLY remove from IndexedDB after verified server success confirmation
          await idbRemoveMutation(mutation.id);
          sentCount++;

          // Update push timestamp IMMEDIATELY upon any verified confirmation
          // Guarantees push state updates even if subsequent operations fail
          const nowIso = new Date().toISOString();
          try {
            localStorage.setItem('stgorge_last_successful_push_iso', nowIso);
          } catch {}
          onRecordPushTime?.(nowIso);
          callbacks?.onMutationSuccess?.(mutation);
        } else {
          const errMsg = result?.error || 'رفض Google Sheets العملية';
          console.warn(`Server rejected mutation ${mutation.id}:`, errMsg);
          await idbUpdateMutationError(mutation.id, errMsg, 'failed');
          callbacks?.onMutationError?.(mutation, errMsg);
          break; // Stop loop on rejection
        }
      } else {
        // Non-200 HTTP status (401, 500, 502, 503): retain in queue and STOP loop
        let errDetail = `استجاب الخادم برمز خطأ (HTTP ${response.status})`;
        if (response.status === 401) {
          errDetail = 'يتطلب إرسال التعديلات للشيت تفعيل رابط Google Apps Script في إعدادات المنظومة أو تسجيل دخول موثق';
        } else if (response.status === 403) {
          errDetail = 'غير مصرح: الحساب الحالي لا يملك صلاحية تعديل هذا المخدوم';
        } else if (response.status >= 500) {
          errDetail = `الخادم غير متاح مؤقتاً (HTTP ${response.status})، سيُعاد الإرسال تلقائياً`;
        }
        console.warn(`Failed to sync mutation ${mutation.id}, HTTP status: ${response.status}`);
        await idbUpdateMutationError(mutation.id, errDetail, 'failed');
        callbacks?.onMutationError?.(mutation, errDetail);
        break;
      }
    } catch (networkError: any) {
      // Network timeout / connection dropped: preserve in queue and STOP loop
      const errMsg = networkError?.name === 'AbortError'
        ? 'انتهت مهلة الاتصال بالخادم (Timeout)، تم حفظ العملية محلياً بأمان وستتم إعادة الإرسال تلقائياً.'
        : `تعذر الاتصال بالشبكة لإرسال العملية: ${networkError?.message || 'انقطع الاتصال'}`;
      console.warn(`Network failure syncing mutation ${mutation.id}:`, networkError);
      await idbUpdateMutationError(mutation.id, errMsg, 'failed');
      callbacks?.onMutationError?.(mutation, errMsg);
      break;
    }
  }

  const remaining = await idbGetPendingMutations();

  if (sentCount > 0 && remaining.length === 0) {
    if (!callbacks?.silent) {
      onNotify?.('اكتمل إرسال العمليات', `تم تأكيد إرسال ${sentCount} عملية بنجاح للشيت`, 'success');
    }
    return { success: true, sentCount, remainingCount: 0 };
  } else if (sentCount > 0) {
    if (!callbacks?.silent) {
      onNotify?.('مزامنة جزئية', `تم إرسال ${sentCount} عملية بنجاح، ومتبقي ${remaining.length} عملية بالطابور`, 'warn');
    }
    return { success: false, sentCount, remainingCount: remaining.length };
  } else {
    return { success: false, sentCount: 0, remainingCount: remaining.length };
  }
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
  onUpdateFollowups?: (records: FollowupRecord[]) => void
): Promise<boolean> {
  // Prevent concurrent sync executions
  if (syncInProgressRef.current) {
    console.warn('Sync is already in progress, skipping concurrent call.');
    return false;
  }

  syncInProgressRef.current = true;

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
      const queueResult = await executeProcessOfflineQueue(user, false, onNotify, onRecordPushTime);
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
          data = relayData;
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
      if (!relayReadSucceeded) {
        const existingList = await idbGetStudents().catch(() => []);
        const existingMap = new Map(existingList.map((student) => [student.id, student]));
        const gvizResult = await fetchSheetStudentsViaGviz(SPREADSHEET_ID, targetSheet, existingMap);
        const remoteFollowups = await fetchFollowupLogViaGviz(SPREADSHEET_ID, gvizResult.students).catch((error) => {
          console.warn('Gviz follow-up log read failed:', error);
          return [];
        });
        if (remoteFollowups.length > 0) {
          const reconciledFu = await idbSaveRemoteFollowupRecords(remoteFollowups).catch(() => remoteFollowups);
          onUpdateFollowups?.(reconciledFu);
        }
        data = {
          ok: true, targetSheet, sheet: targetSheet, isComplete: true, confirmedComplete: true,
          confirmedSheets: gvizResult.confirmedSheets, confirmedEmptySheets: gvizResult.confirmedEmptySheets,
          sheetsMeta: gvizResult.sheetsMeta, students: gvizResult.students, followupRecords: remoteFollowups
        };
      } else if (Array.isArray(data.followupRecords) && data.followupRecords.length > 0) {
        const reconciledFu = await idbSaveRemoteFollowupRecords(data.followupRecords).catch(() => data.followupRecords);
        onUpdateFollowups?.(reconciledFu);
      }
    } else if (!hasExpressCredentials && (isNativeCapacitorRuntime() || typeof window !== 'undefined')) {
      // Path B: Direct Real Google Sheets Visualization Reader (gviz/tq) when Relay/Express Auth not configured
      const existingList = await idbGetStudents().catch(() => []);
      const existingMap = new Map(existingList.map((s) => [s.id, s]));
      const gvizResult = await fetchSheetStudentsViaGviz(SPREADSHEET_ID, targetSheet, existingMap);
      const remoteFollowups = await fetchFollowupLogViaGviz(SPREADSHEET_ID, gvizResult.students).catch(() => []);
      if (remoteFollowups.length > 0) {
        const reconciledFu = await idbSaveRemoteFollowupRecords(remoteFollowups).catch(() => remoteFollowups);
        onUpdateFollowups?.(reconciledFu);
      }
      data = {
        ok: true,
        targetSheet,
        sheet: targetSheet,
        isComplete: true,
        confirmedComplete: true,
        confirmedSheets: gvizResult.confirmedSheets,
        confirmedEmptySheets: gvizResult.confirmedEmptySheets,
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

      const queueResult = await executeProcessOfflineQueue(user, false, onNotify, onRecordPushTime);

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

      data = await res.json();
      if (!data || !Array.isArray(data.students)) {
        throw new Error('بيانات الاستجابة من الشيت غير صالحة');
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

      // Explicitly include all approved sheets and all sheets present in server response
      const sheetsToProcess = new Set<string>();
      APPROVED_SHEETS.forEach((s) => sheetsToProcess.add(s));
      for (const sheetName of bySheet.keys()) {
        sheetsToProcess.add(sheetName);
      }

      // Process each sheet safely:
      // DO NOT replace local sheet data with an empty list unless confirmed complete for that specific sheet!
      // In __ALL__ mode, completeness MUST be verified per sheetName independently.
      // Generic top-level isComplete or confirmedComplete must NEVER be used to wipe multiple sheets.
      for (const sheetName of sheetsToProcess) {
        const sheetStudents = bySheet.get(sheetName) || [];
        const isSheetEmpty = sheetStudents.length === 0;

        // Specific independent confirmation for this sheetName:
        const isSheetConfirmedComplete = Boolean(
          data && (
            (Array.isArray(data.confirmedEmptySheets) && data.confirmedEmptySheets.includes(sheetName)) ||
            (Array.isArray(data.confirmedSheets) && data.confirmedSheets.includes(sheetName)) ||
            data.sheetsMeta?.[sheetName]?.isComplete === true ||
            data.sheetsMeta?.[sheetName]?.confirmedComplete === true
          )
        );

        if (isSheetEmpty && isSheetConfirmedComplete !== true) {
          // Unconfirmed empty response: PRESERVE local sheet data without modification or deletion
          console.warn(`Unconfirmed empty server response for sheet ${sheetName}; preserving local data.`);
          continue;
        }

        const sheetHasPending = remainingMutations.some(
          (m) => !m.sourceSheet || m.sourceSheet === sheetName
        );

        if (sheetHasPending || remainingMutations.length > 0) {
          await idbReconcileStudents(sheetStudents, remainingMutations, sheetName, isSheetConfirmedComplete);
        } else {
          await idbSaveStudents(sheetStudents, sheetName, isSheetConfirmedComplete);
        }
      }

      finalStudents = await idbGetStudents();
      onUpdateStudents?.(finalStudents);

      const nowIso = new Date().toISOString();
      onRecordTimes?.(nowIso);

      if (remainingMutations.length === 0) {
        onRecordError?.(null);
        onNotify?.('تم التحديث بنجاح', 'تم تحديث جميع الفصول بنجاح دون المساس بأي بيانات محلية', 'success');
        return true;
      } else {
        const queueError = remainingMutations.find((mutation) => mutation.lastError)?.lastError;
        const partialError = queueError || `تم سحب البيانات، لكن ما زالت هناك ${remainingMutations.length} عملية معلقة لم يتم تأكيد إرسالها إلى Google Sheets.`;
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
      const isSheetEmpty = data.students.length === 0;

      // Completeness confirmation MUST be explicitly linked to targetSheet:
      // A generic data.isComplete or data.confirmedComplete without explicit sheet association is strictly rejected!
      const isTargetSheetConfirmedComplete = Boolean(
        data && (
          ((data.targetSheet === targetSheet || data.sheet === targetSheet || data.sheetName === targetSheet) &&
            (data.isComplete === true || data.confirmedComplete === true)) ||
          (Array.isArray(data.confirmedEmptySheets) && data.confirmedEmptySheets.includes(targetSheet)) ||
          (Array.isArray(data.confirmedSheets) && data.confirmedSheets.includes(targetSheet)) ||
          data.sheetsMeta?.[targetSheet]?.isComplete === true ||
          data.sheetsMeta?.[targetSheet]?.confirmedComplete === true
        )
      );

      if (isSheetEmpty && isTargetSheetConfirmedComplete !== true) {
        onRecordError?.(`استجابة فارغة غير مؤكدة لفصل (${targetSheet})`);
        onNotify?.(
          'استجابة فارغة غير مؤكدة',
          `استجابة السيرفر لفصل (${targetSheet}) فارغة دون دليل اكتمال الجلب لفصل (${targetSheet}) تحديداً. تم الاحتفاظ بالبيانات المحلية كاملة منعاً لأي مسح غير مقصود.`,
          'warn'
        );
        return false;
      }

      if (remainingMutations.length > 0) {
        finalStudents = await idbReconcileStudents(data.students, remainingMutations, targetSheet, isTargetSheetConfirmedComplete);
        onUpdateStudents?.(finalStudents);
        const nowIso = new Date().toISOString();
        onRecordTimes?.(nowIso);
        const queueError = remainingMutations.find((mutation) => mutation.lastError)?.lastError;
        const partialError = queueError || `تم سحب البيانات، لكن ما زالت هناك ${remainingMutations.length} عملية معلقة لم يتم تأكيد إرسالها إلى Google Sheets.`;
        onRecordError?.(partialError);
        onNotify?.(
          'المزامنة غير مكتملة',
          `تم سحب بيانات الفصل، لكن فشل تأكيد إرسال العمليات المعلقة (${remainingMutations.length}). لم يتم حذف أي عملية.`,
          'warn'
        );
        return false;
      } else {
        await idbSaveStudents(data.students, targetSheet, isTargetSheetConfirmedComplete);
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
    onNotify?.('فشل التحديث', err?.message || 'تعذر الاتصال بالخادم، المعروض هو آخر كاش محلي', 'danger');
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
  const queueLockRef = useRef<boolean>(false);
  const queueNeedsRerunRef = useRef<boolean>(false);
  const triggerAutoProcessQueueRef = useRef<((isImmediateUserAction?: boolean) => Promise<void>) | null>(null);

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
  const [isAddModalOpen, setIsAddModalOpenState] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('stgorge_sidebar_collapsed', isSidebarCollapsed ? '1' : '0');
      }
    } catch {}
  }, [isSidebarCollapsed]);

  // Computed Sync Status reflecting 6 real states
  const syncState = useMemo<'connected' | 'syncing' | 'synced' | 'failed' | 'offline' | 'pending'>(() => {
    if (!isOnline) return 'offline';
    if (isSyncing || isQueueProcessing) return 'syncing';
    if (lastSyncError) return 'failed';
    if (pendingMutationsCount > 0) return 'pending';
    if (lastSuccessfulSyncTime) return 'synced';
    return 'connected';
  }, [isOnline, isSyncing, isQueueProcessing, lastSyncError, pendingMutationsCount, lastSuccessfulSyncTime]);

  // Online / Offline window listeners & auto-drain
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setLastSyncError(null);
      void triggerAutoProcessQueueRef.current?.(false);
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void triggerAutoProcessQueueRef.current?.(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const interval = setInterval(() => {
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        idbGetPendingMutations().then((pending) => {
          if (pending.length > 0) {
            void triggerAutoProcessQueueRef.current?.(false);
          }
        }).catch(() => {});
      }
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
              if (!localHist) return st;
              const nextAtt = { ...localHist, ...(st.att || {}) };
              return {
                ...st,
                att: nextAtt,
                attendanceMonth: computeMonthlyAttendanceSummary(nextAtt).presentCount
              };
            });
            setStudents(merged);
          } else {
            setStudents(cachedStudents);
          }
        }
        const cachedFollowup = await idbGetFollowupRecords();
        if (mounted && cachedFollowup.length > 0) {
          setFollowupRecords(cachedFollowup);
        }
        const pending = await refreshPendingState();

        // Pull authoritative real data from Google Sheets when online (never invent mock data on failure)
        const onlineNow = typeof navigator === 'undefined' || navigator.onLine !== false;
        if (mounted && onlineNow && pending.length > 0) {
          void triggerAutoProcessQueueRef.current?.(false);
        }
        if (mounted && onlineNow) {
          setIsSyncing(true);
          setLastSyncAttemptTime(new Date().toISOString());
          const targetOnBoot: SheetName = cachedStudents.length === 0 ? '__ALL__' : 'نشط';
          const ok = await executeSyncData(
            targetOnBoot,
            user,
            false,
            syncInProgressLock,
            undefined,
            (fresh) => {
              if (mounted) setStudents(fresh);
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
            }
          );
          if (mounted) {
            if (ok) setLastSyncError(null);
            setIsSyncing(false);
            const postPending = await idbGetPendingMutations().catch(() => []);
            if (mounted) setPendingMutationsCount(postPending.length);
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

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
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

  // 1. Automatic Real-Time Queue Processor with Mutex & FIFO Guarantee
  const triggerAutoProcessQueue = useCallback(
    async (isImmediateUserAction: boolean = false): Promise<void> => {
      // If browser is explicitly offline
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

      // Mutex locking: prevent concurrent queue runs while maintaining FIFO
      if (queueLockRef.current) {
        queueNeedsRerunRef.current = true;
        return;
      }

      queueLockRef.current = true;
      setIsQueueProcessing(true);

      try {
        do {
          queueNeedsRerunRef.current = false;
          const pending = await refreshPendingState();
          if (pending.length === 0) break;

          await executeProcessOfflineQueue(
            user,
            isPreviewMode,
            addNotification,
            (pushIso) => {
              setLastSuccessfulPushTime(pushIso);
            },
            {
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
              },
              onMutationError: (mut, err) => {
                if (mut.studentId) {
                  setInFlightStudentIds((prev) => prev.filter((id) => id !== mut.studentId));
                }
                if (isImmediateUserAction) {
                  addNotification(
                    'محفوظة في الانتظار',
                    `تعذر إرسال العملية للشيت حالياً (${err})، تم حفظها محلياً بأمان وستتم المزامنة تلقائياً.`,
                    'warn'
                  );
                }
              }
            }
          );

          await refreshPendingState();
        } while (queueNeedsRerunRef.current);
      } catch (err) {
        console.warn('Auto queue execution error:', err);
      } finally {
        queueLockRef.current = false;
        setIsQueueProcessing(false);
        setInFlightStudentIds([]);
        await refreshPendingState();
      }
    },
    [user, isPreviewMode, addNotification, refreshPendingState]
  );
  triggerAutoProcessQueueRef.current = triggerAutoProcessQueue;

  // Manual trigger from Modals / UI
  const processOfflineQueue = useCallback(async (): Promise<{
    success: boolean;
    sentCount: number;
    remainingCount: number;
  }> => {
    setIsQueueProcessing(true);
    try {
      const res = await executeProcessOfflineQueue(
        user,
        isPreviewMode,
        addNotification,
        (pushIso) => {
          setLastSuccessfulPushTime(pushIso);
        }
      );
      await refreshPendingState();
      return res;
    } finally {
      setIsQueueProcessing(false);
    }
  }, [user, isPreviewMode, addNotification, refreshPendingState]);

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

    const res = await executeSyncData(
      overrideSheet || filters.sheet,
      user,
      isPreviewMode,
      syncInProgressLock,
      addNotification,
      (fresh) => {
        if (!hasUnsavedEditChangesRef.current) {
          setStudents(fresh);
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
      setFollowupRecords
    );

    if (res) {
      setLastSyncError(null);
    }

    setIsSyncing(false);
    try {
      const pending = await idbGetPendingMutations();
      setPendingMutationsCount(pending.length);
    } catch {}
    return res;
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
        version: (student.version || 1) + 1
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
        await idbAtomicRecordAttendanceWithMutation(updatedStudent, historyRecord, mutation);
        setStudents((prev) => prev.map((s) => (s.id === studentId ? updatedStudent : s)));

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

  // 4. Record Followup: Atomic multi-store transaction (Students + Followup + Mutations)
  const recordFollowup = useCallback(
    async (studentId: string, method: string, notes?: string): Promise<boolean> => {
      const student = students.find((s) => s.id === studentId);
      if (!student) return false;

      const permission = canPerformAction('followup', student.servant);
      if (!permission.allowed) {
        addNotification('غير مصرح', permission.reason || 'العملية تتطلب تسجيل دخول موثق', 'warn');
        return false;
      }

      const friday = getNearestFridayString();
      const opId = generateUUID();
      const recordId = generateUUID();
      const safeStudentId = toSafeHeaderAscii(studentId);
      const idempotencyKey = `FU_${safeStudentId}_${opId}`;
      const cleanNotes = (notes || '').trim();

      const updatedStudent: Student = {
        ...student,
        followupStatus: method,
        fu: { ...student.fu, [friday]: method },
        ...(cleanNotes ? { notes: cleanNotes } : {}),
        version: (student.version || 1) + 1
      };

      const newRecord: FollowupRecord = {
        id: recordId,
        date: new Date().toISOString().split('T')[0],
        fridayDate: friday,
        studentId,
        studentCode: student.code,
        studentName: student.name,
        servant: student.servant,
        type: method,
        notes: cleanNotes || `افتقاد عبر ${method}`
      };

      const mutation: OfflineMutation = {
        id: idempotencyKey,
        action: 'followup',
        studentId,
        studentCode: student.code,
        studentName: student.name,
        sourceSheet: student.sourceSheet,
        payload: { friday, method, recordId, ...(cleanNotes ? { notes: cleanNotes } : {}) },
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
        addNotification('تم تسجيل الافتقاد', `${student.name}: ${method}`, 'success');
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
        version: (student.version || 1) + 1
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
        addNotification('تم تحديث البيانات', `تم تعديل بيانات ${student.name}`, 'success');
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
        addNotification('تمت إضافة المخدوم', `تم تسجيل ${newStudent.name} بنجاح`, 'success');
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
        isAddModalOpen,
        isSyncModalOpen,
        isQueueModalOpen,
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
        setIsAddModalOpen,
        setIsSyncModalOpen,
        setIsQueueModalOpen,
        syncData,
        markAttendance,
        recordFollowup,
        updateStudent,
        addNewStudent,
        deleteStudent,
        markNotificationRead,
        markAllNotificationsRead,
        addNotification,
        processOfflineQueue,
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
