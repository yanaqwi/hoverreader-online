// src/App.jsx
import React, { useEffect, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();

const API_OCR = "/api/ocr-space";
const API_TRANSLATE = "/api/translate";

const STYLES = {
  page: {
    position: "relative",
    margin: "0 auto",
    boxShadow: "0 10px 30px rgba(0,0,0,.35)",
    borderRadius: 12,
    overflow: "hidden",
    background: "#111",
  },
  overlayLayer: {
    position: "absolute",
    inset: 0,
    zIndex: 5,
    pointerEvents: "auto", // MUST be 'auto' so hover/click works
  },
  overlayWord: {
    position: "absolute",
    lineHeight: 1.2,
    borderRadius: 4,
    pointerEvents: "auto",
    cursor: "pointer",
    background: "rgba(147,197,253,.16)",
    outlineOffset: 0,
    transition: "outline 120ms ease, background 120ms ease",
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
    pointerEvents: "none",
  },
  sidebar: {
    position: "sticky",
    top: 16,
    padding: 12,
    border: "1px solid #1f2937",
    borderRadius: 12,
    background: "rgba(17,17,17,.6)",
  },
  toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: {
    padding: "8px",
    borderRadius: 10,
    border: "1px solid #333",
    background: "#0b0c10",
    color: "#e5e7eb",
    minWidth: 180,
  },
  badge: {
    display: "inline-block",
    marginLeft: 8,
    fontSize: 12,
    padding: "2px 6px",
    borderRadius: 6,
    background: "#1f2937",
    color: "#e5e7eb",
  },
  warning: {
    display: "inline-block",
    marginLeft: 8,
    fontSize: 12,
    padding: "2px 6px",
    borderRadius: 6,
    background: "#7c2d12",
    color: "#fde68a",
  },
};

// ---------- lexicon (tiny demo) ----------
function useLexicon() {
  const [map, setMap] = useState({});
  useEffect(() => {
    fetch("/lexicon-lite.json")
      .then((r) => r.json())
      .then((rows) => {
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
// Safe Arabic detection (works even if \p{Script=Arabic} unsupported)
function safeIsArabicString(s = "") {
  if (!s) return false;
  try {
    const ok =
      s
        .split("")
        .filter((c) => /\p{Script=Arabic}/u.test(c)).length / s.length >= 0.6;
    return ok;
  } catch {
    const arabic = (s.match(/[\u0600-\u06FF]/g) || []).length;
    return arabic / s.length >= 0.6;
  }
}

async function pdfToPageImage(page, scale = 1.6) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.9),
    width: canvas.width,
    height: canvas.height,
    viewport,
  };
}

// Build word-ish boxes from text items (text mode)
function layoutWordsFromTextItems(items, viewport) {
  const out = [];
  const vT = viewport.transform;
  for (const it of items) {
    const str = it.str || "";
    if (!str.trim()) continue;
    if (!safeIsArabicString(str)) continue; // skip glyph junk

    const width = it.width * viewport.scale;
    const t = pdfjsLib.Util.transform(vT, it.transform); // [a,b,c,d,e,f]
    const x = t[4],
      y = t[5];
    const fontHeight = Math.hypot(t[1], t[3]) || 12;
    const h = fontHeight;

    const clean = str.replace(/\s+/g, " ").trim();
    const parts = clean.split(" ").filter(Boolean);
    const totalChars = clean.replace(/\s+/g, "").length || 1;
    let cursorX = x;
    for (const p of parts) {
      const chars = p.replace(/\s+/g, "").length;
      const w = Math.max(3, width * (chars / totalChars)); // ensure clickable width >=3px
      out.push({
        WordText: p,
        Left: cursorX,
        Top: y - h, // baseline → top
        Width: w,
        Height: Math.max(10, h * 1.15), // ensure min height so it's clickable
        lineText: str,
      });
      cursorX += w + width * (1 / totalChars);
    }
  }
  return out;
}

async function extractTextOverlay(page, scale = 1.6) {
  const { viewport, ...img } = await pdfToPageImage(page, scale);
  const text = await page.getTextContent();
  const items = text.items || [];

  const arabicItems = items.filter((it) => safeIsArabicString(it.str || ""));
  if (items.length > 0 && arabicItems.length / items.length < 0.2) {
    return { img, words: [], mode: "none", reason: "embedded-glyphs" };
  }

  const words = layoutWordsFromTextItems(items, viewport);
  if (words.length >= 3) return { img, words, mode: "text", reason: "" };
  return { img, words: [], mode: "none", reason: "no-words" };
}

async function ocrPageViaServerless(base64Image, language = "ara") {
  const res = await fetch(API_OCR, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Image, language, isOverlayRequired: true }),
  });
  if (!res.ok) throw new Error("OCR failed");
  return await res.json();
}

