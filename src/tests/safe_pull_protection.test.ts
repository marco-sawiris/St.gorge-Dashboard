import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
(globalThis as any).indexedDB = fakeIndexedDB;

const mockStorage = new Map<string, string>();
const mockLocalStorage = {
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
(globalThis as any).localStorage = mockLocalStorage;
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockLocalStorage,
    location: { origin: 'http://localhost:3000', protocol: 'http:' }
  };
}

import assert from 'node:assert/strict';
import {
  DEFAULT_SPREADSHEET_ID,
  NONEXISTENT_SHEET_PROBE_NAME,
  REMOTE_SHEET_GVIZ_CANDIDATES,
  fetchSheetStudentsViaGviz,
  parseGoogleVisualizationResponseDetailed,
  validateStudentTableHeaders
} from '../services/googleSheetParser';
import {
  AttendanceHistoryRecord,
  INDEXED_DB_NAME,
  PullVerificationProof,
  getIndexedDB,
  idbAddFollowupRecord,
  idbAtomicRecordAttendanceWithMutation,
  idbCloseDatabase,
  idbGetAttendanceHistory,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbGetStudents,
  idbReconcileStudents,
  idbSaveStudents
} from '../services/indexedDbService';
import { executeSyncData } from '../context/AppContext';
import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { OfflineMutation } from '../types/auth';

const VALID_STUDENT_HEADERS = ['كود', 'الاسم', 'الاشبين', 'موبيال المخدوم', '2026-10-16', '2026-10-23'];
const FORM_FALLBACK_HEADERS = ['طابع زمني', 'سؤال بدون عنوان', 'عنوان البريد الإلكتروني'];
const FOLLOWUP_LOG_HEADERS = ['التاريخ', 'أسبوع الجمعة', 'الاسم', 'النوع', 'الأشبين', 'ملاحظات'];

function buildGvizPayload(options: {
  sig: string;
  headers: string[];
  rows?: Array<Array<string | number | null>>;
  status?: 'ok' | 'error';
  warnings?: Array<{ reason?: string; message?: string }>;
  rawMalformedRow?: boolean;
}): string {
  const cols = options.headers.map((label, idx) => ({
    id: String.fromCharCode(65 + idx),
    label,
    type: 'string'
  }));
  const rows: any[] = (options.rows || []).map((row) => ({
    c: row.map((v) => (v === null ? null : { v }))
  }));
  if (options.rawMalformedRow) {
    rows.push({ brokenRowWithoutCells: true });
  }
  const payload: any = {
    version: '0.6',
    reqId: '0',
    status: options.status || 'ok',
    sig: options.sig,
    table: { cols, rows }
  };
  if (options.warnings) {
    payload.warnings = options.warnings;
  }
  return `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(payload)});`;
}

function makeStudent(overrides: Partial<Student> & { id: string; name: string; sourceSheet: string }): Student {
  return {
    id: overrides.id,
    code: overrides.code || '101',
    name: overrides.name,
    servant: overrides.servant || 'ماركو ملجي فارس',
    phoneStudent: overrides.phoneStudent || '01200000000',
    phoneParent1: overrides.phoneParent1 || '',
    phoneParent2: overrides.phoneParent2 || '',
    birthDate: overrides.birthDate || '',
    area: overrides.area || 'شبرا',
    address: overrides.address || '',
    notes: overrides.notes || '',
    attendanceTotal: overrides.attendanceTotal ?? 1,
    attendanceMonth: overrides.attendanceMonth ?? 1,
    lastAttendance: overrides.lastAttendance || '2026-10-16',
    lastFollowup: overrides.lastFollowup || '',
    followupStatus: overrides.followupStatus || 'بدون',
    attendanceStatus: overrides.attendanceStatus || 'حاضر',
    sourceSheet: overrides.sourceSheet,
    att: overrides.att || { '2026-10-16': true },
    fu: overrides.fu || {},
    fuOutcomes: overrides.fuOutcomes || {},
    version: overrides.version ?? 1
  };
}

