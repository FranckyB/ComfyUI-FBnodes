import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function applyJpgQualityVisibility(node) {
    const formatWidget = node.widgets?.find((w) => w?.name === "format");
    const qualityWidget = node.widgets?.find((w) => w?.name === "jpg_quality");
    if (!formatWidget || !qualityWidget) {
        return;
    }

    const shouldHide = String(formatWidget.value || "").toLowerCase() !== "jpg";

    if (!qualityWidget._fbnodesOriginalComputeSize && typeof qualityWidget.computeSize === "function") {
        qualityWidget._fbnodesOriginalComputeSize = qualityWidget.computeSize;
    }

    qualityWidget.hidden = shouldHide;

    if (shouldHide) {
        qualityWidget.computeSize = () => [0, -4];
        if (qualityWidget.inputEl) {
            qualityWidget.inputEl.style.display = "none";
        }
    } else {
        if (qualityWidget._fbnodesOriginalComputeSize) {
            qualityWidget.computeSize = qualityWidget._fbnodesOriginalComputeSize;
        }
        if (qualityWidget.inputEl) {
            qualityWidget.inputEl.style.display = "";
        }
    }

    node.setDirtyCanvas?.(true, true);
}

function imageInfoToUrl(imageInfo) {
    if (!imageInfo || !imageInfo.filename) {
        return "";
    }

    let url = `/view?filename=${encodeURIComponent(imageInfo.filename)}&type=${encodeURIComponent(imageInfo.type || "output")}`;
    if (imageInfo.subfolder) {
        url += `&subfolder=${encodeURIComponent(imageInfo.subfolder)}`;
    }
    return url;
}

function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return min;
    }
    return Math.max(min, Math.min(max, n));
}

function clampIndex(index, length) {
    if (!length) {
        return 0;
    }
    return Math.max(0, Math.min(length - 1, Number(index || 0)));
}

function normalizeImageEntries(raw) {
    if (!raw) {
        return [];
    }
    const out = [];
    const stack = Array.isArray(raw) ? [...raw] : [raw];

    while (stack.length) {
        const item = stack.shift();
        if (!item) {
            continue;
        }
        if (Array.isArray(item)) {
            stack.push(...item);
            continue;
        }
        if (typeof item === "object" && typeof item.filename === "string") {
            out.push(item);
        }
    }

    return out;
}

function normalizeBool(raw) {
    if (Array.isArray(raw)) {
        return !!raw[0];
    }
    return !!raw;
}

function extractSavePayload(message) {
    if (!message || typeof message !== "object") {
        return {};
    }

    const candidates = [
        message,
        message.ui,
        message.output,
        message.data,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") {
            continue;
        }
        if (
            candidate.saved_images !== undefined ||
            candidate.images !== undefined ||
            candidate.compare_images !== undefined
        ) {
            return candidate;
        }
    }

    return message;
}

function addRoundedRectPath(ctx, x, y, w, h, r = 8) {
    const radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, radius);
        return;
    }

    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function ensureCompareState(node) {
    if (node._fbSaveCompareState) {
        return node._fbSaveCompareState;
    }

    node._fbSaveCompareState = {
        savedItems: [],
        compareItems: [],
        selectedSaved: 0,
        selectedCompare: 0,
        paired: false,
        unpaired: false,
        gridMode: false,
        split: 0.5,
        hovering: false,
        imageCache: new Map(),
        previewRect: null,
        buttonZones: [],
        gridZones: [],
        drawDisabled: false,
        drawErrorLogged: false,
    };

    return node._fbSaveCompareState;
}

function getWidgetHeight(node, widget) {
    if (widget?.hidden) {
        return 0;
    }
    if (typeof widget?.computeSize === "function") {
        try {
            const size = widget.computeSize(Number(node.size?.[0] || 320));
            if (Array.isArray(size) && Number.isFinite(size[1])) {
                return Number(size[1]);
            }
        } catch {
            return 24;
        }
    }
    return Number(LiteGraph?.NODE_WIDGET_HEIGHT || 24);
}

function getContentStartY(node) {
    const titleH = Number(LiteGraph?.NODE_TITLE_HEIGHT || 30);
    let y = titleH + 6;

    for (const widget of node.widgets || []) {
        y += getWidgetHeight(node, widget) + 4;
    }

    return y + 4;
}

