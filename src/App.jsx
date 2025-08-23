// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();

const API_OCR = "/api/ocr-space";
const API_TRANSLATE = "/api/translate";

const STYLES = {
  page: { position: "relative", margin: "0 auto", boxShadow: "0 10px 30px rgba(0,0,0,.35)", borderRadius: 12, overflow: "hidden", background: "#111" },
  overlayLayer: { position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" },
  overlayWord: { position: "absolute", lineHeight: 1.4, padding: "0 2px", borderRadius: 4, pointerEvents: "auto", cursor: "pointer", background: "rgba(147,197,253,.18)" },
  tip: { position: "fixed", bottom: "auto", transform: "translate(-50%, -120%)", background: "#111", color: "#fff", padding: "6px 8px", borderRadius: 8, whiteSpace: "nowrap", fontSize: 12, zIndex: 50, pointerEvents: "none" },
  sidebar: { position: "sticky", top: 16, padding: 12, border: "1px solid #1f2937", borderRadius: 12, background: "rgba(17,17,17,.6)" },
  toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: { padding: "8px", borderRadius: 10, border: "1px solid #333", background: "#0b0c10", color: "#e5e7eb", minWidth: 180 },
};

// ---------- helpers ----------
function useLexicon() {
  const [map, setMap] = useState({});
  useEffect(() => {
    fetch("/lexicon-lite.json")
      .then(r => r.json()).then(rows => {
        const m = {};
        for (const r of rows) {
          if (r.form) m[r.form] = r;
          if (r.lemma) m[r.lemma] = r;
        }
        setMap(m);
      }).catch(()=>{});
  }, []);
  return map;
}

function stripDiacritics(s) {
  return (s || "").replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]/g, "");
}
function normalizeArabic(s="") {
  // normalize alef/yaa/ta marbuta/hamza forms & remove tatweel/punct
  return s
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئ]/g, "ء")
    .replace(/ـ/g, "")
    .replace(/[^\u0600-\u06FF\s]/g, "");
}
function isArabicString(s="") {
  // consider it Arabic if ≥60% of chars are Arabic range
  const chars = [...s];
  if (chars.length === 0) return false;
  const arabic = chars.filter(c => /\p{Script=Arabic}/u.test(c)).length;
  return arabic / chars.length >= 0.6;
}

async function pdfToPageImage(page, scale=1.6) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.9), width: canvas.width, height: canvas.height, viewport };
}

// Build word-ish boxes from text items (text mode)
function layoutWordsFromTextItems(items, viewport) {
  const out = [];
  const vT = viewport.transform;
  for (const it of items) {
    const str = it.str || "";
    if (!str.trim()) continue;

    // If this line looks non-Arabic (e.g., gibberish glyphs), skip it
    if (!isArabicString(str)) continue;

    const width = it.width * viewport.scale;
    const t = pdfjsLib.Util.transform(vT, it.transform);
    let x = t[4], y = t[5];
    const fontHeight = Math.hypot(t[1], t[3]) || 12;
    const h = fontHeight;

    const pieces = str.split(/\s+/).filter(Boolean);
    const totalChars = str.replace(/\s+/g, "").length || 1;
    let cursorX = x;
    for (const p of pieces) {
      const chars = p.replace(/\s+/g, "").length;
      const w = width * (chars / totalChars);
      out.push({
        WordText: p,
        Left: cursorX,
        Top: y - h,
        Width: w,
        Height: h * 1.1,
        lineText: str
      });
      cursorX += w + (width * (1 / totalChars));
    }
  }
  return out;
}

async function extractTextOverlay(page, scale=1.6) {
  const { viewport, ...img } = await pdfToPageImage(page, scale);
  const text = await page.getTextContent();
  const items = text.items || [];

  // If text items exist but < 20% of them are Arabic → treat as unusable → let caller OCR
  const arabicItems = items.filter(it => isArabicString(it.str || ""));
  if (items.length > 0 && arabicItems.length / items.length < 0.2) {
    return { img, words: [], mode: "none" };
  }

  const words = layoutWordsFromTextItems(items, viewport);
  if (words.length >= 3) return { img, words, mode: "text" };
  return { img, words: [], mode: "none" };
}

async function ocrPageViaServerless(base64Image, language="ara") {
  const res = await fetch(API_OCR, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Image, language, isOverlayRequired: true })
  });
  if (!res.ok) throw new Error("OCR failed");
  return await res.json();
}
// --------------------------------

