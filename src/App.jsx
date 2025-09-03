// HoverReader Frontend — v0.4.0
// - Fixes: visible per-page progress, timeouts, and safer PDF text extraction
// - Adds: .DOCX support via client-side rendering (docx-preview)
// - Hover: Arabic→English tooltip (lexicon→cache→/api/translate)
// - Click: shows line in sidebar; Double-click: line translation
// - UI: page cap, force OCR, draw test boxes, error surfacing

import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfJsWorker from "pdfjs-dist/build/pdf.worker?worker";
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfJsWorker();

// Lazy import for DOCX rendering (docx-preview)
let renderDocxAsync = null;
async function loadDocxPreview() {
  if (!renderDocxAsync) {
    const mod = await import("docx-preview");
    renderDocxAsync = mod.renderAsync;
  }
  return renderDocxAsync;
}

const API_OCR = "/api/ocr-space";
const API_TRANSLATE = "/api/translate";

/** Simple LRU-ish cache for word translations */
class WordCache {
  constructor(limit = 1000) {
    this.map = new Map();
    this.limit = limit;
  }
  get(key) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.limit) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
}
const WORD_CACHE = new WordCache(1000);

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
    pointerEvents: "auto",
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
    maxWidth: "60vw",
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
  error: {
    background: "#7f1d1d",
    color: "#fecaca",
    padding: "8px 10px",
    borderRadius: 8,
    marginTop: 8,
    border: "1px solid #ef4444",
  },
  docxShell: {
    background: "#111",
    padding: 16,
    borderRadius: 12,
    border: "1px solid #1f2937",
  },
  docxPage: {
    margin: "16px auto",
    padding: "24px 28px",
    background: "#fff",
    color: "#000",
    width: 820,
    boxShadow: "0 10px 30px rgba(0,0,0,.35)",
    borderRadius: 12,
    direction: "rtl",
  },
};

// ------- Lexicon (tiny demo) -------
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
function safeIsArabicString(s = "") {
  if (!s) return false;
  try {
    const ok =
      s.split("").filter((c) => /\p{Script=Arabic}/u.test(c)).length / s.length >= 0.6;
    return ok;
  } catch {
    const arabic = (s.match(/[\u0600-\u06FF]/g) || []).length;
    return arabic / s.length >= 0.6;
  }
}

async function translateAPI(text, source = "ar", target = "en") {
  const r = await fetch(API_TRANSLATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source, target }),
  });
  if (!r.ok) throw new Error("Translate failed");
  const j = await r.json();
  if (typeof j?.translatedText === "string") return j.translatedText;
  if (Array.isArray(j) && j[0]?.translatedText) return j[0].translatedText;
  return "";
}

async function getWordTooltip(arWord, lexicon) {
  if (!arWord || !arWord.trim()) return "";
  const candidates = [
    arWord,
    stripDiacritics(arWord),
    normalizeArabic(arWord),
    normalizeArabic(stripDiacritics(arWord)),
  ];
  for (const c of candidates) {
    const entry = lexicon[c];
    if (entry) return (entry.glosses || []).join(", ");
  }
  const cached = WORD_CACHE.get(arWord);
  if (cached) return cached;
  try {
    const en = await translateAPI(arWord, "ar", "en");
    const tip = en || arWord;
    WORD_CACHE.set(arWord, tip);
    return tip;
  } catch {
    return arWord;
  }
}

// ---------- PDF helpers ----------
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

function layoutWordsFromTextItems(items, viewport) {
  const out = [];
  const vT = viewport.transform;
  for (const it of items) {
    const str = it.str || "";
    if (!str.trim()) continue;
    if (!safeIsArabicString(str)) continue;

    const width = it.width * viewport.scale;
    const t = pdfjsLib.Util.transform(vT, it.transform);
    const x = t[4], y = t[5];
    const fontHeight = Math.hypot(t[1], t[3]) || 12;
    const h = fontHeight;

    const clean = str.replace(/\s+/g, " ").trim();
    const parts = clean.split(" ").filter(Boolean);
    const totalChars = clean.replace(/\s+/g, "").length || 1;
    let cursorX = x;
    for (const p of parts) {
      const chars = p.replace(/\s+/g, "").length;
      const w = Math.max(3, width * (chars / totalChars));
      out.push({
        WordText: p,
        Left: cursorX,
        Top: y - h,
        Width: w,
        Height: Math.max(10, h * 1.15),
        lineText: str,
      });
      cursorX += w + width * (1 / totalChars);
    }
  }
  return out;
}

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout")), ms));
}
async function ocrPageViaServerless(base64Image, language = "ara", ms = 20000) {
  const req = fetch(API_OCR, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Image, language, isOverlayRequired: true }),
  });
  const res = await Promise.race([req, timeout(ms)]);
  if (!res.ok) throw new Error(`OCR HTTP ${res.status}`);
  return await res.json();
}