function estimateSelectionRowsHeight(state) {
    const savedCount = state.savedItems.length;
    const compareCount = state.compareItems.length;
    if (!savedCount) {
        return 0;
    }

    const hasCompare = compareCount > 0;
    const pairedView = state.paired && !state.unpaired;

    let rowCount = 0;
    if (hasCompare && pairedView) {
        if (savedCount > 1) {
            rowCount = 1;
        }
    } else if (hasCompare) {
        if (compareCount > 1) {
            rowCount += 1;
        }
        if (savedCount > 1) {
            rowCount += 1;
        }
    } else if (savedCount > 1) {
        rowCount = 1;
    }

    const hasCheckboxes = savedCount > 1;
    if (rowCount === 0 && !hasCheckboxes) {
        return 0;
    }

    const btnH = 18;
    const padY = 6;
    const lineGap = 6;
    const lines = Math.max(1, rowCount);
    return lines * btnH + (lines - 1) * lineGap + padY * 2;
}

function ensureMinDisplaySize(node) {
    const state = ensureCompareState(node);
    const contentTop = getContentStartY(node);
    const controlsH = estimateSelectionRowsHeight(state);
    const frameMinH = 140;
    const footerH = 24;
    const footerGap = 6;
    const bottomPad = 8;

    const minW = 260;
    const minH = Math.ceil(contentTop + controlsH + frameMinH + footerGap + footerH + bottomPad);

    const curW = Number(node.size?.[0] || 0);
    const curH = Number(node.size?.[1] || 0);
    const nextW = Math.max(curW, minW);
    const nextH = Math.max(curH, minH);

    if (nextW !== curW || nextH !== curH) {
        node.size = [nextW, nextH];
        node.setDirtyCanvas?.(true, true);
        return true;
    }

    return false;
}

function getCachedImage(state, url, node) {
    if (!url) {
        return null;
    }

    const cached = state.imageCache.get(url);
    if (cached) {
        return cached.complete ? cached : null;
    }

    const img = new Image();
    img.onload = () => node.setDirtyCanvas?.(true, false);
    img.src = url;
    state.imageCache.set(url, img);
    return null;
}

function drawContainImage(ctx, img, rect) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
        return null;
    }

    const imageAspect = img.naturalWidth / img.naturalHeight;
    const rectAspect = rect.w / rect.h;

    let drawW = rect.w;
    let drawH = rect.h;
    let drawX = rect.x;
    let drawY = rect.y;

    if (imageAspect > rectAspect) {
        drawH = drawW / imageAspect;
        drawY = rect.y + (rect.h - drawH) * 0.5;
    } else {
        drawW = drawH * imageAspect;
        drawX = rect.x + (rect.w - drawW) * 0.5;
    }

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
    return { x: drawX, y: drawY, w: drawW, h: drawH };
}

function drawButton(ctx, rect, text, active) {
    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fillStyle = active ? "rgba(49, 92, 130, 0.98)" : "rgba(45, 51, 63, 0.98)";
    ctx.strokeStyle = active ? "rgba(66, 153, 225, 0.95)" : "rgba(86, 103, 122, 0.6)";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    ctx.font = "600 10px Segoe UI";
    ctx.fillStyle = active ? "rgba(245, 250, 255, 1)" : "rgba(210, 224, 238, 0.96)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, rect.x + rect.w * 0.5, rect.y + rect.h * 0.5 + 0.5);
    ctx.restore();
}

