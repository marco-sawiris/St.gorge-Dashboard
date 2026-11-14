import React, { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Student, SheetName, AppFilterState, APPROVED_SHEETS } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { AppNotification, OfflineMutation, AuthUser } from '../types/auth';
import {
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
  getAppsScriptUrl,
  getRelayKey,
  hasConfiguredRemoteBackend,
  isNativeCapacitorRuntime,
  safeGetLocalStorage
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
  idbGetAttendanceHistory
} from '../services/indexedDbService';
import { syncWeeklyNotificationSchedules } from '../services/weeklyNotificationService';
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
  isAreaModalOpen: boolean;
  isAboutModalOpen: boolean;
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
  setIsAreaModalOpen: (open: boolean) => void;
  setIsAboutModalOpen: (open: boolean) => void;
  setIsAddModalOpen: (open: boolean) => void;
  setIsSyncModalOpen: (open: boolean) => void;
  syncData: (overrideSheet?: SheetName) => Promise<boolean>;
  markAttendance: (studentId: string, isPresent: boolean, targetFridayDate?: string) => Promise<boolean>;
  recordFollowup: (studentId: string, method: string, notes?: string) => Promise<boolean>;
  updateStudent: (studentId: string, updatedFields: Partial<Student>) => Promise<boolean>;
  addNewStudent: (studentData: Partial<Student>) => Promise<boolean>;
  deleteStudent: (studentId: string) => Promise<boolean>;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  addNotification: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void;
  processOfflineQueue: () => Promise<{ success: boolean; sentCount: number; remainingCount: number }>;
  activeToast: AppNotification | null;
  dismissToast: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

// ============================================================================
// Core Production Engines for Queue and Sync (Exported for Direct Verification)
// ============================================================================

