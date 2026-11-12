import React from 'react';
import { useApp } from '../../context/AppContext';
import { Search, RefreshCw, X } from 'lucide-react';
import { SheetName } from '../../types/student';

export const SearchFilterBar: React.FC = () => {
  const { filters, setFilters, syncData, isSyncing, students } = useApp();

  const uniqueServants = React.useMemo(() => {
    const set = new Set<string>();
    students.forEach((s) => {
      const name = s.servant?.trim();
      if (name && name !== 'غير محدد') set.add(name);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [students]);

  return (
    <div className="glass p-3 mb-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-center backdrop-blur-xl border border-[var(--border-color)] shadow-[var(--shadow)]">
      {/* Search Input */}
      <div className="relative">
        <Search className="w-4 h-4 text-[var(--accent-secondary)] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={filters.searchQuery}
          onChange={(e) => setFilters((p) => ({ ...p, searchQuery: e.target.value }))}
          placeholder="بحث بالاسم أو الكود أو الملاحظات..."
          className="w-full h-11 pr-10 pl-8 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs sm:text-sm font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--border-focus)]/20 transition-all shadow-xs"
        />
        {filters.searchQuery && (
          <button
            type="button"
            onClick={() => setFilters((p) => ({ ...p, searchQuery: '' }))}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--accent-secondary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Sheet State Selector */}
      <div className="relative">
        <select
          value={filters.sheet}
          onChange={(e) => setFilters((p) => ({ ...p, sheet: e.target.value as SheetName }))}
          className="w-full h-11 px-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs sm:text-sm font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--border-focus)]/20 cursor-pointer transition-all shadow-xs"
          aria-label="اختيار الشيت"
        >
          <option value="نشط" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">فصل: نشط</option>
          <option value="غير حاضر" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">فصل: غير حاضر</option>
          <option value="فصل البابا شنودة" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">فصل: البابا شنودة</option>
          <option value="__ALL__" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">عرض كل الفصول (الكل)</option>
        </select>
      </div>

      {/* Servant Filter Selector */}
      <div className="relative">
        <select
          value={filters.servant}
          onChange={(e) => setFilters((p) => ({ ...p, servant: e.target.value }))}
          className="w-full h-11 px-3.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs sm:text-sm font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--border-focus)]/20 cursor-pointer transition-all shadow-xs"
          aria-label="فلترة حسب الأشبين"
        >
          <option value="" className="bg-[var(--surface-primary)] text-[var(--text-primary)]">كل الأشابين والخدام</option>
          {uniqueServants.map((name) => (
            <option key={name} value={name} className="bg-[var(--surface-primary)] text-[var(--text-primary)]">
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* Sync Action Button (Liquid Lens Style) */}
      <div>
        <button
          type="button"
          onClick={syncData}
          disabled={isSyncing}
          className="btn--lens w-full h-11 px-4 flex items-center justify-center gap-2 cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 text-xs sm:text-sm font-bold bg-gradient-to-r from-[var(--primary)] to-[var(--accent-secondary)] text-white"
        >
          <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>{isSyncing ? 'جاري المزامنة...' : 'مزامنة السيرفر'}</span>
        </button>
      </div>
    </div>
  );
};