function drawSelectionRows(ctx, node, state, topY, width) {
    state.buttonZones = [];
    state.gridZones = [];

    const savedCount = state.savedItems.length;
    const compareCount = state.compareItems.length;
    if (!savedCount) {
        return 0;
    }

    const hasCompare = compareCount > 0;
    const pairedView = state.paired && !state.unpaired;
    const MANY = 8;

    const rows = [];
    if (hasCompare && pairedView) {
        if (savedCount > 1) {
            rows.push({ label: "Pair", count: savedCount, selected: state.selectedSaved, type: "pair" });
        }
    } else if (hasCompare) {
        if (compareCount > 1) {
            rows.push({ label: "A", count: compareCount, selected: state.selectedCompare, type: "A" });
        }
        if (savedCount > 1) {
            rows.push({ label: "B", count: savedCount, selected: state.selectedSaved, type: "B" });
        }
    } else if (savedCount > 1) {
        rows.push({ label: "", count: savedCount, selected: state.selectedSaved, type: "B" });
    }

    const showGridToggle = savedCount > 1;
    const showPairToggle = state.paired && savedCount > 1;
    const hasCheckboxes = showGridToggle || showPairToggle;

    if (!rows.length && !hasCheckboxes) {
        return 0;
    }

    const labelFont = "600 10px Segoe UI";
    const btnFont = "600 10px Segoe UI";
    const cbFont = "500 10px Segoe UI";
    const btnH = 18;
    const btnGap = 5;
    const groupGap = 16;
    const labelGap = 7;
    const padX = 10;
    const padY = 6;
    const lineGap = 6;
    const navBtnW = 22;
    const cbSize = 13;

    const panelX = 10;
    const panelW = Math.max(40, width - 20);
    const innerW = panelW - padX * 2;

    // Width of the checkbox cluster drawn right-aligned on the first line.
    let cbClusterW = 0;
    ctx.save();
    ctx.font = cbFont;
    if (showGridToggle) {
        cbClusterW += Math.ceil(ctx.measureText("Grid").width) + 5 + cbSize;
    }
    if (showPairToggle) {
        if (cbClusterW > 0) {
            cbClusterW += 14;
        }
        cbClusterW += Math.ceil(ctx.measureText("Pair").width) + 5 + cbSize;
    }
    ctx.restore();

    const measureRow = (row) => {
        ctx.save();
        ctx.font = labelFont;
        let w = row.label ? Math.ceil(ctx.measureText(row.label).width) + labelGap : 0;
        ctx.font = btnFont;
        if (row.count > MANY) {
            const navText = `${row.selected + 1} / ${row.count}`;
            w += navBtnW + btnGap + Math.ceil(ctx.measureText(navText).width) + 16 + btnGap + navBtnW;
        } else {
            for (let i = 0; i < row.count; i += 1) {
                const text = String(i + 1);
                w += Math.max(24, Math.ceil(ctx.measureText(text).width) + 14) + btnGap;
            }
        }
        ctx.restore();
        return w;
    };

    const rowWidths = rows.map(measureRow);

    let sideBySide = false;
    if (rows.length === 2 && rows[0].count <= MANY && rows[1].count <= MANY) {
        sideBySide = rowWidths[0] + groupGap + rowWidths[1] + cbClusterW + groupGap <= innerW;
    }

    const lines = (sideBySide ? 1 : rows.length) || 1;
    const totalH = lines * btnH + (lines - 1) * lineGap + padY * 2;
    const panelY = topY;

    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, panelX, panelY, panelW, totalH, 10);
    ctx.fillStyle = "rgba(42, 46, 54, 0.94)";
    ctx.strokeStyle = "rgba(66, 72, 84, 0.95)";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const drawRow = (row, startX, lineY) => {
        let x = startX;

        if (row.label) {
            ctx.save();
            ctx.font = labelFont;
            ctx.fillStyle = "rgba(192, 206, 222, 0.95)";
            ctx.textBaseline = "middle";
            ctx.fillText(row.label, x, lineY + btnH * 0.5);
            x += Math.ceil(ctx.measureText(row.label).width) + labelGap;
            ctx.restore();
        }

        ctx.save();
        ctx.font = btnFont;
        if (row.count > MANY) {
            const prevRect = { x, y: lineY, w: navBtnW, h: btnH };
            drawButton(ctx, prevRect, "\u2039", false);
            state.buttonZones.push({ ...prevRect, type: "nav", navTarget: row.type, navDir: -1, index: 0 });
            x += navBtnW + btnGap;

            const navText = `${row.selected + 1} / ${row.count}`;
            const tw = Math.ceil(ctx.measureText(navText).width) + 16;
            ctx.fillStyle = "rgba(210, 224, 238, 0.96)";
            ctx.textBaseline = "middle";
            ctx.fillText(navText, x + 8, lineY + btnH * 0.5);
            x += tw + btnGap;

            const nextRect = { x, y: lineY, w: navBtnW, h: btnH };
            drawButton(ctx, nextRect, "\u203A", false);
            state.buttonZones.push({ ...nextRect, type: "nav", navTarget: row.type, navDir: 1, index: 0 });
            x += navBtnW + btnGap;
        } else {
            for (let i = 0; i < row.count; i += 1) {
                const text = String(i + 1);
                const w = Math.max(24, Math.ceil(ctx.measureText(text).width) + 14);
                const rect = { x, y: lineY, w, h: btnH };
                drawButton(ctx, rect, text, !state.gridMode && i === row.selected);
                state.buttonZones.push({ ...rect, type: row.type, index: i });
                x += w + btnGap;
            }
        }
        ctx.restore();
        return x;
    };

    if (rows.length) {
        if (sideBySide) {
            const lineY = panelY + padY;
            let x = panelX + padX;
            x = drawRow(rows[0], x, lineY);
            x += groupGap - btnGap;
            drawRow(rows[1], x, lineY);
        } else {
            let lineY = panelY + padY;
            for (const row of rows) {
                drawRow(row, panelX + padX, lineY);
                lineY += btnH + lineGap;
            }
        }
    }

    if (hasCheckboxes) {
        const midY = panelY + padY + btnH * 0.5;
        let rightX = panelX + panelW - padX;

        const drawCheckbox = (label, checked, type) => {
            ctx.save();
            ctx.font = cbFont;
            const labelW = Math.ceil(ctx.measureText(label).width);
            const boxX = rightX - cbSize;
            const boxY = midY - cbSize / 2;
            const labelX = boxX - 5 - labelW;

            ctx.fillStyle = "rgba(192, 206, 222, 0.95)";
            ctx.textBaseline = "middle";
            ctx.fillText(label, labelX, midY);

            ctx.beginPath();
            addRoundedRectPath(ctx, boxX, boxY, cbSize, cbSize, 3);
            ctx.fillStyle = checked ? "rgba(49, 92, 130, 0.98)" : "rgba(45, 51, 63, 0.98)";
            ctx.strokeStyle = checked ? "rgba(66, 153, 225, 0.95)" : "rgba(86, 103, 122, 0.7)";
            ctx.lineWidth = 1;
            ctx.fill();
            ctx.stroke();

            if (checked) {
                ctx.strokeStyle = "rgba(245, 250, 255, 1)";
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(boxX + 3, boxY + cbSize * 0.55);
                ctx.lineTo(boxX + cbSize * 0.42, boxY + cbSize - 3);
                ctx.lineTo(boxX + cbSize - 2.5, boxY + 3);
                ctx.stroke();
            }
            ctx.restore();

            state.buttonZones.push({
                x: labelX,
                y: boxY - 2,
                w: boxX + cbSize - labelX,
                h: cbSize + 4,
                type,
                index: 0,
            });
            rightX = labelX - 14;
        };

        if (showGridToggle) {
            drawCheckbox("Grid", state.gridMode, "gridToggle");
        }
        if (showPairToggle) {
            drawCheckbox("Pair", !state.unpaired, "unpairToggle");
        }
    }

    return totalH;
}

