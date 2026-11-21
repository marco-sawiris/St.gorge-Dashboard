import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import express from 'express';
import http from 'node:http';
import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { OfflineMutation, AuthUser } from '../types/auth';
import {
  buildUnifiedFollowupRecords,
  classifyFollowupMethod,
  extractFollowupCallOutcome,
  findStudentForFollowupRecord,
  normalizeArabicText
} from '../utils/arabicUtils';
import {
  parse2DRowsToStudents,
  parseGoogleVisualizationFollowupLog
} from '../services/googleSheetParser';
import {
  getIndexedDB,
  idbAddFollowupRecord,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbSaveRemoteFollowupRecords,
  idbSaveStudents,
  idbClearMutations,
  idbQueueMutation
} from '../services/indexedDbService';
import {
  AppContext,
  AppContextType,
  clearBatchUnsupportedCache,
  executeProcessOfflineQueue,
  isValidTargetTabName,
  prepareBatchAttendanceMutations,
  resolveValidSheetName
} from '../context/AppContext';
import {
  buildAttendanceImportPlan,
  createInitialPdfResolutionState,
  validateAndResolvePdfImportEntries
} from '../services/pdfAttendanceImportService';
import { ParsedPdfAttendanceReport } from '../services/pdfAttendanceParser';
import { setAppsScriptUrl, setRelayKey } from '../services/apiConfig';
import { AuthProvider } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';
import { FollowupLogView } from '../components/followup/FollowupLogView';
import sheetsRouter from '../../server/routes/sheets';
import { googleSheetsService } from '../../server/services/googleSheetsService';
import { signAccessToken } from '../../server/security/jwt';

const storageMap = new Map<string, string>();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v));
    },
    removeItem: (k: string) => {
      storageMap.delete(k);
    },
    clear: () => {
      storageMap.clear();
    }
  };
}

function setOnlineStatus(online: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online },
    configurable: true,
    writable: true
  });
}

async function cleanStores() {
  const db = await getIndexedDB();
  const tx = db.transaction(['students', 'mutations', 'attendance_history', 'followup'], 'readwrite');
  tx.objectStore('students').clear();
  tx.objectStore('mutations').clear();
  tx.objectStore('attendance_history').clear();
  tx.objectStore('followup').clear();
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
}

function makeStudent(overrides: Partial<Student> & { id: string; name: string }): Student {
  return {
    code: 'SG-100',
    servant: 'أ/ مينا',
    phoneStudent: '01200001111',
    phoneParent1: '',
    phoneParent2: '',
    birthDate: '2012-01-01',
    area: 'الزيتون',
    address: 'شارع طومان باي',
    notes: '',
    followupStatus: 'بدون',
    attendanceTotal: 2,
    attendanceMonth: 1,
    attendanceStatus: 'غائب',
    sourceSheet: 'نشط',
    version: 1,
    att: {},
    fu: {},
    ...overrides
  };
}

