// Vercel Serverless Function: LibreTranslate proxy
export const config = { runtime: 'edge' };

const DEFAULT_URL = 'https://libretranslate.com/translate';

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

    const url = process.env.TRANSLATE_URL || DEFAULT_URL;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, source, target, format: 'text' })
    });
    if (!r.ok) {
      const text = await r.text();
      return new Response(JSON.stringify({ error: 'Translate upstream failed', detail: text }), { status: 502, headers: cors() });
    }
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