function drawImageGrid(ctx, state, node, rect) {
    state.gridZones = [];
    const items = state.savedItems;
    const n = items.length;
    if (!n) {
        return;
    }

    const cols = Math.ceil(Math.sqrt(n));
    const rowCount = Math.ceil(n / cols);
    const gap = 4;
    const cellW = (rect.w - gap * (cols - 1)) / cols;
    const cellH = (rect.h - gap * (rowCount - 1)) / rowCount;
    if (cellW <= 1 || cellH <= 1) {
        return;
    }

    for (let i = 0; i < n; i += 1) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const cx = rect.x + c * (cellW + gap);
        const cy = rect.y + r * (cellH + gap);
        const cellRect = { x: cx, y: cy, w: cellW, h: cellH };

        ctx.save();
        ctx.fillStyle = "rgba(28, 32, 40, 0.92)";
        ctx.fillRect(cx, cy, cellW, cellH);
        const url = imageInfoToUrl(items[i]);
        const img = getCachedImage(state, url, node);
        if (img) {
            drawContainImage(ctx, img, cellRect);
        }
        ctx.strokeStyle = "rgba(78, 90, 108, 0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1);
        ctx.restore();

        state.gridZones.push({ x: cx, y: cy, w: cellW, h: cellH, index: i });
    }
}