export async function executeProcessOfflineQueue(
  user: AuthUser | null,
  _isPreviewMode: boolean = false,
  onNotify?: (title: string, desc?: string, type?: 'info' | 'warn' | 'success' | 'danger') => void,
  onRecordPushTime?: (pushIso: string) => void
): Promise<{ success: boolean; sentCount: number; remainingCount: number }> {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    onNotify?.('وضع عدم الاتصال', 'لا يوجد اتصال بالإنترنت لإرسال العمليات المعلقة', 'warn');
    const pending = await idbGetPendingMutations();
    return { success: false, sentCount: 0, remainingCount: pending.length };
  }

  const appsScriptUrl = getAppsScriptUrl();
  if (!appsScriptUrl && !hasConfiguredRemoteBackend() && isNativeCapacitorRuntime()) {
    onNotify?.('مطلوب رابط المزامنة', 'يرجى ضبط رابط Google Apps Script في تفاصيل المزامنة. العمليات محفوظة محلياً بأمان.', 'warn');
    const pending = await idbGetPendingMutations();
    return { success: false, sentCount: 0, remainingCount: pending.length };
  }

  const pending = await idbGetPendingMutations();
  if (pending.length === 0) {
    return { success: true, sentCount: 0, remainingCount: 0 };
  }

  let sentCount = 0;

  for (const mutation of pending) {
    try {
      let response: Response;
      if (appsScriptUrl) {
        const relayKey = getRelayKey();
        response = await fetch(appsScriptUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body: JSON.stringify({
            ...mutation,
            idempotencyKey: mutation.id,
            ...(relayKey ? { relayKey } : {})
          })
        });
      } else {
        const mutateUrl = buildApiUrl('/api/sheets/mutate');
        const headers = {
          ...getAuthHeaders(user?.token),
          'X-Idempotency-Key': mutation.id
        };

        response = await fetch(mutateUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(mutation)
        });
      }

      if (response.status === 409) {
        // Version Conflict: Zero data loss - mark conflict and STOP loop to preserve FIFO dependencies
        const result = await response.json().catch(() => null);
        const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (HTTP 409)';
        await idbMarkMutationConflict(mutation.id, conflictMsg);
        onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة أمين الخدمة: ${conflictMsg}`, 'danger');
        break; // Crucial: Do NOT skip past a conflict to send dependent operations!
      }

      if (response.ok) {
        const result = await response.json().catch(() => null);
        if (result && result.status === 409) {
          const conflictMsg = result?.error || 'تعارض في التعديل المتزامن (409)';
          await idbMarkMutationConflict(mutation.id, conflictMsg);
          onNotify?.('تعارض في التعديل', `العملية (${mutation.action}) تحتاج مراجعة: ${conflictMsg}`, 'danger');
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
        } else {
          console.warn(`Server rejected mutation ${mutation.id}:`, result?.error);
          break; // Stop loop on rejection
        }
      } else {
        // Non-200 HTTP status (500, 502, 503): retain in queue and STOP loop
        console.warn(`Failed to sync mutation ${mutation.id}, HTTP status: ${response.status}`);
        break;
      }
    } catch (networkError) {
      // Network timeout / connection dropped: preserve in queue and STOP loop
      console.warn(`Network failure syncing mutation ${mutation.id}:`, networkError);
      break;
    }
  }

  const remaining = await idbGetPendingMutations();

  if (sentCount > 0 && remaining.length === 0) {
    onNotify?.('اكتمل إرسال العمليات', `تم تأكيد إرسال ${sentCount} عملية بنجاح للشيت`, 'success');
    return { success: true, sentCount, remainingCount: 0 };
  } else if (sentCount > 0) {
    onNotify?.('مزامنة جزئية', `تم إرسال ${sentCount} عملية بنجاح، ومتبقي ${remaining.length} عملية بالطابور`, 'warn');
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

    const appsScriptUrl = getAppsScriptUrl();
    const relayKey = getRelayKey();
    const hasExpressCredentials = Boolean(user?.token || relayKey || buildApiUrl('/api/sheets/data').startsWith('https://'));

    let data: any;

    if (appsScriptUrl) {
      // Path A: Direct Private Google Apps Script Relay (Reads + Writes + Private Sheet)
      const queueResult = await executeProcessOfflineQueue(user, false, onNotify, onRecordPushTime);
      if (!queueResult.success && queueResult.remainingCount > 0) {
        onNotify?.(
          'مزامنة غير مكتملة',
          `لم يتم تأكيد إرسال جميع العمليات المعلقة (${queueResult.remainingCount} متبقية).`,
          'warn'
        );
        onRecordError?.(`توجد عمليات معلقة لم يتم تأكيد إرسالها (${queueResult.remainingCount} متبقية)`);
        return false;
      }

      const separator = appsScriptUrl.includes('?') ? '&' : '?';
      const relayQuery = `${appsScriptUrl}${separator}action=getStudents&sheet=${encodeURIComponent(targetSheet)}&t=${Date.now()}${relayKey ? `&relayKey=${encodeURIComponent(relayKey)}` : ''}`;
      const res = await fetch(relayQuery, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`استجاب وسيط Google Sheets بخطأ (HTTP ${res.status})`);
      }

      data = await res.json();
      if (!data || data.ok === false || !Array.isArray(data.students)) {
        throw new Error(data?.error || 'تعذر تحميل البيانات من Google Sheets');
      }
      if (Array.isArray(data.followupRecords) && data.followupRecords.length > 0) {
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
          'مزامنة غير مكتملة',
          `لم يتم تأكيد إرسال جميع العمليات المعلقة (${queueResult.remainingCount} متبقية في الطابور). تم إيقاف سحب بيانات الشيت لتفادي التعارض.`,
          'warn'
        );
        onRecordError?.(`توجد عمليات معلقة لم يتم تأكيد إرسالها (${queueResult.remainingCount} متبقية)`);
        return false;
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
        onRecordError?.('تحديث مع وجود عمليات معلقة محلياً');
        onNotify?.(
          'تحديث مع وجود عمليات معلقة',
          'تم تحديث الفصول مع الحفاظ الكامل على العمليات المحلية غير المرسلة',
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
        onRecordError?.('تحديث مع وجود عمليات معلقة محلياً');
        onNotify?.(
          'تحديث مع وجود عمليات معلقة',
          `تم جلب بيانات الفصل مع الحفاظ الكامل على العمليات المحلية غير المرسلة وعزل الفصول الأخرى`,
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
  const [notifications, setNotifications] = useState<AppNotification[]>(() => {
    const saved = safeGetLocalStorage('stgorge_notifications');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {}
    }
    return [];
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
  const [activeEditingId, setActiveEditingId] = useState<string | null>(null);
  const [hasUnsavedEditChanges, setHasUnsavedEditChanges] = useState<boolean>(false);
  const activeEditingIdRef = useRef<string | null>(null);
  const hasUnsavedEditChangesRef = useRef<boolean>(false);
  activeEditingIdRef.current = activeEditingId;
  hasUnsavedEditChangesRef.current = hasUnsavedEditChanges;

  const [activeToast, setActiveToast] = useState<AppNotification | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [isAreaModalOpen, setIsAreaModalOpen] = useState(false);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpenState] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);

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
    if (isSyncing) return 'syncing';
    if (lastSyncError) return 'failed';
    if (pendingMutationsCount > 0) return 'pending';
    if (lastSuccessfulSyncTime) return 'synced';
    return 'connected';
  }, [isOnline, isSyncing, lastSyncError, pendingMutationsCount, lastSuccessfulSyncTime]);

  // Online / Offline window listeners
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setLastSyncError(null);
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Keep Weekly Local Notifications synced cleanly with Africa/Cairo clock & DST (no past missed triggers)
  useEffect(() => {
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
        const pending = await idbGetPendingMutations();
        if (mounted) {
          setPendingMutationsCount(pending.length);
        }

        // Pull authoritative real data from Google Sheets when online (never invent mock data on failure)
        const onlineNow = typeof navigator === 'undefined' || navigator.onLine !== false;
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

  // Sync notifications to localStorage
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('stgorge_notifications', JSON.stringify(notifications));
      }
    } catch {}
  }, [notifications]);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setActiveToast(null);
  }, []);

  const addNotification = useCallback(
    (title: string, desc?: string, type: 'info' | 'warn' | 'success' | 'danger' = 'info') => {
      const newNotif: AppNotification = {
        id: generateUUID(),
        title,
        desc,
        type,
        timestamp: Date.now(),
        unread: true
      };
      setNotifications((prev) => [newNotif, ...prev.slice(0, 29)]);
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

  // Filtered Students logic
  const filteredStudents = useMemo(() => {
    const q = normalizeArabicText(filters.searchQuery);
    const targetServant = filters.servant ? filters.servant.trim() : '';
    const targetArea = filters.area ? filters.area.trim() : '';
    const targetLetter = filters.alphabetLetter;
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
  }, [students, filters]);

  // 1. Process Offline Queue: Delegates to production engine
  const processOfflineQueue = useCallback(async (): Promise<{
    success: boolean;
    sentCount: number;
    remainingCount: number;
  }> => {
    const res = await executeProcessOfflineQueue(
      user,
      isPreviewMode,
      addNotification,
      (pushIso) => {
        setLastSuccessfulPushTime(pushIso);
      }
    );
    const pending = await idbGetPendingMutations();
    setPendingMutationsCount(pending.length);
    return res;
  }, [user, isPreviewMode, addNotification]);

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
      const idempotencyKey = `ATT_${studentId}_${friday}_${opId}`;

      const nextAtt: Record<string, boolean> = { ...(student.att || {}), [friday]: isPresent };
      const monthlySummary = computeMonthlyAttendanceSummary(nextAtt);
      const totalDelta = isPresent ? (prevVal === true ? 0 : 1) : (prevVal === true ? -1 : 0);

      const updatedStudent: Student = {
        ...student,
        att: nextAtt,
        attendanceStatus: isPresent ? 'حاضر' : 'غائب',
        attendanceTotal: Math.max(0, student.attendanceTotal + totalDelta),
        attendanceMonth: monthlySummary.presentCount,
        ...(isPresent && (!student.lastAttendance || friday >= student.lastAttendance)
          ? { lastAttendance: friday }
          : {}),
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

        // Refreshing the pending counter is secondary UI work. If this read fails
        // after the atomic attendance+queue transaction committed, do not roll back
        // the visible attendance state or report the saved attendance as failed.
        try {
          const pending = await idbGetPendingMutations();
          setPendingMutationsCount(pending.length);
        } catch (counterError) {
          console.warn('Attendance saved, but pending mutation count could not refresh:', counterError);
        }

        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('فشل الحفظ في قاعدة البيانات', err?.message || 'تعذر تسجيل الحضور محلياً', 'danger');
        return false;
      }
    },
    [students, isPreviewMode, canPerformAction, addNotification]
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
      const idempotencyKey = `FU_${studentId}_${opId}`;
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
        const pending = await idbGetPendingMutations();
        setPendingMutationsCount(pending.length);
        addNotification('تم تسجيل الافتقاد', `${student.name}: ${method}`, 'success');
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        setFollowupRecords(priorFollowup);
        addNotification('خطأ في قاعدة البيانات', err?.message || 'تعذر حفظ الافتقاد في IndexedDB', 'danger');
        return false;
      }
    },
    [students, followupRecords, isPreviewMode, canPerformAction, addNotification]
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
      const mutation: OfflineMutation = {
        id: `UPD_${studentId}_${opId}`,
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
        const pending = await idbGetPendingMutations();
        setPendingMutationsCount(pending.length);
        addNotification('تم تحديث البيانات', `تم تعديل بيانات ${student.name}`, 'success');
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('خطأ في التخزين', err?.message || 'تعذر تعديل المخدوم في IndexedDB', 'danger');
        return false;
      }
    },
    [students, isPreviewMode, canPerformAction, addNotification]
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
        const pending = await idbGetPendingMutations();
        setPendingMutationsCount(pending.length);
        addNotification('تمت إضافة المخدوم', `تم تسجيل ${newStudent.name} بنجاح`, 'success');
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('خطأ في الإضافة', err?.message || 'تعذر إضافة المخدوم في IndexedDB', 'danger');
        return false;
      }
    },
    [students, filters.sheet, isPreviewMode, canPerformAction, addNotification]
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
        const pending = await idbGetPendingMutations();
        setPendingMutationsCount(pending.length);
        addNotification('تم الحذف', `تم حذف سجل ${student.name}`, 'info');
        return true;
      } catch (err: any) {
        setStudents(priorStudents);
        addNotification('خطأ في الحذف', err?.message || 'تعذر حذف السجل من IndexedDB', 'danger');
        return false;
      }
    },
    [students, isPreviewMode, canPerformAction, addNotification]
  );

  return (
    <AppContext.Provider
      value={{
        students,
        filteredStudents,
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
        activeEditingId,
        hasUnsavedEditChanges,
        isSidebarOpen,
        isSidebarCollapsed,
        isInitialLoading,
        isAssistantOpen,
        isNotificationsOpen,
        isAreaModalOpen,
        isAboutModalOpen,
        isAddModalOpen,
        isSyncModalOpen,
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
        setIsAreaModalOpen,
        setIsAboutModalOpen,
        setIsAddModalOpen,
        setIsSyncModalOpen,
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
