import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import {
  MutationQueueStatus,
  MutationStageTimings,
  OfflineMutation,
  RemoteVerificationOutcome,
  SyncOutcomeStatus
} from '../types/auth';
import { classifyFollowupMethod, normalizeArabicText } from '../utils/arabicUtils';
import {
  buildStableStudentIdFromCode,
  isValidStudentCode,
  normalizeStudentCodeKey
} from './googleSheetParser';

const DB_NAME = 'StGorgeServiceDB';
const DB_VERSION = 2;

export interface AttendanceHistoryRecord {
  id: string; // `${studentId}__${fridayDate}`
  studentId: string;
  studentCode: string;
  fridayDate: string;
  status: boolean;
  recordedAt: number;
  sourceSheet: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function getIndexedDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB غير مدعوم في هذا المتصفح'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onblocked = () => {
      console.warn('IndexedDB connection blocked: Please close other open tabs of this app.');
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('students')) {
        const studentStore = db.createObjectStore('students', { keyPath: 'id' });
        studentStore.createIndex('code', 'code', { unique: false });
        studentStore.createIndex('name', 'name', { unique: false });
        studentStore.createIndex('servant', 'servant', { unique: false });
        studentStore.createIndex('sourceSheet', 'sourceSheet', { unique: false });
      }

      if (!db.objectStoreNames.contains('followup')) {
        db.createObjectStore('followup', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('mutations')) {
        db.createObjectStore('mutations', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('attendance_history')) {
        const historyStore = db.createObjectStore('attendance_history', { keyPath: 'id' });
        historyStore.createIndex('studentId', 'studentId', { unique: false });
        historyStore.createIndex('fridayDate', 'fridayDate', { unique: false });
        historyStore.createIndex('student_friday', ['studentId', 'fridayDate'], { unique: true });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        console.warn('IndexedDB database version changed. Connection closed.');
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('فشل فتح قاعدة بيانات IndexedDB'));
    };
  });

  return dbPromise;
}

export function idbCloseDatabase(): void {
  if (dbPromise) {
    dbPromise.then((db) => {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    });
    dbPromise = null;
  }
}

// 1. Atomic Add Student + Mutation in a SINGLE readwrite transaction
export async function idbAtomicAddStudentWithMutation(
  newStudent: Student,
  mutation: OfflineMutation
): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة إضافة المخدوم مع تسجيل العملية الذرية'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء المعاملة الذرية لإضافة المخدوم'));

    try {
      const studentReq = studentStore.put(newStudent);
      studentReq.onerror = () => tx.abort();

      const mutReq = mutationStore.put(mutation);
      mutReq.onerror = () => tx.abort();
    } catch (err) {
      tx.abort();
      safeReject(err);
    }
  });
}

// 2. Atomic Update Student + Mutation in a SINGLE readwrite transaction
export async function idbAtomicUpdateStudentWithMutation(
  updatedStudent: Student,
  mutation: OfflineMutation
): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت المعاملة الذرية لتحديث المخدوم'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة تحديث المخدوم'));

    try {
      const studentReq = studentStore.put(updatedStudent);
      studentReq.onerror = () => tx.abort();

      const mutReq = mutationStore.put(mutation);
      mutReq.onerror = () => tx.abort();
    } catch (err) {
      tx.abort();
      safeReject(err);
    }
  });
}

// 2b. Atomic Record Attendance + History Record + Mutation Deduplication in ONE transaction
// Prevents duplicate pending mutations & duplicate student+friday records
export async function idbAtomicRecordAttendanceWithMutation(
  updatedStudent: Student,
  historyRecord: AttendanceHistoryRecord,
  mutation: OfflineMutation
): Promise<{ student: Student; mutation: OfflineMutation }> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    let persistedResult: { student: Student; mutation: OfflineMutation } = {
      student: updatedStudent,
      mutation
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve(persistedResult);
      }
    };

    const tx = db.transaction(['students', 'attendance_history', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const historyStore = tx.objectStore('attendance_history');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت المعاملة الذرية لتسجيل الحضور'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة تسجيل الحضور'));

    const getMutReq = mutationStore.getAll();
    getMutReq.onerror = () => tx.abort();
    getMutReq.onsuccess = () => {
      try {
        const existingMutations: OfflineMutation[] = getMutReq.result || [];
        const supersededMutations: OfflineMutation[] = [];

        // Replace ONLY superseded pending attendance mutations for the exact same (studentId, fridayDate)
        // while preserving the earliest original remote expectedVersion (prevents false HTTP 409 conflicts)
        for (const m of existingMutations) {
          if (
            m.action === 'attendance' &&
            m.status === 'pending' &&
            m.studentId === historyRecord.studentId &&
            m.payload?.friday === historyRecord.fridayDate
          ) {
            supersededMutations.push(m);
            mutationStore.delete(m.id);
          }
        }

        let preservedExpectedVersion = mutation.expectedVersion;
        if (supersededMutations.length > 0) {
          for (const sm of supersededMutations) {
            if (typeof sm.expectedVersion === 'number' && Number.isFinite(sm.expectedVersion)) {
              if (
                typeof preservedExpectedVersion !== 'number' ||
                !Number.isFinite(preservedExpectedVersion) ||
                sm.expectedVersion < preservedExpectedVersion
              ) {
                preservedExpectedVersion = sm.expectedVersion;
              }
            }
          }
        }

        const mutationToStore: OfflineMutation =
          preservedExpectedVersion !== mutation.expectedVersion
            ? { ...mutation, expectedVersion: preservedExpectedVersion }
            : mutation;

        // Avoid inflating local student.version when replacing an unsynced pending mutation
        const studentToStore: Student =
          supersededMutations.length > 0 &&
          typeof preservedExpectedVersion === 'number' &&
          Number.isFinite(preservedExpectedVersion)
            ? {
                ...updatedStudent,
                version: Math.min(updatedStudent.version || 1, preservedExpectedVersion + 1)
              }
            : updatedStudent;

        persistedResult = { student: studentToStore, mutation: mutationToStore };

        const studentReq = studentStore.put(studentToStore);
        studentReq.onerror = () => tx.abort();

        const historyReq = historyStore.put({
          ...historyRecord,
          id: `${historyRecord.studentId}__${historyRecord.fridayDate}`
        });
        historyReq.onerror = () => tx.abort();

        const mutReq = mutationStore.put(mutationToStore);
        mutReq.onerror = () => tx.abort();
      } catch (err) {
        tx.abort();
        safeReject(err);
      }
    };
  });
}

// 2c. Atomic Batch Record Attendance + History + Sequential FIFO Mutations in ONE transaction
// Deduplicates superseded pending attendance mutations by logical key (studentId + fridayDate)
export async function idbAtomicBatchRecordAttendanceWithMutations(
  updatedStudents: Student[],
  historyRecords: AttendanceHistoryRecord[],
  mutations: OfflineMutation[]
): Promise<void> {
  if (updatedStudents.length === 0 && historyRecords.length === 0 && mutations.length === 0) {
    return;
  }
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'attendance_history', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const historyStore = tx.objectStore('attendance_history');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت المعاملة الذرية لاستيراد سجلات الحضور'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة استيراد سجلات الحضور'));

    const incomingMutationByKey = new Map<string, OfflineMutation>();
    for (const mut of mutations) {
      const fri = String(mut.payload?.friday || mut.payload?.date || '');
      if (mut.studentId && fri) {
        incomingMutationByKey.set(`${mut.studentId}__${fri}`, mut);
      }
    }

    const getExistingMutReq = mutationStore.getAll();
    getExistingMutReq.onerror = () => tx.abort();
    getExistingMutReq.onsuccess = () => {
      try {
        const existingMutations: OfflineMutation[] = getExistingMutReq.result || [];
        const skipPutMutationIds = new Set<string>();
        const preservedExpectedVersionByMutId = new Map<string, number>();

        // Deduplicate against ALL active queue statuses without deleting failed/retrying/timeout_unknown ops
        for (const existing of existingMutations) {
          if (existing.action !== 'attendance') continue;
          const existingFriday = String(existing.payload?.friday || existing.payload?.date || '');
          const existingLogicalKey = `${existing.studentId}__${existingFriday}`;
          const incomingMut = incomingMutationByKey.get(existingLogicalKey);
          if (!incomingMut) continue;

          const existingPresent = Boolean(existing.payload?.isPresent ?? existing.payload?.present);
          const incomingPresent = Boolean(incomingMut.payload?.isPresent ?? incomingMut.payload?.present);

          if (existing.status === 'pending' && existingPresent !== incomingPresent) {
            // Only supersede a still-pending mutation when the user intentionally flipped its state before sync,
            // preserving the earliest original remote expectedVersion
            if (typeof existing.expectedVersion === 'number' && Number.isFinite(existing.expectedVersion)) {
              const currentMin = preservedExpectedVersionByMutId.get(incomingMut.id);
              const candidate =
                typeof incomingMut.expectedVersion === 'number' && Number.isFinite(incomingMut.expectedVersion)
                  ? Math.min(existing.expectedVersion, incomingMut.expectedVersion)
                  : existing.expectedVersion;
              preservedExpectedVersionByMutId.set(
                incomingMut.id,
                currentMin !== undefined ? Math.min(currentMin, candidate) : candidate
              );
            }
            mutationStore.delete(existing.id);
          } else {
            // Identical state OR in-flight/failed/timeout_unknown/conflict: keep existing queued op untouched & skip duplicate write
            skipPutMutationIds.add(incomingMut.id);
          }
        }

        for (const student of updatedStudents) {
          const studentReq = studentStore.put(student);
          studentReq.onerror = () => tx.abort();
        }

        for (const historyRecord of historyRecords) {
          const historyReq = historyStore.put({
            ...historyRecord,
            id: `${historyRecord.studentId}__${historyRecord.fridayDate}`
          });
          historyReq.onerror = () => tx.abort();
        }

        for (const mutation of mutations) {
          if (skipPutMutationIds.has(mutation.id)) continue;
          const preservedVer = preservedExpectedVersionByMutId.get(mutation.id);
          const mutationToStore =
            preservedVer !== undefined ? { ...mutation, expectedVersion: preservedVer } : mutation;
          const mutReq = mutationStore.put(mutationToStore);
          mutReq.onerror = () => tx.abort();
        }
      } catch (err) {
        tx.abort();
        safeReject(err);
      }
    };
  });
}

export async function idbGetAttendanceHistory(studentId?: string): Promise<AttendanceHistoryRecord[]> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('attendance_history', 'readonly');
    const store = tx.objectStore('attendance_history');
    let records: AttendanceHistoryRecord[] = [];

    const req = studentId ? store.index('studentId').getAll(studentId) : store.getAll();
    req.onsuccess = () => {
      records = req.result || [];
    };
    req.onerror = () => safeReject(req.error || new Error('فشل قراءة سجل الحضور التاريخي'));

    tx.oncomplete = () => resolve(records);
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة قراءة سجل الحضور التاريخي'));
  });
}

// 3. Atomic Delete Student + Mutation in a SINGLE readwrite transaction
export async function idbAtomicDeleteStudentWithMutation(
  studentId: string,
  mutation: OfflineMutation
): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت المعاملة الذرية لحذف المخدوم'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة حذف المخدوم'));

    try {
      const studentReq = studentStore.delete(studentId);
      studentReq.onerror = () => tx.abort();

      const mutReq = mutationStore.put(mutation);
      mutReq.onerror = () => tx.abort();
    } catch (err) {
      tx.abort();
      safeReject(err);
    }
  });
}

