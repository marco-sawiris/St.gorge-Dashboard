import React, { useState, useMemo, useRef, useEffect } from 'react';
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
import {
  getLatestHeldFridayString,
  getNearestFridayString,
  formatTelHref,
  formatWhatsAppUrl,
  buildUnifiedFollowupRecords,
  classifyFollowupMethod,
  extractFollowupCallOutcome,
  formatFollowupTypeDisplay,
  findStudentForFollowupRecord,
  getCanonicalFollowupStudentKey,
  normalizeArabicText
} from '../../utils/arabicUtils';
import { downloadCsvReport, downloadPrintableHtmlReport } from '../../utils/exportUtils';

export const FollowupLogView: React.FC = () => {
  const { followupRecords, students } = useApp();
  const currentFriday = getNearestFridayString();
  const attendanceFriday = getLatestHeldFridayString();

  const [selectedServant, setSelectedServant] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedSuccess, setCopiedSuccess] = useState<boolean>(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  // Unified non-duplicated followup records combining 'سجل الافتقاد' tab + real student.fu dates
  // (Strictly never turns standalone text notes into followup records)
  const unifiedRecords = useMemo(() => {
    return buildUnifiedFollowupRecords(followupRecords, students);
  }, [followupRecords, students]);

  // Servants list
  const servantsList = useMemo(() => {
    const set = new Set<string>();
    students.forEach((s) => {
      const name = s.servant?.trim();
      if (name && name !== 'غير محدد') set.add(name);
    });
    unifiedRecords.forEach((r) => {
      const name = r.servant?.trim();
      if (name && name !== 'غير محدد') set.add(name);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [students, unifiedRecords]);

  // Filtered records
  const filteredRecords = useMemo(() => {
    const selectedCategory = selectedType ? classifyFollowupMethod(selectedType) : null;
    const normQuery = normalizeArabicText(searchQuery);
    const rawQueryLower = searchQuery.trim().toLowerCase();

    return unifiedRecords.filter((r) => {
      const studentMatch = findStudentForFollowupRecord(r, students);
      const effectiveServant = (r.servant && r.servant !== 'غير محدد' ? r.servant : studentMatch?.servant || '').trim();

      if (selectedServant && effectiveServant !== selectedServant) return false;

      if (selectedType) {
        if (selectedCategory && selectedCategory !== 'other' && selectedCategory !== 'none') {
          if (classifyFollowupMethod(r.type) !== selectedCategory) return false;
        } else if (r.type !== selectedType) {
          return false;
        }
      }

      if (rawQueryLower) {
        const studentNotes = studentMatch?.notes || '';
        const matchNorm =
          (normQuery &&
            (normalizeArabicText(r.studentName).includes(normQuery) ||
              normalizeArabicText(r.studentCode).includes(normQuery) ||
              normalizeArabicText(r.notes).includes(normQuery) ||
              normalizeArabicText(studentNotes).includes(normQuery) ||
              normalizeArabicText(r.type).includes(normQuery) ||
              normalizeArabicText(effectiveServant).includes(normQuery))) ||
          r.studentName.toLowerCase().includes(rawQueryLower) ||
          r.studentCode.toLowerCase().includes(rawQueryLower) ||
          (r.notes || '').toLowerCase().includes(rawQueryLower) ||
          studentNotes.toLowerCase().includes(rawQueryLower) ||
          (r.date || '').toLowerCase().includes(rawQueryLower);
        if (!matchNorm) return false;
      }
      return true;
    });
  }, [unifiedRecords, students, selectedServant, selectedType, searchQuery]);

  // WhatsApp Report Generator (Works for BOTH specific servant OR All Servants Detailed Report)
  const generatedWhatsAppReport = useMemo(() => {
    const formatRecordDetailLine = (r: (typeof unifiedRecords)[number], idx: number) => {
      const stMatch = findStudentForFollowupRecord(r, students);
      const cat = classifyFollowupMethod(r.type);
      const outcome = extractFollowupCallOutcome(r.type, r.callOutcome);
      const methodLabel = formatFollowupTypeDisplay(r.type);
      const outcomeSuffix = cat === 'call' ? ` — نتيجة الاتصال: ${outcome || 'غير مسجل'}` : '';
      const recNote = String(r.notes || '').trim();
      const studentNote = String(stMatch?.notes || '').trim();
      const notesParts: string[] = [];
      if (recNote) notesParts.push(recNote);
      if (studentNote && normalizeArabicText(studentNote) !== normalizeArabicText(recNote)) {
        notesParts.push(`ملاحظة المخدوم: ${studentNote}`);
      }
      const notesStr = notesParts.length > 0 ? ` — ${notesParts.join(' | ')}` : '';
      return `${idx + 1}. ${r.studentName} — ${methodLabel}${outcomeSuffix} (${r.date})${notesStr}\n`;
    };

    if (!selectedServant) {
      const grouped = new Map<string, { total: number; present: number; absent: number; calls: number; visits: number }>();
      students.forEach((s) => {
        const key = s.servant?.trim() || 'غير محدد';
        if (!grouped.has(key)) grouped.set(key, { total: 0, present: 0, absent: 0, calls: 0, visits: 0 });
        const row = grouped.get(key)!;
        row.total++;
        if (s.att && s.att[attendanceFriday]) row.present++;
        else row.absent++;
      });
      unifiedRecords.forEach((r) => {
        const stMatch = findStudentForFollowupRecord(r, students);
        const key = (r.servant && r.servant !== 'غير محدد' ? r.servant : stMatch?.servant)?.trim() || 'غير محدد';
        if (!grouped.has(key)) grouped.set(key, { total: 0, present: 0, absent: 0, calls: 0, visits: 0 });
        const row = grouped.get(key)!;
        const cat = classifyFollowupMethod(r.type);
        if (cat === 'call') row.calls++;
        if (cat === 'visit') row.visits++;
      });

      const distinctStudents = new Set(
        unifiedRecords.map((r) => getCanonicalFollowupStudentKey(r, findStudentForFollowupRecord(r, students)))
      ).size;
      const totalCalls = unifiedRecords.filter((r) => classifyFollowupMethod(r.type) === 'call').length;
      const totalVisits = unifiedRecords.filter((r) => classifyFollowupMethod(r.type) === 'visit').length;

      let text = `✝️ *تقرير الافتقاد الشامل — كل الأشابين*\n`;
      text += `📅 جمعة الحضور: ${attendanceFriday} | أسبوع المتابعة: ${currentFriday}\n`;
      text += `• إجمالي المخدومين: ${students.length} | سجلات الافتقاد: ${unifiedRecords.length} (${distinctStudents} مخدوم)\n`;
      text += `• اتصالات تليفونية: ${totalCalls} | زيارات منزلية: ${totalVisits}\n\n`;
      text += `📋 *ملخص حسب الأشبين:*\n`;
      Array.from(grouped.entries()).forEach(([srv, st], idx) => {
        text += `${idx + 1}. أ/ ${srv}: حضور ${st.present}/${st.total} • غياب ${st.absent} • اتصال ${st.calls} • زيارة ${st.visits}\n`;
      });

      if (unifiedRecords.length > 0) {
        text += `\n📝 *تفاصيل سجلات الافتقاد المسجلة (${unifiedRecords.length}):*\n`;
        unifiedRecords.forEach((r, idx) => {
          text += formatRecordDetailLine(r, idx);
        });
      }

      const studentsWithNotes = students.filter((s) => Boolean(String(s.notes || '').trim()));
      if (studentsWithNotes.length > 0) {
        text += `\n🗒️ *ملاحظات المخدومين المسجلة (${studentsWithNotes.length}):*\n`;
        studentsWithNotes.forEach((s, idx) => {
          text += `${idx + 1}. ${s.name}: ${String(s.notes || '').trim()}\n`;
        });
      }

      text += `\nصلواتكم للخدمة والخدام 🙏`;
      return text;
    }

    const servantStudents = students.filter((s) => s.servant?.trim() === selectedServant);
    const attended = servantStudents.filter((s) => s.att && s.att[attendanceFriday]);
    const absent = servantStudents.filter((s) => !s.att || !s.att[attendanceFriday]);
    const servantLogs = unifiedRecords.filter((r) => {
      const stMatch = findStudentForFollowupRecord(r, students);
      const effSrv = (r.servant && r.servant !== 'غير محدد' ? r.servant : stMatch?.servant || '').trim();
      return effSrv === selectedServant;
    });

    let text = `✝️ *فصل الشهيد مارجرجس - كنيسة العذراء بالزيتون*\n`;
    text += `سلام ونعمة يا أ/ ${selectedServant}،\n`;
    text += `إليك كشف متابعة وافتقاد مخدوميك لجمعة (${attendanceFriday}):\n\n`;

    // Strict zero-green: Use Blue / Cyan symbol
    text += `🔹 *المخدومين الحاضرين (${attended.length}):*\n`;
    attended.forEach((s, idx) => {
      text += `${idx + 1}. ${s.name} (${s.code})${s.notes?.trim() ? ` — ${s.notes.trim()}` : ''}\n`;
    });

    text += `\n🔸 *المخدومين الغائبين ويحتاجون افتقاد (${absent.length}):*\n`;
    absent.forEach((s, idx) => {
      const phone = s.phoneStudent || s.phoneParent1 || 'بدون هاتف';
      const noteText = s.notes?.trim() ? ` | 📝 ${s.notes.trim()}` : '';
      text += `${idx + 1}. ${s.name} (${s.code})\n   📞 ${phone} | ${s.followupStatus || 'لم يفتقد'}${noteText}\n`;
    });

    if (servantLogs.length > 0) {
      text += `\n📝 *عمليات الافتقاد المسجلة (${servantLogs.length}):*\n`;
      servantLogs.forEach((r, idx) => {
        text += formatRecordDetailLine(r, idx);
      });
    }

    const servantStudentsWithNotes = servantStudents.filter((s) => Boolean(String(s.notes || '').trim()));
    if (servantStudentsWithNotes.length > 0) {
      text += `\n🗒️ *ملاحظات المخدومين المسجلة (${servantStudentsWithNotes.length}):*\n`;
      servantStudentsWithNotes.forEach((s, idx) => {
        text += `${idx + 1}. ${s.name}: ${String(s.notes || '').trim()}\n`;
      });
    }

    text += `\nصلواتكم للخدمة والخدام 🙏`;
    return text;
  }, [selectedServant, students, unifiedRecords, currentFriday, attendanceFriday]);

  const handleCopyReport = async () => {
    if (!generatedWhatsAppReport) return;
    try {
      await navigator.clipboard.writeText(generatedWhatsAppReport);
      setCopiedSuccess(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedSuccess(false), 2000);
    } catch {}
  };

  const resolveCombinedNotes = (r: (typeof unifiedRecords)[number], studentNotes?: string) => {
    const recNote = String(r.notes || '').trim();
    const stNote = String(studentNotes || '').trim();
    if (recNote && stNote && normalizeArabicText(recNote) !== normalizeArabicText(stNote)) {
      return `${recNote} | ملاحظات المخدوم: ${stNote}`;
    }
    return recNote || stNote;
  };

  const handleExportFollowupCSV = () => {
    if (filteredRecords.length === 0) return;
    const headers = ['التاريخ', 'أسبوع الجمعة', 'الكود', 'الاسم', 'الأشبين', 'النوع', 'نتيجة الاتصال', 'ملاحظات'];
    const rows = filteredRecords.map((r) => {
      const studentMatch = findStudentForFollowupRecord(r, students);
      const isPhone = classifyFollowupMethod(r.type) === 'call';
      const outcome = extractFollowupCallOutcome(r.type, r.callOutcome);
      return [
        r.date,
        r.fridayDate,
        r.studentCode || studentMatch?.code || '',
        r.studentName,
        r.servant || studentMatch?.servant || 'غير محدد',
        formatFollowupTypeDisplay(r.type),
        outcome || (isPhone ? 'غير مسجل' : '-'),
        resolveCombinedNotes(r, studentMatch?.notes)
      ];
    });
    downloadCsvReport(headers, rows, `سجل_الافتقاد_${currentFriday}.csv`);
  };

  const handleExportFollowupPDF = () => {
    if (filteredRecords.length === 0) return;
    const headers = ['التاريخ', 'أسبوع الجمعة', 'الكود', 'الاسم', 'الأشبين', 'الوسيلة', 'نتيجة الاتصال', 'ملاحظات'];
    const rows = filteredRecords.map((r) => {
      const studentMatch = findStudentForFollowupRecord(r, students);
      const isPhone = classifyFollowupMethod(r.type) === 'call';
      const outcome = extractFollowupCallOutcome(r.type, r.callOutcome);
      return [
        r.date,
        r.fridayDate,
        r.studentCode || studentMatch?.code || '',
        r.studentName,
        r.servant || studentMatch?.servant || 'غير محدد',
        formatFollowupTypeDisplay(r.type),
        outcome || (isPhone ? 'غير مسجل' : '-'),
        resolveCombinedNotes(r, studentMatch?.notes) || '-'
      ];
    });
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
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs shrink-0">
              <Share2 className="w-5 h-5 shrink-0" />
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold text-base m-0 text-[var(--text-primary)] leading-snug">
                توليد تقرير WhatsApp للأشابين والخدام
              </h3>
              <p className="text-xs text-[var(--text-muted)] m-0 leading-snug">
                إرسال كشف المخدومين الغائبين والمحتاجين افتقاد بنقرة واحدة
              </p>
            </div>
          </div>

          <div className="w-full sm:w-auto sm:min-w-[220px]">
            <select
              value={selectedServant}
              onChange={(e) => setSelectedServant(e.target.value)}
              className="w-full min-h-[42px] h-auto py-2 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-primary)] text-xs font-bold focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] cursor-pointer shadow-xs"
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

        <div className="bg-[var(--surface-primary)] rounded-2xl p-3.5 space-y-3.5 border border-[var(--border-color)] relative z-10 shadow-xs">
          <div className="text-xs sm:text-[13px] font-mono whitespace-pre-wrap break-words leading-relaxed text-[var(--text-primary)] bg-[var(--surface-inset)] p-3.5 rounded-xl border border-[var(--border-color)] select-text">
            {generatedWhatsAppReport}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <button
              type="button"
              onClick={handleExportFollowupCSV}
              disabled={filteredRecords.length === 0}
              className="glass-btn w-full min-h-[44px] h-auto px-3 py-2 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center justify-center gap-2 cursor-pointer text-center leading-snug"
            >
              <Download className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span>تصدير Excel (CSV)</span>
            </button>

            <button
              type="button"
              onClick={handleExportFollowupPDF}
              disabled={filteredRecords.length === 0}
              className="glass-btn w-full min-h-[44px] h-auto px-3 py-2 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center justify-center gap-2 cursor-pointer text-center leading-snug"
            >
              <Printer className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
              <span>طباعة / PDF</span>
            </button>

            <button
              type="button"
              onClick={handleCopyReport}
              className="glass-btn w-full min-h-[44px] h-auto px-3 py-2 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center justify-center gap-2 cursor-pointer text-center leading-snug"
            >
              {copiedSuccess ? (
                <span key="copied" className="badge-pop inline-flex items-center justify-center gap-1.5 text-[var(--accent-secondary)]">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>تم النسخ!</span>
                </span>
              ) : (
                <span key="copy" className="inline-flex items-center justify-center gap-1.5">
                  <Copy className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
                  <span>نسخ التقرير</span>
                </span>
              )}
            </button>

            {/* Zero Green: Electric Blue & Cyan button for WhatsApp */}
            <a
              href={`https://wa.me/?text=${encodeURIComponent(generatedWhatsAppReport)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="glass-btn--primary btn--lens w-full min-h-[44px] h-auto px-3 py-2 rounded-xl text-white text-xs font-bold flex items-center justify-center gap-2 border border-[var(--accent-secondary)]/30 text-center leading-snug"
            >
              <MessageSquare className="w-4 h-4 shrink-0 text-white" />
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
        <div className="relative min-w-0">
          <Search className="w-4 h-4 text-[var(--accent-secondary)] absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث في سجل الافتقاد..."
            className="w-full min-h-[42px] h-auto py-2 ps-9 pe-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] transition-all shadow-xs"
          />
        </div>

        {/* Filter Servant */}
        <div className="min-w-0">
          <select
            value={selectedServant}
            onChange={(e) => setSelectedServant(e.target.value)}
            className="w-full min-h-[42px] h-auto py-2 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] cursor-pointer shadow-xs"
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
        <div className="min-w-0">
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="w-full min-h-[42px] h-auto py-2 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] cursor-pointer shadow-xs"
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-[var(--text-muted)] px-1">
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
            const studentMatch = findStudentForFollowupRecord(r, students);
            const methodCategory = classifyFollowupMethod(r.type);
            const isPhoneCall = methodCategory === 'call';
            const resolvedOutcome = extractFollowupCallOutcome(r.type, r.callOutcome);
            const displayCode = r.studentCode || studentMatch?.code || '';
            const studentLinkedNotes = String(studentMatch?.notes || '').trim();
            const hasDistinctStudentNotes =
              Boolean(studentLinkedNotes) &&
              normalizeArabicText(studentLinkedNotes) !== normalizeArabicText(r.notes);

            return (
              <div
                key={r.id}
                style={{ '--i': Math.min(idx + 2, 10) } as React.CSSProperties}
                className="word-in glass p-4 rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-[var(--accent-secondary)]/50 transition-all duration-200"
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-extrabold text-sm text-[var(--text-primary)]">{r.studentName}</span>
                    {displayCode && (
                      <span className="font-mono text-xs font-bold text-[var(--info-text)] bg-[var(--info-bg)] px-2 py-0.5 rounded-md border border-[var(--info-border)]">
                        {displayCode}
                      </span>
                    )}
                    <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[var(--info-bg)] text-[var(--accent-primary)] border border-[var(--info-border)]">
                      {formatFollowupTypeDisplay(r.type)}
                    </span>
                    {(isPhoneCall || resolvedOutcome) && (
                      <span
                        className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${
                          resolvedOutcome === 'تم التواصل'
                            ? 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
                            : resolvedOutcome === 'لم يتم التواصل'
                            ? 'bg-[var(--danger-bg)] text-[var(--danger-text)] border-[var(--danger-border)]'
                            : 'bg-[var(--surface-inset)] text-[var(--text-muted)] border-[var(--border-color)]'
                        }`}
                      >
                        نتيجة الاتصال: {resolvedOutcome || r.callOutcome || 'غير مسجل'}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--text-muted)]">
                    <span className="flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                      <span>الأشبين: {r.servant}</span>
                    </span>
                    <span className="flex items-center gap-1.5 font-mono">
                      <Calendar className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
                      <span>{r.date}</span>
                    </span>
                  </div>

                  {(r.notes || hasDistinctStudentNotes) && (
                    <p className="text-xs text-[var(--text-secondary)] bg-[var(--surface-primary)] p-2.5 rounded-xl m-0 border border-[var(--border-color)] break-words">
                      {r.notes}
                      {r.notes && hasDistinctStudentNotes ? ' · ' : ''}
                      {hasDistinctStudentNotes ? `ملاحظات المخدوم: ${studentLinkedNotes}` : ''}
                    </p>
                  )}
                </div>

                {(() => {
                  const telHref = formatTelHref(studentMatch?.phoneStudent);
                  const waHref = formatWhatsAppUrl(studentMatch?.phoneStudent);
                  if (!telHref && !waHref) return null;
                  return (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {telHref && (
                        <a
                          href={telHref}
                          className="glass-btn min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--text-primary)] hover:text-[var(--accent-secondary)] flex items-center gap-1.5 shrink-0"
                        >
                          <Phone className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                          <span>اتصال</span>
                        </a>
                      )}
                      {waHref && (
                        <a
                          href={waHref}
                          target="_blank"
                          rel="noreferrer"
                          className="glass-btn min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--accent-secondary)] flex items-center gap-1.5 shrink-0"
                        >
                          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                          <span>واتساب</span>
                        </a>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

