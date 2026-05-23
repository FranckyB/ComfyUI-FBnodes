import { app } from "../../scripts/app.js";

const PREVIEW_W = 420;
const PREVIEW_H = 360;
const NODE_MIN_W = 240;
const NODE_MIN_H = 420;
const NODE_MIN_SIZE_W = NODE_MIN_W + 22;
const NODE_MIN_SIZE_H = NODE_MIN_H;
const HANDLE_MIN_SIZE = 20;
const HANDLE_MAX_SIZE = 24;
const BRACKET_THICKNESS = 3;
const CANVAS_PAD = 4;
const PREVIEW_CACHE = new Map();

function styleCornerHandle(el, key, size) {
    const t = BRACKET_THICKNESS;
    const r = Math.max(3, Math.round(t * 1.6));
    el.innerHTML = "";
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.background = "transparent";

    const h = document.createElement("div");
    const v = document.createElement("div");
    h.style.cssText = `position:absolute; background:#fff; height:${t}px;`;
    v.style.cssText = `position:absolute; background:#fff; width:${t}px;`;

    if (key === "nw") {
        h.style.left = "0"; h.style.top = "0"; h.style.right = "0"; h.style.borderRadius = `${r}px 0 0 0`;
        v.style.left = "0"; v.style.top = "0"; v.style.bottom = "0"; v.style.borderRadius = `${r}px 0 0 0`;
    } else if (key === "ne") {
        h.style.left = "0"; h.style.top = "0"; h.style.right = "0"; h.style.borderRadius = `0 ${r}px 0 0`;
        v.style.right = "0"; v.style.top = "0"; v.style.bottom = "0"; v.style.borderRadius = `0 ${r}px 0 0`;
    } else if (key === "sw") {
        h.style.left = "0"; h.style.bottom = "0"; h.style.right = "0"; h.style.borderRadius = `0 0 0 ${r}px`;
        v.style.left = "0"; v.style.top = "0"; v.style.bottom = "0"; v.style.borderRadius = `0 0 0 ${r}px`;
    } else {
        h.style.left = "0"; h.style.bottom = "0"; h.style.right = "0"; h.style.borderRadius = `0 0 ${r}px 0`;
        v.style.right = "0"; v.style.top = "0"; v.style.bottom = "0"; v.style.borderRadius = `0 0 ${r}px 0`;
    }

    el.appendChild(h);
    el.appendChild(v);
}

function styleSideHandle(el, key, length) {
    const t = BRACKET_THICKNESS;
    const r = Math.max(3, Math.round(t * 1.6));
    el.innerHTML = "";
    el.style.background = "#fff";

    if (key === "n") {
        el.style.width = `${length}px`;
        el.style.height = `${t}px`;
        el.style.borderRadius = `${r}px ${r}px 0 0`;
    } else if (key === "s") {
        el.style.width = `${length}px`;
        el.style.height = `${t}px`;
        el.style.borderRadius = `0 0 ${r}px ${r}px`;
    } else if (key === "w") {
        el.style.width = `${t}px`;
        el.style.height = `${length}px`;
        el.style.borderRadius = `${r}px 0 0 ${r}px`;
    } else {
        el.style.width = `${t}px`;
        el.style.height = `${length}px`;
        el.style.borderRadius = `0 ${r}px ${r}px 0`;
    }
}

function getWidget(node, name) {
    return node.widgets?.find((w) => w?.name === name) || null;
}

function parseRatioLabel(label, landscape) {
    if (!label || label === "None") return null;
    const m = String(label).match(/\s*([0-9]*\.?[0-9]+)\s*:\s*([0-9]*\.?[0-9]+)\s*/);
    if (!m) return null;
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    let r = a / b;
    if (landscape) r = 1 / r;
    return r > 0 ? r : null;
}

function clampRect(rect, w, h) {
    rect.left = Math.max(0, Math.min(rect.left, w - 1));
    rect.right = Math.max(rect.left + 1, Math.min(rect.right, w));
    rect.top = Math.max(0, Math.min(rect.top, h - 1));
    rect.bottom = Math.max(rect.top + 1, Math.min(rect.bottom, h));
}

