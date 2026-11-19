/**
 * Phase 4.2.1 — Critical Data Integrity Fixes Test Suite
 *
 * Covers all 9 mandatory audit-driven scenarios using fake-indexeddb + mocked fetch + SSR UI checks:
 * 1. Partial Sync (__ALL__) with skipped/unverified tabs (Gviz & Relay unconfirmed-empty) + startup notification fallback
 * 2. Last Successful Sync Time strictly unchanged during Partial Sync (updated only on Full Sync)
 * 3. UI visual indicator for 'partial' state is distinct amber/warning (NOT green 'synced')
 * 4. Stable student identity across row reordering/insertion, atomic legacy ID migration across all 4 IDB stores,
 *    non-destructive absent-ID preservation, and cautious handling of unkeyed/duplicate-code rows
 * 5. Local records without version (undefined / 0) handled safely
 * 6. Version protection & Relay version: 1 conflict vs legitimate remote updates after sync + Gviz version provenance
 * 7. Partial / unverified / malformed Followup Log response rejected without touching existing followups
 * 8. Gviz Probe hardening: Fail-Closed on network/HTTP failure, sig-precedence (no false positive on distinct sig),
 *    and full-table 64-bit fingerprint detecting middle-row differences when sig is absent
 * 9. Canary records preserved across ALL 4 stores (students, followup, attendance_history, mutations) + 0 POST calls
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockLocalStorage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mockLocalStorage.has(k) ? mockLocalStorage.get(k)! : null),
  setItem: (k: string, v: string) => {
    mockLocalStorage.set(k, String(v));
  },
  removeItem: (k: string) => {
    mockLocalStorage.delete(k);
  },
  clear: () => {
    mockLocalStorage.clear();
  },
  key: (idx: number) => Array.from(mockLocalStorage.keys())[idx] ?? null,
  get length() {
    return mockLocalStorage.size;
  }
};

(globalThis as any).window = {
  location: { origin: 'http://localhost:3000', protocol: 'http:', hostname: 'localhost' },
  localStorage: (globalThis as any).localStorage
};

import {
  idbCloseDatabase,
  idbGetStudents,
  idbSaveStudents,
  idbReconcileStudents,
  idbGetFollowupRecords,
  idbSaveRemoteFollowupRecords,
  idbGetAttendanceHistory,
  idbGetPendingMutations,
  idbRemoveMutation,
  idbAtomicRecordAttendanceWithMutation,
  idbAtomicRecordFollowupWithMutation,
  idbMigrateLegacyStudentIds,
  getIndexedDB,
  PullVerificationProof,
  FollowupPullVerificationProof
} from '../services/indexedDbService';
import {
  NONEXISTENT_SHEET_PROBE_NAME,
  buildStableStudentIdFromCode,
  computeGvizTableFingerprint,
  matchesDefaultFallbackProbe,
  probeGvizDefaultFallback,
  parseGoogleVisualizationResponseDetailed,
  fetchSheetStudentsViaGviz,
  fetchFollowupLogViaGvizDetailed
} from '../services/googleSheetParser';
import {
  AppContext,
  AppContextType,
  PartialSyncInfo,
  executeSyncData
} from '../context/AppContext';
import { SyncStatusIndicator } from '../components/glass/SyncStatusIndicator';
import { SyncDetailsModal } from '../components/modals/SyncDetailsModal';
import { loadAndMigrateNotifications } from '../services/notificationStorageService';
import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { OfflineMutation } from '../types/auth';

const DEFAULT_SPREADSHEET_ID = '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0';
const VALID_STUDENT_HEADERS = ['الكود', 'الاسم', 'الخادم', 'التليفون', '2026-10-09', '2026-10-16'];
const FORM_FALLBACK_HEADERS = ['طابع زمني', 'الرد الأول', 'عنوان البريد الإلكتروني'];
const FOLLOWUP_LOG_HEADERS = ['التاريخ', 'أسبوع الجمعة', 'الاسم', 'النوع', 'الأشبين', 'ملاحظات'];

function buildGvizPayload(options: {
  sig?: string;
  headers: string[];
  rows: (string | number | null)[][];
  status?: 'ok' | 'error';
  errors?: Array<{ reason?: string; message?: string }>;
  warnings?: Array<{ reason?: string; message?: string }>;
}): string {
  const payload: any = {
    version: '0.6',
    reqId: '0',
    status: options.status || 'ok'
  };
  if (options.sig !== undefined) payload.sig = options.sig;
  if (options.errors) payload.errors = options.errors;
  if (options.warnings) payload.warnings = options.warnings;
  if ((options.status || 'ok') === 'ok') {
    payload.table = {
      cols: options.headers.map((label, idx) => ({ id: String.fromCharCode(65 + idx), label, type: 'string' })),
      rows: options.rows.map((cells) => ({
        c: cells.map((val) => (val === null ? null : { v: val, f: String(val) }))
      }))
    };
  }
  return `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(payload)});`;
}

async function resetFakeDatabase(): Promise<void> {
  idbCloseDatabase();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('StGorgeServiceDB');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function makeStudent(overrides: Partial<Student>): Student {
  return {
    id: overrides.id || 'gs_code_نشط_101',
    code: overrides.code ?? '101',
    name: overrides.name || 'طالب افتراضي',
    servant: overrides.servant || 'ماركو ملجي فارس',
    phoneStudent: overrides.phoneStudent || '01200000000',
    phoneParent1: overrides.phoneParent1 || '',
    phoneParent2: overrides.phoneParent2 || '',
    birthDate: overrides.birthDate || '',
    area: overrides.area || 'شبرا',
    address: overrides.address || '',
    notes: overrides.notes || '',
    followupStatus: overrides.followupStatus || 'بدون',
    attendanceTotal: overrides.attendanceTotal ?? 1,
    attendanceMonth: overrides.attendanceMonth ?? 1,
    attendanceStatus: overrides.attendanceStatus || 'حاضر',
    sourceSheet: overrides.sourceSheet || 'نشط',
    version: overrides.version ?? 1,
    att: overrides.att || { '2026-10-16': true },
    fu: overrides.fu || {},
    ...overrides
  };
}

function createMockFetch(
  handler: (url: string, init?: RequestInit) => { ok?: boolean; status?: number; body?: string; throwError?: Error },
  httpAudit: string[]
) {
  return async (input: any, init?: RequestInit): Promise<any> => {
    const url = typeof input === 'string' ? input : String(input?.url || input);
    const method = (init?.method || 'GET').toUpperCase();
    httpAudit.push(`${method} ${url}`);
    if (method !== 'GET') {
      throw new Error(`FORBIDDEN WRITE CALL IN PHASE 4.2.1 TEST: ${method} ${url}`);
    }
    const res = handler(url, init);
    if (res.throwError) throw res.throwError;
    const status = res.status ?? 200;
    const ok = res.ok ?? (status >= 200 && status < 300);
    const textBody = res.body ?? '';
    return {
      ok,
      status,
      text: async () => textBody,
      json: async () => JSON.parse(textBody || '{}')
    };
  };
}

async function seedCanaryAcrossAllFourStores() {
  const canaryStudent = makeStudent({
    id: 'canary_st_inactive_999',
    code: '999',
    name: 'كناري غير نشط محفوظ',
    sourceSheet: 'غير نشط',
    version: 3
  });
  const canaryFollowup: FollowupRecord = {
    id: 'canary_fu_1',
    date: '2026-10-20',
    fridayDate: '2026-10-16',
    studentId: 'canary_st_inactive_999',
    studentCode: '999',
    studentName: 'كناري غير نشط محفوظ',
    servant: 'ماركو ملجي فارس',
    type: 'اتصال',
    notes: 'سجل كناري لا يجوز مسحه'
  };
  const canaryHistory = {
    id: 'canary_st_inactive_999__2026-10-16',
    studentId: 'canary_st_inactive_999',
    studentCode: '999',
    fridayDate: '2026-10-16',
    status: true,
    recordedAt: Date.now(),
    sourceSheet: 'غير نشط'
  };
  const canaryMutation: OfflineMutation = {
    id: 'canary_mut_1',
    action: 'update',
    studentId: 'canary_st_inactive_999',
    studentCode: '999',
    studentName: 'كناري غير نشط محفوظ',
    sourceSheet: 'غير نشط',
    payload: { notes: 'تعديل كناري معلق' },
    expectedVersion: 3,
    timestamp: Date.now(),
    retryCount: 0,
    status: 'pending'
  };

  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['students', 'followup', 'attendance_history', 'mutations'], 'readwrite');
    tx.objectStore('students').put(canaryStudent);
    tx.objectStore('followup').put(canaryFollowup);
    tx.objectStore('attendance_history').put(canaryHistory);
    tx.objectStore('mutations').put(canaryMutation);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return { canaryStudent, canaryFollowup, canaryHistory, canaryMutation };
}

async function runTests() {
  console.log('\n================================================================');
  console.log('🧪 Phase 4.2.1 — Critical Data Integrity Fixes Test Suite');
  console.log('================================================================\n');

  let passed = 0;
  const allHttpCalls: string[] = [];

  // ------------------------------------------------------------------
  // TEST 1 & 2: Partial Sync State + Last Sync Time Unchanged + Startup Notification Fallback
  //             (Both Gviz path and Relay unconfirmed-empty path)
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const localInactive = makeStudent({
      id: 'gs_code_غير نشط_801',
      code: '801',
      name: 'مخدوم غير نشط محلي',
      sourceSheet: 'غير نشط'
    });
    await idbSaveStudents([localInactive], 'غير نشط', true);

    // 1A: Gviz __ALL__ where 'نشط' & 'فصل البابا شنودة' succeed, 'غير نشط' falls back
    (globalThis as any).fetch = createMockFetch((url) => {
      const sheet = new URL(url).searchParams.get('sheet') || '';
      if (sheet === 'نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_active_t1',
            headers: VALID_STUDENT_HEADERS,
            rows: [['101', 'كريس جوزيف عاطف', 'ماركو ملجي فارس', '01211111111', '1', '1']]
          })
        };
      }
      if (sheet === 'غير حاضر') {
        return {
          body: buildGvizPayload({
            sig: 'sig_absent_t1',
            headers: VALID_STUDENT_HEADERS,
            rows: [['151', 'كاراس أسامة سلامة', 'ماركو ملجي فارس', '01215151515', '0', '0']]
          })
        };
      }
      if (sheet === 'فصل البابا شنودة ') {
        return {
          body: buildGvizPayload({
            sig: 'sig_pope_t1',
            headers: VALID_STUDENT_HEADERS,
            rows: [['201', 'توماس كامل يوسف فرج', 'ماركو ملجي فارس', '01222222222', '1', '0']]
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return { body: buildGvizPayload({ sig: 'sig_fu_t1', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
      }
      return {
        body: buildGvizPayload({
          sig: 'sig_default_forms_t1',
          headers: FORM_FALLBACK_HEADERS,
          rows: [['2026-10-01', 'نموذج', 'x@y.com']]
        })
      };
    }, allHttpCalls);

    const existingLastSyncIso = '2026-10-15T10:00:00.000Z';
    let lastSyncTime = existingLastSyncIso;
    let recordTimesCalls = 0;
    let partialInfo: PartialSyncInfo | null = null;
    const syncLock = { current: false };

    // Deliberately omit onNotify (undefined) to verify startup/headless notification persistence!
    const gvizOutcome = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined, // onNotify omitted!
      undefined,
      (iso) => {
        recordTimesCalls++;
        lastSyncTime = iso;
      },
      undefined,
      undefined,
      undefined,
      (info) => {
        partialInfo = info;
      }
    );

    assert.equal(gvizOutcome, 'partial', 'Gviz __ALL__ with skipped tab MUST return "partial", not true');
    assert.equal(recordTimesCalls, 0, 'Last Successful Sync Time MUST NOT be updated on Partial Sync');
    assert.equal(lastSyncTime, existingLastSyncIso, 'Existing Last Successful Sync Time must stay strictly unchanged');
    assert.ok(partialInfo, 'onRecordPartialSync must receive PartialSyncInfo');
    assert.deepEqual((partialInfo as PartialSyncInfo).skippedSheets, ['غير نشط']);
    assert.equal((partialInfo as PartialSyncInfo).appliedSheets.includes('نشط'), true);
    assert.equal((partialInfo as PartialSyncInfo).appliedSheets.includes('فصل البابا شنودة'), true);

    // Startup fallback notification persisted in storage even when onNotify was undefined!
    const storedNotifs = loadAndMigrateNotifications().notifications;
    assert.equal(
      storedNotifs.some((n) => n.type === 'warn' && n.title.includes('مزامنة جزئية')),
      true,
      'Warning notification must be persisted when onNotify is omitted during partial startup sync'
    );

    // 1B: Relay __ALL__ where 'نشط' has rows, 'فصل البابا شنودة' is confirmedEmpty, and 'غير نشط' is unconfirmed empty
    mockLocalStorage.set('stgorge_apps_script_url', 'https://script.google.com/macros/s/TEST_MOCK_RELAY/exec');
    mockLocalStorage.set('stgorge_relay_key', 'TEST_RELAY_KEY_LOCAL');

    (globalThis as any).fetch = createMockFetch((url) => {
      if (url.includes('script.google.com')) {
        return {
          body: JSON.stringify({
            ok: true,
            students: [
              makeStudent({
                id: 'gs_code_نشط_101',
                code: '101',
                name: 'كريس جوزيف عاطف',
                sourceSheet: 'نشط',
                version: 1
              }),
              makeStudent({
                id: 'gs_code_غير حاضر_151',
                code: '151',
                name: 'كاراس أسامة سلامة',
                sourceSheet: 'غير حاضر',
                version: 1
              })
            ],
            confirmedEmptySheets: ['فصل البابا شنودة'],
            sheetsMeta: {
              'نشط': { verified: true, isComplete: true },
              'غير حاضر': { verified: true, isComplete: true },
              'فصل البابا شنودة': { verified: true, isComplete: true }
            }
          })
        };
      }
      return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
    }, allHttpCalls);

    let relayPartialInfo: PartialSyncInfo | null = null;
    let relayRecordTimesCalls = 0;
    const relayOutcome = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      () => {
        relayRecordTimesCalls++;
      },
      undefined,
      undefined,
      undefined,
      (info) => {
        relayPartialInfo = info;
      }
    );

    assert.equal(relayOutcome, 'partial', 'Relay __ALL__ with unconfirmed empty tab MUST return "partial"');
    assert.equal(relayRecordTimesCalls, 0, 'Relay Partial Sync MUST NOT update Last Successful Sync Time');
    assert.deepEqual(
      (relayPartialInfo as PartialSyncInfo | null)?.skippedSheets,
      ['غير نشط'],
      'Unconfirmed empty Relay tab MUST be recorded in skippedSheets'
    );

    // 1C: Full Relay Sync (all 3 tabs confirmed) -> returns true, clears partialSyncInfo, updates Last Sync Time
    (globalThis as any).fetch = createMockFetch((url) => {
      if (url.includes('script.google.com')) {
        return {
          body: JSON.stringify({
            ok: true,
            students: [
              makeStudent({ id: 'gs_code_نشط_101', code: '101', name: 'كريس جوزيف عاطف', sourceSheet: 'نشط', version: 1 }),
              makeStudent({ id: 'gs_code_غير حاضر_151', code: '151', name: 'كاراس أسامة سلامة', sourceSheet: 'غير حاضر', version: 1 }),
              makeStudent({ id: 'gs_code_غير نشط_801', code: '801', name: 'مخدوم غير نشط محلي', sourceSheet: 'غير نشط', version: 1 })
            ],
            confirmedEmptySheets: ['فصل البابا شنودة'],
            sheetsMeta: {
              'نشط': { verified: true, isComplete: true },
              'غير حاضر': { verified: true, isComplete: true },
              'غير نشط': { verified: true, isComplete: true },
              'فصل البابا شنودة': { verified: true, isComplete: true }
            }
          })
        };
      }
      return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
    }, allHttpCalls);

    const fullOutcome = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      (iso) => {
        relayRecordTimesCalls++;
        lastSyncTime = iso;
      },
      undefined,
      undefined,
      undefined,
      (info) => {
        relayPartialInfo = info;
      }
    );
    assert.equal(fullOutcome, true, 'Full verified sync must return true');
    assert.equal(relayRecordTimesCalls, 1, 'Full sync MUST update Last Successful Sync Time');
    assert.equal(relayPartialInfo, null, 'Full sync MUST clear partialSyncInfo');

    mockLocalStorage.clear();
    console.log('✅ Test 1 & 2 Passed: Partial Sync returns "partial", preserves Last Sync Time, notifies on startup, enforces uniform Relay & Gviz completeness');
    passed += 2;
  }

  // ------------------------------------------------------------------
  // TEST 3: Visual Indicator for 'partial' state is distinct non-green warning
  // ------------------------------------------------------------------
  {
    const mockCtx: Partial<AppContextType> = {
      syncState: 'partial',
      isSyncing: false,
      isOnline: true,
      pendingMutationsCount: 0,
      lastSyncError: null,
      lastSyncReport: null,
      lastSuccessfulPullTime: '2026-10-15T10:00:00.000Z',
      lastSuccessfulPushTime: null,
      lastSuccessfulSyncTime: '15 أكتوبر • 10:00 ص',
      lastSuccessfulSyncCompact: '15/10 10:00 ص',
      isSyncModalOpen: true,
      partialSyncInfo: {
        skippedSheets: ['غير نشط'],
        appliedSheets: ['نشط', 'فصل البابا شنودة'],
        timestamp: '2026-10-20T12:00:00.000Z'
      },
      setIsSyncModalOpen: () => {},
      setIsQueueModalOpen: () => {},
      setIsBackupModalOpen: () => {},
      syncData: async () => false,
      processOfflineQueue: async () => ({
        success: true,
        outcome: 'success',
        sentCount: 0,
        deduplicatedCount: 0,
        verifiedPostTimeoutCount: 0,
        remainingCount: 0,
        unknownResultCount: 0,
        failedCount: 0,
        conflictCount: 0,
        mode: 'single',
        totalDurationMs: 0
      })
    };

    const indicatorHtml = renderToStaticMarkup(
      React.createElement(
        AppContext.Provider,
        { value: mockCtx as AppContextType },
        React.createElement(SyncStatusIndicator)
      )
    );

    assert.equal(indicatorHtml.includes('data-sync-state="partial"'), true, 'Indicator must expose data-sync-state="partial"');
    assert.equal(indicatorHtml.includes('var(--warning-bg)'), true, 'Partial indicator MUST use warning background token');
    assert.equal(indicatorHtml.includes('var(--warning-text)'), true, 'Partial indicator MUST use warning text token');
    assert.equal(indicatorHtml.includes('مزامنة جزئية (1 غير مؤكد)'), true, 'Partial indicator MUST show Arabic skipped count label');
    assert.equal(indicatorHtml.includes('var(--success-bg)'), false, 'Partial indicator MUST NOT render green success background');
    assert.equal(indicatorHtml.includes('var(--success-text)'), false, 'Partial indicator MUST NOT render green success text');

    const modalHtml = renderToStaticMarkup(
      React.createElement(
        AppContext.Provider,
        { value: mockCtx as AppContextType },
        React.createElement(SyncDetailsModal)
      )
    );
    assert.equal(modalHtml.includes('مزامنة جزئية'), true, 'SyncDetailsModal must explain partial sync status');
    assert.equal(modalHtml.includes('غير نشط'), true, 'SyncDetailsModal must list skipped tab names');

    console.log('✅ Test 3 Passed: Partial Sync UI indicator & details modal render distinct non-green amber warning state');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 4: Stable Student Identity (Row Reordering + Legacy Migration + Non-Destructive Absent ID + Unkeyed Caution)
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    // 4A: Row reordering & top insertion MUST produce identical stable student IDs (zero row-index dependency)
    const order1Text = buildGvizPayload({
      sig: 'sig_order_1',
      headers: VALID_STUDENT_HEADERS,
      rows: [
        ['101', 'كريس جوزيف عاطف', 'ماركو ملجي فارس', '01211111111', '1', '1'],
        ['102', 'توماس كامل يوسف فرج', 'ماركو ملجي فارس', '01222222222', '1', '0']
      ]
    });
    const order2Text = buildGvizPayload({
      sig: 'sig_order_2',
      headers: VALID_STUDENT_HEADERS,
      rows: [
        ['103', 'مخدوم جديد في الصف الأول', 'ماركو ملجي فارس', '01233333333', '0', '1'],
        ['102', 'توماس كامل يوسف فرج', 'ماركو ملجي فارس', '01222222222', '1', '1'],
        ['101', 'كريس جوزيف عاطف', 'ماركو ملجي فارس', '01211111111', '1', '1']
      ]
    });

    const parsed1 = parseGoogleVisualizationResponseDetailed(order1Text, 'نشط');
    const parsed2 = parseGoogleVisualizationResponseDetailed(order2Text, 'نشط');

    const chris1 = parsed1.students.find((s) => s.code === '101')!;
    const chris2 = parsed2.students.find((s) => s.code === '101')!;
    const thomas1 = parsed1.students.find((s) => s.code === '102')!;
    const thomas2 = parsed2.students.find((s) => s.code === '102')!;

    assert.equal(chris1.id, buildStableStudentIdFromCode('نشط', '101'));
    assert.equal(chris1.id, chris2.id, 'Chris ID MUST remain identical after row insertion & reordering');
    assert.equal(thomas1.id, thomas2.id, 'Thomas ID MUST remain identical after row insertion & reordering');
    assert.equal(chris1.identityQuality, 'stable_code');
    assert.equal(chris1.hasRemoteVersion, false, 'Gviz without version column MUST set hasRemoteVersion: false');

    // 4B: Legacy row-indexed ID (`gs_نشط_101_3`) migrates atomically across ALL 4 stores without losing links!
    const legacyId = 'gs_نشط_101_3';
    const legacyStudent = makeStudent({
      id: legacyId,
      code: '101',
      name: 'كريس جوزيف عاطف',
      sourceSheet: 'نشط',
      version: 2
    });
    const absentLocalStudent = makeStudent({
      id: 'st_local_only_must_not_delete',
      code: '777',
      name: 'مخدوم محلي غير موجود بالرد القادم',
      sourceSheet: 'نشط',
      version: 1
    });

    const db = await getIndexedDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['students', 'followup', 'attendance_history', 'mutations'], 'readwrite');
      tx.objectStore('students').put(legacyStudent);
      tx.objectStore('students').put(absentLocalStudent);
      tx.objectStore('followup').put({
        id: 'fu_legacy_link_1',
        date: '2026-10-20',
        fridayDate: '2026-10-16',
        studentId: legacyId,
        studentCode: '101',
        studentName: 'كريس جوزيف عاطف',
        servant: 'ماركو ملجي فارس',
        type: 'اتصال',
        notes: 'مرتبط بالمعرف القديم'
      });
      tx.objectStore('attendance_history').put({
        id: `${legacyId}__2026-10-09`,
        studentId: legacyId,
        studentCode: '101',
        fridayDate: '2026-10-09',
        status: true,
        recordedAt: Date.now(),
        sourceSheet: 'نشط'
      });
      tx.objectStore('mutations').put({
        id: 'mut_legacy_link_1',
        action: 'update',
        studentId: legacyId,
        studentCode: '101',
        studentName: 'كريس جوزيف عاطف',
        sourceSheet: 'نشط',
        payload: { notes: 'تعديل قديم مرتبط بالمعرف' },
        expectedVersion: 2,
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending'
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Reconcile with canonical IDs from order2 (where Chris moved to row 3, and absentLocalStudent is NOT in response)
    const canonicalChrisId = buildStableStudentIdFromCode('نشط', '101');
    const pendingBefore = await idbGetPendingMutations();
    const verifiedProof: PullVerificationProof = {
      verified: true,
      isComplete: true,
      sheetName: 'نشط',
      source: 'gviz'
    };
    await idbReconcileStudents(parsed2.students, pendingBefore, 'نشط', true, verifiedProof);

    const studentsAfterMig = await idbGetStudents();
    assert.equal(studentsAfterMig.some((s) => s.id === legacyId), false, 'Old legacy row-indexed ID must be replaced atomically');
    assert.equal(studentsAfterMig.some((s) => s.id === canonicalChrisId), true, 'Canonical code-based ID must exist');
    assert.equal(
      studentsAfterMig.some((s) => s.id === 'st_local_only_must_not_delete'),
      true,
      'Local student absent from non-empty Pull MUST NEVER be deleted!'
    );

    const fuAfterMig = await idbGetFollowupRecords();
    const migratedFu = fuAfterMig.find((r) => r.id === 'fu_legacy_link_1');
    assert.equal(migratedFu?.studentId, canonicalChrisId, 'Followup record studentId must be re-linked atomically');

    const histAfterMig = await idbGetAttendanceHistory();
    assert.equal(
      histAfterMig.some((h) => h.studentId === canonicalChrisId && h.fridayDate === '2026-10-09'),
      true,
      'Attendance history studentId must be re-linked atomically'
    );
    assert.equal(
      histAfterMig.some((h) => h.studentId === legacyId),
      false,
      'No dangling legacy studentId left in attendance_history'
    );

    const mutAfterMig = await idbGetPendingMutations();
    const migratedMut = mutAfterMig.find((m) => m.id === 'mut_legacy_link_1');
    assert.equal(migratedMut?.studentId, canonicalChrisId, 'Pending mutation studentId must be re-linked atomically');

    // 4C: Standalone boot migration utility `idbMigrateLegacyStudentIds`
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('students', 'readwrite');
      tx.objectStore('students').put(
        makeStudent({ id: 'gs_غير نشط_555_12', code: '555', name: 'مخدوم هجرة عند التشغيل', sourceSheet: 'غير نشط' })
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const bootMigReport = await idbMigrateLegacyStudentIds();
    assert.equal(bootMigReport.migratedStudents, 1);
    const afterBootMig = await idbGetStudents();
    assert.equal(afterBootMig.some((s) => s.id === buildStableStudentIdFromCode('غير نشط', '555')), true);

    // 4D: Unkeyed & duplicate-code rows handled cautiously (no row-index IDs, no auto-merge/delete)
    const unkeyedText = buildGvizPayload({
      sig: 'sig_unkeyed',
      headers: VALID_STUDENT_HEADERS,
      rows: [
        ['', 'مخدوم بدون كود', 'ماركو ملجي فارس', '01244444444', '1', '0'],
        ['DUP-1', 'أول طالب بكود مكرر', 'ماركو ملجي فارس', '01255555551', '1', '0'],
        ['DUP-1', 'ثاني طالب بكود مكرر', 'ماركو ملجي فارس', '01255555552', '0', '1']
      ]
    });
    const parsedUnkeyed = parseGoogleVisualizationResponseDetailed(unkeyedText, 'نشط');
    assert.equal(parsedUnkeyed.unkeyedRowCount, 3, 'Empty code & duplicate codes must all be classified as unkeyed');
    assert.equal(parsedUnkeyed.students.every((s) => s.identityQuality === 'unkeyed'), true);
    assert.equal(new Set(parsedUnkeyed.students.map((s) => s.id)).size, 3, 'Unkeyed/duplicate rows get distinct content-hashed IDs');
    assert.equal(parsedUnkeyed.students[0].code, '', 'Must NOT fabricate fake SG-1 code for unkeyed rows');

    console.log('✅ Test 4 Passed: Stable student identity, atomic 4-store legacy migration, non-destructive absent-ID policy, and unkeyed caution verified');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 5 & 6: Records Without Version + Version Protection & Relay Conflict vs Legitimate Remote Update
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    // 5A: Local records with missing/zero version handled safely
    const noVerStudent = makeStudent({
      id: 'gs_code_نشط_601',
      code: '601',
      name: 'مخدوم بدون إصدار',
      notes: 'ملاحظة أصلية',
      sourceSheet: 'نشط'
    });
    delete (noVerStudent as any).version;

    const zeroVerStudent = makeStudent({
      id: 'gs_code_نشط_602',
      code: '602',
      name: 'مخدوم بإصدار صفر',
      notes: 'تعديل محلي غير متزامن',
      sourceSheet: 'نشط',
      version: 0,
      hasUnsyncedLocalChanges: true
    });

    const db = await getIndexedDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('students', 'readwrite');
      tx.objectStore('students').put(noVerStudent);
      tx.objectStore('students').put(zeroVerStudent);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const verifiedRelayProof: PullVerificationProof = {
      verified: true,
      isComplete: true,
      sheetName: 'نشط',
      source: 'relay'
    };

    // Incoming Relay payload with default version: 1 and hasRemoteVersion: false
    const incomingForNoVer = makeStudent({
      id: 'gs_code_نشط_601',
      code: '601',
      name: 'مخدوم بدون إصدار',
      notes: 'تحديث شرعي من جهاز آخر',
      sourceSheet: 'نشط',
      version: 1,
      hasRemoteVersion: false
    });
    const incomingForUnsynced = makeStudent({
      id: 'gs_code_نشط_602',
      code: '602',
      name: 'مخدوم بإصدار صفر',
      notes: 'قيمة قديمة من الريلاي version 1',
      sourceSheet: 'نشط',
      version: 1,
      hasRemoteVersion: false
    });

    await idbSaveStudents([incomingForNoVer, incomingForUnsynced], 'نشط', true, verifiedRelayProof);
    let stored = await idbGetStudents();
    const s601 = stored.find((s) => s.id === 'gs_code_نشط_601')!;
    const s602 = stored.find((s) => s.id === 'gs_code_نشط_602')!;

    assert.equal(s601.version, 1, 'Missing version normalized safely to >= 1');
    assert.equal(s601.notes, 'تحديث شرعي من جهاز آخر', 'Clean local record accepts legitimate remote edit even without version column');
    assert.equal(
      s602.notes,
      'تعديل محلي غير متزامن',
      'Local record with hasUnsyncedLocalChanges: true MUST NOT be overwritten by Relay version: 1!'
    );

    // 6A: Local edit with pending mutation -> protected from Relay version: 1 -> then mutation confirmed -> legitimate remote update accepted!
    const editedStudent = makeStudent({
      id: 'gs_code_نشط_601',
      code: '601',
      name: 'مخدوم بدون إصدار',
      notes: 'تعديل محلي معلق في الطابور',
      sourceSheet: 'نشط',
      version: 4,
      hasUnsyncedLocalChanges: true,
      att: { '2026-10-16': true, '2026-10-23': true }
    });
    const pendingMut: OfflineMutation = {
      id: 'mut_sync_cycle_601',
      action: 'attendance',
      studentId: 'gs_code_نشط_601',
      studentCode: '601',
      studentName: 'مخدوم بدون إصدار',
      sourceSheet: 'نشط',
      payload: { friday: '2026-10-23', isPresent: true },
      expectedVersion: 3,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };
    await idbAtomicRecordAttendanceWithMutation(
      editedStudent,
      {
        id: 'gs_code_نشط_601__2026-10-23',
        studentId: 'gs_code_نشط_601',
        studentCode: '601',
        fridayDate: '2026-10-23',
        status: true,
        recordedAt: Date.now(),
        sourceSheet: 'نشط'
      },
      pendingMut
    );

    // Relay pull while mutation is pending: MUST protect local edit!
    const relayOlder = makeStudent({
      id: 'gs_code_نشط_601',
      code: '601',
      name: 'مخدوم بدون إصدار',
      notes: 'تحديث قديم من الشيت',
      sourceSheet: 'نشط',
      version: 1,
      hasRemoteVersion: false,
      att: { '2026-10-16': true }
    });
    await idbReconcileStudents([relayOlder], [pendingMut], 'نشط', true, verifiedRelayProof);
    let afterPendingPull = (await idbGetStudents()).find((s) => s.id === 'gs_code_نشط_601')!;
    assert.equal(afterPendingPull.notes, 'تعديل محلي معلق في الطابور', 'Pending local student MUST be preserved against Relay version: 1');
    assert.equal(afterPendingPull.version, 4);

    // Now simulate successful server confirmation of pending mutation (idbRemoveMutation atomically clears hasUnsyncedLocalChanges!)
    await idbRemoveMutation(pendingMut.id);
    const afterConfirm = (await idbGetStudents()).find((s) => s.id === 'gs_code_نشط_601')!;
    assert.equal(afterConfirm.hasUnsyncedLocalChanges, false, 'Confirmed mutation removal must clear hasUnsyncedLocalChanges');

    // Now another servant edits phone/notes on another device; Relay returns version: 1 (no version column in Sheet)
    const remoteOtherDeviceEdit = makeStudent({
      id: 'gs_code_نشط_601',
      code: '601',
      name: 'مخدوم بدون إصدار',
      phoneStudent: '01299999999',
      notes: 'تحديث جديد من خادم آخر على جهاز ثانٍ',
      sourceSheet: 'نشط',
      version: 1,
      hasRemoteVersion: false,
      att: { '2026-10-16': true, '2026-10-30': true }
    });
    await idbSaveStudents([remoteOtherDeviceEdit], 'نشط', true, verifiedRelayProof);
    const afterOtherDevicePull = (await idbGetStudents()).find((s) => s.id === 'gs_code_نشط_601')!;
    assert.equal(
      afterOtherDevicePull.phoneStudent,
      '01299999999',
      'Legitimate remote edit from another device MUST NOT be permanently blocked once local edits are synced!'
    );
    assert.equal(afterOtherDevicePull.notes, 'تحديث جديد من خادم آخر على جهاز ثانٍ');
    assert.equal(afterOtherDevicePull.version, 4, 'Local monotonic version floor must be preserved (Math.max(4, 1) === 4)');
    assert.equal(afterOtherDevicePull.att['2026-10-30'], true, 'New remote Friday attendance applied');
    assert.equal(afterOtherDevicePull.att['2026-10-23'], true, 'Previously synced non-conflicting Friday key preserved');

    // 6B: Authoritative remote older version (hasRemoteVersion: true, version: 1) NEVER downgrades local version: 4
    const authoritativeOlderRemote = makeStudent({
      id: 'gs_code_نشط_601',
      code: '601',
      name: 'مخدوم بدون إصدار',
      notes: 'نسخة قديمة موثقة v1',
      sourceSheet: 'نشط',
      version: 1,
      hasRemoteVersion: true
    });
    await idbSaveStudents([authoritativeOlderRemote], 'نشط', true, verifiedRelayProof);
    const afterAuthOlder = (await idbGetStudents()).find((s) => s.id === 'gs_code_نشط_601')!;
    assert.equal(
      afterAuthOlder.notes,
      'تحديث جديد من خادم آخر على جهاز ثانٍ',
      'Authoritative older remote version (hasRemoteVersion: true, v1 < v4) MUST NOT overwrite newer local v4'
    );

    // 6C: Gviz parser must NOT copy existing.version into parsed output when Sheet has no version column
    const gvizNoVerText = buildGvizPayload({
      sig: 'sig_no_ver_col',
      headers: VALID_STUDENT_HEADERS,
      rows: [['601', 'مخدوم بدون إصدار', 'ماركو ملجي فارس', '01299999999', '1', '1']]
    });
    const existingMap = new Map<string, Student>([[afterAuthOlder.id, afterAuthOlder]]);
    const gvizNoVer = parseGoogleVisualizationResponseDetailed(gvizNoVerText, 'نشط', existingMap);
    assert.equal(gvizNoVer.hasVersionColumn, false);
    assert.equal(gvizNoVer.students[0].hasRemoteVersion, false);
    assert.equal(gvizNoVer.students[0].version, 1, 'Gviz parser must NOT fabricate version by copying existing.version');

    console.log('✅ Test 5 & 6 Passed: Missing/zero versions, Relay version: 1 protection, legitimate remote edits after sync, and Gviz provenance verified');
    passed += 2;
  }

  // ------------------------------------------------------------------
  // TEST 7: Partial / Unverified / Malformed Followup Log Protection
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const existingRemoteFu: FollowupRecord = {
      id: 'gs_fu_existing_cached_1',
      date: '2026-10-19',
      fridayDate: '2026-10-16',
      studentId: 'gs_code_نشط_101',
      studentCode: '101',
      studentName: 'كريس جوزيف عاطف',
      servant: 'ماركو ملجي فارس',
      type: 'اتصال',
      notes: 'سجل افتقاد مخزن مسبقاً'
    };
    const localInAppFu: FollowupRecord = {
      id: 'local_uuid_fu_1',
      date: '2026-10-20',
      fridayDate: '2026-10-16',
      studentId: 'gs_code_نشط_101',
      studentCode: '101',
      studentName: 'كريس جوزيف عاطف',
      servant: 'ماركو ملجي فارس',
      type: 'زيارة منزلية',
      notes: 'افتقاد محلي معلق'
    };
    const fuMut: OfflineMutation = {
      id: 'FU_local_1',
      action: 'followup',
      studentId: 'gs_code_نشط_101',
      studentCode: '101',
      studentName: 'كريس جوزيف عاطف',
      sourceSheet: 'نشط',
      payload: { recordId: localInAppFu.id, method: 'زيارة منزلية' },
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };

    const validFuProof: FollowupPullVerificationProof = {
      verified: true,
      isComplete: true,
      isPartialParse: false,
      source: 'gviz'
    };
    await idbSaveRemoteFollowupRecords([existingRemoteFu], validFuProof);
    await idbAtomicRecordFollowupWithMutation(
      makeStudent({ id: 'gs_code_نشط_101', code: '101', name: 'كريس جوزيف عاطف' }),
      localInAppFu,
      fuMut
    );

    // 7A: Reject unverified / incomplete / partial-parse proofs before opening transaction
    const badFuProofs: FollowupPullVerificationProof[] = [
      { verified: false, isComplete: true, source: 'gviz', reason: 'unverified_followup_tab' },
      { verified: true, isComplete: false, source: 'gviz', reason: 'incomplete_followup_log' },
      { verified: true, isComplete: true, isPartialParse: true, source: 'gviz', reason: 'partial_parse' }
    ];
    for (const proof of badFuProofs) {
      await assert.rejects(
        () => idbSaveRemoteFollowupRecords([existingRemoteFu], proof),
        /تم رفض تحديث كاش سجل الافتقاد/,
        `idbSaveRemoteFollowupRecords must reject bad proof (${proof.reason})`
      );
    }

    // 7B: Reject malformed followup records (missing studentName / type)
    await assert.rejects(
      () =>
        idbSaveRemoteFollowupRecords(
          [{ ...existingRemoteFu, id: 'gs_fu_bad', studentName: '' }],
          validFuProof
        ),
      /تم رفض تحديث كاش سجل الافتقاد/,
      'Malformed followup record missing studentName must be rejected'
    );

    // 7C: Gviz followup fetch with corrupted non-empty row flags isPartialParse & verified: false
    (globalThis as any).fetch = createMockFetch((url) => {
      const sheet = new URL(url).searchParams.get('sheet') || '';
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
        return { body: buildGvizPayload({ sig: 'sig_forms_fu', headers: FORM_FALLBACK_HEADERS, rows: [] }) };
      }
      return {
        body: buildGvizPayload({
          sig: 'sig_fu_corrupted',
          headers: FOLLOWUP_LOG_HEADERS,
          rows: [
            ['2026-10-20', '2026-10-16', 'كريس جوزيف عاطف', 'اتصال', 'ماركو ملجي فارس', 'سليم'],
            ['2026-10-20', '2026-10-16', '', 'اتصال', 'ماركو ملجي فارس', 'صف تالف بلا اسم']
          ]
        })
      };
    }, allHttpCalls);

    const fuDetail = await fetchFollowupLogViaGvizDetailed(DEFAULT_SPREADSHEET_ID, []);
    assert.equal(fuDetail.verified, false, 'Partially corrupted followup log must NOT be verified');
    assert.equal(fuDetail.isPartialParse, true, 'Partially corrupted followup log must set isPartialParse: true');
    assert.equal(fuDetail.records.length, 0, 'Must emit 0 records on partial followup parse');

    // Verify both cached remote followup & local in-app followup & pending mutation are 100% preserved
    const fuStored = await idbGetFollowupRecords();
    assert.equal(fuStored.some((r) => r.id === existingRemoteFu.id), true, 'Cached remote gs_fu_* preserved');
    assert.equal(fuStored.some((r) => r.id === localInAppFu.id), true, 'Local in-app followup preserved');
    assert.equal((await idbGetPendingMutations()).some((m) => m.id === fuMut.id), true, 'Pending followup mutation preserved');

    console.log('✅ Test 7 Passed: Partial/unverified/malformed Followup Log responses rejected cleanly without touching cached or local followups');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 8 & 9: Gviz Probe Hardening (Fail-Closed + sig precedence + full-table hash)
  //             + Canary Records Preserved Across ALL 4 Stores + Zero POST Calls
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const { canaryStudent, canaryFollowup, canaryHistory, canaryMutation } = await seedCanaryAcrossAllFourStores();
    const localActiveCanary = makeStudent({
      id: 'canary_st_active_100',
      code: '100',
      name: 'كناري نشط محفوظ',
      sourceSheet: 'نشط',
      version: 2
    });
    await idbSaveStudents([localActiveCanary], 'نشط', true);

    // 8A: sig precedence — when BOTH Probe and Tab have sig and probe.sig !== tab.sig,
    //     NEVER falsely reject even if headers/rows are identical!
    const identicalTablePayload = (sig: string) =>
      parseGoogleVisualizationResponseDetailed(
        buildGvizPayload({
          sig,
          headers: VALID_STUDENT_HEADERS,
          rows: [['101', 'طالب مطابق', 'ماركو ملجي فارس', '01200000001', '1', '1']]
        }),
        'نشط'
      );

    const probeParsed = identicalTablePayload('sig_default_tab_AAA');
    const validTabSameContentDifferentSig = identicalTablePayload('sig_valid_tab_BBB');
    assert.equal(
      matchesDefaultFallbackProbe(validTabSameContentDifferentSig, {
        status: 'fallback_active',
        sig: probeParsed.sig,
        tableFingerprint: probeParsed.tableFingerprint
      }),
      false,
      'Distinct sig MUST NEVER falsely reject a valid tab even when table content is identical!'
    );

    const fallbackSameSig = identicalTablePayload('sig_default_tab_AAA');
    assert.equal(
      matchesDefaultFallbackProbe(fallbackSameSig, {
        status: 'fallback_active',
        sig: probeParsed.sig,
        tableFingerprint: probeParsed.tableFingerprint
      }),
      true,
      'Identical sig MUST still be caught as default fallback!'
    );

    // 8B: Full-table 64-bit fingerprint distinguishes middle-row differences when sig is absent
    const tableA = [
      ['101', 'صف أول', 'خادم', '01200000001', '1', '1'],
      ['102', 'صف أوسط أ', 'خادم', '01200000002', '1', '0'],
      ['103', 'صف أخير', 'خادم', '01200000003', '1', '1']
    ];
    const tableB = [
      ['101', 'صف أول', 'خادم', '01200000001', '1', '1'],
      ['102', 'صف أوسط ب مختلف', 'خادم', '01200000002', '0', '1'],
      ['103', 'صف أخير', 'خادم', '01200000003', '1', '1']
    ];
    const fpA = computeGvizTableFingerprint(VALID_STUDENT_HEADERS, tableA);
    const fpB = computeGvizTableFingerprint(VALID_STUDENT_HEADERS, tableB);
    assert.notEqual(fpA, fpB, 'Full-table 64-bit hash MUST detect differences in middle rows');

    const tabBNoSig = parseGoogleVisualizationResponseDetailed(
      buildGvizPayload({ headers: VALID_STUDENT_HEADERS, rows: tableB }),
      'نشط'
    );
    assert.equal(
      matchesDefaultFallbackProbe(tabBNoSig, {
        status: 'fallback_active',
        sig: undefined,
        tableFingerprint: fpA
      }),
      false,
      'Without sig, different middle row must NOT falsely match probe fingerprint'
    );

    // 8C: Strict Fail-Closed when Probe fails with network error or HTTP 500
    // (Verify executeSyncData with students/followup/attendance_history canaries before adding pending queue mutation,
    //  so not even a mocked queue-flush POST is attempted during read-only pull tests.)
    const dbCanary = await getIndexedDB();
    await new Promise<void>((resolve, reject) => {
      const tx = dbCanary.transaction('mutations', 'readwrite');
      tx.objectStore('mutations').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    (globalThis as any).fetch = createMockFetch((url) => {
      const sheet = new URL(url).searchParams.get('sheet') || '';
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
        return { status: 500, ok: false, body: 'Internal Server Error' };
      }
      // Even if a tab would return HTTP 200, Fail-Closed MUST reject without saving anything!
      return {
        body: buildGvizPayload({
          sig: 'sig_active_unverified_because_probe_failed',
          headers: VALID_STUDENT_HEADERS,
          rows: [['999', 'بيانات غير موثقة أثناء فشل الفحص', 'خادم', '01000000000', '1', '1']]
        })
      };
    }, allHttpCalls);

    const probeResult = await probeGvizDefaultFallback(DEFAULT_SPREADSHEET_ID);
    assert.equal(probeResult.status, 'probe_failed', 'HTTP 500 on Probe must return status: "probe_failed"');

    const gvizFailClosed = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, '__ALL__');
    assert.equal(gvizFailClosed.confirmedSheets.length, 0, 'Fail-Closed must confirm ZERO sheets');
    assert.equal(gvizFailClosed.students.length, 0, 'Fail-Closed must emit ZERO students');
    assert.equal(
      String(gvizFailClosed.sheetsMeta['نشط']?.reason || '').startsWith('probe_failed_fail_closed'),
      true,
      'Fail-Closed reason must start with probe_failed_fail_closed'
    );

    const syncLock = { current: false };
    let recordedPullTime = false;
    const syncRes = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      () => {
        recordedPullTime = true;
      }
    );
    assert.equal(syncRes, false, 'executeSyncData must return false when Probe fails (Fail-Closed)');
    assert.equal(recordedPullTime, false, 'Fail-Closed must NEVER update Last Sync Time');

    // Re-seed pending canaryMutation and verify network exception on Probe + storage rejection preserve ALL 4 Canary stores
    await new Promise<void>((resolve, reject) => {
      const tx = dbCanary.transaction('mutations', 'readwrite');
      tx.objectStore('mutations').put(canaryMutation);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    (globalThis as any).fetch = createMockFetch((url) => {
      const sheet = new URL(url).searchParams.get('sheet') || '';
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
        return { throwError: new Error('ECONNRESET simulated network failure') };
      }
      return { body: buildGvizPayload({ sig: 'sig_x', headers: VALID_STUDENT_HEADERS, rows: [] }) };
    }, allHttpCalls);

    const netProbeFail = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, 'نشط');
    assert.equal(netProbeFail.sheetsMeta['نشط']?.verified, false);
    assert.equal(
      String(netProbeFail.sheetsMeta['نشط']?.reason || '').startsWith('probe_failed_fail_closed'),
      true,
      'Network exception on Probe must trigger probe_failed_fail_closed'
    );

    await assert.rejects(
      () =>
        idbReconcileStudents([localActiveCanary], [canaryMutation], 'نشط', false, {
          verified: false,
          isComplete: false,
          sheetName: 'نشط',
          source: 'gviz',
          reason: 'probe_failed_fail_closed'
        }),
      /تم رفض idbReconcileStudents/
    );

    // TEST 9: Assert ALL 4 Canary Stores 100% Intact & ZERO POST / Write Calls
    const finalStudents = await idbGetStudents();
    const finalFollowups = await idbGetFollowupRecords();
    const finalHistory = await idbGetAttendanceHistory();
    const finalMutations = await idbGetPendingMutations();

    assert.equal(finalStudents.some((s) => s.id === canaryStudent.id), true, 'Canary student (غير نشط) intact');
    assert.equal(finalStudents.some((s) => s.id === localActiveCanary.id), true, 'Canary student (نشط) intact');
    assert.equal(finalFollowups.some((f) => f.id === canaryFollowup.id), true, 'Canary followup intact');
    assert.equal(finalHistory.some((h) => h.id === canaryHistory.id), true, 'Canary attendance_history intact');
    assert.equal(finalMutations.some((m) => m.id === canaryMutation.id), true, 'Canary mutation intact');

    assert.ok(allHttpCalls.length > 0, 'Mocked GET calls were exercised');
    assert.equal(
      allHttpCalls.every((c) => c.startsWith('GET ')),
      true,
      'ZERO POST or write calls allowed in Phase 4.2.1 tests'
    );

    console.log('✅ Test 8 Passed: Gviz Probe Fail-Closed, sig precedence, and full-table 64-bit hash verified');
    console.log(`✅ Test 9 Passed: All 4 IndexedDB Canary stores preserved intact (${allHttpCalls.length} mocked GET calls, 0 POST calls)`);
    passed += 2;
  }

  console.log('\n================================================================');
  console.log(`🎉 ALL ${passed} OF 9 PHASE 4.2.1 CRITICAL INTEGRITY TESTS PASSED!`);
  console.log('================================================================\n');
}

runTests()
  .then(() => {
    idbCloseDatabase();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 Phase 4.2.1 Integrity Test Failed:', err);
    idbCloseDatabase();
    process.exit(1);
  });
