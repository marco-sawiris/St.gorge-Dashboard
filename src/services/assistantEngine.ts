import { Student } from '../types/student';
import { FollowupRecord, CallOutcome } from '../types/followup';
import {
  computeMonthlyFollowupSummary,
  getActiveFollowupFridayString,
  getCairoDateParts,
  getLatestHeldFridayString,
  getNearestFridayString,
  normalizeArabicText
} from '../utils/arabicUtils';
import {
  FOLLOWUP_MESSAGE_TEMPLATES,
  FollowupMessageAudience,
  renderFollowupMessageTemplate,
  resolveFollowupClassName,
  resolveFollowupPhoneTarget,
  stripEmojis
} from '../data/followupMessageTemplates';
import { selectFollowupMessage, selectMultipleFollowupMessages } from './followupMessageLibrary';

export interface AssistantAction {
  label: string;
  type: 'prompt' | 'sync' | 'copy' | 'whatsapp';
  payload: string;
  phone?: string;
  variant?: 'primary' | 'present' | 'absent' | 'danger' | 'neutral';
}

export type AssistantCommand =
  | { type: 'markAttendance'; studentId: string; studentName: string; isPresent: boolean; targetFridayDate: string }
  | {
      type: 'markAttendanceBatch';
      entries: Array<{ studentId: string; studentName: string; studentCode: string; fridayDate: string; isPresent: boolean }>;
      isPresent: boolean;
      targetFridayDate: string;
      skippedAlreadyRecordedCount: number;
    }
  | { type: 'openEdit'; studentId: string; studentName: string }
  | {
      type: 'recordFollowupBatch';
      students: Array<{ id: string; name: string }>;
      method: 'تم تليفونياً' | 'واتساب' | 'تم بزيارة';
      weekFridayDate: string;
    };

export type AssistantIntent =
  | 'birthdays'
  | 'birthdayMessage'
  | 'message'
  | 'attendance_unrecorded'
  | 'attendance_bulk_prepare'
  | 'attendance_bulk_confirm'
  | 'attendance_bulk_cancel'
  | 'attendance_comparison'
  | 'attendance_percentage'
  | 'attendance_summary'
  | 'present'
  | 'absent'
  | 'lowAttendance'
  | 'topAttendance'
  | 'followup_contacted'
  | 'followup_not_contacted'
  | 'followup_needs_retry'
  | 'followup_calls'
  | 'followup_recorded'
  | 'followup_mixed'
  | 'followup_log'
  | 'followup_last_student'
  | 'followup_multiple'
  | 'missingFollowup'
  | 'students_count'
  | 'students_list'
  | 'students_active'
  | 'students_inactive'
  | 'students_new'
  | 'students_missing_phones'
  | 'students_missing_data'
  | 'class_list'
  | 'class_students'
  | 'class_attendance'
  | 'class_comparison'
  | 'general_report'
  | 'stats'
  | 'faq'
  | 'chatHistory'
  | 'search'
  | 'help';

export interface AssistantInteractiveAttendanceStudent {
  id: string;
  code: string;
  name: string;
  servant: string;
  sourceSheet: string;
}

export interface AssistantMeta {
  intent: AssistantIntent;
  studentIds?: string[];
  cohortStudentIds?: string[];
  unrecordedStudentIds?: string[];
  targetFriday?: string;
  secondaryFriday?: string;
  followupFriday?: string;
  dateLabel?: string;
  classScope?: string;
  servantScope?: string;
  awaitingServantChoice?: boolean;
  pendingFollowupIntent?: AssistantIntent;
  pendingFollowupTimeframe?: 'today' | 'currentWeek' | 'specificWeek';
  pendingWantsCountOnly?: boolean;
  domain?: 'attendance' | 'followup' | 'students' | 'stats' | 'classes' | 'other';
  interactiveAttendance?: {
    targetFriday: string;
    classScope?: string;
    servantScope?: string;
    students: AssistantInteractiveAttendanceStudent[];
  };
  pendingBulkAttendance?: {
    targetFriday: string;
    isPresent: boolean;
    studentIds: string[];
    classScope?: string;
    servantScope?: string;
  };
  suggestedFollowupTemplateIds?: string[];
  lastFollowupAudience?: FollowupMessageAudience;
  lastFollowupStudentId?: string;
  followupEditableDraft?: string;
  followupPhoneSourceLabel?: string;
  followupPhoneWarning?: string;
  followupOptions?: Array<{
    templateId: string;
    title: string;
    audience: FollowupMessageAudience;
    message: string;
  }>;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'bot';
  text: string;
  copyText?: string;
  whatsappText?: string;
  whatsappPhone?: string;
  actions?: AssistantAction[];
  command?: AssistantCommand;
  meta?: AssistantMeta;
  timestamp: number;
}

export interface AssistantResponse {
  text: string;
  copyText?: string;
  whatsappText?: string;
  whatsappPhone?: string;
  actions?: AssistantAction[];
  command?: AssistantCommand;
  meta?: AssistantMeta;
}

export interface AssistantFaqItem {
  keys: string[];
  answer: string;
}

export const ASSISTANT_FAQ: AssistantFaqItem[] = [
  {
    keys: ['كيف', 'اضيف', 'إضافة', 'مخدوم جديد', 'جديد'],
    answer:
      'لإضافة مخدوم جديد: افتح تبويب «الكروت» واضغط زر «+ إضافة مخدوم» أو من القائمة الجانبية، ثم املأ البيانات واضغط «تسجيل المخدوم» ليُحفظ محلياً ويُرسل لـ Google Sheets عند التزامن.'
  },
  {
    keys: ['تعديل', 'تغيير', 'بيانات', 'كارت واحد', 'قفل التعديل'],
    answer:
      'لتعديل بيانات مخدوم: اقلب الكارت واضغط «تعديل البيانات» أو استخدم أيقونة التعديل في «الجدول». يطبق النظام قاعدة «كارت واحد فقط قيد التعديل» لمنع تعارض التغييرات.'
  },
  {
    keys: ['تسجيل الحضور', 'طريقة تسجيل', 'ازاي اسجل حضور'],
    answer:
      'لتسجيل الحضور: اضغط زر الحضور داخل الكارت أو في الجدول لتحويل الحالة بين «حاضر» و«غائب» لآخر جمعة. يتم الحفظ فوراً في IndexedDB ثم المزامنة مع Google Sheets.'
  },
  {
    keys: ['مسارات', 'شريط', 'حضور شهري', 'تتبع', 'نقاط'],
    answer:
      'يحتوي كل كارت على مسارين:\n• مسار الحضور الشهري (X/4): يعرض عدد مرات حضور الشهر حتى 4 جمعات.\n• مسار الافتقاد: يعرض الحالة الحالية ونتيجة الاتصال وعدد مرات الافتقاد المسجلة، ويمكن النقر عليه لفتح نافذة تسجيل الافتقاد فوراً.'
  },
  {
    keys: ['سجل الافتقاد', 'اتصال تليفوني', 'نتيجة الاتصال'],
    answer:
      'لتسجيل افتقاد: اضغط «افتقاد» على الكارت واختر الوسيلة. عند اختيار «اتصال تليفوني» يلزم تحديد «نتيجة الاتصال» (تم التواصل أو لم يتم التواصل) ثم الحفظ.'
  },
  {
    keys: ['مزامنة', 'جوجل شيت', 'أوفلاين', 'بدون نت'],
    answer:
      'المصدر الأساسي للبيانات هو ملف Google Sheets الحقيقي. يعمل التطبيق بالكامل بدون إنترنت عبر IndexedDB، وعند عودة الاتصال أو الضغط على «مزامنة» تُرفع العمليات المعلقة بالترتيب وتُحدَّث البيانات.'
  },
  {
    keys: ['تصدير', 'اكسل', 'excel', 'csv', 'pdf', 'طباعة'],
    answer:
      'للتصدير والطباعة: من تبويب «الجدول» أو «الافتقاد» يمكنك تنزيل ملف Excel (CSV عربي متوافق بترميز UTF-8 BOM) أو تصدير تقرير HTML/PDF مهيأ للطباعة.'
  },
  {
    keys: ['تصفية', 'فلتر', 'شريط البحث', 'مسح الفلاتر'],
    answer:
      'للبحث والتصفية: استخدم شريط البحث (الاسم، الكود، المنطقة، أو الملاحظات)، واختر الفصل أو الأشبين أو الحرف الأول من لوحة الحروف السفلية.'
  },
  {
    keys: ['ثيم', 'مظهر', 'داكن', 'فاتح', 'الوان'],
    answer:
      'لتغيير المظهر: افتح القائمة الجانبية واضغط على «مظهر وسمة التطبيق» للتبديل بين الثيم الداكن، الخافت (Dim)، والفاتح الزجاجي.'
  },
  {
    keys: ['لوحة الحروف', 'حروف', 'ابجدي'],
    answer:
      'شريط الحروف الأبجدية في أسفل الشاشة يصفّي المخدومين ديناميكياً حسب الحروف الموجودة فعلياً في الأسماء المسجلة مع توحيد الألف (أ/إ/آ).'
  },
  {
    keys: ['حذف', 'مسح طالب', 'ازالة'],
    answer:
      'حذف سجلات المخدومين ممنوع وفق سياسة الخدمة (Zero Delete) لحماية التاريخ الرعوي. لنقل مخدوم من القائمة النشطة يمكنك تعديل حقل «الفصل» إلى «غير نشط» أو «غير حاضر».'
  },
  {
    keys: ['كنيسة', 'زيتون', 'مارجرجس', 'عنوان'],
    answer: 'فصل الشهيد العظيم مارجرجس — كنيسة السيدة العذراء مريم بالزيتون (مرحلة ابتدائي بنين).'
  },
  {
    keys: ['تقرير واتساب', 'واتساب'],
    answer:
      'لتوليد تقرير WhatsApp للأشابين: افتح تبويب «سجل الافتقاد» واختر اسم الأشبين (أو كل الأشابين) للحصول على تقرير جاهز للنسخ أو الإرسال عبر WhatsApp.'
  }
];

export const MESSAGE_TEMPLATES = {
  birthday: [
    '🎂 كل سنة وأنت طيب يا {name}، ربنا يبارك حياتك ويفرح قلبك دايماً في كنيسته، ونفرح بيك في فصل مارجرجس! ✝️💙',
    '🎉 عيد ميلاد سعيد يا {name}! عقبال 100 سنة سعيدة في حضن بابا يسوع، مستنيينك الجمعة الجاية نحتفل بيك! 🕊️✨',
    '🎈 سنة جديدة كلها فرح ونعمة وتفوق يا {name}، صلوات الشهيد مارجرجس تكون معاك وتفرحنا بنجاحك دايماً! 🙏🌟'
  ],
  followup: FOLLOWUP_MESSAGE_TEMPLATES.map((t) => t.template),
  encouragement: [
    'برافو يا {name} 👏 فخورين بالتزامك وحضورك الجميل في فصل مارجرجس، استمر يا بطل والرب يبارك خطواتك! 🌟💙',
    'عاش يا {name} ✝️ حضورك ومشاركتك بيفرحوا الخدمة جداً، ربنا يزيدك نعمة وتفوق في دراستك وحياتك! ✨'
  ],
  congratulations: [
    'ألف مبروك يا {name} 🎉 فرحانين جداً بنجاحك وتفوقك، دايماً من الأوائل بنعمة ربنا يسوع! 🏆💙'
  ],
  prayer: [
    'ربنا معاك يا {name} ويسندك في كل خطوة 🙏 صلوات العذراء مريم والشهيد مارجرجس تحفظك وتديك سلام وفرح ✝️🕊️'
  ],
  general: [
    'سلام ونعمة يا {name} ✝️ بنفكرك بميعاد فصل مارجرجس الجمعة الجاية في كنيسة العذراء بالزيتون، مستنيينك! ⛪💙'
  ]
};

const ARABIC_TO_LATIN_DIGITS: Record<string, string> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9'
};

export function toLatinDigits(input: string): string {
  return String(input || '').replace(/[٠-٩]/g, (ch) => ARABIC_TO_LATIN_DIGITS[ch] ?? ch);
}

export function normalizeAssistantInput(text: string): string {
  return normalizeArabicText(toLatinDigits(text));
}

function shiftIsoDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function isPhoneMethod(method: unknown): boolean {
  const s = normalizeAssistantInput(String(method || ''));
  return s === 'تم تليفونيا' || s === 'اتصال تليفوني' || s === 'اتصال هاتفي' || s.includes('تليفون') || s.includes('هاتف');
}

function formatMethodDisplay(method: unknown): string {
  const raw = String(method || '').trim();
  if (!raw || raw === 'بدون') return 'بدون';
  if (raw === 'تم تليفونياً') return 'اتصال تليفوني';
  return raw;
}

function isEmptyFollowupStatus(value: unknown): boolean {
  const s = String(value || '').trim();
  return !s || s === 'بدون' || s === '-' || s === 'لم يتم' || s === 'لم يتفتقد';
}

export function parseBirthDate(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }

  const normalized = toLatinDigits(String(raw)).trim();
  if (!normalized || normalized === '-' || normalized === 'غير مسجل') return null;

  if (/^\d{4,5}(\.\d+)?$/.test(normalized)) {
    const serial = Number(normalized);
    if (serial >= 20000 && serial <= 80000) {
      const utcMs = Math.round((serial - 25569) * 86400 * 1000);
      const d = new Date(utcMs);
      return isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }

  const isoMatch = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      return new Date(y, m - 1, day);
    }
  }

  const dmyMatch = normalized.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const m = Number(dmyMatch[2]);
    let y = Number(dmyMatch[3]);
    if (y < 100) y += y > 30 ? 1900 : 2000;
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      return new Date(y, m - 1, day);
    }
  }

  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export interface BirthdayMatch {
  student: Student;
  date: Date;
  daysUntil: number;
  day: number;
  month: number;
}

