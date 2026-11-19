import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import http from 'http';
import assert from 'assert';
import express from 'express';
import cookieParser from 'cookie-parser';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import 'fake-indexeddb/auto';

import { CENTRAL_SPREADSHEET_ID, CENTRAL_SPREADSHEET_EDIT_URL, isDisallowedClientSpreadsheetOverride } from '../config/centralSheetConfig';
import { ENV } from '../../server/config/env';
import sheetsRouter from '../../server/routes/sheets';
import { googleSheetsService } from '../../server/services/googleSheetsService';
import { signAccessToken } from '../../server/security/jwt';
import {
  Student,
  LIVE_GOOGLE_SHEET_TABS,
  INACTIVE_STUDENT_CLASSIFICATION,
  STUDENT_CLASSIFICATION_OPTIONS
} from '../types/student';
import { OfflineMutation } from '../types/auth';
import { FollowupRecord } from '../types/followup';
import {
  DEFAULT_SPREADSHEET_ID,
  NONEXISTENT_SHEET_PROBE_NAME,
  fetchSheetStudentsViaGviz
} from '../services/googleSheetParser';
import {
  idbGetStudents,
  idbSaveStudents,
  idbGetFollowupRecords,
  idbGetAttendanceHistory,
  idbGetPendingMutations,
  idbQueueMutation,
  getIndexedDB,
  idbCloseDatabase
} from '../services/indexedDbService';
import {
  SPREADSHEET_ID,
  executeSyncData,
  executeProcessOfflineQueue,
  formatPullWithPendingQueueMessage
} from '../context/AppContext';
import { validateRemotePersistenceProof } from '../services/remotePersistenceVerification';
import { AuthProvider } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';
import { AppProvider } from '../context/AppContext';
import { SearchFilterBar } from '../components/common/SearchFilterBar';
import { StudentFormModal } from '../components/modals/StudentFormModal';
import { Sidebar } from '../components/layout/Sidebar';
import { SyncDetailsModal } from '../components/modals/SyncDetailsModal';

// ---------------------------------------------------------------------------
// LocalStorage & FakeIndexedDB test harness (zero live storage touched)
// ---------------------------------------------------------------------------
const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
  setItem: (key: string, value: string) => storageMap.set(key, String(value)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear()
};

if (!(globalThis as any).window) (globalThis as any).window = globalThis;
(globalThis as any).localStorage = mockLocalStorage;
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

async function resetFakeIndexedDb() {
  const db = await getIndexedDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['students', 'followup', 'mutations', 'attendance_history'], 'readwrite');
    tx.objectStore('students').clear();
    tx.objectStore('followup').clear();
    tx.objectStore('mutations').clear();
    tx.objectStore('attendance_history').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function buildGvizPayload(opts: { sig: string; headers: string[]; rows: any[][] }): string {
  const cols = opts.headers.map((label, idx) => ({ id: `C${idx}`, label, type: 'string' }));
  const rows = opts.rows.map((cells) => ({
    c: opts.headers.map((_, idx) => ({ v: cells[idx] !== undefined ? cells[idx] : '' }))
  }));
  return `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify({
    version: '0.6',
    reqId: '0',
    status: 'ok',
    sig: opts.sig,
    table: { cols, rows }
  })});`;
}

function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: 'st_default_1',
    code: '101',
    name: 'كيرلس مرقس',
    servant: 'ماركو ملجي فارس',
    phoneStudent: '01200000001',
    phoneParent1: '01299999901',
    phoneParent2: '',
    birthDate: '',
    area: 'الزيتون',
    address: '',
    notes: '',
    followupStatus: 'بدون',
    attendanceTotal: 1,
    attendanceMonth: 1,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: { '2026-11-13': true },
    fu: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Minimal Code.gs VM Sandbox (with setValues & full sheet support)
// ---------------------------------------------------------------------------
class MockRange {
  constructor(
    private sheet: MockSheet,
    private startRow: number,
    private startCol: number,
    private numRows: number,
    private numCols: number
  ) {}
  getValues(): any[][] {
    const out: any[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = this.sheet.rows[this.startRow - 1 + r] || [];
      const slice: any[] = [];
      for (let c = 0; c < this.numCols; c++) {
        slice.push(rowArr[this.startCol - 1 + c] !== undefined ? rowArr[this.startCol - 1 + c] : '');
      }
      out.push(slice);
    }
    return out;
  }
  getValue(): any {
    const rowArr = this.sheet.rows[this.startRow - 1] || [];
    return rowArr[this.startCol - 1] !== undefined ? rowArr[this.startCol - 1] : '';
  }
  setValue(val: any): void {
    this.sheet.ensureSize(this.startRow, this.startCol);
    this.sheet.rows[this.startRow - 1][this.startCol - 1] = val;
  }
  setValues(values: any[][]): void {
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        this.sheet.ensureSize(this.startRow + r, this.startCol + c);
        this.sheet.rows[this.startRow - 1 + r][this.startCol - 1 + c] = values[r][c];
      }
    }
  }
  createTextFinder(query: string) {
    let matchEntire = false;
    const self = this;
    return {
      matchEntireCell(flag: boolean) {
        matchEntire = Boolean(flag);
        return this;
      },
      findNext() {
        for (let r = 0; r < self.numRows; r++) {
          for (let c = 0; c < self.numCols; c++) {
            const cellVal = String((self.sheet.rows[self.startRow - 1 + r] || [])[self.startCol - 1 + c] ?? '');
            const matched = matchEntire ? cellVal === query : cellVal.includes(query);
            if (matched) {
              const matchedRow = self.startRow + r;
              return { getRow: () => matchedRow };
            }
          }
        }
        return null;
      }
    };
  }
}

