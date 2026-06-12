import { app } from "../../scripts/app.js";

function applyJpgQualityVisibility(node) {
    const formatWidget = node.widgets?.find((w) => w?.name === "format");
    const qualityWidget = node.widgets?.find((w) => w?.name === "jpg_quality");
    if (!formatWidget || !qualityWidget) {
        return;
    }

    qualityWidget.hidden = String(formatWidget.value || "").toLowerCase() !== "jpg";
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
        split: 0.5,
        hovering: false,
        imageCache: new Map(),
        previewRect: null,
        buttonZones: [],
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
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width;
    ctx.fillText(text, rect.x + (rect.w - tw) * 0.5, rect.y + rect.h * 0.5);
    ctx.restore();
}

function drawSelectionRows(ctx, node, state, topY, width) {
    state.buttonZones = [];

    const savedCount = state.savedItems.length;
    const compareCount = state.compareItems.length;
    if (!savedCount || !compareCount) {
        return 0;
    }

    const rows = [];
    const pairedView = state.paired && !state.unpaired;
    if (pairedView) {
        if (savedCount > 1) {
            rows.push({ label: "Pair", count: savedCount, selected: state.selectedSaved, type: "pair" });
        }
    } else {
        if (compareCount > 1) {
            rows.push({ label: "A", count: compareCount, selected: state.selectedCompare, type: "A" });
        }
        if (savedCount > 1) {
            rows.push({ label: "B", count: savedCount, selected: state.selectedSaved, type: "B" });
        }
    }

    if (!rows.length) {
        return 0;
    }

    const labelFont = "600 10px Segoe UI";
    const btnFont = "600 10px Segoe UI";
    const btnH = 18;
    const btnGap = 5;
    const groupGap = 16;
    const labelGap = 7;
    const padX = 10;
    const padY = 6;

    ctx.save();
    const measureRow = (row) => {
        ctx.font = labelFont;
        let w = Math.ceil(ctx.measureText(row.label).width) + labelGap;
        ctx.font = btnFont;
        for (let i = 0; i < row.count; i += 1) {
            const text = String(i + 1);
            w += Math.max(24, Math.ceil(ctx.measureText(text).width) + 14) + btnGap;
        }
        return w;
    };
    const rowWidths = rows.map(measureRow);
    ctx.restore();

    const panelX = 10;
    const panelW = Math.max(40, width - 20);
    const innerW = panelW - padX * 2;

    let sideBySide = false;
    if (rows.length === 2) {
        sideBySide = rowWidths[0] + groupGap + rowWidths[1] <= innerW;
    }

    const lineGap = 6;
    const lines = sideBySide ? 1 : rows.length;
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

        ctx.save();
        ctx.font = labelFont;
        ctx.fillStyle = "rgba(192, 206, 222, 0.95)";
        ctx.textBaseline = "middle";
        ctx.fillText(row.label, x, lineY + btnH * 0.5);
        x += Math.ceil(ctx.measureText(row.label).width) + labelGap;
        ctx.restore();

        ctx.save();
        ctx.font = btnFont;
        for (let i = 0; i < row.count; i += 1) {
            const text = String(i + 1);
            const w = Math.max(24, Math.ceil(ctx.measureText(text).width) + 14);
            const rect = { x, y: lineY, w, h: btnH };
            drawButton(ctx, rect, text, i === row.selected);
            state.buttonZones.push({ ...rect, type: row.type, index: i });
            x += w + btnGap;
        }
        ctx.restore();
        return x;
    };

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

    // Pair/unpair checkbox on the right side (only when data is pairable).
    if (state.paired) {
        const boxSize = 13;
        const labelText = "Pair";
        ctx.save();
        ctx.font = "500 10px Segoe UI";
        const labelW = Math.ceil(ctx.measureText(labelText).width);
        const boxX = panelX + panelW - padX - boxSize;
        const boxY = panelY + (totalH - boxSize) * 0.5;
        const labelX = boxX - 5 - labelW;
        const labelMidY = boxY + boxSize * 0.5;
        const checked = !state.unpaired;

        ctx.fillStyle = "rgba(192, 206, 222, 0.95)";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, labelX, labelMidY);

        ctx.beginPath();
        addRoundedRectPath(ctx, boxX, boxY, boxSize, boxSize, 3);
        ctx.fillStyle = checked ? "rgba(49, 92, 130, 0.98)" : "rgba(45, 51, 63, 0.98)";
        ctx.strokeStyle = checked ? "rgba(66, 153, 225, 0.95)" : "rgba(86, 103, 122, 0.7)";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();

        if (checked) {
            ctx.strokeStyle = "rgba(245, 250, 255, 1)";
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(boxX + 3, boxY + boxSize * 0.55);
            ctx.lineTo(boxX + boxSize * 0.42, boxY + boxSize - 3);
            ctx.lineTo(boxX + boxSize - 2.5, boxY + 3);
            ctx.stroke();
        }
        ctx.restore();

        state.buttonZones.push({
            x: labelX,
            y: boxY - 2,
            w: boxX + boxSize - labelX,
            h: boxSize + 4,
            type: "unpairToggle",
            index: 0,
        });
    }

    return totalH;
}

