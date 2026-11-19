import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FOLLOWUP_MESSAGE_TEMPLATES,
  buildWhatsAppFollowupDeepLink,
  containsEmoji,
  normalizePhoneForWhatsApp,
  renderFollowupMessageTemplate,
  resolveFollowupClassName,
  resolveFollowupPhoneTarget
} from '../data/followupMessageTemplates';
import { BASE_FOLLOWUP_MESSAGE_TEMPLATES } from '../services/followupMessageLibrary';
import {
  validateRemotePersistenceProof,
  validateTimeoutIdempotencyEntry
} from '../services/remotePersistenceVerification';
import { processAssistantQuery, AssistantMessage } from '../services/assistantEngine';
import { QuickFollowupModal } from '../components/modals/QuickFollowupModal';
import { AuthProvider } from '../context/AuthContext';
import { AppProvider } from '../context/AppContext';
import type { Student } from '../types/student';
import type { OfflineMutation } from '../types/auth';
import sheetsRouter from '../../server/routes/sheets';
import { googleSheetsService } from '../../server/services/googleSheetsService';
import { signAccessToken } from '../../server/security/jwt';

// ============================================================================
// STRICT ISOLATION GUARD: Block any real external network calls
// ============================================================================
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) {
    throw new Error(`BLOCKED REAL EXTERNAL NETWORK REQUEST IN ISOLATED TEST: ${url}`);
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ============================================================================
// MOCK GOOGLE APPS SCRIPT ENVIRONMENT (In-Memory VM Sandbox for Code.gs)
// ============================================================================
interface MockSheetState {
  name: string;
  rows: any[][];
  hidden: boolean;
}

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
      const rowArr = this.sheet.state.rows[this.startRow - 1 + r] || [];
      const slice: any[] = [];
      for (let c = 0; c < this.numCols; c++) {
        slice.push(rowArr[this.startCol - 1 + c] !== undefined ? rowArr[this.startCol - 1 + c] : '');
      }
      out.push(slice);
    }
    return out;
  }

  getValue(): any {
    const rowArr = this.sheet.state.rows[this.startRow - 1] || [];
    return rowArr[this.startCol - 1] !== undefined ? rowArr[this.startCol - 1] : '';
  }

  setValue(val: any): void {
    this.sheet.ensureSize(this.startRow, this.startCol);
    this.sheet.state.rows[this.startRow - 1][this.startCol - 1] = val;
  }

  setValues(values: any[][]): void {
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        this.sheet.ensureSize(this.startRow + r, this.startCol + c);
        this.sheet.state.rows[this.startRow - 1 + r][this.startCol - 1 + c] = values[r][c];
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
            const cellVal = String(
              (self.sheet.state.rows[self.startRow - 1 + r] || [])[self.startCol - 1 + c] ?? ''
            );
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
  constructor(public state: MockSheetState) {}

  getName(): string {
    return this.state.name;
  }

  hideSheet(): void {
    this.state.hidden = true;
  }

  ensureSize(rows: number, cols: number): void {
    while (this.state.rows.length < rows) {
      this.state.rows.push([]);
    }
    for (let r = 0; r < this.state.rows.length; r++) {
      while (this.state.rows[r].length < cols) {
        this.state.rows[r].push('');
      }
    }
  }

  getLastRow(): number {
    return this.state.rows.length;
  }

  getLastColumn(): number {
    let maxCol = 0;
    for (const row of this.state.rows) {
      if (row.length > maxCol) maxCol = row.length;
    }
    return maxCol;
  }

  getDataRange(): MockRange {
    const r = Math.max(1, this.getLastRow());
    const c = Math.max(1, this.getLastColumn());
    return new MockRange(this, 1, 1, r, c);
  }

  getRange(row: number, col: number, numRows = 1, numCols = 1): MockRange {
    return new MockRange(this, row, col, numRows, numCols);
  }

  insertColumnBefore(colPos: number): void {
    for (const row of this.state.rows) {
      while (row.length < colPos - 1) row.push('');
      row.splice(colPos - 1, 0, '');
    }
  }

  appendRow(rowValues: any[]): void {
    this.state.rows.push([...rowValues]);
  }
}