// Atomic local transfer + single remote mutation in one IndexedDB transaction.
export async function idbAtomicTransferStudentWithMutation(
  sourceStudentId: string,
  destinationStudent: Student,
  mutation: OfflineMutation
): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت المعاملة الذرية لنقل المخدوم'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء المعاملة الذرية لنقل المخدوم'));

    try {
      const deleteReq = studentStore.delete(sourceStudentId);
      deleteReq.onerror = () => tx.abort();

      const putStudentReq = studentStore.put(destinationStudent);
      putStudentReq.onerror = () => tx.abort();

      const mutationReq = mutationStore.put(mutation);
      mutationReq.onerror = () => tx.abort();
    } catch (err) {
      tx.abort();
      safeReject(err);
    }
  });
}

// 4. Atomic Record Follow-up in a SINGLE readwrite transaction across 3 stores
// Guarantees all-or-nothing rollback if any step fails
export async function idbAtomicRecordFollowupWithMutation(
  updatedStudent: Student,
  followupRecord: FollowupRecord,
  mutation: OfflineMutation
): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'followup', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');
    const mutationStore = tx.objectStore('mutations');

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت المعاملة الذرية لتسجيل الافتقاد'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء المعاملة الذرية لتسجيل الافتقاد'));

    try {
      // 1. Update Student
      const studentReq = studentStore.put(updatedStudent);
      studentReq.onerror = () => tx.abort();

      // 2. Put FollowupRecord (single put without clearing store)
      const fuReq = followupStore.put(followupRecord);
      fuReq.onerror = () => tx.abort();

      // 3. Put OfflineMutation
      const mutReq = mutationStore.put(mutation);
      mutReq.onerror = () => tx.abort();
    } catch (err) {
      tx.abort();
      safeReject(err);
    }
  });
}

export interface PullVerificationProof {
  verified: boolean;
  isComplete: boolean;
  sheetName: string;
  source?: 'gviz' | 'relay' | 'express' | 'local';
  reason?: string;
}

export interface StudentIdMigrationReport {
  migratedStudents: number;
  updatedFollowups: number;
  updatedHistoryRecords: number;
  updatedMutations: number;
  skippedUnkeyedCount: number;
  skippedDuplicateCodeCount: number;
}

function normalizePositiveVersion(val: any): number {
  const n = Number(val);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function validateStudentBatchWrite(
  students: Student[],
  targetSheet: string,
  isConfirmedComplete: boolean | undefined,
  pullVerification: PullVerificationProof | undefined,
  operationName: 'idbSaveStudents' | 'idbReconcileStudents'
): void {
  if (
    !targetSheet ||
    !targetSheet.trim() ||
    targetSheet === '__ALL__' ||
    targetSheet === 'undefined' ||
    targetSheet === 'null'
  ) {
    throw new Error(
      `لا يمكن استدعاء ${operationName} بالفصل المحجوز __ALL__ أو باسم فصل غير صالح؛ يجب تحديد اسم فصل حقيقي لعزل البيانات ومنع المسح غير المقصود`
    );
  }

  // Explicit verification proof check (mandatory storage-layer gate for remote pulls)
  if (pullVerification !== undefined) {
    if (
      pullVerification.verified !== true ||
      pullVerification.isComplete !== true ||
      pullVerification.sheetName !== targetSheet
    ) {
      const detail = pullVerification.reason ? ` (${pullVerification.reason})` : '';
      throw new Error(
        `تم رفض ${operationName} على مستوى التخزين لفصل (${targetSheet}): سحب غير مُتحقَّق أو غير مكتمل${detail}. تم الاحتفاظ بكافة البيانات المحلية دون تعديل.`
      );
    }
  }

  // Explicit isConfirmedComplete === false blocks even non-empty partial/unverified pulls
  if (isConfirmedComplete === false) {
    throw new Error(
      `تم رفض ${operationName} لفصل (${targetSheet}): السحب مُعلَّم صراحةً كغير مكتمل (isConfirmedComplete === false). تم الاحتفاظ بكافة البيانات المحلية.`
    );
  }

  // Pre-validation: Verify ALL incoming records BEFORE any database interaction.
  // Zero toleration: Reject the entire operation if any record is invalid, lacks name/sourceSheet, or belongs to another sheet.
  for (const s of students) {
    if (!s || !s.id || !s.name || !String(s.name).trim() || !s.sourceSheet || s.sourceSheet !== targetSheet) {
      throw new Error(
        `تم رفض عملية ${operationName} بالكامل: وُجد سجل غير صالح أو بدون sourceSheet/اسم أو تابع لفصل مختلف (${s?.sourceSheet || 'غير محدد'}) بدلاً من الفصل المستهدف (${targetSheet}). لم يتم تعديل أو حذف أي بيانات محلية.`
      );
    }
  }

  // Completeness check for empty server response:
  // Strictly requires isConfirmedComplete === true; rejects false, undefined, or any other value
  if (students.length === 0 && isConfirmedComplete !== true) {
    throw new Error(
      `لا يمكن استبدال أو تسوية فصل (${targetSheet}) بقائمة فارغة ما لم تكن مؤكدة الاكتمال صراحة (isConfirmedComplete === true). تم الاحتفاظ بكافة البيانات المحلية.`
    );
  }
}

/**
 * Phase 4.2.1 Version & Identity Merge Policy:
 * 1. Any local record with pending mutations OR hasUnsyncedLocalChanges === true is STRICTLY preserved
 *    (even if remote says version: 1).
 * 2. When remote lacks a version column (hasRemoteVersion === false) and local has NO unsynced edits,
 *    legitimate updates from other devices ARE accepted (preventing permanent blocking) while keeping
 *    monotonic local version >= existing and preserving non-conflicting local Friday attendance/followup keys.
 * 3. When remote has an authoritative version (hasRemoteVersion === true, or default explicit OCC comparison),
 *    strictly newer local version (localVer > incomingVer) is never downgraded.
 * 4. Missing/invalid versions on either side normalize safely to 1.
 */
function resolveIncomingVsLocalStudent(
  localRecord: Student | undefined,
  incoming: Student,
  hasPendingMutation: boolean
): Student {
  const incomingVer = normalizePositiveVersion(incoming.version);

  if (!localRecord) {
    return {
      ...incoming,
      version: incomingVer,
      hasUnsyncedLocalChanges: false
    };
  }

  const localVer = normalizePositiveVersion(localRecord.version);

  // Rule 1: Pending mutation or explicit unsynced local changes ALWAYS protect local state
  if (hasPendingMutation || localRecord.hasUnsyncedLocalChanges === true) {
    return {
      ...localRecord,
      id: incoming.id, // Align ID safely if migrated from legacy ID -> stable code ID
      version: localVer
    };
  }

  // Rule 2: Remote source explicitly lacks a version column (e.g., Gviz without version column or Relay default version: 1)
  if (incoming.hasRemoteVersion === false) {
    return {
      ...incoming,
      version: Math.max(localVer, incomingVer),
      hasUnsyncedLocalChanges: false,
      att: { ...(localRecord.att || {}), ...(incoming.att || {}) },
      fu: { ...(localRecord.fu || {}), ...(incoming.fu || {}) },
      ...(localRecord.fuOutcomes || incoming.fuOutcomes
        ? { fuOutcomes: { ...(localRecord.fuOutcomes || {}), ...(incoming.fuOutcomes || {}) } }
        : {})
    };
  }

  // Rule 3: Authoritative remote version comparison (protect strictly newer local version)
  if (localVer > incomingVer) {
    return {
      ...localRecord,
      id: incoming.id,
      version: localVer
    };
  }

  // Verified remote version is >= local version: accept remote record
  return {
    ...incoming,
    version: incomingVer,
    hasUnsyncedLocalChanges: false
  };
}

/**
 * Builds a unique-code lookup map for a sheet's local students so legacy IDs (e.g. gs_نشط_101_3)
 * can be safely matched and migrated to canonical stable IDs without ever touching ambiguous/unkeyed rows.
 */
function buildUniqueCodeMapForSheet(students: Iterable<Student>): Map<string, Student> {
  const counts = new Map<string, number>();
  const byCode = new Map<string, Student>();
  for (const s of students) {
    if (!s || s.identityQuality === 'unkeyed' || !isValidStudentCode(s.code)) continue;
    const nk = normalizeStudentCodeKey(s.code);
    counts.set(nk, (counts.get(nk) || 0) + 1);
    byCode.set(nk, s);
  }
  const unique = new Map<string, Student>();
  for (const [nk, count] of counts.entries()) {
    if (count === 1) {
      const match = byCode.get(nk);
      if (match) unique.set(nk, match);
    }
  }
  return unique;
}

/**
 * Atomically re-links followup, attendance_history, and mutations records when student IDs
 * transition from legacy row-indexed IDs to canonical stable code IDs inside an open readwrite transaction.
 */
function relinkMigratedStudentIdsInTx(
  oldIdToNewId: Map<string, string>,
  followupStore: IDBObjectStore,
  historyStore: IDBObjectStore,
  mutationStore: IDBObjectStore,
  tx: IDBTransaction
): void {
  if (oldIdToNewId.size === 0) return;

  const fuReq = followupStore.getAll();
  fuReq.onerror = () => tx.abort();
  fuReq.onsuccess = () => {
    const allFu: FollowupRecord[] = fuReq.result || [];
    for (const rec of allFu) {
      const newId = oldIdToNewId.get(rec.studentId);
      if (newId && newId !== rec.studentId) {
        const putReq = followupStore.put({ ...rec, studentId: newId });
        putReq.onerror = () => tx.abort();
      }
    }
  };

  const histReq = historyStore.getAll();
  histReq.onerror = () => tx.abort();
  histReq.onsuccess = () => {
    const allHist: AttendanceHistoryRecord[] = histReq.result || [];
    for (const h of allHist) {
      const newId = oldIdToNewId.get(h.studentId);
      if (newId && newId !== h.studentId) {
        const newKey = `${newId}__${h.fridayDate}`;
        if (h.id !== newKey) {
          const delReq = historyStore.delete(h.id);
          delReq.onerror = () => tx.abort();
        }
        const putReq = historyStore.put({ ...h, id: newKey, studentId: newId });
        putReq.onerror = () => tx.abort();
      }
    }
  };

  const mutReq = mutationStore.getAll();
  mutReq.onerror = () => tx.abort();
  mutReq.onsuccess = () => {
    const allMuts: OfflineMutation[] = mutReq.result || [];
    for (const m of allMuts) {
      const newId = oldIdToNewId.get(m.studentId);
      if (newId && newId !== m.studentId) {
        const nextPayload =
          m.payload && typeof m.payload === 'object' && m.payload.studentId === m.studentId
            ? { ...m.payload, studentId: newId }
            : m.payload;
        const putReq = mutationStore.put({ ...m, studentId: newId, payload: nextPayload });
        putReq.onerror = () => tx.abort();
      }
    }
  };
}

/**
 * Standalone safe atomic migration converting legacy row-indexed student IDs (`gs_<sheet>_<code>_<row>`)
 * to canonical stable code IDs (`gs_code_<sheet>_<code>`) across all 4 IndexedDB stores.
 * Never touches unkeyed records, duplicate codes, or non-legacy UUIDs.
 */
export async function idbMigrateLegacyStudentIds(sheetName?: string): Promise<StudentIdMigrationReport> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const report: StudentIdMigrationReport = {
      migratedStudents: 0,
      updatedFollowups: 0,
      updatedHistoryRecords: 0,
      updatedMutations: 0,
      skippedUnkeyedCount: 0,
      skippedDuplicateCodeCount: 0
    };
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['students', 'followup', 'attendance_history', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');
    const historyStore = tx.objectStore('attendance_history');
    const mutationStore = tx.objectStore('mutations');

    const getAllReq = studentStore.getAll();
    getAllReq.onerror = () => tx.abort();
    getAllReq.onsuccess = () => {
      const allStudents: Student[] = getAllReq.result || [];
      const bySheet = new Map<string, Student[]>();
      for (const s of allStudents) {
        if (!s || !s.sourceSheet) continue;
        if (sheetName && s.sourceSheet !== sheetName) continue;
        if (!bySheet.has(s.sourceSheet)) bySheet.set(s.sourceSheet, []);
        bySheet.get(s.sourceSheet)!.push(s);
      }

      const oldIdToNewId = new Map<string, string>();
      const existingIdSet = new Set(allStudents.map((s) => s.id));

      for (const [sheet, list] of bySheet.entries()) {
        const codeCounts = new Map<string, number>();
        for (const s of list) {
          if (isValidStudentCode(s.code)) {
            const nk = normalizeStudentCodeKey(s.code);
            codeCounts.set(nk, (codeCounts.get(nk) || 0) + 1);
          }
        }

        for (const s of list) {
          if (!s.id || !s.id.startsWith('gs_') || s.id.startsWith('gs_code_') || s.id.startsWith('gs_unkeyed_')) {
            continue;
          }
          if (!isValidStudentCode(s.code)) {
            report.skippedUnkeyedCount++;
            continue;
          }
          const nk = normalizeStudentCodeKey(s.code);
          if ((codeCounts.get(nk) || 0) !== 1) {
            report.skippedDuplicateCodeCount++;
            continue;
          }
          const canonicalId = buildStableStudentIdFromCode(sheet, s.code);
          if (canonicalId === s.id || existingIdSet.has(canonicalId)) {
            continue;
          }
          oldIdToNewId.set(s.id, canonicalId);
          existingIdSet.add(canonicalId);
          report.migratedStudents++;

          const delReq = studentStore.delete(s.id);
          delReq.onerror = () => tx.abort();
          const putReq = studentStore.put({
            ...s,
            id: canonicalId,
            identityQuality: 'stable_code'
          });
          putReq.onerror = () => tx.abort();
        }
      }

      if (oldIdToNewId.size > 0) {
        const fuReq = followupStore.getAll();
        fuReq.onerror = () => tx.abort();
        fuReq.onsuccess = () => {
          const allFu: FollowupRecord[] = fuReq.result || [];
          for (const rec of allFu) {
            const newId = oldIdToNewId.get(rec.studentId);
            if (newId) {
              report.updatedFollowups++;
              const putReq = followupStore.put({ ...rec, studentId: newId });
              putReq.onerror = () => tx.abort();
            }
          }
        };

        const histReq = historyStore.getAll();
        histReq.onerror = () => tx.abort();
        histReq.onsuccess = () => {
          const allHist: AttendanceHistoryRecord[] = histReq.result || [];
          for (const h of allHist) {
            const newId = oldIdToNewId.get(h.studentId);
            if (newId) {
              report.updatedHistoryRecords++;
              const newKey = `${newId}__${h.fridayDate}`;
              if (h.id !== newKey) {
                const delReq = historyStore.delete(h.id);
                delReq.onerror = () => tx.abort();
              }
              const putReq = historyStore.put({ ...h, id: newKey, studentId: newId });
              putReq.onerror = () => tx.abort();
            }
          }
        };

        const mutReq = mutationStore.getAll();
        mutReq.onerror = () => tx.abort();
        mutReq.onsuccess = () => {
          const allMuts: OfflineMutation[] = mutReq.result || [];
          for (const m of allMuts) {
            const newId = oldIdToNewId.get(m.studentId);
            if (newId) {
              report.updatedMutations++;
              const nextPayload =
                m.payload && typeof m.payload === 'object' && m.payload.studentId === m.studentId
                  ? { ...m.payload, studentId: newId }
                  : m.payload;
              const putReq = mutationStore.put({ ...m, studentId: newId, payload: nextPayload });
              putReq.onerror = () => tx.abort();
            }
          }
        };
      }
    };

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(report);
      }
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشلت هجرة معرّفات المخدومين الثابتة'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء هجرة معرّفات المخدومين الثابتة'));
  });
}

