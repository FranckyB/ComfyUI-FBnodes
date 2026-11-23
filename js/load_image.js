/**
 * Load Image+ (FBnodes): image / video-frame loader with a file browser, an
 * on-node preview, a painted mask, a crop, flips and padding for outpainting.
 *
 * The face is one fbui card. The stock widgets stay (hidden) and hold every
 * saved value: source_folder, image, frame_position, mask_data, crop_data,
 * flip_x, flip_y, pad_data. The stage draws the picture, mask, crop and
 * padding on one canvas.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { basenameOf, isAbsolutePath, isImageFile, isVideoFile, previewUrl, stripAnnotation } from "./path_browser.js";
import { mountCard } from "./fbui/card.js";
import { notifyChange, toast } from "./fbui/comfy.js";
import { button, ICONS, rail } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { modalOpen, openMenu } from "./fbui/modal.js";
import { makeScrub } from "./fbui/scrub.js";
import { findWidget, hideInputsInDef, hideWidget, suppressCorePreview } from "./fbui/widgets.js";
import { createImageStage, drawStroke } from "./common/image_stage.js";
import { BLANK, loadPlus, NONE, sourceLabel } from "./common/load_plus.js";
import { cropPixels, isFullCrop, lockPad } from "./common/stage_math.js";
import { CAPTION_HEIGHT, ROW_HEIGHT, T } from "./fbui/theme.js";

const NODE_NAME = "LoadImagePlus";
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;
// Wide enough for the Brush row: a box that still shows "512" plus five tools.
const MIN_WIDTH = 330;
const STAGE_MIN_HEIGHT = 200;
// The frame picker: its rail (24) over the FRAME line, 6 apart.
const FRAME_PANEL_HEIGHT = 24 + 6 + ROW_HEIGHT;
const BRUSH_MAX = 512;
const PAD_FEATHER = 40;
const PAD_MAX = 16384;
// The padded canvas's aspect: free, the picture's own, or a fixed ratio.
const ASPECTS = ["free", "source", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"];
// Below this the Edit row's tools show their icons only.
const EDIT_LABELS_MIN = 290;
// Which tool the stage edits when the node loads, or when the active one turns off.
const TOOLS = ["crop", "mask", "pad"];

const sourceFolder = (node) => findWidget(node, "source_folder")?.value || "input";
const imageValue = (node) => stripAnnotation(findWidget(node, "image")?.value);

// ---------------------------------------------------------------- preview

function loadBitmap(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

// { frames, fps, duration } of a video, or null when the backend cannot read it.
const videoInfos = new Map();
function videoInfo(filename, source) {
    const key = `${source}|${filename}`;
    if (!videoInfos.has(key)) {
        const params = new URLSearchParams({ filename, source });
        videoInfos.set(key, api.fetchApi(`/fbnodes/video-info?${params}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((info) => (info?.frames > 0 ? { frames: info.frames, fps: info.fps, duration: info.duration } : null))
            .catch(() => null));
    }
    return videoInfos.get(key);
}

// The frame `position` picks, decoded by the backend with the same PyAV code
// the node runs, so the preview is exactly the frame the node loads.
function videoFrame(filename, position, source) {
    const params = new URLSearchParams({ filename, source, position: String(position) });
    return loadBitmap(api.apiURL(`/fbnodes/video-frame?${params}`));
}

// Show `filename` on the stage. A newer request wins over a slower older one.
async function showFile(node, filename) {
    const fb = node._fb;
    const request = ++fb.request;
    const apply = (bitmap, video = null) => {
        if (request !== fb.request) return;
        fb.image = bitmap ? { bitmap, width: bitmap.naturalWidth, height: bitmap.naturalHeight } : null;
        fb.blank = filename === BLANK;
        fb.video = video;
        if (bitmap) fitNodeToImage(node);
        fb.card?.refresh();
        fb.stage?.redraw();
    };
    if (!filename || filename === NONE) return apply(null);
    try {
        if (filename === BLANK) return apply(await loadBitmap(PLACEHOLDER_IMAGE_PATH));
        if (isVideoFile(filename)) {
            const source = sourceFolder(node);
            const position = Number(findWidget(node, "frame_position")?.value) || 0;
            const info = await videoInfo(filename, source);
            return apply(await videoFrame(filename, position, source), info);
        }
        if (isImageFile(filename)) return apply(await loadBitmap(`${previewUrl(filename, sourceFolder(node))}&t=${Date.now()}`));
    } catch (error) {
        console.error(`[LoadImagePlus] Could not preview ${filename}:`, error);
    }
    apply(await loadBitmap(PLACEHOLDER_IMAGE_PATH).catch(() => null));
}

// A new node takes the first picture's shape once; after that its size is the user's.
function fitNodeToImage(node) {
    const fb = node._fb;
    if (fb.sized || fb.configured || !fb.image) return;
    const canvas = fb.stage?.canvas;
    if (!canvas?.clientWidth || !canvas.clientHeight) return;
    fb.sized = true;
    const wanted = Math.min(640, Math.max(STAGE_MIN_HEIGHT, canvas.clientWidth * fb.image.height / fb.image.width + 24));
    node.setSize([node.size[0], node.size[1] + wanted - canvas.clientHeight]);
    node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- crop / flip state

const FULL_CROP = { left_pct: 0, right_pct: 100, top_pct: 0, bottom_pct: 100 };

function getFlips(node) {
    const flag = (value) => (typeof value === "string" ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : Boolean(value));
    return { x: flag(findWidget(node, "flip_x")?.value), y: flag(findWidget(node, "flip_y")?.value) };
}

function setFlip(node, axis, enabled) {
    const widget = findWidget(node, axis);
    if (widget) widget.value = enabled;
    node.properties[axis] = enabled;
}

function normalizeCrop(state) {
    const pct = (value, fallback) => Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : fallback));
    const crop = {
        enabled: Boolean(state?.enabled),
        left_pct: pct(state?.left_pct, 0),
        right_pct: pct(state?.right_pct, 100),
        top_pct: pct(state?.top_pct, 0),
        bottom_pct: pct(state?.bottom_pct, 100),
    };
    if (crop.right_pct <= crop.left_pct) crop.right_pct = Math.min(100, crop.left_pct + 1);
    if (crop.bottom_pct <= crop.top_pct) crop.bottom_pct = Math.min(100, crop.top_pct + 1);
    return crop;
}

function parseCrop(value) {
    try {
        return normalizeCrop(typeof value === "string" && value ? JSON.parse(value) : null);
    } catch {
        return normalizeCrop(null);
    }
}

function syncCropData(node) {
    const crop = node._fb.crop;
    const round = (value) => Number(value.toFixed(4));
    const value = JSON.stringify({
        version: 1,
        enabled: crop.enabled,
        left_pct: round(crop.left_pct),
        right_pct: round(crop.right_pct),
        top_pct: round(crop.top_pct),
        bottom_pct: round(crop.bottom_pct),
    });
    const widget = findWidget(node, "crop_data");
    if (widget) widget.value = value;
    node.properties._cropData = value;
}

// The crop is stored in source space; the stage edits it as displayed (flipped).
function displayCrop(node) {
    const crop = node._fb.crop;
    const flips = getFlips(node);
    return {
        left_pct: flips.x ? 100 - crop.right_pct : crop.left_pct,
        right_pct: flips.x ? 100 - crop.left_pct : crop.right_pct,
        top_pct: flips.y ? 100 - crop.bottom_pct : crop.top_pct,
        bottom_pct: flips.y ? 100 - crop.top_pct : crop.bottom_pct,
    };
}

function setDisplayCrop(node, rect) {
    const flips = getFlips(node);
    Object.assign(node._fb.crop, normalizeCrop({
        enabled: node._fb.crop.enabled,
        left_pct: flips.x ? 100 - rect.right_pct : rect.left_pct,
        right_pct: flips.x ? 100 - rect.left_pct : rect.right_pct,
        top_pct: flips.y ? 100 - rect.bottom_pct : rect.top_pct,
        bottom_pct: flips.y ? 100 - rect.top_pct : rect.bottom_pct,
    }));
    syncCropData(node);
}

// ---------------------------------------------------------------- pad state

// Pixels added beyond the output on each side (as displayed, flips
// included) and how far the outpaint mask fades into the picture.
function parsePad(value) {
    let data = null;
    try {
        data = typeof value === "string" && value ? JSON.parse(value) : null;
    } catch { /* an empty pad */ }
    const px = (entry) => Math.max(0, Math.min(PAD_MAX, Math.round(Number(entry) || 0)));
    return {
        enabled: Boolean(data?.enabled),
        left: px(data?.left), right: px(data?.right), top: px(data?.top), bottom: px(data?.bottom),
        feather: px(data?.feather ?? PAD_FEATHER),
        aspect: ASPECTS.includes(data?.aspect) ? data.aspect : "free",
    };
}

