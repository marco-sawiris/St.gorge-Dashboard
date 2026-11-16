import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Student } from '../types/student';
import { getCairoDateParts, normalizeArabicText } from '../utils/arabicUtils';

export interface PositionedPdfToken {
  str: string;
  x: number; // Left edge in top-left canvas/page coordinates
  y: number; // Top/baseline coordinate increasing downward
  width: number;
  height: number;
  pageIndex: number; // 0-based page index
  dir?: 'ltr' | 'rtl' | 'ttb' | string;
  hasEOL?: boolean;
  transform?: number[];
}

export interface PositionedPdfPage {
  pageIndex: number; // 0-based
  width: number;
  height: number;
  tokens: PositionedPdfToken[];
  rawTextItemsCount?: number;
  verticalGridXs?: number[];
  horizontalGridYs?: number[];
  extractionSource: 'text' | 'ocr';
}

export type PdfAttendanceCellStatus = 'present' | 'absent' | 'empty' | 'unknown' | 'ambiguous';

export interface ParsedPdfAttendanceCell {
  date: string; // Canonical YYYY-MM-DD
  rawDateHeader: string;
  rawText: string;
  status: PdfAttendanceCellStatus;
}

export type PdfStudentMatchStatus = 'exact' | 'ambiguous' | 'needs_review' | 'unmatched';

export interface ParsedPdfStudentRow {
  rowKey: string;
  pageNumber: number; // 1-based first page seen
  extractedName: string;
  normalizedName: string;
  extractedCode?: string;
  reportedAbsenceCount: number | null;
  extractedAbsentCount: number;
  hasAbsenceCountMismatch: boolean;
  cells: Record<string, ParsedPdfAttendanceCell>;
  matchStatus: PdfStudentMatchStatus;
  matchedStudentId: string | null; // Auto-filled ONLY when matchStatus === 'exact'
  candidateStudentIds: string[];
}

export interface ParsedPdfDateColumn {
  date: string; // YYYY-MM-DD
  headerLabel: string;
}

export type PdfExtractionStage =
  | 'pdf_load'
  | 'text_extraction'
  | 'row_clustering'
  | 'header_detection'
  | 'date_detection'
  | 'student_extraction'
  | 'completed';

export interface PdfDateColumnCoordinateDiagnostic {
  dateIso: string;
  headerLabel: string;
  xMin: number;
  xMax: number;
  xCenter: number;
}

export interface PdfPageDiagnostic {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  textItemsCount: number;
  normalizedTokensCount: number;
  rowClustersCount: number;
  verticalGridLinesCount: number;
  horizontalGridLinesCount: number;
  detectedHeaderRowsCount: number;
  detectedDates: string[];
  dateColumnCoordinates: PdfDateColumnCoordinateDiagnostic[];
  extractedStudentsCount: number;
  presentCount: number;
  absentCount: number;
  emptyCount: number;
  sampleExtractedLines: string[];
  issues: string[];
}

export interface PdfDiagnosticReport {
  stageReached: PdfExtractionStage;
  failureStage: PdfExtractionStage | null;
  failureReason: string | null;
  pageCount: number;
  totalTextItems: number;
  totalRowClusters: number;
  extractedDates: string[];
  extractedStudentsCount: number;
  presentCount: number;
  absentCount: number;
  emptyCount: number;
  unknownOrAmbiguousCount: number;
  tableDirection: 'rtl' | 'ltr' | 'unknown';
  issues: string[];
  pages: PdfPageDiagnostic[];
}

export interface ParsedPdfAttendanceReport {
  fileName: string;
  pageCount: number;
  extractionMode: 'text' | 'ocr';
  extractedDates: ParsedPdfDateColumn[];
  rows: ParsedPdfStudentRow[];
  stats: {
    totalStudents: number;
    matchedCount: number;
    needsReviewCount: number;
    emptyCellsCount: number;
    unknownOrAmbiguousCellsCount: number;
    absenceMismatchRowsCount: number;
    perDateStats: Record<
      string,
      {
        present: number;
        absent: number;
        empty: number;
        review: number;
      }
    >;
  };
  warnings: string[];
  diagnostics: PdfDiagnosticReport;
}

export type OcrPageProvider = (params: {
  pageIndex: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}) => Promise<PositionedPdfToken[]>;

const ARABIC_INDIC_MAP: Record<string, string> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9'
};