function drawCompareCanvas(ctx, node) {
    const state = ensureCompareState(node);
    if (state.drawDisabled) {
        return;
    }
    node.imgs = [];
    const hasSavedItems = state.savedItems.length > 0;

    ensureMinDisplaySize(node);

    state.selectedSaved = clampIndex(state.selectedSaved, state.savedItems.length);
    state.selectedCompare = clampIndex(state.selectedCompare, state.compareItems.length);

    const contentTop = getContentStartY(node);
    const contentBottom = Number(node.size?.[1] || 320) - 8;
    if (contentBottom <= contentTop + 20) {
        return;
    }

    const controlsH = drawSelectionRows(ctx, node, state, contentTop, Number(node.size?.[0] || 320));

    const footerH = 24;
    const footerGap = 6;
    const frameX = 10;
    const frameY = contentTop + controlsH;
    const frameW = Math.max(40, Number(node.size?.[0] || 320) - 20);
    const frameH = Math.max(80, contentBottom - frameY - footerH - footerGap);

    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, frameX, frameY, frameW, frameH, 10);
    ctx.fillStyle = "rgba(34, 39, 48, 0.98)";
    ctx.strokeStyle = "rgba(78, 90, 108, 0.72)";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.clip();

    let savedImg = null;
    const drawRect = { x: frameX + 1, y: frameY + 1, w: frameW - 2, h: frameH - 2 };

    if (!hasSavedItems) {
        state.previewRect = null;
        state.buttonZones = [];
        state.gridZones = [];
        ctx.restore();
    } else {
        const savedItem = state.savedItems[state.selectedSaved];
        const savedUrl = imageInfoToUrl(savedItem);
        savedImg = getCachedImage(state, savedUrl, node);

        if (state.gridMode && state.savedItems.length > 1) {
            drawImageGrid(ctx, state, node, drawRect);
            state.previewRect = null;
            ctx.restore();
        } else {
            state.gridZones = [];
            const savedDraw = drawContainImage(ctx, savedImg, drawRect);

            const hasCompare = state.compareItems.length > 0;
            const pairedView = state.paired && !state.unpaired;
            const compareIndex = pairedView ? clampIndex(state.selectedSaved, state.compareItems.length) : state.selectedCompare;
            const compareItem = hasCompare ? state.compareItems[compareIndex] : null;

            if (compareItem && savedDraw && state.hovering) {
                const compareUrl = imageInfoToUrl(compareItem);
                const compareImg = getCachedImage(state, compareUrl, node);

                if (compareImg && compareImg.naturalWidth && compareImg.naturalHeight) {
                    const splitX = savedDraw.x + clamp(state.split, 0, 1) * savedDraw.w;

                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(savedDraw.x, savedDraw.y, Math.max(0, splitX - savedDraw.x), savedDraw.h);
                    ctx.clip();
                    drawContainImage(ctx, compareImg, drawRect);
                    ctx.restore();

                    ctx.fillStyle = "rgba(245, 249, 255, 0.95)";
                    ctx.fillRect(splitX - 1, savedDraw.y, 2, savedDraw.h);
                    ctx.beginPath();
                    ctx.arc(splitX, savedDraw.y + savedDraw.h * 0.5, 5, 0, Math.PI * 2);
                    ctx.fill();

                    state.previewRect = savedDraw;
                } else {
                    state.previewRect = savedDraw;
                }
            } else {
                state.previewRect = savedDraw;
            }

            ctx.restore();
        }
    }

    // Footer: image size box. Shows the displayed image's size, or the first
    // image's size in grid mode (one size for the whole batch).
    const footerImg = state.gridMode
        ? getCachedImage(state, imageInfoToUrl(state.savedItems[0]), node)
        : savedImg;
    const footerX = frameX;
    const footerY = frameY + frameH + footerGap;
    const footerW = frameW;
    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, footerX, footerY, footerW, footerH, 8);
    ctx.fillStyle = "rgba(42, 46, 54, 0.94)";
    ctx.strokeStyle = "rgba(66, 72, 84, 0.95)";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    let sizeText = "—";
    if (footerImg && footerImg.naturalWidth && footerImg.naturalHeight) {
        sizeText = `${footerImg.naturalWidth} × ${footerImg.naturalHeight}`;
    }
    ctx.font = "600 10px Segoe UI";
    ctx.fillStyle = "rgba(192, 206, 222, 0.95)";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(sizeText).width;
    ctx.fillText(sizeText, footerX + (footerW - tw) * 0.5, footerY + footerH * 0.5);
    ctx.restore();
}

function setResultData(node, message) {
    const state = ensureCompareState(node);
    const payload = extractSavePayload(message);

    const savedItems = normalizeImageEntries(payload?.saved_images ?? payload?.images);
    const compareItems = normalizeImageEntries(payload?.compare_images);

    state.savedItems = savedItems;
    state.compareItems = compareItems;
    state.paired = normalizeBool(payload?.compare_paired) && compareItems.length === savedItems.length;
    if (!state.paired) {
        state.paired = compareItems.length > 0 && compareItems.length === savedItems.length;
    }

    state.selectedSaved = clampIndex(state.selectedSaved, savedItems.length);
    state.selectedCompare = clampIndex(state.selectedCompare, compareItems.length);
    if (state.paired) {
        state.selectedCompare = clampIndex(state.selectedSaved, compareItems.length);
    }

    // Default to grid view when a new execution returns multiple saved images.
    state.gridMode = savedItems.length > 1;

    state.imageCache.clear();
    node.imgs = [];

    persistCompareData(node, state);
    ensureMinDisplaySize(node);
}

