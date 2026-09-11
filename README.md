# Kosh 💸

A minimal personal expense tracker (PWA) **backed entirely by a Google Sheet you
already own**. No database, no server, no vendor lock-in. The spreadsheet stays
the single source of truth; the app is a faster way to read and update it from a
phone.

**Live:** https://ankit-icici.github.io/kosh/

> New here — human or AI? Read **[CLAUDE.md](CLAUDE.md)** before changing anything.
> It documents the invariants that are easy to break and expensive to discover.

## Architecture

```
┌──────────────────┐  HTTPS/JSON   ┌───────────────────────┐        ┌────────────────────┐
│  Kosh PWA        │ ────────────▶ │  Apps Script web app  │ ─────▶ │  Your FY sheet     │
│  (GitHub Pages)  │ ◀──────────── │  (your Google account)│ ◀───── │  (source of truth) │
└──────────────────┘               └───────────────────────┘        └────────────────────┘
```

| Piece | File(s) | Notes |
|---|---|---|
| Frontend | `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` | Plain JS, no build step, no dependencies |
| Backend | `apps-script/Code.gs` | Deployed as a web app from the sheet owner's Google account |
| Icons | `icons/`, `tools/make-icons.py` | Regenerate all four sizes with `python3 tools/make-icons.py` |
| Auth | shared token | Set in `Code.gs`; entered once in the app. **Never committed.** |

The app keeps no data of its own. `localStorage` holds only the connection
config and a cached copy of the last-read sheet (for instant open and offline),
plus a queue of writes that failed while offline.

## Screens

| Tab | Shows |
|---|---|
| **Home** | Whole-year position: total income, total expenses *(planned)*, savings from monthly expenses, remaining |
| **Monthly** | Planned / spent / saved / left for the year, then every variable category × every month in one matrix. Tap any cell to edit; tap the Planned column to change a budget |
| **Large** | Planned / spent / left, then each large-expense category with its plan. Amounts can carry a note, stored as a real Google Sheets cell note |
| **Fixed** | Funds/income rows and fixed monthly expenses, every amount editable |
| **Manage** | `#/manage/<section>` — rename, remove or add rows in any of the four sections |

## Sheet layout the script expects

A financial year (Apr–Mar) can live either as **its own spreadsheet** or as a
**tab inside one workbook** — both are discovered, by looking for `FY27`,
`FY28`… in the file or tab name. Sections are found by their **column A label**,
so row numbers may drift freely.

| Section | Anchor label in column A | Columns |
|---|---|---|
| Income | `Funds` … ends at `Total` | B = amount |
| Fixed expenses | `Monthly Fixed Expenses (known)` … ends at a blank row | B = yearly, C = monthly |
| Variable expenses | `Monthly Variable Expenses (known)` … ends at `Total known expenses` | B = yearly plan, C = monthly plan, D…O = Apr…Mar actuals |
| Large / investments | `Large expenses/Investments` … ends at `Total unknown expenses` | B = plan, D…O = month amounts, **cell notes** hold context |
| Summary | `Total expenses`, `Total income`, `Remaining`, `Emergency` | B = value |

Rows with a blank label (spacers, the repeated month header) are skipped.

Every write is also appended to a hidden `_AppLog` tab in the same spreadsheet:
date, section, category, month, amount, mode, note, previous value, new value.

## Development

1. Clone, edit, push to `main` — GitHub Pages redeploys in ~1 minute.
2. **Bump `VERSION` in `sw.js` and `BUILD` in `app.js` on every deploy.**
3. Serve locally with any static server, e.g. `python3 -m http.server 8642`.
4. Backend changes need a **manual redeploy** — editing `Code.gs` alone changes
   nothing live. See [SETUP.md](SETUP.md).

API actions: `ping`, `fys`, `get`, `log`, `addVariable`, `addLarge`, `setNote`,
`setValue`, `addRow`, `renameRow`, `deleteRow`.
