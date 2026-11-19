import type { Student } from '../types/student';

export type FollowupMessageAudience = 'parent' | 'student' | 'general';

export interface FollowupMessageTemplate {
  id: string;
  index: number;
  title: string;
  audience: FollowupMessageAudience;
  isShort: boolean;
  template: string;
}

export interface FollowupMessagePersonalizationInput {
  studentName?: string;
  parentName?: string;
  className?: string;
  meetingSchedule?: string;
}

export interface NormalizedWhatsAppPhoneResult {
  valid: boolean;
  digits: string | null;
  reason?: string;
}

export type FollowupPhoneSource = 'parent1' | 'parent2' | 'student' | 'none';

export interface ResolvedFollowupPhoneTarget {
  hasValidPhone: boolean;
  source: FollowupPhoneSource;
  sourceLabel: string;
  rawPhone: string;
  normalizedDigits: string | null;
  isFallbackToStudent: boolean;
  warningMessage?: string;
}

/**
 * Single Source of Truth — 20 Approved Egyptian-Arabic Follow-up Message Templates
 * Shared by:
 * - QuickFollowupModal (WhatsApp selector & preview)
 * - followupMessageLibrary
 * - Smart Assistant (assistantEngine & AssistantModal)
 *
 * Strict Pastoral & Product Rules:
 * - ZERO emojis, icons, or emoticons in any message
 * - Warm, respectful Egyptian Arabic tone without blame or guilt
 * - Never invents absence reasons or unrecorded data
 * - Supports safe personalization via {{studentName}}, {{parentName}}, {{className}}
 */
