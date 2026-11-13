/**
 * St. George Church Dashboard — Secure Google Apps Script Relay (Code.gs)
 * -------------------------------------------------------------------
 * Deployed as a Web App under the Google Sheet owner's account:
 * - Execute as: Me (Owner) -> Keeps Google Sheet 100% PRIVATE (no public sharing!)
 * - Direct service mode (NO servant username/password screen required),
 *   protected by mandatory RELAY_KEY stored in Google ScriptProperties
 *   + APPROVED_SHEETS allowlist + LockService + Idempotency + OCC 409 + Zero Delete (403).
 *
 * Script Properties (Project Settings -> Script Properties):
 *   SPREADSHEET_ID = "15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0"
 *   RELAY_KEY      = Required high-entropy relay secret configured by owner
 */

var APPROVED_SHEETS = ['نشط', 'غير حاضر', 'فصل البابا شنودة', 'غير نشط'];
var ALL_SHEETS_SENTINEL = '__ALL__';

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SPREADSHEET_ID');
  if (!sheetId) throw new Error('SPREADSHEET_ID not configured in ScriptProperties');
  return SpreadsheetApp.openById(sheetId);
}

function verifyRelayKey(providedKey) {
  var props = PropertiesService.getScriptProperties();
  var expectedKey = props.getProperty('RELAY_KEY');
  if (!expectedKey || String(expectedKey).trim().length < 32) {
    // Fail closed: an unconfigured/weak relay key must never expose sheet data.
    return { valid: false, error: 'Relay unavailable: configure a strong RELAY_KEY in Script Properties' };
  }
  if (!providedKey || String(providedKey).trim() !== String(expectedKey).trim()) {
    return { valid: false, error: 'Unauthorized: invalid or missing RELAY_KEY' };
  }
  return { valid: true };
}

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'health';
    if (action === 'health') {
      return jsonResponse({
        status: 'ok',
        mode: 'google_apps_script_relay',
        timestamp: new Date().toISOString()
      });
    }

    var keyCheck = verifyRelayKey(e && e.parameter && e.parameter.relayKey);
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
        if (nameCol === -1) continue; // Skip placeholder/empty form tabs cleanly

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

    return jsonResponse({ ok: false, status: 400, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, status: 500, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var keyCheck = verifyRelayKey(body.relayKey || (e && e.parameter && e.parameter.relayKey));
    if (!keyCheck.valid) {
      return jsonResponse({ ok: false, status: 401, error: keyCheck.error });
    }

    var mutation = body.mutation || body;
    var idempotencyKey = mutation.id || body.idempotencyKey;
    if (!idempotencyKey) {
      return jsonResponse({ ok: false, status: 400, error: 'X-Idempotency-Key required' });
    }

    var cache = CacheService.getScriptCache();
    var cached = cache.get('IDEMP_' + idempotencyKey);
    if (cached) {
      var prev = JSON.parse(cached);
      prev.deduplicated = true;
      return jsonResponse(prev);
    }

    if (mutation.action === 'delete') {
      return jsonResponse({ ok: false, status: 403, error: 'حذف المخدومين محظور نهائياً' });
    }

    var ss = getSpreadsheet();
    var targetSheetName = mutation.sourceSheet || 'نشط';
    if (APPROVED_SHEETS.indexOf(targetSheetName) === -1) {
      return jsonResponse({ ok: false, status: 400, error: 'اسم الفصل غير معتمد: ' + targetSheetName });
    }

    var sheet = ss.getSheetByName(targetSheetName);
    if (!sheet) {
      return jsonResponse({ ok: false, status: 404, error: 'الفصل غير موجود في الملف: ' + targetSheetName });
    }

    var values = sheet.getDataRange().getValues();
    var headers = values[0].map(function (h) { return formatHeaderCell(h); });
    var idCol = findColIndex(headers, ['id', 'ID', 'كود', 'الكود', 'code']);
    var nameLookupCol = findColIndex(headers, ['الاسم', 'name', 'Name']);
    var versionCol = findColIndex(headers, ['version', 'الإصدار']);

    var rowIndex = -1;
    for (var r = 1; r < values.length; r++) {
      var cellVal = idCol >= 0 ? String(values[r][idCol] || '').trim() : '';
      var rowNameVal = nameLookupCol >= 0 ? String(values[r][nameLookupCol] || '').trim() : '';
      if (
        (cellVal && (cellVal === String(mutation.studentId || '').trim() || cellVal === String(mutation.studentCode || '').trim())) ||
        (rowNameVal && mutation.studentName && rowNameVal === String(mutation.studentName).trim())
      ) {
        rowIndex = r;
        break;
      }
    }

    if (mutation.action !== 'add' && rowIndex === -1) {
      return jsonResponse({ ok: false, status: 404, error: 'المخدوم غير موجود في الشيت' });
    }

    var currentVersion = (rowIndex !== -1 && versionCol >= 0) ? (parseInt(values[rowIndex][versionCol], 10) || 1) : 1;
    if (rowIndex !== -1 && typeof mutation.expectedVersion === 'number' && currentVersion > mutation.expectedVersion) {
      return jsonResponse({
        ok: false,
        status: 409,
        error: 'تعارض في التعديل المتزامن (409): نسخة السيرفر (' + currentVersion + ') أحدث من نسختك (' + mutation.expectedVersion + ')'
      });
    }

    var nextVersion = mutation.action === 'add' ? 1 : currentVersion + 1;
    var payload = mutation.payload || {};

    if (mutation.action === 'add') {
      var newRow = headers.map(function (h) {
        if (h === 'كود' || h.indexOf('الكود') !== -1 || h.toLowerCase() === 'code') return payload.code || mutation.studentCode || '';
        if (h.indexOf('الاسم') !== -1 || h.toLowerCase() === 'name') return payload.name || mutation.studentName || '';
        if (h.indexOf('الاشبين') !== -1 || h.indexOf('الأشبين') !== -1 || h.indexOf('الخادم') !== -1 || h.toLowerCase() === 'servant') return payload.servant || '';
        if (h.indexOf('موبيال المخدوم') !== -1 || h.indexOf('موبايل المخدوم') !== -1 || h.indexOf('موبايل الطالب') !== -1 || h.indexOf('تليفون الطالب') !== -1) return payload.phoneStudent || '';
        if (h.indexOf('ولي الامر 1') !== -1 || h.indexOf('ولي الأمر 1') !== -1) return payload.phoneParent1 || '';
        if (h.indexOf('ولي الامر 2') !== -1 || h.indexOf('ولي الأمر 2') !== -1) return payload.phoneParent2 || '';
        if (h.indexOf('تاريخ الميلاد') !== -1) return payload.birthDate || '';
        if (h === 'منطقة' || h.indexOf('المنطقة') !== -1) return payload.area || '';
        if (h.indexOf('العنوان') !== -1) return payload.address || '';
        if (h.indexOf('ملاحظات') !== -1) return payload.notes || '';
        if (h.indexOf('حالة الافتقاد') !== -1) return payload.followupStatus || 'بدون';
        if (h.toLowerCase() === 'id') return mutation.studentId || '';
        if (h.toLowerCase() === 'version' || h.indexOf('الإصدار') !== -1) return 1;
        return '';
      });
      sheet.appendRow(newRow);
    } else if (rowIndex !== -1) {
      var rowNum = rowIndex + 1;
      if (versionCol >= 0) {
        sheet.getRange(rowNum, versionCol + 1).setValue(nextVersion);
      }
      if (mutation.action === 'attendance') {
        var friday = String(payload.friday || payload.date || '');
        var normalizedAttendance = String(payload.isPresent).trim().toLowerCase();
        var isPresent = payload.isPresent === true || ['1', 'true', 'present', 'حاضر'].indexOf(normalizedAttendance) !== -1;
        if (!friday) {
          return jsonResponse({ ok: false, status: 400, error: 'تاريخ الجمعة مطلوب لتسجيل الحضور' });
        }

        var fridayCol = findExactHeaderIndex(headers, friday);
        if (fridayCol < 0) {
          return jsonResponse({ ok: false, status: 400, error: 'عمود تاريخ الجمعة غير موجود في الشيت: ' + friday });
        }

        // Calculate the delta from the previously stored value. Replaying the same
        // attendance mutation must not increment/decrement totals a second time.
        var previousAttendance = String(values[rowIndex][fridayCol] || '').trim().toLowerCase();
        var wasPresent = ['1', 'true', 'present', 'حاضر'].indexOf(previousAttendance) !== -1;
        var attendanceDelta = (isPresent ? 1 : 0) - (wasPresent ? 1 : 0);

        sheet.getRange(rowNum, fridayCol + 1).setValue(isPresent ? '1' : '0');
        if (isPresent) {
          setIfFound(sheet, rowNum, headers, ['آخر حضور', 'اخر حضور'], friday);
        }

        var totalCol = findColIndex(headers, ['إجمالي الحضور', 'اجمالي الحضور', 'attendanceTotal']);
        var monthCol = findColIndex(headers, ['حضور الشهر', 'attendanceMonth']);
        var statusCol = findColIndex(headers, ['الحالة', 'attendanceStatus']);
        if (statusCol >= 0) sheet.getRange(rowNum, statusCol + 1).setValue(isPresent ? 'حاضر' : 'غائب');
        if (attendanceDelta !== 0 && totalCol >= 0) {
          var prevTotal = parseInt(values[rowIndex][totalCol] || '0', 10) || 0;
          sheet.getRange(rowNum, totalCol + 1).setValue(Math.max(0, prevTotal + attendanceDelta));
        }
        if (attendanceDelta !== 0 && monthCol >= 0) {
          var prevMonth = parseInt(values[rowIndex][monthCol] || '0', 10) || 0;
          sheet.getRange(rowNum, monthCol + 1).setValue(Math.max(0, prevMonth + attendanceDelta));
        }
      } else if (mutation.action === 'followup') {
        var fuDate = String(payload.friday || payload.date || '');
        var fuMethod = payload.method || 'تم تليفونياً';
        if (fuDate) {
          var fuDateCol = findExactHeaderIndex(headers, 'افتقاد ' + fuDate);
          if (fuDateCol >= 0) {
            sheet.getRange(rowNum, fuDateCol + 1).setValue(fuMethod);
          }
          setIfFound(sheet, rowNum, headers, ['آخر افتقاد', 'اخر افتقاد'], fuDate);
        }
        setIfFound(sheet, rowNum, headers, ['حالة الافتقاد', 'ملاحظات الافتقاد', 'followupStatus'], fuMethod);
        appendFollowupLogRow(ss, targetSheetName, headers, values[rowIndex], fuDate, fuMethod, payload.notes || '');
      } else if (mutation.action === 'update') {
        setIfFound(sheet, rowNum, headers, ['الاسم', 'name'], payload.name);
        setIfFound(sheet, rowNum, headers, ['كود', 'الكود', 'code'], payload.code);
        setIfFound(sheet, rowNum, headers, ['الاشبين', 'الأشبين', 'الخادم', 'servant'], payload.servant);
        setIfFound(sheet, rowNum, headers, ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب'], payload.phoneStudent);
        setIfFound(sheet, rowNum, headers, ['موبيل ولي الامر 1', 'ولي الأمر 1'], payload.phoneParent1);
        setIfFound(sheet, rowNum, headers, ['موبيل ولي الامر 2', 'ولي الأمر 2'], payload.phoneParent2);
        setIfFound(sheet, rowNum, headers, ['تاريخ الميلاد'], payload.birthDate);
        setIfFound(sheet, rowNum, headers, ['منطقة', 'المنطقة'], payload.area);
        setIfFound(sheet, rowNum, headers, ['العنوان'], payload.address);
        setIfFound(sheet, rowNum, headers, ['ملاحظات الافتقاد', 'ملاحظات'], payload.notes);
      }
    }

    var successPayload = {
      ok: true,
      status: 200,
      mutationId: idempotencyKey,
      studentId: mutation.studentId,
      newVersion: nextVersion,
      action: mutation.action
    };

    cache.put('IDEMP_' + idempotencyKey, JSON.stringify(successPayload), 21600);
    return jsonResponse(successPayload);
  } catch (err) {
    return jsonResponse({ ok: false, status: 500, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function setIfFound(sheet, rowNum, headers, colNames, value) {
  if (value === undefined) return;
  var col = findColIndex(headers, colNames);
  if (col >= 0) {
    sheet.getRange(rowNum, col + 1).setValue(value);
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

function appendFollowupLogRow(ss, sheetName, studentHeaders, studentRow, fridayDate, method, notes) {
  var logSheet = ss.getSheetByName('سجل الافتقاد');
  if (!logSheet) return;
  var codeCol = findColIndex(studentHeaders, ['كود', 'الكود', 'code']);
  var nameCol = findColIndex(studentHeaders, ['الاسم', 'name']);
  var servantCol = findColIndex(studentHeaders, ['الاشبين', 'الأشبين', 'الخادم', 'servant']);
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd');
  logSheet.appendRow([
    todayStr,
    fridayDate || todayStr,
    sheetName,
    codeCol >= 0 ? formatCellValue(studentRow[codeCol]) : '',
    nameCol >= 0 ? formatCellValue(studentRow[nameCol]) : '',
    servantCol >= 0 ? formatCellValue(studentRow[servantCol]) : '',
    method || 'تم تليفونياً',
    notes || ''
  ]);
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