const _fbSaveImageExecutedCache = new Map();
let _fbSaveImageExecutedListenerInstalled = false;

function cacheExecutedPayload(detail) {
    const nodeId = detail?.node;
    if (nodeId === undefined || nodeId === null) {
        return;
    }

    const payload = extractSavePayload(detail?.output);
    const hasSaved = normalizeImageEntries(payload?.saved_images ?? payload?.images).length > 0;
    const hasCompare = normalizeImageEntries(payload?.compare_images).length > 0;
    if (!hasSaved && !hasCompare) {
        return;
    }

    _fbSaveImageExecutedCache.set(String(nodeId), payload);
}

function restoreFromExecutedCache(node) {
    const nodeId = node?.id;
    if (nodeId === undefined || nodeId === null) {
        return false;
    }

    const cached = _fbSaveImageExecutedCache.get(String(nodeId));
    if (!cached) {
        return false;
    }

    setResultData(node, cached);
    node.imgs = [];
    node.setDirtyCanvas?.(true, true);
    return true;
}

function installExecutedSync() {
    if (_fbSaveImageExecutedListenerInstalled) {
        return;
    }
    _fbSaveImageExecutedListenerInstalled = true;

    api.addEventListener("executed", (event) => {
        cacheExecutedPayload(event?.detail || {});
    });
}

function persistCompareData(node, state) {
    if (!node.properties) {
        node.properties = {};
    }
    try {
        node.properties._saveCompareSavedItems = JSON.stringify(state.savedItems || []);
        node.properties._saveCompareCompareItems = JSON.stringify(state.compareItems || []);
    } catch (error) {
        node.properties._saveCompareSavedItems = "[]";
        node.properties._saveCompareCompareItems = "[]";
    }
    node.properties._saveComparePaired = !!state.paired;
    node.properties._saveCompareUnpaired = !!state.unpaired;
    node.properties._saveCompareGrid = !!state.gridMode;
    node.properties._saveCompareSavedIndex = state.selectedSaved;
    node.properties._saveCompareCompareIndex = state.selectedCompare;
}

function restoreCompareData(node, state) {
    const parse = (raw) => {
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    };

    state.savedItems = parse(node.properties?._saveCompareSavedItems);
    state.compareItems = parse(node.properties?._saveCompareCompareItems);
    state.paired = normalizeBool(node.properties?._saveComparePaired);
    state.unpaired = normalizeBool(node.properties?._saveCompareUnpaired);
    state.gridMode = normalizeBool(node.properties?._saveCompareGrid);
    state.selectedSaved = clampIndex(node.properties?._saveCompareSavedIndex || 0, state.savedItems.length);
    state.selectedCompare = clampIndex(node.properties?._saveCompareCompareIndex || 0, state.compareItems.length);
    if (state.paired && !state.unpaired) {
        state.selectedCompare = clampIndex(state.selectedSaved, state.compareItems.length);
    }
}


function handlePointer(node, localPos) {
    const state = ensureCompareState(node);
    if (!state.previewRect || !state.compareItems.length) {
        if (state.hovering) {
            state.hovering = false;
            node.setDirtyCanvas?.(true, false);
        }
        return false;
    }

    const r = state.previewRect;
    const inside = localPos[0] >= r.x && localPos[0] <= r.x + r.w && localPos[1] >= r.y && localPos[1] <= r.y + r.h;
    if (!inside || r.w <= 0) {
        if (state.hovering) {
            state.hovering = false;
            node.setDirtyCanvas?.(true, false);
        }
        return false;
    }

    const split = (localPos[0] - r.x) / r.w;
    const clamped = Math.max(0, Math.min(1, split));
    let dirty = false;
    if (!state.hovering) {
        state.hovering = true;
        dirty = true;
    }
    if (Math.abs(clamped - state.split) > 0.001) {
        state.split = clamped;
        dirty = true;
    }
    if (dirty) {
        node.setDirtyCanvas?.(true, false);
    }

    return true;
}

