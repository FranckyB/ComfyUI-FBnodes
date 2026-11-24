/**
 * Load Image+ (FBnodes): image / video-frame loader with a file browser, an
 * on-node preview, a painted mask, a turn, a crop, flips, padding for
 * outpainting, a scale and a size step; py/image_transform.py applies them.
 *
 * The face is one fbui card. The stock widgets stay (hidden) and hold every
 * saved value: source_folder, image, frame_position, mask_data, crop_data,
 * flip_x, flip_y, pad_data, rotate_data, scale_data, step. The stage draws
 * the turned picture, mask, crop and padding on one canvas; crop and pad are
 * measured on the turned picture, as the backend applies them.
 *
 * It outputs the result as image, its mask, and the file as loaded as
 * original, shown while an edit is on.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { basenameOf, isAbsolutePath, isImageFile, isVideoFile, previewUrl, stripAnnotation } from "./path_browser.js";
import { mountCard } from "./fbui/card.js";
import { notifyChange, toast } from "./fbui/comfy.js";
import { button, ICONS, rail, segmented, slideLabel } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { confirm, modalOpen, openMenu } from "./fbui/modal.js";
import { makeScrub } from "./fbui/scrub.js";
import { findWidget, hideInputsInDef, hideWidget, suppressCorePreview } from "./fbui/widgets.js";
import { createImageStage, drawStroke } from "./common/image_stage.js";
import { BLANK, loadPlus, NONE, sourceLabel } from "./common/load_plus.js";
import { cropPixels, dragCrop, dragPad, fitRect, isFullCrop, lockCrop, lockPad, outputLayout, rotatedSize } from "./common/stage_math.js";
import { CAPTION_HEIGHT, ROW_HEIGHT, T } from "./fbui/theme.js";

const NODE_NAME = "LoadImagePlus";
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;
// Wide enough for the Brush row: a box that still shows "512" plus five tools.
const MIN_WIDTH = 380;
const STAGE_MIN_HEIGHT = 200;
// The frame picker: its rail (24) over the FRAME line, 6 apart.
// Play and the rail, then the FRAME line.
const FRAME_PANEL_HEIGHT = ROW_HEIGHT + 6 + ROW_HEIGHT;
const BRUSH_MAX = 512;
const PAD_FEATHER = 40;
const PAD_MAX = 16384;
// A crop's or padded canvas's aspect: free, the picture's own, or a fixed ratio.
const ASPECTS = ["free", "source", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"];
// Below this the Edit row's tools show their icons only.
const EDIT_LABELS_MIN = 470;
// Which tool the stage edits when the node loads, or when the active one turns off.
const TOOLS = ["crop", "mask", "pad", "rotate", "scale"];
const SCALE_METHODS = ["lanczos", "area", "bicubic", "bilinear", "nearest-exact"];
// The step's choices; 1 is off. Another value (set in the API) shows none picked.
const STEPS = [1, 8, 16, 32, 64];

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
function videoFrame(filename, position, source, size = 0) {
    const params = new URLSearchParams({ filename, source, position: String(position) });
    if (size) params.set("size", String(size));
    return loadBitmap(api.apiURL(`/fbnodes/video-frame?${params}`));
}

// Reduced frames while playing or scrubbing (AusBoss's frame picker): one
// fetch in flight, the latest position wins; the full frame follows when the
// playhead settles. The picture keeps its full size, so crop and pad hold.
const PREVIEW_FRAME_SIZE = 512;
function pumpFrame(node, position) {
    const fb = node._fb;
    fb.wantedFrame = position;
    fb.pumping ??= (async () => {
        while (fb.wantedFrame !== null) {
            const at = fb.wantedFrame;
            fb.wantedFrame = null;
            const bitmap = await videoFrame(imageValue(node), at, sourceFolder(node), PREVIEW_FRAME_SIZE).catch(() => null);
            if (bitmap && fb.image) {
                fb.image = { ...fb.image, bitmap };
                fb.stage.redraw();
            }
        }
        fb.pumping = null;
    })();
    return fb.pumping;
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
        aspect: ASPECTS.includes(state?.aspect) ? state.aspect : "free",
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
        aspect: crop.aspect,
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

// The crop as displayed, after an edit by `handle` ("" for none; null keeps
// it as given), held to the aspect.
function setDisplayCrop(node, rect, handle = null) {
    const { crop, image } = node._fb;
    const world = image ? turned(node) : null;
    const ratio = handle !== null && world ? aspectRatio(crop.aspect, world.width, world.height) : null;
    if (ratio) rect = lockCrop(rect, handle, world.width, world.height, ratio);
    const flips = getFlips(node);
    Object.assign(crop, normalizeCrop({
        enabled: crop.enabled,
        aspect: crop.aspect,
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
}

// Width / height an aspect holds a width x height picture's crop or canvas
// to, or null while it is free.
function aspectRatio(aspect, width, height) {
    if (aspect === "free") return null;
    if (aspect === "source") return width / height;
    const [w, h] = aspect.split(":").map(Number);
    return w / h;
}

// Sides edited by `handle` ("" for none), held to the aspect.
function setPad(node, sides, handle = null) {
    const fb = node._fb;
    const size = fb.image ? croppedSize(node) : null;
    const ratio = handle !== null && size ? aspectRatio(fb.pad.aspect, size.width, size.height) : null;
    const next = { ...fb.pad, ...sides };
    if (ratio) Object.assign(next, lockPad(next, handle, size.width, size.height, ratio));
    Object.assign(fb.pad, next);
    syncPadData(node);
    fb.card.refresh();
}

// The picture as crop and pad see it: turned, at Pillow's expanded size.
// (Crop before the turn measures it on the picture itself.)
function turned(node) {
    const { image } = node._fb;
    return cropFirst(node) ? { width: image.width, height: image.height } : rotatedSize(image.width, image.height, turn(node));
}

const cropped = (node) => node._fb.crop.enabled && !isFullCrop(node._fb.crop);

// The output size before padding: cropped and turned, in the Order set.
function croppedSize(node) {
    const { crop } = node._fb;
    const world = turned(node);
    const size = cropped(node) ? cropPixels(crop, world.width, world.height) : world;
    return cropFirst(node) ? rotatedSize(size.width, size.height, turn(node)) : size;
}

// The part of the picture the stage shows: a crop made before the turn, once
// the Crop tool is put down; the whole picture otherwise.
function stageRegion(node) {
    const { crop, image } = node._fb;
    if (!cropFirst(node) || node._fb.tool === "crop" || !cropped(node)) return null;
    const px = cropPixels(crop, image.width, image.height);
    return { x: px.left, y: px.top, width: px.width, height: px.height };
}

// ---------------------------------------------------------------- turn / scale state

function parseRotate(value) {
    let data = null;
    try {
        data = typeof value === "string" && value ? JSON.parse(value) : null;
    } catch { /* upright */ }
    return {
        enabled: Boolean(data?.enabled),
        degrees: wrapDegrees(Number(data?.degrees) || 0),
        order: data?.order === "crop_first" ? "crop_first" : "turn_first",
    };
}

