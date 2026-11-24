# Setting Kosh up

## 1 · Deploy the Apps Script (once)

1. Sign in to the Google account that owns your FY sheet, open **script.google.com**.
2. **New project** → delete the placeholder → paste all of
   [`apps-script/Code.gs`](apps-script/Code.gs).
3. Change `SHARED_TOKEN` near the top to your own long random secret (used only
   for testing from a terminal). Treat it like a password; don't commit it.
4. **Deploy → New deployment** → gear → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. **Deploy** → authorise (*Advanced → Go to … (unsafe) → Allow* — it's your own
   unreviewed script) → copy the **Web app URL**, ending in `/exec`.

> "Anyone" means anyone *with the URL and your PIN*. Every request is rejected
> without it, and the script stops accepting guesses after 10 wrong ones.
> Your sheet stays private.

## 2 · Connect the app

Put the Web app URL in `SCRIPT_URL` at the top of `app.js` and deploy. Open
**https://ankit-icici.github.io/kosh/** and choose a 4-digit PIN; the app asks
for it every time it opens. Forgot it: run `resetPin()` in the script editor.

## 3 · Install to the home screen

- **iPhone / Safari:** Share → *Add to Home Screen*
- **Android / Chrome:** ⋮ → *Install app*

The icon is baked in at install time — after an icon change, remove and re-add it.

## Starting a new financial year

Either works; the app discovers both.

**As a tab (what this sheet does):** right-click the `FY27` tab → **Duplicate** →
rename it `FY28` → clear columns D–O. Then in the app: Settings → *Re-scan Drive
for FY sheets*. Switch years with the FY pill at the top.

**As a separate file:** name it so it contains `FY28` and `Planning`.

The year must appear as `FY28` in the tab or file name, and the layout (section
headings in column A, months in D–O) must stay the same.

## Updating the script later

When the app gains a feature that needs the backend, unknown actions come back
as errors. To update:

1. script.google.com → your project → select all → paste the new `Code.gs`,
   **keeping your own `SHARED_TOKEN` line** → save.
2. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.**

The web app URL never changes, so nothing needs reconfiguring on your phone.
