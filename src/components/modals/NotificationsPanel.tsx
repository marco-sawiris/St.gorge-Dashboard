import React from 'react';
import { useApp } from '../../context/AppContext';
import { X, CheckCheck, Bell, Check, Clock, AlertCircle, Info, Sparkles } from 'lucide-react';

export const NotificationsPanel: React.FC = () => {
  const {
    isNotificationsOpen,
    setIsNotificationsOpen,
    notifications,
    markNotificationRead,
    markAllNotificationsRead
  } = useApp();

  if (!isNotificationsOpen) return null;

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setIsNotificationsOpen(false)}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity"
      />

      {/* Panel Container */}
      <div className="fixed top-20 left-3 right-3 sm:right-auto sm:left-6 sm:w-[420px] max-h-[80vh] z-50 glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow-lg)] flex flex-col overflow-hidden animate-wordIn select-none">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-color)] bg-[var(--surface-primary)]/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-sm sm:text-base text-[var(--text-primary)] m-0">التنبيهات</h3>
                {unreadCount > 0 && (
                  <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[var(--accent-secondary)]/15 text-[var(--accent-secondary)] border border-[var(--accent-secondary)]/30">
                    {unreadCount} جديد
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[var(--text-muted)] m-0">
                إشعارات المزامنة، التحديثات، وأحداث الخدمة
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
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
              className="w-8 h-8 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-muted)] flex items-center justify-center hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] cursor-pointer transition-colors"
              aria-label="إغلاق التنبيهات"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Notifications List */}
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
            notifications.map((notif) => {
              // Notification type styles using central design tokens (strict zero green)
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
                  onClick={() => notif.unread && markNotificationRead(notif.id)}
                  className={`p-3 sm:p-3.5 rounded-2xl border transition-all duration-200 cursor-pointer text-right flex items-start gap-3 ${
                    notif.unread
                      ? 'bg-[var(--surface-primary)] border-[var(--accent-secondary)]/35 shadow-[0_2px_12px_rgba(32,199,232,0.1)]'
                      : 'bg-[var(--surface-primary)]/50 border-[var(--border-color)] opacity-85 hover:opacity-100 hover:bg-[var(--surface-primary)]'
                  } ${typeConfig.border}`}
                >
                  <div className={`w-7 h-7 rounded-lg bg-[var(--app-bg)]/50 flex items-center justify-center shrink-0 mt-0.5 ${typeConfig.iconColor}`}>
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
      </div>
    </>
  );
};