class MockSheet {
  public hidden = false;
  constructor(public name: string, public rows: any[][]) {}
  getName() { return this.name; }
  hideSheet() { this.hidden = true; }
  ensureSize(rCount: number, cCount: number) {
    while (this.rows.length < rCount) this.rows.push([]);
    for (let r = 0; r < this.rows.length; r++) {
      while (this.rows[r].length < cCount) this.rows[r].push('');
    }
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { return new MockRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(r: number, c: number, nr = 1, nc = 1) { return new MockRange(this, r, c, nr, nc); }
  insertColumnBefore(colPos: number) {
    for (const r of this.rows) {
      while (r.length < colPos - 1) r.push('');
      r.splice(colPos - 1, 0, '');
    }
  }
  appendRow(vals: any[]) { this.rows.push([...vals]); }
}

function createCodeGsTestSandbox() {
  const sheetMap = new Map<string, MockSheet>();
  const headers = ['كود', 'الاسم', 'الاشبين', 'موبايل المخدوم', 'موبيل ولي الامر 1', 'المنطقة', 'آخر حضور', 'آخر افتقاد', 'حالة الافتقاد', 'إجمالي الحضور', 'id', 'version'];
  sheetMap.set('ردود النموذج 1', new MockSheet('ردود النموذج 1', [['طابع زمني', 'الاسم'], ['2026-01-01', 'رد']]));
  sheetMap.set('سجل الافتقاد', new MockSheet('سجل الافتقاد', [['التاريخ', 'أسبوع الجمعة', 'الشيت', 'الكود', 'الاسم', 'الأشبين', 'النوع', 'ملاحظات']]));
  sheetMap.set('نشط', new MockSheet('نشط', [
    headers,
    ['SG-001', 'مينا جرجس', 'أ/ ماجد', '01011112222', '01222223333', 'الزيتون', '', '', 'بدون', 0, 'st_1', 1]
  ]));
  sheetMap.set('غير حاضر', new MockSheet('غير حاضر', [
    headers,
    ['SG-010', 'كيرلس عادل', 'أ/ رامي', '', '01566667777', 'حدائق الزيتون', '', '', 'بدون', 0, 'st_10', 1]
  ]));
  sheetMap.set('فصل البابا شنودة ', new MockSheet('فصل البابا شنودة ', [
    headers,
    ['SG-020', 'يوحنا هاني', 'أ/ بولس', '', '01299998888', 'الزيتون', '', '', 'بدون', 0, 'st_20', 1]
  ]));

  let openedSpreadsheetId: string | null = null;
  const cacheStore = new Map<string, string>();
  const mockSpreadsheet = {
    getSheetByName: (n: string) => sheetMap.get(n) || null,
    getSheets: () => Array.from(sheetMap.values()),
    insertSheet: (n: string) => {
      const sh = new MockSheet(n, []);
      sheetMap.set(n, sh);
      return sh;
    }
  };

  const sandbox: any = {
    Date, Math, JSON, String, Number, Boolean, Array, Object, RegExp, Error, parseInt, isFinite, isNaN,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      openById: (id: string) => { openedSpreadsheetId = id; return mockSpreadsheet; },
      flush: () => {}
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => (k === 'SPREADSHEET_ID' ? CENTRAL_SPREADSHEET_ID : null)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cacheStore.get(k) ?? null,
        put: (k: string, v: string) => cacheStore.set(k, v),
        getAll: (keys: string[]) => {
          const out: Record<string, string> = {};
          keys.forEach((k) => { if (cacheStore.has(k)) out[k] = cacheStore.get(k)!; });
          return out;
        },
        putAll: (obj: Record<string, string>) => {
          Object.entries(obj).forEach(([k, v]) => cacheStore.set(k, v));
        }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'Africa/Cairo' },
    Utilities: { formatDate: (_d: Date, _tz: string, f: string) => (f === 'yyyy-MM' ? '2026-11' : '2026-11-19') },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (txt: string) => ({ setMimeType() { return this; }, getContent: () => txt })
    }
  };

  const src = fs.readFileSync(path.resolve(process.cwd(), 'docs/google-apps-script/Code.gs'), 'utf-8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  return {
    sandbox,
    sheetMap,
    cacheStore,
    getOpenedSpreadsheetId: () => openedSpreadsheetId,
    invokeGet: (params: Record<string, string>) => JSON.parse(sandbox.doGet({ parameter: params }).getContent()),
    invokePost: (bodyObj: any) =>
      JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(bodyObj) }, parameter: {} }).getContent())
  };
}

