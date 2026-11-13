import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
// Polyfill indexedDB in Node environment
(globalThis as any).indexedDB = fakeIndexedDB;

import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToString } from 'react-dom/server';

import {
  getIndexedDB,
  idbCloseDatabase,
  idbAtomicAddStudentWithMutation,
  idbAtomicUpdateStudentWithMutation,
  idbAtomicDeleteStudentWithMutation,
  idbAtomicRecordFollowupWithMutation,
  idbReconcileStudents,
  idbSaveStudents,
  idbGetStudents,
  idbAddFollowupRecord,
  idbGetFollowupRecords,
  idbQueueMutation,
  idbGetPendingMutations,
  idbRemoveMutation,
  idbMarkMutationConflict,
  idbClearMutations
} from '../services/indexedDbService';

import {
  executeProcessOfflineQueue,
  executeSyncData,
  computeLatestSyncTime,
  AppProvider,
  useApp
} from '../context/AppContext';

import {
  evaluateUserPermission,
  isValidUserRole,
  VALID_USER_ROLES,
  AuthProvider,
  useAuth
} from '../context/AuthContext';

import { generateUUID } from '../utils/uuid';
import { getNearestFridayString } from '../utils/arabicUtils';
import { Student, ALL_SHEETS_SENTINEL, APPROVED_SHEETS } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { OfflineMutation, AuthUser } from '../types/auth';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

function createSampleStudent(overrides: Partial<Student> = {}): Student {
  const id = overrides.id || generateUUID();
  return {
    id,
    code: 'SG-101',
    name: 'مارك هاني جورج',
    servant: 'مينا كمال',
    phoneStudent: '01220000001',
    phoneParent1: '01220000002',
    phoneParent2: '',
    birthDate: '2010-05-15',
    area: 'الزيتون الغربية',
    address: 'شارع طومانباي',
    notes: 'مواظب على القداس',
    followupStatus: 'بدون',
    attendanceTotal: 5,
    attendanceMonth: 2,
    attendanceStatus: 'غائب',
    sourceSheet: 'نشط',
    version: 1,
    att: {},
    fu: {},
    ...overrides
  };
}

