import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

// Polyfill minimal browser globals for SSR rendering checks
const storageMap = new Map<string, string>();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    get length() {
      return storageMap.size;
    }
  };
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: (globalThis as any).localStorage,
    location: { origin: 'http://localhost:3000', protocol: 'http:' },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    documentElement: {
      dataset: {},
      style: {},
      setAttribute: () => {},
      classList: { add: () => {}, remove: () => {} }
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}

import { ThemeProvider } from '../context/ThemeContext';
import { AuthProvider } from '../context/AuthContext';
import { AppProvider } from '../context/AppContext';
import { ThemeSwitcher } from '../components/glass/ThemeSwitcher';
import { SyncStatusIndicator } from '../components/glass/SyncStatusIndicator';
import { TopBar } from '../components/layout/TopBar';
import { Sidebar } from '../components/layout/Sidebar';
import { SearchFilterBar } from '../components/common/SearchFilterBar';
import { StudentCard } from '../components/cards/StudentCard';
import { StudentsTableView } from '../components/table/StudentsTableView';
import { DashboardChartsView } from '../components/charts/DashboardChartsView';
import { FollowupLogView } from '../components/followup/FollowupLogView';
import { NotificationsPanel } from '../components/modals/NotificationsPanel';
import { Student } from '../types/student';

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf-8');
}

function extractCssBlockVars(css: string, selectorRegex: RegExp): Record<string, string> {
  const match = css.match(selectorRegex);
  assert.ok(match && match[1], `Expected CSS block matching ${selectorRegex}`);
  const vars: Record<string, string> = {};
  const propRegex = /(--[a-zA-Z0-9-_]+)\s*:\s*([^;]+);/g;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = propRegex.exec(match[1])) !== null) {
    vars[propMatch[1].trim()] = propMatch[2].trim();
  }
  return vars;
}

function resolveCssVar(vars: Record<string, string>, name: string, depth = 0): string {
  assert.ok(depth < 10, `Circular CSS variable reference at ${name}`);
  const raw = vars[name];
  assert.ok(raw, `Missing CSS token ${name}`);
  const varMatch = raw.match(/^var\((--[a-zA-Z0-9-_]+)\)$/);
  if (varMatch) {
    return resolveCssVar(vars, varMatch[1], depth + 1);
  }
  return raw;
}

function parseColor(raw: string): RGBA {
  const value = raw.trim();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1
      };
    }
  }
  const rgbaMatch = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgbaMatch) {
    return {
      r: Number(rgbaMatch[1]),
      g: Number(rgbaMatch[2]),
      b: Number(rgbaMatch[3]),
      a: rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1
    };
  }
  throw new Error(`Unsupported color format in contrast audit: ${raw}`);
}

function compositeOver(fg: RGBA, bg: RGBA): RGBA {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a
  };
}

