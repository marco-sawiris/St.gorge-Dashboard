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
import { AppProvider, normalizeStudentRecord } from '../context/AppContext';
import { StudentCard } from '../components/cards/StudentCard';
import { QuickFollowupModal } from '../components/modals/QuickFollowupModal';
import { FollowupLogView } from '../components/followup/FollowupLogView';
import { parseGoogleVisualizationFollowupLog } from '../services/googleSheetParser';
import {
  idbAtomicRecordFollowupWithMutation,
  idbGetFollowupRecords,
  idbGetPendingMutations,
  idbRemoveMutation,
  idbSaveStudents
} from '../services/indexedDbService';
import {
  AssistantIntentEngine,
  AssistantMessage,
  detectAssistantIntent,
  processAssistantQuery
} from '../services/assistantEngine';
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
  console.log('\n======================================================');
  console.log('🎉 ALL COMPREHENSIVE FIXES & 5-DOMAIN ASSISTANT TESTS PASSED!');
  console.log('======================================================');
}

runTests().catch((err) => {
  console.error('❌ Test Failed:', err);
  process.exit(1);
});
