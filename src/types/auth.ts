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
  title: string;
  desc?: string;
  type: 'info' | 'warn' | 'success' | 'danger';
  timestamp: number;
  unread: boolean;
}

export interface OfflineMutation {
  id: string; // Unique Operation Idempotency Key (UUID-backed)
  action: 'attendance' | 'followup' | 'update' | 'add' | 'delete';
  studentId: string;
  studentCode: string;
  studentName: string;
  sourceSheet: string;
  payload: Record<string, any>;
  expectedVersion?: number;
  timestamp: number;
  retryCount?: number;
  status?: 'pending' | 'conflict';
  lastError?: string;
}
