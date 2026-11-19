import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { normalizeArabicText } from '../utils/arabicUtils';

export type FollowupContextKind = 'study_exams' | 'travel_busy' | 'health_recovery' | 'general';

export interface FollowupTemplateItem {
  id: string;
  title: string;
  template: string;
  contextKind?: FollowupContextKind;
}

export interface PersonalizedFollowupMessage {
  id: string;
  title: string;
  text: string;
  contextKind: FollowupContextKind;
  isContextAdapted: boolean;
}

export interface StudentPhoneResolution {
  phone: string | null;
  sourceLabel: string | null;
  digits: string;
}

export interface FollowupContextSummary {
  kind: FollowupContextKind;
  badgeLabel: string | null;
  hintText: string | null;
}

/**
 * 10 Core Egyptian-Arabic loving follow-up message templates (User-Provided Base Library).
 * Placeholder [الاسم] is replaced automatically with the student's real name.
 */
export const BASE_FOLLOWUP_MESSAGE_TEMPLATES: readonly FollowupTemplateItem[] = [
  {
    id: 'base_1',
    title: 'افتقاد وترحيب للجمعة',
    template:
      'سلام ونعمة يا [الاسم] ✝️ افتقدناك جداً في فصل مارجرجس! يا رب تكون بخير وصحة، مستنيينك تنوّر الفصل الجمعة الجاية 💙'
  },
  {
    id: 'base_2',
    title: 'اطمئنان هادئ',
    template:
      'سلام ونعمة يا [الاسم] ❤️ بقالنا فترة مفتقدين وجودك معانا، وحبينا نطمن عليك ونعرف أخبارك. ربنا يحفظك، ومستنيين نشوفك قريب.'
  },
  {
    id: 'base_3',
    title: 'محبة وتشجيع وسط الإخوة',
    template:
      'يا [الاسم] الغالي، سلام ونعمة ✝️ وجودك بيفرق معانا، ونفسنا نشوفك وسط إخواتك في الفصل تاني. ربنا يفرح قلبك وينوّر طريقك 💙'
  },
  {
    id: 'base_4',
    title: 'سؤال بسيط وودود',
    template:
      'سلام ونعمة يا [الاسم]، عامل إيه؟ يا رب تكون بخير. حبينا بس نطمن عليك ونقولك إننا فاكرينك ومفتقدينك. ربنا معاك دايماً 🙏'
  },
  {
    id: 'base_5',
    title: 'دعوة دافئة للفصل',
    template:
      'وحشتنا يا [الاسم] ❤️ فصل مارجرجس مستنيك، ومستنيين نشوفك الجمعة الجاية. ربنا يحفظك ويفرح قلبك ✝️'
  },
  {
    id: 'base_6',
    title: 'روح الأسرة الواحدة',
    template:
      'سلام ونعمة يا [الاسم] ✝️ إنت واحد من أسرتنا في فصل مارجرجس، ووجودك بيفرحنا. بنطمن عليك وبنقولك مستنيينك وسطنا قريب 💙'
  },
  {
    id: 'base_7',
    title: 'دعاء وبركة يومية',
    template:
      'يا [الاسم]، ربنا يكون معاك في كل أيامك ❤️ متنساش إن ليك مكان وسط إخواتك، ونفسنا نشوفك معانا تاني. مستنيينك بكل فرحة.'
  },
  {
    id: 'base_8',
    title: 'سؤال عن الأخبار',
    template:
      'سلام ونعمة يا [الاسم]، أخبارك إيه؟ وإيه أخبارك الفترة دي؟ حبينا نفتقدك ونسأل عليك، وربنا يديك سلام وفرح دايماً 🙏'
  },
  {
    id: 'base_9',
    title: 'اطمئنان على الأحوال',
    template:
      'سلام ونعمة يا [الاسم] ❤️ بقالنا شوية مش بنشوفك في الفصل، فحبينا نطمن عليك. يا رب كل أمورك تكون بخير، ومستنيين رجوعك وسطنا.'
  },
  {
    id: 'base_10',
    title: 'صلاة ومحبة دائمة',
    template:
      'ربنا يبارك حياتك يا [الاسم] ✝️ وحبينا نفكرك إننا بنفتكرك وبنصلي من أجلك. وحشتنا في فصل مارجرجس، وربنا يجمعنا دايماً على المحبة 💙'
  }
];