function clickSelectionButton(node, localPos) {
    const state = ensureCompareState(node);

    // Grid cell selection: pick the clicked image and return to single view.
    for (const zone of state.gridZones || []) {
        const hit = localPos[0] >= zone.x && localPos[0] <= zone.x + zone.w && localPos[1] >= zone.y && localPos[1] <= zone.y + zone.h;
        if (!hit) {
            continue;
        }
        state.selectedSaved = clampIndex(zone.index, state.savedItems.length);
        if (state.paired && !state.unpaired) {
            state.selectedCompare = clampIndex(zone.index, state.compareItems.length);
        }
        state.gridMode = false;
        persistCompareData(node, state);
        node.setDirtyCanvas?.(true, true);
        return true;
    }

    for (const zone of state.buttonZones) {
        const hit = localPos[0] >= zone.x && localPos[0] <= zone.x + zone.w && localPos[1] >= zone.y && localPos[1] <= zone.y + zone.h;
        if (!hit) {
            continue;
        }

        if (zone.type === "gridToggle") {
            state.gridMode = !state.gridMode;
            persistCompareData(node, state);
            node.setDirtyCanvas?.(true, true);
            return true;
        }

        if (zone.type === "unpairToggle") {
            state.unpaired = !state.unpaired;
            if (!state.unpaired) {
                state.selectedCompare = clampIndex(state.selectedSaved, state.compareItems.length);
            }
            persistCompareData(node, state);
            node.setDirtyCanvas?.(true, true);
            return true;
        }

        if (zone.type === "nav") {
            if (zone.navTarget === "A") {
                const len = state.compareItems.length || 1;
                state.selectedCompare = ((state.selectedCompare + zone.navDir) % len + len) % len;
            } else {
                const len = state.savedItems.length || 1;
                state.selectedSaved = ((state.selectedSaved + zone.navDir) % len + len) % len;
                if (state.paired && !state.unpaired) {
                    state.selectedCompare = clampIndex(state.selectedSaved, state.compareItems.length);
                }
            }
            persistCompareData(node, state);
            node.setDirtyCanvas?.(true, true);
            return true;
        }

        if (zone.type === "pair") {
            const target = clampIndex(zone.index, state.savedItems.length);
            if (!state.gridMode && target === state.selectedSaved) {
                state.gridMode = true;
            } else {
                state.selectedSaved = target;
                state.selectedCompare = clampIndex(target, state.compareItems.length);
                state.gridMode = false;
            }
        } else if (zone.type === "A") {
            const target = clampIndex(zone.index, state.compareItems.length);
            if (!state.gridMode && target === state.selectedCompare) {
                state.gridMode = true;
            } else {
                state.selectedCompare = target;
                state.gridMode = false;
            }
        } else if (zone.type === "B") {
            const target = clampIndex(zone.index, state.savedItems.length);
            if (!state.gridMode && target === state.selectedSaved) {
                state.gridMode = true;
            } else {
                state.selectedSaved = target;
                if (state.paired && !state.unpaired) {
                    state.selectedCompare = clampIndex(target, state.compareItems.length);
                }
                state.gridMode = false;
            }
        }

        if (!node.properties) {
            node.properties = {};
        }
        persistCompareData(node, state);

        node.setDirtyCanvas?.(true, true);
        return true;
    }

    return false;
}

function stepSelectedImage(node, dir) {
    const state = ensureCompareState(node);
    if (state.gridMode) {
        return false;
    }

    const usingCompareRow = state.compareItems.length > 0 && !(state.paired && !state.unpaired);
    if (usingCompareRow) {
        // In unpaired/A-B view the saved (B) row drives the main image.
        const len = state.savedItems.length;
        if (len <= 1) {
            return false;
        }
        state.selectedSaved = ((state.selectedSaved + dir) % len + len) % len;
    } else {
        const len = state.savedItems.length;
        if (len <= 1) {
            return false;
        }
        state.selectedSaved = ((state.selectedSaved + dir) % len + len) % len;
        if (state.paired && !state.unpaired) {
            state.selectedCompare = clampIndex(state.selectedSaved, state.compareItems.length);
        }
    }

    persistCompareData(node, state);
    node.setDirtyCanvas?.(true, true);
    return true;
}

let _fbHoveredSaveImageNode = null;
let _fbKeyListenerInstalled = false;

function getActiveSaveImageNode(nodeType) {
    // Prefer the node under the cursor, fall back to a single selected node.
    if (_fbHoveredSaveImageNode && !_fbHoveredSaveImageNode.flags?.collapsed) {
        return _fbHoveredSaveImageNode;
    }

    const selected = app.canvas?.selected_nodes;
    if (selected) {
        const nodes = Object.values(selected).filter((n) => n?.comfyClass === "SaveImagePlus" && !n.flags?.collapsed);
        if (nodes.length === 1) {
            return nodes[0];
        }
    }
    return null;
}

