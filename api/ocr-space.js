// Vercel Serverless Function: OCR.Space proxy
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

    const form = new URLSearchParams();
    form.set('apikey', apiKey);
    form.set('isOverlayRequired', isOverlayRequired ? 'true' : 'false');
    form.set('OCREngine', '2');
    form.set('language', language);
    form.set('isTable', 'false');
    form.set('detectOrientation', 'true');
    form.set('base64Image', base64Image);

    const r = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    const j = await r.json();
    return new Response(JSON.stringify(j), { status: 200, headers: cors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors() });
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
