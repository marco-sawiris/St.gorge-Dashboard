import React from 'react';
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: ''
    };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
        ? error
        : 'حدث خطأ غير متوقع أثناء عرض الواجهة.';
    return {
      hasError: true,
      errorMessage: msg
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('St. George Dashboard UI ErrorBoundary caught error:', error, info?.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  private handleReload = () => {
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          dir="rtl"
          role="alert"
          className="min-h-screen bg-[var(--app-bg,#030711)] text-[var(--text-primary,#f4f7fc)] flex items-center justify-center p-4"
        >
          <div className="max-w-md w-full glass-strong rounded-3xl p-6 border border-[var(--danger-border)] shadow-2xl space-y-4 text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-[var(--danger-bg)] border border-[var(--danger-border)] flex items-center justify-center text-[var(--danger-text)]">
              <AlertTriangle className="w-7 h-7" />
            </div>

            <div className="space-y-1.5">
              <h1 className="text-lg font-extrabold m-0">
                حدث خطأ غير متوقع في الواجهة
              </h1>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed m-0">
                لا تقلق — جميع بيانات المخدومين وسجل الحضور والعمليات المعلقة في IndexedDB محفوظة بأمان ولن يتم مسح أي بيانات.
              </p>
              {this.state.errorMessage && (
                <p className="text-[11px] font-mono text-[var(--danger-text)] bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded-xl p-2 mt-2 break-words m-0">
                  {this.state.errorMessage}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={this.handleReset}
                className="btn--lens px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#123fce] to-[#1d4ed8] text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>إعادة المحاولة</span>
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="glass-btn px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4 text-[var(--accent-secondary)]" />
                <span>تحديث التطبيق</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
