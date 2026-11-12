import React, { useState, useMemo } from 'react';
import { Student } from '../../types/student';
import { useApp } from '../../context/AppContext';
import {
  Download,
  Phone,
  MessageSquare,
  Edit3,
  HeartHandshake,
  CheckCircle2,
  XCircle,
  ArrowUpDown
} from 'lucide-react';
import { getNearestFridayString } from '../../utils/arabicUtils';

interface StudentsTableViewProps {
  onOpenFollowup: (student: Student) => void;
  onOpenEdit: (student: Student) => void;
}

type SortField = 'name' | 'code' | 'servant' | 'attendanceTotal' | 'attendanceMonth' | 'area';
type SortOrder = 'asc' | 'desc';

export const StudentsTableView: React.FC<StudentsTableViewProps> = ({
  onOpenFollowup,
  onOpenEdit
}) => {
  const { filteredStudents, markAttendance } = useApp();
  const currentFriday = getNearestFridayString();

  const [sortField, setSortField] = useState<SortField>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const sortedStudents = useMemo(() => {
    return [...filteredStudents].sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];

      if (typeof valA === 'string') {
        const comp = valA.localeCompare(valB || '', 'ar');
        return sortOrder === 'asc' ? comp : -comp;
      }

      if (typeof valA === 'number') {
        return sortOrder === 'asc' ? (valA || 0) - (valB || 0) : (valB || 0) - (valA || 0);
      }

      return 0;
    });
  }, [filteredStudents, sortField, sortOrder]);

  // Export to Excel / CSV with UTF-8 BOM for proper Arabic display
  const handleExportCSV = () => {
    if (sortedStudents.length === 0) return;

    const headers = [
      'كود المخدوم',
      'الاسم',
      'الأشبين',
      'الفصل',
      'المنطقة',
      'العنوان',
      'موبايل الطالب',
      'ولي الأمر 1',
      'ولي الأمر 2',
      'إجمالي الحضور',
      'حضور الشهر',
      'حضور اليوم',
      'حالة الافتقاد',
      'ملاحظات'
    ];

    const rows = sortedStudents.map((s) => {
      const isPresentToday = s.att && s.att[currentFriday] ? 'حاضر' : 'غائب';
      return [
        `"${s.code}"`,
        `"${s.name}"`,
        `"${s.servant}"`,
        `"${s.sourceSheet}"`,
        `"${s.area}"`,
        `"${s.address}"`,
        `"${s.phoneStudent || ''}"`,
        `"${s.phoneParent1 || ''}"`,
        `"${s.phoneParent2 || ''}"`,
        s.attendanceTotal,
        s.attendanceMonth,
        `"${isPresentToday}"`,
        `"${s.followupStatus || ''}"`,
        `"${(s.notes || '').replace(/"/g, '""')}"`
      ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `بيانات_مخدومي_مارجرجس_${currentFriday}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const presentCount = sortedStudents.filter((s) => s.att && s.att[currentFriday]).length;
  const attendanceRate = sortedStudents.length > 0 ? Math.round((presentCount / sortedStudents.length) * 100) : 0;

  return (
    <div className="space-y-4 select-none">
      {/* Table Actions & Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl glass-strong border border-[var(--glass-border)] shadow-md">
        <div className="flex items-center gap-4 text-xs font-bold text-[var(--text)]">
          <span>العدد المعروض: <strong className="font-mono text-[var(--accent)]">{sortedStudents.length}</strong></span>
          <span>حضور اليوم: <strong className="font-mono text-[var(--accent)]">{presentCount}</strong> ({attendanceRate}%)</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportCSV}
            className="btn--lens px-4 py-2 text-xs flex items-center gap-2 cursor-pointer shadow-md active:scale-95"
            title="تنزيل ملف Excel باللغة العربية"
          >
            <Download className="w-3.5 h-3.5" />
            <span>تصدير Excel (CSV)</span>
          </button>
        </div>
      </div>

      {/* Main Table Scroll Container (Liquid Glass) */}
      <div className="overflow-x-auto rounded-3xl glass-strong border border-[var(--glass-border)] shadow-xl select-none">
        <table className="w-full text-right text-xs border-collapse">
          <thead>
            <tr className="border-b border-[var(--glass-border)] bg-[var(--navy)]/80 text-[var(--text-secondary)] font-extrabold backdrop-blur-md">
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('code')}>
                <div className="flex items-center gap-1.5">
                  <span>الكود</span>
                  <ArrowUpDown className="w-3 h-3 text-[var(--accent)]" />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('name')}>
                <div className="flex items-center gap-1.5">
                  <span>الاسم</span>
                  <ArrowUpDown className="w-3 h-3 text-[var(--accent)]" />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('servant')}>
                <div className="flex items-center gap-1.5">
                  <span>الأشبين</span>
                  <ArrowUpDown className="w-3 h-3 text-[var(--accent)]" />
                </div>
              </th>
              <th className="py-3.5 px-3.5">الفصل</th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('area')}>
                <div className="flex items-center gap-1.5">
                  <span>المنطقة</span>
                  <ArrowUpDown className="w-3 h-3 text-[var(--accent)]" />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] text-center transition-colors" onClick={() => handleSort('attendanceTotal')}>
                <div className="flex items-center justify-center gap-1.5">
                  <span>إجمالي الحضور</span>
                  <ArrowUpDown className="w-3 h-3 text-[var(--accent)]" />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] text-center transition-colors" onClick={() => handleSort('attendanceMonth')}>
                <div className="flex items-center justify-center gap-1.5">
                  <span>الشهر</span>
                  <ArrowUpDown className="w-3 h-3 text-[var(--accent)]" />
                </div>
              </th>
              <th className="py-3.5 px-3.5 text-center">حضور اليوم</th>
              <th className="py-3.5 px-3.5">الافتقاد</th>
              <th className="py-3.5 px-3.5 text-center">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--glass-border)]">
            {sortedStudents.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-12 text-center text-[var(--text-muted)]">
                  لا توجد سجلات تطابق الفلاتر المحددة حالياً.
                </td>
              </tr>
            ) : (
              sortedStudents.map((s) => {
                const isPresent = Boolean(s.att && s.att[currentFriday]);
                return (
                  <tr key={s.id} className="hover:bg-white/5 transition-colors">
                    <td className="py-3.5 px-3.5 font-mono font-bold text-[var(--accent)] whitespace-nowrap">
                      {s.code}
                    </td>
                    <td className="py-3.5 px-3.5 font-bold text-[var(--text)] whitespace-nowrap">
                      {s.name}
                    </td>
                    <td className="py-3.5 px-3.5 font-semibold text-[var(--text-secondary)] whitespace-nowrap">
                      {s.servant}
                    </td>
                    <td className="py-3.5 px-3.5 whitespace-nowrap">
                      <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--text)]">
                        {s.sourceSheet}
                      </span>
                    </td>
                    <td className="py-3.5 px-3.5 text-[var(--text-secondary)] whitespace-nowrap">
                      {s.area}
                    </td>
                    <td className="py-3.5 px-3.5 text-center font-mono font-bold text-[var(--accent)] tabular-nums">
                      {s.attendanceTotal}
                    </td>
                    <td className="py-3.5 px-3.5 text-center font-mono font-bold text-[var(--primary)] tabular-nums">
                      {s.attendanceMonth}
                    </td>
                    <td className="py-3.5 px-3.5 text-center whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => markAttendance(s.id, !isPresent)}
                        className={`px-3 py-1 rounded-xl text-xs font-bold cursor-pointer transition-all active:scale-95 inline-flex items-center gap-1.5 border ${
                          isPresent
                            ? 'bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] text-white border-[var(--accent)] shadow-[0_0_12px_rgba(32,199,232,0.45)]'
                            : 'bg-[var(--navy)]/60 border-[var(--glass-border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
                        }`}
                      >
                        {isPresent ? (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                            <span>حاضر</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3.5 h-3.5 text-slate-400" />
                            <span>غائب</span>
                          </>
                        )}
                      </button>
                    </td>
                    <td className="py-3.5 px-3.5 font-semibold text-[var(--accent)] whitespace-nowrap">
                      {s.followupStatus || 'بدون'}
                    </td>
                    <td className="py-3.5 px-3.5 text-center whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1.5">
                        {s.phoneStudent && (
                          <a
                            href={`tel:${s.phoneStudent}`}
                            className="p-1.5 rounded-lg bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--text)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
                            title="اتصال"
                          >
                            <Phone className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {(s.phoneStudent || s.phoneParent1) && (
                          <a
                            href={`https://wa.me/2${(s.phoneStudent || s.phoneParent1)?.replace(/\D/g, '')}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 rounded-lg bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--text)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
                            title="واتساب"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenFollowup(s)}
                          className="p-1.5 rounded-lg bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:border-[var(--accent)] cursor-pointer"
                          title="تسجيل افتقاد"
                        >
                          <HeartHandshake className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenEdit(s)}
                          className="p-1.5 rounded-lg bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--text)] hover:text-[var(--accent)] hover:border-[var(--accent)] cursor-pointer"
                          title="تعديل البيانات"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
