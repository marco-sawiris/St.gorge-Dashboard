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

if (failed) process.exit(1);
console.log('Validated ' + inlineScripts.length + ' inline JavaScript blocks successfully.');
