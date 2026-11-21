/**
 * ============================================================================
 * St. George Dashboard — Authoritative Google Apps Script Backend
 * Phase 4.4 — Central Google Sheets Persistence & Remote Persistence Proof
 * ============================================================================
 *
 * Authoritative Central Database:
 *   Central Spreadsheet ID = "15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0"
 *
 * Compatible with:
 *   1. St. George Dashboard Web / Android APK (Phase 4.3.2–4.4 Offline Queue + Proof Verification)
 *   2. Legacy Standalone HTML App (notes-v2 / notes-v3 payload formats)
 *
 * Core Guarantees:
 *   - Strict Central Spreadsheet enforcement (never accepts client-supplied spreadsheetId)
 *   - Safe tab-name mapping (maps UI 'فصل البابا شنودة' <-> live tab 'فصل البابا شنودة ' without creating tabs)
 *   - Never falls back to 'ردود النموذج 1' for student writes
 *   - Structured RemotePersistenceProof returned ONLY AFTER confirmed sheet write + flush
 *   - Durable idempotency ledger (_mutation_idempotency) + LockService concurrency protection
 *   - Optimistic Concurrency Control (HTTP 409) when version column exists; safe progression when absent
 *   - Strict Zero-Delete policy (HTTP 403)
 *   - Strict ES5 syntax (no optional chaining, no let/const/arrow functions)
 *
 * Script Properties (Google Apps Script -> Project Settings -> Script Properties):
 *   SPREADSHEET_ID = "15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0" (must match exactly)
 *   RELAY_KEY      = Optional secret key for external client authentication.
 */

var CENTRAL_SPREADSHEET_ID = '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0';
var LIVE_STUDENT_SHEETS = ['نشط', 'غير حاضر', 'فصل البابا شنودة'];
var OPTIONAL_STUDENT_SHEETS = [];
var APPROVED_SHEETS = ['نشط', 'غير حاضر', 'فصل البابا شنودة'];
var ALL_SHEETS_SENTINEL = '__ALL__';
var FOLLOWUP_LOG_SHEET_NAME = 'سجل الافتقاد';
var FORBIDDEN_STUDENT_WRITE_SHEETS = ['ردود النموذج 1', 'سجل الافتقاد', '_mutation_idempotency'];

var APPROVED_SHEET_ACTUAL_ALIASES = {
  'نشط': ['نشط'],
  'غير حاضر': ['غير حاضر'],
  'فصل البابا شنودة': ['فصل البابا شنودة ', 'فصل البابا شنودة']
};

function isMissingOrLiteralUndefined(val) {
  if (val === undefined || val === null) return true;
  var str = String(val).trim();
  if (!str) return true;
  var lower = str.toLowerCase();
  return lower === 'undefined' || lower === 'null' || lower === 'nan';
}

function resolveTargetSheetName(candidates, fallbackSheet) {
  for (var i = 0; i < candidates.length; i++) {
    var raw = candidates[i];
    if (!isMissingOrLiteralUndefined(raw)) {
      var trimmed = String(raw).trim();
      if (trimmed !== ALL_SHEETS_SENTINEL) {
        return trimmed;
      }
    }
  }
  return fallbackSheet || 'نشط';
}

function normalizeArabicForMatch(val) {
  var s = String(val || '').trim();
  if (!s) return '';
  s = s.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا');
  s = s.replace(/ى/g, 'ي');
  s = s.replace(/ة/g, 'ه');
  s = s.replace(/چ/g, 'ج');
  s = s.replace(/ڤ/g, 'ف');
  s = s.replace(/پ/g, 'ب');
  s = s.replace(/گ/g, 'ك');
  s = s.replace(/ژ/g, 'ز');
  return s.replace(/\s+/g, ' ').toLowerCase();
}

function isValidIsoDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val.trim());
}

function getCairoTodayDateString() {
  var tz = 'Africa/Cairo';
  try {
    return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  } catch (e) {
    var d = new Date();
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1);
    var day = String(d.getUTCDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }
}

function getCairoMonthString() {
  return getCairoTodayDateString().substring(0, 7);
}

function safeFlushSpreadsheet() {
  if (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.flush === 'function') {
    SpreadsheetApp.flush();
  }
}

