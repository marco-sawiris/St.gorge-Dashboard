import { Student } from '../types/student';
import { getLatestHeldFridayString, getNearestFridayString, normalizeArabicText } from '../utils/arabicUtils';

export interface AssistantAction {
  label: string;
  type: 'prompt' | 'sync' | 'copy' | 'whatsapp';
  payload: string;
  phone?: string;
}

export type AssistantCommand =
  | { type: 'markAttendance'; studentId: string; studentName: string; isPresent: boolean; targetFridayDate: string }
  | { type: 'openEdit'; studentId: string; studentName: string }
  | { type: 'recordFollowupBatch'; students: Array<{ id: string; name: string }>; method: 'تم تليفونياً' | 'واتساب' | 'تم بزيارة'; weekFridayDate: string };

export interface AssistantMessage {
  id: string;
  role: 'user' | 'bot';
  text: string;
  copyText?: string;
  whatsappText?: string;
  whatsappPhone?: string;
  actions?: AssistantAction[];
  command?: AssistantCommand;
  timestamp: number;
}

export interface AssistantResponse {
  text: string;
  copyText?: string;
  whatsappText?: string;
  whatsappPhone?: string;
  actions?: AssistantAction[];
  command?: AssistantCommand;
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
    keys: ['حضور', 'تسجيل الحضور', 'غياب', 'غائب', 'حاضر'],
    answer:
      'لتسجيل الحضور: اضغط زر الحضور داخل الكارت أو في الجدول لتحويل الحالة بين «حاضر» و«غائب» لأقرب جمعة. يتم الحفظ فوراً في IndexedDB ثم المزامنة مع Google Sheets.'
  },
  {
    keys: ['مسارات', 'شريط', 'حضور شهري', 'تتبع', 'نقاط'],
    answer:
      'يحتوي كل كارت على مسارين:\n• مسار الحضور الشهري (X/4): يعرض عدد مرات حضور الشهر حتى 4 جمعات.\n• مسار الافتقاد: يعرض الحالة الحالية وعدد مرات الافتقاد المسجلة، ويمكن النقر عليه لفتح نافذة تسجيل الافتقاد فوراً.'
  },
  {
    keys: ['افتقاد', 'سجل الافتقاد', 'اتصال', 'زيارة'],
    answer:
      'لتسجيل افتقاد: اضغط «افتقاد» على الكارت أو انقر مسار الافتقاد واختر الوسيلة (تليفونياً / زيارة / واتساب / رسالة / اعتذار) مع ملاحظاتك. كما يمكنك عرض سجل الافتقاد الكامل وتوليد تقارير الأشابين من تبويب «الافتقاد».'
  },
  {
    keys: ['مزامنة', 'جوجل شيت', 'شيت', 'أوفلاين', 'بدون نت', 'Apps Script', 'Relay'],
    answer:
      'المصدر الأساسي للبيانات هو ملف Google Sheets الحقيقي. يعمل التطبيق بالكامل بدون إنترنت (Offline) عبر IndexedDB، وعند عودة الاتصال أو الضغط على «مزامنة» تُرفع العمليات المعلقة بالترتيب وتُحدَّث البيانات.'
  },
  {
    keys: ['اعدادات المزامنة', 'حالة المزامنة', 'رابط', 'Apps Script', 'نشر'],
    answer:
      'روابط وإعدادات الربط التقنية مع Google Sheets محمية داخلياً ولا تُعدَّل من الواجهة العامة للمستخدمين. يمكنك متابعة حالة الاتصال والطابور المحلي وتشغيل مزامنة فورية من نافذة «حالة المزامنة».'
  },
  {
    keys: ['تصدير', 'اكسل', 'excel', 'csv', 'pdf', 'طباعة'],
    answer:
      'للتصدير والطباعة: من تبويب «الجدول» أو «الافتقاد» يمكنك تنزيل ملف Excel (CSV عربي متوافق بترميز UTF-8 BOM) أو تصدير تقرير HTML/PDF مهيأ للطباعة.'
  },
  {
    keys: ['تصفية', 'فلتر', 'بحث', 'مسح الفلاتر', 'شريط البحث'],
    answer:
      'للبحث والتصفية: استخدم شريط البحث (الاسم، الكود، المنطقة، أو الملاحظات)، واختر الفصل أو الأشبين أو الحرف الأول من لوحة الحروف السفلية، واضغط «مسح الفلاتر» لإعادة العرض الكامل.'
  },
  {
    keys: ['ثيم', 'مظهر', 'داكن', 'فاتح', 'الوان'],
    answer:
      'لتغيير المظهر: اضغط على أيقونة المظهر في أعلى الشريط العلوي أو القائمة الجانبية للتبديل بين الثيم الداكن، الهافتون المتوسط (Dim)، والفاتح الزجاجي.'
  },
  {
    keys: ['لوحة الحروف', 'حروف', 'ابجدي'],
    answer:
      'شريط الحروف الأبجدية في أسفل الشاشة يصفّي المخدومين فوراً حسب الحرف الأول من الاسم مع توحيد الألف (أ/إ/آ) والتاء المربوطة.'
  },
  {
    keys: ['حذف', 'مسح طالب', 'ازالة'],
    answer:
      'حذف سجلات المخدومين ممنوع وفق سياسة الخدمة (Zero Delete) لحماية التاريخ الرعوي. لنقل مخدوم من القائمة النشطة يمكنك تعديل حقل «الفصل» إلى «غير نشط» أو «غير حاضر».'
  },
  {
    keys: ['كنيسة', 'زيتون', 'مارجرجس', 'عنوان'],
    answer:
      'فصل الشهيد العظيم مارجرجس — كنيسة السيدة العذراء مريم بالزيتون (مرحلة ابتدائي بنين).'
  },
  {
    keys: ['واتساب', 'تقرير'],
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
  followup: [
    'سلام ونعمة يا {name} ✝️ افتقدناك جداً في فصل مارجرجس! يا رب تكون بخير وصحة، مستنيينك تنوّر الفصل الجمعة الجاية 💙',
    'أهلاً يا بطل {name}! غيابك وحشنا في الخدمة، طمنا عليك وعلى الأسرة، ونفرح بوجودك معانا الجمعة الجاية 🙏✨',
    'بنصلي لك دايماً يا {name} 🌟 فصل مارجرجس ناقصه وجودك الحلو، شرفنا الجمعة دي نعيش يوم جميل مع بعض! ⛪'
  ],
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
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
};

