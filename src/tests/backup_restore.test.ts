import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
(globalThis as any).indexedDB = fakeIndexedDB;

const mockStorage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (mockStorage.has(key) ? mockStorage.get(key)! : null),
  setItem: (key: string, value: string) => {
    mockStorage.set(key, String(value));
  },
  removeItem: (key: string) => {
    mockStorage.delete(key);
  },
  clear: () => {
    mockStorage.clear();
  }
};

// Hard guarantee: no test in this suite can ever call network / Google Sheets
(globalThis as any).fetch = async () => {
  throw new Error('Network / Google Sheets access is strictly forbidden in backup_restore tests!');
};

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AttendanceHistoryRecord,
  INDEXED_DB_NAME,
  idbAddFollowupRecord,
  idbAtomicAddStudentWithMutation,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicRecordFollowupWithMutation,
  idbCloseDatabase,
  idbGetAttendanceHistory,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbGetStudents,
  idbInspectDatabaseSummary
} from '../services/indexedDbService';
import {
  BACKUP_SCHEMA_VERSION,
  LAST_BACKUP_META_KEY,
  createVerifiedBackupSnapshot,
  exportAndDownloadBackup,
  loadLastBackupMeta,
  previewBackupRestore,
  restoreVerifiedBackupFromJson,
  validateAndParseBackupJson
} from '../services/backupService';
import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { OfflineMutation } from '../types/auth';
import { ThemeProvider } from '../context/ThemeContext';
import { AuthProvider } from '../context/AuthContext';
import { AppProvider } from '../context/AppContext';
import { BackupRestoreModal } from '../components/modals/BackupRestoreModal';

