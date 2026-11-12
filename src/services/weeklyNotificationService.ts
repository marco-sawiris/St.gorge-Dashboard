import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativeCapacitorRuntime } from './apiConfig';
import { CAIRO_TIMEZONE, getCairoDateParts } from '../utils/arabicUtils';

export interface WeeklyReminderRule {
  id: number;
  key: string;
  dayLabel: string;
  timeLabel: string;
  weekdayCairo: number; // 0=Sun..6=Sat (3=Wed, 4=Thu, 5=Fri)
  hour: number; // 0..23 Africa/Cairo local hour
  minute: number; // 0..59
  title: string;
  body: string;
}

export interface WeeklyNotificationSettings {
  masterEnabled: boolean;
  enabledRules: Record<string, boolean>;
  updatedAt?: string;
}

export type NotificationPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface SyncNotificationsResult {
  scheduledCount: number;
  permission: NotificationPermissionState;
  nextTriggers: Array<{ ruleKey: string; triggerIso: string; preview: string }>;
  reason?: string;
}

export const WEEKLY_NOTIFICATION_SETTINGS_KEY = 'stgorge_weekly_notification_settings';
export const WEEKLY_NOTIFICATION_CHANNEL_ID = 'st_george_weekly_reminders';

export const DEFAULT_WEEKLY_REMINDERS: WeeklyReminderRule[] = [
  {
    id: 1001,
    key: 'wed_prep',
    dayLabel: 'الأربعاء',
    timeLabel: '6:00 م',
    weekdayCairo: 3,
    hour: 18,
    minute: 0,
    title: 'تذكير التحضير',
    body: 'بنفكّرك تبعت التحضير للخادم المسؤول.'
  },
  {
    id: 1002,
    key: 'thu_followup',
    dayLabel: 'الخميس',
    timeLabel: '6:00 م',
    weekdayCairo: 4,
    hour: 18,
    minute: 0,
    title: 'تذكير تقرير الافتقاد',
    body: 'آخر فرصة لإرسال تقرير الافتقاد والتحضير للخادم المسؤول.'
  },
  {
    id: 1003,
    key: 'fri_ready',
    dayLabel: 'الجمعة',
    timeLabel: '12:20 م',
    weekdayCairo: 5,
    hour: 12,
    minute: 20,
    title: 'قرب ميعاد الخدمة',
    body: 'استعد، ميعاد الخدمة قرب!'
  },
  {
    id: 1004,
    key: 'fri_start',
    dayLabel: 'الجمعة',
    timeLabel: '1:00 م',
    weekdayCairo: 5,
    hour: 13,
    minute: 0,
    title: 'بداية الخدمة',
    body: 'الخدمة بدأت الآن. ربنا يبارك خدمتكم.'
  },
  {
    id: 1005,
    key: 'fri_att',
    dayLabel: 'الجمعة',
    timeLabel: '2:30 م',
    weekdayCairo: 5,
    hour: 14,
    minute: 30,
    title: 'تسجيل الحضور والغياب',
    body: 'متنساش تسجّل الحضور والغياب للمخدومين.'
  }
];

export const WEEKLY_NOTIFICATION_IDS = DEFAULT_WEEKLY_REMINDERS.map((r) => r.id);

export function getDefaultNotificationSettings(): WeeklyNotificationSettings {
  const enabledRules: Record<string, boolean> = {};
  for (const r of DEFAULT_WEEKLY_REMINDERS) {
    enabledRules[r.key] = true;
  }
  return {
    masterEnabled: true,
    enabledRules
  };
}

