import React, { useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
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
import { AssistantModal } from './components/modals/AssistantModal';
import { Filter, X, UserPlus, Users, AlertTriangle, RefreshCw, Activity, CheckCircle2, Info } from 'lucide-react';

const SPRING_EASE = [0.34, 1.56, 0.64, 1] as const;

export default function App() {
  const [showSplash, setShowSplash] = useState(true);

  const {
    activeView,
    filteredStudents,
    filters,
    setFilters,
    isAddModalOpen,
    setIsAddModalOpen,
    activeEditingId,
    requestEditStudent,
    cancelEditing,
    students,
    isSidebarCollapsed,
    isInitialLoading,
    isSyncing,
    lastSyncError,
    syncData,
    setIsSyncModalOpen,
    activeToast,
    dismissToast
  } = useApp();

  const [followupStudent, setFollowupStudent] = useState<Student | null>(null);

  // Strict Single Active Edit: source of truth is activeEditingId in AppContext
  const currentEditingStudent = activeEditingId ? students.find((s) => s.id === activeEditingId) || null : null;

  const handleOpenEditStudent = (student: Student) => {
    requestEditStudent(student.id);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-[var(--app-bg)] text-[var(--text-primary)] flex flex-col font-sans transition-colors duration-300 relative overflow-x-clip">
        {/* Liquid Glass Background Orbs (Soft, adaptive) */}
        <div className="fixed -top-40 -right-40 w-96 h-96 rounded-full bg-radial from-[var(--primary)]/15 via-transparent to-transparent blur-3xl pointer-events-none" />
        <div className="fixed top-1/2 -left-48 w-[500px] h-[500px] rounded-full bg-radial from-[var(--accent-secondary)]/10 via-transparent to-transparent blur-3xl pointer-events-none" />
        <div className="fixed -bottom-48 right-1/4 w-[600px] h-[400px] rounded-full bg-radial from-[var(--primary)]/10 via-transparent to-transparent blur-3xl pointer-events-none" />

        {/* Splash Screen */}
        {showSplash && <SplashScreen onDismiss={() => setShowSplash(false)} />}

        {/* Premium Animated Liquid Glass Sidebar (Docked Desktop + Mobile RTL Drawer) */}
        <Sidebar />

        {/* Modals & Panels */}
        <NotificationsPanel />
        <AreaFilterModal />
        <AboutModal />
        <SyncDetailsModal />

        {/* Add Modal & Table-View Edit Modal (Cards view uses Inline Card Edit so all cards stay visible) */}
        <StudentFormModal
          isOpen={isAddModalOpen || (Boolean(currentEditingStudent) && activeView !== 'cards')}
          onClose={() => {
            cancelEditing();
          }}
          studentToEdit={currentEditingStudent}
        />

        {/* Quick Followup Modal */}
        <QuickFollowupModal
          isOpen={Boolean(followupStudent)}
          onClose={() => setFollowupStudent(null)}
          student={followupStudent}
        />

        {/* Smart Assistant Modal (Local Offline-Capable) */}
        <AssistantModal />

        {/* Floating Notification / Guard Toast */}
        <AnimatePresence>
          {activeToast && (
            <motion.div
              key={activeToast.id}
              role="alert"
              initial={{ opacity: 0, y: 24, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 18, scale: 0.94 }}
              transition={{ duration: 0.28, ease: SPRING_EASE }}
              className={`fixed bottom-20 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-md z-[60] glass-strong rounded-2xl p-3.5 border shadow-[0_14px_34px_rgba(3,7,17,0.75)] flex items-start gap-3 ${
                activeToast.type === 'danger'
                  ? 'border-rose-500/50 bg-rose-500/15'
                  : activeToast.type === 'warn'
                  ? 'border-amber-400/50 bg-amber-500/15'
                  : 'border-[#20c7e8]/50 bg-[#20c7e8]/15'
              }`}
            >
              <div className="shrink-0 mt-0.5">
                {activeToast.type === 'danger' || activeToast.type === 'warn' ? (
                  <AlertTriangle className={`w-4 h-4 ${activeToast.type === 'danger' ? 'text-rose-400' : 'text-amber-300'}`} />
                ) : activeToast.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-[#20c7e8]" />
                ) : (
                  <Info className="w-4 h-4 text-[#267aff]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-extrabold text-[var(--text-primary)] m-0">{activeToast.title}</p>
                {activeToast.desc && (
                  <p className="text-[11px] font-semibold text-[var(--text-secondary)] mt-0.5 m-0 leading-relaxed">
                    {activeToast.desc}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={dismissToast}
                aria-label="إغلاق التنبيه"
                className="glass-btn w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Workspace Column aligned beside Docked Desktop Sidebar */}
        <div
          className={`flex-1 flex flex-col transition-[padding] duration-300 ease-out ${
            isSidebarCollapsed ? 'lg:pr-[84px]' : 'lg:pr-[272px]'
          }`}
        >
          {/* Fixed / Sticky TopBar viewport container */}
          <div
            className={`fixed top-0 left-0 right-0 ${
              isSidebarCollapsed ? 'lg:right-[84px]' : 'lg:right-[272px]'
            } z-30 pt-[max(0.5rem,env(safe-area-inset-top))] px-2.5 sm:px-4 pointer-events-none transition-[right] duration-300 ease-out`}
          >
            <TopBar />
          </div>

          {/* Main Content Area with compensated top padding for Fixed TopBar */}
          <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-4 pt-[calc(5.25rem+env(safe-area-inset-top))] pb-28 relative z-10">
            {/* Active Area Filter Banner */}
            {filters.area && (
              <div className="mb-3.5 p-3 rounded-2xl glass border border-[var(--border-color)] flex items-center justify-between text-xs font-bold text-[var(--accent-secondary)] shadow-xs word-in">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-[var(--accent-secondary)]" />
                  <span>تصفية الكروت حسب المنطقة السكنية: <strong className="text-[var(--text-primary)]">{filters.area}</strong></span>
                </div>
                <button
                  type="button"
                  onClick={() => setFilters((p) => ({ ...p, area: '' }))}
                  className="glass-btn px-2.5 py-1 rounded-lg text-rose-400 flex items-center gap-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>إلغاء التصفية</span>
                </button>
              </div>
            )}

            {/* Search & Filter Controls */}
            <div className="word-in" style={{ '--i': 0 } as React.CSSProperties}>
              <SearchFilterBar />
            </div>

            {/* View Switcher Tabs */}
            <div className="mb-4">
              <NavigationTabs />
            </div>

            {/* Authoritative Data Loading / Failure States (Zero Fake/Mock Fallbacks) */}
            {(isInitialLoading || (isSyncing && students.length === 0)) && students.length === 0 ? (
              <div className="glass p-10 text-center rounded-3xl border border-[var(--border-color)] space-y-3 my-4 word-in">
                <RefreshCw className="w-8 h-8 text-[#20c7e8] animate-spin mx-auto" />
                <p className="text-sm font-extrabold text-[var(--text-primary)] m-0">
                  جاري تحميل البيانات الحقيقية من Google Sheets...
                </p>
                <p className="text-xs text-[var(--text-muted)] m-0">
                  يتم الآن سحب أحدث سجلات المخدومين بدون أي بيانات وهمية.
                </p>
              </div>
            ) : students.length === 0 ? (
              <div className="glass p-8 sm:p-10 text-center rounded-3xl border border-rose-500/35 bg-rose-500/[0.06] space-y-4 my-4 word-in">
                <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/35 flex items-center justify-center text-rose-400 mx-auto">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-base font-extrabold text-[var(--text-primary)] m-0">
                    تعذر تحميل البيانات
                  </h3>
                  <p className="text-xs sm:text-sm text-[var(--text-secondary)] max-w-lg mx-auto m-0 leading-relaxed">
                    {lastSyncError || 'تعذر الاتصال بملف Google Sheets ولا توجد نسخة حقيقية محفوظة محلياً على هذا الجهاز.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => syncData('__ALL__')}
                    disabled={isSyncing}
                    className="btn--lens px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#123fce] to-[#267aff] text-white text-xs font-extrabold flex items-center gap-2 cursor-pointer active:scale-95 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>إعادة تحميل من Google Sheets</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsSyncModalOpen(true)}
                    className="glass-btn px-4 py-2.5 rounded-xl text-[var(--text-primary)] text-xs font-bold flex items-center gap-2 cursor-pointer"
                  >
                    <Activity className="w-4 h-4 text-[#20c7e8]" />
                    <span>حالة المزامنة</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Animated View Sections Stage (AnimatePresence + wordIn Spring Choreography) */
              <div className="relative word-in-scope">
                <AnimatePresence mode="wait" initial={false}>
                  {activeView === 'cards' && (
                    <motion.div
                      key="cards"
                      initial={{ opacity: 0, y: 24, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -14, scale: 0.98 }}
                      transition={{ duration: 0.34, ease: SPRING_EASE }}
                      className="space-y-4"
                    >
                      <div className="flex items-center justify-between word-in" style={{ '--i': 0 } as React.CSSProperties}>
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
                            setIsAddModalOpen(true);
                          }}
                          className="glass-btn--primary btn--lens px-4 py-2 rounded-xl text-white text-xs font-extrabold flex items-center gap-2 cursor-pointer border border-[var(--accent-secondary)]/30"
                        >
                          <UserPlus className="w-4 h-4 text-white" />
                          <span>+ إضافة مخدوم</span>
                        </button>
                      </div>

                      {filteredStudents.length === 0 ? (
                        <div className="glass p-12 text-center rounded-3xl text-[var(--text-muted)] space-y-2 border border-[var(--border-color)] word-in">
                          <p className="text-sm font-bold m-0 text-[var(--text-primary)]">لا توجد نتائج مطابقة للفلاتر المحددة</p>
                          <p className="text-xs m-0">
                            يمكنك مسح الفلاتر أو استخدام شريط البحث للعثور على المخدومين.
                          </p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-3 gap-4 word-in-scope min-w-0">
                          {filteredStudents.map((student, idx) => (
                            <div
                              key={student.id}
                              className="word-in min-w-0 w-full"
                              style={{ '--i': Math.min(idx, 8) } as React.CSSProperties}
                            >
                              <StudentCard
                                student={student}
                                onOpenFollowup={(s) => setFollowupStudent(s)}
                                onOpenEdit={handleOpenEditStudent}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}

                  {activeView === 'table' && (
                    <motion.div
                      key="table"
                      initial={{ opacity: 0, y: 24, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -14, scale: 0.98 }}
                      transition={{ duration: 0.34, ease: SPRING_EASE }}
                    >
                      <StudentsTableView
                        onOpenFollowup={(s) => setFollowupStudent(s)}
                        onOpenEdit={handleOpenEditStudent}
                      />
                    </motion.div>
                  )}

                  {activeView === 'charts' && (
                    <motion.div
                      key="charts"
                      initial={{ opacity: 0, y: 24, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -14, scale: 0.98 }}
                      transition={{ duration: 0.34, ease: SPRING_EASE }}
                    >
                      <DashboardChartsView />
                    </motion.div>
                  )}

                  {activeView === 'followup' && (
                    <motion.div
                      key="followup"
                      initial={{ opacity: 0, y: 24, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -14, scale: 0.98 }}
                      transition={{ duration: 0.34, ease: SPRING_EASE }}
                    >
                      <FollowupLogView />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </main>
        </div>

        {/* Alphabet Keyboard Dock fixed at bottom */}
        <BottomKeyboardDock />
      </div>
    </MotionConfig>
  );
}
