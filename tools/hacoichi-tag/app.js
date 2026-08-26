// ハコイチ値札加工ツール
// すべての処理はブラウザ内で完結（PDFはサーバーに送信されません）

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs";

const JP_FONT_URL =
  "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp@0.4.3/400Regular/NotoSansJP_400Regular.ttf";

const MM = 2.83465; // pt per mm
const RENDER_SCALE = 4; // render resolution multiplier for card detection

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const optionsEl = document.getElementById("options");
const processBtn = document.getElementById("processBtn");
const previewArea = document.getElementById("previewArea");
const previewCanvas = document.getElementById("previewCanvas");
const downloadLink = document.getElementById("downloadLink");
const stapleMarginInput = document.getElementById("stapleMargin");
const gapMmInput = document.getElementById("gapMm");

let currentFileBytes = null;
let jpFontBytesCache = null;

function setStatus(msg, kind) {
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  if (file.type !== "application/pdf") {
    setStatus("PDFファイルを選んでください。", "error");
    return;
  }
  currentFileBytes = new Uint8Array(await file.arrayBuffer());
  optionsEl.hidden = false;
  previewArea.hidden = true;
  setStatus(`「${file.name}」を読み込みました。設定を確認して「変換する」を押してください。`, "ok");
}

processBtn.addEventListener("click", () => {
  if (!currentFileBytes) return;
  process().catch((err) => {
    console.error(err);
    setStatus("エラーが発生しました：" + err.message, "error");
  });
});

async function process() {
  processBtn.disabled = true;
  setStatus("PDFを解析しています…", null);

  const stapleMarginMm = parseFloat(stapleMarginInput.value) || 15;
  const gapMm = parseFloat(gapMmInput.value) || 5;

  // 1. render page(s) to canvas & detect card boxes
  const loadingTask = pdfjsLib.getDocument({ data: currentFileBytes.slice() });
  const doc = await loadingTask.promise;

  const allCardsByPage = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;

    setStatus(`${pageNum}ページ目のカードを検出しています…`, null);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const boxesPx = detectCardBoxes(imgData, canvas.width, canvas.height);
    if (boxesPx.length === 0) {
      throw new Error(
        `${pageNum}ページ目で商品カードを検出できませんでした。フォーマットが対応していない可能性があります。`
      );
    }
    const pageHeightPt = viewport.height / RENDER_SCALE;
    const cardsPt = boxesPx
      .sort((a, b) => a.minY - b.minY || a.minX - b.minX)
      .map((b) => ({
        x0: b.minX / RENDER_SCALE,
        x1: b.maxX / RENDER_SCALE,
        top: b.minY / RENDER_SCALE,
        bottom: b.maxY / RENDER_SCALE,
      }));
    allCardsByPage.push({ pageIndex: pageNum - 1, pageHeightPt, cards: cardsPt });
  }

  const totalCards = allCardsByPage.reduce((s, p) => s + p.cards.length, 0);
  setStatus(`商品カードを${totalCards}件検出しました。タグPDFを作成しています…`, null);

  // 2. build output PDF with pdf-lib
  const { PDFDocument, rgb } = window.PDFLib;
  const srcDoc = await PDFDocument.load(currentFileBytes);
  const srcPages = srcDoc.getPages();

  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(window.fontkit);

  if (!jpFontBytesCache) {
    const resp = await fetch(JP_FONT_URL);
    if (!resp.ok) throw new Error("日本語フォントの読み込みに失敗しました。");
    jpFontBytesCache = await resp.arrayBuffer();
  }
  const jpFont = await outDoc.embedFont(jpFontBytesCache, { subset: true });

  const staple_margin = stapleMarginMm * MM;
  const bottom_margin = 3 * MM;
  const side_margin = 3 * MM;
  const gap = gapMm * MM;
  const page_margin = 10 * MM;
  const page_w = 595.0, page_h = 842.0; // A4

  // assume all cards share (roughly) the same size; use the first card as reference
  const refCard = allCardsByPage[0].cards[0];
  const card_w = refCard.x1 - refCard.x0;
  const card_h = refCard.bottom - refCard.top;
  const tag_w = side_margin * 2 + card_w;
  const tag_h = staple_margin + card_h + bottom_margin;

  const usable_w = page_w - 2 * page_margin;
  const usable_h = page_h - 2 * page_margin;
  const cols = Math.max(1, Math.floor((usable_w + gap) / (tag_w + gap)));
  const rows = Math.max(1, Math.floor((usable_h + gap) / (tag_h + gap)));
  const perPage = cols * rows;

  let outPage = null;
  let idx = 0;
  for (const pageInfo of allCardsByPage) {
    const srcPage = srcPages[pageInfo.pageIndex];
    const pageHeight = pageInfo.pageHeightPt;
    for (const c of pageInfo.cards) {
      const pos = idx % perPage;
      if (pos === 0) outPage = outDoc.addPage([page_w, page_h]);
      const col = pos % cols;
      const row = Math.floor(pos / cols);
      const ox = page_margin + col * (tag_w + gap);
      const oyTop = page_margin + row * (tag_h + gap);
      const tagBottomY = page_h - (oyTop + tag_h);

      outPage.drawRectangle({
        x: ox, y: tagBottomY, width: tag_w, height: tag_h,
        borderColor: rgb(0.55, 0.55, 0.55), borderWidth: 0.6,
        borderDashArray: [2, 2],
      });

      const foldYFromTop = oyTop + staple_margin;
      const foldYBottom = page_h - foldYFromTop;
      outPage.drawLine({
        start: { x: ox + 2, y: foldYBottom }, end: { x: ox + tag_w - 2, y: foldYBottom },
        color: rgb(0.7, 0.7, 0.7), thickness: 0.5, dashArray: [1, 2],
      });

      const cx = ox + tag_w / 2;
      const cyFromTop = oyTop + staple_margin / 2 + 2;
      const cyBottom = page_h - cyFromTop;
      const r = 4.5;
      outPage.drawEllipse({ x: cx, y: cyBottom, xScale: r, yScale: r, borderColor: rgb(0.65, 0.65, 0.65), borderWidth: 0.5 });
      outPage.drawLine({ start: { x: cx - r - 2, y: cyBottom }, end: { x: cx + r + 2, y: cyBottom }, color: rgb(0.65, 0.65, 0.65), thickness: 0.5 });
      outPage.drawLine({ start: { x: cx, y: cyBottom - r - 2 }, end: { x: cx, y: cyBottom + r + 2 }, color: rgb(0.65, 0.65, 0.65), thickness: 0.5 });
      outPage.drawText("ホチキス", { x: cx - 14, y: cyBottom - r - 9, size: 5.5, font: jpFont, color: rgb(0.6, 0.6, 0.6) });

      const destX = ox + side_margin;
      const destYTopOffset = oyTop + staple_margin;
      const destYBottom = page_h - (destYTopOffset + card_h);

      const embedded = await outDoc.embedPage(srcPage, {
        left: c.x0, right: c.x1,
        top: pageHeight - c.top, bottom: pageHeight - c.bottom,
      });
      outPage.drawPage(embedded, { x: destX, y: destYBottom, width: card_w, height: card_h });

      idx++;
    }
  }

  const outBytes = await outDoc.save();
  const blob = new Blob([outBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.hidden = false;

  await renderPreview(outBytes);

  setStatus(`完成しました！${totalCards}件のタグを作成しました。`, "ok");
  processBtn.disabled = false;
}

async function renderPreview(pdfBytes) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  previewCanvas.width = viewport.width;
  previewCanvas.height = viewport.height;
  const ctx = previewCanvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  previewArea.hidden = false;
}

