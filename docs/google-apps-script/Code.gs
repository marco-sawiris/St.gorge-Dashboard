/**
 * St. George Church Dashboard — Unified Google Apps Script Relay (Code.gs)
 * -------------------------------------------------------------------
 * Fully unified and authoritative Google Apps Script backend.
 * Compatible with BOTH:
 * 1. Live deployed web app contract ("notes-v2" in Google Sheets):
 *    - Flat JSON actions: 'attendance', 'followup', 'update', 'add'.
 *    - Direct parameters: sheet, name, date, present, status, notes, fields.
 *    - Direct column updates: Friday columns, 'افتقاد YYYY-MM-DD', 'آخر حضور', 'آخر افتقاد', 'إجمالي الحضور'.
 * 2. Enterprise GitHub Relay features:
 *    - LockService (atomic concurrency lock prevents race conditions).
 *    - ScriptProperties RELAY_KEY validation (constant-time comparison).
 *    - Durable Idempotency (CacheService + _mutation_idempotency ledger).
 *    - Optimistic Concurrency Control (OCC 409) when expectedVersion is supplied.
 *    - Zero-delete protection (HTTP 403).
 *    - Multi-sheet support ('نشط', 'غير حاضر', 'فصل البابا شنودة', 'غير نشط').
 *    - Pastoral audit logging to 'سجل الافتقاد' tab.
 *    - Full student reads via doGet?action=getStudents.
 *
 * Script Properties (Google Apps Script -> Project Settings -> Script Properties):
 *   SPREADSHEET_ID = "15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0" (Optional if container-bound)
 *   RELAY_KEY      = Optional secret key for external client authentication.
 */