/**
 * Clears hasUnsyncedLocalChanges on a student only when zero pending mutations remain for that student.
 */
export async function idbClearStudentUnsyncedFlag(studentId: string): Promise<void> {
  if (!studentId) return;
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const mutationStore = tx.objectStore('mutations');

    const mutReq = mutationStore.getAll();
    mutReq.onerror = () => tx.abort();
    mutReq.onsuccess = () => {
      const pending: OfflineMutation[] = mutReq.result || [];
      const stillHasPending = pending.some((m) => m.studentId === studentId);
      if (stillHasPending) return;

      const getReq = studentStore.get(studentId);
      getReq.onerror = () => tx.abort();
      getReq.onsuccess = () => {
        const st: Student | undefined = getReq.result;
        if (st && st.hasUnsyncedLocalChanges) {
          const putReq = studentStore.put({ ...st, hasUnsyncedLocalChanges: false });
          putReq.onerror = () => tx.abort();
        }
      };
    };

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشل تحديث حالة مزامنة المخدوم'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء تحديث حالة مزامنة المخدوم'));
  });
}

// 5. Reconciliation Engine with Strict Multi-Sheet Isolation, Stable ID Migration & Non-Destructive Pull Policy
// Scoped to targetSheet: NEVER deletes or modifies students belonging to other sheets!
// Atomic across ['students', 'followup', 'attendance_history', 'mutations'] to guarantee link integrity.
// NEVER deletes a local student merely because its ID is absent from a non-empty Pull response.
export async function idbReconcileStudents(
  serverStudents: Student[],
  pendingMutations: OfflineMutation[] = [],
  targetSheet: string,
  isConfirmedComplete?: boolean,
  pullVerification?: PullVerificationProof
): Promise<Student[]> {
  validateStudentBatchWrite(
    serverStudents,
    targetSheet,
    isConfirmedComplete,
    pullVerification,
    'idbReconcileStudents'
  );

  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    // Single atomic transaction across all 4 stores for race-free reconciliation + ID migration re-linking
    const tx = db.transaction(['students', 'followup', 'attendance_history', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');
    const historyStore = tx.objectStore('attendance_history');
    const mutationStore = tx.objectStore('mutations');

    const getAllStudentsReq = studentStore.getAll();
    getAllStudentsReq.onerror = () => {
      tx.abort();
      safeReject(getAllStudentsReq.error || new Error('فشل قراءة بيانات المخدومين الحالية للتسوية'));
    };

    getAllStudentsReq.onsuccess = () => {
      const allLocalStudents: Student[] = getAllStudentsReq.result || [];

      // Read mutations directly within the same transaction
      const getAllMutationsReq = mutationStore.getAll();
      getAllMutationsReq.onerror = () => {
        tx.abort();
        safeReject(getAllMutationsReq.error || new Error('فشل قراءة العمليات المعلقة داخل معاملة التسوية'));
      };

      getAllMutationsReq.onsuccess = () => {
        const liveMutations: OfflineMutation[] = getAllMutationsReq.result || [];
        const allPendingMutations = [...liveMutations, ...(pendingMutations || [])];

        // 1. Separate students belonging to targetSheet
        const targetLocalMap = new Map<string, Student>();
        for (const s of allLocalStudents) {
          if (s.sourceSheet === targetSheet) {
            targetLocalMap.set(s.id, s);
          }
        }
        const targetLocalByUniqueCode = buildUniqueCodeMapForSheet(targetLocalMap.values());

        // Collect all student IDs (and codes) with pending mutations in the queue
        const pendingStudentIds = new Set<string>();
        const pendingStudentCodes = new Set<string>();
        for (const m of allPendingMutations) {
          if (!m.sourceSheet || m.sourceSheet === targetSheet || targetLocalMap.has(m.studentId)) {
            if (m.studentId) pendingStudentIds.add(m.studentId);
            if (isValidStudentCode(m.studentCode)) pendingStudentCodes.add(normalizeStudentCodeKey(m.studentCode));
          }
        }

        // Case A: Confirmed genuinely empty sheet ([] with isConfirmedComplete === true)
        if (serverStudents.length === 0) {
          for (const [localId, localStudent] of targetLocalMap.entries()) {
            const hasPending =
              pendingStudentIds.has(localId) ||
              (isValidStudentCode(localStudent.code) && pendingStudentCodes.has(normalizeStudentCodeKey(localStudent.code))) ||
              localStudent.hasUnsyncedLocalChanges === true;
            if (!hasPending) {
              const delReq = studentStore.delete(localId);
              delReq.onerror = () => tx.abort();
            }
          }
          return;
        }

        // Case B: Non-empty verified Pull -> non-destructive merge + safe unique-code ID migration!
        // NEVER delete a local student merely because its ID is absent from the Pull response.
        const incomingUniqueCodeCounts = new Map<string, number>();
        for (const s of serverStudents) {
          if (s.identityQuality !== 'unkeyed' && isValidStudentCode(s.code)) {
            const nk = normalizeStudentCodeKey(s.code);
            incomingUniqueCodeCounts.set(nk, (incomingUniqueCodeCounts.get(nk) || 0) + 1);
          }
        }

        const oldIdToNewId = new Map<string, string>();
        const migratedOldIds = new Set<string>();

        for (const serverStudent of serverStudents) {
          let matchedLocal = targetLocalMap.get(serverStudent.id);

          // Safe Legacy ID -> Stable Code ID matching (NEVER auto-merge unkeyed or duplicate-code rows!)
          if (
            !matchedLocal &&
            serverStudent.identityQuality !== 'unkeyed' &&
            isValidStudentCode(serverStudent.code)
          ) {
            const nk = normalizeStudentCodeKey(serverStudent.code);
            if (incomingUniqueCodeCounts.get(nk) === 1) {
              const legacyMatch = targetLocalByUniqueCode.get(nk);
              if (legacyMatch && legacyMatch.id !== serverStudent.id && !migratedOldIds.has(legacyMatch.id)) {
                matchedLocal = legacyMatch;
                oldIdToNewId.set(legacyMatch.id, serverStudent.id);
                migratedOldIds.add(legacyMatch.id);
              }
            }
          }

          const hasPending = Boolean(
            pendingStudentIds.has(serverStudent.id) ||
            (matchedLocal && pendingStudentIds.has(matchedLocal.id)) ||
            (isValidStudentCode(serverStudent.code) && pendingStudentCodes.has(normalizeStudentCodeKey(serverStudent.code)))
          );

          const resolved = resolveIncomingVsLocalStudent(matchedLocal, serverStudent, hasPending);
          const putReq = studentStore.put(resolved);
          putReq.onerror = () => tx.abort();
        }

        // Remove ONLY superseded old keys that were atomically migrated to their new canonical IDs
        for (const oldId of migratedOldIds) {
          const delReq = studentStore.delete(oldId);
          delReq.onerror = () => tx.abort();
        }

        // Re-link followup, attendance_history, and mutations atomically in the same transaction
        relinkMigratedStudentIdsInTx(oldIdToNewId, followupStore, historyStore, mutationStore, tx);
      };
    };

    tx.oncomplete = () => {
      idbGetStudents().then(resolve).catch(safeReject);
    };

    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة تسوية بيانات المخدومين'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة تسوية بيانات المخدومين'));
  });
}