// ---------- DOCX helpers ----------
/** Wrap text nodes with <span class="hr-word" data-word="...">… */
function wrapDocxWords(container, onHover, onClick, onDblClick) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node.nodeValue || "";
      return /\S/.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const arabicWord = /[\u0600-\u06FF]+/g;
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach((textNode) => {
    const text = textNode.nodeValue;
    const parent = textNode.parentNode;
    if (!parent) return;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    text.replace(arabicWord, (match, index) => {
      // text before the word
      if (index > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, index)));
      }
      // the word span
      const span = document.createElement("span");
      span.className = "hr-word";
      span.textContent = match;
      span.dir = "rtl";
      span.style.background = "rgba(147,197,253,.06)";
      span.style.borderRadius = "4px";
      span.style.cursor = "pointer";
      span.style.padding = "0 2px";
      span.addEventListener("mouseenter", (e) => onHover(e, match));
      span.addEventListener("mousemove", (e) => onHover(e, match));
      span.addEventListener("mouseleave", () => onHover(null, null));
      span.addEventListener("click", () => onClick(match));
      span.addEventListener("dblclick", () => onDblClick(match, span));
      frag.appendChild(span);

      lastIndex = index + match.length;
      return match;
    });
    // trailing text
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(frag, textNode);
  });
}

// ---------- Overlay page for PDF ----------
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
  const lastHoverWord = useRef("");

  async function handleEnter(e, w) {
    setPos({ x: e.clientX, y: e.clientY });
    e.currentTarget.style.outline = "2px solid rgba(147,197,253,.9)";
    const word = (w.WordText || "").trim();
    if (!word) {
      setHover(null);
      return;
    }
    if (lastHoverWord.current === word && hover?.text) {
      setHover({ text: hover.text });
      return;
    }
    setHover({ text: word }); // placeholder
    lastHoverWord.current = word;
    const tip = await getWordTooltip(word, lexicon);
    if (lastHoverWord.current === word) setHover({ text: tip });
  }

  function handleLeave(e) {
    e.currentTarget.style.outline = "none";
    setHover(null);
  }

  return (
    <div style={{ ...STYLES.page, width: img.width, marginTop: 20 }}>
      <img src={img.dataUrl} width={img.width} height={img.height} alt="page" />
      <div style={STYLES.overlayLayer}>
        {overlay?.map((w, idx) => {
          const key = `${idx}-${w.WordText}-${w.Left}-${w.Top}`;
          return (
            <span
              key={key}
              dir="rtl"
              onMouseEnter={(e) => handleEnter(e, w)}
              onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={handleLeave}
              onClick={() => onWordClick?.(w, null)}
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
              title=""
            />
          );
        })}
      </div>
      {hover && <div style={{ ...STYLES.tip, left: pos.x, top: pos.y }}>{hover.text}</div>}
    </div>
  );
}

