import assert from 'assert';
import express from 'express';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'net';
import { hashPassword, verifyPassword } from '../../server/security/argon2';
import { signAccessToken, verifyAccessToken, signRefreshToken, verifyRefreshToken } from '../../server/security/jwt';
import { dbManager } from '../../server/db';
import { evaluateUserPermission } from '../context/AuthContext';
import { AuthUser } from '../types/auth';
import authRouter from '../../server/routes/auth';
import healthRouter from '../../server/routes/health';
import sheetsRouter from '../../server/routes/sheets';
import { googleSheetsService } from '../../server/services/googleSheetsService';

console.log('======================================================');
console.log('  🧪 Running St. George Full-Stack Backend Test Suite');
console.log('======================================================\n');

async function runBackendTests() {
  // Test 1: Argon2id Hashing & Verification
  console.log('--- Test 1: Argon2id Password Hashing & Verification ---');
  const plain = 'MySecretChurchPass2026!';
  const hashed = await hashPassword(plain);
  assert(hashed.startsWith('$argon2id'), 'Hash must follow standard Argon2id prefix');
  const valid = await verifyPassword(hashed, plain);
  assert(valid === true, 'Verification of correct password must succeed');
  const invalid = await verifyPassword(hashed, 'WrongPassword!');
  assert(invalid === false, 'Verification of wrong password must fail');
  console.log('✅ Test 1 Passed: Argon2id Hashing and Verification functional\n');

  // Test 2: JWT Access & Refresh Token Lifecycle
  console.log('--- Test 2: JWT Access & Refresh Token Lifecycle ---');
  const payload = {
    userId: 'usr_test_123',
    username: 'mina_test',
    displayName: 'مينا جورج',
    role: 'servant' as const,
    assignedServantName: 'مينا جورج'
  };
  const token = signAccessToken(payload);
  assert(typeof token === 'string' && token.length > 20, 'Access token must be generated');
  const verified = verifyAccessToken(token);
  assert(verified && verified.userId === payload.userId, 'Verified token payload must match');

  const refToken = signRefreshToken(payload);
  const refVerified = verifyRefreshToken(refToken);
  assert(refVerified && refVerified.username === payload.username, 'Refresh token payload must match');

  const invalidToken = verifyAccessToken('invalid.token.payload');
  assert(invalidToken === null, 'Invalid token must return null');
  console.log('✅ Test 2 Passed: JWT Token Lifecycle functional\n');

  // Test 3: User Authentication & Database Retrieval
  console.log('--- Test 3: User Authentication & In-Memory / DB Store ---');
  const adminUser = await dbManager.getUserByUsername('admin');
  assert(adminUser !== null, 'Seeded admin user must exist');
  assert(adminUser.role === 'admin', 'Admin role must be correct');
  const isPassValid = await verifyPassword(adminUser.passwordHash, 'Admin@123456');
  assert(isPassValid === true, 'Seeded admin password must verify correctly');
  console.log('✅ Test 3 Passed: User Store and Seed Retrieval functional\n');

  // Test 4: Account Lockout Logic
  console.log('--- Test 4: Account Lockout Logic ---');
  const testUser = await dbManager.getUserByUsername('viewer');
  assert(testUser !== null, 'Viewer user exists');
  testUser.failedAttempts = 5;
  testUser.lockoutUntil = new Date(Date.now() + 15 * 60 * 1000);
  await dbManager.updateUser(testUser);

  const updatedTestUser = await dbManager.getUserByUsername('viewer');
  assert(updatedTestUser && updatedTestUser.failedAttempts === 5, 'Failed attempts must be recorded');
  assert(updatedTestUser.lockoutUntil && updatedTestUser.lockoutUntil.getTime() > Date.now(), 'Lockout must be active');
  // Reset for clean state
  testUser.failedAttempts = 0;
  testUser.lockoutUntil = null;
  await dbManager.updateUser(testUser);
  console.log('✅ Test 4 Passed: Account Lockout Logic functional\n');

  // Test 5: Role-Based Access Control (RBAC) & Servant RLAC
  console.log('--- Test 5: Role-Based Access Control (RBAC) & Servant RLAC ---');
  const adminAuthUser: AuthUser = {
    userId: 'usr_admin',
    username: 'admin',
    displayName: 'أمين الخدمة',
    role: 'admin',
    token: 'valid.token'
  };
  const adminPerm = evaluateUserPermission(adminAuthUser, false, 'attendance', 'أي خادم');
  assert(adminPerm.allowed === true, 'Admin can mark attendance for any student');

  const servantAuthUser: AuthUser = {
    userId: 'usr_mina',
    username: 'mina',
    displayName: 'مينا جورج',
    role: 'servant',
    assignedServantName: 'مينا جورج',
    token: 'valid.token'
  };
  const servantOwnStudent = evaluateUserPermission(servantAuthUser, false, 'attendance', 'مينا جورج');
  assert(servantOwnStudent.allowed === true, 'Servant can mark attendance for own assigned student');

  const servantOtherStudent = evaluateUserPermission(servantAuthUser, false, 'attendance', 'بيتر سمير');
  assert(servantOtherStudent.allowed === false, 'Servant CANNOT mark attendance for another servant student');

  const viewerAuthUser: AuthUser = {
    userId: 'usr_viewer',
    username: 'viewer',
    displayName: 'خادم زائر',
    role: 'viewer',
    token: 'valid.token'
  };
  const viewerPerm = evaluateUserPermission(viewerAuthUser, false, 'attendance', 'مينا جورج');
  assert(viewerPerm.allowed === false, 'Viewer has zero write permissions');
  console.log('✅ Test 5 Passed: RBAC and Servant RLAC verified\n');

  // Test 6: Server-side Idempotency Deduplication
  console.log('--- Test 6: Server-side Idempotency Deduplication ---');
  const idempotencyKey = 'IDEMP_KEY_TEST_998877';
  await dbManager.saveIdempotencyRecord({
    key: idempotencyKey,
    action: 'attendance',
    studentId: 'std_001',
    status: 'completed',
    responseBody: { studentId: 'std_001', status: 'حاضر' },
    createdAt: new Date()
  });

  const checkRecord = await dbManager.getIdempotencyRecord(idempotencyKey);
  assert(checkRecord !== null, 'Idempotency record must exist');
  assert(checkRecord.responseBody.status === 'حاضر', 'Response body must match');

  const nonExistentKey = await dbManager.getIdempotencyRecord('NON_EXISTENT_KEY');
  assert(nonExistentKey === null, 'Non-existent idempotency key must return null');
  console.log('✅ Test 6 Passed: Server-side Idempotency Deduplication verified\n');

  // Test 7: Security Audit Logging
  console.log('--- Test 7: Security Audit Logging ---');
  await dbManager.logAudit({
    timestamp: new Date(),
    userId: 'usr_admin',
    username: 'admin',
    action: 'LOGIN_SUCCESS',
    status: 'success',
    ipAddress: '192.168.1.50',
    details: { userAgent: 'TestRunner' }
  });

  const logs = await dbManager.getAuditLogs(10);
  assert(logs.length > 0, 'Audit logs must be recorded');
  const lastLog = logs[logs.length - 1];
  assert(lastLog.action === 'LOGIN_SUCCESS', 'Audit action must match');
  console.log('✅ Test 7 Passed: Security Audit Logging verified\n');

  // Test 8: Full HTTP Express End-to-End Integration (Auth + Sheets Data + Idempotent Mutate + OCC 409 + Zero Delete + RLAC)
  console.log('--- Test 8: End-to-End Express API (Auth, Sheets Data, OCC 409, RLAC, Zero Delete) ---');
  googleSheetsService.seedTestFixtureStudentsOnly([
    {
      id: 'fixture_std_1',
      code: '9001',
      name: 'توماس هاني اختبار',
      servant: 'مارك صموئيل',
      phoneStudent: '01200009001',
      phoneParent1: '01200009002',
      phoneParent2: '',
      birthDate: '2011-01-10',
      area: 'الزيتون',
      address: 'الزيتون',
      notes: '',
      followupStatus: 'بدون',
      attendanceTotal: 2,
      attendanceMonth: 1,
      attendanceStatus: 'حاضر',
      sourceSheet: 'نشط',
      version: 1,
      att: { '2026-11-13': true },
      fu: {}
    },
    {
      id: 'fixture_std_2',
      code: '9002',
      name: 'كيرلس مينا اختبار',
      servant: 'مينا جورج',
      phoneStudent: '01200009003',
      phoneParent1: '01200009004',
      phoneParent2: '',
      birthDate: '2011-03-15',
      area: 'الزيتون',
      address: 'الزيتون',
      notes: '',
      followupStatus: 'تم تليفونياً',
      attendanceTotal: 1,
      attendanceMonth: 1,
      attendanceStatus: 'غائب',
      sourceSheet: 'نشط',
      version: 1,
      att: {},
      fu: { '2026-11-13': 'تم تليفونياً' }
    }
  ]);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/sheets', sheetsRouter);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 8a. Health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert(healthRes.status === 200, 'Health endpoint must return 200');
    const healthJson = await healthRes.json();
    assert(healthJson.status === 'ok', 'Health status must be ok');

    // 8b. Unauthenticated /api/sheets/data must return 401
    const unauthRes = await fetch(`${baseUrl}/api/sheets/data?sheet=${encodeURIComponent('نشط')}`);
    assert(unauthRes.status === 401, 'Unauthenticated sheets/data must return 401');

    // 8c. Admin login + Refresh + Logout revocation
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123456' })
    });
    assert(adminLoginRes.status === 200, 'Admin login must succeed');
    const adminLoginJson = await adminLoginRes.json();
    assert(adminLoginJson.ok === true && adminLoginJson.token && adminLoginJson.refreshToken, 'Admin login must return tokens');

    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminLoginJson.refreshToken })
    });
    assert(refreshRes.status === 200, 'Session refresh must succeed');

    // 8d. Fetch /api/sheets/data for 'نشط'
    const dataRes = await fetch(`${baseUrl}/api/sheets/data?sheet=${encodeURIComponent('نشط')}`, {
      headers: { Authorization: `Bearer ${adminLoginJson.token}` }
    });
    assert(dataRes.status === 200, 'Authenticated GET /api/sheets/data must return 200');
    const dataJson = await dataRes.json();
    assert(dataJson.ok === true && dataJson.isComplete === true && Array.isArray(dataJson.students) && dataJson.students.length > 0, 'Sheets data must include completeness confirmation and students');

    const targetStudent = dataJson.students[0];

    // 8e. Attendance Mutation + Idempotency Deduplication + OCC 409 Conflict
    const idempKey = `TEST_ATT_${Date.now()}`;
    const mutRes1 = await fetch(`${baseUrl}/api/sheets/mutate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminLoginJson.token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempKey
      },
      body: JSON.stringify({
        action: 'attendance',
        studentId: targetStudent.id,
        sourceSheet: targetStudent.sourceSheet,
        expectedVersion: targetStudent.version,
        payload: { friday: '2026-11-13', isPresent: true }
      })
    });
    assert(mutRes1.status === 200, 'Attendance mutation must return 200');
    const mutJson1 = await mutRes1.json();
    assert(mutJson1.newVersion === targetStudent.version + 1, 'Version must increment by 1');

    // Retry with SAME idempotency key -> deduplicated
    const mutResRetry = await fetch(`${baseUrl}/api/sheets/mutate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminLoginJson.token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempKey
      },
      body: JSON.stringify({
        action: 'attendance',
        studentId: targetStudent.id,
        sourceSheet: targetStudent.sourceSheet,
        expectedVersion: targetStudent.version,
        payload: { friday: '2026-11-13', isPresent: true }
      })
    });
    assert(mutResRetry.status === 200, 'Idempotent retry must return 200');
    const mutJsonRetry = await mutResRetry.json();
    assert(mutJsonRetry.deduplicated === true, 'Retry must return deduplicated: true');

    // Stale version -> HTTP 409 Conflict
    const staleRes = await fetch(`${baseUrl}/api/sheets/mutate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminLoginJson.token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `TEST_STALE_${Date.now()}`
      },
      body: JSON.stringify({
        action: 'followup',
        studentId: targetStudent.id,
        sourceSheet: targetStudent.sourceSheet,
        expectedVersion: targetStudent.version, // stale!
        payload: { friday: '2026-11-13', method: 'تم تليفونياً' }
      })
    });
    assert(staleRes.status === 409, 'Stale expectedVersion must trigger HTTP 409 Conflict');

    // 8f. Zero Delete Student Policy (HTTP 403)
    const delRes = await fetch(`${baseUrl}/api/sheets/mutate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminLoginJson.token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `TEST_DEL_${Date.now()}`
      },
      body: JSON.stringify({
        action: 'delete',
        studentId: targetStudent.id,
        expectedVersion: mutJson1.newVersion
      })
    });
    assert(delRes.status === 403, 'Delete mutation must be blocked with HTTP 403');

    // 8g. Servant RLAC: 'mina' cannot mutate student assigned to another servant
    const minaLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mina', password: 'Servant@123456' })
    });
    assert(minaLoginRes.status === 200, 'Servant mina login must succeed');
    const minaJson = await minaLoginRes.json();

    const otherServantStudent = dataJson.students.find((s: any) => s.servant && s.servant !== 'مينا جورج');
    if (otherServantStudent) {
      const rlacRes = await fetch(`${baseUrl}/api/sheets/mutate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${minaJson.token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `TEST_RLAC_${Date.now()}`
        },
        body: JSON.stringify({
          action: 'attendance',
          studentId: otherServantStudent.id,
          expectedVersion: otherServantStudent.version,
          payload: { friday: '2026-11-13', isPresent: true }
        })
      });
      assert(rlacRes.status === 403, 'Servant mutating another servant student must be blocked with 403');
    }

    // 8h. Logout revokes refresh session
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminLoginJson.refreshToken })
    });
    assert(logoutRes.status === 200, 'Logout must succeed');

    const revokedRefreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: adminLoginJson.refreshToken })
    });
    assert(revokedRefreshRes.status === 401, 'Revoked refresh token must be rejected with 401');

    console.log('✅ Test 8 Passed: Full Express HTTP API (Auth, Refresh, Logout, Sheets Data, Idempotency, OCC 409, RLAC 403, Zero Delete 403) verified\n');
  } finally {
    server.close();
  }

  console.log('======================================================');
  console.log('🎉 ALL 8 BACKEND INTEGRATION TESTS PASSED SUCCESSFULLY!');
  console.log('======================================================');
}

runBackendTests().catch((err) => {
  console.error('❌ Backend Test Failure:', err);
  process.exit(1);
});
