// ハコイチ値札加工ツール
// すべての処理はブラウザ内で完結（PDFはサーバーに送信されません）

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs";

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
const marginAboveInput = document.getElementById("marginAbove");
const marginBelowInput = document.getElementById("marginBelow");
const gapMmInput = document.getElementById("gapMm");
const schematicPreview = document.getElementById("schematicPreview");
const cardsSectionEl = document.getElementById("cardsSection");
const cardsListEl = document.getElementById("cardsList");

let currentFileBytes = null;
let allCardsByPage = null; // detection result for the current file, cached so re-clicking "変換する" doesn't re-detect

// parseFloat(...) || fallback would wrongly replace a legitimate 0 with the
// fallback (0 is falsy), so check for a finite number instead.
function numOr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---- live schematic preview (illustrative sizing, not the loaded PDF's actual card size) ----
const SCHEM_PX_PER_MM = 3.6;
const SCHEM_CARD_W_MM = 42;
const SCHEM_CARD_H_MM = 25;
const SCHEM_SIDE_MARGIN_MM = 3;
const SCHEM_BOTTOM_MARGIN_MM = 3;

function schemPx(mm) {
  return mm * SCHEM_PX_PER_MM;
}

function schemTagHtml(tagWmm, tagHmm, marginAboveMm, foldMm) {
  return `
    <div class="schem-tag" style="width:${schemPx(tagWmm)}px;height:${schemPx(tagHmm)}px;">
      <div class="schem-fold" style="top:${schemPx(foldMm)}px;"></div>
      <div class="schem-cross" style="top:${schemPx(marginAboveMm)}px;">⊕</div>
      <div class="schem-card" style="left:${schemPx(SCHEM_SIDE_MARGIN_MM)}px; top:${schemPx(foldMm)}px; width:${schemPx(SCHEM_CARD_W_MM)}px; height:${schemPx(SCHEM_CARD_H_MM)}px;"></div>
    </div>
  `;
}

function renderSchematic() {
  const marginAboveMm = numOr(marginAboveInput.value, 0);
  const marginBelowMm = numOr(marginBelowInput.value, 0);
  const gapMm = Math.max(0, numOr(gapMmInput.value, 0));
  const foldMm = marginAboveMm + marginBelowMm;
  const tagWmm = SCHEM_SIDE_MARGIN_MM * 2 + SCHEM_CARD_W_MM;
  const tagHmm = foldMm + SCHEM_CARD_H_MM + SCHEM_BOTTOM_MARGIN_MM;
  const tag = schemTagHtml(tagWmm, tagHmm, marginAboveMm, foldMm);
  schematicPreview.innerHTML = `${tag}<div class="schem-gap" style="width:${schemPx(gapMm)}px;"></div>${tag}`;
}

function adjustValue(input, step) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  let next = numOr(input.value, 0) + step;
  if (!Number.isNaN(min)) next = Math.max(min, next);
  if (!Number.isNaN(max)) next = Math.min(max, next);
  input.value = next;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// tap = one step; press and hold = repeat, so reaching the far end of a
// range doesn't take dozens of individual taps. Delegated on `document`
// (rather than attached per-button at load) so it also covers the
// per-card count steppers, which don't exist yet until a PDF is detected.
let repeatTimer = null;
function stopRepeat() {
  clearTimeout(repeatTimer);
  window.removeEventListener("pointerup", stopRepeat);
  window.removeEventListener("pointercancel", stopRepeat);
}
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest(".step-btn");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.target);
  const step = parseFloat(btn.dataset.step);
  e.preventDefault();
  adjustValue(input, step);
  window.addEventListener("pointerup", stopRepeat);
  window.addEventListener("pointercancel", stopRepeat);
  repeatTimer = setTimeout(function tick() {
    adjustValue(input, step);
    repeatTimer = setTimeout(tick, 90);
  }, 450);
});