function syncPadData(node) {
    const { enabled, left, right, top, bottom, feather, aspect } = node._fb.pad;
    findWidget(node, "pad_data").value = JSON.stringify({ version: 1, enabled, left, right, top, bottom, feather, aspect });
    syncCanvasOutput(node);
}

// The canvas output shows while Pad is on, and stays while a link still uses it.
function syncCanvasOutput(node) {
    const slot = node.findOutputSlot("canvas");
    if (node._fb.pad.enabled && slot < 0) node.addOutput("canvas", "IMAGE");
    else if (!node._fb.pad.enabled && slot >= 0 && !node.outputs[slot].links?.length) node.removeOutput(slot);
}

// Width / height the canvas is held to, or null while the aspect is free.
function padRatio(node) {
    const aspect = node._fb.pad.aspect;
    if (aspect === "free") return null;
    const { width, height } = croppedSize(node);
    if (aspect === "source") return width / height;
    const [w, h] = aspect.split(":").map(Number);
    return w / h;
}

// Sides edited by `handle` ("" for none), held to the aspect.
function setPad(node, sides, handle = null) {
    const fb = node._fb;
    const ratio = handle !== null && fb.image ? padRatio(node) : null;
    const next = { ...fb.pad, ...sides };
    if (ratio) {
        const { width, height } = croppedSize(node);
        Object.assign(next, lockPad(next, handle, width, height, ratio));
    }
    Object.assign(fb.pad, next);
    syncPadData(node);
    fb.card.refresh();
}

