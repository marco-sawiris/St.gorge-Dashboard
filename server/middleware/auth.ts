import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../security/jwt';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export const authenticateToken = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const configuredRelayKey = (process.env.RELAY_KEY || '').trim();
  const providedRelayKey = String(req.headers['x-relay-key'] || '').trim();
  if (configuredRelayKey && providedRelayKey && providedRelayKey === configuredRelayKey) {
    req.user = {
      userId: 'relay_service',
      username: 'relay_service',
      displayName: 'خدمة فصل الشهيد مارجرجس',
      role: 'admin'
    };
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({
      error: 'المصادقة مطلوبة: يرجى توفير رمز وصول أو مفتاح الوسيط'
    });
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({
      error: 'رمز الوصول منتهي الصلاحية أو غير صالح، يرجى إعادة تسجيل الدخول أو التجديد'
    });
  }

  req.user = payload;
  next();
};

export const requireRole = (allowedRoles: ('admin' | 'servant' | 'viewer')[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'غير مصرح: المستخدم غير موثق' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `غير مصرح: الحساب برتبة (${req.user.role}) لا يملك صلاحية تنفيذ هذا الإجراء`
      });
    }

    next();
  };
};

export const enforceServantOwnership = (studentServant?: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'المصادقة مطلوبة' });
    }

    // Admins have access to all students
    if (user.role === 'admin') {
      return next();
    }

    // Servants can only modify their assigned students
    if (user.role === 'servant') {
      const servantTarget = studentServant || (req.body && req.body.servant) || (req.body && req.body.assignedServantName);
      if (
        servantTarget &&
        user.assignedServantName &&
        servantTarget.trim() !== user.assignedServantName.trim()
      ) {
        return res.status(403).json({
          error: `غير مصرح: هذا المخدوم مسند للأشبين (${servantTarget})، بينما حسابك مسند للأشبين (${user.assignedServantName})`
        });
      }
    }

    next();
  };
};
