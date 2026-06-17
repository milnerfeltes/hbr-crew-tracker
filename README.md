# Hampton Bays Remodeling — Crew Task Tracker (PWA)

A full app that installs to your phone's home screen, saves all data **on the device**
(IndexedDB, with localStorage fallback), and works **offline**. No server, no accounts.

## What's inside
- `index.html` — the app
- `app.js` — logic + on-device storage
- `sw.js` — offline service worker
- `manifest.webmanifest` — makes it installable
- `icons/` — app icons

## How to run it (pick one)

### Option A — Free hosting (recommended, takes ~2 min)
A PWA must be served over **https** to install and work offline.
1. Go to https://app.netlify.com/drop (free, no account needed to test).
2. Drag the **whole unzipped folder** onto the page.
3. It gives you a URL like `https://your-app.netlify.app`.
4. Open that URL on your phone → install it (below).

Other equivalent free hosts: GitHub Pages, Vercel, Cloudflare Pages.

### Option B — Your own web hosting
Upload the folder's contents to any https web host and open the URL on your phone.

## Installing on your phone
- **iPhone (Safari):** open the URL → tap **Share** → **Add to Home Screen**.
- **Android (Chrome):** open the URL → menu (⋮) → **Install app** / **Add to Home screen**.

Once installed it launches full-screen like a normal app and works with no signal.

## Using it
- **Today tab:** add tasks per worker, tap the box to mark done, tap a task's name to log
  *why* it isn't finished. The ring shows daily completion %.
- **‹ Today ›** buttons or the date picker move between days.
- **Week / Report tab:** see the whole week's production and completion %, then
  **Export & share PDF** to send a report by text, WhatsApp, or email.

## Your data
Stored only on the device that entered it. Each phone keeps its own copy.
Export the weekly PDF regularly if you want an off-device record.
To move data to a new phone, host the app at the same URL and re-enter, or keep PDFs.

Workers preloaded: Luis Bordón, Enrique Villalba, César Cáceres, Milner Feltes.
To change the crew, edit the `WORKERS` line near the top of `app.js`.