// The output size before padding.
function croppedSize(node) {
    const { crop, image } = node._fb;
    return crop.enabled && !isFullCrop(crop) ? cropPixels(crop, image.width, image.height) : { width: image.width, height: image.height };
}

// ---------------------------------------------------------------- mask state

// Vector strokes (for editing and undo) live in properties._maskStrokes; the
// mask_data widget holds the rasterized PNG data URL the backend reads, or a
// JSON stroke payload while there is no picture to rasterize against.
function parseStrokes(value) {
    try {
        const data = typeof value === "string" && value.startsWith("{") ? JSON.parse(value) : null;
        return {
            brushSize: Math.max(1, Number(data?.brushSize) || 64),
            erasing: Boolean(data?.erasing),
            strokes: Array.isArray(data?.strokes) ? data.strokes : [],
        };
    } catch {
        return { brushSize: 64, erasing: false, strokes: [] };
    }
}

function restoreMask(node) {
    const props = node.properties;
    const widget = findWidget(node, "mask_data");
    const widgetValue = typeof widget?.value === "string" ? widget.value.trim() : "";
    const stored = typeof props._maskData === "string" ? props._maskData.trim() : "";
    const persisted = widgetValue || stored || (typeof props._maskStrokes === "string" ? props._maskStrokes.trim() : "");
    if (widget && !widgetValue && persisted) widget.value = persisted;
    if (!stored && persisted) props._maskData = persisted;
    if (props._maskEnabled === undefined && persisted) props._maskEnabled = true;
    const enabled = props._maskEnabled !== undefined
        ? ["1", "true", "yes", "on"].includes(String(props._maskEnabled).toLowerCase())
        : Boolean(persisted);
    const parsed = parseStrokes(props._maskStrokes || widgetValue);
    return { enabled, ...parsed, redo: [], hidden: false };
}

function maskValue(node) {
    const { mask, image } = node._fb;
    if (!mask.enabled) return "";
    if (image && mask.strokes.length) {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        for (const stroke of mask.strokes) drawStroke(ctx, stroke, { x: 0, y: 0, w: image.width, h: image.height });
        return canvas.toDataURL("image/png");
    }
    return JSON.stringify({ version: 1, enabled: true, brushSize: mask.brushSize, erasing: mask.erasing, strokes: mask.strokes });
}

function syncMaskData(node) {
    const mask = node._fb.mask;
    const value = maskValue(node);
    const widget = findWidget(node, "mask_data");
    if (widget) widget.value = value;
    node.properties._maskEnabled = mask.enabled;
    node.properties._maskData = value;
    node.properties._maskStrokes = mask.strokes.length
        ? JSON.stringify({ version: 1, brushSize: mask.brushSize, erasing: mask.erasing, strokes: mask.strokes })
        : "";
}

// ---------------------------------------------------------------- tools

// Mask, Crop and Pad are each on or off (what the node outputs); the tool is
// which of them the stage edits. Pressing an enabled tool that is not the
// active one switches to it; pressing the active one turns it off.
function pressTool(node, name) {
    const fb = node._fb;
    const state = fb[name];
    if (!state.enabled) {
        state.enabled = true;
        fb.tool = name;
    } else if (fb.tool !== name) {
        fb.tool = name;
    } else {
        state.enabled = false;
        fb.tool = TOOLS.find((tool) => fb[tool].enabled) ?? null;
    }
    ({ mask: syncMaskData, crop: syncCropData, pad: syncPadData })[name](node);
    fb.card.refreshByHand();
    fb.stage.redraw();
    notifyChange();
}

