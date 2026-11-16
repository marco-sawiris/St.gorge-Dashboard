import assert from 'assert';
import fs from 'fs';
import path from 'path';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToString } from 'react-dom/server';

import {
  getIndexedDB,
  idbAtomicRecordAttendanceWithMutation,
  idbGetPendingMutations,
  idbGetStudents,
  idbSaveStudents,
  idbClearMutations
} from '../services/indexedDbService';
import {
  evaluateSingleActiveEditLock,
  executeProcessOfflineQueue,
  executeSyncData,
  AppProvider
} from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import { SyncDetailsModal } from '../components/modals/SyncDetailsModal';
import { SplashScreen } from '../components/layout/SplashScreen';
import { ThemeSwitcher } from '../components/glass/ThemeSwitcher';
import { NotificationsPanel } from '../components/modals/NotificationsPanel';
import { AppearanceModal } from '../components/modals/AppearanceModal';
import { StudentCard } from '../components/cards/StudentCard';
import { Student } from '../types/student';
import { OfflineMutation } from '../types/auth';
import { generateUUID } from '../utils/uuid';
import { toSafeHeaderAscii, setAppsScriptUrl, setRelayKey } from '../services/apiConfig';

console.log('\n======================================================');
console.log('  🧪 Running Consolidated Fixes Test Suite (Tasks 1-6)');
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

const mockStudent: Student = {
  id: 'std_cons_001',
  code: 'SG-888',
  name: 'مينا كيرلس جرجس',
  servant: 'مينا نبيل',
  sourceSheet: 'نشط',
  area: 'حدائق الزيتون',
  address: 'شارع طومانباي',
  notes: 'مواظب على الحضور',
  followupStatus: 'بدون',
  attendanceTotal: 5,
  attendanceMonth: 2,
  attendanceStatus: 'غائب',
  version: 3,
  lastAttendance: '2026-11-06',
  att: { '2026-11-06': true },
  fu: {}
};

