import React, { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();

const API_OCR = "/api/ocr-space";          // serverless proxy (keeps your key secret)
const API_TRANSLATE = "/api/translate";    // serverless proxy to LibreTranslate (no key needed)

const STYLES = {
  page: { position: "relative", margin: "0 auto", boxShadow: "0 10px 30px rgba(0,0,0,.35)", borderRadius: 12, overflow: "hidden", background: "#111" },
  overlayWord: { position: "absolute", lineHeight: 1.6, padding: "2px 4px", borderRadius: 6, cursor: "pointer", color: "transparent" },
  tip: { position: "absolute", bottom: "120%", left: "50%", transform: "translateX(-50%)", background: "#111", color: "#fff", padding: "6px 8px", borderRadius: 8, whiteSpace: "nowrap", fontSize: 12, zIndex: 5, pointerEvents: "none" },
  sidebar: { position: "sticky", top: 16, padding: 12, border: "1px solid #1f2937", borderRadius: 12, background: "rgba(17,17,17,.6)" },
  toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  button: { padding: "8px 12px", borderRadius: 10, border: "1px solid #333", background: "#18181b", color: "#e5e7eb", cursor: "pointer" },
  input: { padding: "8px", borderRadius: 10, border: "1px solid #333", background: "#0b0c10", color: "#e5e7eb", minWidth: 180 },
  thumb: { width: 90, height: 120, objectFit: "cover", borderRadius: 8, border: "1px solid #1f2937", cursor: "pointer" },
};

function useLexicon() {
  const [map, setMap] = useState({});
  useEffect(() => {
    fetch("/lexicon-lite.json")
      .then(r => r.json()).then(rows => {
        const m = {};
        for (const r of rows) {
          m[r.form] = r;
          m[r.lemma || r.form] = r;
        }
        setMap(m);
      }).catch(()=>{});
  }, []);
  return map;
}

function stripDiacritics(s) {
  return (s || "").replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]/g, "");
}

async function pdfToPageImage(pdf, pageNum, scale=1.6) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return { dataUrl, width: canvas.width, height: canvas.height };
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

function PageOverlay({ img, overlay, lexicon, onWordClick, onWordDblClick }) {
  const [hover, setHover] = useState(null);
  const [pos, setPos] = useState({x:0, y:0});
  return (
    <div style={{...STYLES.page, width: img.width, marginTop: 20}}>
      <img src={img.dataUrl} width={img.width} height={img.height} alt="page" />
      <div style={{ position: "absolute", inset: 0 }}>
        {overlay?.map((w, idx) => {
          const key = `${idx}-${w.WordText}-${w.Left}-${w.Top}`;
          const gloss = (lexicon[w.WordText] || lexicon[stripDiacritics(w.WordText)]);
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
                left: w.Left, top: w.Top, width: w.Width, height: w.Height,
                background: hover?.text===w.WordText ? "rgba(147,197,253,.25)" : "rgba(147,197,253,.15)"
              }}
              title={gloss ? (gloss.glosses||[]).join(", ") : ""}
            >
              {w.WordText}
            </span>
          );
        })}
      </div>
      {hover && hover.gloss && (
        <div style={{...STYLES.tip, left: pos.x, top: pos.y, bottom: "auto", transform: "translate(-50%, -120%)", position: "fixed"}}>
          {(hover.gloss.glosses||[]).join(", ")}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [file, setFile] = useState(null);
  const [pages, setPages] = useState([]);
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
      for (let i=1;i<=pdf.numPages;i++) {
        const img = await pdfToPageImage(pdf, i, 1.6);
        const ocr = await ocrPageViaServerless(img.dataUrl, lang);
        const pr = ocr?.ParsedResults?.[0];
        const words = [];
        if (pr?.TextOverlay?.Lines) {
          for (const line of pr.TextOverlay.Lines) {
            const lineText = line.LineText || (line.Words||[]).map(w=>w.WordText).join(" ");
            for (const w of (line.Words||[])) {
              words.push({ ...w, lineText });
            }
          }
        }
        out.push({ img, overlay: words });
      }
      setPages(out);
    } catch (e) {
      alert("Failed to process PDF: " + e.message);
    } finally { setBusy(false); }
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
      <div className="topbar">
        <div className="container" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
          <div style={STYLES.toolbar}>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e)=> e.target.files?.[0] && handleFile(e.target.files[0])}
              style={STYLES.input}
            />
            <select value={lang} onChange={(e)=>setLang(e.target.value)} style={STYLES.input}>
              <option value="ara">Arabic (ara)</option>
              <option value="eng">English (eng)</option>
            </select>
            {busy ? <span>Processing…</span> : <span>Ready</span>}
          </div>
          <div style={{ position: "relative" }}>
            <div style={{...STYLES.sidebar}}>
              <h3 style={{ marginTop: 0 }}>Details</h3>
              {!activeWord && <div>Hover a word for gloss. Click for root/lemma. Double‑click a line for translation.</div>}
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
      </div>

      <div className="container" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
        <div>
          {pages.length === 0 && (
            <div style={{opacity:.7, marginTop: 40}}>Upload a PDF to begin.</div>
          )}
          {pages.map((p, i) => (
            <div key={i}>
              <div style={{ color: "#94a3b8", marginTop: 16 }}>Page {i+1}</div>
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
