import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  getIndexedDB,
  idbGetStudents,
  idbGetFollowupRecords,
  idbGetAttendanceHistory,
  idbGetPendingMutations,
  idbQueueMutation,
  idbClearMutations,
  idbResetMutationRetry,
  idbReconcileStudents,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicRecordFollowupWithMutation,
  PullVerificationProof
} from '../services/indexedDbService';
import {
  validateRemotePersistenceProof,
  validateTimeoutIdempotencyEntry,
  RemotePersistenceProof
} from '../services/remotePersistenceVerification';
import {
  classifyMutationDisplayState,
  summarizeQueueMutations,
  createQueueClearBackup,
  validateQueueClearBackup,
  executeSafeClearMutations,
  buildLocalSavedNotification,
  buildRemoteVerifiedNotification
} from '../services/queueRecoveryService';
import {
  executeProcessOfflineQueue,
  evaluateQueueMutationEligibility,
  hasDueQueueMutations,
  buildAppsScriptSinglePayload,
  clearBatchUnsupportedCache,
  OFFLINE_QUEUE_LOCK_NAME
} from '../context/AppContext';
import { resolveFollowupCairoDates } from '../utils/arabicUtils';
import type { AuthUser, OfflineMutation } from '../types/auth';
import type { Student } from '../types/student';
import type { FollowupRecord } from '../types/followup';

// Isolated in-memory localStorage & navigator mocks (ZERO real browser storage, ZERO live network)
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
  setItem: (k: string, v: string) => storageMap.set(k, String(v)),
  removeItem: (k: string) => storageMap.delete(k),
  clear: () => storageMap.clear()
};

const mockNavigator: { onLine: boolean; locks?: any } = { onLine: true };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: mockNavigator
});

const TEST_SHEET = 'نشط';
const TEST_APPS_SCRIPT_URL = 'https://mock-e2e-apps-script.local/exec';
const TEST_USER: AuthUser = {
  userId: 'admin-435',
  username: 'admin',
  displayName: 'أمين الخدمة',
  role: 'admin',
  token: 'test-jwt-435'
};

function makeJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeStudent(overrides: Partial<Student> & { id: string }): Student {
  return {
    id: overrides.id,
    code: overrides.code || `SG-${overrides.id}`,
    name: overrides.name || `مخدوم ${overrides.id}`,
    servant: overrides.servant || 'خادم الاختبار',
    phoneStudent: overrides.phoneStudent || '01012345678',
    phoneParent1: overrides.phoneParent1 || '',
    phoneParent2: overrides.phoneParent2 || '',
    birthDate: overrides.birthDate || '',
    area: overrides.area || 'شبرا',
    address: overrides.address || 'العنوان',
    notes: overrides.notes || '',
    followupStatus: overrides.followupStatus || 'بدون',
    attendanceTotal: overrides.attendanceTotal ?? 0,
    attendanceMonth: overrides.attendanceMonth ?? 0,
    attendanceStatus: overrides.attendanceStatus || 'غائب',
    sourceSheet: overrides.sourceSheet || TEST_SHEET,
    version: overrides.version ?? 1,
    hasRemoteVersion: overrides.hasRemoteVersion ?? true,
    hasUnsyncedLocalChanges: overrides.hasUnsyncedLocalChanges ?? false,
    att: overrides.att || {},
    fu: overrides.fu || {}
  };
}

function makeAttendanceMutation(
  overrides: Partial<OfflineMutation> & { id: string; studentId: string }
): OfflineMutation {
  return {
    ...overrides,
    id: overrides.id,
    action: overrides.action || 'attendance',
    studentId: overrides.studentId,
    studentCode: overrides.studentCode || `SG-${overrides.studentId}`,
    studentName: overrides.studentName || `مخدوم ${overrides.studentId}`,
    sourceSheet: overrides.sourceSheet || TEST_SHEET,
    payload: overrides.payload || { friday: '2026-04-17', isPresent: true },
    expectedVersion: overrides.expectedVersion ?? 1,
    timestamp: overrides.timestamp ?? 1776400000000,
    retryCount: overrides.retryCount ?? 0,
    status: overrides.status || 'pending'
  };
}