function createCodeGsSandbox(options?: { includeFollowupLog?: boolean; includeVersionCol?: boolean }) {
  const includeFollowupLog = options?.includeFollowupLog !== false;
  const includeVersionCol = options?.includeVersionCol !== false;

  const baseHeaders = [
    'كود',
    'الاسم',
    'الاشبين',
    'موبايل المخدوم',
    'موبيل ولي الامر 1',
    'موبيل ولي الامر 2',
    'تاريخ الميلاد',
    'المنطقة',
    'العنوان',
    'ملاحظات الافتقاد',
    'آخر حضور',
    'آخر افتقاد',
    'حالة الافتقاد',
    'إجمالي الحضور',
    'حضور الشهر',
    'id'
  ];
  if (includeVersionCol) baseHeaders.push('version');

  const sheetMap = new Map<string, MockSheet>();
  const addSheet = (name: string, rows: any[][]) => {
    sheetMap.set(name, new MockSheet({ name, rows: rows.map((r) => [...r]), hidden: false }));
  };

  // Exact 5 real tabs (including trailing space in 'فصل البابا شنودة '!)
  addSheet('ردود النموذج 1', [['طابع زمني', 'الاسم'], ['2026-01-01', 'نموذج غير طلابي']]);
  if (includeFollowupLog) {
    addSheet('سجل الافتقاد', [
      ['التاريخ', 'أسبوع الجمعة', 'الشيت', 'الكود', 'الاسم', 'الأشبين', 'النوع', 'ملاحظات']
    ]);
  }
  addSheet('نشط', [
    baseHeaders,
    includeVersionCol
      ? ['SG-001', 'مينا جرجس', 'أ/ ماجد', '01011112222', '01222223333', '', '', 'الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_1', 1]
      : ['SG-001', 'مينا جرجس', 'أ/ ماجد', '01011112222', '01222223333', '', '', 'الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_1'],
    includeVersionCol
      ? ['SG-002', 'بيشوي عماد', 'أ/ ماجد', '', '01144445555', '', '', 'الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_2', 1]
      : ['SG-002', 'بيشوي عماد', 'أ/ ماجد', '', '01144445555', '', '', 'الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_2']
  ]);
  addSheet('غير حاضر', [
    baseHeaders,
    includeVersionCol
      ? ['SG-010', 'كيرلس عادل', 'أ/ رامي', '', '01566667777', '', '', 'حدائق الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_10', 1]
      : ['SG-010', 'كيرلس عادل', 'أ/ رامي', '', '01566667777', '', '', 'حدائق الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_10']
  ]);
  // LIVE TAB WITH TRAILING SPACE
  addSheet('فصل البابا شنودة ', [
    baseHeaders,
    includeVersionCol
      ? ['SG-020', 'يوحنا هاني', 'أ/ بولس', '', '01299998888', '', '', 'الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_20', 1]
      : ['SG-020', 'يوحنا هاني', 'أ/ بولس', '', '01299998888', '', '', 'الزيتون', '', '', '', '', 'بدون', 0, 0, 'st_20']
  ]);

  let openedSpreadsheetId: string | null = null;
  let flushCount = 0;
  let failFlushError: string | null = null;
  const cacheStore = new Map<string, string>();
  const scriptProps: Record<string, string> = {
    SPREADSHEET_ID: '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0'
  };

  const mockSpreadsheet = {
    getSheetByName(name: string) {
      return sheetMap.get(name) || null;
    },
    getSheets() {
      return Array.from(sheetMap.values());
    },
    insertSheet(name: string) {
      const sh = new MockSheet({ name, rows: [], hidden: false });
      sheetMap.set(name, sh);
      return sh;
    }
  };

  const sandbox: any = {
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    parseInt,
    isFinite,
    isNaN,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      openById: (id: string) => {
        openedSpreadsheetId = id;
        return mockSpreadsheet;
      },
      flush: () => {
        if (failFlushError) throw new Error(failFlushError);
        flushCount++;
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => scriptProps[k] ?? null
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cacheStore.get(k) ?? null,
        put: (k: string, v: string) => {
          cacheStore.set(k, v);
        },
        getAll: (keys: string[]) => {
          const out: Record<string, string> = {};
          for (const k of keys) {
            if (cacheStore.has(k)) out[k] = cacheStore.get(k)!;
          }
          return out;
        },
        putAll: (obj: Record<string, string>) => {
          for (const [k, v] of Object.entries(obj)) cacheStore.set(k, v);
        }
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {},
        releaseLock: () => {}
      })
    },
    Session: {
      getScriptTimeZone: () => 'Africa/Cairo'
    },
    Utilities: {
      formatDate: (_date: Date, _tz: string, fmt: string) => {
        if (fmt === 'yyyy-MM') return '2026-11';
        return '2026-11-19';
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (txt: string) => ({
        _text: txt,
        setMimeType() {
          return this;
        },
        getContent() {
          return txt;
        }
      })
    }
  };

  const codeGsSource = fs.readFileSync(path.resolve(process.cwd(), 'docs/google-apps-script/Code.gs'), 'utf-8');
  vm.createContext(sandbox);
  vm.runInContext(codeGsSource, sandbox);

  const invokePost = (bodyObj: any) => {
    const out = sandbox.doPost({
      postData: { contents: JSON.stringify(bodyObj) },
      parameter: {}
    });
    return JSON.parse(out.getContent());
  };

  const invokeGet = (params: Record<string, string>) => {
    const out = sandbox.doGet({ parameter: params });
    return JSON.parse(out.getContent());
  };

  return {
    invokePost,
    invokeGet,
    sheetMap,
    cacheStore,
    getOpenedSpreadsheetId: () => openedSpreadsheetId,
    getFlushCount: () => flushCount,
    setFailFlushError: (msg: string | null) => {
      failFlushError = msg;
    }
  };
}

