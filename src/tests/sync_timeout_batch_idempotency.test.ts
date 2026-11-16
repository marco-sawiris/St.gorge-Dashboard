import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import express from 'express';
import http from 'node:http';
import {
  getIndexedDB,
  idbAtomicBatchRecordAttendanceWithMutations,
  idbAtomicRecordAttendanceWithMutation,
  idbClearMutations,
  idbGetPendingMutations,
  idbSaveStudents
} from '../services/indexedDbService';
import {
  clearBatchUnsupportedCache,
  computeExponentialBackoffDelayMs,
  executeProcessOfflineQueue,
  prepareBatchAttendanceMutations
} from '../context/AppContext';
import { setAppsScriptUrl, setRelayKey } from '../services/apiConfig';
import { Student } from '../types/student';
import { OfflineMutation, AuthUser } from '../types/auth';
import sheetsRouter from '../../server/routes/sheets';
import { googleSheetsService } from '../../server/services/googleSheetsService';
import { signAccessToken } from '../../server/security/jwt';

const storageMap = new Map<string, string>();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v));
    },
    removeItem: (k: string) => {
      storageMap.delete(k);
    },
    clear: () => {
      storageMap.clear();
    }
  };
}

function setOnlineStatus(online: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online },
    configurable: true,
    writable: true
  });
}

async function cleanStores() {
  const db = await getIndexedDB();
  const tx = db.transaction(['students', 'mutations', 'attendance_history', 'followup'], 'readwrite');
  tx.objectStore('students').clear();
  tx.objectStore('mutations').clear();
  tx.objectStore('attendance_history').clear();
  tx.objectStore('followup').clear();
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
}

function buildTestStudents(count: number): Student[] {
  const list: Student[] = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      id: `st_timeout_${i}`,
      code: `SG-${200 + i}`,
      name: `مخدوم اختبار ${i}`,
      servant: 'أبانوب وهبة',
      sourceSheet: 'نشط',
      area: 'الزيتون',
      address: 'شارع طومانباي',
      notes: '',
      followupStatus: 'بدون',
      attendanceTotal: 0,
      attendanceMonth: 0,
      attendanceStatus: 'غائب',
      version: 1,
      att: {},
      fu: {}
    });
  }
  return list;
}

