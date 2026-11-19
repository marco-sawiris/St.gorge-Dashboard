import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {
  idbClearMutations,
  idbGetPendingMutations,
  idbQueueMutation
} from '../services/indexedDbService';
import {
  buildAppsScriptSinglePayload,
  executeProcessOfflineQueue,
  verifyMutationsAfterTimeout
} from '../context/AppContext';
import {
  RemotePersistenceProof,
  validateRemotePersistenceProof,
  validateTimeoutIdempotencyEntry
} from '../services/remotePersistenceVerification';
import {
  getCairoTodayIsoDate,
  resolveFollowupCairoDates
} from '../utils/arabicUtils';
import type { AuthUser, OfflineMutation } from '../types/auth';

// Isolated in-memory localStorage & navigator mocks (ZERO real browser storage, ZERO live network)
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
  setItem: (k: string, v: string) => storageMap.set(k, String(v)),
  removeItem: (k: string) => storageMap.delete(k),
  clear: () => storageMap.clear()
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true }
});

const TEST_USER: AuthUser = {
  userId: 'admin-433',
  username: 'admin',
  displayName: 'أمين الخدمة',
  role: 'admin',
  token: 'test-jwt-433'
};

const TEST_SHEET = 'فصل الأنبا كاراس';
const TEST_APPS_SCRIPT_URL = 'https://mock-apps-script.local/exec';

function makeJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeAttendanceMutation(overrides: Partial<OfflineMutation> = {}): OfflineMutation {
  const id = overrides.id || `ATT_MUT_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    action: 'attendance',
    studentId: overrides.studentId || 'STU_101',
    studentCode: overrides.studentCode || '101',
    studentName: overrides.studentName || 'مارك جرجس',
    sourceSheet: overrides.sourceSheet || TEST_SHEET,
    payload: {
      friday: '2026-04-17',
      isPresent: true,
      ...(overrides.payload || {})
    },
    expectedVersion: overrides.expectedVersion ?? 2,
    timestamp: overrides.timestamp ?? Date.now(),
    retryCount: overrides.retryCount ?? 0,
    status: overrides.status ?? 'pending',
    ...overrides
  };
}

function makeFollowupMutation(overrides: Partial<OfflineMutation> = {}): OfflineMutation {
  const id = overrides.id || `FU_MUT_${Math.random().toString(36).slice(2, 8)}`;
  const recordId = overrides.payload?.recordId || `rec_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    action: 'followup',
    studentId: overrides.studentId || 'STU_202',
    studentCode: overrides.studentCode || '202',
    studentName: overrides.studentName || 'بيشوي عماد',
    sourceSheet: overrides.sourceSheet || TEST_SHEET,
    payload: {
      friday: '2026-04-17',
      date: '2026-04-15',
      method: 'تم تليفونياً',
      callOutcome: 'تم التواصل',
      notes: 'بخير وسيحضر الجمعة',
      recordId,
      ...(overrides.payload || {})
    },
    expectedVersion: overrides.expectedVersion ?? 3,
    timestamp: overrides.timestamp ?? Date.now(),
    retryCount: overrides.retryCount ?? 0,
    status: overrides.status ?? 'pending',
    ...overrides
  };
}

function makeValidAttendanceProof(mut: OfflineMutation, row = 12): RemotePersistenceProof {
  return {
    mutationId: mut.id,
    persisted: true,
    operation: 'attendance',
    studentId: mut.studentId,
    friday: String(mut.payload?.friday || mut.payload?.date),
    sheetName: mut.sourceSheet,
    row,
    newVersion: (mut.expectedVersion || 1) + 1,
    verifiedAt: '2026-04-17T10:00:00.000Z'
  };
}

function makeValidFollowupProof(mut: OfflineMutation, followupLogRow = 44): RemotePersistenceProof {
  return {
    mutationId: mut.id,
    persisted: true,
    operation: 'followup',
    studentId: mut.studentId,
    friday: String(mut.payload?.friday),
    date: String(mut.payload?.date || ''),
    sheetName: mut.sourceSheet,
    recordId: String(mut.payload?.recordId),
    followupLogAppended: true,
    followupLogRow,
    row: 15,
    newVersion: (mut.expectedVersion || 1) + 1,
    verifiedAt: '2026-04-15T18:30:00.000Z'
  };
}

