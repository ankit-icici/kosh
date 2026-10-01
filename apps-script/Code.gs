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

var VERSION = '1.5.0';
var MONTH_COL_START = 4;   // column D
var MONTH_COUNT = 12;      // D..O = Apr..Mar
var SCAN_MIN = 80;         // scan at least this many rows; more if the tab is longer
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
      case 'get':         out = getModel(req.fyId, req.tab); break;
      case 'addVariable': out = writeMonthCell(req, 'variable'); break;
      case 'addLarge':    out = writeMonthCell(req, 'large'); break;
      case 'setNote':     out = setNote(req); break;
      case 'setValue':    out = setValue(req); break;
      case 'log':         out = readLog(req); break;
      case 'addRow':      out = addRow(req); break;
      case 'renameRow':   out = renameRow(req); break;
      case 'deleteRow':   out = deleteRowAction(req); break;
      case 'fillFormulas': out = fillFormulasAction(req); break;
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
/**
 * Discover financial years. A year can be either
 *   • its own spreadsheet   — a Drive file whose name contains "FY27", "FY28"… , or
 *   • a tab inside one      — a sheet named "FY27", "FY28"… in any of those files.
 * Both are listed together, so you can start with one file per year and later
 * switch to tabs (or mix) without touching this script.
 */
function listFYs() {
  var map = {};
  function add(label, id, tab, name) {
    if (!map[label]) map[label] = { label: label, id: id, tab: tab || null, name: name };
  }

  var files = [];
  Object.keys(KNOWN_FYS).forEach(function (label) {
    files.push({ id: KNOWN_FYS[label], name: label });
  });
  try {
    var it = DriveApp.searchFiles(
      "title contains 'Planning' and mimeType = 'application/vnd.google-apps.spreadsheet'");
    while (it.hasNext()) {
      var f = it.next();
      if (/FY\s?\d{2,4}/i.test(f.getName())) files.push({ id: f.getId(), name: f.getName() });
    }
  } catch (e) { /* Drive scope missing — fall back to KNOWN_FYS */ }

  var seen = {};
  files.forEach(function (f) {
    if (seen[f.id]) return;
    seen[f.id] = true;
    var ss, sheets;
    try { ss = SpreadsheetApp.openById(f.id); sheets = ss.getSheets(); }
    catch (e) { return; }
    var title = ss.getName();

    // tabs named after a financial year
    sheets.forEach(function (sh) {
      var m = sh.getName().match(/FY\s?(\d{2,4})/i);
      if (m) add('FY' + m[1], f.id, sh.getName(), title + ' · ' + sh.getName());
    });
    // the file itself (its first tab), named from the file
    // the file itself: pin its first tab BY NAME, so inserting another tab
    // later can never silently repoint this year at different data
    var fm = title.match(/FY\s?(\d{2,4})/i) || String(f.name).match(/FY\s?(\d{2,4})/i);
    if (fm && sheets.length) add('FY' + fm[1], f.id, sheets[0].getName(), title);
  });

  var fys = Object.keys(map).map(function (k) { return map[k]; });
  fys.sort(function (a, b) { return b.label.localeCompare(a.label); });
  return { fys: fys };
}

/**
 * Open an FY. `fyId` is the spreadsheet's file id; `tab` optionally names a
 * sheet inside it, so a financial year can live either in its own file or as
 * a tab in one workbook — both work.
 */
function openFY(fyId, tab) {
  if (!fyId) throw new Error('fyId missing');
  var ss = SpreadsheetApp.openById(fyId);
  var sheet = tab ? ss.getSheetByName(tab) : null;
  if (tab && !sheet) throw new Error('No tab named "' + tab + '" in that spreadsheet');
  return { ss: ss, sheet: sheet || ss.getSheets()[0] };
}

// ─── model ──────────────────────────────────────────────────────────────────
function getModel(fyId, tab) {
  var o = openFY(fyId, tab), sheet = o.sheet;
  var rng = sheet.getRange(1, 1, scanRows(sheet), MONTH_COL_START - 1 + MONTH_COUNT);
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
                           monthly: num(vals[r3][2]), monthlyLocked: !!formulas[r3][2],
                           cells: monthCells(r3) });
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
        var raw = vals[r4][MONTH_COL_START - 1 + c2];
        var cell = { v: num(raw), note: notes[r4][MONTH_COL_START - 1 + c2] || '' };
        if (isText(raw)) cell.text = String(raw);
        cells.push(cell);
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
    fy: { id: fyId, tab: sheet.getName(), name: o.ss.getName() },
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
/**
 * Rows move whenever you insert or delete lines directly in Google Sheets.
 * Every write therefore carries the category name the app *thinks* it is
 * writing to; if column A no longer matches, we find that name inside the
 * section and use its real row instead of scribbling over the wrong one.
 */
