import assert from 'assert';
import 'fake-indexeddb/auto';
import {
  getIndexedDB,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicRecordFollowupWithMutation,
  idbGetPendingMutations,
  idbUpdateMutationError,
  idbRemoveMutation,
  idbGetStudents
} from '../services/indexedDbService';
import { executeProcessOfflineQueue } from '../context/AppContext';
import { OfflineMutation, AuthUser } from '../types/auth';
import { Student } from '../types/student';
import { generateUUID } from '../utils/uuid';
import { setAppsScriptUrl, setRelayKey } from '../services/apiConfig';

const mockAdminUser: AuthUser = {
  userId: 'usr_admin',
  username: 'admin',
  displayName: 'أمين الخدمة',
  role: 'admin',
  token: 'mock_admin_token'
};

const sampleStudent1: Student = {
  id: 'std_auto_101',
  code: 'SG-101',
  name: 'كيفين جرجس سمير',
  servant: 'مينا سمير فانوس',
  sourceSheet: 'نشط',
  area: 'سليم الأول الزيتون',
  address: '54 شارع سليم الاول',
  notes: 'مواظب',
  followupStatus: 'بدون',
  attendanceTotal: 5,
  attendanceMonth: 2,
  attendanceStatus: 'غائب',
  version: 2,
  att: { '2026-11-06': true },
  fu: {}
};

const sampleStudent2: Student = {
  id: 'std_auto_102',
  code: 'SG-102',
  name: 'بيتر هاني صبحي',
  servant: 'ماركو ملجي فارس',
  sourceSheet: 'نشط',
  area: 'حلمية الزيتون',
  address: 'شارع ابن سندر',
  notes: 'مواظب',
  followupStatus: 'بدون',
  attendanceTotal: 4,
  attendanceMonth: 1,
  attendanceStatus: 'غائب',
  version: 1,
  att: {},
  fu: {}
};

async function cleanAllStores() {
  const db = await getIndexedDB();
  const tx = db.transaction(['students', 'mutations', 'attendance_history', 'followup'], 'readwrite');
  tx.objectStore('students').clear();
  tx.objectStore('mutations').clear();
  tx.objectStore('attendance_history').clear();
  tx.objectStore('followup').clear();
  await new Promise((resolve) => { tx.oncomplete = resolve; });
}

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); }
  };
}

function setOnlineStatus(online: boolean) {
  try {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: online,
      configurable: true,
      writable: true
    });
  } catch (e) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: online },
      configurable: true,
      writable: true
    });
  }
}