async function resetFakeDatabase(): Promise<void> {
  idbCloseDatabase();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise<void>((resolve, reject) => {
    const req = fakeIndexedDB.deleteDatabase(INDEXED_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Failed to reset fake IndexedDB'));
    req.onblocked = () => resolve();
  });
  mockStorage.clear();
}

function makeStudent(overrides: Partial<Student> & { id: string; name: string }): Student {
  return {
    id: overrides.id,
    code: overrides.code || 'SG-1',
    name: overrides.name,
    servant: overrides.servant || 'ماركو ملجي',
    phoneStudent: overrides.phoneStudent || '01200000001',
    area: overrides.area || 'الزيتون',
    address: overrides.address || 'شارع طومان باي',
    notes: overrides.notes || '',
    followupStatus: overrides.followupStatus || 'بدون',
    attendanceTotal: overrides.attendanceTotal ?? 1,
    attendanceMonth: overrides.attendanceMonth ?? 1,
    attendanceStatus: overrides.attendanceStatus || 'حاضر',
    lastAttendance: overrides.lastAttendance || '2026-11-13',
    lastFollowup: overrides.lastFollowup,
    sourceSheet: overrides.sourceSheet || 'نشط',
    version: overrides.version ?? 1,
    att: overrides.att || { '2026-11-13': true },
    fu: overrides.fu || {}
  };
}

function makeFollowup(overrides: Partial<FollowupRecord> & { id: string; studentId: string; studentName: string }): FollowupRecord {
  return {
    id: overrides.id,
    date: overrides.date || '2026-11-18',
    fridayDate: overrides.fridayDate || '2026-11-13',
    studentId: overrides.studentId,
    studentCode: overrides.studentCode || 'SG-1',
    studentName: overrides.studentName,
    servant: overrides.servant || 'ماركو ملجي',
    type: overrides.type || 'تم تليفونياً',
    callOutcome: overrides.callOutcome,
    notes: overrides.notes || ''
  };
}

function makeMutation(overrides: Partial<OfflineMutation> & { id: string; studentId: string }): OfflineMutation {
  return {
    id: overrides.id,
    action: overrides.action || 'followup',
    studentId: overrides.studentId,
    studentCode: overrides.studentCode || 'SG-1',
    studentName: overrides.studentName || 'مخدوم تجريبي',
    sourceSheet: overrides.sourceSheet || 'نشط',
    payload: overrides.payload || { recordId: 'fu-1', friday: '2026-11-13', method: 'تم تليفونياً' },
    expectedVersion: overrides.expectedVersion ?? 1,
    timestamp: overrides.timestamp ?? 1700000000000,
    retryCount: overrides.retryCount ?? 0,
    status: overrides.status || 'pending'
  };
}

async function seedRichLocalDatabase() {
  const s1 = makeStudent({
    id: 'std-1',
    code: 'SG-101',
    name: 'كيرلس سامح إبراهيم',
    version: 2,
    lastAttendance: '2026-11-13',
    att: { '2026-11-06': true, '2026-11-13': true },
    fu: { '2026-11-13': 'تم تليفونياً' }
  });
  const mAdd1 = makeMutation({
    id: 'ADD_std-1',
    action: 'add',
    studentId: 'std-1',
    studentCode: 'SG-101',
    studentName: s1.name,
    payload: { name: s1.name }
  });
  await idbAtomicAddStudentWithMutation(s1, mAdd1);

  const s2 = makeStudent({
    id: 'std-2',
    code: 'SG-102',
    name: 'مايكل ميلاد عيد',
    sourceSheet: 'فصل البابا شنودة',
    version: 1,
    att: { '2026-11-13': false }
  });
  const hist2: AttendanceHistoryRecord = {
    id: 'std-2__2026-11-13',
    studentId: 'std-2',
    studentCode: 'SG-102',
    fridayDate: '2026-11-13',
    status: false,
    recordedAt: 1700000001000,
    sourceSheet: 'فصل البابا شنودة'
  };
  const mAtt2 = makeMutation({
    id: 'ATT_std-2_2026-11-13',
    action: 'attendance',
    studentId: 'std-2',
    studentCode: 'SG-102',
    studentName: s2.name,
    sourceSheet: 'فصل البابا شنودة',
    payload: { friday: '2026-11-13', isPresent: false }
  });
  await idbAtomicRecordAttendanceWithMutation(s2, hist2, mAtt2);

  const fu1 = makeFollowup({
    id: 'fu-1',
    studentId: 'std-1',
    studentCode: 'SG-101',
    studentName: s1.name,
    callOutcome: 'تم التواصل',
    notes: 'بيحضر في الأمير تادرس للامتحانات'
  });
  const mFu1 = makeMutation({
    id: 'FU_std-1_op1',
    action: 'followup',
    studentId: 'std-1',
    studentCode: 'SG-101',
    studentName: s1.name,
    payload: { recordId: 'fu-1', friday: '2026-11-13', method: 'تم تليفونياً', notes: fu1.notes }
  });
  await idbAtomicRecordFollowupWithMutation(s1, fu1, mFu1);

  const fu2 = makeFollowup({
    id: 'gs_fu_99',
    studentId: 'std-2',
    studentCode: 'SG-102',
    studentName: s2.name,
    date: '2026-10-19',
    fridayDate: '2026-10-16',
    type: 'اتصال',
    notes: 'ملاحظة قديمة'
  });
  await idbAddFollowupRecord(fu2);

  // LocalStorage: both safe settings AND sensitive connection keys
  localStorage.setItem('stgorge_theme', 'dim');
  localStorage.setItem('stgorge_sidebar_collapsed', '1');
  localStorage.setItem('stgorge_last_successful_pull_iso', '2026-11-18T10:00:00.000Z');
  localStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/ORIGINAL_URL/exec');
  localStorage.setItem('stgorge_relay_key', 'SUPER_SECRET_RELAY_KEY_DO_NOT_EXPORT');
  localStorage.setItem('stgorge_api_base_url', 'https://my-api.example.com');
}

async function runTests() {
  // --------------------------------------------------------------------------
  // Test 1: Consistent Export Across ALL 4 Stores + Excludes Sensitive Keys
  // --------------------------------------------------------------------------
  await resetFakeDatabase();
  await seedRichLocalDatabase();

  const summaryBefore = await idbInspectDatabaseSummary();
  assert.deepEqual(
    summaryBefore.storeNames.sort(),
    ['attendance_history', 'followup', 'mutations', 'students'],
    'DB must inspect all 4 object stores'
  );
  assert.equal(summaryBefore.counts.students, 2);
  assert.equal(summaryBefore.counts.followup, 2);
  assert.equal(summaryBefore.counts.mutations, 3);
  assert.equal(summaryBefore.counts.attendance_history, 1);
  assert.equal(summaryBefore.totalRecords, 8);

  const exportRes = await createVerifiedBackupSnapshot();
  assert.equal(exportRes.ok, true, 'Backup snapshot export must succeed');
  assert.ok(exportRes.jsonString && exportRes.payload && exportRes.meta);
  assert.equal(exportRes.payload.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.equal(exportRes.payload.databaseName, INDEXED_DB_NAME);
  assert.equal(exportRes.payload.counts.totalRecords, 8);
  assert.equal(exportRes.payload.stores.students.length, 2);
  assert.equal(exportRes.payload.stores.followup.length, 2);
  assert.equal(exportRes.payload.stores.mutations.length, 3);
  assert.equal(exportRes.payload.stores.attendance_history.length, 1);
  assert.equal(exportRes.payload.settings.theme, 'dim');
  assert.equal(exportRes.payload.settings.sidebarCollapsed, true);

  // Strict security assertion: secrets & connection URLs must NEVER appear in exported JSON
  assert.ok(!exportRes.jsonString.includes('SUPER_SECRET_RELAY_KEY_DO_NOT_EXPORT'), 'Must NOT export relay key');
  assert.ok(!exportRes.jsonString.includes('ORIGINAL_URL'), 'Must NOT export Apps Script URL');
  assert.ok(!exportRes.jsonString.includes('my-api.example.com'), 'Must NOT export API base URL');

  // Verify exportAndDownloadBackup only persists metadata when download succeeds
  const failedDl = await exportAndDownloadBackup(() => false);
  assert.equal(failedDl.ok, false, 'exportAndDownloadBackup must fail if browser download fails');
  assert.equal(loadLastBackupMeta(), null, 'Must NOT record last backup meta if download failed');

  const okDl = await exportAndDownloadBackup((blob, fname) => {
    assert.ok(blob.size > 0 && fname.endsWith('.json'));
    return true;
  });
  assert.equal(okDl.ok, true, 'exportAndDownloadBackup must succeed after verified download');
  const savedMeta = loadLastBackupMeta();
  assert.ok(savedMeta && savedMeta.totalRecords === 8, 'Must record verified last backup metadata');
  console.log('✅ Test 1 Passed: Consistent snapshot export across all stores, verified download, and zero secret leakage');

  // --------------------------------------------------------------------------
  // Test 2: Valid Restore into Clean DB + Preserves Connection Settings
  // --------------------------------------------------------------------------
  const exportedJson = exportRes.jsonString!;
  await resetFakeDatabase();
  localStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/CURRENT_ACTIVE_URL/exec');
  localStorage.setItem('stgorge_relay_key', 'CURRENT_ACTIVE_RELAY_KEY');

  const previewClean = await previewBackupRestore(exportedJson);
  assert.equal(previewClean.valid, true);
  if (previewClean.valid) {
    assert.equal(previewClean.preview.backupTotalRecords, 8);
    assert.equal(previewClean.preview.localTotalRecords, 0);
  }

  const restoreClean = await restoreVerifiedBackupFromJson(exportedJson);
  assert.equal(restoreClean.ok, true, 'Valid JSON restore into clean DB must succeed');
  assert.equal(restoreClean.mergeResult?.verified, true);
  assert.equal(restoreClean.mergeResult?.afterCounts.students, 2);
  assert.equal(restoreClean.mergeResult?.afterCounts.followup, 2);
  assert.equal(restoreClean.mergeResult?.afterCounts.mutations, 3);
  assert.equal(restoreClean.mergeResult?.afterCounts.attendance_history, 1);
  assert.equal(
    localStorage.getItem('stgorge_apps_script_url'),
    'https://script.google.com/macros/s/CURRENT_ACTIVE_URL/exec',
    'Restore must never alter current Apps Script URL'
  );
  assert.equal(
    localStorage.getItem('stgorge_relay_key'),
    'CURRENT_ACTIVE_RELAY_KEY',
    'Restore must never alter current Relay Key'
  );
  assert.equal(localStorage.getItem('stgorge_theme'), 'dim', 'Non-sensitive settings must restore cleanly');
  console.log('✅ Test 2 Passed: Valid backup restore into clean DB & connection settings preservation');

  // --------------------------------------------------------------------------
  // Test 3: Reject Corrupted / Invalid JSON & Unsupported Schema Version
  // --------------------------------------------------------------------------
  const corruptedCases = [
    '',
    '{ not valid json :::',
    '[]',
    JSON.stringify({ schemaVersion: 1, databaseName: 'WrongDB', backupDate: '2026-11-18T10:00:00Z', applicationVersion: '2.0', stores: { students: [], followup: [], mutations: [], attendance_history: [] } }),
    JSON.stringify({ schemaVersion: 1, databaseName: INDEXED_DB_NAME, backupDate: '2026-11-18T10:00:00Z', applicationVersion: '2.0', stores: { students: [] } }),
    JSON.stringify({ schemaVersion: 1, databaseName: INDEXED_DB_NAME, backupDate: 'not-a-date', applicationVersion: '2.0', stores: { students: [], followup: [], mutations: [], attendance_history: [] } }),
    JSON.stringify({ schemaVersion: 1, databaseName: INDEXED_DB_NAME, backupDate: '2026-11-18T10:00:00Z', applicationVersion: '2.0', stores: { students: [{ broken: true }], followup: [], mutations: [], attendance_history: [] } })
  ];
  for (const bad of corruptedCases) {
    const v = validateAndParseBackupJson(bad);
    assert.equal(v.valid, false, 'Corrupted/malformed JSON must be rejected');
    const r = await restoreVerifiedBackupFromJson(bad);
    assert.equal(r.ok, false, 'Restore must refuse corrupted JSON');
  }

  for (const badSchema of [0, 2, 99, '1', null, undefined]) {
    const payloadBadSchema = JSON.stringify({
      schemaVersion: badSchema,
      backupDate: '2026-11-18T10:00:00.000Z',
      applicationVersion: '2.0',
      databaseName: INDEXED_DB_NAME,
      stores: { students: [], followup: [], mutations: [], attendance_history: [] }
    });
    const v = validateAndParseBackupJson(payloadBadSchema);
    assert.equal(v.valid, false, `Unsupported schemaVersion (${String(badSchema)}) must be rejected`);
    const r = await restoreVerifiedBackupFromJson(payloadBadSchema);
    assert.equal(r.ok, false, `Restore must refuse unsupported schemaVersion (${String(badSchema)})`);
  }
  console.log('✅ Test 3 Passed: Corrupted JSON and unsupported schemaVersion rejected cleanly');

  // --------------------------------------------------------------------------
  // Test 4: Safe Merge — Duplicate Prevention, Zero Deletion, Newer Record Wins
  // --------------------------------------------------------------------------
  // Current DB has std-1 (version 2, att 2026-11-06 & 13), std-2 (version 1), fu-1, gs_fu_99, 3 mutations, hist2.
  // Upgrade std-1 locally to version 5 with newer phone & note, plus add brand new local student std-local-only.
  const localNewerStudent = makeStudent({
    id: 'std-1',
    code: 'SG-101',
    name: 'كيرلس سامح إبراهيم',
    version: 5,
    phoneStudent: '01299999999',
    notes: 'تحديث أحدث محلياً',
    lastAttendance: '2026-11-20',
    att: { '2026-11-06': true, '2026-11-13': true, '2026-11-20': true },
    fu: { '2026-11-13': 'تم تليفونياً', '2026-11-20': 'تم بزيارة' }
  });
  await idbAtomicAddStudentWithMutation(
    localNewerStudent,
    makeMutation({ id: 'UPD_std-1_local', action: 'update', studentId: 'std-1', studentName: localNewerStudent.name })
  );

  const localOnlyStudent = makeStudent({
    id: 'std-local-only',
    code: 'SG-999',
    name: 'مخدوم محلي جديد'
  });
  await idbAtomicAddStudentWithMutation(
    localOnlyStudent,
    makeMutation({ id: 'ADD_local_only', action: 'add', studentId: 'std-local-only', studentName: localOnlyStudent.name })
  );

  // Build an older backup containing:
  // - Duplicate std-1 with DIFFERENT id ('std-1-old-id') & older version 1 -> must deduplicate via name+sheet & NOT overwrite version 5!
  // - Duplicate followup with DIFFERENT id ('fu-dup-id') matching std-1 + 2026-11-18 + phone -> must deduplicate!
  // - Duplicate attendance_history with DIFFERENT id ('hist-alt-id') colliding on ['std-2', '2026-11-13'] -> must NOT throw ConstraintError or overwrite newer recordedAt!
  // - One genuinely missing historical followup 'fu-from-backup' & missing student 'std-from-backup' -> must be inserted!
  const backupWithDuplicatesAndOlder = JSON.stringify({
    schemaVersion: 1,
    backupDate: '2026-11-10T10:00:00.000Z',
    applicationVersion: '2.0',
    databaseName: INDEXED_DB_NAME,
    databaseVersion: 2,
    stores: {
      students: [
        makeStudent({
          id: 'std-1-old-id',
          code: 'SG-101',
          name: 'كيرلس سامح إبراهيم',
          version: 1,
          phoneStudent: '01000000000',
          notes: 'ملاحظة قديمة',
          att: { '2026-10-30': true, '2026-11-13': false } // 2026-10-30 is older history missing locally; 2026-11-13 conflicts with newer local!
        }),
        makeStudent({
          id: 'std-from-backup',
          code: 'SG-205',
          name: 'مينا أيمن فؤاد',
          sourceSheet: 'نشط'
        })
      ],
      followup: [
        makeFollowup({
          id: 'fu-dup-id',
          studentId: 'std-1-old-id',
          studentName: 'كيرلس سامح إبراهيم',
          date: '2026-11-18',
          fridayDate: '2026-11-13',
          type: 'تم تليفونياً',
          notes: 'ملاحظة قديمة لا تستبدل'
        }),
        makeFollowup({
          id: 'fu-from-backup',
          studentId: 'std-from-backup',
          studentCode: 'SG-205',
          studentName: 'مينا أيمن فؤاد',
          date: '2026-11-08',
          fridayDate: '2026-11-06',
          type: 'تم بزيارة',
          notes: 'زيارة مستعادة من النسخة'
        })
      ],
      mutations: [
        makeMutation({
          id: 'ATT_std-2_2026-11-13', // Same id
          action: 'attendance',
          studentId: 'std-2',
          payload: { friday: '2026-11-13', isPresent: false }
        }),
        makeMutation({
          id: 'FU_dup_by_recordId',
          action: 'followup',
          studentId: 'std-1-old-id',
          payload: { recordId: 'fu-1', friday: '2026-11-13', method: 'تم تليفونياً' } // Same recordId already in local queue
        })
      ],
      attendance_history: [
        {
          id: 'hist-alt-id',
          studentId: 'std-2',
          studentCode: 'SG-102',
          fridayDate: '2026-11-13',
          status: true,
          recordedAt: 1600000000000, // Older than local 1700000001000
          sourceSheet: 'فصل البابا شنودة'
        },
        {
          id: 'std-from-backup__2026-11-06',
          studentId: 'std-from-backup',
          studentCode: 'SG-205',
          fridayDate: '2026-11-06',
          status: true,
          recordedAt: 1700000000500,
          sourceSheet: 'نشط'
        }
      ]
    },
    settings: {}
  });

  const mergeRes = await restoreVerifiedBackupFromJson(backupWithDuplicatesAndOlder);
  assert.equal(mergeRes.ok, true, 'Safe merge restore must succeed without ConstraintError');
  const studentsAfterMerge = await idbGetStudents();
  const followupsAfterMerge = await idbGetFollowupRecords();
  const mutationsAfterMerge = await idbGetPendingMutations();
  const historyAfterMerge = await idbGetAttendanceHistory();

  // Existing local-only student preserved; duplicate std-1 NOT duplicated; new std-from-backup inserted -> 4 total
  assert.equal(studentsAfterMerge.length, 4, 'Must have 4 students (zero duplicates, zero deletions)');
  assert.ok(studentsAfterMerge.some((s) => s.id === 'std-local-only'), 'Existing local-only student must NOT be deleted');
  const std1After = studentsAfterMerge.find((s) => s.id === 'std-1')!;
  assert.equal(std1After.version, 5, 'Newer local student version must NOT be downgraded');
  assert.equal(std1After.phoneStudent, '01299999999', 'Newer local phone must NOT be overwritten');
  assert.equal(std1After.notes, 'تحديث أحدث محلياً', 'Newer local notes must NOT be overwritten');
  assert.equal(std1After.att['2026-11-13'], true, 'Newer local attendance status must NOT be overwritten');
  assert.equal(std1After.att['2026-10-30'], true, 'Missing older attendance date must still be backfilled safely');

  // Followup: 2 existing + 1 new ('fu-from-backup') = 3 (duplicate fu-dup-id prevented)
  assert.equal(followupsAfterMerge.length, 3, 'Duplicate followup record must be prevented');
  const fuFromBackup = followupsAfterMerge.find((f) => f.id === 'fu-from-backup')!;
  assert.equal(fuFromBackup.notes, 'زيارة مستعادة من النسخة');

  // Mutations: 5 existing, zero duplicate queued mutations added
  assert.equal(mutationsAfterMerge.length, 5, 'Duplicate queued mutations must be prevented');

  // Attendance history: existing std-2__2026-11-13 preserved with status=false (older recordedAt ignored), std-from-backup inserted = 2
  assert.equal(historyAfterMerge.length, 2, 'Attendance history unique student_friday must deduplicate cleanly');
  const std2HistAfter = historyAfterMerge.find((h) => h.studentId === 'std-2' && h.fridayDate === '2026-11-13')!;
  assert.equal(std2HistAfter.status, false, 'Older backup attendance history must NOT overwrite newer local record');
  console.log('✅ Test 4 Passed: Safe merge prevents duplicates, keeps local data intact, and newer records win');

  // --------------------------------------------------------------------------
  // Test 5: Transaction Failure Rollback — Original Data 100% Intact
  // --------------------------------------------------------------------------
  const snapshotBeforeFail = await createVerifiedBackupSnapshot();
  assert.equal(snapshotBeforeFail.ok, true);
  localStorage.setItem('stgorge_theme', 'dark');

  const txFailJson = JSON.stringify({
    schemaVersion: 1,
    backupDate: '2026-11-18T12:00:00.000Z',
    applicationVersion: '2.0',
    databaseName: INDEXED_DB_NAME,
    stores: {
      students: [
        makeStudent({ id: 'std-rollback-should-not-exist', code: 'SG-777', name: 'لا يجب أن يُحفظ' })
      ],
      followup: [
        makeFollowup({ id: 'fu-rollback-should-not-exist', studentId: 'std-rollback-should-not-exist', studentName: 'لا يجب أن يُحفظ' })
      ],
      mutations: [],
      attendance_history: []
    },
    settings: {
      theme: 'light',
      notifications: [{ id: 'notif-rollback', title: 'اختبار', type: 'info', timestamp: Date.now(), unread: true }]
    }
  });

  const failedRestore = await restoreVerifiedBackupFromJson(txFailJson, {
    _beforeCommitHook: () => {
      throw new Error('Simulated mid-transaction IndexedDB failure');
    }
  });
  assert.equal(failedRestore.ok, false, 'Mid-transaction failure must fail restore cleanly');

  const snapshotAfterFail = await createVerifiedBackupSnapshot();
  assert.equal(snapshotAfterFail.ok, true);
  assert.deepEqual(
    snapshotAfterFail.payload?.counts,
    snapshotBeforeFail.payload?.counts,
    'Exact record counts in all stores must remain identical after failed transaction'
  );
  assert.deepEqual(
    snapshotAfterFail.payload?.stores,
    snapshotBeforeFail.payload?.stores,
    'Every single record across all 4 stores must remain 100% untouched after transaction rollback'
  );
  assert.equal(localStorage.getItem('stgorge_theme'), 'dark', 'Settings must NOT be modified if IDB transaction fails');
  console.log('✅ Test 5 Passed: Mid-transaction failure rolls back completely leaving original DB & settings intact');

  // --------------------------------------------------------------------------
  // Test 6: UI Contracts & SSR Verification (Settings Entry + Warnings + No Secrets)
  // --------------------------------------------------------------------------
  const backupModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/BackupRestoreModal.tsx'), 'utf-8');
  const sidebarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf-8');
  const syncModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/SyncDetailsModal.tsx'), 'utf-8');
  const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

  assert.ok(backupModalSrc.includes('إنشاء نسخة احتياطية JSON'));
  assert.ok(backupModalSrc.includes('استعادة نسخة احتياطية JSON'));
  assert.ok(backupModalSrc.includes('تاريخ آخر نسخة احتياطية'));
  assert.ok(backupModalSrc.includes('عدد السجلات داخل النسخة'));
  assert.ok(backupModalSrc.includes('تحذير مهم قبل الاستعادة'));
  assert.ok(backupModalSrc.includes('تأكيد الاستعادة والدمج الآمن'));
  assert.ok(!/Liquid Glass/i.test(backupModalSrc));
  assert.ok(sidebarSrc.includes('النسخ الاحتياطي والاستعادة'));
  assert.ok(syncModalSrc.includes('النسخ الاحتياطي والاستعادة'));
  assert.ok(appSrc.includes('<BackupRestoreModal />'));

  // Verify SSR render of BackupRestoreModal does not crash
  const ssrHtml = renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(BackupRestoreModal))
      )
    )
  );
  assert.equal(typeof ssrHtml, 'string');
  console.log('✅ Test 6 Passed: BackupRestoreModal UI contracts and SSR verified');

  // Confirm backupService exports schema constants properly
  assert.equal(LAST_BACKUP_META_KEY, 'stgorge_last_backup_meta');
  console.log('\n🎉 ALL Phase 4.1 Backup & Safe Restore Tests Passed!');
}

runTests().catch((err) => {
  console.error('❌ Backup/Restore Tests Failed:', err);
  process.exit(1);
});