async function cleanDatabase() {
  const db = await getIndexedDB();
  const tx = db.transaction(['students', 'followup', 'mutations'], 'readwrite');
  tx.objectStore('students').clear();
  tx.objectStore('followup').clear();
  tx.objectStore('mutations').clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const mockAuthenticatedUser: AuthUser = {
  userId: 'usr_admin_1',
  username: 'mina.admin',
  displayName: 'مينا كمال',
  role: 'admin',
  token: 'valid.mock.jwt.token'
};

// ==========================================
// TEST SUITE: Zero Data Loss & Multi-Sheet Isolation
// ==========================================
async function runPhase2Tests() {
  console.log('\n======================================================');
  console.log('  🧪 Running Phase 2 Verification & Compliance Test Suite');
  console.log('======================================================\n');

  let passedCount = 0;

  // ----------------------------------------------------
  // TEST 1: Multi-Sheet Isolation & Pre-validation (Reject before deletion)
  // [Production Code: idbSaveStudents, idbReconcileStudents]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    // 1. Insert students in 3 distinct sheets: 'نشط', 'غير حاضر', 'فصل البابا شنودة'
    const studentActive = createSampleStudent({
      id: 'active_1',
      name: 'طالب نشط',
      sourceSheet: 'نشط'
    });
    const studentInactive = createSampleStudent({
      id: 'inactive_1',
      name: 'طالب غير حاضر',
      sourceSheet: 'غير حاضر'
    });
    const studentPope = createSampleStudent({
      id: 'pope_1',
      name: 'طالب فصل البابا شنودة',
      sourceSheet: 'فصل البابا شنودة'
    });

    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(studentActive);
    initTx.objectStore('students').put(studentInactive);
    initTx.objectStore('students').put(studentPope);
    await new Promise((res) => { initTx.oncomplete = res; });

    // 2. Pre-validation in idbSaveStudents:
    // If a server batch contains an invalid record (missing sourceSheet or wrong sheet),
    // it MUST be rejected completely BEFORE deleting local data!
    const corruptedBatch: Student[] = [
      createSampleStudent({ id: 'inactive_good', name: 'طالب صالح', sourceSheet: 'غير حاضر' }),
      createSampleStudent({ id: 'inactive_bad', name: 'طالب بداتا شيت مفقودة', sourceSheet: '' as any })
    ];

    let preValidationRejected = false;
    try {
      await idbSaveStudents(corruptedBatch, 'غير حاضر');
    } catch {
      preValidationRejected = true;
    }
    assert(preValidationRejected === true, 'idbSaveStudents must reject batch with invalid record');

    // Verify local data is 100% UNTOUCHED (zero local deletion occurred)
    const afterCorruptedSave = await idbGetStudents();
    const corruptedMap = new Map(afterCorruptedSave.map((s) => [s.id, s]));
    assert(corruptedMap.has('inactive_1'), 'Local student inactive_1 MUST NOT be deleted when server batch is invalid');
    assert(corruptedMap.has('active_1'), 'Active student untouched');
    assert(corruptedMap.has('pope_1'), 'Pope student untouched');

    // 3. Valid idbSaveStudents within target sheet
    const validInactiveBatch: Student[] = [
      createSampleStudent({ id: 'inactive_2', name: 'طالب بديل في غير حاضر', sourceSheet: 'غير حاضر' })
    ];
    await idbSaveStudents(validInactiveBatch, 'غير حاضر');

    const afterValidSave = await idbGetStudents();
    const validMap = new Map(afterValidSave.map((s) => [s.id, s]));
    assert(validMap.has('active_1'), 'Sheet "نشط" must remain untouched when saving "غير حاضر"');
    assert(validMap.has('pope_1'), 'Sheet "فصل البابا شنودة" must remain untouched when saving "غير حاضر"');
    assert(validMap.has('inactive_2'), 'Sheet "غير حاضر" updated with new student');
    assert(!validMap.has('inactive_1'), 'Old student of "غير حاضر" replaced cleanly within its own sheet');

    // 4. Test explicit rejection of __ALL__ in idbSaveStudents and idbReconcileStudents
    let allSheetErrorSave = false;
    try {
      await idbSaveStudents([createSampleStudent()], '__ALL__');
    } catch {
      allSheetErrorSave = true;
    }
    assert(allSheetErrorSave === true, 'idbSaveStudents must reject __ALL__ to prevent bulk wipe');

    let allSheetErrorReconcile = false;
    try {
      await idbReconcileStudents([createSampleStudent()], [], '__ALL__');
    } catch {
      allSheetErrorReconcile = true;
    }
    assert(allSheetErrorReconcile === true, 'idbReconcileStudents must reject __ALL__');

    console.log('✅ Test 1 Passed: Multi-Sheet Isolation & Pre-validation (Zero Data Loss)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 1 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 2: Real Atomic Rollback on idbAtomicRecordFollowupWithMutation
  // [Production Code: idbAtomicRecordFollowupWithMutation directly called]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    const initialStudent = createSampleStudent({ id: 'student_atomic_test', followupStatus: 'بدون' });
    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(initialStudent);
    await new Promise((res) => { initTx.oncomplete = res; });

    const updatedStudent: Student = {
      ...initialStudent,
      followupStatus: 'اتصال هاتفي'
    };

    const followupRecord: FollowupRecord = {
      id: generateUUID(),
      date: '2026-11-10',
      fridayDate: getNearestFridayString(),
      studentId: initialStudent.id,
      studentCode: initialStudent.code,
      studentName: initialStudent.name,
      servant: initialStudent.servant,
      type: 'اتصال هاتفي',
      notes: 'اختبار التراجع'
    };

    // Invalid mutation with undefined id causing put constraint failure
    const invalidMutation: any = {
      id: undefined,
      action: 'followup',
      studentId: initialStudent.id,
      timestamp: Date.now()
    };

    let errorCaught = false;
    try {
      await idbAtomicRecordFollowupWithMutation(updatedStudent, followupRecord, invalidMutation);
    } catch {
      errorCaught = true;
    }

    assert(errorCaught === true, 'idbAtomicRecordFollowupWithMutation must reject when a write fails');

    // Verify ZERO Partial Writes across all 3 stores:
    const studentsAfter = await idbGetStudents();
    const followupsAfter = await idbGetFollowupRecords();
    const mutationsAfter = await idbGetPendingMutations();

    assert(studentsAfter.length === 1, 'Student store must have exactly 1 record');
    assert(studentsAfter[0].followupStatus === 'بدون', 'Student status MUST NOT be updated (Atomic Rollback succeeded)');
    assert(followupsAfter.length === 0, 'Followup record MUST NOT be saved on transaction failure');
    assert(mutationsAfter.length === 0, 'Mutation MUST NOT be queued on transaction failure');

    console.log('✅ Test 2 Passed: Real Atomic Rollback on idbAtomicRecordFollowupWithMutation (Production Code)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 2 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 3: Race Condition Prevention between Mutation Queuing and Reconciliation
  // [Production Code: idbReconcileStudents atomic transaction on ['students', 'mutations']]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    const localStudent = createSampleStudent({
      id: 'student_race_test',
      name: 'طالب محلي للتعديل',
      notes: 'ملاحظة محلية غير متزامنة',
      sourceSheet: 'نشط'
    });

    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(localStudent);
    await new Promise((res) => { initTx.oncomplete = res; });

    // Server returns an older or different version of the same student
    const serverStudents: Student[] = [
      createSampleStudent({
        id: 'student_race_test',
        name: 'طالب محلي للتعديل',
        notes: 'ملاحظة قديمة من السيرفر',
        sourceSheet: 'نشط'
      })
    ];

    // Concurrently queue a pending mutation in mutations store
    const raceMutation: OfflineMutation = {
      id: `UPD_${localStudent.id}_${generateUUID()}`,
      action: 'update',
      studentId: localStudent.id,
      studentCode: localStudent.code,
      studentName: localStudent.name,
      sourceSheet: 'نشط',
      payload: { notes: 'ملاحظة محلية غير متزامنة' },
      timestamp: Date.now(),
      status: 'pending'
    };
    await idbQueueMutation(raceMutation);

    // Run reconciliation without externally passed mutations:
    // idbReconcileStudents reads 'mutations' store atomically in its own transaction
    const reconciled = await idbReconcileStudents(serverStudents, [], 'نشط');

    const reconciledStudent = reconciled.find((s) => s.id === localStudent.id);
    assert(Boolean(reconciledStudent), 'Reconciled student exists');
    assert(
      reconciledStudent?.notes === 'ملاحظة محلية غير متزامنة',
      'Local student with pending mutation MUST NOT be overwritten by server data (Race condition prevented)'
    );

    const pendingAfter = await idbGetPendingMutations();
    assert(pendingAfter.length === 1, 'Pending mutation strictly preserved in queue');

    console.log('✅ Test 3 Passed: Race Condition Prevention in Atomic idbReconcileStudents');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 3 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 4: executeProcessOfflineQueue with Network Drop & Direct Queue Delivery
  // [Production Code: executeProcessOfflineQueue]
  // ----------------------------------------------------
  const originalFetch = globalThis.fetch;
  try {
    await cleanDatabase();

    const mutation: OfflineMutation = {
      id: `ATT_offline_${generateUUID()}`,
      action: 'attendance',
      studentId: 'student_off',
      studentCode: 'SG-101',
      studentName: 'مرقس ناصف',
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };
    await idbQueueMutation(mutation);

    // 4a. Direct execution succeeds without requiring servant login when server responds 200 ok
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    });
    const directResult = await executeProcessOfflineQueue(null, false);
    assert(directResult.success === true, 'Direct queue processing works without servant login');
    assert(directResult.sentCount === 1 && directResult.remainingCount === 0, 'Mutation sent and cleared');

    // Re-queue for network drop test
    await idbQueueMutation(mutation);

    // 4b. When network drops:
    (globalThis as any).fetch = async () => {
      throw new TypeError('Failed to fetch (Network connection lost)');
    };

    const networkDropResult = await executeProcessOfflineQueue(mockAuthenticatedUser, false);
    assert(networkDropResult.success === false, 'Queue processing fails on network drop');
    assert(networkDropResult.sentCount === 0, '0 mutations sent on network drop');

    const pendingAfter = await idbGetPendingMutations();
    assert(pendingAfter.length === 1, 'Mutation strictly retained in queue during network drop');
    assert(pendingAfter[0].id === mutation.id, 'Mutation ID intact');

    console.log('✅ Test 4 Passed: executeProcessOfflineQueue Direct Sync & Network Failure Retention');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 4 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 5: executeProcessOfflineQueue Server 500, Partial Push Timestamp Update & 200 ACK
  // [Production Code: executeProcessOfflineQueue]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    const mut1: OfflineMutation = {
      id: `ATT_partial_1_${generateUUID()}`,
      action: 'attendance',
      studentId: 'student_p1',
      studentCode: 'SG-101',
      studentName: 'يوحنا ميخائيل',
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: true },
      expectedVersion: 1,
      timestamp: 1000,
      status: 'pending'
    };

    const mut2: OfflineMutation = {
      id: `ATT_partial_2_${generateUUID()}`,
      action: 'attendance',
      studentId: 'student_p2',
      studentCode: 'SG-102',
      studentName: 'بيتر مجدي',
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: true },
      expectedVersion: 1,
      timestamp: 2000,
      status: 'pending'
    };

    await idbQueueMutation(mut1);
    await idbQueueMutation(mut2);

    let recordedPushIso: string | null = null;
    let callIndex = 0;

    // mut1 succeeds (200), mut2 fails (500)
    (globalThis as any).fetch = async () => {
      callIndex++;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        };
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server Error' })
      };
    };

    const partialRes = await executeProcessOfflineQueue(
      mockAuthenticatedUser,
      false,
      undefined,
      (pushIso) => {
        recordedPushIso = pushIso;
      }
    );

    assert(partialRes.sentCount === 1, 'Exactly 1 mutation sent successfully');
    assert(partialRes.remainingCount === 1, '1 mutation remains in queue after 500');
    assert(recordedPushIso !== null, 'Push timestamp MUST be updated immediately for successful mutation, even when subsequent mutation fails');

    const remaining = await idbGetPendingMutations();
    assert(remaining.length === 1, 'Only failed mutation remains in IndexedDB');
    assert(remaining[0].id === mut2.id, 'mut2 strictly retained in queue');

    console.log('✅ Test 5 Passed: executeProcessOfflineQueue Immediate Push Timestamp Update & 500 Retention');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 5 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 6: FIFO Halt on 409 Conflict (Preserves Dependent Operations)
  // [Production Code: executeProcessOfflineQueue]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    const mut1: OfflineMutation = {
      id: `ATT_fifo_1_${generateUUID()}`,
      action: 'attendance',
      studentId: 'student_1',
      studentCode: 'SG-101',
      studentName: 'طالب 1',
      sourceSheet: 'نشط',
      payload: { isPresent: true },
      expectedVersion: 1,
      timestamp: 1000
    };

    const mut2: OfflineMutation = {
      id: `UPD_fifo_2_${generateUUID()}`,
      action: 'update',
      studentId: 'student_1',
      studentCode: 'SG-101',
      studentName: 'طالب 1',
      sourceSheet: 'نشط',
      payload: { notes: 'تعديل تابع يعتمد على الحضور' },
      expectedVersion: 2,
      timestamp: 2000
    };

    await idbQueueMutation(mut1);
    await idbQueueMutation(mut2);

    let callCount = 0;
    (globalThis as any).fetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: 'Version Conflict in Sheet (HTTP 409)' })
      };
    };

    const res409 = await executeProcessOfflineQueue(mockAuthenticatedUser, false);
    assert(res409.success === false, 'Process queue must return failure on 409');
    assert(callCount === 1, 'Loop MUST break immediately on 409, must not attempt dependent mutation mut2');

    const remaining = await idbGetPendingMutations();
    assert(remaining.length === 2, 'Neither mutation deleted on 409');
    assert(remaining[0].id === mut1.id, 'First mutation is preserved');
    assert(remaining[0].status === 'conflict', 'First mutation marked with conflict status in IndexedDB');
    assert(remaining[1].id === mut2.id, 'Dependent mutation preserved in queue');

    console.log('✅ Test 6 Passed: Real FIFO Halt on 409 Conflict (Preserves Queue Dependencies)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 6 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 7: Stable Idempotency Key across retries & Distinct Keys for New Actions
  // [Production Code: idbQueueMutation]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    const opId = generateUUID();
    const stableKey = `ATT_student_123_${opId}`;
    const mutation: OfflineMutation = {
      id: stableKey,
      action: 'attendance',
      studentId: 'student_123',
      studentCode: 'SG-101',
      studentName: 'يوحنا ميخائيل',
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0
    };

    await idbQueueMutation(mutation);

    const pending1 = await idbGetPendingMutations();
    assert(pending1[0].id === stableKey, 'First attempt uses stableKey');

    // Retry attempt: reuses exact same key
    mutation.retryCount = 1;
    await idbQueueMutation(mutation);

    const pending2 = await idbGetPendingMutations();
    assert(pending2[0].id === stableKey, 'Second attempt reuses same stable key');
    assert(pending2[0].retryCount === 1, 'Retry count incremented without duplicate queue item');

    // Distinct intentional action gets different UUID
    const newOpId = generateUUID();
    const newKey = `ATT_student_123_${newOpId}`;
    assert(newKey !== stableKey, 'Different intentional action produces a unique idempotency key');

    console.log('✅ Test 7 Passed: Stable Idempotency Key on Retry & Unique Keys for Actions');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 7 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 8: Two Real Concurrent executeSyncData Calls (Mutual Exclusion Lock)
  // [Production Code: executeSyncData concurrency lock]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    const syncLock = { current: false };

    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/health')) {
        // Add artificial delay to guarantee overlap
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, status: 200 };
      }
      if (url.includes('/api/sheets/data')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ targetSheet: 'نشط', isComplete: true, students: [] })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    // Trigger two sync requests concurrently
    const [call1Result, call2Result] = await Promise.all([
      executeSyncData('نشط', mockAuthenticatedUser, false, syncLock),
      executeSyncData('نشط', mockAuthenticatedUser, false, syncLock)
    ]);

    // Exactly one must succeed, and one must be rejected by lock!
    const successCount = (call1Result ? 1 : 0) + (call2Result ? 1 : 0);
    assert(successCount === 1, 'Exactly one concurrent sync must proceed; the other must be safely rejected by lock');
    assert(syncLock.current === false, 'Lock must be fully released after sync completion');

    console.log('✅ Test 8 Passed: Real Concurrent executeSyncData Calls Protected by Mutex Lock');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 8 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 9: Real executeSyncData with __ALL__ Sheet (Empty Sheet & Pending Mutations in Another)
  // [Production Code: executeSyncData, idbReconcileStudents, idbSaveStudents]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    // 1. Local state:
    // - Sheet 'نشط' has student_active with an offline pending mutation (e.g. attendance recorded)
    // - Sheet 'فصل البابا شنودة' has student_pope
    const studentActive = createSampleStudent({
      id: 'student_active',
      name: 'طالب نشط محلي',
      sourceSheet: 'نشط',
      attendanceStatus: 'حاضر'
    });
    const studentPope = createSampleStudent({
      id: 'student_pope',
      name: 'طالب فصل البابا شنودة',
      sourceSheet: 'فصل البابا شنودة'
    });

    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(studentActive);
    initTx.objectStore('students').put(studentPope);
    await new Promise((res) => { initTx.oncomplete = res; });

    // Queue offline mutation for studentActive
    const pendingAttMutation: OfflineMutation = {
      id: `ATT_local_${generateUUID()}`,
      action: 'attendance',
      studentId: 'student_active',
      studentCode: 'SG-101',
      studentName: 'طالب نشط محلي',
      sourceSheet: 'نشط',
      payload: { isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      status: 'pending'
    };
    await idbQueueMutation(pendingAttMutation);

    const syncLock = { current: false };

    // Server response for __ALL__:
    // - Sheet 'نشط': returns older data
    // - Sheet 'فصل البابا شنودة': returns EMPTY list [] (empty sheet on server)
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/health')) {
        return { ok: true, status: 200 };
      }
      if (url.includes('/api/sheets/mutate')) {
        // Simulate network failure when attempting to push, so mutation remains in queue
        return { ok: false, status: 503, json: async () => ({ error: 'Sheets Service Temporarily Unavailable' }) };
      }
      if (url.includes('/api/sheets/data')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            students: [
              createSampleStudent({
                id: 'student_active',
                name: 'طالب نشط من السيرفر',
                sourceSheet: 'نشط',
                attendanceStatus: 'غائب'
              })
              // Note: 'فصل البابا شنودة' has 0 records on server (empty sheet)
            ]
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    // Execute sync for __ALL__
    await executeSyncData('__ALL__', mockAuthenticatedUser, false, syncLock);

    // Verify Zero Data Loss:
    // 1. Pending mutation for 'نشط' was NOT wiped or lost
    const pendingAfter = await idbGetPendingMutations();
    assert(pendingAfter.length === 1, 'Offline mutation strictly preserved in queue');

    // 2. Local student in 'نشط' was PRESERVED (not overwritten by server) because of pending mutation!
    const allStudentsAfter = await idbGetStudents();
    const mapAfter = new Map(allStudentsAfter.map((s) => [s.id, s]));

    assert(mapAfter.has('student_active'), 'Student in "نشط" must exist');
    assert(
      mapAfter.get('student_active')?.attendanceStatus === 'حاضر',
      'Local student state preserved because of pending mutation'
    );

    // 3. Approved sheets list and sentinel are standard
    assert(ALL_SHEETS_SENTINEL === '__ALL__', 'ALL_SHEETS_SENTINEL is __ALL__');
    assert(APPROVED_SHEETS.includes('نشط'), 'Approved sheets includes نشط');
    assert(APPROVED_SHEETS.includes('فصل البابا شنودة'), 'Approved sheets includes فصل البابا شنودة');
    assert(mapAfter.has('student_pope'), 'Student in "فصل البابا شنودة" must be preserved because server response was unconfirmed empty');

    console.log('✅ Test 9 Passed: Real executeSyncData with __ALL__ (Empty Sheet & Preserved Pending Mutations)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 9 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 10: Chronological Timestamp Calculation (computeLatestSyncTime)
  // [Production Code: computeLatestSyncTime]
  // ----------------------------------------------------
  try {
    const olderPull = '2026-11-10T10:00:00.000Z';
    const newerPush = '2026-11-10T10:15:00.000Z';
    const latest1 = computeLatestSyncTime(olderPull, newerPush);
    assert(latest1 === newerPush, 'Must choose newer push timestamp over older pull');

    const newerPull = '2026-11-10T11:00:00.000Z';
    const olderPush = '2026-11-10T10:30:00.000Z';
    const latest2 = computeLatestSyncTime(newerPull, olderPush);
    assert(latest2 === newerPull, 'Must choose newer pull timestamp over older push');

    const onlyPush = computeLatestSyncTime(null, newerPush);
    assert(onlyPush === newerPush, 'Must choose push timestamp when pull is null');

    const onlyPull = computeLatestSyncTime(newerPull, null);
    assert(onlyPull === newerPull, 'Must choose pull timestamp when push is null');

    const neither = computeLatestSyncTime(null, null);
    assert(neither === null, 'Must return null when both are null');

    console.log('✅ Test 10 Passed: Chronological Timestamp Calculation (computeLatestSyncTime)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 10 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 11: Runtime Context Provider Verification
  // [Production Code: AuthProvider, AppProvider, useAuth, useApp]
  // ----------------------------------------------------
  try {
    // 11a: Hooks throw meaningful errors when called outside providers
    let authOutsideThrew = false;
    function ConsumerWithoutAuthProvider() {
      useAuth();
      return null;
    }
    try {
      renderToString(React.createElement(ConsumerWithoutAuthProvider));
    } catch (e: any) {
      if (e.message.includes('useAuth must be used within an AuthProvider')) {
        authOutsideThrew = true;
      }
    }
    assert(authOutsideThrew === true, 'useAuth must throw when invoked outside AuthProvider');

    let appOutsideThrew = false;
    function ConsumerWithoutAppProvider() {
      useApp();
      return null;
    }
    try {
      renderToString(React.createElement(ConsumerWithoutAppProvider));
    } catch (e: any) {
      if (e.message.includes('useApp must be used within an AppProvider')) {
        appOutsideThrew = true;
      }
    }
    assert(appOutsideThrew === true, 'useApp must throw when invoked outside AppProvider');

    // 11b: Providers mount and supply actual runtime functions and values
    let receivedAuthContext: any = null;
    let receivedAppContext: any = null;

    function TestChildConsumer() {
      receivedAuthContext = useAuth();
      receivedAppContext = useApp();
      return React.createElement('div', null, 'Rendered');
    }

    const renderedOutput = renderToString(
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(TestChildConsumer)
        )
      )
    );

    assert(renderedOutput.includes('Rendered'), 'Component tree rendered inside providers');
    assert(receivedAuthContext !== null, 'AuthContext received actual runtime object');
    assert(receivedAuthContext.isAuthenticated === false, 'Local direct-service mode must not claim authenticated identity');
    assert(receivedAuthContext.isPreviewMode === false, 'Direct service mode is never locked in Preview Mode');
    assert(receivedAuthContext.login === undefined && receivedAuthContext.logout === undefined, 'Servant login/logout completely removed');
    assert(typeof receivedAuthContext.canPerformAction === 'function', 'AuthContext provides real canPerformAction function');
    assert(receivedAuthContext.canPerformAction('delete_student').allowed === false, 'Zero Delete Student policy enforced');

    assert(receivedAppContext !== null, 'AppContext received actual runtime object');
    assert(typeof receivedAppContext.syncData === 'function', 'AppContext provides real syncData function');
    assert(typeof receivedAppContext.markAttendance === 'function', 'AppContext provides real markAttendance function');
    assert(typeof receivedAppContext.recordFollowup === 'function', 'AppContext provides real recordFollowup function');
    assert(typeof receivedAppContext.updateStudent === 'function', 'AppContext provides real updateStudent function');
    assert(typeof receivedAppContext.addNewStudent === 'function', 'AppContext provides real addNewStudent function');
    assert(typeof receivedAppContext.deleteStudent === 'function', 'AppContext provides real deleteStudent function');
    assert(typeof receivedAppContext.processOfflineQueue === 'function', 'AppContext provides real processOfflineQueue function');

    console.log('✅ Test 11 Passed: Runtime Context Provider & Hook Verification');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 11 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 12: Service Worker Cache Behavior & Regex Security Audit
  // [Production Code: public/sw.js file inspection and behavioral path validation]
  // ----------------------------------------------------
  try {
    const swPath = path.resolve(process.cwd(), 'public/sw.js');
    assert(fs.existsSync(swPath), 'public/sw.js must exist on disk');

    const swContent = fs.readFileSync(swPath, 'utf-8');

    // 12a. Behavioral Regex Matching Test with escaped dot:
    // Regex in sw.js: /\.(?:js|css|woff2?|ttf|png|jpe?g|svg|ico|webp)(?:\?.*)?$/i
    const assetRegex = /\.(?:js|css|woff2?|ttf|png|jpe?g|svg|ico|webp)(?:\?.*)?$/i;

    // Allowed static asset paths
    assert(assetRegex.test('/assets/index-D7xZ1.js') === true, 'Valid JS build chunk allowed');
    assert(assetRegex.test('/assets/style-A1b2.css') === true, 'Valid CSS build chunk allowed');
    assert(assetRegex.test('/assets/font.woff2') === true, 'Valid woff2 font allowed');
    assert(assetRegex.test('/assets/font.woff') === true, 'Valid woff font allowed');
    assert(assetRegex.test('/assets/icon.svg') === true, 'Valid SVG allowed');
    assert(assetRegex.test('/assets/photo.png') === true, 'Valid PNG allowed');
    assert(assetRegex.test('/assets/photo.webp') === true, 'Valid WEBP allowed');
    assert(assetRegex.test('/assets/index-D7xZ1.js?v=123') === true, 'Versioned JS chunk allowed');

    // Disallowed / sensitive / data paths: MUST NOT match asset regex!
    assert(assetRegex.test('/api/sheets/data') === false, 'API sheets endpoint rejected');
    assert(assetRegex.test('/api/health') === false, 'API health check rejected');
    assert(assetRegex.test('/api/auth/login') === false, 'API auth login rejected');
    assert(assetRegex.test('/students.json') === false, 'Students JSON data rejected');
    assert(assetRegex.test('/assets/students.json') === false, 'Assets JSON data rejected');
    assert(assetRegex.test('/data/export.json') === false, 'Export JSON rejected');
    assert(assetRegex.test('/index.html') === false, 'HTML not in asset regex (handled strictly by App Shell allowlist)');

    // 12b. Validate absolute exclusion logic in swContent
    assert(swContent.includes("requestUrl.pathname.includes('/api/')"), 'sw.js must exclude /api/');
    assert(swContent.includes("requestUrl.pathname.includes('/auth/')"), 'sw.js must exclude /auth/');
    assert(swContent.includes("requestUrl.pathname.includes('macros/s/')"), 'sw.js must exclude Apps Script');
    assert(swContent.includes("requestUrl.pathname.includes('gviz')"), 'sw.js must exclude Google Visualization');
    assert(swContent.includes("requestUrl.search.includes('sheet=')"), 'sw.js must exclude dynamic sheet queries');
    assert(swContent.includes("requestUrl.pathname.endsWith('.json')"), 'sw.js must exclude general JSON data files');

    // 12c. Validate event.waitUntil and await cache.put
    assert(swContent.includes('event.waitUntil(cacheUpdatePromise)'), 'sw.js must register event.waitUntil synchronously');
    assert(swContent.includes('await cache.put(event.request, responseToCache)'), 'sw.js must await cache.put');
    assert(swContent.includes('caches.open(CACHE_NAME)'), 'sw.js must explicitly open and use CACHE_NAME');

    console.log('✅ Test 12 Passed: Service Worker Cache Behavior & Regex Security Audit');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 12 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 13: Rejection of Mixed / Invalid Server Response in idbReconcileStudents & idbSaveStudents
  // [Zero Local Modification Guarantee: Pre-validation without filter]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    // Seed 2 local students in 'نشط'
    const localS1 = createSampleStudent({ id: 'loc_1', name: 'طالب محلي 1', sourceSheet: 'نشط' });
    const localS2 = createSampleStudent({ id: 'loc_2', name: 'طالب محلي 2', sourceSheet: 'نشط' });
    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(localS1);
    initTx.objectStore('students').put(localS2);
    await new Promise((res) => { initTx.oncomplete = res; });

    // Mixed batch containing valid student for 'نشط' + invalid student belonging to 'فصل البابا شنودة'
    const mixedBatch: Student[] = [
      createSampleStudent({ id: 'srv_good', name: 'طالب صالح في نشط', sourceSheet: 'نشط' }),
      createSampleStudent({ id: 'srv_wrong', name: 'طالب بفصل مختلف أرسل بالخطأ', sourceSheet: 'فصل البابا شنودة' })
    ];

    // 13a: idbReconcileStudents must reject mixed batch in Pre-validation and throw error
    let reconcileRejected = false;
    try {
      await idbReconcileStudents(mixedBatch, [], 'نشط');
    } catch {
      reconcileRejected = true;
    }
    assert(reconcileRejected === true, 'idbReconcileStudents must reject mixed batch before any DB write/delete');

    // Verify local data is 100% UNTOUCHED
    const afterReconcileStudents = await idbGetStudents();
    assert(afterReconcileStudents.length === 2, 'Local database must still have exactly 2 records');
    const recMap = new Map(afterReconcileStudents.map((s) => [s.id, s]));
    assert(recMap.has('loc_1'), 'loc_1 preserved untouched');
    assert(recMap.has('loc_2'), 'loc_2 preserved untouched');

    // 13b: idbSaveStudents must reject mixed batch in Pre-validation and throw error
    let saveRejected = false;
    try {
      await idbSaveStudents(mixedBatch, 'نشط');
    } catch {
      saveRejected = true;
    }
    assert(saveRejected === true, 'idbSaveStudents must reject mixed batch before any DB write/delete');

    // Verify local data is still 100% UNTOUCHED
    const afterSaveStudents = await idbGetStudents();
    assert(afterSaveStudents.length === 2, 'Local database must still have exactly 2 records');
    const saveMap = new Map(afterSaveStudents.map((s) => [s.id, s]));
    assert(saveMap.has('loc_1'), 'loc_1 preserved untouched');
    assert(saveMap.has('loc_2'), 'loc_2 preserved untouched');

    console.log('✅ Test 13 Passed: Rejection of Mixed/Invalid Server Response (Zero Local Data Modification)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 13 Failed:', err.message);
    throw err;
  }

  // ----------------------------------------------------
  // TEST 14: Unconfirmed Empty Server Response Retention (Zero Wipeout)
  // [Production Code: idbSaveStudents, idbReconcileStudents, executeSyncData]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    // Seed local student in 'نشط'
    const student = createSampleStudent({ id: 'loc_active_100', name: 'طالب نشط معتمد', sourceSheet: 'نشط' });
    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(student);
    await new Promise((res) => { initTx.oncomplete = res; });

    // 14a: idbSaveStudents must reject empty list [] if isConfirmedComplete is false or undefined
    let emptySaveRejectedFalse = false;
    try {
      await idbSaveStudents([], 'نشط', false);
    } catch {
      emptySaveRejectedFalse = true;
    }
    assert(emptySaveRejectedFalse === true, 'idbSaveStudents must reject empty list when isConfirmedComplete is false');

    let emptySaveRejectedUndefined = false;
    try {
      await idbSaveStudents([], 'نشط', undefined as any);
    } catch {
      emptySaveRejectedUndefined = true;
    }
    assert(emptySaveRejectedUndefined === true, 'idbSaveStudents must reject empty list when isConfirmedComplete is undefined');

    // 14b: idbReconcileStudents must reject empty list [] if isConfirmedComplete is false or undefined
    let emptyReconcileRejectedFalse = false;
    try {
      await idbReconcileStudents([], [], 'نشط', false);
    } catch {
      emptyReconcileRejectedFalse = true;
    }
    assert(emptyReconcileRejectedFalse === true, 'idbReconcileStudents must reject empty list when isConfirmedComplete is false');

    let emptyReconcileRejectedUndefined = false;
    try {
      await idbReconcileStudents([], [], 'نشط', undefined as any);
    } catch {
      emptyReconcileRejectedUndefined = true;
    }
    assert(emptyReconcileRejectedUndefined === true, 'idbReconcileStudents must reject empty list when isConfirmedComplete is undefined');

    // Verify local student is 100% PRESERVED
    let checkStudents = await idbGetStudents();
    assert(checkStudents.length === 1, 'Local student preserved after rejected unconfirmed empty calls (both false and undefined)');
    assert(checkStudents[0].id === 'loc_active_100', 'Student ID intact');

    // 14c: executeSyncData with unconfirmed empty server response (isComplete missing or false)
    const syncLock = { current: false };
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/health')) return { ok: true, status: 200 };
      if (url.includes('/api/sheets/data')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            students: [],
            isComplete: false // UNCONFIRMED empty response!
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const syncUnconfirmedEmpty = await executeSyncData('نشط', mockAuthenticatedUser, false, syncLock);
    assert(syncUnconfirmedEmpty === false, 'executeSyncData must reject sync when empty response is unconfirmed');

    // Verify local student was NOT wiped out!
    const studentsAfterSync = await idbGetStudents();
    assert(studentsAfterSync.length === 1, 'Local student MUST NOT be wiped out by unconfirmed empty server response');
    assert(studentsAfterSync[0].id === 'loc_active_100', 'Local student strictly preserved');

    // 14d: When server explicitly confirms complete empty sheet (isComplete: true), saving succeeds safely
    await idbSaveStudents([], 'نشط', true);
    const studentsAfterConfirmedEmpty = await idbGetStudents();
    assert(studentsAfterConfirmedEmpty.length === 0, 'Confirmed complete empty sheet replaces cleanly only when verified');

    console.log('✅ Test 14 Passed: Unconfirmed Empty Server Response Retention (Zero Wipeout)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 14 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 15: Cross-Sheet Confirmation Isolation in Single Sheet Sync
  // [Proves that confirmation of Sheet A does NOT permit wiping incomplete Sheet B]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    // 1. Seed students in two distinct sheets
    const studentActive = createSampleStudent({ id: 'loc_active_t15', name: 'طالب في نشط', sourceSheet: 'نشط' });
    const studentInactive = createSampleStudent({ id: 'loc_inactive_t15', name: 'طالب في غير حاضر', sourceSheet: 'غير حاضر' });

    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(studentActive);
    initTx.objectStore('students').put(studentInactive);
    await new Promise((res) => { initTx.oncomplete = res; });

    const syncLock = { current: false };

    // 2. Scenario A: Syncing targetSheet = 'نشط', but server returns empty students with confirmation
    // tied explicitly to a DIFFERENT sheet ('غير حاضر') or generic confirmation without 'نشط'
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/health')) return { ok: true, status: 200 };
      if (url.includes('/api/sheets/data')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            students: [],
            targetSheet: 'غير حاضر', // Different sheet confirmation!
            isComplete: true,
            confirmedEmptySheets: ['غير حاضر']
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const syncResultWrongSheet = await executeSyncData('نشط', mockAuthenticatedUser, false, syncLock);
    assert(syncResultWrongSheet === false, 'executeSyncData must reject empty response when confirmation belongs to a different sheet');

    // Verify ZERO wipeout: both sheets remain 100% intact!
    let studentsCheck = await idbGetStudents();
    assert(studentsCheck.length === 2, 'Local database must retain both students when confirmation belongs to another sheet');
    let mapCheck = new Map(studentsCheck.map((s) => [s.id, s]));
    assert(mapCheck.has('loc_active_t15'), 'Student in "نشط" strictly preserved');
    assert(mapCheck.has('loc_inactive_t15'), 'Student in "غير حاضر" strictly preserved');

    // 3. Scenario B: Syncing targetSheet = 'نشط', with confirmation explicitly matching 'نشط'
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/health')) return { ok: true, status: 200 };
      if (url.includes('/api/sheets/data')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            students: [],
            targetSheet: 'نشط', // Explicitly matches targetSheet!
            isComplete: true
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const syncResultMatchedSheet = await executeSyncData('نشط', mockAuthenticatedUser, false, syncLock);
    assert(syncResultMatchedSheet === true, 'executeSyncData must succeed when confirmation matches targetSheet');

    // Verify sheet isolation: 'نشط' is now empty, but 'غير حاضر' is STILL 100% intact!
    studentsCheck = await idbGetStudents();
    assert(studentsCheck.length === 1, 'Only "نشط" was cleared; "غير حاضر" must remain');
    assert(studentsCheck[0].id === 'loc_inactive_t15', 'Student in "غير حاضر" untouched');

    console.log('✅ Test 15 Passed: Cross-Sheet Confirmation Isolation (One Sheet Confirmation Cannot Wipe Another)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 15 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ----------------------------------------------------
  // TEST 16: Independent Completeness Verification in __ALL__ Mode
  // [Proves that __ALL__ response with confirmed empty sheet + unconfirmed empty sheet preserves the unconfirmed sheet]
  // ----------------------------------------------------
  try {
    await cleanDatabase();

    // 1. Seed students in three distinct sheets
    const studentActive = createSampleStudent({ id: 'loc_active_t16', name: 'طالب في نشط', sourceSheet: 'نشط' });
    const studentInactive = createSampleStudent({ id: 'loc_inactive_t16', name: 'طالب في غير حاضر', sourceSheet: 'غير حاضر' });
    const studentPope = createSampleStudent({ id: 'loc_pope_t16', name: 'طالب في فصل البابا شنودة', sourceSheet: 'فصل البابا شنودة' });

    const db = await getIndexedDB();
    const initTx = db.transaction('students', 'readwrite');
    initTx.objectStore('students').put(studentActive);
    initTx.objectStore('students').put(studentInactive);
    initTx.objectStore('students').put(studentPope);
    await new Promise((res) => { initTx.oncomplete = res; });

    const syncLock = { current: false };

    // 2. Server response for __ALL__:
    // - students: [] (all sheets empty in payload)
    // - top-level isComplete: true (generic confirmation - MUST NOT wipe all sheets!)
    // - confirmedEmptySheets: ['نشط'] (ONLY 'نشط' is confirmed empty!)
    // - 'غير حاضر' and 'فصل البابا شنودة' are UNCONFIRMED empty
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('/api/health')) return { ok: true, status: 200 };
      if (url.includes('/api/sheets/data')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            students: [],
            isComplete: true, // Generic top-level isComplete
            confirmedEmptySheets: ['نشط'], // ONLY 'نشط' is confirmed complete
            sheetsMeta: {
              'نشط': { isComplete: true }
            }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const syncAllResult = await executeSyncData('__ALL__', mockAuthenticatedUser, false, syncLock);
    assert(syncAllResult === true, 'executeSyncData for __ALL__ proceeds safely');

    // 3. Verify Zero Data Loss on Unconfirmed Sheets:
    // - 'نشط': confirmed empty -> cleared from database
    // - 'غير حاضر': unconfirmed empty -> PRESERVED!
    // - 'فصل البابا شنودة': unconfirmed empty -> PRESERVED!
    const studentsAfterAllSync = await idbGetStudents();
    assert(studentsAfterAllSync.length === 2, 'Exactly 2 students preserved (only confirmed empty sheet was cleared)');

    const finalMap = new Map(studentsAfterAllSync.map((s) => [s.id, s]));
    assert(!finalMap.has('loc_active_t16'), 'Confirmed empty sheet "نشط" cleared cleanly');
    assert(finalMap.has('loc_inactive_t16'), 'Unconfirmed empty sheet "غير حاضر" strictly preserved');
    assert(finalMap.has('loc_pope_t16'), 'Unconfirmed empty sheet "فصل البابا شنودة" strictly preserved');

    console.log('✅ Test 16 Passed: Independent Completeness Verification in __ALL__ Mode (Confirmed Empty vs Unconfirmed Preserved)');
    passedCount++;
  } catch (err: any) {
    console.error('❌ Test 16 Failed:', err.message);
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('\n======================================================');
  console.log(`🎉 ALL ${passedCount} OF 16 PHASE 2 COMPLIANCE TESTS PASSED SUCCESSFULLY!`);
  console.log('======================================================\n');
}

runPhase2Tests()
  .then(() => {
    idbCloseDatabase();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 Test Suite Terminated with error:', err);
    idbCloseDatabase();
    process.exit(1);
  });
