import type { OfflineMutation, RemoteVerificationOutcome } from '../types/auth';

export type MutationOperationType = OfflineMutation['action'];

/**
 * Structured Remote Persistence Proof contract (Phase 4.3.3 client-side enforcement,
 * to be emitted by Phase 4.4 server endpoints in Code.gs and server/routes/sheets.ts).
 *
 * A mutation MUST NOT be treated as synchronized or deleted from IndexedDB
 * unless the remote response supplies a valid proof matching the exact mutation.
 */
export interface RemotePersistenceProof {
  mutationId: string;
  persisted: true;
  operation: MutationOperationType;
  studentId: string;
  friday?: string; // REQUIRED (YYYY-MM-DD) for 'attendance' and 'followup'
  date?: string; // Optional Cairo calendar date (YYYY-MM-DD) for 'followup'
  sheetName: string;
  recordId?: string; // Stable remote record identifier
  verifiedAt?: string; // Optional ISO timestamp
  row?: number;
  newVersion?: number;
  followupLogAppended?: boolean;
  followupLogRow?: number;
  deduplicated?: boolean;
}

export interface PersistenceProofValidationResult {
  valid: boolean;
  outcome: RemoteVerificationOutcome;
  reason: string;
  proof?: RemotePersistenceProof;
}

export interface TimeoutVerificationItemResult {
  mutationId: string;
  outcome: RemoteVerificationOutcome;
  reason: string;
  proof?: RemotePersistenceProof;
  conflictError?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value.trim());
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function normalizeSheetForProof(value: unknown): string {
  return String(value ?? '').trim();
}

function isValidIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed);
}

/**
 * Strictly validates that a remote write response (or stored idempotency record)
 * proves that the EXACT intended mutation was persisted remotely.
 *
 * Fail-closed rules:
 * - Generic HTTP 200 `{ ok: true }` without `persisted: true` and matching identity fields is REJECTED.
 * - Mismatched `mutationId`, `studentId`, `operation`, `sheetName`, or `friday` date is REJECTED.
 * - Followup proofs MUST prove followup-log persistence (`followupLogAppended === true` + stable remote ID/row)
 *   and CANNOT be satisfied by attendance proof or student existence.
 * - Attendance proofs MUST prove `operation === 'attendance'` for the exact `friday` and remote target row/recordId
 *   and CANNOT be satisfied by followup proof.
 */
