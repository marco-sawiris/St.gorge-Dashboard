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

function resolveSafeSheetName(candidates: unknown[], fallback: string = ALL_SHEETS_SENTINEL): string {
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower === 'undefined' || lower === 'null' || lower === 'nan' || lower === '[object object]') continue;
    return trimmed;
  }
  return fallback;
}

function isExplicitlyInvalidSheetInput(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (raw === null) return true;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === ALL_SHEETS_SENTINEL) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'undefined' || lower === 'null' || lower === 'nan' || lower === '[object object]';
}

async function handleGetSheetStudents(req: AuthenticatedRequest, res: Response) {
  const targetSheet = resolveSafeSheetName([req.query.sheet, req.query.tab, req.query.sourceSheet], ALL_SHEETS_SENTINEL);

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
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const rawHeaderKey = req.headers['x-idempotency-key'] as string | undefined;
    let decodedHeaderKey: string | undefined = undefined;
    if (rawHeaderKey && typeof rawHeaderKey === 'string') {
      try {
        decodedHeaderKey = decodeURIComponent(rawHeaderKey.trim());
      } catch {
        decodedHeaderKey = rawHeaderKey.trim();
      }
    }
    const idempotencyKey = decodedHeaderKey || req.body?.idempotencyKey || req.body?.id;

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
    if (
      isExplicitlyInvalidSheetInput(sourceSheet) ||
      isExplicitlyInvalidSheetInput(req.body?.sheet) ||
      isExplicitlyInvalidSheetInput(req.body?.tab)
    ) {
      return res.status(400).json({ error: 'اسم التاب المرسل غير صالح أو غير محدد (undefined / __ALL__).' });
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
      const rawOutcome = String(payload.callOutcome || '').trim();
      const validOutcome =
        rawOutcome === 'تم التواصل' || rawOutcome === 'لم يتم التواصل' ? rawOutcome : undefined;

      updatedStudent = {
        ...currentStudent,
        fu: { ...(currentStudent.fu || {}), [friday]: method },
        ...(validOutcome
          ? {
              fuOutcomes: { ...(currentStudent.fuOutcomes || {}), [friday]: validOutcome },
              lastCallOutcome: validOutcome
            }
          : {}),
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
      const targetSheet = resolveSafeSheetName([candidate.sourceSheet, sourceSheet, req.body?.sheet, req.body?.tab], 'نشط');
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

// GET /api/sheets/idempotency?keys=k1,k2,...
// Used post-timeout (Unknown Result) to verify whether timed-out operations already persisted on server
router.get(
  '/idempotency',
  authenticateToken,
  apiLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    const startedAt = Date.now();
    const rawKeys = String(req.query.keys || req.query.key || '');
    const keys = rawKeys
      .split(',')
      .map((k) => {
        const trimmed = k.trim();
        try {
          return decodeURIComponent(trimmed);
        } catch {
          return trimmed;
        }
      })
      .filter((k) => k.length > 0)
      .slice(0, 100);

    const results: Record<string, { found: boolean; response?: any; status?: string }> = {};
    for (const key of keys) {
      const rec = await dbManager.getIdempotencyRecord(key);
      if (rec) {
        results[key] = {
          found: true,
          status: rec.status,
          response: rec.responseBody
        };
      } else {
        results[key] = { found: false };
      }
    }

    return res.json({
      ok: true,
      results,
      serverDurationMs: Date.now() - startedAt
    });
  }
);

// POST /api/sheets/mutate-batch
// Chunked batch endpoint: enforces RBAC + RLAC + OCC + Idempotency per item while committing to Google Sheets in one batch
router.post(
  '/mutate-batch',
  authenticateToken,
  requireRole(['admin', 'servant']),
  apiLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    const startedAt = Date.now();
    const user = req.user!;
    const ip = getClientIp(req);
    const mutations = Array.isArray(req.body?.mutations) ? req.body.mutations : null;

    if (!mutations) {
      return res.status(400).json({ ok: false, error: 'مصفوفة العمليات (mutations) مطلوبة' });
    }
    if (mutations.length > 50) {
      return res.status(400).json({ ok: false, error: 'حجم الدفعة يتجاوز الحد الأقصى المسموح (50 عملية)' });
    }

    // Strict Zero-Delete check across entire batch
    if (mutations.some((m: any) => String(m?.action || '').trim().toLowerCase() === 'delete')) {
      await dbManager.logAudit({
        timestamp: new Date(),
        userId: user.userId,
        username: user.username,
        action: 'MUTATE_BATCH_DELETE_BLOCKED',
        status: 'denied',
        ipAddress: ip,
        details: { batchSize: mutations.length }
      });
      return res.status(403).json({
        ok: false,
        error: 'عملية حذف المخدومين محظورة نهائياً في النظام لحماية سجلات الخدمة.'
      });
    }

    const results: any[] = new Array(mutations.length);
    const workingStudents = new Map<string, Student>();
    const blockedStudentIds = new Set<string>();
    const stagedIdempotencyRecords: Array<{
      index: number;
      key: string;
      action: string;
      studentId: string;
      responseBody: any;
    }> = [];
    const currentCairoMonth = getCairoDateParts().isoDate.slice(0, 7);

    for (let i = 0; i < mutations.length; i++) {
      const mut = mutations[i] || {};
      const itemKey = String(mut.idempotencyKey || mut.id || '').trim();
      if (!itemKey) {
        results[i] = { ok: false, status: 400, error: 'مفتاح عدم التكرار (idempotencyKey) مطلوب لكل عملية' };
        continue;
      }

      // 1. Server-side idempotency deduplication
      const existingRec = await dbManager.getIdempotencyRecord(itemKey);
      if (existingRec) {
        results[i] = {
          ok: true,
          status: 200,
          deduplicated: true,
          ...existingRec.responseBody
        };
        continue;
      }

      const action = String(mut.action || '').trim().toLowerCase();
      const studentId = String(mut.studentId || '').trim();
      const expectedVersion = mut.expectedVersion;
      const payload = mut.payload || mut;

      if (action !== 'attendance' || !studentId) {
        results[i] = {
          ok: false,
          status: 400,
          mutationId: itemKey,
          studentId,
          error: 'المعالجة المجمعة تقبل عمليات الحضور الصحيحة فقط'
        };
        continue;
      }

      const explicitMutSheet = mut.sourceSheet !== undefined ? mut.sourceSheet : (mut.sheet !== undefined ? mut.sheet : mut.tab);
      if (isExplicitlyInvalidSheetInput(explicitMutSheet)) {
        results[i] = {
          ok: false,
          status: 400,
          mutationId: itemKey,
          studentId,
          error: `اسم التاب غير صالح للمخدوم: ${String(explicitMutSheet)}`
        };
        continue;
      }

      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        results[i] = {
          ok: false,
          status: 400,
          mutationId: itemKey,
          studentId,
          error: 'expectedVersion إلزامي ويجب أن يكون رقم إصدار صحيحاً'
        };
        continue;
      }

      if (blockedStudentIds.has(studentId)) {
        results[i] = {
          ok: false,
          status: 409,
          mutationId: itemKey,
          studentId,
          error: 'توقف التحديث المتسلسل لهذا المخدوم لوجود تعارض إصدار سابق في الدفعة'
        };
        continue;
      }

      let currentStudent = workingStudents.get(studentId) || googleSheetsService.getStudentById(studentId);
      if (!currentStudent) {
        results[i] = {
          ok: false,
          status: 404,
          mutationId: itemKey,
          studentId,
          error: 'المخدوم غير موجود في قاعدة بيانات الخادم'
        };
        continue;
      }

      // RLAC Check
      if (user.role === 'servant') {
        const studentServant = currentStudent.servant?.trim();
        const userServant = user.assignedServantName?.trim();
        if (!studentServant || !userServant || studentServant !== userServant) {
          results[i] = {
            ok: false,
            status: 403,
            mutationId: itemKey,
            studentId,
            error: `غير مصرح: هذا المخدوم مسند للأشبين (${studentServant || 'غير محدد'}).`
          };
          continue;
        }
      }

      // Sequential OCC Version check
      if ((currentStudent.version || 1) !== expectedVersion) {
        blockedStudentIds.add(studentId);
        results[i] = {
          ok: false,
          status: 409,
          mutationId: itemKey,
          studentId,
          error: `تعارض في التعديل المتزامن (HTTP 409): إصدار الخادم (${currentStudent.version}) لا يطابق الإصدار المرسل (${expectedVersion}).`,
          latestServerRecord: currentStudent
        };
        continue;
      }

      const friday = String(payload.friday || payload.date || mut.date || mut.friday || '').trim();
      const rawAttendance = String(payload.isPresent ?? payload.present ?? mut.isPresent ?? mut.present ?? '').trim().toLowerCase();
      const isPresent =
        payload.isPresent === true ||
        payload.present === true ||
        mut.isPresent === true ||
        mut.present === true ||
        ['1', 'true', 'present', 'حاضر'].includes(rawAttendance);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(friday)) {
        results[i] = {
          ok: false,
          status: 400,
          mutationId: itemKey,
          studentId,
          error: 'تاريخ الجمعة (friday) مطلوب بصيغة YYYY-MM-DD'
        };
        continue;
      }

      const previousAttendance = currentStudent.att?.[friday];
      const prevVal = previousAttendance === true;
      const delta = isPresent ? (prevVal ? 0 : 1) : prevVal ? -1 : 0;
      const nextAttendance = { ...(currentStudent.att || {}), [friday]: isPresent };
      const monthlyAttendanceCount = Object.entries(nextAttendance).reduce(
        (count, [d, present]) => (d.slice(0, 7) === currentCairoMonth && present === true ? count + 1 : count),
        0
      );
      const latestPresentFriday = Object.entries(nextAttendance)
        .filter(([, present]) => present === true)
        .map(([d]) => d)
        .sort()
        .pop();

      const nextVersion = (currentStudent.version || 1) + 1;
      const updatedStudent: Student = {
        ...currentStudent,
        att: nextAttendance,
        attendanceTotal: Math.max(0, (currentStudent.attendanceTotal || 0) + delta),
        attendanceMonth: monthlyAttendanceCount,
        attendanceStatus: isPresent ? 'حاضر' : 'غائب',
        lastAttendance: latestPresentFriday,
        version: nextVersion
      };

      workingStudents.set(studentId, updatedStudent);

      const responseBody = {
        ok: true,
        status: 200,
        mutationId: itemKey,
        studentId,
        newVersion: nextVersion,
        action: 'attendance'
      };
      results[i] = responseBody;
      stagedIdempotencyRecords.push({
        index: i,
        key: itemKey,
        action: 'attendance',
        studentId,
        responseBody
      });
    }

    // Persist net final modified student records in ONE Google Sheets batch call BEFORE recording idempotency!
    if (workingStudents.size > 0) {
      try {
        await googleSheetsService.upsertStudentsBatch(Array.from(workingStudents.values()));
      } catch (err: any) {
        return res.status(502).json({
          ok: false,
          error: err?.message || 'تعذر حفظ الدفعة في Google Sheets',
          serverDurationMs: Date.now() - startedAt
        });
      }
    }

    // Record durable idempotency ONLY after sheet write confirmed
    for (const rec of stagedIdempotencyRecords) {
      await dbManager.saveIdempotencyRecord({
        key: rec.key,
        action: rec.action,
        studentId: rec.studentId,
        status: 'completed',
        responseBody: rec.responseBody,
        createdAt: new Date()
      });
    }

    if (stagedIdempotencyRecords.length > 0) {
      await dbManager.logAudit({
        timestamp: new Date(),
        userId: user.userId,
        username: user.username,
        action: 'MUTATE_BATCH_ATTENDANCE',
        status: 'success',
        ipAddress: ip,
        details: {
          confirmedCount: stagedIdempotencyRecords.length,
          studentsTouched: workingStudents.size
        }
      });
    }

    return res.json({
      ok: true,
      action: 'batch',
      results,
      serverDurationMs: Date.now() - startedAt
    });
  }
);

export default router;
