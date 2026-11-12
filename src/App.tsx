import React, { useState } from 'react';
import { useApp } from './context/AppContext';
import { Student } from './types/student';
import { TopBar } from './components/layout/TopBar';
import { Sidebar } from './components/layout/Sidebar';
import { BottomKeyboardDock } from './components/layout/BottomKeyboardDock';
import { SplashScreen } from './components/layout/SplashScreen';
import { NavigationTabs } from './components/layout/NavigationTabs';
import { SearchFilterBar } from './components/common/SearchFilterBar';
import { NotificationsPanel } from './components/modals/NotificationsPanel';
import { AreaFilterModal } from './components/modals/AreaFilterModal';
import { AboutModal } from './components/modals/AboutModal';
import { SyncDetailsModal } from './components/modals/SyncDetailsModal';
import { StudentCard } from './components/cards/StudentCard';
import { StudentsTableView } from './components/table/StudentsTableView';
import { DashboardChartsView } from './components/charts/DashboardChartsView';
import { FollowupLogView } from './components/followup/FollowupLogView';
import { StudentFormModal } from './components/modals/StudentFormModal';
import { QuickFollowupModal } from './components/modals/QuickFollowupModal';
import { GlassAudioPlayer } from './components/glass/GlassAudioPlayer';
import { Filter, X, UserPlus, Users, Music } from 'lucide-react';

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [showAudioPlayer, setShowAudioPlayer] = useState(false);

  const {
    activeView,
    filteredStudents,
    filters,
    setFilters,
    isAddModalOpen,
    setIsAddModalOpen,
    activeEditingId,
    setActiveEditingId,
    students
  } = useApp();

  const [followupStudent, setFollowupStudent] = useState<Student | null>(null);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);

  // Sync editing student if activeEditingId is set
  const currentEditingStudent = editingStudent || (activeEditingId ? students.find((s) => s.id === activeEditingId) || null : null);

  return (
    <div className="min-h-screen bg-[var(--app-bg)] text-[var(--text-primary)] flex flex-col font-sans transition-colors duration-300 relative overflow-x-hidden">
      {/* Liquid Glass Background Orbs (Soft, adaptive) */}
      <div className="fixed -top-40 -right-40 w-96 h-96 rounded-full bg-radial from-[var(--primary)]/15 via-transparent to-transparent blur-3xl pointer-events-none" />
      <div className="fixed top-1/2 -left-48 w-[500px] h-[500px] rounded-full bg-radial from-[var(--accent-secondary)]/10 via-transparent to-transparent blur-3xl pointer-events-none" />
      <div className="fixed -bottom-48 right-1/4 w-[600px] h-[400px] rounded-full bg-radial from-[var(--primary)]/10 via-transparent to-transparent blur-3xl pointer-events-none" />

      {/* Splash Screen */}
      {showSplash && <SplashScreen onDismiss={() => setShowSplash(false)} />}

      {/* Top Bar Header */}
      <TopBar />

      {/* Sidebar Drawer */}
      <Sidebar />

      {/* Modals & Panels */}
      <NotificationsPanel />
      <AreaFilterModal />
      <AboutModal />
      <SyncDetailsModal />

      {/* Add / Edit Student Modal - STRICTLY NO DELETE */}
      <StudentFormModal
        isOpen={isAddModalOpen || Boolean(currentEditingStudent)}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingStudent(null);
          setActiveEditingId(null);
        }}
        studentToEdit={currentEditingStudent}
      />

      {/* Quick Followup Modal */}
      <QuickFollowupModal
        isOpen={Boolean(followupStudent)}
        onClose={() => setFollowupStudent(null)}
        student={followupStudent}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-4 pt-20 pb-28 relative z-10">
        {/* Active Area Filter Banner */}
        {filters.area && (
          <div className="mb-3.5 p-3 rounded-2xl glass border border-[var(--border-color)] flex items-center justify-between text-xs font-bold text-[var(--accent-secondary)] shadow-xs animate-wordIn">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-[var(--accent-secondary)]" />
              <span>تصفية الكروت حسب المنطقة السكنية: <strong className="text-[var(--text-primary)]">{filters.area}</strong></span>
            </div>
            <button
              type="button"
              onClick={() => setFilters((p) => ({ ...p, area: '' }))}
              className="text-rose-500 hover:underline flex items-center gap-1 cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              <span>إلغاء التصفية</span>
            </button>
          </div>
        )}

        {/* Search & Filter Controls */}
        <SearchFilterBar />

        {/* View Switcher Tabs with Audio Player Quick Toggle */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex-1">
            <NavigationTabs />
          </div>

          <button
            type="button"
            onClick={() => setShowAudioPlayer(!showAudioPlayer)}
            className={`px-3.5 py-2 rounded-2xl border text-xs font-bold flex items-center gap-2 transition-all cursor-pointer self-end sm:self-auto ${
              showAudioPlayer
                ? 'btn--lens bg-gradient-to-r from-[var(--primary)] to-[var(--accent-secondary)] text-white border-[var(--accent-secondary)]/50 shadow-xs'
                : 'glass text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent-secondary)]/40 border-[var(--border-color)]'
            }`}
            title="مشغل ألحان وقراءات كنسية"
          >
            <Music className={`w-4 h-4 ${showAudioPlayer ? 'text-[var(--accent-secondary)] animate-bounce' : 'text-[var(--text-muted)]'}`} />
            <span>مشغل الألحان</span>
          </button>
        </div>

        {/* Collapsible Liquid Glass Audio Player */}
        {showAudioPlayer && (
          <div className="mb-5 animate-wordIn">
            <GlassAudioPlayer title="لحن بي إكلوم (إكليل الشهداء) — مارجرجس" duration={185} />
          </div>
        )}

        {/* View Sections */}
        <div className="relative">
          {/* VIEW 1: 3D CARDS VIEW */}
          {activeView === 'cards' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs">
                    <Users className="w-4 h-4" />
                  </div>
                  <h2 className="text-sm sm:text-base font-extrabold text-[var(--text-primary)] m-0">
                    كروت المخدومين ({filteredStudents.length})
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingStudent(null);
                    setIsAddModalOpen(true);
                  }}
                  className="btn--lens px-4 py-2 rounded-xl bg-gradient-to-r from-[var(--primary)] to-[var(--accent-secondary)] text-white text-xs font-extrabold flex items-center gap-2 hover:brightness-110 transition-all cursor-pointer shadow-xs active:scale-95 border border-[var(--accent-secondary)]/30"
                >
                  <UserPlus className="w-4 h-4 text-white" />
                  <span>+ إضافة مخدوم</span>
                </button>
              </div>

              {filteredStudents.length === 0 ? (
                <div className="glass p-12 text-center rounded-3xl text-[var(--text-muted)] space-y-2 border border-[var(--border-color)]">
                  <p className="text-sm font-bold m-0 text-[var(--text-primary)]">لا توجد نتائج مطابقة للفلاتر المحددة</p>
                  <p className="text-xs m-0">
                    يمكنك مسح الفلاتر أو استخدام شريط البحث للعثور على المخدومين.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredStudents.map((student) => (
                    <StudentCard
                      key={student.id}
                      student={student}
                      onOpenFollowup={(s) => setFollowupStudent(s)}
                      onOpenEdit={(s) => {
                        setEditingStudent(s);
                        setActiveEditingId(s.id);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* VIEW 2: DATA TABLE VIEW */}
          {activeView === 'table' && (
            <StudentsTableView
              onOpenFollowup={(s) => setFollowupStudent(s)}
              onOpenEdit={(s) => {
                setEditingStudent(s);
                setActiveEditingId(s.id);
              }}
            />
          )}

          {/* VIEW 3: CHARTS & ANALYTICS VIEW */}
          {activeView === 'charts' && (
            <DashboardChartsView />
          )}

          {/* VIEW 4: FOLLOWUP LOG & WHATSAPP VIEW */}
          {activeView === 'followup' && (
            <FollowupLogView />
          )}
        </div>
      </main>

      {/* Alphabet Keyboard Dock fixed at bottom */}
      <BottomKeyboardDock />
    </div>
  );
}
