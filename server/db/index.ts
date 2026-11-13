import { Pool } from 'pg';
import { ENV } from '../config/env';
import { hashPassword } from '../security/argon2';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  role: 'admin' | 'servant' | 'viewer';
  assignedServantName?: string;
  failedAttempts: number;
  lockoutUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revoked: boolean;
  createdAt: Date;
}

export interface IdempotencyRecord {
  key: string;
  action: string;
  studentId: string;
  status: 'completed' | 'conflict';
  responseBody: any;
  createdAt: Date;
}

export interface AuditLogRecord {
  id?: string;
  timestamp: Date;
  userId: string;
  username: string;
  action: string;
  status: 'success' | 'failed' | 'denied' | 'conflict';
  ipAddress: string;
  details?: any;
}

// In-Memory store fallback for standalone testing or offline resilience
class InMemoryDatabase {
  users = new Map<string, UserRecord>();
  sessions = new Map<string, RefreshSessionRecord>();
  idempotency = new Map<string, IdempotencyRecord>();
  auditLogs: AuditLogRecord[] = [];
  initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.seedDefaults();
  }

  async seedDefaults() {
    // Demo credentials are permitted only in development/test environments.
    // Production must provision real users through an explicit administrative process.
    if (ENV.NODE_ENV === 'production') return;

    const adminPass = await hashPassword('Admin@123456');
    const servantPass = await hashPassword('Servant@123456');
    const viewerPass = await hashPassword('Viewer@123456');

    const seedUsers: UserRecord[] = [
      {
        id: 'usr_admin_001',
        username: 'admin',
        passwordHash: adminPass,
        displayName: 'أمين الخدمة',
        role: 'admin',
        failedAttempts: 0,
        lockoutUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 'usr_servant_001',
        username: 'mina',
        passwordHash: servantPass,
        displayName: 'مينا جورج',
        role: 'servant',
        assignedServantName: 'مينا جورج',
        failedAttempts: 0,
        lockoutUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 'usr_servant_002',
        username: 'peter',
        passwordHash: servantPass,
        displayName: 'بيتر سمير',
        role: 'servant',
        assignedServantName: 'بيتر سمير',
        failedAttempts: 0,
        lockoutUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 'usr_viewer_001',
        username: 'viewer',
        passwordHash: viewerPass,
        displayName: 'خادم زائر',
        role: 'viewer',
        failedAttempts: 0,
        lockoutUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    for (const u of seedUsers) {
      if (!this.users.has(u.username)) {
        this.users.set(u.username, u);
      }
    }
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    await this.initPromise;
    return this.users.get(username.trim().toLowerCase()) || null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    await this.initPromise;
    for (const u of this.users.values()) {
      if (u.id === id) return u;
    }
    return null;
  }

  async updateUser(user: UserRecord): Promise<void> {
    user.updatedAt = new Date();
    this.users.set(user.username.toLowerCase(), user);
  }

  async saveSession(session: RefreshSessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getSession(id: string): Promise<RefreshSessionRecord | null> {
    return this.sessions.get(id) || null;
  }

  async revokeSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      s.revoked = true;
    }
  }

  async getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    return this.idempotency.get(key) || null;
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(record.key, record);
  }

  async logAudit(log: AuditLogRecord): Promise<void> {
    this.auditLogs.push(log);
  }

  async getAuditLogs(limit = 100): Promise<AuditLogRecord[]> {
    return this.auditLogs.slice(-limit);
  }
}

// PostgreSQL Database Client with fallback
class DatabaseManager {
  private pool: Pool | null = null;
  private inMemory: InMemoryDatabase = new InMemoryDatabase();
  private bootstrapPromise: Promise<void> = Promise.resolve();
  public isPostgresConnected = false;

  constructor() {
    this.initPool();
  }

  private assertDatabaseReady(): void {
    if (ENV.NODE_ENV === 'production' && (!this.pool || !this.isPostgresConnected)) {
      throw new Error('Production database unavailable: PostgreSQL is not connected; in-memory fallback is disabled.');
    }
  }