async function resetTestEnv(appsScriptUrl = TEST_APPS_SCRIPT_URL) {
  storageMap.clear();
  if (appsScriptUrl) {
    storageMap.set('stgorge_apps_script_url', appsScriptUrl);
  }
  await idbClearMutations();
}

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`❌ [FAIL] ${name}`);
    console.error('   ', err?.stack || err);
  }
}

async function main() {
  console.log('=== Phase 4.3.3 — Remote Persistence Verification & Timeout Protection Tests ===');

  // 1. Generic HTTP 200 + { ok: true } without persistence proof retains mutation (single & batch)
  await runTest('1. Generic HTTP 200 { ok: true } without persistence proof retains mutation (single)', async () => {
    await resetTestEnv();
    const mut = makeAttendanceMutation({ id: 'MUT_BARE_OK_SINGLE' });
    await idbQueueMutation(mut);

    globalThis.fetch = (async () =>
      makeJsonResponse({ ok: true, status: 200, row: 12, mutationId: mut.id })) as any;

    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true
    });

    assert.equal(report.success, false, 'Bare { ok: true } must NOT report success');
    assert.equal(report.sentCount, 0, 'Bare { ok: true } must NOT increment sentCount');
    assert.equal(report.remainingCount, 1, 'Mutation must remain safely retained in IndexedDB');

    const remaining = await idbGetPendingMutations();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, mut.id, 'Immutable mutation ID must be preserved');
    assert.equal(remaining[0].status, 'timeout_unknown');
    assert.equal(remaining[0].verificationOutcome, 'unknown');
    assert.ok(typeof remaining[0].nextRetryAt === 'number' && remaining[0].nextRetryAt > Date.now());
  });

  // 2. Valid structured proof permits deletion of exact matching mutation (attendance, followup, update, add)
  await runTest('2. Valid structured proof permits deletion for attendance, followup, update, and add', async () => {
    await resetTestEnv();
    const attMut = makeAttendanceMutation({ id: 'MUT_VALID_ATT', studentId: 'S1', timestamp: 1000 });
    const fuMut = makeFollowupMutation({ id: 'MUT_VALID_FU', studentId: 'S2', timestamp: 2000 });
    const updMut: OfflineMutation = {
      id: 'MUT_VALID_UPD',
      action: 'update',
      studentId: 'S3',
      studentCode: '303',
      studentName: 'مينا مجدي',
      sourceSheet: TEST_SHEET,
      payload: { phoneStudent: '01200000000' },
      expectedVersion: 1,
      timestamp: 3000,
      retryCount: 0,
      status: 'pending'
    };
    const addMut: OfflineMutation = {
      id: 'MUT_VALID_ADD',
      action: 'add',
      studentId: 'S4',
      studentCode: '404',
      studentName: 'كيرلس هاني',
      sourceSheet: TEST_SHEET,
      payload: { name: 'كيرلس هاني' },
      expectedVersion: 1,
      timestamp: 4000,
      retryCount: 0,
      status: 'pending'
    };

    for (const m of [attMut, fuMut, updMut, addMut]) {
      await idbQueueMutation(m);
    }

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.idempotencyKey === attMut.id) {
        return makeJsonResponse({ ok: true, proof: makeValidAttendanceProof(attMut, 7) });
      }
      if (body.idempotencyKey === fuMut.id) {
        return makeJsonResponse({ ok: true, proof: makeValidFollowupProof(fuMut, 25) });
      }
      if (body.idempotencyKey === updMut.id) {
        return makeJsonResponse({
          ok: true,
          proof: {
            mutationId: updMut.id,
            persisted: true,
            operation: 'update',
            studentId: updMut.studentId,
            sheetName: updMut.sourceSheet,
            row: 19,
            verifiedAt: '2026-04-17T11:00:00.000Z'
          }
        });
      }
      if (body.idempotencyKey === addMut.id) {
        return makeJsonResponse({
          ok: true,
          proof: {
            mutationId: addMut.id,
            persisted: true,
            operation: 'add',
            studentId: addMut.studentId,
            sheetName: addMut.sourceSheet,
            row: 50,
            recordId: 'ROW_50',
            verifiedAt: '2026-04-17T11:05:00.000Z'
          }
        });
      }
      return makeJsonResponse({ ok: false, error: 'unexpected' }, 400);
    }) as any;

    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true
    });

    assert.equal(report.success, true);
    assert.equal(report.sentCount, 4);
    assert.equal(report.remainingCount, 0);
    assert.equal((await idbGetPendingMutations()).length, 0);
  });

  // 3. Proof with mismatched mutationId is rejected and retains mutation
  await runTest('3. Proof with mismatched mutationId is rejected and retains mutation', async () => {
    await resetTestEnv();
    const mut = makeAttendanceMutation({ id: 'MUT_EXPECTED_ID' });
    await idbQueueMutation(mut);

    const badProof = { ...makeValidAttendanceProof(mut), mutationId: 'MUT_DIFFERENT_ID' };
    const directCheck = validateRemotePersistenceProof(mut, { ok: true, proof: badProof });
    assert.equal(directCheck.valid, false);
    assert.equal(directCheck.reason, 'mutation_id_mismatch');

    globalThis.fetch = (async () => makeJsonResponse({ ok: true, proof: badProof })) as any;

    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true
    });
    assert.equal(report.sentCount, 0);
    assert.equal(report.remainingCount, 1);
    assert.equal((await idbGetPendingMutations())[0].id, mut.id);
  });

  // 4. Proof with mismatched studentId is rejected (name-only match is NOT accepted)
  await runTest('4. Proof with mismatched studentId is rejected and retains mutation', async () => {
    await resetTestEnv();
    const mut = makeAttendanceMutation({ id: 'MUT_STU_CHECK', studentId: 'STU_REAL_1', studentName: 'مارك جرجس' });
    await idbQueueMutation(mut);

    const wrongStudentProof = {
      ...makeValidAttendanceProof(mut),
      studentId: 'STU_OTHER_999',
      studentName: mut.studentName // Matching name alone MUST NOT pass
    };
    const directCheck = validateRemotePersistenceProof(mut, { ok: true, proof: wrongStudentProof });
    assert.equal(directCheck.valid, false);
    assert.equal(directCheck.reason, 'student_id_mismatch');

    globalThis.fetch = (async () => makeJsonResponse({ ok: true, proof: wrongStudentProof })) as any;
    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true
    });
    assert.equal(report.sentCount, 0);
    assert.equal((await idbGetPendingMutations()).length, 1);
  });

  // 5. Proof with mismatched operation, sheetName, or friday date is rejected
  await runTest('5. Proof with mismatched operation, sheetName, or friday date is rejected', async () => {
    const attMut = makeAttendanceMutation({
      id: 'MUT_MISMATCH_FIELDS',
      sourceSheet: 'فصل الأنبا كاراس',
      payload: { friday: '2026-04-17', isPresent: true }
    });

    const wrongFriday = validateRemotePersistenceProof(attMut, {
      ok: true,
      proof: { ...makeValidAttendanceProof(attMut), friday: '2026-04-24' }
    });
    assert.equal(wrongFriday.valid, false);
    assert.equal(wrongFriday.reason, 'attendance_friday_mismatch');

    const wrongSheet = validateRemotePersistenceProof(attMut, {
      ok: true,
      proof: { ...makeValidAttendanceProof(attMut), sheetName: 'فصل البابا شنودة' }
    });
    assert.equal(wrongSheet.valid, false);
    assert.equal(wrongSheet.reason, 'sheet_name_mismatch');

    const wrongOp = validateRemotePersistenceProof(attMut, {
      ok: true,
      proof: { ...makeValidAttendanceProof(attMut), operation: 'update' }
    });
    assert.equal(wrongOp.valid, false);
    assert.equal(wrongOp.reason, 'operation_mismatch');

    const wrongPresent = validateRemotePersistenceProof(attMut, {
      ok: true,
      proof: { ...makeValidAttendanceProof(attMut), isPresent: false }
    });
    assert.equal(wrongPresent.valid, false);
    assert.equal(wrongPresent.reason, 'attendance_state_mismatch');
  });

  // 6. Followup verification does NOT accept attendance proof, missing log confirmation, or wrong recordId
  await runTest('6. Followup verification rejects attendance proof, missing followupLogAppended, and wrong recordId', async () => {
    const fuMut = makeFollowupMutation({ id: 'MUT_FU_STRICT' });

    // Attendance proof must NEVER verify a followup mutation
    const crossOp = validateRemotePersistenceProof(fuMut, {
      ok: true,
      proof: {
        mutationId: fuMut.id,
        persisted: true,
        operation: 'attendance',
        studentId: fuMut.studentId,
        friday: fuMut.payload.friday,
        sheetName: fuMut.sourceSheet,
        row: 10
      }
    });
    assert.equal(crossOp.valid, false);
    assert.equal(crossOp.reason, 'operation_mismatch');

    // Followup proof without followupLogAppended === true must be rejected
    const missingLog = validateRemotePersistenceProof(fuMut, {
      ok: true,
      proof: { ...makeValidFollowupProof(fuMut), followupLogAppended: false }
    });
    assert.equal(missingLog.valid, false);
    assert.equal(missingLog.reason, 'followup_log_not_confirmed');

    // Followup proof with wrong recordId must be rejected
    const wrongRecordId = validateRemotePersistenceProof(fuMut, {
      ok: true,
      proof: { ...makeValidFollowupProof(fuMut), recordId: 'different-rec-id' }
    });
    assert.equal(wrongRecordId.valid, false);
    assert.equal(wrongRecordId.reason, 'followup_record_id_mismatch');

    // Followup proof where server substituted today's date for friday must be rejected
    const substitutedFriday = validateRemotePersistenceProof(fuMut, {
      ok: true,
      proof: { ...makeValidFollowupProof(fuMut), friday: '2026-04-15' }
    });
    assert.equal(substitutedFriday.valid, false);
    assert.equal(substitutedFriday.reason, 'followup_friday_mismatch');

    // Valid followup proof passes
    const okProof = validateRemotePersistenceProof(fuMut, {
      ok: true,
      proof: makeValidFollowupProof(fuMut)
    });
    assert.equal(okProof.valid, true);
    assert.equal(okProof.outcome, 'verified_persisted');
  });

  // 7. Attendance verification does NOT accept followup proof or missing remote target
  await runTest('7. Attendance verification rejects followup proof and missing remote row/recordId', async () => {
    const attMut = makeAttendanceMutation({ id: 'MUT_ATT_STRICT' });

    const crossOp = validateRemotePersistenceProof(attMut, {
      ok: true,
      proof: {
        mutationId: attMut.id,
        persisted: true,
        operation: 'followup',
        studentId: attMut.studentId,
        friday: attMut.payload.friday,
        sheetName: attMut.sourceSheet,
        followupLogAppended: true,
        recordId: 'rec_1'
      }
    });
    assert.equal(crossOp.valid, false);
    assert.equal(crossOp.reason, 'operation_mismatch');

    const missingTarget = validateRemotePersistenceProof(attMut, {
      ok: true,
      proof: {
        mutationId: attMut.id,
        persisted: true,
        operation: 'attendance',
        studentId: attMut.studentId,
        friday: attMut.payload.friday,
        sheetName: attMut.sourceSheet
      }
    });
    assert.equal(missingTarget.valid, false);
    assert.equal(missingTarget.reason, 'attendance_missing_remote_target');
  });

  // 8. Followup timeout verification supports intended mutation identity
  await runTest('8. Followup timeout verification confirms ONLY with valid followup persistence proof', async () => {
    await resetTestEnv();
    const fuMut = makeFollowupMutation({ id: 'MUT_FU_TIMEOUT_VERIFY' });
    await idbQueueMutation(fuMut);

    let callCount = 0;
    let capturedCheckBody: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      callCount++;
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.action === 'followup') {
        const abortErr = new Error('The operation was aborted due to timeout');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (body.action === 'checkIdempotency') {
        capturedCheckBody = body;
        return makeJsonResponse({
          ok: true,
          results: {
            [fuMut.id]: {
              found: true,
              proof: makeValidFollowupProof(fuMut, 88)
            }
          }
        });
      }
      return makeJsonResponse({ ok: false }, 500);
    }) as any;

    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true
    });

    assert.equal(callCount, 2, 'Should perform 1 write + 1 checkIdempotency call');
    assert.ok(Array.isArray(capturedCheckBody?.mutations), 'checkIdempotency should include structured mutation metadata');
    assert.equal(capturedCheckBody.mutations[0].operation, 'followup');
    assert.equal(capturedCheckBody.mutations[0].friday, '2026-04-17');
    assert.equal(capturedCheckBody.mutations[0].recordId, fuMut.payload.recordId);
    assert.equal(report.success, true);
    assert.equal(report.verifiedPostTimeoutCount, 1);
    assert.equal((await idbGetPendingMutations()).length, 0);
  });

  // 9. Attendance timeout verification supports intended mutation identity (and rejects weak/unproved found:true)
  await runTest('9. Attendance timeout verification confirms with valid proof and rejects unproved found:true', async () => {
    await resetTestEnv();
    const attVerified = makeAttendanceMutation({ id: 'MUT_ATT_TV_OK', studentId: 'S_OK' });
    const attWeak = makeAttendanceMutation({ id: 'MUT_ATT_TV_WEAK', studentId: 'S_WEAK' });

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.action, 'checkIdempotency');
      return makeJsonResponse({
        ok: true,
        results: {
          [attVerified.id]: {
            found: true,
            response: { ok: true, proof: makeValidAttendanceProof(attVerified, 21) }
          },
          [attWeak.id]: {
            // Legacy un-upgraded server returning found:true + bare { ok: true } MUST NOT delete!
            found: true,
            response: { ok: true, row: 22 }
          }
        }
      });
    }) as any;

    const res = await verifyMutationsAfterTimeout(
      [attVerified, attWeak],
      TEST_APPS_SCRIPT_URL,
      TEST_USER,
      5000
    );

    assert.deepEqual(res.verifiedIds, [attVerified.id]);
    assert.equal(res.outcomes[attVerified.id].outcome, 'verified_persisted');
    assert.equal(res.outcomes[attWeak.id].outcome, 'unknown');
    assert.equal(res.unconfirmedMutations.length, 1);
    assert.equal(res.unconfirmedMutations[0].id, attWeak.id);
  });

  // 10. Inconclusive / not_found timeout verification retains mutation with immutable ID and Phase 4.3.2 backoff
  await runTest('10. Timeout verification not_found_retryable & unknown retain mutation with backoff and immutable ID', async () => {
    await resetTestEnv();
    const mut = makeFollowupMutation({ id: 'MUT_FU_NOT_FOUND_RETRYABLE' });
    await idbQueueMutation(mut);

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.action === 'followup') {
        const abortErr = new Error('Timeout');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return makeJsonResponse({
        ok: true,
        results: {
          [mut.id]: { found: false }
        }
      });
    }) as any;

    const baseNow = 1_750_000_000_000;
    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: baseNow
    });

    assert.equal(report.success, false);
    assert.equal(report.sentCount, 0);
    const remaining = await idbGetPendingMutations();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, mut.id);
    assert.equal(remaining[0].status, 'timeout_unknown');
    assert.equal(remaining[0].verificationOutcome, 'not_found_retryable');
    assert.equal(remaining[0].retryCount, 1);
    assert.ok(remaining[0].nextRetryAt! > baseNow, 'Phase 4.3.2 exponential backoff nextRetryAt must be set');
  });

  // 11. Verification service unavailable fails closed with verification_unavailable (never falls back to weak student scan)
  await runTest('11. Verification service unavailable (HTTP 500 / 404 / action غير معروف / network) fails closed', async () => {
    await resetTestEnv();
    const mut = makeAttendanceMutation({ id: 'MUT_VERIFY_UNAVAIL' });
    await idbQueueMutation(mut);

    let fetchCalls = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      fetchCalls++;
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.action === 'attendance') {
        const abortErr = new Error('Timeout');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      // Simulate un-upgraded Apps Script returning action غير معروف
      return makeJsonResponse({ ok: false, error: 'action غير معروف: checkIdempotency' }, 200);
    }) as any;

    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true
    });

    assert.equal(fetchCalls, 2, 'MUST NOT make weak getStudents/Gviz fallback calls');
    assert.equal(report.success, false);
    assert.equal(report.sentCount, 0);
    const remaining = await idbGetPendingMutations();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].verificationOutcome, 'verification_unavailable');
    assert.equal(remaining[0].status, 'timeout_unknown');

    // Also verify HTTP 500 and network throw directly
    globalThis.fetch = (async () => makeJsonResponse({ error: 'Internal Error' }, 500)) as any;
    const res500 = await verifyMutationsAfterTimeout([mut], TEST_APPS_SCRIPT_URL, TEST_USER, 5000);
    assert.equal(res500.verifiedIds.length, 0);
    assert.equal(res500.outcomes[mut.id].outcome, 'verification_unavailable');

    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as any;
    const resNet = await verifyMutationsAfterTimeout([mut], TEST_APPS_SCRIPT_URL, TEST_USER, 5000);
    assert.equal(resNet.verifiedIds.length, 0);
    assert.equal(resNet.outcomes[mut.id].outcome, 'verification_unavailable');
  });

  // 12. Timeout after possible remote write does NOT create a duplicate mutation
  await runTest('12. Timeout after possible remote write preserves single immutable mutation without duplication', async () => {
    await resetTestEnv();
    const mut = makeFollowupMutation({
      id: 'MUT_NO_DUP_ON_TIMEOUT',
      payload: { friday: '2026-04-10', date: '2026-04-08', method: 'زيارة منزلية', recordId: 'REC_STABLE_1' }
    });
    await idbQueueMutation(mut);

    const seenWriteKeys: string[] = [];
    const seenFridays: string[] = [];
    let attempt = 0;

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.action === 'followup') {
        attempt++;
        seenWriteKeys.push(body.idempotencyKey);
        seenFridays.push(body.friday);
        if (attempt === 1) {
          const abortErr = new Error('Timeout');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        return makeJsonResponse({
          ok: true,
          deduplicated: true,
          proof: makeValidFollowupProof(mut, 71)
        });
      }
      return makeJsonResponse({ ok: true, results: { [mut.id]: { found: false } } });
    }) as any;

    const t0 = 1_750_000_000_000;
    await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: t0
    });
    const afterTimeout = await idbGetPendingMutations();
    assert.equal(afterTimeout.length, 1, 'Queue length must remain strictly 1');
    assert.equal(afterTimeout[0].id, 'MUT_NO_DUP_ON_TIMEOUT');
    assert.equal(afterTimeout[0].payload.friday, '2026-04-10');

    // Retry after backoff window passes
    const report2 = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: t0 + 15_000
    });
    assert.equal(report2.success, true);
    assert.equal(report2.sentCount, 1);
    assert.equal(report2.deduplicatedCount, 1);
    assert.deepEqual(seenWriteKeys, ['MUT_NO_DUP_ON_TIMEOUT', 'MUT_NO_DUP_ON_TIMEOUT']);
    assert.deepEqual(seenFridays, ['2026-04-10', '2026-04-10']);
    assert.equal((await idbGetPendingMutations()).length, 0);
  });

  // 13. Batch proof is checked independently for each mutation
  await runTest('13. Batch proof checks every mutation independently (deletes ONLY verified items)', async () => {
    await resetTestEnv();
    const m0 = makeAttendanceMutation({ id: 'BATCH_M0', studentId: 'BS0', timestamp: 1000 });
    const m1 = makeAttendanceMutation({ id: 'BATCH_M1', studentId: 'BS1', timestamp: 2000 });
    const m2 = makeAttendanceMutation({ id: 'BATCH_M2', studentId: 'BS2', timestamp: 3000 });
    const m3 = makeAttendanceMutation({ id: 'BATCH_M3', studentId: 'BS3', timestamp: 4000 });

    for (const m of [m0, m1, m2, m3]) await idbQueueMutation(m);

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.action, 'batch');
      return makeJsonResponse({
        ok: true,
        results: [
          // m0: valid proof -> DELETE
          { ok: true, proof: makeValidAttendanceProof(m0, 10) },
          // m1: generic { ok: true } without proof -> RETAIN!
          { ok: true, status: 200, mutationId: m1.id },
          // m2: proof with wrong studentId -> RETAIN!
          { ok: true, proof: { ...makeValidAttendanceProof(m2, 12), studentId: 'WRONG_STUDENT' } },
          // m3: valid proof -> DELETE
          { ok: true, proof: makeValidAttendanceProof(m3, 13) }
        ]
      });
    }) as any;

    const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true
    });

    assert.equal(report.sentCount, 2, 'Only the 2 verified batch items should be counted as sent');
    assert.equal(report.remainingCount, 2, 'The 2 unverified batch items must remain in IndexedDB');

    const remaining = await idbGetPendingMutations();
    assert.deepEqual(
      remaining.map((m) => m.id).sort(),
      ['BATCH_M1', 'BATCH_M2']
    );
    assert.equal(remaining.find((m) => m.id === 'BATCH_M1')?.verificationOutcome, 'unknown');
    assert.equal(remaining.find((m) => m.id === 'BATCH_M2')?.verificationOutcome, 'unknown');
  });

  // 14. Original friday date and Cairo date are preserved intact through payload building & retries
  await runTest('14. Original friday, date, and recordId are preserved intact across retries (never replaced by todayStr)', async () => {
    const fuMut = makeFollowupMutation({
      id: 'MUT_PRESERVE_DATES',
      payload: {
        friday: '2026-03-27',
        date: '2026-03-24',
        method: 'تم تليفونياً',
        callOutcome: 'لم يتم التواصل',
        recordId: 'REC_ORIG_2026_03_24'
      }
    });

    const payload1 = buildAppsScriptSinglePayload(fuMut, 'RELAY_TEST');
    const payload2 = buildAppsScriptSinglePayload({ ...fuMut, retryCount: 4 }, 'RELAY_TEST');

    assert.equal(payload1.friday, '2026-03-27');
    assert.equal(payload1.date, '2026-03-24');
    assert.equal(payload1.recordId, 'REC_ORIG_2026_03_24');
    assert.equal(payload1.payload.friday, '2026-03-27');
    assert.equal(payload1.payload.date, '2026-03-24');
    assert.equal(payload2.friday, '2026-03-27');
    assert.equal(payload2.date, '2026-03-24');
    assert.equal(payload2.idempotencyKey, fuMut.id);
  });

  // 15. Cairo-local date calculations around midnight and UTC/local boundaries (winter UTC+2 & summer DST UTC+3)
  await runTest('15. Cairo-local date calculations handle midnight & UTC boundaries accurately (EST + DST)', async () => {
    // Winter in Cairo = UTC+2:
    // 2026-01-15T21:59:59Z -> 2026-01-15 23:59:59 Cairo
    const winterBeforeMidnight = new Date('2026-01-15T21:59:59.000Z');
    assert.equal(getCairoTodayIsoDate(winterBeforeMidnight), '2026-01-15');
    // 2026-01-15T22:00:01Z -> 2026-01-16 00:00:01 Cairo (while UTC is STILL 2026-01-15!)
    const winterAfterMidnight = new Date('2026-01-15T22:00:01.000Z');
    assert.equal(winterAfterMidnight.toISOString().split('T')[0], '2026-01-15', 'Sanity: UTC is still Jan 15');
    assert.equal(getCairoTodayIsoDate(winterAfterMidnight), '2026-01-16', 'Cairo must advance to Jan 16 at 00:00 Cairo');
    const winterFollowup = resolveFollowupCairoDates(winterAfterMidnight);
    assert.equal(winterFollowup.date, '2026-01-16');
    assert.equal(winterFollowup.friday, '2026-01-16'); // Jan 16, 2026 is a Friday

    // Friday -> Saturday rollover in Winter (UTC+2):
    // 2026-01-16T21:59:59Z -> Friday 23:59:59 Cairo -> friday stays 2026-01-16
    assert.equal(resolveFollowupCairoDates(new Date('2026-01-16T21:59:59.000Z')).friday, '2026-01-16');
    // 2026-01-16T22:00:01Z -> Saturday 00:00:01 Cairo -> friday rolls to next Friday 2026-01-23
    const satCairoWinter = resolveFollowupCairoDates(new Date('2026-01-16T22:00:01.000Z'));
    assert.equal(satCairoWinter.date, '2026-01-17');
    assert.equal(satCairoWinter.friday, '2026-01-23');

    // Summer DST in Cairo = UTC+3 (Egypt observes DST last Friday of April to last Thursday of October):
    // 2026-07-15T20:59:59Z -> 2026-07-15 23:59:59 Cairo
    assert.equal(getCairoTodayIsoDate(new Date('2026-07-15T20:59:59.000Z')), '2026-07-15');
    // 2026-07-15T21:00:01Z -> 2026-07-16 00:00:01 Cairo (while UTC is STILL 2026-07-15!)
    const summerAfterMidnight = new Date('2026-07-15T21:00:01.000Z');
    assert.equal(summerAfterMidnight.toISOString().split('T')[0], '2026-07-15');
    assert.equal(getCairoTodayIsoDate(summerAfterMidnight), '2026-07-16');
    const summerFollowup = resolveFollowupCairoDates(summerAfterMidnight);
    assert.equal(summerFollowup.date, '2026-07-16');
    assert.equal(summerFollowup.friday, '2026-07-17'); // July 17, 2026 is Friday

    // Explicit friday is strictly preserved
    const explicit = resolveFollowupCairoDates(summerAfterMidnight, '2026-07-10');
    assert.equal(explicit.date, '2026-07-16');
    assert.equal(explicit.friday, '2026-07-10');
  });

  // 16. Phase 4.3.2 compatibility: conflict non-auto-retry, per-student isolation, and backoff respected
  await runTest('16. Phase 4.3.2 compatibility: per-student isolation, backoff, and post-timeout conflict handling', async () => {
    await resetTestEnv();
    // Student A op1 returns bare { ok: true } (unverified -> blocks Student A op2)
    // Student B op1 returns valid proof -> MUST proceed without Head-of-Line Blocking!
    const a1 = makeAttendanceMutation({ id: 'ISO_A1', studentId: 'STU_A', timestamp: 1000 });
    const a2 = makeFollowupMutation({ id: 'ISO_A2', studentId: 'STU_A', timestamp: 2000 });
    const b1 = makeAttendanceMutation({ id: 'ISO_B1', studentId: 'STU_B', timestamp: 3000 });
    for (const m of [a1, a2, b1]) await idbQueueMutation(m);

    const attemptedIds: string[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      attemptedIds.push(body.idempotencyKey);
      if (body.idempotencyKey === a1.id) {
        return makeJsonResponse({ ok: true }); // Missing proof -> unverified
      }
      if (body.idempotencyKey === b1.id) {
        return makeJsonResponse({ ok: true, proof: makeValidAttendanceProof(b1, 31) });
      }
      return makeJsonResponse({ ok: false }, 500);
    }) as any;

    const t0 = 1_760_000_000_000;
    const r1 = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: t0
    });

    assert.deepEqual(attemptedIds, ['ISO_A1', 'ISO_B1'], 'a2 must be blocked by a1; b1 must NOT be HoL-blocked');
    assert.equal(r1.sentCount, 1);
    assert.equal(r1.remainingCount, 2);

    // Immediate second run before backoff expires must NOT re-attempt a1 or overtake with a2
    attemptedIds.length = 0;
    await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: t0 + 500
    });
    assert.deepEqual(attemptedIds, [], 'Backoff schedule + per-student barrier must be respected');

    // Verify timeout conflict entry transitions cleanly to 'conflict' and never auto-retries
    const conflictMut = makeAttendanceMutation({ id: 'CONFLICT_TV', studentId: 'STU_C', timestamp: 5000 });
    const conflictEntry = validateTimeoutIdempotencyEntry(conflictMut, {
      found: true,
      status: 409,
      response: { ok: false, status: 409, error: 'تعارض إصدار' }
    });
    assert.equal(conflictEntry.outcome, 'conflict');
  });

  // 17. Post-timeout conflict in executeProcessOfflineQueue marks conflict and never auto-retries
  await runTest('17. Post-timeout 409 conflict marks conflict state without deleting or auto-retrying', async () => {
    await resetTestEnv();
    const mut = makeAttendanceMutation({ id: 'MUT_TIMEOUT_409', studentId: 'STU_409' });
    await idbQueueMutation(mut);

    let writeAttempts = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.action === 'attendance') {
        writeAttempts++;
        const abortErr = new Error('Timeout');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return makeJsonResponse({
        ok: true,
        results: {
          [mut.id]: {
            found: true,
            status: 409,
            error: 'تم تعديل السجل من جهاز آخر'
          }
        }
      });
    }) as any;

    const t0 = 1_770_000_000_000;
    const report1 = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: t0
    });
    assert.equal(report1.conflictCount, 1);
    assert.equal(report1.sentCount, 0);

    const remaining = await idbGetPendingMutations();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].status, 'conflict');
    assert.equal(remaining[0].verificationOutcome, 'conflict');
    assert.equal(remaining[0].nextRetryAt, undefined);

    // Subsequent auto-run even far in future MUST NOT auto-retry conflict
    await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
      silent: true,
      disableBatch: true,
      nowMs: t0 + 999_999
    });
    assert.equal(writeAttempts, 1, 'Conflicted mutation must never auto-retry');
  });

  console.log(`\n=== Phase 4.3.3 Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled test runner error:', err);
  process.exit(1);
});
