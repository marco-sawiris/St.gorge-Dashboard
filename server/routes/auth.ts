import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { dbManager } from '../db';
import { verifyPassword } from '../security/argon2';
import { signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken } from '../security/jwt';
import { authLimiter } from '../middleware/rateLimit';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { ENV } from '../config/env';

const router = Router();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  return (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || '127.0.0.1').trim();
}

// POST /api/auth/login
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  const ip = getClientIp(req);

  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
  }

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'كلمة المرور مطلوبة' });
  }

  const normalizedUsername = username.trim().toLowerCase();
  const user = await dbManager.getUserByUsername(normalizedUsername);
  if (!user) {
    await dbManager.logAudit({
      timestamp: new Date(),
      userId: 'anonymous',
      username: normalizedUsername,
      action: 'LOGIN_FAILED',
      status: 'failed',
      ipAddress: ip,
      details: { reason: 'user_not_found' }
    });
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  // Account Lockout check
  if (user.lockoutUntil && new Date(user.lockoutUntil).getTime() > Date.now()) {
    const remainingMin = Math.ceil((new Date(user.lockoutUntil).getTime() - Date.now()) / (60 * 1000));
    await dbManager.logAudit({
      timestamp: new Date(),
      userId: user.id,
      username: user.username,
      action: 'LOGIN_LOCKED',
      status: 'denied',
      ipAddress: ip,
      details: { remainingMinutes: remainingMin }
    });
    return res.status(429).json({
      error: `تم حظر الحساب مؤقتاً لكثرة المحاولات الخاطئة. يرجى المحاولة بعد ${remainingMin} دقيقة.`
    });
  }

  // Verify Argon2id password hash
  const isValid = await verifyPassword(user.passwordHash, password);
  if (!isValid) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    if (user.failedAttempts >= ENV.MAX_LOGIN_ATTEMPTS) {
      user.lockoutUntil = new Date(Date.now() + ENV.LOCKOUT_DURATION_MS);
    }
    await dbManager.updateUser(user);

    await dbManager.logAudit({
      timestamp: new Date(),
      userId: user.id,
      username: user.username,
      action: 'LOGIN_FAILED',
      status: 'failed',
      ipAddress: ip,
      details: { failedAttempts: user.failedAttempts }
    });

    const remainingAttempts = Math.max(0, ENV.MAX_LOGIN_ATTEMPTS - user.failedAttempts);
    if (remainingAttempts === 0) {
      return res.status(429).json({
        error: 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. تم قفل الحساب مؤقتاً لمدة 15 دقيقة.'
      });
    }

    return res.status(401).json({
      error: `كلمة المرور غير صحيحة. متبقي ${remainingAttempts} محاولات قبل إيقاف الحساب.`
    });
  }

  // Success: reset lockout & failed attempts
  user.failedAttempts = 0;
  user.lockoutUntil = null;
  await dbManager.updateUser(user);

  const sessionId = `sess_${crypto.randomUUID()}`;
  const tokenPayload = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    assignedServantName: user.assignedServantName
  };

  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken({ ...tokenPayload, sessionId });

  await dbManager.saveSession({
    id: sessionId,
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revoked: false,
    createdAt: new Date()
  });

  await dbManager.logAudit({
    timestamp: new Date(),
    userId: user.id,
    username: user.username,
    action: 'LOGIN_SUCCESS',
    status: 'success',
    ipAddress: ip,
    details: { role: user.role, sessionId }
  });

  // Set HTTP-only secure cookie for refresh token
  res.cookie('stgorge_refresh_token', refreshToken, {
    httpOnly: true,
    secure: ENV.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  return res.json({
    ok: true,
    token: accessToken,
    refreshToken,
    user: tokenPayload
  });
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const refreshToken = (req.cookies && req.cookies.stgorge_refresh_token) || (req.body && req.body.refreshToken);
  const ip = getClientIp(req);

  if (!refreshToken) {
    return res.status(401).json({ error: 'رمز التجديد مفقود' });
  }

  const payload = verifyRefreshToken(refreshToken);
  if (!payload) {
    res.clearCookie('stgorge_refresh_token');
    return res.status(401).json({ error: 'رمز التجديد منتهي الصلاحية أو غير صالح' });
  }

  // Verify persisted session hasn't been revoked
  if (payload.sessionId) {
    const session = await dbManager.getSession(payload.sessionId);
    const presentedHash = hashToken(String(refreshToken));
    const storedHash = session?.tokenHash || '';
    const hashesMatch = storedHash.length === presentedHash.length &&
      crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(presentedHash, 'hex'));
    if (!session || session.revoked || session.expiresAt.getTime() < Date.now() || !hashesMatch) {
      res.clearCookie('stgorge_refresh_token');
      return res.status(401).json({ error: 'تم إبطال الجلسة أو انتهت صلاحيتها أو لا يطابق رمز التجديد الجلسة المحفوظة' });
    }
  }

  // Check if user still exists
  const user = await dbManager.getUserById(payload.userId);
  if (!user) {
    res.clearCookie('stgorge_refresh_token');
    return res.status(401).json({ error: 'المستخدم لم يعد مسجلاً في النظام' });
  }

  const newPayload = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    assignedServantName: user.assignedServantName
  };

  const newAccessToken = signAccessToken(newPayload);

  await dbManager.logAudit({
    timestamp: new Date(),
    userId: user.id,
    username: user.username,
    action: 'TOKEN_REFRESH',
    status: 'success',
    ipAddress: ip
  });

  return res.json({
    ok: true,
    token: newAccessToken,
    user: newPayload
  });
});

// POST /api/auth/logout
router.post('/logout', async (req: Request, res: Response) => {
  const refreshToken = (req.cookies && req.cookies.stgorge_refresh_token) || (req.body && req.body.refreshToken);
  const ip = getClientIp(req);

  if (refreshToken) {
    const payload = verifyRefreshToken(refreshToken);
    if (payload?.sessionId) {
      await dbManager.revokeSession(payload.sessionId);
    }
    if (payload) {
      await dbManager.logAudit({
        timestamp: new Date(),
        userId: payload.userId,
        username: payload.username,
        action: 'LOGOUT',
        status: 'success',
        ipAddress: ip
      });
    }
  }

  res.clearCookie('stgorge_refresh_token');
  return res.json({ ok: true, message: 'تم تسجيل الخروج بنجاح' });
});

// GET /api/auth/verify
router.get('/verify', (req: Request, res: Response) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ valid: false, error: 'الرمز مفقود' });
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ valid: false, error: 'الرمز غير صالح أو منتهي الصلاحية' });
  }

  return res.json({
    valid: true,
    user: payload
  });
});

// GET /api/auth/audit-logs (Admin only)
router.get('/audit-logs', authenticateToken, requireRole(['admin']), async (req: AuthenticatedRequest, res: Response) => {
  const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50));
  const logs = await dbManager.getAuditLogs(limit);
  return res.json({ ok: true, logs });
});

export default router;
