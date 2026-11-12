import React, { createContext, useContext, useState, useEffect } from 'react';
import { AuthUser, UserRole } from '../types/auth';
import { buildApiUrl, getAuthHeaders } from '../services/apiConfig';

export type ActionPermissionType =
  | 'attendance'
  | 'followup'
  | 'edit_student'
  | 'add_student'
  | 'delete_student'
  | 'manage_servants';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isPreviewMode: boolean;
  loginError: string | null;
  login: (username: string, password?: string) => Promise<boolean>;
  enterPreviewMode: () => void;
  logout: () => void;
  canPerformAction: (actionType: ActionPermissionType, studentServant?: string) => PermissionResult;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const VALID_USER_ROLES: readonly UserRole[] = ['admin', 'servant', 'viewer'];

export function isValidUserRole(role: any): role is UserRole {
  return typeof role === 'string' && VALID_USER_ROLES.includes(role as UserRole);
}

// Explicit Allowlist per Role - Zero implicit permissions
const ROLE_ALLOWED_ACTIONS: Record<UserRole, readonly ActionPermissionType[]> = {
  admin: [
    'attendance',
    'followup',
    'edit_student',
    'add_student',
    'delete_student',
    'manage_servants'
  ],
  servant: [
    'attendance',
    'followup',
    'edit_student'
  ],
  viewer: [] // Viewers have 0 write permissions
};

// Safe localStorage access utility to prevent unhandled storage exceptions
const safeStorage = {
  getItem: (key: string): string | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // Ignore private browsing / quota errors
    }
  },
  removeItem: (key: string): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
      // Ignore errors
    }
  }
};

/**
 * Pure authorization evaluation engine.
 * NOTE: Frontend RBAC is an immediate UI defense layer; the Backend MUST re-verify
 * all JWT claims, roles, and servant assignments on every API request.
 */
