import React, { useState, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import {
  HeartHandshake,
  MessageSquare,
  Copy,
  Check,
  Search,
  Phone,
  Calendar,
  User,
  Share2,
  Download,
  Printer
} from 'lucide-react';
import { getNearestFridayString } from '../../utils/arabicUtils';
import { downloadCsvReport, downloadPrintableHtmlReport } from '../../utils/exportUtils';

export const FollowupLogView: React.FC = () => {
  const { followupRecords, students } = useApp();
  const currentFriday = getNearestFridayString();

  const [selectedServant, setSelectedServant] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedSuccess, setCopiedSuccess] = useState<boolean>(false);

  // Servants list
  const servantsList = useMemo(() => {
    const set = new Set<string>();
    students.forEach((s) => {
      const name = s.servant?.trim();
      if (name && name !== 'غير محدد') set.add(name);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [students]);

  // Filtered records
  const filteredRecords = useMemo(() => {
    return followupRecords.filter((r) => {
      if (selectedServant && r.servant !== selectedServant) return false;
      if (selectedType && r.type !== selectedType) return false;
      if (searchQuery) {
        const q = searchQuery.trim().toLowerCase();
        const matchName = r.studentName.toLowerCase().includes(q);
        const matchCode = r.studentCode.toLowerCase().includes(q);
        const matchNotes = (r.notes || '').toLowerCase().includes(q);
        if (!matchName && !matchCode && !matchNotes) return false;
      }
      return true;
    });
  }, [followupRecords, selectedServant, selectedType, searchQuery]);

  // WhatsApp Report Generator (Works for BOTH specific servant OR All Servants Summary)
  const generatedWhatsAppReport = useMemo(() => {
    if (!selectedServant) {
      const grouped = new Map<string, { total: number; present: number; absent: number; calls: number; visits: number }>();
      students.forEach((s) => {
        const key = s.servant?.trim() || 'غير محدد';
        if (!grouped.has(key)) grouped.set(key, { total: 0, present: 0, absent: 0, calls: 0, visits: 0 });
        const row = grouped.get(key)!;
        row.total++;
        if (s.att && s.att[currentFriday]) row.present++;
        else row.absent++;
      });
      followupRecords.forEach((r) => {
        const key = r.servant?.trim() || 'غير محدد';
        if (!grouped.has(key)) grouped.set(key, { total: 0, present: 0, absent: 0, calls: 0, visits: 0 });
        const row = grouped.get(key)!;
        if (r.type === 'تم تليفونياً') row.calls++;
        if (r.type === 'تم بزيارة') row.visits++;
      });

      const distinctStudents = new Set(followupRecords.map((r) => r.studentId || r.studentCode || r.studentName)).size;
      const totalCalls = followupRecords.filter((r) => r.type === 'تم تليفونياً').length;
      const totalVisits = followupRecords.filter((r) => r.type === 'تم بزيارة').length;

      let text = `✝️ *تقرير الافتقاد الشامل — كل الأشابين*\n`;
      text += `📅 جمعة: ${currentFriday}\n`;
      text += `• إجمالي المخدومين: ${students.length} | سجلات الافتقاد: ${followupRecords.length} (${distinctStudents} مخدوم)\n`;
      text += `• اتصالات تليفونية: ${totalCalls} | زيارات منزلية: ${totalVisits}\n\n`;
      text += `📋 *ملخص حسب الأشبين:*\n`;
      Array.from(grouped.entries()).forEach(([srv, st], idx) => {
        text += `${idx + 1}. أ/ ${srv}: حضور ${st.present}/${st.total} • غياب ${st.absent} • اتصال ${st.calls} • زيارة ${st.visits}\n`;
      });
      text += `\nصلواتكم للخدمة والخدام 🙏`;
      return text;
    }

    const servantStudents = students.filter((s) => s.servant === selectedServant);
    const attended = servantStudents.filter((s) => s.att && s.att[currentFriday]);
    const absent = servantStudents.filter((s) => !s.att || !s.att[currentFriday]);
    const servantLogs = followupRecords.filter((r) => r.servant === selectedServant);

    let text = `✝️ *فصل الشهيد مارجرجس - كنيسة العذراء بالزيتون*\n`;
    text += `سلام ونعمة يا أ/ ${selectedServant}،\n`;
    text += `إليك كشف متابعة وافتقاد مخدوميك لجمعة (${currentFriday}):\n\n`;

    // Strict zero-green: Use Blue / Cyan symbol
    text += `🔹 *المخدومين الحاضرين (${attended.length}):*\n`;
    attended.forEach((s, idx) => {
      text += `${idx + 1}. ${s.name} (${s.code})\n`;
    });

    text += `\n🔸 *المخدومين الغائبين ويحتاجون افتقاد (${absent.length}):*\n`;
    absent.forEach((s, idx) => {
      const phone = s.phoneStudent || s.phoneParent1 || 'بدون هاتف';
      text += `${idx + 1}. ${s.name} (${s.code})\n   📞 ${phone} | ${s.followupStatus || 'لم يفتقد'}\n`;
    });

    if (servantLogs.length > 0) {
      text += `\n📝 *آخر عمليات الافتقاد المسجلة (${servantLogs.length}):*\n`;
      servantLogs.slice(0, 6).forEach((r, idx) => {
        text += `${idx + 1}. ${r.studentName} — ${r.type} (${r.date})${r.notes ? `: ${r.notes}` : ''}\n`;
      });
    }

    text += `\nصلواتكم للخدمة والخدام 🙏`;
    return text;
  }, [selectedServant, students, followupRecords, currentFriday]);

  const handleCopyReport = async () => {
    if (!generatedWhatsAppReport) return;
    try {
      await navigator.clipboard.writeText(generatedWhatsAppReport);
      setCopiedSuccess(true);
      setTimeout(() => setCopiedSuccess(false), 2000);
    } catch {}
  };

  const handleExportFollowupCSV = () => {
    if (filteredRecords.length === 0) return;
    const headers = ['التاريخ', 'أسبوع الجمعة', 'الكود', 'الاسم', 'الأشبين', 'النوع', 'ملاحظات'];
    const rows = filteredRecords.map((r) => [
      r.date,
      r.fridayDate,
      r.studentCode,
      r.studentName,
      r.servant,
      r.type,
      r.notes || ''
    ]);
    downloadCsvReport(headers, rows, `سجل_الافتقاد_${currentFriday}.csv`);
  };

  const handleExportFollowupPDF = () => {
    if (filteredRecords.length === 0) return;
    const headers = ['التاريخ', 'أسبوع الجمعة', 'الكود', 'الاسم', 'الأشبين', 'الوسيلة', 'ملاحظات'];
    const rows = filteredRecords.map((r) => [
      r.date,
      r.fridayDate,
      r.studentCode,
      r.studentName,
      r.servant,
      r.type,
      r.notes || '-'
    ]);
    downloadPrintableHtmlReport(
      'تقرير سجل الافتقاد الشامل',
      `جمعة ${currentFriday} • الأشبين: ${selectedServant || 'الكل'} • السجلات: ${filteredRecords.length}`,
      headers,
      rows,
      `تقرير_الافتقاد_PDF_${currentFriday}.html`
    );
  };

  return (
    <div className="space-y-6 select-none word-in-scope">
      {/* WhatsApp Report Generator Tool for Servants with Liquid Glass */}
      <div
        className="word-in glass-strong p-5 rounded-3xl relative overflow-hidden text-[var(--text-primary)] shadow-[var(--shadow-lg)] border border-[var(--border-color)]"
        style={{ '--i': 0 } as React.CSSProperties}
      >
        <div className="absolute top-0 right-0 w-80 h-32 bg-radial from-[var(--accent-secondary)]/15 via-transparent to-transparent pointer-events-none" />

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 relative z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-base m-0 text-[var(--text-primary)]">
                توليد تقرير WhatsApp للأشابين والخدام
              </h3>
              <p className="text-xs text-[var(--text-muted)] m-0">
                إرسال كشف المخدومين الغائبين والمحتاجين افتقاد بنقرة واحدة
              </p>
            </div>
          </div>

          <div className="min-w-[220px]">
            <select
              value={selectedServant}
              onChange={(e) => setSelectedServant(e.target.value)}
              className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-primary)] text-xs font-bold focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] cursor-pointer shadow-xs"
              aria-label="اختيار الخادم لتقرير واتساب"
            >
              <option value="" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">كل الأشابين والخدام (تقرير شامل)</option>
              {servantsList.map((name) => (
                <option key={name} value={name} className="bg-[var(--surface-primary)] text-[var(--text-primary)]">
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="bg-[var(--surface-primary)]/80 rounded-2xl p-3.5 space-y-3 border border-[var(--border-color)] relative z-10 shadow-xs">
          <div className="max-h-40 overflow-y-auto text-xs font-mono whitespace-pre-wrap leading-relaxed text-[var(--text-primary)] bg-[var(--surface-secondary)]/80 p-3 rounded-xl border border-[var(--border-color)] select-text">
            {generatedWhatsAppReport}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleExportFollowupCSV}
              disabled={filteredRecords.length === 0}
              className="glass-btn px-3 py-2 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-[var(--accent-secondary)]" />
              <span>تصدير Excel (CSV)</span>
            </button>

            <button
              type="button"
              onClick={handleExportFollowupPDF}
              disabled={filteredRecords.length === 0}
              className="glass-btn px-3 py-2 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5 text-[var(--primary)]" />
              <span>طباعة / PDF</span>
            </button>

            <button
              type="button"
              onClick={handleCopyReport}
              className="glass-btn px-3.5 py-2 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              {copiedSuccess ? (
                <span key="copied" className="badge-pop inline-flex items-center gap-1.5 text-[var(--accent-secondary)]">
                  <Check className="w-4 h-4" />
                  <span>تم النسخ!</span>
                </span>
              ) : (
                <span key="copy" className="inline-flex items-center gap-1.5">
                  <Copy className="w-4 h-4 text-[var(--text-muted)]" />
                  <span>نسخ التقرير</span>
                </span>
              )}
            </button>

            {/* Zero Green: Electric Blue & Cyan button for WhatsApp */}
            <a
              href={`https://wa.me/?text=${encodeURIComponent(generatedWhatsAppReport)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="glass-btn--primary btn--lens px-4 py-2 rounded-xl text-white text-xs font-bold flex items-center gap-1.5 border border-[var(--accent-secondary)]/30"
            >
              <MessageSquare className="w-4 h-4 text-white" />
              <span>إرسال عبر WhatsApp</span>
            </a>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar for Followup Ledger */}
      <div
        className="word-in glass p-4 rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow)] grid grid-cols-1 sm:grid-cols-3 gap-3"
        style={{ '--i': 1 } as React.CSSProperties}
      >
        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 text-[var(--accent-secondary)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث في سجل الافتقاد..."
            className="w-full h-10 pr-9 pl-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] transition-all shadow-xs"
          />
        </div>

        {/* Filter Servant */}
        <div>
          <select
            value={selectedServant}
            onChange={(e) => setSelectedServant(e.target.value)}
            className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] cursor-pointer shadow-xs"
            aria-label="تصفية حسب الخادم"
          >
            <option value="" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">جميع الخدام والأشابين</option>
            {servantsList.map((name) => (
              <option key={name} value={name} className="bg-[var(--surface-primary)] text-[var(--text-primary)]">
                {name}
              </option>
            ))}
          </select>
        </div>

        {/* Filter Type */}
        <div>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] cursor-pointer shadow-xs"
            aria-label="تصفية حسب وسيلة الافتقاد"
          >
            <option value="" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">جميع وسائل الافتقاد</option>
            <option value="تم تليفونياً" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">اتصال هاتفي</option>
            <option value="تم بزيارة" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">زيارة منزلية</option>
            <option value="واتساب" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">محادثة واتساب</option>
            <option value="رسالة نصية" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">رسالة SMS</option>
            <option value="اعتذار" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">اعتذار عن الحضور</option>
          </select>
        </div>
      </div>

      {/* Followup Records List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs font-bold text-[var(--text-muted)] px-1">
          <span>سجل العمليات المنفذة ({filteredRecords.length})</span>
          <span className="font-mono text-[var(--accent-secondary)]">جمعة المتابعة: {currentFriday}</span>
        </div>

        {filteredRecords.length === 0 ? (
          <div className="glass p-12 text-center rounded-3xl text-[var(--text-muted)] space-y-2 border border-[var(--border-color)]">
            <HeartHandshake className="w-9 h-9 text-[var(--accent-secondary)] mx-auto opacity-40 animate-pulse" />
            <p className="text-sm font-bold m-0 text-[var(--text-primary)]">لا توجد سجلات افتقاد مطابقة للفلاتر</p>
            <p className="text-xs m-0">
              يمكنك تسجيل افتقاد من أي كارت مخدوم أو اختيار خادم آخر.
            </p>
          </div>
        ) : (
          filteredRecords.map((r, idx) => {
            const studentMatch = students.find((s) => s.id === r.studentId);
            return (
              <div
                key={r.id}
                style={{ '--i': Math.min(idx + 2, 10) } as React.CSSProperties}
                className="word-in glass p-4 rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-[var(--accent-secondary)]/50 transition-all duration-200"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-sm text-[var(--text-primary)]">{r.studentName}</span>
                    <span className="font-mono text-xs font-bold text-[var(--accent-secondary)] bg-[var(--accent-secondary)]/10 px-2 py-0.5 rounded-md border border-[var(--accent-secondary)]/25">
                      {r.studentCode}
                    </span>
                    <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[var(--primary)]/15 text-[var(--primary)] border border-[var(--primary)]/30">
                      {r.type}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    <span className="flex items-center gap-1">
                      <User className="w-3.5 h-3.5 text-[var(--accent-secondary)]" />
                      الأشبين: {r.servant}
                    </span>
                    <span className="flex items-center gap-1 font-mono">
                      <Calendar className="w-3.5 h-3.5 text-[var(--primary)]" />
                      {r.date}
                    </span>
                  </div>

                  {r.notes && (
                    <p className="text-xs text-[var(--text-secondary)] bg-[var(--surface-primary)] p-2.5 rounded-xl m-0 border border-[var(--border-color)]">
                      {r.notes}
                    </p>
                  )}
                </div>

                {studentMatch?.phoneStudent && (
                  <div className="flex items-center gap-2 shrink-0">
                    <a
                      href={`tel:${studentMatch.phoneStudent}`}
                      className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--text-primary)] hover:text-[var(--accent-secondary)] flex items-center gap-1.5"
                    >
                      <Phone className="w-3.5 h-3.5 text-[var(--accent-secondary)]" />
                      <span>اتصال</span>
                    </a>
                    <a
                      href={`https://wa.me/2${studentMatch.phoneStudent.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--accent-secondary)] flex items-center gap-1.5"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>واتساب</span>
                    </a>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