/**
 * Context-adapted gentle Egyptian-Arabic variations.
 * Strictly supportive, calm, free of blame or embarrassing wording, and never reveals sensitive details.
 */
const CONTEXT_ADAPTED_TEMPLATES: Record<Exclude<FollowupContextKind, 'general'>, readonly FollowupTemplateItem[]> = {
  study_exams: [
    {
      id: 'ctx_study_1',
      title: 'تشجيع للامتحانات والدروس',
      contextKind: 'study_exams',
      template:
        'سلام ونعمة يا [الاسم] ✝️ ربنا معاك ويسندك في دروسك وامتحاناتك، ويديك تركيز ونجاح وتفوق. مفتقدينك في فصل مارجرجس وبنصلي لك دايماً 💙'
    },
    {
      id: 'ctx_study_2',
      title: 'دعاء بالنجاح والتوفيق',
      contextKind: 'study_exams',
      template:
        'يا [الاسم] الغالي، ربنا يوفقك في المذاكرة والامتحانات ويفرح قلبك دايماً 🙏 متقلقش، فصل مارجرجس بيدعيلك ومستنيك تنوّرنا أول ما تخلص ❤️'
    }
  ],
  travel_busy: [
    {
      id: 'ctx_travel_1',
      title: 'اطمئنان ودعاء بالسلامة',
      contextKind: 'travel_busy',
      template:
        'سلام ونعمة يا [الاسم] ✝️ يا رب تكون بألف خير وسلامة في مشاويرك، وحبينا نطمن عليك ونقولك إن مكانك في فصل مارجرجس مستنيك دايماً 💙'
    }
  ],
  health_recovery: [
    {
      id: 'ctx_health_1',
      title: 'صلاة للشفاء والسلامة',
      contextKind: 'health_recovery',
      template:
        'سلام ونعمة يا [الاسم] ❤️ بنصلي لك ربنا يديك تمام الصحة والعافية والسلام، وحبينا نطمن عليك. مستنيينك تنوّرنا لما تكون بخير ✝️'
    }
  ]
};