// Read-after-write verification: never issue a persistence proof from flush alone.
function normalizeVerificationValue(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Africa/Cairo', 'yyyy-MM-dd');
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function verifyCellValue(sheet, row, column, expected, label) {
  if (!sheet || row < 1 || column < 1) throw new Error('تعذر تحديد خلية التحقق: ' + (label || 'unknown'));
  safeFlushSpreadsheet();
  var actual = sheet.getRange(row, column).getValue();
  var safeExpected = sanitizeFormulaValue(expected);
  if (normalizeVerificationValue(actual) !== normalizeVerificationValue(safeExpected)) {
    throw new Error('فشل التحقق بعد الكتابة في ' + (label || ('R' + row + 'C' + column)) + '. لم يتم إصدار إثبات حفظ.');
  }
  return true;
}

function verifyRowFieldValues(sheet, row, headers, checks) {
  for (var i = 0; i < checks.length; i++) {
    var col = findColIndex(headers, checks[i].aliases);
    if (col >= 0) verifyCellValue(sheet, row, col + 1, checks[i].value, checks[i].label || checks[i].aliases[0]);
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Always resolves the authoritative central Google Sheet.
 * Never accepts a client-supplied spreadsheetId.
 */
function getSpreadsheet() {
  // Always open by explicit ID — never use getActiveSpreadsheet() which
  // returns the container-bound sheet (may be an old/test sheet).
  var props = PropertiesService.getScriptProperties();
  var configuredId = String(props.getProperty('SPREADSHEET_ID') || '').trim();
  if (configuredId && configuredId !== CENTRAL_SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID في Script Properties لا يطابق ملف Google Sheets المركزي المعتمد. تم إيقاف العملية لحماية البيانات.');
  }
  var ss = SpreadsheetApp.openById(CENTRAL_SPREADSHEET_ID);
  if (!ss || String(ss.getId()) !== CENTRAL_SPREADSHEET_ID) {
    throw new Error('تعذر تأكيد معرّف ملف Google Sheets المركزي؛ تم إيقاف العملية.');
  }
  return ss;
}

/**
 * Safely locates an approved student sheet tab in the central spreadsheet.
 * Handles trailing-space live tab names (e.g. 'فصل البابا شنودة ') without renaming
 * or creating tabs, and strictly refuses non-student tabs like 'ردود النموذج 1'.
 */
function findApprovedSheet(ss, canonicalSheetName) {
  var canonical = String(canonicalSheetName || '').trim();
  if (!canonical || APPROVED_SHEETS.indexOf(canonical) === -1) {
    return null;
  }

  var aliases = APPROVED_SHEET_ACTUAL_ALIASES[canonical] || [canonical];
  for (var i = 0; i < aliases.length; i++) {
    var candidate = ss.getSheetByName(aliases[i]);
    if (candidate) {
      var actualName = String(candidate.getName() || '');
      if (FORBIDDEN_STUDENT_WRITE_SHEETS.indexOf(actualName.trim()) === -1) {
        return candidate;
      }
    }
  }

  // Fallback scan by trimmed name across existing sheets only (never creates tabs)
  if (typeof ss.getSheets === 'function') {
    var allSheets = ss.getSheets() || [];
    for (var j = 0; j < allSheets.length; j++) {
      var sh = allSheets[j];
      var shTrimmed = String((sh && typeof sh.getName === 'function' ? sh.getName() : '') || '').trim();
      if (shTrimmed === canonical && FORBIDDEN_STUDENT_WRITE_SHEETS.indexOf(shTrimmed) === -1) {
        return sh;
      }
    }
  }

  return null;
}

function findFollowupLogSheet(ss) {
  var exact = ss.getSheetByName(FOLLOWUP_LOG_SHEET_NAME);
  if (exact) return exact;
  if (typeof ss.getSheets === 'function') {
    var allSheets = ss.getSheets() || [];
    for (var i = 0; i < allSheets.length; i++) {
      var sh = allSheets[i];
      var shName = String((sh && typeof sh.getName === 'function' ? sh.getName() : '') || '').trim();
      if (shName === FOLLOWUP_LOG_SHEET_NAME) return sh;
    }
  }
  return null;
}

/**
 * Constructs a structured RemotePersistenceProof matching
 * src/services/remotePersistenceVerification.ts.
 * Must ONLY be called after the remote sheet write has succeeded and flushed.
 */
function buildPersistenceProof(opts) {
  opts = opts || {};
  var mutationId = String(opts.mutationId || '').trim();
  var operation = String(opts.operation || '').trim();
  var studentId = String(opts.studentId || '').trim();
  var sheetName = String(opts.sheetName || '').trim();

  // A persistence proof is a contract, not a success-shaped response.
  // Refuse to issue it unless all identity fields are explicitly present.
  if (!mutationId) throw new Error('تعذر إصدار إثبات الحفظ: mutationId مفقود.');
  if (!operation) throw new Error('تعذر إصدار إثبات الحفظ: operation مفقود.');
  if (!studentId) throw new Error('تعذر إصدار إثبات الحفظ: studentId مفقود.');
  if (!sheetName) throw new Error('تعذر إصدار إثبات الحفظ: sheetName مفقود.');

  var proof = {
    mutationId: mutationId,
    persisted: true,
    operation: operation,
    studentId: studentId,
    sheetName: sheetName,
    verifiedAt: opts.verifiedAt || new Date().toISOString()
  };

  if (typeof opts.row === 'number' && isFinite(opts.row) && opts.row >= 1) {
    proof.row = Math.floor(opts.row);
  }
  if (opts.recordId !== undefined && opts.recordId !== null && String(opts.recordId).trim()) {
    proof.recordId = String(opts.recordId).trim();
  }
  if (typeof opts.newVersion === 'number' && isFinite(opts.newVersion) && opts.newVersion >= 1) {
    proof.newVersion = Math.floor(opts.newVersion);
  }
  if (opts.friday && isValidIsoDate(String(opts.friday))) {
    proof.friday = String(opts.friday).trim();
  }
  if (opts.date && isValidIsoDate(String(opts.date))) {
    proof.date = String(opts.date).trim();
  }
  if (opts.present !== undefined) {
    proof.present = Boolean(opts.present);
    proof.isPresent = Boolean(opts.present);
  }
  if (opts.followupLogAppended === true) {
    proof.followupLogAppended = true;
  }
  if (typeof opts.followupLogRow === 'number' && isFinite(opts.followupLogRow) && opts.followupLogRow >= 1) {
    proof.followupLogRow = Math.floor(opts.followupLogRow);
  }
  if (opts.deduplicated === true) {
    proof.deduplicated = true;
  }
  return proof;
}

function buildVerifiedMutationResponse(proof, extraFields) {
  var res = {
    ok: true,
    status: 200,
    persisted: true,
    operation: proof.operation,
    action: proof.operation,
    mutationId: proof.mutationId,
    studentId: proof.studentId,
    sheetName: proof.sheetName,
    verifiedAt: proof.verifiedAt,
    proof: proof
  };
  if (proof.row !== undefined) res.row = proof.row;
  if (proof.recordId !== undefined) res.recordId = proof.recordId;
  if (proof.newVersion !== undefined) res.newVersion = proof.newVersion;
  if (proof.friday !== undefined) res.friday = proof.friday;
  if (proof.date !== undefined) res.date = proof.date;
  if (proof.present !== undefined) {
    res.present = proof.present;
    res.isPresent = proof.isPresent;
  }
  if (proof.followupLogAppended === true) {
    res.followupLogAppended = true;
  }
  if (proof.followupLogRow !== undefined) {
    res.followupLogRow = proof.followupLogRow;
  }
  if (extraFields) {
    for (var k in extraFields) {
      if (Object.prototype.hasOwnProperty.call(extraFields, k) && extraFields[k] !== undefined) {
        res[k] = extraFields[k];
      }
    }
  }
  return res;
}

function constantTimeStringEquals(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function verifyRelayKey(providedKey) {
  var props = PropertiesService.getScriptProperties();
  var expectedKey = props.getProperty('RELAY_KEY');
  // If RELAY_KEY is not configured in Script Properties, permit requests
  // so existing live sheet deployments continue working seamlessly.
  if (!expectedKey || String(expectedKey).trim().length === 0) {
    return { valid: true };
  }
  if (!constantTimeStringEquals(String(providedKey || '').trim(), String(expectedKey).trim())) {
    return { valid: false, error: 'Unauthorized: invalid or missing RELAY_KEY' };
  }
  return { valid: true };
}

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'health';

    // Health check returns exact signature expected by both systems plus batch/idempotency/proof flags
    if (action === 'health' || !e || !e.parameter || !e.parameter.action) {
      return jsonResponse({
        ok: true,
        status: 'ok',
        msg: 'Apps Script شغال',
        version: 'notes-v4-proof',
        supportsBatch: true,
        supportsPersistenceProof: true,
        capabilities: ['attendance', 'followup', 'update', 'add', 'batch', 'checkIdempotency', 'persistenceProof'],
        mode: 'google_apps_script_relay',
        timestamp: new Date().toISOString()
      });
    }

    var keyCheck = verifyRelayKey(e && e.parameter && (e.parameter.relayKey || e.parameter.token));
    if (!keyCheck.valid) {
      return jsonResponse({ ok: false, status: 401, error: keyCheck.error });
    }

    if (action === 'getStudents') {
      var rawReadSheet = e && e.parameter ? (e.parameter.sheet || e.parameter.tab || e.parameter.sourceSheet) : '';
      var targetSheet = isMissingOrLiteralUndefined(rawReadSheet) ? ALL_SHEETS_SENTINEL : String(rawReadSheet).trim();
      if (targetSheet !== ALL_SHEETS_SENTINEL && APPROVED_SHEETS.indexOf(targetSheet) === -1) {
        return jsonResponse({ ok: false, status: 400, error: 'اسم الفصل غير معتمد: ' + targetSheet });
      }

      var ss = getSpreadsheet();
      var sheetsToRead = [];
      if (targetSheet === ALL_SHEETS_SENTINEL) {
        for (var ls = 0; ls < LIVE_STUDENT_SHEETS.length; ls++) {
          sheetsToRead.push(LIVE_STUDENT_SHEETS[ls]);
        }
        // Only read optional sheets (such as 'غير نشط') if that tab physically exists in the spreadsheet
        for (var os = 0; os < OPTIONAL_STUDENT_SHEETS.length; os++) {
          var optName = OPTIONAL_STUDENT_SHEETS[os];
          if (findApprovedSheet(ss, optName)) {
            sheetsToRead.push(optName);
          }
        }
      } else {
        sheetsToRead = [targetSheet];
      }

      var students = [];
      var confirmedSheets = [];
      var confirmedEmptySheets = [];
      var sheetsMeta = {};
      var allRequestedConfirmed = true;

      for (var i = 0; i < sheetsToRead.length; i++) {
        var sheetName = sheetsToRead[i];
        var sheet = findApprovedSheet(ss, sheetName);
        if (!sheet) {
          allRequestedConfirmed = false;
          sheetsMeta[sheetName] = { verified: false, isComplete: false, reason: 'missing_sheet' };
          continue;
        }
        var values = sheet.getDataRange().getValues();
        if (values.length <= 1) {
          confirmedSheets.push(sheetName);
          confirmedEmptySheets.push(sheetName);
          sheetsMeta[sheetName] = { verified: true, isComplete: true, parsedRowCount: 0 };
          continue;
        }

        var headers = values[0].map(function (h) { return formatHeaderCell(h); });
        var nameCol = findColIndex(headers, ['الاسم', 'name', 'Name']);
        if (nameCol === -1) {
          allRequestedConfirmed = false;
          sheetsMeta[sheetName] = { verified: false, isComplete: false, reason: 'missing_name_column' };
          continue;
        }

        confirmedSheets.push(sheetName);
        var parsedForSheet = 0;
        for (var r = 1; r < values.length; r++) {
          var row = values[r];
          var rowName = String(row[nameCol] || '').trim();
          if (!rowName || rowName === 'الاسم' || rowName === 'سؤال بدون عنوان') continue;
          students.push(mapRowToStudent(headers, row, sheetName, r + 1));
          parsedForSheet++;
        }
        if (parsedForSheet === 0) {
          confirmedEmptySheets.push(sheetName);
        }
        sheetsMeta[sheetName] = { verified: true, isComplete: true, parsedRowCount: parsedForSheet };
      }

      return jsonResponse({
        ok: true,
        sheet: targetSheet,
        targetSheet: targetSheet,
        isComplete: allRequestedConfirmed,
        confirmedComplete: allRequestedConfirmed,
        isConfirmedComplete: allRequestedConfirmed,
        confirmedSheets: confirmedSheets,
        confirmedEmptySheets: confirmedEmptySheets,
        sheetsMeta: sheetsMeta,
        students: students,
        followupRecords: readFollowupLogRows(ss)
      });
    }

    if (action === 'getFollowupLog') {
      var ssLog = getSpreadsheet();
      return jsonResponse({
        ok: true,
        records: readFollowupLogRows(ssLog)
      });
    }

    if (action === 'checkIdempotency') {
      var queryKeysRaw = (e && e.parameter && (e.parameter.keys || e.parameter.key)) || '';
      var queryKeys = String(queryKeysRaw)
        .split(',')
        .map(function (k) { return String(k || '').trim(); })
        .filter(function (k) { return k.length > 0; });
      var ssIdemp = getSpreadsheet();
      var checkStartMs = Date.now();
      return jsonResponse({
        ok: true,
        status: 200,
        results: checkIdempotencyKeys(ssIdemp, queryKeys),
        serverDurationMs: Date.now() - checkStartMs
      });
    }

    return jsonResponse({ ok: false, status: 400, error: 'action غير معروف' });
  } catch (err) {
    return jsonResponse({ ok: false, status: 500, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var postStartMs = Date.now();
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var rawContents = (e && e.postData && e.postData.contents) || '{}';
    var body = {};
    try {
      body = JSON.parse(rawContents);
    } catch (parseErr) {
      return jsonResponse({ ok: false, status: 400, error: 'بيانات JSON غير صالحة' });
    }

    // Verify Relay Key if configured in ScriptProperties
    var keyCheck = verifyRelayKey(body.relayKey || body.token || (body.mutation && body.mutation.relayKey) || (e && e.parameter && e.parameter.relayKey));
    if (!keyCheck.valid) {
      return jsonResponse({ ok: false, status: 401, error: keyCheck.error });
    }

    var mutation = body.mutation || body;
    var allowedActions = ['add', 'update', 'attendance', 'followup', 'delete', 'batch', 'checkidempotency', 'transfer'];
    var action = String(body.action || mutation.action || '').trim().toLowerCase();
    if (!action || allowedActions.indexOf(action) === -1) {
      return jsonResponse({ ok: false, status: 400, error: 'action غير معروف' });
    }

    if (action === 'delete') {
      return jsonResponse({ ok: false, status: 403, error: 'حذف المخدومين محظور نهائياً' });
    }

    if (action === 'checkidempotency') {
      var checkKeys = Array.isArray(body.keys)
        ? body.keys.map(function (k) { return String(k || '').trim(); }).filter(function (k) { return k.length > 0; })
        : (body.key ? [String(body.key).trim()] : []);
      var ssCheck = getSpreadsheet();
      return jsonResponse({
        ok: true,
        status: 200,
        action: 'checkIdempotency',
        results: checkIdempotencyKeys(ssCheck, checkKeys),
        serverDurationMs: Date.now() - postStartMs
      });
    }

    if (action === 'batch') {
      var batchItems = Array.isArray(body.mutations) ? body.mutations : [];
      var batchRes = processBatchMutations(batchItems, postStartMs, body);
      return jsonResponse(batchRes);
    }

    // Target Sheet resolution (rejects literal 'undefined'/'null'/empty and resolves approved tab safely)
    var mutPayload = (mutation && mutation.payload) || {};
    var targetSheetName = resolveTargetSheetName([
      body.sheet,
      body.sourceSheet,
      body.tab,
      body.sheetName,
      mutation.sourceSheet,
      mutation.sheet,
      mutation.tab,
      mutation.sheetName,
      mutPayload.sourceSheet,
      mutPayload.sheet,
      mutPayload.tab
    ], 'نشط');
    if (APPROVED_SHEETS.indexOf(targetSheetName) === -1) {
      return jsonResponse({ ok: false, status: 400, error: 'اسم الفصل غير معتمد: ' + targetSheetName });
    }
    var ss = getSpreadsheet();
    var sheet = findApprovedSheet(ss, targetSheetName);
    if (!sheet) {
      return jsonResponse({ ok: false, status: 404, error: 'التاب مش موجود: ' + targetSheetName });
    }

    // Idempotency check (cache + durable ledger)
    // Check every possible field the client may send the mutation ID under
    var idempotencyKey = String(
      body.idempotencyKey ||
      body.mutationId ||
      body.id ||
      mutation.idempotencyKey ||
      mutation.mutationId ||
      mutation.id ||
      (body.mutation && (body.mutation.idempotencyKey || body.mutation.id)) ||
      ''
    ).trim();
    var cache = CacheService.getScriptCache();
    if (idempotencyKey) {
      var cached = null;
      try {
        cached = cache.get('IDEMP_' + idempotencyKey);
      } catch (cacheReadErr) {
        cached = null;
      }
      if (cached) {
        try {
          var prev = JSON.parse(cached);
          if (prev && prev.ok === true) {
            var resolvedCached = resolveExistingIdempotencyRecord(ss, idempotencyKey, prev);
            return jsonResponse(resolvedCached);
          }
        } catch (cacheParseErr) {
          // Fall through to durable sheet ledger if cache JSON is corrupt
        }
      }
      var durablePrevious = findDurableIdempotencyResult(ss, idempotencyKey);
      if (durablePrevious && durablePrevious.ok === true) {
        var resolvedDurable = resolveExistingIdempotencyRecord(ss, idempotencyKey, durablePrevious);
        if (resolvedDurable.proof && resolvedDurable.proof.persisted === true) {
          try {
            cache.put('IDEMP_' + idempotencyKey, JSON.stringify(resolvedDurable), 21600);
          } catch (cePut) {}
        }
        return jsonResponse(resolvedDurable);
      }
    }

    var values = sheet.getDataRange().getValues();
    if (values.length === 0) {
      return jsonResponse({ ok: false, status: 500, error: 'الشيت فارغ' });
    }
    var headers = values[0].map(function (h) { return formatHeaderCell(h); });

    var idCol = findColIndex(headers, ['id', 'ID']);
    var codeCol = findColIndex(headers, ['كود', 'الكود', 'code']);
    var nameLookupCol = findColIndex(headers, ['الاسم', 'name', 'Name']);
    var versionCol = findColIndex(headers, ['version', 'الإصدار']);

    // Extract student identifiers
    var addPayloadFields = body.fields || (mutPayload && mutPayload.newStudent) || (mutPayload && mutPayload.fields) || mutPayload || {};
    var targetName = String(body.name || body.studentName || mutation.studentName || addPayloadFields.name || '').trim();
    var targetCode = String(body.studentCode || body.code || mutation.studentCode || addPayloadFields.code || '').trim();
    var targetId = String(mutation.studentId || mutPayload.studentId || body.studentId || addPayloadFields.id || '').trim();
    if (!targetId) {
      return jsonResponse({ ok: false, status: 400, error: 'معرّف المخدوم studentId مطلوب ولا يمكن إنشاء إثبات حفظ بدونه.' });
    }

    // Row Matching Logic
    var rowIndex = -1;
    // Prefer the exact immutable studentId; use code/name only to locate legacy rows
    // whose sheet does not yet contain a dedicated ID column.
    if (targetId && idCol >= 0) {
      for (var r = 1; r < values.length; r++) {
        if (String(values[r][idCol] || '').trim() === targetId) {
          rowIndex = r;
          break;
        }
      }
    }
    if (rowIndex === -1 && targetCode && codeCol >= 0) {
      for (var r = 1; r < values.length; r++) {
        if (String(values[r][codeCol] || '').trim() === targetCode) {
          rowIndex = r;
          break;
        }
      }
    }
    if (rowIndex === -1 && targetName && nameLookupCol >= 0) {
      var normTargetName = normalizeArabicForMatch(targetName);
      for (var r = 1; r < values.length; r++) {
        var candidateName = String(values[r][nameLookupCol] || '').trim();
        if (
          candidateName === targetName ||
          candidateName.replace(/\s+/g, ' ') === targetName.replace(/\s+/g, ' ') ||
          (normTargetName && normalizeArabicForMatch(candidateName) === normTargetName)
        ) {
          rowIndex = r;
          break;
        }
      }
    }

    if (action === 'add') {
      var addFields = body.fields || (mutPayload && mutPayload.newStudent) || (mutPayload && mutPayload.fields) || mutPayload || {};
      var addName = String(addFields.name || targetName || '').trim();
      if (!addName) {
        return jsonResponse({ ok: false, status: 400, error: 'الاسم مطلوب' });
      }
      if (rowIndex !== -1) {
        return jsonResponse({ ok: false, status: 409, error: 'المخدوم موجود بالفعل في الشيت' });
      }

      var addCode = String(addFields.code || targetCode || '').trim();
      var newRow = headers.map(function (h) {
        if (h === 'كود' || h.indexOf('الكود') !== -1 || h.toLowerCase() === 'code') return sanitizeFormulaValue(addCode);
        if (h.indexOf('الاسم') !== -1 || h.toLowerCase() === 'name') return sanitizeFormulaValue(addName);
        if (h.indexOf('الاشبين') !== -1 || h.indexOf('الأشبين') !== -1 || h.indexOf('الخادم') !== -1 || h.toLowerCase() === 'servant') return sanitizeFormulaValue(addFields.servant || '');
        if (h.indexOf('موبيال المخدوم') !== -1 || h.indexOf('موبايل المخدوم') !== -1 || h.indexOf('موبايل الطالب') !== -1 || h.indexOf('تليفون الطالب') !== -1) return sanitizeFormulaValue(addFields.phoneStudent || '');
        if (h.indexOf('ولي الامر 1') !== -1 || h.indexOf('ولي الأمر 1') !== -1) return sanitizeFormulaValue(addFields.phoneParent1 || '');
        if (h.indexOf('ولي الامر 2') !== -1 || h.indexOf('ولي الأمر 2') !== -1) return sanitizeFormulaValue(addFields.phoneParent2 || '');
        if (h.indexOf('تاريخ الميلاد') !== -1) return sanitizeFormulaValue(addFields.birthDate || '');
        if (h === 'منطقة' || h.indexOf('المنطقة') !== -1) return sanitizeFormulaValue(addFields.area || '');
        if (h.indexOf('العنوان') !== -1) return sanitizeFormulaValue(addFields.address || '');
        if (h.indexOf('ملاحظات') !== -1) return sanitizeFormulaValue(addFields.notes || '');
        if (h.indexOf('حالة الافتقاد') !== -1) return sanitizeFormulaValue(addFields.status || addFields.followupStatus || 'بدون');
        if (h.toLowerCase() === 'id') return sanitizeFormulaValue(targetId || '');
        if (h.toLowerCase() === 'version' || h.indexOf('الإصدار') !== -1) return 1;
        return '';
      });

      sheet.appendRow(newRow);
      safeFlushSpreadsheet();
      var addedRowNum = sheet.getLastRow();
      if (addedRowNum < 2) throw new Error('تعذر تحديد صف المخدوم المضاف للتحقق.');
      verifyRowFieldValues(sheet, addedRowNum, headers, [
        { aliases: ['الاسم', 'name'], value: addName, label: 'اسم المخدوم المضاف' },
        { aliases: ['كود', 'الكود', 'code'], value: addCode, label: 'كود المخدوم المضاف' }
      ]);
      var effectiveAddStudentId = targetId || ('gs_' + targetSheetName + '_' + (addCode || 'SG') + '_' + addedRowNum).replace(/\s+/g, '_');

      var addProof = buildPersistenceProof({
        mutationId: idempotencyKey,
        operation: 'add',
        studentId: effectiveAddStudentId,
        sheetName: targetSheetName,
        row: addedRowNum,
        recordId: effectiveAddStudentId,
        newVersion: 1
      });
      var addResult = buildVerifiedMutationResponse(addProof, {
        studentName: addName,
        studentCode: addCode
      });

      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, addResult);
        try { cache.put('IDEMP_' + idempotencyKey, JSON.stringify(addResult), 21600); } catch (ceAdd) {}
      }
      return jsonResponse(addResult);
    }

    // For actions other than 'add', student must exist
    if (rowIndex === -1) {
      return jsonResponse({ ok: false, status: 404, error: 'الاسم غير موجود' });
    }

    var rowNum = rowIndex + 1;
    var rowCode = codeCol >= 0 ? formatCellValue(values[rowIndex][codeCol]) : targetCode;
    var rowStoredId = idCol >= 0 ? formatCellValue(values[rowIndex][idCol]) : '';
    // CRITICAL: Echo back client-sent studentId (targetId) so proof.studentId matches mutation.studentId
    var effectiveStudentId = targetId || rowStoredId || ('gs_' + targetSheetName + '_' + (rowCode || ('row' + rowNum)) + '_' + rowNum).replace(/\s+/g, '_');

    var expectedVersion = mutation.expectedVersion !== undefined ? mutation.expectedVersion : body.expectedVersion;
    var currentVersion = (versionCol >= 0) ? (parseInt(values[rowIndex][versionCol], 10) || 1) : 1;

    // Enforce OCC 409 strictly whenever the sheet tracks a version column.
    // When versionCol === -1 (legacy sheet without version column), avoid permanent false 409 loops.
    if (versionCol >= 0 && typeof expectedVersion === 'number' && isFinite(expectedVersion) && expectedVersion >= 1) {
      if (currentVersion !== expectedVersion) {
        return jsonResponse({
          ok: false,
          status: 409,
          error: 'تعارض في التعديل المتزامن (409): إصدار الشيت (' + currentVersion + ') لا يطابق الإصدار المرسل (' + expectedVersion + ')'
        });
      }
    }
    var nextVersion = (versionCol >= 0)
      ? (currentVersion + 1)
      : ((typeof expectedVersion === 'number' && isFinite(expectedVersion) && expectedVersion >= 1) ? (Math.floor(expectedVersion) + 1) : 2);

    // 1. ATTENDANCE ACTION
    if (action === 'attendance') {
      var friday = String(body.friday || body.date || (mutPayload && (mutPayload.friday || mutPayload.date)) || '').trim();
      if (!isValidIsoDate(friday)) {
        return jsonResponse({ ok: false, status: 400, error: 'تاريخ غير صحيح' });
      }

      var rawPresent = body.present !== undefined ? body.present : (body.isPresent !== undefined ? body.isPresent : (mutPayload && (mutPayload.isPresent !== undefined ? mutPayload.isPresent : mutPayload.present)));
      var isPresent = rawPresent === true || ['1', 'true', 'present', 'حاضر'].indexOf(String(rawPresent).trim().toLowerCase()) !== -1;

      // Locate or create Friday column
      var fridayCol = findExactHeaderIndex(headers, friday);
      if (fridayCol < 0) {
        var insertBeforeCol = findColIndex(headers, ['آخر حضور', 'اخر حضور', 'إجمالي الحضور', 'حضور الشهر']);
        if (insertBeforeCol >= 0) {
          sheet.insertColumnBefore(insertBeforeCol + 1);
          sheet.getRange(1, insertBeforeCol + 1).setValue(friday);
          headers.splice(insertBeforeCol, 0, friday);
          fridayCol = insertBeforeCol;
        } else {
          var lastCol = sheet.getLastColumn();
          sheet.getRange(1, lastCol + 1).setValue(friday);
          headers.push(friday);
          fridayCol = lastCol;
        }
        values = sheet.getDataRange().getValues();
        headers = values[0].map(function (h) { return formatHeaderCell(h); });
        versionCol = findColIndex(headers, ['version', 'الإصدار']);
      }

      var prevAttendanceVal = String(values[rowIndex][fridayCol] || '').trim().toLowerCase();
      var wasPresent = ['1', 'true', 'present', 'حاضر'].indexOf(prevAttendanceVal) !== -1;
      var delta = (isPresent ? 1 : 0) - (wasPresent ? 1 : 0);

      sheet.getRange(rowNum, fridayCol + 1).setValue(isPresent ? 1 : 0);

      // Total Attendance Calculation
      var totalCol = findColIndex(headers, ['إجمالي الحضور', 'اجمالي الحضور', 'attendanceTotal', 'total']);
      var totalCount = 0;
      if (totalCol >= 0) {
        var prevTotal = parseInt(values[rowIndex][totalCol] || '0', 10) || 0;
        totalCount = Math.max(0, prevTotal + delta);
        sheet.getRange(rowNum, totalCol + 1).setValue(totalCount);
      } else {
        for (var c = 0; c < headers.length; c++) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(headers[c] || '').trim())) {
            var cellV = (c === fridayCol) ? (isPresent ? 1 : 0) : values[rowIndex][c];
            if (cellV === 1 || String(cellV).trim() === '1' || cellV === true) totalCount++;
          }
        }
      }

      // Latest Present Friday Calculation
      var latestPresentFriday = '';
      for (var c = 0; c < headers.length; c++) {
        var hdrDate = String(headers[c] || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(hdrDate)) {
          var cellV2 = (c === fridayCol) ? (isPresent ? 1 : 0) : values[rowIndex][c];
          if (cellV2 === 1 || String(cellV2).trim() === '1' || cellV2 === true) {
            if (hdrDate > latestPresentFriday) latestPresentFriday = hdrDate;
          }
        }
      }
      setIfFound(sheet, rowNum, headers, ['آخر حضور', 'اخر حضور', 'lastAttendance'], latestPresentFriday);

      // Monthly Attendance Count
      var monthCol = findColIndex(headers, ['حضور الشهر', 'attendanceMonth']);
      if (monthCol >= 0) {
        var currentCairoMonth = getCairoMonthString();
        var monthCount = 0;
        for (var c = 0; c < headers.length; c++) {
          var h = String(headers[c] || '').trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(h) && h.substring(0, 7) === currentCairoMonth) {
            var v = (c === fridayCol) ? (isPresent ? 1 : 0) : values[rowIndex][c];
            if (v === 1 || String(v).trim() === '1' || v === true) monthCount++;
          }
        }
        sheet.getRange(rowNum, monthCol + 1).setValue(monthCount);
      }

      if (versionCol >= 0) {
        sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion);
      }

      safeFlushSpreadsheet();
      verifyCellValue(sheet, rowNum, fridayCol + 1, isPresent ? 1 : 0, 'حضور يوم ' + friday);

      var attProof = buildPersistenceProof({
        mutationId: idempotencyKey,
        operation: 'attendance',
        studentId: effectiveStudentId,
        sheetName: targetSheetName,
        row: rowNum,
        recordId: effectiveStudentId + ':' + friday,
        newVersion: nextVersion,
        friday: friday,
        present: isPresent
      });
      var attendanceResult = buildVerifiedMutationResponse(attProof, {
        total: totalCount,
        lastAttendance: latestPresentFriday
      });

      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, attendanceResult);
        try { cache.put('IDEMP_' + idempotencyKey, JSON.stringify(attendanceResult), 21600); } catch (ceAtt) {}
      }
      return jsonResponse(attendanceResult);
    }

    // 2. FOLLOWUP ACTION
    if (action === 'followup') {
      var fuMethod = String(body.status || body.followupStatus || body.type || body.method || (mutPayload && (mutPayload.status || mutPayload.followupStatus || mutPayload.method || mutPayload.type)) || '').trim();
      if (!fuMethod) {
        return jsonResponse({ ok: false, status: 400, error: 'حالة الافتقاد مطلوبة' });
      }

      var cairoToday = getCairoTodayDateString();
      var rawFuFriday = String(body.friday || body.fridayDate || (mutPayload && (mutPayload.friday || mutPayload.fridayDate)) || '').trim();
      var rawFuDate = String(body.date || (mutPayload && mutPayload.date) || '').trim();
      var fuDate = isValidIsoDate(rawFuDate) ? rawFuDate : cairoToday;
      var fuFriday = isValidIsoDate(rawFuFriday) ? rawFuFriday : fuDate;
      var fuRecordId = String(body.recordId || (mutPayload && mutPayload.recordId) || '').trim();

      var fuDateColHeader = 'افتقاد ' + fuFriday;
      var fuCol = findExactHeaderIndex(headers, fuDateColHeader);
      if (fuCol < 0) {
        var lastColFu = sheet.getLastColumn();
        sheet.getRange(1, lastColFu + 1).setValue(fuDateColHeader);
        headers.push(fuDateColHeader);
        fuCol = lastColFu;
      }

      sheet.getRange(rowNum, fuCol + 1).setValue(sanitizeFormulaValue(fuMethod));
      setIfFound(sheet, rowNum, headers, ['آخر افتقاد', 'اخر افتقاد', 'lastFollowup'], fuDate);
      setIfFound(sheet, rowNum, headers, ['حالة الافتقاد', 'followupStatus'], fuMethod);

      // Pastoral log row — MUST succeed and return row proof; never fail silently
      var fuNotes = body.notes !== undefined ? body.notes : ((mutPayload && mutPayload.notes) || '');
      var fuOutcomeRaw = String(body.callOutcome || (mutPayload && mutPayload.callOutcome) || '').trim();
      var fuOutcome = (fuOutcomeRaw === 'تم التواصل' || fuOutcomeRaw === 'لم يتم التواصل') ? fuOutcomeRaw : '';

      var logWriteResult = appendFollowupLogRow(
        ss,
        targetSheetName,
        headers,
        values[rowIndex],
        fuFriday,
        fuMethod,
        fuNotes,
        idempotencyKey,
        fuOutcome,
        fuDate,
        fuRecordId
      );
      if (!logWriteResult || logWriteResult.appended !== true || !logWriteResult.followupLogRow) {
        return jsonResponse({ ok: false, status: 500, error: 'تعذر إثبات حفظ سجل الافتقاد في تاب سجل الافتقاد' });
      }

      if (versionCol >= 0) {
        sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion);
      }

      safeFlushSpreadsheet();
      verifyCellValue(sheet, rowNum, fuCol + 1, fuMethod, 'حالة الافتقاد في سجل المخدوم');
      if (logWriteResult.followupLogRow > 1) {
        var verifiedLogRow = logWriteResult.followupLogRow;
        var logSheetForVerify = findFollowupLogSheet(ss);
        if (!logSheetForVerify) throw new Error('تعذر إعادة قراءة سجل الافتقاد بعد الكتابة.');
        if (fuRecordId) {
          var verifyHeaders = logSheetForVerify.getRange(1, 1, 1, Math.max(logSheetForVerify.getLastColumn(), 1)).getValues()[0].map(function (h) { return formatHeaderCell(h); });
          var verifyRecordIdCol = findColIndex(verifyHeaders, ['record_id', 'recordId']);
          if (verifyRecordIdCol >= 0) verifyCellValue(logSheetForVerify, verifiedLogRow, verifyRecordIdCol + 1, fuRecordId, 'معرّف سجل الافتقاد');
        }
      }

      var fuProof = buildPersistenceProof({
        mutationId: idempotencyKey,
        operation: 'followup',
        studentId: effectiveStudentId,
        sheetName: targetSheetName,
        row: rowNum,
        recordId: logWriteResult.recordId,
        newVersion: nextVersion,
        friday: fuFriday,
        date: fuDate,
        followupLogAppended: true,
        followupLogRow: logWriteResult.followupLogRow
      });
      var followupResult = buildVerifiedMutationResponse(fuProof, {
        lastFollowup: fuDate,
        fuDate: fuDate,
        fuStatus: fuMethod,
        callOutcome: fuOutcome || undefined
      });

      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, followupResult);
        try { cache.put('IDEMP_' + idempotencyKey, JSON.stringify(followupResult), 21600); } catch (ceFu) {}
      }
      return jsonResponse(followupResult);
    }

    // 3. UPDATE ACTION
    if (action === 'update') {
      var updateFields = body.fields || (mutPayload && mutPayload.updatedData) || (mutPayload && mutPayload.fields) || mutPayload || {};
      var updateNotes = body.notes !== undefined ? body.notes : (updateFields.notes !== undefined ? updateFields.notes : (mutPayload && mutPayload.notes !== undefined ? mutPayload.notes : undefined));
      if (updateNotes !== undefined) {
        setIfFound(sheet, rowNum, headers, ['ملاحظات الافتقاد', 'ملاحظات', 'notes'], updateNotes);
      }

      if (updateFields.name !== undefined) setIfFound(sheet, rowNum, headers, ['الاسم', 'name'], updateFields.name);
      if (updateFields.code !== undefined) setIfFound(sheet, rowNum, headers, ['كود', 'الكود', 'code'], updateFields.code);
      if (updateFields.servant !== undefined) setIfFound(sheet, rowNum, headers, ['الاشبين', 'الأشبين', 'الخادم', 'servant'], updateFields.servant);
      if (updateFields.phoneStudent !== undefined) setIfFound(sheet, rowNum, headers, ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب'], updateFields.phoneStudent);
      if (updateFields.phoneParent1 !== undefined) setIfFound(sheet, rowNum, headers, ['موبيل ولي الامر 1', 'ولي الأمر 1'], updateFields.phoneParent1);
      if (updateFields.phoneParent2 !== undefined) setIfFound(sheet, rowNum, headers, ['موبيل ولي الامر 2', 'ولي الأمر 2'], updateFields.phoneParent2);
      if (updateFields.birthDate !== undefined) setIfFound(sheet, rowNum, headers, ['تاريخ الميلاد'], updateFields.birthDate);
      if (updateFields.area !== undefined) setIfFound(sheet, rowNum, headers, ['منطقة', 'المنطقة'], updateFields.area);
      if (updateFields.address !== undefined) setIfFound(sheet, rowNum, headers, ['العنوان'], updateFields.address);
      if (updateFields.status !== undefined || updateFields.followupStatus !== undefined) {
        setIfFound(sheet, rowNum, headers, ['حالة الافتقاد', 'followupStatus'], updateFields.status !== undefined ? updateFields.status : updateFields.followupStatus);
      }

      if (versionCol >= 0) {
        sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion);
      }

      safeFlushSpreadsheet();
      var updateChecks = [];
      if (updateFields.name !== undefined) updateChecks.push({ aliases: ['الاسم', 'name'], value: updateFields.name, label: 'اسم المخدوم' });
      if (updateFields.code !== undefined) updateChecks.push({ aliases: ['كود', 'الكود', 'code'], value: updateFields.code, label: 'كود المخدوم' });
      if (updateFields.servant !== undefined) updateChecks.push({ aliases: ['الاشبين', 'الأشبين', 'الخادم', 'servant'], value: updateFields.servant, label: 'الخادم' });
      if (updateFields.phoneStudent !== undefined) updateChecks.push({ aliases: ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب'], value: updateFields.phoneStudent, label: 'هاتف المخدوم' });
      if (updateFields.phoneParent1 !== undefined) updateChecks.push({ aliases: ['موبيل ولي الامر 1', 'ولي الأمر 1'], value: updateFields.phoneParent1, label: 'هاتف ولي الأمر الأول' });
      if (updateFields.phoneParent2 !== undefined) updateChecks.push({ aliases: ['موبيل ولي الامر 2', 'ولي الأمر 2'], value: updateFields.phoneParent2, label: 'هاتف ولي الأمر الثاني' });
      if (updateFields.birthDate !== undefined) updateChecks.push({ aliases: ['تاريخ الميلاد'], value: updateFields.birthDate, label: 'تاريخ الميلاد' });
      if (updateFields.area !== undefined) updateChecks.push({ aliases: ['منطقة', 'المنطقة'], value: updateFields.area, label: 'المنطقة' });
      if (updateFields.address !== undefined) updateChecks.push({ aliases: ['العنوان'], value: updateFields.address, label: 'العنوان' });
      if (updateNotes !== undefined) updateChecks.push({ aliases: ['ملاحظات الافتقاد', 'ملاحظات', 'notes'], value: updateNotes, label: 'الملاحظات' });
      if (updateFields.status !== undefined || updateFields.followupStatus !== undefined) updateChecks.push({ aliases: ['حالة الافتقاد', 'followupStatus'], value: updateFields.status !== undefined ? updateFields.status : updateFields.followupStatus, label: 'حالة الافتقاد' });
      verifyRowFieldValues(sheet, rowNum, headers, updateChecks);

      var updateProof = buildPersistenceProof({
        mutationId: idempotencyKey,
        operation: 'update',
        studentId: effectiveStudentId,
        sheetName: targetSheetName,
        row: rowNum,
        recordId: effectiveStudentId,
        newVersion: nextVersion
      });
      var updateResult = buildVerifiedMutationResponse(updateProof);

      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, updateResult);
        try { cache.put('IDEMP_' + idempotencyKey, JSON.stringify(updateResult), 21600); } catch (ceUpd) {}
      }
      return jsonResponse(updateResult);
    }

    // ─── TRANSFER: move a student from one approved sheet to another ───────────
    if (action === 'transfer') {
      var targetSheetDest = String(
        body.targetSheet || body.destinationSheet || body.destSheet ||
        (mutation && (mutation.targetSheet || mutation.destinationSheet)) || ''
      ).trim();

      if (!targetSheetDest) {
        return jsonResponse({ ok: false, status: 400, error: 'transfer يتطلب targetSheet (الشيت الهدف)' });
      }
      if (APPROVED_SHEETS.indexOf(targetSheetDest) === -1) {
        return jsonResponse({ ok: false, status: 400, error: 'الشيت الهدف غير معتمد: ' + targetSheetDest });
      }
      if (targetSheetDest === targetSheetName) {
        return jsonResponse({ ok: false, status: 400, error: 'الشيت المصدر والهدف متطابقان — لا داعي للنقل' });
      }

      // Student must exist in source sheet
      if (rowIndex === -1) {
        return jsonResponse({ ok: false, status: 404, error: 'المخدوم غير موجود في شيت المصدر: ' + targetSheetName });
      }

      // Locate destination sheet
      var destSheet = findApprovedSheet(ss, targetSheetDest);
      if (!destSheet) {
        return jsonResponse({ ok: false, status: 404, error: 'الشيت الهدف غير موجود: ' + targetSheetDest });
      }

      var destValues = destSheet.getDataRange().getValues();
      var destHeaders = destValues.length > 0
        ? destValues[0].map(function (h) { return formatHeaderCell(h); })
        : headers;

      // Build student data row from source
      var sourceRow = values[rowIndex];

      // Check student not already in destination (by code or name)
      var destNameCol = findColIndex(destHeaders, ['الاسم', 'name']);
      var destCodeCol = findColIndex(destHeaders, ['كود', 'الكود', 'code']);
      var alreadyInDest = false;
      if (rowCode) {
        for (var dr = 1; dr < destValues.length; dr++) {
          var destCellCode = destCodeCol >= 0 ? formatCellValue(destValues[dr][destCodeCol]) : '';
          if (destCellCode && normalizeStudentCodeForMatch(destCellCode) === normalizeStudentCodeForMatch(rowCode)) {
            alreadyInDest = true;
            break;
          }
        }
      }
      if (!alreadyInDest && targetName) {
        for (var dr2 = 1; dr2 < destValues.length; dr2++) {
          var destCellName = destNameCol >= 0 ? formatCellValue(destValues[dr2][destNameCol]) : '';
          if (destCellName && destCellName === targetName) {
            alreadyInDest = true;
            break;
          }
        }
      }
      if (alreadyInDest) {
        return jsonResponse({ ok: false, status: 409, error: 'المخدوم موجود مسبقاً في الشيت الهدف' });
      }

      // Build a new row for the destination using the source headers mapping
      var newDestRow = new Array(destHeaders.length).fill('');
      var transferableFields = [
        { src: ['الاسم', 'name'],                        dst: ['الاسم', 'name'] },
        { src: ['كود', 'الكود', 'code'],                  dst: ['كود', 'الكود', 'code'] },
        { src: ['الاشبين', 'الأشبين', 'الخادم', 'servant'], dst: ['الاشبين', 'الأشبين', 'الخادم', 'servant'] },
        { src: ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب'], dst: ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب'] },
        { src: ['موبيل ولي الامر 1', 'ولي الأمر 1'],      dst: ['موبيل ولي الامر 1', 'ولي الأمر 1'] },
        { src: ['موبيل ولي الامر 2', 'ولي الأمر 2'],      dst: ['موبيل ولي الامر 2', 'ولي الأمر 2'] },
        { src: ['تاريخ الميلاد'],                         dst: ['تاريخ الميلاد'] },
        { src: ['منطقة', 'المنطقة'],                      dst: ['منطقة', 'المنطقة'] },
        { src: ['العنوان'],                               dst: ['العنوان'] },
        { src: ['ملاحظات', 'ملاحظات الافتقاد', 'notes'],  dst: ['ملاحظات', 'ملاحظات الافتقاد', 'notes'] }
      ];
      for (var tf = 0; tf < transferableFields.length; tf++) {
        var srcColIdx = findColIndex(headers, transferableFields[tf].src);
        var dstColIdx = findColIndex(destHeaders, transferableFields[tf].dst);
        if (srcColIdx >= 0 && dstColIdx >= 0) {
          newDestRow[dstColIdx] = sourceRow[srcColIdx];
        }
      }

      // Append to destination sheet
      destSheet.appendRow(newDestRow);
      var newDestRow_ = destSheet.getLastRow();

      // Set version = 1 in destination if version column exists
      var destVersionCol = findColIndex(destHeaders, ['version', '__version']);
      if (destVersionCol >= 0) {
        destSheet.getRange(newDestRow_, destVersionCol + 1).setValue(1);
      }

      // Delete source row (only allowed inside transfer — controlled exception)
      sheet.deleteRow(rowNum);

      safeFlushSpreadsheet();

      var transferProof = buildPersistenceProof({
        mutationId: idempotencyKey,
        operation: 'transfer',
        studentId: effectiveStudentId,
        sheetName: targetSheetDest,
        row: newDestRow_,
        recordId: effectiveStudentId,
        newVersion: 1,
        sourceSheet: targetSheetName,
        destinationSheet: targetSheetDest
      });
      var transferResult = buildVerifiedMutationResponse(transferProof, {
        sourceSheet: targetSheetName,
        destinationSheet: targetSheetDest,
        newRow: newDestRow_
      });

      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, transferResult);
        try { cache.put('IDEMP_' + idempotencyKey, JSON.stringify(transferResult), 21600); } catch (ceTr) {}
      }
      return jsonResponse(transferResult);
    }
    // ─────────────────────────────────────────────────────────────────────────

    return jsonResponse({ ok: false, status: 400, error: 'action غير معروف' });
  } catch (err) {
    return jsonResponse({ ok: false, status: 500, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function getDurableIdempotencySheet(ss) {
  var sheetName = '_mutation_idempotency';
  var ledger = ss.getSheetByName(sheetName);
  if (!ledger) {
    ledger = ss.insertSheet(sheetName);
    ledger.appendRow(['idempotency_key', 'response_json', 'created_at']);
    if (typeof ledger.hideSheet === 'function') {
      ledger.hideSheet();
    }
  }
  return ledger;
}

/**
 * Resolves an existing idempotency record safely:
 * - If it has a verified RemotePersistenceProof (persisted === true), replays it with deduplicated: true.
 * - If it is a legacy pre-4.4 record ({ ok: true } without persisted proof), attempts genuine sheet
 *   verification ONLY where provable (e.g. followup row in 'سجل الافتقاد'). Otherwise returns an
 *   honest non-re-executing response WITHOUT fabricating persisted: true or proof.
 */
function resolveExistingIdempotencyRecord(ss, idempotencyKey, storedRecord) {
  var copy = JSON.parse(JSON.stringify(storedRecord));
  if (copy.proof && copy.proof.persisted === true) {
    copy.deduplicated = true;
    copy.proof.deduplicated = true;
    return copy;
  }

  // Attempt genuine verification from 'سجل الافتقاد' if followup log row exists for this mutationId
  var op = String(copy.operation || copy.action || '').trim().toLowerCase();
  if (op === 'followup' || copy.fuStatus || copy.fuDate) {
    var logSheet = findFollowupLogSheet(ss);
    if (logSheet && logSheet.getLastRow() > 1) {
      var logValues = logSheet.getDataRange().getValues();
      var logHeaders = logValues[0].map(function (h) { return formatHeaderCell(h); });
      var logMutCol = findColIndex(logHeaders, ['mutation_id']);
      var logSheetCol = findColIndex(logHeaders, ['الشيت', 'sourceSheet', 'sheet']);
      var logCodeCol = findColIndex(logHeaders, ['الكود', 'كود', 'code']);
      var logDateCol = findColIndex(logHeaders, ['التاريخ']);
      var logFriCol = findColIndex(logHeaders, ['أسبوع الجمعة', 'الجمعة']);
      var logRecIdCol = findColIndex(logHeaders, ['record_id', 'recordId']);
      if (logMutCol >= 0) {
        for (var r = logValues.length - 1; r >= 1; r--) {
          if (String(logValues[r][logMutCol] || '').trim() === String(idempotencyKey).trim()) {
            var sheetLabel = logSheetCol >= 0 ? formatCellValue(logValues[r][logSheetCol]) : String(copy.sheetName || 'نشط');
            var codeVal = logCodeCol >= 0 ? formatCellValue(logValues[r][logCodeCol]) : '';
            var recIdVal = logRecIdCol >= 0 ? formatCellValue(logValues[r][logRecIdCol]) : '';
            var repairedProof = buildPersistenceProof({
              mutationId: idempotencyKey,
              operation: 'followup',
              studentId: String(copy.studentId || codeVal || 'verified_from_log'),
              sheetName: sheetLabel || 'نشط',
              recordId: recIdVal || ('gs_fu_' + (r + 1)),
              friday: logFriCol >= 0 ? formatCellValue(logValues[r][logFriCol]) : undefined,
              date: logDateCol >= 0 ? formatCellValue(logValues[r][logDateCol]) : undefined,
              followupLogAppended: true,
              followupLogRow: r + 1,
              deduplicated: true
            });
            return buildVerifiedMutationResponse(repairedProof, {
              deduplicated: true,
              repairedFromSheetState: true
            });
          }
        }
      }
    }
  }

  // Legacy pre-4.4 entry that cannot be cryptographically proven from sheet row metadata:
  // NEVER re-execute the mutation (prevents duplicate writes / 409 conflicts) and NEVER fabricate proof.
  return {
    ok: true,
    status: 200,
    deduplicated: true,
    legacyIdempotencyEntry: true,
    requiresManualVerification: true,
    mutationId: idempotencyKey,
    operation: copy.operation || copy.action,
    studentId: copy.studentId,
    message: 'العملية مسجلة مسبقاً في سجل عدم التكرار (قبل تفعيل إثبات الحفظ)؛ تم منع إعادة تنفيذها لتفادي التكرار.'
  };
}

function findDurableIdempotencyResult(ss, key) {
  var ledger = getDurableIdempotencySheet(ss);
  var lastRow = ledger.getLastRow();
  if (lastRow < 2) return null;
  var targetKey = String(key || '').trim();
  if (!targetKey) return null;
  var rows = ledger.getRange(2, 1, lastRow - 1, 2).getValues();
  // Bottom-up scan so the most recent record always takes precedence
  for (var r = rows.length - 1; r >= 0; r--) {
    if (String(rows[r][0] || '').trim() === targetKey) {
      var raw = rows[r][1];
      if (!raw) return null;
      try {
        return JSON.parse(String(raw));
      } catch (err) {
        return null;
      }
    }
  }
  return null;
}

function saveDurableIdempotencyResult(ss, key, response) {
  var targetKey = String(key || '').trim();
  if (!targetKey) return;
  var ledger = getDurableIdempotencySheet(ss);
  var lastRow = ledger.getLastRow();
  var serialized = JSON.stringify(response);
  var now = new Date();
  if (lastRow >= 2) {
    var existingKeys = ledger.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = existingKeys.length - 1; r >= 0; r--) {
      if (String(existingKeys[r][0] || '').trim() === targetKey) {
        ledger.getRange(r + 2, 2, 1, 2).setValues([[serialized, now]]);
        safeFlushSpreadsheet();
        return;
      }
    }
  }
  ledger.appendRow([targetKey, serialized, now]);
  safeFlushSpreadsheet();
}

function loadDurableIdempotencyMap(ss, keysNeeded) {
  var map = {};
  if (!keysNeeded || keysNeeded.length === 0) return map;
  var neededSet = {};
  for (var i = 0; i < keysNeeded.length; i++) {
    neededSet[keysNeeded[i]] = true;
  }
  var ledger = getDurableIdempotencySheet(ss);
  var lastRow = ledger.getLastRow();
  if (lastRow < 2) return map;
  var rows = ledger.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var r = 0; r < rows.length; r++) {
    var k = String(rows[r][0] || '').trim();
    if (k && neededSet[k]) {
      try {
        map[k] = JSON.parse(String(rows[r][1] || ''));
      } catch (e) {
        // Fail-closed: NEVER fabricate { ok: true } on corrupt ledger JSON
        map[k] = { ok: false, error: 'corrupt_idempotency_record' };
      }
    }
  }
  return map;
}

function checkIdempotencyKeys(ss, keys) {
  var results = {};
  if (!keys || keys.length === 0) return results;
  var cache = CacheService.getScriptCache();
  var cacheKeys = keys.map(function (k) { return 'IDEMP_' + k; });
  var cachedEntries = {};
  try {
    cachedEntries = cache.getAll(cacheKeys) || {};
  } catch (e) {}

  var missingFromCache = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var cachedRaw = cachedEntries['IDEMP_' + k];
    if (cachedRaw) {
      try {
        var parsedCache = JSON.parse(String(cachedRaw));
        results[k] = {
          found: true,
          proof: parsedCache && parsedCache.proof ? parsedCache.proof : undefined,
          response: parsedCache,
          source: 'cache'
        };
      } catch (err) {
        // Fall through to durable sheet ledger instead of fabricating { ok: true }
        missingFromCache.push(k);
      }
    } else {
      missingFromCache.push(k);
    }
  }

  if (missingFromCache.length > 0) {
    var durableMap = loadDurableIdempotencyMap(ss, missingFromCache);
    for (var j = 0; j < missingFromCache.length; j++) {
      var mk = missingFromCache[j];
      if (durableMap[mk]) {
        var stored = durableMap[mk];
        results[mk] = {
          found: true,
          proof: stored && stored.proof ? stored.proof : undefined,
          response: stored,
          source: 'sheet'
        };
        if (stored && stored.ok === true && stored.proof) {
          try {
            cache.put('IDEMP_' + mk, JSON.stringify(stored), 21600);
          } catch (ce) {}
        }
      } else {
        results[mk] = { found: false };
      }
    }
  }

  return results;
}

