import { AssistantMessage } from './assistantEngine';
import { generateUUID } from '../utils/uuid';

export interface AssistantSession {
  id: string; // Unique Session ID, e.g. "session_UUID"
  title: string; // Arabic summary / first query snippet or "محادثة جديدة"
  createdAt: number;
  updatedAt: number;
  messages: AssistantMessage[];
}

export const ASSISTANT_SESSIONS_STORAGE_KEY = 'stgorge_assistant_sessions';

export const INITIAL_BOT_TEXT =
  'سلام ونعمة ✝️ أنا المساعد الذكي لفصل الشهيد مارجرجس.\nأفهم بيانات المخدومين والحضور والغياب وأعياد الميلاد والافتقاد، وأقدر أنفذ أوامر واضحة لتسجيل الحضور والغياب والافتقاد الجماعي (مكالمة أو واتساب أو زيارة منزلية)، وأفتح كروت المخدومين للتعديل، مع استخدام قاعدة البيانات المحلية وطابور المزامنة.';

export function createInitialBotMessage(): AssistantMessage {
  return {
    id: `welcome-${generateUUID()}`,
    role: 'bot',
    text: INITIAL_BOT_TEXT,
    actions: [
      { label: 'غير المسجلين', type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' },
      { label: 'الحاضرون اليوم', type: 'prompt', payload: 'مين اللي حضر؟', variant: 'present' },
      { label: 'الغائبون', type: 'prompt', payload: 'مين الغايب؟', variant: 'absent' },
      { label: 'عرض الإحصائيات', type: 'prompt', payload: 'إحصائيات', variant: 'neutral' }
    ],
    timestamp: Date.now()
  };
}

/**
 * Creates a brand-new, clean Assistant Session with its own isolated ID,
 * timestamps, and fresh welcome message.
 */
export function createFreshAssistantSession(): AssistantSession {
  const sessionId = `session_${generateUUID()}`;
  const now = Date.now();
  return {
    id: sessionId,
    title: 'محادثة جديدة',
    createdAt: now,
    updatedAt: now,
    messages: [createInitialBotMessage()]
  };
}

/**
 * Retrieves all stored past assistant sessions from localStorage,
 * ordered by most recently updated first.
 */
export function getStoredAssistantSessions(): AssistantSession[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(ASSISTANT_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (e) {
    console.error('Failed to parse stored assistant sessions:', e);
    return [];
  }
}

/**
 * Saves or updates a session in persistent storage.
 * Note: Only sessions with at least one user interaction are archived to prevent spamming empty sessions.
 */
export function saveAssistantSession(session: AssistantSession): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const hasUserMessage = session.messages.some((m) => m.role === 'user');
    if (!hasUserMessage) return;

    const sessions = getStoredAssistantSessions();
    const existingIndex = sessions.findIndex((s) => s.id === session.id);

    // Compute title if still default
    let updatedTitle = session.title;
    if (updatedTitle === 'محادثة جديدة') {
      const firstUserMsg = session.messages.find((m) => m.role === 'user');
      if (firstUserMsg && firstUserMsg.text.trim()) {
        const text = firstUserMsg.text.trim();
        updatedTitle = text.length > 36 ? `${text.slice(0, 34)}...` : text;
      }
    }

    const updatedSession: AssistantSession = {
      ...session,
      title: updatedTitle,
      updatedAt: Date.now()
    };

    if (existingIndex >= 0) {
      sessions[existingIndex] = updatedSession;
    } else {
      sessions.unshift(updatedSession);
    }

    // Keep history capped at 50 sessions
    const capped = sessions.slice(0, 50);
    localStorage.setItem(ASSISTANT_SESSIONS_STORAGE_KEY, JSON.stringify(capped));
  } catch (e) {
    console.error('Failed to save assistant session:', e);
  }
}

/**
 * Retrieves a single session by its unique ID.
 */
export function getAssistantSessionById(sessionId: string): AssistantSession | undefined {
  const sessions = getStoredAssistantSessions();
  return sessions.find((s) => s.id === sessionId);
}

/**
 * Deletes a session by its unique ID from persistent history.
 */
export function deleteAssistantSession(sessionId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const sessions = getStoredAssistantSessions().filter((s) => s.id !== sessionId);
    localStorage.setItem(ASSISTANT_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.error('Failed to delete assistant session:', e);
  }
}

/**
 * Clears all stored sessions.
 */
export function clearAllAssistantSessions(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(ASSISTANT_SESSIONS_STORAGE_KEY);
    }
  } catch {}
}

/**
 * Checks if a user's query explicitly asks about past chats/history.
 */
export function isExplicitHistoryRequest(query: string): boolean {
  const q = (query || '').toLowerCase().trim();
  const triggers = [
    'المحادثات السابقة',
    'المحادثه السابقه',
    'الجلسات السابقة',
    'الجلسه السابقه',
    'سجل المحادثات',
    'تاريخ المحادثات',
    'المحادثات القديمة',
    'سجل الشات',
    'سجل الاسئلة',
    'تاريخ الشات',
    'السجلات القديمة'
  ];
  return triggers.some((t) => q.includes(t));
}
