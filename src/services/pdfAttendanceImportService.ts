import { Student } from '../types/student';
import { ParsedPdfAttendanceReport, PdfAttendanceCellStatus } from './pdfAttendanceParser';

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
  skippedEmptyCount: number;
  skippedUnmatchedRowsCount: number;
  excludedRowsCount: number;
  unresolvedCellsCount: number;
  summaryByDate: Record<string, { newCount: number; overwriteCount: number; duplicateCount: number; conflictCount: number }>;
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
  resolution: PdfImportResolutionState
): AttendanceImportPlan {
  const studentsById = new Map(existingStudents.map((s) => [s.id, s]));
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

  // Logical key deduplication across rows in the same plan
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

      const existingVal = student.att?.[dateIso];
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
        summaryByDate[dateIso].newCount++;
      }
    }
  }

  return {
    toApply,
    unchangedDuplicates,
    conflicts,
    skippedEmptyCount,
    skippedUnmatchedRowsCount,
    excludedRowsCount,
    unresolvedCellsCount,
    summaryByDate
  };
}
