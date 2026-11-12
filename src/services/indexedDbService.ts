import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { OfflineMutation } from '../types/auth';

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
        // Replace any superseded pending attendance mutation for the same (studentId, fridayDate)
        for (const m of existingMutations) {
          if (
            m.action === 'attendance' &&
            m.status === 'pending' &&
            m.studentId === historyRecord.studentId &&
            m.payload?.friday === historyRecord.fridayDate
          ) {
            mutationStore.delete(m.id);
          }
        }

        const studentReq = studentStore.put(updatedStudent);
        studentReq.onerror = () => tx.abort();

        const historyReq = historyStore.put({
          ...historyRecord,
          id: `${historyRecord.studentId}__${historyRecord.fridayDate}`
        });
        historyReq.onerror = () => tx.abort();

        const mutReq = mutationStore.put(mutation);
        mutReq.onerror = () => tx.abort();
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

// 5. Reconciliation Engine with Strict Multi-Sheet Isolation
// Scoped to targetSheet: NEVER deletes or modifies students belonging to other sheets!
// Atomic across BOTH 'students' and 'mutations' stores to prevent Race Conditions.
// Pre-validates ALL server records before any write/delete; rejects whole batch on invalid record.
export async function idbReconcileStudents(
  serverStudents: Student[],
  pendingMutations: OfflineMutation[] = [],
  targetSheet: string,
  isConfirmedComplete: boolean = false
): Promise<Student[]> {
  if (!targetSheet || !targetSheet.trim() || targetSheet === '__ALL__') {
    throw new Error('لا يمكن استدعاء idbReconcileStudents بالفصل المحجوز __ALL__؛ يجب تسوية كل فصل باسمه الحقيقي لمنع مسح الفصول الأخرى');
  }

  // Pre-validation: Verify ALL server records BEFORE any database interaction.
  // Zero toleration: Reject the entire operation if any record is invalid, lacks sourceSheet, or belongs to another sheet.
  for (const s of serverStudents) {
    if (!s || !s.id || !s.sourceSheet || s.sourceSheet !== targetSheet) {
      throw new Error(
        `تم رفض عملية التسوية بالكامل: وُجد سجل غير صالح أو بدون sourceSheet أو تابع لفصل مختلف (${s?.sourceSheet || 'غير محدد'}) بدلاً من الفصل المستهدف (${targetSheet}). لم يتم تعديل أو حذف أي بيانات محلية.`
      );
    }
  }

  // Completeness check for empty server response:
  // Strictly requires isConfirmedComplete === true; rejects false, undefined, or any other value
  if (serverStudents.length === 0 && isConfirmedComplete !== true) {
    throw new Error(
      `لا يمكن تسوية فصل (${targetSheet}) بقائمة سيرفر فارغة ما لم تكن مؤكدة الاكتمال صراحة (isConfirmedComplete === true). تم الاحتفاظ بكافة البيانات المحلية.`
    );
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

    // Single atomic transaction across BOTH stores to eliminate race conditions
    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
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
        // Merge with any externally supplied mutations to ensure 100% coverage
        const allPendingMutations = [...liveMutations, ...(pendingMutations || [])];

        // 1. Separate students into target sheet vs other sheets
        const targetLocalMap = new Map<string, Student>();
        for (const s of allLocalStudents) {
          if (s.sourceSheet === targetSheet) {
            targetLocalMap.set(s.id, s);
          }
        }

        // Collect all student IDs that have pending mutations in the queue
        const pendingStudentIds = new Set<string>();
        for (const m of allPendingMutations) {
          if (m.studentId) {
            if (!m.sourceSheet || m.sourceSheet === targetSheet || targetLocalMap.has(m.studentId)) {
              pendingStudentIds.add(m.studentId);
            }
          }
        }

        // Form serverIdSet strictly from pre-validated server records (NO filter used)
        const serverIdSet = new Set(serverStudents.map((s) => s.id));

        const reconciledMap = new Map<string, Student>();

        // 2. Reconcile pre-validated server students
        for (const serverStudent of serverStudents) {
          if (pendingStudentIds.has(serverStudent.id)) {
            // Local modifications pending: PRESERVE local state!
            const localRecord = targetLocalMap.get(serverStudent.id);
            if (localRecord) {
              reconciledMap.set(localRecord.id, localRecord);
            } else {
              reconciledMap.set(serverStudent.id, serverStudent);
            }
          } else {
            // No local pending edits: accept server version
            reconciledMap.set(serverStudent.id, serverStudent);
          }
        }

        // 3. Preserve any local students created offline in target sheet (e.g. pending add)
        for (const [id, localStudent] of targetLocalMap.entries()) {
          if (pendingStudentIds.has(id) && !reconciledMap.has(id)) {
            reconciledMap.set(id, localStudent);
          }
        }

        // 4. Delete ONLY students in target sheet that do NOT exist on server AND have NO pending mutations
        // Students of OTHER sheets are NEVER touched or deleted!
        for (const [localId] of targetLocalMap.entries()) {
          if (!serverIdSet.has(localId) && !pendingStudentIds.has(localId)) {
            const delReq = studentStore.delete(localId);
            delReq.onerror = () => tx.abort();
          }
        }

        // 5. Upsert reconciled students for target sheet
        for (const student of reconciledMap.values()) {
          const putReq = studentStore.put(student);
          putReq.onerror = () => tx.abort();
        }
      };
    };

    tx.oncomplete = () => {
      idbGetStudents().then(resolve).catch(safeReject);
    };

    tx.onerror = () => safeReject(tx.error || new Error('فشلت معاملة تسوية بيانات المخدومين'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء معاملة تسوية بيانات المخدومين'));
  });
}