function editMask(node, change) {
    const mask = node._fb.mask;
    change(mask);
    syncMaskData(node);
    node._fb.card.refresh();
    node._fb.stage.redraw();
    notifyChange();
}

function editControl(node) {
    const fb = node._fb;
    const tools = el("div", "fbui-field");
    const mask = button("Mask", { icon: ICONS.brush, grow: true, title: "Paint a mask. Press again to stop painting, once more to turn it off.", onClick: () => pressTool(node, "mask") });
    const crop = button("Crop", { icon: ICONS.crop, grow: true, title: "Crop by dragging any edge or corner. Press again to turn it off.", onClick: () => pressTool(node, "crop") });
    const pad = button("Pad", { icon: ICONS.pad, grow: true, title: "Extend the canvas to outpaint: drag any edge outward. The mask output marks the new area. Press again to turn it off.", onClick: () => pressTool(node, "pad") });
    const flip = (axis) => () => {
        setFlip(node, axis, !getFlips(node)[axis === "flip_x" ? "x" : "y"]);
        syncCropData(node);
        fb.card.refresh();
        fb.stage.redraw();
        notifyChange();
    };
    const flipX = button("", { icon: ICONS.flipX, title: "Flip horizontally", onClick: flip("flip_x") });
    const flipY = button("", { icon: ICONS.flipY, title: "Flip vertically", onClick: flip("flip_y") });
    tools.append(mask, crop, pad, flipX, flipY);
    // A narrow node keeps the icons; the words come back when it widens.
    new ResizeObserver(() => {
        const compact = tools.clientWidth < EDIT_LABELS_MIN;
        for (const control of [mask, crop, pad]) control.querySelector("span").hidden = compact;
    }).observe(tools);
    return {
        element: tools,
        sync() {
            const flips = getFlips(node);
            for (const [control, name] of [[mask, "mask"], [crop, "crop"], [pad, "pad"]]) {
                control.classList.toggle("primary", fb.tool === name);
                control.classList.toggle("on", fb[name].enabled && fb.tool !== name);
            }
            flipX.classList.toggle("on", flips.x);
            flipY.classList.toggle("on", flips.y);
        },
    };
}

function brushControl(node) {
    const fb = node._fb;
    const tools = el("div", "fbui-field");
    const size = makeScrub({
        value: fb.mask.brushSize, min: 1, max: BRUSH_MAX, step: 2, fineStep: 1, decimals: 0,
        title: "Brush size in pixels ([ and ] while hovering the node).",
        onChange: (value) => { fb.mask.brushSize = value; fb.stage.redraw(); },
        onSettle: () => { syncMaskData(node); notifyChange(); },
    });
    // The box gives way first so all five tools always fit; 40px still shows "512".
    size.root.style.minWidth = "40px";
    tools.style.gap = "4px";
    const hide = button("", { icon: ICONS.eye, title: "Hold to hide the mask" });
    const showAgain = () => { fb.mask.hidden = false; fb.stage.redraw(); };
    hide.addEventListener("pointerdown", () => { fb.mask.hidden = true; fb.stage.redraw(); });
    hide.addEventListener("pointerup", showAgain);
    hide.addEventListener("pointerleave", showAgain);
    const undo = button("", { icon: ICONS.undo, title: "Undo stroke", onClick: () => editMask(node, (m) => { const s = m.strokes.pop(); if (s) m.redo.push(s); }) });
    const redo = button("", { icon: ICONS.redo, title: "Redo stroke", onClick: () => editMask(node, (m) => { const s = m.redo.pop(); if (s) m.strokes.push(s); }) });
    const erase = button("", { icon: ICONS.eraser, title: "Eraser (Space while hovering the node)", onClick: () => editMask(node, (m) => { m.erasing = !m.erasing; }) });
    const clear = button("", { icon: ICONS.trash, danger: true, title: "Clear the mask", onClick: () => editMask(node, (m) => { m.strokes = []; m.redo = []; }) });
    tools.append(size.root, hide, undo, redo, erase, clear);
    return {
        element: tools,
        sync() {
            size.set(fb.mask.brushSize);
            erase.classList.toggle("on", fb.mask.erasing);
        },
    };
}