function syncRotateData(node) {
    const { enabled, degrees, order } = node._fb.rotate;
    findWidget(node, "rotate_data").value = JSON.stringify({ version: 1, enabled, degrees, order });
}

// Rotate's Order: turn then crop (the crop measured on the turned picture,
// the default), or crop then turn (the cropped part is turned). py/image_transform.py crop_first.
const cropFirst = (node) => node._fb.rotate.order === "crop_first";

const wrapDegrees = (degrees) => Math.round(((((degrees + 180) % 360) + 360) % 360 - 180) * 10) / 10;
const turn = (node) => (node._fb.rotate.enabled ? node._fb.rotate.degrees : 0);

function setRotate(node, degrees) {
    const fb = node._fb;
    fb.rotate.degrees = wrapDegrees(degrees);
    syncRotateData(node);
    fb.card.refresh();
    fb.stage.redraw();
}

function parseScale(value) {
    let data = null;
    try {
        data = typeof value === "string" && value ? JSON.parse(value) : null;
    } catch { /* unscaled */ }
    const positive = (entry) => (Number(entry) > 0 ? Number(entry) : 1);
    return {
        enabled: Boolean(data?.enabled),
        mode: data?.mode === "factor" ? "factor" : "megapixels",
        factor: positive(data?.factor),
        megapixels: positive(data?.megapixels),
        method: SCALE_METHODS.includes(data?.method) ? data.method : SCALE_METHODS[0],
    };
}

function syncScaleData(node) {
    const { enabled, mode, factor, megapixels, method } = node._fb.scale;
    findWidget(node, "scale_data").value = JSON.stringify({ version: 1, enabled, mode, factor, megapixels, method });
}

function editScale(node, change) {
    change(node._fb.scale);
    syncScaleData(node);
    node._fb.card.refresh();
}

// Load Image+'s original output shows while an edit other than the mask is
// on; one with a link stays, so a workflow never loses it.
function syncOriginalOutput(node) {
    const flips = getFlips(node);
    const edited = sizeEdited(node) || flips.x || flips.y;
    const slot = node.findOutputSlot("original");
    if (edited && slot < 0) node.addOutput("original", "IMAGE", { tooltip: node.constructor.nodeData?.output_tooltips?.[2] });
    else if (!edited && slot >= 0 && !node.outputs[slot].links?.length) node.removeOutput(slot);
}

// The step snaps the size only while an edit that changes it is on (py/image_transform.py transform).
const sizeEdited = (node) => ["crop", "pad", "rotate", "scale"].some((name) => node._fb[name].enabled);
const stepOf = (node) => (sizeEdited(node) ? Math.max(1, Math.trunc(Number(findWidget(node, "step")?.value) || 1)) : 1);

// ---------------------------------------------------------------- mask state