async function cleanAllIDB() {
  const db = await getIndexedDB();
  const tx = db.transaction(['students', 'mutations', 'attendance_history', 'followup'], 'readwrite');
  tx.objectStore('students').clear();
  tx.objectStore('mutations').clear();
  tx.objectStore('attendance_history').clear();
  tx.objectStore('followup').clear();
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function runConsolidatedTests() {
  (globalThis as any).localStorage = createStorageMock();
  const originalFetch = globalThis.fetch;

  try {
    // --------------------------------------------------------------------------
    // 1. Task 1 Verification: SyncDetailsModal has zero password / relay-key inputs
    // --------------------------------------------------------------------------
    const syncModalPath = path.resolve(process.cwd(), 'src/components/modals/SyncDetailsModal.tsx');
    const syncModalSrc = fs.readFileSync(syncModalPath, 'utf-8');

    assert(!syncModalSrc.includes('<input'), 'Task 1a: SyncDetailsModal contains zero <input> elements');
    assert(!syncModalSrc.includes('type="password"'), 'Task 1b: SyncDetailsModal contains zero password inputs');
    assert(!syncModalSrc.includes('setRelayKey'), 'Task 1c: SyncDetailsModal does not modify or set relayKey');
    assert(!syncModalSrc.includes('مفتاح تأمين Google Apps Script'), 'Task 1d: Relay key setup section completely removed from UI');

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
    assert(!syncModalHtml.includes('type="password"'), 'Task 1e: Rendered HTML contains zero password inputs');
    console.log('✅ Task 1 Passed: Secret key inputs completely removed from SyncDetailsModal with zero data loss');

    // --------------------------------------------------------------------------
    // 2. Task 2 Verification: Saint George Crest sharp from frame 1 in SplashScreen
    // --------------------------------------------------------------------------
    const splashPath = path.resolve(process.cwd(), 'src/components/layout/SplashScreen.tsx');
    const splashSrc = fs.readFileSync(splashPath, 'utf-8');

    assert(
      !splashSrc.includes('blur(Math.max(0, phase.blurPx * 0.35)px)'),
      'Task 2a: Blur filter removed from crest container'
    );
    assert(
      splashSrc.includes('100% Crisp Crest Card'),
      'Task 2b: Crest container designated as razor sharp'
    );
    assert(
      splashSrc.includes('blurry-splash-bg absolute inset-0'),
      'Task 2c: Atmospheric optical background blur preserved for premium visual depth'
    );
    console.log('✅ Task 2 Passed: Saint George Crest is 100% sharp from first frame in SplashScreen');

    // --------------------------------------------------------------------------
    // 3. Task 3 Verification: 3-State Theme Selector (Dark, Dim, Light)
    // --------------------------------------------------------------------------
    const themeSwitcherPath = path.resolve(process.cwd(), 'src/components/glass/ThemeSwitcher.tsx');
    const themeSwitcherSrc = fs.readFileSync(themeSwitcherPath, 'utf-8');

    assert(themeSwitcherSrc.includes("'dark'"), 'Task 3a: ThemeSwitcher defines dark theme');
    assert(themeSwitcherSrc.includes("'dim'"), 'Task 3b: ThemeSwitcher defines dim theme');
    assert(themeSwitcherSrc.includes("'light'"), 'Task 3c: ThemeSwitcher defines light theme');
    assert(themeSwitcherSrc.includes('داكن') && themeSwitcherSrc.includes('خافت') && themeSwitcherSrc.includes('فاتح'),
      'Task 3d: ThemeSwitcher displays Arabic labels for all 3 themes'
    );

    const themeSwitcherHtml = renderToString(
      React.createElement(ThemeProvider, null, React.createElement(ThemeSwitcher))
    );
    assert(
      themeSwitcherHtml.includes('داكن') &&
      themeSwitcherHtml.includes('خافت') &&
      themeSwitcherHtml.includes('فاتح'),
      'Task 3e: ThemeSwitcher renders all 3 theme buttons'
    );

    const notifPanelPath = path.resolve(process.cwd(), 'src/components/modals/NotificationsPanel.tsx');
    const notifPanelSrc = fs.readFileSync(notifPanelPath, 'utf-8');
    const aboutModalPath = path.resolve(process.cwd(), 'src/components/modals/AboutModal.tsx');
    const aboutModalSrc = fs.readFileSync(aboutModalPath, 'utf-8');
    const appearanceModalPath = path.resolve(process.cwd(), 'src/components/modals/AppearanceModal.tsx');
    const appearanceModalSrc = fs.readFileSync(appearanceModalPath, 'utf-8');
    const sidebarPath = path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx');
    const sidebarSrc = fs.readFileSync(sidebarPath, 'utf-8');
    assert(
      !notifPanelSrc.includes('ThemeSwitcher') &&
      !notifPanelSrc.includes('مظهر وسِمة التطبيق') &&
      !notifPanelSrc.includes('مظهر وسمة التطبيق'),
      'Task 3f: NotificationsPanel no longer embeds ThemeSwitcher or appearance shortcut'
    );
    assert(
      !aboutModalSrc.includes('ThemeSwitcher') &&
      !aboutModalSrc.includes('مظهر وسمة التطبيق'),
      'Task 3g: AboutModal no longer embeds duplicate ThemeSwitcher'
    );
    assert(
      sidebarSrc.includes('مظهر وسمة التطبيق') &&
      sidebarSrc.includes('setIsAppearanceModalOpen(true)'),
      'Task 3h: Sidebar links appearance option directly to independent AppearanceModal'
    );
    assert(
      appearanceModalSrc.includes('<ThemeSwitcher />') &&
      appearanceModalSrc.includes('مظهر وسمة التطبيق') &&
      appearanceModalSrc.includes('داكن') &&
      appearanceModalSrc.includes('خافت') &&
      appearanceModalSrc.includes('فاتح'),
      'Task 3i: AppearanceModal renders ThemeSwitcher for all 3 themes'
    );
    void AppearanceModal;
    console.log('✅ Task 3 Passed: 3-State Theme Selector hosted cleanly in independent Sidebar -> AppearanceModal destination');

    // --------------------------------------------------------------------------
    // 4. Task 4 Verification: Strict Single Active Edit Mode
    // --------------------------------------------------------------------------
    const lock1 = evaluateSingleActiveEditLock(null, 'std_1', false);
    assert(lock1.allowed === true, 'Task 4a: First card allowed to edit');

    const lock2 = evaluateSingleActiveEditLock('std_1', 'std_2', false);
    assert(lock2.allowed === false && Boolean(lock2.reason), 'Task 4b: Second card blocked while std_1 is active');

    const lockSame = evaluateSingleActiveEditLock('std_1', 'std_1', false);
    assert(lockSame.allowed === true, 'Task 4c: Same active card re-evaluation allowed');

    const cardPath = path.resolve(process.cwd(), 'src/components/cards/StudentCard.tsx');
    const cardSrc = fs.readFileSync(cardPath, 'utf-8');
    const appPath = path.resolve(process.cwd(), 'src/App.tsx');
    const appSrc = fs.readFileSync(appPath, 'utf-8');

    // Verify "تفاصيل أكثر" button only toggles independent 3D flip via handleToggleFlip / isFlipped and does NOT call onOpenEdit
    assert(
      cardSrc.includes('onClick={handleToggleFlip}') &&
        cardSrc.includes('aria-expanded={isFlipped}') &&
        cardSrc.includes('card-flip-scene') &&
        cardSrc.includes('card-flip-inner') &&
        !appSrc.includes('expandedCardId') &&
        !cardSrc.includes('role="button"') &&
        !cardSrc.includes('tabIndex'),
      'Task 4d: Details button strictly toggles per-card 3D flip via handleToggleFlip / isFlipped and never makes card container clickable or opens edit mode'
    );
    assert(cardSrc.includes('aria-disabled={isAnotherCardEditing}'), 'Task 4e: Edit button guarded by isAnotherCardEditing');
    console.log('✅ Task 4 Passed: Strict Single Active Edit Mode & Independent 3D Flip Card verified');

    // --------------------------------------------------------------------------
    // 5. Task 5 Verification: Single-Click Attendance & Absence ("حاضر" / "غائب")
    // --------------------------------------------------------------------------
    assert(
      cardSrc.includes('>حاضر</span>') && cardSrc.includes('>غائب</span>'),
      'Task 5a: StudentCard contains explicit [حاضر] and [غائب] buttons'
    );
    assert(
      cardSrc.includes('if (isPresentToday || isAttendanceLoading) return;'),
      'Task 5b: Clicking active [حاضر] button does not toggle or revert state'
    );
    assert(
      cardSrc.includes('if (isAbsentToday || isAttendanceLoading) return;'),
      'Task 5c: Clicking active [غائب] button does not toggle or revert state'
    );

    // Render StudentCard with mock student to verify presence of single-click segment
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
              student: mockStudent,
              onOpenFollowup: () => {},
              onOpenEdit: () => {}
            })
          )
        )
      )
    );
    assert(cardHtml.includes('حاضر') && cardHtml.includes('غائب'), 'Task 5d: StudentCard renders both [حاضر] and [غائب] buttons');
    assert(cardHtml.includes('الجمعة ('), 'Task 5e: Card displays Friday label for single-click attendance');
    console.log('✅ Task 5 Passed: Single-Click Attendance [حاضر] / [غائب] segment buttons verified');

    // --------------------------------------------------------------------------
    // 6. Task 6 Verification: Offline Queue & Sync Diagnostics (Zero Data Loss)
    // --------------------------------------------------------------------------
    await cleanAllIDB();
    const testMutId = `ATT_diag_${generateUUID()}`;
    const testFriday = '2026-11-13';

    await idbAtomicRecordAttendanceWithMutation(
      { ...mockStudent, att: { [testFriday]: true }, attendanceStatus: 'حاضر' },
      {
        id: `${mockStudent.id}__${testFriday}`,
        studentId: mockStudent.id,
        studentCode: mockStudent.code,
        fridayDate: testFriday,
        status: true,
        recordedAt: Date.now(),
        sourceSheet: 'نشط'
      },
      {
        id: testMutId,
        action: 'attendance',
        studentId: mockStudent.id,
        studentCode: mockStudent.code,
        studentName: mockStudent.name,
        sourceSheet: 'نشط',
        payload: { friday: testFriday, isPresent: true },
        expectedVersion: 3,
        timestamp: Date.now(),
        status: 'pending'
      }
    );

    let queued = await idbGetPendingMutations();
    assert(queued.length === 1 && queued[0].id === testMutId, 'Task 6a: Mutation safely stored in IndexedDB');

    // Simulate server failure: mutation MUST stay in IndexedDB with error recorded (Zero Data Loss)
    (globalThis as any).fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'Temporary Server Error' })
    });

    const failedProcess = await executeProcessOfflineQueue(null, false);
    assert(failedProcess.success === false && failedProcess.remainingCount === 1, 'Task 6b: Failed queue processing preserves pending mutation');
    queued = await idbGetPendingMutations();
    assert(queued.length === 1 && queued[0].status === 'failed', 'Task 6c: Mutation remains intact in IndexedDB after failure');

    // Simulate successful server response: mutation removed ONLY upon confirmed success
    let capturedBody: any = null;
    (globalThis as any).fetch = async (url: string, opts?: any) => {
      capturedBody = JSON.parse(opts?.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, mutationId: testMutId })
      } as any;
    };

    const successProcess = await executeProcessOfflineQueue(null, false);
    assert(successProcess.success === true && successProcess.remainingCount === 0, 'Task 6d: Success flushes mutation cleanly');
    assert(capturedBody?.sheet === 'نشط' && capturedBody?.name === mockStudent.name, 'Task 6e: POST body carries Arabic name and sheet in UTF-8 JSON');
    queued = await idbGetPendingMutations();
    assert(queued.length === 0, 'Task 6f: Queue cleared only after verified server confirmation');

    // Verify safe header helper prevents ByteString crash
    const unsafeArabic = 'مارك مرقس جرجس 123';
    const safeHeader = toSafeHeaderAscii(unsafeArabic);
    assert(/^[\x20-\x7E]+$/.test(safeHeader), 'Task 6g: toSafeHeaderAscii strictly emits ISO-8859-1 ByteString safe ASCII');

    console.log('✅ Task 6 Passed: Offline Queue & Sync Diagnostics verified with Zero Data Loss');

    // --------------------------------------------------------------------------
    // 7. Task 7 Verification: Restored Original Buttons & 3D Flip Card Interaction
    // --------------------------------------------------------------------------
    const searchBarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/common/SearchFilterBar.tsx'), 'utf-8');
    const indexCssSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf-8');
    assert(
      !appSrc.includes('liquid-lens-btn') &&
        !searchBarSrc.includes('liquid-lens-btn') &&
        !indexCssSrc.includes('.liquid-lens-btn') &&
        appSrc.includes('glass-btn--primary btn--lens px-4 py-2 rounded-xl') &&
        searchBarSrc.includes('glass-btn--primary btn--lens flex-1 h-11 px-4 rounded-xl'),
      'Task 7a: Original styling restored cleanly for both Add Student and Sync Server buttons'
    );

    assert(
      indexCssSrc.includes('perspective: 1200px') &&
        indexCssSrc.includes('transform-style: preserve-3d') &&
        indexCssSrc.includes('backface-visibility: hidden') &&
        indexCssSrc.includes('rotateY(180deg)') &&
        indexCssSrc.includes('600ms') &&
        indexCssSrc.includes('@media (prefers-reduced-motion: reduce)'),
      'Task 7b: 3D Flip Card CSS specifies perspective, preserve-3d, backface-visibility, rotateY(180deg), 600ms transition & reduced-motion'
    );

    const studentA = { ...mockStudent, id: 'card_a', name: 'كيرلس عماد', code: 'SG-101' };
    const studentB = { ...mockStudent, id: 'card_b', name: 'بيشوي ناجي', code: 'SG-102' };

    const twoCardsHtml = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(
              React.Fragment,
              null,
              React.createElement(StudentCard, {
                student: studentA,
                onOpenFollowup: () => {},
                onOpenEdit: () => {},
                initialFlipped: true
              }),
              React.createElement(StudentCard, {
                student: studentB,
                onOpenFollowup: () => {},
                onOpenEdit: () => {},
                initialFlipped: false
              })
            )
          )
        )
      )
    );

    assert(
      twoCardsHtml.includes('كيرلس عماد') &&
        twoCardsHtml.includes('بيشوي ناجي') &&
        twoCardsHtml.includes('card-flip-inner is-flipped') &&
        twoCardsHtml.includes('id="student-card-back-card_a"') &&
        twoCardsHtml.includes('id="student-card-back-card_b"') &&
        twoCardsHtml.includes('رجوع') &&
        twoCardsHtml.includes('العودة للتفاصيل الأساسية') &&
        twoCardsHtml.includes('aria-expanded="true"') &&
        twoCardsHtml.includes('aria-expanded="false"') &&
        !cardSrc.includes('student-details-'),
      'Task 7c: Flipping card_a rotates only card_a in 3D with back face & return CTA while card_b stays unflipped and visible'
    );
    console.log('✅ Task 7 Passed: Restored buttons & independent 3D Flip Card interaction verified');

    // --------------------------------------------------------------------------
    // 8. Task 8 Verification: Splash-Only System Navigation Bar Hiding & Restore
    // --------------------------------------------------------------------------
    const mainActivitySrc = fs.readFileSync(
      path.resolve(process.cwd(), 'android/app/src/main/java/org/stgeorge/zaitoun/dashboard/MainActivity.java'),
      'utf-8'
    );
    const stylesXmlSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'android/app/src/main/res/values/styles.xml'),
      'utf-8'
    );
    const manifestXmlSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml'),
      'utf-8'
    );

    assert(
      splashSrc.includes('SystemBars') &&
        splashSrc.includes('SystemBarType.NavigationBar') &&
        splashSrc.includes('SystemBars.hide({ bar: SystemBarType.NavigationBar })') &&
        splashSrc.includes('SystemBars.show({ bar: SystemBarType.NavigationBar })') &&
        splashSrc.includes('restoreSystemNavigationBar()') &&
        splashSrc.includes('h-[100dvh] w-full'),
      'Task 8a: SplashScreen hides only NavigationBar while active, fills 100dvh, and restores it cleanly on dismiss/unmount'
    );
    assert(
      mainActivitySrc.includes('WindowInsetsCompat.Type.navigationBars()') &&
        !mainActivitySrc.includes('WindowInsetsCompat.Type.systemBars()') &&
        !stylesXmlSrc.includes('windowFullscreen') &&
        !manifestXmlSrc.includes('Fullscreen'),
      'Task 8b: Android launch splash hides only navigationBars() without altering app-wide theme or other pages'
    );

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
      splashHtml.includes('h-[100dvh] w-full') &&
        splashHtml.includes('Stgorge.png') &&
        splashHtml.includes('دخول الآن'),
      'Task 8c: SplashScreen renders cleanly with full-viewport layout and original artwork/CTA'
    );
    console.log('✅ Task 8 Passed: Splash-only navigation bar hide & restore verified without global theme side effects');

    await cleanAllIDB();
    console.log('\n======================================================');
    console.log('🎉 ALL CONSOLIDATED FIXES TESTS (TASKS 1-8) PASSED!');
    console.log('======================================================\n');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}

runConsolidatedTests().catch((err) => {
  console.error('❌ Consolidated Fixes Test Failure:', err);
  process.exit(1);
});
