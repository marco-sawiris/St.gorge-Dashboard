import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';

export interface TokenPayload {
  userId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'servant' | 'viewer';
  assignedServantName?: string;
  sessionId?: string;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, ENV.JWT_SECRET, {
    expiresIn: '15m'
  });
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, ENV.JWT_REFRESH_SECRET, {
    expiresIn: '7d'
  });
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET) as TokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, ENV.JWT_REFRESH_SECRET) as TokenPayload;
    return decoded;
  } catch {
    return null;
  }
}