// 6. Safe Save Students with Strict Multi-Sheet Isolation, Pull Verification Gate,
// Stable Identity Migration & Non-Destructive Absent-ID Policy
export async function idbSaveStudents(
  students: Student[],
  targetSheet: string,
  isConfirmedComplete?: boolean,
  pullVerification?: PullVerificationProof
): Promise<void> {
  validateStudentBatchWrite(
    students,
    targetSheet,
    isConfirmedComplete,
    pullVerification,
    'idbSaveStudents'
  );

  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const safeResolve = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const tx = db.transaction(['students', 'followup', 'attendance_history', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');
    const historyStore = tx.objectStore('attendance_history');
    const mutationStore = tx.objectStore('mutations');

    const checkMutationsReq = mutationStore.getAll();
    checkMutationsReq.onerror = () => tx.abort();

    checkMutationsReq.onsuccess = () => {
      const pending: OfflineMutation[] = checkMutationsReq.result || [];

      // Check if there are pending mutations affecting the target sheet
      // Conservative detection: any mutation matching targetSheet, OR lacking sourceSheet entirely
      const hasConflict = pending.some((m) => {
        if (m.sourceSheet === targetSheet) return true;
        if (!m.sourceSheet) {
          return true;
        }
        return false;
      });

      if (hasConflict) {
        tx.abort();
        safeReject(new Error('لا يمكن استبدال بيانات الفصل مع وجود عمليات معلقة في الطابور تخص هذا الفصل أو مجهولة المصدر'));
        return;
      }

      const getLocalReq = studentStore.getAll();
      getLocalReq.onerror = () => tx.abort();

      getLocalReq.onsuccess = () => {
        const localStudents: Student[] = getLocalReq.result || [];
        const targetLocalMap = new Map<string, Student>();
        for (const s of localStudents) {
          if (s.sourceSheet === targetSheet) {
            targetLocalMap.set(s.id, s);
          }
        }

        // Case A: Confirmed genuinely empty sheet ([] with isConfirmedComplete === true)
        if (students.length === 0) {
          for (const [localId, localStudent] of targetLocalMap.entries()) {
            if (localStudent.hasUnsyncedLocalChanges !== true) {
              const delReq = studentStore.delete(localId);
              delReq.onerror = () => tx.abort();
            }
          }
          return;
        }

        // Case B: Non-empty verified Pull -> merge + safe unique-code ID migration.
        // If the pull is confirmed complete, students absent from the sheet AND with no
        // unsynced local changes are removed from IndexedDB (they were deleted from the sheet).
        if (isConfirmedComplete) {
          const incomingIds = new Set(students.map((s) => s.id));
          for (const [localId, localStudent] of targetLocalMap.entries()) {
            if (
              !incomingIds.has(localId) &&
              localStudent.hasUnsyncedLocalChanges !== true
            ) {
              const delReq = studentStore.delete(localId);
              delReq.onerror = () => tx.abort();
            }
          }
        }

        const targetLocalByUniqueCode = buildUniqueCodeMapForSheet(targetLocalMap.values());
        const incomingUniqueCodeCounts = new Map<string, number>();
        for (const s of students) {
          if (s.identityQuality !== 'unkeyed' && isValidStudentCode(s.code)) {
            const nk = normalizeStudentCodeKey(s.code);
            incomingUniqueCodeCounts.set(nk, (incomingUniqueCodeCounts.get(nk) || 0) + 1);
          }
        }

        const oldIdToNewId = new Map<string, string>();
        const migratedOldIds = new Set<string>();

        for (const student of students) {
          let existingLocal = targetLocalMap.get(student.id);

          // Safe Legacy ID -> Stable Code ID matching (NEVER auto-merge unkeyed or duplicate-code rows!)
          if (
            !existingLocal &&
            student.identityQuality !== 'unkeyed' &&
            isValidStudentCode(student.code)
          ) {
            const nk = normalizeStudentCodeKey(student.code);
            if (incomingUniqueCodeCounts.get(nk) === 1) {
              const legacyMatch = targetLocalByUniqueCode.get(nk);
              if (legacyMatch && legacyMatch.id !== student.id && !migratedOldIds.has(legacyMatch.id)) {
                existingLocal = legacyMatch;
                oldIdToNewId.set(legacyMatch.id, student.id);
                migratedOldIds.add(legacyMatch.id);
              }
            }
          }

          const recordToStore = resolveIncomingVsLocalStudent(existingLocal, student, false);
          const putReq = studentStore.put(recordToStore);
          putReq.onerror = () => tx.abort();
        }

        // Delete ONLY superseded old keys that were atomically migrated to their new canonical IDs
        for (const oldId of migratedOldIds) {
          const delReq = studentStore.delete(oldId);
          delReq.onerror = () => tx.abort();
        }

        // Re-link followup, attendance_history, and mutations atomically
        relinkMigratedStudentIdsInTx(oldIdToNewId, followupStore, historyStore, mutationStore, tx);
      };
    };

    tx.oncomplete = () => safeResolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة حفظ المخدومين في IndexedDB'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة IndexedDB أثناء حفظ المخدومين'));
  });
}

// Read students: waits for transaction completion before returning result
export async function idbGetStudents(): Promise<Student[]> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('students', 'readonly');
    const store = tx.objectStore('students');
    let data: Student[] = [];

    const req = store.getAll();
    req.onsuccess = () => {
      data = req.result || [];
    };
    req.onerror = () => {
      safeReject(req.error || new Error('فشل استرجاع بيانات المخدومين'));
    };

    tx.oncomplete = () => resolve(data);
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة قراءة المخدومين من IndexedDB'));
  });
}

// Single Followup record insert (preserves previous records)
export async function idbAddFollowupRecord(record: FollowupRecord): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('followup', 'readwrite');
    const store = tx.objectStore('followup');

    tx.oncomplete = () => resolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشل إضافة سجل الافتقاد'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء إضافة سجل الافتقاد'));

    const req = store.put(record);
    req.onerror = () => tx.abort();
  });
}

// Read followup: waits for transaction completion
export async function idbGetFollowupRecords(): Promise<FollowupRecord[]> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('followup', 'readonly');
    const store = tx.objectStore('followup');
    let data: FollowupRecord[] = [];

    const req = store.getAll();
    req.onsuccess = () => {
      data = req.result || [];
    };
    req.onerror = () => {
      safeReject(req.error || new Error('فشل استرجاع سجلات الافتقاد'));
    };

    tx.oncomplete = () => resolve(data);
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة قراءة سجل الافتقاد'));
  });
}

export interface FollowupPullVerificationProof {
  verified: boolean;
  isComplete: boolean;
  isPartialParse?: boolean;
  source?: 'gviz' | 'relay' | 'express';
  reason?: string;
}

function validateRemoteFollowupBatch(
  remoteRecords: FollowupRecord[],
  verification?: FollowupPullVerificationProof
): void {
  if (verification !== undefined) {
    if (
      verification.verified !== true ||
      verification.isComplete !== true ||
      verification.isPartialParse === true
    ) {
      const detail = verification.reason ? ` (${verification.reason})` : '';
      throw new Error(
        `تم رفض تحديث كاش سجل الافتقاد: الاستجابة غير موثقة أو جزئية${detail}. تم الاحتفاظ بكافة السجلات المحلية.`
      );
    }
  }

  if (!Array.isArray(remoteRecords)) {
    throw new Error('تم رفض تحديث كاش سجل الافتقاد: بنية القائمة غير صالحة.');
  }

  for (const rec of remoteRecords) {
    const hasStudentName = Boolean(rec?.studentName && String(rec.studentName).trim());
    const hasId = Boolean(rec?.id && String(rec.id).trim());
    const hasType = typeof rec?.type === 'string' && rec.type.trim().length > 0;
    const hasDate = Boolean(
      (rec?.date && String(rec.date).trim()) ||
      (rec?.fridayDate && String(rec.fridayDate).trim())
    );
    if (!rec || !hasId || !hasStudentName || !hasType || !hasDate) {
      throw new Error(
        'تم رفض تحديث كاش سجل الافتقاد بالكامل: وُجد سجل افتقاد تالف أو ناقص الحقول الأساسية. لم يتم حذف أو تعديل أي سجل محلي.'
      );
    }
  }
}

// Reconcile remote Google Sheet سجل الافتقاد rows while strictly rejecting partial/unverified/malformed payloads
// and preserving locally pending AND unique synced local followup entries.
export async function idbSaveRemoteFollowupRecords(
  remoteRecords: FollowupRecord[],
  verification?: FollowupPullVerificationProof
): Promise<FollowupRecord[]> {
  validateRemoteFollowupBatch(remoteRecords, verification);

  // Never wipe cached followup records on an empty remote array
  if (remoteRecords.length === 0) {
    return idbGetFollowupRecords();
  }

  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['followup', 'mutations'], 'readwrite');
    const fuStore = tx.objectStore('followup');
    const mutStore = tx.objectStore('mutations');

    const buildLogicalKey = (rec: FollowupRecord): string => {
      const studentPart = normalizeArabicText(rec.studentName) || String(rec.studentCode || '').trim() || String(rec.studentId || '').trim();
      const datePart = (rec.date && rec.date !== '-' ? rec.date : rec.fridayDate) || '';
      const methodPart = classifyFollowupMethod(rec.type);
      return `${studentPart}__${datePart}__${methodPart}`;
    };

    const getMutReq = mutStore.getAll();
    getMutReq.onerror = () => tx.abort();
    getMutReq.onsuccess = () => {
      const pending: OfflineMutation[] = getMutReq.result || [];
      const pendingRecordIds = new Set<string>(
        pending
          .filter((m) => m.action === 'followup' && m.payload?.recordId)
          .map((m) => String(m.payload.recordId))
      );

      const remoteLogicalMap = new Map<string, FollowupRecord>();
      for (const remote of remoteRecords) {
        remoteLogicalMap.set(buildLogicalKey(remote), remote);
      }

      const getExistingReq = fuStore.getAll();
      getExistingReq.onerror = () => tx.abort();
      getExistingReq.onsuccess = () => {
        const existing: FollowupRecord[] = getExistingReq.result || [];
        for (const rec of existing) {
          if (pendingRecordIds.has(rec.id)) continue;

          // Previous remote Gviz snapshot rows (gs_fu_*) are replaced ONLY after full verification passed
          if (String(rec.id).startsWith('gs_fu_')) {
            fuStore.delete(rec.id);
            continue;
          }

          // Local records created in-app: if already reflected in remote 'سجل الافتقاد', enrich & deduplicate;
          // if NOT yet in 'سجل الافتقاد' (e.g. notes-v2 only updates per-date sheet columns), KEEP locally!
          const lKey = buildLogicalKey(rec);
          const matchingRemote = remoteLogicalMap.get(lKey);
          if (matchingRemote) {
            if (!matchingRemote.notes && rec.notes) matchingRemote.notes = rec.notes;
            if (!matchingRemote.callOutcome && rec.callOutcome) matchingRemote.callOutcome = rec.callOutcome;
            fuStore.delete(rec.id);
          }
        }
        for (const remote of remoteRecords) {
          fuStore.put(remote);
        }
      };
    };

    tx.oncomplete = () => {
      idbGetFollowupRecords().then(resolve).catch(safeReject);
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشل تحديث سجل الافتقاد محلياً'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة تحديث سجل الافتقاد'));
  });
}