function PageOverlay({ img, overlay, lexicon, onWordClick, onWordDblClick }) {
  const [hover, setHover] = useState(null);
  const [pos, setPos] = useState({x:0, y:0});

  return (
    <div style={{...STYLES.page, width: img.width, marginTop: 20}}>
      <img src={img.dataUrl} width={img.width} height={img.height} alt="page" />
      <div style={STYLES.overlayLayer}>
        {overlay?.map((w, idx) => {
          const key = `${idx}-${w.WordText}-${w.Left}-${w.Top}`;
          // Try to find a gloss with normalization
          const formsToTry = [
            w.WordText,
            stripDiacritics(w.WordText),
            normalizeArabic(w.WordText),
            normalizeArabic(stripDiacritics(w.WordText))
          ];
          let entry = null;
          for (const f of formsToTry) {
            if (lexicon[f]) { entry = lexicon[f]; break; }
          }
          // Always show a tooltip with at least the word itself
          const tipText = entry ? (entry.glosses||[]).join(", ") : w.WordText;

          return (
            <span
              key={key}
              dir="rtl"
              onMouseEnter={(e)=>{ setHover({text: tipText}); setPos({x:e.clientX, y:e.clientY}); }}
              onMouseLeave={()=>setHover(null)}
              onClick={()=> onWordClick?.(w, entry) }
              onDoubleClick={()=> onWordDblClick?.(w) }
              style={{
                ...STYLES.overlayWord,
                left: w.Left, top: w.Top, width: w.Width, height: w.Height
              }}
              title={tipText}
            />
          );
        })}
      </div>

      {hover && (
        <div style={{...STYLES.tip, left: pos.x, top: pos.y}}>
          {hover.text}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [pages, setPages] = useState([]); // [{img, overlay, mode}]
  const [activeWord, setActiveWord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState("ara");
  const lexicon = useLexicon();

  async function handleFile(f) {
    setBusy(true); setPages([]); setActiveWord(null);
    try {
      const ab = await f.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: ab }).promise;

      const out = [];
      for (let i=1; i<=pdf.numPages; i++) {
        const page = await pdf.getPage(i);

        // Attempt TEXT extraction first
        let { img, words, mode } = await extractTextOverlay(page, 1.6);

        // If items exist but aren’t Arabic, or no words found → OCR fallback
        if (mode !== "text" || words.length === 0) {
          const ocr = await ocrPageViaServerless(img.dataUrl, lang);
          const pr = ocr?.ParsedResults?.[0];
          const ocrWords = [];
          if (pr?.TextOverlay?.Lines) {
            for (const line of pr.TextOverlay.Lines) {
              const lineText = line.LineText || (line.Words||[]).map(w=>w.WordText).join(" ");
              for (const w of (line.Words||[])) {
                ocrWords.push({ ...w, lineText });
              }
            }
          }
          words = ocrWords;
          mode = "ocr";
        }
        out.push({ img, overlay: words, mode });
      }

      setPages(out);
    } catch (e) {
      alert("Failed to process PDF: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function translateLine(text, source="ar", target="en") {
    const res = await fetch(API_TRANSLATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source, target })
    });
    if (!res.ok) throw new Error("Translate failed");
    const j = await res.json();
    // Handle both {translatedText} and array forms
    if (typeof j?.translatedText === "string") return j.translatedText;
    if (Array.isArray(j) && j[0]?.translatedText) return j[0].translatedText;
    return "";
  }

  async function onWordClick(w, gloss) {
    setActiveWord({ w, gloss, translation: null });
  }
  async function onWordDblClick(w) {
    try {
      const translated = await translateLine(w.lineText || w.WordText, "ar", "en");
      setActiveWord(prev => ({ ...(prev||{w}), translation: translated }));
    } catch (e) {
      alert("Translate failed: " + e.message);
    }
  }

  return (
    <div>
      <div className="topbar" style={{ position: "sticky", top: 0, zIndex: 40, backdropFilter: "blur(8px)", background: "rgba(17,17,17,.6)", borderBottom: "1px solid #1f2937" }}>
        <div className="container" style={{ maxWidth: 1100, margin: "0 auto", padding: 16, display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
          <div style={STYLES.toolbar}>
            <input type="file" accept="application/pdf" onChange={(e)=> e.target.files?.[0] && handleFile(e.target.files[0])} style={STYLES.input} />
            <select value={lang} onChange={(e)=>setLang(e.target.value)} style={STYLES.input}>
              <option value="ara">Arabic (ara)</option>
              <option value="eng">English (eng)</option>
            </select>
            {busy ? <span>Processing…</span> : <span>Ready</span>}
          </div>
          <div style={STYLES.sidebar}>
            <h3 style={{ marginTop: 0 }}>Details</h3>
            {!activeWord && <div>Hover a word for gloss (or the word itself). Click for root/lemma. Double-click the line for translation.</div>}
            {activeWord && (
              <div>
                <div style={{fontSize:18, marginBottom:8}} dir="rtl">{activeWord.w?.WordText}</div>
                {activeWord.gloss && (
                  <div style={{fontSize:14, color:"#9ca3af"}}>
                    <div><b>Lemma:</b> {activeWord.gloss.lemma || "-"}</div>
                    <div><b>Root:</b> {activeWord.gloss.root || "-"}</div>
                    <div><b>Gloss:</b> {(activeWord.gloss.glosses||[]).join(", ")}</div>
                  </div>
                )}
                {activeWord.w?.lineText && (
                  <div style={{marginTop:12}}>
                    <div style={{fontSize:12, color:"#9ca3af"}}>Line</div>
                    <div dir="rtl" style={{fontSize:16}}>{activeWord.w.lineText}</div>
                  </div>
                )}
                {activeWord.translation && (
                  <div style={{marginTop:12}}>
                    <div style={{fontSize:12, color:"#9ca3af"}}>Translation</div>
                    <div style={{fontSize:16}}>{activeWord.translation}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="container" style={{ maxWidth: 1100, margin: "0 auto", padding: 16, display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
        <div>
          {pages.length === 0 && (
            <div style={{opacity:.7, marginTop: 40}}>Upload a PDF to begin.</div>
          )}
          {pages.map((p, i) => (
            <div key={i}>
              <div style={{ color: "#94a3b8", marginTop: 16 }}>
                Page {i+1} <span style={{ fontSize: 12, opacity: .7 }}>({p.mode})</span>
              </div>
              <PageOverlay
                img={p.img}
                overlay={p.overlay}
                lexicon={lexicon}
                onWordClick={onWordClick}
                onWordDblClick={onWordDblClick}
              />
            </div>
          ))}
        </div>
        <div />
      </div>
    </div>
  );
}