export function evaluateUserPermission(
  user: AuthUser | null,
  isPreviewMode: boolean,
  actionType: ActionPermissionType,
  studentServant?: string
): PermissionResult {
  // 1. Preview Mode is strictly and unconditionally read-only, even if a user object exists
  if (isPreviewMode) {
    return {
      allowed: false,
      reason: 'وضع المعاينة (Preview Mode) مخصص للقراءة والاستعراض فقط. جميع عمليات التعديل والحفظ محظورة تماماً.'
    };
  }

  // 2. Unauthenticated check: User and valid token must both exist
  if (!user || !user.token || !user.role || !isValidUserRole(user.role)) {
    return {
      allowed: false,
      reason: 'غير مصرح: يلزم تسجيل الدخول ببيانات اعتماد موثقة ورتبة صالحة (JWT) لتنفيذ هذا الإجراء.'
    };
  }

  // 3. Explicit Role Allowlist check (Zero implicit privileges)
  const allowedActions = ROLE_ALLOWED_ACTIONS[user.role] || [];
  if (!allowedActions.includes(actionType)) {
    return {
      allowed: false,
      reason: `غير مصرح: الإجراء (${actionType}) غير مسموح به لحساب برتبة (${user.role}).`
    };
  }

  // 4. Servant Granular Row-Level Access Control (RLAC)
  if (user.role === 'servant') {
    if (!studentServant || !studentServant.trim()) {
      return {
        allowed: false,
        reason: 'غير مصرح: لا يمكن تعديل مخدوم غير مسند لأي أشبين بحساب خادم. يلزم تدخل أمين الخدمة.'
      };
    }

    if (!user.assignedServantName || user.assignedServantName.trim() !== studentServant.trim()) {
      return {
        allowed: false,
        reason: `غير مصرح: هذا المخدوم مسند للأشبين (${studentServant})، بينما حسابك مسند للأشبين (${user.assignedServantName || 'غير محدد'}).`
      };
    }
  }

  return { allowed: true };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Security baseline: User starts strictly null and in Preview Mode
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isPreviewMode, setIsPreviewMode] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Secure Session Restoration:
  // Verifies token with Backend (/api/auth/verify).
  // If backend is temporarily offline or returns 5xx, cached session in localStorage is preserved (zero session loss).
  // Only explicit 401/403 responses will revoke the session and return to Preview Mode.
  useEffect(() => {
    async function restoreAndVerifySession() {
      const savedToken = safeStorage.getItem('stgorge_jwt_token');
      if (!savedToken || savedToken.length < 20) {
        enterPreviewMode();
        return;
      }

      try {
        const verifyUrl = buildApiUrl('/api/auth/verify');
        const response = await fetch(verifyUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${savedToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.ok) {
          const data = await response.json();
          // Strictly validate that backend returned an approved role
          if (data && data.valid && data.user && isValidUserRole(data.user.role)) {
            const verifiedUser: AuthUser = {
              userId: data.user.userId,
              username: data.user.username,
              displayName: data.user.displayName || data.user.username,
              role: data.user.role,
              assignedServantName: data.user.assignedServantName,
              token: savedToken
            };
            setUser(verifiedUser);
            setIsPreviewMode(false);
            return;
          } else {
            console.warn('Backend rejected session verification or returned invalid role:', data?.user?.role);
          }
        } else if (response.status === 401 || response.status === 403) {
          // Token is explicitly expired or revoked by auth server: clear session
          enterPreviewMode();
          return;
        }

        // Temporary server error (500, 502, 503): DO NOT wipe session!
        // Fallback to cached user object if available
        const savedUserStr = safeStorage.getItem('stgorge_auth_user');
        if (savedUserStr) {
          try {
            const cachedUser = JSON.parse(savedUserStr);
            if (cachedUser && isValidUserRole(cachedUser.role)) {
              setUser({ ...cachedUser, token: savedToken });
              setIsPreviewMode(false);
              return;
            }
          } catch {}
        }
        enterPreviewMode();
      } catch {
        // Backend offline or unreachable (network failure): DO NOT wipe session!
        const savedUserStr = safeStorage.getItem('stgorge_auth_user');
        if (savedUserStr) {
          try {
            const cachedUser = JSON.parse(savedUserStr);
            if (cachedUser && isValidUserRole(cachedUser.role)) {
              setUser({ ...cachedUser, token: savedToken });
              setIsPreviewMode(false);
              return;
            }
          } catch {}
        }
        enterPreviewMode();
      }
    }

    restoreAndVerifySession();
  }, []);

  const login = async (username: string, password?: string): Promise<boolean> => {
    if (!username || !username.trim()) {
      setLoginError('يرجى إدخال اسم المستخدم');
      return false;
    }

    try {
      const loginUrl = buildApiUrl('/api/auth/login');
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ username: username.trim(), password })
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.token && data.user) {
          // Strictly validate approved user role
          if (!isValidUserRole(data.user.role)) {
            setLoginError('الدور المخصص للحساب غير صالح أو غير معتمد من النظام.');
            return false;
          }

          const authUser: AuthUser = {
            userId: data.user.userId,
            username: data.user.username,
            displayName: data.user.displayName || data.user.username,
            role: data.user.role,
            assignedServantName: data.user.assignedServantName,
            token: data.token
          };
          setUser(authUser);
          setIsPreviewMode(false);
          setLoginError(null);
          safeStorage.setItem('stgorge_jwt_token', data.token);
          safeStorage.setItem('stgorge_auth_user', JSON.stringify(authUser));
          return true;
        }
      }

      const errData = await response.json().catch(() => null);
      setLoginError(errData?.error || 'بيانات الدخول غير صحيحة أو تم رفض الاتصال من الخادم.');
      return false;
    } catch {
      // Backend offline or unreachable
      setLoginError(
        'خادم المصادقة الآمن غير متصل حالياً (المرحلة الخامسة). يعمل التطبيق في وضع المعاينة (Preview Mode) للقراءة فقط لحماية البيانات.'
      );
      setUser(null);
      setIsPreviewMode(true);
      return false;
    }
  };

  const enterPreviewMode = () => {
    setUser(null);
    setIsPreviewMode(true);
    setLoginError(null);
    safeStorage.removeItem('stgorge_jwt_token');
    safeStorage.removeItem('stgorge_auth_user');
  };

  const logout = () => {
    setUser(null);
    setIsPreviewMode(true);
    setLoginError(null);
    safeStorage.removeItem('stgorge_jwt_token');
    safeStorage.removeItem('stgorge_auth_user');
  };

  const canPerformAction = (
    actionType: ActionPermissionType,
    studentServant?: string
  ): PermissionResult => {
    return evaluateUserPermission(user, isPreviewMode, actionType, studentServant);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user && !isPreviewMode,
        isPreviewMode,
        loginError,
        login,
        enterPreviewMode,
        logout,
        canPerformAction
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