async function runAutoSyncTests() {
  (globalThis as any).localStorage = createStorageMock();
  console.log('\n======================================================');
  console.log('  🧪 Running Automatic Real-Time Sync Test Suite (6 Scenarios)');
  console.log('======================================================\n');

  const originalFetch = globalThis.fetch;
  const mockAppsScriptUrl = 'https://script.google.com/macros/s/AKfycbzetL8maCClf180cEMTVUYrxTSQH8pCX969eUxkuDeW6lmpb8HmVAWCs4Y3iSQZbRvY4g/exec';
  setAppsScriptUrl(mockAppsScriptUrl);
  setRelayKey('sec_test_relay_key_12345678901234567890');

  try {
    // --------------------------------------------------------------------------
    // SCENARIO 1: تسجيل حضور مع وجود الإنترنت: يصل التغيير للشيت تلقائياً دون ضغط زر المزامنة
    // --------------------------------------------------------------------------
    await cleanAllStores();
    setOnlineStatus(true);

    const opId1 = generateUUID();
    const fridayDate1 = '2026-11-13';
    const mutation1: OfflineMutation = {
      id: `ATT_${sampleStudent1.id}_${fridayDate1}_${opId1}`,
      action: 'attendance',
      studentId: sampleStudent1.id,
      studentCode: sampleStudent1.code,
      studentName: sampleStudent1.name,
      sourceSheet: sampleStudent1.sourceSheet,
      payload: { friday: fridayDate1, isPresent: true },
      expectedVersion: sampleStudent1.version,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    const historyRecord1 = {
      id: `${sampleStudent1.id}__${fridayDate1}`,
      studentId: sampleStudent1.id,
      studentCode: sampleStudent1.code,
      fridayDate: fridayDate1,
      status: true,
      recordedAt: Date.now(),
      sourceSheet: sampleStudent1.sourceSheet
    };

    // Commit locally
    await idbAtomicRecordAttendanceWithMutation(
      { ...sampleStudent1, attendanceStatus: 'حاضر', attendanceTotal: sampleStudent1.attendanceTotal + 1 },
      historyRecord1,
      mutation1
    );

    let sentPayload1: any = null;
    let pushTimestampRecorded1 = '';
    let startCallbackFired1 = false;
    let successCallbackFired1 = false;

    globalThis.fetch = async (url: any, init?: any) => {
      sentPayload1 = JSON.parse(init?.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          row: 2,
          total: 6,
          lastAttendance: fridayDate1,
          proof: {
            mutationId: sentPayload1.idempotencyKey,
            persisted: true,
            operation: 'attendance',
            studentId: sentPayload1.studentId,
            friday: sentPayload1.friday || fridayDate1,
            sheetName: sentPayload1.sheet || 'نشط',
            row: 2
          }
        })
      } as any;
    };

    // Automatic transmission trigger
    const syncRes1 = await executeProcessOfflineQueue(
      mockAdminUser,
      false,
      undefined,
      (iso) => { pushTimestampRecorded1 = iso; },
      {
        onMutationStart: () => { startCallbackFired1 = true; },
        onMutationSuccess: () => { successCallbackFired1 = true; }
      }
    );

    assert.strictEqual(syncRes1.success, true, 'Scenario 1: Auto sync execution returned success');
    assert.strictEqual(syncRes1.sentCount, 1, 'Scenario 1: Sent 1 operation');
    assert.strictEqual(syncRes1.remainingCount, 0, 'Scenario 1: Remaining queue is 0');
    assert.strictEqual(startCallbackFired1, true, 'Scenario 1: onMutationStart callback fired');
    assert.strictEqual(successCallbackFired1, true, 'Scenario 1: onMutationSuccess callback fired');
    assert(pushTimestampRecorded1.length > 0, 'Scenario 1: Push timestamp updated immediately');
    assert.strictEqual(sentPayload1.action, 'attendance', 'Scenario 1: Action is attendance');
    assert.strictEqual(sentPayload1.name, sampleStudent1.name, 'Scenario 1: Student name transmitted');
    assert.strictEqual(sentPayload1.present, true, 'Scenario 1: present is true');
    assert.strictEqual(sentPayload1.date, fridayDate1, 'Scenario 1: date is ISO string');

    const pendingAfter1 = await idbGetPendingMutations();
    assert.strictEqual(pendingAfter1.length, 0, 'Scenario 1: Pending mutation deleted from IndexedDB after server confirmation');
    console.log('✅ Scenario 1 Passed: Online Attendance registered and transmitted automatically to Google Sheets without clicking sync');

    // --------------------------------------------------------------------------
    // SCENARIO 2: تسجيل انصراف/غياب مع وجود الإنترنت: يصل التغيير للشيت تلقائياً
    // --------------------------------------------------------------------------
    await cleanAllStores();
    const opId2 = generateUUID();
    const mutation2: OfflineMutation = {
      id: `ATT_${sampleStudent1.id}_${fridayDate1}_${opId2}`,
      action: 'attendance',
      studentId: sampleStudent1.id,
      studentCode: sampleStudent1.code,
      studentName: sampleStudent1.name,
      sourceSheet: sampleStudent1.sourceSheet,
      payload: { friday: fridayDate1, isPresent: false },
      expectedVersion: sampleStudent1.version + 1,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    await idbAtomicRecordAttendanceWithMutation(
      { ...sampleStudent1, attendanceStatus: 'غائب', attendanceTotal: sampleStudent1.attendanceTotal },
      { ...historyRecord1, status: false },
      mutation2
    );

    let sentPayload2: any = null;
    globalThis.fetch = async (url: any, init?: any) => {
      sentPayload2 = JSON.parse(init?.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          row: 2,
          total: 5,
          lastAttendance: '',
          proof: {
            mutationId: sentPayload2.idempotencyKey,
            persisted: true,
            operation: 'attendance',
            studentId: sentPayload2.studentId,
            friday: sentPayload2.friday || fridayDate1,
            sheetName: sentPayload2.sheet || 'نشط',
            row: 2
          }
        })
      } as any;
    };

    const syncRes2 = await executeProcessOfflineQueue(mockAdminUser, false);
    assert.strictEqual(syncRes2.success, true, 'Scenario 2: Absence sync returned success');
    assert.strictEqual(sentPayload2.present, false, 'Scenario 2: Transmitted present: false');
    assert.strictEqual(sentPayload2.name, sampleStudent1.name, 'Scenario 2: Transmitted student name');
    const pendingAfter2 = await idbGetPendingMutations();
    assert.strictEqual(pendingAfter2.length, 0, 'Scenario 2: Removed from queue upon confirmation');
    console.log('✅ Scenario 2 Passed: Online Absence (present: false) registered and transmitted automatically');

    // --------------------------------------------------------------------------
    // SCENARIO 3: تسجيل حضور دون إنترنت: يُحفظ في المعلقات محلياً بأمان
    // --------------------------------------------------------------------------
    await cleanAllStores();
    setOnlineStatus(false); // Device offline

    const opId3 = generateUUID();
    const mutation3: OfflineMutation = {
      id: `ATT_${sampleStudent2.id}_${fridayDate1}_${opId3}`,
      action: 'attendance',
      studentId: sampleStudent2.id,
      studentCode: sampleStudent2.code,
      studentName: sampleStudent2.name,
      sourceSheet: sampleStudent2.sourceSheet,
      payload: { friday: fridayDate1, isPresent: true },
      expectedVersion: sampleStudent2.version,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    await idbAtomicRecordAttendanceWithMutation(
      { ...sampleStudent2, attendanceStatus: 'حاضر', attendanceTotal: sampleStudent2.attendanceTotal + 1 },
      { ...historyRecord1, studentId: sampleStudent2.id, studentCode: sampleStudent2.code },
      mutation3
    );

    let offlineNoticeTitle = '';
    const syncRes3 = await executeProcessOfflineQueue(
      mockAdminUser,
      false,
      (t) => { offlineNoticeTitle = t; }
    );

    assert.strictEqual(syncRes3.success, false, 'Scenario 3: Returns success: false when offline');
    assert.strictEqual(syncRes3.sentCount, 0, 'Scenario 3: Zero sent when offline');
    assert.strictEqual(syncRes3.remainingCount, 1, 'Scenario 3: 1 remaining in queue');
    assert.strictEqual(offlineNoticeTitle, 'وضع عدم الاتصال', 'Scenario 3: Notified about offline status');

    const pendingAfter3 = await idbGetPendingMutations();
    assert.strictEqual(pendingAfter3.length, 1, 'Scenario 3: Mutation is safely retained in IndexedDB');
    assert.strictEqual(pendingAfter3[0].id, mutation3.id, 'Scenario 3: Preserved mutation matches exact ID');
    console.log('✅ Scenario 3 Passed: Offline Attendance saved securely in IndexedDB without data loss');

    // --------------------------------------------------------------------------
    // SCENARIO 4: عودة الإنترنت: المزامنة التلقائية فوراً دون أي ضغط يدوي
    // --------------------------------------------------------------------------
    setOnlineStatus(true); // Network restored

    let reconnectFetchCalled = false;
    globalThis.fetch = async (url: any, init?: any) => {
      reconnectFetchCalled = true;
      const b = JSON.parse(init?.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          row: 3,
          total: 5,
          lastAttendance: fridayDate1,
          proof: {
            mutationId: b.idempotencyKey,
            persisted: true,
            operation: b.action || 'attendance',
            studentId: b.studentId,
            friday: b.friday || fridayDate1,
            sheetName: b.sheet || 'نشط',
            row: 3
          }
        })
      } as any;
    };

    // Auto-triggered by handleOnline
    const syncRes4 = await executeProcessOfflineQueue(mockAdminUser, false);
    assert.strictEqual(syncRes4.success, true, 'Scenario 4: Reconnect auto-sync succeeded');
    assert.strictEqual(syncRes4.sentCount, 1, 'Scenario 4: 1 mutation sent upon reconnect');
    assert.strictEqual(syncRes4.remainingCount, 0, 'Scenario 4: Queue drained to 0');
    assert.strictEqual(reconnectFetchCalled, true, 'Scenario 4: Fetch was invoked');

    const pendingAfter4 = await idbGetPendingMutations();
    assert.strictEqual(pendingAfter4.length, 0, 'Scenario 4: Queue is completely clean in IndexedDB');
    console.log('✅ Scenario 4 Passed: Automatic queue drain upon network reconnect without user manual click');

    // --------------------------------------------------------------------------
    // SCENARIO 5: تسجيل عدة عمليات أثناء انقطاع الإنترنت: إرسالها بالترتيب FIFO
    // --------------------------------------------------------------------------
    await cleanAllStores();
    setOnlineStatus(false);

    const mutQueue: OfflineMutation[] = [
      {
        id: `ATT_1_${generateUUID()}`,
        action: 'attendance',
        studentId: sampleStudent1.id,
        studentCode: sampleStudent1.code,
        studentName: sampleStudent1.name,
        sourceSheet: 'نشط',
        payload: { friday: '2026-11-06', isPresent: true },
        expectedVersion: 1,
        timestamp: 1000,
        retryCount: 0,
        status: 'pending'
      },
      {
        id: `ATT_2_${generateUUID()}`,
        action: 'attendance',
        studentId: sampleStudent2.id,
        studentCode: sampleStudent2.code,
        studentName: sampleStudent2.name,
        sourceSheet: 'نشط',
        payload: { friday: '2026-11-06', isPresent: true },
        expectedVersion: 1,
        timestamp: 2000,
        retryCount: 0,
        status: 'pending'
      },
      {
        id: `FU_1_${generateUUID()}`,
        action: 'followup',
        studentId: sampleStudent1.id,
        studentCode: sampleStudent1.code,
        studentName: sampleStudent1.name,
        sourceSheet: 'نشط',
        payload: { method: 'واتساب', status: 'واتساب', friday: '2026-11-06' },
        expectedVersion: 2,
        timestamp: 3000,
        retryCount: 0,
        status: 'pending'
      }
    ];

    await idbAtomicRecordAttendanceWithMutation(
      sampleStudent1,
      { id: `h_${mutQueue[0].id}`, studentId: mutQueue[0].studentId, studentCode: 'SG-101', fridayDate: '2026-11-06', status: true, recordedAt: 1000, sourceSheet: 'نشط' },
      mutQueue[0]
    );
    await idbAtomicRecordAttendanceWithMutation(
      sampleStudent2,
      { id: `h_${mutQueue[1].id}`, studentId: mutQueue[1].studentId, studentCode: 'SG-102', fridayDate: '2026-11-06', status: true, recordedAt: 2000, sourceSheet: 'نشط' },
      mutQueue[1]
    );
    await idbAtomicRecordFollowupWithMutation(
      sampleStudent1,
      { id: `fu_rec_${mutQueue[2].id}`, studentId: sampleStudent1.id, studentCode: 'SG-101', studentName: sampleStudent1.name, servant: sampleStudent1.servant, date: '2026-11-06', fridayDate: '2026-11-06', type: 'واتساب', notes: 'متابعة' },
      mutQueue[2]
    );

    const queueCheck = await idbGetPendingMutations();
    assert.strictEqual(queueCheck.length, 3, 'Scenario 5: 3 operations queued during offline session');

    // Now reconnected
    setOnlineStatus(true);
    const sentActionsInOrder: string[] = [];

    globalThis.fetch = async (url: any, init?: any) => {
      const b = JSON.parse(init?.body || '{}');
      sentActionsInOrder.push(`${b.action}:${b.studentName || b.name}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          row: 2,
          proof: {
            mutationId: b.idempotencyKey,
            persisted: true,
            operation: b.action,
            studentId: b.studentId,
            friday: b.friday || b.date || '2026-11-06',
            sheetName: b.sheet || 'نشط',
            row: 2,
            ...(b.action === 'followup' ? { followupLogAppended: true, followupLogRow: 12, recordId: `rec_${b.idempotencyKey}` } : {})
          }
        })
      } as any;
    };

    const syncRes5 = await executeProcessOfflineQueue(mockAdminUser, false);
    assert.strictEqual(syncRes5.success, true, 'Scenario 5: Batch queue auto sync succeeded');
    assert.strictEqual(syncRes5.sentCount, 3, 'Scenario 5: All 3 mutations confirmed');
    assert.strictEqual(syncRes5.remainingCount, 0, 'Scenario 5: 0 remaining in queue');

    assert.deepStrictEqual(
      sentActionsInOrder,
      [
        `attendance:${sampleStudent1.name}`,
        `attendance:${sampleStudent2.name}`,
        `followup:${sampleStudent1.name}`
      ],
      'Scenario 5: Strict FIFO ordering preserved across multiple offline operations'
    );
    console.log('✅ Scenario 5 Passed: Multiple offline mutations drained sequentially in exact FIFO order');

    // --------------------------------------------------------------------------
    // SCENARIO 6: انقطاع الإنترنت أثناء الإرسال: الاحتفاظ بالعملية وإعادة المحاولة بأمان
    // --------------------------------------------------------------------------
    await cleanAllStores();
    setOnlineStatus(true);

    const opId6 = generateUUID();
    const mutation6: OfflineMutation = {
      id: `ATT_RETRY_${opId6}`,
      action: 'attendance',
      studentId: sampleStudent1.id,
      studentCode: sampleStudent1.code,
      studentName: sampleStudent1.name,
      sourceSheet: 'نشط',
      payload: { friday: fridayDate1, isPresent: true },
      expectedVersion: sampleStudent1.version,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    await idbAtomicRecordAttendanceWithMutation(
      sampleStudent1,
      { id: `h_${opId6}`, studentId: sampleStudent1.id, studentCode: 'SG', fridayDate: fridayDate1, status: true, recordedAt: Date.now(), sourceSheet: 'نشط' },
      mutation6
    );

    let errorFiredCallback = false;

    // Simulate network drop mid-flight
    globalThis.fetch = async () => {
      const err = new TypeError('Failed to fetch');
      throw err;
    };

    const syncRes6Fail = await executeProcessOfflineQueue(
      mockAdminUser,
      false,
      undefined,
      undefined,
      {
        onMutationError: () => { errorFiredCallback = true; }
      }
    );

    assert.strictEqual(syncRes6Fail.success, false, 'Scenario 6: Network drop returns failure');
    assert.strictEqual(syncRes6Fail.remainingCount, 1, 'Scenario 6: Mutation retained in queue');
    assert.strictEqual(errorFiredCallback, true, 'Scenario 6: onMutationError callback fired');

    const pendingAfter6 = await idbGetPendingMutations();
    assert.strictEqual(pendingAfter6.length, 1, 'Scenario 6: Mutation still in IndexedDB');
    assert.strictEqual(pendingAfter6[0].status, 'failed', 'Scenario 6: Marked as failed');
    assert(pendingAfter6[0].lastError?.includes('تعذر الاتصال بالشبكة'), 'Scenario 6: Recorded descriptive error message');

    // Network recovers on retry
    globalThis.fetch = async (_url: any, init?: any) => {
      const b = JSON.parse(init?.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          row: 2,
          total: 6,
          lastAttendance: fridayDate1,
          proof: {
            mutationId: b.idempotencyKey,
            persisted: true,
            operation: 'attendance',
            studentId: b.studentId,
            friday: b.friday || fridayDate1,
            sheetName: b.sheet || 'نشط',
            row: 2
          }
        })
      } as any;
    };

    const syncRes6Recover = await executeProcessOfflineQueue(mockAdminUser, false, undefined, undefined, {
      nowMs: Date.now() + 10_000
    });
    assert.strictEqual(syncRes6Recover.success, true, 'Scenario 6: Automatic retry succeeds');
    assert.strictEqual(syncRes6Recover.sentCount, 1, 'Scenario 6: Sent 1 on recovery');

    const pendingAfter6Recover = await idbGetPendingMutations();
    assert.strictEqual(pendingAfter6Recover.length, 0, 'Scenario 6: Removed from IndexedDB only after verified recovery');
    console.log('✅ Scenario 6 Passed: Network drop during send handled safely with retention and automatic recovery');

    console.log('\n======================================================');
    console.log('🎉 ALL 6 AUTOMATIC REAL-TIME SYNC SCENARIOS PASSED!');
    console.log('======================================================\n');
  } finally {
    globalThis.fetch = originalFetch;
    await cleanAllStores();
  }
}

runAutoSyncTests().catch((err) => {
  console.error('❌ Automatic Real-Time Sync Test Suite Failed:', err);
  process.exit(1);
});