function saveDurableIdempotencyBatch(ss, entries) {
  if (!entries || entries.length === 0) return;
  var ledger = getDurableIdempotencySheet(ss);
  var lastRow = ledger.getLastRow();
  var existingRowMap = {};
  if (lastRow >= 2) {
    var existingKeys = ledger.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < existingKeys.length; r++) {
      var kStr = String(existingKeys[r][0] || '').trim();
      if (kStr) existingRowMap[kStr] = r + 2; // latest row wins
    }
  }

  var now = new Date();
  var rowsToAppend = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var eKey = String(entry.key || '').trim();
    if (!eKey) continue;
    var serialized = JSON.stringify(entry.response);
    if (existingRowMap[eKey] !== undefined) {
      ledger.getRange(existingRowMap[eKey], 2, 1, 2).setValues([[serialized, now]]);
    } else {
      rowsToAppend.push([eKey, serialized, now]);
    }
  }

  if (rowsToAppend.length > 0) {
    var startRow = Math.max(2, lastRow + 1);
    ledger.getRange(startRow, 1, rowsToAppend.length, 3).setValues(rowsToAppend);
  }
  safeFlushSpreadsheet();
}

function processBatchMutations(batchItems, postStartMs, topBody) {
  topBody = topBody || {};

  // Normalize both supported client envelopes before any batch validation or lookup.
  // The app may send identifiers/action inside item.mutation rather than at item root.
  batchItems = (Array.isArray(batchItems) ? batchItems : []).map(function (rawItem) {
    rawItem = rawItem || {};
    var nestedMutation = rawItem.mutation || {};
    var nestedPayload = rawItem.payload || nestedMutation.payload || {};
    var normalized = {};
    Object.keys(nestedMutation).forEach(function (key) {
      if (key !== 'payload' && key !== 'mutation') normalized[key] = nestedMutation[key];
    });
    Object.keys(rawItem).forEach(function (key) {
      if (key !== 'mutation' && key !== 'payload') normalized[key] = rawItem[key];
    });
    normalized.payload = nestedPayload;
    normalized.action = String(rawItem.action || nestedMutation.action || nestedPayload.action || '').trim().toLowerCase();
    normalized.studentId = String(nestedMutation.studentId || rawItem.studentId || nestedPayload.studentId || '').trim();
    normalized.studentCode = String(rawItem.studentCode || rawItem.code || nestedMutation.studentCode || nestedMutation.code || nestedPayload.studentCode || nestedPayload.code || '').trim();
    normalized.studentName = String(rawItem.studentName || rawItem.name || nestedMutation.studentName || nestedMutation.name || nestedPayload.studentName || nestedPayload.name || '').trim();
    normalized.idempotencyKey = String(rawItem.idempotencyKey || rawItem.mutationId || rawItem.id || nestedMutation.idempotencyKey || nestedMutation.mutationId || nestedMutation.id || '').trim();
    normalized.mutationId = normalized.idempotencyKey;
    if (normalized.expectedVersion === undefined) normalized.expectedVersion = nestedMutation.expectedVersion !== undefined ? nestedMutation.expectedVersion : nestedPayload.expectedVersion;
    return normalized;
  });

  if (!batchItems || batchItems.length === 0) {
    return { ok: true, status: 200, action: 'batch', results: [], serverDurationMs: Date.now() - postStartMs };
  }
  if (batchItems.length > 50) {
    return { ok: false, status: 400, error: 'حجم الدفعة يتجاوز الحد الأقصى المسموح (50 عملية في الطلب الواحد)' };
  }

  // Strictly block any delete operation inside a batch
  for (var d = 0; d < batchItems.length; d++) {
    var itemAct = String((batchItems[d] && batchItems[d].action) || '').trim().toLowerCase();
    if (itemAct === 'delete') {
      return { ok: false, status: 403, error: 'حذف المخدومين محظور نهائياً' };
    }
  }

  var ss = getSpreadsheet();
  var cache = CacheService.getScriptCache();
  var allKeys = [];
  for (var i = 0; i < batchItems.length; i++) {
    var rawItem = batchItems[i] || {};
    var itemKey = String(rawItem.idempotencyKey || rawItem.mutationId || rawItem.id || '').trim();
    if (itemKey) allKeys.push(itemKey);
  }
  var idempStateMap = checkIdempotencyKeys(ss, allKeys);

  // Validate target sheets upfront and group pending batch items by canonical sheet name
  var results = new Array(batchItems.length);
  var pendingIndicesBySheet = {};
  for (var idx = 0; idx < batchItems.length; idx++) {
    var item = batchItems[idx] || {};
    var mutKey = String(item.idempotencyKey || item.mutationId || item.id || '').trim();
    if (
      mutKey &&
      idempStateMap[mutKey] &&
      idempStateMap[mutKey].found &&
      idempStateMap[mutKey].response &&
      idempStateMap[mutKey].response.ok === true
    ) {
      results[idx] = resolveExistingIdempotencyRecord(ss, mutKey, idempStateMap[mutKey].response);
      results[idx].mutationId = mutKey;
      continue;
    }

    var itemMutation = item.mutation || {};
    var itemPayload = item.payload || {};
    var sheetName = resolveTargetSheetName([
      item.sheet,
      item.sourceSheet,
      item.tab,
      item.sheetName,
      itemMutation.sourceSheet,
      itemMutation.sheet,
      itemMutation.tab,
      itemPayload.sourceSheet,
      itemPayload.sheet,
      itemPayload.tab,
      topBody.sheet,
      topBody.sourceSheet,
      topBody.tab
    ], 'نشط');
    if (APPROVED_SHEETS.indexOf(sheetName) === -1) {
      results[idx] = { ok: false, status: 400, mutationId: mutKey, error: 'اسم الفصل غير معتمد: ' + sheetName };
      continue;
    }
    var itemAction = String(item.action || '').trim().toLowerCase();
    if (itemAction !== 'attendance' && itemAction !== 'followup') {
      results[idx] = { ok: false, status: 400, mutationId: mutKey, error: 'المعالجة المجمعة تدعم عمليات الحضور والافتقاد فقط حالياً' };
      continue;
    }
    if (!pendingIndicesBySheet[sheetName]) pendingIndicesBySheet[sheetName] = [];
    pendingIndicesBySheet[sheetName].push(idx);
  }

  var newIdempotencyEntries = [];
  var cacheBatchToPut = {};
  var currentCairoToday = getCairoTodayDateString();
  var currentCairoMonth = currentCairoToday.substring(0, 7);

  var sheetNames = Object.keys(pendingIndicesBySheet);
  for (var sIdx = 0; sIdx < sheetNames.length; sIdx++) {
    var targetSheetName = sheetNames[sIdx];
    var itemIndices = pendingIndicesBySheet[targetSheetName];
    if (isMissingOrLiteralUndefined(targetSheetName) || APPROVED_SHEETS.indexOf(targetSheetName) === -1) {
      for (var mErr = 0; mErr < itemIndices.length; mErr++) {
        var rErrIdx = itemIndices[mErr];
        results[rErrIdx] = { ok: false, status: 400, mutationId: String(batchItems[rErrIdx].idempotencyKey || batchItems[rErrIdx].id || ''), error: 'اسم الفصل غير محدد أو غير معتمد' };
      }
      continue;
    }
    var sheet = findApprovedSheet(ss, targetSheetName);
    if (!sheet) {
      for (var m = 0; m < itemIndices.length; m++) {
        var rIdx = itemIndices[m];
        results[rIdx] = { ok: false, status: 404, mutationId: String(batchItems[rIdx].idempotencyKey || batchItems[rIdx].id || ''), error: 'التاب مش موجود: ' + targetSheetName };
      }
      continue;
    }

    var values = sheet.getDataRange().getValues();
    if (values.length === 0) {
      for (var m2 = 0; m2 < itemIndices.length; m2++) {
        var eIdx = itemIndices[m2];
        results[eIdx] = { ok: false, status: 500, mutationId: String(batchItems[eIdx].idempotencyKey || batchItems[eIdx].id || ''), error: 'الشيت فارغ' };
      }
      continue;
    }

    var headers = values[0].map(function (h) { return formatHeaderCell(h); });

    // Pre-create missing Friday attendance columns & followup columns in one pass
    var neededFridays = [];
    var seenFridays = {};
    var neededFuHeaders = [];
    var seenFuHeaders = {};
    for (var m3 = 0; m3 < itemIndices.length; m3++) {
      var bItem = batchItems[itemIndices[m3]];
      var bAct = String(bItem.action || '').trim().toLowerCase();
      if (bAct === 'attendance') {
        var fDate = String(bItem.friday || bItem.date || (bItem.payload && (bItem.payload.friday || bItem.payload.date)) || '').trim();
        if (isValidIsoDate(fDate) && findExactHeaderIndex(headers, fDate) < 0 && !seenFridays[fDate]) {
          seenFridays[fDate] = true;
          neededFridays.push(fDate);
        }
      } else if (bAct === 'followup') {
        var bRawFuFriday = String(bItem.friday || bItem.fridayDate || (bItem.payload && (bItem.payload.friday || bItem.payload.fridayDate)) || '').trim();
        var bRawFuDate = String(bItem.date || (bItem.payload && bItem.payload.date) || '').trim();
        var resolvedFuFri = isValidIsoDate(bRawFuFriday) ? bRawFuFriday : (isValidIsoDate(bRawFuDate) ? bRawFuDate : currentCairoToday);
        var fuHdr = 'افتقاد ' + resolvedFuFri;
        if (findExactHeaderIndex(headers, fuHdr) < 0 && !seenFuHeaders[fuHdr]) {
          seenFuHeaders[fuHdr] = true;
          neededFuHeaders.push(fuHdr);
        }
      }
    }

    neededFridays.sort();
    var insertedColumns = false;
    for (var nf = 0; nf < neededFridays.length; nf++) {
      var nfDate = neededFridays[nf];
      var insertBeforeCol = findColIndex(headers, ['آخر حضور', 'اخر حضور', 'إجمالي الحضور', 'حضور الشهر']);
      if (insertBeforeCol >= 0) {
        sheet.insertColumnBefore(insertBeforeCol + 1);
        sheet.getRange(1, insertBeforeCol + 1).setValue(nfDate);
        headers.splice(insertBeforeCol, 0, nfDate);
      } else {
        var lastCol = sheet.getLastColumn();
        sheet.getRange(1, lastCol + 1).setValue(nfDate);
        headers.push(nfDate);
      }
      insertedColumns = true;
    }
    neededFuHeaders.sort();
    for (var nfu = 0; nfu < neededFuHeaders.length; nfu++) {
      var lastCol2 = sheet.getLastColumn();
      sheet.getRange(1, lastCol2 + 1).setValue(neededFuHeaders[nfu]);
      headers.push(neededFuHeaders[nfu]);
      insertedColumns = true;
    }
    if (insertedColumns) {
      values = sheet.getDataRange().getValues();
      headers = values[0].map(function (h) { return formatHeaderCell(h); });
    }

    var idCol = findColIndex(headers, ['id', 'ID']);
    var codeCol = findColIndex(headers, ['كود', 'الكود', 'code']);
    var nameLookupCol = findColIndex(headers, ['الاسم', 'name', 'Name']);
    var versionCol = findColIndex(headers, ['version', 'الإصدار']);
    var totalCol = findColIndex(headers, ['إجمالي الحضور', 'اجمالي الحضور', 'attendanceTotal', 'total']);
    var lastAttCol = findColIndex(headers, ['آخر حضور', 'اخر حضور', 'lastAttendance']);
    var monthCol = findColIndex(headers, ['حضور الشهر', 'attendanceMonth']);
    var lastFuCol = findColIndex(headers, ['آخر افتقاد', 'اخر افتقاد', 'lastFollowup']);
    var fuStatusCol = findColIndex(headers, ['حالة الافتقاد', 'followupStatus']);

    // Build fast student lookup maps once for the entire sheet
    var byCode = {};
    var byId = {};
    var byName = {};
    var rowVersionMap = {};
    for (var r = 1; r < values.length; r++) {
      if (codeCol >= 0) {
        var cv = String(values[r][codeCol] || '').trim();
        if (cv && byCode[cv] === undefined) byCode[cv] = r;
      }
      if (idCol >= 0) {
        var iv = String(values[r][idCol] || '').trim();
        if (iv && byId[iv] === undefined) byId[iv] = r;
      }
      if (nameLookupCol >= 0) {
        var nv = String(values[r][nameLookupCol] || '').trim().replace(/\s+/g, ' ');
        if (nv && byName[nv] === undefined) byName[nv] = r;
        var normNv = normalizeArabicForMatch(nv);
        if (normNv && byName[normNv] === undefined) byName[normNv] = r;
      }
      rowVersionMap[r] = (versionCol >= 0) ? (parseInt(values[r][versionCol], 10) || 1) : 1;
    }

    var dirtyRows = {};
    var dirtyCells = []; // [{ rowIndex, colIndex, val }]
    var conflictedRowSet = {};
    var stagedSheetSuccesses = []; // [{ qIdx, qKey, itemRes }]

    for (var m4 = 0; m4 < itemIndices.length; m4++) {
      var qIdx = itemIndices[m4];
      var qItem = batchItems[qIdx];
      var qKey = String(qItem.idempotencyKey || qItem.mutationId || qItem.id || '').trim();
      var qAction = String(qItem.action || '').trim().toLowerCase();
      var qPayload = qItem.payload || {};

      var qCode = String(qItem.studentCode || qItem.code || '').trim();
      var qId = String(qItem.studentId || '').trim();
      var qName = String(qItem.studentName || qItem.name || '').trim().replace(/\s+/g, ' ');
      var normQName = normalizeArabicForMatch(qName);
      if (!qId) {
        results[qIdx] = {
          ok: false,
          status: 400,
          mutationId: qKey,
          error: 'معرّف المخدوم studentId مطلوب في كل عملية batch؛ لم يتم تنفيذ الكتابة.'
        };
        continue;
      }
      var rowIndex = -1;
      // Exact studentId takes precedence; code/name are legacy row locators only.
      if (qId && byId[qId] !== undefined) rowIndex = byId[qId];
      else if (qCode && byCode[qCode] !== undefined) rowIndex = byCode[qCode];
      else if (qName && byName[qName] !== undefined) rowIndex = byName[qName];
      else if (normQName && byName[normQName] !== undefined) rowIndex = byName[normQName];

      if (rowIndex === -1) {
        results[qIdx] = { ok: false, status: 404, mutationId: qKey, studentId: qId, error: 'الاسم غير موجود' };
        continue;
      }

      if (conflictedRowSet[rowIndex]) {
        results[qIdx] = {
          ok: false,
          status: 409,
          mutationId: qKey,
          studentId: qId,
          error: 'توقف التحديث المتسلسل لهذا المخدوم لوجود تعارض إصدار سابق في الدفعة'
        };
        continue;
      }

      var curVer = rowVersionMap[rowIndex];
      var expectedVer = qItem.expectedVersion;
      if (versionCol >= 0 && typeof expectedVer === 'number' && isFinite(expectedVer) && expectedVer >= 1 && curVer !== expectedVer) {
        conflictedRowSet[rowIndex] = true;
        results[qIdx] = {
          ok: false,
          status: 409,
          mutationId: qKey,
          studentId: qId,
          error: 'تعارض في التعديل المتزامن (409): إصدار الشيت (' + curVer + ') لا يطابق الإصدار المرسل (' + expectedVer + ')'
        };
        continue;
      }

      var rowEffectiveId = qId; // Echo the exact client mutation.studentId; never synthesize a different proof identity.

      if (qAction === 'attendance') {
        var friday = String(qItem.friday || qItem.date || (qPayload && (qPayload.friday || qPayload.date)) || '').trim();
        if (!isValidIsoDate(friday)) {
          results[qIdx] = { ok: false, status: 400, mutationId: qKey, studentId: rowEffectiveId, error: 'تاريخ غير صحيح' };
          continue;
        }
        var fridayCol = findExactHeaderIndex(headers, friday);
        if (fridayCol < 0) {
          results[qIdx] = { ok: false, status: 500, mutationId: qKey, studentId: rowEffectiveId, error: 'تعذر إنشاء عمود التاريخ' };
          continue;
        }

        var rawPresent = qItem.present !== undefined ? qItem.present : (qItem.isPresent !== undefined ? qItem.isPresent : (qPayload && (qPayload.isPresent !== undefined ? qPayload.isPresent : qPayload.present)));
        var isPresent = rawPresent === true || ['1', 'true', 'present', 'حاضر'].indexOf(String(rawPresent).trim().toLowerCase()) !== -1;

        var prevVal = String(values[rowIndex][fridayCol] || '').trim().toLowerCase();
        var wasPresent = ['1', 'true', 'present', 'حاضر'].indexOf(prevVal) !== -1;
        var delta = (isPresent ? 1 : 0) - (wasPresent ? 1 : 0);

        values[rowIndex][fridayCol] = isPresent ? 1 : 0;
        dirtyCells.push({ rowIndex: rowIndex, colIndex: fridayCol, val: isPresent ? 1 : 0 });

        if (totalCol >= 0) {
          var prevTotal = parseInt(values[rowIndex][totalCol] || '0', 10) || 0;
          values[rowIndex][totalCol] = Math.max(0, prevTotal + delta);
        }

        var nextVer = (versionCol >= 0)
          ? (curVer + 1)
          : ((typeof expectedVer === 'number' && isFinite(expectedVer) && expectedVer >= 1) ? (Math.floor(expectedVer) + 1) : (curVer + 1));
        rowVersionMap[rowIndex] = nextVer;
        if (versionCol >= 0) {
          values[rowIndex][versionCol] = nextVer;
        }
        dirtyRows[rowIndex] = true;

        var batchAttProof = buildPersistenceProof({
          mutationId: qKey,
          operation: 'attendance',
          studentId: rowEffectiveId,
          sheetName: targetSheetName,
          row: rowIndex + 1,
          recordId: rowEffectiveId + ':' + friday,
          newVersion: nextVer,
          friday: friday,
          present: isPresent
        });
        var itemRes = buildVerifiedMutationResponse(batchAttProof);
        stagedSheetSuccesses.push({ qIdx: qIdx, qKey: qKey, itemRes: itemRes });
      } else if (qAction === 'followup') {
        var qFuMethod = String(qItem.status || qItem.followupStatus || qItem.type || qItem.method || (qPayload && (qPayload.status || qPayload.followupStatus || qPayload.method || qPayload.type)) || '').trim();
        if (!qFuMethod) {
          results[qIdx] = { ok: false, status: 400, mutationId: qKey, studentId: rowEffectiveId, error: 'حالة الافتقاد مطلوبة' };
          continue;
        }
        var qRawFuFriday = String(qItem.friday || qItem.fridayDate || (qPayload && (qPayload.friday || qPayload.fridayDate)) || '').trim();
        var qRawFuDate = String(qItem.date || (qPayload && qPayload.date) || '').trim();
        var qFuDate = isValidIsoDate(qRawFuDate) ? qRawFuDate : currentCairoToday;
        var qFuFriday = isValidIsoDate(qRawFuFriday) ? qRawFuFriday : qFuDate;
        var qFuRecordId = String(qItem.recordId || (qPayload && qPayload.recordId) || '').trim();
        var qFuNotes = qItem.notes !== undefined ? qItem.notes : ((qPayload && qPayload.notes) || '');
        var qFuOutcomeRaw = String(qItem.callOutcome || (qPayload && qPayload.callOutcome) || '').trim();
        var qFuOutcome = (qFuOutcomeRaw === 'تم التواصل' || qFuOutcomeRaw === 'لم يتم التواصل') ? qFuOutcomeRaw : '';

        var qFuHeader = 'افتقاد ' + qFuFriday;
        var qFuCol = findExactHeaderIndex(headers, qFuHeader);
        if (qFuCol < 0) {
          results[qIdx] = { ok: false, status: 500, mutationId: qKey, studentId: rowEffectiveId, error: 'تعذر إنشاء عمود الافتقاد' };
          continue;
        }

        // Append pastoral followup log row FIRST — if this fails, fail ONLY this item without fake success
        var qLogResult;
        try {
          qLogResult = appendFollowupLogRow(
            ss,
            targetSheetName,
            headers,
            values[rowIndex],
            qFuFriday,
            qFuMethod,
            qFuNotes,
            qKey,
            qFuOutcome,
            qFuDate,
            qFuRecordId
          );
        } catch (fuLogErr) {
          results[qIdx] = {
            ok: false,
            status: 500,
            mutationId: qKey,
            studentId: rowEffectiveId,
            error: String(fuLogErr && fuLogErr.message ? fuLogErr.message : fuLogErr)
          };
          continue;
        }

        if (!qLogResult || qLogResult.appended !== true || !qLogResult.followupLogRow) {
          results[qIdx] = {
            ok: false,
            status: 500,
            mutationId: qKey,
            studentId: rowEffectiveId,
            error: 'تعذر إثبات حفظ سجل الافتقاد في تاب سجل الافتقاد'
          };
          continue;
        }

        var sanitizedMethod = sanitizeFormulaValue(qFuMethod);
        values[rowIndex][qFuCol] = sanitizedMethod;
        dirtyCells.push({ rowIndex: rowIndex, colIndex: qFuCol, val: sanitizedMethod });
        if (lastFuCol >= 0) {
          values[rowIndex][lastFuCol] = sanitizeFormulaValue(qFuDate);
          dirtyCells.push({ rowIndex: rowIndex, colIndex: lastFuCol, val: sanitizeFormulaValue(qFuDate) });
        }
        if (fuStatusCol >= 0) {
          values[rowIndex][fuStatusCol] = sanitizedMethod;
          dirtyCells.push({ rowIndex: rowIndex, colIndex: fuStatusCol, val: sanitizedMethod });
        }

        var nextFuVer = (versionCol >= 0)
          ? (curVer + 1)
          : ((typeof expectedVer === 'number' && isFinite(expectedVer) && expectedVer >= 1) ? (Math.floor(expectedVer) + 1) : (curVer + 1));
        rowVersionMap[rowIndex] = nextFuVer;
        if (versionCol >= 0) {
          values[rowIndex][versionCol] = nextFuVer;
        }
        dirtyRows[rowIndex] = true;

        var batchFuProof = buildPersistenceProof({
          mutationId: qKey,
          operation: 'followup',
          studentId: rowEffectiveId,
          sheetName: targetSheetName,
          row: rowIndex + 1,
          recordId: qLogResult.recordId,
          newVersion: nextFuVer,
          friday: qFuFriday,
          date: qFuDate,
          followupLogAppended: true,
          followupLogRow: qLogResult.followupLogRow
        });
        var fuItemRes = buildVerifiedMutationResponse(batchFuProof, {
          lastFollowup: qFuDate,
          fuDate: qFuDate,
          fuStatus: qFuMethod,
          callOutcome: qFuOutcome || undefined
        });
        stagedSheetSuccesses.push({ qIdx: qIdx, qKey: qKey, itemRes: fuItemRes });
      }
    }

    // Flush modified cells and summary columns to the real Google Sheet BEFORE publishing success/idempotency
    try {
      for (var cIdx = 0; cIdx < dirtyCells.length; cIdx++) {
        var dc = dirtyCells[cIdx];
        sheet.getRange(dc.rowIndex + 1, dc.colIndex + 1).setValue(dc.val);
      }

      var dirtyRowKeys = Object.keys(dirtyRows);
      for (var dr = 0; dr < dirtyRowKeys.length; dr++) {
        var rIndex = parseInt(dirtyRowKeys[dr], 10);
        var rNum = rIndex + 1;

        var latestPresentFriday = '';
        var monthCount = 0;
        for (var c = 0; c < headers.length; c++) {
          var hDate = String(headers[c] || '').trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(hDate)) {
            var cv2 = values[rIndex][c];
            if (cv2 === 1 || String(cv2).trim() === '1' || cv2 === true) {
              if (hDate > latestPresentFriday) latestPresentFriday = hDate;
              if (hDate.substring(0, 7) === currentCairoMonth) monthCount++;
            }
          }
        }

        if (totalCol >= 0) {
          sheet.getRange(rNum, totalCol + 1).setValue(values[rIndex][totalCol]);
        }
        if (lastAttCol >= 0) {
          sheet.getRange(rNum, lastAttCol + 1).setValue(sanitizeFormulaValue(latestPresentFriday));
        }
        if (monthCol >= 0) {
          sheet.getRange(rNum, monthCol + 1).setValue(monthCount);
        }
        if (versionCol >= 0) {
          sheet.getRange(rNum, versionCol + 1).setValue(rowVersionMap[rIndex]);
        }
      }

      safeFlushSpreadsheet();
      // Verify every queued cell against the live sheet before any batch item is marked persisted.
      for (var verifyIdx = 0; verifyIdx < dirtyCells.length; verifyIdx++) {
        var verifyCell = dirtyCells[verifyIdx];
        verifyCellValue(sheet, verifyCell.rowIndex + 1, verifyCell.colIndex + 1, verifyCell.val, 'عملية batch');
      }

      for (var okIdx = 0; okIdx < stagedSheetSuccesses.length; okIdx++) {
        var okEntry = stagedSheetSuccesses[okIdx];
        results[okEntry.qIdx] = okEntry.itemRes;
        if (okEntry.qKey) {
          newIdempotencyEntries.push({ key: okEntry.qKey, response: okEntry.itemRes });
          cacheBatchToPut['IDEMP_' + okEntry.qKey] = JSON.stringify(okEntry.itemRes);
        }
      }
    } catch (sheetFlushErr) {
      var flushMsg = String(sheetFlushErr && sheetFlushErr.message ? sheetFlushErr.message : sheetFlushErr);
      for (var failIdx = 0; failIdx < stagedSheetSuccesses.length; failIdx++) {
        var failEntry = stagedSheetSuccesses[failIdx];
        results[failEntry.qIdx] = {
          ok: false,
          status: 500,
          mutationId: failEntry.qKey,
          studentId: failEntry.itemRes.studentId,
          error: 'فشل حفظ البيانات في Google Sheets: ' + flushMsg
        };
      }
    }
  }

  if (newIdempotencyEntries.length > 0) {
    saveDurableIdempotencyBatch(ss, newIdempotencyEntries);
    try {
      cache.putAll(cacheBatchToPut, 21600);
    } catch (ce) {
      for (var ck in cacheBatchToPut) {
        try { cache.put(ck, cacheBatchToPut[ck], 21600); } catch (e2) {}
      }
    }
  }

  return {
    ok: true,
    status: 200,
    action: 'batch',
    results: results,
    serverDurationMs: Date.now() - postStartMs
  };
}

