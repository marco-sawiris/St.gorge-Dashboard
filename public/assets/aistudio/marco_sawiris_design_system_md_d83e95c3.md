# Marco Sawiris Design System — الدليل الموحد الشامل (v2.0)

> **تعليمات لأي أداة ذكاء اصطناعي (Google AI Studio / Codex / Cursor / Claude Code):**
> اقرأ هذا الملف كاملاً قبل بناء أي واجهة. يجمع هذا الدليل المرجعي كافة الأنظمة والـ Tokens والمكونات والحركة والبرومتات في ملف واحد موحّد.
> الواجهة **عربية RTL** بالكامل وبأسلوب **Liquid Glass** (الزجاج السائل) الفاخر. يُمنع استخدام نصوص دينية أو كتابية؛ استخدم نصوصاً عامة للعرض والتجربة فقط.

---

## 1. المبادئ الأساسية (Principles)
1. **Liquid Glass (الزجاج السائل):** أسطح زجاجية مموّهة (`backdrop-filter: blur`) لامعة، شفافية متعددة الطبقات، حواف بحدّ علوي مضيء (`inset 0 1px 0`) يعكس الإضاءة المحيطة.
2. **عمق الداكن (Ultra-Dark Foundations):** خلفية الدارك أغمق ما يمكن (`#030711` في الهوية الزرقاء، أو `#050403` في الهوية الذهبية الدافئة) مع كرات ضوء محيطية (Ambient Orbs) ناعمة بالخلفية.
3. **حركة الدخول الموحدة (`wordIn`):** كل عنصر في الواجهة يدخل بحركة `wordIn` ثلاثية الأبعاد مع تسلسل زمني (Stagger) عبر `--i` للعناصر و`--w` للكلمات.
4. **مرونة الهوية اللونية (Dual Identity Tokens):**
   - **الهوية الأساسية المعتمدة (Blue & Cyan — 7 ألوان):** مستوحاة من السماء الليلية العميقة (Midnight Black, Deep Navy, Royal Blue, Electric Blue, Cyan, Indigo, Violet).
   - **الهوية البديلة الدافئة (Gold & Teal):** للواجهات الكلاسيكية الدافئة (Gold `#D99B26`, Soft Gold `#F0C76A`, Brown `#825325`, Deep Teal `#1F8A7A`, Night Blue `#14305E`).
5. **RTL أولاً وإتاحة الوصول:** اتجاه `dir="rtl"` افتراضياً، استخدام الخصائص المنطقية (`margin-inline`, `inset-inline-start`)، تباين عالٍ للنص ($\ge 4.5:1$)، ودعم `prefers-reduced-motion`.

---

## 2. الخطوط والطباعة (Typography)
- **الخط الأساسي:** `Cairo` (الأوزان: 400، 600، 800).
- **الخط الثانوي / البديل (Fallback):** `Almarai` (الأوزان: 300، 400، 700، 800) ثم `'Segoe UI', Tahoma, sans-serif`.
- **خط الأكواد:** `'Fira Code', monospace` مع `direction: ltr`.
- **الأيقونات:** `Material Symbols Outlined` (داخل حاوية `.icon-box` أو `.ej-card__icon`).

```html
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;800&family=Almarai:wght@300;400;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,300..700,0..1,0" rel="stylesheet">
```

### مقياس الطباعة (Type Scale)
| Token | الحجم | الوزن | ارتفاع السطر | الاستخدام |
|---|---|---|---|---|
| `display` | `3rem` | `800` | `1.0` | عنوان الهيرو الرئيسي |
| `h1` | `2rem` | `800` | `1.1` | عنوان الصفحة |
| `h2` | `1.5rem` | `700` | `1.2` | عنوان قسم رئيسي |
| `h3` | `1.25rem` | `700` | `1.3` | عنوان فرعي داخل القسم |
| `title` | `1.0625rem` | `700` | `1.3` | عنوان بطاقة |
| `body-lg` | `1.0625rem` | `300` | `1.75` | نص تمهيدي كبير |
| `body` | `1rem` | `400` | `1.75` | الفقرات والنصوص الأساسية |
| `label` | `0.875rem` | `700` | `1.4` | تسمية حقل أو زر |
| `caption` | `0.75rem` | `400` | `1.4` | ملاحظة صغيرة وتعليق ثانوي |
| `overline` | `0.6875rem` | `700` | `1.4` | شارة فوق العنوان (`letter-spacing: .12em`) |

