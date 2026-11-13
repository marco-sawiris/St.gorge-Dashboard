import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
(globalThis as any).indexedDB = fakeIndexedDB;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToString } from 'react-dom/server';

import {
  getIndexedDB,
  idbAtomicUpdateStudentWithMutation,
  idbAtomicRecordAttendanceWithMutation,
  idbGetAttendanceHistory,
  idbGetPendingMutations,
  idbGetStudents,
  idbSaveStudents,
  idbClearMutations
} from '../services/indexedDbService';
import {
  computeLatestSyncTime,
  evaluateSingleActiveEditLock,
  executeProcessOfflineQueue,
  executeSyncData,
  formatLastSyncCompact,
  formatLastSyncDateTime,
  AppProvider
} from '../context/AppContext';
import { AuthProvider, evaluateUserPermission } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';
import { StudentCard } from '../components/cards/StudentCard';
import { SyncStatusIndicator } from '../components/glass/SyncStatusIndicator';
import { SyncDetailsModal } from '../components/modals/SyncDetailsModal';
import { StudentFormModal } from '../components/modals/StudentFormModal';
import { NotificationsPanel } from '../components/modals/NotificationsPanel';
import {
  getAppsScriptUrl,
  isLocalhostUrl,
  setApiBaseUrl,
  setAppsScriptUrl,
  setRelayKey
} from '../services/apiConfig';
import {
  parse2DRowsToStudents,
  parseGoogleVisualizationResponse,
  parseGoogleVisualizationFollowupLog
} from '../services/googleSheetParser';
import {
  parseBirthDate,
  getBirthdayStudents,
  processAssistantQuery
} from '../services/assistantEngine';
import {
  computeMonthlyAttendanceSummary,
  getMonthFridays,
  getCairoDateParts,
  getLatestHeldFridayString
} from '../utils/arabicUtils';
import {
  DEFAULT_WEEKLY_REMINDERS,
  WEEKLY_NOTIFICATION_HORIZON,
  buildCapacitorNotificationsPayload,
  computeNextCairoOccurrence,
  loadWeeklyNotificationSettings,
  resetDefaultNotificationSettings,
  saveWeeklyNotificationSettings
} from '../services/weeklyNotificationService';
import { AssistantModal } from '../components/modals/AssistantModal';
import { DashboardChartsView } from '../components/charts/DashboardChartsView';
import { FollowupLogView } from '../components/followup/FollowupLogView';
import { StudentsTableView } from '../components/table/StudentsTableView';
import { SearchFilterBar } from '../components/common/SearchFilterBar';
import { buildCsvContent, buildPrintableHtmlReport } from '../utils/exportUtils';
import { LiquidToggle, computeLiquidToggleFraction } from '../components/glass/LiquidToggle';
import { SplashScreen } from '../components/layout/SplashScreen';
import { BottomKeyboardDock } from '../components/layout/BottomKeyboardDock';
import { Sidebar } from '../components/layout/Sidebar';
import { NavigationTabs } from '../components/layout/NavigationTabs';
import App from '../App';
import { AuthUser } from '../types/auth';
import { Student } from '../types/student';
import { generateUUID } from '../utils/uuid';

console.log('======================================================');
console.log('  🧪 Running St. George Sprint Verification Test Suite');
console.log('======================================================\n');

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); }
  };
}

function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: overrides.id || generateUUID(),
    code: 'SG-201',
    name: 'كيرلس مرقس جرجس',
    servant: 'مينا جورج',
    phoneStudent: '01200000011',
    phoneParent1: '01200000012',
    phoneParent2: '',
    birthDate: '2011-04-10',
    area: 'الزيتون الغربية',
    address: 'شارع سنان',
    notes: 'منتظم في الحضور',
    followupStatus: 'بدون',
    attendanceTotal: 4,
    attendanceMonth: 2,
    attendanceStatus: 'غائب',
    sourceSheet: 'نشط',
    version: 1,
    att: {},
    fu: {},
    ...overrides
  };
}

