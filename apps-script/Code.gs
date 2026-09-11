/**
 * Kosh — Apps Script backend
 * =============================
 * Turns your FY planning Google Sheets into a tiny JSON API for the Kosh PWA.
 *
 * The sheet stays the single source of truth. This script only reads cells,
 * adds amounts into month cells, appends notes, and keeps an audit log in a
 * "_AppLog" tab inside each FY spreadsheet.
 *
 * SETUP (see SETUP.md in the repo for screenshots-level detail):
 *  1. Go to script.google.com → New project → paste this whole file.
 *  2. Replace SHARED_TOKEN below with your own secret (any long random text).
 *  3. Deploy → New deployment → type "Web app"
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  4. Copy the Web app URL into the app's setup screen along with your token.
 *
 * Sheet layout expectations (label-anchored, so row numbers may drift):
 *  - "Funds" section: income rows until a row labelled "Total"
 *  - "Monthly Fixed Expenses (known)": rows until first blank label
 *  - "Monthly Variable Expenses (known)": header row with months in D..O,
 *     category rows until "Total known expenses", then "Savings from monthly expenses"
 *  - "Large expenses/Investments": rows until "Total unknown expenses"
 *     (rows with a blank label — e.g. the repeated month header — are skipped)
 *  - Bottom summary rows: "Total expenses", "Total income", "Remaining", "Emergency"
 */

// ─── configuration ──────────────────────────────────────────────────────────
var SHARED_TOKEN = 'CHANGE_ME_to_a_long_random_secret';

// Known FY spreadsheets. Discovery also searches Drive for files whose name
// matches /FY\d+/ + "Planning", so new FY files are picked up automatically.
var KNOWN_FYS = {
  'FY27': '16Vi-MFXjRknsbupGWVo5cueU_2i93LPST34Jhyo-NLo'
};

var VERSION = '1.1.0';
var MONTH_COL_START = 4;   // column D
var MONTH_COUNT = 12;      // D..O = Apr..Mar
var SCAN_ROWS = 80;        // how many rows to scan for sections
var LOG_SHEET = '_AppLog';