export function loadWeeklyNotificationSettings(): WeeklyNotificationSettings {
  const defaults = getDefaultNotificationSettings();
  try {
    if (typeof localStorage === 'undefined') return defaults;
    const raw = localStorage.getItem(WEEKLY_NOTIFICATION_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    const mergedRules: Record<string, boolean> = { ...defaults.enabledRules };
    if (parsed && typeof parsed.enabledRules === 'object') {
      for (const r of DEFAULT_WEEKLY_REMINDERS) {
        if (typeof parsed.enabledRules[r.key] === 'boolean') {
          mergedRules[r.key] = parsed.enabledRules[r.key];
        }
      }
    }
    return {
      masterEnabled: typeof parsed?.masterEnabled === 'boolean' ? parsed.masterEnabled : true,
      enabledRules: mergedRules,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined
    };
  } catch {
    return defaults;
  }
}

export function saveWeeklyNotificationSettings(settings: WeeklyNotificationSettings): WeeklyNotificationSettings {
  const normalized: WeeklyNotificationSettings = {
    masterEnabled: Boolean(settings.masterEnabled),
    enabledRules: {
      ...getDefaultNotificationSettings().enabledRules,
      ...(settings.enabledRules || {})
    },
    updatedAt: new Date().toISOString()
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(WEEKLY_NOTIFICATION_SETTINGS_KEY, JSON.stringify(normalized));
    }
  } catch {}
  return normalized;
}

export function resetDefaultNotificationSettings(): WeeklyNotificationSettings {
  return saveWeeklyNotificationSettings(getDefaultNotificationSettings());
}

/**
 * Converts a target calendar wall-clock time in Africa/Cairo into the exact UTC Date,
 * dynamically accounting for Egypt DST (EET UTC+2 / EEST UTC+3).
 */
function resolveCairoWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  // Initial guess assumes Cairo EET (UTC+2); iterative correction adjusts to +2/+3 cleanly.
  let epochMs = Date.UTC(year, month - 1, day, hour - 2, minute, 0, 0);
  const targetUtcMinutes = Math.floor(Date.UTC(year, month - 1, day, hour, minute, 0, 0) / 60000);

  for (let i = 0; i < 3; i++) {
    const p = getCairoDateParts(new Date(epochMs));
    const actualUtcMinutes = Math.floor(
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0) / 60000
    );
    const diffMinutes = targetUtcMinutes - actualUtcMinutes;
    if (diffMinutes === 0) break;
    epochMs += diffMinutes * 60000;
  }
  return new Date(epochMs);
}

/**
 * Computes the NEXT strictly future trigger Date for a weekly reminder rule in Africa/Cairo.
 * Never returns a timestamp <= refDate (prevents firing missed past alarms upon opening/reboot).
 */
export function computeNextCairoOccurrence(
  rule: WeeklyReminderRule,
  refDate: Date = new Date()
): Date {
  const cairo = getCairoDateParts(refDate);
  let daysAhead = (rule.weekdayCairo - cairo.weekday + 7) % 7;

  const isSameDayPassedOrNow =
    daysAhead === 0 &&
    (cairo.hour > rule.hour ||
      (cairo.hour === rule.hour && cairo.minute > rule.minute) ||
      (cairo.hour === rule.hour && cairo.minute === rule.minute && cairo.second >= 0));

  if (isSameDayPassedOrNow) {
    daysAhead = 7;
  }

  const targetCal = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day + daysAhead));
  let nextDate = resolveCairoWallClockToUtc(
    targetCal.getUTCFullYear(),
    targetCal.getUTCMonth() + 1,
    targetCal.getUTCDate(),
    rule.hour,
    rule.minute
  );

  // Strict guard: never allow trigger in past or identical millisecond
  if (nextDate.getTime() <= refDate.getTime()) {
    const fallbackCal = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day + daysAhead + 7));
    nextDate = resolveCairoWallClockToUtc(
      fallbackCal.getUTCFullYear(),
      fallbackCal.getUTCMonth() + 1,
      fallbackCal.getUTCDate(),
      rule.hour,
      rule.minute
    );
  }

  return nextDate;
}

