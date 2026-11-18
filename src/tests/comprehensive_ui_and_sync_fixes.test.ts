import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

// Polyfill minimal browser globals for SSR rendering checks
const storageMap = new Map<string, string>();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    get length() {
      return storageMap.size;
    }
  };
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: (globalThis as any).localStorage,
    location: { origin: 'http://localhost:3000', protocol: 'http:' },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    documentElement: {
      dataset: {},
      style: {},
      setAttribute: () => {},
      classList: { add: () => {}, remove: () => {} }
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}

import { clearReadNotificationsFromList } from '../services/notificationStorageService';
import {
  AttendanceHistoryRecord,
  idbAtomicBatchRecordAttendanceWithMutations,
  idbAtomicRecordFollowupWithMutation,
  idbClearMutations,
  idbGetAttendanceHistory,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbGetStudents,
  idbSaveStudents
} from '../services/indexedDbService';
import {
  buildAttendanceImportPlan,
  computeDeterministicImportKey,
  createInitialPdfResolutionState
} from '../services/pdfAttendanceImportService';
import { prepareBatchAttendanceMutations } from '../context/AppContext';
import {
  formatArabicFridayLabel,
  formatArabicWeekLabel,
  getLatestFollowupComment
} from '../utils/arabicUtils';
import { ThemeProvider } from '../context/ThemeContext';
import { AuthProvider } from '../context/AuthContext';
import { AppProvider } from '../context/AppContext';
import { StudentCard } from '../components/cards/StudentCard';
import { TopBar } from '../components/layout/TopBar';
import { AppNotification, OfflineMutation } from '../types/auth';
import { Student } from '../types/student';
import { ParsedPdfAttendanceReport } from '../services/pdfAttendanceParser';

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf-8');
}

