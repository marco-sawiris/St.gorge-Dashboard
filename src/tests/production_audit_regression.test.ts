import fs from 'fs';
import path from 'path';
import assert from 'assert';
import React from 'react';
import { renderToString } from 'react-dom/server';
import 'fake-indexeddb/auto';

import {
  extractDynamicAlphabetBuckets,
  formatTelHref,
  formatWhatsAppUrl,
  getLatestHeldFridayString,
  getNearestFridayString,
  normalizeArabicInitial
} from '../utils/arabicUtils';
import { buildCsvContent } from '../utils/exportUtils';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import {
  AppProvider,
  executeProcessOfflineQueue,
  filterStudentsByAppFilters,
  getAvailableAlphabetBuckets,
  resolveValidAlphabetFilter
} from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';
import { Sidebar } from '../components/layout/Sidebar';
import { NotificationsPanel } from '../components/modals/NotificationsPanel';
import { AboutModal } from '../components/modals/AboutModal';
import { AppearanceModal } from '../components/modals/AppearanceModal';
import { BottomKeyboardDock } from '../components/layout/BottomKeyboardDock';
import { processAssistantQuery, detectAssistantIntent } from '../services/assistantEngine';
import { AppFilterState, Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { idbQueueMutation, idbGetPendingMutations } from '../services/indexedDbService';

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf-8');
}