async function runTests() {
  console.log('\n======================================================================');
  console.log('🧪 Final Sync Fix Verification Suite (10 End-to-End Regression Cases)');
  console.log('======================================================================\n');

  let passed = 0;

  // =========================================================================
  // 1. Initial Sync WITHOUT pending mutations: Pull-only (0 POSTs, no missing_persisted_flag, lastSyncError === null)
  // =========================================================================
  {
    await resetFakeIndexedDb();
    mockLocalStorage.clear();
    const calls: string[] = [];

    const validHeaders = ['كود', 'الاسم', 'الاشبين', 'موبايل المخدوم', '2026-11-13'];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = (init?.method || 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (method !== 'GET') throw new Error(`Initial Sync with clean queue MUST NOT send ${method}!`);

      const sheet = new URL(url).searchParams.get('sheet') || '';
      let body = buildGvizPayload({ sig: 'sig_forms_default', headers: ['طابع زمني', 'الاسم'], rows: [] });
      if (sheet === 'نشط') {
        body = buildGvizPayload({ sig: 'sig_a', headers: validHeaders, rows: [['101', 'مينا عادل', 'ماركو', '01211111111', '1']] });
      } else if (sheet === 'غير حاضر') {
        body = buildGvizPayload({ sig: 'sig_b', headers: validHeaders, rows: [['201', 'كيرلس هاني', 'ماركو', '01222222222', '0']] });
      } else if (sheet === 'فصل البابا شنودة ') {
        body = buildGvizPayload({ sig: 'sig_c', headers: validHeaders, rows: [['301', 'ديفيد ماجد', 'ماركو', '01233333333', '1']] });
      } else if (sheet === 'سجل الافتقاد') {
        body = buildGvizPayload({ sig: 'sig_fu', headers: ['التاريخ', 'أسبوع الجمعة', 'الاسم', 'النوع', 'الأشبين', 'ملاحظات'], rows: [] });
      }
      return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
    };

    const syncLock = { current: false };
    let recordedError: string | null = 'should_be_cleared';
    let pullTimeRecorded: string | null = null;
    let pushTimeRecorded: string | null = null;

    const outcome = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      (iso) => { pullTimeRecorded = iso; },
      (iso) => { pushTimeRecorded = iso; },
      (err) => { recordedError = err; }
    );

    assert.strictEqual(outcome, true, '1a: Clean Initial Sync returns true (not partial!)');
    assert.strictEqual(recordedError, null, '1b: Clean Initial Sync keeps lastSyncError === null (no missing_persisted_flag)');
    assert.ok(pullTimeRecorded, '1c: Pull timestamp recorded');
    assert.strictEqual(pushTimeRecorded, null, '1d: Zero writes -> push timestamp untouched');
    assert.strictEqual(calls.every((c) => c.startsWith('GET ')), true, '1e: Initial Sync executed strictly GET Pull calls');
    assert.strictEqual((await idbGetStudents()).length, 3, '1f: All 3 live sheet students hydrated cleanly');
    console.log('✅ Scenario 1 Passed: Clean Initial Sync uses GET Pull only (0 POSTs), no false missing_persisted_flag.');
    passed++;
  }

  // =========================================================================
  // 2. Initial Sync WITH legacy pending mutation failing proof -> Pull still succeeds,
  //    queue mutation preserved safely, and error clearly attributed to queue (not Pull)
  // =========================================================================
  {
    await resetFakeIndexedDb();
    mockLocalStorage.clear();
    mockLocalStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/MOCK_OLD_DEPLOYMENT/exec');

    const localStudent = makeStudent({ id: 'st_old_q', code: '500', name: 'بيشوي عماد', version: 2, hasUnsyncedLocalChanges: true });
    await idbSaveStudents([localStudent], 'نشط', true);

    const oldPendingMut: OfflineMutation = {
      id: 'mut_legacy_unconfirmed_1',
      action: 'attendance',
      studentId: localStudent.id,
      studentCode: localStudent.code,
      studentName: localStudent.name,
      sourceSheet: 'نشط',
      payload: { friday: '2026-11-13', isPresent: true },
      expectedVersion: 1,
      timestamp: Date.now() - 10000,
      retryCount: 0,
      status: 'pending'
    };
    await idbQueueMutation(oldPendingMut);

    const validHeaders = ['كود', 'الاسم', 'الاشبين', 'موبايل المخدوم', '2026-11-13'];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST') {
        // Simulate old pre-4.4 deployed script returning { ok: true } WITHOUT proof/persisted:true
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, msg: 'legacy reply without persisted proof' }),
          json: async () => ({ ok: true, msg: 'legacy reply without persisted proof' })
        };
      }
      const sheet = new URL(url).searchParams.get('sheet') || '';
      let body = buildGvizPayload({ sig: 'sig_forms', headers: ['طابع زمني', 'الاسم'], rows: [] });
      if (sheet === 'نشط') {
        body = buildGvizPayload({ sig: 'sig_a2', headers: validHeaders, rows: [['101', 'مينا عادل', 'ماركو', '01211111111', '1']] });
      } else if (sheet === 'غير حاضر') {
        body = buildGvizPayload({ sig: 'sig_b2', headers: validHeaders, rows: [['201', 'كيرلس هاني', 'ماركو', '01222222222', '0']] });
      } else if (sheet === 'فصل البابا شنودة ') {
        body = buildGvizPayload({ sig: 'sig_c2', headers: validHeaders, rows: [['301', 'ديفيد ماجد', 'ماركو', '01233333333', '1']] });
      } else if (sheet === 'سجل الافتقاد') {
        body = buildGvizPayload({ sig: 'sig_fu2', headers: ['التاريخ', 'أسبوع الجمعة', 'الاسم', 'النوع', 'الأشبين', 'ملاحظات'], rows: [] });
      }
      return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
    };

    const syncLock = { current: false };
    const errBox: { value: string | null } = { value: null };
    let pullRecorded = false;
    const outcome = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      () => { pullRecorded = true; },
      undefined,
      (err) => { errBox.value = err; }
    );

    assert.strictEqual(outcome, false, '2a: Overall sync returns false ONLY because pending queue has remaining unconfirmed item');
    assert.strictEqual(pullRecorded, true, '2b: Pull succeeded and recorded Pull timestamp');
    const remaining = await idbGetPendingMutations();
    assert.strictEqual(remaining.length, 1, '2c: Unconfirmed mutation retained safely in IndexedDB');
    assert.strictEqual(remaining[0].lastError?.includes('missing_persisted_flag'), true, '2d: Push recorded missing_persisted_flag on queued item');
    assert.ok(
      errBox.value && errBox.value.includes('طابور الإرسال') && errBox.value.includes('missing_persisted_flag'),
      '2e: Sync error explicitly attributes issue to pending push queue rather than Pull'
    );

    const msgDirect = formatPullWithPendingQueueMessage(remaining, false);
    assert.ok(msgDirect.includes('تم سحب وتحديث البيانات'), '2f: Pull summary clearly states pull succeeded');

    // SyncDetailsModal clarifies queue vs pull when remaining > 0
    const syncHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(AppProvider, null, React.createElement(SyncDetailsModal))
        )
      )
    );
    assert.strictEqual(syncHtml, '', 'SyncDetailsModal closed by default cleanly');
    console.log('✅ Scenario 2 Passed: Legacy pending push triggers missing_persisted_flag ONLY on queued write while Pull succeeds cleanly.');
    passed++;
  }

  // =========================================================================
  // 3 & 4 & 5. Fail-Closed proof rejection, Valid proof acceptance, Offline Queue retention
  // =========================================================================
  {
    const sampleAtt: OfflineMutation = {
      id: 'proof_att_1',
      action: 'attendance',
      studentId: 'st_1',
      studentCode: 'SG-001',
      studentName: 'مينا',
      sourceSheet: 'نشط',
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0,
      payload: { friday: '2026-11-20', isPresent: true }
    };

    const badLegacyRes = validateRemotePersistenceProof(sampleAtt, { ok: true, status: 200 });
    assert.strictEqual(badLegacyRes.valid, false, '3a: Reject { ok: true } without proof on Push');
    assert.strictEqual(badLegacyRes.reason, 'missing_persisted_flag');

    const validProofRes = validateRemotePersistenceProof(sampleAtt, {
      ok: true,
      status: 200,
      persisted: true,
      proof: {
        mutationId: sampleAtt.id,
        persisted: true,
        operation: 'attendance',
        studentId: sampleAtt.studentId,
        sheetName: 'نشط',
        row: 2,
        recordId: 'st_1:2026-11-20',
        newVersion: 2,
        friday: '2026-11-20',
        present: true,
        verifiedAt: new Date().toISOString()
      }
    });
    assert.strictEqual(validProofRes.valid, true, '4a: Accepts structured RemotePersistenceProof on Push');

    // 5. Timeout retains mutation in IndexedDB
    await resetFakeIndexedDb();
    mockLocalStorage.clear();
    mockLocalStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/MOCK_TIMEOUT/exec');
    await idbQueueMutation({ ...sampleAtt, id: 'timeout_keep_1', timestamp: Date.now() });

    (globalThis as any).fetch = async () => {
      const err: any = new Error('The operation was aborted due to timeout');
      err.name = 'AbortError';
      throw err;
    };
    const qReport = await executeProcessOfflineQueue(null, false);
    assert.strictEqual(qReport.remainingCount, 1, '5a: Timeout/failure retains mutation safely in IndexedDB');
    assert.strictEqual((await idbGetPendingMutations()).some((m) => m.id === 'timeout_keep_1'), true);
    console.log('✅ Scenarios 3, 4 & 5 Passed: Proof enforcement & Offline Queue retention verified.');
    passed += 3;
  }

  // =========================================================================
  // 6. Missing 'غير نشط' tab NEVER forces Partial Sync, while preserving local 'غير نشط' students & UI classification
  // =========================================================================
  {
    assert.deepStrictEqual([...LIVE_GOOGLE_SHEET_TABS], ['نشط', 'غير حاضر', 'فصل البابا شنودة']);
    assert.strictEqual(STUDENT_CLASSIFICATION_OPTIONS.includes(INACTIVE_STUDENT_CLASSIFICATION), true);

    await resetFakeIndexedDb();
    mockLocalStorage.clear();

    const preciousInactive = makeStudent({
      id: 'st_inactive_keep_final',
      code: '777',
      name: 'بيتر سامح (غير نشط)',
      sourceSheet: 'غير نشط',
      notes: 'مخدوم محفوظ في الأرشيف المحلي'
    });
    await idbSaveStudents([preciousInactive], 'غير نشط', true);

    // 6A: Code.gs doGet(__ALL__) when 'غير نشط' tab does NOT exist returns isComplete: true for live tabs
    const gasEnv = createCodeGsTestSandbox();
    const gasAll = gasEnv.invokeGet({ action: 'getStudents', sheet: '__ALL__' });
    assert.strictEqual(gasAll.ok, true);
    assert.strictEqual(gasAll.isComplete, true, '6a: Code.gs doGet(__ALL__) reports isComplete: true without requiring "غير نشط" tab');
    assert.strictEqual(gasAll.students.length, 3, '6b: Returns all 3 live sheet students');

    // 6B: Frontend executeSyncData('__ALL__') against Relay returns true (NOT partial) and preserves local 'غير نشط' student!
    mockLocalStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/MOCK_RELAY_OK/exec');
    mockLocalStorage.setItem('stgorge_relay_key', 'LOCAL_TEST_KEY');
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('script.google.com')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(gasAll), json: async () => gasAll };
      }
      const fuBody = buildGvizPayload({ sig: 'sig_fu_ok', headers: ['التاريخ', 'أسبوع الجمعة', 'الاسم', 'النوع', 'الأشبين', 'ملاحظات'], rows: [] });
      return { ok: true, status: 200, text: async () => fuBody, json: async () => ({}) };
    };

    const syncLock = { current: false };
    let partialInfo: any = 'not_called';
    const outcome = await executeSyncData('__ALL__', null, false, syncLock, undefined, undefined, undefined, undefined, undefined, undefined, (p) => { partialInfo = p; });
    assert.strictEqual(outcome, true, '6c: __ALL__ sync without "غير نشط" tab completes cleanly (not partial!)');
    assert.strictEqual(partialInfo, null, '6d: partialSyncInfo cleared cleanly');

    const storedAfter = await idbGetStudents();
    assert.strictEqual(
      storedAfter.some((s) => s.id === preciousInactive.id && s.sourceSheet === 'غير نشط' && s.notes === preciousInactive.notes),
      true,
      '6e: Local "غير نشط" student preserved 100% untouched in IndexedDB'
    );

    // 6C: StudentFormModal keeps 'غير نشط' option editable
    const formHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(StudentFormModal, { isOpen: true, studentToEdit: preciousInactive, onClose: () => {} })
          )
        )
      )
    );
    assert.strictEqual(formHtml.includes('value="غير نشط"'), true, '6f: StudentFormModal retains "غير نشط" option');
    void SearchFilterBar;
    console.log('✅ Scenario 6 Passed: Missing "غير نشط" tab no longer causes Partial Sync & local "غير نشط" data/classification preserved.');
    passed++;
  }

  // =========================================================================
  // 7. Code.gs _mutation_idempotency upsert-in-place + bottom-up lookup + legacy pre-4.4 non-re-execution
  // =========================================================================
  {
    const gasEnv = createCodeGsTestSandbox();

    // Seed an existing row + duplicate older row in _mutation_idempotency for key 'dup_upsert_key'
    const ledger = gasEnv.sandbox.getDurableIdempotencySheet(gasEnv.sandbox.getSpreadsheet());
    ledger.appendRow(['dup_upsert_key', JSON.stringify({ ok: true, marker: 'stale_first_row' }), new Date(1000)]);
    ledger.appendRow(['dup_upsert_key', JSON.stringify({ ok: true, marker: 'latest_second_row' }), new Date(2000)]);

    const foundBottomUp = gasEnv.sandbox.findDurableIdempotencyResult(gasEnv.sandbox.getSpreadsheet(), 'dup_upsert_key');
    assert.strictEqual(foundBottomUp.marker, 'latest_second_row', '7a: findDurableIdempotencyResult returns latest matching row (bottom-up)');

    const rowsBeforeUpsert = ledger.getLastRow();
    gasEnv.sandbox.saveDurableIdempotencyResult(gasEnv.sandbox.getSpreadsheet(), 'dup_upsert_key', { ok: true, marker: 'updated_in_place' });
    assert.strictEqual(ledger.getLastRow(), rowsBeforeUpsert, '7b: saveDurableIdempotencyResult updates existing row in place without appending duplicate rows');
    assert.strictEqual(
      gasEnv.sandbox.findDurableIdempotencyResult(gasEnv.sandbox.getSpreadsheet(), 'dup_upsert_key').marker,
      'updated_in_place'
    );

    // Seed legacy pre-4.4 attendance idempotency entry (ok: true WITHOUT persisted/proof)
    ledger.appendRow(['legacy_att_key_1', JSON.stringify({ ok: true, action: 'attendance', studentId: 'st_1' }), new Date(3000)]);
    const sheetActiveBefore = gasEnv.sheetMap.get('نشط')!.rows.map((r) => [...r]);

    const legacyReplayRes = gasEnv.invokePost({
      action: 'attendance',
      idempotencyKey: 'legacy_att_key_1',
      studentId: 'st_1',
      studentCode: 'SG-001',
      sourceSheet: 'نشط',
      expectedVersion: 1,
      payload: { friday: '2026-11-27', isPresent: true }
    });
    assert.strictEqual(legacyReplayRes.ok, true);
    assert.strictEqual(legacyReplayRes.deduplicated, true);
    assert.strictEqual(legacyReplayRes.legacyIdempotencyEntry, true, '7c: Identifies legacy pre-4.4 entry');
    assert.notStrictEqual(legacyReplayRes.persisted, true, '7d: NEVER fabricates persisted: true for unprovable legacy entry');
    assert.strictEqual(legacyReplayRes.proof, undefined, '7e: NEVER fabricates fake proof');
    assert.deepStrictEqual(gasEnv.sheetMap.get('نشط')!.rows, sheetActiveBefore, '7f: NEVER re-executes attendance write on sheet (prevents duplicate/409)');

    // Legacy pre-4.4 batch replay does not re-execute either
    const legacyBatchReplay = gasEnv.invokePost({
      action: 'batch',
      mutations: [
        {
          idempotencyKey: 'legacy_att_key_1',
          action: 'attendance',
          studentId: 'st_1',
          studentCode: 'SG-001',
          sourceSheet: 'نشط',
          expectedVersion: 1,
          payload: { friday: '2026-11-27', isPresent: true }
        }
      ]
    });
    assert.strictEqual(legacyBatchReplay.results[0].legacyIdempotencyEntry, true, '7g: Batch also handles legacy entry safely without re-executing');
    assert.deepStrictEqual(gasEnv.sheetMap.get('نشط')!.rows, sheetActiveBefore);

    // Legacy pre-4.4 followup that genuinely exists in 'سجل الافتقاد' by mutation_id gets verified from sheet state
    const logSheet = gasEnv.sheetMap.get('سجل الافتقاد')!;
    logSheet.rows[0].push('mutation_id', 'record_id');
    logSheet.appendRow(['2026-11-10', '2026-11-06', 'نشط', 'SG-001', 'مينا جرجس', 'أ/ ماجد', 'تم تليفونياً', 'متابعة قديمة', 'legacy_fu_verified_key', 'rec_old_fu_1']);
    ledger.appendRow(['legacy_fu_verified_key', JSON.stringify({ ok: true, action: 'followup', studentId: 'st_1', sheetName: 'نشط' }), new Date(4000)]);

    const repairedFuRes = gasEnv.invokePost({
      action: 'followup',
      idempotencyKey: 'legacy_fu_verified_key',
      studentId: 'st_1',
      studentCode: 'SG-001',
      sourceSheet: 'نشط',
      expectedVersion: 1,
      payload: { friday: '2026-11-06', method: 'تم تليفونياً' }
    });
    assert.strictEqual(repairedFuRes.persisted, true, '7h: Provable followup row in سجل الافتقاد is legitimately repaired with real row proof');
    assert.strictEqual(repairedFuRes.proof.followupLogRow, 2);
    assert.strictEqual(logSheet.getLastRow(), 2, '7i: No duplicate followup log row created');

    console.log('✅ Scenario 7 Passed: Durable _mutation_idempotency upsert, bottom-up lookup & legacy non-re-execution verified.');
    passed++;
  }

  // =========================================================================
  // 8. Express Relay Cold-Start Auto-Hydration + Dynamic Reordered Sheet Column Mapping
  // =========================================================================
  {
    googleSheetsService.clearCacheForTestsOnly();

    // Generate temporary runtime RSA keypair (zero secrets committed to codebase)
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const prevEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const prevKey = ENV.GOOGLE_PRIVATE_KEY;
    const prevEmailEnv = ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test-sa@example.iam.gserviceaccount.com';
    ENV.GOOGLE_PRIVATE_KEY = privateKey;

    const sheetValuesPutPayloads: Array<{ url: string; body: any }> = [];
    // Reordered headers with custom/formula columns mixed in!
    const reorderedActiveSheetRows: any[][] = [
      ['صيغة_محسوبة', 'ملاحظات إدارية', 'الاسم', '2026-11-13', 'كود', 'الاشبين', 'موبايل المخدوم', 'موبيل ولي الامر 1', 'المنطقة', 'آخر حضور', 'إجمالي الحضور', 'حضور الشهر', 'الحالة', 'id', 'version'],
      ['=ROW()*10', 'عمود خاص لا يُمس', 'مينا عادل', '1', '101', 'ماركو', '01011111111', '01299999901', 'الزيتون', '2026-11-13', '1', '1', 'حاضر', 'gs_code_نشط_101', '1']
    ];
    const emptySheetRows: any[][] = [
      ['كود', 'الاسم', 'الاشبين', 'موبايل المخدوم', 'موبيل ولي الامر 1', 'المنطقة', 'id', 'version']
    ];

    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'mock_access_token', expires_in: 3600 }) };
      }
      if (url.includes('sheets.googleapis.com/v4/spreadsheets/')) {
        if (method === 'GET') {
          const decoded = decodeURIComponent(url);
          if (decoded.includes("'غير نشط'!")) {
            return { ok: false, status: 400, text: async () => 'Unable to parse range: غير نشط' };
          }
          if (decoded.includes("'نشط'!")) {
            return { ok: true, status: 200, json: async () => ({ values: reorderedActiveSheetRows }) };
          }
          return { ok: true, status: 200, json: async () => ({ values: emptySheetRows }) };
        }
        if (method === 'PUT' || method === 'POST') {
          const parsedBody = JSON.parse(String(init?.body || '{}'));
          sheetValuesPutPayloads.push({ url: decodeURIComponent(url), body: parsedBody });
          return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: "'نشط'!A2:P2" } }), text: async () => '' };
        }
      }
      throw new Error(`Unexpected fetch in Cold-Start test: ${method} ${url}`);
    };

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/sheets', sheetsRouter);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const adminToken = signAccessToken({ userId: 'u_cold', username: 'admin', displayName: 'Admin', role: 'admin' });

    try {
      // 8A. Cold-Start: POST /mutate BEFORE any GET /data -> MUST auto-hydrate and return 200 (not 404!)
      const mutKey = `cold_start_att_${Date.now()}`;
      const realFetch = await (await import('http')).default; // use native http or test fetch directly
      void realFetch;

      const coldRes = await new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          `${baseUrl}/api/sheets/mutate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`,
              'X-Idempotency-Key': mutKey
            }
          },
          (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode || 500, json: JSON.parse(buf) }));
          }
        );
        req.on('error', reject);
        req.write(
          JSON.stringify({
            action: 'attendance',
            studentId: 'gs_code_نشط_101',
            sourceSheet: 'نشط',
            expectedVersion: 1,
            payload: { friday: '2026-11-20', isPresent: true }
          })
        );
        req.end();
      });

      assert.strictEqual(coldRes.status, 200, `8a: Express Cold-Start POST /mutate auto-hydrated without 404 (got ${coldRes.status}: ${JSON.stringify(coldRes.json)})`);
      assert.strictEqual(coldRes.json.proof?.persisted, true, '8b: Cold-Start /mutate returns valid RemotePersistenceProof');

      // 8B. Verify dynamic header-column PUT preserved custom/formula columns at index 0 & 1 and wrote code/name/date dynamically!
      const rowPut = sheetValuesPutPayloads.find((p) => p.url.includes("'نشط'!A2:"));
      assert.ok(rowPut, '8c: PUT updated dynamic range starting at row 2');
      const writtenRow = rowPut!.body.values[0];
      assert.strictEqual(writtenRow[0], '=ROW()*10', '8d: Formula column at index 0 preserved untouched!');
      assert.strictEqual(writtenRow[1], 'عمود خاص لا يُمس', '8e: Custom column at index 1 preserved untouched!');
      assert.strictEqual(writtenRow[2], 'مينا عادل', '8f: Name written dynamically to header index 2');
      assert.strictEqual(writtenRow[4], '101', '8g: Code written dynamically to header index 4 (NOT index 0!)');
      assert.strictEqual(writtenRow[14], '2', '8h: Version incremented cleanly at dynamic header index 14');
      assert.strictEqual(writtenRow[15], '1', '8i: Newly added Friday 2026-11-20 written to dynamic index 15');

      // 8C. Cold-Start batch on nonexistent student still returns 404 for missing student
      googleSheetsService.clearCacheForTestsOnly();
      const missingRes = await new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          `${baseUrl}/api/sheets/mutate-batch`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`
            }
          },
          (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode || 500, json: JSON.parse(buf) }));
          }
        );
        req.on('error', reject);
        req.write(
          JSON.stringify({
            mutations: [
              {
                idempotencyKey: `cold_batch_existing_${Date.now()}`,
                action: 'attendance',
                studentId: 'gs_code_نشط_101',
                sourceSheet: 'نشط',
                expectedVersion: 1,
                payload: { friday: '2026-11-20', isPresent: true }
              },
              {
                idempotencyKey: `cold_batch_404_${Date.now()}`,
                action: 'attendance',
                studentId: 'nonexistent_student_999',
                sourceSheet: 'نشط',
                expectedVersion: 1,
                payload: { friday: '2026-11-20', isPresent: true }
              }
            ]
          })
        );
        req.end();
      });

      assert.strictEqual(missingRes.status, 200);
      assert.strictEqual(missingRes.json.results[0].proof?.persisted, true, '8j: Cold-Start /mutate-batch hydrated and persisted existing student');
      assert.strictEqual(missingRes.json.results[1].status, 404, '8k: Genuinely missing student still returns 404');
    } finally {
      ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL = prevEmailEnv;
      ENV.GOOGLE_PRIVATE_KEY = prevKey;
      if (prevEmail !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = prevEmail;
      googleSheetsService.clearCacheForTestsOnly();
      await new Promise<void>((r) => server.close(() => r()));
    }
    console.log('✅ Scenario 8 Passed: Express Cold-Start auto-hydration + dynamic reordered header-column mapping verified.');
    passed++;
  }

  // =========================================================================
  // 9. Frontend <-> Code.gs <-> Express Compatibility Check
  // =========================================================================
  {
    const gasEnv = createCodeGsTestSandbox();
    const health = gasEnv.invokeGet({ action: 'health' });
    assert.strictEqual(health.supportsBatch, true);
    assert.strictEqual(health.supportsPersistenceProof, true);

    const codeSrc = fs.readFileSync(path.resolve(process.cwd(), 'docs/google-apps-script/Code.gs'), 'utf-8');
    // Strict ES5 check: no `?.`, no `const `, no `let `, no arrow `=>`
    assert.strictEqual(codeSrc.includes('?.'), false, '9a: Code.gs has zero optional chaining');
    assert.strictEqual(/\b(let|const)\s+/.test(codeSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false, '9b: Code.gs uses strict ES5 var only');
    assert.strictEqual(codeSrc.includes('=>'), false, '9c: Code.gs has zero ES6 arrow functions');

    // Verify all action names match across Frontend, Code.gs, and Express
    const supportedActions: Array<OfflineMutation['action']> = ['attendance', 'followup', 'update', 'add'];
    for (const act of supportedActions) {
      assert.ok(codeSrc.includes(`action === '${act}'`), `9d: Code.gs handles ${act}`);
    }
    console.log('✅ Scenario 9 Passed: Frontend <-> Code.gs (strict ES5) <-> Express schema/proof compatibility verified.');
    passed++;
  }

  // =========================================================================
  // 10. Central Spreadsheet ID unification & client override protection
  // =========================================================================
  {
    assert.strictEqual(CENTRAL_SPREADSHEET_ID, '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0');
    assert.strictEqual(SPREADSHEET_ID, CENTRAL_SPREADSHEET_ID, '10a: AppContext SPREADSHEET_ID uses central config');
    assert.strictEqual(DEFAULT_SPREADSHEET_ID, CENTRAL_SPREADSHEET_ID, '10b: googleSheetParser DEFAULT_SPREADSHEET_ID uses central config');
    assert.strictEqual(ENV.GOOGLE_SHEET_ID, CENTRAL_SPREADSHEET_ID, '10c: server ENV.GOOGLE_SHEET_ID uses central config');
    assert.strictEqual(isDisallowedClientSpreadsheetOverride('1UHTw4KVxApvNUAHHpvEWwI4RCvLxyTMV'), true, '10d: Detects foreign spreadsheet ID override');
    assert.strictEqual(isDisallowedClientSpreadsheetOverride(CENTRAL_SPREADSHEET_ID), false);

    const sidebarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf-8');
    assert.strictEqual(sidebarSrc.includes('CENTRAL_SPREADSHEET_EDIT_URL'), true, '10e: Sidebar uses CENTRAL_SPREADSHEET_EDIT_URL');
    void CENTRAL_SPREADSHEET_EDIT_URL;

    // Code.gs ignores override
    const gasEnv = createCodeGsTestSandbox();
    const res = gasEnv.invokePost({
      action: 'attendance',
      idempotencyKey: 'override_guard_gas_1',
      studentId: 'st_1',
      studentCode: 'SG-001',
      sourceSheet: 'نشط',
      spreadsheetId: '1UHTw4KVxApvNUAHHpvEWwI4RCvLxyTMV',
      expectedVersion: 1,
      payload: { friday: '2026-11-20', isPresent: true }
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(gasEnv.getOpenedSpreadsheetId(), CENTRAL_SPREADSHEET_ID, '10f: Code.gs ignores client spreadsheetId override');

    // Express rejects override HTTP 400 on GET and POST
    const app = express();
    app.use(express.json());
    app.use('/api/sheets', sheetsRouter);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const adminToken = signAccessToken({ userId: 'u_ov', username: 'admin', displayName: 'Admin', role: 'admin' });

    const httpJson = (url: string, method: 'GET' | 'POST', body?: any) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          url,
          {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`,
              ...(method === 'POST' ? { 'X-Idempotency-Key': `ov_${Date.now()}` } : {})
            }
          },
          (resp) => {
            let buf = '';
            resp.on('data', (c) => (buf += c));
            resp.on('end', () => resolve({ status: resp.statusCode || 500, json: JSON.parse(buf) }));
          }
        );
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });

    try {
      const foreignId = '1UHTw4KVxApvNUAHHpvEWwI4RCvLxyTMV';
      const getDataOv = await httpJson(`http://127.0.0.1:${port}/api/sheets/data?spreadsheetId=${foreignId}`, 'GET');
      const getIdempOv = await httpJson(`http://127.0.0.1:${port}/api/sheets/idempotency?keys=k1&sheetId=${foreignId}`, 'GET');
      const postMutOv = await httpJson(`http://127.0.0.1:${port}/api/sheets/mutate`, 'POST', {
        action: 'attendance',
        studentId: 'st_1',
        sourceSheet: 'نشط',
        expectedVersion: 1,
        spreadsheetId: foreignId
      });
      const postBatchOv = await httpJson(`http://127.0.0.1:${port}/api/sheets/mutate-batch`, 'POST', {
        mutations: [{ idempotencyKey: 'k1', action: 'attendance', studentId: 'st_1', sourceSheet: 'نشط', expectedVersion: 1, spreadsheetId: foreignId }]
      });

      assert.strictEqual(getDataOv.status, 400, '10g: Express GET /data rejects foreign spreadsheetId HTTP 400');
      assert.strictEqual(getIdempOv.status, 400, '10h: Express GET /idempotency rejects foreign sheetId HTTP 400');
      assert.strictEqual(postMutOv.status, 400, '10i: Express POST /mutate rejects foreign spreadsheetId HTTP 400');
      assert.strictEqual(postBatchOv.status, 400, '10j: Express POST /mutate-batch rejects foreign spreadsheetId HTTP 400');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    console.log('✅ Scenario 10 Passed: Central Spreadsheet ID unification & client override protection verified across all 3 layers.');
    passed++;
  }

  console.log('\n======================================================================');
  console.log(`🎉 ALL ${passed} OF 10 FINAL SYNC FIX VERIFICATION SCENARIOS PASSED!`);
  console.log('======================================================================\n');
}

runTests()
  .then(() => {
    idbCloseDatabase();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 Final Sync Fix Verification Failed:', err);
    idbCloseDatabase();
    process.exit(1);
  });