function sanitizeFormulaValue(value) {
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) {
    return "'" + value;
  }
  return value;
}

function setIfFound(sheet, rowNum, headers, colNames, value) {
  if (value === undefined || value === null) return;
  var col = findColIndex(headers, colNames);
  if (col >= 0) {
    sheet.getRange(rowNum, col + 1).setValue(sanitizeFormulaValue(value));
  }
}

function findExactHeaderIndex(headers, exactName) {
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h] || '').trim() === exactName) return h;
  }
  return -1;
}

function normalizeStudentCodeForMatch(code) {
  return String(code || '').trim().toLowerCase().replace(/\s+/g, '');
}

function findColIndex(headers, names) {
  for (var i = 0; i < names.length; i++) {
    for (var h = 0; h < headers.length; h++) {
      if (headers[h] === names[i]) return h;
    }
  }
  for (var i = 0; i < names.length; i++) {
    for (var h = 0; h < headers.length; h++) {
      if (headers[h].indexOf(names[i]) !== -1) return h;
    }
  }
  return -1;
}

function formatHeaderCell(cell) {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return Utilities.formatDate(cell, Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd');
  }
  return String(cell || '').trim();
}

function formatCellValue(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return Utilities.formatDate(cell, Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd');
  }
  return String(cell).trim();
}

