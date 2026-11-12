import React, { useState, useEffect } from 'react';
import { Student, APPROVED_SHEETS } from '../../types/student';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { X, UserPlus, Save, AlertCircle } from 'lucide-react';

interface StudentFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  studentToEdit?: Student | null;
}

export const StudentFormModal: React.FC<StudentFormModalProps> = ({
  isOpen,
  onClose,
  studentToEdit
}) => {
  const { addNewStudent, updateStudent, students } = useApp();
  const { isPreviewMode } = useAuth();

  const isEditing = Boolean(studentToEdit);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [servant, setServant] = useState('');
  const [sheet, setSheet] = useState<string>('نشط');
  const [area, setArea] = useState('');
  const [address, setAddress] = useState('');
  const [phoneStudent, setPhoneStudent] = useState('');
  const [phoneParent1, setPhoneParent1] = useState('');
  const [phoneParent2, setPhoneParent2] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [notes, setNotes] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Pre-fill or generate code
  useEffect(() => {
    if (studentToEdit) {
      setName(studentToEdit.name || '');
      setCode(studentToEdit.code || '');
      setServant(studentToEdit.servant || '');
      setSheet(studentToEdit.sourceSheet || 'نشط');
      setArea(studentToEdit.area || '');
      setAddress(studentToEdit.address || '');
      setPhoneStudent(studentToEdit.phoneStudent || '');
      setPhoneParent1(studentToEdit.phoneParent1 || '');
      setPhoneParent2(studentToEdit.phoneParent2 || '');
      setBirthDate(studentToEdit.birthDate || '');
      setNotes(studentToEdit.notes || '');
    } else {
      setName('');
      // Suggest next auto-incremented code
      const nextCodeNum = students.length + 101;
      setCode(`SG-${nextCodeNum}`);
      setServant('');
      setSheet('نشط');
      setArea('الزيتون الغربية');
      setAddress('');
      setPhoneStudent('');
      setPhoneParent1('');
      setPhoneParent2('');
      setBirthDate('');
      setNotes('');
    }
    setErrorMsg('');
  }, [studentToEdit, isOpen, students.length]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (isPreviewMode) {
      setErrorMsg('التطبيق في وضع المعاينة (Preview Mode). يلزم تسجيل الدخول لتعديل أو إضافة مخدومين.');
      return;
    }

    if (!name.trim()) {
      setErrorMsg('يرجى إدخال اسم المخدوم كاملاً.');
      return;
    }

    if (!servant.trim()) {
      setErrorMsg('يرجى تحديد أو إدخال اسم الأشبين المسؤول.');
      return;
    }

    setIsSubmitting(true);

    try {
      if (isEditing && studentToEdit) {
        const success = await updateStudent(studentToEdit.id, {
          name: name.trim(),
          code: code.trim(),
          servant: servant.trim(),
          sourceSheet: sheet,
          area: area.trim(),
          address: address.trim(),
          phoneStudent: phoneStudent.trim(),
          phoneParent1: phoneParent1.trim(),
          phoneParent2: phoneParent2.trim(),
          birthDate: birthDate.trim(),
          notes: notes.trim()
        });

        if (success) {
          onClose();
        } else {
          setErrorMsg('تعذر حفظ التعديلات في قاعدة البيانات المحلية.');
        }
      } else {
        const success = await addNewStudent({
          name: name.trim(),
          code: code.trim(),
          servant: servant.trim(),
          sourceSheet: sheet,
          area: area.trim(),
          address: address.trim(),
          phoneStudent: phoneStudent.trim(),
          phoneParent1: phoneParent1.trim(),
          phoneParent2: phoneParent2.trim(),
          birthDate: birthDate.trim(),
          notes: notes.trim()
        });

        if (success) {
          onClose();
        } else {
          setErrorMsg('تعذر تسجيل المخدوم الجديد في قاعدة البيانات.');
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'حدث خطأ أثناء حفظ البيانات.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none">
      <div className="w-full max-w-lg glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between bg-[var(--surface-primary)]/40">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs">
              {isEditing ? <Save className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
            </div>
            <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0">
              {isEditing ? `تعديل بيانات: ${studentToEdit?.name}` : 'إضافة مخدوم جديد'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-xs sm:text-sm">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 flex items-center gap-2 text-xs font-bold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">اسم المخدوم *</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="الاسم ثلاثي أو رباعي..."
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] shadow-xs"
              />
            </div>

            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">كود المخدوم</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="SG-101"
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-mono font-bold text-[var(--accent-secondary)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] shadow-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">الأشبين المسؤول *</label>
              <input
                type="text"
                required
                value={servant}
                onChange={(e) => setServant(e.target.value)}
                placeholder="اسم الخادم..."
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-1 focus:ring-[var(--border-focus)] shadow-xs"
              />
            </div>

            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">الفصل (Sheet)</label>
              <select
                value={sheet}
                onChange={(e) => setSheet(e.target.value)}
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] cursor-pointer shadow-xs"
              >
                {APPROVED_SHEETS.map((s) => (
                  <option key={s} value={s} className="bg-[var(--surface-primary)] text-[var(--text-primary)]">
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">موبايل الطالب</label>
              <input
                type="tel"
                value={phoneStudent}
                onChange={(e) => setPhoneStudent(e.target.value)}
                placeholder="012xxxxxxxx"
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] shadow-xs"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">ولي الأمر (1)</label>
              <input
                type="tel"
                value={phoneParent1}
                onChange={(e) => setPhoneParent1(e.target.value)}
                placeholder="010xxxxxxxx"
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] shadow-xs"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">ولي الأمر (2)</label>
              <input
                type="tel"
                value={phoneParent2}
                onChange={(e) => setPhoneParent2(e.target.value)}
                placeholder="اختياري"
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] shadow-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">المنطقة السكنية</label>
              <input
                type="text"
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="الزيتون الغربية، طومانباي..."
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] shadow-xs"
              />
            </div>
            <div>
              <label className="block font-bold text-[var(--text-secondary)] mb-1">تاريخ الميلاد</label>
              <input
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] shadow-xs"
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-[var(--text-secondary)] mb-1">العنوان التفصيلي</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="رقم العقار، اسم الشارع، علامة مميزة..."
              className="w-full h-10 px-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] shadow-xs"
            />
          </div>

          <div>
            <label className="block font-bold text-[var(--text-secondary)] mb-1">ملاحظات رعوية</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="ملاحظات حول المتابعة أو الأنشطة أو الموهبة..."
              className="w-full p-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] resize-none shadow-xs"
            />
          </div>

          {/* Footer Actions */}
          <div className="pt-3 border-t border-[var(--border-color)] flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] font-bold text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn--lens px-5 py-2 rounded-xl bg-gradient-to-r from-[var(--primary)] to-[var(--accent-secondary)] text-white font-bold text-xs flex items-center gap-2 hover:brightness-110 transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-[var(--accent-secondary)]/30"
            >
              <Save className="w-4 h-4 text-white" />
              <span>{isSubmitting ? 'جاري الحفظ...' : isEditing ? 'حفظ التعديلات' : 'تسجيل المخدوم'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
