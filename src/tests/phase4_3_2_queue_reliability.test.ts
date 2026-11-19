import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Mock localStorage & window/navigator globals in Node BEFORE importing AppContext
const memStorage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memStorage.has(k) ? memStorage.get(k)! : null),
  setItem: (k: string, v: string) => {
    memStorage.set(k, String(v));
  },
  removeItem: (k: string) => {
    memStorage.delete(k);
  },
  clear: () => {
    memStorage.clear();
  }
};

const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const mutableNavigator: Record<string, any> = {
  onLine: true,
  locks: undefined
};
if (!navDescriptor || navDescriptor.configurable) {
  Object.defineProperty(globalThis, 'navigator', {
    value: mutableNavigator,
    configurable: true,
    writable: true
  });
}

import { Student } from '../types/student';
import { OfflineMutation, AuthUser } from '../types/auth';
import {
  idbSaveStudents,
  idbGetStudents,
  idbGetPendingMutations,
  idbClearMutations,
  idbQueueMutation,
  idbMarkMutationConflict,
  idbUpdateMutationError,
  idbResetMutationRetry,
  clearPendingManualRetryTarget,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicBatchRecordAttendanceWithMutations
} from '../services/indexedDbService';
import {
  executeProcessOfflineQueue,
  evaluateQueueMutationEligibility,
  hasDueQueueMutations,
  withOfflineQueueLock,
  isPermanentMutationFailure,
  clearBatchUnsupportedCache,
  MAX_AUTO_MUTATION_RETRIES,
  OFFLINE_QUEUE_LOCK_NAME
} from '../context/AppContext';

const MOCK_ADMIN: AuthUser = {
  userId: 'u_admin',
  username: 'admin',
  displayName: 'أمين الخدمة',
  role: 'admin',
  token: 'test-token'
};

function makeStudent(id: string, code: string, name: string, version = 1): Student {
  return {
    id,
    code,
    name,
    servant: 'خادم تجريبي',
    phoneStudent: '01000000001',
    phoneParent1: '',
    phoneParent2: '',
    birthDate: '2012-05-01',
    area: 'شبرا',
    address: 'عنوان تجريبي',
    notes: '',
    sourceSheet: 'نشط',
    att: {},
    attendanceStatus: 'غائب',
    attendanceTotal: 0,
    attendanceMonth: 0,
    lastAttendance: '',
    followupStatus: 'بدون',
    fu: {},
    version,
    hasRemoteVersion: true
  };
}

