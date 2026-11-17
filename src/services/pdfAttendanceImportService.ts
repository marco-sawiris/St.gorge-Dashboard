import { Student } from '../types/student';
import { ParsedPdfAttendanceReport, PdfAttendanceCellStatus } from './pdfAttendanceParser';
import { AttendanceHistoryRecord } from './indexedDbService';

export interface PdfImportResolutionState {
  rowMappings: Record<string, string | null>; // rowKey -> chosen studentId
  excludedRowKeys: Record<string, boolean>; // rowKey -> true
  cellOverrides: Record<string, 'present' | 'absent' | 'ignored'>; // `${rowKey}__${date}`
  conflictDecisions: Record<string, 'keep_existing' | 'overwrite_with_pdf'>; // `${studentId}__${date}`
}

export function createInitialPdfResolutionState(): PdfImportResolutionState {
  return {
    rowMappings: {},
    excludedRowKeys: {},
    cellOverrides: {},
    conflictDecisions: {}
  };
}

export interface PlannedAttendanceEntry {
  studentId: string;
  studentName: string;
  studentCode: string;
  fridayDate: string;
  isPresent: boolean;
  isOverwrite: boolean;
}

export interface AttendanceImportConflict {
  key: string; // `${studentId}__${fridayDate}`
  studentId: string;
  studentName: string;
  studentCode: string;
  fridayDate: string;
  existingPresent: boolean;
  incomingPresent: boolean;
  decision: 'keep_existing' | 'overwrite_with_pdf';
}

export interface AttendanceImportPlan {
  toApply: PlannedAttendanceEntry[];
  unchangedDuplicates: Array<{
    key: string;
    studentId: string;
    studentName: string;
    fridayDate: string;
    status: boolean;
  }>;
  conflicts: AttendanceImportConflict[];
  existingRecordedCount: number;
  newRecordsCount: number;
  conflictingRecordsCount: number;
  hasPreviouslyRecordedData: boolean;
  skippedEmptyCount: number;
  skippedUnmatchedRowsCount: number;
  excludedRowsCount: number;
  unresolvedCellsCount: number;
  summaryByDate: Record<string, { newCount: number; overwriteCount: number; duplicateCount: number; conflictCount: number }>;
}

/**
 * Generates a stable, ASCII-safe idempotency key for batch attendance imports
 * anchored to (operationId, studentId, fridayDate) so retries and timeouts
 * never create duplicate server mutations.
 */
export function computeDeterministicImportKey(
  operationId: string,
  studentId: string,
  fridayDate: string
): string {
  const cleanOp = String(operationId || 'batch').replace(/[^\x20-\x7E]/g, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'batch';
  const cleanStudent = Array.from(String(studentId || 'std'))
    .map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e && /[a-zA-Z0-9_-]/.test(ch) ? ch : '_'))
    .join('')
    .slice(0, 40) || 'std';
  return `ATT_${cleanStudent}_${fridayDate}_${cleanOp}`;
}

export function getEffectiveCellStatus(
  rowKey: string,
  date: string,
  originalStatus: PdfAttendanceCellStatus,
  resolution: PdfImportResolutionState
): PdfAttendanceCellStatus | 'ignored' {
  const override = resolution.cellOverrides[`${rowKey}__${date}`];
  if (override) return override;
  return originalStatus;
}

export function getEffectiveMatchedStudentId(
  rowKey: string,
  autoMatchedStudentId: string | null,
  resolution: PdfImportResolutionState
): string | null {
  if (Object.prototype.hasOwnProperty.call(resolution.rowMappings, rowKey)) {
    return resolution.rowMappings[rowKey] || null;
  }
  return autoMatchedStudentId;
}