export function normalizePdfRawText(input: string | undefined | null): string {
  return String(input ?? '')
    .normalize('NFKC')
    // Strip Unicode Bidi controls including Arabic Letter Mark (U+061C), LRM/RLM, isolates, soft hyphen
    .replace(/[\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2044\u2215\uFF0F]/g, '/')
    .replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_INDIC_MAP[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArabicStudentNameForImport(value: string | undefined | null): string {
  const base = normalizeArabicText(normalizePdfRawText(value))
    // Unify trailing/isolated Hamza on Ya or Alef Maqsura variants
    .replace(/[ئى]/g, 'ي')
    .replace(/ؤ/g, 'و');
  return base.replace(/\s+/g, ' ').trim();
}

function collapseCompoundArabicSpaces(norm: string): string {
  return norm
    .replace(/(^|\s)عبد\s+/g, '$1عبد')
    .replace(/(^|\s)ابو\s+/g, '$1ابو')
    .replace(/(^|\s)ام\s+/g, '$1ام');
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n];
}

export function matchStudentNameForImport(
  extractedName: string,
  students: ReadonlyArray<Student>,
  extractedCode?: string
): {
  matchStatus: PdfStudentMatchStatus;
  matchedStudentId: string | null;
  candidateStudentIds: string[];
  normalizedName: string;
} {
  const normalizedName = normalizeArabicStudentNameForImport(extractedName);
  const cleanCode = normalizePdfRawText(extractedCode).toUpperCase();

  // Priority 1: Unique Code / ID (only when explicitly present in PDF)
  if (cleanCode && cleanCode.length >= 2) {
    const codeMatches = students.filter(
      (s) =>
        normalizePdfRawText(s.code).toUpperCase() === cleanCode ||
        normalizePdfRawText(s.id).toUpperCase() === cleanCode
    );
    if (codeMatches.length === 1) {
      return {
        matchStatus: 'exact',
        matchedStudentId: codeMatches[0].id,
        candidateStudentIds: [codeMatches[0].id],
        normalizedName
      };
    }
    if (codeMatches.length > 1) {
      return {
        matchStatus: 'ambiguous',
        matchedStudentId: null,
        candidateStudentIds: codeMatches.map((s) => s.id),
        normalizedName
      };
    }
  }

  if (!normalizedName) {
    return {
      matchStatus: 'unmatched',
      matchedStudentId: null,
      candidateStudentIds: [],
      normalizedName
    };
  }

  const collapsedExtracted = collapseCompoundArabicSpaces(normalizedName);

  // Priority 2: Exact Full Name after Arabic normalization
  const exactMatches = students.filter((s) => {
    const stNorm = normalizeArabicStudentNameForImport(s.name);
    if (!stNorm) return false;
    return stNorm === normalizedName || collapseCompoundArabicSpaces(stNorm) === collapsedExtracted;
  });

  if (exactMatches.length === 1) {
    return {
      matchStatus: 'exact',
      matchedStudentId: exactMatches[0].id,
      candidateStudentIds: [exactMatches[0].id],
      normalizedName
    };
  }

  if (exactMatches.length > 1) {
    return {
      matchStatus: 'ambiguous',
      matchedStudentId: null,
      candidateStudentIds: exactMatches.map((s) => s.id),
      normalizedName
    };
  }

  // Priority 3: Approximate / Fuzzy candidate matching (Help ONLY — NEVER auto-assign matchedStudentId)
  const extractedTokens = normalizedName.split(' ').filter((t) => t.length >= 2);
  const scored: Array<{ id: string; score: number }> = [];

  for (const s of students) {
    const stNorm = normalizeArabicStudentNameForImport(s.name);
    if (!stNorm) continue;
    const stTokens = stNorm.split(' ').filter((t) => t.length >= 2);
    if (stTokens.length === 0 || extractedTokens.length === 0) continue;

    // Prefix / containment check (e.g., 2-token sheet name matching 3-token DB name or vice versa)
    let matchedTokenCount = 0;
    let softTokenScore = 0;
    for (const et of extractedTokens) {
      if (stTokens.includes(et)) {
        matchedTokenCount++;
        softTokenScore += 1;
      } else {
        let bestClose = 0;
        for (const st of stTokens) {
          const maxLen = Math.max(et.length, st.length);
          const dist = levenshteinDistance(et, st);
          if (maxLen >= 4 && dist <= 1) bestClose = Math.max(bestClose, 0.85);
          else if (maxLen >= 5 && dist <= 2) bestClose = Math.max(bestClose, 0.7);
        }
        softTokenScore += bestClose;
      }
    }

    const minTokens = Math.min(extractedTokens.length, stTokens.length);
    const maxTokens = Math.max(extractedTokens.length, stTokens.length);
    const ratio = softTokenScore / maxTokens;
    const fullDist = levenshteinDistance(collapsedExtracted, collapseCompoundArabicSpaces(stNorm));
    const maxChars = Math.max(collapsedExtracted.length, collapseCompoundArabicSpaces(stNorm).length);
    const charSim = maxChars > 0 ? 1 - fullDist / maxChars : 0;

    // Require strong similarity: first name must at least closely match AND overall score >= 0.62
    const firstExtracted = extractedTokens[0];
    const firstStudent = stTokens[0];
    const firstNameMatches =
      firstExtracted === firstStudent ||
      levenshteinDistance(firstExtracted, firstStudent) <= (firstExtracted.length >= 5 ? 2 : 1);

    if (
      firstNameMatches &&
      ((minTokens >= 2 && matchedTokenCount >= minTokens && ratio >= 0.62) || ratio >= 0.72 || charSim >= 0.78)
    ) {
      scored.push({ id: s.id, score: Math.max(ratio, charSim) });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return {
      matchStatus: 'needs_review',
      matchedStudentId: null, // Explicitly requires user confirmation!
      candidateStudentIds: scored.slice(0, 5).map((item) => item.id),
      normalizedName
    };
  }

  return {
    matchStatus: 'unmatched',
    matchedStudentId: null,
    candidateStudentIds: [],
    normalizedName
  };
}

function validateCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function tryParseSingleDateCandidate(
  cleaned: string,
  fallbackYear?: number
): { isoDate: string; displayLabel: string } | null {
  // 1. YYYY-MM-DD or YYYY/MM/DD (supports optional spacing inside wrapped Excel cells)
  const ymd = cleaned.match(/(?<!\d)(20\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (validateCalendarDate(year, month, day)) {
      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { isoDate, displayLabel: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
    }
  }

  // 2. DD/MM/YYYY or D/M/YYYY or DD-MM-YYYY or DD / MM / YYYY or DD.MM.YYYY
  const dmyFull = cleaned.match(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(20\d{2})(?!\d)/);
  if (dmyFull) {
    const day = Number(dmyFull[1]);
    const month = Number(dmyFull[2]);
    const year = Number(dmyFull[3]);
    if (validateCalendarDate(year, month, day)) {
      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { isoDate, displayLabel: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
    }
  }

  // 3. Wrapped Excel header line break: "23/10 2026" or "6/11 2026"
  const dmyWrapped = cleaned.match(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s+(20\d{2})(?!\d)/);
  if (dmyWrapped) {
    const day = Number(dmyWrapped[1]);
    const month = Number(dmyWrapped[2]);
    const year = Number(dmyWrapped[3]);
    if (validateCalendarDate(year, month, day)) {
      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { isoDate, displayLabel: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
    }
  }

  // 4. Short 2-digit year DD/MM/YY (e.g. 23/10/26)
  const dmyShortYr = cleaned.match(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2})(?!\d)/);
  if (dmyShortYr) {
    const day = Number(dmyShortYr[1]);
    const month = Number(dmyShortYr[2]);
    const year = 2000 + Number(dmyShortYr[3]);
    if (validateCalendarDate(year, month, day)) {
      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { isoDate, displayLabel: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
    }
  }

  // 5. DD/MM or D/M (year-less header, must look cleanly like a short date header)
  const dmShort = cleaned.match(/^(\d{1,2})\s*[-/]\s*(\d{1,2})$/);
  if (dmShort) {
    const day = Number(dmShort[1]);
    const month = Number(dmShort[2]);
    const year = fallbackYear || getCairoDateParts().year;
    if (validateCalendarDate(year, month, day)) {
      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { isoDate, displayLabel: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
    }
  }

  return null;
}

export function extractAllDatesFromString(
  rawText: string,
  fallbackYear?: number
): Array<{ isoDate: string; displayLabel: string; index: number; length: number }> {
  const cleaned = normalizePdfRawText(rawText);
  if (!cleaned || /\d{7,}/.test(cleaned)) return [];

  const matches: Array<{ isoDate: string; displayLabel: string; index: number; length: number }> = [];
  const regex = /(?<!\d)(?:20\d{2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}|\d{1,2}\s*[-/.]\s*\d{1,2}\s*(?:[-/.]\s*|\s+)20\d{2}|\d{1,2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{2})(?!\d)/g;
  for (const m of cleaned.matchAll(regex)) {
    const parsed = tryParseSingleDateCandidate(m[0], fallbackYear);
    if (parsed && m.index !== undefined) {
      matches.push({ ...parsed, index: m.index, length: m[0].length });
    }
  }
  return matches;
}

export function parsePdfColumnDateHeader(
  rawHeader: string,
  fallbackYear?: number
): { isoDate: string; displayLabel: string } | null {
  const cleaned = normalizePdfRawText(rawHeader);
  if (!cleaned) return null;

  // Reject anything that looks like a full phone number (>= 7 consecutive digits)
  if (/\d{7,}/.test(cleaned)) return null;

  const direct = tryParseSingleDateCandidate(cleaned, fallbackYear);
  if (direct) return direct;

  // Visual RTL character reversal recovery (e.g. "6202/11/6" -> "6/11/2026")
  if (/\d{2,4}\s*[-/.]\s*\d/.test(cleaned)) {
    const reversed = cleaned.split('').reverse().join('');
    const revMatch = tryParseSingleDateCandidate(reversed, fallbackYear);
    if (revMatch) return revMatch;
  }

  return null;
}

export function classifyPdfAttendanceCell(rawCellText: string): PdfAttendanceCellStatus {
  const cleaned = normalizePdfRawText(rawCellText)
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .trim();

  if (!cleaned || /^[-—_.\s]+$/.test(cleaned)) {
    return 'empty';
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const hasPresent = tokens.some((t) => /^(ح|حاضر|حاضره|✓|✔|☑)$/i.test(t));
  const hasAbsent = tokens.some((t) => /^(غ|غائب|غائبه|غايب|غايبه|✗|✘)$/i.test(t));

  if (hasPresent && hasAbsent) {
    return 'ambiguous';
  }
  if (hasPresent && tokens.every((t) => /^(ح|حاضر|حاضره|✓|✔|☑)$/i.test(t))) {
    return 'present';
  }
  if (hasAbsent && tokens.every((t) => /^(غ|غائب|غائبه|غايب|غايبه|✗|✘)$/i.test(t))) {
    return 'absent';
  }

  // Combined compact string without space like "حغ" or "ح/غ"
  if (/ح/.test(cleaned) && /غ/.test(cleaned)) {
    return 'ambiguous';
  }

  return 'unknown';
}

type ColumnRole = 'name' | 'code' | 'phone' | 'address' | 'date' | 'absence_count' | 'other';

interface TableColumnDef {
  colIndex: number;
  role: ColumnRole;
  headerText: string;
  xCenter: number;
  xMin: number;
  xMax: number;
  dateIso?: string;
  dateLabel?: string;
}

interface RowCluster {
  yCenter: number;
  yMin: number;
  yMax: number;
  tokens: PositionedPdfToken[];
}

function clusterTokensIntoRows(
  tokens: PositionedPdfToken[],
  horizontalGridYs?: number[]
): RowCluster[] {
  if (tokens.length === 0) return [];

  // Use exact Excel horizontal border lines when present (>= 4 horizontal borders)
  const cleanH =
    horizontalGridYs && horizontalGridYs.length >= 4
      ? dedupeSortedNumbers(horizontalGridYs, 6)
      : null;

  if (cleanH && cleanH.length >= 4) {
    const bands: Array<{ yMin: number; yMax: number; tokens: PositionedPdfToken[] }> = [];
    for (let i = 0; i < cleanH.length - 1; i++) {
      const yMin = cleanH[i];
      const yMax = cleanH[i + 1];
      const h = yMax - yMin;
      if (h >= 9 && h <= 130) {
        bands.push({ yMin, yMax, tokens: [] });
      }
    }

    if (bands.length >= 3) {
      const outsideTokens: PositionedPdfToken[] = [];
      for (const tok of tokens) {
        const tMidY = tok.y + Math.max(4, tok.height) * 0.45;
        const matchedBand = bands.find((b) => tMidY >= b.yMin - 2 && tMidY <= b.yMax + 2);
        if (matchedBand) {
          matchedBand.tokens.push(tok);
        } else {
          outsideTokens.push(tok);
        }
      }

      const occupiedBands = bands.filter((b) => b.tokens.length > 0);
      if (occupiedBands.length >= 3) {
        const result: RowCluster[] = occupiedBands.map((b) => ({
          yCenter: (b.yMin + b.yMax) / 2,
          yMin: b.yMin,
          yMax: b.yMax,
          tokens: b.tokens
        }));
        if (outsideTokens.length > 0) {
          result.push(...clusterTokensByYProximity(outsideTokens));
        }
        return result.sort((a, b) => a.yCenter - b.yCenter);
      }
    }
  }

  return clusterTokensByYProximity(tokens);
}

function clusterTokensByYProximity(tokens: PositionedPdfToken[]): RowCluster[] {
  if (tokens.length === 0) return [];
  const heights = tokens.map((t) => Math.max(6, t.height || 10)).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 11;
  const rowTol = Math.max(5.5, medianH * 0.72);

  const sorted = [...tokens].sort((a, b) => a.y - b.y || b.x - a.x);
  const clusters: RowCluster[] = [];

  for (const tok of sorted) {
    const tH = Math.max(6, tok.height || medianH);
    const target = clusters.find((c) => Math.abs(tok.y - c.yCenter) <= rowTol);
    if (target) {
      target.tokens.push(tok);
      const count = target.tokens.length;
      target.yCenter = (target.yCenter * (count - 1) + tok.y) / count;
      target.yMin = Math.min(target.yMin, tok.y);
      target.yMax = Math.max(target.yMax, tok.y + tH);
    } else {
      clusters.push({
        yCenter: tok.y,
        yMin: tok.y,
        yMax: tok.y + tH,
        tokens: [tok]
      });
    }
  }

  return clusters.sort((a, b) => a.yCenter - b.yCenter);
}

function crossesVerticalBorder(
  leftX: number,
  rightX: number,
  verticalGridXs?: number[]
): boolean {
  if (!verticalGridXs || verticalGridXs.length === 0) return false;
  const minX = Math.min(leftX, rightX);
  const maxX = Math.max(leftX, rightX);
  return verticalGridXs.some((gx) => gx > minX + 1.5 && gx < maxX - 1.5);
}

/**
 * Stitches split inline pdf.js runs on the same horizontal visual line
 * (e.g. ["23", "/", "10", "/", "2026"] or ["6", "/11/", "2026"]) without ever
 * crossing vertical table grid lines or merging separate dates/attendance marks.
 */
function coalesceInlineTokens(
  rawTokens: PositionedPdfToken[],
  verticalGridXs?: number[]
): PositionedPdfToken[] {
  if (rawTokens.length <= 1) return rawTokens;

  // Step 1: If a wide token accidentally contains multiple full dates, split horizontally first
  const expanded: PositionedPdfToken[] = [];
  for (const t of rawTokens) {
    const clean = normalizePdfRawText(t.str);
    if (!clean) continue;
    const multiDates = extractAllDatesFromString(clean);
    if (multiDates.length >= 2) {
      const totalChars = Math.max(1, clean.length);
      for (const md of multiDates) {
        const fracStart = md.index / totalChars;
        const fracLen = Math.max(0.1, md.length / totalChars);
        expanded.push({
          ...t,
          str: md.displayLabel,
          x: t.x + t.width * fracStart,
          width: Math.max(12, t.width * fracLen)
        });
      }
    } else {
      expanded.push({ ...t, str: clean });
    }
  }

  // Step 2: Cluster loosely by horizontal baseline and stitch contiguous micro-fragments left->right
  const byY = [...expanded].sort((a, b) => a.y - b.y || a.x - b.x);
  const lineGroups: PositionedPdfToken[][] = [];
  for (const tok of byY) {
    const line = lineGroups.find((g) => Math.abs(g[0].y - tok.y) <= Math.max(3.5, Math.min(g[0].height, tok.height) * 0.45));
    if (line) line.push(tok);
    else lineGroups.push([tok]);
  }

  const isDateFrag = (s: string) => /^[\d\s./-]{1,12}$/.test(s) && /[\d./-]/.test(s);
  const isSingleMark = (s: string) => /^(ح|غ|✓|✔|✗|✘|؟)$/.test(s.trim());

  const out: PositionedPdfToken[] = [];
  for (const line of lineGroups) {
    line.sort((a, b) => a.x - b.x);
    let cur: PositionedPdfToken | null = null;
    for (const next of line) {
      if (!cur) {
        cur = { ...next };
        continue;
      }

      const curEnd = cur.x + Math.max(2, cur.width);
      const nextEnd = next.x + Math.max(2, next.width);
      const gap = next.x - curEnd;
      const bothDateFragments = isDateFrag(cur.str) && isDateFrag(next.str);
      const curCenter = cur.x + cur.width / 2;
      const nextCenter = next.x + next.width / 2;
      const separatedByBorder = crossesVerticalBorder(curCenter, nextCenter, verticalGridXs);
      const sameGridCell = Boolean(verticalGridXs && verticalGridXs.length >= 2) && !separatedByBorder;

      const maxAllowedGap = bothDateFragments
        ? sameGridCell
          ? 24
          : Math.max(12, Math.min(cur.height, next.height) * 1.1)
        : Math.max(3.5, Math.min(cur.height, next.height) * 0.32);

      const bothAreDates =
        Boolean(parsePdfColumnDateHeader(cur.str)) && Boolean(parsePdfColumnDateHeader(next.str));
      const eitherIsMark = isSingleMark(cur.str) && isSingleMark(next.str);
      // If an incomplete date fragment (e.g. "23/10/") touches a year ("2026") within <= 4pt,
      // allow stitching even if the overhanging year edge slightly crossed a tight Excel cell border.
      const incompleteDateTouchesYear =
        /[/-]$/.test(cur.str) && /^(?:20\d{2}|\d{1,2}(?:[/-]\d{2,4})?)$/.test(next.str) && gap <= 4;

      const canMergeAsDate =
        bothDateFragments &&
        gap >= -8 &&
        gap <= maxAllowedGap &&
        (!separatedByBorder || incompleteDateTouchesYear) &&
        !bothAreDates;

      const curIsArabic = /[\u0600-\u06FF]/.test(cur.str);
      const nextIsArabic = /[\u0600-\u06FF]/.test(next.str);
      const canMergeText =
        !bothAreDates &&
        !eitherIsMark &&
        !separatedByBorder &&
        gap >= -4 &&
        gap <= maxAllowedGap &&
        ((curIsArabic && nextIsArabic) || (bothDateFragments && gap <= 8));

      if (canMergeAsDate || canMergeText) {
        if (bothDateFragments) {
          // Stitch LTR date tokens cleanly without breaking slashes
          const sep = cur.str.endsWith('/') || cur.str.endsWith('-') || next.str.startsWith('/') || next.str.startsWith('-') ? '' : gap > 2.2 ? ' ' : '';
          cur.str = `${cur.str}${sep}${next.str}`.replace(/\s+/g, ' ').trim();
        } else {
          // Notice for RTL Arabic split tokens, visual left token is logically AFTER visual right token!
          const sep = gap > 1.5 ? ' ' : '';
          cur.str = curIsArabic ? `${next.str}${sep}${cur.str}` : `${cur.str}${sep}${next.str}`;
        }
        cur.x = Math.min(cur.x, next.x);
        cur.width = Math.max(curEnd, nextEnd) - cur.x;
        cur.y = Math.min(cur.y, next.y);
        cur.height = Math.max(cur.height, next.height);
      } else {
        out.push(cur);
        cur = { ...next };
      }
    }
    if (cur) out.push(cur);
  }

  return out;
}

function joinTokensVisually(tokens: PositionedPdfToken[]): string {
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return normalizePdfRawText(tokens[0].str);

  // Sub-cluster vertically into lines inside the cell (if multi-line wrapped text)
  const subRows = clusterTokensByYProximity(tokens);
  const lines: string[] = [];

  for (const sub of subRows) {
    const cleanedTokens = sub.tokens
      .map((t) => ({
        ...t,
        cleanStr: normalizePdfRawText(t.str),
        xRight: t.x + Math.max(0, t.width)
      }))
      .filter((t) => Boolean(t.cleanStr));

    if (cleanedTokens.length === 0) continue;

    const joinedAll = cleanedTokens.map((t) => t.cleanStr).join('');
    const arabicCount = (joinedAll.match(/[\u0600-\u06FF]/g) || []).length;
    const isArabicDominant = arabicCount > 0;

    if (isArabicDominant) {
      // RTL order: larger xRight / xCenter comes first (Right -> Left)
      cleanedTokens.sort((a, b) => b.x + b.width / 2 - (a.x + a.width / 2));
    } else {
      // LTR order (dates/numbers): Left -> Right
      cleanedTokens.sort((a, b) => a.x - b.x);
    }

    lines.push(cleanedTokens.map((t) => t.cleanStr).join(' ').replace(/\s+/g, ' ').trim());
  }

  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function classifyHeaderText(headerText: string, fallbackYear?: number): { role: ColumnRole; dateIso?: string; dateLabel?: string } {
  const raw = normalizePdfRawText(headerText);
  const norm = normalizeArabicText(raw);

  // Reject phones cleanly BEFORE date matching
  if (
    norm.includes('تليفون') ||
    norm.includes('موبايل') ||
    norm.includes('واتساب') ||
    norm.includes('هاتف') ||
    norm.includes('رقم اخر') ||
    norm.includes('ولي الامر')
  ) {
    return { role: 'phone' };
  }

  // Check date header (supports DD/MM/YYYY, YYYY-MM-DD, wrapped DD/MM YYYY, etc.)
  const dateParsed = parsePdfColumnDateHeader(raw, fallbackYear);
  if (dateParsed) {
    return { role: 'date', dateIso: dateParsed.isoDate, dateLabel: dateParsed.displayLabel };
  }

  if (norm.includes('عدد الغياب') || norm.includes('اجمالي الغياب') || norm === 'الغياب' || norm.includes('مرات الغياب')) {
    return { role: 'absence_count' };
  }
  if (norm.includes('عنوان') || norm.includes('العنوان') || norm.includes('منطقه')) {
    return { role: 'address' };
  }
  if (norm === 'كود' || norm === 'الكود' || norm === 'code' || norm === 'id') {
    return { role: 'code' };
  }
  if (
    norm === 'الاسم' ||
    norm === 'اسم' ||
    norm.includes('اسم المخدوم') ||
    norm.includes('اسم الطالب') ||
    norm.includes('اسم الطفل') ||
    norm.includes('الاسم بالكامل') ||
    norm.includes('الاسم ثلاثي') ||
    norm.includes('الاسم رباعي') ||
    norm.includes('الاسم واللقب') ||
    norm.includes('بيان الاسم') ||
    /(?:^|\s)الاسم(?:\s|$)/.test(norm) ||
    norm === 'name'
  ) {
    return { role: 'name' };
  }

  return { role: 'other' };
}

function rowDateTokenCount(row: RowCluster, fallbackYear?: number): number {
  const fromIndividual = row.tokens.filter((t) => Boolean(parsePdfColumnDateHeader(t.str, fallbackYear))).length;
  const rowAllDates = extractAllDatesFromString(joinTokensVisually(row.tokens), fallbackYear).length;
  return Math.max(fromIndividual, rowAllDates);
}

function isHeaderCandidateRow(row: RowCluster, fallbackYear?: number): boolean {
  const rowText = normalizeArabicText(joinTokensVisually(row.tokens));
  const hasNameHeader =
    row.tokens.some((t) => {
      const n = normalizeArabicText(normalizePdfRawText(t.str));
      return n === 'الاسم' || n === 'اسم' || n.includes('اسم المخدوم') || n.includes('اسم الطالب');
    }) || /(?:^|\s)الاسم(?:\s|$)/.test(rowText);

  const dateTokensCount = rowDateTokenCount(row, fallbackYear);
  const hasAbsenceHeader = rowText.includes('عدد الغياب') || rowText.includes('اجمالي الغياب');
  const hasPhoneOrAddrHeader = rowText.includes('تليفون') || rowText.includes('موبايل') || rowText.includes('العنوان') || rowText.includes('واتساب');

  return (
    (hasNameHeader && (dateTokensCount >= 1 || hasPhoneOrAddrHeader || hasAbsenceHeader)) ||
    dateTokensCount >= 2 ||
    (hasPhoneOrAddrHeader && (hasAbsenceHeader || dateTokensCount >= 1))
  );
}

function dedupeSortedNumbers(nums: number[], minGap: number): number[] {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: number[] = [];
  for (const n of sorted) {
    if (out.length === 0 || n - out[out.length - 1] > minGap) {
      out.push(n);
    } else {
      out[out.length - 1] = (out[out.length - 1] + n) / 2;
    }
  }
  return out;
}

function buildColumnsUsingGeometricBands(
  allHeaderTokens: PositionedPdfToken[],
  pageWidth: number,
  inferredYear?: number
): TableColumnDef[] {
  interface XGroup {
    tokens: PositionedPdfToken[];
    xMin: number;
    xMax: number;
    xCenter: number;
  }

  const sortedTokens = [...allHeaderTokens].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2));
  const groups: XGroup[] = [];

  for (const tok of sortedTokens) {
    const tMin = tok.x;
    const tMax = tok.x + Math.max(4, tok.width);
    const tCenter = (tMin + tMax) / 2;

    const matchingGroup = groups.find((g) => {
      const overlapX = Math.min(g.xMax, tMax) - Math.max(g.xMin, tMin);
      const minW = Math.min(g.xMax - g.xMin, tMax - tMin);
      const centerClose = Math.abs(tCenter - g.xCenter) <= Math.max(10, minW * 0.48);
      const sameHorizontalBand = (overlapX > 1.5 && overlapX >= minW * 0.3) || centerClose;
      if (!sameHorizontalBand) return false;

      const sameY = g.tokens.some((existing) => Math.abs(existing.y - tok.y) <= 4.5);
      if (sameY) {
        const horizGap = Math.max(tMin - g.xMax, g.xMin - tMax);
        const existingInfo = classifyHeaderText(joinTokensVisually(g.tokens), inferredYear);
        const tokInfo = classifyHeaderText(tok.str, inferredYear);
        // Never merge two complete date columns or two distinct semantic columns
        if (existingInfo.role === 'date' && tokInfo.role === 'date') return false;
        if (existingInfo.role === 'date' || tokInfo.role === 'date') {
          // Only merge if building a split date fragment like "23/10" + "/2026"
          const combined = joinTokensVisually([...g.tokens, tok]);
          if (parsePdfColumnDateHeader(combined, inferredYear) && horizGap <= 10) return true;
          return false;
        }
        if (existingInfo.role !== 'other' && tokInfo.role !== 'other' && existingInfo.role !== tokInfo.role) return false;
        return horizGap <= 10;
      }
      return true;
    });

    if (matchingGroup) {
      matchingGroup.tokens.push(tok);
      matchingGroup.xMin = Math.min(matchingGroup.xMin, tMin);
      matchingGroup.xMax = Math.max(matchingGroup.xMax, tMax);
      matchingGroup.xCenter = (matchingGroup.xMin + matchingGroup.xMax) / 2;
    } else {
      groups.push({
        tokens: [tok],
        xMin: tMin,
        xMax: tMax,
        xCenter: tCenter
      });
    }
  }

  groups.sort((a, b) => a.xCenter - b.xCenter);
  const cols: TableColumnDef[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const prev = i > 0 ? groups[i - 1] : null;
    const next = i < groups.length - 1 ? groups[i + 1] : null;

    const boundMin = prev ? (prev.xCenter + g.xCenter) / 2 : Math.max(0, g.xMin - 24);
    const boundMax = next ? (g.xCenter + next.xCenter) / 2 : Math.max(pageWidth || g.xMax + 40, g.xMax + 36);
    const headerText = joinTokensVisually(g.tokens);
    const info = classifyHeaderText(headerText, inferredYear);

    cols.push({
      colIndex: i,
      role: info.role,
      headerText,
      xCenter: g.xCenter,
      xMin: boundMin,
      xMax: boundMax,
      dateIso: info.dateIso,
      dateLabel: info.dateLabel
    });
  }

  return cols;
}

function buildColumnsForHeaderBand(
  headerRows: RowCluster[],
  pageWidth: number,
  verticalGridXs: number[] | undefined,
  fallbackYear?: number
): TableColumnDef[] {
  const allHeaderTokens = headerRows
    .flatMap((r) => r.tokens)
    .filter((t) => normalizePdfRawText(t.str).length > 0);
  if (allHeaderTokens.length === 0) return [];

  // Infer fallbackYear from any full date inside header
  let inferredYear = fallbackYear;
  for (const t of allHeaderTokens) {
    const parsed = parsePdfColumnDateHeader(t.str);
    if (parsed) {
      const yMatch = parsed.isoDate.match(/^(\d{4})-/);
      if (yMatch) {
        inferredYear = Number(yMatch[1]);
        break;
      }
    }
  }

  const geoCols = buildColumnsUsingGeometricBands(allHeaderTokens, pageWidth, inferredYear);

  // Case 1: Use explicit PDF table vertical grid lines when available & sufficient (>= 4 lines)
  const cleanGrid = verticalGridXs && verticalGridXs.length >= 4 ? dedupeSortedNumbers(verticalGridXs, 6) : null;
  if (cleanGrid && cleanGrid.length >= 4) {
    const gridIntervals: Array<{ xMin: number; xMax: number; tokens: PositionedPdfToken[] }> = [];
    for (let i = 0; i < cleanGrid.length - 1; i++) {
      const xMin = cleanGrid[i];
      const xMax = cleanGrid[i + 1];
      if (xMax - xMin < 8) continue;
      gridIntervals.push({ xMin, xMax, tokens: [] });
    }
    for (const t of allHeaderTokens) {
      const tMin = t.x;
      const tMax = t.x + Math.max(2, t.width);
      const cx = (tMin + tMax) / 2;
      // Ignore very wide merged title/banner strings spanning multiple grid intervals
      const coveredCols = gridIntervals.filter((g) => Math.min(tMax, g.xMax) - Math.max(tMin, g.xMin) > 8).length;
      if (coveredCols >= 3 && (tMax - tMin) > 120) continue;

      let bestGrid: { xMin: number; xMax: number; tokens: PositionedPdfToken[] } | null = null;
      let bestOverlap = -1;
      for (const g of gridIntervals) {
        const overlap = Math.min(tMax, g.xMax) - Math.max(tMin, g.xMin);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestGrid = g;
        }
      }
      if (!bestGrid || bestOverlap <= 0) {
        let minDist = Infinity;
        for (const g of gridIntervals) {
          const dist = cx < g.xMin ? g.xMin - cx : cx > g.xMax ? cx - g.xMax : 0;
          if (dist < minDist) {
            minDist = dist;
            bestGrid = g;
          }
        }
        if (minDist > 12) bestGrid = null;
      }
      if (bestGrid) bestGrid.tokens.push(t);
    }
    const gridCols: TableColumnDef[] = [];
    for (const g of gridIntervals) {
      const headerText = joinTokensVisually(g.tokens);
      if (!headerText) continue;
      const info = classifyHeaderText(headerText, inferredYear);
      gridCols.push({
        colIndex: gridCols.length,
        role: info.role,
        headerText,
        xCenter: (g.xMin + g.xMax) / 2,
        xMin: g.xMin,
        xMax: g.xMax,
        dateIso: info.dateIso,
        dateLabel: info.dateLabel
      });
    }

    const gridDateCount = gridCols.filter((c) => c.role === 'date').length;
    const geoDateCount = geoCols.filter((c) => c.role === 'date').length;
    const gridHasName = gridCols.some((c) => c.role === 'name');
    const geoHasName = geoCols.some((c) => c.role === 'name');

    // Choose grid boundaries whenever they recover at least as many dates as geometric clustering
    if (gridDateCount > 0 && gridDateCount >= geoDateCount && (gridHasName || !geoHasName)) {
      return gridCols;
    }
  }

  return geoCols;
}

function isNonDataFooterOrBanner(rowText: string): boolean {
  const norm = normalizeArabicText(rowText);
  if (!norm) return true;
  if (/^(?:صفحه|page)\s+\d+/.test(norm)) return true;
  if (norm.startsWith('اجمالي') || norm.startsWith('الإجمالي') || norm.startsWith('المجموع')) return true;
  if (norm.includes('كشف حضور وغياب') || norm.includes('تقرير الحضور والغياب')) return true;
  if (norm.includes('كنيسه') && !norm.includes('شارع') && norm.length < 45) return true;
  return false;
}

function parseArabicNumericToken(raw: string): number | null {
  const clean = normalizePdfRawText(raw);
  const match = clean.match(/\b(\d{1,3})\b/);
  if (!match) return null;
  return Number(match[1]);
}

function assignRowTokensToColumns(row: RowCluster, columns: TableColumnDef[]): Map<number, PositionedPdfToken[]> {
  const map = new Map<number, PositionedPdfToken[]>();
  for (const col of columns) {
    map.set(col.colIndex, []);
  }

  for (const tok of row.tokens) {
    if (!normalizePdfRawText(tok.str)) continue;
    const cx = tok.x + Math.max(0, tok.width) / 2;
    let bestCol: TableColumnDef | null = null;
    for (const col of columns) {
      if (cx >= col.xMin && cx < col.xMax) {
        bestCol = col;
        break;
      }
    }
    if (!bestCol && columns.length > 0) {
      // Only allow gentle overflow tolerance for text columns (name/address);
      // NEVER pull marks across empty date or absence columns!
      let minDist = Infinity;
      for (const col of columns) {
        const dist = cx < col.xMin ? col.xMin - cx : cx > col.xMax ? cx - col.xMax : 0;
        if (dist < minDist) {
          minDist = dist;
          bestCol = col;
        }
      }
      const maxAllowedDist = bestCol?.role === 'date' || bestCol?.role === 'absence_count' ? 4 : 40;
      if (minDist > maxAllowedDist) bestCol = null;
    }
    if (bestCol) {
      map.get(bestCol.colIndex)!.push(tok);
    }
  }

  return map;
}

function isStudentDataLikeRow(row: RowCluster): boolean {
  const joined = normalizePdfRawText(joinTokensVisually(row.tokens));
  if (!joined) return false;
  // Phone numbers (01xxxxxxxxx) cleanly identify real student data rows
  if (/\b01\d{8,9}\b/.test(joined)) return true;
  // Or a row with Arabic alphabetic multi-char text + isolated ح / غ marks
  const markTokens = row.tokens.filter((t) => /^(ح|غ|✓|✔|✗|✘)$/.test(normalizePdfRawText(t.str))).length;
  const hasArabicText = /[\u0600-\u06FF]{2,}/.test(joined) && !/(الاسم|تليفون|العنوان|عدد الغياب|واتساب)/.test(normalizeArabicText(joined));
  return hasArabicText && markTokens >= 2;
}

export function parseAttendanceReportFromPositionedPages(
  fileName: string,
  pages: PositionedPdfPage[],
  existingStudents: Student[],
  referenceYear?: number
): ParsedPdfAttendanceReport {
  const warnings: string[] = [];
  const globalIssues: string[] = [];
  const extractedDatesMap = new Map<string, string>(); // iso -> headerLabel
  let activeColumns: TableColumnDef[] | null = null;

  interface IntermediateRow {
    pageNumber: number;
    extractedName: string;
    normalizedName: string;
    extractedCode?: string;
    reportedAbsenceCount: number | null;
    cells: Record<string, ParsedPdfAttendanceCell>;
  }

  const intermediateRows: IntermediateRow[] = [];
  const extractionMode: 'text' | 'ocr' = pages.some((p) => p.extractionSource === 'ocr') ? 'ocr' : 'text';
  const pageDiagnostics: PdfPageDiagnostic[] = [];
  let totalTextItems = 0;
  let totalRowClusters = 0;
  let totalPresent = 0;
  let totalAbsent = 0;
  let totalEmpty = 0;
  let detectedDirection: 'rtl' | 'ltr' | 'unknown' = 'unknown';

  for (const page of pages) {
    const rawItemsCount = page.rawTextItemsCount ?? page.tokens.length;
    totalTextItems += rawItemsCount;

    const normalizedTokens = coalesceInlineTokens(page.tokens, page.verticalGridXs);
    const rowClusters = clusterTokensIntoRows(normalizedTokens, page.horizontalGridYs);
    totalRowClusters += rowClusters.length;

    const pageIssues: string[] = [];
    const sampleExtractedLines = rowClusters
      .slice(0, 4)
      .map((rc) => joinTokensVisually(rc.tokens))
      .filter(Boolean);

    if (rawItemsCount === 0) {
      pageIssues.push(`الصفحة ${page.pageIndex + 1} لا تحتوي على عناصر نصية مستخرجة (0 Text Items).`);
    } else if (rowClusters.length === 0) {
      pageIssues.push(`تعذر تجميع الصفوف في الصفحة ${page.pageIndex + 1} من ${rawItemsCount} عنصر.`);
    }

    // Detect best header band on THIS page (supports Excel title banners with dates, multi-row headers, rotated dates, & repeated headers across pages 1..N)
    let pageHeaderEndIdx = -1;
    let detectedHeaderRowsCount = 0;
    let bestCandidateScore = -Infinity;
    let bestDetectedCols: TableColumnDef[] | null = null;
    const headerScanLimit = Math.min(rowClusters.length, 40);

    for (let i = 0; i < headerScanLimit; i++) {
      if (!isHeaderCandidateRow(rowClusters[i], referenceYear)) continue;

      // Combine contiguous wrapped/stacked header rows within 68pt vertical window, stopping cleanly at the first data row
      const bandRows: RowCluster[] = [rowClusters[i]];
      let bandBottomY = rowClusters[i].yMax;
      let lastHeaderIdx = i;

      for (let lookAhead = i + 1; lookAhead < Math.min(rowClusters.length, i + 5); lookAhead++) {
        const nextRow = rowClusters[lookAhead];
        const verticalGap = nextRow.yMin - bandBottomY;
        if (verticalGap > 68) break;
        if (isStudentDataLikeRow(nextRow)) break;

        const nextText = normalizeArabicText(joinTokensVisually(nextRow.tokens));
        const hasMark = nextRow.tokens.some((t) => /^(ح|غ|✓|✔|✗|✘)$/.test(normalizePdfRawText(t.str)));
        if (hasMark && verticalGap > 18) break;

        const looksLikeContinuationHeader =
          nextText.includes('واتساب') ||
          nextText.includes('الغياب') ||
          nextText.includes('المخدوم') ||
          nextText.includes('الامر') ||
          nextText.includes('تاريخ') ||
          rowDateTokenCount(nextRow, referenceYear) >= 1 ||
          /^(?:[\s/.-]*20\d{2}[\s/.-]*)+$/.test(normalizePdfRawText(nextText)) ||
          nextRow.tokens.some((t) => /^(?:20\d{2}|\d{1,2}[/-]|[/-]\d{1,2})$/.test(normalizePdfRawText(t.str)));

        if (looksLikeContinuationHeader) {
          bandRows.push(nextRow);
          bandBottomY = nextRow.yMax;
          lastHeaderIdx = lookAhead;
        } else {
          break;
        }
      }

      // Also check 1 row ABOVE row[i] if date row or wrapped header label sat above
      if (i > 0) {
        const prevRow = rowClusters[i - 1];
        const prevGap = rowClusters[i].yMin - prevRow.yMax;
        const prevText = normalizeArabicText(joinTokensVisually(prevRow.tokens));
        const prevHasExactNameTok = prevRow.tokens.some((t) => classifyHeaderText(t.str, referenceYear).role === 'name');
        if (
          prevGap <= 36 &&
          (prevHasExactNameTok || rowDateTokenCount(prevRow, referenceYear) >= 1 || prevText.includes('تليفون'))
        ) {
          bandRows.unshift(prevRow);
        }
      }

      const detectedCols = buildColumnsForHeaderBand(bandRows, page.width, page.verticalGridXs, referenceYear);
      const hasExplicitName = detectedCols.some((c) => c.role === 'name');
      const dateCount = detectedCols.filter((c) => c.role === 'date').length;
      if (dateCount === 0) continue;

      const phoneCount = detectedCols.filter((c) => c.role === 'phone').length;
      const hasAbsence = detectedCols.some((c) => c.role === 'absence_count');
      const hasAddress = detectedCols.some((c) => c.role === 'address');
      const bandText = normalizeArabicText(bandRows.map((r) => joinTokensVisually(r.tokens)).join(' '));
      const looksLikeTitleBanner =
        !hasExplicitName &&
        (bandText.includes('كشف حضور') || bandText.includes('تقرير الحضور') || bandText.includes('مار جرجس') || bandText.includes('الشهيد'));

      const score =
        (hasExplicitName ? 120 : 0) +
        dateCount * 35 +
        Math.min(phoneCount, 3) * 18 +
        (hasAbsence ? 20 : 0) +
        (hasAddress ? 15 : 0) -
        (looksLikeTitleBanner ? 150 : 0);

      // Infer rightmost non-phone column as name only if band is not a title banner
      if (!hasExplicitName && !looksLikeTitleBanner) {
        const rtlCols = [...detectedCols].sort((a, b) => b.xCenter - a.xCenter);
        const candidateNameCol = rtlCols.find(
          (c) => c.role !== 'date' && c.role !== 'phone' && c.role !== 'absence_count' && c.role !== 'code'
        );
        if (candidateNameCol) {
          candidateNameCol.role = 'name';
        }
      }

      if (detectedCols.some((c) => c.role === 'date') && detectedCols.some((c) => c.role === 'name') && score > bestCandidateScore) {
        bestCandidateScore = score;
        pageHeaderEndIdx = lastHeaderIdx;
        detectedHeaderRowsCount = bandRows.length;
        bestDetectedCols = detectedCols;
      }
    }

    if (bestDetectedCols && bestCandidateScore > 0) {
      activeColumns = bestDetectedCols;
      for (const col of bestDetectedCols) {
        if (col.role === 'date' && col.dateIso && !extractedDatesMap.has(col.dateIso)) {
          extractedDatesMap.set(col.dateIso, col.dateLabel || col.dateIso);
        }
      }
      const nameColRef = bestDetectedCols.find((c) => c.role === 'name');
      const dateColXs = bestDetectedCols.filter((c) => c.role === 'date').map((c) => c.xCenter);
      if (nameColRef && dateColXs.length > 0) {
        const avgDateX = dateColXs.reduce((acc, x) => acc + x, 0) / dateColXs.length;
        detectedDirection = nameColRef.xCenter > avgDateX ? 'rtl' : 'ltr';
      }
    }

    if (!activeColumns || !activeColumns.some((c) => c.role === 'date')) {
      if (rowClusters.length > 0) {
        pageIssues.push(`الصفحة ${page.pageIndex + 1}: لم يُعثر على رأس جدول يحتوي على أعمدة تواريخ واضحة.`);
      }
      pageDiagnostics.push({
        pageNumber: page.pageIndex + 1,
        pageWidth: Math.round(page.width),
        pageHeight: Math.round(page.height),
        textItemsCount: rawItemsCount,
        normalizedTokensCount: normalizedTokens.length,
        rowClustersCount: rowClusters.length,
        verticalGridLinesCount: page.verticalGridXs?.length || 0,
        horizontalGridLinesCount: page.horizontalGridYs?.length || 0,
        detectedHeaderRowsCount: 0,
        detectedDates: [],
        dateColumnCoordinates: [],
        extractedStudentsCount: 0,
        presentCount: 0,
        absentCount: 0,
        emptyCount: 0,
        sampleExtractedLines,
        issues: pageIssues
      });
      globalIssues.push(...pageIssues);
      continue;
    }

    const pageDateCols = activeColumns.filter((c) => c.role === 'date' && c.dateIso);
    let pageStudentsCount = 0;
    let pagePresentCount = 0;
    let pageAbsentCount = 0;
    let pageEmptyCount = 0;

    const dataStartIdx = pageHeaderEndIdx >= 0 ? pageHeaderEndIdx + 1 : 0;

    for (let rIdx = dataStartIdx; rIdx < rowClusters.length; rIdx++) {
      const cluster = rowClusters[rIdx];
      // Guard: if a repeated header appears mid-page, refresh columns & skip from data
      if (isHeaderCandidateRow(cluster, referenceYear)) {
        const refreshed = buildColumnsForHeaderBand([cluster], page.width, page.verticalGridXs, referenceYear);
        if (refreshed.some((c) => c.role === 'date') && refreshed.some((c) => c.role === 'name')) {
          activeColumns = refreshed;
          for (const col of refreshed) {
            if (col.role === 'date' && col.dateIso && !extractedDatesMap.has(col.dateIso)) {
              extractedDatesMap.set(col.dateIso, col.dateLabel || col.dateIso);
            }
          }
        }
        continue;
      }

      const fullRowText = joinTokensVisually(cluster.tokens);
      if (isNonDataFooterOrBanner(fullRowText)) continue;

      const byCol = assignRowTokensToColumns(cluster, activeColumns);
      const nameCol = activeColumns.find((c) => c.role === 'name');
      const codeCol = activeColumns.find((c) => c.role === 'code');
      const absCol = activeColumns.find((c) => c.role === 'absence_count');

      const rawName = nameCol ? joinTokensVisually(byCol.get(nameCol.colIndex) || []) : '';
      // Strip optional serial number prefix like "1 - مينا عادل" or "1. مينا عادل" if merged into name column
      const cleanedName = rawName.replace(/^\d+[\s.\-–)]+/, '').trim();
      const normName = normalizeArabicStudentNameForImport(cleanedName);

      // Skip rows that have no real alphabetic Arabic/Latin name (e.g. stray page number or numeric footer)
      if (!cleanedName || !/[\p{L}]{2,}/u.test(cleanedName)) continue;

      // Skip repeated header literals just in case
      if (normName === 'الاسم' || normName === 'اسم المخدوم' || normName === 'الاسم بالكامل') continue;

      const rawCode = codeCol ? joinTokensVisually(byCol.get(codeCol.colIndex) || []) : undefined;
      const rawAbs = absCol ? joinTokensVisually(byCol.get(absCol.colIndex) || []) : '';
      const reportedAbsenceCount = rawAbs ? parseArabicNumericToken(rawAbs) : null;

      const cells: Record<string, ParsedPdfAttendanceCell> = {};
      for (const col of activeColumns) {
        if (col.role !== 'date' || !col.dateIso) continue;
        const cellTokens = byCol.get(col.colIndex) || [];
        const cellText = joinTokensVisually(cellTokens);
        const status = classifyPdfAttendanceCell(cellText);
        cells[col.dateIso] = {
          date: col.dateIso,
          rawDateHeader: col.dateLabel || col.headerText,
          rawText: cellText,
          status
        };
        if (status === 'present') {
          pagePresentCount++;
          totalPresent++;
        } else if (status === 'absent') {
          pageAbsentCount++;
          totalAbsent++;
        } else if (status === 'empty') {
          pageEmptyCount++;
          totalEmpty++;
        }
      }

      // Deduplicate cross-page split or accidental repeated identical row in the same PDF
      const existingRow = intermediateRows.find((r) => r.normalizedName === normName && normName.length > 0);
      if (existingRow) {
        for (const [dKey, cVal] of Object.entries(cells)) {
          const prevCell = existingRow.cells[dKey];
          if (!prevCell || prevCell.status === 'empty') {
            existingRow.cells[dKey] = cVal;
          } else if (cVal.status !== 'empty' && prevCell.status !== cVal.status) {
            existingRow.cells[dKey] = {
              ...prevCell,
              rawText: `${prevCell.rawText} / ${cVal.rawText}`.trim(),
              status: 'ambiguous'
            };
            pageIssues.push(`تضارب حالة المخدوم «${cleanedName}» في تاريخ ${dKey} عبر صفحات متكررة.`);
          }
        }
        if (existingRow.reportedAbsenceCount === null && reportedAbsenceCount !== null) {
          existingRow.reportedAbsenceCount = reportedAbsenceCount;
        }
        continue;
      }

      pageStudentsCount++;
      intermediateRows.push({
        pageNumber: page.pageIndex + 1,
        extractedName: cleanedName,
        normalizedName: normName,
        extractedCode: rawCode,
        reportedAbsenceCount,
        cells
      });
    }

    if (pageStudentsCount === 0) {
      pageIssues.push(`الصفحة ${page.pageIndex + 1}: تم التعرف على الجدول لكن لم تُستخرج أسماء مخدومين جديدة منها.`);
    }

    pageDiagnostics.push({
      pageNumber: page.pageIndex + 1,
      pageWidth: Math.round(page.width),
      pageHeight: Math.round(page.height),
      textItemsCount: rawItemsCount,
      normalizedTokensCount: normalizedTokens.length,
      rowClustersCount: rowClusters.length,
      verticalGridLinesCount: page.verticalGridXs?.length || 0,
      horizontalGridLinesCount: page.horizontalGridYs?.length || 0,
      detectedHeaderRowsCount,
      detectedDates: pageDateCols.map((c) => c.dateLabel || c.dateIso!),
      dateColumnCoordinates: pageDateCols.map((c) => ({
        dateIso: c.dateIso!,
        headerLabel: c.dateLabel || c.headerText,
        xMin: Math.round(c.xMin),
        xMax: Math.round(c.xMax),
        xCenter: Math.round(c.xCenter)
      })),
      extractedStudentsCount: pageStudentsCount,
      presentCount: pagePresentCount,
      absentCount: pageAbsentCount,
      emptyCount: pageEmptyCount,
      sampleExtractedLines,
      issues: pageIssues
    });
    globalIssues.push(...pageIssues);
  }

  // Chronological list of all dynamically extracted date columns
  const extractedDates: ParsedPdfDateColumn[] = Array.from(extractedDatesMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, headerLabel]) => ({ date, headerLabel }));

  let failureStage: PdfExtractionStage | null = null;
  let failureReason: string | null = null;

  if (pages.length === 0) {
    failureStage = 'pdf_load';
    failureReason = 'الملف لا يحتوي على أي صفحات قابلة للقراءة.';
  } else if (totalTextItems === 0 && extractionMode === 'text') {
    failureStage = 'text_extraction';
    failureReason = 'لم يتم استخراج أي عناصر نصية (0 Text Items) من صفحات الـ PDF عبر PDF.js.';
  } else if (totalRowClusters === 0) {
    failureStage = 'row_clustering';
    failureReason = `تم استخراج ${totalTextItems} عنصر نصي لكن تعذر تجميعها في صفوف جدولية.`;
  } else if (extractedDates.length === 0) {
    failureStage = 'date_detection';
    failureReason = `تم تجميع ${totalRowClusters} صفاً عبر ${pages.length} صفحات، لكن لم يتم التعرف على أعمدة تواريخ بصيغة (DD/MM/YYYY أو D/M/YYYY). راجع التقرير التشخيصي لعينة الصفوف المستخرجة.`;
  } else if (intermediateRows.length === 0) {
    failureStage = 'student_extraction';
    failureReason = `تم اكتشاف ${extractedDates.length} أعمدة تواريخ (${extractedDates.map((d) => d.headerLabel).join('، ')}) لكن لم يتم استخراج صفوف أسماء مخدومين من عمود الاسم.`;
  }

  if (extractedDates.length === 0) {
    warnings.push('لم يتم العثور على أعمدة تواريخ واضحة داخل جدول الـ PDF.');
  }
  if (intermediateRows.length === 0) {
    warnings.push('لم يتم استخراج صفوف أسماء مخدومين واضحة من الملف.');
  }

  const perDateStats: ParsedPdfAttendanceReport['stats']['perDateStats'] = {};
  for (const d of extractedDates) {
    perDateStats[d.date] = { present: 0, absent: 0, empty: 0, review: 0 };
  }

  let matchedCount = 0;
  let needsReviewCount = 0;
  let emptyCellsCount = 0;
  let unknownOrAmbiguousCellsCount = 0;
  let absenceMismatchRowsCount = 0;

  const rows: ParsedPdfStudentRow[] = intermediateRows.map((item, idx) => {
    const completeCells: Record<string, ParsedPdfAttendanceCell> = {};
    let extractedAbsentCount = 0;

    for (const d of extractedDates) {
      const existingCell = item.cells[d.date];
      const cell: ParsedPdfAttendanceCell = existingCell || {
        date: d.date,
        rawDateHeader: d.headerLabel,
        rawText: '',
        status: 'empty'
      };
      completeCells[d.date] = cell;

      if (cell.status === 'present') {
        perDateStats[d.date].present++;
      } else if (cell.status === 'absent') {
        extractedAbsentCount++;
        perDateStats[d.date].absent++;
      } else if (cell.status === 'empty') {
        emptyCellsCount++;
        perDateStats[d.date].empty++;
      } else {
        unknownOrAmbiguousCellsCount++;
        perDateStats[d.date].review++;
      }
    }

    const hasAbsenceCountMismatch =
      item.reportedAbsenceCount !== null && extractedAbsentCount !== item.reportedAbsenceCount;
    if (hasAbsenceCountMismatch) {
      absenceMismatchRowsCount++;
    }

    const match = matchStudentNameForImport(item.extractedName, existingStudents, item.extractedCode);
    if (match.matchStatus === 'exact') {
      matchedCount++;
    } else {
      needsReviewCount++;
    }

    return {
      rowKey: `pdf_row_${idx + 1}_${item.normalizedName.replace(/\s+/g, '_')}`,
      pageNumber: item.pageNumber,
      extractedName: item.extractedName,
      normalizedName: match.normalizedName,
      extractedCode: item.extractedCode,
      reportedAbsenceCount: item.reportedAbsenceCount,
      extractedAbsentCount,
      hasAbsenceCountMismatch,
      cells: completeCells,
      matchStatus: match.matchStatus,
      matchedStudentId: match.matchedStudentId,
      candidateStudentIds: match.candidateStudentIds
    };
  });

  if (absenceMismatchRowsCount > 0) {
    warnings.push(
      `يوجد اختلاف بين عدد الغياب المحسوب من أعمدة التواريخ وقيمة عمود «عدد الغياب» في ${absenceMismatchRowsCount} صف. تم الاعتماد على أعمدة التواريخ فقط دون تخمين.`
    );
  }
  if (unknownOrAmbiguousCellsCount > 0) {
    warnings.push(`توجد ${unknownOrAmbiguousCellsCount} خلية برمز غير واضح أو ملتبس وتحتاج مراجعة قبل الحفظ.`);
  }

  const diagnostics: PdfDiagnosticReport = {
    stageReached: failureStage || 'completed',
    failureStage,
    failureReason,
    pageCount: pages.length,
    totalTextItems,
    totalRowClusters,
    extractedDates: extractedDates.map((d) => d.headerLabel),
    extractedStudentsCount: rows.length,
    presentCount: Object.values(perDateStats).reduce((acc, s) => acc + s.present, 0) || totalPresent,
    absentCount: Object.values(perDateStats).reduce((acc, s) => acc + s.absent, 0) || totalAbsent,
    emptyCount: emptyCellsCount || totalEmpty,
    unknownOrAmbiguousCount: unknownOrAmbiguousCellsCount,
    tableDirection: detectedDirection,
    issues: Array.from(new Set(globalIssues)),
    pages: pageDiagnostics
  };

  return {
    fileName,
    pageCount: pages.length,
    extractionMode,
    extractedDates,
    rows,
    stats: {
      totalStudents: rows.length,
      matchedCount,
      needsReviewCount,
      emptyCellsCount,
      unknownOrAmbiguousCellsCount,
      absenceMismatchRowsCount,
      perDateStats
    },
    warnings,
    diagnostics
  };
}

let workerInitialized = false;
function resolvePublicPdfjsAssetUrl(relativePath: string): string | undefined {
  if (typeof window === 'undefined' || !window.location?.href) return undefined;
  try {
    return new URL(`./pdfjs/${relativePath}`, window.location.href).href;
  } catch {
    return undefined;
  }
}

function ensurePdfWorkerConfigured() {
  if (workerInitialized) return;
  workerInitialized = true;
  if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
    const publicWorkerUrl = resolvePublicPdfjsAssetUrl('pdf.worker.min.mjs');
    if (publicWorkerUrl) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = publicWorkerUrl;
    } else {
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();
      } catch {
        // Fallback: pdf.js runs on main thread if worker URL cannot be resolved
      }
    }
  }
}