// ============================================================================
// PART A: SYNC & CENTRAL GOOGLE SHEETS PERSISTENCE TESTS
// ============================================================================
async function testPartA_CodeGsAndExpressPersistence() {
  console.log('\n--- Part A: Sync, Code.gs Sandbox & Express Relay Persistence Tests ---');

  const env = createCodeGsSandbox({ includeFollowupLog: true, includeVersionCol: true });

  // A1. Health check & Central Spreadsheet ID enforcement (client cannot override spreadsheetId)
  const health = env.invokeGet({ action: 'health' });
  assert.strictEqual(health.ok, true, 'A1a: Code.gs health must return ok=true');
  assert.strictEqual(health.supportsPersistenceProof, true, 'A1b: Code.gs health declares supportsPersistenceProof');

  // A2. Attendance write -> real cell updated + valid RemotePersistenceProof
  const attMut: OfflineMutation = {
    id: 'mut_att_001',
    action: 'attendance',
    studentId: 'st_1',
    studentName: 'مينا جرجس',
    studentCode: 'SG-001',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', isPresent: true }
  };
  const attRes = env.invokePost({
    action: 'attendance',
    idempotencyKey: attMut.id,
    studentId: attMut.studentId,
    studentCode: attMut.studentCode,
    studentName: attMut.studentName,
    sourceSheet: attMut.sourceSheet,
    spreadsheetId: 'FAKE_CLIENT_OVERRIDE_SHEET_ID',
    expectedVersion: 1,
    payload: attMut.payload
  });
  assert.strictEqual(
    env.getOpenedSpreadsheetId(),
    '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0',
    'A2a: Code.gs MUST ignore client spreadsheetId and target central Spreadsheet ID'
  );
  assert.strictEqual(attRes.ok, true, 'A2b: Attendance write succeeds');
  const attValidation = validateRemotePersistenceProof(attMut, attRes);
  assert.strictEqual(attValidation.valid, true, `A2c: Attendance proof must pass Phase 4.3.3 validator (${attValidation.reason})`);
  assert.strictEqual(attValidation.proof?.friday, '2026-11-20');
  assert.strictEqual(attValidation.proof?.row, 2);
  assert.strictEqual(attValidation.proof?.newVersion, 2);

  // A3. Follow-up write -> preserves Cairo date, friday, recordId + appends to 'سجل الافتقاد' + valid proof
  const fuMut: OfflineMutation = {
    id: 'mut_fu_001',
    action: 'followup',
    studentId: 'st_1',
    studentName: 'مينا جرجس',
    studentCode: 'SG-001',
    sourceSheet: 'نشط',
    expectedVersion: 2,
    timestamp: Date.now(),
    retryCount: 0,
    payload: {
      friday: '2026-11-20',
      date: '2026-11-18',
      method: 'تم تليفونياً',
      callOutcome: 'تم التواصل',
      notes: 'والده أكد حضوره الجمعة',
      recordId: 'fu_rec_001'
    }
  };
  const fuRes = env.invokePost({
    action: 'followup',
    idempotencyKey: fuMut.id,
    studentId: fuMut.studentId,
    studentCode: fuMut.studentCode,
    studentName: fuMut.studentName,
    sourceSheet: fuMut.sourceSheet,
    expectedVersion: 2,
    payload: fuMut.payload
  });
  assert.strictEqual(fuRes.ok, true, 'A3a: Followup write succeeds');
  const fuValidation = validateRemotePersistenceProof(fuMut, fuRes);
  assert.strictEqual(fuValidation.valid, true, `A3b: Followup proof must pass strict validator (${fuValidation.reason})`);
  assert.strictEqual(fuValidation.proof?.followupLogAppended, true);
  assert.strictEqual(fuValidation.proof?.followupLogRow, 2);
  assert.strictEqual(fuValidation.proof?.recordId, 'fu_rec_001');
  assert.strictEqual(fuValidation.proof?.date, '2026-11-18', 'A3c: Client Cairo date must be preserved (not overwritten)');
  assert.strictEqual(fuValidation.proof?.friday, '2026-11-20', 'A3d: Client friday week must be preserved');
  assert.strictEqual(env.sheetMap.get('سجل الافتقاد')!.getLastRow(), 2, 'A3e: Followup log row appended once');

  // A4. Duplicate Follow-up submission (Idempotency) -> deduplicated, ZERO duplicate rows in 'سجل الافتقاد'
  const fuDupRes = env.invokePost({
    action: 'followup',
    idempotencyKey: fuMut.id,
    studentId: fuMut.studentId,
    studentCode: fuMut.studentCode,
    studentName: fuMut.studentName,
    sourceSheet: fuMut.sourceSheet,
    expectedVersion: 2,
    payload: fuMut.payload
  });
  assert.strictEqual(fuDupRes.deduplicated, true, 'A4a: Duplicate followup returns deduplicated=true');
  assert.strictEqual(env.sheetMap.get('سجل الافتقاد')!.getLastRow(), 2, 'A4b: Zero duplicate rows appended to سجل الافتقاد');
  assert.strictEqual(validateRemotePersistenceProof(fuMut, fuDupRes).valid, true, 'A4c: Deduplicated replay still carries valid proof');

  // A5. Post-timeout checkIdempotency verification (found & not found)
  env.cacheStore.clear(); // Force reading from durable _mutation_idempotency sheet
  const idempCheck = env.invokeGet({ action: 'checkIdempotency', keys: `${attMut.id},${fuMut.id},mut_never_sent` });
  assert.strictEqual(idempCheck.ok, true);
  const attTimeoutCheck = validateTimeoutIdempotencyEntry(attMut, idempCheck.results[attMut.id]);
  const fuTimeoutCheck = validateTimeoutIdempotencyEntry(fuMut, idempCheck.results[fuMut.id]);
  const missingTimeoutCheck = validateTimeoutIdempotencyEntry(
    { ...attMut, id: 'mut_never_sent' },
    idempCheck.results['mut_never_sent']
  );
  assert.strictEqual(attTimeoutCheck.outcome, 'verified_persisted', 'A5a: Timeout check verifies attendance from durable sheet ledger');
  assert.strictEqual(fuTimeoutCheck.outcome, 'verified_persisted', 'A5b: Timeout check verifies followup from durable sheet ledger');
  assert.strictEqual(missingTimeoutCheck.outcome, 'not_found_retryable', 'A5c: Unsent key returns not_found_retryable');

  // A6. Add & Update student writes + valid proofs
  const addMut: OfflineMutation = {
    id: 'mut_add_001',
    action: 'add',
    studentId: 'st_new_99',
    studentName: 'فادي سمير',
    studentCode: 'SG-099',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: {
      newStudent: {
        id: 'st_new_99',
        code: 'SG-099',
        name: 'فادي سمير',
        servant: 'أ/ ماجد',
        phoneParent1: '01212345678',
        sourceSheet: 'نشط'
      }
    }
  };
  const addRes = env.invokePost({
    action: 'add',
    idempotencyKey: addMut.id,
    studentId: addMut.studentId,
    studentCode: addMut.studentCode,
    studentName: addMut.studentName,
    sourceSheet: addMut.sourceSheet,
    payload: addMut.payload
  });
  assert.strictEqual(validateRemotePersistenceProof(addMut, addRes).valid, true, 'A6a: Add student returns valid proof');

  const updMut: OfflineMutation = {
    id: 'mut_upd_001',
    action: 'update',
    studentId: 'st_new_99',
    studentName: 'فادي سمير',
    studentCode: 'SG-099',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { updatedData: { area: 'عين شمس', notes: 'متابع بانتظام' } }
  };
  const updRes = env.invokePost({
    action: 'update',
    idempotencyKey: updMut.id,
    studentId: updMut.studentId,
    studentCode: updMut.studentCode,
    studentName: updMut.studentName,
    sourceSheet: updMut.sourceSheet,
    expectedVersion: 1,
    payload: updMut.payload
  });
  assert.strictEqual(validateRemotePersistenceProof(updMut, updRes).valid, true, 'A6b: Update student returns valid proof');

  // A7. Delete blocked with HTTP 403
  const delRes = env.invokePost({ action: 'delete', studentId: 'st_1', sourceSheet: 'نشط' });
  assert.strictEqual(delRes.ok, false);
  assert.strictEqual(delRes.status, 403, 'A7: Zero-delete policy enforced with HTTP 403');

  // A8. Trailing-space tab mapping ('فصل البابا شنودة' <-> 'فصل البابا شنودة ') WITHOUT creating a new tab!
  const beforeSheetCount = env.sheetMap.size;
  const popeMut: OfflineMutation = {
    id: 'mut_pope_att_1',
    action: 'attendance',
    studentId: 'st_20',
    studentName: 'يوحنا هاني',
    studentCode: 'SG-020',
    sourceSheet: 'فصل البابا شنودة',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', isPresent: true }
  };
  const popeRes = env.invokePost({
    action: 'attendance',
    idempotencyKey: popeMut.id,
    studentId: popeMut.studentId,
    studentCode: popeMut.studentCode,
    studentName: popeMut.studentName,
    sourceSheet: 'فصل البابا شنودة',
    expectedVersion: 1,
    payload: popeMut.payload
  });
  assert.strictEqual(popeRes.ok, true, 'A8a: UI tab name without trailing space resolves live tab with trailing space');
  assert.strictEqual(env.sheetMap.size, beforeSheetCount, 'A8b: No new tab created for فصل البابا شنودة');
  assert.strictEqual(validateRemotePersistenceProof(popeMut, popeRes).valid, true, 'A8c: Proof uses canonical sheetName matching mutation');

  // A9. Missing tab ('غير نشط') returns 404, does NOT create tab, NEVER writes to 'ردود النموذج 1'
  const formRowsBefore = env.sheetMap.get('ردود النموذج 1')!.getLastRow();
  const missingTabRes = env.invokePost({
    action: 'attendance',
    idempotencyKey: 'mut_missing_tab',
    studentId: 'st_x',
    studentCode: 'SG-X',
    sourceSheet: 'غير نشط',
    expectedVersion: 1,
    payload: { friday: '2026-11-20', isPresent: true }
  });
  assert.strictEqual(missingTabRes.ok, false);
  assert.strictEqual(missingTabRes.status, 404, 'A9a: Missing tab returns 404');
  assert.strictEqual(env.sheetMap.has('غير نشط'), false, 'A9b: Missing tab is NEVER auto-created');
  assert.strictEqual(env.sheetMap.get('ردود النموذج 1')!.getLastRow(), formRowsBefore, 'A9c: ردود النموذج 1 is NEVER touched');

  // A10. OCC 409 conflict when version column exists
  const occRes = env.invokePost({
    action: 'attendance',
    idempotencyKey: 'mut_occ_stale',
    studentId: 'st_1',
    studentCode: 'SG-001',
    sourceSheet: 'نشط',
    expectedVersion: 1, // current version is 3
    payload: { friday: '2026-11-20', isPresent: false }
  });
  assert.strictEqual(occRes.ok, false);
  assert.strictEqual(occRes.status, 409, 'A10: Stale expectedVersion rejected with HTTP 409');

  // A11. Legacy sheet without version column (versionCol === -1) succeeds without false 409!
  const noVerEnv = createCodeGsSandbox({ includeFollowupLog: true, includeVersionCol: false });
  const noVerMut: OfflineMutation = {
    id: 'mut_nover_1',
    action: 'attendance',
    studentId: 'st_1',
    studentCode: 'SG-001',
    studentName: 'كيرلس مرقس',
    sourceSheet: 'نشط',
    expectedVersion: 5,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', isPresent: true }
  };
  const noVerRes = noVerEnv.invokePost({
    action: 'attendance',
    idempotencyKey: noVerMut.id,
    studentId: noVerMut.studentId,
    studentCode: noVerMut.studentCode,
    sourceSheet: noVerMut.sourceSheet,
    expectedVersion: 5,
    payload: noVerMut.payload
  });
  assert.strictEqual(noVerRes.ok, true, 'A11a: Sheet without version column avoids false 409');
  assert.strictEqual(validateRemotePersistenceProof(noVerMut, noVerRes).valid, true, 'A11b: Still emits valid proof');

  // A12. Missing 'سجل الافتقاد' fails loudly (NEVER silent success!)
  const noLogEnv = createCodeGsSandbox({ includeFollowupLog: false, includeVersionCol: true });
  const noLogRes = noLogEnv.invokePost({
    action: 'followup',
    idempotencyKey: 'mut_nolog_1',
    studentId: 'st_1',
    studentCode: 'SG-001',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    payload: { friday: '2026-11-20', date: '2026-11-19', method: 'تم تليفونياً', recordId: 'fu_nolog' }
  });
  assert.strictEqual(noLogRes.ok, false, 'A12a: Missing سجل الافتقاد must return ok=false');
  assert.notStrictEqual(noLogRes.persisted, true, 'A12b: Must never return persisted=true when log tab missing');

  // A13. Batch attendance + batch followup + partial failure isolation + write failure protection
  const batchAttMut: OfflineMutation = {
    id: 'mut_batch_att_1',
    action: 'attendance',
    studentId: 'st_2',
    studentCode: 'SG-002',
    studentName: 'يوسف سامي',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', isPresent: true }
  };
  const batchFuMut: OfflineMutation = {
    id: 'mut_batch_fu_1',
    action: 'followup',
    studentId: 'st_20',
    studentCode: 'SG-020',
    studentName: 'بولا أشرف',
    sourceSheet: 'فصل البابا شنودة',
    expectedVersion: 2,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', date: '2026-11-19', method: 'واتساب', recordId: 'fu_batch_rec_1' }
  };
  const batchRes = env.invokePost({
    action: 'batch',
    mutations: [
      { ...batchAttMut, idempotencyKey: batchAttMut.id },
      { ...batchFuMut, idempotencyKey: batchFuMut.id },
      { idempotencyKey: 'mut_batch_missing', action: 'attendance', studentId: 'st_404', studentCode: 'SG-404', sourceSheet: 'نشط', expectedVersion: 1, payload: { friday: '2026-11-20', isPresent: true } }
    ]
  });
  assert.strictEqual(batchRes.ok, true);
  assert.strictEqual(validateRemotePersistenceProof(batchAttMut, batchRes.results[0]).valid, true, 'A13a: Batch attendance item emits valid proof');
  assert.strictEqual(validateRemotePersistenceProof(batchFuMut, batchRes.results[1]).valid, true, 'A13b: Batch followup item emits valid proof');
  assert.strictEqual(batchRes.results[2].ok, false, 'A13c: Missing student in batch fails independently without corrupting valid items');
  assert.strictEqual(batchRes.results[2].status, 404);

  // A14. Flush/write failure never returns persisted=true
  env.setFailFlushError('Simulated Google Sheets write outage');
  const failedWriteRes = env.invokePost({
    action: 'attendance',
    idempotencyKey: 'mut_write_fail_1',
    studentId: 'st_2',
    studentCode: 'SG-002',
    sourceSheet: 'نشط',
    expectedVersion: 2,
    payload: { friday: '2026-11-20', isPresent: false }
  });
  env.setFailFlushError(null);
  assert.strictEqual(failedWriteRes.ok, false, 'A14a: Sheet write failure returns ok=false');
  assert.notStrictEqual(failedWriteRes.persisted, true, 'A14b: Sheet write failure never returns persisted=true');

  // A15. Express Relay (/api/sheets/mutate, /mutate-batch, /idempotency) with full RemotePersistenceProof
  googleSheetsService.seedTestFixtureStudentsOnly([
    {
      id: 'exp_st_1',
      code: 'SG-E1',
      name: 'أبانوب نادر',
      servant: 'أ/ ماجد',
      phoneStudent: '',
      phoneParent1: '01233334444',
      phoneParent2: '',
      birthDate: '',
      area: 'الزيتون',
      address: '',
      notes: '',
      followupStatus: 'بدون',
      attendanceTotal: 0,
      attendanceMonth: 0,
      attendanceStatus: 'غائب',
      sourceSheet: 'فصل البابا شنودة',
      version: 1,
      att: {},
      fu: {}
    }
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sheets', sheetsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const adminToken = signAccessToken({ userId: 'u_admin', username: 'admin', displayName: 'Admin', role: 'admin' });

  try {
    // Express single attendance
    const expAttMut: OfflineMutation = {
      id: `exp_att_${Date.now()}`,
      action: 'attendance',
      studentId: 'exp_st_1',
      studentCode: 'SG-E1',
      studentName: 'مارك جرجس',
      sourceSheet: 'فصل البابا شنودة',
      expectedVersion: 1,
      timestamp: Date.now(),
      retryCount: 0,
      payload: { friday: '2026-11-20', isPresent: true }
    };
    const expAttResp = await fetch(`${baseUrl}/api/sheets/mutate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'X-Idempotency-Key': expAttMut.id
      },
      body: JSON.stringify(expAttMut)
    });
    const expAttJson = await expAttResp.json();
    assert.strictEqual(expAttResp.status, 200);
    assert.strictEqual(validateRemotePersistenceProof(expAttMut, expAttJson).valid, true, 'A15a: Express /mutate attendance returns valid proof');

    // Express single followup
    const expFuMut: OfflineMutation = {
      id: `exp_fu_${Date.now()}`,
      action: 'followup',
      studentId: 'exp_st_1',
      studentCode: 'SG-E1',
      studentName: 'مارك جرجس',
      sourceSheet: 'فصل البابا شنودة',
      expectedVersion: 2,
      timestamp: Date.now(),
      retryCount: 0,
      payload: {
        friday: '2026-11-20',
        date: '2026-11-19',
        method: 'واتساب',
        notes: 'تم إرسال رسالة افتقاد',
        recordId: 'exp_fu_rec_1'
      }
    };
    const expFuResp = await fetch(`${baseUrl}/api/sheets/mutate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'X-Idempotency-Key': expFuMut.id
      },
      body: JSON.stringify(expFuMut)
    });
    const expFuJson = await expFuResp.json();
    assert.strictEqual(expFuResp.status, 200);
    assert.strictEqual(validateRemotePersistenceProof(expFuMut, expFuJson).valid, true, 'A15b: Express /mutate followup returns valid proof');
    assert.strictEqual(googleSheetsService.getFixtureFollowupLog().length, 1, 'A15c: Express appended followup log row');

    // Express /idempotency returns stored proof cleanly
    const expIdempResp = await fetch(`${baseUrl}/api/sheets/idempotency?keys=${encodeURIComponent(`${expAttMut.id},${expFuMut.id},missing_exp_key`)}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const expIdempJson = await expIdempResp.json();
    assert.strictEqual(
      validateTimeoutIdempotencyEntry(expAttMut, expIdempJson.results[expAttMut.id]).outcome,
      'verified_persisted',
      'A15d: Express /idempotency verifies attendance proof'
    );
    assert.strictEqual(
      validateTimeoutIdempotencyEntry(expFuMut, expIdempJson.results[expFuMut.id]).outcome,
      'verified_persisted',
      'A15e: Express /idempotency verifies followup proof'
    );
    assert.strictEqual(
      validateTimeoutIdempotencyEntry({ ...expAttMut, id: 'missing_exp_key' }, expIdempJson.results['missing_exp_key']).outcome,
      'not_found_retryable',
      'A15f: Express /idempotency returns not_found_retryable for unknown key'
    );

    // Express /mutate-batch with attendance + followup
    const expBatchAtt: OfflineMutation = {
      id: `exp_batt_${Date.now()}`,
      action: 'attendance',
      studentId: 'exp_st_1',
      studentCode: 'SG-E1',
      studentName: 'مارك جرجس',
      sourceSheet: 'فصل البابا شنودة',
      expectedVersion: 3,
      timestamp: Date.now(),
      retryCount: 0,
      payload: { friday: '2026-11-27', isPresent: true }
    };
    const expBatchFu: OfflineMutation = {
      id: `exp_bfu_${Date.now()}`,
      action: 'followup',
      studentId: 'exp_st_1',
      studentCode: 'SG-E1',
      studentName: 'مارك جرجس',
      sourceSheet: 'فصل البابا شنودة',
      expectedVersion: 4,
      timestamp: Date.now(),
      retryCount: 0,
      payload: { friday: '2026-11-27', date: '2026-11-26', method: 'تم تليفونياً', callOutcome: 'تم التواصل', recordId: 'exp_bfu_rec_2' }
    };
    const expBatchResp = await fetch(`${baseUrl}/api/sheets/mutate-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        mutations: [
          { ...expBatchAtt, idempotencyKey: expBatchAtt.id },
          { ...expBatchFu, idempotencyKey: expBatchFu.id }
        ]
      })
    });
    const expBatchJson = await expBatchResp.json();
    assert.strictEqual(expBatchResp.status, 200);
    assert.strictEqual(validateRemotePersistenceProof(expBatchAtt, expBatchJson.results[0]).valid, true, 'A15g: Express /mutate-batch attendance item has valid proof');
    assert.strictEqual(validateRemotePersistenceProof(expBatchFu, expBatchJson.results[1]).valid, true, 'A15h: Express /mutate-batch followup item has valid proof');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('✅ Part A Passed: Code.gs sandbox & Express Relay persistence, proofs, tab mapping, OCC, idempotency & batch verified.');
}