export default function App() {
  const [pages, setPages] = useState([]); // PDF pages [{img, overlay, ...}]
  const [docxMode, setDocxMode] = useState(false);
  const [activeWord, setActiveWord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState("ara");
  const [showBoxes, setShowBoxes] = useState(true);
  const [forceOcr, setForceOcr] = useState(false);
  const [testBoxes, setTestBoxes] = useState(false);
  const [maxPages, setMaxPages] = useState(3); // cap for PDFs
  const [status, setStatus] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [hoverTip, setHoverTip] = useState(null); // for DOCX
  const lexicon = useLexicon();

  const docxContainerRef = useRef(null);

  async function handleFile(file) {
    setBusy(true);
    setPages([]);
    setActiveWord(null);
    setHoverTip(null);
    setGlobalError("");
    setDocxMode(false);
    setStatus("Loading…");

    const name = (file?.name || "").toLowerCase();
    const isPDF = name.endsWith(".pdf") || file.type === "application/pdf";
    const isDOCX =
      name.endsWith(".docx") ||
      file.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    try {
      if (isPDF) {
        await handlePdf(file);
      } else if (isDOCX) {
        await handleDocx(file);
      } else {
        throw new Error("Unsupported file type. Please upload PDF or DOCX.");
      }
    } catch (e) {
      setGlobalError(e?.message || String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(""), 1200);
    }
  }

  // -------- PDF pipeline --------
  async function handlePdf(f) {
    const ab = await f.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: ab }).promise;

    const total = pdf.numPages;
    const limit = Math.min(total, Math.max(1, Number(maxPages) || 1));
    const out = [];

    for (let i = 1; i <= limit; i++) {
      setStatus(`Processing page ${i} of ${limit}…`);
      let pageMeta = { img: null, overlay: [], mode: "none", reason: "", boxCount: 0 };

      try {
        const page = await pdf.getPage(i);
        const { viewport, ...img } = await pdfToPageImage(page, 1.6);
        pageMeta.img = { dataUrl: img.dataUrl, width: img.width, height: img.height };

        let words = [];
        let mode = "text";
        let reason = "";

        if (!forceOcr) {
          const text = await page.getTextContent({ disableCombineTextItems: false });
          const items = text.items || [];
          const arabicItems = items.filter((it) => safeIsArabicString(it.str || ""));
          if (items.length > 0 && arabicItems.length / items.length < 0.2) {
            mode = "none";
            reason = "embedded-glyphs";
          } else {
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

        if (mode !== "text" || words.length === 0) {
          setStatus(`OCR page ${i}…`);
          try {
            const ocr = await ocrPageViaServerless(img.dataUrl, lang, 25000);
            const pr = ocr?.ParsedResults?.[0];
            const ocrWords = [];
            if (pr?.TextOverlay?.Lines) {
              for (const line of pr.TextOverlay.Lines) {
                const lineText = line.LineText || (line.Words || []).map((w) => w.WordText).join(" ");
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
            } else if (!reason) {
              reason = "No usable text layer; OCR used.";
            }
          } catch (e) {
            words = [];
            mode = "ocr";
            reason = "OCR error: " + (e?.message || e);
          }
        }

        if (testBoxes) {
          const synth = [];
          for (let k = 0; k < 6; k++) {
            const w = 120, h = 36;
            const left = 20 + k * 24;
            const top = 50 + k * 28;
            synth.push({
              WordText: "اختبار",
              Left: left,
              Top: top,
              Width: w,
              Height: h,
              lineText: "مربع اختبار تفاعلي",
            });
          }
          words = words.concat(synth);
        }

        pageMeta.overlay = words;
        pageMeta.mode = (mode || "none");
        pageMeta.reason = reason || "";
        pageMeta.boxCount = words.length;
      } catch (e) {
        pageMeta.error = (e?.message || String(e));
      }

      out.push(pageMeta);
      setPages((prev) => [...prev, pageMeta]);
    }
  }

  // -------- DOCX pipeline --------
  async function handleDocx(file) {
    setDocxMode(true);
    setStatus("Rendering DOCX…");
    const container = docxContainerRef.current;
    container.innerHTML = ""; // clear

    const arrayBuffer = await file.arrayBuffer();
    const renderAsync = await loadDocxPreview();
    await renderAsync(arrayBuffer, container, container, {
      // docx-preview options
      ignoreWidth: false,
      ignoreHeight: false,
      className: "hr-docx",
    });

    // Wrap Arabic words with spans to enable hover/click
    const tipState = { text: "", pos: { x: 0, y: 0 } };
    const onHover = async (e, word) => {
      if (!e || !word) {
        setHoverTip(null);
        return;
      }
      tipState.pos = { x: e.clientX, y: e.clientY };
      // show immediate placeholder
      setHoverTip({ text: word, x: tipState.pos.x, y: tipState.pos.y });
      const gloss = await getWordTooltip(word, lexicon);
      setHoverTip({ text: gloss || word, x: tipState.pos.x, y: tipState.pos.y });
    };
    const onClick = (word) => {
      setActiveWord({ w: { WordText: word, lineText: "" }, translation: null });
    };
    const onDblClick = async (word, span) => {
      // get containing line text (nearest block)
      let block = span?.closest("p, div, span");
      const lineText = (block?.innerText || word).replace(/\s+/g, " ").trim();
      const translated = await translateAPI(lineText, "ar", "en").catch(() => "");
      setActiveWord({ w: { WordText: word, lineText }, translation: translated });
    };

    wrapDocxWords(container, onHover, onClick, onDblClick);
    setStatus("Done.");
  }

  async function translateLine(text, source = "ar", target = "en") {
    try {
      const t = await translateAPI(text, source, target);
      return t;
    } catch {
      return "";
    }
  }

  function onWordClickPDF(w) {
    setActiveWord({ w, gloss: null, translation: null });
  }
  async function onWordDblClickPDF(w) {
    const translated = await translateLine(w.lineText || w.WordText, "ar", "en");
    setActiveWord((prev) => ({ ...(prev || { w }), translation: translated }));
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
            gridTemplateColumns: "1fr 380px",
            gap: 16,
          }}
        >
          <div style={STYLES.toolbar}>
            <input
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              style={STYLES.input}
            />
            {!docxMode && (
              <>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  Max pages:
                  <input
                    type="number"
                    min={1}
                    value={maxPages}
                    onChange={(e) => setMaxPages(e.target.value)}
                    style={{ ...STYLES.input, width: 90 }}
                  />
                </label>
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  style={STYLES.input}
                  title="OCR language (for images or non-Unicode PDFs)"
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
              </>
            )}
            {busy ? <span>Processing…</span> : <span>Ready</span>}
            {status && <span style={STYLES.badge}>{status}</span>}
          </div>

          <div style={STYLES.sidebar}>
            <h3 style={{ marginTop: 0 }}>Details</h3>
            {!activeWord && (
              <div>
                Hover a word → English tooltip. Click a word → inspect. Double-click a line → translate.
              </div>
            )}
            {activeWord && (
              <div>
                <div style={{ fontSize: 18, marginBottom: 8 }} dir="rtl">
                  {activeWord.w?.WordText}
                </div>
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
            {globalError && <div style={STYLES.error}>{globalError}</div>}
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
          gridTemplateColumns: "1fr 380px",
          gap: 16,
        }}
      >
        <div>
          {!docxMode && pages.length === 0 && (
            <div style={{ opacity: 0.7, marginTop: 40 }}>
              Upload a PDF or DOCX to begin.
              <div style={{ marginTop: 8, fontSize: 13, color: "#9ca3af" }}>
                (PDFs are limited to first {maxPages} page{Number(maxPages) > 1 ? "s" : ""} by default.)
              </div>
            </div>
          )}

          {/* PDF rendering */}
          {!docxMode &&
            pages.map((p, i) => (
              <div key={i}>
                <div style={{ color: "#94a3b8", marginTop: 16 }}>
                  Page {i + 1}
                  <span style={STYLES.badge}>mode: {p.mode}</span>
                  <span style={STYLES.badge}>boxes: {p.boxCount}</span>
                  {p.reason && <span style={STYLES.warning}>• {p.reason}</span>}
                </div>
                {p.error && <div style={STYLES.error}>Error: {p.error}</div>}
                {p.img ? (
                  <PageOverlay
                    img={p.img}
                    overlay={p.overlay}
                    lexicon={lexicon}
                    onWordClick={onWordClickPDF}
                    onWordDblClick={onWordDblClickPDF}
                    showBoxes={showBoxes}
                  />
                ) : (
                  <div style={STYLES.error}>Failed to render this page.</div>
                )}
              </div>
            ))}

          {/* DOCX rendering */}
          {docxMode && (
            <div style={STYLES.docxShell}>
              <div ref={docxContainerRef} style={STYLES.docxPage} dir="rtl" />
              {hoverTip && (
                <div style={{ ...STYLES.tip, left: hoverTip.x, top: hoverTip.y }}>
                  {hoverTip.text}
                </div>
              )}
            </div>
          )}
        </div>
        <div /> {/* spacer */}
      </div>
    </div>
  );
}