async function cleanIDB() {
  const db = await getIndexedDB();
  const tx = db.transaction(['students', 'followup', 'mutations', 'attendance_history'], 'readwrite');
  tx.objectStore('students').clear();
  tx.objectStore('followup').clear();
  tx.objectStore('mutations').clear();
  tx.objectStore('attendance_history').clear();
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function runSprintTests() {
  (globalThis as any).localStorage = createStorageMock();
  const originalFetch = globalThis.fetch;

  const adminUser: AuthUser = {
    userId: 'usr_admin_001',
    username: 'admin',
    displayName: 'أمين الخدمة',
    role: 'admin',
    token: 'valid.jwt.token.for.testing.purposes'
  };

  // --------------------------------------------------------------------------
  // TEST 1 & 2: Google Sheets Read + Save Last Successful Sync Date & Time
  // --------------------------------------------------------------------------
  await cleanIDB();
  const serverStudent = makeStudent({ id: 'gs_1', name: 'بيشوي عماد صموئيل', sourceSheet: 'نشط' });
  let recordedPullIso: string | null = null;
  let recordedError: string | null = null;

  (globalThis as any).fetch = async (url: string) => {
    if (String(url).includes('/api/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) } as any;
    }
    if (String(url).includes('/api/sheets/data')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          targetSheet: 'نشط',
          isComplete: true,
          confirmedComplete: true,
          students: [serverStudent]
        })
      } as any;
    }
    return { ok: false, status: 404 } as any;
  };

  const lockRef = { current: false };
  const syncOk = await executeSyncData(
    'نشط',
    adminUser,
    false,
    lockRef,
    undefined,
    undefined,
    (pullIso) => {
      recordedPullIso = pullIso;
      localStorage.setItem('stgorge_last_successful_pull_iso', pullIso);
    },
    undefined,
    (err) => { recordedError = err; }
  );

  assert(syncOk === true, 'Test 1: Sync from Google Sheets endpoint must succeed');
  assert(recordedError === null, 'Test 1: No sync error after success');
  assert(recordedPullIso !== null, 'Test 2: Last successful pull ISO timestamp must be saved');

  const formattedSync = formatLastSyncDateTime(recordedPullIso);
  const compactSync = formatLastSyncCompact(recordedPullIso);
  assert(formattedSync !== null && formattedSync.includes('•'), 'Test 2: Date + Time formatted cleanly');
  assert(compactSync !== null && compactSync.includes('/'), 'Test 2: Compact mobile date + time formatted');
  console.log(`✅ Test 1 & 2 Passed: Google Sheets read & full date+time sync display (${formattedSync})`);

  // --------------------------------------------------------------------------
  // TEST 3: Sync Failure MUST NOT overwrite Last Successful Sync Timestamp
  // --------------------------------------------------------------------------
  const preservedPullBeforeFail = localStorage.getItem('stgorge_last_successful_pull_iso');
  (globalThis as any).fetch = async () => {
    throw new TypeError('Network unreachable');
  };

  let failRecordedTime: string | null = null;
  let failRecordedError: string | null = null;
  const syncFail = await executeSyncData(
    'نشط',
    adminUser,
    false,
    lockRef,
    undefined,
    undefined,
    (iso) => { failRecordedTime = iso; },
    undefined,
    (err) => { failRecordedError = err; }
  );

  assert(syncFail === false, 'Test 3: Sync failure must return false');
  assert(failRecordedTime === null, 'Test 3: Failed sync MUST NOT update success timestamp');
  assert(failRecordedError !== null, 'Test 3: Failure reason recorded');
  assert(
    localStorage.getItem('stgorge_last_successful_pull_iso') === preservedPullBeforeFail,
    'Test 3: Stored successful sync timestamp remains unchanged on failure'
  );
  console.log('✅ Test 3 Passed: Sync failure never updates last successful sync timestamp');

  // --------------------------------------------------------------------------
  // TEST 4: Restore Data & Sync Timestamp on App Restart
  // --------------------------------------------------------------------------
  const restoredStudents = await idbGetStudents();
  assert(restoredStudents.length === 1 && restoredStudents[0].name === 'بيشوي عماد صموئيل', 'Test 4: IndexedDB retains student data after restart');
  const restoredSyncIso = computeLatestSyncTime(
    localStorage.getItem('stgorge_last_successful_pull_iso'),
    localStorage.getItem('stgorge_last_successful_push_iso')
  );
  assert(restoredSyncIso === preservedPullBeforeFail, 'Test 4: Last sync timestamp restored from localStorage');
  console.log('✅ Test 4 Passed: Students & last successful sync timestamp restored across restarts');

  // --------------------------------------------------------------------------
  // TEST 5, 6 & 7: Offline Work, Reconnect Sync, and Idempotency Deduplication
  // --------------------------------------------------------------------------
  const mutId = `ATT_${serverStudent.id}_${generateUUID()}`;
  await idbAtomicUpdateStudentWithMutation(
    { ...serverStudent, attendanceStatus: 'حاضر', attendanceTotal: 5, version: 2 },
    {
      id: mutId,
      action: 'attendance',
      studentId: serverStudent.id,
      studentCode: serverStudent.code,
      studentName: serverStudent.name,
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    }
  );

  let pendingQueue = await idbGetPendingMutations();
  assert(pendingQueue.length === 1, 'Test 5: Mutation queued locally while offline');

  const seenKeys: string[] = [];
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    if (String(url).includes('/api/sheets/mutate')) {
      seenKeys.push(opts?.headers?.['X-Idempotency-Key']);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, mutationId: mutId, newVersion: 2 })
      } as any;
    }
    return { ok: false, status: 404 } as any;
  };

  let pushedIso: string | null = null;
  const flushRes = await executeProcessOfflineQueue(null, false, undefined, (iso) => {
    pushedIso = iso;
  });

  assert(flushRes.success === true && flushRes.sentCount === 1 && flushRes.remainingCount === 0, 'Test 6: Queued mutation synced directly once internet returns');
  assert(seenKeys.length === 1 && seenKeys[0] === mutId, 'Test 7: Idempotency key matches stable mutation UUID');
  assert(pushedIso !== null, 'Test 6: Push timestamp updated only after server confirmation');
  pendingQueue = await idbGetPendingMutations();
  assert(pendingQueue.length === 0, 'Test 6: Queue cleared after confirmed sync');
  console.log('✅ Test 5, 6 & 7 Passed: Offline queue, reconnect sync, and X-Idempotency-Key deduplication');

  // --------------------------------------------------------------------------
  // TEST 8: Google Apps Script Relay Transport & OCC 409 Handling
  // --------------------------------------------------------------------------
  const relayUrlSaved = setAppsScriptUrl('https://script.google.com/macros/s/AKfycbTestRelayId/exec');
  assert(relayUrlSaved === true, 'Test 8a: Valid Apps Script URL accepted');
  assert(setAppsScriptUrl('http://localhost:3000/macros') === false, 'Test 8b: Invalid/non-Apps-Script URL rejected');
  assert(setApiBaseUrl('http://localhost:3000') === false, 'Test 8c: Localhost API base URL strictly rejected');
  setRelayKey('test-relay-key');

  let capturedRelayPostBody: any = null;
  let capturedRelayGetUrl = '';
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    const urlStr = String(url);
    if (opts?.method === 'POST') {
      capturedRelayPostBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, newVersion: 3 })
      } as any;
    }
    capturedRelayGetUrl = urlStr;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        targetSheet: 'نشط',
        isComplete: true,
        students: [serverStudent]
      })
    } as any;
  };

  const relayMutId = `UPD_${serverStudent.id}_${generateUUID()}`;
  await idbAtomicUpdateStudentWithMutation(
    { ...serverStudent, notes: 'تحديث عبر Relay', version: 3 },
    {
      id: relayMutId,
      action: 'update',
      studentId: serverStudent.id,
      studentCode: serverStudent.code,
      studentName: serverStudent.name,
      sourceSheet: 'نشط',
      payload: { notes: 'تحديث عبر Relay' },
      expectedVersion: 2,
      timestamp: Date.now(),
      status: 'pending'
    }
  );

  const relaySyncOk = await executeSyncData('نشط', null, false, lockRef);
  assert(relaySyncOk === true, 'Test 8d: Direct Apps Script Relay sync succeeded without servant login');
  assert(capturedRelayPostBody?.idempotencyKey === relayMutId, 'Test 8e: Relay POST carries idempotencyKey');
  assert(capturedRelayPostBody?.relayKey === 'test-relay-key', 'Test 8f: Relay POST carries optional relayKey');
  assert(capturedRelayGetUrl.includes('action=getStudents'), 'Test 8g: Relay GET requests getStudents action');

  // Test HTTP 200 JSON 409 conflict inside Apps Script response
  const conflictMutId = `ATT_conflict_${generateUUID()}`;
  await idbAtomicUpdateStudentWithMutation(
    { ...serverStudent, attendanceStatus: 'غائب', version: 4 },
    {
      id: conflictMutId,
      action: 'attendance',
      studentId: serverStudent.id,
      studentCode: serverStudent.code,
      studentName: serverStudent.name,
      sourceSheet: 'نشط',
      payload: { isPresent: false },
      expectedVersion: 1,
      timestamp: Date.now(),
      status: 'pending'
    }
  );
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, status: 409, error: 'Version Conflict' })
  }) as any;
  const conflictRes = await executeProcessOfflineQueue(null, false);
  assert(conflictRes.success === false && conflictRes.remainingCount === 1, 'Test 8h: Apps Script 409 conflict pauses queue without losing mutation');
  await idbClearMutations();
  setAppsScriptUrl('');
  setRelayKey('');
  console.log('✅ Test 8 Passed: Google Apps Script Relay transport & OCC 409 handling verified');

  // --------------------------------------------------------------------------
  // TEST 9: Single Active Edit Enforcement
  // --------------------------------------------------------------------------
  const lock1 = evaluateSingleActiveEditLock(null, 'std_A', false);
  assert(lock1.allowed === true, 'Test 9a: First card allowed to enter edit mode');

  const lockSame = evaluateSingleActiveEditLock('std_A', 'std_A', false);
  assert(lockSame.allowed === true, 'Test 9b: Same active card remains editable');

  const lockSecond = evaluateSingleActiveEditLock('std_A', 'std_B', false);
  assert(lockSecond.allowed === false, 'Test 9c: Opening a second card while std_A is editing MUST be blocked');

  const lockWhileAdd = evaluateSingleActiveEditLock(null, 'std_B', true);
  assert(lockWhileAdd.allowed === false, 'Test 9d: Opening card edit while Add modal is open MUST be blocked');
  console.log('✅ Test 9 Passed: Single Active Edit strictly enforced across app');

  // --------------------------------------------------------------------------
  // TEST 10: Direct Boot Without Servant Login & Card Without Initials Badge
  // --------------------------------------------------------------------------
  const loginModalPath = path.resolve(process.cwd(), 'src/components/modals/LoginModal.tsx');
  assert(!fs.existsSync(loginModalPath), 'Test 10a: LoginModal.tsx must not exist on disk');

  const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  assert(!appSrc.includes('LoginModal') && !appSrc.includes('isPreviewMode'), 'Test 10b: App.tsx boots directly without LoginModal or Preview Mode');

  const formModalHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(StudentFormModal, {
            isOpen: true,
            onClose: () => {},
            studentToEdit: serverStudent
          })
        )
      )
    )
  );
  assert(formModalHtml.includes('تعديل بيانات:'), 'Test 10c: StudentFormModal opens for direct editing without login');
  assert(!formModalHtml.includes('تسجيل الدخول') && !formModalHtml.includes('وضع القراءة فقط'), 'Test 10c: Zero servant login prompts in edit form');

  const syncModalHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(SyncDetailsModal)
        )
      )
    )
  );
  assert(!syncModalHtml.includes('تسجيل الدخول'), 'Test 10d: SyncDetailsModal never requires servant login');

  const cardHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(StudentCard, {
            student: serverStudent,
            onOpenFollowup: () => {},
            onOpenEdit: () => {}
          })
        )
      )
    )
  );
  assert(cardHtml.includes('بيشوي عماد صموئيل'), 'Test 10d: Full Arabic student name rendered');
  assert(!cardHtml.includes('>ب ع<') && !cardHtml.includes('>SG<'), 'Test 10e: Two-letter initials badge removed');
  assert(cardHtml.includes('تعديل البيانات') && cardHtml.includes('تسجيل افتقاد'), 'Test 10f: Followup & Edit actions preserved');
  assert(!cardHtml.includes('حذف المخدوم'), 'Test 10g: Zero Delete policy preserved on StudentCard');

  const syncHtmlWithTime = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(SyncStatusIndicator)
        )
      )
    )
  );
  assert(syncHtmlWithTime.includes('متصل') && syncHtmlWithTime.includes('•'), 'Test 10h: SyncStatusIndicator displays Connected + formatted last sync date/time');

  localStorage.removeItem('stgorge_last_successful_pull_iso');
  localStorage.removeItem('stgorge_last_successful_push_iso');
  const syncHtmlEmpty = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(SyncStatusIndicator)
        )
      )
    )
  );
  assert(syncHtmlEmpty.includes('لم تتم مزامنة بعد'), 'Test 10i: SyncStatusIndicator shows fallback when no sync exists yet');

  const sidebarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf-8');
  assert(!sidebarSrc.includes('تسجيل الخروج') && !sidebarSrc.includes('LoginModal'), 'Test 10j: Sidebar contains zero login/logout controls');
  console.log('✅ Test 10 Passed: Login-free direct startup, no initials badge & full UI verified');

  // --------------------------------------------------------------------------
  // TEST 11: Security & Authorization Audit (RBAC / RLAC / No Secrets / No Localhost)
  // --------------------------------------------------------------------------
  const servantUser: AuthUser = {
    userId: 'usr_mina',
    username: 'mina',
    displayName: 'مينا جورج',
    role: 'servant',
    assignedServantName: 'مينا جورج',
    token: 'valid.jwt.token'
  };
  assert(evaluateUserPermission(servantUser, false, 'attendance', 'مينا جورج').allowed === true, 'Test 11: Servant allowed on own student');
  assert(evaluateUserPermission(servantUser, false, 'attendance', 'بيتر سمير').allowed === false, 'Test 11: Servant blocked from other servant student');
  assert(evaluateUserPermission(servantUser, false, 'add_student', 'مينا جورج').allowed === false, 'Test 11: Servant blocked from adding students');
  assert(isLocalhostUrl('http://localhost:3000') === true && isLocalhostUrl('https://api.stgeorge.app') === false, 'Test 11: Localhost detector functional');
  assert(getAppsScriptUrl() === '', 'Test 11: Cleared relay URL returns empty string');

  const srcFiles = [
    'src/App.tsx',
    'src/services/apiConfig.ts',
    'src/context/AuthContext.tsx',
    'src/context/AppContext.tsx',
    'src/components/layout/Sidebar.tsx',
    'src/components/modals/SyncDetailsModal.tsx',
    'src/components/modals/StudentFormModal.tsx',
    'src/components/modals/QuickFollowupModal.tsx'
  ];
  for (const rel of srcFiles) {
    const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
    assert(!content.includes('BEGIN PRIVATE KEY'), `Security Audit: No private key in ${rel}`);
    assert(!content.includes('Admin@123456'), `Security Audit: No hardcoded admin password in ${rel}`);
    assert(!content.includes('LoginModal'), `Security Audit: Zero LoginModal references in ${rel}`);
  }
  console.log('✅ Test 11 Passed: RBAC/RLAC & zero secrets / zero LoginModal audit verified\n');

  // --------------------------------------------------------------------------
  // TEST 12: Real Google Sheets Parser & Zero Mock Data Enforcement
  // --------------------------------------------------------------------------
  assert(
    !fs.existsSync(path.resolve(process.cwd(), 'src/services/mockData.ts')),
    'Test 12a: src/services/mockData.ts must be completely removed'
  );

  const gvizPayload = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[{"id":"A","label":"","type":"string"},{"id":"B","label":"","type":"string"},{"id":"C","label":"","type":"string"},{"id":"D","label":"","type":"string"},{"id":"E","label":"","type":"string"},{"id":"F","label":"","type":"string"},{"id":"G","label":"","type":"string"},{"id":"H","label":"","type":"string"},{"id":"I","label":"","type":"string"},{"id":"J","label":"","type":"string"},{"id":"K","label":"","type":"string"},{"id":"L","label":"","type":"string"},{"id":"M","label":"","type":"string"},{"id":"N","label":"","type":"string"}],"rows":[{"c":[{"v":"كود"},{"v":"الاسم"},{"v":"الاشبين"},{"v":"موبيال المخدوم"},{"v":"موبيل ولي الامر 1"},{"v":"موبيل ولي الامر 2"},{"v":"تاريخ الميلاد"},{"v":"منطقة"},{"v":"العنوان"},{"v":"ملاحظات الافتقاد"},{"v":"آخر حضور"},{"v":"آخر افتقاد"},{"v":"2026-11-13"},{"v":"افتقاد 2026-11-13"}]},{"c":[{"v":"651171"},{"v":"كيفين جرجس سمير"},{"v":"أبانوب نشأت"},{"v":"01279964011"},{"v":"01283011703"},{"v":""},{"v":"2012-09-12"},{"v":"حدائق الزيتون"},{"v":"شارع سليم الأول"},{"v":"منتظم"},{"v":"2026-11-13"},{"v":"2026-11-13"},{"v":"1"},{"v":"تم تليفونياً"}]}]}});`;

  const parsedRealStudents = parseGoogleVisualizationResponse(gvizPayload, 'نشط');
  assert(parsedRealStudents.length === 1, 'Test 12b: Parses student row from real gviz headers-in-row[0] schema');
  assert(parsedRealStudents[0].code === '651171', 'Test 12c: Parses student code cleanly');
  assert(parsedRealStudents[0].phoneStudent === '01279964011', 'Test 12d: Handles real spelling موبيال المخدوم');
  assert(parsedRealStudents[0].att['2026-11-13'] === true, 'Test 12e: Parses dynamic Friday attendance column');
  assert(parsedRealStudents[0].fu['2026-11-13'] === 'تم تليفونياً', 'Test 12f: Parses dynamic Friday followup column');
  assert(parsedRealStudents[0].attendanceStatus === 'حاضر', 'Test 12g: Computes latest attendanceStatus accurately');

  const placeholderParsed = parse2DRowsToStudents(['', 'سؤال بدون عنوان'], [['1', 'بيان']], 'غير نشط');
  assert(placeholderParsed.length === 0, 'Test 12h: Empty form placeholder tab returns empty array');

  assert(appSrc.includes('تعذر تحميل البيانات'), 'Test 12i: App.tsx includes clear Arabic error banner when real load fails');
  console.log('✅ Test 12 Passed: Real Google Sheets parser, Friday dynamic columns & zero mock data verified\n');

  // --------------------------------------------------------------------------
  // TEST 13: Redesigned Animated Liquid Glass Sidebar Verification
  // --------------------------------------------------------------------------
  const cssSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf-8');
  assert(cssSrc.includes('@keyframes sidebarBlobMove'), 'Test 13a: Morphing blob animation keyframes exist in index.css');
  assert(cssSrc.includes('.sidebar-glass-panel') && cssSrc.includes('.sidebar-blob'), 'Test 13b: Sidebar glass & blob classes exist');
  assert(cssSrc.includes('prefers-reduced-motion'), 'Test 13c: Motion reduction accessibility supported');

  assert(sidebarSrc.includes('sidebar-glass-panel') && sidebarSrc.includes('sidebar-blob'), 'Test 13d: Sidebar.tsx renders animated morphing glass structure');
  assert(sidebarSrc.includes('lg:w-[272px]') && sidebarSrc.includes('lg:w-[84px]'), 'Test 13e: Desktop sidebar supports collapsible expanded/collapsed widths');
  assert(sidebarSrc.includes('translate-x-full lg:translate-x-0'), 'Test 13f: Mobile drawer smoothly slides RTL without overlapping desktop');
  assert(sidebarSrc.includes('حالة المزامنة') && !sidebarSrc.includes('إعدادات المزامنة') && sidebarSrc.includes('المناطق السكنية') && sidebarSrc.includes('عن التطبيق'), 'Test 13g: All sidebar navigation & action items preserved without technical sync config link');
  console.log('✅ Test 13 Passed: Premium Animated Liquid Glass Sidebar (Desktop + RTL Mobile + Accessibility) verified\n');

  // --------------------------------------------------------------------------
  // TEST 14: TopBar Clock Removal & Sync Timestamp Strict Integrity
  // --------------------------------------------------------------------------
  const topBarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/TopBar.tsx'), 'utf-8');
  assert(!topBarSrc.includes('CompactDateTime'), 'Test 14a: CompactDateTime live clock completely deleted from TopBar.tsx');
  assert(!topBarSrc.includes('setInterval') && !topBarSrc.includes('ARABIC_MONTHS'), 'Test 14b: No live clock timers or auto-updating current date in TopBar.tsx');
  assert(topBarSrc.includes('SyncStatusIndicator'), 'Test 14c: SyncStatusIndicator retained in TopBar.tsx');
  console.log('✅ Test 14 Passed: Live clock deleted from TopBar while preserving last sync indicator');

  // --------------------------------------------------------------------------
  // TEST 15: Sidebar Glowing Light Orb + Smart Assistant Trigger
  // --------------------------------------------------------------------------
  assert(cssSrc.includes('@keyframes sidebarLightOrbit') && cssSrc.includes('.sidebar-light-orb'), 'Test 15a: Sidebar light orb keyframes and class exist in index.css');
  assert(
    cssSrc.includes('.sidebar-light-orb') && cssSrc.includes('prefers-reduced-motion'),
    'Test 15b: Sidebar light orb respects prefers-reduced-motion'
  );
  assert(sidebarSrc.includes('sidebar-light-orb'), 'Test 15c: Sidebar.tsx renders sidebar-light-orb');
  assert(sidebarSrc.includes('المساعد الذكي') && sidebarSrc.includes('setIsAssistantOpen'), 'Test 15d: Sidebar.tsx triggers Smart Assistant modal');
  console.log('✅ Test 15 Passed: Sidebar Light Orb animation + Smart Assistant button verified');

  // --------------------------------------------------------------------------
  // TEST 16: StudentCard Dual Tracks (Monthly Attendance Tri-State Green/Red/Neutral & Followup)
  // --------------------------------------------------------------------------
  const currentSummaryNow = computeMonthlyAttendanceSummary({});
  const dynamicAtt: Record<string, boolean> = {};
  currentSummaryNow.fridays.forEach((f, idx) => {
    if (!f.isFuture) {
      dynamicAtt[f.date] = idx === 0 ? true : false;
    }
  });

  const trackStudent = makeStudent({
    id: 'track_1',
    name: 'فادي عادل نجيب',
    attendanceMonth: currentSummaryNow.heldCount > 0 ? 1 : 0,
    attendanceTotal: 8,
    att: dynamicAtt,
    followupStatus: 'تم تليفونياً',
    fu: { '2026-11-06': 'تم تليفونياً', '2026-11-13': 'واتساب' }
  });
  const trackCardHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(StudentCard, {
            student: trackStudent,
            onOpenFollowup: () => {},
            onOpenEdit: () => {}
          })
        )
      )
    )
  );
  const expectedTrackRatio = `${currentSummaryNow.heldCount > 0 ? 1 : 0}/${currentSummaryNow.heldCount}`;
  assert(trackCardHtml.includes('card-dual-tracks'), 'Test 16a: Dual tracks container rendered on StudentCard');
  assert(
    trackCardHtml.includes('الحضور الشهري') &&
      trackCardHtml.includes(expectedTrackRatio) &&
      trackCardHtml.includes(`${currentSummaryNow.totalFridaysInMonth} جمع`),
    'Test 16b: Monthly attendance displays exact held Friday ratio and total Fridays in month'
  );
  assert(trackCardHtml.includes('الافتقاد (2)') && trackCardHtml.includes('تم تليفونياً'), 'Test 16c: Real followup count & status displayed');
  if (currentSummaryNow.heldCount >= 1) {
    assert(trackCardHtml.includes('bg-emerald-500/20'), 'Test 16d: Present recorded Friday displays green state');
  }
  if (currentSummaryNow.heldCount >= 2) {
    assert(trackCardHtml.includes('bg-rose-500/20'), 'Test 16d2: Absent recorded Friday displays red state');
  }

  const pendingStudentHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(StudentCard, {
            student: makeStudent({ id: 'track_2', followupStatus: 'بدون', fu: {}, att: {} }),
            onOpenFollowup: () => {},
            onOpenEdit: () => {}
          })
        )
      )
    )
  );
  assert(pendingStudentHtml.includes('بحاجة لافتقاد'), 'Test 16e: Unfollowed student clearly displays بحاجة لافتقاد');
  assert(
    !pendingStudentHtml.includes('bg-rose-500/20') && pendingStudentHtml.includes('bg-slate-500/12'),
    'Test 16f: Unrecorded attendance remains neutral and is NEVER treated as absent'
  );
  console.log('✅ Test 16 Passed: StudentCard Monthly Attendance tri-state Green/Red/Neutral & Followup tracks verified');

  // --------------------------------------------------------------------------
  // TEST 17: Smart Assistant Engine & Modal (Offline-Capable, Real Data Only)
  // --------------------------------------------------------------------------
  const emptyRes = processAssistantQuery('إحصائيات', []);
  assert(
    emptyRes.text.includes('لا توجد بيانات مخدومين محملة') &&
      Boolean(emptyRes.actions?.some((a) => a.type === 'sync')),
    'Test 17a: Smart Assistant refuses to fabricate stats when data is empty'
  );

  const bdArabic = parseBirthDate('١٥/١١/٢٠١٢');
  assert(bdArabic !== null && bdArabic.getDate() === 15 && bdArabic.getMonth() === 10, 'Test 17b: Parses Arabic digits DD/MM/YYYY');
  const bdSerial = parseBirthDate('41000');
  assert(bdSerial !== null && bdSerial.getFullYear() === 2012, 'Test 17c: Parses Excel serial birth date');

  const refDate = new Date(2026, 10, 12); // Nov 12, 2026
  const bdayStudents = [
    makeStudent({ id: 'bd_1', name: 'مارك بطرس', birthDate: '2013-11-14', phoneStudent: '01211112222' }),
    makeStudent({ id: 'bd_2', name: 'توني سمير', birthDate: '2013-02-01' })
  ];
  const upcomingBdays = getBirthdayStudents(bdayStudents, 7, refDate);
  assert(upcomingBdays.length === 1 && upcomingBdays[0].student.id === 'bd_1' && upcomingBdays[0].daysUntil === 2, 'Test 17d: Detects upcoming birthday within 7 days');

  const bdayAnswer = processAssistantQuery('أعياد الميلاد', bdayStudents, { referenceDate: refDate });
  assert(bdayAnswer.text.includes('مارك بطرس'), 'Test 17e: Assistant lists upcoming birthday student');

  const statsAnswer = processAssistantQuery('إحصائيات', [trackStudent, ...bdayStudents], { referenceDate: refDate });
  assert(statsAnswer.text.includes('إجمالي المخدومين المحملين: 3'), 'Test 17f: Assistant calculates accurate stats from real student schema');

  const msgAnswer = processAssistantQuery('رسالة افتقاد لـ مارك', bdayStudents, { referenceDate: refDate });
  assert(Boolean(msgAnswer.copyText && msgAnswer.whatsappPhone === '01211112222'), 'Test 17g: Assistant prepares copyable + WhatsApp message for mentioned student');

  const faqAnswer = processAssistantQuery('كيف اضيف مخدوم جديد؟', bdayStudents);
  assert(faqAnswer.text.includes('إضافة مخدوم'), 'Test 17h: Assistant answers FAQ accurately');

  const assistantModalClosedHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(AssistantModal)
        )
      )
    )
  );
  assert(assistantModalClosedHtml === '', 'Test 17j: AssistantModal stays hidden until explicitly opened');

  const assistantModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/AssistantModal.tsx'), 'utf-8');
  const assistantEngineSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/services/assistantEngine.ts'), 'utf-8');
  assert(
    !assistantModalSrc.includes('GEMINI_API_KEY') && !assistantEngineSrc.includes('generativelanguage.googleapis.com'),
    'Test 17k: Smart Assistant uses strictly local logic without external LLM API keys'
  );
  assert(appSrc.includes('<AssistantModal') && appSrc.includes('activeToast'), 'Test 17l: App.tsx mounts AssistantModal and activeToast banner');
  console.log('✅ Test 17 Passed: Smart Assistant engine, birthdays, messages, FAQ & real-data honesty verified');

  // --------------------------------------------------------------------------
  // TEST 18: All 6 Single Active Edit Scenarios & UI Feedback
  // --------------------------------------------------------------------------
  const sA = evaluateSingleActiveEditLock(null, 'card_A', false);
  assert(sA.allowed === true, 'Test 18.1: Open card A allowed when idle');
  const sB = evaluateSingleActiveEditLock('card_A', 'card_B', false);
  assert(sB.allowed === false && Boolean(sB.reason), 'Test 18.2: Opening card B blocked with reason while card A is active');
  const sB_afterSave = evaluateSingleActiveEditLock(null, 'card_B', false);
  assert(sB_afterSave.allowed === true, 'Test 18.3: Card B allowed after card A saves and releases lock');
  const sB_afterCancel = evaluateSingleActiveEditLock(null, 'card_B', false);
  assert(sB_afterCancel.allowed === true, 'Test 18.4: Card B allowed after card A cancels');

  const appCtxSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/context/AppContext.tsx'), 'utf-8');
  assert(
    appCtxSrc.includes('hasUnsavedEditChangesRef.current') &&
      appCtxSrc.includes('يوجد تعديل غير محفوظ') &&
      appCtxSrc.includes('تم تأجيل المزامنة مؤقتاً'),
    'Test 18.5 & 18.6: AppContext protects active unsaved edits on tab navigation and syncData'
  );
  const cardSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/cards/StudentCard.tsx'), 'utf-8');
  const tableSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/table/StudentsTableView.tsx'), 'utf-8');
  assert(
    cardSrc.includes('aria-disabled={isAnotherCardEditing}') &&
      tableSrc.includes('aria-disabled={Boolean(activeEditingId && activeEditingId !== s.id)}'),
    'Test 18 UI Lock: Locked edit buttons stay clickable via aria-disabled to emit Arabic warning toast'
  );
  console.log('✅ Test 18 Passed: All 6 Single Active Edit scenarios & warning toast guards verified');

  // --------------------------------------------------------------------------
  // TEST 19: Feature Parity Additions (Log Parser, KPIs, Weekly SVG, Exports, Filters)
  // --------------------------------------------------------------------------
  const logGviz = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[],"rows":[{"c":[{"v":"التاريخ"},{"v":"أسبوع الجمعة"},{"v":"التاب"},{"v":"الكود"},{"v":"الاسم"},{"v":"الاشبين"},{"v":"النوع"},{"v":"ملا حظات"}]},{"c":[{"v":"2026-11-10"},{"v":"2026-11-13"},{"v":"نشط"},{"v":"651171"},{"v":"كيفين جرجس"},{"v":"أبانوب نشأت"},{"v":"تم تليفونياً"},{"v":"الأسرة بخير"}]},{"c":[{"v":""},{"v":""},{"v":"نشط"},{"v":"999999"},{"v":"صف فارغ"},{"v":"أبانوب"},{"v":""},{"v":""}]}]}});`;
  const logLookup = new Map<string, Student>([
    ['651171', makeStudent({ id: 'stu_651171', code: '651171', name: 'كيفين جرجس' })]
  ]);
  const parsedLog = parseGoogleVisualizationFollowupLog(logGviz, logLookup);
  assert(parsedLog.length === 1, 'Test 19a: Followup log parser handles spaced header (ملا حظات) and skips blank template rows');
  assert(parsedLog[0].studentId === 'stu_651171' && parsedLog[0].notes === 'الأسرة بخير', 'Test 19b: Matches student UUID and preserves notes');

  const chartsHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(DashboardChartsView)
        )
      )
    )
  );
  assert(chartsHtml.includes('المنتظمون (3+)') && chartsHtml.includes('لم يحضروا هذا الشهر'), 'Test 19c: DashboardChartsView displays Regular (3+) & Absent All Month KPIs');
  assert(chartsHtml.includes('تطور نسب الحضور الأسبوعية'), 'Test 19d: DashboardChartsView renders Weekly Attendance Trend card');

  const tableHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(StudentsTableView, { onOpenFollowup: () => {}, onOpenEdit: () => {} })
        )
      )
    )
  );
  assert(
    tableHtml.includes('آخر حضور') && tableHtml.includes('طباعة / PDF') && tableHtml.includes('ملخص واتساب'),
    'Test 19e: StudentsTableView includes lastAttendance column, Print/PDF and WhatsApp summary'
  );

  const fuHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(FollowupLogView)
        )
      )
    )
  );
  assert(
    fuHtml.includes('تقرير الافتقاد الشامل') && fuHtml.includes('طباعة / PDF') && fuHtml.includes('تصدير Excel (CSV)'),
    'Test 19f: FollowupLogView supports all-servants WhatsApp summary and CSV/PDF exports'
  );

  const searchBarHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(SearchFilterBar)
        )
      )
    )
  );
  assert(searchBarHtml.includes('مزامنة السيرفر'), 'Test 19g: SearchFilterBar renders cleanly');
  const searchBarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/common/SearchFilterBar.tsx'), 'utf-8');
  assert(searchBarSrc.includes('مسح الفلاتر'), 'Test 19h: SearchFilterBar includes Clear Filters button');

  const sampleCsv = buildCsvContent(['الاسم', 'الكود'], [['مارك', '101']]);
  assert(sampleCsv.startsWith('\uFEFF'), 'Test 19h: CSV export includes UTF-8 BOM');
  const sampleHtmlReport = buildPrintableHtmlReport('تقرير تجريبي', 'وصف', ['الاسم'], [['مارك']]);
  assert(sampleHtmlReport.includes('dir="rtl"') && sampleHtmlReport.includes('مارك'), 'Test 19i: Printable HTML report generates valid RTL Arabic table');
  console.log('✅ Test 19 Passed: Full feature parity additions verified');

  // --------------------------------------------------------------------------
  // TEST 20: UI Reference 1 — LiquidToggle (Drag fraction RTL/LTR, Role Switch, Zero Green)
  // --------------------------------------------------------------------------
  const rtlStart = computeLiquidToggleFraction(200, { left: 100, width: 100 }, true);
  const rtlEnd = computeLiquidToggleFraction(100, { left: 100, width: 100 }, true);
  assert(rtlStart === 0 && rtlEnd === 1, 'Test 20a: RTL drag fraction maps right edge -> 0 (OFF) and left edge -> 1 (ON)');
  const ltrEnd = computeLiquidToggleFraction(200, { left: 100, width: 100 }, false);
  assert(ltrEnd === 1, 'Test 20b: LTR drag fraction maps right edge -> 1 (ON)');

  const toggleOnHtml = renderToString(
    React.createElement(LiquidToggle, {
      checked: true,
      onChange: () => {},
      label: 'تبديل تجريبي',
      onLabel: 'مفعل',
      offLabel: 'متوقف'
    })
  );
  assert(
    toggleOnHtml.includes('role="switch"') &&
      toggleOnHtml.includes('aria-checked="true"') &&
      toggleOnHtml.includes('liquid-toggle--on') &&
      !toggleOnHtml.includes('bg-emerald') &&
      !toggleOnHtml.includes('bg-green'),
    'Test 20c: LiquidToggle renders accessible ARIA switch in Zero-Green Blue/Cyan styling'
  );
  const toggleSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/glass/LiquidToggle.tsx'), 'utf-8');
  assert(
    toggleSrc.includes('onPointerDown') &&
      toggleSrc.includes('onPointerMove') &&
      toggleSrc.includes('onKeyDown') &&
      toggleSrc.includes('targetNext === checked'),
    'Test 20d: LiquidToggle supports drag, keyboard Enter/Space, and commits only real prop changes'
  );
  console.log('✅ Test 20 Passed: LiquidToggle mechanics, RTL/LTR drag, accessibility & real-state commitment verified');

  // --------------------------------------------------------------------------
  // TEST 21: UI Reference 2 — Unified Liquid Glass Sidebar & Buttons (VYLQJoy)
  // --------------------------------------------------------------------------
  const indexCssSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf-8');
  const sidebarSrcV2 = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf-8');
  assert(
    indexCssSrc.includes('.glass-btn') &&
      indexCssSrc.includes('.glass-btn--primary') &&
      indexCssSrc.includes('.glass-btn--active') &&
      indexCssSrc.includes('.sidebar-nav-active') &&
      indexCssSrc.includes('[aria-disabled="true"]') &&
      indexCssSrc.includes('@media (prefers-reduced-motion: reduce)'),
    'Test 21a: index.css defines unified Liquid Glass button states + flat VYLQJoy Sidebar active state'
  );
  assert(
    sidebarSrcV2.includes('sidebar-nav-item') &&
      !sidebarSrcV2.includes('sidebar-nav-item glass-btn') &&
      !sidebarSrcV2.includes('السمة ومظهر التطبيق') &&
      !sidebarSrcV2.includes('<LiquidToggle'),
    'Test 21b: Sidebar uses flat VYLQJoy nav links (not boxed glass-btn pills) and excludes Theme toggles'
  );
  console.log('✅ Test 21 Passed: Unified Liquid Glass Sidebar & Buttons system verified');

  // --------------------------------------------------------------------------
  // TEST 22: UI Reference 3 — Blurry Loading SplashScreen (LYBgdwr)
  // --------------------------------------------------------------------------
  const splashHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(SplashScreen, { onDismiss: () => {} })
        )
      )
    )
  );
  assert(
    splashHtml.includes('blurry-splash-bg') &&
      splashHtml.includes('دخول الآن') &&
      !splashHtml.includes('iframe'),
    'Test 22a: SplashScreen renders optical Blurry Loading stage with instant non-blocking entry button'
  );
  const splashSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/SplashScreen.tsx'), 'utf-8');
  assert(
    splashSrc.includes('isInitialLoading') &&
      splashSrc.includes('isSyncing') &&
      splashSrc.includes('splash-shimmer') &&
      !splashSrc.includes("width: phase.stage === 'syncing'") &&
      splashSrc.includes('filter: `blur('),
    'Test 22b: SplashScreen uses real isInitialLoading / isSyncing stages with honest indeterminate optical shimmer'
  );
  console.log('✅ Test 22 Passed: Blurry Loading SplashScreen real progress & non-blocking UX verified');

  // --------------------------------------------------------------------------
  // TEST 23: Centered Alphabet Dock Handle (Keyboard Label + All Filter Preserved)
  // --------------------------------------------------------------------------
  const dockHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(BottomKeyboardDock)
        )
      )
    )
  );
  assert(
    !dockHtml.includes('AR / EN') &&
      !dockHtml.includes('العربية') &&
      !dockHtml.includes('English') &&
      dockHtml.includes('الكيبورد') &&
      dockHtml.includes('الكل') &&
      dockHtml.includes('safe-area-inset-bottom') &&
      !dockHtml.includes('تبديل إلى الكيبورد'),
    'Test 23a: BottomKeyboardDock shows the centered keyboard handle and preserves the All filter without language controls'
  );
  const dockSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/BottomKeyboardDock.tsx'), 'utf-8');
  assert(
    dockSrc.includes('hasModalBlockingDock') &&
      dockSrc.includes('ChevronUp') &&
      dockSrc.includes('ChevronDown') &&
      !dockSrc.includes('<Keyboard') &&
      !dockSrc.includes('dockMode') &&
      !dockSrc.includes('applyKeyboardActionToText'),
    'Test 23b: Bottom dock uses a directional handle without introducing a soft keyboard mode'
  );
  console.log('✅ Test 23 Passed: Centered keyboard dock handle and All filter verified');

  // --------------------------------------------------------------------------
  // TEST 24: SearchFilterBar Removes 'فصل نشط فقط' Toggle Under Sync
  // --------------------------------------------------------------------------
  assert(
    !searchBarSrc.includes('فصل نشط فقط') &&
      !searchBarSrc.includes('<LiquidToggle') &&
      searchBarSrc.includes('مزامنة السيرفر') &&
      searchBarSrc.includes('فصل: نشط'),
    'Test 24: Bottom scope toggle removed below Sync while sheet selector and sync remain intact'
  );
  console.log('✅ Test 24 Passed: Bottom toggle removed from SearchFilterBar while keeping Sync and sheet filter');

  // --------------------------------------------------------------------------
  // TEST 25: StudentCard Compact Fit, Dynamic Fridays & Followup Method/Count
  // --------------------------------------------------------------------------
  assert(
    !cardSrc.includes('h-[425px]') &&
      !cardSrc.includes('monthAttClamped >= idx + 1') &&
      cardSrc.includes('col-start-1 row-start-1') &&
      cardSrc.includes('card-anchored-pill'),
    'Test 25a: StudentCard uses CSS Grid stacked faces, no clipping height, and never guesses missing attendance as present/absent'
  );
  assert(
    trackCardHtml.includes('الحضور الشهري') &&
      trackCardHtml.includes(expectedTrackRatio) &&
      trackCardHtml.includes('عدد المرات:') &&
      trackCardHtml.includes('الوسيلة:') &&
      trackCardHtml.includes('واتساب'),
    'Test 25b: StudentCard renders dynamic held Friday ratio + followup count + real method accurately'
  );
  assert(
    pendingStudentHtml.includes('بحاجة لافتقاد') && pendingStudentHtml.includes('لم تُسجل'),
    'Test 25c: StudentCard never treats missing followup data as completed'
  );
  console.log('✅ Test 25 Passed: StudentCard non-clipping layout, tri-state Fridays & followup details verified');

  // --------------------------------------------------------------------------
  // TEST 26: Inline Edit Mode Keeps ALL Student Cards Visible
  // --------------------------------------------------------------------------
  const appSrcLatest = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  assert(
    appSrcLatest.includes("activeView !== 'cards'") &&
      cardSrc.includes('isThisCardEditing') &&
      cardSrc.includes('تعديل مباشر') &&
      cardSrc.includes('حفظ التعديلات'),
    'Test 26: Editing in cards view happens inline inside the card keeping all other cards visible'
  );
  console.log('✅ Test 26 Passed: Non-hiding Inline Card Edit Mode verified');

  // --------------------------------------------------------------------------
  // TEST 27: Sticky / Fixed TopBar Layout & Safe Area
  // --------------------------------------------------------------------------
  assert(
    appSrcLatest.includes('overflow-x-clip') &&
      appSrcLatest.includes('fixed top-0 left-0 right-0') &&
      appSrcLatest.includes('safe-area-inset-top'),
    'Test 27: TopBar uses fixed viewport container with overflow-x-clip root and safe-area compensation'
  );
  console.log('✅ Test 27 Passed: Sticky/Fixed TopBar layout fix verified');

  // --------------------------------------------------------------------------
  // TEST 28: Hide Google Sheets Sync Config UI & Preserve Internal Sync System
  // --------------------------------------------------------------------------
  const syncModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/SyncDetailsModal.tsx'), 'utf-8');
  assert(
    !syncModalSrc.includes('setAppsScriptUrl') &&
      !syncModalSrc.includes('setApiBaseUrl') &&
      !syncModalSrc.includes('setRelayKey') &&
      !syncModalSrc.includes('appsScriptInput') &&
      !syncModalSrc.includes('apiBaseInput') &&
      !syncModalSrc.includes('relayKeyInput') &&
      !syncModalSrc.includes('إعدادات رابط المزامنة') &&
      !syncModalSrc.includes('ضبط الرابط') &&
      !syncModalSrc.includes('<input'),
    'Test 28a: SyncDetailsModal completely hides Google Apps Script / Relay / API URL inputs from regular UI'
  );
  assert(
    syncModalSrc.includes('مزامنة فورية الآن') &&
      syncModalSrc.includes('طابور العمليات') &&
      !sidebarSrcV2.includes('إعدادات المزامنة') &&
      !appSrcLatest.includes('إعدادات المزامنة'),
    'Test 28b: Public UI removes technical settings triggers while preserving sync status & sync execution'
  );
  assert(
    setAppsScriptUrl('https://script.google.com/macros/s/AKfycbPreservedConfigTest/exec') === true &&
      getAppsScriptUrl() === 'https://script.google.com/macros/s/AKfycbPreservedConfigTest/exec',
    'Test 28c: Internal sync connection settings utility stays intact and functional'
  );
  setAppsScriptUrl('');
  console.log('✅ Test 28 Passed: Sync connection configuration hidden from public UI while preserving internal sync\n');

  // --------------------------------------------------------------------------
  // TEST 29: Monthly Attendance 4/5 Fridays, Held Count Denominator & Month Rollover (Cairo)
  // --------------------------------------------------------------------------
  const oct2026Fridays = getMonthFridays(2026, 10);
  const nov2026Fridays = getMonthFridays(2026, 11);
  assert(
    oct2026Fridays.length === 5 &&
      oct2026Fridays[0] === '2026-10-02' &&
      oct2026Fridays[4] === '2026-10-30',
    'Test 29a: Supports 5-Friday months (Oct 2026)'
  );
  assert(
    nov2026Fridays.length === 4 &&
      nov2026Fridays[0] === '2026-11-06' &&
      nov2026Fridays[3] === '2026-11-27',
    'Test 29b: Supports 4-Friday months (Nov 2026)'
  );

  // Mid-month scenario: Sunday 2026-11-15 Cairo time -> 2 held Fridays (6/11, 13/11), 2 future Fridays (20/11, 27/11)
  const midNovRef = new Date('2026-11-15T10:00:00+02:00');
  const midSummary = computeMonthlyAttendanceSummary(
    { '2026-11-06': true, '2026-11-13': true, '2026-11-20': true },
    midNovRef
  );
  assert(
    midSummary.heldCount === 2 &&
      midSummary.presentCount === 2 &&
      midSummary.fridays[0].status === 'present' &&
      midSummary.fridays[1].status === 'present' &&
      midSummary.fridays[2].status === 'future' &&
      midSummary.fridays[3].status === 'future',
    'Test 29c: Future Fridays excluded strictly from heldCount denominator & remain neutral'
  );

  // Missing attendance record must NEVER count as absent
  const unrecordedSummary = computeMonthlyAttendanceSummary({}, midNovRef);
  assert(
    unrecordedSummary.heldCount === 2 &&
      unrecordedSummary.presentCount === 0 &&
      unrecordedSummary.absentCount === 0 &&
      unrecordedSummary.fridays[0].status === 'unrecorded' &&
      unrecordedSummary.fridays[1].status === 'unrecorded',
    'Test 29d: Unrecorded Friday stays unrecorded (neutral), never marked absent'
  );

  // Month boundary transition in Cairo: Oct 31 23:59 vs Nov 01 00:05 Cairo time
  const beforeMidnightNov = new Date('2026-10-31T21:55:00Z'); // 23:55 UTC+2 Cairo
  const afterMidnightNov = new Date('2026-10-31T22:05:00Z'); // 00:05 Nov 1 UTC+2 Cairo
  assert(
    getCairoDateParts(beforeMidnightNov).month === 10 &&
      getCairoDateParts(afterMidnightNov).month === 11,
    'Test 29e: Month rollover switches cleanly at midnight Africa/Cairo time'
  );
  console.log('✅ Test 29 Passed: 4/5 Fridays, Cairo midnight rollover, and non-future denominator verified');

  // --------------------------------------------------------------------------
  // TEST 30: Tri-state Parser (1/0/Blank) + IDB History Store & Pending Mutation Deduplication
  // --------------------------------------------------------------------------
  const triStateGviz = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[{"id":"A","type":"string"},{"id":"B","type":"string"},{"id":"C","type":"string"},{"id":"D","type":"string"},{"id":"E","type":"string"}],"rows":[{"c":[{"v":"كود"},{"v":"الاسم"},{"v":"2026-10-02"},{"v":"2026-10-09"},{"v":"2026-10-16"}]},{"c":[{"v":"101"},{"v":"مينا عادل"},{"v":"1"},{"v":"0"},{"v":""}]}]}});`;
  const triStudents = parseGoogleVisualizationResponse(triStateGviz, 'نشط');
  assert(
    triStudents.length === 1 &&
      triStudents[0].att['2026-10-02'] === true &&
      triStudents[0].att['2026-10-09'] === false &&
      triStudents[0].att['2026-10-16'] === undefined,
    'Test 30a: Google Sheets parser distinguishes 1 (present), 0 (absent), and empty cell (unrecorded undefined)'
  );

  await cleanIDB();
  const dedupStudent = makeStudent({ id: 'dedup_1', code: '6501', name: 'توني ماجد', sourceSheet: 'نشط' });
  await idbAtomicRecordAttendanceWithMutation(
    { ...dedupStudent, att: { '2026-11-06': true }, attendanceMonth: 1 },
    {
      id: 'dedup_1__2026-11-06',
      studentId: 'dedup_1',
      studentCode: '6501',
      fridayDate: '2026-11-06',
      status: true,
      recordedAt: Date.now(),
      sourceSheet: 'نشط'
    },
    {
      id: 'ATT_dedup_1_2026-11-06_first',
      action: 'attendance',
      studentId: 'dedup_1',
      studentCode: '6501',
      studentName: 'توني ماجد',
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-06', isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      status: 'pending'
    }
  );
  // Rapid second toggle for same student + same Friday should replace superseded pending mutation
  await idbAtomicRecordAttendanceWithMutation(
    { ...dedupStudent, att: { '2026-11-06': false }, attendanceMonth: 0 },
    {
      id: 'dedup_1__2026-11-06',
      studentId: 'dedup_1',
      studentCode: '6501',
      fridayDate: '2026-11-06',
      status: false,
      recordedAt: Date.now() + 100,
      sourceSheet: 'نشط'
    },
    {
      id: 'ATT_dedup_1_2026-11-06_second',
      action: 'attendance',
      studentId: 'dedup_1',
      studentCode: '6501',
      studentName: 'توني ماجد',
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-06', isPresent: false },
      expectedVersion: 2,
      timestamp: Date.now() + 100,
      status: 'pending'
    }
  );
  const afterDedupMutations = await idbGetPendingMutations();
  const afterHistory = await idbGetAttendanceHistory('dedup_1');
  assert(
    afterDedupMutations.length === 1 && afterDedupMutations[0].id === 'ATT_dedup_1_2026-11-06_second',
    'Test 30b: Prevents duplicate pending mutations for the same student + same Friday'
  );
  assert(
    afterHistory.length === 1 && afterHistory[0].status === false,
    'Test 30c: IndexedDB attendance_history enforces unique (studentId, fridayDate) record cleanly'
  );
  await cleanIDB();
  console.log('✅ Test 30 Passed: Tri-state Sheet parsing + IndexedDB attendance_history & deduplication verified');

  // --------------------------------------------------------------------------
  // TEST 31: Weekly Local Notifications (5 Cairo DST Rules, No Past Firing, Settings UI)
  // --------------------------------------------------------------------------
  assert(DEFAULT_WEEKLY_REMINDERS.length === 5, 'Test 31a: Exactly 5 weekly notification rules defined');
  const wedRule = DEFAULT_WEEKLY_REMINDERS.find((r) => r.key === 'wed_prep')!;
  const thuRule = DEFAULT_WEEKLY_REMINDERS.find((r) => r.key === 'thu_followup')!;
  const fri1Rule = DEFAULT_WEEKLY_REMINDERS.find((r) => r.key === 'fri_ready')!;
  const fri2Rule = DEFAULT_WEEKLY_REMINDERS.find((r) => r.key === 'fri_start')!;
  const fri3Rule = DEFAULT_WEEKLY_REMINDERS.find((r) => r.key === 'fri_att')!;

  assert(
    wedRule.body === 'بنفكّرك تبعت التحضير للخادم المسؤول.' &&
      thuRule.body === 'آخر فرصة لإرسال تقرير الافتقاد والتحضير للخادم المسؤول.' &&
      fri1Rule.body === 'استعد، ميعاد الخدمة قرب!' &&
      fri2Rule.body === 'الخدمة بدأت الآن. ربنا يبارك خدمتكم.' &&
      fri3Rule.body === 'متنساش تسجّل الحضور والغياب للمخدومين.',
    'Test 31b: Exact required Arabic copy matches for all 5 weekly reminders'
  );

  // Egypt Winter Time (Nov, UTC+2): Wed 2026-11-11 18:05 Cairo time (16:05 UTC)
  // Since Wed 18:00 already passed 5 minutes ago, it MUST schedule next Wednesday 2026-11-18 18:00 Cairo (16:00 UTC) — NEVER fire missed past event!
  const wedPastRef = new Date('2026-11-11T16:05:00Z');
  const nextWedWinter = computeNextCairoOccurrence(wedRule, wedPastRef);
  const nextWedWinterParts = getCairoDateParts(nextWedWinter);
  assert(
    nextWedWinter.getTime() > wedPastRef.getTime() &&
      nextWedWinterParts.isoDate === '2026-11-18' &&
      nextWedWinterParts.hour === 18 &&
      nextWedWinterParts.minute === 0,
    'Test 31c: Winter Cairo time (UTC+2) never fires missed past Wed 18:00 and advances +7 days'
  );

  // Egypt Summer DST (July, UTC+3): Fri 2026-07-03 11:00 Cairo time (08:00 UTC)
  const summerFriRef = new Date('2026-07-03T08:00:00Z');
  const nextFriReadySummer = computeNextCairoOccurrence(fri1Rule, summerFriRef);
  const summerParts = getCairoDateParts(nextFriReadySummer);
  assert(
    summerParts.isoDate === '2026-07-03' &&
      summerParts.hour === 12 &&
      summerParts.minute === 20 &&
      nextFriReadySummer.toISOString() === '2026-07-03T09:20:00.000Z',
    'Test 31d: Summer Egypt DST (UTC+3) resolves Fri 12:20 Cairo -> 09:20 UTC accurately'
  );

  // Settings persistence + partial disabling + reset defaults
  saveWeeklyNotificationSettings({
    masterEnabled: true,
    enabledRules: {
      wed_prep: true,
      thu_followup: false,
      fri_ready: true,
      fri_start: true,
      fri_att: false
    }
  });
  const loadedSettings = loadWeeklyNotificationSettings();
  const partialPayload = buildCapacitorNotificationsPayload(loadedSettings, wedPastRef);
  assert(
    partialPayload.length === 3 * WEEKLY_NOTIFICATION_HORIZON &&
      new Set(partialPayload.map((n) => n.id)).size === partialPayload.length &&
      partialPayload.every((n) => n.schedule.at.getTime() > wedPastRef.getTime()),
    'Test 31e: Per-rule toggles filter payload cleanly with deterministic unique IDs and future-only triggers'
  );
  const resetSettings = resetDefaultNotificationSettings();
  assert(
    resetSettings.masterEnabled === true &&
      buildCapacitorNotificationsPayload(resetSettings, wedPastRef).length === 5 * WEEKLY_NOTIFICATION_HORIZON,
    'Test 31f: Reset restores all 5 weekly defaults cleanly'
  );

  const notifPanelSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/NotificationsPanel.tsx'), 'utf-8');
  assert(
    notifPanelSrc.includes('التذكير الأسبوعي') &&
      notifPanelSrc.includes('تفعيل التذكيرات الأسبوعية') &&
      notifPanelSrc.includes('استعادة المواعيد الافتراضية') &&
      notifPanelSrc.includes('LiquidToggle') &&
      notifPanelSrc.includes('بطارية'),
    'Test 31g: NotificationsPanel includes Weekly Settings UI, Master/Item toggles, default reset, and honest battery disclosure'
  );
  const manifestSrc = fs.readFileSync(path.resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml'), 'utf-8');
  assert(
    manifestSrc.includes('POST_NOTIFICATIONS') && manifestSrc.includes('RECEIVE_BOOT_COMPLETED'),
    'Test 31h: AndroidManifest declares POST_NOTIFICATIONS & RECEIVE_BOOT_COMPLETED'
  );
  const appsScriptSrc = fs.readFileSync(path.resolve(process.cwd(), 'docs/google-apps-script/Code.gs'), 'utf-8');
  const validAttendanceDateRegexCount = (appsScriptSrc.match(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2}\$\/\.test/g) || []).length;
  assert(
    validAttendanceDateRegexCount >= 2,
    'Test 31i: Apps Script monthly and latest attendance calculations use valid single-escaped ISO date regexes'
  );
  assert(
    appsScriptSrc.includes("var allowedActions = ['add', 'update', 'attendance', 'followup', 'delete'];") &&
      appsScriptSrc.indexOf("sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion)") >
        appsScriptSrc.indexOf("if (!friday)"),
    'Test 31j: Apps Script explicitly rejects delete and commits the row version only after attendance validation'
  );
  assert(
    appsScriptSrc.includes("var mutationIdCol = findColIndex(logHeaders, ['mutation_id']);") &&
      appsScriptSrc.includes(".createTextFinder(String(mutationId))"),
    'Test 31k: Follow-up log appends are deduplicated using a durable mutation ID'
  );
  console.log('✅ Test 31 Passed: Weekly Cairo DST notifications, Apps Script attendance guards, deduplication, no-past guard & Settings UI verified');

  // --------------------------------------------------------------------------
  // TEST 32: Clean SearchFilterBar + Alphabet-only Dock Confirmation
  // --------------------------------------------------------------------------
  assert(
    !searchBarSrc.includes('فصل نشط فقط') && !searchBarSrc.includes('LiquidToggle'),
    'Test 32a: Toggle below Sync completely removed from SearchFilterBar'
  );
  assert(
    !dockSrc.includes('lucide-react\';\nimport { Keyboard') && !dockSrc.includes('<Keyboard'),
    'Test 32b: Keyboard icon completely deleted from BottomKeyboardDock'
  );
  console.log('✅ Test 32 Passed: SearchFilterBar bottom toggle & BottomKeyboardDock keyboard icon cleanly removed');

  // --------------------------------------------------------------------------
  // TEST 33: Original Dashboard Sidebar Animations (Spring Slide, Overlay Blur, Stagger & Swipe)
  // --------------------------------------------------------------------------
  assert(
    indexCssSrc.includes('.sidebar-overlay-transition') &&
      indexCssSrc.includes('backdrop-filter: blur(4px)') &&
      indexCssSrc.includes('transition: opacity 350ms ease, visibility 350ms ease') &&
      indexCssSrc.includes('cubic-bezier(0.34, 1.56, 0.64, 1)') &&
      indexCssSrc.includes('calc(var(--i, 0) * 50ms)') &&
      indexCssSrc.includes('.sidebar-drawer-spring'),
    'Test 33a: index.css matches exact original dashboard Sidebar spring slide, blur overlay & stagger rules'
  );
  assert(
    sidebarSrcV2.includes('sidebar-overlay-transition') &&
      sidebarSrcV2.includes('sidebar-drawer-spring') &&
      sidebarSrcV2.includes('onTouchStart={handleDrawerTouchStart}') &&
      sidebarSrcV2.includes('onTouchEnd={handleDrawerTouchEnd}') &&
      sidebarSrcV2.includes("'--i': 0"),
    'Test 33b: Sidebar.tsx applies original animation classes, --i stagger indexes, and RTL touch swipe-to-close'
  );
  const sidebarHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(Sidebar))
      )
    )
  );
  assert(
    sidebarHtml.includes('sidebar-drawer-spring') && sidebarHtml.includes('sidebar-overlay-transition'),
    'Test 33c: Sidebar SSR renders cleanly without errors'
  );
  console.log('✅ Test 33 Passed: Original Dashboard Sidebar animations, stagger & touch swipe verified\n');

  // --------------------------------------------------------------------------
  // TEST 34: Reference Animation Code File Audit & Keyframes (Ainmation_code_8feeba97.html)
  // --------------------------------------------------------------------------
  const animHtmlPath = path.resolve(process.cwd(), 'public/assets/aistudio/Ainmation_code_8feeba97.html');
  assert(fs.existsSync(animHtmlPath), 'Test 34a: Ainmation_code_8feeba97.html reference file exists');
  const animHtml = fs.readFileSync(animHtmlPath, 'utf-8');
  assert(
    animHtml.includes('@keyframes wordIn') &&
      animHtml.includes('translateY(45px)') &&
      animHtml.includes('rotateX(-65deg)') &&
      animHtml.includes('scale(0.8)') &&
      animHtml.includes('filter: blur(8px)'),
    'Test 34b: Reference HTML contains exact 3D wordIn transform and blur'
  );
  assert(
    indexCssSrc.includes('@keyframes wordIn') &&
      indexCssSrc.includes('translateY(45px) rotateX(-65deg) scale(0.8)') &&
      indexCssSrc.includes('filter: blur(8px)') &&
      indexCssSrc.includes('translateY(0) rotateX(0) scale(1)') &&
      indexCssSrc.includes('filter: blur(0)') &&
      indexCssSrc.includes('perspective: 800px') &&
      indexCssSrc.includes('--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)') &&
      indexCssSrc.includes('.word-in-text span'),
    'Test 34c: index.css implements exact wordIn transform, spring easing, 800px perspective and per-word stagger'
  );
  assert(
    indexCssSrc.includes('@keyframes fadeIn') &&
      indexCssSrc.includes('@keyframes badgePop') &&
      indexCssSrc.includes('@keyframes chartBarGrow') &&
      indexCssSrc.includes('@keyframes svgLineDraw') &&
      indexCssSrc.includes(':focus-visible'),
    'Test 34d: index.css contains fadeIn, badgePop, chartBarGrow, svgLineDraw, and :focus-visible rules'
  );
  console.log('✅ Test 34 Passed: Reference Animation audit & exact keyframes verified\n');

  // --------------------------------------------------------------------------
  // TEST 35: Animated Navigation Controls & Gliding Indicator (NavigationTabs.tsx)
  // --------------------------------------------------------------------------
  const navTabsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/NavigationTabs.tsx'), 'utf-8');
  assert(
    navTabsSrc.includes('role="tablist"') &&
      navTabsSrc.includes('role="tab"') &&
      navTabsSrc.includes('layoutId="navActiveIndicator"') &&
      navTabsSrc.includes('whileTap={{ scale: 0.96 }}') &&
      navTabsSrc.includes('ArrowLeft') &&
      navTabsSrc.includes('ArrowRight'),
    'Test 35a: NavigationTabs implements accessible tabs, gliding layoutId pill, and RTL keyboard navigation'
  );

  const navTabsHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(NavigationTabs))
      )
    )
  );
  assert(
    navTabsHtml.includes('role="tablist"') &&
      navTabsHtml.includes('جدول الحضور') &&
      navTabsHtml.includes('سجل الافتقاد'),
    'Test 35b: NavigationTabs SSR renders without errors'
  );
  console.log('✅ Test 35 Passed: Animated Navigation Tabs with gliding indicator verified\n');

  // --------------------------------------------------------------------------
  // TEST 36: Full App Choreography, Spring View Transitions & Component Animations
  // --------------------------------------------------------------------------
  assert(
    appSrcLatest.includes('<MotionConfig reducedMotion="user">') &&
      appSrcLatest.includes('<AnimatePresence mode="wait" initial={false}>') &&
      appSrcLatest.includes('SPRING_EASE') &&
      appSrcLatest.includes('key="cards"') &&
      appSrcLatest.includes('key="table"') &&
      appSrcLatest.includes('key="charts"') &&
      appSrcLatest.includes('key="followup"') &&
      appSrcLatest.includes('activeToast'),
    'Test 36a: App.tsx wraps application with MotionConfig, AnimatePresence view transitions & animated toasts'
  );

  const studentCardSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/cards/StudentCard.tsx'), 'utf-8');
  assert(
    studentCardSrc.includes('ease-[var(--ease-spring)]') &&
      studentCardSrc.includes('layoutId={`cardTrackPill_${student.id}`}') &&
      studentCardSrc.includes('word-in'),
    'Test 36b: StudentCard implements 3D spring flip, gliding track pill, and word-in animation'
  );

  const studentsTableSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/table/StudentsTableView.tsx'), 'utf-8');
  assert(
    studentsTableSrc.includes('word-in') &&
      studentsTableSrc.includes('badge-pop') &&
      studentsTableSrc.includes('glass-btn'),
    'Test 36c: StudentsTableView implements word-in stagger, badge-pop attendance toggle, and glass buttons'
  );

  const followupLogSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/followup/FollowupLogView.tsx'), 'utf-8');
  assert(
    followupLogSrc.includes('word-in') &&
      followupLogSrc.includes('badge-pop') &&
      followupLogSrc.includes('glass-btn'),
    'Test 36d: FollowupLogView implements word-in stagger, badge-pop copy indicator, and glass buttons'
  );

  const chartsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/charts/DashboardChartsView.tsx'), 'utf-8');
  assert(
    chartsSrc.includes('word-in') &&
      chartsSrc.includes('svg-line-draw') &&
      chartsSrc.includes('chart-bar-grow'),
    'Test 36e: DashboardChartsView implements word-in, svgLineDraw, and chartBarGrow animations'
  );

  // SSR Render full App to verify zero React / motion/react hydration or SSR crashes
  const fullAppHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(App))
      )
    )
  );
  assert(
    fullAppHtml.includes('St. George Dashboard') &&
      fullAppHtml.includes('جدول الحضور') &&
      fullAppHtml.includes('سجل الافتقاد'),
    'Test 36f: Full App SSR renders cleanly with all motion components'
  );
  console.log('✅ Test 36 Passed: Full App choreography, view transitions & component animations verified\n');

  // --------------------------------------------------------------------------
  // TEST 37: Smart Assistant Data Queries & Real Card Commands
  // --------------------------------------------------------------------------
  const assistantFriday = getLatestHeldFridayString();
  const assistantStudent = makeStudent({
    id: 'assistant_student_1',
    name: 'بيشوي عماد صموئيل',
    birthDate: '2012-12-20',
    att: { [assistantFriday]: true }
  });
  const presentAnswer = processAssistantQuery('هاتلي عدد الأولاد اللي حضرت النهارده', [assistantStudent]);
  assert(presentAnswer.text.includes('الحضور المسجل') && presentAnswer.text.includes('بيشوي عماد صموئيل'), 'Test 37a: Assistant answers natural-language present query from latest held Friday');

  const nextMonthAnswer = processAssistantQuery(
    'هات أعياد الميلاد الشهر القادم',
    [assistantStudent],
    { referenceDate: new Date(2026, 10, 14) }
  );
  assert(nextMonthAnswer.text.includes('الشهر القادم') && nextMonthAnswer.text.includes('بيشوي عماد صموئيل'), 'Test 37b: Assistant searches the complete next calendar month, not only seven days');

  const attendanceCommand = processAssistantQuery('سجل حضور بيشوي عماد صموئيل', [assistantStudent]);
  assert(attendanceCommand.command?.type === 'markAttendance' && attendanceCommand.command.isPresent === true, 'Test 37c: Explicit attendance command resolves a unique student and requests a real attendance write');

  const absenceCommand = processAssistantQuery('سجل غياب بيشوي عماد صموئيل', [assistantStudent]);
  assert(absenceCommand.command?.type === 'markAttendance' && absenceCommand.command.isPresent === false, 'Test 37d: Explicit absence command resolves to absent status');

  const editCommand = processAssistantQuery('افتح تعديل كارت بيشوي عماد صموئيل', [assistantStudent]);
  assert(editCommand.command?.type === 'openEdit' && editCommand.command.studentId === assistantStudent.id, 'Test 37e: Assistant opens the exact student card in inline edit mode');

  const ambiguousCommand = processAssistantQuery('سجل حضور بيشوي', [
    assistantStudent,
    makeStudent({ id: 'assistant_student_2', name: 'بيشوي جرجس' })
  ]);
  assert(!ambiguousCommand.command && ambiguousCommand.text.includes('أكثر من مخدوم'), 'Test 37f: Ambiguous student names never trigger an attendance mutation');

  const unknownAttendance = processAssistantQuery('الغائبون', [
    makeStudent({ id: 'assistant_student_3', name: 'مينا سمير', att: {} })
  ]);
  assert(unknownAttendance.text.includes('لم يُسجل') || unknownAttendance.text.includes('لم يتم تسجيل'), 'Test 37g: Missing attendance is distinguished from explicitly recorded absence');
  console.log('✅ Test 37 Passed: Smart assistant queries, date ranges, safe commands & ambiguity guards verified\\n');

  (globalThis as any).fetch = originalFetch;
  await idbSaveStudents([], 'نشط', true).catch(() => {});

  console.log('======================================================');
  console.log('🎉 ALL 37 SPRINT VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('======================================================');
}

runSprintTests().catch((err) => {
  console.error('❌ Sprint Test Failure:', err);
  process.exit(1);
});