function toAsciiDigits(value: string): string {
  return String(value || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

/**
 * Extracts a natural friendly Egyptian-Arabic display name from the full registered name.
 * Handles two-part Arabic names like "عبد المسيح" or "أبو سيفين".
 */
export function extractStudentMessageName(student?: Pick<Student, 'name'> | null): string {
  const clean = String(student?.name || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'بطل مارجرجس';

  const parts = clean.split(' ').filter(Boolean);
  if (parts.length === 0) return 'بطل مارجرجس';

  const firstNorm = normalizeArabicText(parts[0]);
  if ((firstNorm === 'عبد' || firstNorm === 'ابو' || firstNorm === 'ام') && parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0];
}

export function applyStudentNameToTemplate(template: string, name: string): string {
  const safeName = String(name || '').trim() || 'بطل مارجرجس';
  return String(template || '')
    .replace(/\[الاسم\]/g, safeName)
    .replace(/\{name\}/g, safeName);
}

/**
 * Resolves a valid phone number strictly from the student record (never invents numbers).
 * Returns null if no valid >=8 digit number exists.
 */
export function resolveStudentMessagePhone(student?: Partial<Student> | null): StudentPhoneResolution {
  if (!student) {
    return { phone: null, sourceLabel: null, digits: '' };
  }

  const candidates: Array<{ raw: string | undefined; label: string }> = [
    { raw: student.phoneStudent, label: 'هاتف المخدوم' },
    { raw: student.phoneParent1, label: 'هاتف ولي الأمر' },
    { raw: student.phoneParent2, label: 'هاتف ولي الأمر (2)' }
  ];

  for (const item of candidates) {
    const rawTrimmed = String(item.raw ?? '').trim();
    if (!rawTrimmed || rawTrimmed === '-' || rawTrimmed === 'غير مسجل') continue;
    const ascii = toAsciiDigits(rawTrimmed);
    const digits = ascii.replace(/\D/g, '');
    if (digits.length >= 8) {
      return {
        phone: rawTrimmed,
        sourceLabel: item.label,
        digits
      };
    }
  }

  return { phone: null, sourceLabel: null, digits: '' };
}

/**
 * Normalizes a phone number into WhatsApp international digits (`201...` for Egyptian numbers).
 * Returns null if no valid recipient digits exist (never produces `wa.me/?text=` without a number).
 */
export function formatDirectWhatsAppPhoneDigits(rawPhone: string | undefined | null): string | null {
  const ascii = toAsciiDigits(String(rawPhone ?? '').trim());
  let digits = ascii.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('0')) {
    digits = `2${digits}`;
  } else if (/^1[0-25]\d{8}$/.test(digits)) {
    digits = `20${digits}`;
  }
  return digits.length >= 8 ? digits : null;
}

/**
 * Builds a direct WhatsApp URL with recipient number and message text.
 * Strictly returns null when there is no valid phone number.
 */
export function buildDirectWhatsAppUrl(
  rawPhone: string | undefined | null,
  messageText: string
): string | null {
  const digits = formatDirectWhatsAppPhoneDigits(rawPhone);
  if (!digits) return null;
  const cleanText = String(messageText || '').trim();
  return cleanText
    ? `https://wa.me/${digits}?text=${encodeURIComponent(cleanText)}`
    : `https://wa.me/${digits}`;
}

/**
 * Builds a direct SMS URI (`sms:<phone>?body=<encodedText>`) with recipient number and message text.
 * Strictly returns null when there is no valid phone number.
 */
export function buildDirectSmsUrl(
  rawPhone: string | undefined | null,
  messageText: string
): string | null {
  const ascii = toAsciiDigits(String(rawPhone ?? '').trim());
  const cleaned = ascii.replace(/(?!^\+)[^\d]/g, '');
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 8) return null;
  const cleanText = String(messageText || '').trim();
  return cleanText
    ? `sms:${cleaned}?body=${encodeURIComponent(cleanText)}`
    : `sms:${cleaned}`;
}

/**
 * Detects a safe, non-embarrassing follow-up tone context from the student's existing notes/records.
 * Never invents reasons and avoids exposing embarrassing details.
 */
export function resolveStudentFollowupContext(
  student?: Partial<Student> | null,
  followupRecords: ReadonlyArray<FollowupRecord> = []
): FollowupContextSummary {
  if (!student) {
    return { kind: 'general', badgeLabel: null, hintText: null };
  }

  const normStudentName = normalizeArabicText(student.name || '');
  const matchingNotes = followupRecords
    .filter((r) => {
      if (student.id && r.studentId && r.studentId === student.id) return true;
      if (student.code && r.studentCode && normalizeArabicText(r.studentCode) === normalizeArabicText(student.code)) {
        return true;
      }
      return Boolean(normStudentName && normalizeArabicText(r.studentName) === normStudentName);
    })
    .map((r) => String(r.notes || '').trim())
    .filter(Boolean);

  const combinedRaw = [String(student.notes || '').trim(), ...matchingNotes]
    .filter(Boolean)
    .join(' ');
  const combinedNorm = normalizeArabicText(combinedRaw);

  if (!combinedNorm) {
    return { kind: 'general', badgeLabel: null, hintText: null };
  }

  const studyKeywords = [
    'امتحان',
    'امتحانات',
    'اختبار',
    'درس',
    'دروس',
    'مذاكر',
    'مذاكرة',
    'مدرسه',
    'كورس',
    'شهاده',
    'تقييم',
    'دراسه'
  ];
  if (studyKeywords.some((k) => combinedNorm.includes(normalizeArabicText(k)))) {
    return {
      kind: 'study_exams',
      badgeLabel: 'تشجيع هادئ لفترة الدراسة والامتحانات',
      hintText: 'تراعي الصياغة المقترحة تشجيع المخدوم والدعاء له بالتوفيق بدون أي عتاب.'
    };
  }

  const healthKeywords = ['مريض', 'مرض', 'تعبان', 'تعب', 'عمليه', 'مستشفي', 'دور برد', 'سخون', 'كشف', 'صحيه'];
  if (healthKeywords.some((k) => combinedNorm.includes(normalizeArabicText(k)))) {
    return {
      kind: 'health_recovery',
      badgeLabel: 'اطمئنان وصلاة للسلامة',
      hintText: 'تركّز الصياغة على الدعاء بالصحة والسلامة بلطف وهدوء.'
    };
  }

  const travelKeywords = ['سفر', 'مسافر', 'بلد', 'مصيف', 'رحله', 'زياره عائليه', 'مشغول', 'ظروف'];
  if (travelKeywords.some((k) => combinedNorm.includes(normalizeArabicText(k)))) {
    return {
      kind: 'travel_busy',
      badgeLabel: 'اطمئنان لطيف وترحيب',
      hintText: 'صياغة هادئة للاطمئنان بدون التطرق لأي تفاصيل.'
    };
  }

  return { kind: 'general', badgeLabel: null, hintText: null };
}

/**
 * Builds the complete list of personalized templates for a student (10 base templates + context-adapted ones if relevant).
 */
export function buildPersonalizedFollowupMessages(
  student?: Partial<Student> | null,
  followupRecords: ReadonlyArray<FollowupRecord> = []
): {
  firstName: string;
  context: FollowupContextSummary;
  phoneInfo: StudentPhoneResolution;
  allMessages: PersonalizedFollowupMessage[];
} {
  const firstName = extractStudentMessageName(student ? { name: String(student.name || '') } : null);
  const context = resolveStudentFollowupContext(student, followupRecords);
  const phoneInfo = resolveStudentMessagePhone(student);

  const contextTemplates =
    context.kind !== 'general' ? CONTEXT_ADAPTED_TEMPLATES[context.kind] : [];

  const adaptedList: PersonalizedFollowupMessage[] = contextTemplates.map((tpl) => ({
    id: tpl.id,
    title: tpl.title,
    text: applyStudentNameToTemplate(tpl.template, firstName),
    contextKind: context.kind,
    isContextAdapted: true
  }));

  const baseList: PersonalizedFollowupMessage[] = BASE_FOLLOWUP_MESSAGE_TEMPLATES.map((tpl) => ({
    id: tpl.id,
    title: tpl.title,
    text: applyStudentNameToTemplate(tpl.template, firstName),
    contextKind: 'general',
    isContextAdapted: false
  }));

  return {
    firstName,
    context,
    phoneInfo,
    allMessages: [...adaptedList, ...baseList]
  };
}

function stableStudentSeed(seedText: string): number {
  let hash = 0;
  for (let i = 0; i < seedText.length; i++) {
    hash = (hash * 31 + seedText.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Picks at least `count` (default 4) diverse messages for a student, rotating away from
 * previously shown template IDs so repeated requests for the same student never keep repeating
 * the exact same default wording.
 */
export function pickVariedFollowupSuggestions(
  allMessages: ReadonlyArray<PersonalizedFollowupMessage>,
  options?: {
    studentSeed?: string;
    excludeIds?: ReadonlyArray<string>;
    count?: number;
  }
): PersonalizedFollowupMessage[] {
  const count = Math.max(1, Math.min(allMessages.length, options?.count ?? 4));
  const excludeSet = new Set(options?.excludeIds || []);
  const seed = stableStudentSeed(options?.studentSeed || 'default');

  const rotated: PersonalizedFollowupMessage[] = [];
  if (allMessages.length > 0) {
    const startOffset = seed % allMessages.length;
    for (let i = 0; i < allMessages.length; i++) {
      rotated.push(allMessages[(startOffset + i) % allMessages.length]);
    }
  }

  // Prioritize context-adapted first only if not recently excluded, then fresh unseen base items
  const fresh = rotated.filter((m) => !excludeSet.has(m.id));
  const contextFresh = fresh.filter((m) => m.isContextAdapted);
  const baseFresh = fresh.filter((m) => !m.isContextAdapted);

  const orderedFresh = [...contextFresh, ...baseFresh];
  const fallbackPool = rotated.filter((m) => excludeSet.has(m.id));

  return [...orderedFresh, ...fallbackPool].slice(0, count);
}