// ============================================================================
// PART B: WHATSAPP FOLLOW-UP & 20 TEMPLATES TESTS
// ============================================================================
function testPartB_WhatsAppAndTemplates() {
  console.log('\n--- Part B: Unified 20 Follow-up Templates, Phone Normalization & QuickFollowupModal Tests ---');

  // B1. Exactly 20 templates & single source of truth
  assert.strictEqual(FOLLOWUP_MESSAGE_TEMPLATES.length, 20, 'B1a: Must contain exactly 20 follow-up templates');
  assert.strictEqual(BASE_FOLLOWUP_MESSAGE_TEMPLATES.length, 20, 'B1b: Library must expose the exact same 20 templates');
  const uniqueIds = new Set(FOLLOWUP_MESSAGE_TEMPLATES.map((t) => t.id));
  assert.strictEqual(uniqueIds.size, 20, 'B1c: All 20 template IDs must be unique');

  // B2. Zero emojis & zero unreplaced placeholders across all 20 templates (full data & missing data)
  for (const tpl of FOLLOWUP_MESSAGE_TEMPLATES) {
    assert.strictEqual(containsEmoji(tpl.template), false, `B2a: Raw template ${tpl.id} must have ZERO emojis`);

    const withFullData = renderFollowupMessageTemplate(tpl, {
      studentName: 'مارك جرجس',
      parentName: 'أستاذ جرجس',
      className: 'فصل البابا شنودة',
      meetingSchedule: 'الجمعة الساعة 11 صباحاً'
    });
    assert.strictEqual(containsEmoji(withFullData), false, `B2b: Rendered ${tpl.id} must have ZERO emojis`);
    assert.strictEqual(/\{\{[^}]*\}\}/.test(withFullData), false, `B2c: Rendered ${tpl.id} must have ZERO leftover placeholders`);
    assert.ok(withFullData.includes('مارك'), `B2d: Rendered ${tpl.id} personalizes student name`);
    assert.ok(withFullData.includes('فصل البابا شنودة'), `B2e: Rendered ${tpl.id} personalizes class name`);
    assert.ok(withFullData.includes('الجمعة الساعة 11 صباحاً'), `B2f: Rendered ${tpl.id} includes meeting schedule when provided`);

    const withMissingData = renderFollowupMessageTemplate(tpl, {});
    assert.strictEqual(containsEmoji(withMissingData), false, `B2g: Fallback rendered ${tpl.id} must have ZERO emojis`);
    assert.strictEqual(/\{\{[^}]*\}\}/.test(withMissingData), false, `B2h: Fallback rendered ${tpl.id} must have ZERO leftover placeholders`);
    assert.strictEqual(withMissingData.includes('undefined'), false, `B2i: Fallback rendered ${tpl.id} must never output undefined`);
    assert.strictEqual(withMissingData.includes('  '), false, `B2j: Fallback rendered ${tpl.id} must have clean spacing`);
  }

  assert.strictEqual(resolveFollowupClassName('نشط'), 'فصل الشهيد مارجرجس');
  assert.strictEqual(resolveFollowupClassName('فصل البابا شنودة '), 'فصل البابا شنودة');

  // B3. Phone normalization (Egyptian local, international, Arabic digits, invalid)
  assert.deepStrictEqual(normalizePhoneForWhatsApp('01234567890'), { valid: true, digits: '201234567890' });
  assert.deepStrictEqual(normalizePhoneForWhatsApp('+20 10-1234-5678'), { valid: true, digits: '201012345678' });
  assert.deepStrictEqual(normalizePhoneForWhatsApp('00201198765432'), { valid: true, digits: '201198765432' });
  assert.deepStrictEqual(normalizePhoneForWhatsApp('٠١٥١٢٣٤٥٦٧٨'), { valid: true, digits: '201512345678' });
  assert.deepStrictEqual(normalizePhoneForWhatsApp('+966 55 123 4567'), { valid: true, digits: '966551234567' });
  assert.strictEqual(normalizePhoneForWhatsApp('').valid, false);
  assert.strictEqual(normalizePhoneForWhatsApp('غير مسجل').valid, false);
  assert.strictEqual(normalizePhoneForWhatsApp('12345').valid, false);
  assert.strictEqual(normalizePhoneForWhatsApp('00000000000').valid, false);

  // B4. Parent-first phone priority & deep link format
  const parentFirst = resolveFollowupPhoneTarget({
    phoneParent1: '01211112222',
    phoneParent2: '01133334444',
    phoneStudent: '01055556666'
  });
  assert.strictEqual(parentFirst.hasValidPhone, true);
  assert.strictEqual(parentFirst.source, 'parent1');
  assert.strictEqual(parentFirst.normalizedDigits, '201211112222');
  assert.strictEqual(parentFirst.isFallbackToStudent, false);

  const parent2Fallback = resolveFollowupPhoneTarget({
    phoneParent1: 'غير مسجل',
    phoneParent2: '01133334444',
    phoneStudent: '01055556666'
  });
  assert.strictEqual(parent2Fallback.source, 'parent2');
  assert.strictEqual(parent2Fallback.isFallbackToStudent, false);

  const studentFallback = resolveFollowupPhoneTarget({
    phoneParent1: '',
    phoneParent2: '',
    phoneStudent: '01055556666'
  });
  assert.strictEqual(studentFallback.source, 'student');
  assert.strictEqual(studentFallback.isFallbackToStudent, true);

  const noPhone = resolveFollowupPhoneTarget({ phoneParent1: '', phoneParent2: '---', phoneStudent: '' });
  assert.strictEqual(noPhone.hasValidPhone, false);
  assert.strictEqual(noPhone.source, 'none');
  assert.ok(Boolean(noPhone.warningMessage));

  const validLink = buildWhatsAppFollowupDeepLink('01211112222', 'سلام ونعمة يا بطل');
  assert.strictEqual(validLink, `https://wa.me/201211112222?text=${encodeURIComponent('سلام ونعمة يا بطل')}`);
  assert.strictEqual(buildWhatsAppFollowupDeepLink('غير مسجل', 'سلام'), null, 'B4: Invalid phone must return null deep link');

  // B5. QuickFollowupModal SSR checks (with valid parent phone AND with missing phone)
  const studentWithParentPhone: Student = {
    id: 'ui_st_1',
    code: 'SG-U1',
    name: 'ديفيد ماجد',
    servant: 'أ/ ماجد',
    phoneStudent: '01000001111',
    phoneParent1: '01299887766',
    phoneParent2: '',
    birthDate: '',
    area: 'الزيتون',
    address: '',
    notes: '',
    followupStatus: 'بدون',
    attendanceTotal: 2,
    attendanceMonth: 2,
    attendanceStatus: 'غائب',
    sourceSheet: 'فصل البابا شنودة',
    version: 1,
    att: {},
    fu: {}
  };

  const modalHtmlValid = renderToStaticMarkup(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(
        AppProvider,
        null,
        React.createElement(QuickFollowupModal, {
          student: studentWithParentPhone,
          isOpen: true,
          onClose: () => {}
        })
      )
    )
  );
  // Existing fields preserved
  assert.ok(modalHtmlValid.includes('اتصال تليفوني'), 'B5a: Preserves اتصال تليفوني option');
  assert.ok(modalHtmlValid.includes('نتيجة الاتصال'), 'B5b: Preserves نتيجة الاتصال');
  assert.ok(modalHtmlValid.includes('تفاصيل وملاحظات الافتقاد'), 'B5c: Preserves notes textarea');
  assert.ok(modalHtmlValid.includes('تسجيل الافتقاد الآن'), 'B5d: Preserves submit button');
  // New WhatsApp section checks
  assert.ok(modalHtmlValid.includes('whatsapp-followup-section'), 'B5e: Renders WhatsApp follow-up section');
  assert.ok(modalHtmlValid.includes('إرسال عبر واتساب'), 'B5f: Renders manual WhatsApp send button');
  assert.ok(modalHtmlValid.includes('https://wa.me/201299887766?text='), 'B5g: Targets parent phone 1 in wa.me link');
  assert.ok(modalHtmlValid.includes('ديفيد'), 'B5h: Personalizes preview with student name');
  assert.ok(modalHtmlValid.includes('نسخ الرسالة'), 'B5i: Provides Copy Message button');
  for (const tpl of FOLLOWUP_MESSAGE_TEMPLATES) {
    assert.ok(modalHtmlValid.includes(tpl.title), `B5j: Modal selector includes template ${tpl.index}: ${tpl.title}`);
  }

  const studentNoPhone: Student = { ...studentWithParentPhone, id: 'ui_st_2', phoneStudent: '', phoneParent1: '', phoneParent2: '' };
  const modalHtmlNoPhone = renderToStaticMarkup(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(
        AppProvider,
        null,
        React.createElement(QuickFollowupModal, {
          student: studentNoPhone,
          isOpen: true,
          onClose: () => {}
        })
      )
    )
  );
  assert.ok(modalHtmlNoPhone.includes('لا يوجد رقم هاتف مسجل'), 'B5k: Displays clear warning when no valid phone exists');
  assert.ok(modalHtmlNoPhone.includes('نسخ الرسالة'), 'B5l: Keeps Copy Message button available when no phone exists');
  assert.strictEqual(modalHtmlNoPhone.includes('whatsapp-followup-send-link'), false, 'B5m: Does not render invalid wa.me link when phone is missing');

  // Verify zero window.open / auto-send inside QuickFollowupModal source
  const modalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/QuickFollowupModal.tsx'), 'utf-8');
  assert.strictEqual(modalSrc.includes('window.open'), false, 'B5n: QuickFollowupModal never auto-opens popups');

  console.log('✅ Part B Passed: 20 templates, zero emojis, personalization, parent-first phone normalization & QuickFollowupModal verified.');
}

