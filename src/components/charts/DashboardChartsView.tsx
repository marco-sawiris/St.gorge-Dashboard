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
  PieChart,
  Award,
  AlertCircle,
  Activity
} from 'lucide-react';
import { getNearestFridayString } from '../../utils/arabicUtils';

export const DashboardChartsView: React.FC = () => {
  const { students, followupRecords } = useApp();
  const currentFriday = getNearestFridayString();

  // 1. KPI Calculations
  const totalStudents = students.length;
  const presentCount = students.filter((s) => s.att && s.att[currentFriday]).length;
  const attendanceRate = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100) : 0;

  const followedUpCount = students.filter(
    (s) => s.followupStatus && s.followupStatus !== 'بدون' && !s.followupStatus.includes('لم')
  ).length;
  const followupRate = totalStudents > 0 ? Math.round((followedUpCount / totalStudents) * 100) : 0;

  const regularMonthCount = students.filter((s) => (Number(s.attendanceMonth) || 0) >= 3).length;
  const zeroMonthCount = students.filter((s) => (Number(s.attendanceMonth) || 0) === 0).length;

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

  // 4. Followup Methods Distribution (Combines followupRecords + current student followupStatus)
  const followupMethodStats = useMemo(() => {
    const counts: Record<string, number> = {
      'تم تليفونياً': 0,
      'تم بزيارة': 0,
      'واتساب': 0,
      'رسالة نصية': 0,
      'لم يتم بعد': 0
    };

    const studentsWithLog = new Set<string>();
    followupRecords.forEach((r) => {
      const type = r.type?.trim();
      if (!type || type === 'بدون' || type.includes('لم')) return;
      counts[type] = (counts[type] || 0) + 1;
      if (r.studentId) studentsWithLog.add(r.studentId);
      if (r.studentCode) studentsWithLog.add(r.studentCode.trim());
    });

    students.forEach((s) => {
      const status = s.followupStatus?.trim() || '';
      if (!status || status === 'بدون' || status.includes('لم')) {
        counts['لم يتم بعد']++;
      } else if (!studentsWithLog.has(s.id) && !studentsWithLog.has((s.code || '').trim())) {
        counts[status] = (counts[status] || 0) + 1;
      }
    });

    return counts;
  }, [followupRecords, students]);

  // 5. Weekly Attendance Trend (across all Friday columns in student records)
  const weeklyTrend = useMemo(() => {
    const dateSet = new Set<string>();
    students.forEach((s) => {
      Object.keys(s.att || {}).forEach((d) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dateSet.add(d);
      });
    });
    const sortedDates = Array.from(dateSet).sort().slice(-10);
    return sortedDates.map((dateStr) => {
      const present = students.filter((s) => Boolean(s.att && s.att[dateStr])).length;
      const pct = totalStudents > 0 ? Math.round((present / totalStudents) * 100) : 0;
      return { dateStr, label: dateStr.slice(5), present, pct };
    });
  }, [students, totalStudents]);

  return (
    <div className="space-y-6 select-none word-in-scope">
      {/* KPI Cards Grid (Liquid Glass - 6 Key Metrics) */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 xl:grid-cols-3 gap-3 min-w-0">
        {/* Total Students */}
        <div
          className="word-in min-w-0 p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]"
          style={{ '--i': 0 } as React.CSSProperties}
        >
          <div className="w-12 h-12 rounded-2xl bg-[var(--primary)]/15 text-[var(--primary)] border border-[var(--primary)]/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(38,122,255,0.25)]">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">إجمالي المخدومين</span>
            <strong className="text-xl sm:text-2xl font-mono text-[var(--text)] tabular-nums">{totalStudents}</strong>
          </div>
        </div>

        {/* Friday Attendance (Cyan Accent, Zero Green) */}
        <div
          className="word-in min-w-0 p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]"
          style={{ '--i': 1 } as React.CSSProperties}
        >
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
        <div
          className="word-in min-w-0 p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]"
          style={{ '--i': 2 } as React.CSSProperties}
        >
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
        <div
          className="word-in min-w-0 p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]"
          style={{ '--i': 3 } as React.CSSProperties}
        >
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

        {/* Regular Attendees (3+ times this month) */}
        <div
          className="word-in min-w-0 p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]"
          style={{ '--i': 4 } as React.CSSProperties}
        >
          <div className="w-12 h-12 rounded-2xl bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(32,199,232,0.25)]">
            <Award className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">المنتظمون (3+)</span>
            <strong className="text-xl sm:text-2xl font-mono text-[var(--accent)] tabular-nums">{regularMonthCount}</strong>
          </div>
        </div>

        {/* Absent All Month (0 this month) */}
        <div
          className="word-in min-w-0 p-4 rounded-3xl glass-strong shadow-lg flex items-center gap-3 border border-[var(--glass-border)]"
          style={{ '--i': 5 } as React.CSSProperties}
        >
          <div className="w-12 h-12 rounded-2xl bg-rose-500/15 text-rose-400 border border-rose-500/30 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(244,63,94,0.25)]">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-[var(--text-muted)]">لم يحضروا هذا الشهر</span>
            <strong className="text-xl sm:text-2xl font-mono text-rose-400 tabular-nums">{zeroMonthCount}</strong>
          </div>
        </div>
      </div>

      {/* Weekly Attendance SVG Trend Chart */}
      <div
        className="word-in p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]"
        style={{ '--i': 6 } as React.CSSProperties}
      >
        <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#20C7E8]" />
            <h3 className="font-extrabold text-sm text-[var(--text)] m-0">تطور نسب الحضور الأسبوعية</h3>
          </div>
          <span className="text-xs text-[var(--text-muted)] font-mono">
            {weeklyTrend.length > 0 ? `${weeklyTrend.length} جمعة مسجلة` : 'لا توجد تواريخ جمعة'}
          </span>
        </div>

        {weeklyTrend.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] m-0 py-6 text-center">
            لم تُسجّل أعمدة تواريخ جمعات بعد في السجلات المحملة.
          </p>
        ) : (
          <div className="w-full min-w-0 overflow-hidden">
            <svg
              viewBox="0 0 640 190"
              className="block w-full min-w-0 h-44"
              role="img"
              aria-label="تطور نسب الحضور الأسبوعية"
            >
              <defs>
                <linearGradient id="attTrendArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#20C7E8" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#267AFF" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {[25, 50, 75, 100].map((gridPct) => {
                const y = 145 - (gridPct / 100) * 115;
                return (
                  <g key={gridPct}>
                    <line x1="36" y1={y} x2="616" y2={y} stroke="rgba(148,163,184,0.18)" strokeDasharray="4 4" />
                    <text x="10" y={y + 4} fill="rgba(148,163,184,0.7)" fontSize="10" fontFamily="monospace">
                      {gridPct}%
                    </text>
                  </g>
                );
              })}
              {(() => {
                const pts = weeklyTrend.map((item, idx) => {
                  const x =
                    weeklyTrend.length === 1
                      ? 326
                      : 56 + (idx / (weeklyTrend.length - 1)) * 540;
                  const y = 145 - (item.pct / 100) * 115;
                  return { ...item, x, y };
                });
                const polylinePoints = pts.map((p) => `${p.x},${p.y}`).join(' ');
                const areaPath =
                  pts.length > 1
                    ? `M ${pts[0].x} 145 ` +
                      pts.map((p) => `L ${p.x} ${p.y}`).join(' ') +
                      ` L ${pts[pts.length - 1].x} 145 Z`
                    : '';
                return (
                  <>
                    {areaPath && <path d={areaPath} fill="url(#attTrendArea)" />}
                    {pts.length > 1 && (
                      <polyline
                        fill="none"
                        stroke="#20C7E8"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="svg-line-draw"
                        points={polylinePoints}
                      />
                    )}
                    {pts.map((p) => (
                      <g key={p.dateStr}>
                        <circle cx={p.x} cy={p.y} r="5" fill="#267AFF" stroke="#20C7E8" strokeWidth="2.5" />
                        <text
                          x={p.x}
                          y={Math.max(16, p.y - 10)}
                          textAnchor="middle"
                          fill="#20C7E8"
                          fontSize="11"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          {p.pct}%
                        </text>
                        <text
                          x={p.x}
                          y="170"
                          textAnchor="middle"
                          fill="rgba(148,163,184,0.85)"
                          fontSize="10"
                          fontFamily="monospace"
                        >
                          {p.label}
                        </text>
                      </g>
                    ))}
                  </>
                );
              })()}
            </svg>
          </div>
        )}
      </div>

      {/* Charts Section: 2 Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Chart 1: Distribution by Sheet */}
        <div
          className="word-in p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]"
          style={{ '--i': 7 } as React.CSSProperties}
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
            <div className="flex items-center gap-2">
              <PieChart className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="font-extrabold text-sm text-[var(--text)] m-0">توزيع المخدومين حسب الفصل</h3>
            </div>
            <span className="text-xs text-[var(--text-muted)] font-mono">{totalStudents} مخدوم</span>
          </div>

          <div className="space-y-3">
            {Object.entries(sheetStats).map(([sheetName, count], idx) => {
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
                      className={`chart-bar-grow h-full rounded-full transition-all duration-500 shadow-sm ${colorClass}`}
                      style={{ width: `${pct}%`, '--i': idx } as React.CSSProperties}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 2: Servants Workload & Attendance */}
        <div
          className="word-in p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]"
          style={{ '--i': 8 } as React.CSSProperties}
        >
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
        <div
          className="word-in p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]"
          style={{ '--i': 9 } as React.CSSProperties}
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--glass-border)]">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="font-extrabold text-sm text-[var(--text)] m-0">التوزيع الجغرافي للمناطق</h3>
            </div>
            <span className="text-xs text-[var(--text-muted)] font-mono">{areaStats.length} منطقة</span>
          </div>

          <div className="space-y-2.5">
            {areaStats.map(([areaName, count], idx) => {
              const pct = totalStudents > 0 ? Math.round((count / totalStudents) * 100) : 0;
              return (
                <div key={areaName} className="space-y-1">
                  <div className="flex justify-between text-xs font-bold text-[var(--text)]">
                    <span>{areaName}</span>
                    <span className="font-mono text-[var(--text-secondary)]">{count} ({pct}%)</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] overflow-hidden">
                    <div
                      className="chart-bar-grow h-full rounded-full bg-gradient-to-l from-[var(--accent)] to-[var(--primary)] transition-all duration-500 shadow-[0_0_8px_rgba(32,199,232,0.4)]"
                      style={{ width: `${pct}%`, '--i': idx } as React.CSSProperties}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 4: Followup Methods Distribution */}
        <div
          className="word-in p-5 rounded-3xl glass shadow-xl space-y-4 border border-[var(--glass-border)]"
          style={{ '--i': 10 } as React.CSSProperties}
        >
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