// ─── HTTP entry points ──────────────────────────────────────────────────────
function doGet(e) {
  return respond({ ok: true, data: { pong: true, version: VERSION } });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return respond({ ok: false, error: 'Bad JSON body' }); }

  if (!req || req.token !== SHARED_TOKEN) {
    return respond({ ok: false, error: 'Invalid token' });
  }
  try {
    var out;
    switch (req.action) {
      case 'ping':        out = { pong: true, version: VERSION }; break;
      case 'fys':         out = listFYs(); break;
      case 'get':         out = getModel(req.fyId); break;
      case 'addVariable': out = writeMonthCell(req, 'variable'); break;
      case 'addLarge':    out = writeMonthCell(req, 'large'); break;
      case 'setNote':     out = setNote(req); break;
      case 'setValue':    out = setValue(req); break;
      case 'log':         out = readLog(req); break;
      case 'addRow':      out = addRow(req); break;
      case 'renameRow':   out = renameRow(req); break;
      case 'deleteRow':   out = deleteRowAction(req); break;
      default: return respond({ ok: false, error: 'Unknown action: ' + req.action });
    }
    return respond({ ok: true, data: out });
  } catch (err) {
    return respond({ ok: false, error: String(err && err.message || err) });
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── FY discovery ───────────────────────────────────────────────────────────
function listFYs() {
  var map = {};
  Object.keys(KNOWN_FYS).forEach(function (label) {
    map[label] = { label: label, id: KNOWN_FYS[label], name: label };
  });
  try {
    var it = DriveApp.searchFiles(
      "title contains 'Planning' and mimeType = 'application/vnd.google-apps.spreadsheet'");
    while (it.hasNext()) {
      var f = it.next();
      var m = f.getName().match(/FY\s?(\d{2,4})/i);
      if (m) {
        var label = 'FY' + m[1];
        map[label] = { label: label, id: f.getId(), name: f.getName() };
      }
    }
  } catch (e) { /* Drive scope missing — fall back to KNOWN_FYS */ }
  var fys = Object.keys(map).map(function (k) { return map[k]; });
  fys.sort(function (a, b) { return b.label.localeCompare(a.label); });
  return { fys: fys };
}

function openFY(fyId) {
  if (!fyId) throw new Error('fyId missing');
  var ss = SpreadsheetApp.openById(fyId);
  return { ss: ss, sheet: ss.getSheets()[0] };
}

// ─── model ──────────────────────────────────────────────────────────────────
function getModel(fyId) {
  var o = openFY(fyId), sheet = o.sheet;
  var rng = sheet.getRange(1, 1, SCAN_ROWS, MONTH_COL_START - 1 + MONTH_COUNT);
  var vals = rng.getValues();
  var formulas = rng.getFormulas();
  var notes = rng.getNotes();

  function label(r) { return String(vals[r][0] || '').trim(); }
  function findRow(txt) {
    for (var r = 0; r < vals.length; r++)
      if (label(r).toLowerCase() === txt.toLowerCase()) return r;
    return -1;
  }
  function num(v) { return (typeof v === 'number') ? v : (v === '' || v == null ? null : Number(v) || 0); }
  function monthCells(r) {
    var out = [];
    for (var c = 0; c < MONTH_COUNT; c++) out.push(num(vals[r][MONTH_COL_START - 1 + c]));
    return out;
  }

  // Funds
  var funds = [], fundsTotal = null;
  var rFunds = findRow('Funds');
  if (rFunds >= 0) {
    for (var r = rFunds + 1; r < vals.length; r++) {
      if (label(r).toLowerCase() === 'total') { fundsTotal = num(vals[r][1]); break; }
      if (!label(r)) break;
      funds.push({ row: r + 1, label: label(r), value: num(vals[r][1]),
                   locked: !!formulas[r][1] });
    }
  }

  // Fixed
  var fixed = [];
  var rFixed = findRow('Monthly Fixed Expenses (known)');
  if (rFixed >= 0) {
    for (var r2 = rFixed + 1; r2 < vals.length && label(r2); r2++) {
      fixed.push({ row: r2 + 1, label: label(r2),
                   total: num(vals[r2][1]), monthly: num(vals[r2][2]),
                   totalLocked: !!formulas[r2][1], monthlyLocked: !!formulas[r2][2] });
    }
  }

  // Variable
  var months = [];
  var variable = { rows: [], totalCells: null, totalBudget: null, savingsCells: null, headerRow: null };
  var rVar = findRow('Monthly Variable Expenses (known)');
  if (rVar >= 0) {
    variable.headerRow = rVar + 1;
    for (var c = 0; c < MONTH_COUNT; c++) months.push(String(vals[rVar][MONTH_COL_START - 1 + c] || '').trim());
    for (var r3 = rVar + 1; r3 < vals.length; r3++) {
      var L = label(r3);
      if (!L) continue;
      if (/^total known/i.test(L)) {
        variable.totalCells = monthCells(r3);
        variable.totalBudget = num(vals[r3][2]);
        variable.totalYear = num(vals[r3][1]);
        // savings row usually right after
        if (r3 + 1 < vals.length && /^savings/i.test(label(r3 + 1)))
          variable.savingsCells = monthCells(r3 + 1);
        break;
      }
      variable.rows.push({ row: r3 + 1, label: L, total: num(vals[r3][1]),
                           monthly: num(vals[r3][2]), cells: monthCells(r3) });
    }
  }

  // Large
  var large = { rows: [], totalYear: null };
  var rLarge = findRow('Large expenses/Investments');
  if (rLarge >= 0) {
    for (var r4 = rLarge + 1; r4 < vals.length; r4++) {
      var L2 = label(r4);
      if (!L2) continue;                              // skip repeated month header rows
      if (/^total unknown/i.test(L2)) { large.totalYear = num(vals[r4][1]); break; }
      var cells = [];
      for (var c2 = 0; c2 < MONTH_COUNT; c2++) {
        cells.push({ v: num(vals[r4][MONTH_COL_START - 1 + c2]),
                     note: notes[r4][MONTH_COL_START - 1 + c2] || '' });
      }
      large.rows.push({ row: r4 + 1, label: L2, total: num(vals[r4][1]),
                        totalLocked: !!formulas[r4][1], cells: cells });
    }
  }

  // Bottom summary
  var summary = [];
  ['Total expenses', 'Savings from monthly expenses', 'Total income', 'Remaining', 'Emergency']
    .forEach(function (t) {
      for (var r5 = (rLarge >= 0 ? rLarge : 0); r5 < vals.length; r5++) {
        if (label(r5).toLowerCase() === t.toLowerCase()) {
          summary.push({ label: t, value: num(vals[r5][1]) }); return;
        }
      }
    });

  return {
    fy: { id: fyId, name: o.ss.getName() },
    months: months,
    funds: { rows: funds, total: fundsTotal },
    fixed: fixed,
    variable: variable,
    large: large,
    summary: summary,
    fetchedAt: new Date().toISOString()
  };
}

// ─── writes ─────────────────────────────────────────────────────────────────
function writeMonthCell(req, section) {
  var row = Number(req.row), month = Number(req.month), amount = Number(req.amount);
  if (!row || isNaN(month) || month < 0 || month >= MONTH_COUNT) throw new Error('Bad row/month');
  if (isNaN(amount)) throw new Error('Bad amount');
  var mode = req.mode === 'set' ? 'set' : 'add';

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = openFY(req.fyId), sheet = o.sheet;
    var cell = sheet.getRange(row, MONTH_COL_START + month);
    if (cell.getFormula()) throw new Error('That cell contains a formula — edit it in the sheet.');
    var prev = Number(cell.getValue()) || 0;
    var next = mode === 'add' ? prev + amount : amount;
    cell.setValue(next);

    if (req.note) {
      var existing = cell.getNote();
      var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM');
      var line = req.note + ' (₹' + amount + ', ' + stamp + ')';
      cell.setNote(existing ? existing + '\n' + line : line);
    }

    var catLabel = String(sheet.getRange(row, 1).getValue() || '');
    var monthLabel = monthName(sheet, month);
    appendLog(o.ss, [new Date(), section, catLabel, monthLabel, amount, mode, req.note || '', prev, next]);
    SpreadsheetApp.flush();
    return { row: row, month: month, prev: prev, value: next,
             note: cell.getNote() || '', category: catLabel };
  } finally { lock.releaseLock(); }
}