function fitRectToRatio(rect, w, h, ratio) {
    if (!ratio || ratio <= 0) return;
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    let rw = Math.max(1, rect.right - rect.left);
    let rh = Math.max(1, rect.bottom - rect.top);
    const cur = rw / rh;

    if (cur > ratio) rw = rh * ratio;
    else rh = rw / ratio;

    rw = Math.min(rw, w);
    rh = Math.min(rh, h);

    rect.left = Math.round(cx - rw / 2);
    rect.right = Math.round(cx + rw / 2);
    rect.top = Math.round(cy - rh / 2);
    rect.bottom = Math.round(cy + rh / 2);

    if (rect.left < 0) {
        rect.right -= rect.left;
        rect.left = 0;
    }
    if (rect.top < 0) {
        rect.bottom -= rect.top;
        rect.top = 0;
    }
    if (rect.right > w) {
        rect.left -= rect.right - w;
        rect.right = w;
    }
    if (rect.bottom > h) {
        rect.top -= rect.bottom - h;
        rect.bottom = h;
    }

    clampRect(rect, w, h);
}

function fitRectByAreaAndRatio(rect, w, h, ratio) {
    if (!ratio || ratio <= 0) return;
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const area = Math.max(1, (rect.right - rect.left) * (rect.bottom - rect.top));

    let rw = Math.sqrt(area * ratio);
    let rh = Math.sqrt(area / ratio);

    rw = Math.min(rw, w);
    rh = Math.min(rh, h);

    rect.left = Math.round(cx - rw / 2);
    rect.right = Math.round(cx + rw / 2);
    rect.top = Math.round(cy - rh / 2);
    rect.bottom = Math.round(cy + rh / 2);

    fitRectToRatio(rect, w, h, ratio);
}

function updateWidgetValues(node, state) {
    getWidget(node, "crop_left").value = state.rect.left;
    getWidget(node, "crop_right").value = state.rect.right;
    getWidget(node, "crop_top").value = state.rect.top;
    getWidget(node, "crop_bottom").value = state.rect.bottom;
    state._persistCrop?.();
    node.setDirtyCanvas?.(true, true);
}

function syncRectFromWidgets(node, state) {
    state.rect.left = Number(getWidget(node, "crop_left")?.value ?? 0);
    state.rect.right = Number(getWidget(node, "crop_right")?.value ?? state.imageW);
    state.rect.top = Number(getWidget(node, "crop_top")?.value ?? 0);
    state.rect.bottom = Number(getWidget(node, "crop_bottom")?.value ?? state.imageH);
    clampRect(state.rect, state.imageW, state.imageH);
}

function rectToDisplay(state) {
    const s = state.scale;
    return {
        left: state.offsetX + state.rect.left * s,
        right: state.offsetX + state.rect.right * s,
        top: state.offsetY + state.rect.top * s,
        bottom: state.offsetY + state.rect.bottom * s,
    };
}

function displayToRect(state, d) {
    const s = state.scale;
    state.rect.left = Math.round((d.left - state.offsetX) / s);
    state.rect.right = Math.round((d.right - state.offsetX) / s);
    state.rect.top = Math.round((d.top - state.offsetY) / s);
    state.rect.bottom = Math.round((d.bottom - state.offsetY) / s);
    clampRect(state.rect, state.imageW, state.imageH);
}

function clampNodeSize(node) {
    node.size = node.size || [NODE_MIN_SIZE_W, NODE_MIN_SIZE_H];
    node.size[0] = Math.max(node.size[0] || 0, NODE_MIN_SIZE_W);
    node.size[1] = Math.max(node.size[1] || 0, NODE_MIN_SIZE_H);
}

function ensurePersistState(node) {
    node.properties = node.properties || {};
    node.properties.fb_dragcrop = node.properties.fb_dragcrop || {};
    return node.properties.fb_dragcrop;
}

function persistCropState(node, state) {
    const p = ensurePersistState(node);
    p.crop_left = state.rect.left;
    p.crop_right = state.rect.right;
    p.crop_top = state.rect.top;
    p.crop_bottom = state.rect.bottom;
    p.has_saved_crop = true;
}