async function runTests() {
  console.log('=== Running Production Readiness Audit Regression Tests ===\n');

  // 1. googleSheetsService regex & formula sanitization
  const gsServiceSrc = readProjectFile('server/services/googleSheetsService.ts');
  assert(!gsServiceSrc.includes('/^\\\\d{4}-\\\\d{2}-\\\\d{2}$/'), 'Double-escaped Friday regex removed');
  assert(!gsServiceSrc.includes('/^افتقاد\\\\s+'), 'Double-escaped followup regex removed');
  assert(gsServiceSrc.includes('/^\\d{4}-\\d{2}-\\d{2}$/'), 'Valid Friday date regex present');
  assert(gsServiceSrc.includes('/^افتقاد\\s+(\\d{4}-\\d{2}-\\d{2})$/'), 'Valid followup header regex present');
  assert(gsServiceSrc.includes('sanitizeSheetCell'), 'Formula injection guard present in GoogleSheetsService');
  console.log('✅ Test 1 Passed: GoogleSheetsService regexes & formula injection protection verified.');

  // 2. Code.gs APPROVED_SHEETS guard in doPost, ES5 safety & formula escaping
  const codeGsSrc = readProjectFile('docs/google-apps-script/Code.gs');
  assert(codeGsSrc.includes('APPROVED_SHEETS.indexOf(targetSheetName) === -1'), 'Code.gs doPost enforces APPROVED_SHEETS allowlist');
  assert(!codeGsSrc.includes('?.'), 'Code.gs uses ES5-compatible property checks without optional chaining');
  assert(codeGsSrc.includes('function sanitizeFormulaValue'), 'Code.gs sanitizes spreadsheet formula prefixes');
  console.log('✅ Test 2 Passed: Code.gs allowlist, ES5 compatibility & formula neutralization verified.');

  // 3. StudentsTableView & DashboardChartsView & FollowupLogView Friday alignment + click guard
  const tableSrc = readProjectFile('src/components/table/StudentsTableView.tsx');
  const chartsSrc = readProjectFile('src/components/charts/DashboardChartsView.tsx');
  const followupSrc = readProjectFile('src/components/followup/FollowupLogView.tsx');
  assert(!tableSrc.includes('getNearestFridayString'), 'StudentsTableView no longer uses future Friday for attendance');
  assert(tableSrc.includes('getLatestHeldFridayString'), 'StudentsTableView uses getLatestHeldFridayString');
  assert(tableSrc.includes('inFlightStudentIds'), 'StudentsTableView guards rapid attendance clicks with inFlightStudentIds');
  assert(!chartsSrc.includes('getNearestFridayString'), 'DashboardChartsView no longer uses future Friday for attendance');
  assert(chartsSrc.includes('getLatestHeldFridayString'), 'DashboardChartsView uses getLatestHeldFridayString');
  assert(followupSrc.includes('getLatestHeldFridayString'), 'FollowupLogView uses getLatestHeldFridayString for attendance summary');
  console.log('✅ Test 3 Passed: Attendance Friday source-of-truth unified across all views (' + getLatestHeldFridayString() + ').');

  // 4. CSV Formula Injection Protection
  const csv = buildCsvContent(
    ['الاسم', 'ملاحظات'],
    [
      ['=CMD|"/C calc"!A0', '-'],
      ['+1+1', '@SUM(A1:A5)'],
      ['\tInjected', 'مارك']
    ]
  );
  assert(csv.includes('"\'=CMD|""/C calc""!A0"'), 'Leading = neutralized in CSV');
  assert(csv.includes('"-"'), 'Standalone dash placeholder preserved cleanly');
  assert(csv.includes('"\'+1+1"'), 'Leading + neutralized in CSV');
  assert(csv.includes('"\'@SUM(A1:A5)"'), 'Leading @ neutralized in CSV');
  assert(csv.includes('"\'\tInjected"'), 'Leading tab neutralized in CSV');
  console.log('✅ Test 4 Passed: CSV formula injection protection verified.');

  // 5. Phone & WhatsApp URL Normalization + XSS Blocking
  assert.strictEqual(formatTelHref('javascript:alert(1)'), null, 'Malicious tel scheme blocked');
  assert.strictEqual(formatTelHref('٠١٠١٢٣٤٥٦٧٨'), 'tel:01012345678', 'Arabic-Indic phone normalized for tel:');
  assert.strictEqual(formatWhatsAppUrl('01012345678'), 'https://wa.me/201012345678', 'Local Egyptian phone formatted correctly');
  assert.strictEqual(formatWhatsAppUrl('201234567890'), 'https://wa.me/201234567890', 'International 20... phone avoids double prefix 220...');
  assert.strictEqual(formatWhatsAppUrl('1012345678'), 'https://wa.me/201012345678', '10-digit Egyptian mobile prefixed with 20');
  assert.strictEqual(formatWhatsAppUrl('javascript:alert(1)'), null, 'Invalid phone returns null WhatsApp URL');
  console.log('✅ Test 5 Passed: Phone & WhatsApp normalization and XSS scheme blocking verified.');

  // 6. ErrorBoundary SSR & Fallback State
  const okHtml = renderToString(React.createElement(ErrorBoundary, null, React.createElement('div', null, 'SafeChild')));
  assert(okHtml.includes('SafeChild'), 'ErrorBoundary renders normal children cleanly');
  const errState = ErrorBoundary.getDerivedStateFromError(new Error('Test UI Error'));
  assert.strictEqual(errState.hasError, true);
  assert.strictEqual(errState.errorMessage, 'Test UI Error');
  const boundaryInstance = new ErrorBoundary({ children: null });
  boundaryInstance.state = errState;
  const fallbackHtml = renderToString(boundaryInstance.render() as React.ReactElement);
  assert(fallbackHtml.includes('IndexedDB'), 'ErrorBoundary reassures users IndexedDB data is intact');
  assert(fallbackHtml.includes('إعادة المحاولة'), 'ErrorBoundary displays Arabic recovery actions');
  console.log('✅ Test 6 Passed: React ErrorBoundary crash recovery verified.');

  // 7. Concurrent Offline Queue Flush Serialization (No Duplicate Sends)
  const storageMap = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear()
  };
  await idbQueueMutation({
    id: 'AUDIT_MUT_CONCURRENT_1',
    action: 'attendance',
    studentId: 'st_audit_1',
    studentCode: 'A1',
    studentName: 'اختبار التزامن',
    sourceSheet: 'نشط',
    payload: { friday: getLatestHeldFridayString(), isPresent: true },
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    status: 'pending'
  });

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    await new Promise((r) => setTimeout(r, 40));
    return new Response(JSON.stringify({ ok: true, status: 200, newVersion: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const [resA, resB] = await Promise.all([
      executeProcessOfflineQueue(null, false),
      executeProcessOfflineQueue(null, false)
    ]);
    assert.strictEqual(fetchCallCount, 1, `Expected 1 serialized HTTP send, got ${fetchCallCount}`);
    assert.strictEqual(resA.sentCount + resB.sentCount, 1, 'Mutation processed cleanly once across concurrent calls');
    const remaining = await idbGetPendingMutations();
    assert.strictEqual(remaining.length, 0, 'Pending queue empty after confirmed send');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✅ Test 7 Passed: Concurrent executeProcessOfflineQueue calls serialize with zero duplicate sends.');

  // 8. Server, JWT, DB Schema, .env.example & Android Security Hardening
  const serverSrc = readProjectFile('server.ts');
  assert(serverSrc.includes("app.set('trust proxy', 1)"), 'Express trust proxy configured');
  assert(serverSrc.includes('X-Content-Type-Options'), 'nosniff security header set');
  assert(serverSrc.includes('X-Frame-Options'), 'DENY frame header set');
  assert(serverSrc.includes('Referrer-Policy'), 'Referrer-Policy header set');

  const jwtSrc = readProjectFile('server/security/jwt.ts');
  assert(jwtSrc.includes('ENV.JWT_EXPIRES_IN') && jwtSrc.includes('ENV.JWT_REFRESH_EXPIRES_IN'), 'JWT reads configured expirations');

  const schemaSql = readProjectFile('server/db/schema.sql');
  const dbIndex = readProjectFile('server/db/index.ts');
  assert(schemaSql.includes('VARCHAR(512) PRIMARY KEY') && dbIndex.includes('VARCHAR(512) PRIMARY KEY'), 'idempotency_keys.key widened to VARCHAR(512)');

  const envExample = readProjectFile('.env.example');
  assert(envExample.includes('VITE_RELAY_KEY=""') && !envExample.includes('st_gorge_secret_token_2026'), '.env.example contains no sample relay secret');

  const manifestXml = readProjectFile('android/app/src/main/AndroidManifest.xml');
  const netSecXml = readProjectFile('android/app/src/main/res/xml/network_security_config.xml');
  assert(manifestXml.includes('android:allowBackup="false"'), 'AndroidManifest disables ADB backup');
  assert(manifestXml.includes('android:usesCleartextTraffic="false"'), 'AndroidManifest disables cleartext traffic');
  assert(manifestXml.includes('@xml/network_security_config'), 'AndroidManifest binds network_security_config');
  assert(netSecXml.includes('cleartextTrafficPermitted="false"'), 'network_security_config forbids cleartext HTTP');
  console.log('✅ Test 8 Passed: Backend headers, JWT config, Postgres DDL, .env.example & Android manifest verified.');

  // 9. CI APK Delivery Workflow & Download Route
  const ciYaml = readProjectFile('.github/workflows/ci.yml');
  assert(ciYaml.includes('Final App/StGeorge-Dashboard.apk'), 'CI delivers APK to Final App/StGeorge-Dashboard.apk');
  assert(ciYaml.includes('paths-ignore:') && ciYaml.includes('"Final App/**"'), 'CI ignores Final App/** on push to avoid commit loops');
  assert(ciYaml.includes('[skip ci]') && ciYaml.includes('contents: write'), 'CI has scoped write permission and skip-ci commit guard');
  assert(!ciYaml.includes('git pull --rebase') && !ciYaml.includes('--force'), 'CI updates APK safely on main without force push or rebase conflicts');
  assert(serverSrc.includes('Final App/StGeorge-Dashboard.apk') && serverSrc.includes('/download/StGeorge-Dashboard.apk'), 'Express server exposes Final App/StGeorge-Dashboard.apk via /download/StGeorge-Dashboard.apk');
  console.log('✅ Test 9 Passed: CI APK workflow loop-safety & download route verified.');

  // 10. TopBar St. George + Dashboard Branding & Non-Overlapping SyncStatusIndicator
  const topBarSrc = readProjectFile('src/components/layout/TopBar.tsx');
  const syncIndicatorSrc = readProjectFile('src/components/glass/SyncStatusIndicator.tsx');
  assert(topBarSrc.includes('St. George') && topBarSrc.includes('Dashboard'), 'TopBar displays St. George + Dashboard branding');
  assert(!topBarSrc.includes('>St.Gorge<'), 'Legacy truncated St.Gorge header replaced cleanly');
  assert(topBarSrc.includes('flex flex-col justify-center') && topBarSrc.includes('min-w-0'), 'TopBar separates brand group from action bar');
  assert(syncIndicatorSrc.includes("mobileLabel: 'متصل'") && syncIndicatorSrc.includes('min-h-[36px]'), 'SyncStatusIndicator uses compact responsive status badge so it never overlaps St. George Dashboard');
  console.log('✅ Test 10 Passed: TopBar St. George Dashboard branding & compact SyncStatusIndicator verified.');

  // 11. Notifications One-Time Version Migration, Deduplication & Data Preservation + Android v2.0
  const {
    loadAndMigrateNotifications,
    upsertDeduplicatedNotification,
    saveNotificationsToStorage,
    NOTIFICATIONS_STORAGE_KEY,
    NOTIFICATIONS_MIGRATION_VERSION_KEY,
    CURRENT_NOTIFICATIONS_VERSION
  } = await import('../services/notificationStorageService');
  const { WEEKLY_NOTIFICATION_SETTINGS_KEY } = await import('../services/weeklyNotificationService');

  storageMap.clear();
  storageMap.set(
    NOTIFICATIONS_STORAGE_KEY,
    JSON.stringify([
      { id: 'old_1', title: 'إشعار قديم 1', desc: 'من إصدار سابق', type: 'info', timestamp: 1000, unread: true },
      { id: 'old_2', title: 'إشعار قديم 2', desc: 'من إصدار سابق', type: 'warn', timestamp: 2000, unread: false }
    ])
  );
  storageMap.set(WEEKLY_NOTIFICATION_SETTINGS_KEY, JSON.stringify({ masterEnabled: true, enabledRules: { wed_prep: true } }));

  const firstRun = loadAndMigrateNotifications(1700000000000);
  assert.strictEqual(firstRun.didMigrate, true, 'First launch triggers one-time version migration cleanup');
  assert.strictEqual(firstRun.notifications.length, 0, 'Old notifications cleared on first launch of upgraded version');
  assert.strictEqual(
    storageMap.get(NOTIFICATIONS_MIGRATION_VERSION_KEY),
    CURRENT_NOTIFICATIONS_VERSION,
    'Version migration flag persisted after cleanup'
  );
  assert(storageMap.get(WEEKLY_NOTIFICATION_SETTINGS_KEY)?.includes('masterEnabled'), 'Weekly notification permission/settings preserved across migration');

  let liveList = upsertDeduplicatedNotification(firstRun.notifications, {
    id: 'new_1',
    title: 'تمت المزامنة',
    desc: 'تم تحديث فصل نشط',
    type: 'success',
    timestamp: 1700000001000,
    unread: true
  });
  // Duplicate notification (same content/dedupKey) must NOT create a second item
  liveList = upsertDeduplicatedNotification(liveList, {
    id: 'new_2',
    title: 'تمت المزامنة',
    desc: 'تم تحديث فصل نشط',
    type: 'success',
    timestamp: 1700000002000,
    unread: true
  });
  // Duplicate notification by identical ID must NOT duplicate either
  liveList = upsertDeduplicatedNotification(liveList, {
    id: 'new_2',
    title: 'تنبيه مختلف بنفس المعرف',
    desc: 'اختبار ID deduplication',
    type: 'info',
    timestamp: 1700000003000,
    unread: true
  });
  assert.strictEqual(liveList.length, 1, 'Deduplication prevents duplicate notifications by content and ID');
  saveNotificationsToStorage(liveList);

  const secondRun = loadAndMigrateNotifications(1700000005000);
  assert.strictEqual(secondRun.didMigrate, false, 'Subsequent launch does NOT re-run migration cleanup');
  assert.strictEqual(secondRun.notifications.length, 1, 'New post-upgrade notifications preserved across app restarts');

  const gradleSrc = readProjectFile('android/app/build.gradle');
  assert(gradleSrc.includes('versionCode 2') && gradleSrc.includes('versionName "2.0"'), 'Android build.gradle bumped to versionCode 2 / 2.0');
  console.log('✅ Test 11 Passed: One-time notification cleanup, deduplication, persistence & Android v2.0 verified.');

  // 12. Weekly Reminders Stacked Status UI + Independent AppearanceModal Navigation Routing (Sidebar -> AppearanceModal)
  const notifPanelSrc = readProjectFile('src/components/modals/NotificationsPanel.tsx');
  const sidebarSrc = readProjectFile('src/components/layout/Sidebar.tsx');
  const aboutModalSrc = readProjectFile('src/components/modals/AboutModal.tsx');
  const appearanceModalSrc = readProjectFile('src/components/modals/AppearanceModal.tsx');
  const appTsxSrc = readProjectFile('src/App.tsx');

  assert(
    !notifPanelSrc.includes('ThemeSwitcher') &&
      !notifPanelSrc.includes('مظهر وسمة التطبيق') &&
      !notifPanelSrc.includes('مظهر وسِمة التطبيق'),
    'Appearance & Theme selector completely removed from NotificationsPanel'
  );
  assert(
    !aboutModalSrc.includes('ThemeSwitcher') &&
      !aboutModalSrc.includes('مظهر وسمة التطبيق'),
    'AboutModal completely decoupled from ThemeSwitcher'
  );
  assert(
    notifPanelSrc.includes("flex flex-col items-center justify-center gap-1.5") &&
      notifPanelSrc.includes("settings.masterEnabled ? 'مفعّل' : 'غير مفعّل'") &&
      notifPanelSrc.includes("isRuleEnabled ? 'مفعّل' : 'غير مفعّل'") &&
      notifPanelSrc.includes('text-emerald-600 dark:text-emerald-400') &&
      notifPanelSrc.includes('text-slate-500 dark:text-slate-400'),
    'Weekly Reminders displays green مفعّل / gray غير مفعّل stacked directly above each ON/OFF toggle'
  );
  assert(
    sidebarSrc.includes('مظهر وسمة التطبيق') &&
      sidebarSrc.includes('setIsAppearanceModalOpen(true)') &&
      !sidebarSrc.includes('setIsNotificationsOpen(true)') &&
      sidebarSrc.includes('overflow-y-auto overflow-x-hidden'),
    'Sidebar includes independent مظهر وسمة التطبيق button opening AppearanceModal cleanly and never NotificationsPanel'
  );
  // Ensure Sidebar theme item specifically triggers setIsAppearanceModalOpen(true) and not setIsAboutModalOpen(true)
  const themeBtnMatch = sidebarSrc.match(/onClick=\{\(\)\s*=>\s*\{[\s\S]{0,120}\}\}[\s\S]{0,80}title="مظهر وسمة التطبيق"/);
  assert(
    Boolean(themeBtnMatch) && themeBtnMatch![0].includes('setIsAppearanceModalOpen(true)') && !themeBtnMatch![0].includes('setIsAboutModalOpen(true)'),
    'Sidebar مظهر وسمة التطبيق button is strictly wired to setIsAppearanceModalOpen(true)'
  );
  assert(
    appearanceModalSrc.includes('<ThemeSwitcher />') &&
      appearanceModalSrc.includes('مظهر وسمة التطبيق') &&
      appearanceModalSrc.includes("'dark'") &&
      appearanceModalSrc.includes("'dim'") &&
      appearanceModalSrc.includes("'light'") &&
      appearanceModalSrc.includes('setTheme('),
    'AppearanceModal independently hosts ThemeSwitcher and all 3 themes (dark/dim/light) with setTheme'
  );
  assert(
    appTsxSrc.includes('<AppearanceModal />'),
    'App.tsx mounts independent AppearanceModal'
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
  assert(sidebarHtml.includes('مظهر وسمة التطبيق'), 'Sidebar SSR renders مظهر وسمة التطبيق item');
  const appearanceHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(AppearanceModal))
      )
    )
  );
  assert.strictEqual(appearanceHtml, '', 'AppearanceModal stays closed by default without polluting initial layout');
  void NotificationsPanel;
  void AboutModal;
  console.log('✅ Test 12 Passed: Weekly Reminders stacked UI & independent Sidebar -> AppearanceModal routing verified.');

  // 13. Comprehensive Smart Assistant Intelligence Suite (All 6 Mandatory Prompts + Edge Cases)
  const heldFriday = getLatestHeldFridayString();
  const weekFriday = getNearestFridayString();
  const mkStudent = (overrides: Partial<Student>): Student => ({
    id: 's_default',
    code: 'SG-1',
    name: 'طالب تجريبي',
    servant: 'ماركو',
    area: 'الزيتون',
    address: 'عنوان تجريبي',
    notes: '',
    sourceSheet: 'نشط',
    followupStatus: 'بدون',
    attendanceTotal: 2,
    attendanceMonth: 1,
    attendanceStatus: 'غائب',
    version: 1,
    att: {},
    fu: {},
    ...overrides
  });

  const sPresent1 = mkStudent({ id: 'st_p1', code: 'SG-101', name: 'كيرلس أشرف', att: { [heldFriday]: true }, fu: { [weekFriday]: 'تم تليفونياً' } });
  const sPresent2 = mkStudent({ id: 'st_p2', code: 'SG-102', name: 'بيشوي هاني', att: { [heldFriday]: true }, fu: {} });
  const sAbsent1 = mkStudent({ id: 'st_a1', code: 'SG-103', name: 'فادي مجدي', att: { [heldFriday]: false }, fu: {} });
  const sUnrecorded = mkStudent({ id: 'st_u1', code: 'SG-104', name: 'يوحنا ماهر', att: {}, fu: {} });
  const fuRecords: FollowupRecord[] = [
    {
      id: 'fu_log_1',
      date: weekFriday,
      studentId: sAbsent1.id,
      studentCode: sAbsent1.code,
      studentName: sAbsent1.name,
      servant: 'ماركو',
      fridayDate: weekFriday,
      type: 'واتساب',
      notes: 'تم التواصل'
    }
  ];
  const dataset = [sPresent1, sPresent2, sAbsent1, sUnrecorded];

  // Prompt 1: مين غاب آخر جمعة؟ / مين الأسماء اللي غابت آخر جمعة؟
  for (const p1 of ['مين غاب آخر جمعة؟', 'مين الأسماء اللي غابت آخر جمعة؟', 'اعرض أسماء الغايبين', 'عايز أسماء الغايبين']) {
    assert.strictEqual(detectAssistantIntent(p1), 'absent', `Intent must be absent for: ${p1}`);
    const r = processAssistantQuery(p1, dataset, { followupRecords: fuRecords });
    assert(r.text.includes('فادي مجدي'), `Explicitly absent student returned for: ${p1}`);
    assert(!r.text.includes('يوحنا ماهر'), `Unrecorded attendance NOT falsely listed as absent for: ${p1}`);
    assert(!r.text.includes('كيرلس أشرف'), `Present student NOT listed as absent for: ${p1}`);
  }

  // Prompt 2: مين حضر آخر جمعة؟ / مين الأسماء اللي حضرت آخر جمعة؟ / اعرض أسماء الحاضرين
  for (const p2 of ['مين حضر آخر جمعة؟', 'مين الأسماء اللي حضرت آخر جمعة؟', 'اعرض أسماء الحاضرين']) {
    assert.strictEqual(detectAssistantIntent(p2), 'present', `Intent must be present for: ${p2}`);
    const r = processAssistantQuery(p2, dataset, { followupRecords: fuRecords });
    assert(r.text.includes('كيرلس أشرف') && r.text.includes('بيشوي هاني'), `Present students listed for: ${p2}`);
    assert(!r.text.includes('فادي مجدي'), `Absent student NOT listed as present for: ${p2}`);
  }

  // Prompt 3 & 5: مين اللي نسيت أفتقده الأسبوع ده؟ / مين باقي في الافتقاد؟ / مين لسه ما اتفتقدش؟ / مين اللي محتاج أفتقده؟ / اعرض أسماء المخدومين اللي ما اتعملهمش افتقاد
  for (const pFu of [
    'مين اللي نسيت أفتقده الأسبوع ده؟',
    'مين باقي في الافتقاد؟',
    'مين لسه ما اتفتقدش؟',
    'مين اللي محتاج أفتقده؟',
    'اعرض أسماء المخدومين اللي ما اتعملهمش افتقاد',
    'مين اللي ما كلمتهوش الأسبوع ده؟'
  ]) {
    assert.strictEqual(detectAssistantIntent(pFu), 'missingFollowup', `Intent must be missingFollowup for: ${pFu}`);
    const r = processAssistantQuery(pFu, dataset, { followupRecords: fuRecords });
    assert(!r.command, `Negated follow-up question must NEVER trigger write command: ${pFu}`);
    assert(r.text.includes('بيشوي هاني') && r.text.includes('يوحنا ماهر'), `Unfollowed students returned for: ${pFu}`);
    assert(!r.text.includes('كيرلس أشرف'), `Sheet-followed student excluded for: ${pFu}`);
    assert(!r.text.includes('فادي مجدي'), `FollowupRecord-followed student excluded for: ${pFu}`);
  }

  // Prompt 6: مين محضرش الجمعة اللي فاتت؟ (critical substring guard: محضرش contains حضر)
  assert.strictEqual(detectAssistantIntent('مين محضرش الجمعة اللي فاتت؟'), 'absent', 'محضرش must map to absent, NOT present');
  const notPresentRes = processAssistantQuery('مين محضرش الجمعة اللي فاتت؟', dataset, { followupRecords: fuRecords });
  assert(notPresentRes.text.includes('فادي مجدي') && !notPresentRes.text.includes('كيرلس أشرف'), 'محضرش returns absent list accurately');

  // Edge cases: empty matching list ("لا يوجد"), empty dataset, sync error notice, future Friday separation
  const zeroAbsent = processAssistantQuery('مين غاب آخر جمعة؟', [sPresent1]);
  assert(zeroAbsent.text.includes('لا يوجد') && zeroAbsent.text.includes('(0)'), 'Empty absent query cleanly returns لا يوجد');

  const emptyDataset = processAssistantQuery('مين حضر آخر جمعة؟', [], { lastSyncError: 'Network Error' });
  assert(emptyDataset.text.includes('تعذر') && emptyDataset.actions?.some((a) => a.type === 'sync'), 'Empty dataset with sync error reports sync issue honestly');

  const syncWarningDataset = processAssistantQuery('مين حضر آخر جمعة؟', [sPresent1], { lastSyncError: 'HTTP 503' });
  assert(syncWarningDataset.text.includes('كيرلس أشرف') && syncWarningDataset.text.includes('غير مكتملة'), 'Local results served with honest incomplete-sync warning');

  console.log('✅ Test 13 Passed: Smart Assistant all 6 Arabic prompt groups + edge cases verified.');

  // 14. Dynamic Alphabet Filter (7 Scenarios + UI Source Guard)
  const dockSrc = readProjectFile('src/components/layout/BottomKeyboardDock.tsx');
  assert(!dockSrc.includes('ARABIC_ALPHABET'), 'BottomKeyboardDock must NOT import or render static ARABIC_ALPHABET');
  assert(dockSrc.includes('availableAlphabetBuckets'), 'BottomKeyboardDock derives letters from dynamic availableAlphabetBuckets');

  const baseFilter: AppFilterState = {
    searchQuery: '',
    sheet: 'نشط',
    servant: '',
    area: '',
    alphabetLetter: null
  };

  // Scenario 1 & 2: Different starting letters -> only used letters shown, sorted dynamically in Arabic order
  const st1 = mkStudent({ id: 'da_1', name: 'سالم نجيب', servant: 'ماركو', area: 'الزيتون' });
  const st2 = mkStudent({ id: 'da_2', name: 'بيشوي عماد', servant: 'ماركو', area: 'حدائق الزيتون' });
  const st3 = mkStudent({ id: 'da_3', name: 'أحمد سامي', servant: 'يوسف', area: 'الزيتون' });
  const st4 = mkStudent({ id: 'da_4', name: 'مينا عزيز', servant: 'ماركو', area: 'الزيتون' });
  let dynamicList = [st1, st2, st3, st4];
  let buckets = getAvailableAlphabetBuckets(dynamicList, baseFilter);
  assert.deepStrictEqual(
    buckets.map((b) => b.letter),
    ['ا', 'ب', 'س', 'م'],
    'Scenario 1 & 2: Extracts only used letters in Arabic collation order'
  );
  assert(!buckets.some((b) => ['خ', 'ض', 'ظ', 'غ', 'ي'].includes(b.letter)), 'Unused letters are never rendered');

  // Scenario 3: Adding student with new letter (خالد) adds 'خ' dynamically + selecting letter filters & preserves new additions
  const stKha = mkStudent({ id: 'da_5', name: 'خالد فؤاد', servant: 'ماركو', area: 'الزيتون' });
  dynamicList = [...dynamicList, stKha];
  buckets = getAvailableAlphabetBuckets(dynamicList, baseFilter);
  assert.deepStrictEqual(
    buckets.map((b) => b.letter),
    ['ا', 'ب', 'خ', 'س', 'م'],
    'Scenario 3a: Adding خالد automatically inserts خ in sorted Arabic position'
  );
  const stKha2 = mkStudent({ id: 'da_6', name: 'خليل مرقس', servant: 'ماركو', area: 'الزيتون' });
  const filteredWhileKhaSelected = filterStudentsByAppFilters([...dynamicList, stKha2], {
    ...baseFilter,
    alphabetLetter: 'خ'
  });
  assert.deepStrictEqual(
    filteredWhileKhaSelected.map((s) => s.name),
    ['خالد فؤاد', 'خليل مرقس'],
    'Scenario 3b: Existing filter on خ shows newly added خليل immediately'
  );

  // Also verify letter filter combines cleanly with text search & servant filter
  const combinedFiltered = filterStudentsByAppFilters([...dynamicList, stKha2], {
    ...baseFilter,
    servant: 'ماركو',
    searchQuery: 'خليل',
    alphabetLetter: 'خ'
  });
  assert.deepStrictEqual(combinedFiltered.map((s) => s.id), ['da_6'], 'Preserves text search and servant filters together with alphabet filter');

  // Scenario 4: Deleting last student with letter 'خ' removes 'خ' AND resets active filter back to All (null)
  const listWithoutKha = dynamicList.filter((s) => s.id !== 'da_5');
  const bucketsAfterDelete = getAvailableAlphabetBuckets(listWithoutKha, baseFilter);
  assert(!bucketsAfterDelete.some((b) => b.letter === 'خ'), 'Scenario 4a: Deleting last خ student removes خ from dock');
  assert.strictEqual(
    resolveValidAlphabetFilter('خ', bucketsAfterDelete),
    null,
    'Scenario 4b: Missing selected letter resets automatically to null (الكل)'
  );
  const recoveredResults = filterStudentsByAppFilters(listWithoutKha, {
    ...baseFilter,
    alphabetLetter: 'خ'
  });
  assert.strictEqual(recoveredResults.length, 4, 'Scenario 4c: Invalid letter filter falls back to showing All valid students');

  // Scenario 5: Editing student name changes first letter (سالم -> كريم) removes س and adds ك
  const listAfterRename = listWithoutKha.map((s) => (s.id === 'da_1' ? { ...s, name: 'كريم نجيب' } : s));
  const bucketsAfterRename = getAvailableAlphabetBuckets(listAfterRename, baseFilter);
  assert.deepStrictEqual(
    bucketsAfterRename.map((b) => b.letter),
    ['ا', 'ب', 'ك', 'م'],
    'Scenario 5: Renaming سالم -> كريم removes س and inserts ك in Arabic order'
  );
  assert.strictEqual(resolveValidAlphabetFilter('س', bucketsAfterRename), null, 'Old letter س resets to All after rename');

  // Scenario 6: Google Sheets sync replaces students -> dock updates with synced names only
  const syncedFromSheets = [
    mkStudent({ id: 'gs_1', name: 'تامر حسني', sourceSheet: 'نشط' }),
    mkStudent({ id: 'gs_2', name: 'يوسف جمال', sourceSheet: 'نشط' }),
    mkStudent({ id: 'gs_3', name: 'جورج نبيل', sourceSheet: 'نشط' }),
    mkStudent({ id: 'gs_4', name: 'نادر شكري', sourceSheet: 'غير حاضر' })
  ];
  const syncedBuckets = getAvailableAlphabetBuckets(syncedFromSheets, baseFilter);
  assert.deepStrictEqual(
    syncedBuckets.map((b) => b.letter),
    ['ت', 'ج', 'ي'],
    'Scenario 6: Synced sheet dataset recalculates only active sheet letters dynamically'
  );

  // Scenario 7: Extra spaces, diacritics, punctuation, Alef unification (أ، إ، آ، ا، ٱ) & invalid/empty names ignored
  const edgeBuckets = extractDynamicAlphabetBuckets([
    { name: '   أحمد علي' },
    { name: 'إبراهيم سمير' },
    { name: 'آدم ماجد' },
    { name: '  امير عادل' },
    { name: 'ٱنس كريم' },
    { name: '  -  طارق نبيل' },
    { name: '' },
    { name: '   ' },
    { name: '---' },
    { name: '12345' }
  ]);
  assert.deepStrictEqual(
    edgeBuckets,
    [
      { letter: 'ا', count: 5 },
      { letter: 'ط', count: 1 }
    ],
    'Scenario 7: Unifies all Alef variants, trims leading spaces/punctuation, ignores invalid/empty names'
  );
  assert.strictEqual(normalizeArabicInitial('   '), '', 'Whitespace-only name yields empty initial');
  assert.strictEqual(normalizeArabicInitial('---'), '', 'Punctuation-only name yields empty initial');

  // SSR render check for BottomKeyboardDock
  const dockHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(BottomKeyboardDock))
      )
    )
  );
  assert(dockHtml.includes('شريط التصفية الأبجدية') && dockHtml.includes('الكل'), 'BottomKeyboardDock SSR renders cleanly');
  console.log('✅ Test 14 Passed: All 7 Dynamic Alphabet Filter scenarios & edge cases verified.');

  console.log('\n🎉 ALL PRODUCTION AUDIT REGRESSION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Production audit test failed:', err);
  process.exit(1);
});