function setNote(req) {
  var o = openFY(req.fyId);
  var cell = o.sheet.getRange(Number(req.row), MONTH_COL_START + Number(req.month));
  cell.setNote(req.note || '');
  SpreadsheetApp.flush();
  return { note: cell.getNote() || '' };
}

function setValue(req) {
  var col = req.col === 'C' ? 3 : 2;      // B = total/amount, C = monthly
  var row = Number(req.row), value = Number(req.value);
  if (!row || isNaN(value)) throw new Error('Bad row/value');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = openFY(req.fyId), sheet = o.sheet;
    var cell = sheet.getRange(row, col);
    if (cell.getFormula()) throw new Error('That cell contains a formula — edit it in the sheet.');
    var prev = Number(cell.getValue()) || 0;
    cell.setValue(value);
    var catLabel = String(sheet.getRange(row, 1).getValue() || '');
    appendLog(o.ss, [new Date(), 'fixed', catLabel, (req.col === 'C' ? 'monthly' : 'total'),
                     value, 'set', req.note || '', prev, value]);
    SpreadsheetApp.flush();
    return { row: row, col: req.col, prev: prev, value: value, category: catLabel };
  } finally { lock.releaseLock(); }
}

// ─── log ────────────────────────────────────────────────────────────────────
function logSheet(ss) {
  var sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.appendRow(['When', 'Section', 'Category', 'Month', 'Amount', 'Mode', 'Note', 'Prev', 'New']);
    sh.hideSheet();
  }
  return sh;
}

function appendLog(ss, rowVals) {
  try { logSheet(ss).appendRow(rowVals); } catch (e) { /* logging must never block a write */ }
}

function readLog(req) {
  var o = openFY(req.fyId);
  var sh = o.ss.getSheetByName(LOG_SHEET);
  if (!sh) return { entries: [] };
  var last = sh.getLastRow();
  var n = Math.min(Number(req.limit) || 15, 50);
  if (last < 2) return { entries: [] };
  var start = Math.max(2, last - n + 1);
  var vals = sh.getRange(start, 1, last - start + 1, 9).getValues();
  var entries = vals.map(function (v) {
    return { when: (v[0] instanceof Date) ? v[0].toISOString() : String(v[0]),
             section: v[1], category: v[2], month: v[3], amount: v[4],
             mode: v[5], note: v[6], prev: v[7], value: v[8] };
  }).reverse();
  return { entries: entries };
}

// ─── structural edits: add / rename / delete category rows ──────────────────
/**
 * Locate each section's first and last *category* row (1-based, inclusive).
 * Rows with a blank label (spacers, the repeated month header) are skipped.
 */
