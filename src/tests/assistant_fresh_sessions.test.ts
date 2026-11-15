import assert from 'node:assert';
import {
  createFreshAssistantSession,
  createInitialBotMessage,
  getStoredAssistantSessions,
  saveAssistantSession,
  deleteAssistantSession,
  clearAllAssistantSessions,
  isExplicitHistoryRequest,
  AssistantSession
} from '../services/assistantSessionService';
import {
  processAssistantQuery,
  AssistantMessage
} from '../services/assistantEngine';
import { Student } from '../types/student';

// Mock storage for Node environment
function createStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    }
  };
}

(globalThis as any).localStorage = createStorageMock();

const mockStudents: Student[] = [
  {
    id: 'std_1',
    code: 'SG-101',
    name: 'بيشوي عماد صموئيل',
    servant: 'ماركو',
    phoneStudent: '01211112222',
    birthDate: '2010-11-15',
    area: 'الزيتون',
    address: 'الزيتون',
    notes: 'مواظب',
    followupStatus: 'بدون',
    attendanceTotal: 12,
    attendanceMonth: 3,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    lastFollowup: '2026-11-06',
    att: {},
    fu: {}
  },
  {
    id: 'std_2',
    code: 'SG-102',
    name: 'مارتن فايز عزيز',
    servant: 'مينا',
    phoneStudent: '01233334444',
    birthDate: '2010-12-05',
    area: 'مصر الجديدة',
    address: 'مصر الجديدة',
    notes: '',
    followupStatus: 'بدون',
    attendanceTotal: 15,
    attendanceMonth: 4,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    lastFollowup: '2026-11-06',
    att: {},
    fu: {}
  }
];

