# One-time setup (≈5 minutes)

## 1 · Deploy the Apps Script (your Google account)

1. Open **script.google.com** while signed into the Google account that has your
   FY sheets (the one that owns *FY27 Planning_Aug 26*).
2. **New project** → delete the placeholder code → paste all of
   [`apps-script/Code.gs`](apps-script/Code.gs).
3. At the top of the file, change `SHARED_TOKEN` to your own secret — any long
   random text (treat it like a password; don't commit it anywhere).
4. Name the project "Kosh" (top-left).
5. **Deploy → New deployment** → gear icon → **Web app**:
   - Description: `kosh v1`
   - **Execute as: Me**
   - **Who has access: Anyone**
6. Click **Deploy** → Google asks you to authorize → *Advanced → Go to Kosh
   (unsafe)* → Allow. (It's your own script; "unsafe" just means unreviewed by Google.)
7. Copy the **Web app URL** (ends in `/exec`).

> "Anyone" only means anyone *with the URL and your token* can call it — the URL is
> unguessable and every request is checked against your token. Your sheet itself
> stays private.

## 2 · Connect the app

1. On your phone, open **https://ankit-icici.github.io/kosh/**
2. Paste the Web app URL and your token → **Connect**.

## 3 · Install to home screen

- **iPhone (Safari):** Share button → *Add to Home Screen*.
- **Android (Chrome):** ⋮ menu → *Add to Home screen / Install app*.

## New financial year

Duplicate your sheet template, name it like `FY28 Planning`, keep the same layout.
Open the app → FY pill → *Re-scan* (in Settings) — it appears automatically.

## Updating the backend later

script.google.com → your project → edit → **Deploy → Manage deployments → ✏️ →
Version: New version → Deploy**. URL stays the same; the app needs no change.
