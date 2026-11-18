import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { AuthProvider } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';
import { AppProvider, normalizeStudentRecord, prepareBatchAttendanceMutations } from '../context/AppContext';
import { StudentCard } from '../components/cards/StudentCard';
import { QuickFollowupModal } from '../components/modals/QuickFollowupModal';
import { AssistantModal } from '../components/modals/AssistantModal';
import { FollowupLogView } from '../components/followup/FollowupLogView';
import { parseGoogleVisualizationFollowupLog } from '../services/googleSheetParser';
import {
  idbAtomicBatchRecordAttendanceWithMutations,
  idbAtomicRecordFollowupWithMutation,
  idbClearMutations,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbGetStudents,
  idbRemoveMutation,
  idbSaveStudents
} from '../services/indexedDbService';
import {
  AssistantIntentEngine,
  AssistantMessage,
  detectAssistantIntent,
  prepareVerifiedAssistantAttendanceBatch,
  processAssistantQuery
} from '../services/assistantEngine';
import { createFreshAssistantSession } from '../services/assistantSessionService';
import { getLatestHeldFridayString, getNearestFridayString } from '../utils/arabicUtils';

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

function makeStudent(overrides: Partial<Student> & { id: string; name: string }): Student {
  return {
    code: 'SG-100',
    servant: 'ماركو',
    phoneStudent: '01200001111',
    phoneParent1: '',
    phoneParent2: '',
    birthDate: '2013-05-10',
    area: 'الزيتون',
    address: 'شارع طومان باي',
    notes: '',
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

async function runTests() {
  console.log('======================================================');
  console.log('  🧪 Running Comprehensive Fixes & Assistant 5-Domain Suite');
  console.log('======================================================\n');

  // --------------------------------------------------------------------------
  // PART 1: Text Selection & Android Long-Press Context Menu Guard
  // --------------------------------------------------------------------------
  const indexCss = readProjectFile('src/index.css');
  assert(
    indexCss.includes('-webkit-user-select: none') &&
      indexCss.includes('user-select: none') &&
      indexCss.includes('-webkit-touch-callout: none'),
    'P1a: Global body CSS disables read-only text selection and iOS/Android callout'
  );
  assert(
    indexCss.includes('input:not([type="checkbox"])') &&
      indexCss.includes('textarea,') &&
      indexCss.includes('select,') &&
      indexCss.includes('.selectable-text') &&
      indexCss.includes('-webkit-user-select: text !important') &&
      indexCss.includes('user-select: text !important'),
    'P1b: Form controls & explicit selectable containers remain fully selectable and editable'
  );

  const appTsx = readProjectFile('src/App.tsx');
  assert(
    appTsx.includes("addEventListener('contextmenu'") &&
      appTsx.includes('.selectable-text') &&
      appTsx.includes('e.preventDefault()'),
    'P1c: App.tsx installs read-only contextmenu suppression while exempting inputs & selectable-text'
  );
  console.log('✅ Part 1 Passed: Text Selection CSS & ContextMenu Guard verified');

  // --------------------------------------------------------------------------
  // PART 2: Card Data Rendering on First Load (No Edit-Mode Toggle Needed)
  // --------------------------------------------------------------------------
  const refDate = new Date(2026, 10, 14); // Saturday Nov 14, 2026
  const latestFriday = getLatestHeldFridayString(refDate); // 2026-11-13
  const prevFriday = '2026-11-06';
  const fuWeek = getNearestFridayString(refDate); // 2026-11-13

  const renderedStudent = makeStudent({
    id: 'card_1',
    code: 'SG-501',
    name: 'أبانوب مجدي جرجس',
    servant: 'أ/ مينا',
    area: 'حلمية الزيتون',
    attendanceTotal: 9,
    attendanceMonth: 3,
    att: { [latestFriday]: true },
    fu: { [fuWeek]: 'تم تليفونياً' },
    fuOutcomes: { [fuWeek]: 'تم التواصل' },
    lastCallOutcome: 'تم التواصل'
  });

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
            student: renderedStudent,
            onOpenFollowup: () => {},
            onOpenEdit: () => {}
          })
        )
      )
    )
  );

  assert(cardHtml.includes('أبانوب مجدي جرجس'), 'P2a: Card SSR renders student name immediately on first mount');
  assert(cardHtml.includes('SG-501'), 'P2b: Card SSR renders student code immediately');
  assert(cardHtml.includes('حلمية الزيتون'), 'P2c: Card SSR renders student area immediately');
  assert(cardHtml.includes('أ/ مينا'), 'P2d: Card SSR renders servant immediately');
  assert(cardHtml.includes('تم التواصل'), 'P2e: Card SSR displays follow-up call outcome badge');
  assert(!cardHtml.includes('perspective-1000 overflow-x-clip'), 'P2f: 3D perspective container no longer clips/flattens front face');
  assert(cardHtml.includes('opacity-100 pointer-events-auto relative z-10'), 'P2g: Front face explicitly asserts visible opacity-100 and z-10');

  const normalizedSparse = normalizeStudentRecord({ id: 'sparse_1', name: 'كيرلس', servant: '  ', area: '' });
  assert.strictEqual(normalizedSparse.servant, 'غير محدد', 'P2h: normalizeStudentRecord sets safe servant fallback');
  assert.strictEqual(normalizedSparse.area, 'غير محددة', 'P2i: normalizeStudentRecord sets safe area fallback');
  assert.deepStrictEqual(normalizedSparse.att, {}, 'P2j: normalizeStudentRecord ensures att map is initialized');
  console.log('✅ Part 2 Passed: Card Data Rendering on first load & normalization verified');

  // --------------------------------------------------------------------------
  // PART 3: Follow-up Call Outcome (نتيجة الاتصال) UI, Storage, Queue & Sheet Sync
  // --------------------------------------------------------------------------
  const quickModalHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          AppProvider,
          null,
          React.createElement(QuickFollowupModal, {
            isOpen: true,
            onClose: () => {},
            student: renderedStudent
          })
        )
      )
    )
  );
  assert(quickModalHtml.includes('اتصال تليفوني'), 'P3a: QuickFollowupModal labels phone call as اتصال تليفوني');
  assert(quickModalHtml.includes('نتيجة الاتصال'), 'P3b: QuickFollowupModal renders نتيجة الاتصال section for phone call');
  assert(
    quickModalHtml.includes('تم التواصل') && quickModalHtml.includes('لم يتم التواصل'),
    'P3c: QuickFollowupModal renders both call outcome options'
  );

  // Verify IndexedDB atomic write separates method from callOutcome and queues it for sync
  await idbSaveStudents([renderedStudent], 'نشط', true);
  const newFuRecord: FollowupRecord = {
    id: 'fu_call_test_1',
    date: '2026-11-14',
    fridayDate: fuWeek,
    studentId: renderedStudent.id,
    studentCode: renderedStudent.code,
    studentName: renderedStudent.name,
    servant: renderedStudent.servant,
    type: 'تم تليفونياً',
    callOutcome: 'لم يتم التواصل',
    notes: 'مغلق'
  };
  const updatedWithOutcome: Student = {
    ...renderedStudent,
    followupStatus: 'تم تليفونياً',
    fu: { ...renderedStudent.fu, [fuWeek]: 'تم تليفونياً' },
    fuOutcomes: { [fuWeek]: 'لم يتم التواصل' },
    lastCallOutcome: 'لم يتم التواصل',
    version: 2
  };
  const mutId = 'FU_call_outcome_test_1';
  await idbAtomicRecordFollowupWithMutation(updatedWithOutcome, newFuRecord, {
    id: mutId,
    action: 'followup',
    studentId: renderedStudent.id,
    studentCode: renderedStudent.code,
    studentName: renderedStudent.name,
    sourceSheet: 'نشط',
    payload: { friday: fuWeek, method: 'تم تليفونياً', callOutcome: 'لم يتم التواصل', recordId: newFuRecord.id },
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    status: 'pending'
  });

  const savedFus = await idbGetFollowupRecords();
  const foundFu = savedFus.find((r) => r.id === newFuRecord.id);
  assert(foundFu?.type === 'تم تليفونياً' && foundFu?.callOutcome === 'لم يتم التواصل', 'P3d: IndexedDB persists method and callOutcome separately');

  const pendingMuts = await idbGetPendingMutations();
  const foundMut = pendingMuts.find((m) => m.id === mutId);
  assert(foundMut?.payload?.callOutcome === 'لم يتم التواصل', 'P3e: Offline queue payload carries callOutcome for Google Sheets sync');
  await idbRemoveMutation(mutId);

  // Verify Gviz parser extracts نتيجة الاتصال cleanly AND keeps legacy rows as undefined (never fabricated)
  const gvizPayload = `google.visualization.Query.setResponse(${JSON.stringify({
    status: 'ok',
    table: {
      cols: [
        { label: 'التاريخ' },
        { label: 'أسبوع الجمعة' },
        { label: 'الكود' },
        { label: 'الاسم' },
        { label: 'الأشبين' },
        { label: 'النوع' },
        { label: 'ملاحظات' },
        { label: 'نتيجة الاتصال' }
      ],
      rows: [
        { c: [{ v: '2026-11-10' }, { v: '2026-11-13' }, { v: 'SG-501' }, { v: 'أبانوب مجدي جرجس' }, { v: 'أ/ مينا' }, { v: 'تم تليفونياً' }, { v: 'اتصال قديم' }, null] },
        { c: [{ v: '2026-11-14' }, { v: '2026-11-13' }, { v: 'SG-501' }, { v: 'أبانوب مجدي جرجس' }, { v: 'أ/ مينا' }, { v: 'تم تليفونياً' }, { v: 'رد' }, { v: 'تم التواصل' }] }
      ]
    }
  })});`;

  const parsedFus = parseGoogleVisualizationFollowupLog(gvizPayload);
  assert.strictEqual(parsedFus.length, 2, 'P3f: Gviz follow-up log parses both legacy and new rows');
  assert.strictEqual(parsedFus[0].callOutcome, 'تم التواصل', 'P3g: Gviz parses explicit callOutcome');
  assert.strictEqual(parsedFus[1].callOutcome, undefined, 'P3h: Legacy Gviz row without نتيجة الاتصال stays undefined (never guessed)');

  // Verify FollowupLogView & Apps Script / Express code
  const fuViewSrc = readProjectFile('src/components/followup/FollowupLogView.tsx');
  assert(fuViewSrc.includes("r.callOutcome || 'غير مسجل'"), 'P3i: FollowupLogView renders legacy fallback غير مسجل explicitly');
  const codeGsSrc = readProjectFile('docs/google-apps-script/Code.gs');
  assert(codeGsSrc.includes('نتيجة الاتصال') && codeGsSrc.includes('callOutcome'), 'P3j: Code.gs reads and writes نتيجة الاتصال column cleanly');
  const routesSrc = readProjectFile('server/routes/sheets.ts');
  assert(routesSrc.includes('lastCallOutcome') && routesSrc.includes('fuOutcomes'), 'P3k: Express sheets route persists callOutcome cleanly');
  console.log('✅ Part 3 Passed: Follow-up Call Outcomes UI, IDB, Queue, FollowupLog, Gviz, Express & Code.gs verified');

  // --------------------------------------------------------------------------
  // PART 4: Smart Assistant Intelligence Upgrade — Five Data Domains
  // --------------------------------------------------------------------------
  const s1 = makeStudent({
    id: 'ast_1',
    code: 'SG-101',
    name: 'كيرلس أشرف',
    servant: 'ماركو',
    sourceSheet: 'نشط',
    phoneStudent: '01211111111',
    attendanceMonth: 4,
    attendanceTotal: 15,
    att: { [prevFriday]: true, [latestFriday]: true },
    fu: { [fuWeek]: 'تم تليفونياً' },
    fuOutcomes: { [fuWeek]: 'تم التواصل' },
    lastCallOutcome: 'تم التواصل'
  });
  const s2 = makeStudent({
    id: 'ast_2',
    code: 'SG-102',
    name: 'بيشوي هاني',
    servant: 'ماركو',
    sourceSheet: 'نشط',
    phoneStudent: '',
    phoneParent1: '',
    phoneParent2: '',
    birthDate: '',
    area: 'غير محددة',
    attendanceMonth: 1,
    attendanceTotal: 3,
    att: { [prevFriday]: true, [latestFriday]: false },
    fu: { [fuWeek]: 'تم تليفونياً' },
    fuOutcomes: { [fuWeek]: 'لم يتم التواصل' },
    lastCallOutcome: 'لم يتم التواصل'
  });
  const s3 = makeStudent({
    id: 'ast_3',
    code: 'SG-103',
    name: 'فادي مجدي',
    servant: 'يوسف',
    sourceSheet: 'فصل البابا شنودة',
    phoneStudent: '01233333333',
    attendanceMonth: 0,
    attendanceTotal: 1,
    att: { [prevFriday]: false, [latestFriday]: false },
    fu: {}
  });
  const s4 = makeStudent({
    id: 'ast_4',
    code: 'SG-104',
    name: 'مينا سمير', // Duplicate name intentionally tested against s5
    servant: 'يوسف',
    sourceSheet: 'نشط',
    phoneStudent: '01244444444',
    attendanceMonth: 2,
    attendanceTotal: 6,
    att: { [prevFriday]: true }, // NOT recorded on latestFriday!
    fu: {}
  });
  const s5 = makeStudent({
    id: 'ast_5',
    code: 'SG-202',
    name: 'مينا سمير', // Different studentId & code, same name!
    servant: 'ماركو',
    sourceSheet: 'غير حاضر',
    phoneStudent: '01255555555',
    attendanceMonth: 1,
    attendanceTotal: 2,
    att: {}, // Unrecorded on both dates!
    fu: { '2026-11-06': 'واتساب' }
  });

  const astStudents = [s1, s2, s3, s4, s5];
  const astLogs: FollowupRecord[] = [
    {
      id: 'log_1',
      date: '2026-11-14',
      fridayDate: fuWeek,
      studentId: s1.id,
      studentCode: s1.code,
      studentName: s1.name,
      servant: s1.servant,
      type: 'تم تليفونياً',
      callOutcome: 'تم التواصل',
      notes: 'بخير'
    },
    {
      id: 'log_2',
      date: '2026-11-14',
      fridayDate: fuWeek,
      studentId: s2.id,
      studentCode: s2.code,
      studentName: s2.name,
      servant: s2.servant,
      type: 'تم تليفونياً',
      callOutcome: 'لم يتم التواصل',
      notes: 'لم يرد'
    },
    {
      id: 'log_3',
      date: '2026-11-07',
      fridayDate: prevFriday,
      studentId: s1.id,
      studentCode: s1.code,
      studentName: s1.name,
      servant: s1.servant,
      type: 'تم تليفونياً',
      notes: 'مكالمة أقدم بدون نتيجة مسجلة' // legacy row
    },
    {
      id: 'log_4',
      date: '2026-11-06',
      fridayDate: prevFriday,
      studentId: s5.id,
      studentCode: s5.code,
      studentName: s5.name,
      servant: s5.servant,
      type: 'واتساب',
      notes: 'تم الإرسال'
    }
  ];

  // A & B. Domain 1 (Attendance) — highest-priority unrecorded attendance check
  for (const unrecPrompt of [
    'هات الأسماء اللي لم تسجل حضور أو غياب',
    'مين لسه متسجلش؟',
    'هات الأسماء اللي مش موجودة في كشف الحضور',
    'كام واحد لسه من غير تسجيل؟'
  ]) {
    assert.strictEqual(detectAssistantIntent(unrecPrompt), 'attendance_unrecorded', `Intent unrecorded: ${unrecPrompt}`);
    const res = processAssistantQuery(unrecPrompt, astStudents, { referenceDate: refDate, followupRecords: astLogs });
    assert(!res.text.includes('لتسجيل الحضور: اضغط'), `Must NEVER return FAQ instructions for: ${unrecPrompt}`);
    assert(res.text.includes('SG-104') && res.text.includes('SG-202'), `Returns both unrecorded students cleanly for: ${unrecPrompt}`);
    assert(!res.text.includes('كيرلس أشرف') && !res.text.includes('بيشوي هاني'), `Excludes recorded present/absent students for: ${unrecPrompt}`);
    assert(res.text.includes(latestFriday), `Includes target Friday date for: ${unrecPrompt}`);
  }

  // Attendance comparison & percentage
  const pctRes = processAssistantQuery('نسبة الحضور كام؟', astStudents, { referenceDate: refDate });
  assert(pctRes.text.includes('33%') && pctRes.text.includes('20%'), 'Domain 1: Percentage shows recorded-only rate (1/3 = 33%) AND overall rate (1/5 = 20%)');

  const cmpRes = processAssistantQuery('قارن آخر جمعتين', astStudents, { referenceDate: refDate });
  assert(cmpRes.text.includes(prevFriday) && cmpRes.text.includes(latestFriday), 'Domain 1: Comparison compares both held Fridays');

  // Ambiguous bare "مين محضرش؟" clarifies vs dated "مين محضرش الجمعة اللي فاتت؟"
  const bareAbsent = processAssistantQuery('مين محضرش؟', astStudents, { referenceDate: refDate });
  assert(bareAbsent.text.includes('تقصد الغائبين المسجلين، ولا الأسماء اللي لسه ما سجلتش حضور أو غياب'), 'Domain 1 Ambiguity: Bare محضرش prompts clean clarification');

  // Domain 2 (Follow-up & Call Outcomes)
  const contactedRes = processAssistantQuery('مين تم التواصل معاه؟', astStudents, { referenceDate: refDate, followupRecords: astLogs });
  assert(contactedRes.text.includes('كيرلس أشرف') && !contactedRes.text.includes('بيشوي هاني'), 'Domain 2: Filters تم التواصل strictly');

  const notContactedRes = processAssistantQuery('مين محدش رد عليه؟', astStudents, { referenceDate: refDate, followupRecords: astLogs });
  assert(notContactedRes.text.includes('بيشوي هاني') && !notContactedRes.text.includes('كيرلس أشرف'), 'Domain 2: Filters لم يتم التواصل strictly');

  const callsRes = processAssistantQuery('مين اتصلنا بيه؟', astStudents, { referenceDate: refDate, followupRecords: astLogs });
  assert(callsRes.text.includes('تم التواصل') && callsRes.text.includes('لم يتم التواصل') && callsRes.text.includes('غير مسجل'), 'Domain 2: Call logs preserve exact outcome & legacy غير مسجل');

  const multiFuRes = processAssistantQuery('مين اتعمله افتقاد أكتر من مرة؟', astStudents, { referenceDate: refDate, followupRecords: astLogs });
  assert(multiFuRes.text.includes('كيرلس أشرف') && !multiFuRes.text.includes('SG-104'), 'Domain 2: Multiple follow-ups count by studentId without merging duplicate names');

  // Domain 3 (Students Data)
  const missingPhonesRes = processAssistantQuery('مين ما عندوش رقم تليفون؟', astStudents, { referenceDate: refDate });
  assert(missingPhonesRes.text.includes('بيشوي هاني') && !missingPhonesRes.text.includes('كيرلس أشرف'), 'Domain 3: Identifies student missing all phone numbers');

  const missingDataRes = processAssistantQuery('مين بياناته ناقصة؟', astStudents, { referenceDate: refDate });
  assert(missingDataRes.text.includes('بيشوي هاني') && missingDataRes.text.includes('تاريخ الميلاد'), 'Domain 3: Identifies exact missing fields per student');

  // Domain 4 (Stats & General Report)
  const reportRes = processAssistantQuery('اعرض ملخص الخدمة', astStudents, { referenceDate: refDate, followupRecords: astLogs });
  assert(reportRes.text.includes('إجمالي: 5') && reportRes.text.includes('تم التواصل (1)') && reportRes.text.includes('لم يتم التواصل (1)'), 'Domain 4: Comprehensive report aggregates all domains');

  // Domain 5 (Classes & Categories)
  const babaStudentsRes = processAssistantQuery('مين في فصل البابا شنودة؟', astStudents, { referenceDate: refDate });
  assert(babaStudentsRes.text.includes('فادي مجدي') && !babaStudentsRes.text.includes('كيرلس أشرف'), 'Domain 5: Dynamic class query returns real members only');

  const unknownClassRes = processAssistantQuery('مين في فصل القديس أثناسيوس؟', astStudents, { referenceDate: refDate });
  assert(unknownClassRes.text.includes('غير موجود') && unknownClassRes.text.includes('فصل البابا شنودة'), 'Domain 5: Nonexistent class responds honestly and lists real classes');

  const classCompareRes = processAssistantQuery('قارن بين الفصول', astStudents, { referenceDate: refDate });
  assert(classCompareRes.text.includes('نشط') && classCompareRes.text.includes('فصل البابا شنودة') && classCompareRes.text.includes('غير حاضر'), 'Domain 5: Compares all real classes dynamically');

  // C. Multi-turn intra-session context resolution
  const sessionLog: AssistantMessage[] = [
    { id: 'u1', role: 'user', text: 'مين غاب آخر جمعة؟', timestamp: 1 }
  ];
  const turn1 = processAssistantQuery('مين غاب آخر جمعة؟', astStudents, {
    referenceDate: refDate,
    followupRecords: astLogs,
    sessionMessages: sessionLog
  });
  assert(turn1.text.includes('بيشوي هاني') && turn1.text.includes('فادي مجدي'), 'Context Turn 1: Lists absent students (s2, s3)');

  sessionLog.push({ id: 'b1', role: 'bot', text: turn1.text, meta: turn1.meta, timestamp: 2 });
  sessionLog.push({ id: 'u2', role: 'user', text: 'مين فيهم اتعمله افتقاد؟', timestamp: 3 });

  const turn2 = processAssistantQuery('مين فيهم اتعمله افتقاد؟', astStudents, {
    referenceDate: refDate,
    followupRecords: astLogs,
    sessionMessages: sessionLog
  });
  assert(turn2.text.includes('بيشوي هاني') && !turn2.text.includes('كيرلس أشرف') && !turn2.text.includes('فادي مجدي'), 'Context Turn 2: Filters ONLY absent cohort who got follow-up');

  sessionLog.push({ id: 'b2', role: 'bot', text: turn2.text, meta: turn2.meta, timestamp: 4 });
  sessionLog.push({ id: 'u3', role: 'user', text: 'مين من الأسماء دي ما اتعملوش افتقاد؟', timestamp: 5 });

  const turn3 = processAssistantQuery('مين من الأسماء دي ما اتعملوش افتقاد؟', astStudents, {
    referenceDate: refDate,
    followupRecords: astLogs,
    sessionMessages: sessionLog
  });
  assert(turn3.text.includes('فادي مجدي') && !turn3.text.includes('كيرلس أشرف'), 'Context Turn 3: Sibling query resolves missing follow-up in absent cohort without leaking s1');

  // Engine export smoke test
  assert.strictEqual(AssistantIntentEngine.detectIntent('هات الأسماء اللي لم تسجل حضور أو غياب'), 'attendance_unrecorded');

  console.log('✅ Part 4 Passed: Smart Assistant 5 Domains, Duplicate-Name Safety, Multi-Turn Context & Ambiguity verified');

  // --------------------------------------------------------------------------
  // PART 5: Unrecorded Attendance (20 Present / 11 Unrecorded / Explicit Absent),
  //         Multi-Turn Context, Bulk & Individual Pre-Save Confirmation & Queue Safety
  // --------------------------------------------------------------------------
  const p5Present: Student[] = Array.from({ length: 20 }, (_, i) =>
    makeStudent({
      id: `p5_p_${i + 1}`,
      code: `SG-3${String(i + 1).padStart(2, '0')}`,
      name: `حاضر_${i + 1}`,
      servant: 'ماركو',
      sourceSheet: 'نشط',
      att: { [latestFriday]: true }
    })
  );
  const p5Unrecorded: Student[] = Array.from({ length: 11 }, (_, i) =>
    makeStudent({
      id: `p5_u_${i + 1}`,
      code: `SG-4${String(i + 1).padStart(2, '0')}`,
      name: `ناقص_${i + 1}`,
      servant: 'ماركو',
      sourceSheet: 'نشط',
      att: { [prevFriday]: true } // Unrecorded on latestFriday!
    })
  );
  const p5Absent: Student[] = Array.from({ length: 3 }, (_, i) =>
    makeStudent({
      id: `p5_a_${i + 1}`,
      code: `SG-5${String(i + 1).padStart(2, '0')}`,
      name: `غايب_${i + 1}`,
      servant: 'ماركو',
      sourceSheet: 'نشط',
      att: { [latestFriday]: false }
    })
  );
  const p5Inactive: Student[] = Array.from({ length: 2 }, (_, i) =>
    makeStudent({
      id: `p5_in_${i + 1}`,
      code: `SG-9${String(i + 1).padStart(2, '0')}`,
      name: `غير_نشط_${i + 1}`,
      servant: 'ماركو',
      sourceSheet: 'غير نشط',
      att: {}
    })
  );
  const p5Students = [...p5Present, ...p5Unrecorded, ...p5Absent, ...p5Inactive];

  // 5A. Turn 1: "مين اللي حضر؟"
  const attSession: AssistantMessage[] = [{ id: 'p5_u1', role: 'user', text: 'مين اللي حضر؟', timestamp: 1 }];
  const presentTurn = processAssistantQuery('مين اللي حضر؟', p5Students, {
    referenceDate: refDate,
    selectedFridayDate: latestFriday,
    sessionMessages: attSession
  });
  assert(
    presentTurn.text.includes('20') &&
      presentTurn.text.includes('11') &&
      !presentTurn.text.includes('ناقص_1') &&
      !presentTurn.text.includes('غير_نشط_1'),
    'P5A: Present query counts exact 20 recorded, mentions 11 unrecorded, excludes inactive'
  );
  attSession.push({ id: 'p5_b1', role: 'bot', text: presentTurn.text, meta: presentTurn.meta, timestamp: 2 });

  // 5B. Turn 2: Direct + Contextual unrecorded attendance queries (must never fall through to search/faq)
  const unrecVariations = [
    'مين اللي لم يسجل بعد؟',
    'مين اللي ناقص تسجيله؟',
    'مين اللي لسه متسجلش؟',
    'اعرض اللي حضورهم مش متسجل',
    'مين اللي فاضل؟'
  ];
  let lastUnrecRes = presentTurn;
  for (const q of unrecVariations) {
    assert.strictEqual(
      detectAssistantIntent(q, presentTurn.meta),
      'attendance_unrecorded',
      `P5B: Intent detects attendance_unrecorded cleanly for "${q}"`
    );
    const res = processAssistantQuery(q, p5Students, {
      referenceDate: refDate,
      selectedFridayDate: latestFriday,
      sessionMessages: [...attSession, { id: 'uq', role: 'user', text: q, timestamp: 3 }]
    });
    assert.strictEqual(res.meta?.unrecordedStudentIds?.length, 11, `P5B: Exact 11 unrecorded IDs for "${q}"`);
    assert.strictEqual(res.meta?.interactiveAttendance?.targetFriday, latestFriday, `P5B: Target Friday preserved for "${q}"`);
    for (const u of p5Unrecorded) {
      assert(res.text.includes(u.name), `P5B: Lists unrecorded ${u.name} for "${q}"`);
    }
    assert(!res.text.includes('حاضر_1') && !res.text.includes('غايب_1') && !res.text.includes('غير_نشط_1'), `P5B: Excludes present/absent/inactive for "${q}"`);
    assert(!res.command, `P5B: ZERO writes performed while listing unrecorded students for "${q}"`);
    assert(
      res.actions?.some((a) => a.label === 'تسجيل الكل حضور') &&
        res.actions?.some((a) => a.label === 'تسجيل الكل غياب'),
      `P5B: Presents interactive bulk present & absent options for "${q}"`
    );
    lastUnrecRes = res;
  }

  // 5C. Absent query must strictly exclude unrecorded students
  const absentStrictRes = processAssistantQuery('مين الغايب؟', p5Students, {
    referenceDate: refDate,
    selectedFridayDate: latestFriday
  });
  assert(
    absentStrictRes.text.includes('غايب_1') &&
      absentStrictRes.text.includes('غايب_3') &&
      !absentStrictRes.text.includes('ناقص_1') &&
      !absentStrictRes.text.includes('غير_نشط_1'),
    'P5C: Absent query returns strictly explicit false attendance and never mixes unrecorded'
  );

  // 5D. Conversational Bulk Prepare ("تسجيل الكل حضور" / "خليهم حضور") -> Pre-confirmation only (NO write command)
  const bulkSession: AssistantMessage[] = [
    ...attSession,
    { id: 'p5_u2', role: 'user', text: 'مين اللي لم يسجل بعد؟', timestamp: 3 },
    { id: 'p5_b2', role: 'bot', text: lastUnrecRes.text, meta: lastUnrecRes.meta, timestamp: 4 }
  ];
  const prepPresent = processAssistantQuery('خليهم حضور', p5Students, {
    referenceDate: refDate,
    selectedFridayDate: latestFriday,
    sessionMessages: [...bulkSession, { id: 'p5_u3', role: 'user', text: 'خليهم حضور', timestamp: 5 }]
  });
  assert.strictEqual(prepPresent.meta?.intent, 'attendance_bulk_prepare', 'P5D: "خليهم حضور" triggers confirmation preparation');
  assert.strictEqual(prepPresent.meta?.pendingBulkAttendance?.isPresent, true, 'P5D: Pending state captures present=true');
  assert.strictEqual(prepPresent.meta?.pendingBulkAttendance?.studentIds.length, 11, 'P5D: Pending state includes exact 11 students');
  assert(!prepPresent.command, 'P5D: Zero DB write command before explicit confirmation');

  const prepAbsent = processAssistantQuery('تسجيل الكل غياب', p5Students, {
    referenceDate: refDate,
    selectedFridayDate: latestFriday,
    sessionMessages: [...bulkSession, { id: 'p5_u3b', role: 'user', text: 'تسجيل الكل غياب', timestamp: 5 }]
  });
  assert.strictEqual(prepAbsent.meta?.intent, 'attendance_bulk_prepare', 'P5D: "تسجيل الكل غياب" triggers confirmation preparation');
  assert.strictEqual(prepAbsent.meta?.pendingBulkAttendance?.isPresent, false, 'P5D: Pending state captures present=false');
  assert(!prepAbsent.command, 'P5D: Zero DB write command before explicit confirmation for absent');

  // 5E. Simulate 1 of 11 students recorded in live DB BEFORE user confirms -> Confirmation re-checks live state!
  const p5StudentsAfterExternalUpdate = p5Students.map((s) =>
    s.id === 'p5_u_1' ? { ...s, att: { ...s.att, [latestFriday]: true }, attendanceStatus: 'حاضر' as const } : s
  );
  const confirmBulk = processAssistantQuery('تأكيد', p5StudentsAfterExternalUpdate, {
    referenceDate: refDate,
    selectedFridayDate: latestFriday,
    sessionMessages: [
      ...bulkSession,
      { id: 'p5_u3', role: 'user', text: 'تسجيل الكل حضور', timestamp: 5 },
      { id: 'p5_b3', role: 'bot', text: prepPresent.text, meta: prepPresent.meta, timestamp: 6 },
      { id: 'p5_u4', role: 'user', text: 'تأكيد', timestamp: 7 }
    ]
  });
  assert.strictEqual(confirmBulk.meta?.intent, 'attendance_bulk_confirm', 'P5E: Confirmation triggers attendance_bulk_confirm');
  assert.strictEqual(confirmBulk.command?.type, 'markAttendanceBatch', 'P5E: Emits markAttendanceBatch command on confirm');
  if (confirmBulk.command?.type === 'markAttendanceBatch') {
    assert.strictEqual(confirmBulk.command.entries.length, 10, 'P5E: Excludes student p5_u_1 who was already recorded before confirmation');
    assert.strictEqual(confirmBulk.command.skippedAlreadyRecordedCount, 1, 'P5E: Reports 1 skipped already-recorded student');
    assert(!confirmBulk.command.entries.some((e) => e.studentId === 'p5_u_1'), 'P5E: Already-recorded student never in write entries');
  }

  // 5F. Re-verification & Atomic IndexedDB + Queue Write (including queued 'failed'/'timeout_unknown' protection)
  await idbClearMutations();
  await idbSaveStudents(
    p5StudentsAfterExternalUpdate.filter((s) => s.sourceSheet === 'نشط'),
    'نشط',
    true
  );
  await idbSaveStudents(p5Inactive, 'غير نشط', true);

  // Put p5_u_2 in IndexedDB queue as a prior 'timeout_unknown' mutation to ensure it is NOT duplicated or deleted
  const preQueuedMut = {
    id: `ATT_p5_u_2_${latestFriday}_existing-queue-op`,
    action: 'attendance' as const,
    studentId: 'p5_u_2',
    studentCode: 'SG-402',
    studentName: 'ناقص_2',
    sourceSheet: 'نشط',
    payload: { friday: latestFriday, isPresent: true },
    expectedVersion: 1,
    timestamp: Date.now() - 10000,
    retryCount: 2,
    status: 'timeout_unknown' as const
  };
  await idbAtomicBatchRecordAttendanceWithMutations(
    [],
    [],
    [preQueuedMut]
  );

  const liveQueueBefore = await idbGetPendingMutations();
  const batchCheck = prepareVerifiedAssistantAttendanceBatch(
    p5Unrecorded.map((u) => ({ studentId: u.id, isPresent: true })),
    p5StudentsAfterExternalUpdate,
    latestFriday,
    liveQueueBefore,
    () => ({ allowed: true })
  );
  assert.strictEqual(batchCheck.skippedAlreadyRecorded.length, 1, 'P5F: prepareVerifiedAssistantAttendanceBatch excludes live recorded student p5_u_1');
  assert.strictEqual(batchCheck.skippedAlreadyQueued.length, 1, 'P5F: prepareVerifiedAssistantAttendanceBatch excludes queued student p5_u_2');
  assert.strictEqual(batchCheck.validEntries.length, 9, 'P5F: Only the 9 truly unrecorded + unqueued students proceed to write');

  const prepared = prepareBatchAttendanceMutations(
    batchCheck.validEntries.map((e) => ({ studentId: e.studentId, fridayDate: e.fridayDate, isPresent: e.isPresent })),
    p5StudentsAfterExternalUpdate,
    () => ({ allowed: true }),
    '2026-11-14',
    `AST_${latestFriday}_test`,
    liveQueueBefore
  );
  assert.strictEqual(prepared.mutations.length, 9, 'P5F: Prepares exact 9 offline queue mutations');
  await idbAtomicBatchRecordAttendanceWithMutations(
    prepared.updatedStudents,
    prepared.historyRecords,
    prepared.mutations
  );

  const savedStudentsAfterBatch = await idbGetStudents();
  const queueAfterBatch = await idbGetPendingMutations();
  assert(
    queueAfterBatch.some((m) => m.id === preQueuedMut.id && m.status === 'timeout_unknown'),
    'P5F: Pre-existing timeout_unknown queued mutation preserved untouched'
  );
  assert.strictEqual(
    queueAfterBatch.filter((m) => m.action === 'attendance').length,
    10,
    'P5F: Total queued mutations = 1 preserved + 9 new (zero duplicates)'
  );
  for (const written of batchCheck.validEntries) {
    const stored = savedStudentsAfterBatch.find((s) => s.id === written.studentId);
    assert.strictEqual(stored?.att?.[latestFriday], true, `P5F: ${written.studentName} persisted as present in IndexedDB`);
  }

  // Re-running verification now must produce ZERO valid entries (100% idempotent)
  const secondCheck = prepareVerifiedAssistantAttendanceBatch(
    p5Unrecorded.map((u) => ({ studentId: u.id, isPresent: true })),
    savedStudentsAfterBatch,
    latestFriday,
    queueAfterBatch,
    () => ({ allowed: true })
  );
  assert.strictEqual(secondCheck.validEntries.length, 0, 'P5F: Second run yields 0 valid entries (no duplicate attendance possible)');

  // 5G. Individual / Multi-Select subset (select only 2 students: one present, one absent; others untouched)
  const indStudents: Student[] = ['ind_1', 'ind_2', 'ind_3', 'ind_4'].map((id, idx) =>
    makeStudent({
      id,
      code: `SG-60${idx + 1}`,
      name: `مخدوم_فردي_${idx + 1}`,
      sourceSheet: 'نشط',
      att: {}
    })
  );
  const indCheck = prepareVerifiedAssistantAttendanceBatch(
    [
      { studentId: 'ind_1', isPresent: true },
      { studentId: 'ind_3', isPresent: false }
    ],
    indStudents,
    latestFriday,
    [],
    () => ({ allowed: true })
  );
  assert.strictEqual(indCheck.validEntries.length, 2, 'P5G: Individual selection includes only the 2 selected students');
  const indPrepared = prepareBatchAttendanceMutations(
    indCheck.validEntries.map((e) => ({ studentId: e.studentId, fridayDate: e.fridayDate, isPresent: e.isPresent })),
    indStudents,
    () => ({ allowed: true }),
    '2026-11-14',
    `AST_${latestFriday}_ind`,
    []
  );
  const indUpdatedMap = new Map(indPrepared.updatedStudents.map((s) => [s.id, s]));
  assert.strictEqual(indUpdatedMap.get('ind_1')?.att?.[latestFriday], true, 'P5G: Selected ind_1 marked present');
  assert.strictEqual(indUpdatedMap.get('ind_3')?.att?.[latestFriday], false, 'P5G: Selected ind_3 marked absent');
  assert(!indUpdatedMap.has('ind_2') && !indUpdatedMap.has('ind_4'), 'P5G: Unselected ind_2 & ind_4 remain completely untouched');

  await idbClearMutations();
  console.log('✅ Part 5 Passed: 20/11 Unrecorded Accuracy, Multi-Turn Context, Pre-Save Confirmation & Queue Safety verified');

  // --------------------------------------------------------------------------
  // PART 6: Smart Assistant UI Grid Layout, Closed SSR & Horizontal Rows
  // --------------------------------------------------------------------------
  const closedAssistantHtml = renderToString(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AuthProvider,
        null,
        React.createElement(AppProvider, null, React.createElement(AssistantModal))
      )
    )
  );
  assert.strictEqual(closedAssistantHtml, '', 'P6a: Closed AssistantModal renders zero stray markup');

  const freshSession = createFreshAssistantSession();
  assert.strictEqual(
    freshSession.messages[0].actions,
    undefined,
    'P6b: Fresh assistant welcome message omits duplicate top action cards since all quick icons live in one unified bottom grid'
  );

  const assistantModalSrc = readProjectFile('src/components/modals/AssistantModal.tsx');
  assert(
    assistantModalSrc.includes('grid-cols-2 sm:grid-cols-3') &&
      assistantModalSrc.includes('min-h-[40px]') &&
      assistantModalSrc.includes('w-4 h-4 shrink-0') &&
      assistantModalSrc.includes('الحاضرون اليوم') &&
      assistantModalSrc.includes('عرض الإحصائيات') &&
      assistantModalSrc.includes('showQuickPrompts') &&
      !assistantModalSrc.includes('max-h-[144px]') &&
      !assistantModalSrc.includes('max-h-72 sm:max-h-80 overflow-y-auto') &&
      !assistantModalSrc.includes('max-h-32 overflow-y-auto'),
    'P6c: Unified Quick Prompts grid merges all 9 actions in a responsive scroll-free grid with Hide/Show toggle and zero internal list scrollbars'
  );
  assert(
    assistantModalSrc.includes('grid-cols-2') &&
      assistantModalSrc.includes('grid-cols-2 sm:grid-cols-3') &&
      assistantModalSrc.includes('getActionIcon'),
    'P6d: Bot response actions render in balanced CSS Grid with uniform lucide-react icons'
  );
  assert(
    assistantModalSrc.includes('تسجيل الكل حضور') &&
      assistantModalSrc.includes('تسجيل الكل غياب') &&
      assistantModalSrc.includes('تحديد فردي أو اختيار عدة مخدومين') &&
      assistantModalSrc.includes('role="alertdialog"'),
    'P6e: Interactive unrecorded attendance panel offers Bulk Present, Bulk Absent, Individual Multi-Select & AlertDialog Confirmation'
  );

  const queueModalSrc = readProjectFile('src/components/modals/QueueDetailsModal.tsx');
  assert(
    queueModalSrc.includes('flex flex-row items-center') &&
      queueModalSrc.includes('flex-nowrap') &&
      queueModalSrc.includes('overflow-x-auto no-scrollbar'),
    'P6f: QueueDetailsModal maintains non-wrapping horizontal alignment for icon/button strips'
  );

  const indCardStart = assistantModalSrc.indexOf('data-testid="assistant-individual-student-card"');
  const indCardEnd = assistantModalSrc.indexOf('Review Draft Before Confirming', indCardStart);
  assert(indCardStart > -1 && indCardEnd > indCardStart, 'P6g: AssistantModal renders independent individual student card elements');
  const indCardBlock = assistantModalSrc.slice(indCardStart, indCardEnd);
  assert(
    indCardBlock.includes('flex flex-col gap-2.5') &&
      indCardBlock.includes('whitespace-normal break-words') &&
      !/\btruncate\b/.test(indCardBlock) &&
      indCardBlock.includes('grid grid-cols-2 gap-2 w-full') &&
      indCardBlock.includes('<span>حاضر</span>') &&
      indCardBlock.includes('<span>غائب</span>') &&
      indCardBlock.includes('aria-pressed='),
    'P6g: Individual student card places full untruncated name on row 1 and side-by-side حاضر/غائب buttons on row 2'
  );

  console.log('✅ Part 6 Passed: Smart Assistant CSS Grid Layout, Interactive Controls & Queue Row Alignment verified');
  console.log('\n======================================================');
  console.log('🎉 ALL COMPREHENSIVE FIXES & 5-DOMAIN ASSISTANT TESTS PASSED!');
  console.log('======================================================');
}

runTests().catch((err) => {
  console.error('❌ Test Failed:', err);
  process.exit(1);
});