function persistImageState(node, state) {
    const p = ensurePersistState(node);
    p.image_key = state.imageKey || null;
    p.signature = state.signature || null;
    p.image_w = state.imageW || null;
    p.image_h = state.imageH || null;
}

function getNodeCacheKey(node) {
    return String(node.id ?? "no-id");
}

function hasLikelySavedCrop(node) {
    const left = Number(getWidget(node, "crop_left")?.value ?? 0);
    const right = Number(getWidget(node, "crop_right")?.value ?? 640);
    const top = Number(getWidget(node, "crop_top")?.value ?? 0);
    const bottom = Number(getWidget(node, "crop_bottom")?.value ?? 480);
    if (![left, right, top, bottom].every(Number.isFinite)) return false;
    return !(left === 0 && right === 640 && top === 0 && bottom === 480);
}

function buildUI(node) {
    const root = document.createElement("div");
    root.style.cssText = `
        width:${PREVIEW_W}px;
        height:${PREVIEW_H}px;
        position:relative;
        border:1px solid rgba(255,255,255,0.12);
        border-radius:6px;
        overflow:hidden;
        background:#1c1e22;
        box-sizing:border-box;
        user-select:none;
    `;

    const img = document.createElement("img");
    img.style.cssText = `position:absolute; inset:${CANVAS_PAD}px; width:calc(100% - ${CANVAS_PAD * 2}px); height:calc(100% - ${CANVAS_PAD * 2}px); object-fit:contain;`;
    img.draggable = false;

    const overlay = document.createElement("div");
    overlay.style.cssText = `position:absolute; inset:${CANVAS_PAD}px; pointer-events:none;`;

    const shadeTop = document.createElement("div");
    const shadeBottom = document.createElement("div");
    const shadeLeft = document.createElement("div");
    const shadeRight = document.createElement("div");
    for (const s of [shadeTop, shadeBottom, shadeLeft, shadeRight]) {
        s.style.cssText = "position:absolute; background:rgba(0,0,0,0.45); pointer-events:none;";
        overlay.appendChild(s);
    }

    const box = document.createElement("div");
    box.style.cssText = "position:absolute; border:1px solid rgba(255,255,255,0.52); box-sizing:border-box; pointer-events:auto; cursor:move;";

    const gridV1 = document.createElement("div");
    gridV1.style.cssText = "position:absolute; top:0; bottom:0; left:33.333%; width:1px; transform:translateX(-0.5px); background:rgba(255,255,255,0.38); pointer-events:none;";
    const gridV2 = document.createElement("div");
    gridV2.style.cssText = "position:absolute; top:0; bottom:0; left:66.666%; width:1px; transform:translateX(-0.5px); background:rgba(255,255,255,0.38); pointer-events:none;";
    const gridH1 = document.createElement("div");
    gridH1.style.cssText = "position:absolute; left:0; right:0; top:33.333%; height:1px; transform:translateY(-0.5px); background:rgba(255,255,255,0.38); pointer-events:none;";
    const gridH2 = document.createElement("div");
    gridH2.style.cssText = "position:absolute; left:0; right:0; top:66.666%; height:1px; transform:translateY(-0.5px); background:rgba(255,255,255,0.38); pointer-events:none;";
    box.appendChild(gridV1);
    box.appendChild(gridV2);
    box.appendChild(gridH1);
    box.appendChild(gridH2);

    const label = document.createElement("div");
    label.style.cssText = "position:absolute; left:50%; top:8px; transform:translate(-50%,0); color:#ffffff; background:rgba(20,24,30,0.86); border:1px solid rgba(255,255,255,0.34); border-radius:6px; padding:3px 8px; font-size:12px; font-weight:600; white-space:pre; text-align:center; pointer-events:none;";

    const handles = {};
    for (const key of ["n","s","e","w","nw","ne","sw","se"]) {
        const h = document.createElement("div");
        h.dataset.handle = key;
        h.style.cssText = "position:absolute; box-sizing:border-box; pointer-events:auto;";
        handles[key] = h;
        overlay.appendChild(h);
    }

    overlay.appendChild(box);
    overlay.appendChild(label);
    root.appendChild(img);
    root.appendChild(overlay);

    const state = {
        root,
        img,
        overlay,
        shadeTop,
        shadeBottom,
        shadeLeft,
        shadeRight,
        box,
        label,
        handles,
        imageW: 640,
        imageH: 480,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        rect: { left: 0, right: 640, top: 0, bottom: 480 },
        signature: null,
        imageKey: null,
        hasImagePayload: false,
        keepCropOnFirstImage: false,
        hasVisibleImage: false,
        viewW: PREVIEW_W,
        viewH: PREVIEW_H,
        lastLandscape: false,
        _persistCrop: null,
        dispW: PREVIEW_W,
        dispH: PREVIEW_H,
    };
    state._persistCrop = () => persistCropState(node, state);

    function layoutHandles(displayRect) {
        const x1 = displayRect.left;
        const x2 = displayRect.right;
        const y1 = displayRect.top;
        const y2 = displayRect.bottom;
        const xm = (x1 + x2) / 2;
        const ym = (y1 + y2) / 2;
        const rw = Math.max(1, displayRect.right - displayRect.left);
        const rh = Math.max(1, displayRect.bottom - displayRect.top);
        const target = Math.min(HANDLE_MAX_SIZE, Math.max(HANDLE_MIN_SIZE, Math.min(rw * 0.22, rh * 0.22)));
        const size = Math.round(target);
        const t = BRACKET_THICKNESS;

        const placeCenter = (el, x, y, cursor) => {
            const key = el.dataset.handle;
            if (["nw", "ne", "sw", "se"].includes(key)) {
                styleCornerHandle(el, key, size);
            } else {
                styleSideHandle(el, key, Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9)));
            }
            el.style.cursor = cursor;

            const ew = parseFloat(el.style.width) || size;
            const eh = parseFloat(el.style.height) || size;

            el.style.left = `${x - ew / 2}px`;
            el.style.top = `${y - eh / 2}px`;
        };

        const nw = state.handles.nw;
        const ne = state.handles.ne;
        const sw = state.handles.sw;
        const se = state.handles.se;
        const n = state.handles.n;
        const s = state.handles.s;
        const w = state.handles.w;
        const e = state.handles.e;

        placeCenter(nw, 0, 0, "nwse-resize");
        placeCenter(ne, 0, 0, "nesw-resize");
        placeCenter(sw, 0, 0, "nesw-resize");
        placeCenter(se, 0, 0, "nwse-resize");
        placeCenter(n, xm, y1, "ns-resize");
        placeCenter(s, xm, y2, "ns-resize");
        placeCenter(w, x1, ym, "ew-resize");
        placeCenter(e, x2, ym, "ew-resize");

        // Corner L-brackets: flat inner sides exactly align with crop edges.
        nw.style.left = `${x1 - t}px`;
        nw.style.top = `${y1 - t}px`;

        ne.style.left = `${x2 - size + t}px`;
        ne.style.top = `${y1 - t}px`;

        sw.style.left = `${x1 - t}px`;
        sw.style.top = `${y2 - size + t}px`;

        se.style.left = `${x2 - size + t}px`;
        se.style.top = `${y2 - size + t}px`;

        // Side handles: flat inner side exactly aligns with crop edges.
        const nWidth = parseFloat(n.style.width) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
        const sWidth = parseFloat(s.style.width) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
        const wHeight = parseFloat(w.style.height) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
        const eHeight = parseFloat(e.style.height) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));

        n.style.left = `${xm - nWidth / 2}px`;
        n.style.top = `${y1 - t}px`;

        s.style.left = `${xm - sWidth / 2}px`;
        s.style.top = `${y2}px`;

        w.style.left = `${x1 - t}px`;
        w.style.top = `${ym - wHeight / 2}px`;

        e.style.left = `${x2}px`;
        e.style.top = `${ym - eHeight / 2}px`;
    }

    function redraw() {
        state.viewW = Math.max(1, (state.root.clientWidth || PREVIEW_W) - CANVAS_PAD * 2);
        state.viewH = Math.max(1, (state.root.clientHeight || PREVIEW_H) - CANVAS_PAD * 2);

        const fitScale = Math.min(state.viewW / state.imageW, state.viewH / state.imageH);
        state.scale = fitScale;
        const dispW = state.imageW * fitScale;
        const dispH = state.imageH * fitScale;
        state.dispW = dispW;
        state.dispH = dispH;
        state.offsetX = (state.viewW - dispW) / 2;
        state.offsetY = (state.viewH - dispH) / 2;

        const d = rectToDisplay(state);

        const overlayVisible = !!state.hasVisibleImage;
        state.box.style.display = overlayVisible ? "block" : "none";
        state.label.style.display = overlayVisible ? "block" : "none";
        state.shadeTop.style.display = overlayVisible ? "block" : "none";
        state.shadeBottom.style.display = overlayVisible ? "block" : "none";
        state.shadeLeft.style.display = overlayVisible ? "block" : "none";
        state.shadeRight.style.display = overlayVisible ? "block" : "none";
        for (const h of Object.values(state.handles)) {
            h.style.display = overlayVisible ? "block" : "none";
        }

        if (!overlayVisible) return;

        state.box.style.left = `${d.left}px`;
        state.box.style.top = `${d.top}px`;
        state.box.style.width = `${Math.max(1, d.right - d.left)}px`;
        state.box.style.height = `${Math.max(1, d.bottom - d.top)}px`;

        state.shadeTop.style.left = `${state.offsetX}px`;
        state.shadeTop.style.top = `${state.offsetY}px`;
        state.shadeTop.style.width = `${state.dispW}px`;
        state.shadeTop.style.height = `${Math.max(0, d.top - state.offsetY)}px`;

        state.shadeBottom.style.left = `${state.offsetX}px`;
        state.shadeBottom.style.top = `${d.bottom}px`;
        state.shadeBottom.style.width = `${state.dispW}px`;
        state.shadeBottom.style.height = `${Math.max(0, state.offsetY + state.dispH - d.bottom)}px`;

        state.shadeLeft.style.left = `${state.offsetX}px`;
        state.shadeLeft.style.top = `${d.top}px`;
        state.shadeLeft.style.width = `${Math.max(0, d.left - state.offsetX)}px`;
        state.shadeLeft.style.height = `${Math.max(0, d.bottom - d.top)}px`;

        state.shadeRight.style.left = `${d.right}px`;
        state.shadeRight.style.top = `${d.top}px`;
        state.shadeRight.style.width = `${Math.max(0, state.offsetX + state.dispW - d.right)}px`;
        state.shadeRight.style.height = `${Math.max(0, d.bottom - d.top)}px`;

        const rw = state.rect.right - state.rect.left;
        const rh = state.rect.bottom - state.rect.top;
        const pctW = Math.round((rw / state.imageW) * 100);
        const pctH = Math.round((rh / state.imageH) * 100);
        state.label.style.left = `${state.viewW / 2}px`;
        state.label.textContent = `${pctW}% x ${pctH}% | ${rw}px x ${rh}px`;

        layoutHandles(d);
    }

    function applyAspectFromWidgets() {
        const landscape = !!getWidget(node, "landscape")?.value;
        const ratio = parseRatioLabel(getWidget(node, "aspect_ratio")?.value, landscape);
        const landscapeToggled = landscape !== state.lastLandscape;
        state.lastLandscape = landscape;

        if (ratio) {
            if (landscapeToggled) {
                fitRectByAreaAndRatio(state.rect, state.imageW, state.imageH, ratio);
            } else {
                fitRectToRatio(state.rect, state.imageW, state.imageH, ratio);
            }
            updateWidgetValues(node, state);
        }
        redraw();
    }

    let drag = null;

    function startDrag(mode, startEvent, handle = null) {
        startEvent.preventDefault();
        const startRect = rectToDisplay(state);
        drag = {
            mode,
            handle,
            x: startEvent.clientX,
            y: startEvent.clientY,
            rect: { ...startRect },
        };

        const onMove = (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            const r = { ...drag.rect };

            if (drag.mode === "move") {
                const rw = drag.rect.right - drag.rect.left;
                const rh = drag.rect.bottom - drag.rect.top;
                const minX = state.offsetX;
                const minY = state.offsetY;
                const maxX = state.offsetX + state.dispW;
                const maxY = state.offsetY + state.dispH;

                let left = drag.rect.left + dx;
                let top = drag.rect.top + dy;

                left = Math.max(minX, Math.min(left, maxX - rw));
                top = Math.max(minY, Math.min(top, maxY - rh));

                r.left = left;
                r.right = left + rw;
                r.top = top;
                r.bottom = top + rh;
            } else {
                if (drag.handle.includes("w")) r.left += dx;
                if (drag.handle.includes("e")) r.right += dx;
                if (drag.handle.includes("n")) r.top += dy;
                if (drag.handle.includes("s")) r.bottom += dy;
            }

            const minSize = drag.mode === "move" ? 1 : 20;
            if (r.right - r.left < minSize) {
                if (drag.handle?.includes("w")) r.left = r.right - minSize;
                else r.right = r.left + minSize;
            }
            if (r.bottom - r.top < minSize) {
                if (drag.handle?.includes("n")) r.top = r.bottom - minSize;
                else r.bottom = r.top + minSize;
            }

            const ratio = parseRatioLabel(getWidget(node, "aspect_ratio")?.value, !!getWidget(node, "landscape")?.value);
            displayToRect(state, r);
            if (ratio) fitRectToRatio(state.rect, state.imageW, state.imageH, ratio);
            updateWidgetValues(node, state);
            redraw();
        };

        const onUp = () => {
            drag = null;
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }

    state.box.addEventListener("mousedown", (e) => {
        if (e.target?.dataset?.handle) return;
        startDrag("move", e);
    });

    for (const h of Object.values(state.handles)) {
        h.addEventListener("mousedown", (e) => startDrag("resize", e, h.dataset.handle));
    }

    return {
        state,
        redraw,
        applyAspectFromWidgets,
        setImage(info) {
            if (!info || typeof info !== "object") return;
            state.imageW = Number(info.width) || 640;
            state.imageH = Number(info.height) || 480;
            state.img.src = info.preview || "";
            state.lastLandscape = !!getWidget(node, "landscape")?.value;

            const signature = info.signature || null;
            state.hasVisibleImage = signature !== "none";
            const imageKey = signature || info.preview || `${state.imageW}x${state.imageH}`;
            const isNewImage = imageKey !== state.imageKey;
            const isFirstPayload = !state.hasImagePayload;

            state.hasImagePayload = true;

            if (isFirstPayload && state.keepCropOnFirstImage) {
                state.imageKey = imageKey;
                state.signature = signature;
                syncRectFromWidgets(node, state);
                if (Number.isFinite(info.crop_left)) state.rect.left = Number(info.crop_left);
                if (Number.isFinite(info.crop_right)) state.rect.right = Number(info.crop_right);
                if (Number.isFinite(info.crop_top)) state.rect.top = Number(info.crop_top);
                if (Number.isFinite(info.crop_bottom)) state.rect.bottom = Number(info.crop_bottom);
            } else if (isNewImage) {
                state.imageKey = imageKey;
                state.signature = signature;
                state.rect.left = 0;
                state.rect.right = state.imageW;
                state.rect.top = 0;
                state.rect.bottom = state.imageH;
                updateWidgetValues(node, state);
            } else {
                syncRectFromWidgets(node, state);
                if (Number.isFinite(info.crop_left)) state.rect.left = Number(info.crop_left);
                if (Number.isFinite(info.crop_right)) state.rect.right = Number(info.crop_right);
                if (Number.isFinite(info.crop_top)) state.rect.top = Number(info.crop_top);
                if (Number.isFinite(info.crop_bottom)) state.rect.bottom = Number(info.crop_bottom);
            }

            clampRect(state.rect, state.imageW, state.imageH);
            persistCropState(node, state);
            persistImageState(node, state);

            PREVIEW_CACHE.set(getNodeCacheKey(node), {
                preview: state.img.src || "",
                width: state.imageW,
                height: state.imageH,
                signature: state.signature,
                imageKey: state.imageKey,
            });

            state.keepCropOnFirstImage = false;
            redraw();
        },
    };
}