// The mask_data widget holds the vector strokes as JSON, which is what a
// workflow saves; a queued prompt gets the strokes rasterized at the
// picture's size instead (maskRaster), exactly as drawn, soft edges and all.
// A full-size PNG in the workflow made every autosaved draft megabytes large.
function parseStrokes(value) {
    try {
        const data = typeof value === "string" && value.startsWith("{") ? JSON.parse(value) : null;
        return {
            brushSize: Math.max(1, Number(data?.brushSize) || 64),
            erasing: Boolean(data?.erasing),
            soft: Boolean(data?.soft),
            strokes: Array.isArray(data?.strokes) ? data.strokes : [],
        };
    } catch {
        return { brushSize: 64, erasing: false, soft: false, strokes: [] };
    }
}

function restoreMask(node) {
    const props = node.properties;
    const widget = findWidget(node, "mask_data");
    const widgetValue = typeof widget?.value === "string" ? widget.value.trim() : "";
    // Workflows saved before held the strokes in properties._maskStrokes and a PNG in the widget.
    const strokes = widgetValue.startsWith("{") ? widgetValue : props._maskStrokes;
    const enabled = props._maskEnabled !== undefined
        ? ["1", "true", "yes", "on"].includes(String(props._maskEnabled).toLowerCase())
        : Boolean(widgetValue || strokes);
    return { enabled, ...parseStrokes(strokes), redo: [], hidden: false };
}

// The strokes at the picture's size, as the PNG data URL the backend reads.
function maskRaster(node) {
    const { mask, image } = node._fb;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    for (const stroke of mask.strokes) drawStroke(ctx, stroke, { x: 0, y: 0, w: image.width, h: image.height });
    return canvas.toDataURL("image/png");
}

