import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useApp } from '../../context/AppContext';
import { isNativeCapacitorRuntime } from '../../services/apiConfig';
import { LiquidToggle } from '../glass/LiquidToggle';
import {
  DEFAULT_WEEKLY_REMINDERS,
  NotificationPermissionState,
  WeeklyNotificationSettings,
  computeNextCairoOccurrence,
  formatCairoTriggerPreview,
  getNotificationPermissionStatus,
  loadWeeklyNotificationSettings,
  requestNotificationPermission,
  resetDefaultNotificationSettings,
  saveWeeklyNotificationSettings,
  syncWeeklyNotificationSchedules
} from '../../services/weeklyNotificationService';
import {
  X,
  CheckCheck,
  Bell,
  BellRing,
  Check,
  Clock,
  AlertCircle,
  Info,
  Sparkles,
  RotateCcw,
  ShieldAlert,
  CalendarClock
} from 'lucide-react';

export const NotificationsPanel: React.FC = () => {
  const {
    isNotificationsOpen,
    setIsNotificationsOpen,
    notifications,
    markNotificationRead,
    markAllNotificationsRead,
    addNotification
  } = useApp();

  const [activeTab, setActiveTab] = useState<'feed' | 'settings'>('feed');
  const [settings, setSettings] = useState<WeeklyNotificationSettings>(() =>
    loadWeeklyNotificationSettings()
  );
  const [permissionState, setPermissionState] = useState<NotificationPermissionState>('prompt');
  const [isUpdatingSchedule, setIsUpdatingSchedule] = useState(false);

  useEffect(() => {
    if (!isNotificationsOpen) return;
    setSettings(loadWeeklyNotificationSettings());
    void getNotificationPermissionStatus().then(setPermissionState).catch(() => {});
  }, [isNotificationsOpen]);

  if (!isNotificationsOpen) return null;

  const unreadCount = notifications.filter((n) => n.unread).length;
  const activeCount = settings.masterEnabled
    ? DEFAULT_WEEKLY_REMINDERS.filter((r) => settings.enabledRules[r.key] !== false).length
    : 0;

  const commitSettingsUpdate = async (next: WeeklyNotificationSettings): Promise<boolean> => {
    setIsUpdatingSchedule(true);
    const previous = settings;
    try {
      const saved = saveWeeklyNotificationSettings(next);
      const syncRes = await syncWeeklyNotificationSchedules(saved);
      setPermissionState(syncRes.permission);

      // On Android, a saved preference is not proof that native alarms were scheduled.
      // Roll back the preference when the native plugin, permission, or scheduler fails.
      if (isNativeCapacitorRuntime() && (syncRes.reason || syncRes.scheduledCount !== (
        saved.masterEnabled
          ? DEFAULT_WEEKLY_REMINDERS.filter((rule) => saved.enabledRules[rule.key] !== false).length
          : 0
      ))) {
        saveWeeklyNotificationSettings(previous);
        setSettings(previous);
        addNotification(
          'تعذر جدولة التذكيرات',
          syncRes.reason === 'plugin_missing'
            ? 'إضافة إشعارات Android غير مثبتة أو غير مسجلة في النسخة الحالية.'
            : syncRes.reason === 'permission_required'
              ? 'لازم تسمح بإذن الإشعارات من إعدادات Android أولاً.'
              : 'لم يتم تأكيد جدولة كل التذكيرات. لم يتم اعتماد التغيير.',
          'warn'
        );
        return false;
      }

      setSettings(saved);
      return true;
    } catch {
      saveWeeklyNotificationSettings(previous);
      setSettings(previous);
      return false;
    } finally {
      setIsUpdatingSchedule(false);
    }
  };

  const handleToggleMaster = async (enabled: boolean): Promise<boolean> => {
    if (enabled && permissionState !== 'granted') {
      const reqPerm = await requestNotificationPermission();
      setPermissionState(reqPerm);
    }
    const ok = await commitSettingsUpdate({
      ...settings,
      masterEnabled: enabled
    });
    if (ok) {
      addNotification(
        enabled ? 'تم تفعيل التذكيرات الأسبوعية' : 'تم إيقاف التذكيرات الأسبوعية',
        enabled
          ? isNativeCapacitorRuntime()
            ? 'تم تأكيد جدولة التذكيرات على الجهاز بتوقيت القاهرة.'
            : 'تم حفظ الإعدادات. الجدولة الفعلية متاحة داخل تطبيق Android فقط.'
          : 'لن تصلك تنبيهات أسبوعية حتى تعيد تفعيلها.',
        enabled ? 'success' : 'info'
      );
    }
    return ok;
  };

  const handleToggleRule = async (ruleKey: string, enabled: boolean): Promise<boolean> => {
    return commitSettingsUpdate({
      ...settings,
      enabledRules: {
        ...settings.enabledRules,
        [ruleKey]: enabled
      }
    });
  };

  const handleResetDefaults = async () => {
    setIsUpdatingSchedule(true);
    try {
      const defaults = resetDefaultNotificationSettings();
      setSettings(defaults);
      const syncRes = await syncWeeklyNotificationSchedules(defaults);
      setPermissionState(syncRes.permission);
      const nativeSuccess = !isNativeCapacitorRuntime() ||
        (!syncRes.reason && syncRes.scheduledCount === DEFAULT_WEEKLY_REMINDERS.length);
      if (!nativeSuccess) {
        addNotification(
          'تعذر استعادة الجدولة',
          'تم حفظ الإعدادات، لكن لم يتم تأكيد جدولة الإشعارات على الجهاز.',
          'warn'
        );
      } else {
        addNotification(
          'تمت استعادة المواعيد الافتراضية',
          isNativeCapacitorRuntime()
            ? 'تم تأكيد جدولة التذكيرات الخمسة بتوقيت القاهرة.'
            : 'تم حفظ الإعدادات. الجدولة الفعلية متاحة داخل تطبيق Android فقط.',
          isNativeCapacitorRuntime() ? 'success' : 'info'
        );
      }
    } finally {
      setIsUpdatingSchedule(false);
    }
  };

  const handleRequestPermission = async () => {
    const nextPerm = await requestNotificationPermission();
    setPermissionState(nextPerm);
    if (nextPerm === 'granted') {
      const syncRes = await syncWeeklyNotificationSchedules(settings);
      if (!syncRes.reason && syncRes.scheduledCount > 0) {
        addNotification('تم منح إذن الإشعارات', 'تم تأكيد جدولة التذكيرات الأسبوعية بتوقيت القاهرة.', 'success');
      } else {
        addNotification(
          'تم منح الإذن لكن الجدولة لم تكتمل',
          syncRes.reason === 'plugin_missing'
            ? 'إضافة إشعارات Android غير مثبتة أو غير مسجلة.'
            : 'لم يتم تأكيد جدولة الإشعارات على الجهاز.',
          'warn'
        );
      }
    } else if (nextPerm === 'denied') {
      addNotification(
        'إذن الإشعارات مرفوض',
        'يمكنك السماح بالإشعارات من إعدادات التطبيق في نظام أندرويد.',
        'warn'
      );
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setIsNotificationsOpen(false)}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity"
      />

      {/* Panel Container */}
      <div className="fixed top-20 left-3 right-3 sm:right-auto sm:left-6 sm:w-[440px] max-h-[82vh] z-50 glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow-lg)] flex flex-col overflow-hidden animate-wordIn select-none">
        {/* Header */}
        <div className="flex flex-col gap-3 p-4 border-b border-[var(--border-color)] bg-[var(--surface-primary)]/40">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs shrink-0">
                {activeTab === 'settings' ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-extrabold text-sm sm:text-base text-[var(--text-primary)] m-0 truncate">
                    {activeTab === 'settings' ? 'إعدادات التذكير الأسبوعي' : 'التنبيهات'}
                  </h3>
                  {unreadCount > 0 && activeTab === 'feed' && (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[var(--accent-secondary)]/15 text-[var(--accent-secondary)] border border-[var(--accent-secondary)]/30">
                      {unreadCount} جديد
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[var(--text-muted)] m-0 truncate">
                  {activeTab === 'settings'
                    ? 'بتوقيت القاهرة (Africa/Cairo) • تلقائي'
                    : 'إشعارات المزامنة، التحديثات، وأحداث الخدمة'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {activeTab === 'feed' && unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllNotificationsRead}
                  className="text-xs font-bold text-[var(--accent-secondary)] hover:text-[var(--primary)] flex items-center gap-1 cursor-pointer transition-colors px-2 py-1 rounded-lg hover:bg-[var(--surface-primary)]"
                  title="تحديد كل التنبيهات كمقروءة"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">قراءة الكل</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsNotificationsOpen(false)}
                className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer"
                aria-label="إغلاق التنبيهات"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Sub-navigation Tabs with Sliding Indicator */}
          <div
            role="tablist"
            aria-label="تبويبات التنبيهات"
            className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-[var(--app-bg)]/45 border border-[var(--border-color)]/60"
          >
            {[
              { id: 'feed' as const, label: 'سجل التنبيهات', icon: Bell },
              { id: 'settings' as const, label: `التذكير الأسبوعي (${activeCount}/5)`, icon: CalendarClock }
            ].map((tab) => {
              const Icon = tab.icon;
              const isTabActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isTabActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative py-1.5 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                    isTabActive
                      ? 'text-white'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {isTabActive && (
                    <motion.span
                      layoutId="notifTabPill"
                      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                      aria-hidden="true"
                      className="glass-btn--primary absolute inset-0 rounded-xl pointer-events-none"
                    />
                  )}
                  <Icon className="relative z-10 w-3.5 h-3.5" />
                  <span className="relative z-10">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body Content */}
        {activeTab === 'feed' ? (
          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {notifications.length === 0 ? (
              <div className="text-center py-12 text-[var(--text-muted)] space-y-2">
                <div className="w-12 h-12 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center mx-auto text-[var(--text-muted)] opacity-50">
                  <Bell className="w-6 h-6" />
                </div>
                <p className="text-sm font-bold text-[var(--text-primary)] m-0">لا توجد تنبيهات حالياً</p>
                <p className="text-xs text-[var(--text-muted)] m-0">
                  ستظهر هنا رسائل نجاح المزامنة، تنبيهات الأوفلاين، وتحديثات الطلاب.
                </p>
              </div>
            ) : (
              notifications.map((notif, idx) => {
                const typeConfig = {
                  info: {
                    border: 'border-r-4 border-r-[var(--primary)]',
                    icon: Info,
                    iconColor: 'text-[var(--primary)]'
                  },
                  warn: {
                    border: 'border-r-4 border-r-amber-500',
                    icon: Clock,
                    iconColor: 'text-amber-500'
                  },
                  success: {
                    border: 'border-r-4 border-r-[var(--accent-secondary)]',
                    icon: Sparkles,
                    iconColor: 'text-[var(--accent-secondary)]'
                  },
                  danger: {
                    border: 'border-r-4 border-r-[var(--danger)]',
                    icon: AlertCircle,
                    iconColor: 'text-[var(--danger)]'
                  }
                }[notif.type || 'info'];

                const TypeIcon = typeConfig.icon;

                return (
                  <div
                    key={notif.id}
                    style={{ '--i': Math.min(idx, 8) } as React.CSSProperties}
                    onClick={() => notif.unread && markNotificationRead(notif.id)}
                    className={`word-in p-3 sm:p-3.5 rounded-2xl border transition-all duration-200 cursor-pointer text-right flex items-start gap-3 ${
                      notif.unread
                        ? 'bg-[var(--surface-primary)] border-[var(--accent-secondary)]/35 shadow-[0_2px_12px_rgba(32,199,232,0.1)]'
                        : 'bg-[var(--surface-primary)]/50 border-[var(--border-color)] opacity-85 hover:opacity-100 hover:bg-[var(--surface-primary)]'
                    } ${typeConfig.border}`}
                  >
                    <div
                      className={`w-7 h-7 rounded-lg bg-[var(--app-bg)]/50 flex items-center justify-center shrink-0 mt-0.5 ${typeConfig.iconColor}`}
                    >
                      <TypeIcon className="w-4 h-4" />
                    </div>

                    <div className="flex-1 space-y-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="font-bold text-xs sm:text-sm text-[var(--text-primary)] m-0 truncate">
                          {notif.title}
                        </h4>
                        <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">
                          {new Date(notif.timestamp).toLocaleTimeString('ar-EG', {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </span>
                      </div>

                      {notif.desc && (
                        <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed break-words">
                          {notif.desc}
                        </p>
                      )}

                      {notif.unread && (
                        <div className="pt-1.5 flex items-center justify-between">
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--accent-secondary)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-secondary)] animate-pulse" />
                            <span>غير مقروء</span>
                          </span>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              markNotificationRead(notif.id);
                            }}
                            className="text-[11px] font-bold text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer transition-colors"
                            title="تحديد كمقروء"
                          >
                            <Check className="w-3 h-3 text-[var(--accent-secondary)]" />
                            <span>تمييز كمقروء</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
            {/* Master Switch Card */}
            <div className="p-3 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-xs sm:text-sm font-extrabold text-[var(--text-primary)] m-0">
                  تفعيل التذكيرات الأسبوعية
                </h4>
                <p className="text-[11px] text-[var(--text-muted)] m-0 mt-0.5">
                  جدولة تلقائية بتوقيت القاهرة بدون تكرار عند إعادة التشغيل
                </p>
              </div>
              <LiquidToggle
                size="sm"
                checked={settings.masterEnabled}
                loading={isUpdatingSchedule}
                onChange={handleToggleMaster}
                label="تفعيل التذكيرات الأسبوعية"
                onLabel="مفعل"
                offLabel="متوقف"
              />
            </div>

            {/* Android / Browser Notification Permission Banner */}
            <div className="p-2.5 rounded-2xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]/80 flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <BellRing className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
                <span className="font-bold text-[var(--text-secondary)] truncate">
                  حالة إذن الإشعارات:{' '}
                  <strong
                    className={
                      permissionState === 'granted'
                        ? 'text-[var(--accent-secondary)]'
                        : permissionState === 'denied'
                          ? 'text-rose-400'
                          : 'text-amber-400'
                    }
                  >
                    {permissionState === 'granted'
                      ? 'مسموح'
                      : permissionState === 'denied'
                        ? 'مرفوض من النظام'
                        : permissionState === 'unsupported'
                          ? 'وضع المتصفح / APK محلي'
                          : 'بانتظار الإذن'}
                  </strong>
                </span>
              </div>
              {permissionState !== 'granted' && permissionState !== 'unsupported' && (
                <button
                  type="button"
                  onClick={handleRequestPermission}
                  className="glass-btn--primary px-2.5 py-1 rounded-xl text-[11px] font-extrabold shrink-0 cursor-pointer"
                >
                  طلب الإذن
                </button>
              )}
            </div>

            {/* 5 Weekly Reminders Schedule */}
            <div className="space-y-2">
              {DEFAULT_WEEKLY_REMINDERS.map((rule, idx) => {
                const isRuleEnabled = settings.enabledRules[rule.key] !== false;
                const nextDate = computeNextCairoOccurrence(rule);
                const nextPreview = formatCairoTriggerPreview(nextDate);

                return (
                  <div
                    key={rule.id}
                    style={{ '--i': idx } as React.CSSProperties}
                    className={`word-in p-3 rounded-2xl border transition-all flex items-start justify-between gap-3 ${
                      settings.masterEnabled && isRuleEnabled
                        ? 'bg-[var(--surface-primary)] border-[var(--accent-secondary)]/35'
                        : 'bg-[var(--surface-primary)]/40 border-[var(--border-color)] opacity-70'
                    }`}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10.5px] font-extrabold px-2 py-0.5 rounded-full bg-[var(--accent-secondary)]/15 text-[var(--accent-secondary)] border border-[var(--accent-secondary)]/30">
                          {rule.dayLabel} • {rule.timeLabel}
                        </span>
                        <span className="text-xs font-extrabold text-[var(--text-primary)]">
                          {rule.title}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                        {rule.body}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] m-0">
                        الموعد القادم: <span className="font-semibold text-[var(--text-secondary)]">{nextPreview}</span>
                      </p>
                    </div>

                    <div className="shrink-0 pt-1">
                      <LiquidToggle
                        size="sm"
                        checked={isRuleEnabled}
                        disabled={!settings.masterEnabled}
                        loading={isUpdatingSchedule}
                        onChange={(nextVal) => handleToggleRule(rule.key, nextVal)}
                        label={`تفعيل تنبيه ${rule.dayLabel} ${rule.timeLabel}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Restore Default Schedules Button */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={handleResetDefaults}
                disabled={isUpdatingSchedule}
                className="glass-btn w-full py-2 px-3 rounded-xl text-xs font-extrabold text-[var(--accent-secondary)] flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>استعادة المواعيد الافتراضية</span>
              </button>
            </div>

            {/* Honest Android OS Battery Optimization Disclosure */}
            <div className="p-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-[11px] text-amber-200/90 leading-relaxed">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                <strong>تنبيه موثوقية الإشعارات:</strong> قد تؤخر أنظمة توفير البطارية في بعض هواتف أندرويد الإشعارات في الخلفية؛ لضمان دقة التنبيهات يوصى باستثناء التطبيق من قيود البطارية ومنح إذن التنبيهات الدقيقة.
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