// Idempotent Mutations Queue with transaction completion and error checking
export async function idbQueueMutation(mutation: OfflineMutation): Promise<boolean> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('mutations', 'readwrite');
    const store = tx.objectStore('mutations');

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => safeReject(tx.error || new Error(`فشل تسجيل العملية في طابور الأوفلاين: ${mutation.id}`));
    tx.onabort = () => safeReject(tx.error || new Error(`تم إلغاء عملية تسجيل الطابور: ${mutation.id}`));

    const putReq = store.put(mutation);
    putReq.onerror = () => tx.abort();
  });
}

export async function idbGetPendingMutations(): Promise<OfflineMutation[]> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('mutations', 'readonly');
    const store = tx.objectStore('mutations');
    let data: OfflineMutation[] = [];

    const req = store.getAll();
    req.onsuccess = () => {
      data = req.result || [];
    };
    req.onerror = () => {
      safeReject(req.error || new Error('فشل قراءة العمليات المعلقة'));
    };

    tx.oncomplete = () => {
      // Sort mutations chronologically by timestamp (Strict FIFO queue order)
      data.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      resolve(data);
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة قراءة العمليات المعلقة'));
  });
}

export async function idbRemoveMutation(id: string): Promise<void> {
  if (!id) return;
  await idbRemoveMutationsBatch([id]);
}

export async function idbRemoveMutationsBatch(ids: string[]): Promise<void> {
  const validIds = (ids || []).filter(Boolean);
  if (validIds.length === 0) return;
  const idSet = new Set(validIds);
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['mutations', 'students'], 'readwrite');
    const mutStore = tx.objectStore('mutations');
    const studentStore = tx.objectStore('students');

    tx.oncomplete = () => resolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشل حذف العمليات المؤكدة من الطابور'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء حذف العمليات المؤكدة من الطابور'));

    const allMutReq = mutStore.getAll();
    allMutReq.onerror = () => tx.abort();

    allMutReq.onsuccess = () => {
      const allMutations: OfflineMutation[] = allMutReq.result || [];
      const removedStudentIds = new Set<string>();
      const remainingStudentIds = new Set<string>();

      for (const mut of allMutations) {
        if (!mut?.id) continue;
        if (idSet.has(mut.id)) {
          if (mut.studentId) removedStudentIds.add(mut.studentId);
        } else {
          if (mut.studentId) remainingStudentIds.add(mut.studentId);
        }
      }

      for (const id of validIds) {
        const delReq = mutStore.delete(id);
        delReq.onerror = () => tx.abort();
      }

      // Keep every student with remaining mutations (pending/retrying/failed/conflict/timeout_unknown) protected
      for (const studentId of remainingStudentIds) {
        const getProtectedReq = studentStore.get(studentId);
        getProtectedReq.onerror = () => tx.abort();
        getProtectedReq.onsuccess = () => {
          const existing = getProtectedReq.result as Student | undefined;
          if (existing && !existing.hasUnsyncedLocalChanges) {
            const putReq = studentStore.put({ ...existing, hasUnsyncedLocalChanges: true });
            putReq.onerror = () => tx.abort();
          }
        };
      }

      // For every student whose last pending mutation was removed, clear hasUnsyncedLocalChanges
      // ONLY when ZERO remaining mutations exist for that student.
      for (const studentId of removedStudentIds) {
        if (remainingStudentIds.has(studentId)) continue;
        const getStudentReq = studentStore.get(studentId);
        getStudentReq.onerror = () => tx.abort();
        getStudentReq.onsuccess = () => {
          const existing = getStudentReq.result as Student | undefined;
          if (existing && existing.hasUnsyncedLocalChanges) {
            const putReq = studentStore.put({ ...existing, hasUnsyncedLocalChanges: false });
            putReq.onerror = () => tx.abort();
          }
        };
      }
    };
  });
}

// Mark mutation as conflicted without deleting it (zero data loss)
export async function idbMarkMutationConflict(id: string, errorMessage: string): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('mutations', 'readwrite');
    const store = tx.objectStore('mutations');

    const getReq = store.get(id);
    getReq.onerror = () => tx.abort();

    getReq.onsuccess = () => {
      const mutation: OfflineMutation = getReq.result;
      if (!mutation) {
        return;
      }
      mutation.status = 'conflict';
      mutation.syncOutcome = 'conflict';
      mutation.verificationOutcome = 'conflict';
      mutation.lastError = errorMessage;
      mutation.nextRetryAt = undefined;
      mutation.isPermanentError = false;
      mutation.errorCategory = 'conflict';
      const putReq = store.put(mutation);
      putReq.onerror = () => tx.abort();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => safeReject(tx.error || new Error(`فشلت معاملة تمييز التعارض للعملية: ${id}`));
    tx.onabort = () => safeReject(tx.error || new Error(`تم إلغاء معاملة تمييز التعارض للعملية: ${id}`));
  });
}

export interface MutationErrorUpdateMeta {
  nextRetryAt?: number | null;
  lastDurationMs?: number;
  stageTimingsMs?: MutationStageTimings;
  syncOutcome?: SyncOutcomeStatus;
  verificationOutcome?: RemoteVerificationOutcome;
  incrementRetry?: boolean;
  isPermanentError?: boolean;
  errorCategory?: 'transient' | 'permanent' | 'conflict' | 'timeout';
}

// Persist failure/timeout details without ever altering idempotency key or deleting mutation (Zero Data Loss)
export async function idbUpdateMutationError(
  id: string,
  errorMessage: string,
  status: MutationQueueStatus = 'failed',
  meta?: MutationErrorUpdateMeta
): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('mutations', 'readwrite');
    const store = tx.objectStore('mutations');

    const getReq = store.get(id);
    getReq.onerror = () => tx.abort();

    getReq.onsuccess = () => {
      const mutation: OfflineMutation = getReq.result;
      if (!mutation) {
        return;
      }
      mutation.status = status;
      mutation.syncOutcome =
        meta?.syncOutcome ||
        (status === 'timeout_unknown'
          ? 'timeout_unknown'
          : status === 'conflict'
          ? 'conflict'
          : status === 'pending' || status === 'retrying'
          ? 'pending'
          : 'failed');
      mutation.lastError = errorMessage;
      if (meta?.incrementRetry !== false) {
        mutation.retryCount = (mutation.retryCount || 0) + 1;
      }
      mutation.lastAttemptAt = Date.now();
      if (meta?.nextRetryAt === null) {
        mutation.nextRetryAt = undefined;
      } else if (meta?.nextRetryAt !== undefined) {
        mutation.nextRetryAt = meta.nextRetryAt;
      }
      if (meta?.isPermanentError !== undefined) {
        mutation.isPermanentError = meta.isPermanentError;
        if (meta.isPermanentError) {
          mutation.nextRetryAt = undefined;
        }
      }
      if (meta?.errorCategory !== undefined) {
        mutation.errorCategory = meta.errorCategory;
      }
      if (meta?.verificationOutcome !== undefined) {
        mutation.verificationOutcome = meta.verificationOutcome;
      }
      if (meta?.lastDurationMs !== undefined) {
        mutation.lastDurationMs = meta.lastDurationMs;
      }
      if (meta?.stageTimingsMs !== undefined) {
        mutation.stageTimingsMs = meta.stageTimingsMs;
      }
      const putReq = store.put(mutation);
      putReq.onerror = () => tx.abort();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => safeReject(tx.error || new Error(`فشلت معاملة تحديث خطأ العملية: ${id}`));
    tx.onabort = () => safeReject(tx.error || new Error(`تم إلغاء معاملة تحديث خطأ العملية: ${id}`));
  });
}

// Batch update multiple mutations in one atomic IndexedDB transaction (for timeout_unknown / backoff state)
export async function idbUpdateMutationsBatchState(
  updates: Array<{
    id: string;
    errorMessage: string;
    status: MutationQueueStatus;
    meta?: MutationErrorUpdateMeta;
  }>
): Promise<void> {
  if (!updates || updates.length === 0) return;
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('mutations', 'readwrite');
    const store = tx.objectStore('mutations');

    tx.oncomplete = () => resolve();
    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة تحديث حالات الدفعة في الطابور'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة تحديث حالات الدفعة في الطابور'));

    const now = Date.now();
    for (const item of updates) {
      const getReq = store.get(item.id);
      getReq.onerror = () => tx.abort();
      getReq.onsuccess = () => {
        const mutation: OfflineMutation = getReq.result;
        if (!mutation) return;
        mutation.status = item.status;
        mutation.syncOutcome =
          item.meta?.syncOutcome ||
          (item.status === 'timeout_unknown'
            ? 'timeout_unknown'
            : item.status === 'conflict'
            ? 'conflict'
            : item.status === 'pending' || item.status === 'retrying'
            ? 'pending'
            : 'failed');
        mutation.lastError = item.errorMessage;
        if (item.meta?.incrementRetry !== false) {
          mutation.retryCount = (mutation.retryCount || 0) + 1;
        }
        mutation.lastAttemptAt = now;
        if (item.meta?.nextRetryAt === null) {
          mutation.nextRetryAt = undefined;
        } else if (item.meta?.nextRetryAt !== undefined) {
          mutation.nextRetryAt = item.meta.nextRetryAt;
        }
        if (item.meta?.isPermanentError !== undefined) {
          mutation.isPermanentError = item.meta.isPermanentError;
          if (item.meta.isPermanentError) {
            mutation.nextRetryAt = undefined;
          }
        }
        if (item.meta?.errorCategory !== undefined) {
          mutation.errorCategory = item.meta.errorCategory;
        }
        if (item.meta?.verificationOutcome !== undefined) {
          mutation.verificationOutcome = item.meta.verificationOutcome;
        }
        if (item.meta?.lastDurationMs !== undefined) {
          mutation.lastDurationMs = item.meta.lastDurationMs;
        }
        if (item.meta?.stageTimingsMs !== undefined) {
          mutation.stageTimingsMs = item.meta.stageTimingsMs;
        }
        const putReq = store.put(mutation);
        putReq.onerror = () => tx.abort();
      };
    }
  });
}

// Track targeted single-item manual retry requested via idbResetMutationRetry(id)
// Allows QueueDetailsModal's existing (idbResetMutationRetry + processOfflineQueue) flow
// to execute ONLY that selected mutation without touching unrelated deferred/conflicting items.
let pendingManualRetryTarget: { id: string; requestedAt: number } | null = null;
const MANUAL_RETRY_TARGET_TTL_MS = 30_000;

export function peekPendingManualRetryTarget(): string | null {
  if (!pendingManualRetryTarget) return null;
  if (Date.now() - pendingManualRetryTarget.requestedAt > MANUAL_RETRY_TARGET_TTL_MS) {
    pendingManualRetryTarget = null;
    return null;
  }
  return pendingManualRetryTarget.id;
}