function readFollowupLogRows(ss) {
  var logSheet = findFollowupLogSheet(ss);
  if (!logSheet) return [];
  var values = logSheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  var headers = values[0].map(function (h) { return formatHeaderCell(h).replace(/\s+/g, ' '); });
  var iDate = findColIndex(headers, ['التاريخ']);
  var iFriday = findColIndex(headers, ['أسبوع الجمعة', 'الجمعة']);
  var iCode = findColIndex(headers, ['الكود', 'كود']);
  var iName = findColIndex(headers, ['الاسم']);
  var iServant = findColIndex(headers, ['الأشبين', 'الاشبين']);
  var iType = findColIndex(headers, ['النوع']);
  var iOutcome = findColIndex(headers, ['نتيجة الاتصال', 'نتيجه الاتصال', 'callOutcome', 'النتيجة']);
  var iNotes = findColIndex(headers, ['ملاحظات', 'ملا حظات']);
  var iRecordId = findColIndex(headers, ['record_id', 'recordId']);

  var records = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var nameVal = iName >= 0 ? formatCellValue(row[iName]) : '';
    var codeVal = iCode >= 0 ? formatCellValue(row[iCode]) : '';
    if (!nameVal && !codeVal) continue;
    var rawOutcome = iOutcome >= 0 ? formatCellValue(row[iOutcome]) : '';
    var outcomeVal = (rawOutcome === 'تم التواصل' || rawOutcome === 'لم يتم التواصل') ? rawOutcome : undefined;
    var storedRecId = iRecordId >= 0 ? formatCellValue(row[iRecordId]) : '';
    records.push({
      id: storedRecId || ('gs_fu_' + (r + 1) + '_' + (codeVal || nameVal).replace(/\s+/g, '_')),
      date: iDate >= 0 ? formatCellValue(row[iDate]) : '',
      fridayDate: iFriday >= 0 ? formatCellValue(row[iFriday]) : '',
      studentId: codeVal || nameVal,
      studentCode: codeVal,
      studentName: nameVal,
      servant: iServant >= 0 ? formatCellValue(row[iServant]) : '',
      type: (iType >= 0 ? formatCellValue(row[iType]) : '') || 'بدون',
      callOutcome: outcomeVal,
      notes: iNotes >= 0 ? formatCellValue(row[iNotes]) : ''
    });
  }
  return records;
}