  async ensureProductionReady(): Promise<void> {
    if (ENV.NODE_ENV !== 'production') return;
    if (!this.pool) {
      throw new Error('Production startup blocked: DATABASE_URL or complete PostgreSQL connection settings are required.');
    }
    await this.bootstrapPromise;
    if (!this.isPostgresConnected) {
      throw new Error('Production startup blocked: PostgreSQL connection/schema bootstrap failed. In-memory fallback is disabled.');
    }
  }

  private initPool() {
    if (ENV.DATABASE_URL || ENV.SQL_HOST) {
      try {
        if (ENV.DATABASE_URL) {
          this.pool = new Pool({
            connectionString: ENV.DATABASE_URL,
            max: 10,
            connectionTimeoutMillis: 5000
          });
        } else {
          this.pool = new Pool({
            host: ENV.SQL_HOST,
            user: ENV.SQL_USER,
            password: ENV.SQL_PASSWORD,
            database: ENV.SQL_DB_NAME,
            max: 10,
            connectionTimeoutMillis: 5000
          });
        }

        this.pool.on('error', (err) => {
          console.warn('Postgres pool idle client warning:', err.message);
        });

        // Keep the bootstrap promise so production startup can fail closed
        // instead of accepting requests while the database is unavailable.
        this.bootstrapPromise = this.bootstrapPostgres();
      } catch (err: any) {
        console.warn('Postgres initialization deferred to in-memory store:', err.message);
      }
    }
  }

  private async bootstrapPostgres() {
    if (!this.pool) return;
    try {
      const client = await this.pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(64) PRIMARY KEY,
            username VARCHAR(64) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            display_name VARCHAR(128) NOT NULL,
            role VARCHAR(32) NOT NULL,
            assigned_servant_name VARCHAR(128),
            failed_attempts INT DEFAULT 0,
            lockout_until TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS refresh_sessions (
            id VARCHAR(64) PRIMARY KEY,
            user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
            token_hash VARCHAR(255) NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            revoked BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS idempotency_keys (
            key VARCHAR(128) PRIMARY KEY,
            action VARCHAR(64) NOT NULL,
            student_id VARCHAR(64) NOT NULL,
            status VARCHAR(32) NOT NULL,
            response_body JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            user_id VARCHAR(64),
            username VARCHAR(64),
            action VARCHAR(64) NOT NULL,
            status VARCHAR(32) NOT NULL,
            ip_address VARCHAR(64),
            details JSONB
          );
        `);

        // Seed demo users only outside production. Never create known default
        // usernames/passwords in a production database.
        const countRes = await client.query('SELECT COUNT(*)::int AS total FROM users');
        if (ENV.NODE_ENV !== 'production' && (countRes.rows[0]?.total ?? 0) === 0) {
          await this.inMemory.initPromise;
          for (const u of this.inMemory.users.values()) {
            await client.query(
              `INSERT INTO users (id, username, password_hash, display_name, role, assigned_servant_name, failed_attempts, lockout_until, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (username) DO NOTHING`,
              [
                u.id,
                u.username,
                u.passwordHash,
                u.displayName,
                u.role,
                u.assignedServantName || null,
                u.failedAttempts,
                u.lockoutUntil,
                u.createdAt,
                u.updatedAt
              ]
            );
          }
        }

        this.isPostgresConnected = true;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn('Could not bootstrap Postgres tables; production startup will fail closed:', err.message);
      this.isPostgresConnected = false;
    }
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            username: row.username,
            passwordHash: row.password_hash,
            displayName: row.display_name,
            role: row.role,
            assignedServantName: row.assigned_servant_name,
            failedAttempts: row.failed_attempts,
            lockoutUntil: row.lockout_until ? new Date(row.lockout_until) : null,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at)
          };
        }
        if (ENV.NODE_ENV === 'production') return null;
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres query error, falling back to memory store:', err);
      }
    }
    return this.inMemory.getUserByUsername(username);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            username: row.username,
            passwordHash: row.password_hash,
            displayName: row.display_name,
            role: row.role,
            assignedServantName: row.assigned_servant_name,
            failedAttempts: row.failed_attempts,
            lockoutUntil: row.lockout_until ? new Date(row.lockout_until) : null,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at)
          };
        }
        if (ENV.NODE_ENV === 'production') return null;
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres query error, falling back to memory store:', err);
      }
    }
    return this.inMemory.getUserById(id);
  }

  async updateUser(user: UserRecord): Promise<void> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        await this.pool.query(
          `UPDATE users SET failed_attempts = $1, lockout_until = $2, updated_at = NOW() WHERE id = $3`,
          [user.failedAttempts, user.lockoutUntil, user.id]
        );
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres updateUser error:', err);
      }
    }
    await this.inMemory.updateUser(user);
  }

  async saveSession(session: RefreshSessionRecord): Promise<void> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at, revoked, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET revoked = EXCLUDED.revoked`,
          [session.id, session.userId, session.tokenHash, session.expiresAt, session.revoked, session.createdAt]
        );
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres saveSession error:', err);
      }
    }
    await this.inMemory.saveSession(session);
  }

