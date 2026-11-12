import React from 'react';
import { useApp } from '../../context/AppContext';
import { CreditCard, Table as TableIcon, PieChart, PhoneCall } from 'lucide-react';

export const NavigationTabs: React.FC = () => {
  const { activeView, setActiveView, filteredStudents } = useApp();

  const tabs = [
    { id: 'cards', label: `كروت المخدومين (${filteredStudents.length})`, icon: CreditCard },
    { id: 'table', label: 'جدول الحضور', icon: TableIcon },
    { id: 'charts', label: 'الإحصائيات الذكية', icon: PieChart },
    { id: 'followup', label: 'سجل الافتقاد', icon: PhoneCall }
  ] as const;

  return (
    <div className="clay-selection-bar flex gap-1.5 p-1.5 mb-5 overflow-x-auto select-none backdrop-blur-xl">
      {tabs.map((tab) => {
        const IconComponent = tab.icon;
        const isActive = activeView === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveView(tab.id)}
            className={`flex-1 min-w-[110px] flex items-center justify-center gap-2 py-2.5 px-3.5 rounded-xl text-xs sm:text-sm font-extrabold transition-all duration-300 cursor-pointer ${
              isActive
                ? 'clay-active-pill shadow-lg scale-100'
                : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-white/5'
            }`}
          >
            <IconComponent className={`w-4 h-4 ${isActive ? 'text-[var(--accent)]' : ''}`} />
            <span className="whitespace-nowrap">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
};
