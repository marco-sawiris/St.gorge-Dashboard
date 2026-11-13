import crypto from 'crypto';
import { ENV } from '../config/env';
import { Student, APPROVED_SHEETS, ALL_SHEETS_SENTINEL } from '../../src/types/student';
import {
  DEFAULT_SPREADSHEET_ID,
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
 * - NEVER injects or falls back to fake/mock student records in production.
 */
export class GoogleSheetsService {
  private students = new Map<string, Student>();
  private testFixtureMode = false;
  private tokenCache: GoogleTokenCache | null = null;
  private lastSheetSyncAt: number = 0;
  private readonly CACHE_TTL_MS = 15_000;

  public isGoogleConfigured(): boolean {
    return Boolean(
      ENV.GOOGLE_SHEET_ID &&
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
    for (const s of fixtures) {
      this.students.set(s.id, { ...s, version: s.version || 1 });
    }
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

  private async fetchFromGoogleSheetTab(sheetName: string): Promise<Student[]> {
    const accessToken = await this.getGoogleAccessToken();
    const sheetId = ENV.GOOGLE_SHEET_ID || DEFAULT_SPREADSHEET_ID;
    const range = encodeURIComponent(`'${sheetName}'!A1:AZ1000`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      throw new Error(`Google Sheets read failed for "${sheetName}" (${res.status})`);
    }

    const data = (await res.json()) as { values?: string[][] };
    const rows = data.values || [];
    if (rows.length <= 1) return [];

    const headers = rows[0].map((h) => String(h || '').trim());
    return parse2DRowsToStudents(headers, rows.slice(1), sheetName, this.students);
  }

  public async getStudents(targetSheet: string): Promise<Student[]> {
    const sheetId = ENV.GOOGLE_SHEET_ID || DEFAULT_SPREADSHEET_ID;
    const shouldRefresh = this.students.size === 0 || Date.now() - this.lastSheetSyncAt > this.CACHE_TTL_MS;

    if (shouldRefresh) {
      if (this.isGoogleConfigured()) {
        const sheetsToFetch = targetSheet === ALL_SHEETS_SENTINEL ? [...APPROVED_SHEETS] : [targetSheet];
        for (const sName of sheetsToFetch) {
          const remoteStudents = await this.fetchFromGoogleSheetTab(sName);
          for (const st of remoteStudents) {
            this.students.set(st.id, st);
          }
        }
        this.lastSheetSyncAt = Date.now();
      } else {
        const result = await fetchSheetStudentsViaGviz(sheetId, targetSheet, this.students);
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

  public async upsertStudent(student: Student): Promise<Student> {
    if (!this.isGoogleConfigured() && !this.testFixtureMode) {
      throw new Error('Google Sheets write is unavailable: configure server-side Service Account credentials before accepting mutations.');
    }
    const existing = this.students.get(student.id);
    const nextVersion = existing ? (existing.version || 1) + 1 : 1;
    const saved: Student = {
      ...student,
      version: nextVersion
    };
    // When server-side Google credentials are configured, do not report success or
    // publish the new in-memory version until Google Sheets confirms the write.
    if (this.isGoogleConfigured()) {
      await this.syncStudentUpdateToGoogle(saved, !existing);
    } else if (!this.testFixtureMode) {
      throw new Error('Google Sheets write was not attempted; refusing an in-memory-only success response.');
    }

    this.students.set(saved.id, saved);
    return { ...saved };
  }

  private async syncStudentUpdateToGoogle(student: Student, _isNew: boolean): Promise<void> {
    const accessToken = await this.getGoogleAccessToken();
    const sheetId = ENV.GOOGLE_SHEET_ID || DEFAULT_SPREADSHEET_ID;
    const sheetPrefix = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const lookupRange = encodeURIComponent(`'${student.sourceSheet}'!A1:AZ1000`);
    const lookupResponse = await fetch(`${sheetPrefix}/${lookupRange}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!lookupResponse.ok) {
      throw new Error(`Google Sheets row lookup failed (${lookupResponse.status})`);
    }

    const lookupData = (await lookupResponse.json()) as { values?: string[][] };
    const rows = lookupData.values || [];
    const headers = (rows[0] || []).map((value) => String(value || '').trim());
    if (!headers.length) {
      throw new Error(`Google Sheets tab "${student.sourceSheet}" has no header row`);
    }

    const headerColumnName = (index: number): string => {
      let n = index + 1;
      let label = '';
      while (n > 0) {
        const remainder = (n - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        n = Math.floor((n - 1) / 26);
      }
      return label;
    };
    let versionColumnIndex = headers.findIndex((header) =>
      header.toLowerCase() === 'version' || header === 'الإصدار'
    );
    if (versionColumnIndex < 0) {
      versionColumnIndex = headers.length;
      const versionColumn = headerColumnName(versionColumnIndex);
      const versionHeaderRange = encodeURIComponent(`'${student.sourceSheet}'!${versionColumn}1`);
      const versionHeaderResponse = await fetch(`${sheetPrefix}/${versionHeaderRange}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [['version']] })
      });
      if (!versionHeaderResponse.ok) {
        throw new Error(`Could not create required Google Sheets version column (${versionHeaderResponse.status})`);
      }
      headers.push('version');
    }

    const matchingRows = rows
      .map((row, index) => ({ code: String(row?.[0] ?? '').trim(), rowNumber: index + 1 }))
      .filter((row) => row.rowNumber > 1 && row.code === String(student.code).trim());
    if (matchingRows.length > 1) {
      throw new Error(`Duplicate student code "${student.code}" found in Google Sheets; refusing ambiguous write`);
    }

    const existingRowNumber = matchingRows[0]?.rowNumber;
    const existingRow = existingRowNumber ? [...(rows[existingRowNumber - 1] || [])] : [];
    const rowValues = existingRow;
    while (rowValues.length < Math.max(headers.length, 12)) rowValues.push('');

    // Stable base columns A:L.
    const baseValues = [
      student.code,
      student.name,
      student.servant,
      student.phoneStudent || '',
      student.phoneParent1 || '',
      student.phoneParent2 || '',
      student.birthDate || '',
      student.area || '',
      student.address || '',
      student.notes || '',
      student.lastAttendance || '',
      student.lastFollowup || ''
    ];
    baseValues.forEach((value, index) => { rowValues[index] = String(value ?? ''); });

    // Preserve the dynamic Friday attendance and follow-up columns. These are
    // essential: updating only A:L would make the UI appear saved while the
    // actual Friday history in the sheet remained unchanged.
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      const header = headers[columnIndex];
      const normalizedHeader = header.toLowerCase().trim();
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(header) &&
          Object.prototype.hasOwnProperty.call(student.att || {}, header)) {
        rowValues[columnIndex] = student.att[header] ? '1' : '0';
        continue;
      }

      const followupMatch = header.match(/^افتقاد\\s+(\\d{4}-\\d{2}-\\d{2})$/);
      if (followupMatch && Object.prototype.hasOwnProperty.call(student.fu || {}, followupMatch[1])) {
        rowValues[columnIndex] = String(student.fu[followupMatch[1]] ?? '');
        continue;
      }

      if (normalizedHeader === 'id') rowValues[columnIndex] = student.id;
      else if (normalizedHeader === 'version' || header === 'الإصدار') rowValues[columnIndex] = String(student.version || 1);
      else if (['إجمالي الحضور', 'اجمالي الحضور', 'attendancetotal'].includes(normalizedHeader)) rowValues[columnIndex] = String(student.attendanceTotal || 0);
      else if (['حضور الشهر', 'attendancemonth'].includes(normalizedHeader)) rowValues[columnIndex] = String(student.attendanceMonth || 0);
      else if (['الحالة', 'attendancestatus'].includes(normalizedHeader)) rowValues[columnIndex] = student.attendanceStatus || '';
      else if (['حالة الافتقاد', 'followupstatus'].includes(normalizedHeader)) rowValues[columnIndex] = student.followupStatus || '';
    }

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
      const lastColumn = columnName(Math.max(headers.length, 12) - 1);
      const updateRange = encodeURIComponent(`'${student.sourceSheet}'!A${existingRowNumber}:${lastColumn}${existingRowNumber}`);
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
      return;
    }

    const appendWidth = Math.max(headers.length, 12);
    while (rowValues.length < appendWidth) rowValues.push('');
    const appendRange = encodeURIComponent(`'${student.sourceSheet}'!A:${columnName(appendWidth - 1)}`);
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
  }
}

export const googleSheetsService = new GoogleSheetsService();