async function extractTableGridFromPage(
  page: any,
  viewport: any
): Promise<{ verticalGridXs: number[]; horizontalGridYs: number[] }> {
  try {
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const xs: number[] = [];
    const ys: number[] = [];
    const stack: number[][] = [];
    let ctm = [1, 0, 0, 1, 0, 0];

    const multiply = (m1: number[], m2: number[]): number[] => [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    ];

    const transformX = (px: number, py: number): number => {
      const gx = ctm[0] * px + ctm[2] * py + ctm[4];
      const gy = ctm[1] * px + ctm[3] * py + ctm[5];
      const vpPt = viewport.convertToViewportPoint(gx, gy);
      return vpPt[0];
    };

    const transformY = (px: number, py: number): number => {
      const gx = ctm[0] * px + ctm[2] * py + ctm[4];
      const gy = ctm[1] * px + ctm[3] * py + ctm[5];
      const vpPt = viewport.convertToViewportPoint(gx, gy);
      return vpPt[1];
    };

    const recordSegment = (vx1: number, vy1: number, vx2: number, vy2: number) => {
      if (Math.abs(vx1 - vx2) <= 2.5 && Math.abs(vy1 - vy2) >= 10) {
        xs.push((vx1 + vx2) / 2);
      }
      if (Math.abs(vy1 - vy2) <= 2.5 && Math.abs(vx1 - vx2) >= 14) {
        ys.push((vy1 + vy2) / 2);
      }
    };

    let curX = 0;
    let curY = 0;
    const fnArray: number[] = opList?.fnArray || [];
    const argsArray: any[] = opList?.argsArray || [];

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      if (fn === OPS.save) {
        stack.push([...ctm]);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
        ctm = multiply(args as number[], ctm);
      } else if (fn === OPS.rectangle && Array.isArray(args) && args.length >= 4) {
        const [rx, ry, rw, rh] = args;
        const x1 = transformX(rx, ry);
        const y1 = transformY(rx, ry);
        const x2 = transformX(rx + rw, ry + rh);
        const y2 = transformY(rx + rw, ry + rh);
        if (Math.abs(y2 - y1) >= 10 || Math.abs(x2 - x1) <= 2.5) {
          xs.push(x1, x2);
        }
        if (Math.abs(x2 - x1) >= 14 || Math.abs(y2 - y1) <= 2.5) {
          ys.push(y1, y2);
        }
      } else if (fn === OPS.constructPath && Array.isArray(args)) {
        const drawStream = Array.isArray(args[1]) && args[1][0] ? args[1][0] : null;
        if (drawStream && typeof drawStream.length === 'number' && !Array.isArray(args[0])) {
          let startX = 0;
          let startY = 0;
          for (let di = 0; di < drawStream.length; ) {
            const dOp = drawStream[di++];
            if (dOp === 0) {
              curX = drawStream[di++];
              curY = drawStream[di++];
              startX = curX;
              startY = curY;
            } else if (dOp === 1) {
              const nx = drawStream[di++];
              const ny = drawStream[di++];
              recordSegment(transformX(curX, curY), transformY(curX, curY), transformX(nx, ny), transformY(nx, ny));
              curX = nx;
              curY = ny;
            } else if (dOp === 2) {
              curX = drawStream[di + 4];
              curY = drawStream[di + 5];
              di += 6;
            } else if (dOp === 3) {
              curX = drawStream[di + 2];
              curY = drawStream[di + 3];
              di += 4;
            } else if (dOp === 4) {
              recordSegment(transformX(curX, curY), transformY(curX, curY), transformX(startX, startY), transformY(startX, startY));
              curX = startX;
              curY = startY;
            } else {
              break;
            }
          }
        } else if (Array.isArray(args[0]) && Array.isArray(args[1])) {
          const subOps: number[] = args[0];
          const coords: number[] = args[1];
          let ci = 0;
          for (const sub of subOps) {
            if (sub === OPS.moveTo) {
              curX = coords[ci++];
              curY = coords[ci++];
            } else if (sub === OPS.lineTo) {
              const nx = coords[ci++];
              const ny = coords[ci++];
              recordSegment(transformX(curX, curY), transformY(curX, curY), transformX(nx, ny), transformY(nx, ny));
              curX = nx;
              curY = ny;
            } else if (sub === OPS.curveTo) {
              ci += 6;
            } else if (sub === OPS.curveTo2 || sub === OPS.curveTo3) {
              ci += 4;
            } else if (sub === OPS.rectangle) {
              const rx = coords[ci++];
              const ry = coords[ci++];
              const rw = coords[ci++];
              const rh = coords[ci++];
              const x1 = transformX(rx, ry);
              const y1 = transformY(rx, ry);
              const x2 = transformX(rx + rw, ry + rh);
              const y2 = transformY(rx + rw, ry + rh);
              if (Math.abs(y2 - y1) >= 10 || Math.abs(x2 - x1) <= 2.5) xs.push(x1, x2);
              if (Math.abs(x2 - x1) >= 14 || Math.abs(y2 - y1) <= 2.5) ys.push(y1, y2);
            }
          }
        }
      }
    }
    return {
      verticalGridXs: dedupeSortedNumbers(xs.filter((x) => Number.isFinite(x) && x >= 0 && x <= viewport.width + 2), 6),
      horizontalGridYs: dedupeSortedNumbers(ys.filter((y) => Number.isFinite(y) && y >= 0 && y <= viewport.height + 2), 6)
    };
  } catch {
    return { verticalGridXs: [], horizontalGridYs: [] };
  }
}