export function toLatinDigits(input: string): string {
  return String(input || '').replace(/[٠-٩]/g, (ch) => ARABIC_TO_LATIN_DIGITS[ch] ?? ch);
}

/**
 * Parses birth dates formatted as YYYY-MM-DD, DD/MM/YYYY, Arabic digits, or Excel serial numbers.
 */
export function parseBirthDate(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }

  const normalized = toLatinDigits(String(raw)).trim();
  if (!normalized || normalized === '-' || normalized === 'غير مسجل') return null;

  // Excel serial number (approx 1954 .. 2119)
  if (/^\d{4,5}(\.\d+)?$/.test(normalized)) {
    const serial = Number(normalized);
    if (serial >= 20000 && serial <= 80000) {
      const utcMs = Math.round((serial - 25569) * 86400 * 1000);
      const d = new Date(utcMs);
      return isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      return new Date(y, m - 1, day);
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY
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

export type AssistantIntent =
  | 'birthdays'
  | 'birthdayMessage'
  | 'message'
  | 'stats'
  | 'present'
  | 'absent'
  | 'missingFollowup'
  | 'lowAttendance'
  | 'topAttendance'
  | 'faq'
  | 'search'
  | 'help';

export function detectAssistantIntent(query: string): AssistantIntent {
  const q = normalizeArabicText(query);

  if (!q) return 'help';

  // Message generation intents (note normalizeArabicText maps ة -> ه)
  const wantsMessage =
    q.includes('رساله') ||
    q.includes('رسايل') ||
    q.includes('مسج') ||
    q.includes('ابعت') ||
    q.includes('تهنئه') ||
    q.includes('تشجيع') ||
    q.includes('صلاه');

  if ((q.includes('عيد') || q.includes('ميلاد')) && wantsMessage) {
    return 'birthdayMessage';
  }
  if (q.includes('عيد') || q.includes('ميلاد') || q.includes('احتفال') || q.includes('مواليد')) {
    return 'birthdays';
  }
  if (wantsMessage && !q.includes('كيف') && !q.includes('ازاي')) {
    return 'message';
  }

  // Attendance queries for the latest held Friday (not the next upcoming Friday).
  if ((q.includes('حضر') || q.includes('حاضرين') || q.includes('الحضور')) &&
      (q.includes('مين') || q.includes('عدد') || q.includes('كام') || q.includes('النهارده') || q.includes('اليوم'))) {
    return 'present';
  }

  // Weak attendance requests should return the low-attendance list, even when phrased as a count.
  if (q.includes('حضور') && (q.includes('مش قوي') || q.includes('ضعيف') || q.includes('اقل'))) return 'lowAttendance';

  // Stats & Analytics
  if (
    q.includes('احصائي') ||
    q.includes('نسبه') ||
    q.includes('ملخص') ||
    q.includes('تقرير عام') ||
    q.includes('اجمالي') ||
    q.includes('كم عدد') ||
    q.includes('كام مخدوم')
  ) {
    return 'stats';
  }

  // Follow-up gaps for the current service week.
  if ((q.includes('افتقاد') || q.includes('افتقد') || q.includes('كلم')) &&
      (q.includes('الاسبوع ده') || q.includes('هذا الاسبوع') || q.includes('نسي') || q.includes('ما افتقد') || q.includes('مفتقدتش') || q.includes('ما كلم'))) return 'missingFollowup';

  // Attendance tiers
  if (q.includes('غائب') || q.includes('غايب') || q.includes('لم يحضر') || q.includes('محتاجين افتقاد')) {
    return 'absent';
  }
  if (q.includes('ضعيف') || q.includes('اقل حضور') || q.includes('منقطع') || q.includes('مقصر') || q.includes('حضورهم مش قوي') || q.includes('حضورهم ضعيف') || (q.includes('حضور') && q.includes('مش قوي'))) {
    return 'lowAttendance';
  }
  if (q.includes('افضل') || q.includes('اعلي حضور') || q.includes('منتظم') || q.includes('اكثر حضور')) {
    return 'topAttendance';
  }

  // Help / How-to
  if (q.includes('مساعده') || q.includes('اوامر') || q.includes('تقدر تعمل') || q === 'اهلا' || q === 'سلام') {
    return 'help';
  }

  // FAQ keywords
  if (
    q.includes('كيف') ||
    q.includes('ازاي') ||
    q.includes('طريقه') ||
    q.includes('ممكن') ||
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
  const q = normalizeArabicText(query);
  if (!q) return null;

  let best: AssistantFaqItem | null = null;
  let bestScore = 0;

  for (const item of ASSISTANT_FAQ) {
    let score = 0;
    for (const key of item.keys) {
      const normKey = normalizeArabicText(key);
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

function findMentionedStudent(query: string, students: Student[]): Student | null {
  const q = normalizeArabicText(query);
  if (q.length < 2) return null;

  // Code exact or included
  const byCode = students.find((s) => s.code && q.includes(normalizeArabicText(s.code)));
  if (byCode) return byCode;

  // Name match
  for (const s of students) {
    const normName = normalizeArabicText(s.name);
    if (!normName) continue;
    if (normName.includes(q) || q.includes(normName)) return s;
    const parts = normName.split(/\s+/).filter((p) => p.length >= 3);
    if (parts.some((p) => q.includes(p))) return s;
  }
  return null;
}

function pickMessageTemplate(query: string): { category: keyof typeof MESSAGE_TEMPLATES; text: string } {
  const q = normalizeArabicText(query);
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


/**
 * Converts explicit natural-language commands into safe, app-level actions.
 * Attendance commands require one uniquely identified student; ambiguous names never execute.
 */
function resolveAssistantStudent(target: string, students: Student[]): { student?: Student; matches: Student[] } {
  const normalizedTarget = normalizeArabicText(target);
  const exactCode = students.filter((s) => normalizeArabicText(s.code || '') === normalizedTarget);
  const exactName = students.filter((s) => normalizeArabicText(s.name || '') === normalizedTarget);
  let matches = exactCode.length ? exactCode : exactName;
  if (matches.length === 0) {
    matches = students.filter((s) => {
      const name = normalizeArabicText(s.name || '');
      const code = normalizeArabicText(s.code || '');
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
  const q = normalizeArabicText(query);
  if (!q) return null;

  const followupMatch = query.match(/(?:كلمت|اتصلت(?:\s+ب)?|بعت(?:\s+رساله)?\s+واتساب\s+لـ?|بعت\s+واتساب\s+لـ?|زرت|عملت\s+زياره\s+منزليه\s+لـ?)\s*(.+)$/i);
  if (followupMatch) {
    const rawTail = followupMatch[1].replace(/[.!؟?]+$/g, '').replace(/^(?:مثلاً|مثلا|أنا|انا|النهارده|النهاردة)\s+/i, '').trim();
    const method: 'تم تليفونياً' | 'واتساب' | 'تم بزيارة' = /واتساب/i.test(query) ? 'واتساب' : /زرت|زياره\s+منزليه/i.test(query) ? 'تم بزيارة' : 'تم تليفونياً';
    const targets = rawTail.split(/،|,|\s+و\s+/).map((name) => name.trim()).filter(Boolean);
    const resolved: Student[] = [];
    const problems: string[] = [];
    for (const targetName of targets) {
      const result = resolveAssistantStudent(targetName, students);
      if (!result.student) {
        problems.push(result.matches.length > 1
          ? '«' + targetName + '» اسم غير محدد ويطابق: ' + result.matches.slice(0, 4).map((s) => s.name + ' (' + s.code + ')').join('، ')
          : '«' + targetName + '» غير موجود في البيانات المحملة');
      } else if (!resolved.some((s) => s.id === result.student!.id)) resolved.push(result.student);
    }
    if (problems.length || resolved.length === 0) {
      return { text: 'لم أسجل أي افتقاد لأن بعض الأسماء تحتاج توضيحًا:\n• ' + problems.join('\n• ') + '\nاكتب الاسم الكامل أو الكود لكل مخدوم، ثم أعد الأمر.' };
    }
    const weekFridayDate = getNearestFridayString();
    const already = resolved.filter((s) => Boolean(s.fu?.[weekFridayDate]));
    const fresh = resolved.filter((s) => !s.fu?.[weekFridayDate]);
    if (fresh.length === 0) {
      return { text: 'كل الأسماء المحددة لها افتقاد مسجل بالفعل لهذا الأسبوع (' + weekFridayDate + '):\n' + already.map((s) => '• ' + s.name + ': ' + s.fu?.[weekFridayDate]).join('\n') + '\nلم أضف سجلات مكررة.' };
    }
    return {
      text: 'سأُسجل ' + method + ' للأسماء التالية: ' + fresh.map((s) => s.name).join('، ') + '.\n' + (already.length ? 'تم استبعاد ' + already.length + ' اسم مسجل بالفعل هذا الأسبوع.\n' : '') + 'جارٍ الحفظ...',
      command: { type: 'recordFollowupBatch', students: fresh.map((s) => ({ id: s.id, name: s.name })), method, weekFridayDate }
    };
  }
  const attendanceMatch = q.match(/^(?:سجل|سجلي|اثبت|اثبتي)\s+(?:الحضور|حضور|الغياب|غياب|حاضر|غائب)\s*(.*)$/);
  const editMatch = q.match(/^(?:افتح|فتح)\s+(?:تعديل|كارت للتعديل|الكارت للتعديل)\s*(.*)$/) ||
    q.match(/^عدل بيانات\s+(.+)$/);

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
      text: `الاسم «${target}» مطابق لأكثر من مخدوم. لم أنفذ أي تغيير لتجنب تسجيله للشخص الخطأ:\n${matches.slice(0, 8).map((s, i) => `${i + 1}. ${s.name} — ${s.code} — الأشبين: ${s.servant || 'غير محدد'}`).join('\n')}\nاكتب الاسم بالكامل أو الكود.`
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

export function processAssistantQuery(
  query: string,
  students: Student[],
  options?: { referenceDate?: Date; lastSyncLabel?: string | null; servantName?: string | null }
): AssistantResponse {
  const trimmed = String(query || '').trim();
  const intent = detectAssistantIntent(trimmed);
  const referenceDate = options?.referenceDate || new Date();
  const currentFriday = getLatestHeldFridayString();

  const command = parseAssistantCommand(trimmed, students, currentFriday);
  if (command) return command;

  const dataIntents: AssistantIntent[] = [
    'birthdays',
    'birthdayMessage',
    'message',
    'stats',
    'present',
    'absent',
    'missingFollowup',
    'lowAttendance',
    'topAttendance',
    'search'
  ];

  // If no loaded real student data yet, be 100% honest (even if FAQ also might apply, for data intents block and ask for sync)
  if (students.length === 0 && dataIntents.includes(intent)) {
    const faqFallback = intent === 'search' ? matchFaq(trimmed) : null;
    if (faqFallback) {
      return { text: faqFallback.answer };
    }
    return {
      text: 'لا توجد بيانات مخدومين محملة حالياً في التطبيق. اضغط «مزامنة الآن» للاتصال بملف Google Sheets وجلب البيانات الحقيقية أولاً.',
      actions: [{ label: '🔄 مزامنة الآن', type: 'sync', payload: '' }]
    };
  }

  switch (intent) {
    case 'birthdays': {
      const q = normalizeArabicText(trimmed);
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
        } else if (q.includes('خلال شهر') || q.includes('الشهر الجاي') || q.includes('بعد شهر')) {
          endOffsetDays = 30;
          periodLabel = 'خلال 30 يوم';
        } else if (q.includes('هذا الشهر') || q.includes('الشهر الحالي')) {
          const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
          endOffsetDays = Math.floor((monthEnd.getTime() - today.getTime()) / 86400000);
          periodLabel = 'باقي الشهر الحالي';
        }
      }
      const matches = getBirthdayStudents(students, endOffsetDays, referenceDate, startOffsetDays);
      if (matches.length === 0) {
        return {
          text: `لا توجد أعياد ميلاد مسجلة خلال ${periodLabel} من إجمالي ${students.length} مخدوم محمّل.`,
          actions: [
            { label: '🎉 رسالة تهنئة عامة', type: 'prompt', payload: 'اكتب رسالة عيد ميلاد' },
            { label: '📊 عرض الإحصائيات', type: 'prompt', payload: 'إحصائيات' }
          ]
        };
      }

      const lines = matches.map((m, idx) => {
        const when = m.daysUntil === 0 ? 'اليوم 🎂' : m.daysUntil === 1 ? 'غداً' : `خلال ${m.daysUntil} أيام`;
        return `${idx + 1}. ${m.student.name} (${m.day}/${m.month}) — ${when} • الأشبين: ${m.student.servant || 'غير محدد'}`;
      });

      const first = matches[0].student;
      const sampleMsg = MESSAGE_TEMPLATES.birthday[0].replace('{name}', first.name.split(' ')[0] || first.name);

      return {
        text: `🎂 أعياد الميلاد — ${periodLabel} (${matches.length}):\n\n${lines.join('\n')}`,
        copyText: sampleMsg,
        whatsappText: sampleMsg,
        whatsappPhone: getPreferredPhone(first),
        actions: [
          { label: `🎂 تهنئة ${first.name.split(' ')[0]}`, type: 'prompt', payload: `رسالة عيد ميلاد لـ ${first.name}` }
        ]
      };
    }

    case 'birthdayMessage':
    case 'message': {
      const { text: rawTemplate } = pickMessageTemplate(trimmed);
      const targetStudent = findMentionedStudent(trimmed, students);
      const displayName = targetStudent ? targetStudent.name.split(' ')[0] : 'بطل مارجرجس';
      const filledMessage = rawTemplate.replace(/\{name\}/g, displayName);
      const phone = targetStudent ? getPreferredPhone(targetStudent) : undefined;

      const header = targetStudent
        ? `✉️ رسالة جاهزة إلى ${targetStudent.name} (${targetStudent.code}):`
        : '✉️ رسالة جاهزة (يمكنك نسخها أو تعديل الاسم قبل الإرسال):';

      return {
        text: `${header}\n\n"${filledMessage}"`,
        copyText: filledMessage,
        whatsappText: filledMessage,
        whatsappPhone: phone,
        actions: [
          { label: '🎂 رسالة عيد ميلاد', type: 'prompt', payload: 'رسالة عيد ميلاد' },
          { label: '💙 رسالة افتقاد', type: 'prompt', payload: 'رسالة افتقاد' },
          { label: '🌟 رسالة تشجيع', type: 'prompt', payload: 'رسالة تشجيع' }
        ]
      };
    }

    case 'stats': {
      const total = students.length;
      const present = students.filter((s) => s.att?.[currentFriday] === true).length;
      const absent = students.filter((s) => s.att?.[currentFriday] === false).length;
      const unrecorded = Math.max(0, total - present - absent);
      const attPct = total > 0 ? Math.round((present / total) * 100) : 0;
      const regular = students.filter((s) => Number(s.attendanceMonth) >= 3).length;
      const zeroMonth = students.filter((s) => Number(s.attendanceMonth) === 0).length;
      const followedUp = students.filter(
        (s) => s.followupStatus && s.followupStatus !== 'بدون' && !s.followupStatus.includes('لم')
      ).length;
      const fuPct = total > 0 ? Math.round((followedUp / total) * 100) : 0;
      const servants = new Set(students.map((s) => s.servant?.trim()).filter(Boolean)).size;

      const summary = [
        `📊 إحصائيات الخدمة الحقيقية (جمعة ${currentFriday}):`,
        `• إجمالي المخدومين المحملين: ${total} (موزعين على ${servants} خادم/أشبين)`,
        `• حضور آخر جمعة انعقدت (${currentFriday}): ${present} (${attPct}%) | غياب مسجل: ${absent} | لم يُسجل: ${unrecorded}`,
        `• المنتظمون هذا الشهر (3+): ${regular} | لم يحضروا هذا الشهر: ${zeroMonth}`,
        `• نسبة الافتقاد المسجل: ${followedUp} (${fuPct}%)`,
        options?.lastSyncLabel ? `• آخر مزامنة ناجحة: ${options.lastSyncLabel}` : '• المزامنة: لم تتم مزامنة موثقة بعد'
      ].join('\n');

      return {
        text: summary,
        copyText: summary,
        actions: [
          { label: '⚠️ عرض الغائبين', type: 'prompt', payload: 'الغائبون' },
          { label: '🏆 الأكثر التزاماً', type: 'prompt', payload: 'أفضل حضور' },
          { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' }
        ]
      };
    }

    case 'present': {
      const presentList = students.filter((s) => s.att?.[currentFriday] === true);
      const unrecorded = students.filter((s) => typeof s.att?.[currentFriday] !== 'boolean').length;
      return {
        text: `✅ الحضور المسجل لآخر جمعة انعقدت (${currentFriday}): ${presentList.length} مخدوم من إجمالي ${students.length}.\n\n${presentList.length ? presentList.map((s, i) => `${i + 1}. ${s.name} (${s.code}) — الأشبين: ${s.servant || 'غير محدد'}`).join('\n') : 'لا يوجد حضور مسجل.'}\n\nعدد السجلات التي لم يُسجل لها حضور أو غياب: ${unrecorded}.`,
        copyText: presentList.map((s) => `${s.name} (${s.code})`).join('\n'),
        actions: [{ label: '⚠️ عرض الغائبين', type: 'prompt', payload: 'الغائبون' }]
      };
    }

    case 'absent': {
      const absentList = students.filter((s) => s.att?.[currentFriday] === false);
      const unrecorded = students.filter((s) => typeof s.att?.[currentFriday] !== 'boolean').length;
      if (absentList.length === 0) {
        return {
          text: `🎉 لا يوجد أي مخدوم مسجل كغائب لآخر جمعة انعقدت (${currentFriday}). يوجد ${unrecorded} سجل لم يُسجل له حضور أو غياب.`
        };
      }
      const preview = absentList.slice(0, 12).map((s, idx) => {
        const phone = s.phoneStudent || s.phoneParent1 || 'بدون هاتف';
        const fu = s.followupStatus && s.followupStatus !== 'بدون' ? s.followupStatus : 'بحاجة لافتقاد';
        return `${idx + 1}. ${s.name} (${s.code}) — الأشبين: ${s.servant || '-'} • 📞 ${phone} • ${fu}`;
      });
      const extra = absentList.length > 12 ? `\n...وعدد ${absentList.length - 12} آخرين.` : '';
      return {
        text: `⚠️ الغياب المسجل عن آخر جمعة انعقدت (${currentFriday}) — الإجمالي (${absentList.length}):\n\n${preview.join('\n')}${extra}\n\nسجلات بدون تسجيل حضور/غياب: ${unrecorded}.`,
        copyText: preview.join('\n'),
        actions: [{ label: '💙 رسالة افتقاد جاهزة', type: 'prompt', payload: 'رسالة افتقاد' }]
      };
    }

    case 'missingFollowup': {
      const explicitServant = trimmed.match(/(?:للأشبين|للأشبن|بالنسبة للأشبين|بالنسبة للأشبن)\\s+(.+)$/);
      const servantName = options?.servantName?.trim() || explicitServant?.[1]?.trim();
      const allServantsRequested = normalizeArabicText(trimmed).includes('كل الاشابين');
      if (!servantName && !allServantsRequested) {
        return { text: 'علشان أطلع لك الأسماء اللي تخصك بدقة، اختار اسمك من فلتر «أشابين وخدام الفصل» في القائمة الجانبية، وبعدها اسألني تاني. أو قل «كل الأشابين» لعرض تقرير شامل.' };
      }
      const weekFridayDate = getNearestFridayString(referenceDate);
      const assigned = students.filter((s) => allServantsRequested || s.servant?.trim() === servantName);
      const missing = assigned.filter((s) => !s.fu?.[weekFridayDate]);
      const scope = allServantsRequested ? 'كل الأشابين' : 'الأشبن: ' + servantName;
      const lines = missing.slice(0, 30).map((s, i) => (i + 1) + '. ' + s.name + ' (' + s.code + ') — ' + (s.servant || 'غير مسند') + ' — آخر افتقاد: ' + (s.lastFollowup || 'غير مسجل'));
      return {
        text: missing.length
          ? '📋 مخدومون لم يظهر لهم افتقاد مسجل هذا الأسبوع (أسبوع ' + weekFridayDate + ')\nالنطاق: ' + scope + '\nالعدد: ' + missing.length + ' من ' + assigned.length + '\n\n' + lines.join('\n') + (missing.length > 30 ? '\n... و' + (missing.length - 30) + ' أسماء أخرى.' : '') + '\n\nتنبيه: القائمة مبنية على سجلات الافتقاد المحفوظة في التطبيق، وليست إثباتًا أن مكالمة لم تحدث خارج التطبيق.'
          : 'ممتاز، كل المخدومين ضمن النطاق المحدد لديهم افتقاد مسجل هذا الأسبوع (' + weekFridayDate + ').\nالنطاق: ' + scope + '.'
      };
    }
    case 'lowAttendance': {
      const lowList = [...students]
        .filter((s) => (!options?.servantName || s.servant?.trim() === options.servantName.trim()) && Number(s.attendanceMonth) <= 1)
        .sort((a, b) => Number(a.attendanceMonth) - Number(b.attendanceMonth) || Number(a.attendanceTotal) - Number(b.attendanceTotal));

      if (lowList.length === 0) {
        return {
          text: '👍 جميع المخدومين المحملين لديهم سجل حضور أعلى من مرة واحدة.'
        };
      }
      const lines = lowList.slice(0, 12).map(
        (s, idx) => `${idx + 1}. ${s.name} (${s.code}) — حضور الشهر: ${s.attendanceMonth}/4 • إجمالي الحضور: ${s.attendanceTotal} • آخر حضور: ${s.lastAttendance || 'غير مسجل'}`
      );
      return {
        text: `📉 المخدومون الأقل حضوراً (<= 1 مرة) — عددهم (${lowList.length}):\n\n${lines.join('\n')}`,
        actions: [{ label: '💙 رسالة افتقاد جاهزة', type: 'prompt', payload: 'رسالة افتقاد' }]
      };
    }

    case 'topAttendance': {
      const topList = [...students]
        .filter((s) => Number(s.attendanceTotal) >= 1)
        .sort((a, b) => Number(b.attendanceTotal) - Number(a.attendanceTotal) || Number(b.attendanceMonth) - Number(a.attendanceMonth))
        .slice(0, 10);

      if (topList.length === 0) {
        return {
          text: 'لا توجد أرقام حضور إجمالية مسجلة حتى الآن في البيانات المحملة.'
        };
      }
      const lines = topList.map(
        (s, idx) => `${idx + 1}. ${s.name} — إجمالي: ${s.attendanceTotal} | الشهر: ${s.attendanceMonth}/4`
      );
      return {
        text: `🏆 أكثر المخدومين انتظاماً وحضوراً:\n\n${lines.join('\n')}`,
        actions: [{ label: '🌟 رسالة تشجيع', type: 'prompt', payload: 'رسالة تشجيع' }]
      };
    }

    case 'faq': {
      const matched = matchFaq(trimmed);
      if (matched) {
        return {
          text: matched.answer,
          actions: [{ label: '📊 إحصائيات الخدمة', type: 'prompt', payload: 'إحصائيات' }]
        };
      }
      return {
        text: 'يمكنني مساعدتك في: أعياد الميلاد، إحصائيات الحضور والافتقاد، قوائم الغائبين، البحث عن مخدوم أو أشبين، كتابة رسائل تهنئة/افتقاد جاهزة، وشرح خصائص التطبيق. جرّب أحد الأزرار السريعة بالأسفل.',
        actions: [
          { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' },
          { label: '📊 إحصائيات', type: 'prompt', payload: 'إحصائيات' },
          { label: '⚠️ الغائبون', type: 'prompt', payload: 'الغائبون' }
        ]
      };
    }

    case 'search': {
      const q = normalizeArabicText(trimmed);
      const matchedStudents = students.filter((s) => {
        const hay = normalizeArabicText(
          `${s.name} ${s.code} ${s.servant} ${s.area} ${s.address} ${s.notes} ${s.sourceSheet}`
        );
        return hay.includes(q);
      });

      if (matchedStudents.length > 0) {
        const top = matchedStudents.slice(0, 8);
        const lines = top.map((s, idx) => {
          const phone = s.phoneStudent || s.phoneParent1 || 'غير مسجل';
          return `${idx + 1}. ${s.name} (${s.code})\n   الأشبين: ${s.servant || '-'} | الفصل: ${s.sourceSheet} | حضور: ${s.attendanceTotal} (${s.attendanceMonth}/4)\n   📞 ${phone} | الافتقاد: ${s.followupStatus || 'بدون'}`;
        });
        const first = top[0];
        return {
          text: `🔎 نتائج البحث عن «${trimmed}» (${matchedStudents.length}):\n\n${lines.join('\n\n')}`,
          whatsappPhone: getPreferredPhone(first),
          whatsappText: MESSAGE_TEMPLATES.followup[0].replace('{name}', first.name.split(' ')[0]),
          actions: [
            { label: `✉️ رسالة لـ ${first.name.split(' ')[0]}`, type: 'prompt', payload: `رسالة افتقاد لـ ${first.name}` }
          ]
        };
      }

      const faqMatch = matchFaq(trimmed);
      if (faqMatch) {
        return { text: faqMatch.answer };
      }

      return {
        text: `لم أجد نتائج تطابق «${trimmed}» داخل ${students.length} مخدوم محمل أو دليل الاستخدام. جرب البحث بالاسم أو الكود أو اسم الأشبين، أو اختر أمراً سريعاً:`,
        actions: [
          { label: '📊 إحصائيات', type: 'prompt', payload: 'إحصائيات' },
          { label: '⚠️ الغائبون', type: 'prompt', payload: 'الغائبون' },
          { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' }
        ]
      };
    }

    case 'help':
    default: {
      return {
        text: [
          'أهلاً بك في المساعد الذكي (يعمل محلياً بالكامل بدون إنترنت أو إرسال بيانات لخوادم ذكاء اصطناعي خارجية):',
          '• «أعياد الميلاد» أو «أعياد الميلاد الشهر القادم» أو «أعياد الميلاد خلال 30 يوم» — بحث بتاريخ مرن',
          '• «مين حضر النهارده؟» / «مين غاب؟» / «اللي حضورهم مش قوي» — قوائم الحضور والغياب والمحتاجين افتقاد',
          '• «النهارده كلمت مارتن، مايكل» / «بعت واتساب لـ...» / «زرت ...» — تسجيل افتقاد جماعي على الكروت',
          '• «مين نسيته في الافتقاد الأسبوع ده؟» — المخدومون الذين لا يوجد لهم سجل افتقاد هذا الأسبوع حسب الأشبين المحدد',
          '• «الغائبون» / «اللي حضورهم مش قوي» / «أفضل حضور» — متابعة المخدومين حسب حضور الشهر الحالي',
          '• «رسالة افتقاد [الاسم]» أو «رسالة عيد ميلاد [الاسم]» — رسالة جاهزة للنسخ والإرسال عبر WhatsApp',
          '• اكتب اسم أي مخدوم أو كود أو أشبين للبحث الفوري، أو اسأل «كيف أضيف/أصدر/أزامن؟»'
        ].join('\n'),
        actions: [
          { label: '🎂 أعياد الميلاد', type: 'prompt', payload: 'أعياد الميلاد' },
          { label: '📊 إحصائيات', type: 'prompt', payload: 'إحصائيات' },
          { label: '⚠️ الغائبون', type: 'prompt', payload: 'الغائبون' },
          { label: '💙 رسالة افتقاد', type: 'prompt', payload: 'رسالة افتقاد' }
        ]
      };
    }
  }
}
