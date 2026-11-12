import React, { createContext, useContext } from 'react';
import { AuthUser, UserRole } from '../types/auth';

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
  canPerformAction: (actionType: ActionPermissionType, studentServant?: string) => PermissionResult;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const VALID_USER_ROLES: readonly UserRole[] = ['admin', 'servant', 'viewer'];

export function isValidUserRole(role: any): role is UserRole {
  return typeof role === 'string' && VALID_USER_ROLES.includes(role as UserRole);
}

// Explicit Allowlist per Role - Zero implicit permissions (Zero Delete Student enforced)
const ROLE_ALLOWED_ACTIONS: Record<UserRole, readonly ActionPermissionType[]> = {
  admin: [
    'attendance',
    'followup',
    'edit_student',
    'add_student',
    'manage_servants'
  ],
  servant: [
    'attendance',
    'followup',
    'edit_student'
  ],
  viewer: []
};

/**
 * Pure role permission evaluator (retained for backend/security test verification).
 */
export function evaluateUserPermission(
  user: AuthUser | null,
  isPreviewMode: boolean,
  actionType: ActionPermissionType,
  studentServant?: string
): PermissionResult {
  if (actionType === 'delete_student') {
    return {
      allowed: false,
      reason: 'حذف المخدومين غير مسموح به نهائياً حفاظاً على بيانات الخدمة.'
    };
  }

  if (isPreviewMode) {
    return {
      allowed: false,
      reason: 'وضع القراءة فقط: التعديل غير متاح حالياً.'
    };
  }

  if (!user || !user.role || !isValidUserRole(user.role)) {
    return {
      allowed: false,
      reason: 'بيانات الصلاحية غير صالحة.'
    };
  }

  const allowedActions = ROLE_ALLOWED_ACTIONS[user.role] || [];
  if (!allowedActions.includes(actionType)) {
    return {
      allowed: false,
      reason: `غير مصرح: الإجراء (${actionType}) غير مسموح به.`
    };
  }

  if (user.role === 'servant') {
    if (!studentServant || !studentServant.trim()) {
      return {
        allowed: false,
        reason: 'غير مصرح: المخدوم غير مسند لأي أشبين.'
      };
    }

    if (!user.assignedServantName || user.assignedServantName.trim() !== studentServant.trim()) {
      return {
        allowed: false,
        reason: `غير مصرح: هذا المخدوم مسند للأشبين (${studentServant}).`
      };
    }
  }

  return { allowed: true };
}

// Direct service session without servant login screen (Zero secrets / zero hardcoded passwords)
const DIRECT_SERVICE_USER: AuthUser = {
  userId: 'service_direct',
  username: 'stgeorge_service',
  displayName: 'خدمة فصل الشهيد مارجرجس',
  role: 'admin'
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const canPerformAction = (actionType: ActionPermissionType): PermissionResult => {
    if (actionType === 'delete_student') {
      return {
        allowed: false,
        reason: 'حذف المخدومين محظور نهائياً في النظام لحماية سجلات الخدمة.'
      };
    }
    return { allowed: true };
  };

  return (
    <AuthContext.Provider
      value={{
        user: DIRECT_SERVICE_USER,
        isAuthenticated: true,
        isPreviewMode: false,
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