export function consumePendingManualRetryTarget(): string | null {
  const id = peekPendingManualRetryTarget();
  pendingManualRetryTarget = null;
  return id;
}

export function clearPendingManualRetryTarget(): void {
  pendingManualRetryTarget = null;
}

// Reset mutation status to pending for intentional targeted manual retry (never changes immutable mutation.id!)
export async function idbResetMutationRetry(id: string): Promise<void> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    let foundMutation = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction('mutations', 'readwrite');
    const store = tx.objectStore('mutations');

    const getReq = store.get(id);
    getReq.onerror = () => tx.abort();

    getReq.onsuccess = () => {
      const mutation: OfflineMutation = getReq.result;
      if (!mutation) {
        return;
      }
      foundMutation = true;
      mutation.status = 'pending';
      mutation.syncOutcome = 'pending';
      mutation.verificationOutcome = undefined;
      mutation.nextRetryAt = undefined;
      mutation.isPermanentError = false;
      mutation.errorCategory = undefined;
      const putReq = store.put(mutation);
      putReq.onerror = () => tx.abort();
    };

    tx.oncomplete = () => {
      if (foundMutation) {
        pendingManualRetryTarget = { id, requestedAt: Date.now() };
      }
      resolve();
    };
    tx.onerror = () => safeReject(tx.error || new Error(`فشلت معاملة إعادة ضبط محاولة العملية: ${id}`));
    tx.onabort = () => safeReject(tx.error || new Error(`تم إلغاء معاملة إعادة ضبط محاولة العملية: ${id}`));
  });
}

export interface ClearSelectedMutationsResult {
  clearedCount: number;
  remainingCount: number;
  clearedStudentIds: string[];
  protectedStudentIds: string[];
}

/**
 * Atomically removes ONLY the explicitly specified mutation IDs (after verified recovery backup)
 * and recalculates `hasUnsyncedLocalChanges` across `['mutations', 'students']`:
 * - Students with ANY remaining mutation (pending, retrying, failed, conflict, timeout_unknown)
 *   STRICTLY retain `hasUnsyncedLocalChanges = true`.
 * - Students with ZERO remaining mutations have `hasUnsyncedLocalChanges` reset to `false`
 *   so their local records are never permanently frozen from future Google Sheets pulls.
 * - Does NOT claim or record remote synchronization.
 */
export async function idbClearSelectedMutations(ids: string[]): Promise<ClearSelectedMutationsResult> {
  const validIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (validIds.length === 0) {
    const existing = await idbGetPendingMutations().catch(() => [] as OfflineMutation[]);
    return {
      clearedCount: 0,
      remainingCount: existing.length,
      clearedStudentIds: [],
      protectedStudentIds: Array.from(new Set(existing.map((m) => m.studentId).filter(Boolean)))
    };
  }

  clearPendingManualRetryTarget();
  const idSet = new Set(validIds);
  const db = await getIndexedDB();

  return new Promise((resolve, reject) => {
    let settled = false;
    let result: ClearSelectedMutationsResult = {
      clearedCount: 0,
      remainingCount: 0,
      clearedStudentIds: [],
      protectedStudentIds: []
    };

    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['mutations', 'students'], 'readwrite');
    const mutStore = tx.objectStore('mutations');
    const studentStore = tx.objectStore('students');

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشل حذف العمليات المحددة من الطابور'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء حذف العمليات المحددة من الطابور'));

    const allMutReq = mutStore.getAll();
    allMutReq.onerror = () => tx.abort();
    allMutReq.onsuccess = () => {
      const allMutations: OfflineMutation[] = allMutReq.result || [];
      const actualRemovedIds: string[] = [];
      const removedStudentIds = new Set<string>();
      const remainingStudentIds = new Set<string>();
      let remainingCount = 0;

      for (const mut of allMutations) {
        if (!mut?.id) continue;
        if (idSet.has(mut.id)) {
          actualRemovedIds.push(mut.id);
          if (mut.studentId) removedStudentIds.add(mut.studentId);
        } else {
          remainingCount += 1;
          if (mut.studentId) remainingStudentIds.add(mut.studentId);
        }
      }

      for (const id of actualRemovedIds) {
        const delReq = mutStore.delete(id);
        delReq.onerror = () => tx.abort();
      }

      const clearedStudentIds = Array.from(removedStudentIds).filter((sid) => !remainingStudentIds.has(sid));
      const protectedStudentIds = Array.from(remainingStudentIds);

      result = {
        clearedCount: actualRemovedIds.length,
        remainingCount,
        clearedStudentIds,
        protectedStudentIds
      };

      for (const studentId of protectedStudentIds) {
        const getReq = studentStore.get(studentId);
        getReq.onerror = () => tx.abort();
        getReq.onsuccess = () => {
          const existing = getReq.result as Student | undefined;
          if (existing && !existing.hasUnsyncedLocalChanges) {
            const putReq = studentStore.put({ ...existing, hasUnsyncedLocalChanges: true });
            putReq.onerror = () => tx.abort();
          }
        };
      }

      for (const studentId of clearedStudentIds) {
        const getReq = studentStore.get(studentId);
        getReq.onerror = () => tx.abort();
        getReq.onsuccess = () => {
          const existing = getReq.result as Student | undefined;
          if (existing && existing.hasUnsyncedLocalChanges) {
            const putReq = studentStore.put({ ...existing, hasUnsyncedLocalChanges: false });
            putReq.onerror = () => tx.abort();
          }
        };
      }
    };
  });
}

export async function idbClearMutations(): Promise<number> {
  clearPendingManualRetryTarget();
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    let clearedCount = 0;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['mutations', 'students'], 'readwrite');
    const mutStore = tx.objectStore('mutations');
    const studentStore = tx.objectStore('students');

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(clearedCount);
      }
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشل تفريغ طابور العمليات'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء تفريغ طابور العمليات'));

    const countReq = mutStore.count();
    countReq.onerror = () => tx.abort();
    countReq.onsuccess = () => {
      clearedCount = countReq.result || 0;
      const clearReq = mutStore.clear();
      clearReq.onerror = () => tx.abort();

      // Atomically recalculate student local-unsynced flags so clearing the queue
      // never leaves stale `hasUnsyncedLocalChanges: true` flags that permanently freeze pulls.
      const allStudentsReq = studentStore.getAll();
      allStudentsReq.onerror = () => tx.abort();
      allStudentsReq.onsuccess = () => {
        const allStudents: Student[] = allStudentsReq.result || [];
        for (const student of allStudents) {
          if (student && student.hasUnsyncedLocalChanges) {
            const putReq = studentStore.put({ ...student, hasUnsyncedLocalChanges: false });
            putReq.onerror = () => tx.abort();
          }
        }
      };
    };
  });
}

/**
 * Atomically reconciles `hasUnsyncedLocalChanges` on every student record against
 * the current contents of the `mutations` store.
 */
export async function idbRecalculateUnsyncedStudentFlags(): Promise<{
  protectedCount: number;
  clearedFlagCount: number;
  raisedFlagCount: number;
}> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    let protectedCount = 0;
    let clearedFlagCount = 0;
    let raisedFlagCount = 0;

    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['mutations', 'students'], 'readwrite');
    const mutStore = tx.objectStore('mutations');
    const studentStore = tx.objectStore('students');

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve({ protectedCount, clearedFlagCount, raisedFlagCount });
      }
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشل إعادة حساب حالة التعديلات المحلية'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء إعادة حساب حالة التعديلات المحلية'));

    const mutReq = mutStore.getAll();
    mutReq.onerror = () => tx.abort();
    mutReq.onsuccess = () => {
      const mutations: OfflineMutation[] = mutReq.result || [];
      const protectedIds = new Set<string>(
        mutations.map((m) => m.studentId).filter((sid): sid is string => Boolean(sid))
      );
      protectedCount = protectedIds.size;

      const studentsReq = studentStore.getAll();
      studentsReq.onerror = () => tx.abort();
      studentsReq.onsuccess = () => {
        const students: Student[] = studentsReq.result || [];
        for (const student of students) {
          if (!student?.id) continue;
          const shouldProtect = protectedIds.has(student.id);
          const currentlyProtected = Boolean(student.hasUnsyncedLocalChanges);
          if (shouldProtect !== currentlyProtected) {
            if (shouldProtect) raisedFlagCount += 1;
            else clearedFlagCount += 1;
            const putReq = studentStore.put({ ...student, hasUnsyncedLocalChanges: shouldProtect });
            putReq.onerror = () => tx.abort();
          }
        }
      };
    };
  });
}

/**
 * Removes legacy seeded mock records (`mock-std-*`, `mock-fu-*`) from IndexedDB
 * so only genuine Google Sheets records or user-created entries are stored locally.
 */
export async function idbPurgeMockRecords(): Promise<number> {
  const db = await getIndexedDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    let removedCount = 0;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(['students', 'followup'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');

    const sReq = studentStore.getAll();
    sReq.onsuccess = () => {
      const list: Student[] = sReq.result || [];
      for (const st of list) {
        if (st && typeof st.id === 'string' && st.id.startsWith('mock-')) {
          studentStore.delete(st.id);
          removedCount++;
        }
      }
    };
    sReq.onerror = () => tx.abort();

    const fReq = followupStore.getAll();
    fReq.onsuccess = () => {
      const list: FollowupRecord[] = fReq.result || [];
      for (const fu of list) {
        if (fu && typeof fu.id === 'string' && fu.id.startsWith('mock-')) {
          followupStore.delete(fu.id);
          removedCount++;
        }
      }
    };
    fReq.onerror = () => tx.abort();

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(removedCount);
      }
    };
    tx.onerror = () => safeReject(tx.error || new Error('فشل تنظيف السجلات التجريبية القديمة'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء تنظيف السجلات التجريبية القديمة'));
  });
}

// ============================================================================
// Phase 4.1: Complete Local Data Backup Snapshot & Safe Atomic Merge Restore
// ============================================================================

export const INDEXED_DB_NAME = DB_NAME;
export const INDEXED_DB_VERSION = DB_VERSION;

export interface DatabaseStoreSummary {
  databaseName: string;
  databaseVersion: number;
  storeNames: string[];
  counts: {
    students: number;
    followup: number;
    mutations: number;
    attendance_history: number;
    [extraStore: string]: number;
  };
  totalRecords: number;
}

export interface DatabaseSnapshotExport {
  databaseName: string;
  databaseVersion: number;
  storeNames: string[];
  counts: {
    students: number;
    followup: number;
    mutations: number;
    attendance_history: number;
    [extraStore: string]: number;
  };
  stores: {
    students: Student[];
    followup: FollowupRecord[];
    mutations: OfflineMutation[];
    attendance_history: AttendanceHistoryRecord[];
    [extraStore: string]: unknown[];
  };
}

export interface SafeMergeStoreStats {
  inserted: number;
  updated: number;
  keptExisting: number;
}

export interface SafeMergeRestoreResult {
  beforeCounts: DatabaseStoreSummary['counts'];
  afterCounts: DatabaseStoreSummary['counts'];
  stats: {
    students: SafeMergeStoreStats;
    followup: SafeMergeStoreStats;
    mutations: SafeMergeStoreStats;
    attendance_history: SafeMergeStoreStats;
  };
  verified: boolean;
}

/**
 * Inspects StGorgeServiceDB inside a single readonly transaction across all existing stores
 * and returns accurate record counts per store.
 */
