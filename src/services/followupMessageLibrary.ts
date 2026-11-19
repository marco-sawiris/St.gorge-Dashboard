import type { Student } from '../types/student';
import type { FollowupRecord } from '../types/followup';
import {
  FOLLOWUP_MESSAGE_TEMPLATES,
  FollowupMessageAudience,
  FollowupMessageTemplate,
  renderFollowupMessageTemplate,
  resolveFollowupClassName,
  stripEmojis
} from '../data/followupMessageTemplates';
import { normalizeArabicText, getCairoDateParts, getMonthFridays } from '../utils/arabicUtils';

/**
 * Unified Follow-up Message Library
 * Delegates strictly to the single source of truth in src/data/followupMessageTemplates.ts.
 * Zero duplicate templates, zero emojis, zero invented reasons or fabricated student data.
 */

export type FollowupMessageCategory = 'parent' | 'student' | 'general';

export interface FollowupTemplateEntry {
  id: string;
  index: number;
  title: string;
  category: FollowupMessageCategory;
  audience: FollowupMessageAudience;
  isShort: boolean;
  template: string;
}

export const BASE_FOLLOWUP_MESSAGE_TEMPLATES: readonly FollowupTemplateEntry[] =
  FOLLOWUP_MESSAGE_TEMPLATES.map((tpl: FollowupMessageTemplate) => ({
    id: tpl.id,
    index: tpl.index,
    title: tpl.title,
    category: tpl.audience,
    audience: tpl.audience,
    isShort: tpl.isShort,
    template: tpl.template
  }));

export interface FollowupSelectionContext {
  student?: Student;
  parentName?: string;
  className?: string;
  meetingSchedule?: string;
  audience?: FollowupMessageAudience;
  preferShort?: boolean;
  excludeTemplateIds?: string[];
  followupRecords?: FollowupRecord[];
  referenceDate?: Date;
}

export interface GeneratedFollowupMessage {
  templateId: string;
  templateIndex: number;
  title: string;
  audience: FollowupMessageAudience;
  isShort: boolean;
  message: string;
}

export function getTemplatesByFilter(options?: {
  audience?: FollowupMessageAudience;
  preferShort?: boolean;
}): FollowupMessageTemplate[] {
  let pool = [...FOLLOWUP_MESSAGE_TEMPLATES];
  if (options?.audience) {
    const exactAudience = pool.filter((t) => t.audience === options.audience);
    if (exactAudience.length > 0) pool = exactAudience;
  }
  if (options?.preferShort) {
    const shortOnes = pool.filter((t) => t.isShort);
    if (shortOnes.length > 0) pool = shortOnes;
  }
  return pool;
}

export function selectFollowupMessage(
  ctx: FollowupSelectionContext = {}
): GeneratedFollowupMessage {
  const excluded = new Set(ctx.excludeTemplateIds || []);
  let pool = getTemplatesByFilter({
    audience: ctx.audience,
    preferShort: ctx.preferShort
  });

  const nonExcluded = pool.filter((t) => !excluded.has(t.id));
  if (nonExcluded.length > 0) {
    pool = nonExcluded;
  } else if (ctx.audience) {
    const fallbackAll = FOLLOWUP_MESSAGE_TEMPLATES.filter((t) => !excluded.has(t.id));
    if (fallbackAll.length > 0) pool = fallbackAll;
  }

  const chosen = pool[0] || FOLLOWUP_MESSAGE_TEMPLATES[0];
  const rendered = renderFollowupMessageTemplate(chosen, {
    studentName: ctx.student?.name,
    parentName: ctx.parentName,
    className: ctx.className || resolveFollowupClassName(ctx.student?.sourceSheet),
    meetingSchedule: ctx.meetingSchedule
  });

  return {
    templateId: chosen.id,
    templateIndex: chosen.index,
    title: chosen.title,
    audience: chosen.audience,
    isShort: chosen.isShort,
    message: stripEmojis(rendered)
  };
}

export function selectMultipleFollowupMessages(
  count: number,
  ctx: FollowupSelectionContext = {}
): GeneratedFollowupMessage[] {
  const safeCount = Math.max(1, Math.min(count, FOLLOWUP_MESSAGE_TEMPLATES.length));
  const usedIds = new Set<string>(ctx.excludeTemplateIds || []);
  const results: GeneratedFollowupMessage[] = [];

  for (let i = 0; i < safeCount; i++) {
    const next = selectFollowupMessage({
      ...ctx,
      excludeTemplateIds: Array.from(usedIds)
    });
    if (results.some((r) => r.templateId === next.templateId)) {
      break;
    }
    usedIds.add(next.templateId);
    results.push(next);
  }
  return results;
}

export function inferStudentAbsenceCountForMonth(
  student: Student,
  referenceDate: Date = new Date()
): number {
  const cairo = getCairoDateParts(referenceDate);
  const fridays = getMonthFridays(cairo.year, cairo.month).filter((f) => f <= cairo.isoDate);
  let missed = 0;
  for (const f of fridays) {
    if (student.att && student.att[f] === false) missed++;
  }
  return missed;
}

export function hasPriorFollowupRecords(
  student: Student,
  followupRecords: FollowupRecord[] = []
): boolean {
  const normName = normalizeArabicText(student.name);
  return followupRecords.some(
    (r) =>
      r.studentId === student.id ||
      (Boolean(student.code) && r.studentCode === student.code) ||
      (Boolean(normName) && normalizeArabicText(r.studentName) === normName)
  );
}
