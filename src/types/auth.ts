export type UserRole = 'admin' | 'servant' | 'viewer';

export interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  assignedServantName?: string;
  token?: string;
}

export interface AppNotification {
  id: string;
  dedupKey?: string;
  title: string;
  desc?: string;
  type: 'info' | 'warn' | 'success' | 'danger';
  timestamp: number;
  unread: boolean;
  appVersion?: string;
}

export type MutationQueueStatus = 'pending' | 'retrying' | 'timeout_unknown' | 'conflict' | 'failed';
export type SyncOutcomeStatus = 'success' | 'pending' | 'timeout_unknown' | 'failed' | 'conflict';
export type RemoteVerificationOutcome =
  | 'verified_persisted'
  | 'not_found_retryable'
  | 'unknown'
  | 'verification_unavailable'
  | 'conflict';

export interface MutationStageTimings {
  prepMs?: number;
  networkMs?: number;
  verifyMs?: number;
  serverMs?: number;
  totalMs?: number;
  mode?: 'batch' | 'single';
  batchSize?: number;
}

export interface OfflineMutation {
  id: string; // Unique Operation Idempotency Key (UUID-backed, immutable across all retries)
  action: 'attendance' | 'followup' | 'update' | 'add' | 'delete' | 'transfer';
  studentId: string;
  studentCode: string;
  studentName: string;
  sourceSheet: string;
  payload: Record<string, any>;
  expectedVersion?: number;
  timestamp: number;
  retryCount?: number;
  status?: MutationQueueStatus;
  syncOutcome?: SyncOutcomeStatus;
  verificationOutcome?: RemoteVerificationOutcome;
  remoteRecordId?: string;
  verifiedAt?: string;
  lastError?: string;
  lastAttemptAt?: number;
  nextRetryAt?: number;
  lastDurationMs?: number;
  stageTimingsMs?: MutationStageTimings;
  isPermanentError?: boolean;
  errorCategory?: 'transient' | 'permanent' | 'conflict' | 'timeout';
}
