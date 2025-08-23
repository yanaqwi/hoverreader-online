# HoverReader Online (Vercel)

Frontend-only deploy with **OCR (ocr.space)** and **translation (LibreTranslate)** via Vercel serverless functions.
- Upload PDF → per-page OCR (Arabic by default) → hover words for gloss, click for etymology, double‑click line for translation.

## Quick Deploy (Vercel)
1. Create a **new GitHub repo** (empty).
2. Upload these files to the repo (drag-drop in GitHub web UI).
3. Go to **vercel.com → New Project → Import** your repo.
4. Framework = **Vite** (auto-detected). Build: `npm run build` Output: `dist` (auto).
5. Add **Environment Variables** (Project Settings → Environment Variables):
   - `OCRSPACE_API_KEY` = your free key from https://ocr.space/ocrapi (server-side secret)
   - (optional) `TRANSLATE_URL` = LibreTranslate endpoint (default: https://libretranslate.com/translate)
6. Deploy. Open your URL.

## Local Dev (optional)
```bash
npm install
npm run dev
# visit http://localhost:5173
```

## Notes
- The OCR proxy keeps your key **server-side** (not exposed to the browser).
- The translation proxy avoids CORS and rate-limit issues; no key is required for LibreTranslate public instance, but uptime may vary.
- The lexicon is a tiny sample. Replace `/public/lexicon-lite.json` with a larger dictionary when ready.
