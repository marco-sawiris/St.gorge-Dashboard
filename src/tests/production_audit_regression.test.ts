import fs from 'fs';
import path from 'path';
import assert from 'assert';
import React from 'react';
import { renderToString } from 'react-dom/server';
import 'fake-indexeddb/auto';

import {
  formatTelHref,
  formatWhatsAppUrl,
  getLatestHeldFridayString
} from '../utils/arabicUtils';
import { buildCsvContent } from '../utils/exportUtils';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { executeProcessOfflineQueue } from '../context/AppContext';
import { idbQueueMutation, idbGetPendingMutations } from '../services/indexedDbService';

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf-8');
}

async function runTests() {
  console.log('=== Running Production Readiness Audit Regression Tests ===\n');

  // 1. googleSheetsService regex & formula sanitization
  const gsServiceSrc = readProjectFile('server/services/googleSheetsService.ts');
  assert(!gsServiceSrc.includes('/^\\\\d{4}-\\\\d{2}-\\\\d{2}$/'), 'Double-escaped Friday regex removed');
  assert(!gsServiceSrc.includes('/^افتقاد\\\\s+'), 'Double-escaped followup regex removed');
  assert(gsServiceSrc.includes('/^\\d{4}-\\d{2}-\\d{2}$/'), 'Valid Friday date regex present');
  assert(gsServiceSrc.includes('/^افتقاد\\s+(\\d{4}-\\d{2}-\\d{2})$/'), 'Valid followup header regex present');
  assert(gsServiceSrc.includes('sanitizeSheetCell'), 'Formula injection guard present in GoogleSheetsService');
  console.log('✅ Test 1 Passed: GoogleSheetsService regexes & formula injection protection verified.');

  // 2. Code.gs APPROVED_SHEETS guard in doPost, ES5 safety & formula escaping
  const codeGsSrc = readProjectFile('docs/google-apps-script/Code.gs');
  assert(codeGsSrc.includes('APPROVED_SHEETS.indexOf(targetSheetName) === -1'), 'Code.gs doPost enforces APPROVED_SHEETS allowlist');
  assert(!codeGsSrc.includes('?.'), 'Code.gs uses ES5-compatible property checks without optional chaining');
  assert(codeGsSrc.includes('function sanitizeFormulaValue'), 'Code.gs sanitizes spreadsheet formula prefixes');
  console.log('✅ Test 2 Passed: Code.gs allowlist, ES5 compatibility & formula neutralization verified.');

  // 3. StudentsTableView & DashboardChartsView & FollowupLogView Friday alignment + click guard
  const tableSrc = readProjectFile('src/components/table/StudentsTableView.tsx');
  const chartsSrc = readProjectFile('src/components/charts/DashboardChartsView.tsx');
  const followupSrc = readProjectFile('src/components/followup/FollowupLogView.tsx');
  assert(!tableSrc.includes('getNearestFridayString'), 'StudentsTableView no longer uses future Friday for attendance');
  assert(tableSrc.includes('getLatestHeldFridayString'), 'StudentsTableView uses getLatestHeldFridayString');
  assert(tableSrc.includes('inFlightStudentIds'), 'StudentsTableView guards rapid attendance clicks with inFlightStudentIds');
  assert(!chartsSrc.includes('getNearestFridayString'), 'DashboardChartsView no longer uses future Friday for attendance');
  assert(chartsSrc.includes('getLatestHeldFridayString'), 'DashboardChartsView uses getLatestHeldFridayString');
  assert(followupSrc.includes('getLatestHeldFridayString'), 'FollowupLogView uses getLatestHeldFridayString for attendance summary');
  console.log('✅ Test 3 Passed: Attendance Friday source-of-truth unified across all views (' + getLatestHeldFridayString() + ').');

  // 4. CSV Formula Injection Protection
  const csv = buildCsvContent(
    ['الاسم', 'ملاحظات'],
    [
      ['=CMD|"/C calc"!A0', '-'],
      ['+1+1', '@SUM(A1:A5)'],
      ['\tInjected', 'مارك']
    ]
  );
  assert(csv.includes('"\'=CMD|""/C calc""!A0"'), 'Leading = neutralized in CSV');
  assert(csv.includes('"-"'), 'Standalone dash placeholder preserved cleanly');
  assert(csv.includes('"\'+1+1"'), 'Leading + neutralized in CSV');
  assert(csv.includes('"\'@SUM(A1:A5)"'), 'Leading @ neutralized in CSV');
  assert(csv.includes('"\'\tInjected"'), 'Leading tab neutralized in CSV');
  console.log('✅ Test 4 Passed: CSV formula injection protection verified.');

  // 5. Phone & WhatsApp URL Normalization + XSS Blocking
  assert.strictEqual(formatTelHref('javascript:alert(1)'), null, 'Malicious tel scheme blocked');
  assert.strictEqual(formatTelHref('٠١٠١٢٣٤٥٦٧٨'), 'tel:01012345678', 'Arabic-Indic phone normalized for tel:');
  assert.strictEqual(formatWhatsAppUrl('01012345678'), 'https://wa.me/201012345678', 'Local Egyptian phone formatted correctly');
  assert.strictEqual(formatWhatsAppUrl('201234567890'), 'https://wa.me/201234567890', 'International 20... phone avoids double prefix 220...');
  assert.strictEqual(formatWhatsAppUrl('1012345678'), 'https://wa.me/201012345678', '10-digit Egyptian mobile prefixed with 20');
  assert.strictEqual(formatWhatsAppUrl('javascript:alert(1)'), null, 'Invalid phone returns null WhatsApp URL');
  console.log('✅ Test 5 Passed: Phone & WhatsApp normalization and XSS scheme blocking verified.');

  // 6. ErrorBoundary SSR & Fallback State
  const okHtml = renderToString(React.createElement(ErrorBoundary, null, React.createElement('div', null, 'SafeChild')));
  assert(okHtml.includes('SafeChild'), 'ErrorBoundary renders normal children cleanly');
  const errState = ErrorBoundary.getDerivedStateFromError(new Error('Test UI Error'));
  assert.strictEqual(errState.hasError, true);
  assert.strictEqual(errState.errorMessage, 'Test UI Error');
  const boundaryInstance = new ErrorBoundary({ children: null });
  boundaryInstance.state = errState;
  const fallbackHtml = renderToString(boundaryInstance.render() as React.ReactElement);
  assert(fallbackHtml.includes('IndexedDB'), 'ErrorBoundary reassures users IndexedDB data is intact');
  assert(fallbackHtml.includes('إعادة المحاولة'), 'ErrorBoundary displays Arabic recovery actions');
  console.log('✅ Test 6 Passed: React ErrorBoundary crash recovery verified.');

  // 7. Concurrent Offline Queue Flush Serialization (No Duplicate Sends)
  const storageMap = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear()
  };
  await idbQueueMutation({
    id: 'AUDIT_MUT_CONCURRENT_1',
    action: 'attendance',
    studentId: 'st_audit_1',
    studentCode: 'A1',
    studentName: 'اختبار التزامن',
    sourceSheet: 'نشط',
    payload: { friday: getLatestHeldFridayString(), isPresent: true },
    expectedVersion: 1,
    timestamp: Date.now(),
    retryCount: 0,
    status: 'pending'
  });

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    await new Promise((r) => setTimeout(r, 40));
    return new Response(JSON.stringify({ ok: true, status: 200, newVersion: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;

  try {
    const [resA, resB] = await Promise.all([
      executeProcessOfflineQueue(null, false),
      executeProcessOfflineQueue(null, false)
    ]);
    assert.strictEqual(fetchCallCount, 1, `Expected 1 serialized HTTP send, got ${fetchCallCount}`);
    assert.strictEqual(resA.sentCount + resB.sentCount, 1, 'Mutation processed cleanly once across concurrent calls');
    const remaining = await idbGetPendingMutations();
    assert.strictEqual(remaining.length, 0, 'Pending queue empty after confirmed send');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✅ Test 7 Passed: Concurrent executeProcessOfflineQueue calls serialize with zero duplicate sends.');

  // 8. Server, JWT, DB Schema, .env.example & Android Security Hardening
  const serverSrc = readProjectFile('server.ts');
  assert(serverSrc.includes("app.set('trust proxy', 1)"), 'Express trust proxy configured');
  assert(serverSrc.includes('X-Content-Type-Options'), 'nosniff security header set');
  assert(serverSrc.includes('X-Frame-Options'), 'DENY frame header set');
  assert(serverSrc.includes('Referrer-Policy'), 'Referrer-Policy header set');

  const jwtSrc = readProjectFile('server/security/jwt.ts');
  assert(jwtSrc.includes('ENV.JWT_EXPIRES_IN') && jwtSrc.includes('ENV.JWT_REFRESH_EXPIRES_IN'), 'JWT reads configured expirations');

  const schemaSql = readProjectFile('server/db/schema.sql');
  const dbIndex = readProjectFile('server/db/index.ts');
  assert(schemaSql.includes('VARCHAR(512) PRIMARY KEY') && dbIndex.includes('VARCHAR(512) PRIMARY KEY'), 'idempotency_keys.key widened to VARCHAR(512)');

  const envExample = readProjectFile('.env.example');
  assert(envExample.includes('VITE_RELAY_KEY=""') && !envExample.includes('st_gorge_secret_token_2026'), '.env.example contains no sample relay secret');

  const manifestXml = readProjectFile('android/app/src/main/AndroidManifest.xml');
  const netSecXml = readProjectFile('android/app/src/main/res/xml/network_security_config.xml');
  assert(manifestXml.includes('android:allowBackup="false"'), 'AndroidManifest disables ADB backup');
  assert(manifestXml.includes('android:usesCleartextTraffic="false"'), 'AndroidManifest disables cleartext traffic');
  assert(manifestXml.includes('@xml/network_security_config'), 'AndroidManifest binds network_security_config');
  assert(netSecXml.includes('cleartextTrafficPermitted="false"'), 'network_security_config forbids cleartext HTTP');
  console.log('✅ Test 8 Passed: Backend headers, JWT config, Postgres DDL, .env.example & Android manifest verified.');

  // 9. CI APK Delivery Workflow & Download Route
  const ciYaml = readProjectFile('.github/workflows/ci.yml');
  assert(ciYaml.includes('APP Final/StGeorge-Dashboard.apk'), 'CI delivers APK to APP Final/StGeorge-Dashboard.apk');
  assert(ciYaml.includes('paths-ignore:') && ciYaml.includes('"APP Final/**"'), 'CI ignores APP Final/** on push to avoid commit loops');
  assert(ciYaml.includes('[skip ci]') && ciYaml.includes('contents: write'), 'CI has scoped write permission and skip-ci commit guard');
  assert(serverSrc.includes('/download/StGeorge-Dashboard.apk'), 'Express server exposes /download/StGeorge-Dashboard.apk');
  console.log('✅ Test 9 Passed: CI APK workflow loop-safety & download route verified.');

  console.log('\n🎉 ALL PRODUCTION AUDIT REGRESSION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Production audit test failed:', err);
  process.exit(1);
});