export const FOLLOWUP_MESSAGE_TEMPLATES: readonly FollowupMessageTemplate[] = [
  // --- Parent-Addressed Templates (1..10) ---
  {
    id: 'fu_tpl_01',
    index: 1,
    title: 'اطمئنان دافئ لولي الأمر',
    audience: 'parent',
    isShort: false,
    template:
      'سلام ونعمة {{parentGreeting}}، بنطمن على حضرتك وعلى {{studentRefParent}}، وحشنا جداً في {{className}} ومكانُه فاضي وسط إخواته. يا رب تكونوا جميعاً بخير وصحة، ومستنيين يفرحنا بوجوده الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_02',
    index: 2,
    title: 'رسالة قصيرة لولي الأمر',
    audience: 'parent',
    isShort: true,
    template:
      'سلام ونعمة {{parentGreeting}}، بنسأل على {{studentRefParent}} وبنطمن عليكم، مفتقدينه جداً في {{className}} ومستنيينه ينوّرنا الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_03',
    index: 3,
    title: 'دعوة محبة للجمعة القادمة',
    audience: 'parent',
    isShort: false,
    template:
      'سلام ونعمة {{parentGreeting}}، كل خدام {{className}} بيسلموا على حضرتك وعلى {{studentRefParent}}. افتقدنا وجوده الجميل معانا، ونفرح جداً لو شرفنا يوم الجمعة الجاية نعيش يوم حلو مع بعض في الكنيسة.'
  },
  {
    id: 'fu_tpl_04',
    index: 4,
    title: 'تأكيد المحبة والدعم للأسرة',
    audience: 'parent',
    isShort: false,
    template:
      'سلام المسيح مع حضرتك {{parentVocative}} ومع الأسرة كلها. حابين نطمن على {{studentRefParent}} لأن غيابه وحشنا في {{className}}. لو في أي حاجة نقدر نساعد فيها إحنا تحت أمر حضرتك في أي وقت، ومستنيينه ينورنا قريب.'
  },
  {
    id: 'fu_tpl_05',
    index: 5,
    title: 'سؤال بسيط ولطيف لولي الأمر',
    audience: 'parent',
    isShort: true,
    template:
      'سلام ونعمة {{parentGreeting}}، يا رب تكونوا بألف خير. حابين نطمن على {{studentRefParent}} ونقوله إن {{className}} مفتقده ومستنيه الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_06',
    index: 6,
    title: 'بركة وصلوات للأسرة والمخدوم',
    audience: 'parent',
    isShort: false,
    template:
      'سلام ونعمة {{parentGreeting}}، بنصلي دايماً لحضرتك وللبيت كله إن ربنا يبارككم ويملى بيتكم سلام وفرح. افتقدنا {{studentRefParent}} في {{className}}، ونفرح جداً بشوفته معانا في ميعاد الفصل الجاي.'
  },
  {
    id: 'fu_tpl_07',
    index: 7,
    title: 'رسالة ودودة بعد الغياب',
    audience: 'parent',
    isShort: false,
    template:
      'أهلاً بحضرتك {{parentVocative}}، سلام ونعمة. كنا حابين نسأل على {{studentRefParent}} ونطمن إن كل حاجة تمام، صحابه والخدام في {{className}} سألوا عليه كتير ومستنيين يرجع ينورنا الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_08',
    index: 8,
    title: 'تذكير لطيف بميعاد الفصل لولي الأمر',
    audience: 'parent',
    isShort: true,
    template:
      'سلام ونعمة {{parentGreeting}}، بنطمن على {{studentRefParent}} وبنفكر حضرتك بميعاد {{className}} يوم الجمعة الجاية، وجوده دايماً بيفرحنا.'
  },
  {
    id: 'fu_tpl_09',
    index: 9,
    title: 'رسالة تقدير وتشجيع لولي الأمر',
    audience: 'parent',
    isShort: false,
    template:
      'سلام ونعمة {{parentGreeting}}، ربنا يبارك تعب حضرتك مع {{studentRefParent}}. وجوده في {{className}} بيفرق معانا جداً وبيفرح الخدمة، وبنستناه الجمعة الجاية ينورنا وسط صحابه.'
  },
  {
    id: 'fu_tpl_10',
    index: 10,
    title: 'اطمئنان مختصر وسريع للأسرة',
    audience: 'parent',
    isShort: true,
    template:
      'سلام ونعمة {{parentGreeting}}، بنسأل على حضرتك وعلى {{studentRefParent}} ونتمنى تكونوا بكل خير. وحشنا جداً في {{className}}.'
  },

  // --- Student-Addressed Templates (11..18) ---
  {
    id: 'fu_tpl_11',
    index: 11,
    title: 'افتقاد دافئ للمخدوم',
    audience: 'student',
    isShort: false,
    template:
      'سلام ونعمة {{studentVocative}}، وحشتنا جداً في {{className}}! كل صحابك والخدام سألوا عليك، يا رب تكون بخير ومبسوط، ومستنيينك تنور الفصل الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_12',
    index: 12,
    title: 'رسالة قصيرة للمخدوم',
    audience: 'student',
    isShort: true,
    template:
      'أهلاً {{studentVocative}}، سلام ونعمة! وحشتنا في {{className}}، طمنا عليك ومستنيينك الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_13',
    index: 13,
    title: 'تشجيع للمخدوم للعودة للفصل',
    audience: 'student',
    isShort: false,
    template:
      'إزيك {{studentVocative}}، يا رب تكون بألف خير. {{className}} ناقصه وجودك الحلو وضحكتك وسط صحابك، مستنيينك الجمعة الجاية نعيش يوم جميل مع بعض في الكنيسة.'
  },
  {
    id: 'fu_tpl_14',
    index: 14,
    title: 'سؤال أخوي سريع للطالب',
    audience: 'student',
    isShort: true,
    template:
      'سلام ونعمة {{studentVocative}}، عامل إيه؟ مفتقدينك جداً في {{className}} ونفرح جداً لو جيت يوم الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_15',
    index: 15,
    title: 'رسالة صلاة ومحبة للطالب',
    audience: 'student',
    isShort: false,
    template:
      'سلام ونعمة {{studentVocative}}، بنصلي لك دايماً إن ربنا يكون معاك ويفرح قلبك ويوفقك في كل خطوة. افتقدناك في {{className}}، ومكانك مستنيك الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_16',
    index: 16,
    title: 'ترحيب وتشجيع بالمشاركة',
    audience: 'student',
    isShort: false,
    template:
      'أهلاً {{studentVocative}}، وحشنا وجودك ومشاركتك الجميلة في {{className}}. طمنا عليك وعلى أخبارك، ومستنيين تشرفنا الجمعة الجاية عشان نفرح بيك مع صحابك.'
  },
  {
    id: 'fu_tpl_17',
    index: 17,
    title: 'تذكير لطيف للجمعة للمخدوم',
    audience: 'student',
    isShort: true,
    template:
      'سلام ونعمة {{studentVocative}}، بنفكرك بميعاد {{className}} الجمعة الجاية، وحشتنا ومستنيينك تنورنا.'
  },
  {
    id: 'fu_tpl_18',
    index: 18,
    title: 'رسالة تقدير لمكانة الطالب في الفصل',
    audience: 'student',
    isShort: false,
    template:
      'سلام المسيح معاك {{studentVocative}}، إنت غالي عندنا جداً ووجودك في {{className}} بيسعدنا كلنا. يا رب تكون في أحسن حال، ومستنيين نشوفك الجمعة الجاية.'
  },

  // --- General / Flexible Templates (19..20) ---
  {
    id: 'fu_tpl_19',
    index: 19,
    title: 'رسالة افتقاد عامة دافئة',
    audience: 'general',
    isShort: false,
    template:
      'سلام ونعمة، بنطمن على {{studentRefGeneral}} وعلى الأسرة الكريمة كلها، يا رب تكونوا في أتم صحة وسلام. افتقدنا وجوده في {{className}} ومستنيين يفرحنا يوم الجمعة الجاية.'
  },
  {
    id: 'fu_tpl_20',
    index: 20,
    title: 'رسالة افتقاد عامة مختصرة',
    audience: 'general',
    isShort: true,
    template:
      'سلام ونعمة، بنسأل على {{studentRefGeneral}} وبنطمن عليكم، مفتقدينه جداً في {{className}} ومستنيينه الجمعة الجاية.'
  }
];