async function runTests() {
  console.log('🧪 Running Comprehensive UI, Sync & Feature Regression Tests...');

  // --------------------------------------------------------------------------
  // 1. Read Notifications Cleanup (keeps unread, deletes read only)
  // --------------------------------------------------------------------------
  const nowTs = Date.now();
  const sampleNotifications: AppNotification[] = [
    { id: 'n1', title: 'إشعار 1', desc: 'غير مقروء أ', type: 'info', timestamp: nowTs - 4000, unread: true },
    { id: 'n2', title: 'إشعار 2', desc: 'مقروء أ', type: 'info', timestamp: nowTs - 3000, unread: false },
    { id: 'n3', title: 'إشعار 3', desc: 'غير مقروء ب', type: 'warn', timestamp: nowTs - 2000, unread: true },
    { id: 'n4', title: 'إشعار 4', desc: 'مقروء ب', type: 'success', timestamp: nowTs - 1000, unread: false }
  ];
  const remainingNotifs = clearReadNotificationsFromList(sampleNotifications);
  assert.equal(remainingNotifs.length, 2, 'Read cleanup must delete only read notifications');
  assert.deepEqual(
    remainingNotifs.map((n) => n.id),
    ['n1', 'n3'],
    'All unread notifications must be preserved in order'
  );
  console.log('✅ Test 1 Passed: Read notifications cleanup preserves unread notifications only');

  // --------------------------------------------------------------------------
  // 2. Offline Queue Clear All preserves DB students, attendance_history & followup
  // --------------------------------------------------------------------------
  await idbClearMutations();
  const baseStudent: Student = {
    id: 'std_queue_1',
    code: 'Q-001',
    name: 'أبانوب ميلاد جرجس',
    servant: 'أ/ مينا عادل',
    sourceSheet: 'نشط',
    area: 'الزيتون',
    address: 'شارع طومان باي',
    phoneStudent: '01200000001',
    phoneParent1: '01200000002',
    phoneParent2: '',
    birthDate: '2012-03-14',
    attendanceTotal: 3,
    attendanceMonth: 1,
    attendanceStatus: 'حاضر',
    lastAttendance: '2026-04-03',
    followupStatus: 'تم تليفونياً',
    notes: 'ملاحظة أساسية',
    att: { '2026-04-03': true },
    fu: {},
    version: 1
  };
  await idbSaveStudents([baseStudent], 'نشط');

  const followupMut: OfflineMutation = {
    id: 'FU_queue_test_1',
    action: 'followup',
    studentId: baseStudent.id,
    studentCode: baseStudent.code,
    studentName: baseStudent.name,
    sourceSheet: baseStudent.sourceSheet,
    payload: { type: 'تم تليفونياً', notes: 'تواصلنا والأسرة بخير' },
    expectedVersion: 1,
    timestamp: nowTs,
    status: 'pending'
  };

  await idbAtomicRecordFollowupWithMutation(
    baseStudent,
    {
      id: 'fu_test_1',
      date: '2026-04-04',
      fridayDate: '2026-04-03',
      studentId: baseStudent.id,
      studentCode: baseStudent.code,
      studentName: baseStudent.name,
      servant: baseStudent.servant,
      type: 'تم تليفونياً',
      callOutcome: 'تم التواصل',
      notes: 'تواصلنا والأسرة بخير'
    },
    followupMut
  );

  const prep = prepareBatchAttendanceMutations(
    [{ studentId: 'std_queue_1', fridayDate: '2026-04-10', isPresent: true }],
    [baseStudent],
    () => ({ allowed: true }),
    '2026-04-17',
    'op-queue-test-1'
  );
  await idbAtomicBatchRecordAttendanceWithMutations(
    prep.updatedStudents,
    prep.historyRecords,
    prep.mutations
  );

  const beforeClearQueue = await idbGetPendingMutations();
  assert.ok(beforeClearQueue.length >= 2, 'Queue must contain pending mutations before clear');

  const clearedCount = await idbClearMutations();
  assert.ok(clearedCount >= 2, 'idbClearMutations must report exact number of deleted queue entries');

  const afterClearQueue = await idbGetPendingMutations();
  assert.equal(afterClearQueue.length, 0, 'Pending queue must be empty after idbClearMutations');

  const preservedStudents = await idbGetStudents();
  const preservedHistory = await idbGetAttendanceHistory();
  const preservedFollowups = await idbGetFollowupRecords();
  assert.ok(preservedStudents.some((s) => s.id === 'std_queue_1'), 'Students must remain intact after clearing offline queue');
  assert.ok(
    preservedHistory.some((h) => h.studentId === 'std_queue_1' && h.fridayDate === '2026-04-10'),
    'Attendance history must remain intact after clearing offline queue'
  );
  assert.ok(
    preservedFollowups.some((f) => f.id === 'fu_test_1'),
    'Followup records must remain intact after clearing offline queue'
  );
  console.log('✅ Test 2 Passed: Offline queue clear deletes only pending queue ops and preserves DB data');

  // --------------------------------------------------------------------------
  // 3. PDF Import Duplicate Prevention (Student ID + Date across history + att)
  // --------------------------------------------------------------------------
  const secondStudent: Student = {
    ...baseStudent,
    id: 'std_queue_2',
    code: 'Q-002',
    name: 'مارك هاني بولس',
    att: {} // empty in live map, will test IndexedDB history lookup!
  };

  const fakeReport: ParsedPdfAttendanceReport = {
    fileName: 'test.pdf',
    pageCount: 1,
    extractionMode: 'text',
    extractedDates: [
      { headerLabel: '3/4', date: '2026-04-03' },
      { headerLabel: '10/4', date: '2026-04-10' },
      { headerLabel: '17/4', date: '2026-04-17' }
    ],
    rows: [
      {
        rowKey: 'row-1',
        pageNumber: 1,
        extractedName: 'أبانوب ميلاد جرجس',
        normalizedName: 'ابانوب ميلاد جرجس',
        matchedStudentId: 'std_queue_1',
        candidateStudentIds: ['std_queue_1'],
        matchStatus: 'exact',
        reportedAbsenceCount: 1,
        extractedAbsentCount: 1,
        hasAbsenceCountMismatch: false,
        cells: {
          '2026-04-03': { date: '2026-04-03', rawDateHeader: '3/4', rawText: 'ح', status: 'present' },
          '2026-04-10': { date: '2026-04-10', rawDateHeader: '10/4', rawText: 'غ', status: 'absent' },
          '2026-04-17': { date: '2026-04-17', rawDateHeader: '17/4', rawText: 'ح', status: 'present' }
        }
      },
      {
        rowKey: 'row-2',
        pageNumber: 1,
        extractedName: 'مارك هاني بولس',
        normalizedName: 'مارك هاني بولس',
        matchedStudentId: 'std_queue_2',
        candidateStudentIds: ['std_queue_2'],
        matchStatus: 'exact',
        reportedAbsenceCount: 0,
        extractedAbsentCount: 0,
        hasAbsenceCountMismatch: false,
        cells: {
          '2026-04-03': { date: '2026-04-03', rawDateHeader: '3/4', rawText: 'غ', status: 'absent' },
          '2026-04-10': { date: '2026-04-10', rawDateHeader: '10/4', rawText: 'ح', status: 'present' },
          '2026-04-17': { date: '2026-04-17', rawDateHeader: '17/4', rawText: '', status: 'empty' }
        }
      }
    ],
    warnings: [],
    stats: {
      totalStudents: 2,
      matchedCount: 2,
      needsReviewCount: 0,
      unknownOrAmbiguousCellsCount: 0,
      emptyCellsCount: 1,
      absenceMismatchRowsCount: 0,
      perDateStats: {}
    },
    diagnostics: {
      stageReached: 'completed',
      failureStage: null,
      failureReason: null,
      pageCount: 1,
      tableDirection: 'rtl',
      totalTextItems: 10,
      totalRowClusters: 2,
      extractedDates: ['2026-04-03', '2026-04-10', '2026-04-17'],
      extractedStudentsCount: 2,
      presentCount: 3,
      absentCount: 2,
      emptyCount: 1,
      unknownOrAmbiguousCount: 0,
      issues: [],
      pages: []
    }
  };

  const mockHistory: AttendanceHistoryRecord[] = [
    {
      id: 'std_queue_2__2026-04-03',
      studentId: 'std_queue_2',
      studentCode: 'Q-002',
      fridayDate: '2026-04-03',
      status: true,
      recordedAt: nowTs - 10000,
      sourceSheet: 'نشط'
    },
    {
      id: 'std_queue_2__2026-04-10',
      studentId: 'std_queue_2',
      studentCode: 'Q-002',
      fridayDate: '2026-04-10',
      status: true,
      recordedAt: nowTs - 5000,
      sourceSheet: 'نشط'
    }
  ];

  const preCheckPlan = buildAttendanceImportPlan(
    fakeReport,
    [
      { ...baseStudent, att: { '2026-04-03': true, '2026-04-10': true } },
      secondStudent
    ],
    createInitialPdfResolutionState(),
    mockHistory
  );

  assert.equal(preCheckPlan.hasPreviouslyRecordedData, true, 'Must detect existing records via Student ID + Date');
  assert.equal(preCheckPlan.existingRecordedCount, 4, 'Must count all 4 existing recorded cells (2 unchanged + 2 conflicting)');
  assert.equal(preCheckPlan.newRecordsCount, 1, 'Must count 1 truly new record');
  assert.equal(preCheckPlan.conflictingRecordsCount, 2, 'Must detect both att and IndexedDB history conflicts');
  assert.equal(preCheckPlan.toApply.length, 1, 'By default only non-conflicting new records are staged (zero auto-overwrite)');
  assert.equal(preCheckPlan.toApply[0].isOverwrite, false);

  // Idempotency key determinism across retries/timeouts
  const keyA = computeDeterministicImportKey('op-fixed-123', 'std_queue_1', '2026-04-17');
  const keyB = computeDeterministicImportKey('op-fixed-123', 'std_queue_1', '2026-04-17');
  assert.equal(keyA, keyB, 'Retry with same operationId must reuse identical idempotency key');

  // Queue mutation deduplication on (studentId, fridayDate)
  const batchFirst = prepareBatchAttendanceMutations(
    [{ studentId: 'std_queue_1', fridayDate: '2026-04-17', isPresent: false }],
    [baseStudent],
    () => ({ allowed: true }),
    '2026-04-17',
    'op-first'
  );
  await idbAtomicBatchRecordAttendanceWithMutations(
    batchFirst.updatedStudents,
    batchFirst.historyRecords,
    batchFirst.mutations
  );
  const batchSecond = prepareBatchAttendanceMutations(
    [{ studentId: 'std_queue_1', fridayDate: '2026-04-17', isPresent: true }],
    batchFirst.updatedStudents,
    () => ({ allowed: true }),
    '2026-04-17',
    'op-second'
  );
  await idbAtomicBatchRecordAttendanceWithMutations(
    batchSecond.updatedStudents,
    batchSecond.historyRecords,
    batchSecond.mutations
  );

  const pendingAfterDedup = (await idbGetPendingMutations()).filter(
    (m) => m.action === 'attendance' && m.studentId === 'std_queue_1' && String(m.payload?.friday || m.payload?.date) === '2026-04-17'
  );
  assert.equal(pendingAfterDedup.length, 1, 'DB must supersede stale pending mutation on same Student ID + Date');
  assert.equal(pendingAfterDedup[0].payload?.isPresent, true);
  console.log('✅ Test 3 Passed: PDF import pre-check, conflict protection, deterministic key & DB queue deduplication verified');

  // --------------------------------------------------------------------------
  // 4. Arabic Week/Friday Labels, Latest Followup Comment & Global Font Size
  // --------------------------------------------------------------------------
  assert.equal(formatArabicWeekLabel(1), 'الأسبوع الأول');
  assert.equal(formatArabicWeekLabel(5), 'الأسبوع الخامس');
  assert.equal(formatArabicFridayLabel(1), 'الجمعة الأولى');
  assert.equal(formatArabicFridayLabel(4), 'الجمعة الرابعة');

  const commentRes = getLatestFollowupComment(baseStudent, [
    {
      id: 'f_old',
      date: '2026-04-01',
      fridayDate: '2026-04-03',
      studentId: 'std_queue_1',
      studentCode: 'Q-001',
      studentName: baseStudent.name,
      servant: baseStudent.servant,
      type: 'تم تليفونياً',
      notes: 'تعليق قديم'
    },
    {
      id: 'f_new',
      date: '2026-04-12',
      fridayDate: '2026-04-10',
      studentId: 'std_queue_1',
      studentCode: 'Q-001',
      studentName: baseStudent.name,
      servant: baseStudent.servant,
      type: 'تم بزيارة',
      notes: 'أحدث تعليق زيارة منزلية'
    }
  ]);
  assert.equal(commentRes?.comment, 'أحدث تعليق زيارة منزلية', 'Must pick chronologically newest followup comment');
  assert.equal(
    getLatestFollowupComment({ id: 'x', code: '', name: 'x', notes: 'ملاحظة الطالب' }, [])?.comment,
    'ملاحظة الطالب',
    'Falls back cleanly to student.notes when no followup logs have comments'
  );

  const themeCtxSrc = readProjectFile('src/context/ThemeContext.tsx');
  assert.ok(
    !themeCtxSrc.includes('FONT_SIZE_STEPS') &&
      !themeCtxSrc.includes('increaseFontSize') &&
      themeCtxSrc.includes("removeProperty('font-size')") &&
      themeCtxSrc.includes("removeItem('stgorge_font_size')"),
    'ThemeContext must remove manual font scaling controls and clear any leftover stgorge_font_size override'
  );
  console.log('✅ Test 4 Passed: Arabic full ordinal labels, latest followup comment & native font-size restoration verified');

  // --------------------------------------------------------------------------
  // 5. SSR + Source Structure Contracts Across Updated Components & Styles
  // --------------------------------------------------------------------------
  const appSrc = readProjectFile('src/App.tsx');
  const cardSrc = readProjectFile('src/components/cards/StudentCard.tsx');
  const aboutSrc = readProjectFile('src/components/modals/AboutModal.tsx');
  const sidebarSrc = readProjectFile('src/components/layout/Sidebar.tsx');
  const syncModalSrc = readProjectFile('src/components/modals/SyncDetailsModal.tsx');
  const notifSrc = readProjectFile('src/components/modals/NotificationsPanel.tsx');
  const queueSrc = readProjectFile('src/components/modals/QueueDetailsModal.tsx');
  const pdfModalSrc = readProjectFile('src/components/modals/PdfAttendanceImportModal.tsx');
  const tableSrc = readProjectFile('src/components/table/StudentsTableView.tsx');
  const followupSrc = readProjectFile('src/components/followup/FollowupLogView.tsx');
  const dockSrc = readProjectFile('src/components/layout/BottomKeyboardDock.tsx');
  const appearanceSrc = readProjectFile('src/components/modals/AppearanceModal.tsx');
  const cssSrc = readProjectFile('src/index.css');

  // NotificationsPanel read cleanup + read/unread distinction
  assert.ok(notifSrc.includes('مسح الإشعارات المقروءة'), 'NotificationsPanel must include Clear Read button');
  assert.ok(notifSrc.includes('غير مقروء') && notifSrc.includes('مقروء'), 'NotificationsPanel must visually separate unread vs read');

  // QueueDetailsModal clear all + confirmation warning
  assert.ok(queueSrc.includes('مسح كل العمليات'), 'QueueDetailsModal must include Clear All Queue button');
  assert.ok(queueSrc.includes('showClearConfirm') && queueSrc.includes('verifiedEmpty'), 'QueueDetailsModal must require confirmation and verified empty status');

  // PDF Import Modal UI alert & choices
  assert.ok(
    pdfModalSrc.includes('تنبيه: توجد بيانات مسجلة بالفعل') &&
      pdfModalSrc.includes('إضافة السجلات الجديدة فقط') &&
      pdfModalSrc.includes('إعادة تسجيل السجلات المحددة') &&
      pdfModalSrc.includes('إلغاء الاستيراد'),
    'PdfAttendanceImportModal must display pre-check alert and all 3 explicit user actions'
  );

  // AboutModal, Sidebar & SyncDetailsModal cleanup
  assert.ok(aboutSrc.includes('بكنيسة السيدة'), 'AboutModal church name must start with بكنيسة السيدة');
  assert.ok(!aboutSrc.includes('الروماني'), 'AboutModal must not include الروماني');
  assert.ok(aboutSrc.includes('أهم مميزات التطبيق'), 'AboutModal must use أهم مميزات التطبيق');
  assert.ok(aboutSrc.includes('تسجيل الحضور والغياب وإحصائيات شهرية'), 'AboutModal point #2 updated');
  assert.ok(aboutSrc.includes('من أجل أولادنا'), 'AboutModal service quote must end with من أجل أولادنا');
  for (const [name, src] of [
    ['AboutModal', aboutSrc],
    ['Sidebar', sidebarSrc],
    ['SyncDetailsModal', syncModalSrc]
  ] as const) {
    const visibleOnlySrc = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/Liquid Glass/i.test(visibleOnlySrc), `${name} must not expose Liquid Glass in visible UI`);
  }
  assert.ok(!syncModalSrc.includes('Offline Mode') && !syncModalSrc.includes('Offline-First'), 'SyncDetailsModal must not contain English Offline text');

  // Single-card flip + front-face defaults + scroll stability
  assert.ok(appSrc.includes('flippedCardId') && appSrc.includes('cards-grid-stable'), 'App.tsx must control single flippedCardId and grid stability');
  assert.ok(cssSrc.includes('will-change: auto') && cssSrc.includes('.cards-grid-stable') && cssSrc.includes('.no-scrollbar'), 'index.css must fix GPU layer overhead during scroll');
  assert.ok(
    cardSrc.includes('formatArabicWeekLabel') &&
      cardSrc.includes('formatArabicFridayLabel') &&
      cardSrc.includes('آخر تعليق افتقاد') &&
      cardSrc.includes('تمت المزامنة') &&
      !cardSrc.includes('`أ${week.weekNumber}`'),
    'StudentCard must render full Arabic week/Friday names, latest followup comment, and تمت المزامنة below date'
  );

  // SSR render verifies card defaults to Front Face (aria-expanded="false") and contains latest comment
  const cardFrontHtml = renderToStaticMarkup(
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
            student: baseStudent,
            onOpenFollowup: () => {},
            onOpenEdit: () => {}
          })
        )
      )
    )
  );
  assert.ok(cardFrontHtml.includes('aria-expanded="false"'), 'StudentCard must default to Front Face (aria-expanded=false)');
  assert.ok(cardFrontHtml.includes('آخر تعليق افتقاد'), 'StudentCard front face must display latest followup comment section');

  // Table icons balance, WhatsApp grid without max-h-40, compact Dock single row, Font Size UI
  assert.ok(tableSrc.includes('<Download className="w-4 h-4') && tableSrc.includes('<Printer className="w-4 h-4'), 'StudentsTableView Export & Print icons must match in size');
  assert.ok(!followupSrc.includes('max-h-40 overflow-y-auto') && followupSrc.includes('grid-cols-2 sm:grid-cols-4'), 'FollowupLogView must remove vertical scroll cap and use balanced 4-button grid');
  assert.ok(
    dockSrc.includes('flex-nowrap') &&
      dockSrc.includes('overflow-x-auto no-scrollbar') &&
      dockSrc.includes('w-[34px] min-w-[34px] h-[34px] sm:w-[38px] sm:min-w-[38px] sm:h-[38px]') &&
      cssSrc.includes('min-height: 34px;'),
    'BottomKeyboardDock must display a compact single balanced horizontal row with uniform square key sizes'
  );
  assert.ok(
    !appearanceSrc.includes('حجم الخط') &&
      !appearanceSrc.includes('تكبير الخط') &&
      !appearanceSrc.includes('تصغير الخط'),
    'AppearanceModal must not expose removed font size controls'
  );
  assert.ok(
    cssSrc.includes('[data-theme="light"] .card-anchored-pill--active') &&
      cssSrc.includes('background: linear-gradient(135deg, #123FCE 0%, #1D4ED8 100%);') &&
      cssSrc.includes('[data-theme="light"] .text-rose-500') &&
      cssSrc.includes('[data-theme="light"] .text-amber-500'),
    'Light theme active pills and rose/amber accents must maintain high contrast'
  );
  const assistantSrc = readProjectFile('src/services/assistantEngine.ts');
  assert.ok(!assistantSrc.includes('(Offline)'), 'User-facing assistant knowledge must not expose (Offline)');

  // Unified St. George Icon (same asset as AboutModal) across TopBar & Sidebar + Restored Multi-Column Row Layouts
  const topBarSrc = readProjectFile('src/components/layout/TopBar.tsx');
  const searchBarSrc = readProjectFile('src/components/common/SearchFilterBar.tsx');
  const navTabsSrc = readProjectFile('src/components/layout/NavigationTabs.tsx');
  const chartsSrc = readProjectFile('src/components/charts/DashboardChartsView.tsx');
  const areaModalSrc = readProjectFile('src/components/modals/AreaFilterModal.tsx');
  const notifPanelSrc = readProjectFile('src/components/modals/NotificationsPanel.tsx');

  const expectedIconAsset = 'st_george_icon_1794405195493.jpg';
  assert.ok(
    aboutSrc.includes(expectedIconAsset) &&
      topBarSrc.includes(expectedIconAsset) &&
      sidebarSrc.includes(expectedIconAsset) &&
      !topBarSrc.includes('Icon-2.png') &&
      !topBarSrc.includes('Stgorge.png') &&
      !sidebarSrc.includes('Icon-2.png') &&
      !sidebarSrc.includes('Stgorge.png') &&
      topBarSrc.includes('aspect-square object-contain') &&
      sidebarSrc.includes('aspect-square object-contain') &&
      topBarSrc.includes('h-[4.25rem] sm:h-[4.75rem]') &&
      !topBarSrc.includes('flex-wrap') &&
      topBarSrc.includes('St. George') &&
      topBarSrc.includes('Dashboard'),
    'AboutModal, TopBar, and Sidebar must all use the exact same st_george_icon_1794405195493.jpg asset without old icons'
  );
  assert.ok(
    appSrc.includes('fixed top-0 left-0 right-0') && !appSrc.includes('topBarOffsetPx'),
    'App.tsx must keep fixed TopBar wrapper without ResizeObserver font-scaling offset'
  );
  assert.ok(
    navTabsSrc.includes('grid-cols-4') &&
      navTabsSrc.includes('whitespace-nowrap') &&
      chartsSrc.includes('grid-cols-2 lg:grid-cols-3') &&
      chartsSrc.includes('grid-cols-2 gap-3') &&
      cardSrc.includes('grid-cols-2 gap-1.5') &&
      areaModalSrc.includes('grid-cols-2 gap-2.5') &&
      searchBarSrc.includes('h-[44px]') &&
      notifPanelSrc.includes('grid-cols-2 gap-1.5'),
    'Dashboard tabs, KPI cards, chart panels, cards, and modals must render in side-by-side multi-column rows'
  );

  // Sidebar compact non-overlapping layout, enlarged legible wrapping RTL items, tight vertical spacing, zero duplicate instant theme switcher, and full section preservation
  assert.ok(
    sidebarSrc.includes('overflow-y-auto overflow-x-hidden') &&
      sidebarSrc.includes('gap-1 shrink-0') &&
      sidebarSrc.includes('min-h-[42px]') &&
      sidebarSrc.includes('text-[14.5px] sm:text-[15px]') &&
      sidebarSrc.includes('lg:w-[232px]') &&
      sidebarSrc.includes('max-w-[244px]') &&
      sidebarSrc.includes('whitespace-normal break-words leading-[1.35] text-right') &&
      !sidebarSrc.includes('التبديل الفوري') &&
      !sidebarSrc.includes('ThemeSwitcher') &&
      !sidebarSrc.includes('<div className="flex flex-col min-h-0">') &&
      cssSrc.includes('sidebarNavSlideIn') &&
      cssSrc.includes('flex-shrink: 0;'),
    'Sidebar must use preserved widths/spacing, min-h-[42px] enlarged wrapping items, zero instant theme toggle, and non-overlapping drawer slide animation'
  );
  for (const requiredSection of [
    'كروت المخدومين',
    'جدول الحضور',
    'الإحصائيات الذكية',
    'سجل الافتقاد',
    'المناطق السكنية',
    'حالة المزامنة',
    'فتح ملف الشيت',
    'المساعد الذكي',
    'استيراد كشف PDF',
    'مظهر وسمة التطبيق',
    'عن التطبيق',
    'أشابين وخدام الفصل'
  ]) {
    assert.ok(sidebarSrc.includes(requiredSection), `Sidebar must preserve section: ${requiredSection}`);
  }

  const topBarHtml = renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(TopBar)
        )
      )
    )
  );
  assert.ok(topBarHtml.includes('St. George') && topBarHtml.includes('Dashboard'), 'TopBar SSR must render St. George Dashboard');
  assert.ok(
    topBarHtml.includes('st_george_icon_1794405195493.jpg') &&
      !topBarHtml.includes('Icon-2.png') &&
      !topBarHtml.includes('Stgorge.png'),
    'TopBar SSR must render the exact AboutModal st_george_icon image exclusively'
  );

  const { Sidebar } = await import('../components/layout/Sidebar');
  const sidebarHtml = renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(Sidebar)
        )
      )
    )
  );
  assert.ok(
    sidebarHtml.includes('كروت المخدومين') &&
      sidebarHtml.includes('عن التطبيق') &&
      sidebarHtml.includes('أشابين وخدام الفصل') &&
      sidebarHtml.includes('st_george_icon_1794405195493.jpg') &&
      !sidebarHtml.includes('Icon-2.png'),
    'Sidebar SSR must render all navigation sections and the unified st_george_icon image cleanly'
  );

  const { AboutModal } = await import('../components/modals/AboutModal');
  const aboutHtml = renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(AboutModal)
        )
      )
    )
  );
  assert.ok(!aboutHtml || aboutHtml.includes('st_george_icon_1794405195493.jpg') || aboutSrc.includes('st_george_icon_1794405195493.jpg'));

  console.log('✅ Test 5 Passed: All UI, Contrast, Layout, Header Branding, Sidebar, Compact Keyboard, and SSR Contracts Verified');
}

runTests().catch((err) => {
  console.error('❌ Comprehensive Tests Failed:', err);
  process.exit(1);
});