marginAboveInput.addEventListener("input", renderSchematic);
marginBelowInput.addEventListener("input", renderSchematic);
gapMmInput.addEventListener("input", renderSchematic);
renderSchematic();

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
  allCardsByPage = null;
  cardsSectionEl.hidden = true;
  optionsEl.hidden = true;
  previewArea.hidden = true;
  setStatus(`「${file.name}」を読み込みました。カードを検出しています…`, null);

  try {
    allCardsByPage = await detectCards();
    renderCardsList();
    cardsSectionEl.hidden = false;
    optionsEl.hidden = false;
    const totalCards = allCardsByPage.reduce((s, p) => s + p.cards.length, 0);
    setStatus(`${totalCards}件のタグを検出しました。枚数と設定を確認して「変換する」を押してください。`, "ok");
  } catch (err) {
    console.error(err);
    setStatus("エラーが発生しました：" + err.message, "error");
  }
}

// render each source page to a canvas, detect card boxes, and crop a
// thumbnail per card so the "枚数" list can show what each one actually is
async function detectCards() {
  const loadingTask = pdfjsLib.getDocument({ data: currentFileBytes.slice() });
  const doc = await loadingTask.promise;

  const result = [];
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
    const THUMB_W = 160;
    const cardsPt = boxesPx
      .sort((a, b) => a.minY - b.minY || a.minX - b.minX)
      .map((b) => {
        const wPx = b.maxX - b.minX, hPx = b.maxY - b.minY;
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = THUMB_W;
        thumbCanvas.height = Math.round((hPx / wPx) * THUMB_W);
        thumbCanvas
          .getContext("2d")
          .drawImage(canvas, b.minX, b.minY, wPx, hPx, 0, 0, thumbCanvas.width, thumbCanvas.height);
        return {
          x0: b.minX / RENDER_SCALE,
          x1: b.maxX / RENDER_SCALE,
          top: b.minY / RENDER_SCALE,
          bottom: b.maxY / RENDER_SCALE,
          thumbUrl: thumbCanvas.toDataURL("image/png"),
        };
      });
    result.push({ pageIndex: pageNum - 1, pageHeightPt, cards: cardsPt });
  }
  return result;
}

function renderCardsList() {
  let idx = 0;
  const items = [];
  for (const page of allCardsByPage) {
    for (const c of page.cards) {
      c.countInputId = `cardCount${idx}`;
      items.push(`
        <div class="card-item">
          <img class="card-thumb" src="${c.thumbUrl}" alt="検出したタグ ${idx + 1}">
          <span class="stepper">
            <button type="button" class="step-btn" data-target="${c.countInputId}" data-step="-1" aria-label="1枚減らす">－</button>
            <input type="number" id="${c.countInputId}" value="1" min="0" max="50" step="1">
            <button type="button" class="step-btn" data-target="${c.countInputId}" data-step="1" aria-label="1枚増やす">＋</button>
            <span class="unit">枚</span>
          </span>
        </div>
      `);
      idx++;
    }
  }
  cardsListEl.innerHTML = items.join("");
}

processBtn.addEventListener("click", () => {
  if (!currentFileBytes || !allCardsByPage) return;
  process().catch((err) => {
    console.error(err);
    setStatus("エラーが発生しました：" + err.message, "error");
  });
});

