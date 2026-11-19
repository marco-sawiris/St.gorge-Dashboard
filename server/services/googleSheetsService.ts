import crypto from 'crypto';
import { ENV } from '../config/env';
import { CENTRAL_SPREADSHEET_ID } from '../../src/config/centralSheetConfig';
import {
  Student,
  LIVE_GOOGLE_SHEET_TABS,
  INACTIVE_STUDENT_CLASSIFICATION,
  STUDENT_CLASSIFICATION_OPTIONS,
  ALL_SHEETS_SENTINEL
} from '../../src/types/student';
import {
  fetchSheetStudentsViaGviz,
  parse2DRowsToStudents
} from '../../src/services/googleSheetParser';

interface GoogleTokenCache {
  accessToken: string;
  expiresAt: number;
}

/**
 * Authoritative Data & Google Sheets Integration Service
 * - Uses official Google Sheets API v4 (Service Account JWT RS256) when GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   and GOOGLE_PRIVATE_KEY are configured in server environment variables.
 * - Uses real Google Sheets Visualization endpoint (gviz/tq) when Service Account secrets are absent,
 *   parsing actual rows and Friday attendance/followup columns from Google Drive.
 * - Eliminates Express Cold-Start 404s via deduplicated ensureStudentsLoaded() / getStudentByIdAsync().
 * - Maps writes dynamically by header names & multi-key row matching so custom/reordered columns
 *   and spreadsheet formulas are never overwritten positionally.
 */
export interface FollowupLogWriteInput {
  date: string;
  friday: string;
  sheetName: string;
  studentCode: string;
  studentName: string;
  servant: string;
  method: string;
  notes: string;
  mutationId: string;
  callOutcome?: string;
  recordId?: string;
}

export interface FollowupLogWriteResult {
  appended: true;
  followupLogRow: number;
  recordId: string;
  deduplicated: boolean;
}

const ACTUAL_GOOGLE_TAB_CANDIDATES: Record<string, string[]> = {
  'نشط': ['نشط'],
  'غير حاضر': ['غير حاضر'],
  'فصل البابا شنودة': ['فصل البابا شنودة ', 'فصل البابا شنودة'],
  'غير نشط': ['غير نشط']
};

const FOLLOWUP_LOG_TAB = 'سجل الافتقاد';

