/**
 * Save Image+ (FBnodes): saves PNG / EXR / AVIF with date tokens in the
 * prefix, optionally after you pick which images to keep (save_image_review.js),
 * and shows what was saved: one image, a grid for a batch, and an A/B
 * comparison against the Compare input under the pointer.
 *
 * The face is one fbui card; the stock widgets stay hidden and hold every
 * saved value. The last results are kept on the node, so a reloaded
 * workflow shows them again.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mountCard } from "./fbui/card.mjs";
import { toast } from "./fbui/comfy.mjs";
import { button, ICONS, segmented } from "./fbui/controls.mjs";
import { chainCallback, el } from "./fbui/dom.mjs";
import { openMenu, openModal } from "./fbui/modal.mjs";
import { findWidget, hideInputsInDef, suppressCorePreview } from "./fbui/widgets.mjs";
import { CAPTION_HEIGHT, RADIUS, T } from "./fbui/theme.mjs";
import { bestGrid } from "./common/grid_math.mjs";
import { fitRect } from "./common/stage_math.mjs";

const NODE_NAME = "SaveImagePlus";
const MIN_WIDTH = 300;
const STAGE_MIN_HEIGHT = 200;
// More images than this get ‹ n / N › instead of one button each.
const MANY = 8;
const GRID_GAP = 6;

// What each format can store; the Depth and Color pills follow the format.
const FORMAT_OPTIONS = {
    png: { bit_depth: ["8-bit", "16-bit"], input_color_space: ["sRGB"] },
    exr: { bit_depth: ["16-bit float", "32-bit float"], input_color_space: ["sRGB", "HDR", "linear"] },
    avif: { bit_depth: ["auto", "8-bit YUV420", "10-bit YUV420"], input_color_space: ["sRGB", "HDR", "HDR PQ"] },
};

const CSS_ID = "fbnodes-save-image-css-v1";
function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-save .single,.fbnodes-save .grid{position:absolute;inset:0}
.fbnodes-save .single img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}
.fbnodes-save .divider{position:absolute;top:0;width:2px;margin-left:-1px;background:${T.ink};box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none}
.fbnodes-save .divider::after{content:"";position:absolute;left:50%;top:50%;width:10px;height:10px;border-radius:50%;transform:translate(-50%,-50%);background:${T.ink};box-shadow:0 0 0 1px rgba(0,0,0,.5)}
.fbnodes-save .tag{position:absolute;top:8px;padding:2px 7px;border-radius:999px;background:rgba(10,12,15,.75);color:${T.ink};font:600 10px system-ui;pointer-events:none}
.fbnodes-save .grid{display:grid;gap:${GRID_GAP}px;justify-content:center;align-content:center}
.fbnodes-save .grid img{width:100%;height:100%;object-fit:contain;border-radius:${RADIUS - 2}px;background:${T.card};outline:1px solid ${T.plateEdge};cursor:pointer;display:block}
.fbnodes-save .grid img:hover{outline:2px solid ${T.brand}}
.fbnodes-save-picker{display:flex;align-items:center;gap:6px;min-width:0;width:100%}
.fbnodes-save-picker .fbui-seg{flex:1;min-width:0}
.fbnodes-save-picker .where{flex:1;text-align:center;color:${T.label};font:600 11px system-ui;font-variant-numeric:tabular-nums}
`;
    document.head.append(style);
}

function imageUrl(info) {
    const shown = info?.preview ?? info;
    if (!shown?.filename) return "";
    const params = new URLSearchParams({ filename: shown.filename, type: shown.type || "output", subfolder: shown.subfolder || "" });
    return api.apiURL(`/view?${params}`);
}

function flatImages(raw) {
    const out = [];
    const stack = Array.isArray(raw) ? [...raw] : raw ? [raw] : [];
    while (stack.length) {
        const item = stack.shift();
        if (Array.isArray(item)) stack.unshift(...item);
        else if (item && typeof item.filename === "string") out.push(item);
    }
    return out;
}

const clampIndex = (index, length) => (length ? Math.max(0, Math.min(length - 1, Number(index) || 0)) : 0);

// ---------------------------------------------------------------- results

function persist(node) {
    const fb = node._fb;
    const props = node.properties;
    props._saveCompareSavedItems = JSON.stringify(fb.saved);
    props._saveCompareCompareItems = JSON.stringify(fb.compare);
    props._saveComparePaired = fb.paired;
    props._saveCompareUnpaired = fb.unpaired;
    props._saveCompareGrid = fb.grid;
    props._saveCompareSavedIndex = fb.at;
    props._saveCompareCompareIndex = fb.atCompare;
}

function restore(node) {
    const fb = node._fb;
    const props = node.properties;
    const parse = (raw) => {
        try {
            const value = JSON.parse(raw || "[]");
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    };
    fb.saved = parse(props._saveCompareSavedItems);
    fb.compare = parse(props._saveCompareCompareItems);
    fb.paired = Boolean(props._saveComparePaired);
    fb.unpaired = Boolean(props._saveCompareUnpaired);
    fb.grid = Boolean(props._saveCompareGrid) && fb.saved.length > 1;
    fb.at = clampIndex(props._saveCompareSavedIndex, fb.saved.length);
    fb.atCompare = clampIndex(props._saveCompareCompareIndex, fb.compare.length);
}

function setResults(node, payload) {
    const fb = node._fb;
    fb.saved = flatImages(payload?.saved_images ?? payload?.images);
    fb.compare = flatImages(payload?.compare_images);
    fb.paired = fb.compare.length > 0 && fb.compare.length === fb.saved.length;
    fb.at = clampIndex(fb.at, fb.saved.length);
    fb.atCompare = fb.paired ? fb.at : clampIndex(fb.atCompare, fb.compare.length);
    // A new batch opens on the grid.
    fb.grid = fb.saved.length > 1;
    persist(node);
    fb.card.refresh();
}

// The compare image shown against the current saved one.
function compareItem(node) {
    const fb = node._fb;
    if (!fb.compare.length) return null;
    return fb.compare[fb.paired && !fb.unpaired ? clampIndex(fb.at, fb.compare.length) : fb.atCompare] ?? null;
}

function select(node, which, index) {
    const fb = node._fb;
    if (which === "saved") {
        // The image already shown, clicked again, goes back to the grid.
        if (index === fb.at && !fb.grid && fb.saved.length > 1) fb.grid = true;
        else {
            fb.at = clampIndex(index, fb.saved.length);
            fb.grid = false;
        }
    } else {
        fb.atCompare = clampIndex(index, fb.compare.length);
        fb.grid = false;
    }
    persist(node);
    fb.card.refresh();
}

function step(node, direction) {
    const fb = node._fb;
    if (fb.grid || fb.saved.length < 2) return false;
    fb.at = (fb.at + direction + fb.saved.length) % fb.saved.length;
    persist(node);
    fb.card.refresh();
    return true;
}

// ---------------------------------------------------------------- settings

// Keep Depth and Color to what the format can store.
function applyFormat(node) {
    const options = FORMAT_OPTIONS[findWidget(node, "format")?.value] ?? FORMAT_OPTIONS.png;
    for (const name of ["bit_depth", "input_color_space"]) {
        const widget = findWidget(node, name);
        if (!widget) continue;
        widget.options.values = [...options[name]];
        if (!options[name].includes(widget.value)) widget.value = options[name][0];
    }
}

// ---------------------------------------------------------------- panels

// Pick the image shown: a button per image (or ‹ n / N › for many), and
// for the saved row, Grid and Pair toggles.
function pickerControl(which) {
    return (node) => {
        const fb = node._fb;
        const field = el("div", "fbnodes-save-picker");
        const holder = el("div", "fbnodes-save-picker");
        holder.style.flex = "1";
        const grid = button("", { icon: ICONS.grid, title: "All images (Esc)", onClick: () => { fb.grid = !fb.grid; persist(node); fb.card.refresh(); } });
        const pair = button("Pair", { title: "Compare each image with its own Compare image", onClick: () => {
            fb.unpaired = !fb.unpaired;
            if (!fb.unpaired) fb.atCompare = clampIndex(fb.at, fb.compare.length);
            persist(node);
            fb.card.refresh();
        } });
        field.append(holder);
        if (which === "saved") field.append(pair, grid);
        let built = "";
        let seg = null;
        let where = null;
        const count = () => (which === "saved" ? fb.saved.length : fb.compare.length);
        const index = () => (which === "saved" ? fb.at : fb.atCompare);
        return {
            element: field,
            sync() {
                const n = count();
                const key = `${n}`;
                if (key !== built) {
                    built = key;
                    holder.replaceChildren();
                    seg = null;
                    where = null;
                    if (n <= MANY) {
                        seg = segmented(Array.from({ length: n }, (_, i) => ({ value: i, label: String(i + 1) })), { onPick: (i) => select(node, which, i) });
                        holder.append(seg.root);
                    } else {
                        where = el("span", "where");
                        holder.append(
                            button("", { icon: ICONS.chevronLeft, onClick: () => select(node, which, (index() - 1 + n) % n) }),
                            where,
                            button("", { icon: ICONS.chevronRight, onClick: () => select(node, which, (index() + 1) % n) }),
                        );
                    }
                }
                const showing = which === "saved" && fb.grid ? -1 : index();
                seg?.set(showing);
                if (where) where.textContent = `${index() + 1} / ${n}`;
                grid.hidden = which !== "saved";
                grid.classList.toggle("on", fb.grid);
                pair.hidden = which !== "saved" || !fb.paired;
                pair.classList.toggle("on", fb.paired && !fb.unpaired);
            },
        };
    };
}

function showLarge(info) {
    const img = el("img");
    img.src = imageUrl(info);
    img.style.cssText = "display:block;max-width:86vw;max-height:78vh;margin:auto;border-radius:6px";
    openModal({ title: info.filename, body: img });
}

async function copyImage(info) {
    try {
        const response = await fetch(imageUrl(info));
        const blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    } catch (error) {
        toast(`Could not copy the image: ${error.message}`, { severity: "error" });
    }
}

// The view: the shown image (with the compare image revealed left of the
// pointer), or the batch as a grid; the size footnote reads fb.shownSize.
function stagePanel(node) {
    ensureCss();
    const fb = node._fb;
    const stage = el("div", "fbui-stage fbnodes-save");
    const single = el("div", "single");
    const main = el("img");
    const other = el("img");
    const divider = el("div", "divider");
    const tagA = el("span", "tag", "A");
    const tagB = el("span", "tag", "B");
    tagA.style.left = "8px";
    tagB.style.right = "8px";
    single.append(main, other, divider, tagA, tagB);
    const grid = el("div", "grid");
    const empty = el("div", "fbui-stage-empty", "Run the workflow to see the saved images");
    const tools = el("div", "fbui-stage-tools");
    const large = button("", { icon: ICONS.open, small: true, title: "Open a large preview", onClick: () => fb.saved[fb.at] && showLarge(fb.saved[fb.at]) });
    tools.append(large);
    stage.append(single, grid, empty, tools);

    let hoverX = null;
    let gridKey = "";
    const naturalSize = (img) => (img.naturalWidth ? [img.naturalWidth, img.naturalHeight] : null);

    function layoutGrid() {
        const first = grid.firstChild;
        if (!first?.naturalWidth) return;
        const fit = bestGrid(fb.saved.length, first.naturalWidth, first.naturalHeight, stage.clientWidth - 12, stage.clientHeight - 12, GRID_GAP);
        grid.style.gridTemplateColumns = `repeat(${fit.columns}, ${Math.floor(fit.width)}px)`;
        grid.style.gridTemplateRows = `repeat(${fit.rows}, ${Math.floor(fit.height)}px)`;
    }

    function drawCompare() {
        const item = compareItem(node);
        const size = naturalSize(main);
        const show = Boolean(item && size && hoverX !== null && !fb.grid);
        other.hidden = divider.hidden = tagA.hidden = tagB.hidden = !show;
        if (!show) return;
        const rect = fitRect(size[0], size[1], stage.clientWidth, stage.clientHeight, 0);
        const x = Math.max(rect.x, Math.min(rect.x + rect.width, hoverX));
        other.style.clipPath = `inset(0 ${stage.clientWidth - x}px 0 0)`;
        divider.style.left = `${x}px`;
        divider.style.top = `${rect.y}px`;
        divider.style.height = `${rect.height}px`;
    }

    function sync() {
        const has = fb.saved.length > 0;
        empty.hidden = has;
        large.hidden = !has || fb.grid;
        single.hidden = !has || fb.grid;
        grid.hidden = !has || !fb.grid;
        if (!has) {
            fb.shownSize = null;
            return;
        }
        if (fb.grid) {
            const key = fb.saved.map((info) => info.filename).join("\n");
            if (key !== gridKey) {
                gridKey = key;
                grid.replaceChildren(...fb.saved.map((info, index) => {
                    const thumb = el("img");
                    thumb.src = imageUrl(info);
                    thumb.draggable = false;
                    thumb.title = info.filename;
                    thumb.addEventListener("load", () => { layoutGrid(); fb.card.refresh(); });
                    thumb.addEventListener("click", () => select(node, "saved", index));
                    return thumb;
                }));
            }
            layoutGrid();
            fb.shownSize = naturalSize(grid.firstChild);
        } else {
            const url = imageUrl(fb.saved[fb.at]);
            if (main.dataset.url !== url) {
                main.dataset.url = url;
                main.src = url;
            }
            const item = compareItem(node);
            const otherUrl = item ? imageUrl(item) : "";
            if (other.dataset.url !== otherUrl) {
                other.dataset.url = otherUrl;
                if (otherUrl) other.src = otherUrl;
            }
            fb.shownSize = naturalSize(main);
            drawCompare();
        }
    }

    main.addEventListener("load", () => fb.card.refresh());
    stage.addEventListener("pointermove", (event) => {
        const box = stage.getBoundingClientRect();
        hoverX = ((event.clientX - box.left) / Math.max(1, box.width)) * stage.clientWidth;
        drawCompare();
    });
    stage.addEventListener("pointerleave", () => {
        hoverX = null;
        drawCompare();
    });
    stage.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const info = fb.grid ? fb.saved[[...grid.children].indexOf(event.target)] : fb.saved[fb.at];
        if (!info) return;
        const against = fb.grid ? null : compareItem(node);
        openMenu(event.clientX, event.clientY, [
            { label: "Open image", action: () => window.open(imageUrl(info), "_blank") },
            { label: "Copy image", action: () => copyImage(info) },
            { label: "Open large preview", action: () => showLarge(info) },
            ...(against ? [{ label: "Open compare image", action: () => window.open(imageUrl(against), "_blank") }] : []),
        ]);
    });
    new ResizeObserver(() => {
        if (fb.grid) layoutGrid();
        else drawCompare();
    }).observe(stage);

    return { element: stage, sync };
}

function captionPanel(node) {
    const fb = node._fb;
    const caption = el("div", "fbui-caption");
    return {
        element: caption,
        sync() {
            const size = fb.shownSize;
            const count = fb.saved.length;
            if (!size) {
                caption.textContent = "—";
                return;
            }
            caption.textContent = `${size[0]} × ${size[1]}${fb.grid && count > 1 ? ` · ${count} images` : ""}`;
        },
    };
}

// ---------------------------------------------------------------- node

// ← / → step through a batch and Esc shows them all, while hovering the node.
let hovered = null;
function installKeys() {
    window.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? "") || event.target?.isContentEditable) return;
        const node = hovered?.graph && !hovered.flags?.collapsed ? hovered : null;
        if (!node) return;
        const fb = node._fb;
        let handled = false;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") handled = step(node, event.key === "ArrowRight" ? 1 : -1);
        else if (event.key === "Escape" && !fb.grid && fb.saved.length > 1) {
            fb.grid = true;
            persist(node);
            fb.card.refresh();
            handled = true;
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
}

// Results that arrive while the node's workflow is not open are kept here
// and shown when it is.
const lastResults = new Map();

function setupNode(node) {
    node.properties ??= {};
    suppressCorePreview(node);
    const fb = { saved: [], compare: [], paired: false, unpaired: false, grid: false, at: 0, atCompare: 0, shownSize: null };
    node._fb = fb;
    restore(node);
    applyFormat(node);
    chainCallback(findWidget(node, "format"), "callback", () => {
        applyFormat(node);
        fb.card.refresh();
    });

    const saving = (values) => values.save !== false;
    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            { widget: "filename_prefix", label: "Prefix", kind: "text" },
            { widget: "save", label: "Save", offText: "preview only", onText: "save" },
            { widget: "format", label: "Format", kind: "segment", labels: { png: "PNG", exr: "EXR", avif: "AVIF" }, when: saving },
            { widget: "review", label: "Review", when: saving },
            { pair: ["review_timeout", "on_timeout"], label: "Timeout", suffix: "s", when: (values) => saving(values) && values.review },
            { group: "more", label: "More", when: saving },
            { widget: "bit_depth", label: "Depth", kind: "segment", group: "more", when: saving },
            { widget: "input_color_space", label: "Color", kind: "segment", group: "more", when: saving },
            { widget: "crf", label: "CRF", group: "more", when: (values) => saving(values) && values.format === "avif" },
            { label: "Image", control: pickerControl("saved"), when: (_values, n) => n._fb.saved.length > 1 },
            { label: "Compare", control: pickerControl("compare"), when: (_values, n) => n._fb.compare.length > 1 && (!n._fb.paired || n._fb.unpaired) },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    const card = fb.card.root;
    card.addEventListener("pointerenter", () => { hovered = node; });
    card.addEventListener("pointerleave", () => { if (hovered === node) hovered = null; });
    chainCallback(node, "onRemoved", () => { if (hovered === node) hovered = null; });

    chainCallback(node, "onExecuted", (message) => setResults(node, message));
    chainCallback(node, "onConfigure", () => {
        restore(node);
        applyFormat(node);
        const kept = lastResults.get(String(node.id));
        if (kept) setResults(node, kept);
        else fb.card.refresh();
    });
}

app.registerExtension({
    name: "FBnodes.SaveImagePlus",
    setup() {
        installKeys();
        api.addEventListener("executed", (event) => {
            const { node, output } = event.detail ?? {};
            if (node != null && (output?.saved_images?.length || output?.compare_images?.length)) lastResults.set(String(node), output);
        });
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, [
            "filename_prefix", "save", "format", "bit_depth", "input_color_space", "crf", "review", "review_timeout", "on_timeout",
        ]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
