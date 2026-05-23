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
const CORNER_HIT_SIZE = 24;
const SIDE_HANDLE_HIT_THICKNESS = 14;
const CANVAS_PAD = 4;
const SIDE_HANDLE_LENGTH_MULT = 1.5;
const INFO_WIDGET_RESERVED_H = 30;
const PREVIEW_CACHE = new Map();

function styleCornerHandle(el, key, size) {
    const t = BRACKET_THICKNESS;
    const r = Math.max(4, Math.round(t * 2.0));
    const hit = Math.max(size, CORNER_HIT_SIZE);
    el.innerHTML = "";
    el.style.width = `${hit}px`;
    el.style.height = `${hit}px`;
    el.style.background = "transparent";

    const h = document.createElement("div");
    const v = document.createElement("div");
    h.style.cssText = `position:absolute; background:#fff; height:${t}px;`;
    v.style.cssText = `position:absolute; background:#fff; width:${t}px;`;

    if (key === "nw") {
        h.style.left = "0"; h.style.top = "0"; h.style.width = `${size}px`; h.style.borderRadius = `${r}px ${r}px 0 0`;
        v.style.left = "0"; v.style.top = "0"; v.style.height = `${size}px`; v.style.borderRadius = `${r}px 0 0 ${r}px`;
    } else if (key === "ne") {
        h.style.right = "0"; h.style.top = "0"; h.style.width = `${size}px`; h.style.borderRadius = `${r}px ${r}px 0 0`;
        v.style.right = "0"; v.style.top = "0"; v.style.height = `${size}px`; v.style.borderRadius = `0 ${r}px ${r}px 0`;
    } else if (key === "sw") {
        h.style.left = "0"; h.style.bottom = "0"; h.style.width = `${size}px`; h.style.borderRadius = `0 0 ${r}px ${r}px`;
        v.style.left = "0"; v.style.bottom = "0"; v.style.height = `${size}px`; v.style.borderRadius = `${r}px 0 0 ${r}px`;
    } else {
        h.style.right = "0"; h.style.bottom = "0"; h.style.width = `${size}px`; h.style.borderRadius = `0 0 ${r}px ${r}px`;
        v.style.right = "0"; v.style.bottom = "0"; v.style.height = `${size}px`; v.style.borderRadius = `0 ${r}px ${r}px 0`;
    }

    el.appendChild(h);
    el.appendChild(v);
}

function styleSideHandle(el, key, length) {
    const t = BRACKET_THICKNESS;
    const r = Math.max(3, Math.round(t * 1.6));
    el.innerHTML = "";
    el.style.background = "transparent";

    const line = document.createElement("div");
    line.style.cssText = "position:absolute; background:#fff;";

    if (key === "n") {
        el.style.width = `${length}px`;
        el.style.height = `${SIDE_HANDLE_HIT_THICKNESS}px`;
        line.style.left = "0";
        line.style.right = "0";
        line.style.bottom = "0";
        line.style.height = `${t}px`;
        line.style.borderRadius = `${r}px ${r}px 0 0`;
    } else if (key === "s") {
        el.style.width = `${length}px`;
        el.style.height = `${SIDE_HANDLE_HIT_THICKNESS}px`;
        line.style.left = "0";
        line.style.right = "0";
        line.style.top = "0";
        line.style.height = `${t}px`;
        line.style.borderRadius = `0 0 ${r}px ${r}px`;
    } else if (key === "w") {
        el.style.width = `${SIDE_HANDLE_HIT_THICKNESS}px`;
        el.style.height = `${length}px`;
        line.style.right = "0";
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = `${t}px`;
        line.style.borderRadius = `${r}px 0 0 ${r}px`;
    } else {
        el.style.width = `${SIDE_HANDLE_HIT_THICKNESS}px`;
        el.style.height = `${length}px`;
        line.style.left = "0";
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = `${t}px`;
        line.style.borderRadius = `0 ${r}px ${r}px 0`;
    }

    el.appendChild(line);
}

function getWidget(node, name) {
    return node.widgets?.find((w) => w?.name === name) || null;
}