export function validateRemotePersistenceProof(
  mutation: OfflineMutation,
  rawResponse: unknown
): PersistenceProofValidationResult {
  if (!rawResponse || typeof rawResponse !== 'object') {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'missing_or_invalid_response'
    };
  }

  const raw = rawResponse as Record<string, any>;

  // Explicit optimistic-concurrency conflict always maps to 'conflict'
  if (raw.status === 409 || raw.outcome === 'conflict') {
    return {
      valid: false,
      outcome: 'conflict',
      reason: 'remote_version_conflict'
    };
  }

  // If top-level `ok` is present, it MUST be strictly true
  if ('ok' in raw && raw.ok !== true) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'response_not_ok'
    };
  }

  // Accept either nested `raw.proof` envelope (recommended Phase 4.4 shape)
  // OR explicit top-level proof fields when `raw.ok === true`
  let candidate: Record<string, any> | null = null;
  if (raw.proof && typeof raw.proof === 'object' && !Array.isArray(raw.proof)) {
    candidate = raw.proof as Record<string, any>;
  } else if (raw.ok === true) {
    candidate = raw;
  } else if (raw.persisted === true) {
    candidate = raw;
  }

  if (!candidate) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'missing_proof_object'
    };
  }

  // 1. Strict boolean persisted === true (rejects generic `{ ok: true }`)
  if (candidate.persisted !== true) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'missing_persisted_flag'
    };
  }

  // 2. Exact mutationId match
  const expectedMutationId = String(mutation.id || '').trim();
  const proofMutationId = String(candidate.mutationId ?? '').trim();
  if (!expectedMutationId || !proofMutationId || proofMutationId !== expectedMutationId) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'mutation_id_mismatch'
    };
  }

  // 3. Exact operation match (prevents cross-operation false verification)
  const proofOperation = String(candidate.operation ?? '').trim();
  if (!proofOperation || proofOperation !== mutation.action) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'operation_mismatch'
    };
  }
  // If an auxiliary `action` field is also present on the proof, it must agree with `operation`
  if (candidate.action !== undefined && String(candidate.action).trim() !== proofOperation) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'operation_action_conflict'
    };
  }

  // 4. Exact studentId match (never rely on approximate student name or code alone)
  const expectedStudentId = String(mutation.studentId || '').trim();
  const proofStudentId = String(candidate.studentId ?? '').trim();
  if (!expectedStudentId || !proofStudentId || proofStudentId !== expectedStudentId) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'student_id_mismatch'
    };
  }

  // 5. Sheet name match
  const expectedSheet = normalizeSheetForProof(mutation.sourceSheet);
  const proofSheet = normalizeSheetForProof(candidate.sheetName ?? candidate.sheet);
  if (!expectedSheet || !proofSheet || proofSheet !== expectedSheet) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'sheet_name_mismatch'
    };
  }

  // 6. Optional verifiedAt timestamp sanity check
  let normalizedVerifiedAt: string | undefined;
  if (candidate.verifiedAt !== undefined && candidate.verifiedAt !== null && candidate.verifiedAt !== '') {
    if (!isValidIsoTimestamp(candidate.verifiedAt)) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'invalid_verified_at_timestamp'
      };
    }
    normalizedVerifiedAt = String(candidate.verifiedAt).trim();
  }

  const normalizedRecordId =
    typeof candidate.recordId === 'string' && candidate.recordId.trim()
      ? candidate.recordId.trim()
      : undefined;
  const normalizedRow = isPositiveInteger(candidate.row) ? candidate.row : undefined;
  const normalizedFollowupLogRow = isPositiveInteger(candidate.followupLogRow)
    ? candidate.followupLogRow
    : undefined;
  const normalizedNewVersion = isPositiveInteger(candidate.newVersion)
    ? candidate.newVersion
    : undefined;

  // 7. Operation-specific proof checks
  if (mutation.action === 'attendance') {
    const expectedFriday = String(mutation.payload?.friday || mutation.payload?.date || '').trim();
    const proofFriday = String(candidate.friday ?? '').trim();
    if (!isValidIsoDateString(expectedFriday) || !isValidIsoDateString(proofFriday) || proofFriday !== expectedFriday) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'attendance_friday_mismatch'
      };
    }

    // Must reference an actual persisted remote row or recordId
    if (!normalizedRecordId && !normalizedRow) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'attendance_missing_remote_target'
      };
    }

    // If proof echoes the attendance boolean, verify it matches the intended state
    const hasProofPresent = candidate.present !== undefined || candidate.isPresent !== undefined;
    if (hasProofPresent) {
      const expectedPresent = Boolean(mutation.payload?.isPresent ?? mutation.payload?.present);
      const proofPresent = Boolean(candidate.isPresent ?? candidate.present);
      if (proofPresent !== expectedPresent) {
        return {
          valid: false,
          outcome: 'unknown',
          reason: 'attendance_state_mismatch'
        };
      }
    }

    return {
      valid: true,
      outcome: 'verified_persisted',
      reason: 'verified_attendance_persistence_proof',
      proof: {
        mutationId: proofMutationId,
        persisted: true,
        operation: 'attendance',
        studentId: proofStudentId,
        friday: proofFriday,
        sheetName: proofSheet,
        recordId: normalizedRecordId,
        verifiedAt: normalizedVerifiedAt,
        row: normalizedRow,
        newVersion: normalizedNewVersion,
        deduplicated: Boolean(candidate.deduplicated ?? raw.deduplicated)
      }
    };
  }

  if (mutation.action === 'followup') {
    const expectedFriday = String(mutation.payload?.friday || '').trim();
    const proofFriday = String(candidate.friday ?? '').trim();
    if (!isValidIsoDateString(expectedFriday) || !isValidIsoDateString(proofFriday) || proofFriday !== expectedFriday) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'followup_friday_mismatch'
      };
    }

    // If client sent an explicit Cairo calendar date AND server returned `date`, they must match
    const expectedDate = String(mutation.payload?.date || '').trim();
    const proofDate = String(candidate.date ?? '').trim();
    if (expectedDate && proofDate && proofDate !== expectedDate) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'followup_date_mismatch'
      };
    }

    // Followup MUST explicitly prove persistence in the remote followup log
    const logConfirmed = candidate.followupLogAppended === true;
    if (!logConfirmed) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'followup_log_not_confirmed'
      };
    }

    // Must provide a stable remote record identifier (recordId or followupLogRow)
    const expectedRecordId = String(mutation.payload?.recordId || '').trim();
    if (expectedRecordId) {
      if (!normalizedRecordId || normalizedRecordId !== expectedRecordId) {
        return {
          valid: false,
          outcome: 'unknown',
          reason: 'followup_record_id_mismatch'
        };
      }
    } else if (!normalizedRecordId && !normalizedFollowupLogRow) {
      return {
        valid: false,
        outcome: 'unknown',
        reason: 'followup_missing_remote_identifier'
      };
    }

    return {
      valid: true,
      outcome: 'verified_persisted',
      reason: 'verified_followup_persistence_proof',
      proof: {
        mutationId: proofMutationId,
        persisted: true,
        operation: 'followup',
        studentId: proofStudentId,
        friday: proofFriday,
        date: proofDate || undefined,
        sheetName: proofSheet,
        recordId: normalizedRecordId,
        verifiedAt: normalizedVerifiedAt,
        row: normalizedRow,
        newVersion: normalizedNewVersion,
        followupLogAppended: true,
        followupLogRow: normalizedFollowupLogRow,
        deduplicated: Boolean(candidate.deduplicated ?? raw.deduplicated)
      }
    };
  }

  // 'update' | 'add' | 'delete'
  const hasStableTarget =
    Boolean(normalizedRecordId) ||
    Boolean(normalizedRow) ||
    (mutation.action === 'delete' && candidate.deleted === true);

  if (!hasStableTarget) {
    return {
      valid: false,
      outcome: 'unknown',
      reason: 'missing_remote_target_identifier'
    };
  }

  return {
    valid: true,
    outcome: 'verified_persisted',
    reason: `verified_${mutation.action}_persistence_proof`,
    proof: {
      mutationId: proofMutationId,
      persisted: true,
      operation: mutation.action,
      studentId: proofStudentId,
      sheetName: proofSheet,
      recordId: normalizedRecordId,
      verifiedAt: normalizedVerifiedAt,
      row: normalizedRow,
      newVersion: normalizedNewVersion,
      deduplicated: Boolean(candidate.deduplicated ?? raw.deduplicated)
    }
  };
}