const EMOJI_DETECTION_RE =
  /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}]/u;

export function containsEmoji(text: string): boolean {
  return EMOJI_DETECTION_RE.test(String(text || ''));
}

export function stripEmojis(text: string): string {
  return String(text || '')
    .replace(
      /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}]/gu,
      ''
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function resolveFollowupClassName(rawClassName?: string): string {
  const cleaned = String(rawClassName || '').trim();
  if (!cleaned || cleaned === 'نشط' || cleaned === 'غير حاضر' || cleaned === 'غير نشط' || cleaned === '__ALL__') {
    return 'فصل الشهيد مارجرجس';
  }
  return cleaned;
}

function extractFirstName(fullName?: string): string {
  const cleaned = String(fullName || '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(' ')[0] || cleaned;
}

/**
 * Renders any template cleanly with safe fallbacks so:
 * - Zero unreplaced {{...}} placeholders ever appear
 * - Zero awkward spacing when parentName or studentName is absent
 * - Zero emojis ever appear in output
 * - Never fabricates absence reasons or missing meeting times
 */
export function renderFollowupMessageTemplate(
  templateOrId: FollowupMessageTemplate | string,
  input: FollowupMessagePersonalizationInput = {}
): string {
  const tplObj =
    typeof templateOrId === 'string'
      ? FOLLOWUP_MESSAGE_TEMPLATES.find((t) => t.id === templateOrId) || FOLLOWUP_MESSAGE_TEMPLATES[0]
      : templateOrId;

  const studentFirst = extractFirstName(input.studentName);
  const parentClean = String(input.parentName || '').replace(/\s+/g, ' ').trim();
  const className = resolveFollowupClassName(input.className);
  const meetingSchedule = String(input.meetingSchedule || '').replace(/\s+/g, ' ').trim();

  const parentGreeting = parentClean ? `يا ${parentClean}` : 'لحضرتك';
  const parentVocative = parentClean ? `يا ${parentClean}` : '';
  const studentRefParent = studentFirst ? `البطل ${studentFirst}` : 'ابنكم الغالي';
  const studentVocative = studentFirst ? `يا ${studentFirst}` : 'يا بطل';
  const studentRefGeneral = studentFirst ? studentFirst : 'ابنكم';

  let rendered = tplObj.template
    .replace(/\{\{parentGreeting\}\}/g, parentGreeting)
    .replace(/\{\{parentVocative\}\}/g, parentVocative)
    .replace(/\{\{studentRefParent\}\}/g, studentRefParent)
    .replace(/\{\{studentVocative\}\}/g, studentVocative)
    .replace(/\{\{studentRefGeneral\}\}/g, studentRefGeneral)
    .replace(/\{\{studentName\}\}/g, studentFirst || 'بطلنا')
    .replace(/\{\{parentName\}\}/g, parentClean || 'ولي الأمر الفاضل')
    .replace(/\{\{className\}\}/g, className);

  // Clean up any punctuation/spacing artifacts when optional vocative is empty
  rendered = rendered
    .replace(/\s+،/g, '،')
    .replace(/\s+\./g, '.')
    .replace(/\s+!/g, '!')
    .replace(/،\s*،/g, '،')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (meetingSchedule) {
    rendered = `${rendered} ميعاد الاجتماع: ${meetingSchedule}.`;
  }

  // Defensive strip of any accidental placeholders or emojis
  rendered = rendered.replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  return stripEmojis(rendered);
}

function toAsciiDigits(raw: string): string {
  return String(raw || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

/**
 * Strictly normalizes phone numbers for WhatsApp deep links (Egypt + International).
 * Rejects empty, malformed, placeholder, or too-short/too-long inputs.
 * Never fabricates a phone number.
 */
export function normalizePhoneForWhatsApp(rawPhone: string | undefined | null): NormalizedWhatsAppPhoneResult {
  const raw = String(rawPhone ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .trim();
  if (!raw) {
    return { valid: false, digits: null, reason: 'empty_phone' };
  }

  // Reject values containing alphabetic text (e.g. "غير مسجل", "لا يوجد")
  if (/[A-Za-z\u0600-\u065F\u066A-\u06EF\u06FA-\u06FF]/.test(raw)) {
    return { valid: false, digits: null, reason: 'non_numeric_phone' };
  }

  const ascii = toAsciiDigits(raw);
  let digits = ascii.replace(/\D/g, '');
  if (!digits) {
    return { valid: false, digits: null, reason: 'no_digits' };
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // Egyptian mobile normalization: 010/011/012/015xxxxxxxx -> 201...
  if (/^01[0125]\d{8}$/.test(digits)) {
    digits = `2${digits}`;
  } else if (/^1[0125]\d{8}$/.test(digits)) {
    digits = `20${digits}`;
  } else if (/^0[2-9]\d{7,9}$/.test(digits)) {
    // Egyptian local landline or alternate 0-prefixed Egyptian number
    digits = `2${digits}`;
  }

  if (digits.startsWith('0')) {
    return { valid: false, digits: null, reason: 'unrecognized_local_prefix' };
  }

  if (digits.length < 10 || digits.length > 15) {
    return { valid: false, digits: null, reason: 'invalid_length' };
  }

  // Reject degenerate repeating numbers like 0000000000 or 1111111111
  if (/^(\d)\1+$/.test(digits)) {
    return { valid: false, digits: null, reason: 'degenerate_digits' };
  }

  return { valid: true, digits };
}

/**
 * Resolves the target phone number for WhatsApp Follow-up strictly prioritizing Parent Phone:
 *   1. phoneParent1 (ولي الأمر 1)
 *   2. phoneParent2 (ولي الأمر 2)
 *   3. phoneStudent (fallback with clear indicator)
 * Never invents a phone number.
 */
export function resolveFollowupPhoneTarget(
  student: Pick<Student, 'phoneParent1' | 'phoneParent2' | 'phoneStudent'> | null | undefined
): ResolvedFollowupPhoneTarget {
  if (!student) {
    return {
      hasValidPhone: false,
      source: 'none',
      sourceLabel: 'غير متوفر',
      rawPhone: '',
      normalizedDigits: null,
      isFallbackToStudent: false,
      warningMessage: 'لا يوجد رقم هاتف مسجل لهذا المخدوم. يمكنك نسخ الرسالة وإرسالها يدوياً.'
    };
  }

  const candidates: Array<{
    source: Exclude<FollowupPhoneSource, 'none'>;
    label: string;
    raw: string | undefined;
    isFallback: boolean;
  }> = [
    { source: 'parent1', label: 'رقم ولي الأمر 1', raw: student.phoneParent1, isFallback: false },
    { source: 'parent2', label: 'رقم ولي الأمر 2', raw: student.phoneParent2, isFallback: false },
    {
      source: 'student',
      label: 'رقم المخدوم (بديل لعدم توفر رقم ولي الأمر)',
      raw: student.phoneStudent,
      isFallback: true
    }
  ];

  for (const c of candidates) {
    const check = normalizePhoneForWhatsApp(c.raw);
    if (check.valid && check.digits) {
      return {
        hasValidPhone: true,
        source: c.source,
        sourceLabel: c.label,
        rawPhone: String(c.raw || '').trim(),
        normalizedDigits: check.digits,
        isFallbackToStudent: c.isFallback
      };
    }
  }

  const anyRawPresent = Boolean(
    String(student.phoneParent1 || '').trim() ||
      String(student.phoneParent2 || '').trim() ||
      String(student.phoneStudent || '').trim()
  );

  return {
    hasValidPhone: false,
    source: 'none',
    sourceLabel: 'غير متوفر',
    rawPhone: '',
    normalizedDigits: null,
    isFallbackToStudent: false,
    warningMessage: anyRawPresent
      ? 'الرقم المسجل لولي الأمر أو المخدوم غير صالح لفتح واتساب. يمكنك نسخ الرسالة وإرسالها يدوياً.'
      : 'لا يوجد رقم هاتف مسجل لولي الأمر أو المخدوم. يمكنك نسخ الرسالة وإرسالها يدوياً.'
  };
}

/**
 * Builds a manual WhatsApp Deep Link (`https://wa.me/<intlDigits>?text=<encoded>`).
 * Returns null if the phone number is missing or invalid (never invents numbers, never auto-sends).
 */
export function buildWhatsAppFollowupDeepLink(
  rawPhone: string | undefined | null,
  messageText: string
): string | null {
  const normalized = normalizePhoneForWhatsApp(rawPhone);
  if (!normalized.valid || !normalized.digits) {
    return null;
  }
  const cleanMessage = stripEmojis(String(messageText || '')).trim();
  const query = cleanMessage ? `?text=${encodeURIComponent(cleanMessage)}` : '';
  return `https://wa.me/${normalized.digits}${query}`;
}
