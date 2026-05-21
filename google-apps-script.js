const SHEET_NAME = 'reservations';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const action = payload.action || 'list';

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (action === 'list') {
        return jsonResponse({ ok: true, reservations: listReservations() });
      }

      if (action === 'reserve') {
        return jsonResponse(reserveGift(payload));
      }

      if (action === 'unreserve') {
        return jsonResponse(unreserveGift(payload));
      }

      return jsonResponse({ ok: false, error: 'Unknown action' });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error) });
  }
}

function getSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow(['gift_id', 'name', 'device_id', 'updated_at']);
  }

  return sheet;
}

function listReservations() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1);

  return rows
    .filter((row) => row[0] !== '')
    .map((row) => ({
      gift_id: Number(row[0]),
      name: row[1] || 'Аноним',
      device_id: row[2] || '',
      updated_at: row[3] || ''
    }));
}

function reserveGift(payload) {
  const giftId = Number(payload.gift_id);
  const name = String(payload.name || 'Аноним').slice(0, 30);
  const deviceId = String(payload.device_id || '');

  if (!giftId) return { ok: false, error: 'gift_id is required' };

  const sheet = getSheet();
  const rowIndex = findGiftRow(sheet, giftId);

  if (rowIndex) {
    const currentDeviceId = String(sheet.getRange(rowIndex, 3).getValue() || '');
    if (currentDeviceId && currentDeviceId !== deviceId) {
      return { ok: false, error: 'Gift is already reserved' };
    }

    sheet.getRange(rowIndex, 2, 1, 3).setValues([[name, deviceId, new Date()]]);
  } else {
    sheet.appendRow([giftId, name, deviceId, new Date()]);
  }

  return { ok: true };
}

function unreserveGift(payload) {
  const giftId = Number(payload.gift_id);
  const deviceId = String(payload.device_id || '');

  if (!giftId) return { ok: false, error: 'gift_id is required' };

  const sheet = getSheet();
  const rowIndex = findGiftRow(sheet, giftId);
  if (!rowIndex) return { ok: true };

  const currentDeviceId = String(sheet.getRange(rowIndex, 3).getValue() || '');
  if (currentDeviceId && currentDeviceId !== deviceId) {
    return { ok: false, error: 'Only the same browser can cancel this reservation' };
  }

  sheet.deleteRow(rowIndex);
  return { ok: true };
}

function findGiftRow(sheet, giftId) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (Number(values[i][0]) === giftId) return i + 1;
  }
  return null;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