export function getBirthdayStudents(
  students: Student[],
  daysWindow: number = 7,
  referenceDate: Date = new Date(),
  startOffsetDays: number = 0
): BirthdayMatch[] {
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const matches: BirthdayMatch[] = [];

  for (const s of students) {
    const bd = parseBirthDate(s.birthDate);
    if (!bd) continue;

    let nextBd = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
    if (nextBd.getTime() < today.getTime()) {
      nextBd = new Date(today.getFullYear() + 1, bd.getMonth(), bd.getDate());
    }

    const diffDays = Math.round((nextBd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays >= Math.max(0, startOffsetDays) && diffDays <= daysWindow) {
      matches.push({
        student: s,
        date: bd,
        daysUntil: diffDays,
        day: bd.getDate(),
        month: bd.getMonth() + 1
      });
    }
  }

  return matches.sort((a, b) => a.daysUntil - b.daysUntil);
}

export interface ResolvedDateRange {
  kind: 'latestHeldFriday' | 'previousFriday' | 'lastTwoFridays' | 'currentWeek' | 'lastWeek' | 'lastMonth' | 'explicitDate';
  primaryFriday: string;
  secondaryFriday: string;
  followupFriday: string;
  dateList: string[];
  label: string;
  hasExplicitDateMarker: boolean;
}

export function resolveAssistantDateRange(query: string, referenceDate: Date = new Date()): ResolvedDateRange {
  const q = normalizeAssistantInput(query);
  const latestHeld = getLatestHeldFridayString(referenceDate);
  const previousFriday = shiftIsoDays(latestHeld, -7);
  const currentFuWeek = getNearestFridayString(referenceDate);
  const lastFuWeek = shiftIsoDays(currentFuWeek, -7);
  const refParts = getCairoDateParts(referenceDate);

  // Explicit YYYY-MM-DD
  const isoMatch = q.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const dStr = `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    return {
      kind: 'explicitDate',
      primaryFriday: dStr,
      secondaryFriday: shiftIsoDays(dStr, -7),
      followupFriday: dStr,
      dateList: [dStr],
      label: `تاريخ ${dStr}`,
      hasExplicitDateMarker: true
    };
  }

  // Explicit DD/MM/YYYY or D/M
  const dmyFull = q.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (dmyFull) {
    const dStr = `${dmyFull[3]}-${dmyFull[2].padStart(2, '0')}-${dmyFull[1].padStart(2, '0')}`;
    return {
      kind: 'explicitDate',
      primaryFriday: dStr,
      secondaryFriday: shiftIsoDays(dStr, -7),
      followupFriday: dStr,
      dateList: [dStr],
      label: `تاريخ ${dStr}`,
      hasExplicitDateMarker: true
    };
  }

  const dmShort = q.match(/(?:يوم|تاريخ)\s+(\d{1,2})[-/](\d{1,2})\b/);
  if (dmShort) {
    const m = Number(dmShort[2]);
    const day = Number(dmShort[1]);
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      const y = refParts.year;
      const dStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return {
        kind: 'explicitDate',
        primaryFriday: dStr,
        secondaryFriday: shiftIsoDays(dStr, -7),
        followupFriday: dStr,
        dateList: [dStr],
        label: `تاريخ ${dStr}`,
        hasExplicitDateMarker: true
      };
    }
  }

  if (
    q.includes('اخر جمعتين') ||
    q.includes('اخر اسبوعين') ||
    q.includes('الاسبوعين اللي فات') ||
    q.includes('الجمعتين')
  ) {
    return {
      kind: 'lastTwoFridays',
      primaryFriday: latestHeld,
      secondaryFriday: previousFriday,
      followupFriday: currentFuWeek,
      dateList: [previousFriday, latestHeld],
      label: `آخر جمعتين (${previousFriday} و ${latestHeld})`,
      hasExplicitDateMarker: true
    };
  }

  if (
    q.includes('اخر شهر') ||
    q.includes('الشهر ده') ||
    q.includes('هذا الشهر') ||
    q.includes('خلال 30 يوم') ||
    q.includes('خلال شهر')
  ) {
    const fridays = [
      shiftIsoDays(latestHeld, -21),
      shiftIsoDays(latestHeld, -14),
      previousFriday,
      latestHeld
    ];
    return {
      kind: 'lastMonth',
      primaryFriday: latestHeld,
      secondaryFriday: previousFriday,
      followupFriday: currentFuWeek,
      dateList: fridays,
      label: `آخر 4 جمعات (${fridays[0]} → ${latestHeld})`,
      hasExplicitDateMarker: true
    };
  }

  if (
    q.includes('الجمعه السابقه') ||
    q.includes('الجمعه اللي قبل') ||
    q.includes('الجمعه قبل') ||
    q.includes('قبل اللي فات') ||
    q.includes('الاسبوع اللي قبل')
  ) {
    return {
      kind: 'previousFriday',
      primaryFriday: previousFriday,
      secondaryFriday: shiftIsoDays(previousFriday, -7),
      followupFriday: lastFuWeek,
      dateList: [previousFriday],
      label: `الجمعة السابقة (${previousFriday})`,
      hasExplicitDateMarker: true
    };
  }

  if (q.includes('الاسبوع اللي فات') || q.includes('الاسبوع الماضي') || q.includes('الاسبوع السابق')) {
    return {
      kind: 'lastWeek',
      primaryFriday: previousFriday,
      secondaryFriday: shiftIsoDays(previousFriday, -7),
      followupFriday: lastFuWeek,
      dateList: [previousFriday],
      label: `الأسبوع الماضي (${previousFriday})`,
      hasExplicitDateMarker: true
    };
  }

  if (q.includes('الاسبوع ده') || q.includes('هذا الاسبوع')) {
    return {
      kind: 'currentWeek',
      primaryFriday: latestHeld,
      secondaryFriday: previousFriday,
      followupFriday: currentFuWeek,
      dateList: [latestHeld],
      label: `هذا الأسبوع (${latestHeld})`,
      hasExplicitDateMarker: true
    };
  }

  const explicitMarker =
    q.includes('اخر جمعه') ||
    q.includes('الجمعه اللي فات') ||
    q.includes('الجمعه الماضيه') ||
    q.includes('الجمعه الحاليه') ||
    q.includes('الجمعه دي') ||
    q.includes('النهارده') ||
    q.includes('اليوم');

  return {
    kind: 'latestHeldFriday',
    primaryFriday: latestHeld,
    secondaryFriday: previousFriday,
    followupFriday: currentFuWeek,
    dateList: [latestHeld],
    label: `آخر جمعة (${latestHeld})`,
    hasExplicitDateMarker: explicitMarker
  };
}

export interface RegisteredServant {
  name: string;
  normalizedName: string;
  firstName: string;
  studentCount: number;
}

const arabicServantCollator = new Intl.Collator('ar', { sensitivity: 'base' });

export function extractRegisteredServants(students: ReadonlyArray<Student>): RegisteredServant[] {
  const counts = new Map<string, number>();
  for (const s of students) {
    const raw = String(s.servant || '').trim();
    if (!raw || raw === 'غير محدد' || raw === 'غير مسجل' || raw === '-') continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => arabicServantCollator.compare(a, b))
    .map(([name, studentCount]) => {
      const normalizedName = normalizeAssistantInput(name);
      const firstName = normalizedName.split(/\s+/)[0] || normalizedName;
      return { name, normalizedName, firstName, studentCount };
    });
}

export function resolveServantFromQuery(
  query: string,
  servants: ReadonlyArray<RegisteredServant>
): {
  exact?: RegisteredServant;
  matches: RegisteredServant[];
  explicitNameRequested?: string;
} {
  const qNorm = normalizeAssistantInput(query);
  if (!qNorm || servants.length === 0) return { matches: [] };

  // Strip common honorific prefixes ("ا/ ", "استاذ ", "خادم ", "اشبين ") to detect bare or prefixed replies
  const cleanedTokensQuery = qNorm
    .replace(/(?:^|\s)(?:ا|أ|استاذ|أستاذ|خادم|الخادم|اشبين|الأشبين|الاشبين|مخدومين|مخدومي|اولاد|ولاد|عند|بتوع|لـ|ل)\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 1. Exact full servant name present inside query
  const fullMatches = servants.filter(
    (srv) => srv.normalizedName && (qNorm === srv.normalizedName || qNorm.includes(srv.normalizedName))
  );
  if (fullMatches.length === 1) {
    return { exact: fullMatches[0], matches: fullMatches };
  }
  if (fullMatches.length > 1) {
    return { matches: fullMatches };
  }

  // 2. Multi-token match (e.g., "مينا سمير" matching "مينا سمير فانوس")
  const prefixMatches = servants.filter((srv) => {
    const srvTokens = srv.normalizedName.split(/\s+/).filter((t) => t.length >= 2);
    if (srvTokens.length >= 2) {
      const twoToken = `${srvTokens[0]} ${srvTokens[1]}`;
      if (qNorm.includes(twoToken)) return true;
    }
    return false;
  });
  if (prefixMatches.length === 1) {
    return { exact: prefixMatches[0], matches: prefixMatches };
  }
  if (prefixMatches.length > 1) {
    return { matches: prefixMatches };
  }

  // 3. Single first-name token match (only match whole word token in query)
  const qWords = new Set(cleanedTokensQuery.split(/\s+/).filter((w) => w.length >= 2));
  const firstNameMatches = servants.filter((srv) => srv.firstName.length >= 2 && qWords.has(srv.firstName));
  if (firstNameMatches.length === 1) {
    return { exact: firstNameMatches[0], matches: firstNameMatches };
  }
  if (firstNameMatches.length > 1) {
    return { matches: firstNameMatches };
  }

  // 4. Detect explicit named servant phrasing when name wasn't found in registered servants
  const explicitSrvMatch = query.match(
    /(?:^|\s)(?:للأشبين|للأشبن|الأشبين|الاشبين|للخادم|الخادم|ولاد|أولاد|مخدومين|مخدومي)\s+([^\s؟?!,.،]+(?:\s+[^\s؟?!,.،]+){0,1})/
  );
  if (explicitSrvMatch) {
    const candidateRaw = explicitSrvMatch[1].trim();
    const candidateNorm = normalizeAssistantInput(candidateRaw);
    const firstToken = candidateNorm.split(/\s+/)[0] || '';
    const nonServantWords = new Set([
      'اللي',
      'الذين',
      'التي',
      'مين',
      'كل',
      'الفصل',
      'مارجرجس',
      'مفتقدتش',
      'ماتفتقد',
      'ما',
      'لسه',
      'النشطين',
      'غير',
      'الجداد',
      'جداد',
      'ناقص',
      'بدون',
      'هنا'
    ]);
    if (candidateNorm && !nonServantWords.has(candidateNorm) && !nonServantWords.has(firstToken)) {
      return { matches: [], explicitNameRequested: candidateRaw };
    }
  }

  return { matches: [] };
}

export interface ExtractedQueryScope {
  normalizedQuery: string;
  dateRange: ResolvedDateRange;
  classScope?: string;
  unknownClassRequested?: string;
  servantScope?: string;
  ambiguousServantMatches?: RegisteredServant[];
  unknownServantRequested?: string;
  explicitAllServantsRequested?: boolean;
  followupTimeframe: 'today' | 'currentWeek' | 'specificWeek';
  isReferential: boolean;
  wantsCountOnly: boolean;
}

const KNOWN_CLASS_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: 'نشط', aliases: ['فصل نشط', 'الشيت النشط', 'المخدومين النشطين', 'قسم نشط', 'قائمه نشط'] },
  { canonical: 'غير حاضر', aliases: ['فصل غير حاضر', 'شيت غير حاضر', 'قسم غير حاضر', 'فئه غير حاضر'] },
  { canonical: 'فصل البابا شنودة', aliases: ['البابا شنوده', 'فصل البابا شنوده', 'البابا شنودة'] },
  { canonical: 'غير نشط', aliases: ['فصل غير نشط', 'المخدومين غير النشطين', 'غير النشطين', 'شيت غير نشط'] }
];

export function getExistingClasses(students: Student[]): string[] {
  const counts = new Map<string, number>();
  for (const s of students) {
    const cls = String(s.sourceSheet || '').trim();
    if (cls) counts.set(cls, (counts.get(cls) || 0) + 1);
  }
  return Array.from(counts.keys());
}

export function extractQueryScope(
  query: string,
  students: Student[],
  referenceDate: Date = new Date(),
  fallbackServant?: string
): ExtractedQueryScope {
  const q = normalizeAssistantInput(query);
  const dateRange = resolveAssistantDateRange(query, referenceDate);
  const existingClasses = getExistingClasses(students);
  const registeredServants = extractRegisteredServants(students);

  let classScope: string | undefined;
  let unknownClassRequested: string | undefined;

  // Match against dynamically existing classes first
  for (const cls of existingClasses) {
    const normCls = normalizeAssistantInput(cls);
    if (normCls && (q.includes(`فصل ${normCls}`) || q.includes(`شيت ${normCls}`) || q.includes(normCls))) {
      // Guard against "نشط" matching "غير نشط"
      if (normCls === 'نشط' && q.includes('غير نشط')) continue;
      if (normCls === 'حاضر' && q.includes('غير حاضر')) continue;
      classScope = cls;
      break;
    }
  }

  // Fallback check known class aliases
  if (!classScope) {
    for (const entry of KNOWN_CLASS_ALIASES) {
      if (entry.aliases.some((a) => q.includes(normalizeAssistantInput(a)))) {
        const matchExisting = existingClasses.find(
          (c) => normalizeAssistantInput(c) === normalizeAssistantInput(entry.canonical)
        );
        if (matchExisting) {
          classScope = matchExisting;
        } else {
          unknownClassRequested = entry.canonical;
        }
        break;
      }
    }
  }

  // Detect explicit named class after "فصل ..." that wasn't found in loaded sheets
  if (!classScope && !unknownClassRequested) {
    const explicitClassMatch = query.match(/(?:فصل|قسم|مجموعة)\s+([^\s؟?!,.،]+(?:\s+[^\s؟?!,.،]+){0,2})/);
    if (explicitClassMatch) {
      const candidateRaw = explicitClassMatch[1].trim();
      const candidateNorm = normalizeAssistantInput(candidateRaw);
      const ignored = ['الشهيد', 'مارجرجس', 'المخدومين', 'الحضور', 'من الحضور', 'عن الحضور', 'الاول', 'الثاني'];
      if (!ignored.some((ign) => candidateNorm === ign || candidateNorm.startsWith('الحضور') || candidateNorm.startsWith('الغياب'))) {
        const matchedExisting = existingClasses.find(
          (c) =>
            normalizeAssistantInput(c) === candidateNorm ||
            normalizeAssistantInput(c).includes(candidateNorm) ||
            candidateNorm.includes(normalizeAssistantInput(c))
        );
        if (matchedExisting) {
          classScope = matchedExisting;
        } else if (!['الموجوده', 'المتاحه', 'الفصول'].some((w) => candidateNorm.includes(w))) {
          unknownClassRequested = candidateRaw;
        }
      }
    }
  }

  const explicitAllServantsRequested =
    q.includes('كل الاشابين') ||
    q.includes('جميع الاشابين') ||
    q.includes('الخدمه كلها') ||
    q.includes('كل الخدام') ||
    q === 'الكل';

  let servantScope = fallbackServant?.trim() || undefined;
  let ambiguousServantMatches: RegisteredServant[] | undefined;
  let unknownServantRequested: string | undefined;

  if (explicitAllServantsRequested) {
    servantScope = undefined;
  } else {
    // 1. Check explicit label syntax first (compatible with external servant values)
    const servantMatch = query.match(/(?:للأشبين|للأشبن|بالنسبة للأشبين|بالنسبة للأشبن|للخادم|خادم)\s+([^\s؟?!,.،]+(?:\s+[^\s؟?!,.،]+){0,2})/);
    if (servantMatch) {
      const resolvedExplicit = resolveServantFromQuery(servantMatch[1], registeredServants);
      if (resolvedExplicit.exact) {
        servantScope = resolvedExplicit.exact.name;
      } else if (resolvedExplicit.matches.length > 1) {
        ambiguousServantMatches = resolvedExplicit.matches;
      } else {
        const rawCandidate = servantMatch[1].trim();
        const candidateNorm = normalizeAssistantInput(rawCandidate);
        const matchesAny = registeredServants.some((srv) => srv.normalizedName.includes(candidateNorm));
        if (registeredServants.length > 0 && !matchesAny) {
          unknownServantRequested = rawCandidate;
        } else {
          servantScope = rawCandidate;
        }
      }
    } else {
      // 2. Dynamic match against actual servants registered in dataset (e.g. "ولاد ماجد" / "ماجد" / "مينا سمير")
      const resolved = resolveServantFromQuery(query, registeredServants);
      if (resolved.exact) {
        servantScope = resolved.exact.name;
      } else if (resolved.matches.length > 1) {
        ambiguousServantMatches = resolved.matches;
      } else if (resolved.explicitNameRequested) {
        unknownServantRequested = resolved.explicitNameRequested;
      }
    }
  }

  const followupTimeframe: 'today' | 'currentWeek' | 'specificWeek' =
    q.includes('النهارده') || q.includes('اليوم')
      ? 'today'
      : dateRange.kind === 'lastWeek' || dateRange.kind === 'previousFriday' || dateRange.kind === 'explicitDate'
        ? 'specificWeek'
        : 'currentWeek';

  const isReferential =
    /(?:^|\s)(?:فيهم|منهم|الاسماء دي|دول|دي|نفس القائمة|نفس المجموعه|طب مين|وكمان مين|وايه اخبارهم|اخر مره امتي)(?:\s|$)/.test(
      q
    );

  const wantsCountOnly =
    (/(?:^|\s)(?:كم|كام)(?:\s|$)/.test(q) || q.includes('عدد')) &&
    !q.includes('مين') &&
    !q.includes('اسماء') &&
    !q.includes('في الميه');

  return {
    normalizedQuery: q,
    dateRange,
    classScope,
    unknownClassRequested,
    servantScope,
    ambiguousServantMatches,
    unknownServantRequested,
    explicitAllServantsRequested,
    followupTimeframe,
    isReferential,
    wantsCountOnly
  };
}

function getAllHeldFridaysFromStudents(students: Student[], upToDate: string): string[] {
  const set = new Set<string>();
  for (const s of students) {
    if (!s.att) continue;
    for (const d of Object.keys(s.att)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= upToDate && typeof s.att[d] === 'boolean') {
        set.add(d);
      }
    }
  }
  return Array.from(set).sort();
}

export function detectAssistantIntent(query: string, prevMeta?: AssistantMeta | null): AssistantIntent {
  const q = normalizeAssistantInput(query);
  if (!q) return 'help';

  // Message generation intents (including all Arabic follow-up message requests)
  const wantsMessage =
    q.includes('رساله') ||
    q.includes('رسايل') ||
    q.includes('رسائل') ||
    q.includes('مسج') ||
    q.includes('ابعت') ||
    q.includes('تهنئه') ||
    q.includes('تشجيع') ||
    q.includes('صلاه');

  const isDirectFollowupDraftRequest =
    (q.includes('عايز افتقد') ||
      q.includes('اريد افتقاد') ||
      q.includes('عايز افتقده') ||
      q.includes('افتقد الطالب ده') ||
      q.includes('افتقد المخدوم ده') ||
      q.includes('اقترح رساله') ||
      q.includes('اقترح رسايل') ||
      q.includes('اقترح رسائل')) &&
    !q.includes('مين') &&
    !q.includes('كام') &&
    !q.includes('كم') &&
    !q.includes('باقي');

  const isContextualFollowupVariantRequest =
    prevMeta?.intent === 'message' &&
    Boolean(prevMeta?.suggestedFollowupTemplateIds?.length) &&
    (q.includes('مختلفه') ||
      q.includes('تانيه') ||
      q.includes('ثانيه') ||
      q.includes('غيرها') ||
      q.includes('بديل') ||
      q.includes('قصيره') ||
      q.includes('مختصره') ||
      q.includes('لولي الامر') ||
      q.includes('للطالب') ||
      q.includes('للمخدوم') ||
      q.includes('خيارات'));

  if ((q.includes('عيد') || q.includes('ميلاد')) && wantsMessage) {
    return 'birthdayMessage';
  }
  if ((q.includes('عيد') || q.includes('ميلاد') || q.includes('احتفال') || q.includes('مواليد')) && !q.includes('ناقص')) {
    return 'birthdays';
  }
  if (
    (wantsMessage || isDirectFollowupDraftRequest || isContextualFollowupVariantRequest) &&
    !q.includes('كيف') &&
    !q.includes('ازاي') &&
    !q.includes('اتصل')
  ) {
    return 'message';
  }

  // Chat history explicit check
  if (
    q.includes('محادثات سابقه') ||
    q.includes('محادثه سابقه') ||
    q.includes('جلسات سابقه') ||
    q.includes('جلسه سابقه') ||
    q.includes('سجل المحادثات') ||
    q.includes('تاريخ المحادثات') ||
    q.includes('سجل الشات') ||
    q.includes('شات قديم') ||
    q.includes('محادثات قديمه')
  ) {
    return 'chatHistory';
  }

  // Contextual Bulk Attendance Confirmation / Cancellation (only when awaiting confirmation)
  if (prevMeta?.intent === 'attendance_bulk_prepare' && prevMeta.pendingBulkAttendance) {
    const isCancel =
      /^(?:الغاء|إلغاء|الغاء العمليه|لا|تراجع|بلاش|مش دلوقتي|خلاص|الغي|إلغاء التسجيل)$/.test(q) ||
      q.includes('الغاء التسجيل') ||
      q.includes('الغاء العمليه');
    if (isCancel) {
      return 'attendance_bulk_cancel';
    }
    const isConfirm =
      /^(?:تاكيد|تأكيد|اكد|أكد|ايوه|أيوه|ايوة|أيوة|نعم|موافق|تمام|نفذ|ماشي)$/.test(q) ||
      q.startsWith('تاكيد تسجيل') ||
      q.includes('تاكيد التسجيل');
    if (isConfirm) {
      return 'attendance_bulk_confirm';
    }
  }

  // Bulk Attendance Preparation Triggers (always shows confirmation before any write)
  const isExplicitBulkAttendance =
    q.includes('تسجيل الكل حضور') ||
    q.includes('تسجيل الكل غياب') ||
    q.includes('سجل الكل حضور') ||
    q.includes('سجل الكل غياب') ||
    q.includes('تسجيل غير المسجلين حضور') ||
    q.includes('تسجيل غير المسجلين غياب') ||
    q.includes('تسجيل كل غير المسجلين') ||
    q.includes('حضور للكل') ||
    q.includes('غياب للكل');

  const isContextualBulkFollowup =
    prevMeta?.domain === 'attendance' &&
    Boolean((prevMeta.unrecordedStudentIds && prevMeta.unrecordedStudentIds.length > 0) || prevMeta.intent === 'attendance_unrecorded') &&
    (q.includes('خليهم حضور') ||
      q.includes('خليهم غياب') ||
      q.includes('سجلهم حضور') ||
      q.includes('سجلهم غياب') ||
      q.includes('سجلهم كلهم حضور') ||
      q.includes('سجلهم كلهم غياب') ||
      q.includes('خليهم كلهم حضور') ||
      q.includes('خليهم كلهم غياب') ||
      q === 'حضور' ||
      q === 'حاضر' ||
      q === 'حاضرين' ||
      q === 'غياب' ||
      q === 'غائب' ||
      q === 'غائبين');

  if (isExplicitBulkAttendance || isContextualBulkFollowup) {
    return 'attendance_bulk_prepare';
  }

  // HIGHEST PRIORITY ATTENDANCE DOMAIN: Unrecorded attendance/absence
  const isPhoneOrFollowupOrCallContext =
    q.includes('تليفون') ||
    q.includes('موبايل') ||
    q.includes('رقم') ||
    q.includes('بيانات') ||
    q.includes('اتصال') ||
    q.includes('تواصل') ||
    q.includes('افتقاد') ||
    q.includes('افتقد') ||
    q.includes('اتفتقد') ||
    q.includes('متفتقد') ||
    q.includes('كيف') ||
    q.includes('ازاي');

  const hasExplicitUnrecordedCue =
    q.includes('لم تسجل') ||
    q.includes('لم يسجل') ||
    q.includes('لم يتم التسجيل') ||
    q.includes('لم يتم تسجيل') ||
    q.includes('ما سجلش') ||
    q.includes('ماسجلش') ||
    q.includes('متسجلش') ||
    q.includes('ماتسجلش') ||
    q.includes('ما اتسجلش') ||
    q.includes('مسجلش') ||
    q.includes('مش متسجل') ||
    q.includes('مش مسجل') ||
    q.includes('غير مسجل') ||
    q.includes('الغير مسجل') ||
    q.includes('من غير تسجيل') ||
    q.includes('بدون تسجيل') ||
    q.includes('ناقص تسجيل') ||
    q.includes('ناقصه تسجيل') ||
    q.includes('ناقص في التسجيل') ||
    q.includes('مش موجوده في كشف الحضور') ||
    q.includes('مش موجودين في كشف الحضور') ||
    q.includes('مش موجود في كشف الحضور');

  const hasAttendanceRemainingContextualCue =
    prevMeta?.domain === 'attendance' &&
    (q.includes('مين اللي فاضل') ||
      q.includes('مين فاضل') ||
      q.includes('فاضل مين') ||
      q.includes('اللي فاضل') ||
      q.includes('مين اللي باقي') ||
      q.includes('مين باقي') ||
      q.includes('باقي مين') ||
      q.includes('اللي باقي') ||
      q.includes('طب والباقي') ||
      q.includes('ومين الباقي') ||
      q.includes('ومين لسه') ||
      q === 'والباقي' ||
      q === 'مين لسه' ||
      q === 'مين ناقص');

  const asksUnrecordedAttendance =
    !isPhoneOrFollowupOrCallContext &&
    (hasExplicitUnrecordedCue || hasAttendanceRemainingContextualCue);

  if (asksUnrecordedAttendance) {
    return 'attendance_unrecorded';
  }

  // Domain 2: Follow-up & Call Outcomes (checked cleanly in priority order)
  const mentionsCallOutcomeSuccess =
    q.includes('تم التواصل') ||
    q.includes('رد علي الاتصال') ||
    q.includes('اترد عليه') ||
    q.includes('ردوا') ||
    q.includes('اتواصلنا مع') ||
    q.includes('اتكلمنا معاه ورد');

  const mentionsCallOutcomeFail =
    q.includes('لم يتم التواصل') ||
    q.includes('محدش رد') ||
    q.includes('ما ردش') ||
    q.includes('ماردش') ||
    q.includes('لم يرد') ||
    q.includes('ما ردوش') ||
    q.includes('مردش');

  if (mentionsCallOutcomeFail) {
    return 'followup_not_contacted';
  }
  if (mentionsCallOutcomeSuccess && !q.includes('مين ما') && !q.includes('لم يتم التواصل')) {
    return 'followup_contacted';
  }

  if (
    q.includes('متابعه تاني') ||
    q.includes('اعاده اتصال') ||
    q.includes('اعاده متابعه') ||
    q.includes('لسه محتاج متابعه') ||
    q.includes('محتاج متابعه')
  ) {
    return 'followup_needs_retry';
  }

  if (
    q.includes('اكتر من مره') ||
    q.includes('اكثر من مره') ||
    (q.includes('افتقاد') && (q.includes('مكرر') || q.includes('مرتين')))
  ) {
    return 'followup_multiple';
  }

  if (
    (q.includes('اخر مره') && (q.includes('افتقد') || q.includes('افتقاد') || q.includes('اتصل') || q.includes('كلم'))) ||
    q.includes('اخر افتقاد ل')
  ) {
    return 'followup_last_student';
  }

  if (
    q.includes('اتصلنا بيه') ||
    q.includes('اتصلنا بيهم') ||
    q.includes('اتصالات الافتقاد') ||
    q.includes('سجل الاتصالات') ||
    q.includes('المكالمات التليفونيه') ||
    (q.includes('اتصال تليفوني') && !q.includes('كيف') && !q.includes('ازاي'))
  ) {
    return 'followup_calls';
  }

  if (
    (q.includes('سجل الافتقاد') || q.includes('تفاصيل الافتقاد') || q.includes('اعرض الافتقاد')) &&
    !q.includes('كيف') &&
    !q.includes('ازاي')
  ) {
    return 'followup_log';
  }

  const mentionsFollowup =
    q.includes('افتقاد') ||
    q.includes('افتقد') ||
    q.includes('اتفتقد') ||
    q.includes('يفتقد') ||
    q.includes('تفتقد') ||
    q.includes('فتقد') ||
    q.includes('اتكلم') ||
    q.includes('مكلمت') ||
    q.includes('كلمت') ||
    q.includes('تواصلت') ||
    q.includes('باقي عليا') ||
    q.includes('باقي لي') ||
    (prevMeta?.domain === 'followup' && (q.includes('باقي') || q.includes('فاضل') || q.includes('خلصت')));

  const isNegativeOrRemainingFollowup =
    q.includes('نسي') ||
    q.includes('باقي') ||
    q.includes('فاضل') ||
    q.includes('متبقي') ||
    q.includes('لسه') ||
    q.includes('محتاج') ||
    q.includes('ما اتفتقد') ||
    q.includes('متفتقدش') ||
    q.includes('ماتفتقد') ||
    q.includes('ماتفتقدش') ||
    q.includes('ما افتقد') ||
    q.includes('مافتقد') ||
    q.includes('مفتقدت') ||
    q.includes('مفتقدهمش') ||
    q.includes('مفتقدتش') ||
    q.includes('افتقدتش') ||
    q.includes('افتقدهمش') ||
    q.includes('ما اتعمل') ||
    q.includes('معملهمش') ||
    q.includes('ما اتعملهمش') ||
    q.includes('عملتلهمش') ||
    q.includes('معملتلهمش') ||
    q.includes('لم يتم') ||
    q.includes('لم يفتقد') ||
    q.includes('بدون افتقاد') ||
    q.includes('مش متفتقد') ||
    q.includes('لم يتفتقد') ||
    q.includes('ما كلم') ||
    q.includes('مكلمت') ||
    q.includes('كلمتهوش');

  const isDoneFollowupCue =
    (q.includes('خلصت') ||
      (/(?:^|\s)اتعمل(?:ه|هم)(?:\s|$)/.test(q) && !q.includes('ما اتعمل') && !q.includes('اتعملهمش') && !q.includes('اتعملهوش')) ||
      q.includes('افتقدت') ||
      (/(?:^|\s)اتفتقد(?:وا)?(?:\s|$)/.test(q) && !q.includes('ما اتفتقد') && !q.includes('ماتفتقد')) ||
      q.includes('مين اتفتقد') ||
      q.includes('اللي اتفتقد')) &&
    !q.includes('ما افتقد') &&
    !q.includes('مافتقد') &&
    !q.includes('مفتقدت');

  // Combined done + remaining query (e.g. "مين خلصت افتقاده ومين باقي؟" or "اعرض اللي افتقدتهم واللي لسه مفتقدتهمش")
  if (
    mentionsFollowup &&
    isDoneFollowupCue &&
    isNegativeOrRemainingFollowup &&
    /(?:^|\s)(?:ومين|واللي)(?:\s|$)/.test(q) &&
    !q.includes('كيف') &&
    !q.includes('ازاي')
  ) {
    return 'followup_mixed';
  }

  if (mentionsFollowup && isNegativeOrRemainingFollowup) {
    return 'missingFollowup';
  }

  if (
    mentionsFollowup &&
    (isDoneFollowupCue ||
      q.includes('مين افتقدته') ||
      q.includes('مين افتقدتهم') ||
      q.includes('اللي افتقدتهم') ||
      q.includes('تم افتقادهم')) &&
    !q.includes('كيف') &&
    !q.includes('ازاي')
  ) {
    return 'followup_recorded';
  }

  // Domain 5: Classes & Categories
  if (
    (q.includes('قارن') || q.includes('مقارنه')) &&
    (q.includes('فصل') || q.includes('فصول'))
  ) {
    return 'class_comparison';
  }

  if (
    q.includes('ايه الفصول') ||
    q.includes('الفصول الموجوده') ||
    q.includes('قائمه الفصول') ||
    q.includes('ما هي الفصول') ||
    q === 'الفصول'
  ) {
    return 'class_list';
  }

  // Domain 1: Comparison, Percentages, Full Attendance Sheet
  if (
    (q.includes('قارن') || q.includes('مقارنه') || q.includes('الفرق بين')) &&
    (q.includes('جمعه') || q.includes('جمعتين') || q.includes('اسبوع') || q.includes('حضور'))
  ) {
    return 'attendance_comparison';
  }

  if (
    (q.includes('نسبه الحضور') || q.includes('نسبه الغياب') || q.includes('كام في الميه')) &&
    !q.includes('الخدمه') &&
    !q.includes('ملخص')
  ) {
    if (q.includes('فصل')) return 'class_attendance';
    return 'attendance_percentage';
  }

  if (
    q.includes('كشف الحضور') ||
    q.includes('جدول الحضور') ||
    q.includes('اعمل تقرير الحضور')
  ) {
    if (q.includes('تقرير الحضور')) return 'general_report';
    return 'attendance_summary';
  }

  // Class-specific attendance / student list queries
  const mentionsExplicitClassPhrase =
    /(?:فصل\s+(?!الشهيد|مارجرجس)|شيت\s+|قسم\s+)/.test(q) ||
    q.includes('البابا شنوده');

  if (mentionsExplicitClassPhrase && (q.includes('حضور') || q.includes('غياب') || q.includes('غاب') || q.includes('حضر'))) {
    return 'class_attendance';
  }

  if (
    mentionsExplicitClassPhrase &&
    (q.includes('مين') || q.includes('عدد') || q.includes('كام') || q.includes('مخدوم') || q.includes('اسماء')) &&
    !q.includes('موقف الفصل')
  ) {
    return 'class_students';
  }

  // Weak Attendance
  if (
    q.includes('ضعيف') ||
    q.includes('اقل حضور') ||
    q.includes('منقطع') ||
    q.includes('مقصر') ||
    q.includes('اكتر ناس بتغيب') ||
    q.includes('بيغيبوا كتير') ||
    q.includes('حضورهم مش قوي') ||
    q.includes('حضورهم ضعيف') ||
    (q.includes('حضور') && q.includes('مش قوي'))
  ) {
    return 'lowAttendance';
  }

  // Domain 3: Students Data (missing phones, missing data, counts, active/inactive, new, list)
  if (
    (q.includes('تليفون') || q.includes('موبايل') || q.includes('رقم')) &&
    (q.includes('بدون') || q.includes('معندوش') || q.includes('ما عندوش') || q.includes('مفيش') || q.includes('ناقص') || q.includes('مش مسجل') || q.includes('مفيش رقم'))
  ) {
    return 'students_missing_phones';
  }

  if (q.includes('بياناته ناقصه') || q.includes('بيانات ناقصه') || q.includes('حقول ناقصه') || q.includes('معلومات ناقصه')) {
    return 'students_missing_data';
  }

  if (
    (q.includes('مخدوم') || q.includes('اولاد') || q.includes('طلاب')) &&
    (q.includes('جداد') || q.includes('جدد') || q.includes('اخر مخدومين') || q.includes('اتضافوا'))
  ) {
    return 'students_new';
  }

  if (
    (q.includes('غير نشط') || q.includes('المخدومين غير النشطين') || q.includes('غير النشطين') || q.includes('مش نشط')) &&
    (q.includes('مين') || q.includes('مخدوم') || q.includes('اعرض') || q.includes('عدد'))
  ) {
    return 'students_inactive';
  }

  if (
    (q.includes('النشطين') || q.includes('مخدومين نشط')) &&
    (q.includes('مين') || q.includes('اعرض') || q.includes('عدد')) &&
    !q.includes('حضر') &&
    !q.includes('غاب')
  ) {
    return 'students_active';
  }

  if (
    (q.includes('كام مخدوم') ||
      q.includes('كم مخدوم') ||
      q.includes('عدد المخدومين') ||
      q.includes('عدد الاولاد') ||
      q.includes('اجمالي المخدومين')) &&
    !q.includes('حضر') &&
    !q.includes('غاب')
  ) {
    return 'students_count';
  }

  if (
    q.includes('اعرض اسماء المخدومين') ||
    q.includes('كل المخدومين') ||
    q.includes('قائمه المخدومين') ||
    q.includes('هات اسماء المخدومين')
  ) {
    return 'students_list';
  }

  // Absence (checked BEFORE presence because "محضرش" contains "حضر")
  const isAbsenceQuery =
    q.includes('غاب') ||
    q.includes('غائب') ||
    q.includes('غايب') ||
    q.includes('متغيب') ||
    q.includes('تغيب') ||
    q.includes('محضرش') ||
    q.includes('محضرتش') ||
    q.includes('محضروش') ||
    q.includes('ما حضر') ||
    q.includes('ماحضر') ||
    q.includes('مش حاضر') ||
    q.includes('لم يحضر') ||
    q.includes('لم تحضر') ||
    q.includes('لم يحضروا');

  if (isAbsenceQuery && !q.includes('كيف') && !q.includes('ازاي')) {
    return 'absent';
  }

  // Top Attendance
  if (q.includes('افضل') || q.includes('اعلي حضور') || q.includes('منتظم') || q.includes('اكثر حضور') || q.includes('ملتزم')) {
    return 'topAttendance';
  }

  // Domain 4: Reports & Stats (checked BEFORE bare 'حضور' match when user asks for report/posture)
  if (
    q.includes('ملخص الخدمه') ||
    q.includes('تقرير شامل') ||
    q.includes('تقرير الخدمه') ||
    q.includes('ايه اللي محتاج متابعه')
  ) {
    return 'general_report';
  }

  if (
    q.includes('احصائي') ||
    q.includes('موقف الفصل') ||
    q.includes('تقرير عام') ||
    (q.includes('ملخص') && !q.includes('بحث')) ||
    (q.includes('نسبه') && q.includes('افتقاد'))
  ) {
    return 'stats';
  }

  // Presence queries
  const isPresentQuery =
    ((q.includes('حضر') ||
      q.includes('حاضرين') ||
      q.includes('حاضرون') ||
      q.includes('الحضور') ||
      (q.includes('موجود') && (q.includes('مين') || q.includes('اسماء') || q.includes('جمعه')))) &&
      !q.includes('كيف') &&
      !q.includes('ازاي') &&
      !q.includes('طريقه تسجيل'));

  if (isPresentQuery) {
    return 'present';
  }

  // Help / Greeting
  if (q.includes('مساعده') || q.includes('اوامر') || q.includes('تقدر تعمل') || q === 'اهلا' || q === 'سلام') {
    return 'help';
  }

  // FAQ
  if (
    q.includes('كيف') ||
    q.includes('ازاي') ||
    q.includes('طريقه') ||
    q.includes('فين') ||
    q.includes('اين') ||
    q.includes('حذف') ||
    q.includes('مزامنه') ||
    q.includes('ثيم') ||
    q.includes('تصدير') ||
    q.includes('طباعه') ||
    q.includes('مسارات') ||
    q.includes('حروف')
  ) {
    return 'faq';
  }

  return 'search';
}

export function matchFaq(query: string): AssistantFaqItem | null {
  const q = normalizeAssistantInput(query);
  if (!q) return null;

  let best: AssistantFaqItem | null = null;
  let bestScore = 0;

  for (const item of ASSISTANT_FAQ) {
    let score = 0;
    for (const key of item.keys) {
      const normKey = normalizeAssistantInput(key);
      if (normKey && q.includes(normKey)) {
        score += normKey.length > 4 ? 2 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore > 0 ? best : null;
}

function getPreferredPhone(student: Student): string | undefined {
  const raw = student.phoneStudent || student.phoneParent1 || student.phoneParent2 || '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 ? digits : undefined;
}

function findMentionedStudents(query: string, students: Student[]): Student[] {
  const q = normalizeAssistantInput(query)
    .replace(/(?:اخر مره|امتي|امتى|افتقدنا|افتقاد|بيانات|معلومات|تليفون|رقم|حاله|كارت|عن|لـ|ل\s)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (q.length < 2) return [];

  const byCode = students.filter((s) => s.code && q.includes(normalizeAssistantInput(s.code)));
  if (byCode.length > 0) return byCode;

  const exactFull = students.filter((s) => {
    const n = normalizeAssistantInput(s.name);
    return n && (n === q || q.includes(n));
  });
  if (exactFull.length > 0) return exactFull;

  const partial = students.filter((s) => {
    const n = normalizeAssistantInput(s.name);
    if (!n) return false;
    if (n.includes(q)) return true;
    const tokens = q.split(/\s+/).filter((t) => t.length >= 3);
    return tokens.length > 0 && tokens.every((t) => n.includes(t));
  });
  if (partial.length > 0) return partial;

  const loose = students.filter((s) => {
    const parts = normalizeAssistantInput(s.name).split(/\s+/).filter((p) => p.length >= 3);
    return parts.some((p) => q.includes(p));
  });
  return loose;
}

function findMentionedStudent(query: string, students: Student[]): Student | null {
  const list = findMentionedStudents(query, students);
  return list.length > 0 ? list[0] : null;
}

function pickMessageTemplate(query: string): { category: keyof typeof MESSAGE_TEMPLATES; text: string } {
  const q = normalizeAssistantInput(query);
  let category: keyof typeof MESSAGE_TEMPLATES = 'general';

  if (q.includes('عيد') || q.includes('ميلاد') || q.includes('تهنئه ميلاد')) {
    category = 'birthday';
  } else if (q.includes('افتقاد') || q.includes('غياب') || q.includes('غائب')) {
    category = 'followup';
  } else if (q.includes('تشجيع') || q.includes('تحفيز') || q.includes('برافو')) {
    category = 'encouragement';
  } else if (q.includes('مبروك') || q.includes('نجاح') || q.includes('تهنئه')) {
    category = 'congratulations';
  } else if (q.includes('صلاه') || q.includes('صلي')) {
    category = 'prayer';
  }

  const list = MESSAGE_TEMPLATES[category];
  const chosen = list[Math.floor(Math.random() * list.length)] || list[0];
  return { category, text: chosen };
}

function resolveAssistantStudent(target: string, students: Student[]): { student?: Student; matches: Student[] } {
  const normalizedTarget = normalizeAssistantInput(target);
  const exactCode = students.filter((s) => normalizeAssistantInput(s.code || '') === normalizedTarget);
  const exactName = students.filter((s) => normalizeAssistantInput(s.name || '') === normalizedTarget);
  let matches = exactCode.length ? exactCode : exactName;
  if (matches.length === 0) {
    matches = students.filter((s) => {
      const name = normalizeAssistantInput(s.name || '');
      const code = normalizeAssistantInput(s.code || '');
      return (name && (name.includes(normalizedTarget) || normalizedTarget.includes(name))) || code === normalizedTarget;
    });
  }
  return { student: matches.length === 1 ? matches[0] : undefined, matches };
}

export function parseAssistantCommand(
  query: string,
  students: Student[],
  targetFridayDate: string
): AssistantResponse | null {
  const q = normalizeAssistantInput(query);
  if (!q) return null;

  const isQuestionOrNegatedFollowup =
    /^(?:مين|من|اعرض|هات|كم|كام|هل|طب|و(?:اللي|مين)|انا\s+مفتقدتش|مفتقدتش)\b/.test(q) ||
    /(?:ما\s*كلم|مكلمت|كلمتهوش|نسيت|لسه|امتي|امتى|عملتلهمش|معملتلهمش|مفتقدت|افتقدتش|باقي|خلصت|؟|\?)/.test(q);
  const followupMatch = !isQuestionOrNegatedFollowup
    ? query.match(/(?:^|\s)(?:كلمت|اتصلت(?:\s+ب)?|بعت(?:\s+رساله)?\s+واتساب\s+لـ?|بعت\s+واتساب\s+لـ?|زرت|عملت\s+زياره\s+منزليه\s+لـ?)\s+(.+)$/i)
    : null;
  if (followupMatch) {
    const rawTail = followupMatch[1].replace(/[.!؟?]+$/g, '').replace(/^(?:مثلاً|مثلا|أنا|انا|النهارده|النهاردة)\s+/i, '').trim();
    const method: 'تم تليفونياً' | 'واتساب' | 'تم بزيارة' = /واتساب/i.test(query)
      ? 'واتساب'
      : /زرت|زياره\s+منزليه/i.test(query)
      ? 'تم بزيارة'
      : 'تم تليفونياً';
    const targets = rawTail.split(/،|,|\s+و\s*/).map((name) => name.trim()).filter(Boolean);
    const resolved: Student[] = [];
    const problems: string[] = [];
    for (const targetName of targets) {
      const result = resolveAssistantStudent(targetName, students);
      if (!result.student) {
        problems.push(
          result.matches.length > 1
            ? `«${targetName}» اسم غير محدد ويطابق: ${result.matches.slice(0, 4).map((s) => `${s.name} (${s.code})`).join('، ')}`
            : `«${targetName}» غير موجود في البيانات المحملة`
        );
      } else if (!resolved.some((s) => s.id === result.student!.id)) {
        resolved.push(result.student);
      }
    }
    if (problems.length || resolved.length === 0) {
      return {
        text: `لم أسجل أي افتقاد لأن بعض الأسماء تحتاج توضيحًا:\n• ${problems.join('\n• ')}\nاكتب الاسم الكامل أو الكود لكل مخدوم، ثم أعد الأمر.`
      };
    }
    const weekFridayDate = getNearestFridayString();
    const already = resolved.filter((s) => Boolean(s.fu?.[weekFridayDate]));
    const fresh = resolved.filter((s) => !s.fu?.[weekFridayDate]);
    if (fresh.length === 0) {
      return {
        text: `كل الأسماء المحددة لها افتقاد مسجل بالفعل لهذا الأسبوع (${weekFridayDate}):\n${already
          .map((s) => `• ${s.name}: ${s.fu?.[weekFridayDate]}`)
          .join('\n')}\nلم أضف سجلات مكررة.`
      };
    }
    return {
      text: `سأُسجل ${method} للأسماء التالية: ${fresh.map((s) => s.name).join('، ')}.\n${
        already.length ? `تم استبعاد ${already.length} اسم مسجل بالفعل هذا الأسبوع.\n` : ''
      }جارٍ الحفظ...`,
      command: { type: 'recordFollowupBatch', students: fresh.map((s) => ({ id: s.id, name: s.name })), method, weekFridayDate }
    };
  }

  const attendanceMatch = q.match(/^(?:سجل|سجلي|اثبت|اثبتي)\s+(?:الحضور|حضور|الغياب|غياب|حاضر|غائب)\s*(.*)$/);
  const editMatch =
    q.match(/^(?:افتح|فتح)\s+(?:تعديل|كارت للتعديل|الكارت للتعديل)\s*(.*)$/) || q.match(/^عدل بيانات\s+(.+)$/);

  const match = attendanceMatch || editMatch;
  if (!match) return null;

  const isAttendance = Boolean(attendanceMatch);
  const target = String(match[1] || '')
    .replace(/^(?:الولد|المخدوم|الطالب|كارت)\s+/, '')
    .replace(/\s+(?:مرتين|مرة واحدة)$/, '')
    .trim();

  if (!target) {
    return {
      text: isAttendance
        ? 'اكتب اسم المخدوم أو الكود، مثال: «سجل حضور بيشوي عماد». لم يتم تسجيل أي تغيير.'
        : 'اكتب اسم المخدوم أو الكود، مثال: «افتح تعديل كارت بيشوي عماد».'
    };
  }

  const { matches } = resolveAssistantStudent(target, students);

  if (matches.length === 0) {
    return { text: `لم أجد مخدوماً مطابقاً للاسم «${target}». لم يتم تنفيذ أي تغيير؛ جرّب الاسم بالكامل أو الكود.` };
  }
  if (matches.length > 1) {
    return {
      text: `الاسم «${target}» مطابق لأكثر من مخدوم. لم أنفذ أي تغيير لتجنب تسجيله للشخص الخطأ:\n${matches
        .slice(0, 8)
        .map((s, i) => `${i + 1}. ${s.name} — ${s.code} — الأشبين: ${s.servant || 'غير محدد'}`)
        .join('\n')}\nاكتب الاسم بالكامل أو الكود.`
    };
  }

  const student = matches[0];
  if (isAttendance) {
    const isPresent = !/(?:غياب|الغياب|غائب)/.test(q.slice(0, q.indexOf(target)));
    return {
      text: `جارٍ تسجيل ${isPresent ? 'حضور' : 'غياب'} ${student.name} عن ${targetFridayDate}.`,
      command: { type: 'markAttendance', studentId: student.id, studentName: student.name, isPresent, targetFridayDate }
    };
  }

  return {
    text: `هفتح كارت ${student.name} في وضع التعديل. تقدر تعدل البيانات وتحفظ من الكارت نفسه.`,
    command: { type: 'openEdit', studentId: student.id, studentName: student.name }
  };
}

export interface AssistantQueryContext {
  referenceDate?: Date;
  selectedFridayDate?: string;
  classScope?: string | null;
  lastSyncLabel?: string | null;
  lastSyncError?: string | null;
  isSyncing?: boolean;
  isOnline?: boolean;
  pendingMutationsCount?: number;
  followupRecords?: FollowupRecord[];
  servantName?: string | null;
  sessionId?: string;
  sessionMessages?: AssistantMessage[];
  includePastHistory?: boolean;
  pastSessions?: Array<{
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: AssistantMessage[];
  }>;
}

function getPreviousSessionMeta(sessionMessages?: AssistantMessage[]): AssistantMeta | null {
  if (!sessionMessages || sessionMessages.length === 0) return null;
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const m = sessionMessages[i];
    if (m.role === 'bot' && m.meta) return m.meta;
  }
  return null;
}

function isStudentFollowedUpInWeek(
  student: Student,
  weekFriday: string,
  followupRecords: FollowupRecord[]
): { followedUp: boolean; method?: string; callOutcome?: CallOutcome; latestDate?: string } {
  const weekStartDate = shiftIsoDays(weekFriday, -6);
  const sheetMethod = !isEmptyFollowupStatus(student.fu?.[weekFriday]) ? student.fu?.[weekFriday] : undefined;
  const matchingLogs = followupRecords
    .filter((r) => {
      if (!r || isEmptyFollowupStatus(r.type)) return false;
      const matchesStudent =
        r.studentId === student.id ||
        (!r.studentId && Boolean(r.studentCode) && r.studentCode === student.code);
      if (!matchesStudent) return false;
      if (r.fridayDate === weekFriday) return true;
      if (r.date && r.date >= weekStartDate && r.date <= weekFriday && (!r.fridayDate || r.fridayDate === weekFriday)) {
        return true;
      }
      return false;
    })
    .sort((a, b) => (b.date || b.fridayDate || '').localeCompare(a.date || a.fridayDate || ''));

  if (matchingLogs.length > 0) {
    const latest = matchingLogs[0];
    return {
      followedUp: true,
      method: latest.type,
      callOutcome: latest.callOutcome,
      latestDate: latest.date || weekFriday
    };
  }
  if (sheetMethod) {
    const outcome = student.fuOutcomes?.[weekFriday] || student.lastCallOutcome;
    return {
      followedUp: true,
      method: sheetMethod,
      callOutcome: outcome,
      latestDate: student.lastFollowup || weekFriday
    };
  }
  return { followedUp: false };
}

function isStudentFollowedUpToday(
  student: Student,
  todayIso: string,
  followupRecords: FollowupRecord[]
): { followedUpToday: boolean; method?: string; callOutcome?: CallOutcome } {
  const todayLogs = followupRecords.filter((r) => {
    if (!r || isEmptyFollowupStatus(r.type)) return false;
    const matchesStudent =
      r.studentId === student.id ||
      (!r.studentId && Boolean(r.studentCode) && r.studentCode === student.code);
    return matchesStudent && r.date === todayIso;
  });
  if (todayLogs.length > 0) {
    return {
      followedUpToday: true,
      method: todayLogs[0].type,
      callOutcome: todayLogs[0].callOutcome
    };
  }
  if (student.lastFollowup === todayIso && !isEmptyFollowupStatus(student.followupStatus)) {
    return {
      followedUpToday: true,
      method: student.followupStatus,
      callOutcome: student.lastCallOutcome
    };
  }
  return { followedUpToday: false };
}

function buildSyncFootnotes(options?: AssistantQueryContext): string {
  const parts: string[] = [];
  if (options?.lastSyncError) {
    parts.push(`⚠️ تعذر إكمال المزامنة (${options.lastSyncError})؛ النتائج من البيانات المحلية وقد تكون القائمة غير مكتملة لحين تحديث الشيت.`);
  }
  if (options?.pendingMutationsCount && options.pendingMutationsCount > 0) {
    parts.push(`⏳ توجد ${options.pendingMutationsCount} عملية محلية قيد الانتظار للمزامنة مع Google Sheets.`);
  }
  return parts.length > 0 ? `\n\n${parts.join('\n')}` : '';
}

function formatUniqueStudentLine(s: Student, idx: number, extra?: string): string {
  const codePart = s.code ? ` (${s.code})` : '';
  const clsPart = s.sourceSheet ? ` • ${s.sourceSheet}` : '';
  const srvPart = s.servant ? ` • الأشبين: ${s.servant}` : '';
  return `${idx + 1}. ${s.name}${codePart}${clsPart}${srvPart}${extra ? ` — ${extra}` : ''}`;
}

function matchRecordToStudentId(r: FollowupRecord, studentsById: Map<string, Student>, students: Student[]): string {
  if (r.studentId && studentsById.has(r.studentId)) return r.studentId;
  if (r.studentCode) {
    const byCode = students.find((s) => s.code === r.studentCode);
    if (byCode) return byCode.id;
  }
  if (r.studentName) {
    const byName = students.filter((s) => normalizeAssistantInput(s.name) === normalizeAssistantInput(r.studentName));
    if (byName.length === 1) return byName[0].id;
  }
  return r.studentId || r.studentCode || r.studentName;
}

export function processAssistantQuery(
  query: string,
  students: Student[],
  options?: AssistantQueryContext
): AssistantResponse {
  const trimmed = String(query || '').trim();
  const referenceDate = options?.referenceDate || new Date();
  const prevMeta = getPreviousSessionMeta(options?.sessionMessages);
  const registeredServants = extractRegisteredServants(students);
  const scope = extractQueryScope(trimmed, students, referenceDate, options?.servantName || undefined);
  let intent = detectAssistantIntent(trimmed, prevMeta);
  let effectiveFollowupTimeframe = scope.followupTimeframe;
  let effectiveWantsCountOnly = scope.wantsCountOnly;
  let activeServantFilter = scope.servantScope;
  let answeredServantSelection = false;

  // Command execution check first
  const command = parseAssistantCommand(trimmed, students, scope.dateRange.primaryFriday);
  if (command) return command;

  // Handle interactive follow-up reply to "تقصد مخدومين مين؟"
  if (prevMeta?.awaitingServantChoice && registeredServants.length > 0 && intent === 'search') {
    const cleanReply = toLatinDigits(trimmed).trim();
    const numMatch = cleanReply.match(/^(\d+)$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < registeredServants.length) {
        activeServantFilter = registeredServants[idx].name;
        intent = prevMeta.pendingFollowupIntent || 'missingFollowup';
        if (prevMeta.pendingFollowupTimeframe) effectiveFollowupTimeframe = prevMeta.pendingFollowupTimeframe;
        if (typeof prevMeta.pendingWantsCountOnly === 'boolean') effectiveWantsCountOnly = prevMeta.pendingWantsCountOnly;
        answeredServantSelection = true;
      }
    } else if (scope.explicitAllServantsRequested) {
      activeServantFilter = undefined;
      intent = prevMeta.pendingFollowupIntent || 'missingFollowup';
      if (prevMeta.pendingFollowupTimeframe) effectiveFollowupTimeframe = prevMeta.pendingFollowupTimeframe;
      if (typeof prevMeta.pendingWantsCountOnly === 'boolean') effectiveWantsCountOnly = prevMeta.pendingWantsCountOnly;
      answeredServantSelection = true;
    } else if (scope.ambiguousServantMatches && scope.ambiguousServantMatches.length > 1) {
      return {
        text: `الاسم يطابق أكثر من خادم في القائمة؛ تقصد مخدومين مين؟\n\n${scope.ambiguousServantMatches
          .map((srv, idx) => `${idx + 1}. ${srv.name} (${srv.studentCount} مخدوم)`)
          .join('\n')}`,
        actions: scope.ambiguousServantMatches.map((srv) => ({
          label: srv.name,
          type: 'prompt' as const,
          payload: srv.name
        })),
        meta: {
          ...prevMeta,
          intent: prevMeta.pendingFollowupIntent || 'missingFollowup',
          domain: 'followup',
          awaitingServantChoice: true
        }
      };
    } else if (scope.servantScope) {
      activeServantFilter = scope.servantScope;
      intent = prevMeta.pendingFollowupIntent || 'missingFollowup';
      if (prevMeta.pendingFollowupTimeframe) effectiveFollowupTimeframe = prevMeta.pendingFollowupTimeframe;
      if (typeof prevMeta.pendingWantsCountOnly === 'boolean') effectiveWantsCountOnly = prevMeta.pendingWantsCountOnly;
      answeredServantSelection = true;
    }
  }

  // Determine effective date, class, and servant scope with multi-turn attendance context continuity
  const effectiveAttendanceDate = !scope.dateRange.hasExplicitDateMarker
    ? prevMeta?.domain === 'attendance' && prevMeta.targetFriday && /^\d{4}-\d{2}-\d{2}$/.test(prevMeta.targetFriday)
      ? prevMeta.targetFriday
      : options?.selectedFridayDate && /^\d{4}-\d{2}-\d{2}$/.test(options.selectedFridayDate)
        ? options.selectedFridayDate
        : scope.dateRange.primaryFriday
    : scope.dateRange.primaryFriday;

  const effectiveDateLabel =
    effectiveAttendanceDate === scope.dateRange.primaryFriday
      ? scope.dateRange.label
      : prevMeta?.domain === 'attendance' && prevMeta.targetFriday === effectiveAttendanceDate && prevMeta.dateLabel
        ? prevMeta.dateLabel
        : `تاريخ ${effectiveAttendanceDate}`;

  const explicitAllClassesRequested =
    scope.normalizedQuery.includes('كل الفصول') || scope.normalizedQuery.includes('جميع الفصول');

  let effectiveClassScope = scope.classScope;
  if (!effectiveClassScope && !scope.unknownClassRequested && !explicitAllClassesRequested) {
    if (prevMeta?.domain === 'attendance' && prevMeta.classScope) {
      effectiveClassScope = prevMeta.classScope;
    } else if (options?.classScope && options.classScope !== '__ALL__') {
      effectiveClassScope = options.classScope;
    }
  }

  // Persist servantScope across active session follow-up OR attendance turns unless another servant or all-servants is explicitly requested
  if (
    !answeredServantSelection &&
    !activeServantFilter &&
    !scope.explicitAllServantsRequested &&
    !scope.unknownServantRequested &&
    !(scope.ambiguousServantMatches && scope.ambiguousServantMatches.length > 1) &&
    prevMeta?.servantScope &&
    (prevMeta.domain === 'followup' || prevMeta.domain === 'attendance' || scope.isReferential)
  ) {
    activeServantFilter = prevMeta.servantScope;
  }

  const attendanceDomainIntents = new Set<AssistantIntent>([
    'attendance_unrecorded',
    'attendance_bulk_prepare',
    'attendance_bulk_confirm',
    'attendance_bulk_cancel',
    'present',
    'absent',
    'attendance_summary',
    'attendance_percentage',
    'attendance_comparison'
  ]);

  const usingContextualSubset = Boolean(
    scope.isReferential &&
      prevMeta &&
      ((prevMeta.studentIds && prevMeta.studentIds.length > 0) ||
        (prevMeta.cohortStudentIds && prevMeta.cohortStudentIds.length > 0)) &&
      !answeredServantSelection &&
      !attendanceDomainIntents.has(intent)
  );

  let workingStudents = students;
  if (usingContextualSubset && prevMeta) {
    const prefersCohort =
      intent === 'missingFollowup' ||
      intent === 'followup_not_contacted' ||
      (prevMeta.cohortStudentIds && prevMeta.cohortStudentIds.length > 0 && intent === 'followup_recorded');
    const sourceIds =
      prefersCohort && prevMeta.cohortStudentIds?.length
        ? prevMeta.cohortStudentIds
        : prevMeta.studentIds && prevMeta.studentIds.length > 0
        ? prevMeta.studentIds
        : prevMeta.cohortStudentIds || [];
    if (sourceIds.length > 0) {
      const idSet = new Set(sourceIds);
      workingStudents = students.filter((s) => idSet.has(s.id));
    }
  }

  // If no loaded student data yet and intent requires data, report sync/offline state honestly
  const nonDataIntents: AssistantIntent[] = ['faq', 'chatHistory', 'help'];
  if (students.length === 0 && !nonDataIntents.includes(intent)) {
    const faqFallback = intent === 'search' ? matchFaq(trimmed) : null;
    if (faqFallback) return { text: faqFallback.answer, meta: { intent: 'faq', domain: 'other' } };
    if (options?.isSyncing) {
      return {
        text: 'جاري تحميل بيانات المخدومين من Google Sheets الآن. انتظر لحظة ثم أعد الاستعلام.',
        meta: { intent, domain: 'other' }
      };
    }
    if (options?.lastSyncError) {
      return {
        text: `تعذر عرض النتائج لأن المزامنة فشلت ولم يتم تحميل بيانات المخدومين (${options.lastSyncError}). القائمة قد تكون غير مكتملة — اضغط «مزامنة الآن» لإعادة المحاولة.`,
        actions: [{ label: 'مزامنة الآن', type: 'sync', payload: '' }],
        meta: { intent, domain: 'other' }
      };
    }
    return {
      text: 'لا توجد بيانات مخدومين محملة حالياً في التطبيق. اضغط «مزامنة الآن» للاتصال بملف Google Sheets وجلب البيانات الحقيقية أولاً.',
      actions: [{ label: 'مزامنة الآن', type: 'sync', payload: '' }],
      meta: { intent, domain: 'other' }
    };
  }

  // Unknown requested class honest handling (never invent class data)
  if (scope.unknownClassRequested && (intent === 'class_students' || intent === 'class_attendance' || intent === 'attendance_percentage')) {
    const existing = getExistingClasses(students);
    return {
      text: `الفصل المطلوب «${scope.unknownClassRequested}» غير موجود في البيانات المحملة حالياً.\n\nالفصول الموجودة فعلياً في قاعدة البيانات (${existing.length}):\n${existing
        .map((c, i) => `${i + 1}. ${c} (${students.filter((s) => s.sourceSheet === c).length} مخدوم)`)
        .join('\n')}`,
      actions: [{ label: 'عرض الفصول', type: 'prompt', payload: 'إيه الفصول الموجودة؟' }],
      meta: { intent: 'class_list', domain: 'classes' }
    };
  }

  // Unknown requested servant honest handling (never invent servant assignments)
  if (scope.unknownServantRequested && (intent === 'missingFollowup' || intent === 'followup_recorded' || intent === 'followup_mixed')) {
    return {
      text: `لم أجد خادماً باسم «${scope.unknownServantRequested}» في البيانات المحملة حالياً.\n\nالأشابين المسجلون فعلياً (${registeredServants.length}):\n${registeredServants
        .map((srv, idx) => `${idx + 1}. ${srv.name} (${srv.studentCount} مخدوم)`)
        .join('\n')}`,
      actions: registeredServants.map((srv) => ({
        label: srv.name,
        type: 'prompt' as const,
        payload: srv.name
      })),
      meta: {
        intent,
        domain: 'followup',
        awaitingServantChoice: true,
        pendingFollowupIntent: intent,
        pendingFollowupTimeframe: effectiveFollowupTimeframe,
        pendingWantsCountOnly: effectiveWantsCountOnly,
        followupFriday: scope.dateRange.followupFriday
      }
    };
  }

  // Ambiguous short servant name in query (2+ matching registered servants)
  if (
    scope.ambiguousServantMatches &&
    scope.ambiguousServantMatches.length > 1 &&
    (intent === 'missingFollowup' || intent === 'followup_recorded' || intent === 'followup_mixed')
  ) {
    return {
      text: `تقصد مخدومين مين؟\n\n${scope.ambiguousServantMatches
        .map((srv, idx) => `${idx + 1}. ${srv.name} (${srv.studentCount} مخدوم)`)
        .join('\n')}`,
      actions: scope.ambiguousServantMatches.map((srv) => ({
        label: srv.name,
        type: 'prompt' as const,
        payload: srv.name
      })),
      meta: {
        intent,
        domain: 'followup',
        awaitingServantChoice: true,
        pendingFollowupIntent: intent,
        pendingFollowupTimeframe: effectiveFollowupTimeframe,
        pendingWantsCountOnly: effectiveWantsCountOnly,
        followupFriday: scope.dateRange.followupFriday
      }
    };
  }

  // Apply explicit class scope if not contextual
  if (effectiveClassScope && (!usingContextualSubset || attendanceDomainIntents.has(intent))) {
    const classFiltered = workingStudents.filter((s) => s.sourceSheet === effectiveClassScope);
    if (classFiltered.length > 0 || scope.classScope) {
      workingStudents = classFiltered;
    }
  } else if (attendanceDomainIntents.has(intent) && !explicitAllClassesRequested) {
    // Exclude inactive students ("غير نشط") from default active attendance evaluation
    const activeAttendancePool = workingStudents.filter((s) => s.sourceSheet !== 'غير نشط');
    if (activeAttendancePool.length > 0) {
      workingStudents = activeAttendancePool;
    }
  }

  if (activeServantFilter && (!usingContextualSubset || attendanceDomainIntents.has(intent)) && !['class_students', 'class_attendance', 'class_comparison', 'class_list', 'students_count'].includes(intent)) {
    const srvNorm = normalizeAssistantInput(activeServantFilter);
    const matchedSrv = workingStudents.filter((s) => normalizeAssistantInput(s.servant || '') === srvNorm || normalizeAssistantInput(s.servant || '').includes(srvNorm));
    if (matchedSrv.length > 0) {
      workingStudents = matchedSrv;
    }
  }

  const followupRecords = options?.followupRecords || [];
  const studentsById = new Map(students.map((s) => [s.id, s]));
  const syncFootnotes = buildSyncFootnotes(options);

  // If referential query like "آخر مرة إمتى؟" on a previous search/student
  if (usingContextualSubset && intent === 'followup_last_student' && workingStudents.length > 0) {
    const first = workingStudents[0];
    const logs = followupRecords
      .filter((r) => matchRecordToStudentId(r, studentsById, students) === first.id)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (logs.length === 0 && !first.lastFollowup) {
      return {
        text: `لا يوجد أي سجل افتقاد مسجل حتى الآن للمخدوم: ${first.name} (${first.code}).${syncFootnotes}`,
        meta: { intent: 'followup_last_student', domain: 'followup', studentIds: [first.id], cohortStudentIds: [first.id], servantScope: activeServantFilter }
      };
    }
    const latest = logs[0];
    const outcomeText = latest && isPhoneMethod(latest.type) ? ` • نتيجة الاتصال: ${latest.callOutcome || 'غير مسجل'}` : '';
    return {
      text: `📅 آخر افتقاد لـ ${first.name} (${first.code}):\n• التاريخ: ${latest?.date || first.lastFollowup}\n• الوسيلة: ${formatMethodDisplay(latest?.type || first.followupStatus)}${outcomeText}\n• الأشبين: ${latest?.servant || first.servant || 'غير محدد'}${latest?.notes ? `\n• ملاحظات: ${latest.notes}` : ''}${syncFootnotes}`,
      meta: { intent: 'followup_last_student', domain: 'followup', studentIds: [first.id], cohortStudentIds: [first.id], servantScope: activeServantFilter }
    };
  }

  // Interactive Servant Disambiguation for servant-personal follow-up queries when >= 2 servants exist
  const isPersonalFollowupIntent =
    intent === 'missingFollowup' || intent === 'followup_recorded' || intent === 'followup_mixed';
  if (
    isPersonalFollowupIntent &&
    !usingContextualSubset &&
    !activeServantFilter &&
    !scope.explicitAllServantsRequested &&
    !answeredServantSelection
  ) {
    if (registeredServants.length === 0) {
      return {
        text: `⚠️ علاقة الخادم (الأشبين) غير محددة في البيانات المحملة حالياً، ولا يمكن ربط المخدومين بخادم معين دون حقل «الأشبين» في الشيت.${syncFootnotes}`,
        meta: {
          intent,
          domain: 'followup',
          followupFriday: scope.dateRange.followupFriday
        }
      };
    }
    if (registeredServants.length >= 2) {
      const servantListLines = registeredServants
        .map((srv, idx) => `${idx + 1}. ${srv.name} (${srv.studentCount} مخدوم)`)
        .join('\n');
      return {
        text: `تقصد مخدومين مين؟\n\nاختر اسم الخادم / الأشبين من القائمة المسجلة:\n${servantListLines}${syncFootnotes}`,
        actions: [
          ...registeredServants.map((srv) => ({
            label: srv.name,
            type: 'prompt' as const,
            payload: srv.name
          })),
          { label: 'كل الأشابين', type: 'prompt' as const, payload: 'كل الأشابين' }
        ],
        meta: {
          intent,
          domain: 'followup',
          awaitingServantChoice: true,
          pendingFollowupIntent: intent,
          pendingFollowupTimeframe: effectiveFollowupTimeframe,
          pendingWantsCountOnly: effectiveWantsCountOnly,
          followupFriday: scope.dateRange.followupFriday
        }
      };
    }
  }

  // Handle ambiguous bare "مين محضرش؟" when there's no date marker and unrecorded > 0
  if (
    intent === 'absent' &&
    !scope.dateRange.hasExplicitDateMarker &&
    !usingContextualSubset &&
    /^مين\s+(?:ما\s*حضرش|محضرش|مش\s*حاضر)[؟?]*$/.test(scope.normalizedQuery)
  ) {
    const targetFriday = effectiveAttendanceDate;
    const unrecordedCount = workingStudents.filter((s) => typeof s.att?.[targetFriday] !== 'boolean').length;
    const recordedAbsentCount = workingStudents.filter((s) => s.att?.[targetFriday] === false).length;
    if (unrecordedCount > 0) {
      return {
        text: `تقصد الغائبين المسجلين، ولا الأسماء اللي لسه ما سجلتش حضور أو غياب؟\n\nفي ${effectiveDateLabel}:\n• غياب مسجل صراحةً: ${recordedAbsentCount}\n• لم يسجل حضور أو غياب بعد: ${unrecordedCount}`,
        actions: [
          { label: `الغائبون المسجلون (${recordedAbsentCount})`, type: 'prompt', payload: 'مين غاب؟', variant: 'absent' },
          { label: `لم تسجل بعد (${unrecordedCount})`, type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' }
        ],
        meta: {
          intent: 'absent',
          domain: 'attendance',
          targetFriday,
          dateLabel: effectiveDateLabel,
          classScope: effectiveClassScope,
          servantScope: activeServantFilter
        }
      };
    }
  }

  switch (intent) {
    // ========================================================================
    // DOMAIN 1: ATTENDANCE & ABSENCE
    // ========================================================================
    case 'attendance_unrecorded': {
      const targetFriday = effectiveAttendanceDate;
      const unrecorded = workingStudents.filter((s) => typeof s.att?.[targetFriday] !== 'boolean');
      const scopeLabel = [
        effectiveClassScope ? `فصل: ${effectiveClassScope}` : '',
        activeServantFilter ? `الأشبين: ${activeServantFilter}` : ''
      ]
        .filter(Boolean)
        .join(' • ');

      if (unrecorded.length === 0) {
        return {
          text: `✅ الأسماء التي لم يُسجَّل لها حضور أو غياب — ${effectiveDateLabel}${scopeLabel ? ` (${scopeLabel})` : ''} (0): جميع المخدومين النشطين في هذا النطاق (${workingStudents.length}) مسجل لهم حضور أو غياب بالفعل.${syncFootnotes}`,
          meta: {
            intent: 'attendance_unrecorded',
            domain: 'attendance',
            studentIds: [],
            unrecordedStudentIds: [],
            cohortStudentIds: workingStudents.map((s) => s.id),
            targetFriday,
            dateLabel: effectiveDateLabel,
            classScope: effectiveClassScope,
            servantScope: activeServantFilter
          }
        };
      }

      const listLines = unrecorded.map((s, idx) => formatUniqueStudentLine(s, idx)).join('\n');
      const header = `📝 متبقي ${unrecorded.length} مخدومًا لم يتم تسجيل حالتهم حتى الآن (${targetFriday})${scopeLabel ? ` • ${scopeLabel}` : ''}:`;
      return {
        text: `${header}\n\n${listLines}\n\nتحب تسجلهم حضور ولا غياب؟${syncFootnotes}`,
        copyText: unrecorded.map((s) => s.name).join('\n'),
        actions: [
          { label: 'تسجيل الكل حضور', type: 'prompt', payload: 'تسجيل الكل حضور', variant: 'present' },
          { label: 'تسجيل الكل غياب', type: 'prompt', payload: 'تسجيل الكل غياب', variant: 'absent' },
          { label: 'كشف الحضور كامل', type: 'prompt', payload: 'اعرض كشف الحضور كامل', variant: 'neutral' },
          { label: 'الغائبون المسجلون', type: 'prompt', payload: 'مين غاب؟', variant: 'neutral' }
        ],
        meta: {
          intent: 'attendance_unrecorded',
          domain: 'attendance',
          studentIds: unrecorded.map((s) => s.id),
          unrecordedStudentIds: unrecorded.map((s) => s.id),
          cohortStudentIds: workingStudents.map((s) => s.id),
          targetFriday,
          dateLabel: effectiveDateLabel,
          classScope: effectiveClassScope,
          servantScope: activeServantFilter,
          interactiveAttendance: {
            targetFriday,
            classScope: effectiveClassScope,
            servantScope: activeServantFilter,
            students: unrecorded.map((s) => ({
              id: s.id,
              code: s.code,
              name: s.name,
              servant: s.servant || 'غير محدد',
              sourceSheet: s.sourceSheet || 'نشط'
            }))
          }
        }
      };
    }

    case 'attendance_bulk_prepare': {
      const targetFriday = prevMeta?.targetFriday && /^\d{4}-\d{2}-\d{2}$/.test(prevMeta.targetFriday)
        ? prevMeta.targetFriday
        : effectiveAttendanceDate;
      const desiredPresent =
        !scope.normalizedQuery.includes('غياب') &&
        !scope.normalizedQuery.includes('غائب') &&
        !scope.normalizedQuery.includes('غائبين');

      // Always re-verify live database state so already-recorded students are NEVER included or touched
      const scopedUnrecordedPool = workingStudents.filter((s) => typeof s.att?.[targetFriday] !== 'boolean');
      const prevUnrecSet =
        prevMeta?.unrecordedStudentIds && prevMeta.unrecordedStudentIds.length > 0
          ? new Set(prevMeta.unrecordedStudentIds)
          : null;
      const verifiedTargets = prevUnrecSet
        ? scopedUnrecordedPool.filter((s) => prevUnrecSet.has(s.id))
        : scopedUnrecordedPool;
      const targets = verifiedTargets.length > 0 ? verifiedTargets : scopedUnrecordedPool;

      if (targets.length === 0) {
        return {
          text: `ℹ️ لا يوجد أي مخدوم غير مسجل في هذا النطاق لتاريخ ${targetFriday}. جميع المخدومين مسجلون بالفعل ولم يتم إنشاء أي سجلات مكررة.${syncFootnotes}`,
          meta: {
            intent: 'attendance_unrecorded',
            domain: 'attendance',
            targetFriday,
            dateLabel: effectiveDateLabel,
            classScope: effectiveClassScope,
            servantScope: activeServantFilter,
            unrecordedStudentIds: [],
            studentIds: []
          }
        };
      }

      const statusLabel = desiredPresent ? 'حضور' : 'غياب';
      const scopeDetails = [
        effectiveClassScope ? `الفصل: ${effectiveClassScope}` : '',
        activeServantFilter ? `الأشبين: ${activeServantFilter}` : ''
      ]
        .filter(Boolean)
        .join(' • ');

      return {
        text: [
          `⚠️ تأكيد قبل تنفيذ التسجيل الجماعي:`,
          `• عدد المخدومين غير المسجلين: ${targets.length} مخدوم`,
          `• التاريخ المحدد للتسجيل: ${targetFriday}`,
          `• الحالة المختارة: ${statusLabel}`,
          scopeDetails ? `• النطاق: ${scopeDetails}` : '',
          '',
          `لن يتم تنفيذ التسجيل إلا بعد موافقتك، وسيُعاد التحقق من عدم وجود سجلات مسبقة قبل الحفظ.${syncFootnotes}`
        ]
          .filter(Boolean)
          .join('\n'),
        actions: [
          {
            label: `تأكيد تسجيل الكل (${statusLabel})`,
            type: 'prompt',
            payload: `تأكيد تسجيل الكل ${statusLabel}`,
            variant: desiredPresent ? 'present' : 'absent'
          },
          {
            label: 'إلغاء',
            type: 'prompt',
            payload: 'إلغاء العملية',
            variant: 'danger'
          }
        ],
        meta: {
          intent: 'attendance_bulk_prepare',
          domain: 'attendance',
          targetFriday,
          dateLabel: effectiveDateLabel,
          classScope: effectiveClassScope,
          servantScope: activeServantFilter,
          unrecordedStudentIds: targets.map((s) => s.id),
          studentIds: targets.map((s) => s.id),
          pendingBulkAttendance: {
            targetFriday,
            isPresent: desiredPresent,
            studentIds: targets.map((s) => s.id),
            classScope: effectiveClassScope,
            servantScope: activeServantFilter
          }
        }
      };
    }

    case 'attendance_bulk_confirm': {
      const pending = prevMeta?.pendingBulkAttendance;
      if (!pending || pending.studentIds.length === 0) {
        return {
          text: 'لا توجد عملية تسجيل جماعي معلقة للتأكيد حالياً. يمكنك عرض قائمة غير المسجلين أولاً ثم اختيار الحالة.',
          meta: { intent: 'attendance_unrecorded', domain: 'attendance', targetFriday: effectiveAttendanceDate }
        };
      }

      const targetFriday = pending.targetFriday;
      const isPresent = pending.isPresent;
      const entries: Array<{
        studentId: string;
        studentName: string;
        studentCode: string;
        fridayDate: string;
        isPresent: boolean;
      }> = [];
      let skippedAlreadyRecordedCount = 0;

      for (const sid of pending.studentIds) {
        const liveStudent = studentsById.get(sid);
        if (!liveStudent) continue;
        // Re-verify against latest loaded state before writing (never overwrite or duplicate existing records)
        if (typeof liveStudent.att?.[targetFriday] === 'boolean') {
          skippedAlreadyRecordedCount++;
          continue;
        }
        entries.push({
          studentId: liveStudent.id,
          studentName: liveStudent.name,
          studentCode: liveStudent.code,
          fridayDate: targetFriday,
          isPresent
        });
      }

      if (entries.length === 0) {
        return {
          text: `ℹ️ عند إعادة التحقق تبين أن جميع المخدومين المحددين (${skippedAlreadyRecordedCount}) تم تسجيل حالتهم بالفعل لتاريخ ${targetFriday}. لم أُضف أي سجلات مكررة.`,
          meta: {
            intent: 'attendance_unrecorded',
            domain: 'attendance',
            targetFriday,
            classScope: pending.classScope,
            servantScope: pending.servantScope,
            unrecordedStudentIds: [],
            studentIds: []
          }
        };
      }

      const statusLabel = isPresent ? 'حضور' : 'غياب';
      return {
        text: `⏳ جاري تسجيل ${statusLabel} لـ ${entries.length} مخدومًا عن ${targetFriday}...`,
        command: {
          type: 'markAttendanceBatch',
          entries,
          isPresent,
          targetFridayDate: targetFriday,
          skippedAlreadyRecordedCount
        },
        meta: {
          intent: 'attendance_bulk_confirm',
          domain: 'attendance',
          targetFriday,
          classScope: pending.classScope,
          servantScope: pending.servantScope,
          studentIds: entries.map((e) => e.studentId)
        }
      };
    }

    case 'attendance_bulk_cancel': {
      return {
        text: 'تم إلغاء التسجيل الجماعي. لم يتم تعديل أي سجل حضور أو غياب في قاعدة البيانات.',
        actions: [
          { label: 'عرض غير المسجلين', type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' }
        ],
        meta: {
          intent: 'attendance_bulk_cancel',
          domain: 'attendance',
          targetFriday: prevMeta?.targetFriday || effectiveAttendanceDate,
          classScope: prevMeta?.classScope || effectiveClassScope,
          servantScope: prevMeta?.servantScope || activeServantFilter
        }
      };
    }

    case 'present': {
      const targetFriday = effectiveAttendanceDate;
      const presentList = workingStudents.filter((s) => s.att?.[targetFriday] === true);
      const unrecordedList = workingStudents.filter((s) => typeof s.att?.[targetFriday] !== 'boolean');
      const unrecorded = unrecordedList.length;
      const prefix =
        targetFriday === scope.dateRange.primaryFriday && scope.dateRange.kind === 'latestHeldFriday'
          ? 'الحاضرون آخر جمعة'
          : `الحاضرون (${effectiveDateLabel})`;

      if (presentList.length === 0) {
        return {
          text: `${prefix} (0): لا يوجد${unrecorded > 0 ? `\n• لم يُسجل بعد: ${unrecorded}` : ''}${syncFootnotes}`,
          actions:
            unrecorded > 0
              ? [{ label: `غير المسجلين (${unrecorded})`, type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' }]
              : undefined,
          meta: {
            intent: 'present',
            domain: 'attendance',
            studentIds: [],
            unrecordedStudentIds: unrecordedList.map((s) => s.id),
            cohortStudentIds: workingStudents.map((s) => s.id),
            targetFriday,
            dateLabel: effectiveDateLabel,
            classScope: effectiveClassScope,
            servantScope: activeServantFilter
          }
        };
      }

      const namesList = presentList
        .map((s, i) => `${i + 1}. ${s.name}${s.sourceSheet && !effectiveClassScope ? ` (${s.sourceSheet})` : ''}`)
        .join('\n');
      return {
        text: `${prefix} (${presentList.length}):\n${namesList}${unrecorded > 0 ? `\n\n• لم يُسجل بعد: ${unrecorded} مخدومًا` : ''}${syncFootnotes}`,
        copyText: presentList.map((s) => s.name).join('\n'),
        actions: [
          { label: 'الغائبون المسجلون', type: 'prompt', payload: 'مين غاب؟', variant: 'absent' },
          { label: `غير المسجلين (${unrecorded})`, type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' }
        ],
        meta: {
          intent: 'present',
          domain: 'attendance',
          studentIds: presentList.map((s) => s.id),
          unrecordedStudentIds: unrecordedList.map((s) => s.id),
          cohortStudentIds: workingStudents.map((s) => s.id),
          targetFriday,
          dateLabel: effectiveDateLabel,
          classScope: effectiveClassScope,
          servantScope: activeServantFilter
        }
      };
    }

    case 'absent': {
      const targetFriday = effectiveAttendanceDate;
      const absentList = workingStudents.filter((s) => s.att?.[targetFriday] === false);
      const unrecordedList = workingStudents.filter((s) => typeof s.att?.[targetFriday] !== 'boolean');
      const unrecorded = unrecordedList.length;
      const prefix =
        targetFriday === scope.dateRange.primaryFriday && scope.dateRange.kind === 'latestHeldFriday'
          ? 'الغائبون آخر جمعة'
          : `الغائبون (${effectiveDateLabel})`;

      if (absentList.length === 0) {
        return {
          text: `${prefix} (0): لا يوجد غياب مسجل${unrecorded > 0 ? `\n• لم يُسجل بعد: ${unrecorded}` : ''}${syncFootnotes}`,
          actions:
            unrecorded > 0
              ? [{ label: `غير المسجلين (${unrecorded})`, type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' }]
              : undefined,
          meta: {
            intent: 'absent',
            domain: 'attendance',
            studentIds: [],
            unrecordedStudentIds: unrecordedList.map((s) => s.id),
            cohortStudentIds: [],
            targetFriday,
            dateLabel: effectiveDateLabel,
            classScope: effectiveClassScope,
            servantScope: activeServantFilter
          }
        };
      }

      const namesList = absentList
        .map((s, idx) => `${idx + 1}. ${s.name}${s.sourceSheet && !effectiveClassScope ? ` (${s.sourceSheet})` : ''}`)
        .join('\n');
      return {
        text: `${prefix} (${absentList.length}):\n${namesList}${unrecorded > 0 ? `\n\n• لم يُسجل بعد: ${unrecorded} (منفصلون عن الغياب المسجل)` : ''}${syncFootnotes}`,
        copyText: absentList.map((s) => s.name).join('\n'),
        actions: [
          { label: 'مين فيهم اتعمله افتقاد؟', type: 'prompt', payload: 'مين فيهم اتعمله افتقاد؟' },
          { label: 'رسالة افتقاد جاهزة', type: 'prompt', payload: 'رسالة افتقاد' },
          ...(unrecorded > 0
            ? [{ label: `غير المسجلين (${unrecorded})`, type: 'prompt' as const, payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' as const }]
            : [])
        ],
        meta: {
          intent: 'absent',
          domain: 'attendance',
          studentIds: absentList.map((s) => s.id),
          unrecordedStudentIds: unrecordedList.map((s) => s.id),
          cohortStudentIds: absentList.map((s) => s.id),
          targetFriday,
          dateLabel: effectiveDateLabel,
          classScope: effectiveClassScope,
          servantScope: activeServantFilter
        }
      };
    }

    case 'attendance_summary': {
      const targetFriday = effectiveAttendanceDate;
      const present = workingStudents.filter((s) => s.att?.[targetFriday] === true);
      const absent = workingStudents.filter((s) => s.att?.[targetFriday] === false);
      const unrecorded = workingStudents.filter((s) => typeof s.att?.[targetFriday] !== 'boolean');
      const recordedTotal = present.length + absent.length;
      const recordedPct = recordedTotal > 0 ? Math.round((present.length / recordedTotal) * 100) : 0;

      const text = [
        `📋 كشف الحضور الكامل — ${effectiveDateLabel} (${workingStudents.length} مخدوم):`,
        `• حاضر: ${present.length} | غائب مسجل: ${absent.length} | لم يُسجل: ${unrecorded.length}`,
        recordedTotal > 0 ? `• نسبة الحضور من المسجلين: ${recordedPct}% (${present.length}/${recordedTotal})` : '• لم يُسجل حضور أو غياب لأي مخدوم في هذا التاريخ بعد.',
        '',
        `✅ الحاضرون (${present.length}):`,
        present.length > 0 ? present.map((s, i) => `${i + 1}. ${s.name}`).join('\n') : 'لا يوجد',
        '',
        `⚠️ الغائبون المسجلون (${absent.length}):`,
        absent.length > 0 ? absent.map((s, i) => `${i + 1}. ${s.name}`).join('\n') : 'لا يوجد',
        '',
        `📝 لم يُسجل (${unrecorded.length}):`,
        unrecorded.length > 0 ? unrecorded.map((s, i) => `${i + 1}. ${s.name}`).join('\n') : 'لا يوجد'
      ].join('\n');

      return {
        text: `${text}${syncFootnotes}`,
        copyText: text,
        actions:
          unrecorded.length > 0
            ? [{ label: `غير المسجلين (${unrecorded.length})`, type: 'prompt', payload: 'مين اللي لم يسجل بعد؟', variant: 'primary' }]
            : undefined,
        meta: {
          intent: 'attendance_summary',
          domain: 'attendance',
          studentIds: workingStudents.map((s) => s.id),
          unrecordedStudentIds: unrecorded.map((s) => s.id),
          cohortStudentIds: workingStudents.map((s) => s.id),
          targetFriday,
          dateLabel: effectiveDateLabel,
          classScope: effectiveClassScope,
          servantScope: activeServantFilter
        }
      };
    }

    case 'attendance_percentage': {
      const targetFriday = scope.dateRange.primaryFriday;
      const presentCount = workingStudents.filter((s) => s.att?.[targetFriday] === true).length;
      const absentCount = workingStudents.filter((s) => s.att?.[targetFriday] === false).length;
      const unrecordedCount = Math.max(0, workingStudents.length - presentCount - absentCount);
      const recordedTotal = presentCount + absentCount;
      const pctOverall = workingStudents.length > 0 ? Math.round((presentCount / workingStudents.length) * 100) : 0;
      const pctRecorded = recordedTotal > 0 ? Math.round((presentCount / recordedTotal) * 100) : null;

      const lines = [
        `📊 نسبة الحضور — ${scope.dateRange.label}${scope.classScope ? ` (فصل: ${scope.classScope})` : ''}:`,
        `• إجمالي المخدومين في النطاق: ${workingStudents.length}`,
        `• حاضر: ${presentCount} | غائب مسجل: ${absentCount} | غير مسجل: ${unrecordedCount}`,
        pctRecorded !== null
          ? `• نسبة الحضور الفعلية (من المسجلين فقط): ${pctRecorded}% (${presentCount}/${recordedTotal})`
          : '• نسبة الحضور الفعلية: لا توجد سجلات حضور أو غياب مسجلة لهذا التاريخ بعد',
        `• نسبة الحضور من الإجمالي الكلي: ${pctOverall}% (${presentCount}/${workingStudents.length})`
      ];
      return {
        text: `${lines.join('\n')}${syncFootnotes}`,
        meta: { intent: 'attendance_percentage', domain: 'attendance', targetFriday }
      };
    }

    case 'attendance_comparison': {
      const heldFridays = getAllHeldFridaysFromStudents(workingStudents, scope.dateRange.primaryFriday);
      const latest = scope.dateRange.primaryFriday;
      const prev =
        heldFridays.length >= 2 && heldFridays[heldFridays.length - 1] === latest
          ? heldFridays[heldFridays.length - 2]
          : scope.dateRange.secondaryFriday;

      const calcForDate = (d: string) => {
        const present = workingStudents.filter((s) => s.att?.[d] === true).length;
        const absent = workingStudents.filter((s) => s.att?.[d] === false).length;
        const unrec = Math.max(0, workingStudents.length - present - absent);
        const recTotal = present + absent;
        const rateRec = recTotal > 0 ? `${Math.round((present / recTotal) * 100)}%` : 'غير مسجل';
        const rateAll = workingStudents.length > 0 ? `${Math.round((present / workingStudents.length) * 100)}%` : '0%';
        return { present, absent, unrec, rateRec, rateAll };
      };

      const prevStats = calcForDate(prev);
      const latestStats = calcForDate(latest);
      const deltaPresent = latestStats.present - prevStats.present;
      const deltaStr = deltaPresent > 0 ? `+${deltaPresent}` : String(deltaPresent);

      const newlyAbsent = workingStudents.filter((s) => s.att?.[prev] === true && s.att?.[latest] === false);
      const returned = workingStudents.filter((s) => s.att?.[prev] === false && s.att?.[latest] === true);

      const text = [
        `📈 مقارنة الحضور بين آخر جمعتين (${prev} vs ${latest}):`,
        `• ${prev} (السابقة): حضور ${prevStats.present} | غياب ${prevStats.absent} | غير مسجل ${prevStats.unrec} | نسبة المسجلين: ${prevStats.rateRec} (من الكل ${prevStats.rateAll})`,
        `• ${latest} (الأحدث): حضور ${latestStats.present} | غياب ${latestStats.absent} | غير مسجل ${latestStats.unrec} | نسبة المسجلين: ${latestStats.rateRec} (من الكل ${latestStats.rateAll})`,
        `• الفارق الصافي في الحضور: ${deltaStr}`,
        returned.length > 0 ? `• عادوا للحضور (${returned.length}): ${returned.map((s) => s.name).join('، ')}` : '',
        newlyAbsent.length > 0 ? `• حضروا السابقة وغابوا الأحدث (${newlyAbsent.length}): ${newlyAbsent.map((s) => s.name).join('، ')}` : ''
      ]
        .filter(Boolean)
        .join('\n');

      return {
        text: `${text}${syncFootnotes}`,
        copyText: text,
        meta: {
          intent: 'attendance_comparison',
          domain: 'attendance',
          targetFriday: latest,
          secondaryFriday: prev
        }
      };
    }

    case 'lowAttendance': {
      const lowList = [...workingStudents]
        .filter((s) => Number(s.attendanceMonth) <= 1)
        .sort((a, b) => Number(a.attendanceMonth) - Number(b.attendanceMonth) || Number(a.attendanceTotal) - Number(b.attendanceTotal));

      if (lowList.length === 0) {
        return {
          text: `👍 جميع المخدومين في النطاق الحالي لديهم حضور شهري أعلى من مرة واحدة.${syncFootnotes}`,
          meta: { intent: 'lowAttendance', domain: 'attendance', studentIds: [] }
        };
      }
      const lines = lowList
        .slice(0, 15)
        .map(
          (s, idx) =>
            `${idx + 1}. ${s.name} (${s.code}) — حضور الشهر: ${s.attendanceMonth}/4 • إجمالي الحضور: ${s.attendanceTotal} • آخر حضور: ${
              s.lastAttendance || 'غير مسجل'
            }`
        );
      return {
        text: `📉 المخدومون الأقل حضوراً (<= 1 مرة هذا الشهر) — عددهم (${lowList.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        actions: [{ label: '💙 رسالة افتقاد جاهزة', type: 'prompt', payload: 'رسالة افتقاد' }],
        meta: {
          intent: 'lowAttendance',
          domain: 'attendance',
          studentIds: lowList.map((s) => s.id),
          cohortStudentIds: lowList.map((s) => s.id)
        }
      };
    }

    case 'topAttendance': {
      const topList = [...workingStudents]
        .filter((s) => Number(s.attendanceTotal) >= 1)
        .sort((a, b) => Number(b.attendanceTotal) - Number(a.attendanceTotal) || Number(b.attendanceMonth) - Number(a.attendanceMonth))
        .slice(0, 10);

      if (topList.length === 0) {
        return {
          text: `لا توجد أرقام حضور إجمالية مسجلة حتى الآن في البيانات المحملة.${syncFootnotes}`,
          meta: { intent: 'topAttendance', domain: 'attendance', studentIds: [] }
        };
      }
      const lines = topList.map((s, idx) => `${idx + 1}. ${s.name} — إجمالي: ${s.attendanceTotal} | الشهر: ${s.attendanceMonth}/4`);
      return {
        text: `🏆 أكثر المخدومين انتظاماً وحضوراً (${topList.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        actions: [{ label: '🌟 رسالة تشجيع', type: 'prompt', payload: 'رسالة تشجيع' }],
        meta: {
          intent: 'topAttendance',
          domain: 'attendance',
          studentIds: topList.map((s) => s.id),
          cohortStudentIds: topList.map((s) => s.id)
        }
      };
    }

    // ========================================================================
    // DOMAIN 2: FOLLOW-UP & CALL OUTCOMES
    // ========================================================================
    case 'missingFollowup': {
      const weekFridayDate =
        effectiveFollowupTimeframe === 'specificWeek'
          ? scope.dateRange.followupFriday
          : getActiveFollowupFridayString(referenceDate);
      const todayIso = getCairoDateParts(referenceDate).isoDate;
      const resolvedScopeLabel = activeServantFilter ? ` — الأشبن: ${activeServantFilter}` : '';

      if (effectiveFollowupTimeframe === 'today' && !usingContextualSubset) {
        const missingToday = workingStudents.filter(
          (s) => !isStudentFollowedUpToday(s, todayIso, followupRecords).followedUpToday
        );

        if (effectiveWantsCountOnly) {
          const doneTodayCount = workingStudents.length - missingToday.length;
          return {
            text: `📊 المتبقون في افتقاد اليوم (${todayIso})${resolvedScopeLabel}: ${missingToday.length} من أصل ${workingStudents.length} (تم افتقاد ${doneTodayCount} اليوم).${syncFootnotes}`,
            actions: [
              { label: '📋 عرض الأسماء المتبقية', type: 'prompt', payload: 'مين باقي عليا في الافتقاد؟' },
              { label: '✅ طب مين افتقدته؟', type: 'prompt', payload: 'طب مين افتقدته؟' }
            ],
            meta: {
              intent: 'missingFollowup',
              domain: 'followup',
              servantScope: activeServantFilter,
              studentIds: missingToday.map((s) => s.id),
              cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
              followupFriday: weekFridayDate
            }
          };
        }

        if (missingToday.length === 0) {
          return {
            text: `المتبقون في الافتقاد اليوم (${todayIso})${resolvedScopeLabel} (0): لا يوجد — تم افتقاد جميع المخدومين اليوم.${syncFootnotes}`,
            meta: {
              intent: 'missingFollowup',
              domain: 'followup',
              servantScope: activeServantFilter,
              studentIds: [],
              cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
              followupFriday: weekFridayDate
            }
          };
        }

        const lines = missingToday.map((s, i) => {
          const weekSummary = computeMonthlyFollowupSummary(s, followupRecords, referenceDate, true);
          const currentWeekEntry = weekSummary.weeks.find((w) => w.fridayDate === weekFridayDate);
          const alreadyEarlierThisWeek =
            currentWeekEntry?.status === 'done'
              ? ` • تم افتقاده سابقاً هذا الأسبوع (${currentWeekEntry.recordDate || weekFridayDate})`
              : '';
          return `${i + 1}. ${s.name}${s.code ? ` (${s.code})` : ''}${alreadyEarlierThisWeek}`;
        });

        return {
          text: `المتبقون في الافتقاد اليوم (${todayIso})${resolvedScopeLabel} (${missingToday.length} من ${workingStudents.length}):\n${lines.join('\n')}${syncFootnotes}`,
          copyText: missingToday.map((s) => s.name).join('\n'),
          actions: [
            { label: '✅ طب مين افتقدته؟', type: 'prompt', payload: 'طب مين افتقدته؟' },
            { label: '📊 خلصت ومين باقي؟', type: 'prompt', payload: 'مين خلصت افتقاده ومين باقي؟' }
          ],
          meta: {
            intent: 'missingFollowup',
            domain: 'followup',
            servantScope: activeServantFilter,
            studentIds: missingToday.map((s) => s.id),
            cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
            followupFriday: weekFridayDate
          }
        };
      }

      const missing = workingStudents.filter((s) => {
        const weekRes = isStudentFollowedUpInWeek(s, weekFridayDate, followupRecords);
        return !weekRes.followedUp;
      });

      if (effectiveWantsCountOnly) {
        const doneCount = workingStudents.length - missing.length;
        return {
          text: `📊 المتبقون في افتقاد الأسبوع الحالي (ينتهي الجمعة 11:59 م بتوقيت القاهرة — ${weekFridayDate})${resolvedScopeLabel}: ${missing.length} من أصل ${workingStudents.length} (تم افتقاد ${doneCount}).${syncFootnotes}`,
          actions: [
            { label: '📋 عرض الأسماء المتبقية', type: 'prompt', payload: 'مين باقي عليا في الافتقاد؟' },
            { label: '✅ طب مين افتقدته؟', type: 'prompt', payload: 'طب مين افتقدته؟' }
          ],
          meta: {
            intent: 'missingFollowup',
            domain: 'followup',
            servantScope: activeServantFilter,
            studentIds: missing.map((s) => s.id),
            cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
            followupFriday: weekFridayDate
          }
        };
      }

      if (missing.length === 0) {
        return {
          text: `المتبقون في الافتقاد هذا الأسبوع${resolvedScopeLabel} (0): لا يوجد${syncFootnotes}`,
          meta: {
            intent: 'missingFollowup',
            domain: 'followup',
            servantScope: activeServantFilter,
            studentIds: [],
            cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
            followupFriday: weekFridayDate
          }
        };
      }

      const namesList = missing.map((s, i) => `${i + 1}. ${s.name}${s.code ? ` (${s.code})` : ''}`).join('\n');
      return {
        text: `المتبقون في الافتقاد هذا الأسبوع (${weekFridayDate})${resolvedScopeLabel} (${missing.length} من ${workingStudents.length}):\n${namesList}${syncFootnotes}`,
        copyText: missing.map((s) => s.name).join('\n'),
        actions: [
          { label: '✅ طب مين افتقدته؟', type: 'prompt', payload: 'طب مين افتقدته؟' },
          { label: '📊 خلصت ومين باقي؟', type: 'prompt', payload: 'مين خلصت افتقاده ومين باقي؟' }
        ],
        meta: {
          intent: 'missingFollowup',
          domain: 'followup',
          servantScope: activeServantFilter,
          studentIds: missing.map((s) => s.id),
          cohortStudentIds: prevMeta?.cohortStudentIds || missing.map((s) => s.id),
          followupFriday: weekFridayDate
        }
      };
    }

    case 'followup_recorded': {
      const weekFridayDate =
        effectiveFollowupTimeframe === 'specificWeek'
          ? scope.dateRange.followupFriday
          : getActiveFollowupFridayString(referenceDate);
      const todayIso = getCairoDateParts(referenceDate).isoDate;
      const resolvedScopeLabel = activeServantFilter ? ` — الأشبن: ${activeServantFilter}` : '';
      const matched: Array<{ student: Student; method: string; callOutcome?: CallOutcome; date?: string }> = [];

      for (const s of workingStudents) {
        if (effectiveFollowupTimeframe === 'today' && !usingContextualSubset) {
          const todayRes = isStudentFollowedUpToday(s, todayIso, followupRecords);
          if (todayRes.followedUpToday) {
            matched.push({ student: s, method: todayRes.method || s.followupStatus || 'مسجل', callOutcome: todayRes.callOutcome, date: todayIso });
          }
        } else {
          const res = isStudentFollowedUpInWeek(s, weekFridayDate, followupRecords);
          if (res.followedUp) {
            matched.push({ student: s, method: res.method || s.followupStatus || 'مسجل', callOutcome: res.callOutcome, date: res.latestDate });
          }
        }
      }

      const timeLabel = effectiveFollowupTimeframe === 'today' && !usingContextualSubset ? `اليوم (${todayIso})` : `أسبوع (${weekFridayDate})`;

      if (effectiveWantsCountOnly) {
        const remainingCount = workingStudents.length - matched.length;
        return {
          text: `📊 عدد المخدومين الذين تم افتقادهم في ${timeLabel}${resolvedScopeLabel}: ${matched.length} من أصل ${workingStudents.length} (متبقي ${remainingCount}).${syncFootnotes}`,
          meta: {
            intent: 'followup_recorded',
            domain: 'followup',
            servantScope: activeServantFilter,
            studentIds: matched.map((m) => m.student.id),
            cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
            followupFriday: weekFridayDate
          }
        };
      }

      if (matched.length === 0) {
        return {
          text: `لم يُسجَّل افتقاد لأي مخدوم${usingContextualSubset ? ' من الأسماء المحددة' : ''}${resolvedScopeLabel} في ${timeLabel}.${syncFootnotes}`,
          meta: {
            intent: 'followup_recorded',
            domain: 'followup',
            servantScope: activeServantFilter,
            studentIds: [],
            cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
            followupFriday: weekFridayDate
          }
        };
      }

      const lines = matched.map((item, idx) => {
        const methodText = formatMethodDisplay(item.method);
        const outcomeSuffix = isPhoneMethod(item.method) ? ` (نتيجة الاتصال: ${item.callOutcome || 'غير مسجل'})` : '';
        return `${idx + 1}. ${item.student.name} (${item.student.code}) — ${methodText}${outcomeSuffix}`;
      });

      return {
        text: `✅ المخدومون الذين تم افتقادهم (${timeLabel})${resolvedScopeLabel} — عددهم (${matched.length} من ${workingStudents.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: matched.map((m) => m.student.name).join('\n'),
        actions: [
          { label: '⏳ واللي باقي؟', type: 'prompt', payload: 'مين باقي عليا في الافتقاد؟' },
          { label: '📊 الكشف كامل', type: 'prompt', payload: 'مين خلصت افتقاده ومين باقي؟' }
        ],
        meta: {
          intent: 'followup_recorded',
          domain: 'followup',
          servantScope: activeServantFilter,
          studentIds: matched.map((m) => m.student.id),
          cohortStudentIds: prevMeta?.cohortStudentIds || workingStudents.map((s) => s.id),
          followupFriday: weekFridayDate
        }
      };
    }

    case 'followup_mixed': {
      const weekFridayDate =
        effectiveFollowupTimeframe === 'specificWeek'
          ? scope.dateRange.followupFriday
          : getActiveFollowupFridayString(referenceDate);
      const todayIso = getCairoDateParts(referenceDate).isoDate;
      const resolvedScopeLabel = activeServantFilter ? ` — الأشبين: ${activeServantFilter}` : '';
      const useToday = effectiveFollowupTimeframe === 'today' && !usingContextualSubset;

      const doneList: Array<{ student: Student; method: string; callOutcome?: CallOutcome }> = [];
      const missingList: Student[] = [];

      for (const s of workingStudents) {
        if (useToday) {
          const todayRes = isStudentFollowedUpToday(s, todayIso, followupRecords);
          if (todayRes.followedUpToday) {
            doneList.push({ student: s, method: todayRes.method || 'مسجل', callOutcome: todayRes.callOutcome });
          } else {
            missingList.push(s);
          }
        } else {
          const weekRes = isStudentFollowedUpInWeek(s, weekFridayDate, followupRecords);
          if (weekRes.followedUp) {
            doneList.push({ student: s, method: weekRes.method || 'مسجل', callOutcome: weekRes.callOutcome });
          } else {
            missingList.push(s);
          }
        }
      }

      const periodTitle = useToday
        ? `اليوم (${todayIso})`
        : `الأسبوع الحالي (ينتهي الجمعة 11:59 م بتوقيت القاهرة — ${weekFridayDate})`;

      const doneLines =
        doneList.length > 0
          ? doneList
              .map((d, idx) => {
                const outcome = isPhoneMethod(d.method) ? ` • ${d.callOutcome || 'غير مسجل'}` : '';
                return `${idx + 1}. ${d.student.name} (${d.student.code}) — ${formatMethodDisplay(d.method)}${outcome}`;
              })
              .join('\n')
          : 'لا يوجد';

      const missingLines =
        missingList.length > 0
          ? missingList.map((s, idx) => `${idx + 1}. ${s.name}${s.code ? ` (${s.code})` : ''}`).join('\n')
          : 'لا يوجد — تم الانتهاء من الجميع ✅';

      const text = [
        `📋 موقف الافتقاد — ${periodTitle}${resolvedScopeLabel} (${workingStudents.length} مخدوم):`,
        `• تم افتقادهم: ${doneList.length} | متبقي للافتقاد: ${missingList.length}`,
        '',
        `✅ تم افتقادهم (${doneList.length}):`,
        doneLines,
        '',
        `⏳ باقي الافتقاد (${missingList.length}):`,
        missingLines
      ].join('\n');

      return {
        text: `${text}${syncFootnotes}`,
        copyText: missingList.map((s) => s.name).join('\n'),
        meta: {
          intent: 'followup_mixed',
          domain: 'followup',
          servantScope: activeServantFilter,
          studentIds: missingList.map((s) => s.id),
          cohortStudentIds: workingStudents.map((s) => s.id),
          followupFriday: weekFridayDate
        }
      };
    }

    case 'followup_contacted':
    case 'followup_not_contacted': {
      const wantedOutcome: CallOutcome = intent === 'followup_contacted' ? 'تم التواصل' : 'لم يتم التواصل';
      const title =
        wantedOutcome === 'تم التواصل'
          ? '📞 المخدومون الذين تم التواصل معهم (نتيجة الاتصال: تم التواصل)'
          : '📵 المخدومون الذين لم يردّوا / لم يتم التواصل معهم (نتيجة الاتصال: لم يتم التواصل)';

      const workingIds = new Set(workingStudents.map((s) => s.id));
      const matchedMap = new Map<string, { student: Student; date: string; notes?: string }>();

      for (const r of followupRecords) {
        const sid = matchRecordToStudentId(r, studentsById, students);
        if (!workingIds.has(sid)) continue;
        if (r.callOutcome !== wantedOutcome) continue;
        const st = studentsById.get(sid);
        if (!st) continue;
        if (!matchedMap.has(sid)) {
          matchedMap.set(sid, { student: st, date: r.date || r.fridayDate, notes: r.notes });
        }
      }

      // Check student fuOutcomes if log array didn't carry it
      for (const s of workingStudents) {
        if (matchedMap.has(s.id)) continue;
        if (s.lastCallOutcome === wantedOutcome) {
          matchedMap.set(s.id, { student: s, date: s.lastFollowup || scope.dateRange.followupFriday });
        } else if (s.fuOutcomes) {
          const entry = Object.entries(s.fuOutcomes).find(([, val]) => val === wantedOutcome);
          if (entry) {
            matchedMap.set(s.id, { student: s, date: entry[0] });
          }
        }
      }

      const list = Array.from(matchedMap.values());
      const legacyPhoneCount = followupRecords.filter(
        (r) => isPhoneMethod(r.type) && !r.callOutcome && workingIds.has(matchRecordToStudentId(r, studentsById, students))
      ).length;

      if (list.length === 0) {
        const legacyNote =
          legacyPhoneCount > 0
            ? `\nملاحظة: توجد ${legacyPhoneCount} مكالمة تليفونية قديمة مسجلة قبل تفعيل حقل «نتيجة الاتصال» تظهر كـ «غير مسجل» دون افتراض نتيجتها.`
            : '';
        return {
          text: `${title} (0): لا توجد سجلات بهذه النتيجة في النطاق المحدد.${legacyNote}${syncFootnotes}`,
          meta: {
            intent,
            domain: 'followup',
            studentIds: [],
            cohortStudentIds: []
          }
        };
      }

      const lines = list.map(
        (item, idx) => `${idx + 1}. ${item.student.name} (${item.student.code}) — التاريخ: ${item.date} • الأشبين: ${item.student.servant}`
      );
      const legacyNote =
        legacyPhoneCount > 0
          ? `\n\nℹ️ توجد أيضاً ${legacyPhoneCount} مكالمة قديمة نتيجتها «غير مسجل» ولم تُحسب هنا للحفاظ على دقة البيانات.`
          : '';

      return {
        text: `${title} (${list.length}):\n\n${lines.join('\n')}${legacyNote}${syncFootnotes}`,
        copyText: list.map((i) => i.student.name).join('\n'),
        meta: {
          intent,
          domain: 'followup',
          studentIds: list.map((i) => i.student.id),
          cohortStudentIds: list.map((i) => i.student.id)
        }
      };
    }

    case 'followup_calls': {
      const workingIds = new Set(workingStudents.map((s) => s.id));
      const callLogs = followupRecords.filter(
        (r) => isPhoneMethod(r.type) && workingIds.has(matchRecordToStudentId(r, studentsById, students))
      );

      if (callLogs.length === 0) {
        return {
          text: `📞 اتصالات الافتقاد التليفونية (0): لا توجد مكالمات تليفونية مسجلة في سجل الافتقاد الحالي.${syncFootnotes}`,
          meta: { intent: 'followup_calls', domain: 'followup', studentIds: [] }
        };
      }

      const uniqueIds = Array.from(new Set(callLogs.map((r) => matchRecordToStudentId(r, studentsById, students))));
      const lines = callLogs.slice(0, 20).map((r, idx) => {
        return `${idx + 1}. ${r.studentName} (${r.studentCode}) — ${r.date} • النتيجة: ${r.callOutcome || 'غير مسجل'} • الأشبين: ${r.servant}`;
      });
      return {
        text: `📞 اتصالات الافتقاد التليفونية (${callLogs.length} سجل لـ ${uniqueIds.length} مخدوم):\n\n${lines.join('\n')}${syncFootnotes}`,
        meta: {
          intent: 'followup_calls',
          domain: 'followup',
          studentIds: uniqueIds,
          cohortStudentIds: uniqueIds
        }
      };
    }

    case 'followup_needs_retry': {
      const targetFriday = scope.dateRange.primaryFriday;
      const fuWeek = scope.dateRange.followupFriday;
      const workingIds = new Set(workingStudents.map((s) => s.id));

      // Latest follow-up record per studentId
      const latestRecordBySid = new Map<string, FollowupRecord>();
      for (const r of followupRecords) {
        const sid = matchRecordToStudentId(r, studentsById, students);
        if (!workingIds.has(sid)) continue;
        if (!latestRecordBySid.has(sid)) latestRecordBySid.set(sid, r);
      }

      const retryList: Array<{ student: Student; reason: string }> = [];
      for (const s of workingStudents) {
        const latestRec = latestRecordBySid.get(s.id);
        if (latestRec?.callOutcome === 'لم يتم التواصل' || s.lastCallOutcome === 'لم يتم التواصل') {
          retryList.push({ student: s, reason: 'اتصال سابق لم يتم التواصل فيه' });
          continue;
        }
        const weekFu = isStudentFollowedUpInWeek(s, fuWeek, followupRecords);
        if (s.att?.[targetFriday] === false && !weekFu.followedUp) {
          retryList.push({ student: s, reason: `غائب في ${targetFriday} ولم يُفتقد هذا الأسبوع` });
        }
      }

      if (retryList.length === 0) {
        return {
          text: `✅ لا يوجد مخدومون يحتاجون لإعادة متابعة حالياً في هذا النطاق.${syncFootnotes}`,
          meta: { intent: 'followup_needs_retry', domain: 'followup', studentIds: [] }
        };
      }

      const lines = retryList.map((item, i) => `${i + 1}. ${item.student.name} (${item.student.code}) — ${item.reason}`);
      return {
        text: `🔁 المخدومون المحتاجون لإعادة المتابعة (${retryList.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: retryList.map((i) => i.student.name).join('\n'),
        meta: {
          intent: 'followup_needs_retry',
          domain: 'followup',
          studentIds: retryList.map((i) => i.student.id),
          cohortStudentIds: retryList.map((i) => i.student.id)
        }
      };
    }

    case 'followup_log': {
      const workingIds = new Set(workingStudents.map((s) => s.id));
      const scopedLogs = followupRecords.filter((r) => workingIds.has(matchRecordToStudentId(r, studentsById, students)));
      if (scopedLogs.length === 0) {
        return {
          text: `📒 سجل الافتقاد فارغ حالياً في النطاق المحدد.${syncFootnotes}`,
          meta: { intent: 'followup_log', domain: 'followup', studentIds: [] }
        };
      }
      const lines = scopedLogs.slice(0, 15).map((r, i) => {
        const outcomeStr = isPhoneMethod(r.type) ? ` • النتيجة: ${r.callOutcome || 'غير مسجل'}` : '';
        return `${i + 1}. ${r.studentName} — ${formatMethodDisplay(r.type)}${outcomeStr} (${r.date}) • الأشبين: ${r.servant}`;
      });
      const uniqueIds = Array.from(new Set(scopedLogs.map((r) => matchRecordToStudentId(r, studentsById, students))));
      return {
        text: `📒 أحدث سجلات الافتقاد (${scopedLogs.length} إجمالي — عرض ${lines.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        meta: { intent: 'followup_log', domain: 'followup', studentIds: uniqueIds, cohortStudentIds: uniqueIds }
      };
    }

    case 'followup_last_student': {
      const matches = findMentionedStudents(trimmed, workingStudents);
      if (matches.length === 0) {
        return {
          text: `لم أتعرف على اسم المخدوم في سؤالك. اكتب الاسم بالكامل أو الكود، مثال: «آخر مرة افتقدنا بيشوي عماد إمتى؟».${syncFootnotes}`,
          meta: { intent: 'followup_last_student', domain: 'followup', studentIds: [] }
        };
      }
      if (matches.length > 1) {
        return {
          text: `الاسم يطابق أكثر من مخدوم؛ إليك آخر افتقاد مسجل لكل منهم بالاسم والكود:\n\n${matches
            .slice(0, 8)
            .map((st, idx) => {
              const logs = followupRecords.filter((r) => matchRecordToStudentId(r, studentsById, students) === st.id);
              const latest = logs[0];
              const lastDate = latest?.date || st.lastFollowup || 'لا يوجد سجل افتقاد';
              const method = latest ? formatMethodDisplay(latest.type) : formatMethodDisplay(st.followupStatus);
              const out = latest && isPhoneMethod(latest.type) ? ` (نتيجة الاتصال: ${latest.callOutcome || 'غير مسجل'})` : '';
              return `${idx + 1}. ${st.name} (${st.code}) — ${lastDate} • ${method}${out}`;
            })
            .join('\n')}${syncFootnotes}`,
          meta: {
            intent: 'followup_last_student',
            domain: 'followup',
            studentIds: matches.map((s) => s.id),
            cohortStudentIds: matches.map((s) => s.id)
          }
        };
      }

      const target = matches[0];
      const logs = followupRecords.filter((r) => matchRecordToStudentId(r, studentsById, students) === target.id);
      if (logs.length === 0 && isEmptyFollowupStatus(target.followupStatus) && !target.lastFollowup) {
        return {
          text: `لا يوجد سجل افتقاد مسجل لـ ${target.name} (${target.code}) حتى الآن.${syncFootnotes}`,
          meta: { intent: 'followup_last_student', domain: 'followup', studentIds: [target.id] }
        };
      }
      const latest = logs[0];
      const lastDate = latest?.date || target.lastFollowup || 'غير محدد';
      const method = formatMethodDisplay(latest?.type || target.followupStatus);
      const outcomeLine =
        isPhoneMethod(latest?.type || target.followupStatus)
          ? `\n• نتيجة الاتصال: ${latest?.callOutcome || target.lastCallOutcome || 'غير مسجل'}`
          : '';
      return {
        text: `📅 آخر افتقاد لـ ${target.name} (${target.code}):\n• التاريخ: ${lastDate}\n• الوسيلة: ${method}${outcomeLine}\n• الأشبين: ${latest?.servant || target.servant}\n• إجمالي مرات الافتقاد المسجلة: ${Math.max(logs.length, Object.keys(target.fu || {}).length)}${syncFootnotes}`,
        meta: { intent: 'followup_last_student', domain: 'followup', studentIds: [target.id] }
      };
    }

    case 'followup_multiple': {
      const workingIds = new Set(workingStudents.map((s) => s.id));
      const counts = new Map<string, { student: Student; count: number; records: FollowupRecord[] }>();

      for (const r of followupRecords) {
        if (isEmptyFollowupStatus(r.type)) continue;
        const sid = matchRecordToStudentId(r, studentsById, students);
        if (!workingIds.has(sid)) continue;
        const st = studentsById.get(sid);
        if (!st) continue;
        const entry = counts.get(sid) || { student: st, count: 0, records: [] };
        entry.count++;
        entry.records.push(r);
        counts.set(sid, entry);
      }

      // Also count distinct student.fu dates if followupRecords was empty
      for (const s of workingStudents) {
        const fuDates = Object.entries(s.fu || {}).filter(([, val]) => !isEmptyFollowupStatus(val));
        const currentCount = counts.get(s.id)?.count || 0;
        if (fuDates.length > currentCount && fuDates.length >= 2) {
          counts.set(s.id, { student: s, count: fuDates.length, records: counts.get(s.id)?.records || [] });
        }
      }

      const multiple = Array.from(counts.values())
        .filter((e) => e.count >= 2)
        .sort((a, b) => b.count - a.count);

      if (multiple.length === 0) {
        return {
          text: `لا يوجد مخدومون لديهم أكثر من سجل افتقاد واحد في البيانات المسجلة حالياً.${syncFootnotes}`,
          meta: { intent: 'followup_multiple', domain: 'followup', studentIds: [] }
        };
      }

      const lines = multiple.map(
        (m, i) => `${i + 1}. ${m.student.name} (${m.student.code}) — ${m.count} مرات • الأشبين: ${m.student.servant}`
      );
      return {
        text: `🔁 المخدومون الذين تم افتقادهم أكثر من مرة (${multiple.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        meta: {
          intent: 'followup_multiple',
          domain: 'followup',
          studentIds: multiple.map((m) => m.student.id),
          cohortStudentIds: multiple.map((m) => m.student.id)
        }
      };
    }

    // ========================================================================
    // DOMAIN 3: STUDENTS DATA
    // ========================================================================
    case 'students_count': {
      const byClass = new Map<string, number>();
      for (const s of students) {
        const cls = s.sourceSheet || 'غير محدد';
        byClass.set(cls, (byClass.get(cls) || 0) + 1);
      }
      const breakdown = Array.from(byClass.entries())
        .map(([cls, count]) => `• ${cls}: ${count} مخدوم`)
        .join('\n');

      return {
        text: `👥 إجمالي المخدومين المسجلين (${students.length} مخدوم):\n\n${breakdown}${syncFootnotes}`,
        meta: { intent: 'students_count', domain: 'students', studentIds: students.map((s) => s.id) }
      };
    }

    case 'students_list': {
      const preview = workingStudents.slice(0, 30);
      const listLines = preview.map((s, i) => formatUniqueStudentLine(s, i)).join('\n');
      const extraNote =
        workingStudents.length > preview.length ? `\n\n… وعرض أول ${preview.length} من إجمالي ${workingStudents.length} مخدوم.` : '';
      return {
        text: `📋 قائمة المخدومين (${workingStudents.length}):\n\n${listLines}${extraNote}${syncFootnotes}`,
        copyText: workingStudents.map((s) => s.name).join('\n'),
        meta: {
          intent: 'students_list',
          domain: 'students',
          studentIds: workingStudents.map((s) => s.id),
          cohortStudentIds: workingStudents.map((s) => s.id)
        }
      };
    }

    case 'students_active': {
      const activeList = students.filter((s) => s.sourceSheet === 'نشط');
      if (activeList.length === 0) {
        return { text: `لا يوجد مخدومون في قسم «نشط» حالياً.${syncFootnotes}`, meta: { intent: 'students_active', domain: 'students', studentIds: [] } };
      }
      const lines = activeList.slice(0, 30).map((s, i) => formatUniqueStudentLine(s, i));
      return {
        text: `✅ المخدومون النشطون — فصل «نشط» (${activeList.length}):\n\n${lines.join('\n')}${activeList.length > 30 ? `\n\n… من إجمالي ${activeList.length}` : ''}${syncFootnotes}`,
        copyText: activeList.map((s) => s.name).join('\n'),
        meta: { intent: 'students_active', domain: 'students', studentIds: activeList.map((s) => s.id), cohortStudentIds: activeList.map((s) => s.id) }
      };
    }

    case 'students_inactive': {
      const inactiveList = students.filter((s) => s.sourceSheet === 'غير نشط' || s.sourceSheet === 'غير حاضر');
      if (inactiveList.length === 0) {
        return {
          text: `لا يوجد مخدومون مسجلون في أقسام «غير نشط» أو «غير حاضر» حالياً.${syncFootnotes}`,
          meta: { intent: 'students_inactive', domain: 'students', studentIds: [] }
        };
      }
      const lines = inactiveList.map((s, i) => formatUniqueStudentLine(s, i));
      return {
        text: `📁 المخدومون في الأقسام غير النشطة (${inactiveList.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: inactiveList.map((s) => s.name).join('\n'),
        meta: { intent: 'students_inactive', domain: 'students', studentIds: inactiveList.map((s) => s.id), cohortStudentIds: inactiveList.map((s) => s.id) }
      };
    }

    case 'students_new': {
      // Check if any local records carry UUID id (added via app) vs Google Sheets imported rows without timestamps
      const localAdded = workingStudents.filter((s) => !s.id.startsWith('gs_'));
      if (localAdded.length > 0) {
        return {
          text: `🆕 المخدومون المضافون عبر التطبيق في القائمة الحالية (${localAdded.length}):\n\n${localAdded
            .map((s, i) => formatUniqueStudentLine(s, i))
            .join('\n')}\n\nملاحظة: صفوف Google Sheets المستوردة لا تحتوي على عمود تاريخ إنشاء (Timestamp)، لذلك لا يُفترض ترتيب زمني غير مسجل للبقية.${syncFootnotes}`,
          meta: { intent: 'students_new', domain: 'students', studentIds: localAdded.map((s) => s.id) }
        };
      }
      return {
        text: `ℹ️ سجلات Google Sheets المستوردة (${workingStudents.length} مخدوم) لا تحتوي على حقل تاريخ إضافة (Created Timestamp)، لذا لا يمكن الجزم بأحدث المنضمين دون توثيق تاريخ التسجيل في الشيت.${syncFootnotes}`,
        meta: { intent: 'students_new', domain: 'students', studentIds: [] }
      };
    }

    case 'students_missing_phones': {
      const noPhones = workingStudents.filter(
        (s) => !String(s.phoneStudent || '').trim() && !String(s.phoneParent1 || '').trim() && !String(s.phoneParent2 || '').trim()
      );
      if (noPhones.length === 0) {
        return {
          text: `✅ جميع المخدومين في النطاق الحالي (${workingStudents.length}) لديهم رقم تليفون مسجل على الأقل (طالب أو ولي أمر).${syncFootnotes}`,
          meta: { intent: 'students_missing_phones', domain: 'students', studentIds: [] }
        };
      }
      const lines = noPhones.map((s, i) => formatUniqueStudentLine(s, i, 'لا يوجد أي رقم تليفون'));
      return {
        text: `📵 المخدومون بدون أي رقم تليفون مسجل (${noPhones.length} من ${workingStudents.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: noPhones.map((s) => s.name).join('\n'),
        meta: {
          intent: 'students_missing_phones',
          domain: 'students',
          studentIds: noPhones.map((s) => s.id),
          cohortStudentIds: noPhones.map((s) => s.id)
        }
      };
    }

    case 'students_missing_data': {
      const missingEntries: Array<{ student: Student; missingFields: string[] }> = [];
      for (const s of workingStudents) {
        const missing: string[] = [];
        if (!String(s.phoneStudent || '').trim() && !String(s.phoneParent1 || '').trim() && !String(s.phoneParent2 || '').trim()) {
          missing.push('رقم تليفون');
        }
        if (!String(s.birthDate || '').trim()) missing.push('تاريخ الميلاد');
        if (!String(s.area || '').trim() || s.area === 'غير محددة') missing.push('المنطقة');
        if (!String(s.servant || '').trim() || s.servant === 'غير محدد') missing.push('الأشبين');
        if (missing.length > 0) missingEntries.push({ student: s, missingFields: missing });
      }
      if (missingEntries.length === 0) {
        return {
          text: `✅ بيانات جميع المخدومين في النطاق الحالي مكتملة (التليفون، الميلاد، المنطقة، الأشبين).${syncFootnotes}`,
          meta: { intent: 'students_missing_data', domain: 'students', studentIds: [] }
        };
      }
      const lines = missingEntries.slice(0, 20).map((e, i) => `${i + 1}. ${e.student.name} (${e.student.code}) — ناقص: ${e.missingFields.join('، ')}`);
      return {
        text: `📝 مخدومون تنقصهم بيانات أساسية (${missingEntries.length}):\n\n${lines.join('\n')}${
          missingEntries.length > 20 ? `\n\n… وعرض أول 20 من ${missingEntries.length}` : ''
        }${syncFootnotes}`,
        meta: {
          intent: 'students_missing_data',
          domain: 'students',
          studentIds: missingEntries.map((e) => e.student.id),
          cohortStudentIds: missingEntries.map((e) => e.student.id)
        }
      };
    }

    // ========================================================================
    // DOMAIN 5: CLASSES & CATEGORIES
    // ========================================================================
    case 'class_list': {
      const existing = getExistingClasses(students);
      if (existing.length === 0) {
        return { text: `لا توجد فصول محملة حالياً.${syncFootnotes}`, meta: { intent: 'class_list', domain: 'classes' } };
      }
      const lines = existing.map((cls, i) => {
        const count = students.filter((s) => s.sourceSheet === cls).length;
        return `${i + 1}. ${cls} — ${count} مخدوم`;
      });
      return {
        text: `🏫 الفصول والتصنيفات الموجودة فعلياً في قاعدة البيانات (${existing.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        actions: [{ label: '📊 قارن بين الفصول', type: 'prompt', payload: 'قارن بين الفصول' }],
        meta: { intent: 'class_list', domain: 'classes', studentIds: students.map((s) => s.id) }
      };
    }

    case 'class_students': {
      const clsName = scope.classScope;
      if (!clsName) {
        return processAssistantQuery('إيه الفصول الموجودة؟', students, options);
      }
      const clsStudents = students.filter((s) => s.sourceSheet === clsName);
      if (clsStudents.length === 0) {
        return {
          text: `فصل «${clsName}» لا يحتوي على مخدومين مسجلين حالياً (0).${syncFootnotes}`,
          meta: { intent: 'class_students', domain: 'classes', classScope: clsName, studentIds: [] }
        };
      }
      const lines = clsStudents.map((s, i) => formatUniqueStudentLine(s, i));
      return {
        text: `🏫 مخدومو «${clsName}» (${clsStudents.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: clsStudents.map((s) => s.name).join('\n'),
        meta: {
          intent: 'class_students',
          domain: 'classes',
          classScope: clsName,
          studentIds: clsStudents.map((s) => s.id),
          cohortStudentIds: clsStudents.map((s) => s.id)
        }
      };
    }

    case 'class_attendance': {
      const clsName = scope.classScope;
      const targetFriday = scope.dateRange.primaryFriday;
      if (!clsName) {
        return processAssistantQuery('قارن بين الفصول', students, options);
      }
      const clsStudents = students.filter((s) => s.sourceSheet === clsName);
      const present = clsStudents.filter((s) => s.att?.[targetFriday] === true).length;
      const absent = clsStudents.filter((s) => s.att?.[targetFriday] === false).length;
      const unrec = Math.max(0, clsStudents.length - present - absent);
      const recTotal = present + absent;
      const rateRec = recTotal > 0 ? `${Math.round((present / recTotal) * 100)}% (${present}/${recTotal})` : 'غير مسجل';
      const rateAll = clsStudents.length > 0 ? `${Math.round((present / clsStudents.length) * 100)}% (${present}/${clsStudents.length})` : '0%';
      return {
        text: `📊 حضور «${clsName}» — ${scope.dateRange.label}:\n• إجمالي الفصل: ${clsStudents.length}\n• حاضر: ${present} | غائب مسجل: ${absent} | غير مسجل: ${unrec}\n• نسبة المسجلين: ${rateRec}\n• نسبة الإجمالي: ${rateAll}${syncFootnotes}`,
        meta: {
          intent: 'class_attendance',
          domain: 'classes',
          classScope: clsName,
          targetFriday,
          studentIds: clsStudents.map((s) => s.id)
        }
      };
    }

    case 'class_comparison': {
      const existing = getExistingClasses(students);
      const targetFriday = scope.dateRange.primaryFriday;
      if (existing.length === 0) {
        return { text: `لا توجد فصول للمقارنة.${syncFootnotes}`, meta: { intent: 'class_comparison', domain: 'classes' } };
      }
      const lines = existing.map((cls, i) => {
        const clsStudents = students.filter((s) => s.sourceSheet === cls);
        const present = clsStudents.filter((s) => s.att?.[targetFriday] === true).length;
        const absent = clsStudents.filter((s) => s.att?.[targetFriday] === false).length;
        const unrec = Math.max(0, clsStudents.length - present - absent);
        const recTotal = present + absent;
        const rate = recTotal > 0 ? `${Math.round((present / recTotal) * 100)}% من المسجلين` : 'بدون تسجيل';
        return `${i + 1}. ${cls} (${clsStudents.length} مخدوم): حضور ${present} | غياب ${absent} | غير مسجل ${unrec} — ${rate}`;
      });
      return {
        text: `🏫 مقارنة الفصول — ${scope.dateRange.label}:\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: lines.join('\n'),
        meta: { intent: 'class_comparison', domain: 'classes', targetFriday }
      };
    }

    // ========================================================================
    // DOMAIN 4: STATS & GENERAL REPORTS + BIRTHDAYS + MESSAGES + SEARCH + FAQ
    // ========================================================================
    case 'stats': {
      const currentFriday = scope.dateRange.primaryFriday;
      const fuWeek = scope.dateRange.followupFriday;
      const total = workingStudents.length;
      const present = workingStudents.filter((s) => s.att?.[currentFriday] === true).length;
      const absent = workingStudents.filter((s) => s.att?.[currentFriday] === false).length;
      const unrecorded = Math.max(0, total - present - absent);
      const recordedTotal = present + absent;
      const attPctOverall = total > 0 ? Math.round((present / total) * 100) : 0;
      const attPctRecorded = recordedTotal > 0 ? Math.round((present / recordedTotal) * 100) : null;
      const regular = workingStudents.filter((s) => Number(s.attendanceMonth) >= 3).length;
      const zeroMonth = workingStudents.filter((s) => Number(s.attendanceMonth) === 0).length;
      const followedUp = workingStudents.filter((s) => isStudentFollowedUpInWeek(s, fuWeek, followupRecords).followedUp).length;
      const fuPct = total > 0 ? Math.round((followedUp / total) * 100) : 0;
      const servants = new Set(workingStudents.map((s) => s.servant?.trim()).filter(Boolean)).size;

      const summary = [
        `📊 إحصائيات الخدمة الحقيقية (${scope.dateRange.label})${scope.classScope ? ` — فصل: ${scope.classScope}` : ''}:`,
        `• إجمالي المخدومين المحملين: ${total} (موزعين على ${servants} خادم/أشبين)`,
        `• حضور ${currentFriday}: ${present} (${attPctOverall}% من الإجمالي${
          attPctRecorded !== null ? ` • ${attPctRecorded}% من المسجلين` : ''
        }) | غياب مسجل: ${absent} | لم يُسجل: ${unrecorded}`,
        `• المنتظمون هذا الشهر (3+): ${regular} | لم يحضروا هذا الشهر: ${zeroMonth}`,
        `• نسبة الافتقاد هذا الأسبوع (${fuWeek}): ${followedUp}/${total} (${fuPct}%)`,
        options?.lastSyncLabel ? `• آخر مزامنة ناجحة: ${options.lastSyncLabel}` : '• المزامنة: لم تتم مزامنة موثقة بعد'
      ].join('\n');

      return {
        text: `${summary}${syncFootnotes}`,
        copyText: summary,
        actions: [
          { label: '⚠️ عرض الغائبين', type: 'prompt', payload: 'الغائبون' },
          { label: '🏆 الأكثر التزاماً', type: 'prompt', payload: 'أفضل حضور' },
          { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' }
        ],
        meta: { intent: 'stats', domain: 'stats', targetFriday: currentFriday }
      };
    }

    case 'general_report': {
      const currentFriday = scope.dateRange.primaryFriday;
      const fuWeek = scope.dateRange.followupFriday;
      const total = workingStudents.length;
      const present = workingStudents.filter((s) => s.att?.[currentFriday] === true).length;
      const absent = workingStudents.filter((s) => s.att?.[currentFriday] === false).length;
      const unrecorded = Math.max(0, total - present - absent);
      const recordedTotal = present + absent;
      const attPctRec = recordedTotal > 0 ? `${Math.round((present / recordedTotal) * 100)}%` : 'غير مسجل';
      const attPctAll = total > 0 ? `${Math.round((present / total) * 100)}%` : '0%';
      const fuDone = workingStudents.filter((s) => isStudentFollowedUpInWeek(s, fuWeek, followupRecords).followedUp).length;
      const fuMissing = total - fuDone;

      const contacted = followupRecords.filter((r) => r.callOutcome === 'تم التواصل').length;
      const notContacted = followupRecords.filter((r) => r.callOutcome === 'لم يتم التواصل').length;
      const legacyCalls = followupRecords.filter((r) => isPhoneMethod(r.type) && !r.callOutcome).length;
      const noPhones = workingStudents.filter((s) => !s.phoneStudent && !s.phoneParent1 && !s.phoneParent2).length;
      const byClass = getExistingClasses(workingStudents)
        .map((c) => `${c} (${workingStudents.filter((s) => s.sourceSheet === c).length})`)
        .join(' • ');

      const report = [
        `📑 ملخص وتقرير الخدمة الشامل — ${scope.dateRange.label}:`,
        `• الفصول: ${byClass || 'غير محدد'} | الإجمالي: ${total} مخدوم`,
        `• الحضور: ${present} حاضر | ${absent} غائب مسجل | ${unrecorded} لم يُسجل بعد`,
        `• نسبة الحضور: ${attPctRec} من المسجلين (${attPctAll} من الإجمالي)`,
        `• افتقاد أسبوع (${fuWeek}): تم افتقاد ${fuDone} • متبقي ${fuMissing}`,
        `• نتائج الاتصالات التليفونية: تم التواصل (${contacted}) | لم يتم التواصل (${notContacted})${
          legacyCalls > 0 ? ` | غير مسجل (${legacyCalls})` : ''
        }`,
        `• تنبيهات بيانات: بدون أرقام تليفون (${noPhones})`
      ].join('\n');

      return {
        text: `${report}${syncFootnotes}`,
        copyText: report,
        actions: [
          { label: '📝 لم تسجل حضور/غياب', type: 'prompt', payload: 'هات الأسماء اللي لم تسجل حضور أو غياب' },
          { label: '🔁 يحتاج متابعة تاني', type: 'prompt', payload: 'مين محتاج متابعة تاني؟' }
        ],
        meta: { intent: 'general_report', domain: 'stats', targetFriday: currentFriday }
      };
    }

    case 'birthdays': {
      const q = scope.normalizedQuery;
      const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
      let startOffsetDays = 0;
      let endOffsetDays = 7;
      let periodLabel = 'اليوم والـ 7 أيام القادمة';
      if (q.includes('الشهر القادم') || q.includes('الشهر الجاي') || q.includes('الشهر المقبل') || q.includes('الشهر اللي جاي')) {
        const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        const nextMonthEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0);
        startOffsetDays = Math.ceil((nextMonthStart.getTime() - today.getTime()) / 86400000);
        endOffsetDays = Math.floor((nextMonthEnd.getTime() - today.getTime()) / 86400000);
        periodLabel = 'الشهر القادم';
      } else {
        const daysMatch = q.match(/(\d+)\s*(?:يوم|ايام)/);
        if (daysMatch) {
          endOffsetDays = Math.min(366, Math.max(0, Number(daysMatch[1])));
          periodLabel = `خلال ${endOffsetDays} يوم`;
        } else if (q.includes('خلال شهر') || q.includes('بعد شهر')) {
          endOffsetDays = 30;
          periodLabel = 'خلال 30 يوم';
        } else if (q.includes('هذا الشهر') || q.includes('الشهر الحالي')) {
          const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
          endOffsetDays = Math.floor((monthEnd.getTime() - today.getTime()) / 86400000);
          periodLabel = 'باقي الشهر الحالي';
        }
      }
      const matches = getBirthdayStudents(workingStudents, endOffsetDays, referenceDate, startOffsetDays);
      if (matches.length === 0) {
        return {
          text: `لا توجد أعياد ميلاد مسجلة خلال ${periodLabel} من إجمالي ${workingStudents.length} مخدوم محمّل.${syncFootnotes}`,
          actions: [
            { label: '🎉 رسالة تهنئة عامة', type: 'prompt', payload: 'اكتب رسالة عيد ميلاد' },
            { label: '📊 عرض الإحصائيات', type: 'prompt', payload: 'إحصائيات' }
          ],
          meta: { intent: 'birthdays', domain: 'students', studentIds: [] }
        };
      }

      const lines = matches.map((m, idx) => {
        const when = m.daysUntil === 0 ? 'اليوم 🎂' : m.daysUntil === 1 ? 'غداً' : `خلال ${m.daysUntil} أيام`;
        return `${idx + 1}. ${m.student.name} (${m.day}/${m.month}) — ${when} • الأشبين: ${m.student.servant || 'غير محدد'}`;
      });

      const first = matches[0].student;
      const sampleMsg = MESSAGE_TEMPLATES.birthday[0].replace('{name}', first.name.split(' ')[0] || first.name);

      return {
        text: `🎂 أعياد الميلاد — ${periodLabel} (${matches.length}):\n\n${lines.join('\n')}${syncFootnotes}`,
        copyText: sampleMsg,
        whatsappText: sampleMsg,
        whatsappPhone: getPreferredPhone(first),
        actions: [{ label: `🎂 تهنئة ${first.name.split(' ')[0]}`, type: 'prompt', payload: `رسالة عيد ميلاد لـ ${first.name}` }],
        meta: { intent: 'birthdays', domain: 'students', studentIds: matches.map((m) => m.student.id) }
      };
    }

    case 'birthdayMessage':
    case 'message': {
      const qNorm = scope.normalizedQuery;
      const isNonFollowupCategory =
        intent === 'birthdayMessage' ||
        qNorm.includes('عيد') ||
        qNorm.includes('ميلاد') ||
        qNorm.includes('تشجيع') ||
        qNorm.includes('تحفيز') ||
        qNorm.includes('برافو') ||
        qNorm.includes('مبروك') ||
        qNorm.includes('نجاح') ||
        qNorm.includes('تهنئه') ||
        qNorm.includes('صلاه') ||
        qNorm.includes('صلي');

      const explicitStudent = findMentionedStudent(trimmed, workingStudents);
      const prevStudentId = prevMeta?.lastFollowupStudentId || prevMeta?.studentIds?.[0];
      const contextualStudent =
        !explicitStudent && prevStudentId
          ? workingStudents.find((s) => s.id === prevStudentId) || students.find((s) => s.id === prevStudentId) || null
          : null;
      const shouldUseContextualStudent =
        Boolean(contextualStudent) &&
        (qNorm.includes('ده') ||
          qNorm.includes('مختلفه') ||
          qNorm.includes('تانيه') ||
          qNorm.includes('ثانيه') ||
          qNorm.includes('غيرها') ||
          qNorm.includes('بديل') ||
          qNorm.includes('قصيره') ||
          qNorm.includes('مختصره') ||
          qNorm.includes('لولي الامر') ||
          qNorm.includes('للطالب') ||
          qNorm.includes('للمخدوم') ||
          qNorm.includes('افتقده') ||
          prevMeta?.intent === 'message' ||
          prevMeta?.intent === 'search');
      const targetStudent = explicitStudent || (shouldUseContextualStudent ? contextualStudent : null);

      if (!isNonFollowupCategory) {
        const wantsParent =
          qNorm.includes('ولي الامر') ||
          qNorm.includes('لولي الامر') ||
          qNorm.includes('الاهل') ||
          qNorm.includes('للاهل') ||
          qNorm.includes('الاسره') ||
          qNorm.includes('والد') ||
          qNorm.includes('والده') ||
          qNorm.includes('ماما') ||
          qNorm.includes('بابا');
        const wantsStudent =
          !wantsParent &&
          (qNorm.includes('للطالب') ||
            qNorm.includes('للمخدوم') ||
            qNorm.includes('الطالب') ||
            qNorm.includes('المخدوم')) &&
          !qNorm.includes('عايز افتقد الطالب ده');
        const wantsShort =
          qNorm.includes('قصيره') ||
          qNorm.includes('قصير') ||
          qNorm.includes('مختصره') ||
          qNorm.includes('مختصر') ||
          qNorm.includes('سريعه');
        const wantsDifferent =
          qNorm.includes('مختلفه') ||
          qNorm.includes('تانيه') ||
          qNorm.includes('ثانيه') ||
          qNorm.includes('غيرها') ||
          qNorm.includes('بديل') ||
          qNorm.includes('اخرى') ||
          qNorm.includes('اخري');
        const wantsMultiple =
          qNorm.includes('رسايل') ||
          qNorm.includes('رسائل') ||
          qNorm.includes('كذا رساله') ||
          qNorm.includes('اكتر من رساله') ||
          qNorm.includes('اكثر من رساله') ||
          qNorm.includes('خيارات') ||
          qNorm.includes('اقتراحات') ||
          /[2-5]\s*رسا/.test(qNorm);

        let audience: FollowupMessageAudience | undefined = wantsParent
          ? 'parent'
          : wantsStudent
          ? 'student'
          : wantsDifferent
          ? prevMeta?.lastFollowupAudience
          : undefined;

        // Collect all previously suggested template IDs from this session to avoid repeating
        const sessionSuggestedIds: string[] = [];
        for (const msg of options?.sessionMessages || []) {
          const ids = msg.meta?.suggestedFollowupTemplateIds;
          if (Array.isArray(ids)) {
            for (const id of ids) {
              if (id && !sessionSuggestedIds.includes(id)) sessionSuggestedIds.push(id);
            }
          }
        }
        const immediatelyPreviousIds = prevMeta?.suggestedFollowupTemplateIds || [];

        const phoneTarget = targetStudent ? resolveFollowupPhoneTarget(targetStudent) : null;
        if (!audience && phoneTarget?.hasValidPhone && !phoneTarget.isFallbackToStudent) {
          audience = 'parent';
        }

        // Check if excluding all session IDs exhausts the pool; if so, keep at least the immediately previous IDs excluded
        const matchingPool = FOLLOWUP_MESSAGE_TEMPLATES.filter((t) => {
          if (audience && t.audience !== audience) return false;
          if (wantsShort && !t.isShort) return false;
          return true;
        });
        const remainingPool = matchingPool.filter((t) => !sessionSuggestedIds.includes(t.id));
        const excludeTemplateIds =
          remainingPool.length > 0 ? sessionSuggestedIds : immediatelyPreviousIds;

        const selectionCtx = {
          student: targetStudent || undefined,
          className: targetStudent ? resolveFollowupClassName(targetStudent.sourceSheet) : undefined,
          audience,
          preferShort: wantsShort,
          excludeTemplateIds
        };

        if (wantsMultiple) {
          const suggestions = selectMultipleFollowupMessages(3, selectionCtx);
          const primary = suggestions[0];
          const audienceLabel =
            audience === 'parent'
              ? 'لولي الأمر'
              : audience === 'student'
              ? 'للطالب'
              : 'مناسبة للافتقاد';
          const targetLabel = targetStudent
            ? ` للمخدوم ${targetStudent.name} (${targetStudent.code})`
            : '';

          const formattedOptions = suggestions
            .map((opt, idx) => `${idx + 1}. (${opt.title}):\n${opt.message}`)
            .join('\n\n');

          const phoneNote = targetStudent
            ? phoneTarget?.hasValidPhone
              ? `\n\nرقم الإرسال المقترح: ${phoneTarget.sourceLabel} (${phoneTarget.rawPhone})`
              : `\n\nتنبيه: ${phoneTarget?.warningMessage || 'لا يوجد رقم هاتف صالح لهذا المخدوم، يمكنك نسخ الرسالة وإرسالها يدوياً.'}`
            : '';

          return {
            text: stripEmojis(
              `إليك ${suggestions.length} خيارات رسائل افتقاد ${audienceLabel}${targetLabel} (يمكنك تعديل الرسالة أو نسخها أو فتح واتساب للإرسال اليدوي):\n\n${formattedOptions}${phoneNote}`
            ),
            copyText: primary.message,
            whatsappText: primary.message,
            whatsappPhone: phoneTarget?.hasValidPhone ? (phoneTarget.rawPhone || phoneTarget.normalizedDigits || undefined) : undefined,
            actions: [
              { label: 'رسالة مختلفة', type: 'prompt', payload: 'هات رسالة مختلفة' },
              { label: 'رسالة لولي الأمر', type: 'prompt', payload: 'عايز رسالة لولي الأمر' },
              { label: 'رسالة للطالب', type: 'prompt', payload: 'اكتب رسالة للطالب' },
              { label: 'رسالة قصيرة', type: 'prompt', payload: 'اكتب رسالة قصيرة' }
            ],
            meta: {
              intent: 'message',
              domain: 'followup',
              studentIds: targetStudent ? [targetStudent.id] : [],
              lastFollowupStudentId: targetStudent?.id,
              lastFollowupAudience: primary.audience,
              suggestedFollowupTemplateIds: suggestions.map((s) => s.templateId),
              followupEditableDraft: primary.message,
              followupPhoneSourceLabel: phoneTarget?.hasValidPhone ? phoneTarget.sourceLabel : undefined,
              followupPhoneWarning: targetStudent && !phoneTarget?.hasValidPhone ? phoneTarget?.warningMessage : undefined,
              followupOptions: suggestions.map((s) => ({
                templateId: s.templateId,
                title: s.title,
                audience: s.audience,
                message: s.message
              }))
            }
          };
        }

        const picked = selectFollowupMessage(selectionCtx);
        const audienceTitle =
          picked.audience === 'parent'
            ? 'لولي الأمر'
            : picked.audience === 'student'
            ? 'للطالب'
            : 'عامة';
        const header = targetStudent
          ? `رسالة افتقاد (${audienceTitle} - ${picked.title}) للمخدوم ${targetStudent.name} (${targetStudent.code}):`
          : `رسالة افتقاد مقترحة (${audienceTitle} - ${picked.title}) — يمكنك تعديلها أو نسخها قبل الإرسال اليدوي:`;
        const phoneNote = targetStudent
          ? phoneTarget?.hasValidPhone
            ? `\n\nرقم واتساب المقترح: ${phoneTarget.sourceLabel} (${phoneTarget.rawPhone})`
            : `\n\nتنبيه: ${phoneTarget?.warningMessage || 'لا يوجد رقم هاتف مسجل لهذا المخدوم، يمكنك نسخ الرسالة وإرسالها يدوياً.'}`
          : '';

        return {
          text: stripEmojis(`${header}\n\n${picked.message}${phoneNote}`),
          copyText: picked.message,
          whatsappText: picked.message,
          whatsappPhone: phoneTarget?.hasValidPhone ? (phoneTarget.rawPhone || phoneTarget.normalizedDigits || undefined) : undefined,
          actions: [
            { label: 'رسالة مختلفة', type: 'prompt', payload: 'هات رسالة مختلفة' },
            { label: 'رسالة لولي الأمر', type: 'prompt', payload: 'عايز رسالة لولي الأمر' },
            { label: 'رسالة للطالب', type: 'prompt', payload: 'اكتب رسالة للطالب' },
            { label: 'رسالة قصيرة', type: 'prompt', payload: 'اكتب رسالة قصيرة' }
          ],
          meta: {
            intent: 'message',
            domain: 'followup',
            studentIds: targetStudent ? [targetStudent.id] : [],
            lastFollowupStudentId: targetStudent?.id,
            lastFollowupAudience: picked.audience,
            suggestedFollowupTemplateIds: [picked.templateId],
            followupEditableDraft: picked.message,
            followupPhoneSourceLabel: phoneTarget?.hasValidPhone ? phoneTarget.sourceLabel : undefined,
            followupPhoneWarning: targetStudent && !phoneTarget?.hasValidPhone ? phoneTarget?.warningMessage : undefined
          }
        };
      }

      const { text: rawTemplate } = pickMessageTemplate(trimmed);
      const displayName = targetStudent ? targetStudent.name.split(' ')[0] : 'بطل مارجرجس';
      const filledMessage = rawTemplate.replace(/\{name\}/g, displayName);
      const phone = targetStudent ? getPreferredPhone(targetStudent) : undefined;

      const header = targetStudent
        ? `رسالة جاهزة إلى ${targetStudent.name} (${targetStudent.code}):`
        : 'رسالة جاهزة (يمكنك نسخها أو تعديل الاسم قبل الإرسال):';

      return {
        text: `${header}\n\n"${filledMessage}"`,
        copyText: filledMessage,
        whatsappText: filledMessage,
        whatsappPhone: phone,
        actions: [
          { label: 'رسالة افتقاد', type: 'prompt', payload: 'اكتب رسالة افتقاد' },
          { label: 'رسالة عيد ميلاد', type: 'prompt', payload: 'رسالة عيد ميلاد' },
          { label: 'رسالة تشجيع', type: 'prompt', payload: 'رسالة تشجيع' }
        ],
        meta: { intent, domain: 'other', studentIds: targetStudent ? [targetStudent.id] : [] }
      };
    }

    case 'faq': {
      const matched = matchFaq(trimmed);
      if (matched) {
        return {
          text: matched.answer,
          actions: [{ label: '📊 إحصائيات الخدمة', type: 'prompt', payload: 'إحصائيات' }],
          meta: { intent: 'faq', domain: 'other' }
        };
      }
      return {
        text: 'يمكنني مساعدتك في: أعياد الميلاد، حالات الحضور والغياب والأسماء غير المسجلة، سجل الافتقاد ونتائج الاتصال، كتابة رسائل افتقاد جاهزة للواتساب، بيانات المخدومين الناقصة، المقارنة بين الفصول، وتوليد تقارير الخدمة الفورية.',
        actions: [
          { label: '📝 لم تسجل حضور/غياب', type: 'prompt', payload: 'هات الأسماء اللي لم تسجل حضور أو غياب' },
          { label: '📊 ملخص الخدمة', type: 'prompt', payload: 'اعرض ملخص الخدمة' },
          { label: 'رسالة افتقاد', type: 'prompt', payload: 'اكتب رسالة افتقاد' }
        ],
        meta: { intent: 'faq', domain: 'other' }
      };
    }

    case 'search': {
      const q = scope.normalizedQuery
        .replace(/^(?:بيانات|معلومات|تليفون|رقم|حاله|هات|اعرض|ابحث عن|دور على)\s+/g, '')
        .trim();
      const matchedStudents = workingStudents.filter((s) => {
        const hay = normalizeAssistantInput(`${s.name} ${s.code} ${s.servant} ${s.area} ${s.address} ${s.notes} ${s.sourceSheet}`);
        return hay.includes(q || scope.normalizedQuery);
      });

      if (matchedStudents.length > 0) {
        const top = matchedStudents.slice(0, 8);
        const lines = top.map((s, idx) => {
          const phone = s.phoneParent1 || s.phoneParent2 || s.phoneStudent || 'غير مسجل';
          const outcomeTxt = s.lastCallOutcome ? ` • نتيجة الاتصال: ${s.lastCallOutcome}` : '';
          return `${idx + 1}. ${s.name} (${s.code})\n   الأشبين: ${s.servant || '-'} | الفصل: ${s.sourceSheet} | حضور: ${s.attendanceTotal} (${s.attendanceMonth}/4)\n   📞 ${phone} | الافتقاد: ${formatMethodDisplay(s.followupStatus)}${outcomeTxt}`;
        });
        const first = top[0];
        const firstPhoneTarget = resolveFollowupPhoneTarget(first);
        const searchFollowupText = renderFollowupMessageTemplate(FOLLOWUP_MESSAGE_TEMPLATES[0], {
          studentName: first.name,
          className: resolveFollowupClassName(first.sourceSheet)
        });
        return {
          text: `🔎 نتائج البحث عن «${trimmed}» (${matchedStudents.length}):\n\n${lines.join('\n\n')}${syncFootnotes}`,
          whatsappPhone: firstPhoneTarget.hasValidPhone ? firstPhoneTarget.normalizedDigits || undefined : undefined,
          whatsappText: searchFollowupText,
          actions: [{ label: `رسالة افتقاد لـ ${first.name.split(' ')[0]}`, type: 'prompt', payload: `اكتب رسالة افتقاد لـ ${first.name}` }],
          meta: {
            intent: 'search',
            domain: 'students',
            studentIds: matchedStudents.map((s) => s.id),
            cohortStudentIds: matchedStudents.map((s) => s.id),
            lastFollowupStudentId: first.id
          }
        };
      }

      const faqMatch = matchFaq(trimmed);
      if (faqMatch) {
        return { text: faqMatch.answer, meta: { intent: 'faq', domain: 'other' } };
      }

      return {
        text: `لم أجد نتائج تطابق «${trimmed}» داخل ${students.length} مخدوم محمل أو دليل الاستخدام. جرب البحث بالاسم أو الكود أو اسم الأشبين، أو اختر أمراً سريعاً:`,
        actions: [
          { label: '📊 إحصائيات', type: 'prompt', payload: 'إحصائيات' },
          { label: '📝 لم تسجل حضور/غياب', type: 'prompt', payload: 'هات الأسماء اللي لم تسجل حضور أو غياب' },
          { label: '⚠️ الغائبون', type: 'prompt', payload: 'مين غاب آخر جمعة؟' }
        ],
        meta: { intent: 'search', domain: 'other' }
      };
    }

    case 'chatHistory': {
      const pastSessions = options?.pastSessions || [];
      if (pastSessions.length === 0) {
        return {
          text: 'لا توجد محادثات سابقة مؤرشفة حتى الآن. كل مرة تفتح فيها المساعد الذكي تبدأ جلسة جديدة ومستقلة، وتُحفظ الجلسة في السجل تلقائياً عند احتوائها على أسئلة وإغلاقها.',
          actions: [
            { label: '📊 إحصائيات', type: 'prompt', payload: 'إحصائيات' },
            { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' }
          ],
          meta: { intent: 'chatHistory', domain: 'other' }
        };
      }

      const historyList = pastSessions
        .slice(0, 5)
        .map((s, idx) => {
          const d = new Date(s.updatedAt || s.createdAt);
          const dateStr = d.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const userCount = (s.messages || []).filter((m) => m.role === 'user').length;
          return `${idx + 1}. «${s.title}» (${dateStr} • ${userCount} أسئلة)`;
        })
        .join('\n');

      return {
        text: `📂 لديك ${pastSessions.length} جلسة سابقة محفوظة في سجل المحادثات:\n\n${historyList}\n\nيمكنك استعراض أي جلسة سابقة بالضغط على أيقونة «سجل المحادثات» 🕒 في أعلى النافذة دون التأثير على الجلسة الحالية.`,
        actions: [
          { label: '🔄 محادثة جديدة', type: 'prompt', payload: 'محادثة جديدة' },
          { label: '📊 إحصائيات', type: 'prompt', payload: 'إحصائيات' }
        ],
        meta: { intent: 'chatHistory', domain: 'other' }
      };
    }

    case 'help':
    default: {
      return {
        text: [
          'أهلاً بك في المساعد الذكي (يعمل محلياً بالكامل بدون إنترنت ويستعلم مباشرة من بيانات الخدمة الحقيقية):',
          '• «هات الأسماء اللي لم تسجل حضور أو غياب» / «قارن آخر جمعتين» — الحضور والغياب الدقيق',
          '• «مين تم التواصل معاه؟» / «مين محدش رد عليه؟» / «مين محتاج متابعة تاني؟» — نتائج الافتقاد والاتصالات',
          '• «مين ما عندوش رقم تليفون؟» / «مين بياناته ناقصة؟» / «كام مخدوم في كل فصل؟» — بيانات المخدومين',
          '• «اعرض ملخص الخدمة» / «قارن بين الفصول» — الإحصائيات والتقارير والتصنيفات',
          '• متابعة الأسئلة في نفس الجلسة: اسأل مثلاً «مين غاب آخر جمعة؟» ثم «مين فيهم اتعمله افتقاد؟»'
        ].join('\n'),
        actions: [
          { label: '📝 لم تسجل حضور/غياب', type: 'prompt', payload: 'هات الأسماء اللي لم تسجل حضور أو غياب' },
          { label: '📊 ملخص الخدمة', type: 'prompt', payload: 'اعرض ملخص الخدمة' },
          { label: '⚠️ الغائبون', type: 'prompt', payload: 'مين غاب آخر جمعة؟' },
          { label: '📞 لم يتم التواصل', type: 'prompt', payload: 'مين محدش رد عليه؟' }
        ],
        meta: { intent: 'help', domain: 'other' }
      };
    }
  }
}

export interface VerifiedAttendanceSelectionInput {
  studentId: string;
  isPresent: boolean;
}

export interface VerifiedAttendanceBatchPlan {
  validEntries: Array<{
    studentId: string;
    studentName: string;
    studentCode: string;
    fridayDate: string;
    isPresent: boolean;
  }>;
  skippedAlreadyRecorded: Array<{
    studentId: string;
    studentName: string;
    existingPresent: boolean;
    reason: string;
  }>;
  skippedAlreadyQueued: Array<{
    studentId: string;
    studentName: string;
    reason: string;
  }>;
  blockedUnauthorized: Array<{
    studentId: string;
    studentName: string;
    reason: string;
  }>;
  notFoundIds: string[];
}

export function prepareVerifiedAssistantAttendanceBatch(
  requestedSelections: ReadonlyArray<VerifiedAttendanceSelectionInput>,
  liveStudents: ReadonlyArray<Student>,
  targetFridayDate: string,
  existingQueuedMutations: ReadonlyArray<{
    action: string;
    studentId: string;
    status?: string;
    payload?: Record<string, any>;
  }> = [],
  canPerformAction: (action: 'attendance', servantName?: string) => { allowed: boolean; reason?: string } = () => ({ allowed: true })
): VerifiedAttendanceBatchPlan {
  const studentsById = new Map(liveStudents.map((s) => [s.id, s]));
  const queuedAttendanceKeys = new Set<string>();
  for (const m of existingQueuedMutations) {
    if (m.action !== 'attendance') continue;
    const mFri = String(m.payload?.friday || m.payload?.date || '').trim();
    if (m.studentId && mFri) {
      queuedAttendanceKeys.add(`${m.studentId}__${mFri}`);
    }
  }

  const validEntries: VerifiedAttendanceBatchPlan['validEntries'] = [];
  const skippedAlreadyRecorded: VerifiedAttendanceBatchPlan['skippedAlreadyRecorded'] = [];
  const skippedAlreadyQueued: VerifiedAttendanceBatchPlan['skippedAlreadyQueued'] = [];
  const blockedUnauthorized: VerifiedAttendanceBatchPlan['blockedUnauthorized'] = [];
  const notFoundIds: string[] = [];
  const seenLogicalKeys = new Set<string>();

  for (const sel of requestedSelections) {
    const logicalKey = `${sel.studentId}__${targetFridayDate}`;
    if (seenLogicalKeys.has(logicalKey)) continue;
    seenLogicalKeys.add(logicalKey);

    const liveStudent = studentsById.get(sel.studentId);
    if (!liveStudent) {
      notFoundIds.push(sel.studentId);
      continue;
    }

    const perm = canPerformAction('attendance', liveStudent.servant);
    if (!perm.allowed) {
      blockedUnauthorized.push({
        studentId: liveStudent.id,
        studentName: liveStudent.name,
        reason: perm.reason || 'غير مصرح بتعديل سجلات هذا المخدوم'
      });
      continue;
    }

    const existingVal = liveStudent.att?.[targetFridayDate];
    if (typeof existingVal === 'boolean') {
      skippedAlreadyRecorded.push({
        studentId: liveStudent.id,
        studentName: liveStudent.name,
        existingPresent: existingVal,
        reason: `مسجل بالفعل (${existingVal ? 'حاضر' : 'غائب'})`
      });
      continue;
    }

    if (queuedAttendanceKeys.has(logicalKey)) {
      skippedAlreadyQueued.push({
        studentId: liveStudent.id,
        studentName: liveStudent.name,
        reason: 'موجود بالفعل في طابور المزامنة لهذا التاريخ'
      });
      continue;
    }

    validEntries.push({
      studentId: liveStudent.id,
      studentName: liveStudent.name,
      studentCode: liveStudent.code,
      fridayDate: targetFridayDate,
      isPresent: Boolean(sel.isPresent)
    });
  }

  return {
    validEntries,
    skippedAlreadyRecorded,
    skippedAlreadyQueued,
    blockedUnauthorized,
    notFoundIds
  };
}

export const AssistantIntentEngine = {
  normalizeInput: normalizeAssistantInput,
  detectIntent: detectAssistantIntent,
  extractScope: extractQueryScope,
  resolveDateRange: resolveAssistantDateRange,
  query: processAssistantQuery,
  prepareVerifiedBatch: prepareVerifiedAssistantAttendanceBatch
};