async function defaultBrowserArabicOcrProvider(params: {
  pageIndex: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}): Promise<PositionedPdfToken[]> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('ara');
  try {
    const res = await worker.recognize(params.canvas, {}, { blocks: true });
    const tokens: PositionedPdfToken[] = [];
    const blocks = (res?.data as any)?.blocks || [];
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            const text = normalizePdfRawText(word?.text);
            if (!text || !word?.bbox) continue;
            const scaleX = params.width / (params.canvas.width || params.width);
            const scaleY = params.height / (params.canvas.height || params.height);
            tokens.push({
              str: text,
              x: word.bbox.x0 * scaleX,
              y: word.bbox.y0 * scaleY,
              width: Math.max(4, (word.bbox.x1 - word.bbox.x0) * scaleX),
              height: Math.max(8, (word.bbox.y1 - word.bbox.y0) * scaleY),
              pageIndex: params.pageIndex
            });
          }
        }
      }
    }
    return tokens;
  } finally {
    await worker.terminate();
  }
}

function mergeStackedRotatedVerticalTokens(rotatedTokens: PositionedPdfToken[]): PositionedPdfToken[] {
  if (rotatedTokens.length <= 1) return rotatedTokens;
  const groups: PositionedPdfToken[][] = [];
  for (const tok of rotatedTokens) {
    const g = groups.find((grp) => Math.abs(grp[0].x - tok.x) <= 5);
    if (g) g.push(tok);
    else groups.push([tok]);
  }
  const merged: PositionedPdfToken[] = [];
  for (const grp of groups) {
    // Bottom-to-top rotated Excel headers read upward (`y` descending)
    grp.sort((a, b) => b.y - a.y);
    let cur: PositionedPdfToken | null = null;
    for (const nxt of grp) {
      if (!cur) {
        cur = { ...nxt };
        continue;
      }
      const gapY = Math.abs(cur.y - nxt.y);
      const isDateFrag = (s: string) => /^[\d\s./-]{1,12}$/.test(s);
      if (gapY <= 42 && isDateFrag(cur.str) && isDateFrag(nxt.str)) {
        cur.str = `${cur.str}${nxt.str}`.replace(/\s+/g, '');
        cur.y = Math.min(cur.y, nxt.y);
      } else {
        merged.push(cur);
        cur = { ...nxt };
      }
    }
    if (cur) merged.push(cur);
  }
  return merged;
}

