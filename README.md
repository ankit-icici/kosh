# Kharcha 💸

A minimal, aesthetic PWA for tracking personal expenses — **backed entirely by your own
Google Sheet**. No database, no server of ours, no vendor lock-in. The spreadsheet you
already maintain stays the single source of truth; this app is just a faster, nicer way
to update it from your phone.

**Live app:** https://ankit-icici.github.io/kharcha/

## How it works

```
┌─────────────────┐   HTTPS (JSON)   ┌──────────────────────┐        ┌──────────────────┐
│  Kharcha PWA    │ ───────────────▶ │  Apps Script web app │ ─────▶ │  FY Google Sheet │
│  (GitHub Pages) │ ◀─────────────── │  (your Google acct)  │ ◀───── │  (source of truth)│
└─────────────────┘                  └──────────────────────┘        └──────────────────┘
```

- **Frontend** — plain HTML/CSS/JS (no build step), served by GitHub Pages, installable
  as a PWA on iOS/Android. Files: `index.html`, `styles.css`, `app.js`, `sw.js`,
  `manifest.webmanifest`.
- **Backend** — `apps-script/Code.gs`, a Google Apps Script deployed as a web app *from
  your own Google account*. It reads/writes the FY sheet and keeps an audit log in a
  hidden `_AppLog` tab inside the same spreadsheet.
- **Auth** — a shared secret token you set in `Code.gs` and enter once in the app.
  The deployed script URL + token live only in your phone's localStorage (as a cache of
  config, not of data).

## Sheet layout the script expects

One spreadsheet per financial year (Apr–Mar), first tab, label-anchored sections
(row numbers may drift; labels must match):

| Section | Anchor label in column A | Columns |
|---|---|---|
| Income | `Funds` … `Total` | B = amount |
| Fixed expenses | `Monthly Fixed Expenses (known)` | B = yearly, C = monthly |
| Variable expenses | `Monthly Variable Expenses (known)` … `Total known expenses` | C = monthly budget, D..O = Apr..Mar actuals |
| Large / investments | `Large expenses/Investments` … `Total unknown expenses` | B = planned/total, D..O = month amounts, **cell notes** hold context |
| Summary | `Total expenses`, `Total income`, `Remaining`, `Emergency` | B = value |

New FY files are auto-discovered from Drive by name (`FY## …Planning…`), so rolling
into FY28 = duplicate the sheet template with that name. Nothing to redeploy.

## Features

- 🏠 **Home** — current month spend vs budget, one-tap add expense, recent entries
- ▦ **Months** — every category × every month of the FY in one matrix (tap any cell to edit)
- ◈ **Large** — investments & big-ticket items, each amount can carry a note
- ◷ **Year** — funds, fixed expenses (editable), FY summary
- Dark / light / auto theme, offline queue for entries, works fully installed

## Continuing development (with or without Claude)

Everything needed to keep building lives in this repo + your Google account:

1. Clone the repo, edit, push to `main` — GitHub Pages redeploys automatically.
2. When changing app files, bump `VERSION` in `sw.js` so installed phones pick up the update.
3. Backend changes: edit the script at script.google.com → Deploy → *Manage deployments*
   → edit → new version. The URL stays the same.
4. The API contract between app and script is in `apps-script/Code.gs` (actions:
   `ping`, `fys`, `get`, `addVariable`, `addLarge`, `setNote`, `setValue`, `log`).

No local state matters: a phone can be wiped and reconnected with just the script URL
and token.