---

## 3. متغيرات التصميم (Design Tokens)

### 3.1 الهوية الأساسية: الأزرق الملكي والسيان (7 ألوان معتمدة + 3 سمات)
| الاسم | HEX | الدور |
|---|---|---|
| Midnight Black | `#030711` | خلفية الدارك الأغمق |
| Deep Navy | `#071B3B` | الأسطح والبطاقات المرتفعة |
| Royal Blue | `#123FCE` | عمق التدرجات |
| Electric Blue | `#267AFF` | اللون الأساسي (`--primary`) |
| Cyan | `#20C7E8` | التوهج والتركيز وحالات النجاح (`--accent`) |
| Indigo | `#3020A0` | عمق ثانوي وحالات الخطر (`--indigo`) |
| Violet | `#6548F5` | تباين وتنبيهات (`--violet`) |

```css
:root, [data-theme="dark"] {
  /* الألوان السبعة الأساسية */
  --midnight: #030711;
  --navy: #071B3B;
  --navy-mid: #0B2452;
  --royal: #123FCE;
  --primary: #267AFF;
  --primary-hover: #3D8DFF;
  --accent: #20C7E8;
  --indigo: #3020A0;
  --violet: #6548F5;

  /* الخلفيات والأسطح الزجاجية (Dark — الأغمق) */
  --bg: #030711;
  --bg-el: #071B3B;
  --bg-high: #0B2452;
  --glass-bg: rgba(7, 27, 59, 0.62);
  --glass-bg-2: rgba(11, 36, 82, 0.78);
  --glass-bg-3: rgba(38, 122, 255, 0.20);
  --glass-border: rgba(38, 122, 255, 0.24);
  --glass-border-2: rgba(32, 199, 232, 0.42);
  --glass-inset-top: inset 0 1px 0 rgba(32, 199, 232, 0.30);
  --glass-inset-bot: inset 0 -1px 0 rgba(3, 7, 17, 0.35);
  --glass-blur: 24px;

  /* النصوص */
  --text: #FFFFFF;
  --text-secondary: rgba(255, 255, 255, 0.75);
  --text-muted: rgba(255, 255, 255, 0.48);
  --on-primary: #030711;

  /* الحالات */
  --info: #267AFF;
  --success: #20C7E8;
  --warning: #6548F5;
  --danger: #3020A0;

  /* التدرجات */
  --grad-primary: linear-gradient(135deg, #267AFF 0%, #123FCE 100%);
  --grad-accent: linear-gradient(135deg, #20C7E8 0%, #267AFF 60%, #3020A0 100%);
  --grad-indigo: linear-gradient(135deg, #3020A0 0%, #6548F5 100%);
  --grad-deep: linear-gradient(180deg, #071B3B 0%, #030711 100%);

  /* الظلال وحلقة التركيز */
  --shadow-1: 0 4px 20px rgba(3, 7, 17, 0.85);
  --shadow-2: 0 14px 44px rgba(3, 7, 17, 0.95);
  --shadow-primary: 0 0 0 1px rgba(38, 122, 255, 0.40), 0 10px 30px -6px rgba(38, 122, 255, 0.55);
  --shadow-accent: 0 0 0 1px rgba(32, 199, 232, 0.25), 0 8px 24px -8px rgba(32, 199, 232, 0.35);
  --focus-ring: 0 0 0 3px rgba(38, 122, 255, 0.35);

  /* المسافات وأنصاف الأقطار والمنحنيات */
  --s1: .25rem; --s2: .5rem; --s3: .75rem; --s4: 1rem; --s5: 1.25rem;
  --s6: 1.5rem; --s8: 2rem; --s10: 2.5rem; --s12: 3rem; --s16: 4rem; --s20: 5rem;
  --r-sm: .5rem; --r-md: .875rem; --r-lg: 1.25rem; --r-xl: 1.75rem; --r-pill: 999px;
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out: cubic-bezier(0.25, 1, 0.5, 1);
}

/* السمة الخافتة (Dim) */
[data-theme="dim"] {
  --bg: #071B3B;
  --bg-el: #0B2452;
  --glass-bg: rgba(18, 63, 206, 0.22);
  --glass-bg-2: rgba(18, 63, 206, 0.36);
  --glass-border: rgba(32, 199, 232, 0.28);
}

/* السمة الفاتحة (Light) */
[data-theme="light"] {
  --primary: #123FCE;
  --accent: #267AFF;
  --royal: #123FCE;
  --violet: #3020A0;
  --bg: #EEF2FA;
  --bg-el: #FFFFFF;
  --glass-bg: rgba(255, 255, 255, 0.75);
  --glass-bg-2: rgba(255, 255, 255, 0.92);
  --glass-bg-3: rgba(18, 63, 206, 0.12);
  --glass-border: rgba(18, 63, 206, 0.18);
  --glass-border-2: rgba(18, 63, 206, 0.36);
  --glass-inset-top: inset 0 1px 0 rgba(255, 255, 255, 0.95);
  --text: #030711;
  --text-secondary: rgba(3, 7, 17, 0.72);
  --text-muted: rgba(3, 7, 17, 0.50);
  --on-primary: #FFFFFF;
  --shadow-1: 0 4px 18px rgba(18, 63, 206, 0.12);
  --shadow-2: 0 12px 34px rgba(18, 63, 206, 0.20);
  --shadow-primary: 0 0 0 1px rgba(18, 63, 206, 0.25), 0 10px 30px -6px rgba(18, 63, 206, 0.40);
}
```