var APPROVED_SHEETS = ['نشط', 'غير حاضر', 'فصل البابا شنودة', 'غير نشط'];
var ALL_SHEETS_SENTINEL = '__ALL__';

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}

  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SPREADSHEET_ID') || '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0';
  return SpreadsheetApp.openById(sheetId);
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

    // Health check returns exact signature expected by both systems plus batch/idempotency capability flags
    if (action === 'health' || !e || !e.parameter || !e.parameter.action) {
      return jsonResponse({
        ok: true,
        status: 'ok',
        msg: 'Apps Script شغال',
        version: 'notes-v3',
        supportsBatch: true,
        capabilities: ['attendance', 'followup', 'update', 'add', 'batch', 'checkIdempotency'],
        mode: 'google_apps_script_relay',
        timestamp: new Date().toISOString()
      });
    }

    var keyCheck = verifyRelayKey(e && e.parameter && (e.parameter.relayKey || e.parameter.token));
    if (!keyCheck.valid) {
      return jsonResponse({ ok: false, status: 401, error: keyCheck.error });
    }

    if (action === 'getStudents') {
      var targetSheet = (e && e.parameter && e.parameter.sheet) || ALL_SHEETS_SENTINEL;
      if (targetSheet !== ALL_SHEETS_SENTINEL && APPROVED_SHEETS.indexOf(targetSheet) === -1) {
        return jsonResponse({ ok: false, status: 400, error: 'اسم الفصل غير معتمد: ' + targetSheet });
      }

      var ss = getSpreadsheet();
      var sheetsToRead = targetSheet === ALL_SHEETS_SENTINEL ? APPROVED_SHEETS : [targetSheet];
      var students = [];
      var confirmedSheets = [];

      for (var i = 0; i < sheetsToRead.length; i++) {
        var sheetName = sheetsToRead[i];
        var sheet = ss.getSheetByName(sheetName);
        if (!sheet) continue;
        confirmedSheets.push(sheetName);
        var values = sheet.getDataRange().getValues();
        if (values.length <= 1) continue;

        var headers = values[0].map(function (h) { return formatHeaderCell(h); });
        var nameCol = findColIndex(headers, ['الاسم', 'name', 'Name']);
        if (nameCol === -1) continue;

        for (var r = 1; r < values.length; r++) {
          var row = values[r];
          var rowName = String(row[nameCol] || '').trim();
          if (!rowName || rowName === 'الاسم' || rowName === 'سؤال بدون عنوان') continue;
          students.push(mapRowToStudent(headers, row, sheetName, r + 1));
        }
      }

      return jsonResponse({
        ok: true,
        sheet: targetSheet,
        targetSheet: targetSheet,
        isComplete: true,
        confirmedComplete: true,
        isConfirmedComplete: true,
        confirmedSheets: confirmedSheets,
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
    var allowedActions = ['add', 'update', 'attendance', 'followup', 'delete', 'batch', 'checkidempotency'];
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
      var batchRes = processBatchMutations(batchItems, postStartMs);
      return jsonResponse(batchRes);
    }

    // Target Sheet resolution
    var targetSheetName = body.sheet || body.sourceSheet || mutation.sourceSheet || mutation.sheet || 'نشط';
    if (APPROVED_SHEETS.indexOf(targetSheetName) === -1) {
      return jsonResponse({ ok: false, status: 400, error: 'اسم الفصل غير معتمد: ' + targetSheetName });
    }
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(targetSheetName);
    if (!sheet) {
      return jsonResponse({ ok: false, status: 404, error: 'التاب مش موجود: ' + targetSheetName });
    }

    // Idempotency check
    var idempotencyKey = String(body.idempotencyKey || body.id || mutation.id || '').trim();
    var cache = CacheService.getScriptCache();
    if (idempotencyKey) {
      var cached = cache.get('IDEMP_' + idempotencyKey);
      if (cached) {
        var prev = JSON.parse(cached);
        prev.deduplicated = true;
        return jsonResponse(prev);
      }
      var durablePrevious = findDurableIdempotencyResult(ss, idempotencyKey);
      if (durablePrevious) {
        durablePrevious.deduplicated = true;
        cache.put('IDEMP_' + idempotencyKey, JSON.stringify(durablePrevious), 21600);
        return jsonResponse(durablePrevious);
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
    var targetName = String(body.name || body.studentName || mutation.studentName || (mutation.payload && mutation.payload.name) || '').trim();
    var targetCode = String(body.studentCode || body.code || mutation.studentCode || (mutation.payload && mutation.payload.code) || '').trim();
    var targetId = String(body.studentId || body.id || mutation.studentId || '').trim();

    // Row Matching Logic
    var rowIndex = -1;
    if (targetCode && codeCol >= 0) {
      for (var r = 1; r < values.length; r++) {
        if (String(values[r][codeCol] || '').trim() === targetCode) {
          rowIndex = r;
          break;
        }
      }
    }
    if (rowIndex === -1 && targetId && idCol >= 0) {
      for (var r = 1; r < values.length; r++) {
        if (String(values[r][idCol] || '').trim() === targetId) {
          rowIndex = r;
          break;
        }
      }
    }
    if (rowIndex === -1 && targetName && nameLookupCol >= 0) {
      for (var r = 1; r < values.length; r++) {
        var candidateName = String(values[r][nameLookupCol] || '').trim();
        if (candidateName === targetName || candidateName.replace(/\s+/g, ' ') === targetName.replace(/\s+/g, ' ')) {
          rowIndex = r;
          break;
        }
      }
    }

    if (action === 'add') {
      var addFields = body.fields || (mutation.payload && mutation.payload.fields) || mutation.payload || {};
      var addName = String(addFields.name || targetName || '').trim();
      if (!addName) {
        return jsonResponse({ ok: false, status: 400, error: 'الاسم مطلوب' });
      }
      if (rowIndex !== -1) {
        return jsonResponse({ ok: false, status: 409, error: 'المخدوم موجود بالفعل في الشيت' });
      }

      var newRow = headers.map(function (h) {
        if (h === 'كود' || h.indexOf('الكود') !== -1 || h.toLowerCase() === 'code') return sanitizeFormulaValue(addFields.code || targetCode || '');
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
      var addedRowNum = sheet.getLastRow();
      var addResult = {
        ok: true,
        status: 200,
        row: addedRowNum,
        mutationId: idempotencyKey,
        newVersion: 1,
        action: 'add'
      };
      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, addResult);
        cache.put('IDEMP_' + idempotencyKey, JSON.stringify(addResult), 21600);
      }
      return jsonResponse(addResult);
    }

    // For actions other than 'add', student must exist
    if (rowIndex === -1) {
      return jsonResponse({ ok: false, status: 404, error: 'الاسم غير موجود' });
    }

    var rowNum = rowIndex + 1;
    var currentVersion = (versionCol >= 0) ? (parseInt(values[rowIndex][versionCol], 10) || 1) : 1;
    var expectedVersion = mutation.expectedVersion || body.expectedVersion;

    // Concurrency Check (OCC 409) if client explicitly provided expectedVersion
    if (typeof expectedVersion === 'number' && isFinite(expectedVersion) && expectedVersion >= 1) {
      if (currentVersion !== expectedVersion) {
        return jsonResponse({
          ok: false,
          status: 409,
          error: 'تعارض في التعديل المتزامن (409): إصدار الشيت (' + currentVersion + ') لا يطابق الإصدار المرسل (' + expectedVersion + ')'
        });
      }
    }
    var nextVersion = currentVersion + 1;

    // 1. ATTENDANCE ACTION
    if (action === 'attendance') {
      var friday = String(body.date || body.friday || (mutation.payload && (mutation.payload.friday || mutation.payload.date)) || '').trim();
      if (!friday) {
        return jsonResponse({ ok: false, status: 400, error: 'تاريخ غير صحيح' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(friday)) {
        return jsonResponse({ ok: false, status: 400, error: 'تاريخ غير صحيح' });
      }

      var rawPresent = body.present !== undefined ? body.present : (body.isPresent !== undefined ? body.isPresent : (mutation.payload && (mutation.payload.isPresent !== undefined ? mutation.payload.isPresent : mutation.payload.present)));
      var isPresent = rawPresent === true || ['1', 'true', 'present', 'حاضر'].indexOf(String(rawPresent).trim().toLowerCase()) !== -1;

      // Locate or create Friday column
      var fridayCol = findExactHeaderIndex(headers, friday);
      if (fridayCol < 0) {
        // Find insert position before summary columns or append at end
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
          var cellV = (c === fridayCol) ? (isPresent ? 1 : 0) : values[rowIndex][c];
          if (cellV === 1 || String(cellV).trim() === '1' || cellV === true) {
            if (hdrDate > latestPresentFriday) latestPresentFriday = hdrDate;
          }
        }
      }
      setIfFound(sheet, rowNum, headers, ['آخر حضور', 'اخر حضور', 'lastAttendance'], latestPresentFriday);

      // Monthly Attendance Count
      var monthCol = findColIndex(headers, ['حضور الشهر', 'attendanceMonth']);
      if (monthCol >= 0) {
        var currentCairoMonth = Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM');
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

      var attendanceResult = {
        ok: true,
        status: 200,
        row: rowNum,
        total: totalCount,
        lastAttendance: latestPresentFriday,
        mutationId: idempotencyKey,
        newVersion: nextVersion,
        action: 'attendance'
      };
      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, attendanceResult);
        cache.put('IDEMP_' + idempotencyKey, JSON.stringify(attendanceResult), 21600);
      }
      return jsonResponse(attendanceResult);
    }

    // 2. FOLLOWUP ACTION
    if (action === 'followup') {
      var fuMethod = String(body.status || body.followupStatus || body.type || (mutation.payload && (mutation.payload.status || mutation.payload.followupStatus || mutation.payload.method || mutation.payload.type)) || '').trim();
      if (!fuMethod) {
        return jsonResponse({ ok: false, status: 400, error: 'حالة الافتقاد مطلوبة' });
      }

      var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd');
      var fuDateColHeader = 'افتقاد ' + todayStr;

      // Locate or create specific followup column for today
      var fuCol = findExactHeaderIndex(headers, fuDateColHeader);
      if (fuCol < 0) {
        var lastCol = sheet.getLastColumn();
        sheet.getRange(1, lastCol + 1).setValue(fuDateColHeader);
        headers.push(fuDateColHeader);
        fuCol = lastCol;
      }

      sheet.getRange(rowNum, fuCol + 1).setValue(fuMethod);
      setIfFound(sheet, rowNum, headers, ['آخر افتقاد', 'اخر افتقاد', 'lastFollowup'], todayStr);
      setIfFound(sheet, rowNum, headers, ['حالة الافتقاد', 'followupStatus'], fuMethod);

      // Pastoral log row
      var fuNotes = body.notes || (mutation.payload && mutation.payload.notes) || '';
      var fuOutcomeRaw = String(body.callOutcome || (mutation.payload && mutation.payload.callOutcome) || '').trim();
      var fuOutcome = (fuOutcomeRaw === 'تم التواصل' || fuOutcomeRaw === 'لم يتم التواصل') ? fuOutcomeRaw : '';
      appendFollowupLogRow(ss, targetSheetName, headers, values[rowIndex], todayStr, fuMethod, fuNotes, idempotencyKey, fuOutcome);

      if (versionCol >= 0) {
        sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion);
      }

      var followupResult = {
        ok: true,
        status: 200,
        row: rowNum,
        lastFollowup: todayStr,
        fuDate: todayStr,
        fuStatus: fuMethod,
        callOutcome: fuOutcome || undefined,
        mutationId: idempotencyKey,
        newVersion: nextVersion,
        action: 'followup'
      };
      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, followupResult);
        cache.put('IDEMP_' + idempotencyKey, JSON.stringify(followupResult), 21600);
      }
      return jsonResponse(followupResult);
    }

    // 3. UPDATE ACTION
    if (action === 'update') {
      var updateNotes = body.notes !== undefined ? body.notes : (mutation.payload && mutation.payload.notes !== undefined ? mutation.payload.notes : undefined);
      if (updateNotes !== undefined) {
        setIfFound(sheet, rowNum, headers, ['ملاحظات الافتقاد', 'ملاحظات', 'notes'], updateNotes);
      }

      var updateFields = body.fields || (mutation.payload && mutation.payload.fields) || mutation.payload || {};
      if (updateFields.name) setIfFound(sheet, rowNum, headers, ['الاسم', 'name'], updateFields.name);
      if (updateFields.code) setIfFound(sheet, rowNum, headers, ['كود', 'الكود', 'code'], updateFields.code);
      if (updateFields.servant) setIfFound(sheet, rowNum, headers, ['الاشبين', 'الأشبين', 'الخادم', 'servant'], updateFields.servant);
      if (updateFields.phoneStudent) setIfFound(sheet, rowNum, headers, ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب'], updateFields.phoneStudent);
      if (updateFields.phoneParent1) setIfFound(sheet, rowNum, headers, ['موبيل ولي الامر 1', 'ولي الأمر 1'], updateFields.phoneParent1);
      if (updateFields.phoneParent2) setIfFound(sheet, rowNum, headers, ['موبيل ولي الامر 2', 'ولي الأمر 2'], updateFields.phoneParent2);
      if (updateFields.birthDate) setIfFound(sheet, rowNum, headers, ['تاريخ الميلاد'], updateFields.birthDate);
      if (updateFields.area) setIfFound(sheet, rowNum, headers, ['منطقة', 'المنطقة'], updateFields.area);
      if (updateFields.address) setIfFound(sheet, rowNum, headers, ['العنوان'], updateFields.address);
      if (updateFields.status || updateFields.followupStatus) setIfFound(sheet, rowNum, headers, ['حالة الافتقاد', 'followupStatus'], updateFields.status || updateFields.followupStatus);

      if (versionCol >= 0) {
        sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion);
      }

      var updateResult = {
        ok: true,
        status: 200,
        row: rowNum,
        mutationId: idempotencyKey,
        newVersion: nextVersion,
        action: 'update'
      };
      if (idempotencyKey) {
        saveDurableIdempotencyResult(ss, idempotencyKey, updateResult);
        cache.put('IDEMP_' + idempotencyKey, JSON.stringify(updateResult), 21600);
      }
      return jsonResponse(updateResult);
    }

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
    ledger.hideSheet();
  }
  return ledger;
}