async function runTests() {
  console.log('\n=================================================================');
  console.log('  🚀 St. George Sync Timeout, Batch & Idempotency Test Suite (7+)');
  console.log('=================================================================\n');

  const originalFetch = globalThis.fetch;
  setOnlineStatus(true);
  setAppsScriptUrl('https://script.google.com/macros/s/AKfycbSyncTimeoutSuite/exec');
  setRelayKey('TIMEOUT_SYNC_TEST_RELAY_KEY_MIN_32_CHARS');
  clearBatchUnsupportedCache();

  try {
    // -----------------------------------------------------------------------
    // SCENARIO 1: تسجيل حضور واحد (Single Write) + Explicit Confirmation & Timing
    // -----------------------------------------------------------------------
    await cleanStores();
    const st1 = buildTestStudents(1)[0];
    await idbSaveStudents([st1], 'نشط', true);
    const singleKey = `ATT_${st1.id}_2026-10-23_fixed-single-uuid`;
    const singleMut: OfflineMutation = {
      id: singleKey,
      action: 'attendance',
      studentId: st1.id,
      studentCode: st1.code,
      studentName: st1.name,
      sourceSheet: 'نشط',
      payload: { friday: '2026-10-23', isPresent: true },
      expectedVersion: 1,
      timestamp: 1000,
      retryCount: 0,
      status: 'pending'
    };
    await idbAtomicRecordAttendanceWithMutation(
      { ...st1, att: { '2026-10-23': true }, attendanceTotal: 1, version: 2 },
      { id: `${st1.id}__2026-10-23`, studentId: st1.id, studentCode: st1.code, fridayDate: '2026-10-23', status: true, recordedAt: 1000, sourceSheet: 'نشط' },
      singleMut
    );

    let singleHttpCalls = 0;
    (globalThis as any).fetch = async (_u: string, init?: RequestInit) => {
      singleHttpCalls++;
      const b = JSON.parse(String(init?.body || '{}'));
      assert.equal(b.action, 'attendance');
      assert.equal(b.idempotencyKey, singleKey);
      return new Response(JSON.stringify({ ok: true, status: 200, mutationId: singleKey, newVersion: 2, serverDurationMs: 18 }), { status: 200 });
    };

    const singleReport = await executeProcessOfflineQueue(null, false);
    assert.equal(singleReport.success, true);
    assert.equal(singleReport.outcome, 'success');
    assert.equal(singleReport.sentCount, 1);
    assert.equal(singleReport.remainingCount, 0);
    assert.equal(singleHttpCalls, 1);
    assert.equal((await idbGetPendingMutations()).length, 0);
    console.log('✅ Scenario 1 Passed: Single attendance write confirmed & cleared');

    // -----------------------------------------------------------------------
    // SCENARIO 2: استيراد PDF كبير -> Chunked Batch Processing + Legacy Fallback
    // -----------------------------------------------------------------------
    await cleanStores();
    clearBatchUnsupportedCache();
    const tenStudents = buildTestStudents(10);
    await idbSaveStudents(tenStudents, 'نشط', true);
    const fridays = ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13']; // 10 * 4 = 40 records
    const entries = tenStudents.flatMap((s) =>
      fridays.map((f) => ({ studentId: s.id, fridayDate: f, isPresent: true }))
    );
    const plan = prepareBatchAttendanceMutations(entries, tenStudents, () => ({ allowed: true }), '2026-11-16');
    assert.equal(plan.appliedCount, 40);
    await idbAtomicBatchRecordAttendanceWithMutations(plan.updatedStudents, plan.historyRecords, plan.mutations);

    const serverState = new Map<string, { version: number; att: Record<string, boolean> }>();
    tenStudents.forEach((s) => serverState.set(s.id, { version: 1, att: {} }));
    let batchHttpCalls = 0;
    const processedKeys = new Set<string>();

    (globalThis as any).fetch = async (_u: string, init?: RequestInit) => {
      batchHttpCalls++;
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.action, 'batch', 'Large PDF import must use batch action');
      assert.ok(body.mutations.length <= 15, 'Batch chunks must respect max chunk size (15)');
      const results = body.mutations.map((item: any) => {
        if (processedKeys.has(item.idempotencyKey)) {
          return { ok: true, status: 200, deduplicated: true, mutationId: item.idempotencyKey };
        }
        const rec = serverState.get(item.studentId)!;
        if (rec.version !== item.expectedVersion) {
          return { ok: false, status: 409, mutationId: item.idempotencyKey, error: 'Version mismatch' };
        }
        rec.version += 1;
        rec.att[item.date] = item.isPresent;
        processedKeys.add(item.idempotencyKey);
        return { ok: true, status: 200, mutationId: item.idempotencyKey, newVersion: rec.version };
      });
      return new Response(JSON.stringify({ ok: true, action: 'batch', results, serverDurationMs: 55 }), { status: 200 });
    };

    const batchReport = await executeProcessOfflineQueue(null, false, undefined, undefined, { batchSize: 15 });
    assert.equal(batchReport.success, true);
    assert.equal(batchReport.mode, 'batch');
    assert.equal(batchReport.sentCount, 40);
    assert.equal(batchReport.remainingCount, 0);
    assert.equal(batchHttpCalls, 3, '40 mutations should finish in 3 chunked HTTP requests (15+15+10), NOT 40!');
    for (const s of tenStudents) {
      assert.equal(serverState.get(s.id)?.version, 5, `Student ${s.id} has exact sequential OCC version 5`);
      assert.equal(Object.keys(serverState.get(s.id)?.att || {}).length, 4);
    }
    console.log('✅ Scenario 2 Passed: 40 PDF attendance records compressed into 3 ordered chunks cleanly');

    // -----------------------------------------------------------------------
    // SCENARIO 3: انقطاع الشبكة أثناء الإرسال -> Retention + Exponential Backoff + Same Key
    // -----------------------------------------------------------------------
    await cleanStores();
    clearBatchUnsupportedCache();
    const dropStudent = buildTestStudents(1)[0];
    const immutableKey = `ATT_${dropStudent.id}_2026-11-13_immutable-key-3`;
    const dropMut: OfflineMutation = {
      id: immutableKey,
      action: 'attendance',
      studentId: dropStudent.id,
      studentCode: dropStudent.code,
      studentName: dropStudent.name,
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: false },
      expectedVersion: 1,
      timestamp: 2000,
      retryCount: 0,
      status: 'pending'
    };
    await idbAtomicRecordAttendanceWithMutation(dropStudent, { id: 'h_drop', studentId: dropStudent.id, studentCode: dropStudent.code, fridayDate: '2026-11-13', status: false, recordedAt: 2000, sourceSheet: 'نشط' }, dropMut);

    (globalThis as any).fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const dropReport = await executeProcessOfflineQueue(null, false);
    assert.equal(dropReport.success, false);
    assert.equal(dropReport.outcome, 'failed');
    assert.equal(dropReport.remainingCount, 1);
    const pendingAfterDrop = await idbGetPendingMutations();
    assert.equal(pendingAfterDrop[0].id, immutableKey, 'Idempotency key MUST NEVER change on failure');
    assert.equal(pendingAfterDrop[0].retryCount, 1);
    assert.ok(typeof pendingAfterDrop[0].nextRetryAt === 'number' && pendingAfterDrop[0].nextRetryAt > Date.now());
    assert.equal(computeExponentialBackoffDelayMs(1), 2000);
    assert.equal(computeExponentialBackoffDelayMs(2), 4000);
    assert.equal(computeExponentialBackoffDelayMs(3), 8000);
    assert.equal(computeExponentialBackoffDelayMs(6), 60000);
    console.log('✅ Scenario 3 Passed: Network drop retains operation with immutable key & Exponential Backoff');

    // -----------------------------------------------------------------------
    // SCENARIO 4: Timeout AFTER Server Actually Executed Write Before Response Returned!
    //             Client aborts at timeout -> enters timeout_unknown -> queries checkIdempotency
    //             -> confirms server ALREADY persisted -> removes cleanly WITHOUT re-writing!
    // -----------------------------------------------------------------------
    await cleanStores();
    clearBatchUnsupportedCache();
    const lateStudents = buildTestStudents(4);
    await idbSaveStudents(lateStudents, 'نشط', true);
    const lateEntries = lateStudents.map((s) => ({ studentId: s.id, fridayDate: '2026-11-13', isPresent: true }));
    const latePlan = prepareBatchAttendanceMutations(lateEntries, lateStudents, () => ({ allowed: true }), '2026-11-16');
    await idbAtomicBatchRecordAttendanceWithMutations(latePlan.updatedStudents, latePlan.historyRecords, latePlan.mutations);

    const serverLedger = new Map<string, any>();
    let batchExecCount = 0;
    let idempCheckCount = 0;

    (globalThis as any).fetch = async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.action === 'batch') {
        batchExecCount++;
        // Server EXECUTES the write immediately, BEFORE taking longer than client timeout to respond!
        for (const item of body.mutations) {
          serverLedger.set(item.idempotencyKey, { ok: true, status: 200, mutationId: item.idempotencyKey, newVersion: 2 });
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted due to timeout');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      }
      if (body.action === 'checkIdempotency') {
        idempCheckCount++;
        const results: Record<string, any> = {};
        for (const k of body.keys) {
          const hit = serverLedger.get(k);
          results[k] = hit ? { found: true, response: hit } : { found: false };
        }
        return new Response(JSON.stringify({ ok: true, status: 200, results }), { status: 200 });
      }
      return new Response('{}', { status: 400 });
    };

    const timeoutVerifiedReport = await executeProcessOfflineQueue(null, false, undefined, undefined, {
      batchTimeoutMs: 40,
      verifyTimeoutMs: 1000
    });

    assert.equal(batchExecCount, 1, 'Timed-out batch MUST NOT be blindly re-executed after checkIdempotency confirms write');
    assert.equal(idempCheckCount, 1, 'Post-timeout verification MUST query checkIdempotency');
    assert.equal(timeoutVerifiedReport.success, true);
    assert.equal(timeoutVerifiedReport.verifiedPostTimeoutCount, 4);
    assert.equal(timeoutVerifiedReport.sentCount, 4);
    assert.equal(timeoutVerifiedReport.remainingCount, 0);
    assert.equal((await idbGetPendingMutations()).length, 0);
    console.log('✅ Scenario 4 Passed: Post-timeout verification detects server write & prevents duplicate re-execution');

    // -----------------------------------------------------------------------
    // SCENARIO 5 & 6: Timeout when server did NOT execute -> status timeout_unknown
    //                -> retry keeps EXACT same idempotencyKey -> Zero duplicates on resend!
    // -----------------------------------------------------------------------
    await cleanStores();
    clearBatchUnsupportedCache();
    const unexecSt = buildTestStudents(1)[0];
    const fixedRetryKey = `ATT_${unexecSt.id}_2026-11-13_never-regenerate-id`;
    await idbAtomicRecordAttendanceWithMutation(
      { ...unexecSt, att: { '2026-11-13': true }, attendanceTotal: 1, version: 2 },
      { id: `${unexecSt.id}__2026-11-13`, studentId: unexecSt.id, studentCode: unexecSt.code, fridayDate: '2026-11-13', status: true, recordedAt: 3000, sourceSheet: 'نشط' },
      {
        id: fixedRetryKey,
        action: 'attendance',
        studentId: unexecSt.id,
        studentCode: unexecSt.code,
        studentName: unexecSt.name,
        sourceSheet: 'نشط',
        payload: { friday: '2026-11-13', isPresent: true },
        expectedVersion: 1,
        timestamp: 3000,
        retryCount: 0,
        status: 'pending'
      }
    );

    (globalThis as any).fetch = async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body || '{}'));
      if (b.action === 'checkIdempotency') {
        return new Response(JSON.stringify({ ok: true, results: { [fixedRetryKey]: { found: false } } }), { status: 200 });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Timed out');
          e.name = 'AbortError';
          reject(e);
        });
      });
    };

    const timedOutUnconfirmed = await executeProcessOfflineQueue(null, false, undefined, undefined, {
      singleTimeoutMs: 30,
      verifyTimeoutMs: 500
    });
    assert.equal(timedOutUnconfirmed.success, false);
    assert.equal(timedOutUnconfirmed.outcome, 'timeout_unknown');
    assert.equal(timedOutUnconfirmed.unknownResultCount, 1);
    assert.equal(timedOutUnconfirmed.remainingCount, 1);

    const unknownQueue = await idbGetPendingMutations();
    assert.equal(unknownQueue.length, 1, 'Scenario 7 check: unconfirmed timeout operation MUST stay in Offline Queue');
    assert.equal(unknownQueue[0].status, 'timeout_unknown');
    assert.equal(unknownQueue[0].id, fixedRetryKey, 'Scenario 5 check: MUST retain identical idempotencyKey');

    // Now resend same operation -> succeeds cleanly with exact same key
    const seenResendKeys: string[] = [];
    (globalThis as any).fetch = async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body || '{}'));
      seenResendKeys.push(b.idempotencyKey);
      return new Response(JSON.stringify({ ok: true, status: 200, mutationId: b.idempotencyKey, newVersion: 2 }), { status: 200 });
    };
    const recovered = await executeProcessOfflineQueue(null, false);
    assert.equal(recovered.success, true);
    assert.deepEqual(seenResendKeys, [fixedRetryKey], 'Resend used identical immutable idempotencyKey');
    assert.equal((await idbGetPendingMutations()).length, 0);
    console.log('✅ Scenario 5, 6 & 7 (Apps Script) Passed: timeout_unknown retention, immutable key resend, and zero duplicates');

    // -----------------------------------------------------------------------
    // SCENARIO 6b & 7b: Express Server Integration Test (/api/sheets/mutate-batch + /idempotency)
    //                   Verifies real Express backend batch chunking, deduplication, OCC, and idempotency endpoint!
    // -----------------------------------------------------------------------
    setAppsScriptUrl('');
    storageMap.delete('stgorge_apps_script_url');

    const expStudents = buildTestStudents(3);
    googleSheetsService.seedTestFixtureStudentsOnly(expStudents);

    const app = express();
    app.use(express.json());
    app.use('/api/sheets', sheetsRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const adminToken = signAccessToken({ userId: 'u_admin', username: 'admin', displayName: 'أمين', role: 'admin' });

    try {
      (globalThis as any).fetch = originalFetch;

      // Batch payload with 6 attendance records (3 students x 2 Fridays, sequential versions 1 -> 2 -> 3)
      const batchMuts = expStudents.flatMap((s) => [
        { id: `EXP_${s.id}_d1_k1`, action: 'attendance', studentId: s.id, expectedVersion: 1, payload: { friday: '2026-10-23', isPresent: true } },
        { id: `EXP_${s.id}_d2_k2`, action: 'attendance', studentId: s.id, expectedVersion: 2, payload: { friday: '2026-10-30', isPresent: false } }
      ]);

      const batchResp = await fetch(`${baseUrl}/api/sheets/mutate-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ mutations: batchMuts })
      });
      assert.equal(batchResp.status, 200);
      const batchJson = (await batchResp.json()) as any;
      assert.equal(batchJson.ok, true);
      assert.equal(batchJson.results.length, 6);
      assert.ok(batchJson.results.every((r: any) => r.ok && r.status === 200));

      // Verify student attendance total & version after 1 present + 1 absent = version 3, total 1!
      const s1After = googleSheetsService.getStudentById(expStudents[0].id)!;
      assert.equal(s1After.version, 3);
      assert.equal(s1After.attendanceTotal, 1);

      // Re-sending IDENTICAL batch -> deduplicated: true, version stays 3, attendanceTotal stays 1 (Zero Duplicates!)
      const dupResp = await fetch(`${baseUrl}/api/sheets/mutate-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ mutations: batchMuts })
      });
      const dupJson = (await dupResp.json()) as any;
      assert.equal(dupJson.ok, true);
      assert.ok(dupJson.results.every((r: any) => r.ok && r.deduplicated === true));
      assert.equal(googleSheetsService.getStudentById(expStudents[0].id)!.version, 3, 'Duplicate replay must not increment version');
      assert.equal(googleSheetsService.getStudentById(expStudents[0].id)!.attendanceTotal, 1, 'Duplicate replay must not double attendanceTotal');

      // Query /api/sheets/idempotency for confirmed keys + unknown key
      const checkResp = await fetch(
        `${baseUrl}/api/sheets/idempotency?keys=${encodeURIComponent(`EXP_${expStudents[0].id}_d1_k1,NON_EXISTENT_KEY`)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const checkJson = (await checkResp.json()) as any;
      assert.equal(checkJson.ok, true);
      assert.equal(checkJson.results[`EXP_${expStudents[0].id}_d1_k1`].found, true);
      assert.equal(checkJson.results['NON_EXISTENT_KEY'].found, false);

      console.log('✅ Scenario 6b & 7b Passed: Express /mutate-batch + /idempotency enforces zero duplicates & OCC cleanly');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    console.log('\n=================================================================');
    console.log('🎉 ALL 7+ SYNC TIMEOUT, BATCHING & IDEMPOTENCY SCENARIOS PASSED!');
    console.log('=================================================================\n');
  } finally {
    globalThis.fetch = originalFetch;
    setAppsScriptUrl('');
    setRelayKey('');
    clearBatchUnsupportedCache();
    await cleanStores();
  }
}

runTests().catch((err) => {
  console.error('❌ Sync Timeout & Batch Test Suite Failed:', err);
  process.exit(1);
});