export async function idbInspectDatabaseSummary(): Promise<DatabaseStoreSummary> {
  const snapshot = await idbExportDatabaseSnapshot();
  const totalRecords = Object.values(snapshot.counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return {
    databaseName: snapshot.databaseName,
    databaseVersion: snapshot.databaseVersion,
    storeNames: snapshot.storeNames,
    counts: snapshot.counts,
    totalRecords
  };
}

/**
 * Exports a 100% consistent snapshot of ALL object stores in StGorgeServiceDB
 * using a single multi-store `readonly` IndexedDB transaction.
 */
export async function idbExportDatabaseSnapshot(): Promise<DatabaseSnapshotExport> {
  const db = await getIndexedDB();
  const storeNames = Array.from(db.objectStoreNames);

  if (storeNames.length === 0) {
    return {
      databaseName: db.name || DB_NAME,
      databaseVersion: db.version || DB_VERSION,
      storeNames: [],
      counts: {
        students: 0,
        followup: 0,
        mutations: 0,
        attendance_history: 0
      },
      stores: {
        students: [],
        followup: [],
        mutations: [],
        attendance_history: []
      }
    };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const tx = db.transaction(storeNames, 'readonly');
    const rawStores: Record<string, unknown[]> = {};

    for (const storeName of storeNames) {
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        rawStores[storeName] = Array.isArray(req.result) ? req.result : [];
      };
      req.onerror = () => {
        safeReject(req.error || new Error(`فشل قراءة الجدول المحلي: ${storeName}`));
      };
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;

      const students = Array.isArray(rawStores.students) ? (rawStores.students as Student[]) : [];
      const followup = Array.isArray(rawStores.followup) ? (rawStores.followup as FollowupRecord[]) : [];
      const mutations = Array.isArray(rawStores.mutations) ? (rawStores.mutations as OfflineMutation[]) : [];
      const attendance_history = Array.isArray(rawStores.attendance_history)
        ? (rawStores.attendance_history as AttendanceHistoryRecord[])
        : [];

      const counts: DatabaseSnapshotExport['counts'] = {
        students: students.length,
        followup: followup.length,
        mutations: mutations.length,
        attendance_history: attendance_history.length
      };

      const stores: DatabaseSnapshotExport['stores'] = {
        students,
        followup,
        mutations,
        attendance_history
      };

      for (const name of storeNames) {
        if (name !== 'students' && name !== 'followup' && name !== 'mutations' && name !== 'attendance_history') {
          const list = Array.isArray(rawStores[name]) ? rawStores[name] : [];
          stores[name] = list;
          counts[name] = list.length;
        }
      }

      resolve({
        databaseName: db.name || DB_NAME,
        databaseVersion: db.version || DB_VERSION,
        storeNames,
        counts,
        stores
      });
    };

    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة أخذ لقطة قاعدة البيانات المحلية'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة أخذ لقطة قاعدة البيانات المحلية'));
  });
}