function makeValidAttendanceProof(mut: OfflineMutation, row = 10): RemotePersistenceProof {
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

function makeValidFollowupProof(mut: OfflineMutation, followupLogRow = 55): RemotePersistenceProof {
  return {
    mutationId: mut.id,
    persisted: true,
    operation: 'followup',
    studentId: mut.studentId,
    friday: String(mut.payload?.friday),
    date: String(mut.payload?.date || ''),
    sheetName: mut.sourceSheet,
    recordId: String(mut.payload?.recordId || ''),
    followupLogAppended: true,
    followupLogRow,
    row: 14,
    newVersion: (mut.expectedVersion || 1) + 1,
    verifiedAt: '2026-04-17T10:05:00.000Z'
  };
}

async function seedStudentsDirect(students: Student[]): Promise<void> {
  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('students', 'readwrite');
    const store = tx.objectStore('students');
    for (const s of students) store.put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function resetIsolatedEnvironment(): Promise<void> {
  storageMap.clear();
  storageMap.set('stgorge_apps_script_url', TEST_APPS_SCRIPT_URL);
  mockNavigator.onLine = true;
  delete mockNavigator.locks;
  clearBatchUnsupportedCache();
  await idbClearMutations();
  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['students', 'followup', 'attendance_history', 'mutations'], 'readwrite');
    tx.objectStore('students').clear();
    tx.objectStore('followup').clear();
    tx.objectStore('attendance_history').clear();
    tx.objectStore('mutations').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let scenarioCount = 0;
async function runScenario(label: string, fn: () => Promise<void>): Promise<void> {
  await resetIsolatedEnvironment();
  await fn();
  scenarioCount += 1;
  console.log(`  [PASS] ${label}`);
}

async function main() {
  console.log('\n=======================================================================');
  console.log('Phase 4.3.5 — End-to-End Integration Testing (Phases 4.3.2 – 4.3.4)');
  console.log('=======================================================================\n');

  const originalFetch = globalThis.fetch;

  try {
    // =========================================================================
    // SCENARIO A — Successful local-to-remote lifecycle
    // =========================================================================
    await runScenario('Scenario A — Successful local-to-remote attendance lifecycle', async () => {
      const s1 = makeStudent({ id: 'STU_A1', name: 'كيرلس هاني', version: 1 });
      const s2 = makeStudent({ id: 'STU_A2', name: 'مارك يوسف', version: 1, hasUnsyncedLocalChanges: true });
      await seedStudentsDirect([s1, s2]);

      // Unrelated pending mutation for STU_A2 (scheduled in future so only STU_A1 is eligible)
      const unrelatedMut = makeAttendanceMutation({
        id: 'ATT_STU_A2_2026-04-17_unrelated',
        studentId: 'STU_A2',
        studentName: 'مارك يوسف',
        nextRetryAt: Date.now() + 120_000,
        status: 'retrying'
      });
      await idbQueueMutation(unrelatedMut);

      // 1. Create attendance mutation + atomic local persistence across students, attendance_history, mutations
      const friday = '2026-04-17';
      const updatedS1: Student = {
        ...s1,
        att: { [friday]: true },
        attendanceStatus: 'حاضر',
        attendanceTotal: 1,
        attendanceMonth: 1,
        lastAttendance: friday,
        version: 2,
        hasUnsyncedLocalChanges: true
      };
      const mutA1 = makeAttendanceMutation({
        id: 'ATT_STU_A1_2026-04-17_uuid-a1',
        studentId: 'STU_A1',
        studentName: 'كيرلس هاني',
        payload: { friday, isPresent: true },
        expectedVersion: 1
      });
      await idbAtomicRecordAttendanceWithMutation(
        updatedS1,
        {
          id: `STU_A1__${friday}`,
          studentId: 'STU_A1',
          studentCode: s1.code,
          fridayDate: friday,
          status: true,
          recordedAt: Date.now(),
          sourceSheet: TEST_SHEET
        },
        mutA1
      );

      // 2 & 3. Verify atomic local persistence & queue insertion
      const localStudents = await idbGetStudents();
      const localS1 = localStudents.find((s) => s.id === 'STU_A1')!;
      assert.equal(localS1.hasUnsyncedLocalChanges, true);
      assert.equal(localS1.att[friday], true);

      const history = await idbGetAttendanceHistory('STU_A1');
      assert.equal(history.length, 1);
      assert.equal(history[0].fridayDate, friday);
      assert.equal(history[0].status, true);

      const pendingBefore = await idbGetPendingMutations();
      assert.equal(pendingBefore.length, 2);
      assert.ok(pendingBefore.some((m) => m.id === mutA1.id));

      // Pre-sync UI state MUST NOT show green verified remote persistence
      const preSyncDisplay = classifyMutationDisplayState(mutA1, pendingBefore);
      assert.equal(preSyncDisplay.stateKey, 'pending');
      assert.equal(preSyncDisplay.isVerifiedRemotely, false);
      assert.notEqual(preSyncDisplay.badgeTone, 'success');

      // 4 & 5. Simulate valid remote persistence proof and verify exact validation
      const expectedProof = makeValidAttendanceProof(mutA1, 18);
      const directValidation = validateRemotePersistenceProof(mutA1, { ok: true, proof: expectedProof });
      assert.equal(directValidation.valid, true);
      assert.equal(directValidation.outcome, 'verified_persisted');

      const sentKeys: string[] = [];
      globalThis.fetch = (async (_url: any, init?: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        sentKeys.push(body.idempotencyKey);
        return makeJsonResponse({ ok: true, proof: expectedProof });
      }) as typeof fetch;

      const verifiedCallbackItems: OfflineMutation[] = [];
      let pushRecordedIso: string | null = null;
      const report = await executeProcessOfflineQueue(
        TEST_USER,
        false,
        undefined,
        (iso) => {
          pushRecordedIso = iso;
        },
        {
          onMutationSuccess: (m) => verifiedCallbackItems.push(m)
        }
      );

      assert.equal(report.sentCount, 1);
      assert.deepEqual(sentKeys, [mutA1.id]);
      assert.ok(pushRecordedIso);

      // 6. Confirm ONLY the verified mutation was removed; unrelated mutation remains untouched
      const pendingAfter = await idbGetPendingMutations();
      assert.equal(pendingAfter.length, 1);
      assert.equal(pendingAfter[0].id, unrelatedMut.id);

      // 7. Confirm local unsynchronized flags recalculated accurately
      const studentsAfter = await idbGetStudents();
      assert.equal(studentsAfter.find((s) => s.id === 'STU_A1')!.hasUnsyncedLocalChanges, false);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_A2')!.hasUnsyncedLocalChanges, true);

      // 8. Confirm UI can display verified remote persistence ONLY after proof
      assert.equal(verifiedCallbackItems.length, 1);
      const postSyncDisplay = classifyMutationDisplayState(verifiedCallbackItems[0], []);
      assert.equal(postSyncDisplay.stateKey, 'verified_persisted');
      assert.equal(postSyncDisplay.badgeTone, 'success');
      assert.equal(postSyncDisplay.isVerifiedRemotely, true);
      assert.match(postSyncDisplay.arabicLabel, /تم تأكيد الحفظ على Google Sheets/);
    });

    // =========================================================================
    // SCENARIO B — Offline followup lifecycle
    // =========================================================================
    await runScenario('Scenario B — Offline followup lifecycle with Cairo dates and strict followup proof', async () => {
      // Simulate offline & test UTC midnight rollover -> Cairo (+02:00) is already next calendar day!
      mockNavigator.onLine = false;
      const utcLateNight = new Date('2026-04-17T22:30:00.000Z'); // Saturday 2026-04-18 00:30 Africa/Cairo -> upcoming Friday 2026-04-24
      const { date: cairoDate, friday: cairoFriday } = resolveFollowupCairoDates(utcLateNight);
      assert.equal(cairoDate, '2026-04-18');
      assert.equal(cairoFriday, '2026-04-24');

      const sB = makeStudent({ id: 'STU_B1', name: 'بيشوي عماد', version: 3 });
      await seedStudentsDirect([sB]);

      const recordId = 'fu-rec-b1-uuid';
      const mutB: OfflineMutation = {
        id: 'FU_STU_B1_uuid-b1',
        action: 'followup',
        studentId: 'STU_B1',
        studentCode: sB.code,
        studentName: sB.name,
        sourceSheet: TEST_SHEET,
        payload: {
          friday: cairoFriday,
          date: cairoDate,
          method: 'تم تليفونياً',
          callOutcome: 'تم التواصل',
          notes: 'سيحضر الجمعة القادمة',
          recordId
        },
        expectedVersion: 3,
        timestamp: utcLateNight.getTime(),
        retryCount: 0,
        status: 'pending'
      };
      const updatedSB: Student = {
        ...sB,
        followupStatus: 'تم تليفونياً',
        fu: { [cairoFriday]: 'تم تليفونياً' },
        fuOutcomes: { [cairoFriday]: 'تم التواصل' },
        lastCallOutcome: 'تم التواصل',
        notes: 'سيحضر الجمعة القادمة',
        version: 4,
        hasUnsyncedLocalChanges: true
      };
      const fuRecord: FollowupRecord = {
        id: recordId,
        date: cairoDate,
        fridayDate: cairoFriday,
        studentId: 'STU_B1',
        studentCode: sB.code,
        studentName: sB.name,
        servant: sB.servant,
        type: 'تم تليفونياً',
        callOutcome: 'تم التواصل',
        notes: 'سيحضر الجمعة القادمة'
      };

      // 1 & 2. Atomic offline followup persistence
      await idbAtomicRecordFollowupWithMutation(updatedSB, fuRecord, mutB);

      const savedStudent = (await idbGetStudents()).find((s) => s.id === 'STU_B1')!;
      assert.equal(savedStudent.hasUnsyncedLocalChanges, true);
      assert.equal(savedStudent.fu[cairoFriday], 'تم تليفونياً');
      const savedFollowups = await idbGetFollowupRecords();
      assert.equal(savedFollowups.length, 1);
      assert.equal(savedFollowups[0].date, '2026-04-18');
      assert.equal(savedFollowups[0].fridayDate, '2026-04-24');
      assert.equal((await idbGetPendingMutations()).length, 1);

      // 3. Verify UI displays local-save status, NOT remote success
      const localNotif = buildLocalSavedNotification('followup', sB.name, 'تم تليفونياً (تم التواصل)');
      assert.equal(localNotif.type, 'info');
      assert.match(localNotif.title, /محلياً/);
      assert.match(localNotif.desc, /بانتظار المزامنة/);
      const offlineDisplay = classifyMutationDisplayState(mutB, [mutB]);
      assert.equal(offlineDisplay.isVerifiedRemotely, false);
      assert.notEqual(offlineDisplay.badgeTone, 'success');

      // While offline -> zero fetches
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return makeJsonResponse({ ok: true });
      }) as typeof fetch;
      const offlineReport = await executeProcessOfflineQueue(TEST_USER, false);
      assert.equal(fetchCount, 0);
      assert.equal(offlineReport.remainingCount, 1);

      // 4. Restore network; first test rejection of invalid followup responses (bare ok, attendance proof, missing log)
      mockNavigator.onLine = true;
      const invalidResponses = [
        { ok: true },
        {
          ok: true,
          proof: {
            mutationId: mutB.id,
            persisted: true,
            operation: 'attendance', // WRONG operation
            studentId: mutB.studentId,
            friday: cairoFriday,
            sheetName: TEST_SHEET,
            row: 14
          }
        },
        {
          ok: true,
          proof: {
            mutationId: mutB.id,
            persisted: true,
            operation: 'followup',
            studentId: mutB.studentId,
            friday: cairoFriday,
            date: cairoDate,
            sheetName: TEST_SHEET,
            recordId,
            followupLogAppended: false // NOT appended to log
          }
        }
      ];

      for (const badResp of invalidResponses) {
        await idbResetMutationRetry(mutB.id);
        globalThis.fetch = (async () => makeJsonResponse(badResp)) as typeof fetch;
        const badReport = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
          targetMutationId: mutB.id
        });
        assert.equal(badReport.sentCount, 0);
        assert.equal((await idbGetPendingMutations()).length, 1, 'Invalid followup proof MUST NOT delete mutation');
        assert.equal((await idbGetStudents())[0].hasUnsyncedLocalChanges, true);
      }

      // 5 & 6. Valid followup proof -> removes mutation ONLY after proof validation
      await idbResetMutationRetry(mutB.id);
      const validProof = makeValidFollowupProof(mutB, 77);
      let receivedPayload: any = null;
      globalThis.fetch = (async (_url: any, init?: any) => {
        receivedPayload = JSON.parse(String(init?.body || '{}'));
        return makeJsonResponse({ ok: true, proof: validProof });
      }) as typeof fetch;

      const verifiedList: OfflineMutation[] = [];
      const finalReport = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
        targetMutationId: mutB.id,
        onMutationSuccess: (m) => verifiedList.push(m)
      });

      assert.equal(finalReport.success, true);
      assert.equal(finalReport.sentCount, 1);
      assert.equal((await idbGetPendingMutations()).length, 0);
      assert.equal(receivedPayload.date, '2026-04-18');
      assert.equal(receivedPayload.friday, '2026-04-24');
      assert.equal(receivedPayload.recordId, recordId);

      // 7. Followup record, Cairo-local dates, and recalculated flag all accurate
      const finalStudents = await idbGetStudents();
      assert.equal(finalStudents[0].hasUnsyncedLocalChanges, false);
      const finalFollowups = await idbGetFollowupRecords();
      assert.equal(finalFollowups.length, 1);
      assert.equal(finalFollowups[0].date, '2026-04-18');
      assert.equal(finalFollowups[0].fridayDate, '2026-04-24');
      assert.equal(verifiedList.length, 1);
      assert.equal(classifyMutationDisplayState(verifiedList[0], []).stateKey, 'verified_persisted');
      assert.equal(buildRemoteVerifiedNotification(1).type, 'success');
    });

    // =========================================================================
    // SCENARIO C — Timeout after possible remote write (all 4 outcomes + idempotency)
    // =========================================================================
    await runScenario('Scenario C — Timeout verification across verified_persisted, not_found_retryable, unknown, verification_unavailable & zero duplicates', async () => {
      // Simulated remote ledger to prove zero duplicate server writes on retry
      const remoteLedger = new Map<string, { writes: number; proof: RemotePersistenceProof }>();

      const makeAbortError = () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'AbortError';
        return err;
      };

      // --- Sub-case C1: Timeout after remote write -> checkIdempotency returns valid proof ---
      {
        const s = makeStudent({ id: 'STU_C1', hasUnsyncedLocalChanges: true });
        await seedStudentsDirect([s]);
        const mut = makeAttendanceMutation({ id: 'ATT_C1_IMMUTABLE', studentId: 'STU_C1' });
        await idbQueueMutation(mut);

        globalThis.fetch = (async (_url: any, init?: any) => {
          const body = JSON.parse(String(init?.body || '{}'));
          if (body.action === 'checkIdempotency') {
            assert.deepEqual(body.keys, [mut.id]);
            const entry = remoteLedger.get(mut.id)!;
            return makeJsonResponse({
              ok: true,
              results: { [mut.id]: { found: true, proof: entry.proof } }
            });
          }
          // Simulate server persisted BEFORE network timeout!
          remoteLedger.set(mut.id, { writes: 1, proof: makeValidAttendanceProof(mut, 21) });
          throw makeAbortError();
        }) as typeof fetch;

        const r1 = await executeProcessOfflineQueue(TEST_USER, false);
        assert.equal(r1.sentCount, 1);
        assert.equal(r1.verifiedPostTimeoutCount, 1);
        assert.equal((await idbGetPendingMutations()).length, 0);
        assert.equal((await idbGetStudents()).find((st) => st.id === 'STU_C1')!.hasUnsyncedLocalChanges, false);
        assert.equal(remoteLedger.get(mut.id)!.writes, 1, 'Zero duplicate writes on post-timeout verified recovery');
      }

      // --- Sub-case C2: Timeout -> not_found_retryable -> retry with SAME immutable ID (zero duplicates) ---
      {
        await resetIsolatedEnvironment();
        const s = makeStudent({ id: 'STU_C2', hasUnsyncedLocalChanges: true });
        await seedStudentsDirect([s]);
        const mut = makeAttendanceMutation({ id: 'ATT_C2_IMMUTABLE', studentId: 'STU_C2' });
        await idbQueueMutation(mut);

        let postAttempt = 0;
        const observedIds: string[] = [];
        globalThis.fetch = (async (_url: any, init?: any) => {
          const body = JSON.parse(String(init?.body || '{}'));
          if (body.action === 'checkIdempotency') {
            return makeJsonResponse({ ok: true, results: { [mut.id]: { found: false } } });
          }
          postAttempt += 1;
          observedIds.push(body.idempotencyKey);
          if (postAttempt === 1) {
            throw makeAbortError();
          }
          // Second attempt succeeds idempotently using exact same immutable mutationId
          const existing = remoteLedger.get(body.idempotencyKey);
          if (!existing) {
            remoteLedger.set(body.idempotencyKey, { writes: 1, proof: makeValidAttendanceProof(mut, 22) });
          }
          return makeJsonResponse({ ok: true, proof: remoteLedger.get(body.idempotencyKey)!.proof });
        }) as typeof fetch;

        const rTimeout = await executeProcessOfflineQueue(TEST_USER, false);
        assert.equal(rTimeout.sentCount, 0);
        const retained = await idbGetPendingMutations();
        assert.equal(retained.length, 1);
        assert.equal(retained[0].id, mut.id, 'Immutable mutation ID MUST be preserved');
        assert.equal(retained[0].status, 'timeout_unknown');
        assert.equal(retained[0].verificationOutcome, 'not_found_retryable');
        assert.ok((retained[0].nextRetryAt || 0) > Date.now());
        assert.equal((await idbGetStudents())[0].hasUnsyncedLocalChanges, true);

        // Now retry -> exact same immutable ID, persists cleanly once
        await idbResetMutationRetry(mut.id);
        const rRetry = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
          targetMutationId: mut.id
        });
        assert.equal(rRetry.sentCount, 1);
        assert.deepEqual(observedIds, [mut.id, mut.id]);
        assert.equal(remoteLedger.get(mut.id)!.writes, 1);
        assert.equal((await idbGetPendingMutations()).length, 0);
      }

      // --- Sub-case C3: Timeout -> unknown (found:true WITHOUT valid proof -> fail-closed!) ---
      {
        await resetIsolatedEnvironment();
        const s = makeStudent({ id: 'STU_C3', hasUnsyncedLocalChanges: true });
        await seedStudentsDirect([s]);
        const mut = makeAttendanceMutation({ id: 'ATT_C3_IMMUTABLE', studentId: 'STU_C3' });
        await idbQueueMutation(mut);

        globalThis.fetch = (async (_url: any, init?: any) => {
          const body = JSON.parse(String(init?.body || '{}'));
          if (body.action === 'checkIdempotency') {
            return makeJsonResponse({
              ok: true,
              results: { [mut.id]: { found: true, response: { ok: true } } } // NO persistence proof!
            });
          }
          throw makeAbortError();
        }) as typeof fetch;

        const rUnk = await executeProcessOfflineQueue(TEST_USER, false);
        assert.equal(rUnk.sentCount, 0);
        const retained = await idbGetPendingMutations();
        assert.equal(retained.length, 1);
        assert.equal(retained[0].id, mut.id);
        assert.equal(retained[0].status, 'timeout_unknown');
        assert.equal(retained[0].verificationOutcome, 'unknown');
        const disp = classifyMutationDisplayState(retained[0], retained);
        assert.equal(disp.stateKey, 'timeout_unknown');
        assert.notEqual(disp.badgeTone, 'success');
        assert.equal((await idbGetStudents())[0].hasUnsyncedLocalChanges, true);
      }

      // --- Sub-case C4: Timeout -> verification_unavailable (checkIdempotency HTTP 500 -> fail-closed!) ---
      {
        await resetIsolatedEnvironment();
        const s = makeStudent({ id: 'STU_C4', hasUnsyncedLocalChanges: true });
        await seedStudentsDirect([s]);
        const mut = makeAttendanceMutation({ id: 'ATT_C4_IMMUTABLE', studentId: 'STU_C4' });
        await idbQueueMutation(mut);

        globalThis.fetch = (async (_url: any, init?: any) => {
          const body = JSON.parse(String(init?.body || '{}'));
          if (body.action === 'checkIdempotency') {
            return makeJsonResponse({ ok: false, error: 'Internal Server Error' }, 500);
          }
          throw makeAbortError();
        }) as typeof fetch;

        const rUnavail = await executeProcessOfflineQueue(TEST_USER, false);
        assert.equal(rUnavail.sentCount, 0);
        const retained = await idbGetPendingMutations();
        assert.equal(retained.length, 1);
        assert.equal(retained[0].id, mut.id);
        assert.equal(retained[0].status, 'timeout_unknown');
        assert.equal(retained[0].verificationOutcome, 'verification_unavailable');
        const disp = classifyMutationDisplayState(retained[0], retained);
        assert.equal(disp.stateKey, 'verification_unavailable');
        assert.match(disp.arabicLabel, /تعذر التحقق/);
        assert.notEqual(disp.badgeTone, 'success');
        assert.equal((await idbGetStudents())[0].hasUnsyncedLocalChanges, true);
      }
    });

    // =========================================================================
    // SCENARIO D — Conflicts and per-student isolation
    // =========================================================================
    await runScenario('Scenario D — 409 conflict isolation, independent students proceed, same-student ordering & zero auto-retry', async () => {
      await seedStudentsDirect([
        makeStudent({ id: 'STU_A', name: 'الطالب أ', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 'STU_B', name: 'الطالب ب', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 'STU_C', name: 'الطالب ج', hasUnsyncedLocalChanges: true })
      ]);

      const mutA1 = makeAttendanceMutation({
        id: 'ATT_A1',
        studentId: 'STU_A',
        studentName: 'الطالب أ',
        timestamp: 1776400001000
      });
      const mutA2: OfflineMutation = {
        id: 'FU_A2',
        action: 'followup',
        studentId: 'STU_A',
        studentCode: 'SG-STU_A',
        studentName: 'الطالب أ',
        sourceSheet: TEST_SHEET,
        payload: { friday: '2026-04-17', date: '2026-04-17', method: 'تم تليفونياً', recordId: 'rec-a2' },
        expectedVersion: 2,
        timestamp: 1776400002000,
        retryCount: 0,
        status: 'pending'
      };
      const mutB1 = makeAttendanceMutation({
        id: 'ATT_B1',
        studentId: 'STU_B',
        studentName: 'الطالب ب',
        timestamp: 1776400003000
      });
      const mutC1: OfflineMutation = {
        id: 'FU_C1',
        action: 'followup',
        studentId: 'STU_C',
        studentCode: 'SG-STU_C',
        studentName: 'الطالب ج',
        sourceSheet: TEST_SHEET,
        payload: { friday: '2026-04-17', date: '2026-04-17', method: 'زيارة منزلية', recordId: 'rec-c1' },
        expectedVersion: 1,
        timestamp: 1776400004000,
        retryCount: 0,
        status: 'pending'
      };

      await idbQueueMutation(mutA1);
      await idbQueueMutation(mutA2);
      await idbQueueMutation(mutB1);
      await idbQueueMutation(mutC1);

      const sentOrder: string[] = [];
      globalThis.fetch = (async (_url: any, init?: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const id = body.idempotencyKey;
        sentOrder.push(id);
        if (id === mutA1.id) {
          return makeJsonResponse({ ok: false, status: 409, error: 'تعارض إصدار على الخادم (409)' }, 409);
        }
        if (id === mutB1.id) {
          return makeJsonResponse({ ok: true, proof: makeValidAttendanceProof(mutB1, 31) });
        }
        if (id === mutC1.id) {
          return makeJsonResponse({ ok: true, proof: makeValidFollowupProof(mutC1, 61) });
        }
        throw new Error(`Unexpected send for ${id}`);
      }) as typeof fetch;

      const r1 = await executeProcessOfflineQueue(TEST_USER, false);
      assert.equal(r1.sentCount, 2);
      assert.equal(r1.conflictCount, 1);
      assert.deepEqual(sentOrder, [mutA1.id, mutB1.id, mutC1.id], 'A2 MUST NOT bypass conflicted A1; B1 and C1 MUST proceed independently');

      const remaining = await idbGetPendingMutations();
      assert.deepEqual(remaining.map((m) => m.id), [mutA1.id, mutA2.id]);
      assert.equal(remaining[0].status, 'conflict');
      assert.equal(remaining[1].status, 'pending');

      const studentsAfter = await idbGetStudents();
      assert.equal(studentsAfter.find((s) => s.id === 'STU_A')!.hasUnsyncedLocalChanges, true);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_B')!.hasUnsyncedLocalChanges, false);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_C')!.hasUnsyncedLocalChanges, false);

      // Conflicts MUST NOT be auto-retried, and A2 MUST NOT bypass A1 even on manual retry
      assert.equal(hasDueQueueMutations(remaining), false);
      const elig = evaluateQueueMutationEligibility(remaining);
      assert.equal(elig.eligible.length, 0);
      assert.equal(elig.conflicts.length, 1);
      assert.equal(elig.blockedBySameStudent.length, 1);
      assert.equal(elig.nextEarliestRetryAt, null);

      let extraFetches = 0;
      globalThis.fetch = (async () => {
        extraFetches += 1;
        return makeJsonResponse({ ok: true });
      }) as typeof fetch;

      await executeProcessOfflineQueue(TEST_USER, false);
      await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, { targetMutationId: mutA2.id });
      assert.equal(extraFetches, 0, 'Conflict must not auto-retry and later op A2 must never bypass A1');
    });

    // =========================================================================
    // SCENARIO E — Partial batch responses (5 mixed outcomes evaluated independently)
    // =========================================================================
    await runScenario('Scenario E — Partial batch responses evaluate each item independently and delete ONLY valid-proof items', async () => {
      const ids = ['STU_E1', 'STU_E2', 'STU_E3', 'STU_E4', 'STU_E5'];
      await seedStudentsDirect(ids.map((id) => makeStudent({ id, hasUnsyncedLocalChanges: true })));

      const muts = ids.map((id, idx) =>
        makeAttendanceMutation({
          id: `ATT_${id}_2026-04-17`,
          studentId: id,
          timestamp: 1776400001000 + idx * 1000
        })
      );
      for (const m of muts) await idbQueueMutation(m);

      let batchCalls = 0;
      globalThis.fetch = (async (_url: any, init?: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        assert.equal(body.action, 'batch');
        assert.equal(body.mutations.length, 5);
        batchCalls += 1;
        return makeJsonResponse({
          ok: true,
          serverDurationMs: 40,
          results: [
            // 0: Verified success
            { ok: true, proof: makeValidAttendanceProof(muts[0], 101) },
            // 1: Permanent failure (HTTP 400)
            { ok: false, status: 400, error: 'بيانات غير صالحة — اسم الفصل غير معتمد' },
            // 2: Temporary server/network failure (HTTP 503)
            { ok: false, status: 503, error: 'الخادم غير متاح مؤقتاً' },
            // 3: Another verified success
            { ok: true, proof: makeValidAttendanceProof(muts[3], 104) },
            // 4: Timeout-unknown operation
            { ok: false, status: 504, outcome: 'timeout_unknown', error: 'انتهت المهلة على مستوى السجل' }
          ]
        });
      }) as typeof fetch;

      const confirmedCallbackIds: string[] = [];
      const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
        onMutationSuccess: (m) => {
          assert.equal(m.verificationOutcome, 'verified_persisted');
          assert.ok(m.verifiedAt);
          confirmedCallbackIds.push(m.id);
        }
      });

      assert.equal(batchCalls, 1);
      assert.equal(report.mode, 'batch');
      assert.equal(report.sentCount, 2);
      assert.equal(report.remainingCount, 3);
      assert.deepEqual(confirmedCallbackIds, [muts[0].id, muts[3].id]);

      const remaining = await idbGetPendingMutations();
      assert.deepEqual(remaining.map((m) => m.id), [muts[1].id, muts[2].id, muts[4].id]);

      const rPerm = remaining.find((m) => m.id === muts[1].id)!;
      assert.equal(rPerm.status, 'failed');
      assert.equal(rPerm.isPermanentError, true);
      assert.equal(rPerm.errorCategory, 'permanent');
      assert.equal(rPerm.nextRetryAt, undefined);
      assert.equal(classifyMutationDisplayState(rPerm, remaining).stateKey, 'permanent_failure');

      const rTemp = remaining.find((m) => m.id === muts[2].id)!;
      assert.equal(rTemp.status, 'failed');
      assert.equal(rTemp.isPermanentError, false);
      assert.equal(rTemp.errorCategory, 'transient');
      assert.ok((rTemp.nextRetryAt || 0) > Date.now());
      assert.equal(classifyMutationDisplayState(rTemp, remaining).stateKey, 'retrying_scheduled');

      const rTimeout = remaining.find((m) => m.id === muts[4].id)!;
      assert.equal(rTimeout.status, 'timeout_unknown');
      assert.equal(rTimeout.errorCategory, 'timeout');
      assert.equal(rTimeout.verificationOutcome, 'unknown');
      assert.ok((rTimeout.nextRetryAt || 0) > Date.now());
      assert.equal(classifyMutationDisplayState(rTimeout, remaining).stateKey, 'timeout_unknown');

      // Student protection flags match exact verified vs retained status
      const studentsAfter = await idbGetStudents();
      assert.equal(studentsAfter.find((s) => s.id === 'STU_E1')!.hasUnsyncedLocalChanges, false);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_E2')!.hasUnsyncedLocalChanges, true);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_E3')!.hasUnsyncedLocalChanges, true);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_E4')!.hasUnsyncedLocalChanges, false);
      assert.equal(studentsAfter.find((s) => s.id === 'STU_E5')!.hasUnsyncedLocalChanges, true);
    });

    // =========================================================================
    // SCENARIO F — Safe queue recovery (retry guards, cancel, backup failures, selective clear & flags)
    // =========================================================================
    await runScenario('Scenario F — Safe queue recovery, manual retry guards, backup validation, selective clear & student protection flags', async () => {
      await seedStudentsDirect([
        makeStudent({ id: 'STU_F1', name: 'مخدوم 1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 'STU_F2', name: 'مخدوم 2', notes: 'محلي 2', version: 2, hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 'STU_F3', name: 'مخدوم 3', notes: 'محمي تعارض 3', version: 2, hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 'STU_F4', name: 'مخدوم 4', notes: 'محمي مهلة 4', version: 2, hasUnsyncedLocalChanges: true })
      ]);

      const fPend = makeAttendanceMutation({ id: 'F_PEND', studentId: 'STU_F1', timestamp: 1776400001000, status: 'pending' });
      const fFail = makeAttendanceMutation({
        id: 'F_FAIL',
        studentId: 'STU_F2',
        timestamp: 1776400002000,
        status: 'failed',
        isPermanentError: true,
        errorCategory: 'permanent',
        lastError: 'HTTP 403 غير مصرح'
      });
      const fLaterSameStudent = makeAttendanceMutation({
        id: 'F_LATER_F2',
        studentId: 'STU_F2',
        timestamp: 1776400003000,
        payload: { friday: '2026-04-10', isPresent: false },
        status: 'pending'
      });
      const fConf = makeAttendanceMutation({
        id: 'F_CONF',
        studentId: 'STU_F3',
        timestamp: 1776400004000,
        status: 'conflict',
        errorCategory: 'conflict',
        lastError: 'HTTP 409'
      });
      const fTo = makeAttendanceMutation({
        id: 'F_TO',
        studentId: 'STU_F4',
        timestamp: 1776400005000,
        status: 'timeout_unknown',
        errorCategory: 'timeout',
        verificationOutcome: 'unknown',
        lastError: 'انتهت المهلة'
      });

      for (const m of [fPend, fFail, fLaterSameStudent, fConf, fTo]) {
        await idbQueueMutation(m);
      }

      const allInitial = await idbGetPendingMutations();
      const summary = summarizeQueueMutations(allInitial);
      assert.equal(summary.total, 5);
      assert.equal(summary.pending, 2);
      assert.equal(summary.permanentFailed, 1);
      assert.equal(summary.conflict, 1);
      assert.equal(summary.timeoutUnknown, 1);

      // 2a. Attempt manual retry on ineligible later op for STU_F2 -> blocked
      assert.equal(classifyMutationDisplayState(fLaterSameStudent, allInitial).canManualRetry, false);
      let blockedCalls = 0;
      globalThis.fetch = (async () => {
        blockedCalls += 1;
        return makeJsonResponse({ ok: true });
      }) as typeof fetch;
      const blockedReport = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
        targetMutationId: fLaterSameStudent.id
      });
      assert.equal(blockedCalls, 0);
      assert.equal(blockedReport.sentCount, 0);

      // 2b. Manual retry on eligible F_PEND -> succeeds & removes ONLY F_PEND
      globalThis.fetch = (async () =>
        makeJsonResponse({ ok: true, proof: makeValidAttendanceProof(fPend, 201) })) as typeof fetch;
      await idbResetMutationRetry(fPend.id);
      const singleRetryReport = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
        targetMutationId: fPend.id
      });
      assert.equal(singleRetryReport.sentCount, 1);
      assert.equal((await idbGetPendingMutations()).length, 4);
      assert.equal((await idbGetStudents()).find((s) => s.id === 'STU_F1')!.hasUnsyncedLocalChanges, false);

      // 3. Cancellation -> deletes ZERO
      const resCancel = await executeSafeClearMutations({ confirmed: false });
      assert.equal(resCancel.ok, false);
      assert.equal(resCancel.cancelled, true);
      assert.equal((await idbGetPendingMutations()).length, 4);

      // 4. Backup download failure -> deletes ZERO
      const resBackupErr = await executeSafeClearMutations({
        confirmed: true,
        targetMutationIds: [fFail.id, fLaterSameStudent.id],
        downloader: () => {
          throw new Error('Disk write error');
        }
      });
      assert.equal(resBackupErr.ok, false);
      assert.equal(resBackupErr.clearedCount, 0);
      assert.equal((await idbGetPendingMutations()).length, 4);

      // 5. Invalid/stale backup -> deletes ZERO
      const staleJson = createQueueClearBackup([fFail, fLaterSameStudent], {
        nowIso: new Date(Date.now() - 3600_000).toISOString()
      }).jsonString;
      const resInvalidBackup = await executeSafeClearMutations({
        confirmed: true,
        targetMutationIds: [fFail.id, fLaterSameStudent.id],
        backupJsonOverride: staleJson,
        downloader: () => true
      });
      assert.equal(resInvalidBackup.ok, false);
      assert.equal(resInvalidBackup.clearedCount, 0);
      assert.equal((await idbGetPendingMutations()).length, 4);

      // 6. Valid selective clear of STU_F2's failed + later mutations using freshly validated backup
      let exportedJson = '';
      const resSelective = await executeSafeClearMutations({
        confirmed: true,
        targetMutationIds: [fFail.id, fLaterSameStudent.id],
        downloader: ({ jsonString }) => {
          exportedJson = jsonString;
          return true;
        }
      });
      assert.equal(resSelective.ok, true);
      assert.equal(resSelective.clearedCount, 2);
      assert.equal(resSelective.remainingCount, 2);
      assert.equal(validateQueueClearBackup(exportedJson, [fFail, fLaterSameStudent]).valid, true);

      // 7. Unselected conflict & timeout_unknown mutations remain untouched
      const remainingAfter = await idbGetPendingMutations();
      assert.deepEqual(remainingAfter.map((m) => m.id).sort(), [fConf.id, fTo.id].sort());

      // 8. Verify ALL student protection flags + pull reconciliation protection
      const studentsBeforePull = await idbGetStudents();
      assert.equal(studentsBeforePull.find((s) => s.id === 'STU_F1')!.hasUnsyncedLocalChanges, false);
      assert.equal(studentsBeforePull.find((s) => s.id === 'STU_F2')!.hasUnsyncedLocalChanges, false);
      assert.equal(studentsBeforePull.find((s) => s.id === 'STU_F3')!.hasUnsyncedLocalChanges, true);
      assert.equal(studentsBeforePull.find((s) => s.id === 'STU_F4')!.hasUnsyncedLocalChanges, true);

      const proof: PullVerificationProof = {
        verified: true,
        isComplete: true,
        sheetName: TEST_SHEET,
        source: 'gviz'
      };
      await idbReconcileStudents(
        [
          makeStudent({ id: 'STU_F2', name: 'مخدوم 2 محدث', notes: 'محدث من الشيت', version: 4, hasRemoteVersion: true }),
          makeStudent({ id: 'STU_F3', name: 'محاولة استبدال 3', notes: 'بعيد 3', version: 4, hasRemoteVersion: true }),
          makeStudent({ id: 'STU_F4', name: 'محاولة استبدال 4', notes: 'بعيد 4', version: 4, hasRemoteVersion: true })
        ],
        remainingAfter,
        TEST_SHEET,
        true,
        proof
      );

      const studentsAfterPull = await idbGetStudents();
      assert.equal(studentsAfterPull.find((s) => s.id === 'STU_F2')!.notes, 'محدث من الشيت', 'Cleared student must NOT be frozen from pulls');
      assert.equal(studentsAfterPull.find((s) => s.id === 'STU_F3')!.notes, 'محمي تعارض 3', 'Conflict mutation MUST protect local student');
      assert.equal(studentsAfterPull.find((s) => s.id === 'STU_F4')!.notes, 'محمي مهلة 4', 'Timeout-unknown mutation MUST protect local student');
    });

    // =========================================================================
    // SCENARIO G — Multi-tab and concurrency protection (Web Locks + Mutex + Order)
    // =========================================================================
    await runScenario('Scenario G — Multi-tab Web Locks, concurrency serialization, zero duplicate sends & same-student ordering', async () => {
      await seedStudentsDirect([
        makeStudent({ id: 'STU_G1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 'STU_G2', hasUnsyncedLocalChanges: true })
      ]);

      const mutGA1 = makeAttendanceMutation({
        id: 'ATT_GA1',
        studentId: 'STU_G1',
        timestamp: 1776400001000
      });
      const mutGA2: OfflineMutation = {
        id: 'FU_GA2',
        action: 'followup',
        studentId: 'STU_G1',
        studentCode: 'SG-STU_G1',
        studentName: 'مخدوم STU_G1',
        sourceSheet: TEST_SHEET,
        payload: { friday: '2026-04-17', date: '2026-04-17', method: 'تم تليفونياً', recordId: 'rec-ga2' },
        expectedVersion: 2,
        timestamp: 1776400002000,
        retryCount: 0,
        status: 'pending'
      };
      const mutGB1 = makeAttendanceMutation({
        id: 'ATT_GB1',
        studentId: 'STU_G2',
        timestamp: 1776400003000
      });

      await idbQueueMutation(mutGA1);
      await idbQueueMutation(mutGA2);
      await idbQueueMutation(mutGB1);

      // Mock cross-tab Web Locks API
      let activeLocks = 0;
      let maxActiveLocks = 0;
      let totalLockAcquisitions = 0;
      let lockQueueTail: Promise<void> = Promise.resolve();
      mockNavigator.locks = {
        request: async (name: string, opts: any, cb: () => Promise<any>) => {
          assert.equal(name, OFFLINE_QUEUE_LOCK_NAME);
          assert.equal(opts?.mode, 'exclusive');
          let release!: () => void;
          const next = new Promise<void>((r) => {
            release = r;
          });
          const prev = lockQueueTail;
          lockQueueTail = prev.then(() => next, () => next);
          await prev;
          activeLocks += 1;
          totalLockAcquisitions += 1;
          maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
          try {
            return await cb();
          } finally {
            activeLocks -= 1;
            release();
          }
        }
      };

      let activeFetches = 0;
      let maxConcurrentFetches = 0;
      const sendTimeline: string[] = [];
      const completedTimeline: string[] = [];

      globalThis.fetch = (async (_url: any, init?: any) => {
        activeFetches += 1;
        maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
        const body = JSON.parse(String(init?.body || '{}'));
        const id = body.idempotencyKey;
        sendTimeline.push(id);
        await new Promise((r) => setTimeout(r, 15));
        activeFetches -= 1;
        completedTimeline.push(id);

        if (id === mutGA1.id) return makeJsonResponse({ ok: true, proof: makeValidAttendanceProof(mutGA1, 301) });
        if (id === mutGA2.id) return makeJsonResponse({ ok: true, proof: makeValidFollowupProof(mutGA2, 302) });
        if (id === mutGB1.id) return makeJsonResponse({ ok: true, proof: makeValidAttendanceProof(mutGB1, 303) });
        throw new Error(`Unexpected mutation ${id}`);
      }) as typeof fetch;

      // Trigger 4 simultaneous concurrent processors (simulating multi-tab + auto-trigger + manual button)
      const reports = await Promise.all([
        executeProcessOfflineQueue(TEST_USER, false),
        executeProcessOfflineQueue(TEST_USER, false),
        executeProcessOfflineQueue(TEST_USER, false),
        executeProcessOfflineQueue(TEST_USER, false)
      ]);

      assert.equal(totalLockAcquisitions, 4);
      assert.equal(maxActiveLocks, 1, 'Web Lock MUST enforce strict exclusive concurrency');
      assert.equal(maxConcurrentFetches, 1, 'Zero overlapping network writes allowed');

      // Zero duplicate sends across all 4 concurrent callers!
      const uniqueSent = new Set(sendTimeline);
      assert.equal(sendTimeline.length, 3, 'Each mutation must be sent AT MOST ONCE');
      assert.equal(uniqueSent.size, 3);
      assert.equal(reports.reduce((acc, r) => acc + r.sentCount, 0), 3);

      // Strict same-student ordering: GA1 MUST finish before GA2 starts
      assert.ok(sendTimeline.indexOf(mutGA1.id) < sendTimeline.indexOf(mutGA2.id));
      assert.ok(completedTimeline.indexOf(mutGA1.id) < sendTimeline.indexOf(mutGA2.id));

      // Final queue empty & flags cleared
      assert.equal((await idbGetPendingMutations()).length, 0);
      const finalStudents = await idbGetStudents();
      assert.equal(finalStudents.every((s) => s.hasUnsyncedLocalChanges === false), true);
    });

    // =========================================================================
    // SECTION 3 — Cross-Phase Contract Validation
    // =========================================================================
    await runScenario('Cross-Phase Contract Validation — proof strictness, immutability, dates, UI gating & deletion boundaries', async () => {
      const sampleAtt = makeAttendanceMutation({
        id: 'ATT_CONTRACT_IMMUTABLE_1',
        studentId: 'STU_CONTRACT_1',
        sourceSheet: 'فصل الأنبا كاراس',
        payload: { friday: '2026-04-10', isPresent: true }
      });
      const sampleFu: OfflineMutation = {
        id: 'FU_CONTRACT_IMMUTABLE_2',
        action: 'followup',
        studentId: 'STU_CONTRACT_1',
        studentCode: 'SG-C1',
        studentName: 'مخدوم العقد',
        sourceSheet: 'فصل الأنبا كاراس',
        payload: {
          friday: '2026-04-10',
          date: '2026-04-11',
          method: 'تم تليفونياً',
          recordId: 'rec-contract-2'
        },
        expectedVersion: 2,
        timestamp: 1775800000000,
        retryCount: 0,
        status: 'pending'
      };

      // 1. Bare { ok: true } NEVER accepted
      assert.equal(validateRemotePersistenceProof(sampleAtt, { ok: true }).valid, false);
      assert.equal(validateRemotePersistenceProof(sampleFu, { ok: true }).valid, false);

      // 2. persisted: true alone WITHOUT all required matching fields NEVER accepted
      assert.equal(validateRemotePersistenceProof(sampleAtt, { ok: true, persisted: true }).valid, false);
      assert.equal(
        validateRemotePersistenceProof(sampleAtt, {
          ok: true,
          proof: { persisted: true, mutationId: sampleAtt.id, operation: 'attendance', studentId: sampleAtt.studentId } // missing sheetName, friday, row/recordId
        }).valid,
        false
      );
      assert.equal(
        validateRemotePersistenceProof(sampleAtt, {
          ok: true,
          proof: { ...makeValidAttendanceProof(sampleAtt), sheetName: 'فصل مختلف' }
        }).valid,
        false
      );
      assert.equal(
        validateRemotePersistenceProof(sampleAtt, {
          ok: true,
          proof: { ...makeValidAttendanceProof(sampleAtt), friday: '2026-04-17' }
        }).valid,
        false
      );
      assert.equal(
        validateTimeoutIdempotencyEntry(sampleFu, { found: true, response: { ok: true, persisted: true } }).outcome,
        'unknown'
      );

      // 3. Original Friday and followup Cairo calendar date remain immutable in wire payload across retries
      const wireFu = buildAppsScriptSinglePayload(sampleFu, 'relay-key-test');
      assert.equal(wireFu.idempotencyKey, sampleFu.id);
      assert.equal(wireFu.studentId, sampleFu.studentId);
      assert.equal(wireFu.sheet, 'فصل الأنبا كاراس');
      assert.equal(wireFu.friday, '2026-04-10');
      assert.equal(wireFu.date, '2026-04-11');
      assert.equal(wireFu.recordId, 'rec-contract-2');

      // 4. Static contract audit across all 6 cross-phase modules + UI components
      const readSrc = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
      const appCtxSrc = readSrc('src/context/AppContext.tsx');
      const queueModalSrc = readSrc('src/components/modals/QueueDetailsModal.tsx');
      const syncModalSrc = readSrc('src/components/modals/SyncDetailsModal.tsx');
      const indicatorSrc = readSrc('src/components/glass/SyncStatusIndicator.tsx');
      const studentCardSrc = readSrc('src/components/cards/StudentCard.tsx');

      // Deletion paths in AppContext MUST ONLY be gated by proof validation or executeSafeClearMutations
      assert.ok(appCtxSrc.includes('validateRemotePersistenceProof'), 'AppContext must enforce validateRemotePersistenceProof');
      assert.ok(appCtxSrc.includes('executeSafeClearMutations'), 'AppContext.clearOfflineQueue must use executeSafeClearMutations');
      assert.ok(!appCtxSrc.includes('idbClearMutations('), 'AppContext must NOT call unprotected idbClearMutations directly');

      // UI components MUST NOT report remote success before valid proof exists
      assert.ok(queueModalSrc.includes('classifyMutationDisplayState'), 'QueueDetailsModal must classify via 7-state proof-gated classifier');
      assert.ok(syncModalSrc.includes("lastSyncReport.outcome === 'success' && lastSyncReport.remainingCount === 0"), 'SyncDetailsModal must gate green confirmed label');
      assert.ok(indicatorSrc.includes('pendingMutationsCount'), 'SyncStatusIndicator must reflect pending state cleanly');
      assert.ok(
        studentCardSrc.indexOf('isStudentPending ?') > 0 &&
          studentCardSrc.indexOf('isStudentSynced ?') > 0 &&
          studentCardSrc.indexOf('isStudentPending ?') < studentCardSrc.indexOf('isStudentSynced ?'),
        'StudentCard must prioritize pending local badge over synced badge in JSX render branch'
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\n✅ ALL ${scenarioCount}/8 Phase 4.3.5 End-to-End Integration Scenarios & Contract Checks PASSED!\n`);
}

main().catch((err) => {
  console.error('\n❌ Phase 4.3.5 End-to-End Integration Tests FAILED:', err);
  process.exit(1);
});
