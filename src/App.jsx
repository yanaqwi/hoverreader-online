// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();

// Serverless API routes (already in your repo)
const API_OCR = "/api/ocr-space";
const API_TRANSLATE = "/api/translate";

const STYLES = {
  page: { position: "relative", margin: "0 auto", boxShadow: "0 10px 30px rgba(0,0,0,.35)", borderRadius: 12, overflow: "hidden", background: "#111" },
  overlayLayer: { position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" },           // layer itself ignores events
  overlayWord: { position: "absolute", lineHeight: 1.4, padding: "0 2px", borderRadius: 4, pointerEvents: "auto", cursor: "pointer", background: "rgba(147,197,253,.18)" },
  tip: { position: "fixed", bottom: "auto", transform: "translate(-50%, -120%)", background: "#111", color: "#fff", padding: "6px 8px", borderRadius: 8, whiteSpace: "nowrap", fontSize: 12, zIndex: 50, pointerEvents: "none" },
  sidebar: { position: "sticky", top: 16, padding: 12, border: "1px solid #1f2937", borderRadius: 12, background: "rgba(17,17,17,.6)" },
  toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: { padding: "8px", borderRadius: 10, border: "1px solid #333", background: "#0b0c10", color: "#e5e7eb", minWidth: 180 },
};

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

async function pdfToPageImage(page, scale=1.6) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.9), width: canvas.width, height: canvas.height, viewport };
}

// --- TEXT MODE (no OCR): build per-word-ish overlays from pdf.js textContent ---
function layoutWordsFromTextItems(items, viewport) {
  // Each item is a text chunk; we split by spaces to approximate per-word boxes.
  // Compute device-space transform using pdf.js utilities.
  const out = [];
  const vT = viewport.transform;
  for (const it of items) {
    const str = it.str || "";
    if (!str.trim()) continue;

    const width = it.width * viewport.scale; // approx
    const t = pdfjsLib.Util.transform(vT, it.transform); // [a,b,c,d,e,f]
    let x = t[4], y = t[5];
    // pdf.js y is baseline; estimate height from transform
    const fontHeight = Math.hypot(t[1], t[3]) || 12;
    const h = fontHeight;

    // Split by whitespace for word-ish boxes
    const parts = str.split(/\s+/).filter(Boolean);
    const totalChars = str.replace(/\s+/g, "").length || 1;
    let cursorX = x;
    let consumed = 0;
    for (const p of parts) {
      const chars = p.replace(/\s+/g, "").length;
      const w = width * (chars / totalChars);
      out.push({
        WordText: p,
        Left: cursorX,
        Top: y - h,        // y is baseline → move up by height
        Width: w,
        Height: h * 1.1,   // pad a bit
        lineText: str
      });
      cursorX += w + (width * (1 / totalChars)); // small space
      consumed += chars;
    }
  }
  return out;
}

async function extractTextOverlay(page, scale=1.6) {
  const { viewport, ...img } = await pdfToPageImage(page, scale);
  const text = await page.getTextContent();
  const items = text.items || [];
  if (items.length >= 3) {
    const words = layoutWordsFromTextItems(items, viewport);
    return { img, words, mode: "text" };
  }
  return { img, words: [], mode: "none" }; // let caller decide OCR fallback
}

// --- OCR fallback (for scanned pages) ---
async function ocrPageViaServerless(base64Image, language="ara") {
  const res = await fetch(API_OCR, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Image, language, isOverlayRequired: true })
  });
  if (!res.ok) throw new Error("OCR failed");
  return await res.json();
}

function PageOverlay({ img, overlay, lexicon, onWordClick, onWordDblClick }) {
  const [hover, setHover] = useState(null);
  const [pos, setPos] = useState({x:0, y:0});

  return (
    <div style={{...STYLES.page, width: img.width, marginTop: 20}}>
      <img src={img.dataUrl} width={img.width} height={img.height} alt="page" />
      <div style={STYLES.overlayLayer}>
        {overlay?.map((w, idx) => {
          const key = `${idx}-${w.WordText}-${w.Left}-${w.Top}`;
          // Try raw form, then diacritic-stripped
          const gloss = lexicon[w.WordText] || lexicon[stripDiacritics(w.WordText)];
          return (
            <span
              key={key}
              dir="rtl"
              onMouseEnter={(e)=>{ setHover({text:w.WordText, gloss}); setPos({x:e.clientX, y:e.clientY}); }}
              onMouseLeave={()=>setHover(null)}
              onClick={()=> onWordClick?.(w, gloss) }
              onDoubleClick={()=> onWordDblClick?.(w) }
              style={{
                ...STYLES.overlayWord,
                left: w.Left, top: w.Top, width: w.Width, height: w.Height
              }}
              title={gloss ? (gloss.glosses||[]).join(", ") : ""}
            />
          );
        })}
      </div>

      {hover && hover.gloss && (
        <div style={{...STYLES.tip, left: pos.x, top: pos.y}}>
          {(hover.gloss.glosses||[]).join(", ")}
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

        // 1) Try TEXT MODE first
        let { img, words, mode } = await extractTextOverlay(page, 1.6);

        // 2) If no words, fallback to OCR
        if (mode !== "text" || words.length === 0) {
          const ocr = await ocrPageViaServerless(img.dataUrl, lang);
          const pr = ocr?.ParsedResults?.[0];
          const ocrWords = [];
          if (pr?.TextOverlay?.Lines) {
            for (const line of pr.TextOverlay.Lines) {
              const lineText = line.LineText || (line.Words||[]).map(w=>w.WordText).join(" ");
              for (const w of (line.Words||[])) {
                // OCR.space outputs px aligned to the image we sent
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
    return j?.translatedText || "";
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
            {!activeWord && <div>Hover a word for gloss. Click for root/lemma. Double-click a line for translation.</div>}
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
        <div /> {/* spacer */}
      </div>
    </div>
  );
}