/**
 * Validates a single entry returned by the remote idempotency/verification lookup
 * (`checkIdempotency` / `GET /api/sheets/idempotency`).
 *
 * Distinguishes strictly between:
 * - `verified_persisted` — ONLY when `found === true` AND a valid `RemotePersistenceProof` matches the mutation.
 * - `conflict` — when the remote ledger records a 409/conflict outcome.
 * - `not_found_retryable` — when the remote verification service explicitly checked its durable ledger and returned `found === false`.
 * - `unknown` — when the entry is malformed, missing, or says `found === true` without valid structured persistence proof (fail-closed!).
 */
export function validateTimeoutIdempotencyEntry(
  mutation: OfflineMutation,
  entry: unknown
): TimeoutVerificationItemResult {
  if (!entry || typeof entry !== 'object') {
    return {
      mutationId: mutation.id,
      outcome: 'unknown',
      reason: 'missing_idempotency_entry'
    };
  }

  const record = entry as Record<string, any>;

  if (
    record.outcome === 'conflict' ||
    record.status === 'conflict' ||
    record.status === 409 ||
    record.response?.status === 409
  ) {
    return {
      mutationId: mutation.id,
      outcome: 'conflict',
      reason: 'remote_idempotency_conflict',
      conflictError:
        record.error ||
        record.response?.error ||
        'تعارض في التعديل المتزامن (HTTP 409) تم رصده أثناء التحقق بعد انتهاء المهلة'
    };
  }

  if (record.found === false) {
    return {
      mutationId: mutation.id,
      outcome: 'not_found_retryable',
      reason: 'not_found_in_remote_ledger'
    };
  }

  if (record.found === true) {
    if (record.response && typeof record.response === 'object' && record.response.ok === false) {
      return {
        mutationId: mutation.id,
        outcome: 'unknown',
        reason: 'stored_response_not_ok'
      };
    }

    const proofEnvelope =
      record.proof && typeof record.proof === 'object'
        ? { ok: true, proof: record.proof, deduplicated: true }
        : record.response && typeof record.response === 'object'
        ? record.response
        : null;

    if (!proofEnvelope) {
      return {
        mutationId: mutation.id,
        outcome: 'unknown',
        reason: 'found_without_persistence_proof'
      };
    }

    const validation = validateRemotePersistenceProof(mutation, proofEnvelope);
    if (validation.valid && validation.proof) {
      return {
        mutationId: mutation.id,
        outcome: 'verified_persisted',
        reason: validation.reason,
        proof: validation.proof
      };
    }

    if (validation.outcome === 'conflict') {
      return {
        mutationId: mutation.id,
        outcome: 'conflict',
        reason: validation.reason,
        conflictError:
          record.response?.error ||
          'تعارض في التعديل المتزامن (HTTP 409) تم رصده أثناء التحقق'
      };
    }

    return {
      mutationId: mutation.id,
      outcome: 'unknown',
      reason: `unverified_idempotency_record:${validation.reason}`
    };
  }

  return {
    mutationId: mutation.id,
    outcome: 'unknown',
    reason: 'ambiguous_idempotency_entry'
  };
}

export function buildUnverifiedRemoteErrorMessage(reason: string): string {
  return `استجاب الخادم دون إثبات حفظ فعلي موثّق للعملية (${reason}) — تم الاحتفاظ بالعملية محلياً بأمان لحين التحقق وعدم حذفها.`;
}

export function buildTimeoutOutcomeErrorMessage(
  outcome: RemoteVerificationOutcome,
  reason: string
): string {
  switch (outcome) {
    case 'not_found_retryable':
      return 'انتهت مهلة الاتصال ولم يتم العثور على العملية في سجل الخادم — محفوظة محلياً بنفس معرفها الثابت وستُعاد المحاولة تلقائياً بأمان.';
    case 'verification_unavailable':
      return `انتهت مهلة الاتصال وتعذر الوصول لخدمة التحقق عن بُعد (${reason}) — تم الاحتفاظ بالعملية محلياً بأمان دون حذف لحين التحقق.`;
    case 'unknown':
    default:
      return `انتهت مهلة الاتصال ولم يقدّم الخادم إثبات حفظ فعلي موثّق (${reason}) — تم الاحتفاظ بالعملية محلياً بنفس معرفها الثابت بأمان.`;
  }
}
