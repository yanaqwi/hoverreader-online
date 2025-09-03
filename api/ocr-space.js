// HoverReader API — v0.4.0 (ocr-space with timeouts and clearer errors)
export const config = { runtime: 'edge' };

export default async function handler(req) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
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
    const result = await callWithFallback({ base64Image, language, isOverlayRequired, apiKey, timeoutMs: 20000 });
    return new Response(JSON.stringify(result), { status: 200, headers: cors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: cors() });
  }
}

async function callWithFallback({ base64Image, language, isOverlayRequired, apiKey, timeoutMs }) {
  const first = await callEngine({ engine: 2, base64Image, language, isOverlayRequired, apiKey, timeoutMs });
  let count = countOverlay(first);
  if (count > 0) {
    first._note = 'Used OCR Engine 2.';
    return first;
  }
  const second = await callEngine({ engine: 1, base64Image, language, isOverlayRequired, apiKey, timeoutMs });
  const count2 = countOverlay(second);
  if (count2 > count) {
    second._note = 'Used OCR Engine 1 (more overlay words).';
    return second;
  }
  first._note = 'Engine 2 kept (Engine 1 not better).';
  return first;
}

async function callEngine({ engine, base64Image, language, isOverlayRequired, apiKey, timeoutMs }) {
  const form = new URLSearchParams();
  form.set('apikey', apiKey);
  form.set('isOverlayRequired', isOverlayRequired ? 'true' : 'false');
  form.set('OCREngine', String(engine)); // 1 or 2
  form.set('language', language);
  form.set('detectOrientation', 'true');
  form.set('scale', 'true');
  form.set('isTable', 'false');
  form.set('base64Image', base64Image);

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const r = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
    clearTimeout(to);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { OCRExitCode: 999, IsErroredOnProcessing: true, ErrorMessage: [`HTTP ${r.status}`], ...j };
    }
    return j;
  } catch (e) {
    clearTimeout(to);
    return { OCRExitCode: 999, IsErroredOnProcessing: true, ErrorMessage: [String(e?.message || e)] };
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