function syncMaskData(node) {
    const mask = node._fb.mask;
    findWidget(node, "mask_data").value = mask.enabled
        ? JSON.stringify({ version: 1, enabled: true, brushSize: mask.brushSize, erasing: mask.erasing, soft: mask.soft, strokes: mask.strokes })
        : "";
    node.properties._maskEnabled = mask.enabled;
    delete node.properties._maskData;
    delete node.properties._maskStrokes;
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
    ({ mask: syncMaskData, crop: syncCropData, pad: syncPadData, rotate: syncRotateData, scale: syncScaleData })[name](node);
    syncOriginalOutput(node);
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
    const rotate = button("Rotate", { icon: ICONS.rotate, grow: true, title: "Turn the picture: drag on it, Shift snaps to 15°. The corners it opens are filled and masked like padding. Press again to turn it off.", onClick: () => pressTool(node, "rotate") });
    const scale = button("Scale", { icon: ICONS.scale, grow: true, title: "Scale the output by a factor or to a megapixel budget. Press again to turn it off.", onClick: () => pressTool(node, "scale") });
    const flip = (axis) => () => {
        setFlip(node, axis, !getFlips(node)[axis === "flip_x" ? "x" : "y"]);
        syncCropData(node);
        syncOriginalOutput(node);
        fb.card.refresh();
        fb.stage.redraw();
        notifyChange();
    };
    const flipX = button("", { icon: ICONS.flipX, title: "Flip horizontally", onClick: flip("flip_x") });
    const flipY = button("", { icon: ICONS.flipY, title: "Flip vertically", onClick: flip("flip_y") });
    tools.append(mask, crop, pad, rotate, scale, flipX, flipY);
    // "Edit" with a reset for everything beside it, while anything is edited.
    const label = el("span", "fbui-label");
    label.style.cssText = "display:flex;align-items:center;gap:6px";
    const resetEverything = button("", { icon: ICONS.reset, small: true, danger: true, title: "Reset all edits (asks first)", onClick: () => resetAll(node) });
    label.append("Edit", resetEverything);
    // A narrow node keeps the icons; the words come back when it widens.
    new ResizeObserver(() => {
        const compact = tools.clientWidth < EDIT_LABELS_MIN;
        for (const control of [mask, crop, pad, rotate, scale]) control.querySelector("span").hidden = compact;
    }).observe(tools);
    return {
        element: tools,
        label,
        sync() {
            resetEverything.hidden = !anyEdit(node);
            const flips = getFlips(node);
            for (const [control, name] of [[mask, "mask"], [crop, "crop"], [pad, "pad"], [rotate, "rotate"], [scale, "scale"]]) {
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
    const soft = button("", { icon: ICONS.feather, title: "Soft brush: strokes with a soft edge (or hold Shift for one)", onClick: () => editMask(node, (m) => { m.soft = !m.soft; }) });
    const erase = button("", { icon: ICONS.eraser, title: "Eraser (or hold Ctrl while painting)", onClick: () => editMask(node, (m) => { m.erasing = !m.erasing; }) });
    tools.append(size.root, soft, hide, undo, redo, erase);
    return {
        element: tools,
        sync() {
            size.set(fb.mask.brushSize);
            soft.classList.toggle("on", fb.mask.soft);
            erase.classList.toggle("on", fb.mask.erasing);
        },
    };
}

function stagePanel(node) {
    const fb = node._fb;
    const stage = createImageStage({
        image: () => fb.image,
        // While the crop is edited before the turn, the picture shows upright.
        turn: () => (cropFirst(node) && fb.tool === "crop" ? 0 : turn(node)),
        region: () => stageRegion(node),
        flips: () => getFlips(node),
        // A crop before the turn is already the region shown, once put down.
        crop: () => ({ shown: fb.crop.enabled && Boolean(fb.image) && !stageRegion(node), editable: fb.tool === "crop", rect: displayCrop(node) }),
        pad: () => ({ shown: fb.pad.enabled && Boolean(fb.image), editable: fb.tool === "pad", sides: fb.pad }),
        mask: () => ({
            shown: fb.mask.enabled && !fb.mask.hidden,
            editable: fb.tool === "mask",
            strokes: fb.mask.strokes,
            brushSize: fb.mask.brushSize,
            erasing: fb.mask.erasing,
            soft: fb.mask.soft,
        }),
        onCrop: (rect, handle) => {
            setDisplayCrop(node, rect, handle);
            fb.card.refresh();
        },
        onCropEnd: notifyChange,
        onPad: (sides, handle) => setPad(node, sides, handle),
        onPadEnd: notifyChange,
        rotate: () => ({ editable: fb.tool === "rotate" }),
        onRotate: (degrees) => setRotate(node, degrees),
        onRotateEnd: notifyChange,
        onStrokeStart: (stroke) => {
            fb.mask.redo = [];
            fb.mask.strokes.push(stroke);
        },
        onStrokeEnd: () => {
            syncMaskData(node);
            // The resets follow what is painted.
            fb.card.refresh();
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
    // Rotate's quarter turns on the picture itself; dragging turns it freely.
    const quarter = (delta) => () => {
        setRotate(node, fb.rotate.degrees + delta);
        notifyChange();
    };
    const turnLeft = button("", { icon: ICONS.rotateLeft, small: true, title: "Turn 90° counter-clockwise (drag the picture to turn freely, Shift snaps to 15°)", onClick: quarter(-90) });
    const turnRight = button("", { icon: ICONS.rotateRight, small: true, title: "Turn 90° clockwise (drag the picture to turn freely, Shift snaps to 15°)", onClick: quarter(90) });
    tools.append(turnLeft, turnRight, open);
    stage.element.append(tools);
    return {
        element: stage.element,
        sync() {
            open.hidden = !fb.image || fb.blank;
            turnLeft.hidden = turnRight.hidden = fb.tool !== "rotate" || !fb.image;
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
            const { width, height } = outputLayout(croppedSize(node), fb.pad, fb.scale, stepOf(node)).canvas;
            const source = `${image.width} × ${image.height}`;
            caption.textContent = width === image.width && height === image.height ? source : `${source} → ${width} × ${height}`;
        },
    };
}

// Frame picker for videos: play, a rail with a playhead (press or drag it)
// and a FRAME number box with the time. With the frame count known, frame n
// is stored as n / frames; otherwise the rail sets the 0..1 position itself.
// The value is written straight to the widget: the stock float widget's
// callback rounds to its 0.01 step, which would land long videos on the
// wrong frame.
function framePanel(node) {
    const fb = node._fb;
    const frames = () => (fb.video?.frames > 1 ? fb.video.frames : 0);
    const position = () => Number(findWidget(node, "frame_position")?.value) || 0;
    const setPosition = (value, settled) => {
        stop();
        findWidget(node, "frame_position").value = Math.max(0, Math.min(1, value));
        if (!settled) pumpFrame(node, position());
        fb.frameChanged();
        fb.card.refresh();
        node.setDirtyCanvas(true, true);
        if (settled) notifyChange();
    };
    const toFrame = (count, fraction) => Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1))));

    // Playback, as AusBoss's: each tick awaits a frame, so a pause usually lands
    // mid-fetch; the session counter lets that tick die instead of rescheduling.
    const playback = { session: 0, playing: false, timer: 0 };
    const stop = () => {
        if (!playback.playing) return;
        playback.playing = false;
        playback.session++;
        clearTimeout(playback.timer);
        fb.frameChanged();
        notifyChange();
        play.innerHTML = ICONS.play;
    };
    const start = () => {
        const count = frames();
        if (!count || playback.playing) return;
        let next = Math.min(count - 1, Math.round(position() * count));
        // From the start when parked on the last frame.
        if (next >= count - 1) next = 0;
        playback.playing = true;
        play.innerHTML = ICONS.pause;
        const session = ++playback.session;
        const interval = 1000 / (Number(fb.video.fps) || 30);
        const tick = async () => {
            if (playback.session !== session) return;
            const started = performance.now();
            findWidget(node, "frame_position").value = next / count;
            fb.card.refresh();
            await pumpFrame(node, next / count);
            if (playback.session !== session) return;
            if (next >= count - 1) return stop();
            next++;
            playback.timer = setTimeout(tick, Math.max(0, interval - (performance.now() - started)));
        };
        tick();
    };
    const play = button("", { icon: ICONS.play, title: "Play the video on the node; pause keeps the frame shown", onClick: () => (playback.playing ? stop() : start()) });
    fb.stopPlayback = stop;

    const panel = el("div");
    panel.style.cssText = "display:flex;flex-direction:column;gap:6px;height:100%;justify-content:center";
    const track = rail({
        title: "Press or drag to pick the frame the node outputs.",
        onSeek: (fraction, settled) => {
            const count = frames();
            setPosition(count ? toFrame(count, fraction) / count : fraction, settled);
        },
    });
    const transport = el("div", "fbui-field");
    transport.style.flex = "none";
    transport.style.height = `${ROW_HEIGHT}px`;
    transport.append(play, track.root);
    track.root.style.flex = "1";
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
    panel.append(transport, line);

    let mode = null;
    return {
        element: panel,
        sync() {
            const count = frames();
            play.disabled = !count;
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

// Picture pixels per CSS pixel on the stage, so a slide moves a region about
// as far on the picture as the pointer moves.
function picturePerCss(node) {
    const { stage } = node._fb;
    const world = turned(node);
    return world.width / Math.max(1, fitRect(world.width, world.height, stage.canvas.clientWidth || 1, stage.canvas.clientHeight || 1).width);
}

const SIDE_HANDLE = { left: "w", right: "e", top: "n", bottom: "s" };

// An Exact row's label slides its region along the row's axis; a button
// at the end centres it.
function slideAndCenter(axis, what, { start, slide, center, end }) {
    const label = slideLabel(axis === "x" ? "Left · Right" : "Top · Bottom", {
        axis,
        title: `Drag to slide ${what} ${axis === "x" ? "left and right" : "up and down"}.`,
        onStart: start,
        onSlide: slide,
        onEnd: end,
    });
    const centre = button("", { icon: axis === "x" ? ICONS.centerX : ICONS.centerY, title: `Centre ${what} ${axis === "x" ? "horizontally" : "vertically"}`, onClick: () => {
        center();
        end();
    } });
    return { label, centre };
}

// Exact crop, in pixels of the picture as shown (flips included).
function cropPairControl(node, first, second) {
    const fb = node._fb;
    const axis = first === "left" ? "x" : "y";
    const field = el("div", "fbui-field");
    const scrubs = {};
    const commit = (side, value) => {
        if (!fb.image) return;
        const world = turned(node);
        const rect = displayCrop(node);
        const across = side === "left" || side === "right" ? world.width : world.height;
        const pct = (Math.max(0, value) / across) * 100;
        if (side === "left") rect.left_pct = Math.min(pct, rect.right_pct - 100 / across);
        else if (side === "right") rect.right_pct = Math.max(100 - pct, rect.left_pct + 100 / across);
        else if (side === "top") rect.top_pct = Math.min(pct, rect.bottom_pct - 100 / across);
        else rect.bottom_pct = Math.max(100 - pct, rect.top_pct + 100 / across);
        setDisplayCrop(node, rect, SIDE_HANDLE[side]);
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
    let from = null;
    const { label, centre } = slideAndCenter(axis, "the crop", {
        start: () => { from = displayCrop(node); },
        slide: (delta) => {
            if (!fb.image || !from) return;
            const world = turned(node);
            const shift = (delta * picturePerCss(node) / (axis === "x" ? world.width : world.height)) * 100;
            setDisplayCrop(node, dragCrop("move", from, axis === "x" ? shift : 0, axis === "y" ? shift : 0));
            fb.card.refresh();
        },
        center: () => {
            const rect = displayCrop(node);
            const [lo, hi] = axis === "x" ? ["left_pct", "right_pct"] : ["top_pct", "bottom_pct"];
            const size = rect[hi] - rect[lo];
            setDisplayCrop(node, { ...rect, [lo]: (100 - size) / 2, [hi]: (100 + size) / 2 });
            fb.card.refresh();
        },
        end: notifyChange,
    });
    field.append(centre);
    return {
        element: field,
        label,
        sync() {
            if (!fb.image) return;
            const world = turned(node);
            const px = cropPixels(displayCrop(node), world.width, world.height);
            for (const side of [first, second]) scrubs[side].set(px[side]);
        },
    };
}

// ---------------------------------------------------------------- resets

const ZERO_PAD = { left: 0, right: 0, top: 0, bottom: 0 };

// Whether a tool holds anything to reset (its ratio included).
function toolEdited(node, name) {
    const fb = node._fb;
    if (name === "mask") return fb.mask.strokes.length > 0;
    if (name === "crop") return !isFullCrop(fb.crop) || fb.crop.aspect !== "free";
    if (name === "pad") return Boolean(fb.pad.left || fb.pad.right || fb.pad.top || fb.pad.bottom) || fb.pad.aspect !== "free";
    if (name === "rotate") return fb.rotate.degrees !== 0 || fb.rotate.order !== "turn_first";
    if (name === "scale") return fb.scale.mode !== "megapixels" || fb.scale.factor !== 1 || fb.scale.megapixels !== 1 || fb.scale.method !== SCALE_METHODS[0];
    return false;
}

// A tool back to its defaults; it stays on.
function resetTool(node, name) {
    const fb = node._fb;
    if (name === "mask") editMask(node, (mask) => { mask.strokes = []; mask.redo = []; });
    else if (name === "crop") {
        fb.crop.aspect = "free";
        setDisplayCrop(node, FULL_CROP);
    } else if (name === "pad") {
        fb.pad.aspect = "free";
        setPad(node, ZERO_PAD, "");
    } else if (name === "rotate") {
        fb.rotate.order = "turn_first";
        setRotate(node, 0);
    }
    else if (name === "scale") editScale(node, (scale) => Object.assign(scale, { mode: "megapixels", factor: 1, megapixels: 1, method: SCALE_METHODS[0] }));
    fb.card.refresh();
    fb.stage.redraw();
    notifyChange();
}

const RESET_TITLES = {
    mask: "Clear the mask",
    crop: "Reset the crop: the whole picture, ratio free",
    pad: "Reset the padding: none, ratio free",
    rotate: "Back to upright, the turn before the crop",
    scale: "Reset the scale",
};

// The Options header's reset, for whichever tool is active.
function toolReset(node) {
    const fb = node._fb;
    const reset = button("Reset", { small: true, onClick: () => fb.tool && resetTool(node, fb.tool) });
    return {
        element: reset,
        sync() {
            const tool = fb.tool;
            reset.hidden = !tool;
            reset.disabled = !tool || !toolEdited(node, tool);
            if (tool) reset.title = RESET_TITLES[tool];
        },
    };
}

// Every edit back to its default and every tool off, after a confirm.
async function resetAll(node) {
    const fb = node._fb;
    if (!(await confirm({ title: "Reset all edits", message: "Clear the mask and undo the crop, padding, turn, scale, flips and step? The tools turn off and Options closes.", confirmText: "Reset all", danger: true }))) return;
    for (const name of TOOLS) {
        resetTool(node, name);
        fb[name].enabled = false;
    }
    setFlip(node, "flip_x", false);
    setFlip(node, "flip_y", false);
    findWidget(node, "step").value = 1;
    fb.tool = null;
    // The Options fold closes too: the node is back as it first came.
    node.properties.fbui_open_options = false;
    syncMaskData(node);
    syncCropData(node);
    syncPadData(node);
    syncRotateData(node);
    syncScaleData(node);
    syncOriginalOutput(node);
    fb.card.refreshByHand();
    fb.stage.redraw();
    notifyChange();
}

const anyEdit = (node) => {
    const flips = getFlips(node);
    return TOOLS.some((name) => node._fb[name].enabled || toolEdited(node, name)) || flips.x || flips.y;
};

// An icon naming the field after it (ratio, feather), its title the field's.
function fieldIcon(icon, title) {
    const span = el("span");
    span.innerHTML = icon;
    span.title = title;
    span.style.cssText = `flex:none;display:flex;color:${T.label}`;
    return span;
}

function aspectSelect(title, onPick) {
    const select = el("select", "fbui-select");
    select.title = title;
    for (const value of ASPECTS) {
        const option = el("option", "", { free: "Free", source: "Source" }[value] ?? value);
        option.value = value;
        select.append(option);
    }
    select.addEventListener("change", () => {
        onPick(select.value);
        notifyChange();
    });
    return select;
}

// The Crop row: the crop's aspect and the Order toggle.
function cropControl(node) {
    const fb = node._fb;
    const field = el("div", "fbui-field");
    const title = "Ratio: the crop's aspect, free, the picture's own, or a ratio that holds while you drag.";
    const aspect = aspectSelect(title, (value) => {
        fb.crop.aspect = value;
        setDisplayCrop(node, displayCrop(node), "");
        fb.card.refresh();
    });
    const order = orderToggle(node);
    field.append(fieldIcon(ICONS.ratio, title), aspect, order.element);
    return {
        element: field,
        sync() {
            aspect.value = fb.crop.aspect;
            order.sync();
        },
    };
}

// The Pad row: the canvas's aspect and the feather.
function padControl(node) {
    const fb = node._fb;
    const tools = el("div", "fbui-field");
    const ratioTitle = "Ratio: the padded canvas's aspect, free, the picture's own, or a ratio that holds while you drag.";
    const aspect = aspectSelect(ratioTitle, (value) => {
        fb.pad.aspect = value;
        setPad(node, {}, "");
    });
    const featherTitle = "Feather: how far the mask fades into the picture, so the seam is painted over too.";
    const feather = makeScrub({
        value: fb.pad.feather, min: 0, max: 512, step: 4, fineStep: 1, decimals: 0, unit: "px",
        title: featherTitle,
        onChange: (value) => setPad(node, { feather: value }),
        onSettle: notifyChange,
    });
    feather.root.style.cssText = "flex:none;width:76px";
    tools.append(fieldIcon(ICONS.ratio, ratioTitle), aspect, fieldIcon(ICONS.feather, featherTitle), feather.root);
    return {
        element: tools,
        sync() {
            aspect.value = fb.pad.aspect;
            feather.set(fb.pad.feather);
        },
    };
}

// The Order toggle, on both the Crop and the Rotate row: lit, the crop comes
// first and the cropped part turns.
function orderToggle(node) {
    const fb = node._fb;
    const toggle = button("", { icon: ICONS.cropTurn, title: "Turn the crop: crop first, then turn what is left (its corners are filled). Off, the picture turns and the crop is drawn on it.", onClick: () => {
        fb.rotate.order = cropFirst(node) ? "turn_first" : "crop_first";
        syncRotateData(node);
        fb.card.refresh();
        fb.stage.redraw();
        notifyChange();
    } });
    return {
        element: toggle,
        sync() {
            toggle.classList.toggle("on", cropFirst(node));
        },
    };
}

// The Rotate row: degrees clockwise, quarter turns, and the Order toggle.
function rotateControl(node) {
    const fb = node._fb;
    const field = el("div", "fbui-field");
    const title = "Degrees, clockwise. Drag on the picture to turn it; Shift snaps to 15°.";
    const degrees = makeScrub({
        value: fb.rotate.degrees, min: -180, max: 180, step: 1, fineStep: 0.1, decimals: 1, unit: "°",
        title,
        onChange: (value) => setRotate(node, value),
        onSettle: notifyChange,
    });
    const quarter = (delta) => () => {
        setRotate(node, fb.rotate.degrees + delta);
        notifyChange();
    };
    const left = button("", { icon: ICONS.rotateLeft, title: "Turn 90° counter-clockwise", onClick: quarter(-90) });
    const right = button("", { icon: ICONS.rotateRight, title: "Turn 90° clockwise", onClick: quarter(90) });
    const order = orderToggle(node);
    field.append(fieldIcon(ICONS.rotate, title), degrees.root, left, right, order.element);
    return {
        element: field,
        sync() {
            degrees.set(fb.rotate.degrees);
            order.sync();
        },
    };
}

// The Scale row: by a factor or to a megapixel budget (counted on the whole canvas).
function scaleControl(node) {
    const fb = node._fb;
    const field = el("div", "fbui-field");
    const mode = segmented([
        { value: "megapixels", label: "Mpx", title: "Scale to a megapixel budget, the whole canvas counted (as core Scale Image To Total Pixels)" },
        { value: "factor", label: "×", title: "Scale by a factor" },
    ], { onPick: (value) => { editScale(node, (scale) => { scale.mode = value; }); notifyChange(); } });
    mode.root.style.cssText = "flex:none;width:84px";
    const amount = makeScrub({
        value: 1, min: 0.05, max: 16, step: 0.05, fineStep: 0.01, decimals: 2, unit: "Mpx",
        title: "How much: a factor, or megapixels",
        onChange: (value) => editScale(node, (scale) => { scale[scale.mode] = value; }),
        onSettle: notifyChange,
    });
    field.append(mode.root, amount.root);
    const unit = amount.root.querySelector(".fbui-scrub-unit");
    let shown = null;
    return {
        element: field,
        sync() {
            const scale = fb.scale;
            mode.set(scale.mode);
            if (shown !== scale.mode) {
                shown = scale.mode;
                amount.setRange({ min: 0.05, max: scale.mode === "megapixels" ? 16 : 8 });
                unit.textContent = scale.mode === "megapixels" ? "Mpx" : "×";
            }
            amount.set(scale[scale.mode]);
        },
    };
}

function methodControl(node) {
    const fb = node._fb;
    const select = el("select", "fbui-select");
    select.title = "How the picture is resampled; area is best for shrinking.";
    for (const method of SCALE_METHODS) {
        const option = el("option", "", method);
        option.value = method;
        select.append(option);
    }
    select.addEventListener("change", () => {
        editScale(node, (scale) => { scale.method = select.value; });
        notifyChange();
    });
    return {
        element: select,
        sync() {
            select.value = fb.scale.method;
        },
    };
}

// The Step row: the output snaps to a multiple; padding takes the leftover,
// or an unpadded side is trimmed evenly.
function stepControl(node, card) {
    const choices = segmented(STEPS.map((value) => ({
        value,
        label: value === 1 ? "off" : String(value),
        title: value === 1 ? "No step: the size as it comes" : `Snap the output to a multiple of ${value} px: padding takes the leftover, an unpadded side is trimmed evenly`,
    })), { onPick: (value) => card.setWidget("step", value) });
    return {
        element: choices.root,
        sync() {
            choices.set(stepOf(node));
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
            onChange: (value) => setPad(node, { [side]: value }, SIDE_HANDLE[side]),
            onSettle: notifyChange,
        });
        field.append(scrubs[side].root);
    }
    const axis = first === "left" ? "x" : "y";
    let from = null;
    const { label, centre } = slideAndCenter(axis, "the canvas", {
        start: () => { from = { ...fb.pad }; },
        slide: (delta) => {
            if (!fb.image || !from) return;
            const shift = delta * picturePerCss(node);
            setPad(node, dragPad("move", from, axis === "x" ? shift : 0, axis === "y" ? shift : 0));
        },
        center: () => {
            const total = fb.pad[first] + fb.pad[second];
            setPad(node, { [first]: Math.floor(total / 2), [second]: total - Math.floor(total / 2) });
        },
        end: notifyChange,
    });
    field.append(centre);
    return {
        element: field,
        label,
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
        rotate: parseRotate(findWidget(node, "rotate_data")?.value),
        scale: parseScale(findWidget(node, "scale_data")?.value),
        tool: null,
        reload: (value) => showFile(node, value),
    };
    node._fb = fb;
    fb.tool = TOOLS.find((tool) => fb[tool].enabled) ?? null;
    for (const name of ["source_folder", "frame_position", "mask_data", "crop_data", "flip_x", "flip_y", "pad_data", "rotate_data", "scale_data", "step"]) hideWidget(findWidget(node, name));
    // The prompt gets the painted mask as drawn; the workflow keeps the strokes.
    const maskWidget = findWidget(node, "mask_data");
    maskWidget.serializeValue = () => (fb.mask.enabled && fb.mask.strokes.length && fb.image ? maskRaster(node) : maskWidget.value);

    const imageWidget = findWidget(node, "image");
    chainCallback(imageWidget, "callback", (value) => {
        // The MaskEditor writes "name.png [input]".
        const clean = stripAnnotation(value);
        if (clean !== value) imageWidget.value = clean;
        fb.stopPlayback?.();
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
    const scaleTool = (_values, n) => n._fb.tool === "scale";
    // The step snaps what crop, pad and scale make; it shows with them.
    const sizeTool = (_values, n) => sizeEdited(n);
    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            {
                widget: "image", label: "Source", kind: "select", labels: sourceLabel,
                button: files.sourceButtons,
            },
            { label: "Edit", control: editControl },
            // The active tool's settings, folded away until opened; open, the fold
            // stays open as the tool changes and shows that tool's settings.
            { group: "options", label: "Options", tools: toolReset, when: (_values, n) => Boolean(n._fb.tool) },
            { label: "Brush", control: brushControl, group: "options", when: (_values, n) => n._fb.tool === "mask" },
            { label: "Crop", control: cropControl, group: "options", when: cropTool },
            { label: "Left · Right", control: (n) => cropPairControl(n, "left", "right"), group: "options", when: cropTool },
            { label: "Top · Bottom", control: (n) => cropPairControl(n, "top", "bottom"), group: "options", when: cropTool },
            { label: "Pad", control: padControl, group: "options", when: padTool },
            { label: "Left · Right", control: (n) => padPairControl(n, "left", "right"), group: "options", when: padTool },
            { label: "Top · Bottom", control: (n) => padPairControl(n, "top", "bottom"), group: "options", when: padTool },
            { label: "Rotate", control: rotateControl, group: "options", when: (_values, n) => n._fb.tool === "rotate" },
            { label: "Scale", control: scaleControl, group: "options", when: scaleTool },
            { label: "Method", control: methodControl, group: "options", when: scaleTool },
            { label: "Step", control: stepControl, widgets: ["step"], group: "options", when: sizeTool },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: framePanel, height: FRAME_PANEL_HEIGHT, when: (values) => isVideoFile(values.image) },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    files.track(node);
    syncOriginalOutput(node);

    chainCallback(node, "onConfigure", () => {
        fb.configured = true;
        fb.mask = restoreMask(node);
        const props = node.properties;
        if (!props._cropData && findWidget(node, "crop_data")?.value) props._cropData = findWidget(node, "crop_data").value;
        fb.crop = parseCrop(props._cropData);
        fb.pad = parsePad(findWidget(node, "pad_data")?.value);
        fb.rotate = parseRotate(findWidget(node, "rotate_data")?.value);
        fb.scale = parseScale(findWidget(node, "scale_data")?.value);
        // Saved on dev-ui-refresh while the third output was canvas (now part of image).
        if (node.findOutputSlot("canvas") >= 0) node.removeOutput(node.findOutputSlot("canvas"));
        for (const axis of ["flip_x", "flip_y"]) if (props[axis] !== undefined) setFlip(node, axis, Boolean(props[axis]));
        fb.tool = TOOLS.find((tool) => fb[tool].enabled) ?? null;
        syncCropData(node);
        syncOriginalOutput(node);
        files.refreshOptions(node, imageValue(node));
        showFile(node, imageValue(node)).then(() => { if (fb.mask.enabled) syncMaskData(node); });
    });
    chainCallback(node, "onRemoved", () => {
        fb.stopPlayback?.();
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
        hideInputsInDef(nodeData, ["source_folder", "image", "frame_position", "mask_data", "crop_data", "flip_x", "flip_y", "pad_data", "rotate_data", "scale_data", "step"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
