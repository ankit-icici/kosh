# Working on Kosh

Read this before changing anything. Everything below was learned by breaking it
or nearly breaking it. The code is small and readable; these are the things the
code alone will not tell you.

## What this is

A PWA whose entire database is the owner's personal Google Sheet. There is no
other store. Correctness here means **someone's real financial records**, so the
bias is: refuse loudly rather than write something plausible.

- Frontend: plain JS, no build step, no dependencies. `app.js` is the whole app.
- Backend: `apps-script/Code.gs`, deployed as a Google Apps Script web app.
- Hosting: GitHub Pages off `main`.

---

## The invariants

### 1. Planned ≠ spent. Never conflate them.

| Column | Meaning |
|---|---|
| **B** | planned for the year |
| **C** | planned per month (variable + fixed sections) |
| **D…O** | **actual** amounts, April → March |

The sheet's own `Total expenses` row is **planned**, not spent — it is
`Total known expenses` + `Total unknown expenses`, both of which are plans.
Labelling it "spent" was a real bug. Actual spend must be summed from D…O.

Helpers in `app.js` keep the two apart: `M.varPlanned()` / `M.varSpent()`,
`M.largePlanned()` / `M.largeSpent()`. Use them.

### 2. Sections are found by label, never by row number.

`sections()` in `Code.gs` scans column A for the anchor labels. Row numbers
drift whenever anyone edits the sheet. Never hard-code a row.

### 3. Every write carries the category name, and `resolveRow` checks it.

Because this is two-way — the owner edits the sheet directly too — a cached
model can point at the wrong row. Every write sends `label`; `resolveRow()`
verifies column A matches, finds the row by name within the section if it
doesn't, and **throws if the name is gone**.

Without this, adding to "Grocery" with a stale row silently landed in
"Food & Drinks". Do not remove it, and add it to any new write action.

### 4. Writes must never be retried automatically.

Apps Script answers a POST with a 302; the browser re-issues that hop as a GET,
which sometimes lands on `doGet` and returns the **ping payload instead of the
answer — even though the write already ran**. Observed twice in live testing.

`app.js` therefore splits actions: `READ_ACTIONS` (`ping`, `fys`, `get`, `log`)
retry up to 3×; everything else throws `err.lost`, and the caller **re-reads the
sheet** instead of re-sending. Retrying a write double-counts someone's money.

Same trap from the shell — `-X POST` forces the method across the redirect and
returns a misleading 405:

```bash
# right
curl -sL "$URL" -H 'Content-Type: text/plain' --data-raw '{"token":"…","action":"get",…}'
# wrong: -X POST
```

### 5. Adding a row inserts *inside* the block, never after it.

`addRow()` calls `insertRowBefore(lastRow)`, copies the old last row up into the
gap, then repurposes the trailing row. This is deliberate: inserting inside an
existing block makes Google Sheets expand every `SUM` range itself, including
the cross-section totals. **No formula of the owner's is ever rewritten.**

Deleting relies on Sheets' own range-shrinking. Deleting the last row of a
section is refused — it would leave those ranges pointing at nothing.

New rows keep column B only if it holds a formula; otherwise it is cleared.

### 6. A financial year may be a file *or* a tab.

Discovery matches `FY27`, `FY28`… in either a spreadsheet's name or a tab's
name. `fyId` is the file id and `tab` is the optional sheet name; both flow
through every call. The file-level fallback pins the first tab **by name**, so
adding a tab later can't silently repoint an existing year at other data.

The current owner keeps one workbook with tabs `FY27`, `FY28`.

### 7. Backend edits are not live until redeployed.

Editing `Code.gs` changes nothing. Deploy → Manage deployments → ✏️ → Version:
**New version** → Deploy. The URL never changes.

The editor exposes `monaco.editor.getModels()[0]`, and the page *can* fetch
`raw.githubusercontent.com`, so an update can be pulled straight from this repo.
When doing that, **preserve the existing `var SHARED_TOKEN = …` line** by
splicing it out of the current editor contents — never type the secret.

### 8. Bump the caches on every deploy.

`VERSION` in `sw.js` and `BUILD` in `app.js`. The service worker is
**network-first** for same-origin requests (cache is the offline fallback only)
— it used to be cache-first, which meant new code appeared only on the *second*
open and looked like features hadn't shipped. Settings shows the app build, the
deployed script version and the active FY tab; check there first when something
looks missing.

### 9. Never commit the token.

`Code.gs` in the repo carries the `CHANGE_ME_to_a_long_random_secret`
placeholder. The real value lives only in the deployed script and on the owner's
phone.

---

## Testing against the real sheet

Use the **FY28 tab**, never FY27. The pattern that has worked:

1. `get` a baseline.
2. Do the operation.
3. Assert the specific effect *and* that everything else is untouched.
4. Undo it.
5. `get` again and deep-compare against the baseline, ignoring `fetchedAt`.
   It must be **byte-identical**.

Worth re-running after any change to `Code.gs`: add a category, write to it,
write using a deliberately wrong row number with the correct label (the drift
guard), rename, delete — for both the `variable` and `large` sections.

## Smaller traps

- **Didot has no `₹` glyph.** It silently renders `.notdef` (an empty box).
  Cochin, Baskerville, Georgia and STIX Two Text carry it. See `tools/make-icons.py`.
- Dark mode: buttons take their text colour from `--on-acc`. Don't reintroduce a
  `html[data-theme="dark"] .btn { color: … }` rule — it outranks `.btn.ghost`
  and `.btn.danger` and renders them dark-on-dark.
- Bottom sheets push a history entry so the back button closes them. Keep
  `openSheet`/`closeSheet` symmetric or back navigation breaks.
- `₹` amounts use `Intl.NumberFormat('en-IN')` — lakh/crore grouping, not thousands.
- The FY month index is `(month + 9) % 12`, i.e. April = 0.

## House style

Match the existing code: no framework, no build step, no dependencies. Comments
explain *why*, not what. Keep the UI minimal and calm — this is a tool someone
opens for thirty seconds a day.
