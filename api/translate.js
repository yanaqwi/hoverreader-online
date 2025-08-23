// HoverReader API — v0.3.2 (translate)
export const config = { runtime: 'edge' };

/**
 * Translation proxy with two free backends:
 * 1) LibreTranslate (set TRANSLATE_URL env, e.g. https://libretranslate.de/translate)
 * 2) MyMemory fallback (public, rate-limited)
 *
 * Env:
 * - TRANSLATE_URL (optional) — if provided, we use LibreTranslate-compatible API
 * - TRANSLATE_API_KEY (optional) — if your LibreTranslate requires a key
 */
export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors() });
    }
    const body = await req.json();
    const q = (body?.q || '').toString().trim();
    const source = (body?.source || 'auto').toString();
    const target = (body?.target || 'en').toString();

    if (!q) {
      return new Response(JSON.stringify({ error: 'Missing q' }), { status: 400, headers: cors() });
    }

    // Try LibreTranslate-compatible endpoint first if configured
    const LT = process.env.TRANSLATE_URL;
    if (LT) {
      try {
        const payload = {
          q,
          source,
          target,
          format: 'text',
        };
        const headers = { 'content-type': 'application/json' };
        const key = process.env.TRANSLATE_API_KEY;
        if (key) headers['x-api-key'] = key;

        const r = await fetch(LT, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        if (r.ok) {
          const j = await r.json();
          const translatedText = j?.translatedText || j?.data?.translatedText || '';
          if (translatedText) {
            return new Response(JSON.stringify({ translatedText }), { status: 200, headers: cors() });
          }
        }
      } catch {
        // fall through to MyMemory
      }
    }

    // Fallback: MyMemory (public)
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', q);
    url.searchParams.set('langpair', `${mapLang(source) || 'auto'}|${mapLang(target) || 'en'}`);

    const resp = await fetch(url.toString());
    const data = await resp.json();
    const translatedText = data?.responseData?.translatedText || '';

    return new Response(JSON.stringify({ translatedText }), { status: 200, headers: cors() });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors() });
  }
}

function mapLang(l) {
  // minimal mapper for common tags to MyMemory format
  if (!l || l === 'auto') return 'auto';
  if (l.startsWith('ar')) return 'ar';
  if (l.startsWith('en')) return 'en';
  return l.slice(0,2);
}

function cors() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}