// 6. Safe Save Students with Strict Multi-Sheet Isolation
// Mandatory targetSheet: only that sheet is updated; other sheets are strictly preserved!
// Checks ALL server records BEFORE performing any deletion: rejects whole batch if any record is invalid or from another sheet.
// Rejects empty students list unless isConfirmedComplete is true.
export async function idbSaveStudents(
  students: Student[],
  targetSheet: string,
  isConfirmedComplete: boolean = false
): Promise<void> {
  if (!targetSheet || !targetSheet.trim() || targetSheet === '__ALL__') {
    throw new Error('لا يمكن استدعاء idbSaveStudents بالفصل المحجوز __ALL__؛ يجب تحديد اسم فصل حقيقي لعزل البيانات ومنع المسح غير المقصود');
  }

  // Pre-verification: Verify ALL server records BEFORE opening/mutating database
  for (const s of students) {
    if (!s || !s.id || !s.sourceSheet || s.sourceSheet !== targetSheet) {
      throw new Error(
        `تم رفض حفظ البيانات بالكامل: وُجد سجل غير صالح أو بدون sourceSheet أو تابع لفصل مختلف (${s?.sourceSheet || 'غير محدد'}) عن الفصل المستهدف (${targetSheet}). لم يتم حذف أو تعديل أي بيانات محلية.`
      );
    }
  }

  // Completeness check for empty server response:
  // Strictly requires isConfirmedComplete === true; rejects false, undefined, or any other value
  if (students.length === 0 && isConfirmedComplete !== true) {
    throw new Error(
      `لا يمكن استبدال بيانات فصل (${targetSheet}) بقائمة فارغة ما لم تكن مؤكدة الاكتمال صراحة (isConfirmedComplete === true). تم الاحتفاظ بكافة البيانات المحلية لمنع الحذف غير المقصود.`
    );
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

    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    const studentStore = tx.objectStore('students');
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
          // Missing sourceSheet: conservative conflict! Must block overwrite to prevent zero data loss
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

        // Delete ONLY existing students of the target sheet
        // Students of other sheets are NEVER cleared or deleted!
        for (const s of localStudents) {
          if (s.sourceSheet === targetSheet) {
            const delReq = studentStore.delete(s.id);
            delReq.onerror = () => tx.abort();
          }
        }

        // Put incoming verified students for this specific sheet
        for (const student of students) {
          const putReq = studentStore.put(student);
          putReq.onerror = () => tx.abort();
        }
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

// Reconcile remote Google Sheet سجل الافتقاد rows while preserving locally pending followup entries
export async function idbSaveRemoteFollowupRecords(remoteRecords: FollowupRecord[]): Promise<FollowupRecord[]> {
  if (!Array.isArray(remoteRecords) || remoteRecords.length === 0) {
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

    const getMutReq = mutStore.getAll();
    getMutReq.onerror = () => tx.abort();
    getMutReq.onsuccess = () => {
      const pending: OfflineMutation[] = getMutReq.result || [];
      const pendingRecordIds = new Set<string>(
        pending
          .filter((m) => m.action === 'followup' && m.payload?.recordId)
          .map((m) => String(m.payload.recordId))
      );

      const getExistingReq = fuStore.getAll();
      getExistingReq.onerror = () => tx.abort();
      getExistingReq.onsuccess = () => {
        const existing: FollowupRecord[] = getExistingReq.result || [];
        for (const rec of existing) {
          if (!pendingRecordIds.has(rec.id)) {
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
    tx.onerror = () => safeReject(tx.error || new Error(`فشل حذف العملية المعلقة: ${id}`));
    tx.onabort = () => safeReject(tx.error || new Error(`تم إلغاء حذف العملية: ${id}`));

    const delReq = store.delete(id);
    delReq.onerror = () => tx.abort();
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
      mutation.lastError = errorMessage;
      const putReq = store.put(mutation);
      putReq.onerror = () => tx.abort();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => safeReject(tx.error || new Error(`فشلت معاملة تمييز التعارض للعملية: ${id}`));
    tx.onabort = () => safeReject(tx.error || new Error(`تم إلغاء معاملة تمييز التعارض للعملية: ${id}`));
  });
}

export async function idbClearMutations(): Promise<void> {
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
    tx.onerror = () => safeReject(tx.error || new Error('فشل تفريغ طابور العمليات'));
    tx.onabort = () => safeReject(tx.error || new Error('تم إلغاء تفريغ طابور العمليات'));

    const clearReq = store.clear();
    clearReq.onerror = () => tx.abort();
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