function relativeLuminance(c: RGBA): number {
  const toLinear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

function contrastRatio(fg: RGBA, bg: RGBA): number {
  const bgOpaque = bg.a < 1 ? compositeOver(bg, { r: 0, g: 0, b: 0, a: 1 }) : bg;
  const fgResolved = fg.a < 1 ? compositeOver(fg, bgOpaque) : fg;
  const l1 = relativeLuminance(fgResolved);
  const l2 = relativeLuminance(bgOpaque);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrast(
  themeName: string,
  pairLabel: string,
  fgRaw: string,
  bgRaw: string,
  minRatio: number,
  backdropRaw?: string
) {
  let bg = parseColor(bgRaw);
  if (bg.a < 1 && backdropRaw) {
    bg = compositeOver(bg, parseColor(backdropRaw));
  }
  const fg = parseColor(fgRaw);
  const ratio = contrastRatio(fg, bg);
  assert.ok(
    ratio >= minRatio,
    `[${themeName}] Contrast check failed for ${pairLabel}: ${fgRaw} on ${bgRaw}${backdropRaw ? ` (over ${backdropRaw})` : ''} => ${ratio.toFixed(2)}:1 < required ${minRatio}:1`
  );
}

function buildSampleStudents(): Student[] {
  return [
    {
      id: 'st_contrast_1',
      code: 'SG-101',
      name: 'بيشوي عماد فؤاد',
      servant: 'أ/ مينا عادل',
      sourceSheet: 'نشط',
      area: 'الزيتون',
      address: '12 شارع طومانباي',
      phoneStudent: '01200001111',
      phoneParent1: '01200002222',
      phoneParent2: '',
      birthDate: '2012-05-10',
      attendanceTotal: 5,
      attendanceMonth: 2,
      attendanceStatus: 'حاضر',
      lastAttendance: '2026-04-10',
      followupStatus: 'تم تليفونياً',
      notes: 'طالب منتظم ومشارك',
      att: { '2026-04-03': true, '2026-04-10': true },
      fu: { '2026-04-10': 'تم تليفونياً' },
      version: 2
    },
    {
      id: 'st_contrast_2',
      code: 'SG-102',
      name: 'كيرلس هاني سمير',
      servant: 'أ/ مينا عادل',
      sourceSheet: 'متابعة',
      area: 'حدائق القبة',
      address: '5 شارع مصر والسودان',
      phoneStudent: '01000003333',
      phoneParent1: '',
      phoneParent2: '',
      birthDate: '2011-08-20',
      attendanceTotal: 2,
      attendanceMonth: 0,
      attendanceStatus: 'غائب',
      lastAttendance: '2026-03-27',
      followupStatus: 'لم يتم التواصل',
      notes: '',
      att: { '2026-04-03': false, '2026-04-10': false },
      fu: { '2026-04-10': 'لم يتم التواصل' },
      version: 1
    }
  ];
}

async function runTests() {
  console.log('🎨 Running Theme Contrast & Dual-Theme WCAG 2.2 AA Audit...');

  const css = readProjectFile('src/index.css');

  // --------------------------------------------------------------------------
  // 1. Parse CSS token sets for Dark, Dim, and Light themes
  // --------------------------------------------------------------------------
  const darkVars = extractCssBlockVars(css, /:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  const dimVarsRaw = extractCssBlockVars(css, /\[data-theme="dim"\]\s*\{([\s\S]*?)\n\}/);
  const dimVars: Record<string, string> = { ...darkVars, ...dimVarsRaw };
  const lightVarsRaw = extractCssBlockVars(css, /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
  const lightVars: Record<string, string> = { ...darkVars, ...lightVarsRaw };

  const requiredSemanticTokens = [
    '--app-bg',
    '--bg-primary',
    '--bg-secondary',
    '--surface-primary',
    '--surface-secondary',
    '--surface-inset',
    '--surface-glass',
    '--surface-glass-strong',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--border-color',
    '--border-default',
    '--accent-primary',
    '--accent-secondary',
    '--success-text',
    '--success-bg',
    '--success-border',
    '--warning-text',
    '--warning-bg',
    '--warning-border',
    '--danger-text',
    '--danger-bg',
    '--danger-border',
    '--info-text',
    '--info-bg',
    '--info-border'
  ];

  for (const [themeName, themeVars] of [
    ['dark', darkVars],
    ['dim', dimVars],
    ['light', lightVars]
  ] as const) {
    for (const token of requiredSemanticTokens) {
      assert.ok(themeVars[token], `[${themeName}] Missing required semantic token: ${token}`);
    }

    const appBg = resolveCssVar(themeVars, '--app-bg');
    const surfPrimary = resolveCssVar(themeVars, '--surface-primary');
    const surfSecondary = resolveCssVar(themeVars, '--surface-secondary');
    const surfInset = resolveCssVar(themeVars, '--surface-inset');
    const surfGlass = resolveCssVar(themeVars, '--surface-glass');
    const surfGlassStrong = resolveCssVar(themeVars, '--surface-glass-strong');

    const textPrimary = resolveCssVar(themeVars, '--text-primary');
    const textSecondary = resolveCssVar(themeVars, '--text-secondary');
    const textMuted = resolveCssVar(themeVars, '--text-muted');

    // Primary text contrast >= 7.0:1 on all surfaces
    assertContrast(themeName, '--text-primary on --app-bg', textPrimary, appBg, 7.0);
    assertContrast(themeName, '--text-primary on --surface-primary', textPrimary, surfPrimary, 7.0);
    assertContrast(themeName, '--text-primary on --surface-secondary', textPrimary, surfSecondary, 7.0);
    assertContrast(themeName, '--text-primary on --surface-inset', textPrimary, surfInset, 7.0, appBg);
    assertContrast(themeName, '--text-primary on --surface-glass', textPrimary, surfGlass, 7.0, appBg);
    assertContrast(themeName, '--text-primary on --surface-glass-strong', textPrimary, surfGlassStrong, 7.0, appBg);

    // Secondary text contrast >= 4.5:1 on all surfaces
    assertContrast(themeName, '--text-secondary on --app-bg', textSecondary, appBg, 4.5);
    assertContrast(themeName, '--text-secondary on --surface-primary', textSecondary, surfPrimary, 4.5);
    assertContrast(themeName, '--text-secondary on --surface-secondary', textSecondary, surfSecondary, 4.5);
    assertContrast(themeName, '--text-secondary on --surface-inset', textSecondary, surfInset, 4.5, appBg);
    assertContrast(themeName, '--text-secondary on --surface-glass', textSecondary, surfGlass, 4.5, appBg);

    // Muted text contrast >= 4.5:1 (strict WCAG AA for 11px/12px metadata)
    assertContrast(themeName, '--text-muted on --app-bg', textMuted, appBg, 4.5);
    assertContrast(themeName, '--text-muted on --surface-primary', textMuted, surfPrimary, 4.5);
    assertContrast(themeName, '--text-muted on --surface-secondary', textMuted, surfSecondary, 4.5);
    assertContrast(themeName, '--text-muted on --surface-inset', textMuted, surfInset, 4.5, appBg);

    // Accent & Semantic status text over primary surface & over status pill background
    for (const pair of [
      ['--accent-primary', surfPrimary],
      ['--accent-secondary', surfPrimary],
      ['--success-text', surfPrimary],
      ['--warning-text', surfPrimary],
      ['--danger-text', surfPrimary],
      ['--info-text', surfPrimary]
    ] as const) {
      assertContrast(themeName, `${pair[0]} on --surface-primary`, resolveCssVar(themeVars, pair[0]), pair[1], 4.5);
    }

    assertContrast(
      themeName,
      '--success-text on --success-bg',
      resolveCssVar(themeVars, '--success-text'),
      resolveCssVar(themeVars, '--success-bg'),
      4.5,
      surfPrimary
    );
    assertContrast(
      themeName,
      '--warning-text on --warning-bg',
      resolveCssVar(themeVars, '--warning-text'),
      resolveCssVar(themeVars, '--warning-bg'),
      4.5,
      surfPrimary
    );
    assertContrast(
      themeName,
      '--danger-text on --danger-bg',
      resolveCssVar(themeVars, '--danger-text'),
      resolveCssVar(themeVars, '--danger-bg'),
      4.5,
      surfPrimary
    );
    assertContrast(
      themeName,
      '--info-text on --info-bg',
      resolveCssVar(themeVars, '--info-text'),
      resolveCssVar(themeVars, '--info-bg'),
      4.5,
      surfPrimary
    );

    // Input fields & placeholders (--text-primary and --text-muted on --input-bg composited over --app-bg)
    const inputBg = resolveCssVar(themeVars, '--input-bg');
    assertContrast(themeName, '--text-primary on --input-bg', textPrimary, inputBg, 4.5, appBg);
    assertContrast(themeName, 'placeholder (--text-muted) on --input-bg', textMuted, inputBg, 4.5, appBg);

    // Hover surfaces (--text-primary & --text-secondary over --surface-hover composited over --surface-primary)
    const surfHover = resolveCssVar(themeVars, '--surface-hover');
    assertContrast(themeName, '--text-primary on --surface-hover', textPrimary, surfHover, 4.5, surfPrimary);
    assertContrast(themeName, '--text-secondary on --surface-hover', textSecondary, surfHover, 4.5, surfPrimary);

    // White button text contrast on unified primary/active & danger gradient stops
    assertContrast(themeName, 'white on #123FCE', '#FFFFFF', '#123FCE', 4.5);
    assertContrast(themeName, 'white on #1D4ED8', '#FFFFFF', '#1D4ED8', 4.5);
    assertContrast(themeName, 'white on #0369A1', '#FFFFFF', '#0369A1', 4.5);
    assertContrast(themeName, 'white on #BE123C', '#FFFFFF', '#BE123C', 4.5);
    assertContrast(themeName, 'white on #9F1239', '#FFFFFF', '#9F1239', 4.5);
  }
  console.log('✅ Test 1 Passed: All Dark, Dim, and Light CSS tokens (including inputs, placeholders & hover) satisfy WCAG 2.2 AA contrast ratios');

  // --------------------------------------------------------------------------
  // 2. Cascade & Layering Regression Guard (prevents white-on-white pill collapse)
  // --------------------------------------------------------------------------
  const layerComponentsStart = css.indexOf('@layer components {');
  assert.ok(layerComponentsStart !== -1, 'src/index.css must wrap component styles in @layer components');
  const firstGlassBtnIdx = css.indexOf('.glass-btn--primary {', layerComponentsStart);
  assert.ok(
    firstGlassBtnIdx > layerComponentsStart,
    '.glass-btn--primary must live inside @layer components so Tailwind .absolute utility overrides position: relative'
  );
  assert.match(
    css,
    /\[data-theme="light"\]\s*\.sidebar-glass-panel\s*\{[^}]*0\.92/,
    'Light Mode sidebar glass drawer must use crisp >= 0.90 background opacity'
  );
  console.log('✅ Test 2 Passed: CSS @layer components cascade guarantees active motion pills render visibly');

  // --------------------------------------------------------------------------
  // 3. Component Source & Modal Semantic Token Audit
  // --------------------------------------------------------------------------
  const notificationsSource = readProjectFile('src/components/modals/NotificationsPanel.tsx');
  assert.ok(!notificationsSource.includes('opacity-85'), 'Read notifications must not reduce container opacity');
  assert.ok(!notificationsSource.includes('opacity-70'), 'Paused Weekly Reminders must not dim entire card with opacity-70');
  assert.ok(notificationsSource.includes('bg-[var(--surface-inset)]'), 'Notifications sub-tab bar must use crisp surface-inset');

  const assistantSource = readProjectFile('src/components/modals/AssistantModal.tsx');
  assert.ok(
    assistantSource.includes('data-testid="assistant-individual-student-card"'),
    'AssistantModal must preserve 2-row individual student card structure'
  );
  assert.ok(assistantSource.includes('bg-emerald-700 text-white'), 'AssistantModal active present toggle must use high-contrast emerald-700 + white');
  assert.ok(assistantSource.includes('bg-amber-700 text-white'), 'AssistantModal active absent toggle must use high-contrast amber-700 + white');

  const pdfModalSource = readProjectFile('src/components/modals/PdfAttendanceImportModal.tsx');
  assert.ok(!pdfModalSource.includes('bg-[var(--accent-primary)] text-white'), 'PdfAttendanceImportModal must not pair dark-mode light blue accent-primary with white text');

  const syncModalSource = readProjectFile('src/components/modals/SyncDetailsModal.tsx');
  assert.ok(syncModalSource.includes('var(--warning-text)') && syncModalSource.includes('var(--danger-bg)'), 'SyncDetailsModal must use semantic status tokens');

  const queueModalSource = readProjectFile('src/components/modals/QueueDetailsModal.tsx');
  assert.ok(queueModalSource.includes('var(--warning-bg)') && queueModalSource.includes('var(--success-text)'), 'QueueDetailsModal must use semantic status tokens');

  // Verify instant binary toggle removed and Sidebar -> AppearanceModal popup preserved cleanly
  const themeCtxSource = readProjectFile('src/context/ThemeContext.tsx');
  assert.ok(!themeCtxSource.includes('toggleTheme'), 'ThemeContext must not expose duplicate instant binary toggleTheme handler');

  const appearanceModalSource = readProjectFile('src/components/modals/AppearanceModal.tsx');
  assert.ok(
    !appearanceModalSource.includes('تبديل السمة الفوري') &&
      !appearanceModalSource.includes('<ThemeSwitcher />') &&
      appearanceModalSource.includes("'dark'") &&
      appearanceModalSource.includes("'dim'") &&
      appearanceModalSource.includes("'light'"),
    'AppearanceModal must preserve all 3 theme options without duplicate Instant Theme Toggle UI'
  );

  const sidebarSource = readProjectFile('src/components/layout/Sidebar.tsx');
  assert.ok(
    sidebarSource.includes('مظهر وسمة التطبيق') && sidebarSource.includes('setIsAppearanceModalOpen(true)'),
    'Sidebar must keep Appearance button opening AppearanceModal popup'
  );

  const appSource = readProjectFile('src/App.tsx');
  assert.ok(
    appSource.includes('!bg-[var(--surface-glass-strong)]'),
    'App.tsx floating toasts & alerts must keep opaque glass-strong surface backdrop'
  );

  console.log('✅ Test 3 Passed: Modals, Theme Selector hygiene, and semantic contrast token checks');

  // --------------------------------------------------------------------------
  // 4. Dual-Theme SSR Render Smoke Audit (Light Mode & Dark Mode)
  // --------------------------------------------------------------------------
  const sampleStudents = buildSampleStudents();

  for (const themeMode of ['light', 'dark', 'dim'] as const) {
    (globalThis as any).localStorage.setItem('st_george_theme', themeMode);

    const switcherHtml = renderToStaticMarkup(
      React.createElement(ThemeProvider, null, React.createElement(ThemeSwitcher))
    );
    assert.ok(switcherHtml.includes('داكن') && switcherHtml.includes('فاتح'), `[${themeMode}] ThemeSwitcher must render labels`);

    const syncHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(SyncStatusIndicator)
          )
        )
      )
    );
    assert.ok(syncHtml.length > 20, `[${themeMode}] SyncStatusIndicator must render`);

    const cardHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(StudentCard, {
              student: sampleStudents[0],
              onOpenFollowup: () => {},
              onOpenEdit: () => {}
            })
          )
        )
      )
    );
    assert.ok(cardHtml.includes('بيشوي عماد فؤاد'), `[${themeMode}] StudentCard must render student name`);
    assert.ok(cardHtml.includes('حاضر') && cardHtml.includes('غائب'), `[${themeMode}] StudentCard must render attendance controls`);

    const tableHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(StudentsTableView, {
              onOpenFollowup: () => {},
              onOpenEdit: () => {}
            })
          )
        )
      )
    );
    assert.ok(tableHtml.length > 20, `[${themeMode}] StudentsTableView must render cleanly`);

    const chartsHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(DashboardChartsView)
          )
        )
      )
    );
    assert.ok(chartsHtml.includes('إجمالي المخدومين'), `[${themeMode}] DashboardChartsView must render KPI cards`);

    const followupHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(FollowupLogView)
          )
        )
      )
    );
    assert.ok(followupHtml.length > 20, `[${themeMode}] FollowupLogView must render cleanly`);

    const chromeHtml = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            AppProvider,
            null,
            React.createElement(
              React.Fragment,
              null,
              React.createElement(TopBar),
              React.createElement(SearchFilterBar),
              React.createElement(Sidebar),
              React.createElement(NotificationsPanel)
            )
          )
        )
      )
    );
    assert.ok(chromeHtml.includes('St. George'), `[${themeMode}] TopBar/Sidebar chrome must render cleanly`);
  }

  console.log('✅ Test 4 Passed: All dashboard views, cards, tables, charts, and layout chrome SSR-render cleanly across Light, Dim, and Dark themes');
  console.log('🎉 ALL THEME CONTRAST & WCAG 2.2 AA AUDIT CHECKS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Theme Contrast Audit Failed:', err);
  process.exit(1);
});