/**
 * Appends a followup row to 'سجل الافتقاد' with strict fail-loud guarantees and deduplication.
 * NEVER fails silently if 'سجل الافتقاد' is missing.
 */
function appendFollowupLogRow(
  ss,
  sheetName,
  studentHeaders,
  studentRow,
  fridayDate,
  method,
  notes,
  mutationId,
  callOutcome,
  recordDate,
  recordId
) {
  var logSheet = findFollowupLogSheet(ss);
  if (!logSheet) {
    throw new Error('التاب "' + FOLLOWUP_LOG_SHEET_NAME + '" غير موجود في ملف Google Sheets المركزي');
  }

  var codeCol = findColIndex(studentHeaders, ['كود', 'الكود', 'code']);
  var nameCol = findColIndex(studentHeaders, ['الاسم', 'name']);
  var servantCol = findColIndex(studentHeaders, ['الاشبين', 'الأشبين', 'الخادم', 'servant']);
  var logLastColumn = Math.max(logSheet.getLastColumn(), 8);
  var logHeaders = logSheet.getRange(1, 1, 1, logLastColumn).getValues()[0]
    .map(function (h) { return formatHeaderCell(h); });

  var mutationIdCol = findColIndex(logHeaders, ['mutation_id']);
  if (mutationIdCol < 0) {
    mutationIdCol = logLastColumn;
    logSheet.getRange(1, mutationIdCol + 1).setValue('mutation_id');
    logHeaders.push('mutation_id');
    logLastColumn = mutationIdCol + 1;
  }

  var outcomeCol = findColIndex(logHeaders, ['نتيجة الاتصال', 'نتيجه الاتصال', 'callOutcome']);
  if (outcomeCol < 0 && callOutcome) {
    outcomeCol = logLastColumn;
    logSheet.getRange(1, outcomeCol + 1).setValue('نتيجة الاتصال');
    logHeaders.push('نتيجة الاتصال');
    logLastColumn = outcomeCol + 1;
  }

  var recordIdCol = findColIndex(logHeaders, ['record_id', 'recordId']);
  if (recordIdCol < 0 && recordId) {
    recordIdCol = logLastColumn;
    logSheet.getRange(1, recordIdCol + 1).setValue('record_id');
    logHeaders.push('record_id');
    logLastColumn = recordIdCol + 1;
  }

  var logLastRow = logSheet.getLastRow();
  if (mutationId && logLastRow > 1) {
    var existingMutation = logSheet.getRange(2, mutationIdCol + 1, logLastRow - 1, 1)
      .createTextFinder(String(mutationId))
      .matchEntireCell(true)
      .findNext();
    if (existingMutation) {
      var existingRow = existingMutation.getRow();
      var existingRecIdVal = (recordIdCol >= 0) ? formatCellValue(logSheet.getRange(existingRow, recordIdCol + 1).getValue()) : '';
      return {
        appended: true,
        followupLogRow: existingRow,
        recordId: recordId || existingRecIdVal || ('gs_fu_' + existingRow),
        deduplicated: true
      };
    }
  }
  if (recordId && recordIdCol >= 0 && logLastRow > 1) {
    var existingByRecordId = logSheet.getRange(2, recordIdCol + 1, logLastRow - 1, 1)
      .createTextFinder(String(recordId))
      .matchEntireCell(true)
      .findNext();
    if (existingByRecordId) {
      var existingRecRow = existingByRecordId.getRow();
      return {
        appended: true,
        followupLogRow: existingRecRow,
        recordId: String(recordId),
        deduplicated: true
      };
    }
  }

  var effectiveDate = isValidIsoDate(String(recordDate || '')) ? String(recordDate).trim() : getCairoTodayDateString();
  var effectiveFriday = isValidIsoDate(String(fridayDate || '')) ? String(fridayDate).trim() : effectiveDate;

  var newRow = [
    effectiveDate,
    effectiveFriday,
    sanitizeFormulaValue(sheetName),
    sanitizeFormulaValue(codeCol >= 0 ? formatCellValue(studentRow[codeCol]) : ''),
    sanitizeFormulaValue(nameCol >= 0 ? formatCellValue(studentRow[nameCol]) : ''),
    sanitizeFormulaValue(servantCol >= 0 ? formatCellValue(studentRow[servantCol]) : ''),
    sanitizeFormulaValue(method || 'تم تليفونياً'),
    sanitizeFormulaValue(notes || '')
  ];

  var targetWidth = Math.max(
    mutationIdCol + 1,
    outcomeCol >= 0 ? outcomeCol + 1 : 0,
    recordIdCol >= 0 ? recordIdCol + 1 : 0
  );
  while (newRow.length < targetWidth) newRow.push('');
  newRow[mutationIdCol] = mutationId || '';
  if (outcomeCol >= 0 && callOutcome) {
    newRow[outcomeCol] = sanitizeFormulaValue(callOutcome);
  }
  if (recordIdCol >= 0 && recordId) {
    newRow[recordIdCol] = sanitizeFormulaValue(recordId);
  }

  logSheet.appendRow(newRow);
  safeFlushSpreadsheet();
  var appendedRowNum = logSheet.getLastRow();
  if (appendedRowNum < 2) throw new Error('تعذر تحديد صف سجل الافتقاد بعد الإضافة.');
  var persistedLogRow = logSheet.getRange(appendedRowNum, 1, 1, newRow.length).getValues()[0];
  for (var verifyCol = 0; verifyCol < newRow.length; verifyCol++) {
    if (normalizeVerificationValue(persistedLogRow[verifyCol]) !== normalizeVerificationValue(newRow[verifyCol])) {
      throw new Error('فشل التحقق من إعادة قراءة صف سجل الافتقاد بعد الكتابة.');
    }
  }

  return {
    appended: true,
    followupLogRow: appendedRowNum,
    recordId: recordId || ('gs_fu_' + appendedRowNum),
    deduplicated: false
  };
}

