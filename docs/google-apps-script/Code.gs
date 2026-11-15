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

    // Health check returns exact signature expected by both systems
    if (action === 'health' || !e || !e.parameter || !e.parameter.action) {
      return jsonResponse({
        ok: true,
        status: 'ok',
        msg: 'Apps Script شغال',
        version: 'notes-v2',
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

    return jsonResponse({ ok: false, status: 400, error: 'action غير معروف' });
  } catch (err) {
    return jsonResponse({ ok: false, status: 500, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
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
    var allowedActions = ['add', 'update', 'attendance', 'followup', 'delete'];
    var action = String(body.action || mutation.action || '').trim().toLowerCase();
    if (!action || allowedActions.indexOf(action) === -1) {
      return jsonResponse({ ok: false, status: 400, error: 'action غير معروف' });
    }

    if (action === 'delete') {
      return jsonResponse({ ok: false, status: 403, error: 'حذف المخدومين محظور نهائياً' });
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
      appendFollowupLogRow(ss, targetSheetName, headers, values[rowIndex], todayStr, fuMethod, fuNotes, idempotencyKey);

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
  var iNotes = findColIndex(headers, ['ملاحظات', 'ملا حظات']);

  var records = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var nameVal = iName >= 0 ? formatCellValue(row[iName]) : '';
    var codeVal = iCode >= 0 ? formatCellValue(row[iCode]) : '';
    if (!nameVal && !codeVal) continue;
    records.push({
      id: 'gs_fu_' + (r + 1) + '_' + (codeVal || nameVal).replace(/\s+/g, '_'),
      date: iDate >= 0 ? formatCellValue(row[iDate]) : '',
      fridayDate: iFriday >= 0 ? formatCellValue(row[iFriday]) : '',
      studentId: codeVal || nameVal,
      studentCode: codeVal,
      studentName: nameVal,
      servant: iServant >= 0 ? formatCellValue(row[iServant]) : '',
      type: (iType >= 0 ? formatCellValue(row[iType]) : '') || 'بدون',
      notes: iNotes >= 0 ? formatCellValue(row[iNotes]) : ''
    });
  }
  return records;
}

function appendFollowupLogRow(ss, sheetName, studentHeaders, studentRow, fridayDate, method, notes, mutationId) {
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
  while (newRow.length <= mutationIdCol) newRow.push('');
  newRow[mutationIdCol] = mutationId || '';
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