function resolveRow(sheet, section, row, label) {
  if (!label) return row;
  label = String(label).trim();
  if (String(sheet.getRange(row, 1).getValue() || '').trim() === label) return row;

  var sec = sections(sheet)[section];
  if (sec && sec.last >= sec.first) {
    var col = sheet.getRange(sec.first, 1, sec.last - sec.first + 1, 1).getValues();
    for (var i = 0; i < col.length; i++)
      if (String(col[i][0] || '').trim() === label) return sec.first + i;
  }
  throw new Error('"' + label + '" has moved or been removed in the sheet — refresh the app and try again');
}

function writeMonthCell(req, section) {
  var row = Number(req.row), month = Number(req.month), amount = Number(req.amount);
  if (!row || isNaN(month) || month < 0 || month >= MONTH_COUNT) throw new Error('Bad row/month');
  if (isNaN(amount)) throw new Error('Bad amount');
  var mode = req.mode === 'set' ? 'set' : 'add';

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = openFY(req.fyId, req.tab), sheet = o.sheet;
    row = resolveRow(sheet, section, row, req.label);
    var cell = sheet.getRange(row, MONTH_COL_START + month);
    if (cell.getFormula()) throw new Error('That cell contains a formula — edit it in the sheet.');
    if (isText(cell.getValue()))       // e.g. "Stocks=-66k": adding to it would wipe the text
      throw new Error('That cell holds text (“' + cell.getValue() + '”) — edit it in the sheet.');
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

    // The amount is in. Filling formulas is a bonus: it must never turn a
    // completed write into an error reply, or the app would doubt the write.
    var fill = { filled: [], removed: [], warnings: [] };
    if (section === 'variable') {
      try { fill = fillMonthFormulas(o.ss, sheet); }
      catch (e) { fill.warnings.push(String(e && e.message || e)); }
    }
    return { row: row, month: month, prev: prev, value: next,
             note: cell.getNote() || '', category: catLabel,
             filled: fill.filled, removed: fill.removed, warnings: fill.warnings };
  } finally { lock.releaseLock(); }
}

function setNote(req) {
  var o = openFY(req.fyId, req.tab);
  var row = resolveRow(o.sheet, 'large', Number(req.row), req.label);
  var cell = o.sheet.getRange(row, MONTH_COL_START + Number(req.month));
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
    var o = openFY(req.fyId, req.tab), sheet = o.sheet;
    row = resolveRow(sheet, req.section, row, req.label);
    var cell = sheet.getRange(row, col);
    var prevFormula = cell.getFormula();      // replaced on purpose; the app warns first
    var prev = Number(cell.getValue()) || 0;
    cell.setValue(value);
    var catLabel = String(sheet.getRange(row, 1).getValue() || '');
    appendLog(o.ss, [new Date(), 'fixed', catLabel, (req.col === 'C' ? 'monthly' : 'total'),
                     value, 'set', prevFormula ? 'replaced formula ' + prevFormula : (req.note || ''),
                     prev, value]);
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
  var o = openFY(req.fyId, req.tab);
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
  var n = scanRows(sheet);
  var colA = sheet.getRange(1, 1, n, 1).getValues()
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
    for (var r = first; r <= n; r++) {
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
    var o = openFY(req.fyId, req.tab), sheet = o.sheet;
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
    return getModel(req.fyId, req.tab);
  } finally { lock.releaseLock(); }
}

function renameRow(req) {
  var label = String(req.label || '').trim();
  if (!label) throw new Error('Name is required');
  var o = openFY(req.fyId, req.tab), sheet = o.sheet;
  req.label = req.was;                       // match on the OLD name, write the new one
  var cell = sheet.getRange(resolveRow(sheet, req.section, Number(req.row), req.label), 1);
  var prev = String(cell.getValue() || '');
  cell.setValue(label);
  SpreadsheetApp.flush();
  appendLog(o.ss, [new Date(), req.section || '', prev + ' → ' + label, '—', '', 'rename', '', '', '']);
  return getModel(req.fyId, req.tab);
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
    var o = openFY(req.fyId, req.tab), sheet = o.sheet;
    var sec = sections(sheet)[req.section];
    if (!sec) throw new Error('Unknown section: ' + req.section);
    var row = Number(req.row);
    if (row < sec.first || row > sec.last) throw new Error('That row is not in this section');

    var labels = sheet.getRange(sec.first, 1, sec.last - sec.first + 1, 1).getValues()
      .map(function (r) { return String(r[0] || '').trim(); })
      .filter(function (s) { return s; });
    if (labels.length <= 1) throw new Error('Can\u2019t remove the only category in a section');

    row = resolveRow(sheet, req.section, row, req.was);
    var label = String(sheet.getRange(row, 1).getValue() || '');
    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    appendLog(o.ss, [new Date(), req.section, label, '—', '', 'delete-category', '', '', '']);
    return getModel(req.fyId, req.tab);
  } finally { lock.releaseLock(); }
}

