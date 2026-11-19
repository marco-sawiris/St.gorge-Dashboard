import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  getIndexedDB,
  idbGetStudents,
  idbQueueMutation,
  idbGetPendingMutations,
  idbRemoveMutationsBatch,
  idbClearMutations,
  idbResetMutationRetry,
  idbReconcileStudents,
  idbRecalculateUnsyncedStudentFlags,
  PullVerificationProof
} from '../services/indexedDbService';
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
  evaluateQueueMutationEligibility,
  executeProcessOfflineQueue
} from '../context/AppContext';
import { OfflineMutation, AuthUser } from '../types/auth';
import { Student } from '../types/student';

// Isolated in-memory localStorage & navigator mocks (ZERO real browser storage, ZERO live calls)
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
  userId: 'u-admin-434',
  username: 'admin',
  displayName: 'أمين الخدمة',
  role: 'admin',
  token: 'test-token-434'
};

function makeStudent(overrides: Partial<Student> & { id: string }): Student {
  return {
    id: overrides.id,
    code: overrides.code || `SG-${overrides.id}`,
    name: overrides.name || `مخدوم ${overrides.id}`,
    servant: overrides.servant || 'خادم الاختبار',
    phoneStudent: overrides.phoneStudent || '01000000000',
    phoneParent1: overrides.phoneParent1 || '',
    phoneParent2: overrides.phoneParent2 || '',
    birthDate: overrides.birthDate || '',
    area: overrides.area || 'شبرا',
    address: overrides.address || 'العنوان',
    notes: overrides.notes || '',
    followupStatus: overrides.followupStatus || 'بدون',
    attendanceTotal: overrides.attendanceTotal ?? 1,
    attendanceMonth: overrides.attendanceMonth ?? 1,
    attendanceStatus: overrides.attendanceStatus || 'حاضر',
    sourceSheet: overrides.sourceSheet || 'نشط',
    version: overrides.version ?? 2,
    hasRemoteVersion: overrides.hasRemoteVersion ?? true,
    hasUnsyncedLocalChanges: overrides.hasUnsyncedLocalChanges ?? true,
    att: overrides.att || { '2026-04-10': true },
    fu: overrides.fu || {}
  };
}

function makeMutation(overrides: Partial<OfflineMutation> & { id: string; studentId: string }): OfflineMutation {
  return {
    id: overrides.id,
    action: overrides.action || 'attendance',
    studentId: overrides.studentId,
    studentCode: overrides.studentCode || `SG-${overrides.studentId}`,
    studentName: overrides.studentName || `مخدوم ${overrides.studentId}`,
    sourceSheet: overrides.sourceSheet || 'نشط',
    payload: overrides.payload || { friday: '2026-04-10', isPresent: true },
    expectedVersion: overrides.expectedVersion ?? 1,
    timestamp: overrides.timestamp ?? 1775800000000,
    retryCount: overrides.retryCount ?? 0,
    status: overrides.status || 'pending',
    verificationOutcome: overrides.verificationOutcome,
    verifiedAt: overrides.verifiedAt,
    lastError: overrides.lastError,
    lastAttemptAt: overrides.lastAttemptAt,
    nextRetryAt: overrides.nextRetryAt,
    isPermanentError: overrides.isPermanentError,
    errorCategory: overrides.errorCategory
  };
}