### 3.2 الهوية البديلة الدافئة (Gold & Teal — اختياري عبر `[data-palette="gold"]`)
```css
[data-palette="gold"] {
  --primary: #D99B26;
  --accent: #1F8A7A;
  --royal: #825325;
  --violet: #14305E;
  --indigo: #825325;
  --bg: #050403;
  --bg-el: #0B0805;
  --glass-bg: rgba(20, 14, 8, 0.65);
  --glass-bg-2: rgba(28, 19, 10, 0.82);
  --glass-bg-3: rgba(217, 155, 38, 0.16);
  --glass-border: rgba(217, 155, 38, 0.24);
  --glass-border-2: rgba(240, 199, 106, 0.42);
  --glass-inset-top: inset 0 1px 0 rgba(240, 199, 106, 0.28);
  --text: #F4EBDD;
  --text-secondary: #B8A68C;
  --text-muted: #7A6A55;
  --on-primary: #1A1006;
  --grad-primary: linear-gradient(135deg, #F0C76A 0%, #D99B26 55%, #825325 100%);
  --grad-accent: linear-gradient(135deg, #F0C76A 0%, #1F8A7A 100%);
  --shadow-primary: 0 0 0 1px rgba(217, 155, 38, 0.35), 0 10px 30px -6px rgba(217, 155, 38, 0.45);
}
```

---

## 4. الحركة (Motion) — `wordIn`

```css
@keyframes wordIn {
  from { opacity: 0; transform: translateY(45px) rotateX(-65deg) scale(.8); filter: blur(8px); }
  to   { opacity: 1; transform: none; filter: blur(0); }
}

.word-in-scope { perspective: 800px; }

.word-in {
  animation: wordIn 900ms var(--ease-spring) both;
  animation-delay: calc(var(--i, 0) * 100ms);
}

.word-in-text span {
  display: inline-block;
  animation: wordIn 800ms var(--ease-spring) both;
  animation-delay: calc(var(--w, 0) * 90ms);
}

@media (prefers-reduced-motion: reduce) {
  .word-in, .word-in-text span { animation: none !important; }
}
```