// ============================================================================
// PART C: SMART ASSISTANT INTEGRATION TESTS
// ============================================================================
function testPartC_SmartAssistantFollowupIntegration() {
  console.log('\n--- Part C: Smart Assistant Follow-up Message Integration Tests ---');

  const students: Student[] = [
    {
      id: 'ast_st_1',
      code: 'SG-A1',
      name: 'جورج أشرف',
      servant: 'أ/ ماجد',
      phoneStudent: '01012345678',
      phoneParent1: '01287654321',
      phoneParent2: '',
      birthDate: '',
      area: 'الزيتون',
      address: '',
      notes: '',
      followupStatus: 'بدون',
      attendanceTotal: 3,
      attendanceMonth: 2,
      attendanceStatus: 'غائب',
      sourceSheet: 'فصل البابا شنودة',
      version: 1,
      att: {},
      fu: {}
    },
    {
      id: 'ast_st_2',
      code: 'SG-A2',
      name: 'بولا سامح',
      servant: 'أ/ ماجد',
      phoneStudent: '',
      phoneParent1: '',
      phoneParent2: '',
      birthDate: '',
      area: 'الزيتون',
      address: '',
      notes: '',
      followupStatus: 'بدون',
      attendanceTotal: 1,
      attendanceMonth: 1,
      attendanceStatus: 'غائب',
      sourceSheet: 'نشط',
      version: 1,
      att: {},
      fu: {}
    }
  ];

  // C1. Generic follow-up request
  const r1 = processAssistantQuery('اكتب رسالة افتقاد لـ جورج أشرف', students, { sessionMessages: [] });
  assert.strictEqual(r1.meta?.intent, 'message');
  assert.ok(r1.copyText && r1.copyText.includes('جورج'), 'C1a: Personalizes student name');
  assert.ok(r1.copyText && r1.copyText.includes('فصل البابا شنودة'), 'C1b: Personalizes class name');
  assert.strictEqual(containsEmoji(r1.text), false, 'C1c: Assistant follow-up response text has ZERO emojis');
  assert.strictEqual(containsEmoji(r1.copyText || ''), false, 'C1d: Assistant copyText has ZERO emojis');
  assert.strictEqual(/\{\{[^}]*\}\}/.test(r1.copyText || ''), false, 'C1e: Zero unreplaced placeholders');
  assert.strictEqual(r1.whatsappPhone, '01287654321', 'C1f: Prioritizes parent phone 1');
  const r1WaLink = buildWhatsAppFollowupDeepLink(r1.whatsappPhone, r1.copyText || '');
  assert.ok(r1WaLink && r1WaLink.startsWith('https://wa.me/201287654321?text='), 'C1f-link: Generates valid normalized wa.me link for parent phone 1');
  const firstTplId = r1.meta?.suggestedFollowupTemplateIds?.[0];
  assert.ok(firstTplId && FOLLOWUP_MESSAGE_TEMPLATES.some((t) => t.id === firstTplId), 'C1g: Uses unified 20 templates');

  // C2. Requesting a different message ("هات رسالة مختلفة") MUST avoid repeating previous template & keep student context
  const sessionMsgs: AssistantMessage[] = [
    { id: 'u1', role: 'user', text: 'اكتب رسالة افتقاد لـ جورج أشرف', timestamp: 1 },
    { id: 'b1', role: 'bot', text: r1.text, copyText: r1.copyText, meta: r1.meta, timestamp: 2 }
  ];
  const r2 = processAssistantQuery('هات رسالة مختلفة', students, { sessionMessages: sessionMsgs });
  const secondTplId = r2.meta?.suggestedFollowupTemplateIds?.[0];
  assert.ok(secondTplId && secondTplId !== firstTplId, 'C2a: "هات رسالة مختلفة" selects a genuinely different template');
  assert.ok(r2.copyText?.includes('جورج'), 'C2b: Retains student context on follow-up request');
  assert.strictEqual(containsEmoji(r2.copyText || ''), false, 'C2c: Zero emojis in alternative message');

  // C3. Parent-addressed, Student-addressed, Short, "عايز أفتقد الطالب ده", and Multiple suggestions
  const rParent = processAssistantQuery('عايز رسالة لولي الأمر لـ جورج أشرف', students, { sessionMessages: [] });
  assert.strictEqual(rParent.meta?.lastFollowupAudience, 'parent', 'C3a: Routes parent request to parent audience');
  assert.strictEqual(containsEmoji(rParent.copyText || ''), false);

  const rStudent = processAssistantQuery('اكتب رسالة للطالب جورج أشرف', students, { sessionMessages: [] });
  assert.strictEqual(rStudent.meta?.lastFollowupAudience, 'student', 'C3b: Routes student request to student audience');
  assert.strictEqual(containsEmoji(rStudent.copyText || ''), false);

  const rShort = processAssistantQuery('اكتب رسالة قصيرة لـ جورج أشرف', students, { sessionMessages: [] });
  const shortTpl = FOLLOWUP_MESSAGE_TEMPLATES.find((t) => t.id === rShort.meta?.suggestedFollowupTemplateIds?.[0]);
  assert.strictEqual(shortTpl?.isShort, true, 'C3c: Short request picks concise template');
  assert.strictEqual(containsEmoji(rShort.copyText || ''), false);

  const rDirectWant = processAssistantQuery('عايز أفتقد الطالب ده', students, { sessionMessages: sessionMsgs });
  assert.strictEqual(rDirectWant.meta?.intent, 'message', 'C3d: "عايز أفتقد الطالب ده" produces follow-up suggestion');
  assert.ok(rDirectWant.copyText?.includes('جورج'), 'C3e: Uses contextual student');

  const rMulti = processAssistantQuery('اقترح رسائل افتقاد لـ جورج أشرف', students, { sessionMessages: [] });
  assert.strictEqual(rMulti.meta?.followupOptions?.length, 3, 'C3f: Multi-suggestion returns 3 distinct options');
  assert.strictEqual(new Set(rMulti.meta?.followupOptions?.map((o) => o.templateId)).size, 3);
  for (const opt of rMulti.meta?.followupOptions || []) {
    assert.strictEqual(containsEmoji(opt.message), false, 'C3g: All multi-suggestion options have ZERO emojis');
  }

  // C4. Student without valid phone -> warns cleanly, no invalid whatsappPhone
  const rNoPhone = processAssistantQuery('اكتب رسالة افتقاد لـ بولا سامح', students, { sessionMessages: [] });
  assert.strictEqual(rNoPhone.whatsappPhone, undefined, 'C4a: Never invents phone for student without phone');
  assert.ok(Boolean(rNoPhone.meta?.followupPhoneWarning), 'C4b: Supplies clear warning when phone is missing');
  assert.ok(Boolean(rNoPhone.copyText), 'C4c: Still provides copyable personalized message');

  console.log('✅ Part C Passed: Smart Assistant follow-up intents, non-repetition, personalization & zero-emoji policy verified.');
}

