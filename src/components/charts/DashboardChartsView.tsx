import React, { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import {
  Users,
  CheckCircle2,
  HeartHandshake,
  UserCheck,
  TrendingUp,
  MapPin,
  BarChart3,
  PieChart
} from 'lucide-react';
import { getNearestFridayString } from '../../utils/arabicUtils';

export const DashboardChartsView: React.FC = () => {
  const { students, followupRecords } = useApp();
  const currentFriday = getNearestFridayString();

  // 1. KPI Calculations
  const totalStudents = students.length;
  const presentCount = students.filter((s) => s.att && s.att[currentFriday]).length;
  const attendanceRate = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100) : 0;

  const followedUpCount = students.filter((s) => s.followupStatus && s.followupStatus !== 'بدون').length;
  const followupRate = totalStudents > 0 ? Math.round((followedUpCount / totalStudents) * 100) : 0;

  // Servants stats
  const servantsMap = useMemo(() => {
    const map = new Map<string, { total: number; present: number; followedUp: number }>();
    students.forEach((s) => {
      const servant = s.servant?.trim() || 'غير محدد';
      if (!map.has(servant)) {
        map.set(servant, { total: 0, present: 0, followedUp: 0 });
      }
      const entry = map.get(servant)!;
      entry.total++;
      if (s.att && s.att[currentFriday]) entry.present++;
      if (s.followupStatus && s.followupStatus !== 'بدون') entry.followedUp++;
    });
    return map;
  }, [students, currentFriday]);

  const totalServants = servantsMap.size;
  const avgStudentsPerServant = totalServants > 0 ? (totalStudents / totalServants).toFixed(1) : '0';

  // 2. Sheet Distribution
  const sheetStats = useMemo(() => {
    const counts: Record<string, number> = { 'نشط': 0, 'غير حاضر': 0, 'فصل البابا شنودة': 0, 'غير نشط': 0 };
    students.forEach((s) => {
      const sheet = s.sourceSheet || 'نشط';
      counts[sheet] = (counts[sheet] || 0) + 1;
    });
    return counts;
  }, [students]);

  // 3. Areas Distribution
  const areaStats = useMemo(() => {
    const counts: Record<string, number> = {};
    students.forEach((s) => {
      const area = s.area?.trim() || 'غير محددة';
      counts[area] = (counts[area] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [students]);

  // 4. Followup Methods Distribution
  const followupMethodStats = useMemo(() => {
    const counts: Record<string, number> = {
      'تم تليفونياً': 0,
      'تم بزيارة': 0,
      'واتساب': 0,
      'رسالة نصية': 0
    };
    followupRecords.forEach((r) => {
      const type = r.type?.trim();
      if (type && counts[type] !== undefined) {
        counts[type]++;
      } else if (type) {
        counts[type] = (counts[type] || 0) + 1;
      }
    });
    return counts;
  }, [followupRecords]);

  return (
    <div className="space-y-6 select-none">
      {/* KPI Cards Grid (Liquid Glass) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Total Students */}
        <div className="p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]">
          <div className="w-12 h-12 rounded-2xl bg-[var(--primary)]/15 text-[var(--primary)] border border-[var(--primary)]/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(38,122,255,0.25)]">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">إجمالي المخدومين</span>
            <strong className="text-xl sm:text-2xl font-mono text-[var(--text)] tabular-nums">{totalStudents}</strong>
          </div>
        </div>

        {/* Friday Attendance (Cyan Accent, Zero Green) */}
        <div className="p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]">
          <div className="w-12 h-12 rounded-2xl bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(32,199,232,0.3)]">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">حضور الجمعة ({currentFriday})</span>
            <div className="flex items-baseline gap-1.5">
              <strong className="text-xl sm:text-2xl font-mono text-[var(--accent)] tabular-nums">{presentCount}</strong>
              <span className="text-xs font-bold text-[var(--text-secondary)]">({attendanceRate}%)</span>
            </div>
          </div>
        </div>

        {/* Followup Coverage (Violet Accent) */}
        <div className="p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]">
          <div className="w-12 h-12 rounded-2xl bg-[var(--violet)]/15 text-[var(--violet)] border border-[var(--violet)]/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(101,72,245,0.25)]">
            <HeartHandshake className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">نسبة الافتقاد الشهري</span>
            <div className="flex items-baseline gap-1.5">
              <strong className="text-xl sm:text-2xl font-mono text-[var(--violet)] tabular-nums">{followedUpCount}</strong>
              <span className="text-xs font-bold text-[var(--text-secondary)]">({followupRate}%)</span>
            </div>
          </div>
        </div>

        {/* Servants Capacity (Royal Blue Accent) */}
        <div className="p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]">
          <div className="w-12 h-12 rounded-2xl bg-[var(--royal)]/25 text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(18,63,206,0.3)]">
            <UserCheck className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">الخدام والأشابين</span>
            <div className="flex items-baseline gap-1.5">
              <strong className="text-xl sm:text-2xl font-mono text-[var(--accent)] tabular-nums">{totalServants}</strong>
              <span className="text-xs text-[var(--text-muted)] font-medium">({avgStudentsPerServant} لكل خادم)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Charts Section: 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Chart 1: Distribution by Sheet */}
        <div className="p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
            <div className="flex items-center gap-2">
              <PieChart className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="font-extrabold text-sm text-[var(--text)] m-0">توزيع المخدومين حسب الفصل</h3>
            </div>
            <span className="text-xs text-[var(--text-muted)] font-mono">{totalStudents} مخدوم</span>
          </div>

          <div className="space-y-3">
            {Object.entries(sheetStats).map(([sheetName, count]) => {
              const pct = totalStudents > 0 ? Math.round((count / totalStudents) * 100) : 0;
              const colorClass =
                sheetName === 'نشط'
                  ? 'bg-gradient-to-r from-[var(--primary)] to-[var(--accent)]'
                  : sheetName === 'غير حاضر'
                  ? 'bg-gradient-to-r from-[var(--indigo)] to-[var(--violet)]'
                  : sheetName === 'فصل البابا شنودة'
                  ? 'bg-gradient-to-r from-[var(--royal)] to-[var(--primary)]'
                  : 'bg-slate-600';

              return (
                <div key={sheetName} className="space-y-1">
                  <div className="flex justify-between text-xs font-bold text-[var(--text)]">
                    <span>{sheetName}</span>
                    <span className="font-mono text-[var(--text-secondary)]">{count} ({pct}%)</span>
                  </div>
                  <div className="w-full h-2.5 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 shadow-sm ${colorClass}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 2: Servants Workload & Attendance */}
        <div className="p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="font-extrabold text-sm text-[var(--text)] m-0">معدلات حضور وافتقاد الخدام</h3>
            </div>
            <span className="text-xs text-[var(--text-muted)] font-mono">{totalServants} خادم</span>
          </div>

          <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
            {Array.from(servantsMap.entries()).map(([servantName, data]) => {
              const attPct = data.total > 0 ? Math.round((data.present / data.total) * 100) : 0;
              const fuPct = data.total > 0 ? Math.round((data.followedUp / data.total) * 100) : 0;

              return (
                <div key={servantName} className="p-3 rounded-2xl bg-[var(--navy)]/60 border border-[var(--glass-border)] space-y-1.5 text-xs">
                  <div className="flex justify-between font-bold text-[var(--text)]">
                    <span>{servantName}</span>
                    <span className="font-mono text-[var(--accent)]">{data.total} مخدوم</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-muted)]">حضور:</span>
                      <strong className="text-[var(--accent)] font-mono">{data.present} ({attPct}%)</strong>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-muted)]">افتقاد:</span>
                      <strong className="text-[var(--violet)] font-mono">{data.followedUp} ({fuPct}%)</strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 3: Areas Distribution */}
        <div className="p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="font-extrabold text-sm text-[var(--text)] m-0">التوزيع الجغرافي للمناطق</h3>
            </div>
            <span className="text-xs text-[var(--text-muted)] font-mono">{areaStats.length} منطقة</span>
          </div>

          <div className="space-y-2.5">
            {areaStats.map(([areaName, count]) => {
              const pct = totalStudents > 0 ? Math.round((count / totalStudents) * 100) : 0;
              return (
                <div key={areaName} className="space-y-1">
                  <div className="flex justify-between text-xs font-bold text-[var(--text)]">
                    <span>{areaName}</span>
                    <span className="font-mono text-[var(--text-secondary)]">{count} ({pct}%)</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-[var(--accent)] to-[var(--primary)] transition-all duration-500 shadow-[0_0_8px_rgba(32,199,232,0.4)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 4: Followup Methods Distribution */}
        <div className="p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="font-extrabold text-sm text-[var(--text)] m-0">وسائل الافتقاد المنفذة</h3>
            </div>
            <span className="text-xs text-[var(--text-muted)] font-mono">{followupRecords.length} عملية افتقاد</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {Object.entries(followupMethodStats).map(([methodName, count]) => (
              <div key={methodName} className="p-3.5 rounded-2xl bg-[var(--navy)]/60 border border-[var(--glass-border)] text-center shadow-xs">
                <span className="block text-xs font-semibold text-[var(--text-muted)] mb-1">{methodName}</span>
                <strong className="text-xl font-mono text-[var(--accent)] tabular-nums">{count}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
