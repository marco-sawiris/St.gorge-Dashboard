import {
  AttendanceHistoryRecord,
  DatabaseSnapshotExport,
  DatabaseStoreSummary,
  INDEXED_DB_NAME,
  SafeMergeRestoreResult,
  idbExportDatabaseSnapshot,
  idbInspectDatabaseSummary,
  idbSafeMergeRestoreBackup
} from './indexedDbService';
import { safeGetLocalStorage, safeSetLocalStorage } from './apiConfig';
import {
  ASSISTANT_SESSIONS_STORAGE_KEY,
  AssistantSession,
  getStoredAssistantSessions
} from './assistantSessionService';
import {
  NOTIFICATIONS_MIGRATION_TIMESTAMP_KEY,
  NOTIFICATIONS_MIGRATION_VERSION_KEY,
  NOTIFICATIONS_STORAGE_KEY,
  deduplicateNotifications,
  saveNotificationsToStorage
} from './notificationStorageService';
import {
  WEEKLY_NOTIFICATION_SETTINGS_KEY,
  WeeklyNotificationSettings,
  loadWeeklyNotificationSettings,
  saveWeeklyNotificationSettings
} from './weeklyNotificationService';
import { AppNotification, OfflineMutation } from '../types/auth';
import { FollowupRecord } from '../types/followup';
import { Student } from '../types/student';
import { triggerBlobDownload } from '../utils/exportUtils';

export const BACKUP_SCHEMA_VERSION = 1;
export const SUPPORTED_BACKUP_SCHEMA_VERSIONS = [1] as const;
export const BACKUP_APPLICATION_VERSION = '2.0';
export const LAST_BACKUP_META_KEY = 'stgorge_last_backup_meta';

// Connection URLs, relay keys, secrets, and auth credentials MUST NEVER be exported or overwritten on restore.
export const EXCLUDED_BACKUP_STORAGE_KEYS = [
  'stgorge_relay_key',
  'stgorge_apps_script_url',
  'stgorge_api_base_url'
] as const;

export interface StGeorgeBackupSettings {
  theme?: 'dark' | 'dim' | 'light';
  sidebarCollapsed?: boolean;
  weeklyNotificationSettings?: WeeklyNotificationSettings;
  notifications?: AppNotification[];
  notificationsMigrationVersion?: string;
  notificationsMigratedAt?: string;
  assistantSessions?: AssistantSession[];
  lastSuccessfulPullIso?: string;
  lastSuccessfulPushIso?: string;
}

export interface StGeorgeBackupPayload {
  schemaVersion: number;
  backupDate: string;
  applicationVersion: string;
  databaseName: string;
  databaseVersion: number;
  counts: DatabaseSnapshotExport['counts'] & { totalRecords: number };
  stores: DatabaseSnapshotExport['stores'];
  settings: StGeorgeBackupSettings;
}

export interface LastBackupMeta {
  backupDate: string;
  schemaVersion: number;
  applicationVersion: string;
  fileName: string;
  totalRecords: number;
  counts: DatabaseSnapshotExport['counts'];
  byteSize: number;
}

export interface BackupPreviewSummary {
  schemaVersion: number;
  backupDate: string;
  applicationVersion: string;
  databaseName: string;
  backupCounts: DatabaseSnapshotExport['counts'];
  backupTotalRecords: number;
  localCounts: DatabaseStoreSummary['counts'];
  localTotalRecords: number;
  settingsKeys: string[];
}

export type BackupValidationResult =
  | { valid: true; backup: StGeorgeBackupPayload }
  | { valid: false; error: string };

export interface BackupExportResult {
  ok: boolean;
  error?: string;
  payload?: StGeorgeBackupPayload;
  jsonString?: string;
  byteSize?: number;
  fileName?: string;
  meta?: LastBackupMeta;
}

export interface BackupRestoreResult {
  ok: boolean;
  error?: string;
  mergeResult?: SafeMergeRestoreResult;
  backupDate?: string;
  restoredSettingsKeys?: string[];
}