function sections(sheet) {
  var colA = sheet.getRange(1, 1, SCAN_ROWS, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); });
  function find(txt) {
    for (var i = 0; i < colA.length; i++)
      if (colA[i].toLowerCase() === txt.toLowerCase()) return i + 1;
    return -1;
  }
  // stopRe: label that ends the block. stopOnBlank: does an empty row end it?
  function block(headerRow, stopRe, stopOnBlank) {
    if (headerRow < 0) return null;
    var first = headerRow + 1, last = first - 1;
    for (var r = first; r <= SCAN_ROWS; r++) {
      var L = colA[r - 1];
      if (!L) { if (stopOnBlank) break; continue; }   // large/variable have spacer rows
      if (stopRe && stopRe.test(L)) break;
      last = r;
    }
    return { first: first, last: last };
  }
  return {
    funds:    block(find('Funds'), /^total$/i, true),
    fixed:    block(find('Monthly Fixed Expenses (known)'), null, true),
    variable: block(find('Monthly Variable Expenses (known)'), /^total known/i, false),
    large:    block(find('Large expenses/Investments'), /^total unknown/i, false)
  };
}

/**
 * Add a category at the end of a section.
 *
 * The new row is inserted *inside* the existing block (not after it) so that
 * every SUM range in the sheet — including the cross-section totals — expands
 * on its own. The old last row is then copied up into the gap and the trailing
 * row is repurposed, which leaves the new category visually last without ever
 * rewriting one of your formulas.
 */
function addRow(req) {
  var label = String(req.label || '').trim();
  if (!label) throw new Error('Name is required');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = openFY(req.fyId), sheet = o.sheet;
    var sec = sections(sheet)[req.section];
    if (!sec) throw new Error('Unknown section: ' + req.section);
    if (sec.last < sec.first) throw new Error('That section is empty — add the first row in the sheet');

    var width = MONTH_COL_START - 1 + MONTH_COUNT;
    var last = sec.last;

    sheet.insertRowBefore(last);                                   // blank row lands at `last`
    sheet.getRange(last + 1, 1, 1, width)
         .copyTo(sheet.getRange(last, 1, 1, width));               // old last row moves up
    var target = sheet.getRange(last + 1, 1, 1, width);            // repurpose the trailing row
    sheet.getRange(last + 1, 3, 1, MONTH_COUNT + 1).clearContent(); // C..O
    target.clearNote();
    if (!sheet.getRange(last + 1, 2).getFormula())                 // keep B only if it's a formula
      sheet.getRange(last + 1, 2).clearContent();
    sheet.getRange(last + 1, 1).setValue(label);

    SpreadsheetApp.flush();
    appendLog(o.ss, [new Date(), req.section, label, '—', '', 'add-category', '', '', '']);
    return getModel(req.fyId);
  } finally { lock.releaseLock(); }
}

function renameRow(req) {
  var label = String(req.label || '').trim();
  if (!label) throw new Error('Name is required');
  var o = openFY(req.fyId), sheet = o.sheet;
  var cell = sheet.getRange(Number(req.row), 1);
  var prev = String(cell.getValue() || '');
  cell.setValue(label);
  SpreadsheetApp.flush();
  appendLog(o.ss, [new Date(), req.section || '', prev + ' → ' + label, '—', '', 'rename', '', '', '']);
  return getModel(req.fyId);
}

/**
 * Delete a category row. Google Sheets shrinks the SUM ranges that covered it,
 * so totals stay correct. Refuses to remove the last row of a section, which
 * would leave those ranges with nothing to point at.
 */
function deleteRowAction(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = openFY(req.fyId), sheet = o.sheet;
    var sec = sections(sheet)[req.section];
    if (!sec) throw new Error('Unknown section: ' + req.section);
    var row = Number(req.row);
    if (row < sec.first || row > sec.last) throw new Error('That row is not in this section');

    var labels = sheet.getRange(sec.first, 1, sec.last - sec.first + 1, 1).getValues()
      .map(function (r) { return String(r[0] || '').trim(); })
      .filter(function (s) { return s; });
    if (labels.length <= 1) throw new Error('Can\u2019t remove the only category in a section');

    var label = String(sheet.getRange(row, 1).getValue() || '');
    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    appendLog(o.ss, [new Date(), req.section, label, '—', '', 'delete-category', '', '', '']);
    return getModel(req.fyId);
  } finally { lock.releaseLock(); }
}

function monthName(sheet, monthIdx) {
  // find the variable header row to read the month label
  var colA = sheet.getRange(1, 1, SCAN_ROWS, 1).getValues();
  for (var r = 0; r < colA.length; r++) {
    if (String(colA[r][0]).trim() === 'Monthly Variable Expenses (known)') {
      return String(sheet.getRange(r + 1, MONTH_COL_START + monthIdx).getValue() || '');
    }
  }
  return String(monthIdx);
}