function stagePanel(node) {
    const fb = node._fb;
    const stage = createImageStage({
        image: () => fb.image,
        flips: () => getFlips(node),
        crop: () => ({ shown: fb.crop.enabled && Boolean(fb.image), editable: fb.tool === "crop", rect: displayCrop(node) }),
        pad: () => ({ shown: fb.pad.enabled && Boolean(fb.image), editable: fb.tool === "pad", sides: fb.pad }),
        mask: () => ({
            shown: fb.mask.enabled && !fb.mask.hidden,
            editable: fb.tool === "mask",
            strokes: fb.mask.strokes,
            brushSize: fb.mask.brushSize,
            erasing: fb.mask.erasing,
        }),
        onCrop: (rect) => {
            setDisplayCrop(node, rect);
            fb.card.refresh();
        },
        onCropEnd: notifyChange,
        onPad: (sides, handle) => setPad(node, sides, handle),
        onPadEnd: notifyChange,
        onStrokeStart: (stroke) => {
            fb.mask.redo = [];
            fb.mask.strokes.push(stroke);
        },
        onStrokeEnd: () => {
            syncMaskData(node);
            notifyChange();
        },
        onClick: () => {
            if (!fb.tool) files.openBrowser(node);
        },
        onContextMenu: (event) => showContextMenu(node, event),
        emptyText: () => "Browse, drop or paste an image",
    });
    fb.stage = stage;
    const tools = el("div", "fbui-stage-tools");
    const open = button("", { icon: ICONS.open, small: true, title: "Open a large preview", onClick: () => files.openPreview(node) });
    tools.append(open);
    stage.element.append(tools);
    return {
        element: stage.element,
        sync() {
            open.hidden = !fb.image || fb.blank;
            stage.redraw();
        },
    };
}

// The footnote under the stage: the picture's size, and the size the node
// outputs when a crop or pad changes it.
function captionPanel(node) {
    const fb = node._fb;
    const caption = el("div", "fbui-caption");
    return {
        element: caption,
        sync() {
            const image = fb.image;
            if (!image || fb.blank) {
                caption.textContent = "—";
                return;
            }
            let { width, height } = croppedSize(node);
            if (fb.pad.enabled) {
                width += fb.pad.left + fb.pad.right;
                height += fb.pad.top + fb.pad.bottom;
            }
            const source = `${image.width} × ${image.height}`;
            caption.textContent = width === image.width && height === image.height ? source : `${source} → ${width} × ${height}`;
        },
    };
}

// Frame picker for videos: a rail with a playhead (press or drag it) and a
// FRAME number box with the time. With the frame count known, frame n is
// stored as n / frames; otherwise the rail sets the 0..1 position itself.
// The value is written straight to the widget: the stock float widget's
// callback rounds to its 0.01 step, which would land long videos on the
// wrong frame.
function framePanel(node) {
    const fb = node._fb;
    const frames = () => (fb.video?.frames > 1 ? fb.video.frames : 0);
    const position = () => Number(findWidget(node, "frame_position")?.value) || 0;
    const setPosition = (value, settled) => {
        findWidget(node, "frame_position").value = Math.max(0, Math.min(1, value));
        fb.frameChanged();
        fb.card.refresh();
        node.setDirtyCanvas(true, true);
        if (settled) notifyChange();
    };
    const toFrame = (count, fraction) => Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1))));

    const panel = el("div");
    panel.style.cssText = "display:flex;flex-direction:column;gap:6px;height:100%;justify-content:center";
    const track = rail({
        title: "Press or drag to pick the frame the node outputs.",
        onSeek: (fraction, settled) => {
            const count = frames();
            setPosition(count ? toFrame(count, fraction) / count : fraction, settled);
        },
    });
    const line = el("div", "fbui-field");
    line.style.flex = "none";
    line.style.height = `${ROW_HEIGHT}px`;
    const scrub = makeScrub({
        value: 0, min: 0, max: 1, step: 0.01, fineStep: 0.001, decimals: 2,
        title: "Which frame of the video to load.",
        onChange: (value) => {
            const count = frames();
            setPosition(count ? value / count : value, false);
        },
        onSettle: notifyChange,
    });
    scrub.root.style.cssText = "flex:none;width:84px";
    const readout = el("span", "fbui-readout");
    line.append(el("span", "fbui-tag", "Frame"), scrub.root, readout);
    panel.append(track.root, line);

    let mode = null;
    return {
        element: panel,
        sync() {
            const count = frames();
            if (mode !== count) {
                mode = count;
                scrub.setRange(count ? { min: 0, max: count - 1, step: 1, fineStep: 1, decimals: 0 } : { min: 0, max: 1, step: 0.01, fineStep: 0.001, decimals: 2 });
            }
            readout.replaceChildren();
            if (count) {
                const frame = Math.min(count - 1, Math.round(position() * count));
                scrub.set(frame);
                track.set(count > 1 ? frame / (count - 1) : 0);
                const fps = Number(fb.video.fps) || 0;
                if (fps > 0) readout.append(el("b", "", `${(frame / fps).toFixed(2)} s`), document.createTextNode(` · of ${count} frames`));
                else readout.append(document.createTextNode(`of ${count} frames`));
            } else {
                scrub.set(position());
                track.set(position());
                readout.textContent = "position";
            }
        },
    };
}

