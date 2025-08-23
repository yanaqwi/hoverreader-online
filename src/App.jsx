// src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();

const API_OCR = "/api/ocr-space";
const API_TRANSLATE = "/api/translate";

const STYLES = {
  page: { position: "relative", margin: "0 auto", boxShadow: "0 10px 30px rgba(0,0,0,.35)", borderRadius: 12, overflow: "hidden", background: "#111" },
  overlayLayer: { position: "absolute", inset: 0, zIndex: 5, pointerEvents: "auto" }, // must be 'auto' so hover/click works
  overlayWord: {
    position: "absolute",
    lineHeight: 1.4,
    padding: "0 2px",
    borderRadius: 4,
    pointerEvents: "auto",
    cursor: "pointer",
    background: "rgba(147,197,253,.18)",
    transition: "outline 120ms ease, background 120ms ease"
  },
  tip: {
    position: "fixed",
    bottom: "auto",
    transform: "translate(-50%, -120%)",
    background: "#111",
    color: "#fff",
    padding: "6px 8px",
    borderRadius: 8,
    whiteSpace: "nowrap",
    fontSize: 12,
    zIndex: 50,
    pointerEvents: "none"
  },
  sidebar: { position: "sticky", top: 16, padding: 12, border: "1px solid #1f2937", borderRadius: 12, background: "rgba(17,17,17,.6)" },
  toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: { padding: "8px", borderRadius: 10, border: "1px solid #333", background: "#0b0c10", color: "#e5e7eb", minWidth: 180 },
};

// ---------- helpers ----------
function useLexicon() {
  const [map, setMap] = useState({});
  useEffect(() => {
    fetch("/lexicon-lite.json")
      .then(r => r.json())
      .then(rows => {
        const m = {};
        for (const r of rows) {
          if (r.form) m[r.form] = r;
          if (r.lemma) m[r.lemma] = r;
        }
        setMap(m);
      })
      .catch(() => {});
  }, []);
  return map;
}

function stripDiacritics(s) {
  return (s || "").replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]/g, "");
}
function normalizeArabic(s = "") {
  return s
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئ]/g, "ء")
    .replace(/ـ/g, "")
    .replace(/[^\u0600-\u06FF\s]/g, "");
}
function isArabicString(s = "") {
  const chars = [...s];
  if (chars.length === 0) return false;
  const arabic = chars.filter(c => /\p{Script=Arabic}/u.test(c)).length;
  return arabic / chars.length >= 0.6;
}

async function pdfToPageImage(page, scale = 1.6) {
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
    const t = pdfjsLib.Util.transform(vT, it.transform); // [a,b,c,d,e,f]
    let x = t[4],
      y = t[5];
    const fontHeight = Math.hypot(t[1], t[3]) || 12;
    const h = fontHeight;

    // Split by whitespace for word-ish boxes
    const pieces = str.split(/\s+/).filter(Boolean);
    const totalChars = str.replace(/\s+/g, "").length || 1;
    let cursorX = x;
    for (const p of pieces) {
      const chars = p.replace(/\s+/g, "").length;
      const w = width * (chars / totalChars);
      out.push({
        WordText: p,
        Left: cursorX,
        Top: y - h, // baseline → move up by height
        Width: w,
        Height: h * 1.1,
        lineText: str
      });
      cursorX += w + width * (1 / totalChars); // small space
    }
  }
  return out;
}

async function extractTextOverlay(page, scale = 1.6) {
  const { viewport, ...img } = await pdfToPageImage(page, scale);
  const text = await page.getTextContent();
  const items = text.items || [];

  // If text items exist but < 20% are Arabic → treat as unusable → let caller OCR
  const arabicItems = items.filter(it => isArabicString(it.str || ""));
  if (items.length > 0 && arabicItems.length / items.length < 0.2) {
    return { img, words: [], mode: "none" };
  }

  const words = layoutWordsFromTextItems(items, viewport);
  if (words.length >= 3) return { img, words, mode: "text" };
  return { img, words: [], mode: "none" };
}

async function ocrPageViaServerless(base64Image, language = "ara") {
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
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <div style={{ ...STYLES.page, width: img.width, marginTop: 20 }}>
      <img src={img.dataUrl} width={img.width} height={img.height} alt="page" />
      <div style={STYLES.overlayLayer}>
        {overlay?.map((w, idx) => {
          const key = `${idx}-${w.WordText}-${w.Left}-${w.Top}`;
          // Try to find a gloss with normalization
          const candidates = [
            w.WordText,
            stripDiacritics(w.WordText),
            normalizeArabic(w.WordText),
            normalizeArabic(stripDiacritics(w.WordText))
          ];
          let entry = null;
          for (const c of candidates) {
            if (lexicon[c]) {
              entry = lexicon[c];
              break;
            }
          }
          const tipText = entry ? (entry.glosses || []).join(", ") : w.WordText;

          return (
            <span
              key={key}
              dir="rtl"
              onMouseEnter={e => {
                setHover({ text: tipText });
                setPos({ x: e.clientX, y: e.clientY });
                e.currentTarget.style.outline = "2px solid rgba(147,197,253,.9)";
              }}
              onMouseLeave={e => {
                setHover(null);
                e.currentTarget.style.outline = "none";
              }}
              onClick={() => onWordClick?.(w, entry)}
              onDoubleClick={() => onWordDblClick?.(w)}
              style={{
                ...STYLES.overlayWord,
                left: w.Left,
                top: w.Top,
                width: w.Width,
                height: w.Height
              }}
              title={tipText}
            />
          );
        })}
      </div>

      {hover && <div style={{ ...STYLES.tip, left: pos.x, top: pos.y }}>{hover.text}</div>}
    </div>
  );
}

export default function