export async function extractPositionedPagesFromPdfBuffer(
  buffer: Uint8Array | ArrayBuffer,
  options?: {
    ocrProvider?: OcrPageProvider;
    onProgress?: (pct: number, message: string) => void;
  }
): Promise<PositionedPdfPage[]> {
  ensurePdfWorkerConfigured();

  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const cMapUrl = resolvePublicPdfjsAssetUrl('cmaps/');
  const standardFontDataUrl = resolvePublicPdfjsAssetUrl('standard_fonts/');

  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useSystemFonts: true,
    ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
    ...(standardFontDataUrl ? { standardFontDataUrl } : {})
  });

  const pdfDoc = await loadingTask.promise;
  const pageCount = pdfDoc.numPages;
  const pages: PositionedPdfPage[] = [];
  let totalChars = 0;

  for (let p = 1; p <= pageCount; p++) {
    options?.onProgress?.(Math.round((p / pageCount) * 60), `جاري قراءة صفحة ${p} من ${pageCount}...`);
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent({ includeMarkedContent: false });
    const { verticalGridXs, horizontalGridYs } = await extractTableGridFromPage(page, viewport);

    const horizontalTokens: PositionedPdfToken[] = [];
    const rotatedTokens: PositionedPdfToken[] = [];
    let rawTextItemsCount = 0;

    for (const rawItem of textContent.items as any[]) {
      if (!rawItem || typeof rawItem.str !== 'string') continue;
      rawTextItemsCount++;
      const clean = normalizePdfRawText(rawItem.str);
      if (!clean) continue;
      totalChars += clean.replace(/\s+/g, '').length;

      const tr = pdfjsLib.Util.transform(viewport.transform, rawItem.transform);
      const horizMag = Math.hypot(tr[0], tr[1]);
      const vertMag = Math.hypot(tr[2], tr[3]);
      const isRotatedVertical =
        (Math.abs(tr[1]) > Math.abs(tr[0]) * 1.5 && Math.abs(tr[2]) > Math.abs(tr[3]) * 1.5) ||
        rawItem.dir === 'ttb';

      if (isRotatedVertical) {
        const fontSize = Math.max(7, horizMag || vertMag || rawItem.height || 10);
        const spanLen = Math.max(fontSize, Number(rawItem.width) || clean.length * 4);
        const dirY = tr[1] < 0 ? -1 : 1;
        const midY = tr[5] + dirY * (spanLen * 0.5);
        rotatedTokens.push({
          str: clean,
          x: tr[4] - fontSize * 0.5,
          y: midY - fontSize * 0.5,
          width: fontSize,
          height: fontSize,
          pageIndex: p - 1,
          dir: rawItem.dir,
          hasEOL: Boolean(rawItem.hasEOL),
          transform: tr
        });
      } else {
        const fontHeight = Math.max(7, vertMag || rawItem.height || 10);
        const x = tr[4];
        const y = tr[5] - fontHeight * 0.8;
        horizontalTokens.push({
          str: clean,
          x,
          y,
          width: Math.max(2, Number(rawItem.width) || clean.length * 4),
          height: fontHeight,
          pageIndex: p - 1,
          dir: rawItem.dir,
          hasEOL: Boolean(rawItem.hasEOL),
          transform: tr
        });
      }
    }

    const mergedRotated = mergeStackedRotatedVerticalTokens(rotatedTokens);
    const tokens = [...horizontalTokens, ...mergedRotated];

    pages.push({
      pageIndex: p - 1,
      width: viewport.width,
      height: viewport.height,
      tokens,
      rawTextItemsCount,
      verticalGridXs,
      horizontalGridYs,
      extractionSource: 'text'
    });
  }

  // Fallback to Arabic OCR strictly when scanned/image-only PDF has virtually zero usable text layer (< 15 chars total)
  if (totalChars < 15 && (typeof document !== 'undefined' || options?.ocrProvider)) {
    const ocrFn = options?.ocrProvider || defaultBrowserArabicOcrProvider;
    const ocrPages: PositionedPdfPage[] = [];

    for (let p = 1; p <= pageCount; p++) {
      options?.onProgress?.(60 + Math.round((p / pageCount) * 35), `جاري تشغيل OCR عربي للصفحة ${p} من ${pageCount}...`);
      const page = await pdfDoc.getPage(p);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderViewport = page.getViewport({ scale: 2 });

      const canvas =
        typeof document !== 'undefined'
          ? (document.createElement('canvas') as HTMLCanvasElement)
          : ({ width: renderViewport.width, height: renderViewport.height } as unknown as HTMLCanvasElement);

      if (typeof document !== 'undefined') {
        canvas.width = Math.round(renderViewport.width);
        canvas.height = Math.round(renderViewport.height);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport: renderViewport, canvas } as any).promise;
        }
      }

      const ocrTokens = await ocrFn({
        pageIndex: p - 1,
        width: baseViewport.width,
        height: baseViewport.height,
        canvas
      });

      ocrPages.push({
        pageIndex: p - 1,
        width: baseViewport.width,
        height: baseViewport.height,
        tokens: ocrTokens,
        rawTextItemsCount: ocrTokens.length,
        verticalGridXs: pages[p - 1]?.verticalGridXs,
        horizontalGridYs: pages[p - 1]?.horizontalGridYs,
        extractionSource: 'ocr'
      });
    }

    return ocrPages;
  }

  return pages;
}