function makeAttendanceMutation(
  id: string,
  studentId: string,
  studentCode: string,
  studentName: string,
  friday: string,
  isPresent: boolean,
  timestamp: number,
  overrides: Partial<OfflineMutation> = {}
): OfflineMutation {
  return {
    id,
    action: 'attendance',
    studentId,
    studentCode,
    studentName,
    sourceSheet: 'نشط',
    payload: { friday, isPresent },
    expectedVersion: 1,
    timestamp,
    retryCount: 0,
    status: 'pending',
    ...overrides
  };
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeProofFromRequestBody(body: any, row = 10) {
  const op = body?.action || body?.mutation?.action || 'attendance';
  const mutId = body?.idempotencyKey || body?.id || body?.mutation?.id;
  const studentId = body?.studentId || body?.mutation?.studentId;
  const sheetName = body?.sheet || body?.sourceSheet || body?.mutation?.sourceSheet || 'نشط';
  const friday = body?.friday || body?.date || body?.payload?.friday || '2026-04-17';
  const recordId = body?.recordId || body?.payload?.recordId;
  return {
    mutationId: mutId,
    persisted: true as const,
    operation: op,
    studentId,
    sheetName,
    ...(op === 'attendance' || op === 'followup' ? { friday } : {}),
    ...(op === 'followup'
      ? {
          followupLogAppended: true,
          followupLogRow: row + 50,
          ...(recordId ? { recordId } : { recordId: `rec_${mutId}` })
        }
      : {}),
    row,
    verifiedAt: '2026-04-17T10:00:00.000Z'
  };
}

function verifiedJsonResponse(body: any, row = 10): Response {
  return jsonResponse({ ok: true, proof: makeProofFromRequestBody(body, row) });
}

async function resetTestEnvironment() {
  clearBatchUnsupportedCache();
  clearPendingManualRetryTarget();
  await idbClearMutations();
  mutableNavigator.onLine = true;
  mutableNavigator.locks = undefined;
  localStorage.clear();
  localStorage.setItem('stgorge_apps_script_url', 'https://mock-apps-script.local/exec');
  localStorage.setItem('stgorge_relay_key', 'mock-relay-key');
}

async function runTests() {
  console.log('=== Phase 4.3.2 Offline Queue Reliability & Retry Protection Test Suite ===\n');

  // ---------------------------------------------------------------------------
  // Test 1: nextRetryAt in the future prevents automatic sending
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const futureMut = makeAttendanceMutation(
      'mut_future_1',
      'stu_1',
      '101',
      'مارك مينا',
      '2026-04-17',
      true,
      now - 5000,
      { status: 'failed', retryCount: 1, nextRetryAt: now + 15_000, lastError: 'HTTP 500' }
    );
    await idbQueueMutation(futureMut);

    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      return jsonResponse({ ok: true });
    };

    const report = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now,
      isAutoTrigger: true
    });

    assert.equal(fetchCalls, 0, 'Mutation with future nextRetryAt must NOT trigger any HTTP call');
    assert.equal(report.sentCount, 0);
    assert.equal(report.remainingCount, 1);
    assert.equal(hasDueQueueMutations([futureMut], now), false);
    console.log('✓ Test 1 passed: nextRetryAt in the future prevents automatic sending (0 fetch calls)');
  }

  // ---------------------------------------------------------------------------
  // Test 2: A due mutation becomes eligible when its retry time arrives
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const dueMut = makeAttendanceMutation(
      'mut_due_1',
      'stu_1',
      '101',
      'مارك مينا',
      '2026-04-17',
      true,
      now - 10_000,
      { status: 'failed', retryCount: 1, nextRetryAt: now + 4_000 }
    );
    await idbQueueMutation(dueMut);

    let fetchCalls = 0;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      fetchCalls++;
      return verifiedJsonResponse(JSON.parse(init?.body || '{}'));
    };

    // Before due time -> 0 calls
    await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 3_999,
      isAutoTrigger: true
    });
    assert.equal(fetchCalls, 0, 'Must still be deferred 1ms before nextRetryAt');

    // Exactly at/after due time -> eligible & sent!
    const dueReport = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 4_000,
      isAutoTrigger: true
    });
    assert.equal(fetchCalls, 1, 'Due mutation must be sent once retry time arrives');
    assert.equal(dueReport.success, true);
    assert.equal(dueReport.sentCount, 1);
    assert.equal((await idbGetPendingMutations()).length, 0);
    console.log('✓ Test 2 passed: Due mutation becomes eligible and sends when nextRetryAt arrives');
  }

  // ---------------------------------------------------------------------------
  // Test 3: conflict is NEVER automatically retried
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const conflictMut = makeAttendanceMutation(
      'mut_conflict_1',
      'stu_a',
      '101',
      'بيشوي عادل',
      '2026-04-17',
      true,
      now - 60_000
    );
    await idbQueueMutation(conflictMut);
    await idbMarkMutationConflict(conflictMut.id, 'تعارض إصدار (HTTP 409)');

    let fetchCalls = 0;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      return jsonResponse({ ok: true });
    };

    for (let i = 0; i < 3; i++) {
      const rep = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
        nowMs: now + i * 60_000,
        isAutoTrigger: true
      });
      assert.equal(rep.sentCount, 0);
      assert.equal(rep.conflictCount, 1);
    }

    assert.equal(fetchCalls, 0, 'Conflicting mutation must NEVER be automatically retried');
    const pending = await idbGetPendingMutations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'conflict');
    assert.equal(hasDueQueueMutations(pending, now + 999_999), false);
    assert.equal(evaluateQueueMutationEligibility(pending, { nowMs: now }).nextEarliestRetryAt, null);
    console.log('✓ Test 3 passed: conflict is never automatically retried and schedules no backoff timer');
  }

  // ---------------------------------------------------------------------------
  // Test 4: Student A conflict (or failure) does NOT block Student B
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const mutA = makeAttendanceMutation('mut_A1', 'stu_A', '101', 'الطالب أ', '2026-04-17', true, now + 100);
    const mutB = makeAttendanceMutation('mut_B1', 'stu_B', '102', 'الطالب ب', '2026-04-17', true, now + 200);
    await idbQueueMutation(mutA);
    await idbQueueMutation(mutB);
    await idbMarkMutationConflict(mutA.id, 'HTTP 409 on Student A');

    const sentIds: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      sentIds.push(body.idempotencyKey || body.id);
      return verifiedJsonResponse(body);
    };

    const report = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 500,
      isAutoTrigger: true
    });

    assert.deepEqual(sentIds, ['mut_B1'], 'Only Student B must be sent; Student A conflict must not block Student B');
    assert.equal(report.sentCount, 1);
    assert.equal(report.remainingCount, 1);
    const remaining = await idbGetPendingMutations();
    assert.equal(remaining[0].id, 'mut_A1');
    assert.equal(remaining[0].status, 'conflict');

    // Also verify runtime 409 during a pass does NOT block Student C queued right behind Student A
    const mutA_live = makeAttendanceMutation('mut_A_live', 'stu_A2', '103', 'الطالب أ2', '2026-04-17', true, now + 300);
    const mutC_live = makeAttendanceMutation('mut_C_live', 'stu_C', '104', 'الطالب ج', '2026-04-17', true, now + 400);
    await idbQueueMutation(mutA_live);
    await idbQueueMutation(mutC_live);

    const sentLive: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const id = body.idempotencyKey || body.id;
      sentLive.push(id);
      if (id === 'mut_A_live') {
        return jsonResponse({ ok: false, status: 409, error: 'Version conflict' }, 409);
      }
      return verifiedJsonResponse(body);
    };

    const reportLive = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 1000,
      isAutoTrigger: true
    });
    assert.deepEqual(sentLive, ['mut_A_live', 'mut_C_live'], 'Runtime 409 on Student A2 must NOT block Student C');
    assert.equal(reportLive.sentCount, 1);
    const remAfterLive = await idbGetPendingMutations();
    assert.equal(remAfterLive.some((m) => m.id === 'mut_C_live'), false);
    assert.equal(remAfterLive.find((m) => m.id === 'mut_A_live')?.status, 'conflict');
    console.log('✓ Test 4 passed: Student A conflict (stored or runtime) does not block Student B/C');
  }

  // ---------------------------------------------------------------------------
  // Test 5: Later operation for Student A cannot bypass earlier unresolved op for Student A
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    // Case 5a: Earlier conflict blocks later op for Student A, while Student B still passes
    const mutA1 = makeAttendanceMutation('mut_A_old', 'stu_A', '101', 'الطالب أ', '2026-04-10', true, now + 100);
    const mutA2 = makeAttendanceMutation('mut_A_new', 'stu_A', '101', 'الطالب أ', '2026-04-17', true, now + 200);
    const mutB1 = makeAttendanceMutation('mut_B_ok', 'stu_B', '102', 'الطالب ب', '2026-04-17', true, now + 300);
    await idbQueueMutation(mutA1);
    await idbQueueMutation(mutA2);
    await idbQueueMutation(mutB1);
    await idbMarkMutationConflict(mutA1.id, 'Conflict on earlier op');

    const sentIds: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      sentIds.push(body.idempotencyKey || body.id);
      return verifiedJsonResponse(body);
    };

    await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 1000,
      isAutoTrigger: true
    });
    assert.deepEqual(sentIds, ['mut_B_ok'], 'mut_A_new MUST NOT overtake mut_A_old; Student B MUST pass');

    // Case 5b: Runtime failure on mut_X1 blocks mut_X2 in the SAME pass, while mut_Y1 passes
    await resetTestEnvironment();
    const mutX1 = makeAttendanceMutation('mut_X1', 'stu_X', '201', 'الطالب س', '2026-04-10', true, now + 100);
    const mutX2 = makeAttendanceMutation('mut_X2', 'stu_X', '201', 'الطالب س', '2026-04-17', true, now + 200);
    const mutY1 = makeAttendanceMutation('mut_Y1', 'stu_Y', '202', 'الطالب ص', '2026-04-17', true, now + 300);
    await idbQueueMutation(mutX1);
    await idbQueueMutation(mutX2);
    await idbQueueMutation(mutY1);

    const sentOrder: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const id = body.idempotencyKey || body.id;
      sentOrder.push(id);
      if (id === 'mut_X1') {
        return jsonResponse({ ok: false, status: 400, error: 'تاريخ غير صحيح' }, 400);
      }
      return verifiedJsonResponse(body);
    };

    await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 1000,
      disableBatch: true,
      isAutoTrigger: true
    });
    assert.deepEqual(sentOrder, ['mut_X1', 'mut_Y1'], 'mut_X2 must be blocked after mut_X1 fails, while mut_Y1 proceeds');
    const remX = await idbGetPendingMutations();
    assert.equal(remX.length, 2);
    assert.equal(remX.find((m) => m.id === 'mut_X1')?.isPermanentError, true);
    assert.equal(remX.find((m) => m.id === 'mut_X2')?.status, 'pending');
    console.log('✓ Test 5 passed: Later op for Student A cannot bypass earlier unresolved op for Student A');
  }

  // ---------------------------------------------------------------------------
  // Test 6: Same-student attendance changed twice (and 3x) offline preserves original expectedVersion
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const baseStudent = makeStudent('stu_ver', '301', 'فادي عماد', 1);
    await idbSaveStudents([baseStudent], 'نشط', true, {
      verified: true,
      isComplete: true,
      sheetName: 'نشط',
      source: 'gviz'
    });

    // Add an unrelated mutation for another Friday (must NOT be deleted!)
    const otherFridayMut = makeAttendanceMutation(
      'mut_other_fri',
      'stu_ver',
      '301',
      'فادي عماد',
      '2026-04-10',
      true,
      1_700_000_000_000,
      { expectedVersion: 1 }
    );
    await idbQueueMutation(otherFridayMut);

    // Offline Toggle #1 on 2026-04-17: present=true, remote expectedVersion=1 -> local student.version=2
    const step1Student: Student = { ...baseStudent, att: { '2026-04-17': true }, version: 2, hasUnsyncedLocalChanges: true };
    const step1Mut = makeAttendanceMutation('mut_tog_1', 'stu_ver', '301', 'فادي عماد', '2026-04-17', true, 1_700_000_001_000, {
      expectedVersion: 1
    });
    const res1 = await idbAtomicRecordAttendanceWithMutation(
      step1Student,
      { id: 'stu_ver__2026-04-17', studentId: 'stu_ver', studentCode: '301', fridayDate: '2026-04-17', status: true, recordedAt: 1000, sourceSheet: 'نشط' },
      step1Mut
    );
    assert.equal(res1.mutation.expectedVersion, 1);
    assert.equal(res1.student.version, 2);

    // Offline Toggle #2 on SAME Friday 2026-04-17: present=false, caller passes local student.version=2 as expectedVersion
    const step2Student: Student = { ...res1.student, att: { '2026-04-17': false }, version: res1.student.version + 1 };
    const step2Mut = makeAttendanceMutation('mut_tog_2', 'stu_ver', '301', 'فادي عماد', '2026-04-17', false, 1_700_000_002_000, {
      expectedVersion: res1.student.version // 2 (inflated!)
    });
    const res2 = await idbAtomicRecordAttendanceWithMutation(
      step2Student,
      { id: 'stu_ver__2026-04-17', studentId: 'stu_ver', studentCode: '301', fridayDate: '2026-04-17', status: false, recordedAt: 2000, sourceSheet: 'نشط' },
      step2Mut
    );
    assert.equal(res2.mutation.expectedVersion, 1, 'Toggle #2 MUST preserve original remote expectedVersion=1');
    assert.equal(res2.student.version, 2, 'Toggle #2 MUST NOT inflate local student.version to 3');

    // Offline Toggle #3 on SAME Friday 2026-04-17: present=true
    const step3Student: Student = { ...res2.student, att: { '2026-04-17': true }, version: res2.student.version + 1 };
    const step3Mut = makeAttendanceMutation('mut_tog_3', 'stu_ver', '301', 'فادي عماد', '2026-04-17', true, 1_700_000_003_000, {
      expectedVersion: res2.student.version
    });
    const res3 = await idbAtomicRecordAttendanceWithMutation(
      step3Student,
      { id: 'stu_ver__2026-04-17', studentId: 'stu_ver', studentCode: '301', fridayDate: '2026-04-17', status: true, recordedAt: 3000, sourceSheet: 'نشط' },
      step3Mut
    );
    assert.equal(res3.mutation.expectedVersion, 1, 'Toggle #3 MUST still preserve original remote expectedVersion=1');

    const storedMuts = await idbGetPendingMutations();
    assert.equal(storedMuts.length, 2, 'Must keep unrelated Friday mutation + latest single mutation for 2026-04-17');
    assert.ok(storedMuts.some((m) => m.id === 'mut_other_fri'), 'Unrelated Friday mutation must never be deleted');
    const latestFriMut = storedMuts.find((m) => m.payload?.friday === '2026-04-17');
    assert.ok(latestFriMut);
    assert.equal(latestFriMut.id, 'mut_tog_3');
    assert.equal(latestFriMut.expectedVersion, 1);
    assert.equal(latestFriMut.payload.isPresent, true);

    const storedStudents = await idbGetStudents();
    assert.equal(storedStudents.find((s) => s.id === 'stu_ver')?.version, 2);

    // Also verify batch superseding preserves original expectedVersion
    const batchFlipMut = makeAttendanceMutation('mut_batch_flip', 'stu_ver', '301', 'فادي عماد', '2026-04-17', false, 1_700_000_004_000, {
      expectedVersion: 5
    });
    await idbAtomicBatchRecordAttendanceWithMutations(
      [res3.student],
      [{ id: 'stu_ver__2026-04-17', studentId: 'stu_ver', studentCode: '301', fridayDate: '2026-04-17', status: false, recordedAt: 4000, sourceSheet: 'نشط' }],
      [batchFlipMut]
    );
    const afterBatch = (await idbGetPendingMutations()).find((m) => m.id === 'mut_batch_flip');
    assert.equal(afterBatch?.expectedVersion, 1, 'Batch attendance superseding must also preserve original expectedVersion=1');
    console.log('✓ Test 6 passed: Repeated offline attendance toggles preserve original remote expectedVersion=1');
  }

  // ---------------------------------------------------------------------------
  // Test 7: Partial batch response [success, failure, success, success]
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const b0 = makeAttendanceMutation('batch_0', 'stu_0', '1', 'طالب 0', '2026-04-17', true, now + 1);
    const b1 = makeAttendanceMutation('batch_1', 'stu_1', '2', 'طالب 1', '2026-04-17', true, now + 2);
    const b2 = makeAttendanceMutation('batch_2', 'stu_2', '3', 'طالب 2', '2026-04-17', true, now + 3);
    const b3 = makeAttendanceMutation('batch_3', 'stu_3', '4', 'طالب 3', '2026-04-17', true, now + 4);
    // Add a follow-up op for stu_1 (failed in batch) AND a follow-up op for stu_4 (independent) AFTER the batch!
    const followStu1 = {
      id: 'followup_stu_1',
      action: 'followup' as const,
      studentId: 'stu_1',
      studentCode: '2',
      studentName: 'طالب 1',
      sourceSheet: 'نشط',
      payload: { friday: '2026-04-17', date: '2026-04-15', recordId: 'rec_fu_1', status: 'تم الاتصال', notes: 'بعد الدفعة' },
      expectedVersion: 2,
      timestamp: now + 5,
      retryCount: 0,
      status: 'pending' as const
    };
    const followStu4 = {
      id: 'followup_stu_4',
      action: 'followup' as const,
      studentId: 'stu_4',
      studentCode: '5',
      studentName: 'طالب 4',
      sourceSheet: 'نشط',
      payload: { friday: '2026-04-17', date: '2026-04-15', recordId: 'rec_fu_4', status: 'تم الاتصال', notes: 'مستقل' },
      expectedVersion: 1,
      timestamp: now + 6,
      retryCount: 0,
      status: 'pending' as const
    };

    for (const m of [b0, b1, b2, b3, followStu1, followStu4]) {
      await idbQueueMutation(m);
    }

    const calledActions: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.action === 'batch') {
        calledActions.push(`batch:${body.mutations.length}`);
        return jsonResponse({
          ok: true,
          results: [
            { ok: true, idempotencyKey: 'batch_0', proof: makeProofFromRequestBody(body.mutations[0], 10) },
            { ok: false, status: 500, error: 'Transient error on item 1' },
            { ok: true, idempotencyKey: 'batch_2', proof: makeProofFromRequestBody(body.mutations[2], 12) },
            { ok: true, idempotencyKey: 'batch_3', proof: makeProofFromRequestBody(body.mutations[3], 13) }
          ]
        });
      }
      calledActions.push(`single:${body.idempotencyKey || body.id}`);
      return verifiedJsonResponse(body);
    };

    const rep = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 100,
      isAutoTrigger: true
    });

    assert.deepEqual(
      calledActions,
      ['batch:4', 'single:followup_stu_4'],
      'Batch must commit 0,2,3; block followup_stu_1 (same student as failed b1); and proceed to independent followup_stu_4!'
    );
    assert.equal(rep.sentCount, 4, '3 confirmed batch items + 1 independent follow-up = 4 sent');
    const rem = await idbGetPendingMutations();
    assert.deepEqual(
      rem.map((m) => m.id),
      ['batch_1', 'followup_stu_1'],
      'Items 0, 2, 3 and stu_4 must be removed; ONLY batch_1 and same-student followup_stu_1 retained'
    );
    assert.equal(rem[0].status, 'failed');
    assert.ok((rem[0].nextRetryAt || 0) > now + 100, 'Failed batch item 1 must have future backoff nextRetryAt');
    console.log('✓ Test 7 passed: Partial batch [success, failure, success, success] removes 0,2,3, retains 1, preserves per-student order');
  }

  // ---------------------------------------------------------------------------
  // Test 8, 9, 10: Backoff NOT bypassed by 20s interval, visibilitychange, or duplicate startup
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const deferredMut = makeAttendanceMutation(
      'mut_backoff_guard',
      'stu_bg',
      '501',
      'مينا جورج',
      '2026-04-17',
      true,
      now - 20_000,
      { status: 'failed', retryCount: 4, nextRetryAt: now + 16_000 }
    );
    await idbQueueMutation(deferredMut);

    let fetchCount = 0;
    (globalThis as any).fetch = async () => {
      fetchCount++;
      return jsonResponse({ ok: true });
    };

    // Simulate 20s interval check at now + 10s (still 6s before nextRetryAt)
    const pendingAt10s = await idbGetPendingMutations();
    const shouldRunInterval = hasDueQueueMutations(pendingAt10s, now + 10_000);
    assert.equal(shouldRunInterval, false, '20s interval MUST NOT trigger while nextRetryAt is still in the future');

    // Simulate visibilitychange event at now + 12s (still 4s before nextRetryAt)
    const shouldRunVisibility = hasDueQueueMutations(pendingAt10s, now + 12_000);
    assert.equal(shouldRunVisibility, false, 'visibilitychange MUST NOT force early retry while nextRetryAt is in the future');

    // Even if processor is invoked directly before due time, 0 fetches occur
    await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 12_000,
      isAutoTrigger: true
    });
    assert.equal(fetchCount, 0);

    // Verify source code wiring in AppContext.tsx for interval, visibilitychange, triggerAutoProcessQueue, and startup
    const appCtxSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/context/AppContext.tsx'), 'utf8');
    // 1. Both interval and visibilitychange delegate to triggerIfDue() which checks hasDueQueueMutations(pending)
    assert.ok(
      appCtxSrc.includes('const triggerIfDue = () =>') &&
        appCtxSrc.includes('if (hasDueQueueMutations(pending))'),
      'AppContext online/visibilitychange/20s-interval listeners must check hasDueQueueMutations(pending)'
    );
    // 2. Startup block (loadCacheAndInitialSync) must NOT call triggerAutoProcessQueueRef before executeSyncData
    const bootIdx = appCtxSrc.indexOf('async function loadCacheAndInitialSync()');
    const bootEndIdx = appCtxSrc.indexOf('const reloadLocalDatabaseState', bootIdx);
    const bootBlock = appCtxSrc.slice(bootIdx, bootEndIdx);
    const execSyncIdx = bootBlock.indexOf('await executeSyncData(');
    assert.ok(execSyncIdx > 0, 'loadCacheAndInitialSync must call executeSyncData');
    const preSyncBoot = bootBlock.slice(0, execSyncIdx);
    assert.equal(
      preSyncBoot.includes('triggerAutoProcessQueueRef.current'),
      false,
      'Startup must NOT fire triggerAutoProcessQueueRef before executeSyncData (eliminates duplicate startup queue run)'
    );
    // 3. triggerAutoProcessQueue must check eligibility BEFORE clearing backoffRetryTimerRef
    const trigIdx = appCtxSrc.indexOf('const triggerAutoProcessQueue = useCallback(');
    const trigBlock = appCtxSrc.slice(trigIdx, trigIdx + 1800);
    const evalIdx = trigBlock.indexOf('evaluateQueueMutationEligibility(initialPending)');
    const clearTimerIdx = trigBlock.indexOf('clearTimeout(backoffRetryTimerRef.current)');
    assert.ok(
      evalIdx > 0 && clearTimerIdx > evalIdx,
      'triggerAutoProcessQueue must check eligibility BEFORE clearing backoffRetryTimerRef'
    );
    console.log('✓ Tests 8, 9, 10 passed: 20s interval, visibilitychange, and startup respect backoff with zero duplicate runs');
  }

  // ---------------------------------------------------------------------------
  // Test 11: Concurrent processor entry points are strictly serialized (zero duplicate HTTP sends)
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    const m1 = makeAttendanceMutation('mut_serial_1', 'stu_s1', '601', 'كيرلس', '2026-04-17', true, now);
    await idbQueueMutation(m1);

    let inFlight = 0;
    let maxConcurrency = 0;
    let totalPostCalls = 0;

    (globalThis as any).fetch = async (_url: string, init: any) => {
      totalPostCalls++;
      inFlight++;
      maxConcurrency = Math.max(maxConcurrency, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return verifiedJsonResponse(JSON.parse(init?.body || '{}'));
    };

    // Fire 4 concurrent entry points simultaneously!
    const [r1, r2, r3, r4] = await Promise.all([
      executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { nowMs: now + 10, isAutoTrigger: true }),
      executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { nowMs: now + 10 }),
      executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { nowMs: now + 10, isAutoTrigger: true }),
      executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { nowMs: now + 10 })
    ]);

    assert.equal(maxConcurrency, 1, 'Processor must NEVER execute concurrently');
    assert.equal(totalPostCalls, 1, 'Mutation must be sent ONCE across 4 concurrent calls (zero duplicates)');
    assert.equal(r1.sentCount + r2.sentCount + r3.sentCount + r4.sentCount, 1);
    console.log('✓ Test 11 passed: 4 concurrent processor calls serialized strictly (maxConcurrency=1, totalPosts=1)');
  }

  // ---------------------------------------------------------------------------
  // Test 12 & 13: Web Locks (navigator.locks) acquisition, mutual exclusion, and lock release on success & error
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const lockEvents: string[] = [];
    let lockHeld = false;
    let lockQueue: Promise<void> = Promise.resolve();

    mutableNavigator.locks = {
      request: async (name: string, optionsOrCb: any, maybeCb?: any) => {
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        const mode = typeof optionsOrCb === 'object' ? optionsOrCb.mode : 'exclusive';
        lockEvents.push(`request:${name}:${mode}`);

        let release!: () => void;
        const myTurn = new Promise<void>((resolve) => {
          release = resolve;
        });
        const prev = lockQueue;
        lockQueue = prev.then(() => myTurn, () => myTurn);
        await prev;

        assert.equal(lockHeld, false, 'Web Lock mutual exclusion violated!');
        lockHeld = true;
        lockEvents.push(`acquired:${name}`);
        try {
          return await cb({ name, mode });
        } finally {
          lockHeld = false;
          lockEvents.push(`released:${name}`);
          release();
        }
      }
    };

    // Test 12: Acquisition & mutual exclusion via executeProcessOfflineQueue + withOfflineQueueLock
    const mLock = makeAttendanceMutation('mut_wlock', 'stu_wl', '701', 'جورج', '2026-04-17', true, 1_700_000_000_000);
    await idbQueueMutation(mLock);
    let posts = 0;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      posts++;
      await new Promise((r) => setTimeout(r, 25));
      return verifiedJsonResponse(JSON.parse(init?.body || '{}'));
    };

    await Promise.all([
      executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { isAutoTrigger: true }),
      executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { isAutoTrigger: true })
    ]);

    assert.equal(posts, 1, 'Web Lock + mutex must prevent duplicate sends');
    assert.ok(lockEvents.includes(`request:${OFFLINE_QUEUE_LOCK_NAME}:exclusive`), 'Must request exclusive Web Lock with expected name');
    assert.equal(lockHeld, false, 'Web Lock must be released after success');

    // Test 13: Lock release after BOTH thrown failure AND subsequent success (no deadlock!)
    let caughtError = false;
    try {
      await withOfflineQueueLock(async () => {
        assert.equal(lockHeld, true);
        throw new Error('Simulated crash inside queue lock');
      });
    } catch (err: any) {
      caughtError = err?.message === 'Simulated crash inside queue lock';
    }
    assert.equal(caughtError, true, 'Thrown error inside lock must propagate');
    assert.equal(lockHeld, false, 'Web Lock MUST be released after thrown error');

    // Subsequent call MUST acquire cleanly without deadlock
    const afterFailureResult = await withOfflineQueueLock(async () => {
      assert.equal(lockHeld, true);
      return 'recovered_ok';
    });
    assert.equal(afterFailureResult, 'recovered_ok');
    assert.equal(lockHeld, false, 'Web Lock MUST be released after subsequent success');
    console.log('✓ Tests 12 & 13 passed: Web Locks (navigator.locks) exclusive acquisition & clean release on success and thrown failure');
  }

  // ---------------------------------------------------------------------------
  // Test 14: Targeted manual retry (idbResetMutationRetry + processOfflineQueue / targetMutationId)
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    const now = 1_700_000_000_000;
    // Queue has:
    // 1. Student A conflict (earlier)
    // 2. Student A pending (later - same student!)
    // 3. Student B failed with future nextRetryAt (target for manual retry!)
    // 4. Student C pending (unrelated, must NOT be touched during targeted retry of Student B!)
    const mutA1 = makeAttendanceMutation('t14_A1', 'stu_A', '801', 'طالب أ', '2026-04-10', true, now + 100);
    const mutA2 = makeAttendanceMutation('t14_A2', 'stu_A', '801', 'طالب أ', '2026-04-17', true, now + 200);
    const mutB1 = makeAttendanceMutation('t14_B1', 'stu_B', '802', 'طالب ب', '2026-04-17', true, now + 300, {
      status: 'failed',
      retryCount: 2,
      nextRetryAt: now + 60_000
    });
    const mutC1 = makeAttendanceMutation('t14_C1', 'stu_C', '803', 'طالب ج', '2026-04-17', true, now + 400);

    await idbQueueMutation(mutA1);
    await idbQueueMutation(mutA2);
    await idbQueueMutation(mutB1);
    await idbQueueMutation(mutC1);
    await idbMarkMutationConflict(mutA1.id, 'HTTP 409');

    const sentTargeted: string[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      sentTargeted.push(body.idempotencyKey || body.id);
      return verifiedJsonResponse(body);
    };

    // Subtest 14a: Attempting targeted retry on mutA2 (later op for Student A) MUST BE REFUSED (cannot bypass mutA1!)
    await idbResetMutationRetry(mutA2.id);
    const blockedRes = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { nowMs: now + 500 });
    assert.equal(blockedRes.success, false, 'Must refuse targeted retry that would bypass earlier unresolved same-student op');
    assert.equal(blockedRes.sentCount, 0);
    assert.equal(sentTargeted.length, 0, 'ZERO fetch calls when targeted retry is blocked by earlier same-student op');
    assert.ok(blockedRes.lastError?.includes('لا يمكن تجاوز عملية أقدم'), 'Must return clear Arabic ordering error');

    // Subtest 14b: Targeted retry on mutB1 via exact QueueDetailsModal flow (idbResetMutationRetry + manual processOfflineQueue)
    // Must process ONLY mutB1 and NOT touch mutA1, mutA2, or even pending mutC1!
    await idbResetMutationRetry(mutB1.id);
    const targetedRes = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, { nowMs: now + 600 });
    assert.equal(targetedRes.success, true);
    assert.equal(targetedRes.sentCount, 1);
    assert.deepEqual(sentTargeted, ['t14_B1'], 'Targeted manual retry MUST send ONLY the selected mutation (t14_B1)');

    const remAfterTarget = await idbGetPendingMutations();
    assert.deepEqual(
      remAfterTarget.map((m) => m.id),
      ['t14_A1', 't14_A2', 't14_C1'],
      'Unrelated items (mutA1, mutA2, mutC1) must remain completely untouched'
    );
    assert.equal(remAfterTarget[0].status, 'conflict');
    console.log('✓ Test 14 passed: Targeted manual retry sends ONLY target item and refuses bypassing earlier same-student op');
  }

  // ---------------------------------------------------------------------------
  // Test 15: Permanent error classification & MAX_AUTO_MUTATION_RETRIES cap
  // ---------------------------------------------------------------------------
  await resetTestEnvironment();
  {
    assert.equal(isPermanentMutationFailure(400, 'Bad Request'), true);
    assert.equal(isPermanentMutationFailure(403, 'Forbidden'), true);
    assert.equal(isPermanentMutationFailure(404, 'Not Found'), true);
    assert.equal(isPermanentMutationFailure(200, 'حذف المخدومين محظور نهائياً', 'delete'), true);
    assert.equal(isPermanentMutationFailure(500, 'Server unavailable'), false);
    assert.equal(isPermanentMutationFailure(503, 'Service unavailable'), false);
    assert.equal(isPermanentMutationFailure(429, 'Too many requests'), false);

    const now = 1_700_000_000_000;
    const exhaustedMut = makeAttendanceMutation('mut_max_retries', 'stu_ex', '901', 'طالب منتهي', '2026-04-17', true, now, {
      status: 'failed',
      retryCount: MAX_AUTO_MUTATION_RETRIES,
      nextRetryAt: now - 1000 // even if retryAt passed, retryCount >= MAX stops auto-retries!
    });
    await idbQueueMutation(exhaustedMut);

    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return jsonResponse({ ok: true });
    };

    const resEx = await executeProcessOfflineQueue(MOCK_ADMIN, false, undefined, undefined, {
      nowMs: now + 5000,
      isAutoTrigger: true
    });
    assert.equal(calls, 0, 'Mutation at MAX_AUTO_MUTATION_RETRIES must stop automatic retries');
    assert.equal(resEx.sentCount, 0);
    assert.equal(hasDueQueueMutations([exhaustedMut], now + 5000), false);
    console.log('✓ Test 15 passed: Permanent errors and MAX_AUTO_MUTATION_RETRIES cap stop infinite auto-retry loops');
  }

  console.log('\n=== ALL 15 PHASE 4.3.2 QUEUE RELIABILITY TESTS PASSED ===');
}

runTests().catch((err) => {
  console.error('❌ Phase 4.3.2 test failed:', err);
  process.exit(1);
});