const VALID_MUTATION_ACTIONS = new Set(['attendance', 'followup', 'update', 'add', 'delete']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasUnsafeKeys(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collects ONLY non-sensitive local application preferences and local state metadata.
 * Connection URLs, relay secrets, passwords, and tokens are strictly excluded.
 */
export function collectSafeBackupSettings(): StGeorgeBackupSettings {
  const settings: StGeorgeBackupSettings = {};

  const savedTheme = safeGetLocalStorage('stgorge_theme');
  if (savedTheme === 'dark' || savedTheme === 'dim' || savedTheme === 'light') {
    settings.theme = savedTheme;
  }

  const sidebarCollapsed = safeGetLocalStorage('stgorge_sidebar_collapsed');
  if (sidebarCollapsed === '1' || sidebarCollapsed === '0') {
    settings.sidebarCollapsed = sidebarCollapsed === '1';
  }

  const rawWeekly = safeGetLocalStorage(WEEKLY_NOTIFICATION_SETTINGS_KEY);
  if (rawWeekly) {
    settings.weeklyNotificationSettings = loadWeeklyNotificationSettings();
  }

  const rawNotifications = safeGetLocalStorage(NOTIFICATIONS_STORAGE_KEY);
  if (rawNotifications) {
    try {
      const parsed = JSON.parse(rawNotifications);
      if (Array.isArray(parsed)) {
        settings.notifications = deduplicateNotifications(parsed);
      }
    } catch {
      // Ignore malformed notification history
    }
  }

  const migVer = safeGetLocalStorage(NOTIFICATIONS_MIGRATION_VERSION_KEY);
  if (migVer) settings.notificationsMigrationVersion = migVer;

  const migAt = safeGetLocalStorage(NOTIFICATIONS_MIGRATION_TIMESTAMP_KEY);
  if (migAt) settings.notificationsMigratedAt = migAt;

  const rawSessions = safeGetLocalStorage(ASSISTANT_SESSIONS_STORAGE_KEY);
  if (rawSessions) {
    const sessions = getStoredAssistantSessions();
    if (sessions.length > 0) {
      settings.assistantSessions = sessions;
    }
  }

  const pullIso = safeGetLocalStorage('stgorge_last_successful_pull_iso');
  if (pullIso) settings.lastSuccessfulPullIso = pullIso;

  const pushIso = safeGetLocalStorage('stgorge_last_successful_push_iso');
  if (pushIso) settings.lastSuccessfulPushIso = pushIso;

  return settings;
}

export function loadLastBackupMeta(): LastBackupMeta | null {
  try {
    const raw = safeGetLocalStorage(LAST_BACKUP_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || typeof parsed.backupDate !== 'string' || typeof parsed.totalRecords !== 'number') {
      return null;
    }
    return parsed as LastBackupMeta;
  } catch {
    return null;
  }
}

function saveLastBackupMeta(meta: LastBackupMeta): void {
  safeSetLocalStorage(LAST_BACKUP_META_KEY, JSON.stringify(meta));
}

function formatBackupFilename(isoDate: string): string {
  const safeStamp = isoDate.slice(0, 16).replace(/[:T]/g, '-');
  return `stgorge-backup-${safeStamp}.json`;
}

/**
 * Validates JSON syntax, top-level schemaVersion, database identity, and store record integrity.
 */
export function validateAndParseBackupJson(rawText: string): BackupValidationResult {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { valid: false, error: 'ملف النسخة الاحتياطية فارغ أو غير صالح.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, error: 'ملف JSON تالف أو يحتوي على صياغة غير صحيحة.' };
  }

  if (!isPlainObject(parsed) || hasUnsafeKeys(parsed)) {
    return { valid: false, error: 'بنية ملف النسخة الاحتياطية غير صالحة.' };
  }

  if (
    typeof parsed.schemaVersion !== 'number' ||
    !Number.isInteger(parsed.schemaVersion) ||
    !SUPPORTED_BACKUP_SCHEMA_VERSIONS.includes(parsed.schemaVersion as 1)
  ) {
    return {
      valid: false,
      error: `إصدار مخطط النسخة الاحتياطية (schemaVersion: ${String(parsed.schemaVersion ?? 'غير محدد')}) غير مدعوم في هذا الإصدار.`
    };
  }

  if (parsed.databaseName !== INDEXED_DB_NAME) {
    return {
      valid: false,
      error: `اسم قاعدة البيانات (${String(parsed.databaseName ?? 'غير محدد')}) لا يطابق قاعدة بيانات التطبيق (${INDEXED_DB_NAME}).`
    };
  }

  if (typeof parsed.backupDate !== 'string' || Number.isNaN(Date.parse(parsed.backupDate))) {
    return { valid: false, error: 'تاريخ النسخة الاحتياطية (backupDate) غير صالح.' };
  }

  if (typeof parsed.applicationVersion !== 'string' || !parsed.applicationVersion.trim()) {
    return { valid: false, error: 'إصدار التطبيق (applicationVersion) مفقود في النسخة الاحتياطية.' };
  }

  if (!isPlainObject(parsed.stores) || hasUnsafeKeys(parsed.stores)) {
    return { valid: false, error: 'قسم الجداول (stores) مفقود أو غير صالح داخل النسخة الاحتياطية.' };
  }

  const requiredStores = ['students', 'followup', 'mutations', 'attendance_history'] as const;
  for (const storeName of requiredStores) {
    if (!Array.isArray(parsed.stores[storeName])) {
      return {
        valid: false,
        error: `الجدول الأساسي "${storeName}" مفقود أو ليس مصفوفة صالحة داخل النسخة الاحتياطية.`
      };
    }
  }

  const students = parsed.stores.students as Student[];
  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    if (!isPlainObject(s) || hasUnsafeKeys(s) || typeof s.id !== 'string' || !s.id.trim() || typeof s.name !== 'string') {
      return { valid: false, error: `سجل مخدوم غير صالح عند الفهرس ${i} داخل النسخة الاحتياطية.` };
    }
  }

  const followup = parsed.stores.followup as FollowupRecord[];
  for (let i = 0; i < followup.length; i++) {
    const f = followup[i];
    if (
      !isPlainObject(f) ||
      hasUnsafeKeys(f) ||
      typeof f.id !== 'string' ||
      !f.id.trim() ||
      (typeof f.studentId !== 'string' && typeof f.studentName !== 'string')
    ) {
      return { valid: false, error: `سجل افتقاد غير صالح عند الفهرس ${i} داخل النسخة الاحتياطية.` };
    }
  }

  const mutations = parsed.stores.mutations as OfflineMutation[];
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (
      !isPlainObject(m) ||
      hasUnsafeKeys(m) ||
      typeof m.id !== 'string' ||
      !m.id.trim() ||
      typeof m.action !== 'string' ||
      !VALID_MUTATION_ACTIONS.has(m.action)
    ) {
      return { valid: false, error: `عملية طابور غير صالحة عند الفهرس ${i} داخل النسخة الاحتياطية.` };
    }
  }

  const attendanceHistory = parsed.stores.attendance_history as AttendanceHistoryRecord[];
  for (let i = 0; i < attendanceHistory.length; i++) {
    const h = attendanceHistory[i];
    if (
      !isPlainObject(h) ||
      hasUnsafeKeys(h) ||
      typeof h.studentId !== 'string' ||
      !h.studentId.trim() ||
      typeof h.fridayDate !== 'string' ||
      !h.fridayDate.trim()
    ) {
      return { valid: false, error: `سجل حضور تاريخي غير صالح عند الفهرس ${i} داخل النسخة الاحتياطية.` };
    }
  }

  const settings = isPlainObject(parsed.settings) && !hasUnsafeKeys(parsed.settings)
    ? (parsed.settings as StGeorgeBackupSettings)
    : {};

  const counts: StGeorgeBackupPayload['counts'] = {
    students: students.length,
    followup: followup.length,
    mutations: mutations.length,
    attendance_history: attendanceHistory.length,
    totalRecords: students.length + followup.length + mutations.length + attendanceHistory.length
  };

  for (const key of Object.keys(parsed.stores)) {
    if (key !== 'students' && key !== 'followup' && key !== 'mutations' && key !== 'attendance_history') {
      const val = parsed.stores[key];
      if (!Array.isArray(val)) {
        return { valid: false, error: `جدول إضافي غير صالح داخل النسخة: ${key}` };
      }
      counts[key] = val.length;
      counts.totalRecords += val.length;
    }
  }

  return {
    valid: true,
    backup: {
      schemaVersion: parsed.schemaVersion,
      backupDate: parsed.backupDate,
      applicationVersion: parsed.applicationVersion,
      databaseName: parsed.databaseName,
      databaseVersion: typeof parsed.databaseVersion === 'number' ? parsed.databaseVersion : 2,
      counts,
      stores: parsed.stores as DatabaseSnapshotExport['stores'],
      settings
    }
  };
}