export async function parseAttendancePdfBuffer(
  fileName: string,
  buffer: Uint8Array | ArrayBuffer,
  existingStudents: Student[],
  options?: {
    ocrProvider?: OcrPageProvider;
    onProgress?: (pct: number, message: string) => void;
    referenceYear?: number;
  }
): Promise<ParsedPdfAttendanceReport> {
  try {
    const pages = await extractPositionedPagesFromPdfBuffer(buffer, options);
    options?.onProgress?.(95, 'جاري تحليل الجدول ومطابقة الأسماء والتواريخ...');
    const report = parseAttendanceReportFromPositionedPages(fileName, pages, existingStudents, options?.referenceYear);
    options?.onProgress?.(100, 'تم تحليل الكشف بنجاح');
    return report;
  } catch (err: any) {
    const errMsg = err?.message || 'تعذر فتح ملف الـ PDF عبر محرك PDF.js.';
    return {
      fileName,
      pageCount: 0,
      extractionMode: 'text',
      extractedDates: [],
      rows: [],
      stats: {
        totalStudents: 0,
        matchedCount: 0,
        needsReviewCount: 0,
        emptyCellsCount: 0,
        unknownOrAmbiguousCellsCount: 0,
        absenceMismatchRowsCount: 0,
        perDateStats: {}
      },
      warnings: [`تعذر قراءة ملف PDF في مرحلة تحميل الملف: ${errMsg}`],
      diagnostics: {
        stageReached: 'pdf_load',
        failureStage: 'pdf_load',
        failureReason: errMsg,
        pageCount: 0,
        totalTextItems: 0,
        totalRowClusters: 0,
        extractedDates: [],
        extractedStudentsCount: 0,
        presentCount: 0,
        absentCount: 0,
        emptyCount: 0,
        unknownOrAmbiguousCount: 0,
        tableDirection: 'unknown',
        issues: [errMsg],
        pages: []
      }
    };
  }
}

export async function parseAttendancePdfFile(
  file: File,
  existingStudents: Student[],
  options?: {
    ocrProvider?: OcrPageProvider;
    onProgress?: (pct: number, message: string) => void;
    referenceYear?: number;
  }
): Promise<ParsedPdfAttendanceReport> {
  const buffer = await file.arrayBuffer();
  return parseAttendancePdfBuffer(file.name, buffer, existingStudents, options);
}