export function formatCairoTriggerPreview(date: Date): string {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      timeZone: CAIRO_TIMEZONE,
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function buildCapacitorNotificationsPayload(
  settings: WeeklyNotificationSettings,
  refDate: Date = new Date()
) {
  if (!settings.masterEnabled) return [];

  return DEFAULT_WEEKLY_REMINDERS.filter((r) => settings.enabledRules[r.key] !== false)
    .map((rule) => {
      const nextAt = computeNextCairoOccurrence(rule, refDate);
      if (nextAt.getTime() <= refDate.getTime()) return null;
      return {
        id: rule.id,
        title: rule.title,
        body: rule.body,
        channelId: WEEKLY_NOTIFICATION_CHANNEL_ID,
        schedule: {
          at: nextAt,
          allowWhileIdle: true
        },
        extra: {
          ruleKey: rule.key,
          timezone: CAIRO_TIMEZONE,
          weekdayCairo: rule.weekdayCairo,
          hour: rule.hour,
          minute: rule.minute
        }
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionState> {
  if (isNativeCapacitorRuntime()) {
    try {
      const res = await LocalNotifications.checkPermissions();
      const display = String(res?.display || '').toLowerCase();
      if (display === 'granted') return 'granted';
      if (display === 'denied') return 'denied';
      return 'prompt';
    } catch {
      return 'prompt';
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    const p = window.Notification.permission;
    if (p === 'granted') return 'granted';
    if (p === 'denied') return 'denied';
    return 'prompt';
  }

  return 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isNativeCapacitorRuntime()) {
    try {
      const res = await LocalNotifications.requestPermissions();
      const display = String(res?.display || '').toLowerCase();
      if (display === 'granted') return 'granted';
      if (display === 'denied') return 'denied';
      return 'prompt';
    } catch {
      return 'denied';
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      const res = await window.Notification.requestPermission();
      if (res === 'granted') return 'granted';
      if (res === 'denied') return 'denied';
      return 'prompt';
    } catch {
      return 'denied';
    }
  }

  return 'unsupported';
}

export async function syncWeeklyNotificationSchedules(
  settingsOverride?: WeeklyNotificationSettings,
  refDate: Date = new Date()
): Promise<SyncNotificationsResult> {
  const settings = settingsOverride || loadWeeklyNotificationSettings();
  const payload = buildCapacitorNotificationsPayload(settings, refDate);
  const nextTriggers = payload.map((item) => ({
    ruleKey: String(item.extra.ruleKey),
    triggerIso: item.schedule.at.toISOString(),
    preview: formatCairoTriggerPreview(item.schedule.at)
  }));

  if (!isNativeCapacitorRuntime()) {
    const perm = await getNotificationPermissionStatus();
    if (!settings.masterEnabled || payload.length === 0) {
      return { scheduledCount: 0, permission: perm, nextTriggers: [], reason: 'disabled' };
    }
    return { scheduledCount: payload.length, permission: perm, nextTriggers, reason: 'web_preview' };
  }

  try {
    // Always cancel stale/existing weekly IDs before rescheduling to eliminate duplicates across restarts/reboots
    const pending = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
    const knownIds = new Set<number>(WEEKLY_NOTIFICATION_IDS);
    for (const p of pending.notifications || []) {
      if (typeof p.id === 'number' && knownIds.has(p.id)) {
        knownIds.add(p.id);
      }
    }
    await LocalNotifications.cancel({
      notifications: Array.from(knownIds).map((id) => ({ id }))
    }).catch(() => {});

    if (!settings.masterEnabled || payload.length === 0) {
      const perm = await getNotificationPermissionStatus();
      return { scheduledCount: 0, permission: perm, nextTriggers: [], reason: 'disabled' };
    }

    const perm = await getNotificationPermissionStatus();
    if (perm !== 'granted') {
      return { scheduledCount: 0, permission: perm, nextTriggers, reason: 'permission_required' };
    }

    await LocalNotifications.createChannel({
      id: WEEKLY_NOTIFICATION_CHANNEL_ID,
      name: 'تذكيرات خدمة مارجرجس الأسبوعية',
      description: 'تذكيرات التحضير والافتقاد والحضور بتوقيت القاهرة',
      importance: 4,
      visibility: 1,
      vibration: true
    }).catch(() => {});

    await LocalNotifications.schedule({
      notifications: payload
    });

    return {
      scheduledCount: payload.length,
      permission: perm,
      nextTriggers
    };
  } catch (err: any) {
    const perm = await getNotificationPermissionStatus().catch(() => 'prompt' as const);
    return {
      scheduledCount: 0,
      permission: perm,
      nextTriggers,
      reason: err?.message || 'schedule_failed'
    };
  }
}
