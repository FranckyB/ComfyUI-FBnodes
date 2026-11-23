/**
 * Visual LoRA Picker+ (FBnodes): pick a LoRA by its picture.
 *
 * The face is one fbui card: the LoRAs of the folder last browsed, a
 * strength, and the picture saved beside the LoRA (same base name). The stock
 * widgets (image: the LoRA's absolute path, strength_model) stay hidden and
 * hold the saved values. ← / → step through the folder while the pointer is
 * over the node.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createFileBrowserModal } from "./file_browser.js";
import { basenameOf, mediaFileUrl, stripAnnotation } from "./path_browser.js";
import { mountCard } from "./fbui/card.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { findWidget, hideInputsInDef } from "./fbui/widgets.js";
import { CAPTION_HEIGHT } from "./fbui/theme.js";
import { sourceLabel } from "./common/load_plus.js";

const NODE_NAME = "VisualLoraPicker";
const NONE = "(none)";
const MIN_WIDTH = 260;
const STAGE_MIN_HEIGHT = 220;
const PICTURE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

const dirOf = (path) => String(path || "").replace(/\\/g, "/").replace(/\/+$/, "").replace(/\/[^/]*$/, "");
const current = (node) => stripAnnotation(findWidget(node, "image")?.value) || "";

async function lorasRoot() {
    try {
        const response = await api.fetchApi("/fbnodes/lora-browser/root");
        const data = response.ok ? await response.json() : null;
        return data?.ok ? data.root : "";
    } catch {
        return "";
    }
}

// The LoRAs of a folder, or null when the folder cannot be read.
async function listLoras(folder) {
    if (!folder) return null;
    try {
        const response = await api.fetchApi(`/fbnodes/path-browser/list?${new URLSearchParams({ path: folder, kind: "lora" })}`);
        const data = response.ok ? await response.json() : null;
        if (!data?.ok) return null;
        return (data.files || []).map((file) => (typeof file === "string" ? file : file?.path)).filter(Boolean);
    } catch {
        return null;
    }
}

// The folder to list: the one asked for if it is still there, else the loras root.
async function openFolder(node, folder) {
    let loras = await listLoras(folder);
    if (!loras) {
        folder = await lorasRoot();
        loras = (await listLoras(folder)) ?? [];
    }
    node.properties._vlpImageDir = folder;
    node._fb.loras = loras;
    node._fb.card.refresh();
}

// The picture beside a LoRA: the first of name.png / .jpg / .jpeg / .webp found.
function findPicture(path) {
    const base = path.replace(/\.[^./\\]+$/, "");
    return new Promise((resolve) => {
        const tryNext = (index) => {
            if (index >= PICTURE_EXTENSIONS.length) return resolve(null);
            const probe = new Image();
            probe.onload = () => resolve(probe);
            probe.onerror = () => tryNext(index + 1);
            probe.src = mediaFileUrl(`${base}.${PICTURE_EXTENSIONS[index]}`);
        };
        tryNext(0);
    });
}

async function showLora(node, path) {
    const fb = node._fb;
    const request = ++fb.request;
    fb.picture = null;
    fb.card.refresh();
    if (!path || path === NONE) return;
    const picture = await findPicture(path);
    if (request !== fb.request) return;
    fb.picture = picture;
    fb.card.refresh();
}

function pick(node, path) {
    node._fb.card.setWidget("image", path);
}

async function openBrowser(node) {
    const value = current(node);
    const initialPath = node.properties._vlpImageDir || (value ? dirOf(value) : "") || (await lorasRoot());
    createFileBrowserModal(value, (selected, meta) => {
        pick(node, meta.absPath);
        openFolder(node, meta.dir);
    }, "input", {
        initialPath,
        selectedAbsPath: value,
        navKind: "lora",
        allowedTypes: ["other"],
        filterTypeOptions: ["all", "other"],
        defaultFilter: "other",
    });
}

function step(node, direction) {
    const loras = node._fb.loras;
    if (loras.length < 2) return false;
    const index = loras.indexOf(current(node));
    const next = index < 0 ? (direction > 0 ? 0 : loras.length - 1) : (index + direction + loras.length) % loras.length;
    pick(node, loras[next]);
    return true;
}

// The LoRA list: the folder's LoRAs by name, the picked one kept even when
// it lives elsewhere.
function loraControl(node) {
    const fb = node._fb;
    const field = el("div", "fbui-field");
    const select = el("select", "fbui-select");
    select.addEventListener("change", () => pick(node, select.value));
    field.append(select, button("", { icon: ICONS.folder, title: "Browse for a LoRA", onClick: () => openBrowser(node) }));
    let shown = "";
    return {
        element: field,
        sync() {
            const value = current(node);
            const values = [NONE, ...fb.loras];
            if (value && !values.includes(value)) values.push(value);
            const key = values.join("\n");
            if (key !== shown) {
                shown = key;
                select.replaceChildren(...values.map((item) => {
                    const option = el("option", "", sourceLabel(item, values));
                    option.value = item;
                    return option;
                }));
            }
            select.value = value || NONE;
            select.title = value || "No LoRA selected";
        },
    };
}

function picturePanel(node) {
    const fb = node._fb;
    const stage = el("div", "fbui-stage");
    const empty = el("div", "fbui-stage-empty");
    const img = el("img");
    img.draggable = false;
    stage.append(img, empty);
    stage.style.cursor = "pointer";
    stage.title = "Click to browse for a LoRA";
    stage.addEventListener("click", () => openBrowser(node));
    return {
        element: stage,
        sync() {
            const has = Boolean(fb.picture);
            img.hidden = !has;
            if (has && img.src !== fb.picture.src) img.src = fb.picture.src;
            const value = current(node);
            empty.textContent = has ? "" : value && value !== NONE ? "No picture beside this LoRA" : "Click to pick a LoRA";
        },
    };
}

// The footnote: which LoRA, and the size of its picture.
function captionPanel(node) {
    const fb = node._fb;
    const caption = el("div", "fbui-caption");
    return {
        element: caption,
        sync() {
            const value = current(node);
            if (!value || value === NONE) {
                caption.textContent = "—";
                return;
            }
            caption.textContent = fb.picture ? `${basenameOf(value)} · ${fb.picture.naturalWidth} × ${fb.picture.naturalHeight}` : basenameOf(value);
            caption.title = value;
        },
    };
}

// ← / → step through the folder while the pointer is over a picker.
let hovered = null;
function installArrowKeys() {
    window.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? "") || event.target?.isContentEditable) return;
        if (!hovered?.graph || hovered.flags?.collapsed) return;
        if (!step(hovered, event.key === "ArrowRight" ? 1 : -1)) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}

function setupNode(node) {
    node.properties ??= {};
    const fb = { request: 0, loras: [], picture: null, configured: false };
    node._fb = fb;

    const imageWidget = findWidget(node, "image");
    chainCallback(imageWidget, "callback", (value) => {
        const clean = stripAnnotation(value);
        if (clean !== value) imageWidget.value = clean;
        showLora(node, clean);
    });

    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            { label: "LoRA", control: loraControl, widgets: ["image"] },
            { widget: "strength_model", label: "Strength" },
            { panel: picturePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    const card = fb.card.root;
    card.addEventListener("pointerenter", () => { hovered = node; });
    card.addEventListener("pointerleave", () => { if (hovered === node) hovered = null; });
    chainCallback(node, "onMouseEnter", () => { hovered = node; });
    chainCallback(node, "onMouseLeave", () => { if (hovered === node) hovered = null; });
    chainCallback(node, "onRemoved", () => { if (hovered === node) hovered = null; });

    const restore = () => {
        const value = current(node);
        openFolder(node, node.properties._vlpImageDir || (value && value !== NONE ? dirOf(value) : ""));
        showLora(node, value);
    };
    chainCallback(node, "onConfigure", () => {
        fb.configured = true;
        restore();
    });
    queueMicrotask(() => {
        if (!fb.configured) restore();
    });
}

app.registerExtension({
    name: "FBnodes.VisualLoraPicker",
    setup() {
        installArrowKeys();
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["image", "strength_model"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
