import { Request, Response, NextFunction } from 'express';
import { dbManager } from '../db';

export function sanitizeObject(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitiveKeys = ['password', 'token', 'phone', 'phoneStudent', 'phoneParent1', 'phoneParent2', 'address', 'cookie'];
  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeObject(sanitized[key]);
    }
  }

  return sanitized;
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const originalJson = res.json;

  res.json = function (body: any) {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      const isAuthAction = req.path.includes('/auth/');
      const status = res.statusCode >= 400 ? 'failed' : 'success';
      const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

      if (isAuthAction || res.statusCode >= 400) {
        dbManager.logAudit({
          timestamp: new Date(),
          userId: (req as any).user?.userId || 'anonymous',
          username: (req as any).user?.username || (req.body && req.body.username) || 'unknown',
          action: `${req.method} ${req.path}`,
          status: res.statusCode === 403 ? 'denied' : res.statusCode === 409 ? 'conflict' : status,
          ipAddress: ip.split(',')[0].trim(),
          details: {
            statusCode: res.statusCode,
            durationMs: duration
          }
        }).catch(() => {});
      }
    }
    return originalJson.call(this, body);
  };

  next();
}