// Exact crop, in pixels of the picture as shown (flips included).
function cropPairControl(node, first, second) {
    const fb = node._fb;
    const field = el("div", "fbui-field");
    const scrubs = {};
    const commit = (side, value) => {
        const image = fb.image;
        if (!image) return;
        const rect = displayCrop(node);
        const across = side === "left" || side === "right" ? image.width : image.height;
        const pct = (Math.max(0, value) / across) * 100;
        if (side === "left") rect.left_pct = Math.min(pct, rect.right_pct - 100 / across);
        else if (side === "right") rect.right_pct = Math.max(100 - pct, rect.left_pct + 100 / across);
        else if (side === "top") rect.top_pct = Math.min(pct, rect.bottom_pct - 100 / across);
        else rect.bottom_pct = Math.max(100 - pct, rect.top_pct + 100 / across);
        setDisplayCrop(node, rect);
        fb.card.refresh();
    };
    for (const side of [first, second]) {
        if (side === second) field.append(el("span", "fbui-sep", "·"));
        scrubs[side] = makeScrub({
            value: 0, min: 0, max: 16384, step: 1, fineStep: 1, decimals: 0, unit: "px",
            title: `Pixels cropped from the ${side}.`,
            onChange: (value) => commit(side, value),
            onSettle: notifyChange,
        });
        field.append(scrubs[side].root);
    }
    return {
        element: field,
        sync() {
            const image = fb.image;
            if (!image) return;
            const px = cropPixels(displayCrop(node), image.width, image.height);
            for (const side of [first, second]) scrubs[side].set(px[side]);
        },
    };
}

// The resets beside the Exact crop / Exact pad headers.
function cropResetControl(node) {
    const fb = node._fb;
    const reset = button("", { icon: ICONS.reset, small: true, title: "Reset the crop: back to the whole picture", onClick: () => {
        setDisplayCrop(node, FULL_CROP);
        fb.card.refresh();
        notifyChange();
    } });
    return {
        element: reset,
        sync() {
            reset.disabled = isFullCrop(fb.crop);
        },
    };
}

function padResetControl(node) {
    const fb = node._fb;
    const reset = button("", { icon: ICONS.reset, small: true, title: "Reset the padding", onClick: () => {
        setPad(node, { left: 0, right: 0, top: 0, bottom: 0 }, "");
        notifyChange();
    } });
    return {
        element: reset,
        sync() {
            reset.disabled = !(fb.pad.left || fb.pad.right || fb.pad.top || fb.pad.bottom);
        },
    };
}

// The Pad row: the canvas's aspect and the feather.
function padControl(node) {
    const fb = node._fb;
    const tools = el("div", "fbui-field");
    const aspect = el("select", "fbui-select");
    aspect.title = "The padded canvas's aspect: free, the picture's own, or a ratio that holds while you drag.";
    for (const value of ASPECTS) {
        const option = el("option", "", { free: "Free", source: "Source" }[value] ?? value);
        option.value = value;
        aspect.append(option);
    }
    aspect.addEventListener("change", () => {
        fb.pad.aspect = aspect.value;
        setPad(node, {}, "");
        notifyChange();
    });
    const featherIcon = el("span");
    featherIcon.innerHTML = ICONS.feather;
    featherIcon.title = "Feather: how far the mask fades into the picture, so the seam is painted over too.";
    featherIcon.style.cssText = `flex:none;display:flex;color:${T.label}`;
    const feather = makeScrub({
        value: fb.pad.feather, min: 0, max: 512, step: 4, fineStep: 1, decimals: 0, unit: "px",
        title: featherIcon.title,
        onChange: (value) => setPad(node, { feather: value }),
        onSettle: notifyChange,
    });
    feather.root.style.cssText = "flex:none;width:76px";
    tools.append(aspect, featherIcon, feather.root);
    return {
        element: tools,
        sync() {
            aspect.value = fb.pad.aspect;
            feather.set(fb.pad.feather);
        },
    };
}