function buildMinimalFollowupContext(
  students: Student[],
  followupRecords: FollowupRecord[]
): AppContextType {
  return {
    students,
    filteredStudents: students,
    availableAlphabetBuckets: [],
    followupRecords,
    notifications: [],
    filters: {
      searchQuery: '',
      sheet: '__ALL__',
      servant: 'الكل',
      area: 'الكل',
      alphabetLetter: null
    },
    activeView: 'followup',
    isSyncing: false,
    isOnline: true,
    lastSyncError: null,
    lastSyncReport: null,
    syncState: 'synced',
    lastSyncAttemptTime: null,
    lastSuccessfulPushTime: null,
    lastSuccessfulPullTime: null,
    lastSuccessfulSyncTime: '12:00',
    lastSuccessfulSyncCompact: '12:00',
    pendingMutationsCount: 0,
    activeEditingId: null,
    hasUnsavedEditChanges: false,
    isSidebarOpen: false,
    isSidebarCollapsed: false,
    isInitialLoading: false,
    isAssistantOpen: false,
    isNotificationsOpen: false,
    notificationsActiveTab: 'feed',
    isAreaModalOpen: false,
    isAboutModalOpen: false,
    isAppearanceModalOpen: false,
    isPdfImportModalOpen: false,
    isAddModalOpen: false,
    isSyncModalOpen: false,
    isQueueModalOpen: false,
    setFilters: () => {},
    setActiveView: () => {},
    setActiveEditingId: () => {},
    setHasUnsavedEditChanges: () => {},
    requestEditStudent: () => true,
    cancelEditing: () => {},
    setIsSidebarOpen: () => {},
    setIsSidebarCollapsed: () => {},
    setIsAssistantOpen: () => {},
    setIsNotificationsOpen: () => {},
    setNotificationsActiveTab: () => {},
    setIsAreaModalOpen: () => {},
    setIsAboutModalOpen: () => {},
    setIsAppearanceModalOpen: () => {},
    setIsPdfImportModalOpen: () => {},
    setIsAddModalOpen: () => {},
    setIsSyncModalOpen: () => {},
    setIsQueueModalOpen: () => {},
    syncData: async () => true,
    markAttendance: async () => true,
    importAttendanceBatch: async () => ({
      success: true,
      appliedCount: 0,
      skippedDuplicateCount: 0,
      blockedCount: 0,
      futureBlockedCount: 0,
      queuedCount: 0
    }),
    recordFollowup: async () => true,
    updateStudent: async () => true,
    addNewStudent: async () => true,
    deleteStudent: async () => false,
    transferStudent: async () => false,
    markNotificationRead: () => {},
    markAllNotificationsRead: () => {},
    clearReadNotifications: () => {},
    addNotification: () => {},
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
      mode: 'batch',
      totalDurationMs: 0
    }),
    clearOfflineQueue: async () => ({ clearedCount: 0, verifiedEmpty: true }),
    inFlightStudentIds: [],
    syncedStudentIds: [],
    pendingStudentIds: [],
    isQueueProcessing: false,
    triggerAutoProcessQueue: async () => {},
    activeToast: null,
    dismissToast: () => {}
  };
}