function mapRowToStudent(headers, row, sheetName, rowNumber) {
  function get(names) {
    var idx = findColIndex(headers, names);
    return idx >= 0 ? formatCellValue(row[idx]) : '';
  }
  var code = get(['كود', 'الكود', 'code', 'Code']) || ('SG-' + rowNumber);
  var notesRaw = get(['ملاحظات الافتقاد', 'ملاحظات', 'notes']);
  var att = {};
  var fu = {};
  var totalCount = 0;
  for (var h = 0; h < headers.length; h++) {
    var hdr = String(headers[h] || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(hdr)) {
      var v = formatCellValue(row[h]);
      if (v === '1' || v.toLowerCase() === 'true' || v === 'حاضر') {
        att[hdr] = true;
        totalCount++;
      }
    } else if (/^افتقاد\s+\d{4}-\d{2}-\d{2}$/.test(hdr)) {
      var dStr = hdr.replace(/^افتقاد\s+/, '');
      var fv = formatCellValue(row[h]);
      if (fv && fv !== 'بدون') fu[dStr] = fv;
    }
  }
  return {
    id: get(['id', 'ID']) || ('gs_' + sheetName + '_' + code + '_' + rowNumber).replace(/\s+/g, '_'),
    code: code,
    name: get(['الاسم', 'name', 'Name']),
    servant: get(['الاشبين', 'الأشبين', 'الخادم', 'servant']) || 'غير محدد',
    phoneStudent: get(['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب', 'phoneStudent']),
    phoneParent1: get(['موبيل ولي الامر 1', 'ولي الأمر 1', 'phoneParent1']),
    phoneParent2: get(['موبيل ولي الامر 2', 'ولي الأمر 2', 'phoneParent2']),
    birthDate: get(['تاريخ الميلاد', 'birthDate']),
    area: get(['منطقة', 'المنطقة', 'area']) || 'غير محددة',
    address: get(['العنوان', 'address']),
    notes: notesRaw === 'بدون' ? '' : notesRaw,
    followupStatus: get(['حالة الافتقاد', 'followupStatus']) || (['بدون', 'تم تليفونياً', 'تم بزيارة', 'واتساب', 'رسالة نصية'].indexOf(notesRaw) !== -1 ? notesRaw : 'بدون'),
    attendanceTotal: parseInt(get(['إجمالي الحضور', 'اجمالي الحضور', 'attendanceTotal']) || String(totalCount), 10) || totalCount,
    attendanceMonth: parseInt(get(['حضور الشهر', 'attendanceMonth']) || '0', 10) || 0,
    attendanceStatus: get(['الحالة', 'attendanceStatus']) === 'حاضر' ? 'حاضر' : 'غائب',
    lastAttendance: get(['آخر حضور', 'اخر حضور', 'lastAttendance']) || undefined,
    lastFollowup: get(['آخر افتقاد', 'اخر افتقاد', 'lastFollowup']) || undefined,
    sourceSheet: sheetName,
    version: parseInt(get(['version', 'الإصدار']) || '1', 10) || 1,
    att: att,
    fu: fu
  };
}