async function process() {
  processBtn.disabled = true;
  setStatus("タグPDFを作成しています…", null);

  const marginAboveMm = numOr(marginAboveInput.value, 8);
  const marginBelowMm = numOr(marginBelowInput.value, 7);
  const gapMm = numOr(gapMmInput.value, 5);

  const totalCards = allCardsByPage.reduce(
    (s, p) => s + p.cards.reduce((s2, c) => s2 + Math.max(0, Math.round(numOr(document.getElementById(c.countInputId).value, 1))), 0),
    0
  );
  if (totalCards === 0) {
    throw new Error("少なくとも1つのタグの枚数を1枚以上にしてください。");
  }

  const { PDFDocument, rgb } = window.PDFLib;
  const srcDoc = await PDFDocument.load(currentFileBytes);
  const srcPages = srcDoc.getPages();

  const outDoc = await PDFDocument.create();

  const staple_margin_above = marginAboveMm * MM;
  const staple_margin_below = marginBelowMm * MM;
  const staple_margin = staple_margin_above + staple_margin_below;
  const bottom_margin = 3 * MM;
  const side_margin = 3 * MM;
  const gap = gapMm * MM;
  const page_margin = 10 * MM;
  const page_w = 595.0, page_h = 842.0; // A4

  // cards are usually a consistent size, but height can vary slightly row
  // to row depending on content (e.g. a longer category line), so size the
  // tag grid from the largest card rather than assuming uniform size; each
  // card is still drawn at its own true size below, so nothing gets
  // stretched or squished to fit
  const allCards = allCardsByPage.flatMap((p) => p.cards);
  const maxCardW = Math.max(...allCards.map((c) => c.x1 - c.x0));
  const maxCardH = Math.max(...allCards.map((c) => c.bottom - c.top));
  const tag_w = side_margin * 2 + maxCardW;
  const tag_h = staple_margin + maxCardH + bottom_margin;

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
      const count = Math.max(0, Math.round(numOr(document.getElementById(c.countInputId).value, 1)));
      if (count === 0) continue;

      const card_w = c.x1 - c.x0;
      const card_h = c.bottom - c.top;
      // embedding is the same regardless of how many times this card repeats
      const embedded = await outDoc.embedPage(srcPage, {
        left: c.x0, right: c.x1,
        top: pageHeight - c.top, bottom: pageHeight - c.bottom,
      });

      for (let n = 0; n < count; n++) {
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
        const cyFromTop = oyTop + staple_margin_above;
        const cyBottom = page_h - cyFromTop;
        const r = 4.5;
        outPage.drawEllipse({ x: cx, y: cyBottom, xScale: r, yScale: r, borderColor: rgb(0.65, 0.65, 0.65), borderWidth: 0.5 });
        outPage.drawLine({ start: { x: cx - r - 2, y: cyBottom }, end: { x: cx + r + 2, y: cyBottom }, color: rgb(0.65, 0.65, 0.65), thickness: 0.5 });
        outPage.drawLine({ start: { x: cx, y: cyBottom - r - 2 }, end: { x: cx, y: cyBottom + r + 2 }, color: rgb(0.65, 0.65, 0.65), thickness: 0.5 });

        const destX = ox + side_margin;
        const destYTopOffset = oyTop + staple_margin;
        const destYBottom = page_h - (destYTopOffset + card_h);
        outPage.drawPage(embedded, { x: destX, y: destYBottom, width: card_w, height: card_h });

        idx++;
      }
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

  // Group by rounded WIDTH, not height: this format lays cards out in fixed-
  // width columns, so a card's width stays the same across every row even
  // when a row's height varies with content (a longer category line, an
  // extra note, etc). Grouping by height would split rows with different
  // content into separate groups, at risk of losing a row entirely - or, for
  // a lone leftover card in a partial last row, losing just that one card -
  // whenever the "most common group" heuristic below picks another row's
  // height. Width doesn't have that problem, so a single group is normally
  // enough to capture every real card regardless of row/column count.
  const buckets = {};
  for (const b of big) {
    const w = b.maxX - b.minX;
    const key = Math.round(w / 15) * 15;
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

  // Still keep any other group with 2+ members as a safety net, in case
  // width isn't perfectly uniform (rendering jitter, or a format where it
  // legitimately varies) - same reasoning as above, just belt-and-braces.
  const candidates = [];
  for (const k in buckets) {
    if (buckets[k].length >= 2 || k === bestKey) candidates.push(...buckets[k]);
  }

  // Each card's outer border and its denser inner content (barcode + text)
  // can end up as two separate connected components landing in two
  // different (both legitimately repeating) buckets, double-counting the
  // same physical card. Keep only the outermost box of any such overlap.
  const boxArea = (b) => (b.maxX - b.minX) * (b.maxY - b.minY);
  const containedFraction = (inner, outer) => {
    const ix0 = Math.max(inner.minX, outer.minX);
    const iy0 = Math.max(inner.minY, outer.minY);
    const ix1 = Math.min(inner.maxX, outer.maxX);
    const iy1 = Math.min(inner.maxY, outer.maxY);
    if (ix1 <= ix0 || iy1 <= iy0) return 0;
    return ((ix1 - ix0) * (iy1 - iy0)) / boxArea(inner);
  };
  const byAreaDesc = candidates.slice().sort((a, b) => boxArea(b) - boxArea(a));
  const kept = [];
  for (const b of byAreaDesc) {
    if (!kept.some((k) => containedFraction(b, k) > 0.8)) kept.push(b);
  }
  return kept;
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