async function runTests() {
  console.log('\n=================================================================');
  console.log('  🧪 St. George Follow-up Log & PDF Tab Regression Test Suite');
  console.log('=================================================================\n');

  const originalFetch = globalThis.fetch;
  setOnlineStatus(true);
  setAppsScriptUrl('https://script.google.com/macros/s/AKfycbRegressionSuite/exec');
  setRelayKey('REGRESSION_SUITE_RELAY_KEY_32_CHARS');
  clearBatchUnsupportedCache();

  try {
    // =========================================================================
    // PART 1: BUG 1 — Follow-up Log Retrieval, Arabic Normalization, Linking,
    // Notes Separation, Dedup & Detailed Report Output
    // =========================================================================

    assert.equal(
      normalizeArabicText('كريس جوزيف عاطف'),
      normalizeArabicText('كريس چوزيف عاطف'),
      'Arabic normalization must map Persian چ to Arabic ج'
    );

    const activeHeaders = [
      'كود',
      'الاسم',
      'الأشبين',
      'موبايل الطالب',
      'ولي الأمر 1',
      'ولي الأمر 2',
      'تاريخ الميلاد',
      'المنطقة',
      'العنوان',
      'ملاحظات الافتقاد',
      'آخر حضور',
      'آخر افتقاد',
      'افتقاد 2026-10-20',
      'افتقاد 2026-10-19'
    ];
    const activeDataRows: string[][] = [
      [
        'SG-301',
        'كريس چوزيف عاطف',
        'أ/ مينا',
        '01200010001',
        '',
        '',
        '2012-02-01',
        'الزيتون',
        '',
        'لا يحضر حالياً، يحتاج متابعة مستمرة',
        '2026-10-09',
        '2026-10-20',
        'تم تليفونياً — تم التواصل',
        ''
      ],
      [
        'SG-302',
        'كيفين سامح اميل عزمى',
        'أ/ مينا',
        '01200010002',
        '',
        '',
        '2012-03-01',
        'الزيتون',
        '',
        'لا يحضر بسبب الامتحانات.',
        '2026-10-02',
        '',
        '',
        ''
      ],
      [
        'SG-303',
        'كيرلس سامح ابراهيم',
        'أ/ مينا',
        '01200010003',
        '',
        '',
        '2012-04-01',
        'الزيتون',
        '',
        'يحضر في كنيسة الأمير تادرس.',
        '2026-10-02',
        '',
        '',
        ''
      ]
    ];

    const absentHeaders = [
      'كود',
      'الاسم',
      'الأشبين',
      'موبايل الطالب',
      'ولي الأمر 1',
      'ولي الأمر 2',
      'تاريخ الميلاد',
      'المنطقة',
      'العنوان',
      'ملاحظات الافتقاد',
      'آخر حضور',
      'آخر افتقاد',
      'افتقاد 2026-10-19'
    ];
    const absentDataRows: string[][] = [
      ['SG-401', 'توماس كامل يوسف فرج', 'أ/ بيتر', '01200020001', '', '', '', 'الزيتون', '', '', '', '2026-10-19', 'اتصال'],
      ['SG-402', 'كاراس أسامة سلامة', 'أ/ بيتر', '01200020002', '', '', '', 'الزيتون', '', '', '', '2026-10-19', 'اتصال'],
      ['SG-403', 'مايكل ميلاد عيد', 'أ/ بيتر', '01200020003', '', '', '', 'الزيتون', '', '', '', '2026-10-19', 'اتصال'],
      ['SG-404', 'مينا أيمن فؤاد', 'أ/ بيتر', '01200020004', '', '', '', 'الزيتون', '', '', '', '2026-10-19', 'اتصال'],
      ['SG-405', 'بافلى أيمن حسنى', 'أ/ بيتر', '01200020005', '', '', '', 'الزيتون', '', '', '', '2026-10-19', 'اتصال'],
      ['SG-406', 'ديفيد أيمن حسنى', 'أ/ بيتر', '01200020006', '', '', '', 'الزيتون', '', '', '', '2026-10-19', 'اتصال'],
      ['SG-407', 'فيلوباتير سامح سليمان', 'أ/ بيتر', '01200020007', '', '', '', 'الزيتون', '', 'لا يحضر بسبب الدروس.', '', '', ''],
      ['SG-408', 'فام ياسر أمين', 'أ/ بيتر', '01200020008', '', '', '', 'الزيتون', '', 'يحاول تنظيم مواعيد دروسه لكي يستطيع الحضور.', '', '', ''],
      ['SG-409', 'شنودة عياد', 'أ/ بيتر', '01200020009', '', '', '', 'الزيتون', '', 'لا يحضر حاليًا، لكنه يحاول العودة.', '', '', ''],
      ['SG-410', 'جونثان رامي نبيل', 'أ/ بيتر', '01200020010', '', '', '', 'الزيتون', '', 'تم افتقاده منزليًا.', '', '2026-10-19', 'تم بزيارة']
    ];

    const parsedActive = parse2DRowsToStudents(activeHeaders, activeDataRows, 'نشط');
    const parsedAbsent = parse2DRowsToStudents(absentHeaders, absentDataRows, 'غير حاضر');
    const allStudents = [...parsedActive, ...parsedAbsent];

    assert.equal(parsedActive[0].fu['2026-10-20'], 'تم تليفونياً — تم التواصل', 'Student column keeps exact followup method string');
    assert.equal(parsedActive[0].fuOutcomes?.['2026-10-20'], 'تم التواصل', 'Must preserve embedded call outcome');

    const studentLookup = new Map<string, Student>();
    allStudents.forEach((s) => {
      if (s.code) studentLookup.set(s.code.trim(), s);
      if (s.name) {
        studentLookup.set(s.name.trim(), s);
        studentLookup.set(normalizeArabicText(s.name), s);
      }
    });

    // Gviz 'سجل الافتقاد' containing overlapping + additional call records (using ج vs چ!)
    const gvizJson = {
      status: 'ok',
      table: {
        cols: [
          { label: 'التاريخ' },
          { label: 'أسبوع الجمعة' },
          { label: 'الشيت' },
          { label: 'الكود' },
          { label: 'الاسم' },
          { label: 'الأشبين' },
          { label: 'النوع' },
          { label: 'نتيجة الاتصال' },
          { label: 'ملاحظات' }
        ],
        rows: [
          {
            c: [
              { v: '2026-10-20' },
              { v: '2026-10-23' },
              { v: 'نشط' },
              { v: '' }, // Empty code tests Arabic-variant name linking!
              { v: 'كريس جوزيف عاطف' },
              { v: 'أ/ مينا' },
              { v: 'اتصال' },
              { v: 'تم التواصل' },
              { v: 'مكالمة مطمئنة ووعد بالحضور' }
            ]
          },
          {
            c: [
              { v: '2026-10-19' },
              { v: '2026-10-23' },
              { v: 'غير حاضر' },
              { v: 'SG-401' },
              { v: 'توماس كامل يوسف فرج' },
              { v: 'أ/ بيتر' },
              { v: 'تم تليفونياً' },
              { v: 'لم يتم التواصل' },
              { v: 'الموبايل مغلق' }
            ]
          }
        ]
      }
    };

    const gvizParsed = parseGoogleVisualizationFollowupLog(
      `google.visualization.Query.setResponse(${JSON.stringify(gvizJson)});`,
      studentLookup
    );
    assert.equal(gvizParsed.length, 2, 'Should parse 2 Gviz rows from سجل الافتقاد');
    const chrisFromGviz = gvizParsed.find((r) => r.studentName === 'كريس جوزيف عاطف');
    assert.ok(chrisFromGviz, 'Chris Gviz row must exist');
    assert.equal(
      chrisFromGviz!.studentId,
      parsedActive[0].id,
      'Chris Gviz row with empty code & ج must link to كريس چوزيف عاطف student.id'
    );
    assert.equal(chrisFromGviz!.studentCode, 'SG-301', 'Linked studentCode should backfill from matched student');

    const unified = buildUnifiedFollowupRecords(gvizParsed, allStudents);
    assert.equal(unified.length, 8, `Expected 8 deduplicated unified followups, got ${unified.length}`);
    assert.equal(
      unified.filter((r) => classifyFollowupMethod(r.type) === 'call').length,
      7,
      'Expected exactly 7 calls (1 on 10-20 + 6 on 10-19)'
    );
    assert.equal(
      unified.filter((r) => classifyFollowupMethod(r.type) === 'visit').length,
      1,
      'Expected exactly 1 visit (Jonathan on 10-19)'
    );

    for (const notesOnlyName of [
      'كيفين سامح اميل عزمى',
      'كيرلس سامح ابراهيم',
      'فيلوباتير سامح سليمان',
      'فام ياسر أمين',
      'شنودة عياد'
    ]) {
      const matchedRecs = unified.filter((r) => {
        const st = findStudentForFollowupRecord(r, allStudents);
        return st?.name === notesOnlyName;
      });
      assert.equal(
        matchedRecs.length,
        0,
        `Standalone note for "${notesOnlyName}" must NEVER become a synthetic followup record`
      );
    }

    await cleanStores();
    const localSyncedOnly: FollowupRecord = {
      id: 'local_fu_karas_2026_10_19',
      date: '2026-10-19',
      fridayDate: '2026-10-23',
      studentId: parsedAbsent[1].id,
      studentCode: 'SG-402',
      studentName: 'كاراس أسامة سلامة',
      servant: 'أ/ بيتر',
      type: 'اتصال',
      notes: 'تم الاطمئنان عليه'
    };
    const staleGvizRow: FollowupRecord = {
      id: 'gs_fu_99_old',
      date: '2026-09-01',
      fridayDate: '2026-09-04',
      studentId: 'old',
      studentCode: 'SG-000',
      studentName: 'قديم محذوف',
      servant: 'أ/ مينا',
      type: 'اتصال',
      notes: ''
    };
    await idbAddFollowupRecord(localSyncedOnly);
    await idbAddFollowupRecord(staleGvizRow);
    await idbSaveRemoteFollowupRecords(gvizParsed);
    const idbAfterRemote = await idbGetFollowupRecords();
    assert.ok(
      idbAfterRemote.some((r) => r.id === localSyncedOnly.id),
      'Local synced followup missing from remote log tab must be preserved'
    );
    assert.ok(
      !idbAfterRemote.some((r) => r.id === staleGvizRow.id),
      'Stale remote gs_fu_* snapshot rows not in latest Gviz response should be replaced cleanly'
    );

    const logHtml = renderToStaticMarkup(
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            AppContext.Provider,
            { value: buildMinimalFollowupContext(allStudents, gvizParsed) },
            React.createElement(FollowupLogView)
          )
        )
      )
    );

    assert.ok(logHtml.includes('كريس جوزيف عاطف'), 'FollowupLogView must render Chris call record');
    assert.ok(logHtml.includes('مكالمة مطمئنة ووعد بالحضور'), 'FollowupLogView must render recorded call notes');
    assert.ok(logHtml.includes('لا يحضر حالياً، يحتاج متابعة مستمرة'), 'FollowupLogView must display linked student note');
    assert.ok(logHtml.includes('ملاحظات المخدومين المسجلة'), 'FollowupLogView must show linked pastoral notes section');
    assert.ok(logHtml.includes('كيفين سامح اميل عزمى'), 'FollowupLogView report must include Kevin pastoral note');
    assert.ok(logHtml.includes('لا يحضر بسبب الامتحانات.'), 'FollowupLogView report must include Kevin note text');
    assert.ok(logHtml.includes('تم افتقاده منزليًا.'), 'FollowupLogView must include Jonathan visit note');
    assert.ok(logHtml.includes('اتصالات تليفونية: 7'), 'Detailed report must show 7 calls');
    assert.ok(logHtml.includes('زيارات منزلية: 1'), 'Detailed report must show 1 visit');
    assert.ok(logHtml.includes('تفاصيل سجلات الافتقاد المسجلة (8)'), 'Detailed report must list all 8 followup records');

    const extractedOutcome = extractFollowupCallOutcome('تم تليفونياً — لم يتم التواصل');
    assert.equal(extractedOutcome, 'لم يتم التواصل');

    console.log('✅ Part 1 Passed: Follow-up Log reconciliation, Arabic variants, IDB preservation & detailed reporting verified.');

    // =========================================================================
    // PART 2: BUG 2 — PDF Import `التاب مش موجود: undefined` Elimination
    // =========================================================================

    assert.equal(isValidTargetTabName('نشط'), true);
    assert.equal(isValidTargetTabName('غير حاضر'), true);
    assert.equal(isValidTargetTabName('فصل البابا شنودة'), true);
    assert.equal(isValidTargetTabName('undefined'), false);
    assert.equal(isValidTargetTabName('null'), false);
    assert.equal(isValidTargetTabName('__ALL__'), false);
    assert.equal(isValidTargetTabName(''), false);
    assert.equal(isValidTargetTabName(undefined), false);
    assert.equal(resolveValidSheetName('undefined', 'غير حاضر'), 'غير حاضر');
    assert.equal(resolveValidSheetName('__ALL__', ''), '');

    const studentsById = new Map(allStudents.map((s) => [s.id, s]));
    const brokenStudent = makeStudent({ id: 'st_broken_tab', name: 'طالب بدون تاب', sourceSheet: 'undefined' as any });
    studentsById.set(brokenStudent.id, brokenStudent);

    const blockedValidation = validateAndResolvePdfImportEntries(
      [{ studentId: brokenStudent.id, fridayDate: '2026-10-23', isPresent: true }],
      studentsById
    );
    assert.equal(blockedValidation.ok, false, 'Entries with sourceSheet="undefined" and no valid fallback must fail validation before send');
    assert.ok(blockedValidation.error && blockedValidation.error.includes('اسم التاب غير محدد'));

    const multiTabValidation = validateAndResolvePdfImportEntries(
      [
        { studentId: parsedActive[0].id, fridayDate: '2026-10-23', isPresent: true },
        { studentId: parsedAbsent[0].id, fridayDate: '2026-10-23', isPresent: false }
      ],
      studentsById
    );
    assert.equal(multiTabValidation.ok, true);
    assert.deepEqual(multiTabValidation.entries.map((e) => e.sourceSheet), ['نشط', 'غير حاضر']);
    assert.deepEqual(multiTabValidation.resolvedTabs, ['نشط', 'غير حاضر']);

    const pdfReport: ParsedPdfAttendanceReport = {
      fileName: 'october-attendance.pdf',
      pageCount: 1,
      extractionMode: 'text',
      extractedDates: [{ date: '2026-10-23', headerLabel: '2026-10-23' }],
      rows: [
        {
          rowKey: 'r1',
          pageNumber: 1,
          extractedName: 'كريس جوزيف عاطف',
          normalizedName: normalizeArabicText('كريس جوزيف عاطف'),
          extractedCode: 'SG-301',
          reportedAbsenceCount: 0,
          extractedAbsentCount: 0,
          hasAbsenceCountMismatch: false,
          matchStatus: 'exact',
          matchedStudentId: parsedActive[0].id,
          candidateStudentIds: [parsedActive[0].id],
          cells: {
            '2026-10-23': { date: '2026-10-23', rawDateHeader: '2026-10-23', rawText: 'حاضر', status: 'present' }
          }
        },
        {
          rowKey: 'r2',
          pageNumber: 1,
          extractedName: 'توماس كامل يوسف فرج',
          normalizedName: normalizeArabicText('توماس كامل يوسف فرج'),
          extractedCode: 'SG-401',
          reportedAbsenceCount: 1,
          extractedAbsentCount: 1,
          hasAbsenceCountMismatch: false,
          matchStatus: 'exact',
          matchedStudentId: parsedAbsent[0].id,
          candidateStudentIds: [parsedAbsent[0].id],
          cells: {
            '2026-10-23': { date: '2026-10-23', rawDateHeader: '2026-10-23', rawText: 'غائب', status: 'absent' }
          }
        }
      ],
      stats: {
        totalStudents: 2,
        matchedCount: 2,
        needsReviewCount: 0,
        emptyCellsCount: 0,
        unknownOrAmbiguousCellsCount: 0,
        absenceMismatchRowsCount: 0,
        perDateStats: {
          '2026-10-23': { present: 1, absent: 1, empty: 0, review: 0 }
        }
      },
      warnings: [],
      diagnostics: {
        stageReached: 'completed',
        failureStage: null,
        failureReason: null,
        pageCount: 1,
        totalTextItems: 50,
        totalRowClusters: 3,
        extractedDates: ['2026-10-23'],
        extractedStudentsCount: 2,
        presentCount: 1,
        absentCount: 1,
        emptyCount: 0,
        unknownOrAmbiguousCount: 0,
        tableDirection: 'rtl',
        issues: [],
        pages: []
      }
    };

    const plan = buildAttendanceImportPlan(pdfReport, allStudents, createInitialPdfResolutionState(), []);
    assert.equal(plan.toApply.length, 2);
    assert.equal(plan.toApply[0].sourceSheet, 'نشط');
    assert.equal(plan.toApply[1].sourceSheet, 'غير حاضر');

    const allowAll = () => ({ allowed: true });

    const batchPrepBad = prepareBatchAttendanceMutations(
      [{ studentId: brokenStudent.id, fridayDate: '2026-10-23', isPresent: true, sourceSheet: 'undefined' }],
      [...allStudents, brokenStudent],
      allowAll,
      '2026-10-24',
      'op_bad'
    );
    assert.equal(batchPrepBad.invalidSheetCount, 1);
    assert.equal(batchPrepBad.mutations.length, 0, 'Must never build mutation objects with undefined sourceSheet');

    await cleanStores();
    await idbSaveStudents(parsedActive, 'نشط', true);
    await idbSaveStudents(parsedAbsent, 'غير حاضر', true);

    const prepGood = prepareBatchAttendanceMutations(
      [
        { studentId: parsedActive[0].id, fridayDate: '2026-10-23', isPresent: true, sourceSheet: 'نشط' },
        { studentId: parsedActive[1].id, fridayDate: '2026-10-23', isPresent: true, sourceSheet: 'نشط' },
        { studentId: parsedActive[2].id, fridayDate: '2026-10-23', isPresent: true, sourceSheet: 'نشط' },
        { studentId: parsedAbsent[0].id, fridayDate: '2026-10-23', isPresent: false, sourceSheet: 'غير حاضر' }
      ],
      allStudents,
      allowAll,
      '2026-10-24',
      'pdf_op_v2'
    );
    assert.equal(prepGood.invalidSheetCount, 0);
    assert.equal(prepGood.mutations.length, 4);
    for (const m of prepGood.mutations) {
      await idbQueueMutation(m);
    }

    const capturedPayloads: any[] = [];
    clearBatchUnsupportedCache();
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      capturedPayloads.push(body);

      // Replicate LIVE "notes-v2" validation behavior: checks body.sheet FIRST before action!
      const incomingSheet = body.sheet;
      if (!incomingSheet || incomingSheet === 'undefined' || !['نشط', 'غير حاضر'].includes(incomingSheet)) {
        return new Response(
          JSON.stringify({ ok: false, error: `التاب مش موجود: ${String(incomingSheet)}` }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (body.action === 'batch') {
        return new Response(
          JSON.stringify({ ok: false, status: 400, error: 'action غير معروف' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (body.action === 'attendance') {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            mutationId: body.idempotencyKey,
            newVersion: (body.expectedVersion || 1) + 1,
            proof: {
              mutationId: body.idempotencyKey,
              persisted: true,
              operation: 'attendance',
              studentId: body.studentId,
              friday: body.friday || body.date,
              sheetName: incomingSheet,
              row: 8,
              newVersion: (body.expectedVersion || 1) + 1
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const reportV2 = await executeProcessOfflineQueue(null);
    assert.equal(reportV2.sentCount, 4, 'Live notes-v2 batch->single fallback must succeed for all 4 multi-sheet students');
    assert.equal(reportV2.failedCount, 0, `Expected zero failures under notes-v2 simulation, got ${reportV2.lastError}`);
    assert.ok(
      capturedPayloads.every((p) => typeof p.sheet === 'string' && p.sheet !== 'undefined' && p.sheet.length > 0),
      'Every fetch payload (batch AND single) must carry non-empty valid top-level sheet'
    );
    assert.ok(
      capturedPayloads.some((p) => p.action === 'batch' && p.sheet === 'نشط'),
      'Batch request must include top-level sheet'
    );
    assert.ok(
      capturedPayloads.some((p) => p.action === 'attendance' && p.sheet === 'غير حاضر'),
      'Absent-sheet student attendance write must target غير حاضر'
    );

    await idbClearMutations();
    let fetchCalledForCorruptQueue = false;
    globalThis.fetch = (async () => {
      fetchCalledForCorruptQueue = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const corruptMut: OfflineMutation = {
      id: 'corrupt_mut_1',
      action: 'attendance',
      studentId: parsedActive[0].id,
      studentCode: parsedActive[0].code,
      studentName: parsedActive[0].name,
      sourceSheet: 'undefined' as any,
      payload: { friday: '2026-10-23', isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending'
    };
    await idbQueueMutation(corruptMut);
    const corruptReport = await executeProcessOfflineQueue(null);
    assert.equal(fetchCalledForCorruptQueue, false, 'Pre-send guard must NOT send fetch when queue item sourceSheet is undefined');
    assert.equal(corruptReport.failedCount, 1);
    const remainingPending = await idbGetPendingMutations();
    assert.equal(remainingPending[0].status, 'failed');

    googleSheetsService.seedTestFixtureStudentsOnly(allStudents);
    const adminUser: AuthUser = {
      userId: 'admin_test',
      username: 'admin',
      displayName: 'أمين الخدمة',
      role: 'admin'
    };
    const token = signAccessToken(adminUser);
    const app = express();
    app.use(express.json());
    app.use('/api/sheets', sheetsRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    globalThis.fetch = originalFetch;

    try {
      const mutateBadResp = await originalFetch(`${baseUrl}/api/sheets/mutate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Idempotency-Key': 'k_bad_tab_1'
        },
        body: JSON.stringify({
          action: 'attendance',
          studentId: parsedActive[0].id,
          sourceSheet: 'undefined',
          expectedVersion: 1,
          payload: { friday: '2026-10-23', isPresent: true }
        })
      });
      assert.equal(mutateBadResp.status, 400, '/mutate must reject sourceSheet="undefined" with 400');

      const batchBadResp = await originalFetch(`${baseUrl}/api/sheets/mutate-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          mutations: [
            {
              idempotencyKey: 'k_batch_bad_1',
              action: 'attendance',
              studentId: parsedActive[0].id,
              sourceSheet: '__ALL__',
              expectedVersion: 1,
              payload: { friday: '2026-10-23', isPresent: true }
            }
          ]
        })
      });
      const batchBadJson = (await batchBadResp.json()) as any;
      assert.equal(batchBadJson.results[0].ok, false);
      assert.equal(batchBadJson.results[0].status, 400, '/mutate-batch item with __ALL__ tab must fail validation with 400');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const codeGs = fs.readFileSync(path.resolve(process.cwd(), 'docs/google-apps-script/Code.gs'), 'utf-8');
    assert.ok(codeGs.includes('function normalizeArabicForMatch'), 'Code.gs must include normalizeArabicForMatch');
    assert.ok(codeGs.includes('topBody.sheet'), 'Code.gs processBatchMutations must include topBody.sheet fallback');
    assert.ok(!codeGs.includes('?.'), 'Code.gs must stay strict ES5');

    console.log('✅ Part 2 Passed: PDF tab resolution, notes-v2 batch sheet header, Express & Code.gs guards verified.');
  } finally {
    globalThis.fetch = originalFetch;
    await idbClearMutations().catch(() => {});
  }
}

runTests().catch((err) => {
  console.error('❌ Follow-up Log & PDF Tab Regression Suite Failed:', err);
  process.exit(1);
});