async function seedStudents(students: Student[]) {
  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('students', 'readwrite');
    const store = tx.objectStore('students');
    for (const s of students) {
      store.put(s);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function resetDb() {
  storageMap.clear();
  storageMap.set('stgorge_apps_script_url', 'https://mock-apps-script.local/exec');
  await idbClearMutations();
  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['students', 'mutations'], 'readwrite');
    tx.objectStore('students').clear();
    tx.objectStore('mutations').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let passed = 0;
async function runCase(name: string, fn: () => Promise<void> | void) {
  await resetDb();
  await fn();
  passed += 1;
  console.log(`  [PASS] ${passed}. ${name}`);
}

async function main() {
  console.log('\n=================================================================');
  console.log('Phase 4.3.4 — Data Protection, Queue UI & Safe Recovery Tests');
  console.log('=================================================================\n');

  const originalFetch = globalThis.fetch;

  try {
    // TEST 1: All 7 distinct states classified with clear Arabic labels + breakdown summary
    await runCase('Classifies all 7 queue states clearly in Arabic and computes exact breakdown summary', () => {
      const now = 1776000000000;
      const mPending = makeMutation({ id: 'm-1', studentId: 's-1', status: 'pending' });
      const mRetrying = makeMutation({
        id: 'm-2',
        studentId: 's-2',
        status: 'retrying',
        errorCategory: 'transient',
        retryCount: 2,
        nextRetryAt: now + 30_000,
        lastError: 'فشل مؤقت في الشبكة'
      });
      const mPermanent = makeMutation({
        id: 'm-3',
        studentId: 's-3',
        status: 'failed',
        isPermanentError: true,
        errorCategory: 'permanent',
        lastError: 'HTTP 403 غير مصرح'
      });
      const mConflict = makeMutation({
        id: 'm-4',
        studentId: 's-4',
        status: 'conflict',
        errorCategory: 'conflict',
        verificationOutcome: 'conflict',
        lastError: 'HTTP 409 تعارض إصدار'
      });
      const mTimeout = makeMutation({
        id: 'm-5',
        studentId: 's-5',
        status: 'timeout_unknown',
        errorCategory: 'timeout',
        verificationOutcome: 'unknown',
        lastError: 'انتهت المهلة قبل تأكيد الحفظ'
      });
      const mVerifyUnavailable = makeMutation({
        id: 'm-6',
        studentId: 's-6',
        status: 'timeout_unknown',
        errorCategory: 'timeout',
        verificationOutcome: 'verification_unavailable',
        lastError: 'تعذر الوصول لنقطة التحقق'
      });
      const mVerified = makeMutation({
        id: 'm-7',
        studentId: 's-7',
        status: 'pending',
        verificationOutcome: 'verified_persisted',
        verifiedAt: new Date(now).toISOString()
      });

      const all = [mPending, mRetrying, mPermanent, mConflict, mTimeout, mVerifyUnavailable, mVerified];

      const d1 = classifyMutationDisplayState(mPending, all, { nowMs: now });
      assert.equal(d1.stateKey, 'pending');
      assert.equal(d1.isVerifiedRemotely, false);
      assert.equal(d1.badgeTone, 'info');
      assert.match(d1.arabicLabel, /قيد الانتظار/);

      const d2 = classifyMutationDisplayState(mRetrying, all, { nowMs: now });
      assert.equal(d2.stateKey, 'retrying_scheduled');
      assert.equal(d2.isVerifiedRemotely, false);
      assert.notEqual(d2.badgeTone, 'success');
      assert.match(d2.arabicLabel, /إعادة المحاولة/);

      const d3 = classifyMutationDisplayState(mPermanent, all, { nowMs: now });
      assert.equal(d3.stateKey, 'permanent_failure');
      assert.equal(d3.isPermanentFailure, true);
      assert.equal(d3.badgeTone, 'danger');
      assert.match(d3.arabicLabel, /فشل دائم/);
      assert.match(d3.autoRetryExplanation || '', /لا يُعاد إرساله تلقائياً/);

      const d4 = classifyMutationDisplayState(mConflict, all, { nowMs: now });
      assert.equal(d4.stateKey, 'conflict');
      assert.equal(d4.isConflict, true);
      assert.equal(d4.badgeTone, 'danger');
      assert.match(d4.arabicLabel, /تعارض إصدار \(409\)/);
      assert.match(d4.autoRetryExplanation || '', /لا يُعاد إرسال عمليات التعارض تلقائياً/);

      const d5 = classifyMutationDisplayState(mTimeout, all, { nowMs: now });
      assert.equal(d5.stateKey, 'timeout_unknown');
      assert.equal(d5.isTimeoutUnknown, true);
      assert.equal(d5.badgeTone, 'warning');
      assert.match(d5.arabicLabel, /نتيجة غير مؤكدة/);

      const d6 = classifyMutationDisplayState(mVerifyUnavailable, all, { nowMs: now });
      assert.equal(d6.stateKey, 'verification_unavailable');
      assert.equal(d6.isVerificationUnavailable, true);
      assert.equal(d6.badgeTone, 'warning');
      assert.match(d6.arabicLabel, /تعذر التحقق/);

      const d7 = classifyMutationDisplayState(mVerified, all, { nowMs: now });
      assert.equal(d7.stateKey, 'verified_persisted');
      assert.equal(d7.isVerifiedRemotely, true);
      assert.equal(d7.badgeTone, 'success');
      assert.match(d7.arabicLabel, /تم تأكيد الحفظ على Google Sheets/);

      const summary = summarizeQueueMutations(all, now);
      assert.equal(summary.total, 7);
      assert.equal(summary.pending, 1);
      assert.equal(summary.retrying, 1);
      assert.equal(summary.permanentFailed, 1);
      assert.equal(summary.failed, 1);
      assert.equal(summary.conflict, 1);
      assert.equal(summary.timeoutUnknown, 2); // timeout_unknown + verification_unavailable
      assert.equal(summary.verificationUnavailable, 1);
      assert.equal(summary.verifiedPersisted, 1);
    });

    // TEST 2: Never displays green success state without valid remote persistence proof
    await runCase('Never displays green success state for unverified or partially-marked mutations', () => {
      const unverifiedCandidates: OfflineMutation[] = [
        makeMutation({ id: 'u-1', studentId: 's-1', status: 'pending' }),
        makeMutation({ id: 'u-2', studentId: 's-2', status: 'retrying', verificationOutcome: 'not_found_retryable' }),
        makeMutation({ id: 'u-3', studentId: 's-3', status: 'timeout_unknown', verificationOutcome: 'unknown' }),
        makeMutation({ id: 'u-4', studentId: 's-4', status: 'timeout_unknown', verificationOutcome: 'verification_unavailable' }),
        makeMutation({ id: 'u-5', studentId: 's-5', status: 'conflict', verificationOutcome: 'conflict' }),
        makeMutation({ id: 'u-6', studentId: 's-6', status: 'failed', isPermanentError: true }),
        // Missing verifiedAt timestamp -> MUST NOT display green confirmed state!
        makeMutation({ id: 'u-7', studentId: 's-7', status: 'pending', verificationOutcome: 'verified_persisted', verifiedAt: '' })
      ];

      for (const mut of unverifiedCandidates) {
        const state = classifyMutationDisplayState(mut, unverifiedCandidates);
        assert.notEqual(state.badgeTone, 'success', `Unverified mutation ${mut.id} must NEVER get green tone`);
        assert.equal(state.isVerifiedRemotely, false, `Unverified mutation ${mut.id} must NOT be marked verified`);
        assert.notEqual(state.stateKey, 'verified_persisted');
      }
    });

    // TEST 3: Manual retry of a single mutation resets ONLY that mutation (unrelated untouched)
    await runCase('Targeted manual retry resets ONLY the selected mutation and leaves unrelated mutations untouched', async () => {
      const futureRetry = Date.now() + 120_000;
      const m1 = makeMutation({
        id: 'ATT_s1_2026-04-10_op1',
        studentId: 's-1',
        status: 'retrying',
        retryCount: 2,
        nextRetryAt: futureRetry,
        lastError: 'عطل مؤقت 1'
      });
      const m2 = makeMutation({
        id: 'ATT_s2_2026-04-10_op2',
        studentId: 's-2',
        status: 'retrying',
        retryCount: 3,
        nextRetryAt: futureRetry + 60_000,
        lastError: 'عطل مؤقت 2'
      });

      await seedStudents([
        makeStudent({ id: 's-1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-2', hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(m1);
      await idbQueueMutation(m2);

      await idbResetMutationRetry(m1.id);

      const afterReset = await idbGetPendingMutations();
      const afterM1 = afterReset.find((m) => m.id === m1.id)!;
      const afterM2 = afterReset.find((m) => m.id === m2.id)!;

      assert.equal(afterM1.status, 'pending');
      assert.equal(afterM1.nextRetryAt, undefined);
      assert.equal(afterM1.isPermanentError, false);
      assert.equal(afterM1.retryCount, 2); // Audit history preserved while schedule & failure flags reset

      // Unrelated m2 MUST remain completely untouched
      assert.equal(afterM2.status, 'retrying');
      assert.equal(afterM2.retryCount, 3);
      assert.equal(afterM2.nextRetryAt, futureRetry + 60_000);
      assert.equal(afterM2.lastError, 'عطل مؤقت 2');

      // Now execute targeted retry with valid remote proof for m1 ONLY
      const sentIds: string[] = [];
      globalThis.fetch = (async (_url: any, init?: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        sentIds.push(body.idempotencyKey || body.id);
        return new Response(
          JSON.stringify({
            status: 'success',
            ok: true,
            success: true,
            persisted: true,
            mutationId: m1.id,
            operation: 'attendance',
            studentId: 's-1',
            sheetName: 'نشط',
            friday: '2026-04-10',
            row: 12,
            newVersion: 2,
            verifiedAt: new Date().toISOString()
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
        targetMutationId: m1.id
      });
      assert.equal(report.sentCount, 1);
      assert.deepEqual(sentIds, [m1.id]);

      const remaining = await idbGetPendingMutations();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, m2.id);
      assert.equal(remaining[0].retryCount, 3);
      assert.equal(remaining[0].nextRetryAt, futureRetry + 60_000);
    });

    // TEST 4: Manual retry blocked when an earlier unresolved operation exists for the SAME student
    await runCase('Blocks manual retry on a later mutation when an earlier unresolved operation exists for the same student', async () => {
      const earlier = makeMutation({
        id: 'ATT_same_1',
        studentId: 's-same',
        timestamp: 1775800001000,
        status: 'conflict',
        errorCategory: 'conflict',
        lastError: 'HTTP 409'
      });
      const later = makeMutation({
        id: 'FU_same_2',
        studentId: 's-same',
        action: 'followup',
        payload: { friday: '2026-04-10', date: '2026-04-11', method: 'تم تليفونياً', recordId: 'rec-same-2' },
        timestamp: 1775800002000,
        status: 'pending'
      });

      await seedStudents([makeStudent({ id: 's-same', hasUnsyncedLocalChanges: true })]);
      await idbQueueMutation(earlier);
      await idbQueueMutation(later);

      // UI classifier guard
      const laterDisplay = classifyMutationDisplayState(later, [earlier, later]);
      assert.equal(laterDisplay.isBlockedByEarlierSameStudent, true);
      assert.equal(laterDisplay.canManualRetry, false);
      assert.equal(laterDisplay.earlierBlockingMutationId, earlier.id);
      assert.match(laterDisplay.manualRetryBlockedReason || '', /أقدم/);

      // Eligibility engine guard
      const elig = evaluateQueueMutationEligibility([earlier, later], { targetMutationId: later.id });
      assert.equal(elig.eligible.length, 0);
      assert.ok(elig.targetBlockedReason);

      // Execution guard: zero network calls allowed for blocked target
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const report = await executeProcessOfflineQueue(TEST_USER, false, undefined, undefined, {
        targetMutationId: later.id
      });
      assert.equal(fetchCalls, 0);
      assert.equal(report.sentCount, 0);
      assert.equal(report.remainingCount, 2);
    });

    // TEST 5: Safe clear confirmation cancellation deletes ZERO mutations
    await runCase('Safe clear cancellation deletes ZERO mutations and preserves student protection flags', async () => {
      await seedStudents([
        makeStudent({ id: 's-1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-2', hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(makeMutation({ id: 'm-c1', studentId: 's-1', status: 'pending' }));
      await idbQueueMutation(makeMutation({ id: 'm-c2', studentId: 's-2', status: 'conflict' }));

      let downloaderCalled = false;
      const res = await executeSafeClearMutations({
        confirmed: false,
        downloader: () => {
          downloaderCalled = true;
          return true;
        }
      });

      assert.equal(res.ok, false);
      assert.equal(res.cancelled, true);
      assert.equal(res.clearedCount, 0);
      assert.equal(res.remainingCount, 2);
      assert.equal(downloaderCalled, false);

      const remaining = await idbGetPendingMutations();
      assert.equal(remaining.length, 2);
      const students = await idbGetStudents();
      assert.equal(students.every((s) => s.hasUnsyncedLocalChanges === true), true);
    });

    // TEST 6: Safe clear creates fresh validated backup with exact IDs & payloads before clearing
    await runCase('Safe clear creates and strictly validates fresh backup containing exact target IDs and payloads before clearing', async () => {
      const m1 = makeMutation({
        id: 'ATT_b1',
        studentId: 's-1',
        action: 'attendance',
        payload: { friday: '2026-04-10', isPresent: true, nestedMeta: { source: 'card', seq: 1 } }
      });
      const m2 = makeMutation({
        id: 'FU_b2',
        studentId: 's-2',
        action: 'followup',
        payload: { friday: '2026-04-10', date: '2026-04-11', method: 'تم تليفونياً', recordId: 'rec-b2', notes: 'تم التواصل بنجاح' }
      });

      await seedStudents([
        makeStudent({ id: 's-1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-2', hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(m1);
      await idbQueueMutation(m2);

      let capturedJson = '';
      let capturedFileName = '';
      let countAtDownloadTime = -1;

      const res = await executeSafeClearMutations({
        confirmed: true,
        downloader: async ({ fileName, jsonString }) => {
          // Verify mutations have NOT been deleted yet when backup download runs!
          const currentBeforeDelete = await idbGetPendingMutations();
          countAtDownloadTime = currentBeforeDelete.length;
          capturedFileName = fileName;
          capturedJson = jsonString;
          return true;
        }
      });

      assert.equal(res.ok, true);
      assert.equal(countAtDownloadTime, 2, 'Backup MUST complete BEFORE any mutation is deleted');
      assert.equal(res.clearedCount, 2);
      assert.equal(res.remainingCount, 0);
      assert.equal(res.verifiedEmpty, true);
      assert.match(capturedFileName, /^stgorge-queue-recovery-backup-.*\.json$/);

      const parsed = JSON.parse(capturedJson);
      assert.equal(parsed.kind, 'stgorge_queue_recovery_backup');
      assert.equal(parsed.mutationCount, 2);
      assert.deepEqual(parsed.mutationIds.sort(), [m1.id, m2.id].sort());

      const strictCheck = validateQueueClearBackup(capturedJson, [m1, m2]);
      assert.equal(strictCheck.valid, true);

      const afterQueue = await idbGetPendingMutations();
      assert.equal(afterQueue.length, 0);
    });

    // TEST 7: Backup export/download failure aborts clear and deletes ZERO mutations
    await runCase('Backup download error or false return aborts clear and deletes ZERO mutations', async () => {
      await seedStudents([makeStudent({ id: 's-1', hasUnsyncedLocalChanges: true })]);
      await idbQueueMutation(makeMutation({ id: 'm-fail-dl-1', studentId: 's-1' }));
      await idbQueueMutation(makeMutation({ id: 'm-fail-dl-2', studentId: 's-1', timestamp: 1775800005000 }));

      const resThrow = await executeSafeClearMutations({
        confirmed: true,
        downloader: () => {
          throw new Error('Simulated download write failure');
        }
      });
      assert.equal(resThrow.ok, false);
      assert.equal(resThrow.clearedCount, 0);
      assert.equal((await idbGetPendingMutations()).length, 2);

      const resFalse = await executeSafeClearMutations({
        confirmed: true,
        downloader: () => false
      });
      assert.equal(resFalse.ok, false);
      assert.equal(resFalse.clearedCount, 0);
      assert.equal((await idbGetPendingMutations()).length, 2);
    });

    // TEST 8: Stale, malformed, missing-ID, or tampered-payload backup JSON is strictly rejected
    await runCase('Rejects stale historical backups, malformed JSON, missing IDs, and tampered payloads with ZERO deletions', async () => {
      const now = 1776000000000;
      const m1 = makeMutation({ id: 'm-v1', studentId: 's-1', payload: { friday: '2026-04-10', isPresent: true } });
      const m2 = makeMutation({ id: 'm-v2', studentId: 's-2', payload: { friday: '2026-04-10', isPresent: false } });

      await seedStudents([
        makeStudent({ id: 's-1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-2', hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(m1);
      await idbQueueMutation(m2);

      // (a) Stale historical backup (1 hour old > 5 min max age)
      const staleBackup = createQueueClearBackup([m1, m2], {
        nowIso: new Date(now - 60 * 60 * 1000).toISOString()
      });
      const resStale = await executeSafeClearMutations({
        confirmed: true,
        nowMs: now,
        backupJsonOverride: staleBackup.jsonString,
        downloader: () => true
      });
      assert.equal(resStale.ok, false);
      assert.equal(resStale.clearedCount, 0);
      assert.match(resStale.error || '', /قديمة/);

      // (b) Missing second mutation
      const incompleteBackup = createQueueClearBackup([m1], { nowIso: new Date(now).toISOString() });
      const resIncomplete = await executeSafeClearMutations({
        confirmed: true,
        nowMs: now,
        backupJsonOverride: incompleteBackup.jsonString,
        downloader: () => true
      });
      assert.equal(resIncomplete.ok, false);
      assert.equal(resIncomplete.clearedCount, 0);

      // (c) Tampered payload value
      const tamperedObj = JSON.parse(createQueueClearBackup([m1, m2], { nowIso: new Date(now).toISOString() }).jsonString);
      tamperedObj.mutations[0].payload.isPresent = false;
      const resTampered = await executeSafeClearMutations({
        confirmed: true,
        nowMs: now,
        backupJsonOverride: JSON.stringify(tamperedObj),
        downloader: () => true
      });
      assert.equal(resTampered.ok, false);
      assert.equal(resTampered.clearedCount, 0);
      assert.match(resTampered.error || '', /لا يطابق الحمولة/);

      // (d) Malformed JSON
      const resMalformed = await executeSafeClearMutations({
        confirmed: true,
        nowMs: now,
        backupJsonOverride: '{not-valid-json',
        downloader: () => true
      });
      assert.equal(resMalformed.ok, false);
      assert.equal(resMalformed.clearedCount, 0);

      // Zero mutations deleted across all 4 rejections
      assert.equal((await idbGetPendingMutations()).length, 2);
    });

    // TEST 9: Selective clear NEVER silently removes conflict or timeout_unknown mutations
    await runCase('Selective safe clear removes ONLY explicitly targeted IDs and preserves unselected conflict and timeout_unknown items', async () => {
      const mPending = makeMutation({ id: 'm-sel-pending', studentId: 's-1', status: 'pending' });
      const mConflict = makeMutation({ id: 'm-sel-conflict', studentId: 's-2', status: 'conflict' });
      const mTimeout = makeMutation({ id: 'm-sel-timeout', studentId: 's-3', status: 'timeout_unknown' });

      await seedStudents([
        makeStudent({ id: 's-1', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-2', hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-3', hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(mPending);
      await idbQueueMutation(mConflict);
      await idbQueueMutation(mTimeout);

      const res = await executeSafeClearMutations({
        confirmed: true,
        targetMutationIds: [mPending.id],
        downloader: () => true
      });

      assert.equal(res.ok, true);
      assert.equal(res.clearedCount, 1);
      assert.equal(res.remainingCount, 2);
      assert.equal(res.verifiedEmpty, false);

      const remaining = await idbGetPendingMutations();
      assert.deepEqual(remaining.map((m) => m.id).sort(), [mConflict.id, mTimeout.id].sort());

      const students = await idbGetStudents();
      const s1 = students.find((s) => s.id === 's-1')!;
      const s2 = students.find((s) => s.id === 's-2')!;
      const s3 = students.find((s) => s.id === 's-3')!;
      assert.equal(s1.hasUnsyncedLocalChanges, false);
      assert.equal(s2.hasUnsyncedLocalChanges, true);
      assert.equal(s3.hasUnsyncedLocalChanges, true);
    });

    // TEST 10: Removing one verified mutation preserves hasUnsyncedLocalChanges while another mutation remains for same student
    await runCase('Removing one mutation keeps hasUnsyncedLocalChanges=true while another mutation remains for the same student', async () => {
      const m1 = makeMutation({ id: 'm-multi-1', studentId: 's-shared', timestamp: 1775800001000 });
      const m2 = makeMutation({ id: 'm-multi-2', studentId: 's-shared', status: 'timeout_unknown', timestamp: 1775800002000 });

      await seedStudents([makeStudent({ id: 's-shared', hasUnsyncedLocalChanges: true })]);
      await idbQueueMutation(m1);
      await idbQueueMutation(m2);

      // Remove only first mutation -> student MUST remain protected
      await idbRemoveMutationsBatch([m1.id]);
      let sShared = (await idbGetStudents()).find((s) => s.id === 's-shared')!;
      assert.equal(sShared.hasUnsyncedLocalChanges, true);

      // Remove final remaining mutation -> flag cleanly clears
      await idbRemoveMutationsBatch([m2.id]);
      sShared = (await idbGetStudents()).find((s) => s.id === 's-shared')!;
      assert.equal(sShared.hasUnsyncedLocalChanges, false);
    });

    // TEST 11: Clearing queue resets stale hasUnsyncedLocalChanges so students are NOT permanently frozen from remote pulls
    await runCase('Clearing queue recalculates hasUnsyncedLocalChanges=false so future verified remote pulls are never frozen', async () => {
      await seedStudents([
        makeStudent({ id: 's-freeze-1', name: 'الاسم القديم 1', version: 2, hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-freeze-2', name: 'الاسم القديم 2', version: 2, hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(makeMutation({ id: 'm-f1', studentId: 's-freeze-1' }));
      await idbQueueMutation(makeMutation({ id: 'm-f2', studentId: 's-freeze-2' }));

      // Safe clear all
      const res = await executeSafeClearMutations({ confirmed: true, downloader: () => true });
      assert.equal(res.ok, true);
      assert.equal(res.clearedCount, 2);

      const afterClear = await idbGetStudents();
      assert.equal(afterClear.find((s) => s.id === 's-freeze-1')!.hasUnsyncedLocalChanges, false);
      assert.equal(afterClear.find((s) => s.id === 's-freeze-2')!.hasUnsyncedLocalChanges, false);

      // Also verify direct idbClearMutations() fixes stale flags atomically
      await seedStudents([
        makeStudent({ id: 's-freeze-1', name: 'الاسم القديم 1', version: 2, hasUnsyncedLocalChanges: true }),
        makeStudent({ id: 's-freeze-2', name: 'الاسم القديم 2', version: 2, hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(makeMutation({ id: 'm-f3', studentId: 's-freeze-1' }));
      const directCleared = await idbClearMutations();
      assert.equal(directCleared, 1);

      const afterDirectClear = await idbGetStudents();
      assert.equal(afterDirectClear.find((s) => s.id === 's-freeze-1')!.hasUnsyncedLocalChanges, false);
      assert.equal(afterDirectClear.find((s) => s.id === 's-freeze-2')!.hasUnsyncedLocalChanges, false);

      // Subsequent verified remote pull MUST update students cleanly (not frozen!)
      const proof: PullVerificationProof = {
        verified: true,
        isComplete: true,
        sheetName: 'نشط',
        source: 'gviz'
      };
      await idbReconcileStudents(
        [
          makeStudent({ id: 's-freeze-1', name: 'الاسم المحدث من الشيت 1', version: 3, hasRemoteVersion: true, hasUnsyncedLocalChanges: false }),
          makeStudent({ id: 's-freeze-2', name: 'الاسم المحدث من الشيت 2', version: 3, hasRemoteVersion: true, hasUnsyncedLocalChanges: false })
        ],
        await idbGetPendingMutations(),
        'نشط',
        true,
        proof
      );

      const afterPull = await idbGetStudents();
      assert.equal(afterPull.find((s) => s.id === 's-freeze-1')!.name, 'الاسم المحدث من الشيت 1');
      assert.equal(afterPull.find((s) => s.id === 's-freeze-2')!.name, 'الاسم المحدث من الشيت 2');
    });

    // TEST 12: Remaining conflict or timeout_unknown mutation protects local student data during remote pull
    await runCase('Remaining conflict or timeout_unknown mutations keep protecting local student data during verified remote pulls', async () => {
      await seedStudents([
        makeStudent({ id: 's-conf', name: 'بيانات محلية تعارض', notes: 'محمي بالتعارض', version: 2, hasUnsyncedLocalChanges: false }),
        makeStudent({ id: 's-to', name: 'بيانات محلية مهلة', notes: 'محمي بالمهلة', version: 2, hasUnsyncedLocalChanges: false }),
        makeStudent({ id: 's-clean', name: 'قديم نظيف', notes: 'قديم', version: 2, hasUnsyncedLocalChanges: true })
      ]);
      await idbQueueMutation(makeMutation({ id: 'm-conf', studentId: 's-conf', status: 'conflict' }));
      await idbQueueMutation(makeMutation({ id: 'm-to', studentId: 's-to', status: 'timeout_unknown' }));

      // Recalculate flags: raises flag on s-conf & s-to, clears stale flag on s-clean
      const recalc = await idbRecalculateUnsyncedStudentFlags();
      assert.equal(recalc.protectedCount, 2);
      assert.equal(recalc.raisedFlagCount, 2);
      assert.equal(recalc.clearedFlagCount, 1);

      const proof: PullVerificationProof = {
        verified: true,
        isComplete: true,
        sheetName: 'نشط',
        source: 'gviz'
      };
      await idbReconcileStudents(
        [
          makeStudent({ id: 's-conf', name: 'محاولة استبدال تعارض', notes: 'بعيد', version: 5, hasRemoteVersion: true, hasUnsyncedLocalChanges: false }),
          makeStudent({ id: 's-to', name: 'محاولة استبدال مهلة', notes: 'بعيد', version: 5, hasRemoteVersion: true, hasUnsyncedLocalChanges: false }),
          makeStudent({ id: 's-clean', name: 'محدث من الشيت', notes: 'جديد من الشيت', version: 5, hasRemoteVersion: true, hasUnsyncedLocalChanges: false })
        ],
        await idbGetPendingMutations(),
        'نشط',
        true,
        proof
      );

      const finalStudents = await idbGetStudents();
      const sConf = finalStudents.find((s) => s.id === 's-conf')!;
      const sTo = finalStudents.find((s) => s.id === 's-to')!;
      const sClean = finalStudents.find((s) => s.id === 's-clean')!;

      assert.equal(sConf.notes, 'محمي بالتعارض');
      assert.equal(sConf.hasUnsyncedLocalChanges, true);
      assert.equal(sTo.notes, 'محمي بالمهلة');
      assert.equal(sTo.hasUnsyncedLocalChanges, true);
      assert.equal(sClean.name, 'محدث من الشيت');
      assert.equal(sClean.hasUnsyncedLocalChanges, false);
    });

    // TEST 13: Local vs remote-verified notifications & UI modal contracts
    await runCase('Followup/attendance/update/add notifications strictly separate local save from confirmed remote persistence and modals enforce Phase 4.3.4 invariants', () => {
      const fuNotif = buildLocalSavedNotification('followup', 'مينا عادل', 'تم تليفونياً');
      assert.equal(fuNotif.type, 'info');
      assert.match(fuNotif.title, /محلياً/);
      assert.match(fuNotif.desc, /بانتظار المزامنة/);

      const attNotif = buildLocalSavedNotification('attendance', 'مينا عادل', 'حاضر');
      assert.equal(attNotif.type, 'info');
      assert.match(attNotif.title, /محلياً/);

      const updNotif = buildLocalSavedNotification('update', 'مينا عادل');
      assert.equal(updNotif.type, 'info');
      assert.match(updNotif.title, /محلياً/);

      const addNotif = buildLocalSavedNotification('add', 'مينا عادل');
      assert.equal(addNotif.type, 'info');
      assert.match(addNotif.title, /محلياً/);

      const remoteNotif = buildRemoteVerifiedNotification(1);
      assert.equal(remoteNotif.type, 'success');
      assert.match(remoteNotif.title, /تم تأكيد الحفظ على Google Sheets/);

      // Source-level contract checks on AppContext, QueueDetailsModal, SyncDetailsModal
      const appCtxSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/context/AppContext.tsx'), 'utf-8');
      assert.ok(appCtxSrc.includes('buildLocalSavedNotification'), 'AppContext must use buildLocalSavedNotification for local saves');
      assert.ok(appCtxSrc.includes('executeSafeClearMutations'), 'AppContext.clearOfflineQueue must route through executeSafeClearMutations');
      assert.ok(!appCtxSrc.includes("addNotification(\n          'تم تسجيل الافتقاد'"), 'recordFollowup must NOT emit premature success before remote proof');

      const queueModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/QueueDetailsModal.tsx'), 'utf-8');
      assert.ok(queueModalSrc.includes('classifyMutationDisplayState'), 'QueueDetailsModal must use 7-state classifier');
      assert.ok(queueModalSrc.includes('summarizeQueueMutations'), 'QueueDetailsModal must show breakdown counts');
      assert.ok(queueModalSrc.includes('clearConfirmChecked'), 'QueueDetailsModal must require explicit confirmation checkbox');
      assert.ok(queueModalSrc.includes('mutation.studentId'), 'QueueDetailsModal must display studentId');
      assert.ok(queueModalSrc.includes('isBlockedByEarlierSameStudent'), 'QueueDetailsModal must guard same-student ordering on manual retry');

      const syncModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/SyncDetailsModal.tsx'), 'utf-8');
      assert.ok(syncModalSrc.includes('summarizeQueueMutations'), 'SyncDetailsModal must display queue state breakdown');
      assert.ok(syncModalSrc.includes('تم تأكيد الحفظ على Google Sheets'), 'SyncDetailsModal must gate confirmed remote label');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\n✅ ALL ${passed}/13 Phase 4.3.4 Data Protection, Queue UI & Safe Recovery tests PASSED!\n`);
}

main().catch((err) => {
  console.error('\n❌ Phase 4.3.4 test suite FAILED:', err);
  process.exit(1);
});