export function buildAttendanceImportPlan(
  report: ParsedPdfAttendanceReport,
  existingStudents: Student[],
  resolution: PdfImportResolutionState,
  existingHistoryRecords: ReadonlyArray<AttendanceHistoryRecord> = []
): AttendanceImportPlan {
  const studentsById = new Map(existingStudents.map((s) => [s.id, s]));
  const historyStatusByLogicalKey = new Map<string, boolean>();
  for (const h of existingHistoryRecords) {
    if (h && h.studentId && h.fridayDate && typeof h.status === 'boolean') {
      historyStatusByLogicalKey.set(`${h.studentId}__${h.fridayDate}`, h.status);
    }
  }

  const toApply: PlannedAttendanceEntry[] = [];
  const unchangedDuplicates: AttendanceImportPlan['unchangedDuplicates'] = [];
  const conflicts: AttendanceImportConflict[] = [];
  const summaryByDate: AttendanceImportPlan['summaryByDate'] = {};

  for (const d of report.extractedDates) {
    summaryByDate[d.date] = { newCount: 0, overwriteCount: 0, duplicateCount: 0, conflictCount: 0 };
  }

  let skippedEmptyCount = 0;
  let skippedUnmatchedRowsCount = 0;
  let excludedRowsCount = 0;
  let unresolvedCellsCount = 0;
  let newRecordsCount = 0;

  // Logical key deduplication across rows in the same plan using Student ID + Attendance Date
  const seenLogicalKeys = new Set<string>();

  for (const row of report.rows) {
    if (resolution.excludedRowKeys[row.rowKey]) {
      excludedRowsCount++;
      continue;
    }

    const effectiveStudentId = getEffectiveMatchedStudentId(row.rowKey, row.matchedStudentId, resolution);
    const student = effectiveStudentId ? studentsById.get(effectiveStudentId) : undefined;
    if (!student) {
      skippedUnmatchedRowsCount++;
      continue;
    }

    for (const dateCol of report.extractedDates) {
      const dateIso = dateCol.date;
      const cell = row.cells[dateIso];
      if (!cell) continue;

      const effectiveStatus = getEffectiveCellStatus(row.rowKey, dateIso, cell.status, resolution);
      if (effectiveStatus === 'empty' || effectiveStatus === 'ignored') {
        skippedEmptyCount++;
        continue;
      }
      if (effectiveStatus === 'unknown' || effectiveStatus === 'ambiguous') {
        unresolvedCellsCount++;
        continue;
      }

      const incomingIsPresent = effectiveStatus === 'present';
      const logicalKey = `${student.id}__${dateIso}`;
      if (seenLogicalKeys.has(logicalKey)) {
        continue;
      }
      seenLogicalKeys.add(logicalKey);

      // Authoritative check against BOTH live student attendance map AND IndexedDB attendance_history
      const studentAttVal = student.att?.[dateIso];
      const historyVal = historyStatusByLogicalKey.get(logicalKey);
      const existingVal =
        typeof studentAttVal === 'boolean'
          ? studentAttVal
          : typeof historyVal === 'boolean'
          ? historyVal
          : undefined;

      if (typeof existingVal === 'boolean') {
        if (existingVal === incomingIsPresent) {
          unchangedDuplicates.push({
            key: logicalKey,
            studentId: student.id,
            studentName: student.name,
            fridayDate: dateIso,
            status: incomingIsPresent
          });
          summaryByDate[dateIso].duplicateCount++;
        } else {
          // Default protects historical data ('keep_existing') unless user explicitly chooses overwrite
          const decision = resolution.conflictDecisions[logicalKey] || 'keep_existing';
          conflicts.push({
            key: logicalKey,
            studentId: student.id,
            studentName: student.name,
            studentCode: student.code,
            fridayDate: dateIso,
            existingPresent: existingVal,
            incomingPresent: incomingIsPresent,
            decision
          });
          summaryByDate[dateIso].conflictCount++;
          if (decision === 'overwrite_with_pdf') {
            toApply.push({
              studentId: student.id,
              studentName: student.name,
              studentCode: student.code,
              fridayDate: dateIso,
              isPresent: incomingIsPresent,
              isOverwrite: true
            });
            summaryByDate[dateIso].overwriteCount++;
          }
        }
      } else {
        toApply.push({
          studentId: student.id,
          studentName: student.name,
          studentCode: student.code,
          fridayDate: dateIso,
          isPresent: incomingIsPresent,
          isOverwrite: false
        });
        newRecordsCount++;
        summaryByDate[dateIso].newCount++;
      }
    }
  }

  const existingRecordedCount = unchangedDuplicates.length + conflicts.length;
  const conflictingRecordsCount = conflicts.length;

  return {
    toApply,
    unchangedDuplicates,
    conflicts,
    existingRecordedCount,
    newRecordsCount,
    conflictingRecordsCount,
    hasPreviouslyRecordedData: existingRecordedCount > 0,
    skippedEmptyCount,
    skippedUnmatchedRowsCount,
    excludedRowsCount,
    unresolvedCellsCount,
    summaryByDate
  };
}