async function resetFakeDatabase(): Promise<void> {
  idbCloseDatabase();
  await new Promise<void>((resolve, reject) => {
    const req = fakeIndexedDB.deleteDatabase(INDEXED_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function seedAuxStores(): Promise<{ followup: FollowupRecord; history: AttendanceHistoryRecord }> {
  const followup: FollowupRecord = {
    id: 'fu_preserve_1',
    date: '2026-11-18',
    fridayDate: '2026-11-13',
    studentId: 'st_keep_other',
    studentCode: 'K-1',
    studentName: 'كيرلس سامح إبراهيم',
    servant: 'ماركو ملجي فارس',
    type: 'تم تليفونياً',
    notes: 'سجل افتقاد محلي يجب عدم المساس به'
  };
  await idbAddFollowupRecord(followup);

  const history: AttendanceHistoryRecord = {
    id: 'st_keep_other__2026-10-23',
    studentId: 'st_keep_other',
    studentCode: 'K-1',
    fridayDate: '2026-10-23',
    status: true,
    recordedAt: Date.now(),
    sourceSheet: 'نشط'
  };
  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('attendance_history', 'readwrite');
    tx.objectStore('attendance_history').put(history);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return { followup, history };
}

function createMockGvizFetch(
  tabResponder: (sheetParam: string) => { status?: number; body: string },
  recordedMethods: string[]
) {
  return async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    recordedMethods.push(`${method} ${url}`);

    // Hard guarantee: Phase 4.2 Pull tests must NEVER perform any POST or Apps Script write
    if (method !== 'GET') {
      throw new Error(`FORBIDDEN HTTP METHOD IN PULL TEST: ${method} ${url}`);
    }
    if (url.includes('script.google.com')) {
      throw new Error(`FORBIDDEN APPS SCRIPT CALL IN GVIZ PULL TEST: ${url}`);
    }
    if (!url.includes('/gviz/tq')) {
      throw new Error(`UNEXPECTED NETWORK URL IN MOCKED TEST: ${url}`);
    }

    const parsedUrl = new URL(url);
    const sheetParam = parsedUrl.searchParams.get('sheet') || '';
    const reply = tabResponder(sheetParam);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => reply.body,
      json: async () => JSON.parse(reply.body)
    } as any;
  };
}

async function runTests() {
  console.log('\n==============================================================');
  console.log('🛡️  Running Phase 4.2 — Safe Google Sheets Pull Protection Tests');
  console.log('==============================================================\n');

  const allHttpCalls: string[] = [];
  let passed = 0;

  // ------------------------------------------------------------------
  // TEST 1: Existing tab with students -> verified & saved cleanly
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const otherSheetStudent = makeStudent({
      id: 'st_pope_existing',
      code: 'P-1',
      name: 'مينا أيمن فؤاد',
      sourceSheet: 'فصل البابا شنودة'
    });
    await idbSaveStudents([otherSheetStudent], 'فصل البابا شنودة', true);
    const { followup, history } = await seedAuxStores();

    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
        return {
          body: buildGvizPayload({
            sig: 'sig_forms_default',
            headers: FORM_FALLBACK_HEADERS,
            rows: [['2026-10-01', 'رد افتراضي', 'form@example.com']]
          })
        };
      }
      if (sheet === 'نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_active_valid_1',
            headers: VALID_STUDENT_HEADERS,
            rows: [
              ['101', 'توماس كامل يوسف فرج', 'ماركو ملجي فارس', '01211111111', '1', '0'],
              ['102', 'كاراس أسامة سلامة', 'ماركو ملجي فارس', '01222222222', '1', '1']
            ]
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return {
          body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] })
        };
      }
      return {
        body: buildGvizPayload({ sig: 'sig_forms_default', headers: FORM_FALLBACK_HEADERS, rows: [] })
      };
    }, allHttpCalls);

    const syncLock = { current: false };
    let recordedSyncTime: string | null = null;
    const ok = await executeSyncData(
      'نشط',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      (iso) => {
        recordedSyncTime = iso;
      }
    );

    assert.equal(ok, true, 'Verified existing tab Pull must succeed');
    assert.ok(recordedSyncTime, 'Sync timestamp should be recorded on verified Pull');

    const stored = await idbGetStudents();
    const activeStudents = stored.filter((s) => s.sourceSheet === 'نشط');
    const popeStudents = stored.filter((s) => s.sourceSheet === 'فصل البابا شنودة');
    assert.equal(activeStudents.length, 2, 'Active sheet must contain 2 verified students');
    assert.equal(popeStudents.length, 1, 'Other sheet students must remain untouched');
    assert.equal((await idbGetFollowupRecords()).some((r) => r.id === followup.id), true, 'Followup store preserved');
    assert.equal((await idbGetAttendanceHistory()).some((h) => h.id === history.id), true, 'Attendance history preserved');

    console.log('✅ Test 1 Passed: Existing tab with valid students verified & saved with full isolation');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 2: Existing genuinely empty tab with valid student headers
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    await idbSaveStudents(
      [makeStudent({ id: 'st_active_old', name: 'طالب سيتم تفريغ فصله المؤكد', sourceSheet: 'نشط' })],
      'نشط',
      true
    );
    await idbSaveStudents(
      [makeStudent({ id: 'st_pope_keep', name: 'طالب فصل آخر يجب بقاؤه', sourceSheet: 'فصل البابا شنودة' })],
      'فصل البابا شنودة',
      true
    );
    const { followup, history } = await seedAuxStores();

    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
        return {
          body: buildGvizPayload({
            sig: 'sig_forms_default',
            headers: FORM_FALLBACK_HEADERS,
            rows: [['2026-10-01', 'رد افتراضي', 'form@example.com']]
          })
        };
      }
      if (sheet === 'نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_active_genuinely_empty',
            headers: VALID_STUDENT_HEADERS,
            rows: []
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
      }
      return { body: buildGvizPayload({ sig: 'sig_forms_default', headers: FORM_FALLBACK_HEADERS, rows: [] }) };
    }, allHttpCalls);

    const parsed = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, 'نشط');
    assert.equal(parsed.sheetsMeta['نشط']?.verified, true, 'Genuinely empty tab with valid headers must be verified');
    assert.equal(parsed.sheetsMeta['نشط']?.isComplete, true);
    assert.equal(parsed.confirmedEmptySheets.includes('نشط'), true);

    const syncLock = { current: false };
    const ok = await executeSyncData('نشط', null, false, syncLock);
    assert.equal(ok, true, 'Verified genuinely empty tab Pull should succeed');

    const stored = await idbGetStudents();
    assert.equal(stored.filter((s) => s.sourceSheet === 'نشط').length, 0, 'Verified empty sheet cleared cleanly');
    assert.equal(stored.filter((s) => s.sourceSheet === 'فصل البابا شنودة').length, 1, 'Other sheet completely preserved');
    assert.equal((await idbGetFollowupRecords()).some((r) => r.id === followup.id), true, 'Followup store untouched');
    assert.equal((await idbGetAttendanceHistory()).some((h) => h.id === history.id), true, 'Attendance history untouched');

    console.log('✅ Test 2 Passed: Existing genuinely empty tab verified, scoped cleanly, other stores untouched');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 3: Non-existent tab ("غير نشط") returning HTTP 200 ok + fallback "ردود النموذج 1"
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const localInactive = makeStudent({
      id: 'st_inactive_precious',
      code: 'IN-1',
      name: 'مايكل ميلاد عيد',
      sourceSheet: 'غير نشط'
    });
    const localActive = makeStudent({
      id: 'st_active_before',
      code: 'AC-1',
      name: 'قديم في نشط',
      sourceSheet: 'نشط'
    });
    await idbSaveStudents([localInactive], 'غير نشط', true);
    await idbSaveStudents([localActive], 'نشط', true);
    const { followup, history } = await seedAuxStores();

    // 3A: Gviz returns HTTP 200 status:'ok' with Google Forms "ردود النموذج 1" for missing tab "غير نشط"
    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME || sheet === 'غير نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_form_responses_1',
            headers: FORM_FALLBACK_HEADERS,
            rows: [['2026-10-01', 'رد نموذج 1', 'user@example.com']]
          })
        };
      }
      if (sheet === 'نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_active_fresh',
            headers: VALID_STUDENT_HEADERS,
            rows: [['201', 'بافلى أيمن حسنى', 'ماركو ملجي فارس', '01233333333', '1', '1']]
          })
        };
      }
      if (sheet === 'فصل البابا شنودة ') {
        return {
          body: buildGvizPayload({
            sig: 'sig_pope_fresh',
            headers: VALID_STUDENT_HEADERS,
            rows: [['301', 'ديفيد أيمن حسنى', 'ماركو ملجي فارس', '01244444444', '1', '0']]
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
      }
      return {
        body: buildGvizPayload({
          sig: 'sig_form_responses_1',
          headers: FORM_FALLBACK_HEADERS,
          rows: [['2026-10-01', 'رد نموذج 1', 'user@example.com']]
        })
      };
    }, allHttpCalls);

    const singleGviz = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, 'غير نشط');
    assert.equal(singleGviz.confirmedSheets.includes('غير نشط'), false, 'Missing tab must NOT be in confirmedSheets');
    assert.equal(singleGviz.confirmedEmptySheets.includes('غير نشط'), false, 'Missing tab must NOT be in confirmedEmptySheets');
    assert.equal(singleGviz.unverifiedSheets.includes('غير نشط'), true, 'Missing tab must be marked unverified');
    assert.equal(singleGviz.sheetsMeta['غير نشط']?.verified, false);
    assert.equal(singleGviz.sheetsMeta['غير نشط']?.isComplete, false);

    const syncLock = { current: false };
    let recordedError: string | null = null;
    const singleOk = await executeSyncData(
      'غير نشط',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      undefined,
      undefined,
      (err) => {
        recordedError = err;
      }
    );
    assert.equal(singleOk, false, 'Single-sheet Pull for missing tab returning fallback must return false');
    assert.ok(recordedError, 'Error message should explain local data protection');

    let stored = await idbGetStudents();
    assert.equal(
      stored.some((s) => s.id === 'st_inactive_precious' && s.sourceSheet === 'غير نشط'),
      true,
      'Local "غير نشط" student MUST survive missing-tab fallback Pull!'
    );

    // 3B: Probe detection even if default tab #1 hypothetically had valid student headers (same sig/fingerprint)
    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      if (sheet === NONEXISTENT_SHEET_PROBE_NAME || sheet === 'غير نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_default_tab_happens_to_be_students',
            headers: VALID_STUDENT_HEADERS,
            rows: [['999', 'طالب في التبويب الافتراضي الأول', 'خادم', '01000000000', '1', '1']]
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
      }
      return {
        body: buildGvizPayload({
          sig: 'sig_default_tab_happens_to_be_students',
          headers: VALID_STUDENT_HEADERS,
          rows: [['999', 'طالب في التبويب الافتراضي الأول', 'خادم', '01000000000', '1', '1']]
        })
      };
    }, allHttpCalls);

    const probeCaught = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, 'غير نشط');
    assert.equal(probeCaught.sheetsMeta['غير نشط']?.verified, false, 'Fallback matching probe sig must be rejected');
    assert.equal(probeCaught.sheetsMeta['غير نشط']?.reason, 'default_sheet_fallback');
    assert.equal(probeCaught.students.length, 0, 'Must never import rows from default fallback tab');

    const probeSyncOk = await executeSyncData('غير نشط', null, false, syncLock);
    assert.equal(probeSyncOk, false, 'executeSyncData must reject fallback matching probe');
    stored = await idbGetStudents();
    assert.equal(
      stored.some((s) => s.id === 'st_inactive_precious'),
      true,
      'Local "غير نشط" student must remain untouched after probe-caught fallback'
    );

    // 3C: __ALL__ mode with valid "نشط" & "فصل البابا شنودة " + missing "غير نشط"
    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      if (sheet === 'نشط') {
        return {
          body: buildGvizPayload({
            sig: 'sig_active_fresh_all',
            headers: VALID_STUDENT_HEADERS,
            rows: [['201', 'بافلى أيمن حسنى', 'ماركو ملجي فارس', '01233333333', '1', '1']]
          })
        };
      }
      if (sheet === 'فصل البابا شنودة ') {
        return {
          body: buildGvizPayload({
            sig: 'sig_pope_fresh_all',
            headers: VALID_STUDENT_HEADERS,
            rows: [['301', 'ديفيد أيمن حسنى', 'ماركو ملجي فارس', '01244444444', '1', '0']]
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
      }
      return {
        body: buildGvizPayload({
          sig: 'sig_form_responses_1',
          headers: FORM_FALLBACK_HEADERS,
          rows: [['2026-10-01', 'رد نموذج 1', 'user@example.com']]
        })
      };
    }, allHttpCalls);

    const allOk = await executeSyncData('__ALL__', null, false, syncLock);
    assert.equal(allOk, 'partial', '__ALL__ sync should return partial when verified tabs update while an unverified tab is skipped');
    stored = await idbGetStudents();
    assert.equal(
      stored.some((s) => s.sourceSheet === 'نشط' && s.name === 'بافلى أيمن حسنى'),
      true,
      'Verified "نشط" updated with incoming student'
    );
    assert.equal(
      stored.some((s) => s.sourceSheet === 'فصل البابا شنودة' && s.name === 'ديفيد أيمن حسنى'),
      true,
      'Verified "فصل البابا شنودة" updated with incoming student'
    );
    assert.equal(
      stored.some((s) => s.id === 'st_inactive_precious' && s.sourceSheet === 'غير نشط'),
      true,
      'Unverified "غير نشط" preserved during __ALL__ sync'
    );
    assert.equal((await idbGetFollowupRecords()).some((r) => r.id === followup.id), true);
    assert.equal((await idbGetAttendanceHistory()).some((h) => h.id === history.id), true);

    console.log('✅ Test 3 Passed: Non-existent tab ("غير نشط") HTTP 200 fallback blocked in single & __ALL__ modes');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 4: Incompatible headers (unknown columns / single Name / Followup log headers)
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const localActive = makeStudent({ id: 'st_keep_headers', name: 'مخدوم محلي محفوظ', sourceSheet: 'نشط' });
    await idbSaveStudents([localActive], 'نشط', true);

    assert.equal(validateStudentTableHeaders([]).valid, false);
    assert.equal(validateStudentTableHeaders(FORM_FALLBACK_HEADERS).reason, 'form_responses_tab');
    assert.equal(validateStudentTableHeaders(['عمود1', 'عمود2']).reason, 'missing_name_column');
    assert.equal(validateStudentTableHeaders(['الاسم']).reason, 'insufficient_student_columns');
    assert.equal(validateStudentTableHeaders(['الاسم', 'عمود عشوائي']).reason, 'insufficient_student_columns');
    assert.equal(validateStudentTableHeaders(FOLLOWUP_LOG_HEADERS).reason, 'followup_log_tab');
    assert.equal(validateStudentTableHeaders(VALID_STUDENT_HEADERS).valid, true);

    const badHeaderCases: Array<{ label: string; headers: string[]; rows: string[][] }> = [
      { label: 'unknown columns', headers: ['عمود_أ', 'عمود_ب'], rows: [['1', '2']] },
      { label: 'single name column only', headers: ['الاسم'], rows: [['اسم عشوائي']] },
      { label: 'followup log headers', headers: FOLLOWUP_LOG_HEADERS, rows: [['2026-10-20', '2026-10-16', 'فلان', 'اتصال', 'خادم', 'ملاحظة']] }
    ];

    for (const tc of badHeaderCases) {
      (globalThis as any).fetch = createMockGvizFetch((sheet) => {
        if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
          return { body: buildGvizPayload({ sig: 'sig_probe_forms', headers: FORM_FALLBACK_HEADERS, rows: [] }) };
        }
        if (sheet === 'نشط') {
          return { body: buildGvizPayload({ sig: `sig_bad_${tc.label}`, headers: tc.headers, rows: tc.rows }) };
        }
        return { body: buildGvizPayload({ sig: 'sig_probe_forms', headers: FORM_FALLBACK_HEADERS, rows: [] }) };
      }, allHttpCalls);

      const syncLock = { current: false };
      const ok = await executeSyncData('نشط', null, false, syncLock);
      assert.equal(ok, false, `Pull with incompatible headers (${tc.label}) must be rejected`);
      const stored = await idbGetStudents();
      assert.equal(stored.length, 1, `Local student must remain untouched for ${tc.label}`);
      assert.equal(stored[0].id, 'st_keep_headers');
    }

    console.log('✅ Test 4 Passed: Incompatible headers rejected without touching IndexedDB');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 5: Trailing space mismatch for "فصل البابا شنودة" vs "فصل البابا شنودة "
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    assert.deepEqual(
      [...REMOTE_SHEET_GVIZ_CANDIDATES['فصل البابا شنودة']],
      ['فصل البابا شنودة ', 'فصل البابا شنودة'],
      'Trailing-space candidates must be strictly scoped to known mismatch'
    );

    const requestedSheets: string[] = [];
    // 5A: Exact trailing-space tab exists while trimmed name falls back to Form Responses
    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      requestedSheets.push(sheet);
      if (sheet === 'فصل البابا شنودة ') {
        return {
          body: buildGvizPayload({
            sig: 'sig_pope_trailing_space',
            headers: VALID_STUDENT_HEADERS,
            rows: [['P-10', 'كريس جوزيف عاطف', 'ماركو ملجي فارس', '01255555555', '1', '1']]
          })
        };
      }
      if (sheet === 'سجل الافتقاد') {
        return { body: buildGvizPayload({ sig: 'sig_fu_empty', headers: FOLLOWUP_LOG_HEADERS, rows: [] }) };
      }
      return {
        body: buildGvizPayload({
          sig: 'sig_forms_default',
          headers: FORM_FALLBACK_HEADERS,
          rows: [['2026-10-01', 'نموذج', 'a@b.com']]
        })
      };
    }, allHttpCalls);

    const gvizPope = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, 'فصل البابا شنودة');
    assert.equal(gvizPope.sheetsMeta['فصل البابا شنودة']?.verified, true);
    assert.equal(gvizPope.sheetsMeta['فصل البابا شنودة']?.resolvedRemoteSheetName, 'فصل البابا شنودة ');
    assert.equal(gvizPope.students.length, 1);
    assert.equal(gvizPope.students[0].sourceSheet, 'فصل البابا شنودة', 'Normalized local sourceSheet preserved');

    const syncLock = { current: false };
    const popeOk = await executeSyncData('فصل البابا شنودة', null, false, syncLock);
    assert.equal(popeOk, true);
    let stored = await idbGetStudents();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'كريس جوزيف عاطف');
    assert.equal(stored[0].sourceSheet, 'فصل البابا شنودة');

    // 5B: When NEITHER "فصل البابا شنودة " nor "فصل البابا شنودة" exists -> rejects without guessing unrelated tabs
    const requestedWhenMissing: string[] = [];
    (globalThis as any).fetch = createMockGvizFetch((sheet) => {
      requestedWhenMissing.push(sheet);
      return {
        body: buildGvizPayload({
          sig: 'sig_forms_default',
          headers: FORM_FALLBACK_HEADERS,
          rows: [['2026-10-01', 'نموذج', 'a@b.com']]
        })
      };
    }, allHttpCalls);

    const missingOk = await executeSyncData('فصل البابا شنودة', null, false, syncLock);
    assert.equal(missingOk, false, 'Must reject cleanly when neither candidate exists');
    assert.equal(
      requestedWhenMissing.every(
        (s) =>
          s === NONEXISTENT_SHEET_PROBE_NAME ||
          s === 'فصل البابا شنودة ' ||
          s === 'فصل البابا شنودة' ||
          s === 'سجل الافتقاد'
      ),
      true,
      'Must never guess unrelated tab names'
    );
    stored = await idbGetStudents();
    assert.equal(stored.length, 1, 'Previously saved local "فصل البابا شنودة" student remains intact');

    console.log('✅ Test 5 Passed: Trailing space handling ("فصل البابا شنودة ") resolves cleanly and rejects safely when missing');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 6: Partial parsing failure (corrupted row / malformed row / Gviz warnings)
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const localActive = makeStudent({ id: 'st_keep_partial', name: 'مخدوم محفوظ قبل الفشل الجزئي', sourceSheet: 'نشط' });
    await idbSaveStudents([localActive], 'نشط', true);

    // 6A: Non-empty data row missing Name alongside a valid row
    const corruptedText = buildGvizPayload({
      sig: 'sig_partial_missing_name',
      headers: VALID_STUDENT_HEADERS,
      rows: [
        ['101', 'طالب سليم', 'ماركو ملجي فارس', '01200000001', '1', '1'],
        ['102', '', 'ماركو ملجي فارس', '01200000002', '1', '0'] // Corrupted non-empty row without name!
      ]
    });
    const detailA = parseGoogleVisualizationResponseDetailed(corruptedText, 'نشط');
    assert.equal(detailA.isPartialParse, true, 'Missing name in non-empty row must flag isPartialParse');
    assert.equal(detailA.skippedCorruptedRowCount, 1);

    // 6B: Malformed Gviz row object (no c array)
    const malformedText = buildGvizPayload({
      sig: 'sig_partial_malformed_row',
      headers: VALID_STUDENT_HEADERS,
      rows: [['101', 'طالب سليم', 'ماركو ملجي فارس', '01200000001', '1', '1']],
      rawMalformedRow: true
    });
    const detailB = parseGoogleVisualizationResponseDetailed(malformedText, 'نشط');
    assert.equal(detailB.isPartialParse, true, 'Malformed Gviz row object must flag isPartialParse');

    // 6C: Gviz warnings present
    const warnedText = buildGvizPayload({
      sig: 'sig_partial_warnings',
      headers: VALID_STUDENT_HEADERS,
      rows: [['101', 'طالب سليم', 'ماركو ملجي فارس', '01200000001', '1', '1']],
      warnings: [{ reason: 'data_truncated', message: 'Rows truncated' }]
    });
    const detailC = parseGoogleVisualizationResponseDetailed(warnedText, 'نشط');
    assert.equal(detailC.isPartialParse, true, 'Gviz warnings must flag isPartialParse');

    for (const [label, body] of [
      ['corrupted row', corruptedText],
      ['malformed row', malformedText],
      ['gviz warnings', warnedText]
    ] as const) {
      (globalThis as any).fetch = createMockGvizFetch((sheet) => {
        if (sheet === 'نشط') return { body };
        return { body: buildGvizPayload({ sig: 'sig_probe_forms', headers: FORM_FALLBACK_HEADERS, rows: [] }) };
      }, allHttpCalls);

      const gvizRes = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, 'نشط');
      assert.equal(gvizRes.sheetsMeta['نشط']?.isComplete, false, `Partial parse (${label}) must NOT be isComplete`);
      assert.equal(gvizRes.sheetsMeta['نشط']?.verified, false, `Partial parse (${label}) must NOT be verified`);
      assert.equal(gvizRes.students.length, 0, `Partial parse (${label}) must not emit partial students`);

      const syncLock = { current: false };
      const ok = await executeSyncData('نشط', null, false, syncLock);
      assert.equal(ok, false, `executeSyncData must reject partial parse (${label})`);
      const stored = await idbGetStudents();
      assert.equal(stored.length, 1);
      assert.equal(stored[0].id, 'st_keep_partial');
    }

    console.log('✅ Test 6 Passed: Partial parsing failures (corrupted row, malformed row, Gviz warnings) rejected cleanly');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 7: Storage-layer rejection in idbSaveStudents & idbReconcileStudents
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const existing = makeStudent({ id: 'st_storage_guard', name: 'بيانات محلية محمية', sourceSheet: 'نشط' });
    await idbSaveStudents([existing], 'نشط', true);

    const candidate = makeStudent({ id: 'st_incoming_1', name: 'وارد جديد', sourceSheet: 'نشط' });

    const invalidProofs: PullVerificationProof[] = [
      { verified: false, isComplete: true, sheetName: 'نشط', source: 'gviz', reason: 'unverified_tab' },
      { verified: true, isComplete: false, sheetName: 'نشط', source: 'gviz', reason: 'partial_parse' },
      { verified: true, isComplete: true, sheetName: 'غير نشط', source: 'gviz', reason: 'sheet_mismatch' }
    ];

    for (const proof of invalidProofs) {
      await assert.rejects(
        () => idbSaveStudents([candidate], 'نشط', true, proof),
        /تم رفض idbSaveStudents/,
        `idbSaveStudents must reject invalid proof (${proof.reason})`
      );
      await assert.rejects(
        () => idbReconcileStudents([candidate], [], 'نشط', true, proof),
        /تم رفض idbReconcileStudents/,
        `idbReconcileStudents must reject invalid proof (${proof.reason})`
      );
    }

    // Explicit isConfirmedComplete === false must reject EVEN for non-empty arrays!
    await assert.rejects(
      () => idbSaveStudents([candidate], 'نشط', false),
      /تم رفض idbSaveStudents/,
      'idbSaveStudents must reject non-empty array when isConfirmedComplete === false'
    );
    await assert.rejects(
      () => idbReconcileStudents([candidate], [], 'نشط', false),
      /تم رفض idbReconcileStudents/,
      'idbReconcileStudents must reject non-empty array when isConfirmedComplete === false'
    );

    // Empty array without confirmation
    await assert.rejects(() => idbSaveStudents([], 'نشط', undefined), /لا يمكن استبدال/);
    await assert.rejects(() => idbSaveStudents([], 'نشط', false), /تم رفض/);

    // Invalid student missing name
    await assert.rejects(
      () => idbSaveStudents([makeStudent({ id: 'bad_no_name', name: '   ', sourceSheet: 'نشط' })], 'نشط', true),
      /تم رفض/
    );

    // Verify zero impact on IndexedDB after all rejected calls
    const stored = await idbGetStudents();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'st_storage_guard');

    console.log('✅ Test 7 Passed: Storage-layer guards in idbSaveStudents & idbReconcileStudents reject all unverified/incomplete writes');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 8: Newer local student version & unsynced mutations + auxiliary stores protection
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const newerLocal = makeStudent({
      id: 'st_versioned_1',
      code: '501',
      name: 'كيفين سامح أميل عزمي',
      notes: 'غياب بسبب الامتحانات (نسخة محلية أحدث v5)',
      sourceSheet: 'نشط',
      version: 5
    });
    await idbSaveStudents([newerLocal], 'نشط', true);
    const { followup, history } = await seedAuxStores();

    // 8A: Verified Pull with older version (v1) must NOT downgrade newer local v5
    const olderRemoteSnapshot = makeStudent({
      id: 'st_versioned_1',
      code: '501',
      name: 'كيفين سامح أميل عزمي',
      notes: 'نسخة قديمة من الشيت v1',
      sourceSheet: 'نشط',
      version: 1
    });
    const verifiedProof: PullVerificationProof = {
      verified: true,
      isComplete: true,
      sheetName: 'نشط',
      source: 'gviz'
    };
    await idbSaveStudents([olderRemoteSnapshot], 'نشط', true, verifiedProof);

    let stored = await idbGetStudents();
    const afterSave = stored.find((s) => s.id === 'st_versioned_1');
    assert.equal(afterSave?.version, 5, 'Strictly newer local version must be preserved in idbSaveStudents');
    assert.equal(afterSave?.notes, 'غياب بسبب الامتحانات (نسخة محلية أحدث v5)');

    // 8B: Local pending mutation in queue + idbReconcileStudents preserves unsynced local state & mutations/followup/attendance_history
    const pendingMutation: OfflineMutation = {
      id: 'mut_pending_keep_1',
      action: 'attendance',
      studentId: 'st_versioned_1',
      studentCode: '501',
      studentName: 'كيفين سامح أميل عزمي',
      sourceSheet: 'نشط',
      payload: {
        action: 'recordAttendance',
        studentId: 'st_versioned_1',
        studentName: 'كيفين سامح أميل عزمي',
        friday: '2026-10-30',
        status: 'حاضر'
      },
      timestamp: Date.now(),
      status: 'pending'
    };
    await idbAtomicRecordAttendanceWithMutation(
      { ...newerLocal, att: { ...newerLocal.att, '2026-10-30': true }, attendanceTotal: 2, version: 6 },
      {
        id: 'st_versioned_1__2026-10-30',
        studentId: 'st_versioned_1',
        studentCode: '501',
        fridayDate: '2026-10-30',
        status: true,
        recordedAt: Date.now(),
        sourceSheet: 'نشط'
      },
      pendingMutation
    );

    // idbSaveStudents must refuse overwrite while mutation is pending
    await assert.rejects(
      () => idbSaveStudents([olderRemoteSnapshot], 'نشط', true, verifiedProof),
      /عمليات معلقة/,
      'idbSaveStudents must block overwrite when pending mutations exist'
    );

    // idbReconcileStudents must preserve pending local student AND newer local version AND all other stores
    const reconciled = await idbReconcileStudents(
      [olderRemoteSnapshot],
      [pendingMutation],
      'نشط',
      true,
      verifiedProof
    );
    const reconciledStudent = reconciled.find((s) => s.id === 'st_versioned_1');
    assert.equal(reconciledStudent?.version, 6, 'Pending local student state preserved by idbReconcileStudents');
    assert.equal(reconciledStudent?.att?.['2026-10-30'], true, 'Unsynced attendance edit preserved');
    assert.equal((await idbGetPendingMutations()).some((m) => m.id === pendingMutation.id), true, 'Mutations store untouched');
    assert.equal((await idbGetFollowupRecords()).some((r) => r.id === followup.id), true, 'Followup store untouched');
    assert.equal((await idbGetAttendanceHistory()).some((h) => h.id === history.id), true, 'Attendance history untouched');

    console.log('✅ Test 8 Passed: Newer local versions, unsynced mutations, followup, and attendance_history strictly preserved');
    passed++;
  }

  // ------------------------------------------------------------------
  // TEST 9: Assert ZERO write requests / ZERO Apps Script calls occurred
  // ------------------------------------------------------------------
  {
    assert.ok(allHttpCalls.length > 0, 'Mocked Gviz GET requests should have been exercised');
    assert.equal(
      allHttpCalls.every((entry) => entry.startsWith('GET ') && !entry.includes('script.google.com')),
      true,
      'All network traffic in tests must be mocked Gviz GET calls only (zero writes, zero Apps Script calls)'
    );
    console.log(`✅ Test 9 Passed: Verified ${allHttpCalls.length} mocked GET calls, 0 POST/write calls, 0 live Google Sheets hits`);
    passed++;
  }

  console.log('\n==============================================================');
  console.log(`🎉 ALL ${passed} OF 9 PHASE 4.2 SAFE PULL PROTECTION TESTS PASSED!`);
  console.log('==============================================================\n');
}

runTests()
  .then(() => {
    idbCloseDatabase();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 Phase 4.2 Safe Pull Protection Test Failed:', err);
    idbCloseDatabase();
    process.exit(1);
  });