  async getSession(id: string): Promise<RefreshSessionRecord | null> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM refresh_sessions WHERE id = $1', [id]);
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            userId: row.user_id,
            tokenHash: row.token_hash,
            expiresAt: new Date(row.expires_at),
            revoked: Boolean(row.revoked),
            createdAt: new Date(row.created_at)
          };
        }
        if (ENV.NODE_ENV === 'production') return null;
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres getSession error:', err);
      }
    }
    return this.inMemory.getSession(id);
  }

  async revokeSession(id: string): Promise<void> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        await this.pool.query('UPDATE refresh_sessions SET revoked = TRUE WHERE id = $1', [id]);
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres revokeSession error:', err);
      }
    }
    await this.inMemory.revokeSession(id);
  }

  async getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM idempotency_keys WHERE key = $1', [key]);
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            key: row.key,
            action: row.action,
            studentId: row.student_id,
            status: row.status,
            responseBody: row.response_body,
            createdAt: new Date(row.created_at)
          };
        }
        if (ENV.NODE_ENV === 'production') return null;
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres idempotency query error:', err);
      }
    }
    return this.inMemory.getIdempotencyRecord(key);
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO idempotency_keys (key, action, student_id, status, response_body, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (key) DO UPDATE SET response_body = EXCLUDED.response_body`,
          [record.key, record.action, record.studentId, record.status, JSON.stringify(record.responseBody), record.createdAt]
        );
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres idempotency save error:', err);
      }
    }
    await this.inMemory.saveIdempotencyRecord(record);
  }

  async logAudit(log: AuditLogRecord): Promise<void> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO audit_logs (timestamp, user_id, username, action, status, ip_address, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [log.timestamp, log.userId, log.username, log.action, log.status, log.ipAddress, JSON.stringify(log.details || {})]
        );
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres audit log error:', err);
      }
    }
    await this.inMemory.logAudit(log);
  }

  async getAuditLogs(limit = 100): Promise<AuditLogRecord[]> {
    this.assertDatabaseReady();
    if (this.isPostgresConnected && this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT id, timestamp, user_id, username, action, status, ip_address, details FROM audit_logs ORDER BY timestamp DESC LIMIT $1',
          [limit]
        );
        return res.rows.map((row) => ({
          id: String(row.id),
          timestamp: new Date(row.timestamp),
          userId: row.user_id,
          username: row.username,
          action: row.action,
          status: row.status,
          ipAddress: row.ip_address,
          details: row.details
        }));
      } catch (err) {
        if (ENV.NODE_ENV === 'production') throw err;
        console.warn('Postgres audit query error:', err);
      }
    }
    return this.inMemory.getAuditLogs(limit);
  }
}

export const dbManager = new DatabaseManager();