function findDurableIdempotencyResult(ss, key) {
  var ledger = getDurableIdempotencySheet(ss);
  var lastRow = ledger.getLastRow();
  if (lastRow < 2) return null;
  var match = ledger.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(key))
    .matchEntireCell(true)
    .findNext();
  if (!match) return null;
  var raw = ledger.getRange(match.getRow(), 2).getValue();
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    return null;
  }
}

function saveDurableIdempotencyResult(ss, key, response) {
  try {
    var ledger = getDurableIdempotencySheet(ss);
    ledger.appendRow([String(key), JSON.stringify(response), new Date()]);
  } catch (e) {}
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
        map[k] = JSON.parse(String(rows[r][1] || '{}'));
      } catch (e) {
        map[k] = { ok: true };
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
        results[k] = { found: true, response: JSON.parse(String(cachedRaw)), source: 'cache' };
      } catch (err) {
        results[k] = { found: true, response: { ok: true }, source: 'cache' };
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
        results[mk] = { found: true, response: durableMap[mk], source: 'sheet' };
        try {
          cache.put('IDEMP_' + mk, JSON.stringify(durableMap[mk]), 21600);
        } catch (ce) {}
      } else {
        results[mk] = { found: false };
      }
    }
  }

  return results;
}

function saveDurableIdempotencyBatch(ss, entries) {
  if (!entries || entries.length === 0) return;
  try {
    var ledger = getDurableIdempotencySheet(ss);
    var startRow = Math.max(2, ledger.getLastRow() + 1);
    var now = new Date();
    var rows = entries.map(function (entry) {
      return [String(entry.key), JSON.stringify(entry.response), now];
    });
    ledger.getRange(startRow, 1, rows.length, 3).setValues(rows);
  } catch (e) {}
}