function updateInfoWidget(node, state) {
    const w = getWidget(node, "crop_info_display");
    if (!w) return;
    if (!state.hasVisibleImage) {
        w.value = "--";
        return;
    }

    const rw = Math.max(1, state.rect.right - state.rect.left);
    const rh = Math.max(1, state.rect.bottom - state.rect.top);
    const pctW = Math.round((rw / Math.max(1, state.imageW)) * 100);
    const pctH = Math.round((rh / Math.max(1, state.imageH)) * 100);
    w.value = `${pctW}% x ${pctH}% | ${rw}px x ${rh}px`;
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
    const left = Math.round(rect.left);
    const right = Math.round(rect.right);
    const top = Math.round(rect.top);
    const bottom = Math.round(rect.bottom);

    rect.left = Math.max(0, Math.min(left, w - 1));
    rect.right = Math.max(rect.left + 1, Math.min(right, w));
    rect.top = Math.max(0, Math.min(top, h - 1));
    rect.bottom = Math.max(rect.top + 1, Math.min(bottom, h));
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

function applyRatioForHandle(rect, handle, ratio, w, h) {
    if (!ratio || ratio <= 0 || !handle) return;

    const projectCorner = (candW, candH, maxW, maxH) => {
        const vx = 1;
        const vy = 1 / ratio;
        const denom = vx * vx + vy * vy;
        const t = (candW * vx + candH * vy) / Math.max(1e-9, denom);

        let tw = Math.max(1, t * vx);
        let th = Math.max(1, t * vy);

        const sW = maxW / Math.max(1e-9, tw);
        const sH = maxH / Math.max(1e-9, th);
        const s = Math.min(1, sW, sH);
        tw *= s;
        th *= s;

        return { tw: Math.max(1, tw), th: Math.max(1, th) };
    };

    if (handle === "se") {
        const ax = rect.left;
        const ay = rect.top;
        const candW = Math.max(1, rect.right - ax);
        const candH = Math.max(1, rect.bottom - ay);
        const { tw, th } = projectCorner(candW, candH, w - ax, h - ay);
        rect.right = ax + tw;
        rect.bottom = ay + th;
    } else if (handle === "sw") {
        const ax = rect.right;
        const ay = rect.top;
        const candW = Math.max(1, ax - rect.left);
        const candH = Math.max(1, rect.bottom - ay);
        const { tw, th } = projectCorner(candW, candH, ax, h - ay);
        rect.left = ax - tw;
        rect.bottom = ay + th;
    } else if (handle === "ne") {
        const ax = rect.left;
        const ay = rect.bottom;
        const candW = Math.max(1, rect.right - ax);
        const candH = Math.max(1, ay - rect.top);
        const { tw, th } = projectCorner(candW, candH, w - ax, ay);
        rect.right = ax + tw;
        rect.top = ay - th;
    } else if (handle === "nw") {
        const ax = rect.right;
        const ay = rect.bottom;
        const candW = Math.max(1, ax - rect.left);
        const candH = Math.max(1, ay - rect.top);
        const { tw, th } = projectCorner(candW, candH, ax, ay);
        rect.left = ax - tw;
        rect.top = ay - th;
    } else if (handle === "e") {
        const ax = rect.left;
        const cy = (rect.top + rect.bottom) / 2;
        let tw = Math.max(1, rect.right - ax);
        let th = tw / ratio;
        const maxThByCenter = Math.max(1, 2 * Math.min(cy, h - cy));
        th = Math.min(th, maxThByCenter);
        tw = Math.min(th * ratio, w - ax);
        th = tw / ratio;
        rect.right = ax + tw;
        rect.top = cy - th / 2;
        rect.bottom = cy + th / 2;
    } else if (handle === "w") {
        const ax = rect.right;
        const cy = (rect.top + rect.bottom) / 2;
        let tw = Math.max(1, ax - rect.left);
        let th = tw / ratio;
        const maxThByCenter = Math.max(1, 2 * Math.min(cy, h - cy));
        th = Math.min(th, maxThByCenter);
        tw = Math.min(th * ratio, ax);
        th = tw / ratio;
        rect.left = ax - tw;
        rect.top = cy - th / 2;
        rect.bottom = cy + th / 2;
    } else if (handle === "s") {
        const ay = rect.top;
        const cx = (rect.left + rect.right) / 2;
        let th = Math.max(1, rect.bottom - ay);
        let tw = th * ratio;
        const maxTwByCenter = Math.max(1, 2 * Math.min(cx, w - cx));
        tw = Math.min(tw, maxTwByCenter);
        th = Math.min(tw / ratio, h - ay);
        tw = th * ratio;
        rect.bottom = ay + th;
        rect.left = cx - tw / 2;
        rect.right = cx + tw / 2;
    } else if (handle === "n") {
        const ay = rect.bottom;
        const cx = (rect.left + rect.right) / 2;
        let th = Math.max(1, ay - rect.top);
        let tw = th * ratio;
        const maxTwByCenter = Math.max(1, 2 * Math.min(cx, w - cx));
        tw = Math.min(tw, maxTwByCenter);
        th = Math.min(tw / ratio, ay);
        tw = th * ratio;
        rect.top = ay - th;
        rect.left = cx - tw / 2;
        rect.right = cx + tw / 2;
    }

    clampRect(rect, w, h);
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

    const emptyHint = document.createElement("div");
    emptyHint.textContent = "Execute the node to display image";
    emptyHint.style.cssText = "position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); color:rgba(220,230,240,0.62); font-size:13px; font-weight:500; text-align:center; pointer-events:none; user-select:none;";

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
    box.style.cssText = "position:absolute; border:1px solid rgba(255,255,255,0.52); box-sizing:border-box; pointer-events:auto; cursor:move; z-index:2;";

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
        h.style.cssText = "position:absolute; box-sizing:border-box; pointer-events:auto; z-index:4;";
        handles[key] = h;
        overlay.appendChild(h);
    }

    overlay.appendChild(box);
    overlay.appendChild(label);
    root.appendChild(img);
    root.appendChild(emptyHint);
    root.appendChild(overlay);

    const state = {
        root,
        img,
        emptyHint,
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
                const baseLen = Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
                styleSideHandle(el, key, Math.round(baseLen * SIDE_HANDLE_LENGTH_MULT));
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
        const nwHit = parseFloat(nw.style.width) || size;
        const neHit = parseFloat(ne.style.width) || size;
        const swHit = parseFloat(sw.style.width) || size;
        const seHit = parseFloat(se.style.width) || size;

        nw.style.left = `${x1 - t}px`;
        nw.style.top = `${y1 - t}px`;

        ne.style.left = `${x2 - neHit + t}px`;
        ne.style.top = `${y1 - t}px`;

        sw.style.left = `${x1 - t}px`;
        sw.style.top = `${y2 - swHit + t}px`;

        se.style.left = `${x2 - seHit + t}px`;
        se.style.top = `${y2 - seHit + t}px`;

        // Side handles: flat inner side exactly aligns with crop edges.
        const nWidth = parseFloat(n.style.width) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
        const sWidth = parseFloat(s.style.width) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
        const wHeight = parseFloat(w.style.height) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));
        const eHeight = parseFloat(e.style.height) || Math.max(HANDLE_MIN_SIZE, Math.round(size * 0.9));

        const nHeight = parseFloat(n.style.height) || SIDE_HANDLE_HIT_THICKNESS;
        const sHeight = parseFloat(s.style.height) || SIDE_HANDLE_HIT_THICKNESS;
        const wWidth = parseFloat(w.style.width) || SIDE_HANDLE_HIT_THICKNESS;
        const eWidth = parseFloat(e.style.width) || SIDE_HANDLE_HIT_THICKNESS;

        n.style.left = `${xm - nWidth / 2}px`;
        n.style.top = `${y1 - nHeight}px`;

        s.style.left = `${xm - sWidth / 2}px`;
        s.style.top = `${y2}px`;

        w.style.left = `${x1 - wWidth}px`;
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
        state.label.style.display = "none";
        state.emptyHint.style.display = overlayVisible ? "none" : "block";
        state.shadeTop.style.display = overlayVisible ? "block" : "none";
        state.shadeBottom.style.display = overlayVisible ? "block" : "none";
        state.shadeLeft.style.display = overlayVisible ? "block" : "none";
        state.shadeRight.style.display = overlayVisible ? "block" : "none";
        for (const h of Object.values(state.handles)) {
            h.style.display = overlayVisible ? "block" : "none";
        }

        updateInfoWidget(node, state);

        if (!overlayVisible) return;

        state.box.style.left = `${d.left}px`;
        state.box.style.top = `${d.top}px`;
        state.box.style.width = `${Math.max(1, d.right - d.left)}px`;
        state.box.style.height = `${Math.max(1, d.bottom - d.top)}px`;

        // Pixel-snap mask bounds to avoid 1px seams from fractional display coordinates.
        const imgLeft = Math.floor(state.offsetX);
        const imgTop = Math.floor(state.offsetY);
        const imgRight = Math.ceil(state.offsetX + state.dispW);
        const imgBottom = Math.ceil(state.offsetY + state.dispH);

        const cropLeft = Math.max(imgLeft, Math.floor(d.left));
        const cropTop = Math.max(imgTop, Math.floor(d.top));
        const cropRight = Math.min(imgRight, Math.ceil(d.right));
        const cropBottom = Math.min(imgBottom, Math.ceil(d.bottom));

        state.shadeTop.style.left = `${imgLeft}px`;
        state.shadeTop.style.top = `${imgTop}px`;
        state.shadeTop.style.width = `${Math.max(0, imgRight - imgLeft)}px`;
        state.shadeTop.style.height = `${Math.max(0, cropTop - imgTop)}px`;

        state.shadeBottom.style.left = `${imgLeft}px`;
        state.shadeBottom.style.top = `${cropBottom}px`;
        state.shadeBottom.style.width = `${Math.max(0, imgRight - imgLeft)}px`;
        state.shadeBottom.style.height = `${Math.max(0, imgBottom - cropBottom)}px`;

        state.shadeLeft.style.left = `${imgLeft}px`;
        state.shadeLeft.style.top = `${cropTop}px`;
        state.shadeLeft.style.width = `${Math.max(0, cropLeft - imgLeft)}px`;
        state.shadeLeft.style.height = `${Math.max(0, cropBottom - cropTop)}px`;

        state.shadeRight.style.left = `${cropRight}px`;
        state.shadeRight.style.top = `${cropTop}px`;
        state.shadeRight.style.width = `${Math.max(0, imgRight - cropRight)}px`;
        state.shadeRight.style.height = `${Math.max(0, cropBottom - cropTop)}px`;

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
        drag = {
            mode,
            handle,
            x: startEvent.clientX,
            y: startEvent.clientY,
        };

        const onMove = (e) => {
            if (!drag) return;
            const dxScreen = e.clientX - drag.x;
            const dyScreen = e.clientY - drag.y;

            // Convert mouse deltas from screen space to overlay-local space (accounts for canvas zoom).
            const overlayRect = state.overlay.getBoundingClientRect();
            const scaleX = overlayRect.width > 0 ? overlayRect.width / Math.max(1, state.overlay.clientWidth) : 1;
            const scaleY = overlayRect.height > 0 ? overlayRect.height / Math.max(1, state.overlay.clientHeight) : 1;
            const dx = dxScreen / (scaleX || 1);
            const dy = dyScreen / (scaleY || 1);

            const r = { ...rectToDisplay(state) };

            if (drag.mode === "move") {
                const rw = r.right - r.left;
                const rh = r.bottom - r.top;
                const minX = state.offsetX;
                const minY = state.offsetY;
                const maxX = state.offsetX + state.dispW;
                const maxY = state.offsetY + state.dispH;

                let left = r.left + dx;
                let top = r.top + dy;

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
            if (ratio && drag.mode === "resize") {
                applyRatioForHandle(state.rect, drag.handle, ratio, state.imageW, state.imageH);
            } else if (ratio) {
                fitRectToRatio(state.rect, state.imageW, state.imageH, ratio);
            }
            updateWidgetValues(node, state);
            redraw();

            // Consume mouse motion every frame so clamped overflow does not accumulate.
            drag.x = e.clientX;
            drag.y = e.clientY;
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

            if (!getWidget(this, "crop_info_display")) {
                const infoWidget = this.addWidget("text", "crop_info_display", "--", () => {}, {});
                if (infoWidget?.inputEl) {
                    infoWidget.inputEl.readOnly = true;
                }
            }

            const domWidget = this.addDOMWidget("drag_crop_preview", "customwidget", ui.state.root, {
                serialize: false,
                hideOnZoom: false,
            });
            // Keep a stable minimum; do not depend on current node height or it will ratchet upward.
            domWidget.computeSize = (w) => [Math.max(120, w), 120];

            clampNodeSize(this);

            const resizeRoot = () => {
                const width = Math.max(120, (this.size?.[0] || NODE_MIN_W) - 22);
                const hasInfoWidget = !!getWidget(this, "crop_info_display");
                const reserved = 205 + (hasInfoWidget ? INFO_WIDGET_RESERVED_H : 0);
                const height = Math.max(120, (this.size?.[1] || NODE_MIN_H) - reserved);
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