// ─── helpers ────────────────────────────────────────────────────────────────
/* Every row with content, never fewer than SCAN_MIN. A fixed cap silently cut
   off the summary rows once enough categories had been added. */
function scanRows(sheet) {
  return Math.max(SCAN_MIN, Math.min(sheet.getLastRow(), sheet.getMaxRows()));
}

/* A non-empty cell that isn't a number — a note typed into a month cell. */
function isText(v) {
  return typeof v === 'string' && v.trim() !== '' && isNaN(Number(v));
}

// ─── month formulas ─────────────────────────────────────────────────────────
/**
 * The owner extends "Total known expenses" and the "Savings from monthly
 * expenses" row one month at a time, so a month can hold entries before it
 * has a total. For each month that has entries but an EMPTY total/savings
 * cell, copy the nearest earlier month's formula across (relative refs shift
 * to the new column: =SUM(H18:H29) → =SUM(I18:I29), =$C$30-H30 → =$C$30-I30).
 *
 * Never overwrites a cell that holds anything. After filling, the result is
 * checked against the month's own cells — total = sum of categories,
 * savings = monthly plan − total — and removed again if it disagrees, so an
 * unusual formula is never propagated.
 *
 * The reverse matters as much: savings = plan − 0 for a month with no
 * spending, so a formula left on an empty month counts its whole budget as
 * saved. "Entered" therefore means a NON-ZERO amount, and when a month we
 * filled is empty again (a mistaken entry set back to 0 or cleared), its
 * formulas are removed — but only cells this script filled (per _AppLog) and
 * that still hold the same pattern as the month before. The owner's own
 * formulas are never touched.
 */
function fillMonthFormulas(ss, sheet) {
  var out = { filled: [], removed: [], warnings: [] };
  var sec = sections(sheet).variable;
  if (!sec || sec.last < sec.first) return out;

  var n = scanRows(sheet);
  var colA = sheet.getRange(1, 1, n, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); });
  var totalRow = -1;
  for (var r = sec.first; r <= n; r++) if (/^total known/i.test(colA[r - 1])) { totalRow = r; break; }
  if (totalRow < 0) return out;
  var savingsRow = totalRow < n && /^savings/i.test(colA[totalRow]) ? totalRow + 1 : -1;

  var height = sec.last - sec.first + 1;
  var cats = sheet.getRange(sec.first, MONTH_COL_START, height, MONTH_COUNT).getValues();
  var isCat = colA.slice(sec.first - 1, sec.last).map(function (L) { return !!L; });
  function entered(m) {        // any non-zero amount; a month of blanks and zeros has no spending yet
    for (var i = 0; i < height; i++) if (isCat[i] && Number(cats[i][m])) return true;
    return false;
  }
  function catSum(m) {
    var t = 0;
    for (var i = 0; i < height; i++) if (isCat[i]) t += Number(cats[i][m]) || 0;
    return t;
  }

  function rowState(row) {
    if (row < 0) return null;
    var rg = sheet.getRange(row, MONTH_COL_START, 1, MONTH_COUNT);
    return { row: row, f: rg.getFormulas()[0], v: rg.getValues()[0] };
  }
  var tot = rowState(totalRow), sav = rowState(savingsRow);
  var budget = Number(sheet.getRange(totalRow, 3).getValue()) || 0;     // column C: monthly plan

  // copy the nearest earlier formula in this row into month m; returns the source month or -1
  function fillCell(st, m) {
    if (!st || st.f[m] || (st.v[m] !== '' && st.v[m] != null)) return -1;   // occupied: leave it
    for (var k = m - 1; k >= 0; k--) {
      if (!st.f[k]) continue;
      sheet.getRange(st.row, MONTH_COL_START + k)
           .copyTo(sheet.getRange(st.row, MONTH_COL_START + m), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
      st.f[m] = '(filled)';
      return k;
    }
    return -1;
  }

  var months = sheet.getRange(sec.first - 1, MONTH_COL_START, 1, MONTH_COUNT).getValues()[0];
  removeEmptyMonthFormulas(ss, sheet, months, entered, tot, sav, out);
  var done = [];
  for (var m = 0; m < MONTH_COUNT; m++) {
    if (!entered(m)) continue;
    var a = fillCell(tot, m), b = fillCell(sav, m);
    if (a >= 0 || b >= 0) done.push({ m: m, tot: a >= 0, sav: b >= 0, from: Math.max(a, b) });
  }
  if (!done.length) return out;
  SpreadsheetApp.flush();

  done.forEach(function (d) {
    var label = String(months[d.m] || d.m);
    var totalNow = Number(sheet.getRange(totalRow, MONTH_COL_START + d.m).getValue());
    var ok = Math.abs(totalNow - catSum(d.m)) < 0.005;
    if (ok && savingsRow > 0) {
      var savNow = Number(sheet.getRange(savingsRow, MONTH_COL_START + d.m).getValue());
      ok = Math.abs(savNow - (budget - totalNow)) < 0.005;
    }
    if (!ok) {
      if (d.tot) sheet.getRange(totalRow, MONTH_COL_START + d.m).clearContent();
      if (d.sav) sheet.getRange(savingsRow, MONTH_COL_START + d.m).clearContent();
      out.warnings.push(label + ': the copied formulas didn’t add up, so they were removed — please fill ' +
                        label + '’s total and savings in the sheet');
      return;
    }
    out.filled.push(label);
    appendLog(ss, [new Date(), 'variable', 'Total + Savings formulas', label, '', 'fill-formulas',
                   'copied from ' + String(months[d.from] || d.from), '', '']);
  });
  SpreadsheetApp.flush();
  return out;
}

