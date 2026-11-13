import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRole } from '../middleware/auth';
import { dbManager } from '../db';
import { apiLimiter } from '../middleware/rateLimit';
import { googleSheetsService } from '../services/googleSheetsService';
import { Student, APPROVED_SHEETS, ALL_SHEETS_SENTINEL } from '../../src/types/student';
import { getCairoDateParts } from '../../src/utils/arabicUtils';

const router = Router();

function getClientIp(req: AuthenticatedRequest): string {
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  return (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || '127.0.0.1').trim();
}

const UPDATABLE_STUDENT_FIELDS: (keyof Student)[] = [
  'name',
  'code',
  'servant',
  'sourceSheet',
  'area',
  'address',
  'phoneStudent',
  'phoneParent1',
  'phoneParent2',
  'birthDate',
  'notes',
  'followupStatus',
  'lastAttendance',
  'lastFollowup'
];

async function handleGetSheetStudents(req: AuthenticatedRequest, res: Response) {
  const targetSheet = (req.query.sheet as string) || ALL_SHEETS_SENTINEL;

  if (targetSheet !== ALL_SHEETS_SENTINEL && !APPROVED_SHEETS.includes(targetSheet as any)) {
    return res.status(400).json({
      error: `اسم الفصل غير صالح: (${targetSheet}). الفصول المعتمدة هي: ${APPROVED_SHEETS.join(', ')}`
    });
  }

  try {
    const students = await googleSheetsService.getStudents(targetSheet);

    return res.json({
      ok: true,
      sheet: targetSheet,
      targetSheet,
      isComplete: true,
      confirmedComplete: true,
      isConfirmedComplete: true,
      confirmedSheets: targetSheet === ALL_SHEETS_SENTINEL ? [...APPROVED_SHEETS] : [targetSheet],
      students
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'فشل جلب بيانات الفصل من الخادم'
    });
  }
}

// Primary endpoint used by AppContext.tsx (GET /api/sheets/data) and REST alias (GET /api/sheets/students)
router.get('/data', authenticateToken, apiLimiter, handleGetSheetStudents);
router.get('/students', authenticateToken, apiLimiter, handleGetSheetStudents);