// ============================================================================
// PART D: PROTECTION INVARIANTS (FAIL-CLOSED PROOF REJECTION)
// ============================================================================
function testPartD_ProtectionInvariants() {
  console.log('\n--- Part D: Fail-Closed Protection Invariants ---');

  const sampleAtt: OfflineMutation = {
    id: 'prot_att_1',
    action: 'attendance',
    studentId: 'st_1',
    studentCode: 'SG-001',
    studentName: 'كيرلس مرقس',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', isPresent: true }
  };

  const sampleFu: OfflineMutation = {
    id: 'prot_fu_1',
    action: 'followup',
    studentId: 'st_1',
    studentCode: 'SG-001',
    studentName: 'كيرلس مرقس',
    sourceSheet: 'نشط',
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    payload: { friday: '2026-11-20', date: '2026-11-19', method: 'واتساب', recordId: 'rec_prot_1' }
  };

  // D1. Generic { ok: true } without proof MUST be rejected
  assert.strictEqual(validateRemotePersistenceProof(sampleAtt, { ok: true }).valid, false, 'D1: Rejects generic { ok: true }');
  assert.strictEqual(validateRemotePersistenceProof(sampleAtt, { ok: true, status: 200 }).valid, false, 'D2: Rejects HTTP 200 without proof');

  // D3. Cross-operation / mismatched mutationId / mismatched studentId rejected
  assert.strictEqual(
    validateRemotePersistenceProof(sampleAtt, {
      ok: true,
      proof: {
        mutationId: 'wrong_id',
        persisted: true,
        operation: 'attendance',
        studentId: 'st_1',
        sheetName: 'نشط',
        friday: '2026-11-20',
        row: 2
      }
    }).valid,
    false,
    'D3: Rejects mismatched mutationId'
  );

  // D4. Followup without followupLogAppended: true rejected
  assert.strictEqual(
    validateRemotePersistenceProof(sampleFu, {
      ok: true,
      proof: {
        mutationId: sampleFu.id,
        persisted: true,
        operation: 'followup',
        studentId: 'st_1',
        sheetName: 'نشط',
        friday: '2026-11-20',
        date: '2026-11-19',
        recordId: 'rec_prot_1',
        followupLogAppended: false
      }
    }).valid,
    false,
    'D4: Rejects followup proof without followupLogAppended=true'
  );

  // D5. Timeout ledger saying found=true without valid proof rejected (fail-closed)
  assert.strictEqual(
    validateTimeoutIdempotencyEntry(sampleAtt, { found: true, response: { ok: true } }).outcome,
    'unknown',
    'D5: Rejects timeout entry with found=true but no proof'
  );

  console.log('✅ Part D Passed: All fail-closed protection invariants verified.');
}

async function runAllPhase44Tests() {
  console.log('=== Phase 4.4 Isolated Automated Verification Suite ===');
  await testPartA_CodeGsAndExpressPersistence();
  testPartB_WhatsAppAndTemplates();
  testPartC_SmartAssistantFollowupIntegration();
  testPartD_ProtectionInvariants();
  console.log('\n🎉 ALL PHASE 4.4 ISOLATED TESTS PASSED (Parts A, B, C, D)!');
}

runAllPhase44Tests().catch((err) => {
  console.error('❌ Phase 4.4 Test Suite Failed:', err);
  process.exit(1);
});