// ---- card detection: binarize -> dilate -> connected components -> pick repeating box size ----
function detectCardBoxes(imgData, width, height) {
  const { data } = imgData;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const idx = (rowOff + x) << 2;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      mask[rowOff + x] = a > 10 && (r < 245 || g < 245 || b < 245) ? 1 : 0;
    }
  }

  const R = 10; // px, merges nearby glyphs/lines while keeping distinct cards separate
  const dil = dilateVert(dilateHoriz(mask, width, height, R), width, height, R);

  const labels = new Int32Array(width * height).fill(-1);
  const boxes = [];
  const stackX = new Int32Array(width * height);
  const stackY = new Int32Array(width * height);
  let nextLabel = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (dil[idx] !== 1 || labels[idx] !== -1) continue;
      let sp = 0;
      stackX[sp] = x; stackY[sp] = y; sp++;
      labels[idx] = nextLabel;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      while (sp > 0) {
        sp--;
        const cx = stackX[sp], cy = stackY[sp];
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0) { const n = cy * width + (cx - 1); if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx - 1; stackY[sp] = cy; sp++; } }
        if (cx < width - 1) { const n = cy * width + (cx + 1); if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx + 1; stackY[sp] = cy; sp++; } }
        if (cy > 0) { const n = (cy - 1) * width + cx; if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx; stackY[sp] = cy - 1; sp++; } }
        if (cy < height - 1) { const n = (cy + 1) * width + cx; if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx; stackY[sp] = cy + 1; sp++; } }
      }
      boxes.push({ minX, minY, maxX, maxY, area });
      nextLabel++;
    }
  }

  const minArea = (30 * RENDER_SCALE) * (30 * RENDER_SCALE);
  const big = boxes.filter((b) => b.area > minArea);
  if (big.length === 0) return [];

  // group by rounded height, prefer the group with the most members (repeating card size);
  // break ties toward the larger box (the full card border, not inner content)
  const buckets = {};
  for (const b of big) {
    const h = b.maxY - b.minY;
    const key = Math.round(h / 15) * 15;
    (buckets[key] = buckets[key] || []).push(b);
  }
  let bestKey = null, bestCount = 0;
  for (const k in buckets) {
    const cnt = buckets[k].length;
    if (cnt > bestCount || (cnt === bestCount && bestKey !== null && Number(k) > Number(bestKey))) {
      bestCount = cnt; bestKey = k;
    }
  }
  if (bestCount < 1) return [];
  return buckets[bestKey];
}

function dilateHoriz(src, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let count = 0;
    for (let x = 0; x < w; x++) {
      const addIdx = x + r, remIdx = x - r - 1;
      if (addIdx < w && src[off + addIdx]) count++;
      if (remIdx >= 0 && src[off + remIdx]) count--;
      out[off + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}
function dilateVert(src, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) {
      const addIdx = y + r, remIdx = y - r - 1;
      if (addIdx < h && src[addIdx * w + x]) count++;
      if (remIdx >= 0 && src[remIdx * w + x]) count--;
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}