function sanitizeSheetCell(val: unknown): string {
  const str = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

function normalizeArabicForMatch(val: unknown): string {
  let s = String(val ?? '').trim();
  if (!s) return '';
  s = s.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا');
  s = s.replace(/ى/g, 'ي');
  s = s.replace(/ة/g, 'ه');
  s = s.replace(/چ/g, 'ج');
  s = s.replace(/ڤ/g, 'ف');
  s = s.replace(/پ/g, 'ب');
  s = s.replace(/گ/g, 'ك');
  s = s.replace(/ژ/g, 'ز');
  return s.replace(/\s+/g, ' ').toLowerCase();
}

function findColumnIndexByAliases(headers: string[], aliases: string[]): number {
  const normalizedHeaders = headers.map((h) => String(h || '').trim());
  for (const alias of aliases) {
    const targetLower = alias.toLowerCase().trim();
    const idx = normalizedHeaders.findIndex((h) => h.toLowerCase() === targetLower);
    if (idx >= 0) return idx;
  }
  for (const alias of aliases) {
    const targetNorm = normalizeArabicForMatch(alias);
    if (!targetNorm) continue;
    const idx = normalizedHeaders.findIndex((h) => normalizeArabicForMatch(h) === targetNorm);
    if (idx >= 0) return idx;
  }
  for (const alias of aliases) {
    const targetLower = alias.toLowerCase().trim();
    if (!targetLower || targetLower.length < 3) continue;
    const idx = normalizedHeaders.findIndex((h) => h.toLowerCase().includes(targetLower));
    if (idx >= 0) return idx;
  }
  return -1;
}

export class GoogleSheetsService {
  private students = new Map<string, Student>();
  private loadedSheets = new Set<string>();
  private fixtureRowNumbers = new Map<string, number>();
  private fixtureNextRow = 2;
  private fixtureFollowupLog: Array<FollowupLogWriteInput & { row: number; recordId: string }> = [];
  private testFixtureMode = false;
  private tokenCache: GoogleTokenCache | null = null;
  private lastSheetSyncAt: number = 0;
  private loadPromise: Promise<void> | null = null;
  private readonly CACHE_TTL_MS = 15_000;

  public isGoogleConfigured(): boolean {
    return Boolean(
      (ENV.GOOGLE_SHEET_ID || CENTRAL_SPREADSHEET_ID) &&
      ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      ENV.GOOGLE_PRIVATE_KEY &&
      ENV.GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')
    );
  }

  /**
   * Explicitly for isolated unit tests when running without internet/Google Sheets connectivity.
   * Never invoked by application runtime or server startup.
   */
  public seedTestFixtureStudentsOnly(fixtures: Student[]): void {
    this.testFixtureMode = true;
    this.fixtureFollowupLog = [];
    for (const s of fixtures) {
      this.students.set(s.id, { ...s, version: s.version || 1 });
      this.loadedSheets.add(s.sourceSheet);
      if (!this.fixtureRowNumbers.has(s.id)) {
        this.fixtureRowNumbers.set(s.id, this.fixtureNextRow++);
      }
    }
  }

  public clearCacheForTestsOnly(): void {
    this.students.clear();
    this.loadedSheets.clear();
    this.fixtureRowNumbers.clear();
    this.fixtureNextRow = 2;
    this.fixtureFollowupLog = [];
    this.testFixtureMode = false;
    this.lastSheetSyncAt = 0;
    this.loadPromise = null;
  }

  public getFixtureFollowupLog(): ReadonlyArray<FollowupLogWriteInput & { row: number; recordId: string }> {
    return [...this.fixtureFollowupLog];
  }

  public getLoadedSheetsSnapshot(): string[] {
    return Array.from(this.loadedSheets);
  }

  /**
   * Ensures students are hydrated into memory before mutation lookups,
   * eliminating Express Cold-Start 404s when a write arrives before GET /data.
   */
  public async ensureStudentsLoaded(): Promise<void> {
    if (this.testFixtureMode || this.students.size > 0) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.getStudents(ALL_SHEETS_SENTINEL)
        .then(() => undefined)
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  private base64UrlEncode(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private async getGoogleAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.accessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claimSet = this.base64UrlEncode(
      JSON.stringify({
        iss: ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      })
    );

    const unsignedToken = `${header}.${claimSet}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();
    const signature = this.base64UrlEncode(signer.sign(ENV.GOOGLE_PRIVATE_KEY));
    const assertion = `${unsignedToken}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      throw new Error(`Google OAuth token exchange failed (${tokenRes.status}): ${errText}`);
    }

    const tokenJson = (await tokenRes.json()) as { access_token: string; expires_in?: number };
    this.tokenCache = {
      accessToken: tokenJson.access_token,
      expiresAt: Date.now() + (tokenJson.expires_in || 3600) * 1000
    };
    return this.tokenCache.accessToken;
  }

  private resolveApprovedTab(rawTab: unknown, fallback: string = 'نشط'): string {
    if (rawTab !== undefined && rawTab !== null) {
      const trimmed = String(rawTab).trim();
      const lower = trimmed.toLowerCase();
      if (trimmed && lower !== 'undefined' && lower !== 'null' && trimmed !== ALL_SHEETS_SENTINEL) {
        if (!STUDENT_CLASSIFICATION_OPTIONS.includes(trimmed as any)) {
          throw new Error(`اسم التاب غير معتمد: "${trimmed}". التابات المتاحة: ${STUDENT_CLASSIFICATION_OPTIONS.join('، ')}`);
        }
        return trimmed;
      }
    }
    return fallback;
  }

  private async lookupGoogleTabRows(
    sheetPrefix: string,
    canonicalTab: string,
    accessToken: string
  ): Promise<{ actualTabName: string; rows: string[][] }> {
    const candidates = ACTUAL_GOOGLE_TAB_CANDIDATES[canonicalTab] || [canonicalTab];
    let lastStatus = 404;
    for (const candidateTab of candidates) {
      const lookupRange = encodeURIComponent(`'${candidateTab}'!A1:AZ1000`);
      const res = await fetch(`${sheetPrefix}/${lookupRange}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (res.ok) {
        const data = (await res.json()) as { values?: string[][] };
        return { actualTabName: candidateTab, rows: data.values || [] };
      }
      lastStatus = res.status;
    }
    throw new Error(`تعذر الوصول إلى التاب "${canonicalTab}" في Google Sheets (${lastStatus})`);
  }

  private async fetchFromGoogleSheetTab(sheetName: string): Promise<Student[]> {
    const safeSheetName = this.resolveApprovedTab(sheetName);
    const accessToken = await this.getGoogleAccessToken();
    const sheetId = ENV.GOOGLE_SHEET_ID || CENTRAL_SPREADSHEET_ID;
    const sheetPrefix = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const { rows } = await this.lookupGoogleTabRows(sheetPrefix, safeSheetName, accessToken);
    if (rows.length <= 1) return [];

    const headers = rows[0].map((h) => String(h || '').trim());
    return parse2DRowsToStudents(headers, rows.slice(1), safeSheetName, this.students);
  }

  public async getStudents(targetSheet: string): Promise<Student[]> {
    if (this.testFixtureMode) {
      const fixtures = Array.from(this.students.values());
      return (targetSheet === ALL_SHEETS_SENTINEL
        ? fixtures
        : fixtures.filter((student) => student.sourceSheet === targetSheet)
      ).map((student) => ({ ...student, att: { ...(student.att || {}) }, fu: { ...(student.fu || {}) } }));
    }

    const sheetId = ENV.GOOGLE_SHEET_ID || CENTRAL_SPREADSHEET_ID;
    const shouldRefresh = this.students.size === 0 || Date.now() - this.lastSheetSyncAt > this.CACHE_TTL_MS;

    if (shouldRefresh) {
      if (this.isGoogleConfigured()) {
        if (targetSheet === ALL_SHEETS_SENTINEL) {
          for (const sName of LIVE_GOOGLE_SHEET_TABS) {
            const remoteStudents = await this.fetchFromGoogleSheetTab(sName);
            this.loadedSheets.add(sName);
            for (const st of remoteStudents) {
              this.students.set(st.id, st);
            }
          }
          // Read optional 'غير نشط' tab only if present on Google Sheets; never fail __ALL__ if absent
          try {
            const optionalStudents = await this.fetchFromGoogleSheetTab(INACTIVE_STUDENT_CLASSIFICATION);
            this.loadedSheets.add(INACTIVE_STUDENT_CLASSIFICATION);
            for (const st of optionalStudents) {
              this.students.set(st.id, st);
            }
          } catch {
            // Optional classification tab does not exist on live spreadsheet — preserve __ALL__ completion
          }
        } else {
          const remoteStudents = await this.fetchFromGoogleSheetTab(targetSheet);
          this.loadedSheets.add(targetSheet);
          for (const st of remoteStudents) {
            this.students.set(st.id, st);
          }
        }
        this.lastSheetSyncAt = Date.now();
      } else {
        const result = await fetchSheetStudentsViaGviz(sheetId, targetSheet, this.students);
        for (const confirmedSheet of result.confirmedSheets) {
          this.loadedSheets.add(confirmedSheet);
        }
        for (const st of result.students) {
          const existing = this.students.get(st.id);
          // Preserve server-incremented OCC version if already loaded in this process
          this.students.set(st.id, existing ? { ...st, version: Math.max(st.version, existing.version) } : st);
        }
        this.lastSheetSyncAt = Date.now();
      }
    }

    if (targetSheet === ALL_SHEETS_SENTINEL) {
      return Array.from(this.students.values()).map((s) => ({ ...s }));
    }
    return Array.from(this.students.values())
      .filter((s) => s.sourceSheet === targetSheet)
      .map((s) => ({ ...s }));
  }

  public getStudentById(id: string): Student | null {
    const found = this.students.get(id);
    return found ? { ...found, att: { ...(found.att || {}) }, fu: { ...(found.fu || {}) } } : null;
  }

  public async getStudentByIdAsync(id: string): Promise<Student | null> {
    const existing = this.getStudentById(id);
    if (existing) return existing;
    if (this.students.size === 0 && !this.testFixtureMode) {
      await this.ensureStudentsLoaded();
      return this.getStudentById(id);
    }
    return null;
  }

  public async upsertStudent(student: Student): Promise<Student> {
    const result = await this.upsertStudentWithMeta(student);
    return result.student;
  }

  public async upsertStudentWithMeta(student: Student): Promise<{ student: Student; row: number }> {
    if (!this.isGoogleConfigured() && !this.testFixtureMode) {
      throw new Error('Google Sheets write is unavailable: configure server-side Service Account credentials before accepting mutations.');
    }
    const existing = this.students.get(student.id);
    const nextVersion = existing ? (existing.version || 1) + 1 : 1;
    const saved: Student = {
      ...student,
      version: nextVersion
    };

    let persistedRow: number;
    if (this.isGoogleConfigured()) {
      persistedRow = await this.syncStudentUpdateToGoogle(saved, !existing);
    } else if (this.testFixtureMode) {
      persistedRow = this.fixtureRowNumbers.get(saved.id) ?? this.fixtureNextRow++;
      this.fixtureRowNumbers.set(saved.id, persistedRow);
    } else {
      throw new Error('Google Sheets write was not attempted; refusing an in-memory-only success response.');
    }

    this.students.set(saved.id, saved);
    return { student: { ...saved }, row: persistedRow };
  }

  /**
   * Builds a sheet row dynamically by header names so reordered/custom columns
   * and existing spreadsheet formulas in unrelated columns are preserved untouched.
   */
  public buildRowValuesForSheetHeaders(
    headers: string[],
    student: Student,
    existingRow?: unknown[]
  ): string[] {
    const rowValues: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      rowValues.push(existingRow && existingRow[i] !== undefined ? String(existingRow[i]) : '');
    }

    const codeIdx = findColumnIndexByAliases(headers, ['كود', 'الكود', 'code']);
    const nameIdx = findColumnIndexByAliases(headers, ['الاسم', 'name']);
    const servantIdx = findColumnIndexByAliases(headers, ['الاشبين', 'الأشبين', 'الخادم', 'servant']);
    const phoneStudentIdx = findColumnIndexByAliases(headers, [
      'موبيال المخدوم',
      'موبايل المخدوم',
      'موبايل الطالب',
      'تليفون الطالب',
      'phonestudent'
    ]);
    const phoneParent1Idx = findColumnIndexByAliases(headers, [
      'موبيل ولي الامر 1',
      'ولي الامر 1',
      'ولي الأمر 1',
      'phoneparent1'
    ]);
    const phoneParent2Idx = findColumnIndexByAliases(headers, [
      'موبيل ولي الامر 2',
      'ولي الامر 2',
      'ولي الأمر 2',
      'phoneparent2'
    ]);
    const birthDateIdx = findColumnIndexByAliases(headers, ['تاريخ الميلاد', 'birthdate']);
    const areaIdx = findColumnIndexByAliases(headers, ['منطقة', 'المنطقة', 'area']);
    const addressIdx = findColumnIndexByAliases(headers, ['العنوان', 'address']);
    const notesIdx = findColumnIndexByAliases(headers, ['ملاحظات الافتقاد', 'ملاحظات', 'notes']);
    const lastAttendanceIdx = findColumnIndexByAliases(headers, ['آخر حضور', 'اخر حضور', 'lastattendance']);
    const lastFollowupIdx = findColumnIndexByAliases(headers, ['آخر افتقاد', 'اخر افتقاد', 'lastfollowup']);
    const idIdx = findColumnIndexByAliases(headers, ['id']);
    const versionIdx = findColumnIndexByAliases(headers, ['version', 'الإصدار']);
    const totalIdx = findColumnIndexByAliases(headers, ['إجمالي الحضور', 'اجمالي الحضور', 'attendancetotal']);
    const monthIdx = findColumnIndexByAliases(headers, ['حضور الشهر', 'attendancemonth']);
    const attendanceStatusIdx = findColumnIndexByAliases(headers, ['الحالة', 'attendancestatus']);
    const followupStatusIdx = findColumnIndexByAliases(headers, ['حالة الافتقاد', 'followupstatus']);

    if (codeIdx >= 0) rowValues[codeIdx] = sanitizeSheetCell(student.code);
    if (nameIdx >= 0) rowValues[nameIdx] = sanitizeSheetCell(student.name);
    if (servantIdx >= 0) rowValues[servantIdx] = sanitizeSheetCell(student.servant || '');
    if (phoneStudentIdx >= 0) rowValues[phoneStudentIdx] = sanitizeSheetCell(student.phoneStudent || '');
    if (phoneParent1Idx >= 0) rowValues[phoneParent1Idx] = sanitizeSheetCell(student.phoneParent1 || '');
    if (phoneParent2Idx >= 0) rowValues[phoneParent2Idx] = sanitizeSheetCell(student.phoneParent2 || '');
    if (birthDateIdx >= 0) rowValues[birthDateIdx] = sanitizeSheetCell(student.birthDate || '');
    if (areaIdx >= 0) rowValues[areaIdx] = sanitizeSheetCell(student.area || '');
    if (addressIdx >= 0) rowValues[addressIdx] = sanitizeSheetCell(student.address || '');
    if (notesIdx >= 0) rowValues[notesIdx] = sanitizeSheetCell(student.notes || '');
    if (lastAttendanceIdx >= 0) rowValues[lastAttendanceIdx] = sanitizeSheetCell(student.lastAttendance || '');
    if (lastFollowupIdx >= 0) rowValues[lastFollowupIdx] = sanitizeSheetCell(student.lastFollowup || '');
    if (idIdx >= 0) rowValues[idIdx] = sanitizeSheetCell(student.id);
    if (versionIdx >= 0) rowValues[versionIdx] = String(student.version || 1);
    if (totalIdx >= 0) rowValues[totalIdx] = String(student.attendanceTotal || 0);
    if (monthIdx >= 0) rowValues[monthIdx] = String(student.attendanceMonth || 0);
    if (attendanceStatusIdx >= 0) rowValues[attendanceStatusIdx] = sanitizeSheetCell(student.attendanceStatus || '');
    if (followupStatusIdx >= 0) rowValues[followupStatusIdx] = sanitizeSheetCell(student.followupStatus || '');

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      const header = headers[columnIndex];
      if (/^\d{4}-\d{2}-\d{2}$/.test(header) &&
          Object.prototype.hasOwnProperty.call(student.att || {}, header)) {
        rowValues[columnIndex] = student.att[header] ? '1' : '0';
        continue;
      }

      const followupMatch = header.match(/^افتقاد\s+(\d{4}-\d{2}-\d{2})$/);
      if (followupMatch && Object.prototype.hasOwnProperty.call(student.fu || {}, followupMatch[1])) {
        rowValues[columnIndex] = sanitizeSheetCell(student.fu[followupMatch[1]] ?? '');
      }
    }

    return rowValues;
  }

  private findMatchingRowNumber(headers: string[], rows: string[][], student: Student): number | undefined {
    const codeCol = findColumnIndexByAliases(headers, ['كود', 'الكود', 'code']);
    const idCol = findColumnIndexByAliases(headers, ['id']);
    const nameCol = findColumnIndexByAliases(headers, ['الاسم', 'name']);

    const targetCode = String(student.code || '').trim();
    if (targetCode && codeCol >= 0) {
      const codeMatches: number[] = [];
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i]?.[codeCol] ?? '').trim() === targetCode) {
          codeMatches.push(i + 1);
        }
      }
      if (codeMatches.length > 1) {
        throw new Error(`Duplicate student code "${student.code}" found in Google Sheets; refusing ambiguous write`);
      }
      if (codeMatches.length === 1) return codeMatches[0];
    }

    const targetId = String(student.id || '').trim();
    if (targetId && idCol >= 0) {
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i]?.[idCol] ?? '').trim() === targetId) {
          return i + 1;
        }
      }
    }

    const targetNormName = normalizeArabicForMatch(student.name);
    if (targetNormName && nameCol >= 0) {
      const nameMatches: number[] = [];
      for (let i = 1; i < rows.length; i++) {
        if (normalizeArabicForMatch(rows[i]?.[nameCol]) === targetNormName) {
          nameMatches.push(i + 1);
        }
      }
      if (nameMatches.length === 1) return nameMatches[0];
    }

    return undefined;
  }

  private async ensureMissingHeadersOnSheet(
    sheetPrefix: string,
    safeTab: string,
    headers: string[],
    studentsForTab: Student[],
    accessToken: string
  ): Promise<void> {
    const columnName = (index: number): string => {
      let n = index + 1;
      let label = '';
      while (n > 0) {
        const remainder = (n - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        n = Math.floor((n - 1) / 26);
      }
      return label;
    };

    const headerUpdates: Array<{ range: string; values: string[][] }> = [];
    const versionColIdx = findColumnIndexByAliases(headers, ['version', 'الإصدار']);
    if (versionColIdx < 0) {
      const newIdx = headers.length;
      headers.push('version');
      headerUpdates.push({
        range: `'${safeTab}'!${columnName(newIdx)}1`,
        values: [['version']]
      });
    }

    const neededAttDates = new Set<string>();
    const neededFuHeaders = new Set<string>();
    for (const st of studentsForTab) {
      for (const d of Object.keys(st.att || {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !headers.includes(d)) {
          neededAttDates.add(d);
        }
      }
      for (const fd of Object.keys(st.fu || {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fd)) {
          const fuHeader = `افتقاد ${fd}`;
          if (!headers.includes(fuHeader)) {
            neededFuHeaders.add(fuHeader);
          }
        }
      }
    }

    for (const d of Array.from(neededAttDates).sort()) {
      const colIdx = headers.length;
      headers.push(d);
      headerUpdates.push({
        range: `'${safeTab}'!${columnName(colIdx)}1`,
        values: [[d]]
      });
    }
    for (const fuHdr of Array.from(neededFuHeaders).sort()) {
      const colIdx = headers.length;
      headers.push(fuHdr);
      headerUpdates.push({
        range: `'${safeTab}'!${columnName(colIdx)}1`,
        values: [[fuHdr]]
      });
    }

    if (headerUpdates.length > 0) {
      const hdrResp = await fetch(`${sheetPrefix}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: headerUpdates
        })
      });
      if (!hdrResp.ok) {
        throw new Error(`Could not add missing columns to Google Sheets "${safeTab}" (${hdrResp.status})`);
      }
    }
  }

  private async syncStudentUpdateToGoogle(student: Student, _isNew: boolean): Promise<number> {
    const canonicalTab = this.resolveApprovedTab(student.sourceSheet);
    const accessToken = await this.getGoogleAccessToken();
    const sheetId = ENV.GOOGLE_SHEET_ID || CENTRAL_SPREADSHEET_ID;
    const sheetPrefix = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const { actualTabName: safeTab, rows } = await this.lookupGoogleTabRows(sheetPrefix, canonicalTab, accessToken);
    const headers = (rows[0] || []).map((value) => String(value || '').trim());
    if (!headers.length) {
      throw new Error(`التاب "${canonicalTab}" في Google Sheets لا يحتوي على صف عناوين`);
    }

    await this.ensureMissingHeadersOnSheet(sheetPrefix, safeTab, headers, [student], accessToken);

    const existingRowNumber = this.findMatchingRowNumber(headers, rows, student);
    const existingRow = existingRowNumber ? rows[existingRowNumber - 1] : undefined;
    const rowValues = this.buildRowValuesForSheetHeaders(headers, student, existingRow);

    const columnName = (index: number): string => {
      let n = index + 1;
      let label = '';
      while (n > 0) {
        const remainder = (n - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        n = Math.floor((n - 1) / 26);
      }
      return label;
    };

    if (existingRowNumber) {
      const lastColumn = columnName(Math.max(headers.length, rowValues.length) - 1);
      const updateRange = encodeURIComponent(`'${safeTab}'!A${existingRowNumber}:${lastColumn}${existingRowNumber}`);
      const response = await fetch(`${sheetPrefix}/${updateRange}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [rowValues] })
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Google Sheets update failed (${response.status}): ${detail}`);
      }
      return existingRowNumber;
    }

    const appendWidth = Math.max(headers.length, rowValues.length);
    while (rowValues.length < appendWidth) rowValues.push('');
    const appendRange = encodeURIComponent(`'${safeTab}'!A:${columnName(appendWidth - 1)}`);
    const appendResponse = await fetch(`${sheetPrefix}/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: [rowValues] })
    });
    if (!appendResponse.ok) {
      const detail = await appendResponse.text().catch(() => '');
      throw new Error(`Google Sheets append failed (${appendResponse.status}): ${detail}`);
    }
    const appendJson = (await appendResponse.json().catch(() => ({}))) as { updates?: { updatedRange?: string } };
    const rangeMatch = String(appendJson?.updates?.updatedRange || '').match(/![A-Z]+(\d+)/);
    return rangeMatch ? parseInt(rangeMatch[1], 10) : rows.length + 1;
  }

  /**
   * Appends a followup audit row to the central 'سجل الافتقاد' tab with deduplication.
   * Fail-loud: throws if the tab is missing or write fails; never returns fake success.
   */
  public async appendFollowupLog(entry: FollowupLogWriteInput): Promise<FollowupLogWriteResult> {
    if (!this.isGoogleConfigured() && !this.testFixtureMode) {
      throw new Error('Google Sheets followup log write is unavailable: configure server-side Service Account credentials.');
    }

    if (this.testFixtureMode && !this.isGoogleConfigured()) {
      const existing = this.fixtureFollowupLog.find(
        (r) =>
          (entry.mutationId && r.mutationId === entry.mutationId) ||
          (entry.recordId && r.recordId === entry.recordId)
      );
      if (existing) {
        return {
          appended: true,
          followupLogRow: existing.row,
          recordId: entry.recordId || existing.recordId,
          deduplicated: true
        };
      }
      const nextRow = this.fixtureFollowupLog.length + 2;
      const effectiveRecordId = entry.recordId || `gs_fu_${nextRow}`;
      this.fixtureFollowupLog.push({ ...entry, row: nextRow, recordId: effectiveRecordId });
      return {
        appended: true,
        followupLogRow: nextRow,
        recordId: effectiveRecordId,
        deduplicated: false
      };
    }

    const accessToken = await this.getGoogleAccessToken();
    const sheetId = ENV.GOOGLE_SHEET_ID || CENTRAL_SPREADSHEET_ID;
    const sheetPrefix = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const lookupRange = encodeURIComponent(`'${FOLLOWUP_LOG_TAB}'!A1:M5000`);
    const lookupRes = await fetch(`${sheetPrefix}/${lookupRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!lookupRes.ok) {
      throw new Error(`التاب "${FOLLOWUP_LOG_TAB}" غير موجود أو تعذر الوصول إليه في Google Sheets (${lookupRes.status})`);
    }

    const lookupJson = (await lookupRes.json()) as { values?: string[][] };
    const rows = lookupJson.values || [];
    const headers = (rows[0] || []).map((v) => String(v || '').trim());
    const mutationCol = headers.findIndex((h) => h === 'mutation_id');
    const recordIdCol = headers.findIndex((h) => h === 'record_id' || h === 'recordId');

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (mutationCol >= 0 && entry.mutationId && String(r[mutationCol] || '').trim() === entry.mutationId) {
        return {
          appended: true,
          followupLogRow: i + 1,
          recordId: entry.recordId || (recordIdCol >= 0 ? String(r[recordIdCol] || '').trim() : '') || `gs_fu_${i + 1}`,
          deduplicated: true
        };
      }
      if (recordIdCol >= 0 && entry.recordId && String(r[recordIdCol] || '').trim() === entry.recordId) {
        return {
          appended: true,
          followupLogRow: i + 1,
          recordId: entry.recordId,
          deduplicated: true
        };
      }
    }

    const effectiveRecordId = entry.recordId || `gs_fu_${rows.length + 1}`;
    const newRow = [
      entry.date,
      entry.friday,
      sanitizeSheetCell(entry.sheetName),
      sanitizeSheetCell(entry.studentCode),
      sanitizeSheetCell(entry.studentName),
      sanitizeSheetCell(entry.servant),
      sanitizeSheetCell(entry.method),
      sanitizeSheetCell(entry.notes || ''),
      entry.mutationId,
      sanitizeSheetCell(entry.callOutcome || ''),
      sanitizeSheetCell(effectiveRecordId)
    ];

    const appendRange = encodeURIComponent(`'${FOLLOWUP_LOG_TAB}'!A:K`);
    const appendRes = await fetch(`${sheetPrefix}/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: [newRow] })
    });
    if (!appendRes.ok) {
      const detail = await appendRes.text().catch(() => '');
      throw new Error(`فشل حفظ سجل الافتقاد في "${FOLLOWUP_LOG_TAB}" (${appendRes.status}): ${detail}`);
    }
    const appendData = (await appendRes.json().catch(() => ({}))) as { updates?: { updatedRange?: string } };
    const rowMatch = String(appendData?.updates?.updatedRange || '').match(/![A-Z]+(\d+)/);
    const appendedRow = rowMatch ? parseInt(rowMatch[1], 10) : rows.length + 1;

    return {
      appended: true,
      followupLogRow: appendedRow,
      recordId: effectiveRecordId,
      deduplicated: false
    };
  }

  /**
   * Batch persist multiple student updates across one or more sheets.
   * Reads each target sheet ONCE and commits all updated rows in a SINGLE Google Sheets values:batchUpdate call.
   */
  public async upsertStudentsBatch(studentsToSave: Student[]): Promise<Student[]> {
    const result = await this.upsertStudentsBatchWithMeta(studentsToSave);
    return result.students;
  }

  public async upsertStudentsBatchWithMeta(
    studentsToSave: Student[]
  ): Promise<{ students: Student[]; rowByStudentId: Record<string, number> }> {
    if (!studentsToSave || studentsToSave.length === 0) {
      return { students: [], rowByStudentId: {} };
    }
    if (!this.isGoogleConfigured() && !this.testFixtureMode) {
      throw new Error('Google Sheets write is unavailable: configure server-side Service Account credentials before accepting mutations.');
    }

    const prepared: Student[] = studentsToSave.map((st) => {
      const existing = this.students.get(st.id);
      const nextVer =
        typeof st.version === 'number' && existing && st.version > existing.version
          ? st.version
          : existing
          ? (existing.version || 1) + 1
          : st.version || 1;
      return { ...st, version: nextVer };
    });

    let rowByStudentId: Record<string, number> = {};
    if (this.isGoogleConfigured()) {
      rowByStudentId = await this.syncStudentsBatchToGoogle(prepared);
    } else if (this.testFixtureMode) {
      for (const saved of prepared) {
        const row = this.fixtureRowNumbers.get(saved.id) ?? this.fixtureNextRow++;
        this.fixtureRowNumbers.set(saved.id, row);
        rowByStudentId[saved.id] = row;
      }
    } else {
      throw new Error('Google Sheets batch write was not attempted; refusing an in-memory-only success response.');
    }

    for (const saved of prepared) {
      this.students.set(saved.id, { ...saved, att: { ...(saved.att || {}) }, fu: { ...(saved.fu || {}) } });
    }
    return {
      students: prepared.map((s) => ({ ...s })),
      rowByStudentId
    };
  }

  private async syncStudentsBatchToGoogle(studentsToSave: Student[]): Promise<Record<string, number>> {
    const accessToken = await this.getGoogleAccessToken();
    const sheetId = ENV.GOOGLE_SHEET_ID || CENTRAL_SPREADSHEET_ID;
    const sheetPrefix = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const rowByStudentId: Record<string, number> = {};

    const columnName = (index: number): string => {
      let n = index + 1;
      let label = '';
      while (n > 0) {
        const remainder = (n - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        n = Math.floor((n - 1) / 26);
      }
      return label;
    };

    const bySheet = new Map<string, Student[]>();
    for (const st of studentsToSave) {
      const tab = this.resolveApprovedTab(st.sourceSheet);
      if (!bySheet.has(tab)) bySheet.set(tab, []);
      bySheet.get(tab)!.push({ ...st, sourceSheet: tab });
    }

    for (const [canonicalSheetName, sheetStudents] of bySheet.entries()) {
      const { actualTabName: sheetName, rows } = await this.lookupGoogleTabRows(
        sheetPrefix,
        canonicalSheetName,
        accessToken
      );
      const headers = (rows[0] || []).map((v) => String(v || '').trim());
      if (!headers.length) {
        throw new Error(`Google Sheets tab "${canonicalSheetName}" has no header row`);
      }

      await this.ensureMissingHeadersOnSheet(sheetPrefix, sheetName, headers, sheetStudents, accessToken);

      const rowBatchData: Array<{ range: string; values: string[][] }> = [];
      const appendRows: string[][] = [];
      const width = Math.max(headers.length, 1);
      const lastColLetter = columnName(width - 1);

      for (const student of sheetStudents) {
        const existingRowNumber = this.findMatchingRowNumber(headers, rows, student);
        const existingRow = existingRowNumber ? rows[existingRowNumber - 1] : undefined;
        const rowValues = this.buildRowValuesForSheetHeaders(headers, student, existingRow);

        if (existingRowNumber) {
          rowByStudentId[student.id] = existingRowNumber;
          rowBatchData.push({
            range: `'${sheetName}'!A${existingRowNumber}:${lastColLetter}${existingRowNumber}`,
            values: [rowValues]
          });
        } else {
          rowByStudentId[student.id] = rows.length + appendRows.length + 1;
          appendRows.push(rowValues);
        }
      }

      if (rowBatchData.length > 0) {
        const batchResp = await fetch(`${sheetPrefix}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            valueInputOption: 'USER_ENTERED',
            data: rowBatchData
          })
        });
        if (!batchResp.ok) {
          const detail = await batchResp.text().catch(() => '');
          throw new Error(`Google Sheets batch update failed (${batchResp.status}): ${detail}`);
        }
      }

      if (appendRows.length > 0) {
        const appendRange = encodeURIComponent(`'${sheetName}'!A:${lastColLetter}`);
        const appResp = await fetch(`${sheetPrefix}/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values: appendRows })
        });
        if (!appResp.ok) {
          const detail = await appResp.text().catch(() => '');
          throw new Error(`Google Sheets batch append failed (${appResp.status}): ${detail}`);
        }
      }
    }

    return rowByStudentId;
  }
}

export const googleSheetsService = new GoogleSheetsService();
