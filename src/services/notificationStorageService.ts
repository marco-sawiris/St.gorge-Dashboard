import { AppNotification } from '../types/auth';
import { isNativeCapacitorRuntime, safeGetLocalStorage } from './apiConfig';

export const NOTIFICATIONS_STORAGE_KEY = 'stgorge_notifications';
export const NOTIFICATIONS_MIGRATION_VERSION_KEY = 'stgorge_notifications_migration_version';
export const NOTIFICATIONS_MIGRATION_TIMESTAMP_KEY = 'stgorge_notifications_migrated_at';
export const CURRENT_NOTIFICATIONS_VERSION = '2.0.0';
export const MAX_STORED_NOTIFICATIONS = 30;

export interface NotificationMigrationResult {
  notifications: AppNotification[];
  didMigrate: boolean;
  migratedAt: number;
}

/**
 * Generates a deterministic deduplication key for an in-app notification so
 * repeated alerts with identical type/title/description never stack in history.
 */
export function computeNotificationDedupKey(
  title: string,
  desc?: string,
  type: 'info' | 'warn' | 'success' | 'danger' = 'info',
  explicitDedupKey?: string
): string {
  if (explicitDedupKey && explicitDedupKey.trim()) {
    return explicitDedupKey.trim();
  }
  const normalizedTitle = String(title || '').trim().replace(/\s+/g, ' ');
  const normalizedDesc = String(desc || '').trim().replace(/\s+/g, ' ');
  return `${type}::${normalizedTitle}::${normalizedDesc}`;
}

/**
 * Removes duplicate notifications by `id` and `dedupKey`, keeping the newest occurrence.
 */
export function deduplicateNotifications(
  items: AppNotification[],
  maxItems: number = MAX_STORED_NOTIFICATIONS
): AppNotification[] {
  if (!Array.isArray(items) || items.length === 0) return [];

  const sorted = [...items]
    .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const result: AppNotification[] = [];

  for (const item of sorted) {
    const key = computeNotificationDedupKey(item.title, item.desc, item.type || 'info', item.dedupKey);
    if (seenIds.has(item.id) || seenKeys.has(key)) {
      continue;
    }
    seenIds.add(item.id);
    seenKeys.add(key);
    result.push({
      ...item,
      dedupKey: key
    });
    if (result.length >= maxItems) break;
  }

  return result;
}

/**
 * Inserts or updates a notification while enforcing strict ID & content deduplication.
 * Prevents duplicate entries for repeated events while keeping new notifications persisted.
 */
export function upsertDeduplicatedNotification(
  previous: AppNotification[],
  incoming: AppNotification,
  maxItems: number = MAX_STORED_NOTIFICATIONS
): AppNotification[] {
  const dedupKey = computeNotificationDedupKey(
    incoming.title,
    incoming.desc,
    incoming.type || 'info',
    incoming.dedupKey
  );

  const normalizedIncoming: AppNotification = {
    ...incoming,
    dedupKey,
    appVersion: incoming.appVersion || CURRENT_NOTIFICATIONS_VERSION
  };

  const remaining = (Array.isArray(previous) ? previous : []).filter((item) => {
    if (!item) return false;
    if (item.id === normalizedIncoming.id) return false;
    const itemKey = computeNotificationDedupKey(
      item.title,
      item.desc,
      item.type || 'info',
      item.dedupKey
    );
    return itemKey !== dedupKey;
  });

  return [normalizedIncoming, ...remaining].slice(0, maxItems);
}

/**
 * Executes a strict ONE-TIME cleanup of legacy notifications when upgrading to
 * CURRENT_NOTIFICATIONS_VERSION using a persisted version migration flag.
 *
 * - First launch on this version: clears ONLY `stgorge_notifications` (`[]`),
 *   records version & migration timestamp, and leaves IndexedDB, Offline Queue,
 *   weekly reminder settings, and Android permissions/channels completely intact.
 * - Subsequent launches on the same version: preserves all notifications created
 *   at or after `migratedAt`, deduplicates them, and never wipes new alerts.
 */
export function loadAndMigrateNotifications(nowMs: number = Date.now()): NotificationMigrationResult {
  try {
    if (typeof localStorage === 'undefined') {
      return { notifications: [], didMigrate: false, migratedAt: nowMs };
    }

    const migratedVersion = safeGetLocalStorage(NOTIFICATIONS_MIGRATION_VERSION_KEY);
    if (migratedVersion !== CURRENT_NOTIFICATIONS_VERSION) {
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify([]));
      localStorage.setItem(NOTIFICATIONS_MIGRATION_VERSION_KEY, CURRENT_NOTIFICATIONS_VERSION);
      localStorage.setItem(NOTIFICATIONS_MIGRATION_TIMESTAMP_KEY, String(nowMs));
      return { notifications: [], didMigrate: true, migratedAt: nowMs };
    }

    const rawMigratedAt = Number(safeGetLocalStorage(NOTIFICATIONS_MIGRATION_TIMESTAMP_KEY) || 0);
    const migratedAt = Number.isFinite(rawMigratedAt) && rawMigratedAt > 0 ? rawMigratedAt : 0;

    const rawSaved = safeGetLocalStorage(NOTIFICATIONS_STORAGE_KEY);
    if (!rawSaved) {
      return { notifications: [], didMigrate: false, migratedAt };
    }

    const parsed = JSON.parse(rawSaved);
    if (!Array.isArray(parsed)) {
      return { notifications: [], didMigrate: false, migratedAt };
    }

    const postUpgradeOnly = parsed.filter((item: any) => {
      if (!item || typeof item !== 'object') return false;
      if (migratedAt > 0 && typeof item.timestamp === 'number' && item.timestamp < migratedAt) {
        return false;
      }
      return true;
    });

    return {
      notifications: deduplicateNotifications(postUpgradeOnly),
      didMigrate: false,
      migratedAt
    };
  } catch {
    return { notifications: [], didMigrate: false, migratedAt: nowMs };
  }
}

export function saveNotificationsToStorage(notifications: AppNotification[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        NOTIFICATIONS_STORAGE_KEY,
        JSON.stringify(deduplicateNotifications(notifications))
      );
    }
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Deletes ONLY notifications already marked as read (`unread === false`),
 * preserving all unread notifications without touching any attendance or student data.
 */
export function clearReadNotificationsFromList(notifications: AppNotification[]): AppNotification[] {
  if (!Array.isArray(notifications) || notifications.length === 0) return [];
  return notifications.filter((item) => Boolean(item && item.unread));
}

/**
 * Clears already-delivered legacy notifications from the Android OS shade once
 * upon upgrade migration, without touching scheduled reminders, permissions,
 * or Android Notification Channels.
 */
export async function clearDeliveredNativeNotificationsOnce(): Promise<void> {
  if (!isNativeCapacitorRuntime() || typeof window === 'undefined') return;
  try {
    const plugins = (window as any).Capacitor?.Plugins;
    let ln = plugins?.LocalNotifications;
    if (!ln) {
      const mod = await import('@capacitor/local-notifications');
      ln = mod.LocalNotifications || null;
    }
    if (ln && typeof ln.removeAllDeliveredNotifications === 'function') {
      await ln.removeAllDeliveredNotifications();
    }
  } catch {
    // Non-fatal on web or if plugin method unavailable
  }
}