/* Months this script has filled, from _AppLog ("fill-formulas" rows). */
function filledByKosh(ss) {
  var sh = ss.getSheetByName(LOG_SHEET), seen = {};
  if (!sh || sh.getLastRow() < 1) return seen;
  sh.getRange(1, 1, sh.getLastRow(), 6).getValues().forEach(function (r) {
    var what = String(r[2]), month = String(r[3]), mode = String(r[5]);
    if (what !== 'Total + Savings formulas') return;
    if (mode === 'fill-formulas') seen[month] = true;
    if (mode === 'unfill-formulas') delete seen[month];
  });
  return seen;
}

/* Clear total/savings formulas that this script added to months which now have
   no spending. Kept if the owner wrote them, or if they no longer match the
   neighbouring month's pattern (someone edited them). */
function removeEmptyMonthFormulas(ss, sheet, months, entered, tot, sav, out) {
  var ours = null;
  [tot, sav].forEach(function (st) {
    if (!st) return;
    var r1c1 = sheet.getRange(st.row, MONTH_COL_START, 1, MONTH_COUNT).getFormulasR1C1()[0];
    for (var m = 1; m < MONTH_COUNT; m++) {
      if (!st.f[m] || entered(m)) continue;
      var label = String(months[m] || m);
      ours = ours || filledByKosh(ss);
      if (!ours[label]) continue;                                  // not ours: leave it
      var k = m - 1; while (k >= 0 && !r1c1[k]) k--;
      if (k < 0 || r1c1[k] !== r1c1[m]) continue;                  // edited since: leave it
      sheet.getRange(st.row, MONTH_COL_START + m).clearContent();
      st.f[m] = ''; st.v[m] = '';
      if (out.removed.indexOf(label) < 0) out.removed.push(label);
    }
  });
  out.removed.forEach(function (label) {
    appendLog(ss, [new Date(), 'variable', 'Total + Savings formulas', label, '', 'unfill-formulas',
                   'month has no entries', '', '']);
  });
  if (out.removed.length) SpreadsheetApp.flush();
}

/* Explicit, from the app's "Add to sheet" button. Only ever fills empty
   cells, so running it twice is harmless. */
function fillFormulasAction(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var o = openFY(req.fyId, req.tab);
    var fill = fillMonthFormulas(o.ss, o.sheet);
    return { filled: fill.filled, removed: fill.removed, warnings: fill.warnings, model: getModel(req.fyId, req.tab) };
  } finally { lock.releaseLock(); }
}

function monthName(sheet, monthIdx) {
  // find the variable header row to read the month label
  var colA = sheet.getRange(1, 1, scanRows(sheet), 1).getValues();
  for (var r = 0; r < colA.length; r++) {
    if (String(colA[r][0]).trim() === 'Monthly Variable Expenses (known)') {
      return String(sheet.getRange(r + 1, MONTH_COL_START + monthIdx).getValue() || '');
    }
  }
  return String(monthIdx);
}
