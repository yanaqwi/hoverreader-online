// api/ocr-space.js
// Vercel Serverless Function (Edge): OCR.Space proxy with engine fallback
export const config = { runtime: 'edge' };

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors() });
    }
    const body = await req.json();
    const { base64Image, language = 'ara', isOverlayRequired = true } = body || {};

    if (!base64Image) {
      return new Response(JSON.stringify({ error: 'Missing base64Image' }), { status: 400, headers: cors() });
    }

    const apiKey = process.env.OCRSPACE_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Server missing OCRSPACE_API_KEY' }), { status: 500, headers: cors() });
    }

    // Helper to call OCR.Space with a specific engine
    async function callEngine(engine) {
      const form = new URLSearchParams();
      form.set('apikey', apiKey);
      form.set('isOverlayRequired', isOverlayRequired ? 'true' : 'false');
      form.set('OCREngine', String(engine)); // '1' or '2'
      form.set('language', language);
      form.set('detectOrientation', 'true');
      form.set('scale', 'true'); // recommended for better results on scans
      form.set('isTable', 'false');
      form.set('base64Image', base64Image);

      const r = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const j = await r.json();
      return j;
    }

    // Try Engine 2, then Engine 1 if needed
    let first = await callEngine(2);
    let overlayCount = countOverlay(first);
    if (overlayCount === 0) {
      const second = await callEngine(1);
      const overlayCount2 = countOverlay(second);
      // Prefer the one that returns more overlay words
      if (overlayCount2 > overlayCount) {
        second._note = 'Used OCR Engine 1 (more overlay words).';
        return new Response(JSON.stringify(second), { status: 200, headers: cors() });
      }
      first._note = 'Engine 2 kept (Engine 1 not better).';
      return new Response(JSON.stringify(first), { status: 200, headers: cors() });
    }
    first._note = 'Used OCR Engine 2.';
    return new Response(JSON.stringify(first), { status: 200, headers: cors() });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors() });
  }
}

function countOverlay(resp) {
  try {
    const pr = resp?.ParsedResults?.[0];
    const lines = pr?.TextOverlay?.Lines || [];
    let n = 0;
    for (const ln of lines) n += (ln.Words || []).length;
    return n;
  } catch {
    return 0;
  }
}

function cors() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}