function processBatchMutations(batchItems, postStartMs) {
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
    var itemKey = String(rawItem.idempotencyKey || rawItem.id || '').trim();
    if (itemKey) allKeys.push(itemKey);
  }
  var idempStateMap = checkIdempotencyKeys(ss, allKeys);

  // Validate target sheets upfront and collect missing Friday columns per sheet
  var results = new Array(batchItems.length);
  var pendingIndicesBySheet = {};
  for (var idx = 0; idx < batchItems.length; idx++) {
    var item = batchItems[idx] || {};
    var mutKey = String(item.idempotencyKey || item.id || '').trim();
    if (mutKey && idempStateMap[mutKey] && idempStateMap[mutKey].found) {
      var prevResp = idempStateMap[mutKey].response || { ok: true };
      prevResp.deduplicated = true;
      prevResp.mutationId = mutKey;
      results[idx] = prevResp;
      continue;
    }

    var sheetName = String(item.sheet || item.sourceSheet || 'نشط').trim();
    if (APPROVED_SHEETS.indexOf(sheetName) === -1) {
      results[idx] = { ok: false, status: 400, mutationId: mutKey, error: 'اسم الفصل غير معتمد: ' + sheetName };
      continue;
    }
    var itemAction = String(item.action || '').trim().toLowerCase();
    if (itemAction !== 'attendance') {
      results[idx] = { ok: false, status: 400, mutationId: mutKey, error: 'المعالجة المجمعة تدعم عمليات الحضور فقط حالياً' };
      continue;
    }
    if (!pendingIndicesBySheet[sheetName]) pendingIndicesBySheet[sheetName] = [];
    pendingIndicesBySheet[sheetName].push(idx);
  }

  var newIdempotencyEntries = [];
  var cacheBatchToPut = {};
  var currentCairoMonth = Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM');

  var sheetNames = Object.keys(pendingIndicesBySheet);
  for (var sIdx = 0; sIdx < sheetNames.length; sIdx++) {
    var targetSheetName = sheetNames[sIdx];
    var itemIndices = pendingIndicesBySheet[targetSheetName];
    var sheet = ss.getSheetByName(targetSheetName);
    if (!sheet) {
      for (var m = 0; m < itemIndices.length; m++) {
        var rIdx = itemIndices[m];
        results[rIdx] = { ok: false, status: 404, mutationId: String(batchItems[rIdx].idempotencyKey || batchItems[rIdx].id || ''), error: 'التاب مش موجود: ' + targetSheetName };
      }
      continue;
    }

    var values = sheet.getDataRange().getValues();
    if (values.length === 0) {
      for (var m = 0; m < itemIndices.length; m++) {
        var eIdx = itemIndices[m];
        results[eIdx] = { ok: false, status: 500, mutationId: String(batchItems[eIdx].idempotencyKey || batchItems[eIdx].id || ''), error: 'الشيت فارغ' };
      }
      continue;
    }

    var headers = values[0].map(function (h) { return formatHeaderCell(h); });

    // Pre-create all missing Friday columns in this chunk in one pass before applying cells
    var neededFridays = [];
    var seenFridays = {};
    for (var m = 0; m < itemIndices.length; m++) {
      var bItem = batchItems[itemIndices[m]];
      var fDate = String(bItem.date || bItem.friday || (bItem.payload && (bItem.payload.friday || bItem.payload.date)) || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(fDate) && findExactHeaderIndex(headers, fDate) < 0 && !seenFridays[fDate]) {
        seenFridays[fDate] = true;
        neededFridays.push(fDate);
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
      }
      rowVersionMap[r] = (versionCol >= 0) ? (parseInt(values[r][versionCol], 10) || 1) : 1;
    }

    var dirtyRows = {};
    var dirtyCells = []; // [{ rowIndex, colIndex, val }]
    var conflictedRowSet = {};

    for (var m = 0; m < itemIndices.length; m++) {
      var qIdx = itemIndices[m];
      var qItem = batchItems[qIdx];
      var qKey = String(qItem.idempotencyKey || qItem.id || '').trim();

      var friday = String(qItem.date || qItem.friday || (qItem.payload && (qItem.payload.friday || qItem.payload.date)) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(friday)) {
        results[qIdx] = { ok: false, status: 400, mutationId: qKey, error: 'تاريخ غير صحيح' };
        continue;
      }
      var fridayCol = findExactHeaderIndex(headers, friday);
      if (fridayCol < 0) {
        results[qIdx] = { ok: false, status: 500, mutationId: qKey, error: 'تعذر إنشاء عمود التاريخ' };
        continue;
      }

      var qCode = String(qItem.studentCode || qItem.code || '').trim();
      var qId = String(qItem.studentId || '').trim();
      var qName = String(qItem.studentName || qItem.name || '').trim().replace(/\s+/g, ' ');
      var rowIndex = -1;
      if (qCode && byCode[qCode] !== undefined) rowIndex = byCode[qCode];
      else if (qId && byId[qId] !== undefined) rowIndex = byId[qId];
      else if (qName && byName[qName] !== undefined) rowIndex = byName[qName];

      if (rowIndex === -1) {
        results[qIdx] = { ok: false, status: 404, mutationId: qKey, error: 'الاسم غير موجود' };
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
      if (typeof expectedVer === 'number' && isFinite(expectedVer) && expectedVer >= 1 && curVer !== expectedVer) {
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

      var rawPresent = qItem.present !== undefined ? qItem.present : (qItem.isPresent !== undefined ? qItem.isPresent : (qItem.payload && (qItem.payload.isPresent !== undefined ? qItem.payload.isPresent : qItem.payload.present)));
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

      var nextVer = curVer + 1;
      rowVersionMap[rowIndex] = nextVer;
      if (versionCol >= 0) {
        values[rowIndex][versionCol] = nextVer;
      }
      dirtyRows[rowIndex] = true;

      var itemRes = {
        ok: true,
        status: 200,
        row: rowIndex + 1,
        mutationId: qKey,
        studentId: qId,
        newVersion: nextVer,
        action: 'attendance'
      };
      results[qIdx] = itemRes;
      if (qKey) {
        newIdempotencyEntries.push({ key: qKey, response: itemRes });
        cacheBatchToPut['IDEMP_' + qKey] = JSON.stringify(itemRes);
      }
    }

    // Flush modified attendance cells and compute summary columns ONCE per dirty student row
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
          var cv = values[rIndex][c];
          if (cv === 1 || String(cv).trim() === '1' || cv === true) {
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
  var logSheet = ss.getSheetByName('سجل الافتقاد');
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

  var records = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var nameVal = iName >= 0 ? formatCellValue(row[iName]) : '';
    var codeVal = iCode >= 0 ? formatCellValue(row[iCode]) : '';
    if (!nameVal && !codeVal) continue;
    var rawOutcome = iOutcome >= 0 ? formatCellValue(row[iOutcome]) : '';
    var outcomeVal = (rawOutcome === 'تم التواصل' || rawOutcome === 'لم يتم التواصل') ? rawOutcome : undefined;
    records.push({
      id: 'gs_fu_' + (r + 1) + '_' + (codeVal || nameVal).replace(/\s+/g, '_'),
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

function appendFollowupLogRow(ss, sheetName, studentHeaders, studentRow, fridayDate, method, notes, mutationId, callOutcome) {
  var logSheet = ss.getSheetByName('سجل الافتقاد');
  if (!logSheet) return;
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
    logLastColumn = mutationIdCol + 1;
  }
  var outcomeCol = findColIndex(logHeaders, ['نتيجة الاتصال', 'نتيجه الاتصال', 'callOutcome']);
  if (outcomeCol < 0 && callOutcome) {
    outcomeCol = logLastColumn;
    logSheet.getRange(1, outcomeCol + 1).setValue('نتيجة الاتصال');
  }

  var logLastRow = logSheet.getLastRow();
  if (mutationId && logLastRow > 1) {
    var existingMutation = logSheet.getRange(2, mutationIdCol + 1, logLastRow - 1, 1)
      .createTextFinder(String(mutationId))
      .matchEntireCell(true)
      .findNext();
    if (existingMutation) return;
  }

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd');
  var newRow = [
    todayStr,
    fridayDate || todayStr,
    sanitizeFormulaValue(sheetName),
    sanitizeFormulaValue(codeCol >= 0 ? formatCellValue(studentRow[codeCol]) : ''),
    sanitizeFormulaValue(nameCol >= 0 ? formatCellValue(studentRow[nameCol]) : ''),
    sanitizeFormulaValue(servantCol >= 0 ? formatCellValue(studentRow[servantCol]) : ''),
    sanitizeFormulaValue(method || 'تم تليفونياً'),
    sanitizeFormulaValue(notes || '')
  ];
  var targetWidth = Math.max(mutationIdCol + 1, outcomeCol >= 0 ? outcomeCol + 1 : 0);
  while (newRow.length < targetWidth) newRow.push('');
  newRow[mutationIdCol] = mutationId || '';
  if (outcomeCol >= 0 && callOutcome) {
    newRow[outcomeCol] = sanitizeFormulaValue(callOutcome);
  }
  logSheet.appendRow(newRow);
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