async function runAssistantFreshSessionsTests() {
  console.log('======================================================');
  console.log('  🧪 Running Assistant Fresh Sessions Test Suite');
  console.log('======================================================');

  clearAllAssistantSessions();

  // --------------------------------------------------------------------------
  // TEST 1: createFreshAssistantSession creates unique ID, fresh welcome message, clean state
  // --------------------------------------------------------------------------
  const session1 = createFreshAssistantSession();
  assert.ok(session1.id.startsWith('session_'), 'Test 1a: Session ID has unique prefix');
  assert.strictEqual(session1.title, 'محادثة جديدة', 'Test 1b: Fresh session has default title');
  assert.strictEqual(session1.messages.length, 1, 'Test 1c: Fresh session starts with exactly 1 welcome message');
  assert.strictEqual(session1.messages[0].role, 'bot', 'Test 1d: First message is bot welcome');
  assert.ok(session1.messages[0].text.includes('سلام ونعمة'), 'Test 1e: Bot welcome text present');

  const session2 = createFreshAssistantSession();
  assert.notStrictEqual(session1.id, session2.id, 'Test 1f: Successive sessions have distinct Session IDs');
  console.log('✅ Test 1 Passed: createFreshAssistantSession generates isolated sessions with unique IDs');

  // --------------------------------------------------------------------------
  // TEST 2: Active Session Continuity within open session (Requirement 6)
  // --------------------------------------------------------------------------
  const userMsg1: AssistantMessage = {
    id: 'msg_u1',
    role: 'user',
    text: 'مين حضر النهارده؟',
    timestamp: Date.now()
  };
  const botResp1 = processAssistantQuery(userMsg1.text, mockStudents, {
    sessionId: session1.id,
    sessionMessages: [...session1.messages, userMsg1]
  });

  const botMsg1: AssistantMessage = {
    id: 'msg_b1',
    role: 'bot',
    text: botResp1.text,
    timestamp: Date.now()
  };

  session1.messages.push(userMsg1, botMsg1);
  assert.strictEqual(session1.messages.length, 3, 'Test 2a: Messages appended to current active session');
  assert.strictEqual(session1.messages[1].text, 'مين حضر النهارده؟', 'Test 2b: User message preserved in session');
  assert.ok(session1.messages[2].text.length > 0, 'Test 2c: Bot answer stored in session');
  console.log('✅ Test 2 Passed: Active session continuity operates smoothly while session is open');

  // --------------------------------------------------------------------------
  // TEST 3: Archiving dirty session to history & preserving old history (Requirement 7)
  // --------------------------------------------------------------------------
  saveAssistantSession(session1);
  const stored1 = getStoredAssistantSessions();
  assert.strictEqual(stored1.length, 1, 'Test 3a: Session archived in history storage');
  assert.strictEqual(stored1[0].id, session1.id, 'Test 3b: Correct session archived');
  assert.strictEqual(stored1[0].title, 'مين حضر النهارده؟', 'Test 3c: Title updated to first question preview');
  assert.strictEqual(stored1[0].messages.length, 3, 'Test 3d: All messages preserved intact');

  // Empty sessions (with zero user messages) must NOT pollute history
  const emptySession = createFreshAssistantSession();
  saveAssistantSession(emptySession);
  const storedAfterEmpty = getStoredAssistantSessions();
  assert.strictEqual(storedAfterEmpty.length, 1, 'Test 3e: Empty session without user interactions not archived');
  console.log('✅ Test 3 Passed: Dirty sessions safely archived in history, empty sessions filtered');

  // --------------------------------------------------------------------------
  // TEST 4: Closing & Reopening generates completely fresh session (Requirements 1, 2, 3, 5)
  // --------------------------------------------------------------------------
  // Simulate opening modal again -> fresh session initiated
  const sessionReopened = createFreshAssistantSession();
  assert.notStrictEqual(sessionReopened.id, session1.id, 'Test 4a: Reopened session has brand new Session ID');
  assert.strictEqual(sessionReopened.messages.length, 1, 'Test 4b: Reopened session contains only welcome message');
  assert.strictEqual(sessionReopened.messages[0].role, 'bot', 'Test 4c: No user messages from previous session');
  assert.ok(!sessionReopened.messages.some(m => m.text.includes('مين حضر النهارده؟')), 'Test 4d: Previous question completely absent');
  assert.strictEqual(sessionReopened.title, 'محادثة جديدة', 'Test 4e: Title is clean default');
  console.log('✅ Test 4 Passed: Reopening assistant begins with clean slate, fresh ID, and zero previous chat text');

  // --------------------------------------------------------------------------
  // TEST 5: Context Isolation: Past sessions are NOT sent in context unless explicitly requested (Requirement 4)
  // --------------------------------------------------------------------------
  // Regular query: past history context is not passed
  const queryRegular = 'أعياد الميلاد';
  const explicitFalse = isExplicitHistoryRequest(queryRegular);
  assert.strictEqual(explicitFalse, false, 'Test 5a: Standard query is not an explicit history request');

  const regularResponse = processAssistantQuery(queryRegular, mockStudents, {
    sessionId: sessionReopened.id,
    sessionMessages: sessionReopened.messages, // ONLY fresh session messages
    includePastHistory: explicitFalse
  });
  assert.ok(regularResponse.text.includes('بيشوي عماد صموئيل') || regularResponse.text.includes('أعياد ميلاد'), 'Test 5b: Regular query answered purely from current student data');
  assert.ok(!regularResponse.text.includes('📂 لديك'), 'Test 5c: Past session list is omitted in regular responses');

  // Explicit history query: triggers history summary
  const queryHistory = 'سجل المحادثات السابقة';
  const explicitTrue = isExplicitHistoryRequest(queryHistory);
  assert.strictEqual(explicitTrue, true, 'Test 5d: History query detected as explicit request');

  const historyResponse = processAssistantQuery(queryHistory, mockStudents, {
    sessionId: sessionReopened.id,
    includePastHistory: true,
    pastSessions: getStoredAssistantSessions()
  });
  assert.ok(historyResponse.text.includes('📂 لديك 1 جلسة سابقة محفوظة'), 'Test 5e: Explicit request displays past sessions overview');
  assert.ok(historyResponse.text.includes('مين حضر النهارده؟'), 'Test 5f: Past session title listed in history summary');
  console.log('✅ Test 5 Passed: Context isolation strictly enforced; past sessions excluded unless explicitly requested');

  // --------------------------------------------------------------------------
  // TEST 6: Multiple Consecutive Cycles (Open -> Chat -> Close -> Reopen -> Chat -> Close)
  // --------------------------------------------------------------------------
  clearAllAssistantSessions();

  // Cycle 1: Ask about stats
  const cycle1 = createFreshAssistantSession();
  cycle1.messages.push(
    { id: 'c1_u', role: 'user', text: 'إحصائيات', timestamp: 1000 },
    { id: 'c1_b', role: 'bot', text: 'إجمالي المخدومين: 2', timestamp: 1001 }
  );
  saveAssistantSession(cycle1);

  // Cycle 2: Reopen -> Ask about birthdays
  const cycle2 = createFreshAssistantSession();
  assert.notStrictEqual(cycle2.id, cycle1.id, 'Test 6a: Cycle 2 ID differs from Cycle 1');
  assert.strictEqual(cycle2.messages.length, 1, 'Test 6b: Cycle 2 starts with only 1 message');
  cycle2.messages.push(
    { id: 'c2_u', role: 'user', text: 'أعياد الميلاد القادمة', timestamp: 2000 },
    { id: 'c2_b', role: 'bot', text: 'عيد ميلاد بيشوي', timestamp: 2001 }
  );
  saveAssistantSession(cycle2);

  // Cycle 3: Reopen -> Verify clean state & history contents
  const cycle3 = createFreshAssistantSession();
  assert.notStrictEqual(cycle3.id, cycle2.id, 'Test 6c: Cycle 3 ID differs from Cycle 2');
  assert.notStrictEqual(cycle3.id, cycle1.id, 'Test 6d: Cycle 3 ID differs from Cycle 1');
  assert.strictEqual(cycle3.messages.length, 1, 'Test 6e: Cycle 3 starts with blank conversation (only welcome)');
  assert.ok(!cycle3.messages.some(m => m.role === 'user'), 'Test 6f: Cycle 3 has zero user messages from previous sessions');
  assert.strictEqual(cycle3.messages[0].role, 'bot', 'Test 6f2: Only initial bot welcome is present');

  // Verify history contains both past sessions
  const finalHistory = getStoredAssistantSessions();
  assert.strictEqual(finalHistory.length, 2, 'Test 6g: History contains both previous sessions');
  assert.strictEqual(finalHistory[0].id, cycle2.id, 'Test 6h: Most recent session at top of history');
  assert.strictEqual(finalHistory[1].id, cycle1.id, 'Test 6i: Older session preserved at index 1');

  // Test session deletion from history
  deleteAssistantSession(cycle1.id);
  const afterDelete = getStoredAssistantSessions();
  assert.strictEqual(afterDelete.length, 1, 'Test 6j: Deleted session removed from history');
  assert.strictEqual(afterDelete[0].id, cycle2.id, 'Test 6k: Remaining session preserved');
  console.log('✅ Test 6 Passed: Multiple consecutive open/close cycles operate independently with intact history');

  console.log('======================================================');
  console.log('🎉 ALL ASSISTANT FRESH SESSIONS TESTS PASSED!');
  console.log('======================================================');
}

runAssistantFreshSessionsTests().catch((err) => {
  console.error('❌ Assistant Fresh Sessions Test Failed:', err);
  process.exit(1);
});