// Exact padding, in pixels added on each side.
function padPairControl(node, first, second) {
    const fb = node._fb;
    const field = el("div", "fbui-field");
    const scrubs = {};
    for (const side of [first, second]) {
        if (side === second) field.append(el("span", "fbui-sep", "·"));
        scrubs[side] = makeScrub({
            value: 0, min: 0, max: PAD_MAX, step: 8, fineStep: 1, decimals: 0, unit: "px",
            title: `Pixels added on the ${side}.`,
            onChange: (value) => setPad(node, { [side]: value }, { left: "w", right: "e", top: "n", bottom: "s" }[side]),
            onSettle: notifyChange,
        });
        field.append(scrubs[side].root);
    }
    return {
        element: field,
        sync() {
            for (const side of [first, second]) scrubs[side].set(fb.pad[side]);
        },
    };
}

// ---------------------------------------------------------------- files

const files = loadPlus({ widget: "image", listKind: "media", navKind: "media", allowedTypes: ["image", "video"] });

const isImagePath = (text) => isAbsolutePath(text) && /\.(png|jpe?g|webp|gif|bmp)$/i.test(text);

async function pastePath(node, path) {
    const response = await api.fetchApi(`/fbnodes/path-browser/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`Could not read ${path}`);
    await files.upload(node, await response.blob(), basenameOf(path));
}

async function pasteClipboardItems(node, items) {
    for (const item of items) {
        if (!item.types.includes("text/plain")) continue;
        const text = (await (await item.getType("text/plain")).text()).trim();
        if (isImagePath(text)) return pastePath(node, text).then(() => true);
    }
    for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (!type) continue;
        const ext = { "image/jpeg": "jpg", "image/webp": "webp" }[type] ?? "png";
        await files.upload(node, await item.getType(type), `pasted_${Date.now()}.${ext}`, type);
        return true;
    }
    return false;
}

async function pasteDataTransfer(node, data) {
    const text = (data?.getData("text/plain") || "").trim();
    if (isImagePath(text)) {
        await pastePath(node, text);
        return true;
    }
    const file = data?.files?.[0];
    if (file && /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
        await files.upload(node, file, file.name, file.type);
        return true;
    }
    return false;
}

async function copyImage(node) {
    const image = node._fb.image;
    if (!image) return;
    try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d").drawImage(image.bitmap, 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (error) {
        toast(`Could not copy the image: ${error.message}`, { severity: "error" });
    }
}

function showContextMenu(node, event) {
    const hasImage = Boolean(node._fb.image) && !node._fb.blank;
    openMenu(event.clientX, event.clientY, [
        { label: "Open preview", disabled: !hasImage, action: () => files.openPreview(node) },
        { label: "Copy image", disabled: !hasImage, action: () => copyImage(node) },
        {
            label: "Paste image",
            action: async () => {
                try {
                    if (!(await pasteClipboardItems(node, await navigator.clipboard.read()))) {
                        toast("The clipboard holds no image or image path.", { severity: "warn" });
                    }
                } catch (error) {
                    // A context menu gives no clipboard-read permission; Ctrl+V needs none.
                    if (error.name === "NotAllowedError") toast("The browser blocked clipboard access here. Hover the node and press Ctrl+V.");
                    else toast(`Paste failed: ${error.message}`, { severity: "error" });
                }
            },
        },
        { label: "Browse files…", action: () => files.openBrowser(node) },
    ]);
}

// ---------------------------------------------------------------- keyboard

// Shortcuts act on the Load Image+ node under the pointer (← / → come from
// load_plus).
const typing = (target) => /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "") || target?.isContentEditable;
const activeNode = () => files.hoveredNode();

function installShortcuts() {
    window.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || modalOpen() || typing(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
        const node = activeNode();
        if (!node) return;
        const fb = node._fb;
        let handled = false;
        if (fb.tool === "mask" && (event.key === "[" || event.key === "]")) {
            const step = Math.max(1, Math.round(fb.mask.brushSize * 0.15));
            editMask(node, (m) => { m.brushSize = Math.max(1, Math.min(BRUSH_MAX, m.brushSize + (event.key === "]" ? step : -step))); });
            handled = true;
        } else if (fb.tool === "mask" && event.key === " ") {
            editMask(node, (m) => { m.erasing = !m.erasing; });
            handled = true;
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
    // The paste event carries clipboardData without any permission prompt.
    window.addEventListener("paste", (event) => {
        if (event.defaultPrevented || typing(event.target)) return;
        const node = activeNode();
        if (!node) return;
        event.preventDefault();
        event.stopPropagation();
        pasteDataTransfer(node, event.clipboardData)
            .then((pasted) => { if (!pasted) toast("The clipboard holds no image or image path.", { severity: "warn" }); })
            .catch((error) => toast(`Paste failed: ${error.message}`, { severity: "error" }));
    }, true);
}

// ---------------------------------------------------------------- node

function setupNode(node) {
    node.properties ??= {};
    suppressCorePreview(node);
    const fb = {
        request: 0, image: null, blank: false, sized: false, configured: false,
        mask: restoreMask(node),
        crop: parseCrop(node.properties._cropData || findWidget(node, "crop_data")?.value),
        pad: parsePad(findWidget(node, "pad_data")?.value),
        tool: null,
        reload: (value) => showFile(node, value),
    };
    node._fb = fb;
    fb.tool = TOOLS.find((tool) => fb[tool].enabled) ?? null;
    for (const name of ["source_folder", "frame_position", "mask_data", "crop_data", "flip_x", "flip_y", "pad_data"]) hideWidget(findWidget(node, name));

    const imageWidget = findWidget(node, "image");
    chainCallback(imageWidget, "callback", (value) => {
        // The MaskEditor writes "name.png [input]".
        const clean = stripAnnotation(value);
        if (clean !== value) imageWidget.value = clean;
        const frame = findWidget(node, "frame_position");
        if (frame && isVideoFile(clean)) frame.value = 0;
        showFile(node, clean);
    });
    // A frame change reloads the preview once the scrubbing settles.
    let frameTimer = 0;
    fb.frameChanged = () => {
        clearTimeout(frameTimer);
        frameTimer = setTimeout(() => {
            if (isVideoFile(imageValue(node))) showFile(node, imageValue(node));
        }, 300);
    };
    chainCallback(findWidget(node, "frame_position"), "callback", fb.frameChanged);

    const cropTool = (_values, n) => n._fb.tool === "crop";
    const padTool = (_values, n) => n._fb.tool === "pad";
    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            {
                widget: "image", label: "Source", kind: "select", labels: sourceLabel,
                button: files.sourceButtons,
            },
            { label: "Edit", control: editControl },
            { label: "Brush", control: brushControl, when: (_values, n) => n._fb.tool === "mask" },
            { label: "Pad", control: padControl, when: padTool },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: framePanel, height: FRAME_PANEL_HEIGHT, when: (values) => isVideoFile(values.image) },
            { group: "crop", label: "Exact crop", tools: cropResetControl, when: cropTool },
            { label: "Left · Right", control: (n) => cropPairControl(n, "left", "right"), group: "crop", when: cropTool },
            { label: "Top · Bottom", control: (n) => cropPairControl(n, "top", "bottom"), group: "crop", when: cropTool },
            { group: "pad", label: "Exact pad", tools: padResetControl, when: padTool },
            { label: "Left · Right", control: (n) => padPairControl(n, "left", "right"), group: "pad", when: padTool },
            { label: "Top · Bottom", control: (n) => padPairControl(n, "top", "bottom"), group: "pad", when: padTool },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    files.track(node);
    syncCanvasOutput(node);

    chainCallback(node, "onConfigure", () => {
        fb.configured = true;
        fb.mask = restoreMask(node);
        const props = node.properties;
        if (!props._cropData && findWidget(node, "crop_data")?.value) props._cropData = findWidget(node, "crop_data").value;
        fb.crop = parseCrop(props._cropData);
        fb.pad = parsePad(findWidget(node, "pad_data")?.value);
        syncCanvasOutput(node);
        for (const axis of ["flip_x", "flip_y"]) if (props[axis] !== undefined) setFlip(node, axis, Boolean(props[axis]));
        fb.tool = TOOLS.find((tool) => fb[tool].enabled) ?? null;
        syncCropData(node);
        files.refreshOptions(node, imageValue(node));
        showFile(node, imageValue(node)).then(() => { if (fb.mask.enabled) syncMaskData(node); });
    });
    chainCallback(node, "onRemoved", () => {
        fb.stage?.dispose();
    });

    node.onDragOver = (event) => Boolean(event.dataTransfer?.types?.includes("Files"));
    node.onDragDrop = async (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (!file || !/\.(png|jpe?g|webp|mp4|webm|mov|avi)$/i.test(file.name)) return false;
        try {
            await files.upload(node, file, file.name, file.type);
        } catch (error) {
            toast(`Upload failed: ${error.message}`, { severity: "error" });
        }
        return true;
    };

    // A new node lists the input folder and shows its default value.
    queueMicrotask(() => {
        if (fb.configured) return;
        files.refreshOptions(node, imageValue(node));
        showFile(node, imageValue(node));
    });
}

app.registerExtension({
    name: "FBnodes.LoadImagePlus",

    setup() {
        installShortcuts();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["source_folder", "image", "frame_position", "mask_data", "crop_data", "flip_x", "flip_y", "pad_data"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