function parseIsoTimeMs(value?: string): number {
  if (!value || value === '-') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLatestDateKeyFromMap(record?: Record<string, unknown>): number {
  if (!record || typeof record !== 'object') return 0;
  let maxMs = 0;
  for (const key of Object.keys(record)) {
    const ms = parseIsoTimeMs(key);
    if (ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function getStudentFreshnessScore(student: Student): number {
  const versionScore = (Number(student.version) || 1) * 1_000_000_000_000;
  const lastDateMs = Math.max(
    parseIsoTimeMs(student.lastAttendance),
    parseIsoTimeMs(student.lastFollowup),
    getLatestDateKeyFromMap(student.att),
    getLatestDateKeyFromMap(student.fu)
  );
  return versionScore + lastDateMs;
}

function mergeStudentRecordsSafely(
  existing: Student,
  incoming: Student,
  hasPendingLocalMutation: boolean
): { merged: Student; didUpdate: boolean } {
  const existingScore = getStudentFreshnessScore(existing);
  const incomingScore = getStudentFreshnessScore(incoming);
  // Protect existing record if it has pending local mutations OR has equal/newer freshness
  const preferIncoming = !hasPendingLocalMutation && incomingScore > existingScore;

  const existingAtt = existing.att || {};
  const incomingAtt = incoming.att || {};
  const mergedAtt: Record<string, boolean> = preferIncoming
    ? { ...existingAtt, ...incomingAtt }
    : { ...incomingAtt, ...existingAtt };

  const existingFu = existing.fu || {};
  const incomingFu = incoming.fu || {};
  const mergedFu: Record<string, string> = preferIncoming
    ? { ...existingFu, ...incomingFu }
    : { ...incomingFu, ...existingFu };

  const existingOutcomes = existing.fuOutcomes || {};
  const incomingOutcomes = incoming.fuOutcomes || {};
  const mergedOutcomes =
    Object.keys(existingOutcomes).length > 0 || Object.keys(incomingOutcomes).length > 0
      ? preferIncoming
        ? { ...existingOutcomes, ...incomingOutcomes }
        : { ...incomingOutcomes, ...existingOutcomes }
      : undefined;

  const pickScalar = <T extends string | undefined>(primaryVal: T, fallbackVal: T): T => {
    const pStr = typeof primaryVal === 'string' ? primaryVal.trim() : '';
    if (pStr) return primaryVal;
    return fallbackVal;
  };

  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;

  const mergedVersion = Math.max(Number(existing.version) || 1, Number(incoming.version) || 1);
  const attEntriesCount = Object.values(mergedAtt).filter(Boolean).length;
  const mergedAttendanceTotal = Math.max(
    Number(primary.attendanceTotal) || 0,
    Number(secondary.attendanceTotal) || 0,
    attEntriesCount
  );

  const existingLastAttMs = parseIsoTimeMs(existing.lastAttendance);
  const incomingLastAttMs = parseIsoTimeMs(incoming.lastAttendance);
  const mergedLastAttendance =
    incomingLastAttMs > existingLastAttMs ? incoming.lastAttendance : existing.lastAttendance || incoming.lastAttendance;

  const existingLastFuMs = parseIsoTimeMs(existing.lastFollowup);
  const incomingLastFuMs = parseIsoTimeMs(incoming.lastFollowup);
  const mergedLastFollowup =
    incomingLastFuMs > existingLastFuMs ? incoming.lastFollowup : existing.lastFollowup || incoming.lastFollowup;

  const merged: Student = {
    ...secondary,
    ...primary,
    id: existing.id, // Always preserve canonical existing store key
    code: pickScalar(primary.code, secondary.code) || existing.code,
    name: pickScalar(primary.name, secondary.name) || existing.name,
    servant: pickScalar(primary.servant, secondary.servant) || existing.servant,
    phoneStudent: pickScalar(primary.phoneStudent, secondary.phoneStudent),
    phoneParent1: pickScalar(primary.phoneParent1, secondary.phoneParent1),
    phoneParent2: pickScalar(primary.phoneParent2, secondary.phoneParent2),
    birthDate: pickScalar(primary.birthDate, secondary.birthDate),
    area: pickScalar(primary.area, secondary.area) || '',
    address: pickScalar(primary.address, secondary.address) || '',
    notes: pickScalar(primary.notes, secondary.notes) || '',
    followupStatus: pickScalar(primary.followupStatus, secondary.followupStatus) || 'بدون',
    sourceSheet: pickScalar(primary.sourceSheet, secondary.sourceSheet) || existing.sourceSheet,
    version: mergedVersion,
    attendanceTotal: mergedAttendanceTotal,
    lastAttendance: mergedLastAttendance,
    lastFollowup: mergedLastFollowup,
    att: mergedAtt,
    fu: mergedFu,
    ...(mergedOutcomes ? { fuOutcomes: mergedOutcomes } : {})
  };

  const didUpdate = JSON.stringify(merged) !== JSON.stringify(existing);
  return { merged, didUpdate };
}

function buildFollowupLogicalKeyForMerge(rec: FollowupRecord): string {
  const studentPart =
    normalizeArabicText(rec.studentName) ||
    String(rec.studentCode || '').trim() ||
    String(rec.studentId || '').trim();
  const datePart = (rec.date && rec.date !== '-' ? rec.date : rec.fridayDate) || '';
  const methodPart = classifyFollowupMethod(rec.type);
  return `${studentPart}__${datePart}__${methodPart}`;
}

/**
 * Safely merges a validated backup snapshot into StGorgeServiceDB inside ONE atomic readwrite transaction.
 * - Never clears any store or deletes existing local records.
 * - Prevents duplicate records via unique primary IDs and logical uniqueness keys.
 * - Never overwrites newer local records with older backup data.
 * - Aborts and rolls back completely if any error occurs.
 */
export async function idbSafeMergeRestoreBackup(
  stores: {
    students: Student[];
    followup: FollowupRecord[];
    mutations: OfflineMutation[];
    attendance_history: AttendanceHistoryRecord[];
  },
  options?: {
    _beforeCommitHook?: () => void;
  }
): Promise<SafeMergeRestoreResult> {
  const db = await getIndexedDB();
  const requiredStores = ['students', 'followup', 'mutations', 'attendance_history'] as const;
  for (const storeName of requiredStores) {
    if (!db.objectStoreNames.contains(storeName)) {
      throw new Error(`الجدول المطلوب غير موجود في قاعدة البيانات: ${storeName}`);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const stats: SafeMergeRestoreResult['stats'] = {
      students: { inserted: 0, updated: 0, keptExisting: 0 },
      followup: { inserted: 0, updated: 0, keptExisting: 0 },
      mutations: { inserted: 0, updated: 0, keptExisting: 0 },
      attendance_history: { inserted: 0, updated: 0, keptExisting: 0 }
    };

    const beforeCounts: DatabaseStoreSummary['counts'] = {
      students: 0,
      followup: 0,
      mutations: 0,
      attendance_history: 0
    };

    const tx = db.transaction(['students', 'followup', 'mutations', 'attendance_history'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');
    const mutationStore = tx.objectStore('mutations');
    const historyStore = tx.objectStore('attendance_history');

    const failTx = (err: unknown, fallbackMessage: string) => {
      try {
        tx.abort();
      } catch {
        // Already aborted
      }
      safeReject(err instanceof Error ? err : new Error(fallbackMessage));
    };

    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة استعادة النسخة الاحتياطية وتم التراجع عنها'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة استعادة النسخة الاحتياطية وحفظ البيانات الأصلية'));

    const sReq = studentStore.getAll();
    const fReq = followupStore.getAll();
    const mReq = mutationStore.getAll();
    const hReq = historyStore.getAll();

    sReq.onerror = () => failTx(sReq.error, 'فشل قراءة المخدومين أثناء الاستعادة');
    fReq.onerror = () => failTx(fReq.error, 'فشل قراءة سجل الافتقاد أثناء الاستعادة');
    mReq.onerror = () => failTx(mReq.error, 'فشل قراءة طابور العمليات أثناء الاستعادة');
    hReq.onerror = () => failTx(hReq.error, 'فشل قراءة سجل الحضور أثناء الاستعادة');

    let loadedStudents: Student[] | null = null;
    let loadedFollowup: FollowupRecord[] | null = null;
    let loadedMutations: OfflineMutation[] | null = null;
    let loadedHistory: AttendanceHistoryRecord[] | null = null;

    const tryExecuteMerge = () => {
      if (!loadedStudents || !loadedFollowup || !loadedMutations || !loadedHistory) {
        return;
      }

      try {
        beforeCounts.students = loadedStudents.length;
        beforeCounts.followup = loadedFollowup.length;
        beforeCounts.mutations = loadedMutations.length;
        beforeCounts.attendance_history = loadedHistory.length;

        // Track students with active local mutations so newer local unsynced edits are strictly protected
        const localPendingStudentIds = new Set<string>(
          loadedMutations.map((m) => String(m.studentId || '')).filter(Boolean)
        );

        // 1. Merge Students (deduplicate by id, then by normalized name + sourceSheet)
        const existingStudentsById = new Map<string, Student>();
        const existingStudentIdByNameSheet = new Map<string, string>();
        for (const st of loadedStudents) {
          existingStudentsById.set(st.id, st);
          const normName = normalizeArabicText(st.name);
          const sheet = String(st.sourceSheet || '').trim();
          if (normName && sheet) {
            existingStudentIdByNameSheet.set(`${normName}__${sheet}`, st.id);
          }
        }

        const studentIdRemap = new Map<string, string>();
        for (const rawIncoming of stores.students || []) {
          if (!rawIncoming || !rawIncoming.id) continue;
          const normName = normalizeArabicText(rawIncoming.name);
          const sheet = String(rawIncoming.sourceSheet || '').trim();
          const nameSheetKey = normName && sheet ? `${normName}__${sheet}` : '';

          const matchedId = existingStudentsById.has(rawIncoming.id)
            ? rawIncoming.id
            : nameSheetKey
              ? existingStudentIdByNameSheet.get(nameSheetKey)
              : undefined;

          if (matchedId) {
            if (matchedId !== rawIncoming.id) {
              studentIdRemap.set(rawIncoming.id, matchedId);
            }
            const existing = existingStudentsById.get(matchedId)!;
            const { merged, didUpdate } = mergeStudentRecordsSafely(
              existing,
              rawIncoming,
              localPendingStudentIds.has(matchedId)
            );
            if (didUpdate) {
              existingStudentsById.set(matchedId, merged);
              const putReq = studentStore.put(merged);
              putReq.onerror = () => failTx(putReq.error, 'فشل دمج سجل مخدوم أثناء الاستعادة');
              stats.students.updated++;
            } else {
              stats.students.keptExisting++;
            }
          } else {
            existingStudentsById.set(rawIncoming.id, rawIncoming);
            if (nameSheetKey) {
              existingStudentIdByNameSheet.set(nameSheetKey, rawIncoming.id);
            }
            const putReq = studentStore.put(rawIncoming);
            putReq.onerror = () => failTx(putReq.error, 'فشل إضافة مخدوم من النسخة الاحتياطية');
            stats.students.inserted++;
          }
        }

        // 2. Merge Followup Records (deduplicate by id and logical key)
        const existingFollowupById = new Map<string, FollowupRecord>();
        const existingFollowupByLogicalKey = new Map<string, FollowupRecord>();
        for (const fu of loadedFollowup) {
          existingFollowupById.set(fu.id, fu);
          existingFollowupByLogicalKey.set(buildFollowupLogicalKeyForMerge(fu), fu);
        }

        for (const rawIncoming of stores.followup || []) {
          if (!rawIncoming || !rawIncoming.id) continue;
          const resolvedStudentId = studentIdRemap.get(rawIncoming.studentId) || rawIncoming.studentId;
          const incoming: FollowupRecord =
            resolvedStudentId !== rawIncoming.studentId
              ? { ...rawIncoming, studentId: resolvedStudentId }
              : rawIncoming;

          const lKey = buildFollowupLogicalKeyForMerge(incoming);
          const match = existingFollowupById.get(incoming.id) || existingFollowupByLogicalKey.get(lKey);

          if (match) {
            let changed = false;
            const enriched: FollowupRecord = { ...match };
            if (!enriched.notes && incoming.notes) {
              enriched.notes = incoming.notes;
              changed = true;
            }
            if (!enriched.callOutcome && incoming.callOutcome) {
              enriched.callOutcome = incoming.callOutcome;
              changed = true;
            }
            if (changed) {
              existingFollowupById.set(enriched.id, enriched);
              existingFollowupByLogicalKey.set(lKey, enriched);
              const putReq = followupStore.put(enriched);
              putReq.onerror = () => failTx(putReq.error, 'فشل تحديث تفاصيل سجل افتقاد أثناء الاستعادة');
              stats.followup.updated++;
            } else {
              stats.followup.keptExisting++;
            }
          } else {
            existingFollowupById.set(incoming.id, incoming);
            existingFollowupByLogicalKey.set(lKey, incoming);
            const putReq = followupStore.put(incoming);
            putReq.onerror = () => failTx(putReq.error, 'فشل استعادة سجل افتقاد');
            stats.followup.inserted++;
          }
        }

        // 3. Merge Offline Mutations (deduplicate by immutable mutation.id & active logical keys)
        const existingMutById = new Map<string, OfflineMutation>();
        const existingMutAttendanceKeys = new Set<string>();
        const existingFollowupRecordIdsInQueue = new Set<string>();

        for (const mut of loadedMutations) {
          existingMutById.set(mut.id, mut);
          if (mut.action === 'attendance') {
            const fri = String(mut.payload?.friday || mut.payload?.date || '');
            const pres = Boolean(mut.payload?.isPresent ?? mut.payload?.present);
            existingMutAttendanceKeys.add(`${mut.studentId}__${fri}__${pres}`);
          } else if (mut.action === 'followup' && mut.payload?.recordId) {
            existingFollowupRecordIdsInQueue.add(String(mut.payload.recordId));
          }
        }

        for (const rawIncoming of stores.mutations || []) {
          if (!rawIncoming || !rawIncoming.id) continue;
          const resolvedStudentId = studentIdRemap.get(rawIncoming.studentId) || rawIncoming.studentId;
          const incoming: OfflineMutation =
            resolvedStudentId !== rawIncoming.studentId
              ? { ...rawIncoming, studentId: resolvedStudentId }
              : rawIncoming;

          const existingById = existingMutById.get(incoming.id);
          if (existingById) {
            const existingTime = Math.max(existingById.lastAttemptAt || 0, existingById.timestamp || 0);
            const incomingTime = Math.max(incoming.lastAttemptAt || 0, incoming.timestamp || 0);
            if (incomingTime > existingTime && existingById.status === 'pending') {
              existingMutById.set(incoming.id, incoming);
              const putReq = mutationStore.put(incoming);
              putReq.onerror = () => failTx(putReq.error, 'فشل تحديث عملية في الطابور أثناء الاستعادة');
              stats.mutations.updated++;
            } else {
              stats.mutations.keptExisting++;
            }
            continue;
          }

          if (incoming.action === 'attendance') {
            const fri = String(incoming.payload?.friday || incoming.payload?.date || '');
            const pres = Boolean(incoming.payload?.isPresent ?? incoming.payload?.present);
            const attKey = `${incoming.studentId}__${fri}__${pres}`;
            if (existingMutAttendanceKeys.has(attKey)) {
              stats.mutations.keptExisting++;
              continue;
            }
            existingMutAttendanceKeys.add(attKey);
          } else if (incoming.action === 'followup' && incoming.payload?.recordId) {
            const recId = String(incoming.payload.recordId);
            if (existingFollowupRecordIdsInQueue.has(recId)) {
              stats.mutations.keptExisting++;
              continue;
            }
            existingFollowupRecordIdsInQueue.add(recId);
          }

          existingMutById.set(incoming.id, incoming);
          const putReq = mutationStore.put(incoming);
          putReq.onerror = () => failTx(putReq.error, 'فشل استعادة عملية معلقة في الطابور');
          stats.mutations.inserted++;
        }

        // 4. Merge Attendance History (respect unique index ['studentId', 'fridayDate'])
        const existingHistById = new Map<string, AttendanceHistoryRecord>();
        const existingHistByStudentFriday = new Map<string, AttendanceHistoryRecord>();
        for (const rec of loadedHistory) {
          existingHistById.set(rec.id, rec);
          existingHistByStudentFriday.set(`${rec.studentId}__${rec.fridayDate}`, rec);
        }

        for (const rawIncoming of stores.attendance_history || []) {
          if (!rawIncoming || !rawIncoming.studentId || !rawIncoming.fridayDate) continue;
          const resolvedStudentId = studentIdRemap.get(rawIncoming.studentId) || rawIncoming.studentId;
          const sfKey = `${resolvedStudentId}__${rawIncoming.fridayDate}`;
          const normalizedIncoming: AttendanceHistoryRecord = {
            ...rawIncoming,
            studentId: resolvedStudentId,
            id: rawIncoming.id || sfKey
          };

          const existing =
            existingHistByStudentFriday.get(sfKey) || existingHistById.get(normalizedIncoming.id);

          if (existing) {
            if ((normalizedIncoming.recordedAt || 0) > (existing.recordedAt || 0)) {
              const updatedRec: AttendanceHistoryRecord = {
                ...normalizedIncoming,
                id: existing.id // Keep existing key so unique index never conflicts
              };
              existingHistById.set(existing.id, updatedRec);
              existingHistByStudentFriday.set(sfKey, updatedRec);
              const putReq = historyStore.put(updatedRec);
              putReq.onerror = () => failTx(putReq.error, 'فشل تحديث سجل حضور تاريخي أثناء الاستعادة');
              stats.attendance_history.updated++;
            } else {
              stats.attendance_history.keptExisting++;
            }
          } else {
            // Ensure unique id matching student_friday to avoid ConstraintError
            const recordToInsert: AttendanceHistoryRecord = {
              ...normalizedIncoming,
              id: existingHistById.has(normalizedIncoming.id) ? sfKey : normalizedIncoming.id
            };
            existingHistById.set(recordToInsert.id, recordToInsert);
            existingHistByStudentFriday.set(sfKey, recordToInsert);
            const putReq = historyStore.put(recordToInsert);
            putReq.onerror = () => failTx(putReq.error, 'فشل استعادة سجل حضور تاريخي');
            stats.attendance_history.inserted++;
          }
        }

        // Optional hook for testing transaction rollback semantics atomically
        if (options?._beforeCommitHook) {
          options._beforeCommitHook();
        }
      } catch (err) {
        failTx(err, 'حدث خطأ أثناء تنفيذ الدمج الذري للنسخة الاحتياطية');
      }
    };

    sReq.onsuccess = () => {
      loadedStudents = sReq.result || [];
      tryExecuteMerge();
    };
    fReq.onsuccess = () => {
      loadedFollowup = fReq.result || [];
      tryExecuteMerge();
    };
    mReq.onsuccess = () => {
      loadedMutations = mReq.result || [];
      tryExecuteMerge();
    };
    hReq.onsuccess = () => {
      loadedHistory = hReq.result || [];
      tryExecuteMerge();
    };

    tx.oncomplete = () => {
      if (settled) return;
      idbInspectDatabaseSummary()
        .then((summary) => {
          settled = true;
          const verified =
            summary.counts.students >= beforeCounts.students &&
            summary.counts.followup >= beforeCounts.followup &&
            summary.counts.mutations >= beforeCounts.mutations &&
            summary.counts.attendance_history >= beforeCounts.attendance_history;

          resolve({
            beforeCounts,
            afterCounts: summary.counts,
            stats,
            verified
          });
        })
        .catch(safeReject);
    };
  });
}