/**
 * Generates an atomic consistent IndexedDB snapshot + safe settings JSON backup
 * and verifies round-trip integrity before returning.
 */
export async function createVerifiedBackupSnapshot(): Promise<BackupExportResult> {
  try {
    const snapshot = await idbExportDatabaseSnapshot();
    const settings = collectSafeBackupSettings();
    const backupDate = new Date().toISOString();

    const totalRecords = Object.values(snapshot.counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const payload: StGeorgeBackupPayload = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      backupDate,
      applicationVersion: BACKUP_APPLICATION_VERSION,
      databaseName: snapshot.databaseName,
      databaseVersion: snapshot.databaseVersion,
      counts: {
        ...snapshot.counts,
        totalRecords
      },
      stores: snapshot.stores,
      settings
    };

    const jsonString = JSON.stringify(payload, null, 2);
    if (!jsonString || jsonString.length < 10) {
      return { ok: false, error: 'فشل توليد نص النسخة الاحتياطية.' };
    }

    // Round-trip validation to verify JSON & record counts before claiming success
    const verification = validateAndParseBackupJson(jsonString);
    if (!verification.valid) {
      return { ok: false, error: verification.error };
    }
    if (verification.backup.counts.totalRecords !== totalRecords) {
      return { ok: false, error: 'فشل التحقق من تطابق عدد السجلات في النسخة الاحتياطية المُصدَّرة.' };
    }

    const fileName = formatBackupFilename(backupDate);
    const byteSize = new TextEncoder().encode(jsonString).byteLength;
    const meta: LastBackupMeta = {
      backupDate,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      applicationVersion: BACKUP_APPLICATION_VERSION,
      fileName,
      totalRecords,
      counts: snapshot.counts,
      byteSize
    };

    return {
      ok: true,
      payload: verification.backup,
      jsonString,
      byteSize,
      fileName,
      meta
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || 'حدث خطأ أثناء إنشاء النسخة الاحتياطية.'
    };
  }
}