---

## 5. الأسطح الزجاجية (Glass Surfaces)

```css
.glass {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(170%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(170%);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-1), var(--glass-inset-top);
  border-radius: var(--r-lg);
}

.glass-strong {
  background: var(--glass-bg-2);
  border-color: var(--glass-border-2);
  backdrop-filter: blur(32px) saturate(190%);
  -webkit-backdrop-filter: blur(32px) saturate(190%);
  box-shadow: var(--shadow-2), var(--glass-inset-top);
}

.card {
  padding: 20px;
  transition: transform .25s var(--ease-standard), border-color .25s var(--ease-standard), box-shadow .25s var(--ease-standard);
}
.card:hover {
  transform: translateY(-3px);
  border-color: var(--glass-border-2);
  box-shadow: var(--shadow-2), var(--shadow-accent), var(--glass-inset-top);
}
```

---

## 6. مكتبة المكونات الكاملة (Components)

1. **مبدل السمات ثلاثي الأوضاع (Theme Switcher):** كبسولة زجاجية تحوي 3 أزرار دائرية (`light` / `dark` / `dim`) تحفظ الاختيار في `localStorage` وتُطبق فوراً عبر `data-theme`.
2. **مفتاح التشغيل السائل (Liquid Toggle ON/OFF):** زر كبسولة بمؤشر دائري متدرج يتحرك بحركة `spring` في اتجاه RTL (`translateX(-80px)`).
3. **الأزرار (Buttons):**
   - `.btn--primary`: تدرج `--grad-primary` مع حافة علوية مضيئة وتوهج.
   - `.btn--glass`: سطح زجاجي شفاف بحدود مضيئة.
   - `.btn--lens` (Liquid Glass Lens): زر كبسولة انكساري بـ `contrast(1.8)` وظلال داخلية متعددة مع شارة دائرية للأيقونة.
   - `.btn--ghost` و `.btn--danger`: أزرار ثانوية وللإجراءات الحساسة.
4. **اختيار البار المقسّم (Clay Segmented Control):** شريط اختيار بنمط Claymorphism غائر، يرتفع الخيار النشط بتدرج لوني وظل داخلي وخارجي.
5. **تاب بار سفلي بنوتش متحرك (Notched Bottom Tab Bar):** شريط سفلي زجاجي بـ 4 تبويبات، يرتفع التبويب النشط كفقاعة دائرية ويُقطع الشريط أسفله بنوتش دائري عبر `mask: radial-gradient(...)`.
6. **الاسكرول بار السائل (Liquid Scrollbar):** شريط تمرير مخصص بعرض `10px` وتدرج لوني متوهج.
7. **التحميل بالبلور (Blur Loading & Skeleton):** طبقة `backdrop-filter: blur(8px)` فوق المحتوى قيد التحميل مع تأثير `shimmer` وشرائط `skeleton` نابضة.
8. **حاوية الأيقونات (Icon Box):** مربع مدور `62px` بحدود مضيئة وتدرج زجاجي ناعم.
9. **المشغل الصوتي (Audio Player — 3 أنماط):**
   - **النمط 1 (الافتراضي):** بطاقة زجاجية مع غلاف مربع، شريط تقدم، زر تشغيل/إيقاف مؤقت، و7 أعمدة موجات صوتية متحركة (`.audio-bar`).
   - **النمط 2:** أسطوانة دائرية تدور (`spin 7s linear infinite`).
   - **النمط 3:** كبسولة مصغرة.
10. **الحقول والبحث والتصفية (Inputs, Chips & Badges):** حقول إدخال بتسميات ظاهرة وحالات خطأ/تعطيل، ورقائق تصفية تفاعلية (`.chip`)، وشارات حالة (`.badge`).
11. **إحصائيات وتخزين محلي (Stats & Local Storage):** بطاقات مؤشرات رقمية وعرض لحالة `localStorage` ووضع PWA.