function drawCompareCanvas(ctx, node) {
    const state = ensureCompareState(node);
    if (state.drawDisabled) {
        return;
    }
    node.imgs = [];

    if (!state.savedItems.length) {
        state.previewRect = null;
        state.buttonZones = [];
        return;
    }

    state.selectedSaved = clampIndex(state.selectedSaved, state.savedItems.length);
    state.selectedCompare = clampIndex(state.selectedCompare, state.compareItems.length);

    const contentTop = getContentStartY(node);
    const contentBottom = Number(node.size?.[1] || 320) - 8;
    if (contentBottom <= contentTop + 20) {
        return;
    }

    const controlsH = drawSelectionRows(ctx, node, state, contentTop, Number(node.size?.[0] || 320));

    const frameX = 10;
    const frameY = contentTop + controlsH;
    const frameW = Math.max(40, Number(node.size?.[0] || 320) - 20);
    const frameH = Math.max(80, contentBottom - frameY);

    ctx.save();
    ctx.beginPath();
    addRoundedRectPath(ctx, frameX, frameY, frameW, frameH, 10);
    ctx.fillStyle = "rgba(34, 39, 48, 0.98)";
    ctx.strokeStyle = "rgba(78, 90, 108, 0.72)";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.clip();

    const savedItem = state.savedItems[state.selectedSaved];
    const savedUrl = imageInfoToUrl(savedItem);
    const savedImg = getCachedImage(state, savedUrl, node);
    const drawRect = { x: frameX + 1, y: frameY + 1, w: frameW - 2, h: frameH - 2 };
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

function setResultData(node, message) {
    const state = ensureCompareState(node);

    const savedItems = normalizeImageEntries(message?.saved_images ?? message?.images);
    const compareItems = normalizeImageEntries(message?.compare_images);

    state.savedItems = savedItems;
    state.compareItems = compareItems;
    state.paired = normalizeBool(message?.compare_paired) && compareItems.length === savedItems.length;
    if (!state.paired) {
        state.paired = compareItems.length > 0 && compareItems.length === savedItems.length;
    }

    state.selectedSaved = clampIndex(state.selectedSaved, savedItems.length);
    state.selectedCompare = clampIndex(state.selectedCompare, compareItems.length);
    if (state.paired) {
        state.selectedCompare = clampIndex(state.selectedSaved, compareItems.length);
    }

    state.imageCache.clear();
    node.imgs = [];

    persistCompareData(node, state);
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
    for (const zone of state.buttonZones) {
        const hit = localPos[0] >= zone.x && localPos[0] <= zone.x + zone.w && localPos[1] >= zone.y && localPos[1] <= zone.y + zone.h;
        if (!hit) {
            continue;
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

        if (zone.type === "pair") {
            state.selectedSaved = clampIndex(zone.index, state.savedItems.length);
            state.selectedCompare = clampIndex(zone.index, state.compareItems.length);
        } else if (zone.type === "A") {
            state.selectedCompare = clampIndex(zone.index, state.compareItems.length);
        } else if (zone.type === "B") {
            state.selectedSaved = clampIndex(zone.index, state.savedItems.length);
            if (state.paired && !state.unpaired) {
                state.selectedCompare = clampIndex(zone.index, state.compareItems.length);
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
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);

            setResultData(this, message || {});
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
            const handled = handlePointer(this, localPos);
            if (canvas?.canvas) {
                canvas.canvas.style.cursor = handled ? "ew-resize" : "";
            }
            return result;
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
            if (state.hovering) {
                state.hovering = false;
                this.setDirtyCanvas?.(true, false);
            }
            return result;
        };
    },
});
