import React from 'react';
import { useApp } from '../../context/AppContext';
import { MapPin, X } from 'lucide-react';

export const AreaFilterModal: React.FC = () => {
  const { isAreaModalOpen, setIsAreaModalOpen, students, filters, setFilters } = useApp();

  const areaCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    students.forEach((s) => {
      const a = s.area?.trim() || 'غير محددة';
      counts[a] = (counts[a] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [students]);

  if (!isAreaModalOpen) return null;

  const handleSelectArea = (areaName: string) => {
    setFilters((p) => ({ ...p, area: areaName }));
    setIsAreaModalOpen(false);
  };

  const handleClear = () => {
    setFilters((p) => ({ ...p, area: '' }));
    setIsAreaModalOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-md glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col max-h-[85vh] animate-wordIn">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-color)] bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#20c7e8]/10 border border-[#20c7e8]/30 flex items-center justify-center text-[#20c7e8]">
              <MapPin className="w-4 h-4" />
            </div>
            <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0">
              المناطق السكنية لمخدومي الفصل
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setIsAreaModalOpen(false)}
            aria-label="إغلاق نافذة المناطق"
            className="glass-btn w-8 h-8 rounded-xl text-[var(--text-secondary)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Areas List */}
        <div className="p-4 overflow-y-auto flex-1">
          <p className="text-xs text-[var(--text-secondary)] mb-3">
            اضغط على أي منطقة لتصفية الكروت وعرض مخدوميها فوراً:
          </p>

          <div className="grid grid-cols-2 gap-2.5">
            {areaCounts.length === 0 ? (
              <span className="text-xs text-[var(--text-muted)] col-span-2 text-center py-4">
                لا توجد مناطق مسجلة حالياً
              </span>
            ) : (
              areaCounts.map(([areaName, count]) => {
                const isSelected = filters.area === areaName;
                return (
                  <button
                    key={areaName}
                    type="button"
                    onClick={() => handleSelectArea(areaName)}
                    aria-pressed={isSelected}
                    className={`glass-btn p-3 rounded-2xl text-center cursor-pointer ${
                      isSelected ? 'glass-btn--active' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    <strong className="block text-sm font-extrabold mb-1">{areaName}</strong>
                    <span className="text-xs opacity-75 font-semibold text-[#8ecfff]">{count} مخدوم</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-[var(--border-color)] flex justify-between items-center bg-white/[0.02]">
          <button
            type="button"
            onClick={handleClear}
            className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-rose-400 cursor-pointer"
          >
            إلغاء تصفية المنطقة
          </button>

          <button
            type="button"
            onClick={() => setIsAreaModalOpen(false)}
            className="glass-btn px-4 py-1.5 rounded-xl text-xs font-bold text-[var(--text-primary)] cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
