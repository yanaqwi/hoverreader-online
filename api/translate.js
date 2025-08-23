// api/translate.js
export const config = { runtime: 'edge' };

// Try env first; otherwise try a list of public endpoints
const CANDIDATES = [
  () => process.env.TRANSLATE_URL,
  () => 'https://libretranslate.com/translate',
  () => 'https://translate.argosopentech.com/translate'
];

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors() });
    }
    const body = await req.json();
    const { q, source = 'ar', target = 'en' } = body || {};
    if (!q) {
      return new Response(JSON.stringify({ error: 'Missing q' }), { status: 400, headers: cors() });
    }

    let lastErr = null;
    for (const getUrl of CANDIDATES) {
      const url = getUrl();
      if (!url) continue;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, source, target, format: 'text' })
        });
        if (!r.ok) {
          lastErr = new Error(`Upstream ${url} -> ${r.status}`);
          continue;
        }
        const j = await r.json();
        // Normalize reply: some return {translatedText}, some return [{translatedText}]
        const translatedText = typeof j?.translatedText === 'string'
          ? j.translatedText
          : (Array.isArray(j) && j[0]?.translatedText ? j[0].translatedText : null);
        if (!translatedText) throw new Error('Bad response shape');
        return new Response(JSON.stringify({ translatedText }), { status: 200, headers: cors() });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No translation endpoint reachable');
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors() });
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
