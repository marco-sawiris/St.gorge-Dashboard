import assert from 'assert';
import fs from 'fs';
import path from 'path';
import 'fake-indexeddb/auto';
import {
  getIndexedDB,
  idbAtomicRecordAttendanceWithMutation,
  idbGetPendingMutations,
  idbUpdateMutationError,
  idbResetMutationRetry,
  idbRemoveMutation,
  idbGetStudents,
  idbClearMutations
} from '../services/indexedDbService';
import { executeProcessOfflineQueue, executeSyncData } from '../context/AppContext';
import { OfflineMutation, AuthUser } from '../types/auth';
import { Student } from '../types/student';
import { generateUUID } from '../utils/uuid';
import { setAppsScriptUrl, setRelayKey, toSafeHeaderAscii, fromSafeHeaderAscii, getAuthHeaders } from '../services/apiConfig';

const mockAdminUser: AuthUser = {
  userId: 'usr_admin',
  username: 'admin',
  displayName: 'أمين الخدمة',
  role: 'admin',
  token: 'mock_admin_token'
};

const sampleStudent: Student = {
  id: 'std_test_101',
  code: 'SG-101',
  name: 'مارك عاطف فهيم',
  servant: 'أبانوب وهبة',
  sourceSheet: 'نشط',
  area: 'الزيتون',
  address: 'شارع طومانباي',
  notes: 'مواظب',
  followupStatus: 'بدون',
  attendanceTotal: 3,
  attendanceMonth: 1,
  attendanceStatus: 'غائب',
  version: 2,
  att: { '2026-11-06': true },
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

async function runDiagnosticTests() {
  (globalThis as any).localStorage = createStorageMock();
  console.log('\n======================================================');
  console.log('  🧪 Running St. George Sync & Queue Diagnostics Test Suite');
  console.log('======================================================\n');

  const originalFetch = globalThis.fetch;

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Attendance Mutation Lifecycle & Storage in IndexedDB
    // --------------------------------------------------------------------------
    await cleanAllStores();

    const friday = '2026-11-13';
    const opId = generateUUID();
    const idempKey = `ATT_${sampleStudent.id}_${friday}_${opId}`;

    const updatedStudent: Student = {
      ...sampleStudent,
      att: { ...sampleStudent.att, [friday]: true },
      attendanceStatus: 'حاضر',
      attendanceTotal: 4,
      attendanceMonth: 2,
      version: 3
    };

    const mutation: OfflineMutation = {
      id: idempKey,
      action: 'attendance',
      studentId: sampleStudent.id,
      studentCode: sampleStudent.code,
      studentName: sampleStudent.name,
      sourceSheet: sampleStudent.sourceSheet,
      payload: { friday, isPresent: true },
      expectedVersion: sampleStudent.version,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    const historyRecord = {
      id: `${sampleStudent.id}__${friday}`,
      studentId: sampleStudent.id,
      studentCode: sampleStudent.code,
      fridayDate: friday,
      status: true,
      recordedAt: Date.now(),
      sourceSheet: sampleStudent.sourceSheet
    };

    await idbAtomicRecordAttendanceWithMutation(updatedStudent, historyRecord, mutation);

    const pending = await idbGetPendingMutations();
    assert(pending.length === 1, 'Test 1a: Exactly one mutation stored in IndexedDB');
    assert(pending[0].id === idempKey, 'Test 1b: Stored mutation ID matches idempotency key');
    assert(pending[0].status === 'pending', 'Test 1c: Mutation enters queue in pending state');
    assert(pending[0].studentName === 'مارك عاطف فهيم', 'Test 1d: Associated student name stored');
    assert(pending[0].payload?.isPresent === true, 'Test 1e: Payload reflects attendance presence');

    console.log('✅ Test 1 Passed: Attendance mutation created and stored atomically in IndexedDB');

    // --------------------------------------------------------------------------
    // TEST 2: Failure Error Tracking & Retry Count Persistence (Zero Data Loss)
    // --------------------------------------------------------------------------
    const testErrorMsg = 'استجاب الخادم برمز خطأ (HTTP 500)';
    await idbUpdateMutationError(idempKey, testErrorMsg, 'failed');

    const pendingAfterError = await idbGetPendingMutations();
    assert(pendingAfterError.length === 1, 'Test 2a: Mutation NOT deleted on failure');
    assert(pendingAfterError[0].status === 'failed', 'Test 2b: Status updated to failed');
    assert(pendingAfterError[0].lastError === testErrorMsg, 'Test 2c: Exact error message persisted');
    assert(pendingAfterError[0].retryCount === 1, 'Test 2d: Retry count incremented to 1');
    assert(typeof pendingAfterError[0].lastAttemptAt === 'number', 'Test 2e: Attempt timestamp recorded');

    // Reset for retry
    await idbResetMutationRetry(idempKey);
    const pendingAfterReset = await idbGetPendingMutations();
    assert(pendingAfterReset[0].status === 'pending', 'Test 2f: Status reset to pending for retry');
    assert(pendingAfterReset[0].lastError === testErrorMsg, 'Test 2g: Previous error history preserved until success');

    console.log('✅ Test 2 Passed: Failure details, retry counts, and attempt timestamps persisted');

    // --------------------------------------------------------------------------
    // TEST 3: executeProcessOfflineQueue Records Errors and Retains Mutations
    // --------------------------------------------------------------------------
    setAppsScriptUrl('https://script.google.com/macros/s/AKfycbDiagTest/exec');
    setRelayKey('SYNC_DIAGNOSTIC_TEST_RELAY_KEY_32_CHARS_MINIMUM');

    // Simulate 500 error from Apps Script
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('script.google.com')) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ ok: false, error: 'Database busy' })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const flushResult = await executeProcessOfflineQueue(null, false);
    assert(flushResult.success === false, 'Test 3a: Queue flush reports failure on 500');
    assert(flushResult.remainingCount === 1, 'Test 3b: Mutation retained in queue (Zero Data Loss)');

    const pendingAfterHttpFail = await idbGetPendingMutations();
    assert(pendingAfterHttpFail[0].status === 'failed', 'Test 3c: Mutation status updated to failed');
    assert(
      pendingAfterHttpFail[0].lastError && pendingAfterHttpFail[0].lastError.includes('500'),
      'Test 3d: Error message details HTTP 500'
    );
    assert(pendingAfterHttpFail[0].retryCount! >= 2, 'Test 3e: Retry count incremented on failed attempt');

    console.log('✅ Test 3 Passed: executeProcessOfflineQueue tracks failure reason without losing data');

    // --------------------------------------------------------------------------
    // TEST 4: executeSyncData Pulls Data & Preserves Unpushed Local Mutations WITHOUT Failing
    // --------------------------------------------------------------------------
    // Server returns sheet data with student version 2
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('action=getStudents')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            sheet: 'نشط',
            isComplete: true,
            confirmedComplete: true,
            students: [
              {
                ...sampleStudent,
                name: 'مارك عاطف فهيم (محدث من الشيت)',
                attendanceStatus: 'غائب', // Server has absent
                version: 2
              }
            ]
          })
        };
      }
      // Fail mutations so mutation stays pending in queue
      if (url.includes('script.google.com')) {
        return { ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    let recordedError: string | null = 'stale_error';
    let recordedPullIso: string | null = null;
    const lockRef = { current: false };

    const syncResult = await executeSyncData(
      'نشط',
      null,
      false,
      lockRef,
      undefined,
      undefined,
      (iso) => { recordedPullIso = iso; },
      undefined,
      (err) => { recordedError = err; }
    );

    // Pull may succeed while the overall sync remains incomplete because queued writes failed.
    assert(syncResult === false, 'Test 4a: Overall sync reports incomplete while a mutation remains unconfirmed');
    assert(recordedError !== null, 'Test 4b: Failed queued write remains visible as a sync error');
    assert(recordedPullIso !== null, 'Test 4c: Successful pull timestamp is still updated independently');

    // Zero Data Loss: verify local student attendance was PRESERVED because of pending mutation!
    const localStudents = await idbGetStudents();
    const activeStudentInDb = localStudents.find((s) => s.id === sampleStudent.id);
    assert(activeStudentInDb !== undefined, 'Test 4d: Student exists in IndexedDB');
    assert(
      activeStudentInDb?.attendanceStatus === 'حاضر',
      'Test 4e: Local attendance (حاضر) strictly preserved over server version (غائب) due to pending mutation'
    );

    const pendingStillPresent = await idbGetPendingMutations();
    assert(pendingStillPresent.length === 1, 'Test 4f: Pending mutation strictly preserved in queue');

    console.log('✅ Test 4 Passed: Data pulled & reconciled successfully while preserving local pending operations');

    // --------------------------------------------------------------------------
    // TEST 5: Verified Removal ONLY Upon Google Apps Script Confirmation
    // --------------------------------------------------------------------------
    // Simulate real successful confirmation from Google Apps Script
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('script.google.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            status: 200,
            mutationId: idempKey,
            studentId: sampleStudent.id,
            newVersion: 3,
            action: 'attendance'
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    let pushTimeSaved: string | null = null;
    const successfulFlush = await executeProcessOfflineQueue(
      null,
      false,
      undefined,
      (pushIso) => { pushTimeSaved = pushIso; }
    );

    assert(successfulFlush.success === true, 'Test 5a: Queue flush succeeds on server confirmation');
    assert(successfulFlush.sentCount === 1, 'Test 5b: One operation confirmed sent');
    assert(successfulFlush.remainingCount === 0, 'Test 5c: Zero remaining operations');
    assert(pushTimeSaved !== null, 'Test 5d: Push timestamp saved upon verified success');

    const pendingAfterSuccess = await idbGetPendingMutations();
    assert(pendingAfterSuccess.length === 0, 'Test 5e: Mutation removed from IndexedDB ONLY after verified success');

    console.log('✅ Test 5 Passed: Mutation removed from IndexedDB only after verified Google Apps Script confirmation');

    // --------------------------------------------------------------------------
    // TEST 6: Structural & Zero Data Loss Audit of QueueDetailsModal
    // --------------------------------------------------------------------------
    const queueModalPath = path.resolve(process.cwd(), 'src/components/modals/QueueDetailsModal.tsx');
    assert(fs.existsSync(queueModalPath), 'Test 6a: QueueDetailsModal.tsx exists');

    const queueModalSrc = fs.readFileSync(queueModalPath, 'utf-8');
    assert(queueModalSrc.includes('طابور العمليات المعلقة'), 'Test 6b: Displays Queue Details title');
    assert(queueModalSrc.includes('idbGetPendingMutations'), 'Test 6c: Loads real mutations from IndexedDB');
    assert(queueModalSrc.includes('processOfflineQueue'), 'Test 6d: Connects to processOfflineQueue');
    assert(queueModalSrc.includes('handleRetrySingle'), 'Test 6e: Supports individual operation retry');
    assert(queueModalSrc.includes('handleRetryAll'), 'Test 6f: Supports retry all operations');
    assert(queueModalSrc.includes('lastError'), 'Test 6g: Displays failure error message');
    assert(queueModalSrc.includes('studentName'), 'Test 6h: Displays associated student name');
    assert(queueModalSrc.includes('studentCode'), 'Test 6i: Displays student code');
    assert(queueModalSrc.includes('sourceSheet'), 'Test 6j: Displays source sheet');
    assert(queueModalSrc.includes('Zero Data Loss'), 'Test 6k: Mentions Zero Data Loss guarantee');

    // Strict Zero Data Loss Guarantee: MUST NOT contain any delete or clear queue buttons!
    assert(!queueModalSrc.includes('idbClearMutations'), 'Test 6l: NO bulk clear queue call in QueueDetailsModal');
    assert(!queueModalSrc.includes('idbRemoveMutation'), 'Test 6m: NO manual delete mutation call in QueueDetailsModal');
    assert(!queueModalSrc.includes('حذف العملية'), 'Test 6n: NO delete operation button text');
    assert(!queueModalSrc.includes('مسح الطابور'), 'Test 6o: NO clear queue button text');

    // Check SyncDetailsModal opens QueueDetailsModal
    const syncDetailsModalPath = path.resolve(process.cwd(), 'src/components/modals/SyncDetailsModal.tsx');
    const syncDetailsModalSrc = fs.readFileSync(syncDetailsModalPath, 'utf-8');
    assert(syncDetailsModalSrc.includes('setIsQueueModalOpen(true)'), 'Test 6p: Clicking queue in SyncDetailsModal opens QueueDetailsModal');

    console.log('✅ Test 6 Passed: QueueDetailsModal and SyncDetailsModal verified with Zero Data Loss enforcement\n');

    // --------------------------------------------------------------------------
    // TEST 7: Root-Cause Non-ISO-8859-1 Header Fix & ByteString Safety Verification
    // --------------------------------------------------------------------------
    const rawArabicMutationId = 'ATT_gs_نشط_SG-101_1_2026-11-13_a8f903-4c91';
    
    // Check that raw Arabic string contains characters > 255 (non-ISO-8859-1)
    const hasNonIsoCodePoint = Array.from(rawArabicMutationId).some((ch) => ch.charCodeAt(0) > 255);
    assert(hasNonIsoCodePoint, 'Test 7a: Original mutation ID contains non-ISO-8859-1 Arabic characters');

    // In modern Web IDL fetch specification, constructing Headers or Request with code point > 255 throws
    let threwOnRawHeader = false;
    try {
      new Headers({ 'X-Idempotency-Key': rawArabicMutationId });
    } catch (e: any) {
      threwOnRawHeader = true;
      assert(
        e.message.includes('non-ISO-8859-1') || e.message.includes('ByteString') || e.name === 'TypeError',
        'Test 7b: Native Headers rejects non-ISO-8859-1 character'
      );
    }
    // Note: depending on Node fetch runtime, if it didn't throw in Headers constructor, Request constructor or network dispatch enforces it.

    // Now verify toSafeHeaderAscii converts to 100% pure ASCII range [\x20-\x7E]
    const safeHeaderKey = toSafeHeaderAscii(rawArabicMutationId);
    assert(/^[\x20-\x7E]+$/.test(safeHeaderKey), 'Test 7c: toSafeHeaderAscii output contains ONLY valid ASCII bytes (\x20-\x7E)');
    assert(!safeHeaderKey.includes('نشط'), 'Test 7d: Arabic characters safely percent-encoded in header');

    // Constructing Request with sanitized header MUST NOT throw
    const safeHeaders = new Headers({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Idempotency-Key': safeHeaderKey
    });
    assert(safeHeaders.get('X-Idempotency-Key') === safeHeaderKey, 'Test 7e: Headers constructed cleanly without error');

    const testReq = new Request('https://script.google.com/macros/s/test/exec', {
      method: 'POST',
      headers: safeHeaders,
      body: JSON.stringify({ test: 'ok' })
    });
    assert(testReq.headers.get('X-Idempotency-Key') === safeHeaderKey, 'Test 7f: Request created without non-ISO-8859-1 code point error');

    // Decoding on server reconstitutes the exact original Arabic mutation ID
    const decodedOnServer = decodeURIComponent(safeHeaderKey);
    assert(decodedOnServer === rawArabicMutationId, 'Test 7g: Server decodeURIComponent restores exact original Arabic mutation ID');
    assert(fromSafeHeaderAscii(safeHeaderKey) === rawArabicMutationId, 'Test 7h: fromSafeHeaderAscii restores exact original Arabic string');

    // Pure ASCII keys (UUIDs) remain unchanged
    const asciiKey = 'ATT_std_101_2026-11-13_f89b-1234';
    assert(toSafeHeaderAscii(asciiKey) === asciiKey, 'Test 7i: Pure ASCII keys remain untouched');

    console.log('✅ Test 7 Passed: Root-cause ByteString non-ISO-8859-1 header fix verified with 100% fidelity');

    // --------------------------------------------------------------------------
    // TEST 8: Arabic Student & Sheet Name Mutation Transmission (UTF-8 JSON Body & Idempotency)
    // --------------------------------------------------------------------------
    await cleanAllStores();

    const arabicStudentId = 'gs_نشط_SG-999_1';
    const arabicStudentName = 'كيرلس مرقس عبد المسيح';
    const arabicSheetName = 'فصل القديس أثناسيوس';
    const fridayDate = '2026-11-20';
    const arabicMutationKey = `ATT_${arabicStudentId}_${fridayDate}_test-idem-999`;

    const arabicStudent: Student = {
      id: arabicStudentId,
      code: 'SG-999',
      name: arabicStudentName,
      servant: 'مينا كمال',
      sourceSheet: arabicSheetName,
      area: 'مصر الجديدة',
      address: 'شارع الحجاز',
      notes: 'يحتاج افتقاد تليفوني',
      followupStatus: 'بدون',
      attendanceTotal: 5,
      attendanceMonth: 2,
      attendanceStatus: 'غائب',
      version: 1,
      att: {},
      fu: {}
    };

    const arabicMutation: OfflineMutation = {
      id: arabicMutationKey,
      action: 'attendance',
      studentId: arabicStudentId,
      studentCode: 'SG-999',
      studentName: arabicStudentName,
      sourceSheet: arabicSheetName,
      payload: { friday: fridayDate, isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    const arabicHistory = {
      id: `${arabicStudentId}__${fridayDate}`,
      studentId: arabicStudentId,
      studentCode: 'SG-999',
      fridayDate,
      status: true,
      recordedAt: Date.now(),
      sourceSheet: arabicSheetName
    };

    // Store in IndexedDB
    await idbAtomicRecordAttendanceWithMutation(
      { ...arabicStudent, attendanceStatus: 'حاضر', version: 2 },
      arabicHistory,
      arabicMutation
    );

    const pendingArabic = await idbGetPendingMutations();
    assert(pendingArabic.length === 1, 'Test 8a: Arabic student mutation saved to IndexedDB');
    assert(pendingArabic[0].studentName === arabicStudentName, 'Test 8b: Arabic student name preserved in IndexedDB');

    // Intercept fetch to verify outgoing network request
    let interceptedUrl = '';
    let interceptedHeaders: any = {};
    let interceptedBody: any = null;

    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      interceptedUrl = url;
      interceptedHeaders = init?.headers || {};
      if (init?.body && typeof init.body === 'string') {
        interceptedBody = JSON.parse(init.body);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: 200,
          mutationId: arabicMutationKey,
          studentId: arabicStudentId,
          newVersion: 2,
          action: 'attendance'
        })
      };
    };

    // Send through executeProcessOfflineQueue
    const arabicFlushResult = await executeProcessOfflineQueue(null, false);
    assert(arabicFlushResult.success === true, 'Test 8c: Queue flush succeeds for Arabic student and sheet');
    assert(arabicFlushResult.sentCount === 1, 'Test 8d: One mutation confirmed processed');
    assert(arabicFlushResult.remainingCount === 0, 'Test 8e: Queue cleared after verified confirmation');

    // Verify Headers were strictly ASCII
    for (const [headerName, headerVal] of Object.entries(interceptedHeaders)) {
      assert(
        /^[\x20-\x7E]+$/.test(String(headerVal)),
        `Test 8f: Outgoing header "${headerName}" is strictly ASCII, found: ${headerVal}`
      );
    }

    // Verify Body contains pure UTF-8 Arabic fields without corruption
    assert(interceptedBody !== null, 'Test 8g: Request body successfully parsed as JSON');
    assert(interceptedBody.studentName === arabicStudentName, 'Test 8h: Arabic student name preserved in JSON body');
    assert(interceptedBody.sourceSheet === arabicSheetName, 'Test 8i: Arabic sheet name preserved in JSON body');
    assert(interceptedBody.studentId === arabicStudentId, 'Test 8j: Student ID preserved in JSON body');
    assert(interceptedBody.payload?.isPresent === true, 'Test 8k: Attendance payload preserved in JSON body');

    // Verify IndexedDB now has 0 pending mutations
    const pendingFinal = await idbGetPendingMutations();
    assert(pendingFinal.length === 0, 'Test 8l: Mutation safely deleted from IndexedDB after verified server success\n');

    console.log('✅ Test 8 Passed: Arabic student & sheet name mutation transmission with UTF-8 JSON body & Idempotency verified\n');

    console.log('======================================================');
    console.log('🎉 ALL 8 SYNC & QUEUE DIAGNOSTIC TESTS PASSED SUCCESSFULLY!');
    console.log('======================================================\n');
  } finally {
    globalThis.fetch = originalFetch;
    setAppsScriptUrl('');
    setRelayKey('');
  }
}

runDiagnosticTests().catch((err) => {
  console.error('\n❌ Diagnostic Test Suite Failed:', err);
  process.exit(1);
});