/**
 * Exports, verifies, downloads the JSON backup file, and persists metadata ONLY after download succeeds.
 */
export async function exportAndDownloadBackup(
  downloader?: (blob: Blob, filename: string) => boolean
): Promise<BackupExportResult> {
  const snapshotResult = await createVerifiedBackupSnapshot();
  if (!snapshotResult.ok || !snapshotResult.jsonString || !snapshotResult.fileName || !snapshotResult.meta) {
    return snapshotResult;
  }

  const blob = new Blob([snapshotResult.jsonString], { type: 'application/json;charset=utf-8' });
  if (blob.size <= 0) {
    return { ok: false, error: 'حجم ملف النسخة الاحتياطية الناتج يساوي صفراً.' };
  }

  const downloadFn = downloader || triggerBlobDownload;
  const triggered = downloadFn(blob, snapshotResult.fileName);
  if (!triggered) {
    return {
      ok: false,
      error: 'تعذر بدء تنزيل ملف النسخة الاحتياطية من المتصفح.'
    };
  }

  saveLastBackupMeta(snapshotResult.meta);
  return snapshotResult;
}

/**
 * Parses and summarizes a backup JSON file against current local IndexedDB counts without mutating anything.
 */
export async function previewBackupRestore(
  rawText: string
): Promise<{ valid: true; backup: StGeorgeBackupPayload; preview: BackupPreviewSummary } | { valid: false; error: string }> {
  const validation = validateAndParseBackupJson(rawText);
  if (!validation.valid) {
    return validation;
  }

  const localSummary = await idbInspectDatabaseSummary();
  const backup = validation.backup;
  const settingsKeys = Object.keys(backup.settings || {});

  return {
    valid: true,
    backup,
    preview: {
      schemaVersion: backup.schemaVersion,
      backupDate: backup.backupDate,
      applicationVersion: backup.applicationVersion,
      databaseName: backup.databaseName,
      backupCounts: {
        students: backup.counts.students,
        followup: backup.counts.followup,
        mutations: backup.counts.mutations,
        attendance_history: backup.counts.attendance_history
      },
      backupTotalRecords: backup.counts.totalRecords,
      localCounts: localSummary.counts,
      localTotalRecords: localSummary.totalRecords,
      settingsKeys
    }
  };
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Safely merges non-sensitive settings AFTER atomic IndexedDB restore completes & is verified.
 * Strictly never modifies connection URLs or relay keys (`stgorge_apps_script_url`, `stgorge_relay_key`, `stgorge_api_base_url`).
 */
export function mergeSafeBackupSettings(settings?: StGeorgeBackupSettings): string[] {
  if (!settings || !isPlainObject(settings)) return [];
  const restoredKeys: string[] = [];

  if (settings.theme === 'dark' || settings.theme === 'dim' || settings.theme === 'light') {
    if (!safeGetLocalStorage('stgorge_theme')) {
      safeSetLocalStorage('stgorge_theme', settings.theme);
      restoredKeys.push('theme');
    }
  }

  if (typeof settings.sidebarCollapsed === 'boolean') {
    if (safeGetLocalStorage('stgorge_sidebar_collapsed') === null) {
      safeSetLocalStorage('stgorge_sidebar_collapsed', settings.sidebarCollapsed ? '1' : '0');
      restoredKeys.push('sidebarCollapsed');
    }
  }

  if (settings.weeklyNotificationSettings && isPlainObject(settings.weeklyNotificationSettings)) {
    const currentWeekly = safeGetLocalStorage(WEEKLY_NOTIFICATION_SETTINGS_KEY);
    if (!currentWeekly) {
      saveWeeklyNotificationSettings(settings.weeklyNotificationSettings);
      restoredKeys.push('weeklyNotificationSettings');
    } else {
      const existing = loadWeeklyNotificationSettings();
      const existingTs = parseIsoMs(existing.updatedAt);
      const incomingTs = parseIsoMs(settings.weeklyNotificationSettings.updatedAt);
      if (incomingTs > existingTs) {
        saveWeeklyNotificationSettings(settings.weeklyNotificationSettings);
        restoredKeys.push('weeklyNotificationSettings');
      }
    }
  }

  if (Array.isArray(settings.notifications) && settings.notifications.length > 0) {
    let existingNotifs: AppNotification[] = [];
    try {
      const raw = safeGetLocalStorage(NOTIFICATIONS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) existingNotifs = parsed;
    } catch {
      existingNotifs = [];
    }
    const mergedNotifs = deduplicateNotifications([...existingNotifs, ...settings.notifications]);
    saveNotificationsToStorage(mergedNotifs);
    restoredKeys.push('notifications');
  }

  if (Array.isArray(settings.assistantSessions) && settings.assistantSessions.length > 0) {
    const existingSessions = getStoredAssistantSessions();
    const sessionMap = new Map<string, AssistantSession>();
    for (const s of existingSessions) {
      if (s && s.id) sessionMap.set(s.id, s);
    }
    for (const incoming of settings.assistantSessions) {
      if (!incoming || !incoming.id) continue;
      const cur = sessionMap.get(incoming.id);
      if (!cur || (incoming.updatedAt || 0) > (cur.updatedAt || 0)) {
        sessionMap.set(incoming.id, incoming);
      }
    }
    const mergedSessions = Array.from(sessionMap.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50);
    safeSetLocalStorage(ASSISTANT_SESSIONS_STORAGE_KEY, JSON.stringify(mergedSessions));
    restoredKeys.push('assistantSessions');
  }

  const curPull = safeGetLocalStorage('stgorge_last_successful_pull_iso');
  if (settings.lastSuccessfulPullIso && parseIsoMs(settings.lastSuccessfulPullIso) > parseIsoMs(curPull || undefined)) {
    safeSetLocalStorage('stgorge_last_successful_pull_iso', settings.lastSuccessfulPullIso);
    restoredKeys.push('lastSuccessfulPullIso');
  }

  const curPush = safeGetLocalStorage('stgorge_last_successful_push_iso');
  if (settings.lastSuccessfulPushIso && parseIsoMs(settings.lastSuccessfulPushIso) > parseIsoMs(curPush || undefined)) {
    safeSetLocalStorage('stgorge_last_successful_push_iso', settings.lastSuccessfulPushIso);
    restoredKeys.push('lastSuccessfulPushIso');
  }

  return restoredKeys;
}

/**
 * Validates, executes atomic safe-merge restore into StGorgeServiceDB, verifies post-restore counts,
 * and ONLY THEN merges safe non-sensitive settings.
 */
export async function restoreVerifiedBackupFromJson(
  rawText: string,
  options?: { _beforeCommitHook?: () => void }
): Promise<BackupRestoreResult> {
  const validation = validateAndParseBackupJson(rawText);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const backup = validation.backup;

  try {
    const mergeResult = await idbSafeMergeRestoreBackup(
      {
        students: backup.stores.students,
        followup: backup.stores.followup,
        mutations: backup.stores.mutations,
        attendance_history: backup.stores.attendance_history
      },
      options
    );

    if (!mergeResult.verified) {
      return {
        ok: false,
        error: 'فشل التحقق الفعلي من سلامة السجلات بعد الاستعادة.'
      };
    }

    const restoredSettingsKeys = mergeSafeBackupSettings(backup.settings);

    return {
      ok: true,
      mergeResult,
      backupDate: backup.backupDate,
      restoredSettingsKeys
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || 'فشلت عملية الاستعادة وتم الحفاظ على البيانات المحلية دون تغيير.'
    };
  }
}
