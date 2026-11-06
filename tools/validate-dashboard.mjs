import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const html = readFileSync('app/src/main/assets/index.html', 'utf8');
const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
const inlineScripts = scriptTags.filter((match) => !/\bsrc\s*=/.test(match[1]));
if (inlineScripts.length === 0) {
  console.error('No inline JavaScript blocks found.');
  process.exit(1);
}

let failed = false;
inlineScripts.forEach((match, index) => {
  const result = spawnSync(process.execPath, ['--check'], {
    input: match[2],
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed = true;
    const startLine = html.slice(0, match.index).split('\n').length;
    console.error('Inline script #' + (index + 1) + ' (HTML line ' + startLine + ') failed syntax validation:');
    process.stderr.write(result.stderr || result.stdout || 'Unknown Node.js syntax error.\n');
  }
});


const requiredUiContracts = [
  ['About button uses the dedicated modal handler', /id="btnAboutApp"[^>]*onclick="openAboutModal\(\)"/],
  ['Dedicated About modal handler exists', /window\.openAboutModal\s*=\s*function/],
  ['About modal markup exists', /id="aboutModal"/],
  ['Original modal open function exists', /function showModal\(modalId\)/],
  ['Original modal close function exists', /function hideModal\(modalId\)/],
  ['Bell uses the existing notification handler', /id="btnBell"[^>]*onclick="toggleNotifPanel\(\)"/],
  ['Notification panel markup exists', /id="notifPanel"/],
  ['Notification overlay markup exists', /id="notifOverlay"/],
  ['Notification panel handler exists', /window\.toggleNotifPanel\s*=\s*function/],
  ['Notification close handler exists', /window\.closeNotifPanel\s*=\s*function/],
  ['No late duplicate WebView handler override remains', !/Android WebView-safe handlers for About and Notifications/.test(html)]
];

for (const [label, check] of requiredUiContracts) {
  const passed = check instanceof RegExp ? check.test(html) : check;
  if (!passed) {
    failed = true;
    console.error('UI contract validation failed: ' + label);
  }
}

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicateIds.length) {
  failed = true;
  console.error('Duplicate HTML IDs found: ' + duplicateIds.join(', '));
}

if (failed) process.exit(1);
console.log('Validated ' + inlineScripts.length + ' inline JavaScript blocks successfully.');
