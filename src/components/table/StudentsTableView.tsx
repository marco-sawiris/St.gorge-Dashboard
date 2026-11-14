import React, { useState, useMemo } from 'react';
import { Student } from '../../types/student';
import { useApp } from '../../context/AppContext';
import {
  Download,
  Printer,
  Phone,
  MessageSquare,
  Edit3,
  HeartHandshake,
  CheckCircle2,
  XCircle,
  ArrowUpDown
} from 'lucide-react';
import { getNearestFridayString } from '../../utils/arabicUtils';
import { downloadCsvReport, downloadPrintableHtmlReport } from '../../utils/exportUtils';

interface StudentsTableViewProps {
  onOpenFollowup: (student: Student) => void;
  onOpenEdit: (student: Student) => void;
}

type SortField = 'name' | 'code' | 'servant' | 'attendanceTotal' | 'attendanceMonth' | 'lastAttendance' | 'area';
type SortOrder = 'asc' | 'desc';

export const StudentsTableView: React.FC<StudentsTableViewProps> = ({
  onOpenFollowup,
  onOpenEdit
}) => {
  const { filteredStudents, markAttendance, activeEditingId } = useApp();
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
      const valA = a[sortField];
      const valB = b[sortField];

      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortOrder === 'asc' ? valA - valB : valB - valA;
      }

      const strA = String(valA || '');
      const strB = String(valB || '');
      const comp = strA.localeCompare(strB, 'ar');
      return sortOrder === 'asc' ? comp : -comp;
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
      'آخر حضور',
      'حضور اليوم',
      'حالة الافتقاد',
      'ملاحظات'
    ];

    const rows = sortedStudents.map((s) => {
      const isPresentToday = s.att && s.att[currentFriday] ? 'حاضر' : 'غائب';
      return [
        s.code,
        s.name,
        s.servant,
        s.sourceSheet,
        s.area,
        s.address,
        s.phoneStudent || '',
        s.phoneParent1 || '',
        s.phoneParent2 || '',
        s.attendanceTotal,
        s.attendanceMonth,
        s.lastAttendance || '-',
        isPresentToday,
        s.followupStatus || '',
        s.notes || ''
      ];
    });

    downloadCsvReport(headers, rows, `بيانات_مخدومي_مارجرجس_${currentFriday}.csv`);
  };

  // Export Printable RTL HTML Report (Save as PDF via Print)
  const handleExportPrintablePDF = () => {
    if (sortedStudents.length === 0) return;
    const headers = [
      'الكود',
      'الاسم',
      'الأشبين',
      'الفصل',
      'المنطقة',
      'إجمالي الحضور',
      'الشهر',
      'آخر حضور',
      'حالة اليوم',
      'الافتقاد'
    ];
    const rows = sortedStudents.map((s) => [
      s.code,
      s.name,
      s.servant,
      s.sourceSheet,
      s.area,
      s.attendanceTotal,
      s.attendanceMonth,
      s.lastAttendance || '-',
      s.att && s.att[currentFriday] ? 'حاضر' : 'غائب',
      s.followupStatus || 'بدون'
    ]);
    downloadPrintableHtmlReport(
      'تقرير جدول مخدومي فصل الشهيد مارجرجس',
      `جمعة ${currentFriday} • إجمالي السجلات: ${sortedStudents.length}`,
      headers,
      rows,
      `تقرير_الجدول_PDF_${currentFriday}.html`
    );
  };

  const presentCount = sortedStudents.filter((s) => s.att && s.att[currentFriday]).length;
  const attendanceRate = sortedStudents.length > 0 ? Math.round((presentCount / sortedStudents.length) * 100) : 0;

  const whatsappSummaryText = useMemo(() => {
    const absentCount = sortedStudents.length - presentCount;
    return [
      `✝️ *ملخص جدول فصل الشهيد مارجرجس (${currentFriday})*`,
      `• المعروض: ${sortedStudents.length} مخدوم`,
      `• الحاضرون: ${presentCount} (${attendanceRate}%)`,
      `• الغائبون: ${absentCount}`,
      '',
      '🔸 *أبرز الغائبين للمتابعة:*',
      ...sortedStudents
        .filter((s) => !s.att || !s.att[currentFriday])
        .slice(0, 10)
        .map((s, idx) => `${idx + 1}. ${s.name} (${s.servant || '-'})`)
    ].join('\n');
  }, [sortedStudents, presentCount, attendanceRate, currentFriday]);

  return (
    <div className="space-y-4 select-none word-in-scope">
      {/* Table Actions & Summary */}
      <div
        className="word-in flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl glass-strong border border-[var(--glass-border)] shadow-md"
        style={{ '--i': 0 } as React.CSSProperties}
      >
        <div className="flex items-center gap-4 text-xs font-bold text-[var(--text)]">
          <span>العدد المعروض: <strong className="font-mono text-[var(--accent)]">{sortedStudents.length}</strong></span>
          <span>حضور اليوم: <strong className="font-mono text-[var(--accent)]">{presentCount}</strong> ({attendanceRate}%)</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportCSV}
            className="glass-btn--primary btn--lens px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            title="تنزيل ملف Excel باللغة العربية"
          >
            <Download className="w-3.5 h-3.5" />
            <span>تصدير Excel (CSV)</span>
          </button>

          <button
            type="button"
            onClick={handleExportPrintablePDF}
            className="glass-btn px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            title="تنزيل تقرير جاهز للطباعة أو الحفظ كـ PDF"
          >
            <Printer className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>طباعة / PDF</span>
          </button>

          <a
            href={`https://wa.me/?text=${encodeURIComponent(whatsappSummaryText)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="glass-btn px-3.5 py-2 rounded-xl text-xs font-bold text-[var(--accent)] flex items-center gap-1.5"
            title="مشاركة ملخص الجدول عبر واتساب"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>ملخص واتساب</span>
          </a>
        </div>
      </div>

      {/* Responsive Mobile Records: same data and actions without horizontal table scrolling */}
      <div className="2xl:hidden space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl glass-strong border border-[var(--glass-border)]">
          <label htmlFor="mobile-student-sort" className="text-xs font-bold text-[var(--text-secondary)]">ترتيب حسب</label>
          <select
            id="mobile-student-sort"
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            className="flex-1 min-w-0 h-9 px-2 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)]"
          >
            <option value="name">الاسم</option>
            <option value="code">الكود</option>
            <option value="servant">الأشبين</option>
            <option value="attendanceTotal">إجمالي الحضور</option>
            <option value="attendanceMonth">حضور الشهر</option>
            <option value="lastAttendance">آخر حضور</option>
            <option value="area">المنطقة</option>
          </select>
          <button
            type="button"
            onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
            className="glass-btn px-3 py-2 rounded-xl text-xs font-bold shrink-0"
            aria-label="عكس ترتيب السجلات"
          >
            {sortOrder === 'asc' ? 'تصاعدي ↑' : 'تنازلي ↓'}
          </button>
        </div>

        {sortedStudents.length === 0 ? (
          <div className="p-8 text-center rounded-2xl glass border border-[var(--border-color)] text-xs text-[var(--text-muted)]">
            لا توجد سجلات تطابق الفلاتر المحددة حالياً.
          </div>
        ) : (
          sortedStudents.map((s, idx) => {
            const isPresent = Boolean(s.att && s.att[currentFriday]);
            const isAnotherCardEditing = Boolean(activeEditingId && activeEditingId !== s.id);
            return (
              <article
                key={s.id}
                className="word-in min-w-0 p-3.5 rounded-2xl glass-strong border border-[var(--glass-border)] shadow-md space-y-3"
                style={{ '--i': Math.min(idx + 1, 10) } as React.CSSProperties}
              >
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-mono font-bold text-[var(--accent)] m-0">{s.code || 'بدون كود'}</p>
                    <h3 className="text-sm font-extrabold text-[var(--text-primary)] m-0 break-words">{s.name}</h3>
                    <p className="text-[11px] text-[var(--text-secondary)] m-0 break-words">الأشبين: {s.servant || 'غير محدد'}</p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--text)] shrink-0">
                    {s.sourceSheet || 'نشط'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="min-w-0 p-2 rounded-xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]">
                    <span className="block text-[10px] text-[var(--text-muted)]">المنطقة</span>
                    <strong className="block text-[var(--text-primary)] break-words">{s.area || 'غير محددة'}</strong>
                  </div>
                  <div className="p-2 rounded-xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]">
                    <span className="block text-[10px] text-[var(--text-muted)]">إجمالي الحضور</span>
                    <strong className="block font-mono text-[var(--accent)]">{s.attendanceTotal ?? 0}</strong>
                  </div>
                  <div className="p-2 rounded-xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]">
                    <span className="block text-[10px] text-[var(--text-muted)]">حضور الشهر</span>
                    <strong className="block font-mono text-[var(--primary)]">{s.attendanceMonth ?? 0}</strong>
                  </div>
                  <div className="p-2 rounded-xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]">
                    <span className="block text-[10px] text-[var(--text-muted)]">آخر حضور</span>
                    <strong className="block font-mono text-[var(--text-primary)] break-words">{s.lastAttendance || '-'}</strong>
                  </div>
                  <div className="p-2 rounded-xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]">
                    <span className="block text-[10px] text-[var(--text-muted)]">حضور الجمعة ({currentFriday})</span>
                    <strong className={`block ${isPresent ? 'text-[#20c7e8]' : 'text-rose-400'}`}>{isPresent ? 'حاضر' : 'غائب'}</strong>
                  </div>
                  <div className="min-w-0 p-2 rounded-xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)]">
                    <span className="block text-[10px] text-[var(--text-muted)]">حالة الافتقاد</span>
                    <strong className="block text-[var(--accent)] break-words">{s.followupStatus || 'بدون'}</strong>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-color)] pt-2">
                  <button
                    type="button"
                    onClick={() => markAttendance(s.id, !isPresent)}
                    aria-pressed={isPresent}
                    className={`glass-btn px-2.5 py-1.5 rounded-xl text-[11px] font-bold inline-flex items-center gap-1 ${isPresent ? 'glass-btn--active text-white' : 'text-[var(--text-muted)]'}`}
                  >
                    {isPresent ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                    {isPresent ? 'حاضر' : 'تسجيل حضور'}
                  </button>
                  {s.phoneStudent && (
                    <a href={`tel:${s.phoneStudent}`} className="glass-btn p-2 rounded-lg" aria-label={`اتصال بـ ${s.name}`}>
                      <Phone className="w-3.5 h-3.5" />
                    </a>
                  )}
                  {(s.phoneStudent || s.phoneParent1) && (
                    <a
                      href={`https://wa.me/2${(s.phoneStudent || s.phoneParent1)?.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="glass-btn p-2 rounded-lg"
                      aria-label={`واتساب ${s.name}`}
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                    </a>
                  )}
                  <button type="button" onClick={() => onOpenFollowup(s)} className="glass-btn p-2 rounded-lg text-[var(--accent)]" title="تسجيل افتقاد">
                    <HeartHandshake className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={isAnotherCardEditing}
                    onClick={() => onOpenEdit(s)}
                    className="glass-btn p-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                    title={isAnotherCardEditing ? 'يوجد كارت آخر قيد التعديل' : 'تعديل البيانات'}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {/* Wide-screen Table: no horizontal scroll; compact fixed columns with wrapping */}
      <div
        className="hidden 2xl:block word-in overflow-hidden rounded-3xl glass-strong border border-[var(--glass-border)] shadow-xl select-none"
        style={{ '--i': 1 } as React.CSSProperties}
      >
        <table className="w-full table-fixed text-right text-xs border-collapse">
          <thead>
            <tr className="border-b border-[var(--glass-border)] bg-[var(--navy)]/80 text-[var(--text-secondary)] font-extrabold backdrop-blur-md">
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('code')}>
                <div className="flex items-center gap-1.5">
                  <span className={sortField === 'code' ? 'text-[var(--accent)]' : ''}>الكود</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'code' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'code' ? 'scale-110' : 'opacity-65'}`} />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('name')}>
                <div className="flex items-center gap-1.5">
                  <span className={sortField === 'name' ? 'text-[var(--accent)]' : ''}>الاسم</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'name' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'name' ? 'scale-110' : 'opacity-65'}`} />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('servant')}>
                <div className="flex items-center gap-1.5">
                  <span className={sortField === 'servant' ? 'text-[var(--accent)]' : ''}>الأشبين</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'servant' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'servant' ? 'scale-110' : 'opacity-65'}`} />
                </div>
              </th>
              <th className="py-3.5 px-3.5">الفصل</th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('area')}>
                <div className="flex items-center gap-1.5">
                  <span className={sortField === 'area' ? 'text-[var(--accent)]' : ''}>المنطقة</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'area' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'area' ? 'scale-110' : 'opacity-65'}`} />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] text-center transition-colors" onClick={() => handleSort('attendanceTotal')}>
                <div className="flex items-center justify-center gap-1.5">
                  <span className={sortField === 'attendanceTotal' ? 'text-[var(--accent)]' : ''}>إجمالي الحضور</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'attendanceTotal' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'attendanceTotal' ? 'scale-110' : 'opacity-65'}`} />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] text-center transition-colors" onClick={() => handleSort('attendanceMonth')}>
                <div className="flex items-center justify-center gap-1.5">
                  <span className={sortField === 'attendanceMonth' ? 'text-[var(--accent)]' : ''}>الشهر</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'attendanceMonth' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'attendanceMonth' ? 'scale-110' : 'opacity-65'}`} />
                </div>
              </th>
              <th className="py-3.5 px-3.5 cursor-pointer hover:text-[var(--accent)] transition-colors" onClick={() => handleSort('lastAttendance')}>
                <div className="flex items-center gap-1.5">
                  <span className={sortField === 'lastAttendance' ? 'text-[var(--accent)]' : ''}>آخر حضور</span>
                  <ArrowUpDown className={`w-3 h-3 text-[var(--accent)] transition-transform duration-300 ${sortField === 'lastAttendance' && sortOrder === 'desc' ? 'rotate-180 scale-110' : sortField === 'lastAttendance' ? 'scale-110' : 'opacity-65'}`} />
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
                <td colSpan={11} className="py-12 text-center text-[var(--text-muted)]">
                  لا توجد سجلات تطابق الفلاتر المحددة حالياً.
                </td>
              </tr>
            ) : (
              sortedStudents.map((s, idx) => {
                const isPresent = Boolean(s.att && s.att[currentFriday]);
                return (
                  <tr
                    key={s.id}
                    className="word-in hover:bg-white/5 transition-colors"
                    style={{ '--i': Math.min(idx + 1, 10) } as React.CSSProperties}
                  >
                    <td className="py-3.5 px-3.5 font-mono font-bold text-[var(--accent)] break-words">
                      {s.code}
                    </td>
                    <td className="py-3.5 px-3.5 font-bold text-[var(--text)] break-words">
                      {s.name}
                    </td>
                    <td className="py-3.5 px-3.5 font-semibold text-[var(--text-secondary)] break-words">
                      {s.servant}
                    </td>
                    <td className="py-3.5 px-3.5 break-words">
                      <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--text)]">
                        {s.sourceSheet}
                      </span>
                    </td>
                    <td className="py-3.5 px-3.5 text-[var(--text-secondary)] break-words">
                      {s.area}
                    </td>
                    <td className="py-3.5 px-3.5 text-center font-mono font-bold text-[var(--accent)] tabular-nums">
                      {s.attendanceTotal}
                    </td>
                    <td className="py-3.5 px-3.5 text-center font-mono font-bold text-[var(--primary)] tabular-nums">
                      {s.attendanceMonth}
                    </td>
                    <td className="py-3.5 px-3.5 font-mono text-[var(--text-secondary)] break-words">
                      {s.lastAttendance || '-'}
                    </td>
                    <td className="py-3.5 px-3.5 text-center break-words">
                      <button
                        type="button"
                        onClick={() => markAttendance(s.id, !isPresent)}
                        aria-pressed={isPresent}
                        className={`glass-btn px-3 py-1 rounded-xl text-xs font-bold cursor-pointer inline-flex items-center gap-1.5 ${
                          isPresent ? 'glass-btn--active text-white' : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {isPresent ? (
                          <span key="p" className="badge-pop inline-flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                            <span>حاضر</span>
                          </span>
                        ) : (
                          <span key="a" className="badge-pop inline-flex items-center gap-1.5">
                            <XCircle className="w-3.5 h-3.5 text-slate-400" />
                            <span>غائب</span>
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="py-3.5 px-3.5 font-semibold text-[var(--accent)] break-words">
                      {s.followupStatus || 'بدون'}
                    </td>
                    <td className="py-3.5 px-3.5 text-center break-words">
                      <div className="flex items-center justify-center gap-1.5">
                        {s.phoneStudent && (
                          <a
                            href={`tel:${s.phoneStudent}`}
                            className="glass-btn p-1.5 rounded-lg text-[var(--text)] hover:text-[var(--accent)]"
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
                            className="glass-btn p-1.5 rounded-lg text-[var(--text)] hover:text-[var(--accent)]"
                            title="واتساب"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenFollowup(s)}
                          className="glass-btn p-1.5 rounded-lg text-[var(--accent)] cursor-pointer"
                          title="تسجيل افتقاد"
                        >
                          <HeartHandshake className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-disabled={Boolean(activeEditingId && activeEditingId !== s.id)}
                          onClick={() => onOpenEdit(s)}
                          className={`glass-btn p-1.5 rounded-lg ${
                            activeEditingId && activeEditingId !== s.id
                              ? 'opacity-40 cursor-not-allowed text-[var(--text-muted)]'
                              : 'text-[var(--text)] hover:text-[var(--accent)] cursor-pointer'
                          }`}
                          title={activeEditingId && activeEditingId !== s.id ? 'يوجد كارت آخر قيد التعديل' : 'تعديل البيانات'}
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