app.registerExtension({
    name: "FBnodes.DragCropPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "DragCropPlus") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            const ui = buildUI(this);
            this._dragCropUI = ui;

            const domWidget = this.addDOMWidget("drag_crop_preview", "customwidget", ui.state.root, {
                serialize: false,
                hideOnZoom: false,
            });
            domWidget.computeSize = (w) => [Math.max(120, w), Math.max(120, (this.size?.[1] || NODE_MIN_H) - 205)];

            clampNodeSize(this);

            const resizeRoot = () => {
                const width = Math.max(120, (this.size?.[0] || NODE_MIN_W) - 22);
                const height = Math.max(120, (this.size?.[1] || NODE_MIN_H) - 205);
                ui.state.root.style.width = `${width}px`;
                ui.state.root.style.height = `${height}px`;
                ui.redraw();
            };
            resizeRoot();

            const oldOnResize = this.onResize;
            this.onResize = function () {
                const res = oldOnResize?.apply(this, arguments);
                clampNodeSize(this);
                resizeRoot();
                this.setDirtyCanvas?.(true, true);
                return res;
            };

            const wireWidget = (name, cb) => {
                const w = getWidget(this, name);
                if (!w) return;
                const old = w.callback;
                w.callback = function () {
                    old?.apply(this, arguments);
                    cb();
                };
            };

            wireWidget("crop_left", () => { syncRectFromWidgets(this, ui.state); ui.redraw(); });
            wireWidget("crop_right", () => { syncRectFromWidgets(this, ui.state); ui.redraw(); });
            wireWidget("crop_top", () => { syncRectFromWidgets(this, ui.state); ui.redraw(); });
            wireWidget("crop_bottom", () => { syncRectFromWidgets(this, ui.state); ui.redraw(); });
            wireWidget("aspect_ratio", () => ui.applyAspectFromWidgets());
            wireWidget("landscape", () => ui.applyAspectFromWidgets());

            const persistAfterWidget = () => persistCropState(this, ui.state);
            wireWidget("crop_left", persistAfterWidget);
            wireWidget("crop_right", persistAfterWidget);
            wireWidget("crop_top", persistAfterWidget);
            wireWidget("crop_bottom", persistAfterWidget);

            ui.redraw();
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const payload = message?.dragcrop;
            const info = Array.isArray(payload) ? payload[0] : payload;
            if (info && this._dragCropUI) {
                this._dragCropUI.setImage(info);
            }
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            if (this._dragCropUI) {
                const ui = this._dragCropUI;
                const p = this.properties?.fb_dragcrop || {};

                ui.state.keepCropOnFirstImage = !!p.has_saved_crop || hasLikelySavedCrop(this);
                ui.state.imageKey = p.image_key || null;
                ui.state.signature = p.signature || null;

                const cache = PREVIEW_CACHE.get(getNodeCacheKey(this));
                if (cache?.preview) {
                    ui.state.imageW = Number(cache.width) || ui.state.imageW;
                    ui.state.imageH = Number(cache.height) || ui.state.imageH;
                    ui.state.imageKey = cache.imageKey || ui.state.imageKey;
                    ui.state.signature = cache.signature || ui.state.signature;
                    ui.state.img.src = cache.preview;
                    ui.state.hasImagePayload = true;
                    ui.state.hasVisibleImage = ui.state.signature !== "none";
                }

                if (p?.has_saved_crop) {
                    const left = Number(p.crop_left);
                    const right = Number(p.crop_right);
                    const top = Number(p.crop_top);
                    const bottom = Number(p.crop_bottom);
                    if ([left, right, top, bottom].every(Number.isFinite)) {
                        const wl = getWidget(this, "crop_left");
                        const wr = getWidget(this, "crop_right");
                        const wt = getWidget(this, "crop_top");
                        const wb = getWidget(this, "crop_bottom");
                        if (wl) wl.value = left;
                        if (wr) wr.value = right;
                        if (wt) wt.value = top;
                        if (wb) wb.value = bottom;
                    }
                }

                syncRectFromWidgets(this, ui.state);
                persistCropState(this, ui.state);
                ui.redraw();
            }
            return r;
        };
    },
});