---

## 7. مكتبة Prompts لتوليد الصور والـ Mockups

> **Negative Prompt الموحد (يُرفق تلقائياً مع كل Prompt):**
> `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors`

| # | العنصر | Prompt | Negative Prompt | Parameters |
|---|---|---|---|---|
| 1 | واجهة تطبيق موبايل | `mobile app UI, liquid glass aesthetic with frosted glass panels, soft cool lighting, color palette of deep navy, electric blue and cyan with indigo and violet accents on midnight black, layered card layout with depth, modern and sleek mood, smooth rendering technique` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors such as gold, green, red, orange, pink or beige` | `--ar 9:16 --style raw --stylize 250` |
| 2 | مشغل صوتي زجاجي | `mobile app audio player card, liquid glass effect, frosted and glossy surfaces, soft ambient lighting with blue tones, cyan waveform accents, deep navy to midnight black gradient, layered depth with transparency, modern and sleek mood, high-quality rendering` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 9:16 --style raw --stylize 250` |
| 3 | أيقونة تطبيق | `rounded app icon, liquid glass aesthetic, glossy finish with subtle highlights, soft gradient from cyan to electric blue to royal blue, minimalistic design with depth through layering, smooth edges and soft shadows, modern mood` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 1:1 --style raw --stylize 250` |
| 4 | مفتاح ON/OFF سائل | `frosted glass toggle switch, liquid glass aesthetic, glossy transparent materials, soft lighting, cyan glow when on and deep navy when off, minimalist composition, subtle depth, high-fidelity rendering` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 1:1 --style raw --stylize 250` |
| 5 | زر Liquid Lens | `liquid glass lens button, frosted capsule with refractive bevel, dual specular highlights, electric blue circular badge, royal blue to indigo background, soft diffused lighting, modern and sleek mood` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 16:9 --style raw --stylize 250` |
| 6 | تاب بار بنوتش | `sleek mobile tab bar with a circular notch, claymorphism meets liquid glass, floating electric blue bubble with cyan glow, deep navy frosted bar on midnight black, soft ambient lighting, minimalistic composition` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 16:9 --style raw --stylize 250` |
| 7 | لوحة تحكم (Dashboard) | `mobile dashboard, glassmorphism aesthetic with frosted glass panels, cool blue palette of navy, electric blue and cyan with violet highlights, layered card layouts for data, smooth lighting creating depth, clean and professional mood` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 9:16 --style raw --stylize 250` |
| 8 | شاشة تحميل بالبلور | `blurry loading screen, soft focus gradient of royal blue, cyan and violet resolving into sharp focus, frosted glass counter, calm and modern mood` | `low contrast, harsh shadows, cluttered layout, pixelation, watermark, jpeg artifacts, excessive text, off-palette colors` | `--ar 9:16 --style raw --stylize 250` |

---

## 8. قائمة التحقق قبل التسليم (Checklist)
- [x] واجهة عربية `RTL` بالكامل مع خطي `Cairo` و `Almarai`.
- [x] الالتزام بمتغيرات الألوان المعتمدة (الباليت الأزرق/السيان + خيار الباليت الذهبي/التيل).
- [x] عمل السمات الثلاث (`Dark`، `Dim`، `Light`) بسلاسة وحفظ الاختيار محلياً.
- [x] دخول العناصر بحركة `wordIn` مع `stagger` واحترام `prefers-reduced-motion`.
- [x] شمول كافة المكونات: مبدل السمات، مفتاح ON/OFF السائل، الأزرار (بما فيها Lens)، Clay Segmented، تاب بار بنوتش، الاسكرول بار السائل، التحميل بالبلور، المشغل الصوتي، الحقول، الرقائق، الإحصائيات، ومكتبة البرومتات.
- [x] استخدام نصوص عامة محايدة للمعاينة والاختبار.

*Marco Sawiris Design System (v2.0) — Unified Liquid Glass Specification · RTL*