// POST /api/sheets/mutate (Idempotent, RBAC + RLAC Enforced, OCC Version-Protected, Audit-Logged)
router.post(
  '/mutate',
  authenticateToken,
  requireRole(['admin', 'servant']),
  apiLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const ip = getClientIp(req);
    const idempotencyKey = (req.headers['x-idempotency-key'] as string) || req.body?.id;

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'ترويسة مفتاح عدم التكرار (X-Idempotency-Key) إلزامية' });
    }

    // 1. Server-side Idempotency Deduplication Check
    const existingRecord = await dbManager.getIdempotencyRecord(idempotencyKey);
    if (existingRecord) {
      return res.json({
        ok: true,
        deduplicated: true,
        message: 'العملية تم تنفيذها وتأكيدها مسبقاً (Idempotent response)',
        ...existingRecord.responseBody
      });
    }

    const { action, studentId, sourceSheet, payload, expectedVersion } = req.body || {};

    if (!action || !studentId) {
      return res.status(400).json({ error: 'بيانات العملية غير مكتملة (action و studentId مطلوبان)' });
    }
    if (action !== 'add' && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
      return res.status(400).json({ error: 'expectedVersion إلزامي ويجب أن يكون رقم إصدار صحيحاً لكل تعديل على سجل موجود.' });
    }

    // 2. Zero Delete Student Policy Enforcement
    if (action === 'delete') {
      await dbManager.logAudit({
        timestamp: new Date(),
        userId: user.userId,
        username: user.username,
        action: 'MUTATE_DELETE_BLOCKED',
        status: 'denied',
        ipAddress: ip,
        details: { studentId }
      });
      return res.status(403).json({
        error: 'عملية حذف المخدومين محظورة نهائياً في النظام لحماية سجلات الخدمة.'
      });
    }

    // 3. Role-based add check (Admin only)
    if (action === 'add' && user.role !== 'admin') {
      await dbManager.logAudit({
        timestamp: new Date(),
        userId: user.userId,
        username: user.username,
        action: 'MUTATE_ADD_DENIED',
        status: 'denied',
        ipAddress: ip,
        details: { studentId, role: user.role }
      });
      return res.status(403).json({
        error: 'غير مصرح: إضافة مخدومين جدد مقتصرة على أمين الخدمة (Admin) فقط.'
      });
    }

    const currentStudent = googleSheetsService.getStudentById(studentId);

    if (action !== 'add' && !currentStudent) {
      return res.status(404).json({ error: 'المخدوم غير موجود في قاعدة بيانات الخادم' });
    }

    // 4. Servant Granular Row-Level Access Control (RLAC)
    if (user.role === 'servant' && currentStudent) {
      const studentServant = currentStudent.servant?.trim();
      const userServant = user.assignedServantName?.trim();

      if (!studentServant || !userServant || studentServant !== userServant) {
        await dbManager.logAudit({
          timestamp: new Date(),
          userId: user.userId,
          username: user.username,
          action: `MUTATE_${String(action).toUpperCase()}`,
          status: 'denied',
          ipAddress: ip,
          details: { studentId, studentServant, assigned: userServant }
        });

        return res.status(403).json({
          error: `غير مصرح: هذا المخدوم مسند للأشبين (${studentServant || 'غير محدد'})، بينما حسابك مسند للأشبين (${userServant || 'غير محدد'}).`
        });
      }
    }

    // 5. Optimistic Concurrency Control (OCC) Version Conflict Check
    if (currentStudent && action !== 'add') {
      if (currentStudent.version !== expectedVersion) {
        await dbManager.logAudit({
          timestamp: new Date(),
          userId: user.userId,
          username: user.username,
          action: `MUTATE_${String(action).toUpperCase()}`,
          status: 'conflict',
          ipAddress: ip,
          details: { studentId, expectedVersion, currentVersion: currentStudent.version }
        });

        return res.status(409).json({
          error: `تعارض في التعديل المتزامن (HTTP 409): إصدار الخادم (${currentStudent.version}) لا يطابق الإصدار المرسل (${expectedVersion}).`,
          latestServerRecord: currentStudent
        });
      }
    }

    // 6. Apply Validated Mutation
    let updatedStudent: Student;

    if (action === 'attendance' && currentStudent && payload) {
      const friday = String(payload.friday || payload.date || '');
      const rawAttendance = String(payload.isPresent ?? payload.status ?? '').trim().toLowerCase();
      const isPresent = payload.isPresent === true || ['1', 'true', 'present', 'حاضر'].includes(rawAttendance);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(friday)) {
        return res.status(400).json({ error: 'تاريخ الجمعة (friday) مطلوب بصيغة YYYY-MM-DD' });
      }

      const previousAttendance = currentStudent.att?.[friday];
      const prevVal = previousAttendance === true;
      const delta = isPresent ? (prevVal ? 0 : 1) : (prevVal ? -1 : 0);
      const nextAttendance = { ...(currentStudent.att || {}), [friday]: isPresent };
      const currentCairoMonth = getCairoDateParts().isoDate.slice(0, 7);
      const monthlyAttendanceCount = Object.entries(nextAttendance).reduce((count, [date, present]) =>
        date.slice(0, 7) === currentCairoMonth && present === true ? count + 1 : count, 0);
      const latestPresentFriday = Object.entries(nextAttendance)
        .filter(([, present]) => present === true)
        .map(([date]) => date)
        .sort()
        .pop();

      updatedStudent = {
        ...currentStudent,
        att: nextAttendance,
        attendanceTotal: Math.max(0, (currentStudent.attendanceTotal || 0) + delta),
        attendanceMonth: monthlyAttendanceCount,
        attendanceStatus: isPresent ? 'حاضر' : 'غائب',
        lastAttendance: latestPresentFriday
      };
    } else if (action === 'followup' && currentStudent && payload) {
      const friday = String(payload.friday || payload.date || '');
      const method = String(payload.method || 'تم تليفونياً');
      if (!friday) {
        return res.status(400).json({ error: 'تاريخ الافتقاد (friday) مطلوب' });
      }

      updatedStudent = {
        ...currentStudent,
        fu: { ...(currentStudent.fu || {}), [friday]: method },
        followupStatus: method,
        lastFollowup: friday
      };
    } else if (action === 'update' && currentStudent && payload) {
      const sourcePayload = payload.updatedData && typeof payload.updatedData === 'object' ? payload.updatedData : payload;
      updatedStudent = { ...currentStudent };
      for (const field of UPDATABLE_STUDENT_FIELDS) {
        if (sourcePayload[field] !== undefined) {
          (updatedStudent as any)[field] = sourcePayload[field];
        }
      }
    } else if (action === 'add') {
      const candidate = payload?.newStudent && typeof payload.newStudent === 'object' ? payload.newStudent : payload || {};
      const targetSheet = candidate.sourceSheet || sourceSheet || 'نشط';
      if (!APPROVED_SHEETS.includes(targetSheet as any)) {
        return res.status(400).json({ error: `فصل غير معتمد: ${targetSheet}` });
      }
      const studentName = String(candidate.name || req.body.studentName || '').trim();
      if (!studentName) {
        return res.status(400).json({ error: 'اسم المخدوم مطلوب عند الإضافة' });
      }

      const candidateCode = String(candidate.code || req.body.studentCode || '').trim();
      const sameSheetStudents = await googleSheetsService.getStudents(targetSheet);
      const normalizedName = studentName.replace(/\s+/g, ' ').toLowerCase();
      const duplicateStudent = sameSheetStudents.find((student) =>
        (candidateCode && String(student.code || '').trim() === candidateCode) ||
        String(student.name || '').replace(/\s+/g, ' ').trim().toLowerCase() === normalizedName
      );
      if (duplicateStudent) {
        return res.status(409).json({
          error: `المخدوم موجود بالفعل في فصل "${targetSheet}" (${duplicateStudent.name} / ${duplicateStudent.code}).`,
          duplicateStudentId: duplicateStudent.id
        });
      }

      updatedStudent = {
        id: studentId,
        code: String(candidate.code || req.body.studentCode || 'SG-NEW'),
        name: studentName,
        servant: String(candidate.servant || user.assignedServantName || 'غير محدد'),
        phoneStudent: String(candidate.phoneStudent || ''),
        phoneParent1: String(candidate.phoneParent1 || ''),
        phoneParent2: String(candidate.phoneParent2 || ''),
        birthDate: String(candidate.birthDate || ''),
        area: String(candidate.area || 'الزيتون'),
        address: String(candidate.address || ''),
        notes: String(candidate.notes || ''),
        followupStatus: 'بدون',
        attendanceTotal: 0,
        attendanceMonth: 0,
        attendanceStatus: 'غائب',
        sourceSheet: targetSheet,
        version: 1,
        att: {},
        fu: {}
      };
    } else {
      return res.status(400).json({ error: `نوع العملية غير مدعوم أو البيانات ناقصة: ${action}` });
    }

    const saved = await googleSheetsService.upsertStudent(updatedStudent);

    const responseBody = {
      mutationId: idempotencyKey,
      studentId: saved.id,
      newVersion: saved.version,
      action
    };

    // 7. Store Idempotency Record
    await dbManager.saveIdempotencyRecord({
      key: idempotencyKey,
      action,
      studentId: saved.id,
      status: 'completed',
      responseBody,
      createdAt: new Date()
    });

    // 8. Security Audit Log
    await dbManager.logAudit({
      timestamp: new Date(),
      userId: user.userId,
      username: user.username,
      action: `MUTATE_${String(action).toUpperCase()}`,
      status: 'success',
      ipAddress: ip,
      details: { studentId: saved.id, newVersion: saved.version, sheet: saved.sourceSheet }
    });

    return res.json({
      ok: true,
      ...responseBody,
      student: saved
    });
  }
);

export default router;