function PageOverlay({
  img,
  overlay,
  lexicon,
  onWordClick,
  onWordDblClick,
  showBoxes,
}) {
  const [hover, setHover] = useState(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <div style={{ ...STYLES.page, width: img.width, marginTop: 20 }}>
      <img src={img.dataUrl} width={img.width} height={img.height} alt="page" />
      <div style={STYLES.overlayLayer}>
        {overlay?.map((w, idx) => {
          const key = `${idx}-${w.WordText}-${w.Left}-${w.Top}`;
          const candidates = [
            w.WordText,
            stripDiacritics(w.WordText),
            normalizeArabic(w.WordText),
            normalizeArabic(stripDiacritics(w.WordText)),
          ];
          let entry = null;
          for (const c of candidates) {
            if (lexicon[c]) {
              entry = lexicon[c];
              break;
            }
          }
          const tipText = entry
            ? (entry.glosses || []).join(", ")
            : w.WordText;

          return (
            <span
              key={key}
              dir="rtl"
              onMouseEnter={(e) => {
                setHover({ text: tipText });
                setPos({ x: e.clientX, y: e.clientY });
                e.currentTarget.style.outline =
                  "2px solid rgba(147,197,253,.9)";
              }}
              onMouseLeave={(e) => {
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
                height: w.Height,
                background: showBoxes
                  ? "rgba(147,197,253,.16)"
                  : "rgba(147,197,253,.06)",
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

export default function App() {
  const [pages, setPages] = useState([]); // [{img, overlay, mode, reason, boxCount}]
  const [activeWord, setActiveWord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState("ara");
  const [showBoxes, setShowBoxes] = useState(true);
  const [forceOcr, setForceOcr] = useState(false); // DEBUG: force OCR path
  const [testBoxes, setTestBoxes] = useState(false); // DEBUG: draw synthetic boxes
  const lexicon = useLexicon();

  async function handleFile(f) {
    setBusy(true);
    setPages([]);
    setActiveWord(null);
    try {
      const ab = await f.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: ab }).promise;

      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);

        // Render page to image
        const { viewport, ...img } = await (async () => {
          const vpPage = await pdf.getPage(i);
          const viewport = vpPage.getViewport({ scale: 1.6 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await vpPage.render({
            canvasContext: canvas.getContext("2d"),
            viewport,
          }).promise;
          return {
            dataUrl: canvas.toDataURL("image/jpeg", 0.9),
            width: canvas.width,
            height: canvas.height,
            viewport,
          };
        })();

        let words = [];
        let mode = "text";
        let reason = "";

        if (!forceOcr) {
          // Try TEXT extraction first
          const text = await page.getTextContent();
          const items = text.items || [];

          const arabicItems = items.filter((it) =>
            safeIsArabicString(it.str || "")
          );
          if (items.length > 0 && arabicItems.length / items.length < 0.2) {
            mode = "none";
            reason = "embedded-glyphs";
          } else {
            // Layout word-ish boxes
            words = layoutWordsFromTextItems(items, viewport);
            if (words.length < 3) {
              mode = "none";
              reason = "no-words";
            }
          }
        } else {
          mode = "none";
          reason = "forced-ocr";
        }

        // Fallback to OCR when needed
        if (mode !== "text" || words.length === 0) {
          try {
            const ocr = await ocrPageViaServerless(img.dataUrl, lang);
            const pr = ocr?.ParsedResults?.[0];
            const ocrWords = [];
            if (pr?.TextOverlay?.Lines) {
              for (const line of pr.TextOverlay.Lines) {
                const lineText =
                  line.LineText ||
                  (line.Words || []).map((w) => w.WordText).join(" ");
                for (const w of line.Words || []) {
                  ocrWords.push({ ...w, lineText });
                }
              }
            }
            words = ocrWords;
            mode = "ocr";
            if (reason === "embedded-glyphs") {
              reason = "Embedded text wasn’t Unicode Arabic; OCR used.";
            } else if (reason === "forced-ocr") {
              reason = "Force OCR enabled.";
            } else {
              reason = "No usable text layer; OCR used.";
            }
          } catch (e) {
            words = [];
            mode = "ocr";
            reason = "OCR error: " + e.message;
          }
        }

        // DEBUG: draw synthetic clickable boxes to prove overlay works
        if (testBoxes) {
          const synth = [];
          for (let k = 0; k < 6; k++) {
            const w = 120,
              h = 36;
            const left = 20 + k * 24;
            const top = 50 + k * 28;
            synth.push({
              WordText: "TEST",
              Left: left,
              Top: top,
              Width: w,
              Height: h,
              lineText: "Synthetic test box",
            });
          }
          words = words.concat(synth);
        }

        out.push({
          img: { dataUrl: img.dataUrl, width: img.width, height: img.height },
          overlay: words,
          mode,
          reason,
          boxCount: words.length,
        });
      }

      setPages(out);
    } catch (e) {
      alert("Failed to process PDF: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function translateLine(text, source = "ar", target = "en") {
    const res = await fetch(API_TRANSLATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source, target }),
    });
    if (!res.ok) throw new Error("Translate failed");
    const j = await res.json();
    if (typeof j?.translatedText === "string") return j.translatedText;
    if (Array.isArray(j) && j[0]?.translatedText) return j[0].translatedText;
    return "";
  }

  function onWordClick(w, gloss) {
    setActiveWord({ w, gloss, translation: null });
  }
  async function onWordDblClick(w) {
    try {
      const translated = await translateLine(
        w.lineText || w.WordText,
        "ar",
        "en"
      );
      setActiveWord((prev) => ({ ...(prev || { w }), translation: translated }));
    } catch (e) {
      alert("Translate failed: " + e.message);
    }
  }

  return (
    <div>
      {/* Top bar */}
      <div
        className="topbar"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          backdropFilter: "blur(8px)",
          background: "rgba(17,17,17,.6)",
          borderBottom: "1px solid #1f2937",
        }}
      >
        <div
          className="container"
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: 16,
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: 16,
          }}
        >
          <div style={STYLES.toolbar}>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) =>
                e.target.files?.[0] && handleFile(e.target.files[0])
              }
              style={STYLES.input}
            />
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              style={STYLES.input}
            >
              <option value="ara">Arabic (ara)</option>
              <option value="eng">English (eng)</option>
            </select>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={showBoxes}
                onChange={(e) => setShowBoxes(e.target.checked)}
              />
              Show boxes
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={forceOcr}
                onChange={(e) => setForceOcr(e.target.checked)}
              />
              Force OCR
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={testBoxes}
                onChange={(e) => setTestBoxes(e.target.checked)}
              />
              Draw test boxes
            </label>
            {busy ? <span>Processing…</span> : <span>Ready</span>}
          </div>

          <div style={STYLES.sidebar}>
            <h3 style={{ marginTop: 0 }}>Details</h3>
            {!activeWord && (
              <div>
                Hover for a tooltip (word or gloss). Click for root/lemma.
                Double-click a line to translate.
              </div>
            )}
            {activeWord && (
              <div>
                <div style={{ fontSize: 18, marginBottom: 8 }} dir="rtl">
                  {activeWord.w?.WordText}
                </div>
                {activeWord.gloss && (
                  <div style={{ fontSize: 14, color: "#9ca3af" }}>
                    <div>
                      <b>Lemma:</b> {activeWord.gloss.lemma || "-"}
                    </div>
                    <div>
                      <b>Root:</b> {activeWord.gloss.root || "-"}
                    </div>
                    <div>
                      <b>Gloss:</b>{" "}
                      {(activeWord.gloss.glosses || []).join(", ")}
                    </div>
                  </div>
                )}
                {activeWord.w?.lineText && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>Line</div>
                    <div dir="rtl" style={{ fontSize: 16 }}>
                      {activeWord.w.lineText}
                    </div>
                  </div>
                )}
                {activeWord.translation && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>
                      Translation
                    </div>
                    <div style={{ fontSize: 16 }}>
                      {activeWord.translation}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main area */}
      <div
        className="container"
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: 16,
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: 16,
        }}
      >
        <div>
          {pages.length === 0 && (
            <div style={{ opacity: 0.7, marginTop: 40 }}>
              Upload a PDF to begin.
            </div>
          )}
          {pages.map((p, i) => (
            <div key={i}>
              <div style={{ color: "#94a3b8", marginTop: 16 }}>
                Page {i + 1}
                <span style={STYLES.badge}>mode: {p.mode}</span>
                <span style={STYLES.badge}>boxes: {p.boxCount}</span>
                {p.reason && (
                  <span style={STYLES.warning}>• {p.reason}</span>
                )}
              </div>
              <PageOverlay
                img={p.img}
                overlay={p.overlay}
                lexicon={lexicon}
                onWordClick={onWordClick}
                onWordDblClick={onWordDblClick}
                showBoxes={showBoxes}
              />
            </div>
          ))}
        </div>
        <div /> {/* spacer */}
      </div>
    </div>
  );
}