function installKeyNavigation() {
    if (_fbKeyListenerInstalled) {
        return;
    }
    _fbKeyListenerInstalled = true;

    window.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Escape") {
            return;
        }

        const target = event.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
            return;
        }

        const node = getActiveSaveImageNode();
        if (!node) {
            return;
        }

        const state = ensureCompareState(node);

        if (event.key === "Escape") {
            if (!state.gridMode && state.savedItems.length > 1) {
                state.gridMode = true;
                persistCompareData(node, state);
                node.setDirtyCanvas?.(true, true);
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }

        if (stepSelectedImage(node, event.key === "ArrowRight" ? 1 : -1)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
}

app.registerExtension({
    name: "FBnodes.SaveImagePlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "SaveImagePlus") {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            const formatWidget = this.widgets?.find((w) => w?.name === "format");
            if (formatWidget && !formatWidget._fbnodesSaveImagePlusWrapped) {
                const originalCallback = formatWidget.callback;
                formatWidget.callback = function () {
                    originalCallback?.apply(this, arguments);
                    applyJpgQualityVisibility(this.node);
                };
                formatWidget._fbnodesSaveImagePlusWrapped = true;
            }

            ensureCompareState(this);
            this.imgs = [];
            applyJpgQualityVisibility(this);
            installKeyNavigation();
            installExecutedSync();
            restoreFromExecutedCache(this);
            ensureMinDisplaySize(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            const state = ensureCompareState(this);

            if (!this.properties) {
                this.properties = {};
            }
            restoreCompareData(this, state);

            this.imgs = [];
            applyJpgQualityVisibility(this);
            restoreFromExecutedCache(this);
            ensureMinDisplaySize(this);
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);

            const payload = extractSavePayload(message || {});
            setResultData(this, payload);
            if (this.id !== undefined && this.id !== null) {
                _fbSaveImageExecutedCache.set(String(this.id), payload);
            }
            const state = ensureCompareState(this);

            if (!this.properties) {
                this.properties = {};
            }
            this.properties._saveCompareSavedIndex = state.selectedSaved;
            this.properties._saveCompareCompareIndex = state.selectedCompare;

            this.imgs = [];
            this.setDirtyCanvas?.(true, true);
            return result;
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            const result = onDrawForeground?.apply(this, arguments);
            const state = ensureCompareState(this);
            if (state.drawDisabled) {
                return result;
            }

            // Save the full canvas state at the boundary and ALWAYS restore it, even
            // if drawing throws. This prevents a leaked clip/transform from corrupting
            // (and visually freezing) the rest of Comfy's UI.
            ctx.save();
            try {
                drawCompareCanvas(ctx, this);
            } catch (error) {
                state.drawDisabled = true;
                state.previewRect = null;
                state.buttonZones = [];
                if (!state.drawErrorLogged) {
                    state.drawErrorLogged = true;
                    console.error("[FBnodes SaveImagePlus] compare draw disabled after error:", error);
                }
            } finally {
                ctx.restore();
            }
            return result;
        };

        const onMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (event, localPos, canvas) {
            const result = onMouseMove?.apply(this, arguments);
            _fbHoveredSaveImageNode = this;
            const handled = handlePointer(this, localPos);
            if (canvas?.canvas) {
                canvas.canvas.style.cursor = handled ? "ew-resize" : "";
            }
            return result;
        };

        const onMouseEnter = nodeType.prototype.onMouseEnter;
        nodeType.prototype.onMouseEnter = function () {
            _fbHoveredSaveImageNode = this;
            return onMouseEnter?.apply(this, arguments);
        };

        const onMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, localPos, canvas) {
            if (clickSelectionButton(this, localPos)) {
                return true;
            }
            return onMouseDown?.apply(this, arguments);
        };

        const onMouseLeave = nodeType.prototype.onMouseLeave;
        nodeType.prototype.onMouseLeave = function () {
            const result = onMouseLeave?.apply(this, arguments);
            const state = ensureCompareState(this);
            if (_fbHoveredSaveImageNode === this) {
                _fbHoveredSaveImageNode = null;
            }
            if (state.hovering) {
                state.hovering = false;
                this.setDirtyCanvas?.(true, false);
            }
            return result;
        };
    },
});
