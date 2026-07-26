/**
 * Visual LoRA Picker - pick a LoRA by selecting its thumbnail image.
 *
 * UI mirrors LoadImagePlus but without mask/size footer:
 *   - flat file dropdown populated with images in the selected folder
 *   - "Select Lora" thumbnail browser opening in ComfyUI's loras folder
 *   - image preview filling the node body with a numeric strength input
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createFileBrowserModal } from "./file_browser.js";
import { mediaFileUrl } from "./path_browser.js";

const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;

function isAbsolutePath(value) {
    if (!value) return false;
    return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

function basenameForDisplay(value) {
    const s = String(value || "");
    const normalized = s.replace(/\\/g, "/");
    const i = normalized.lastIndexOf("/");
    return i >= 0 ? normalized.substring(i + 1) : normalized;
}

function dirnameForPath(value) {
    const s = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const i = s.lastIndexOf("/");
    return i > 0 ? s.substring(0, i) : "";
}

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

function isTypingTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable;
}

let _fbVlpHoveredNode = null;
let _fbVlpArrowListenerInstalled = false;

function isVlpNodeInGraph(node) {
    if (!node || !app.graph?._nodes) return false;
    return app.graph._nodes.includes(node);
}

function getActiveVisualLoraPickerNode() {
    // Hover-only: only react when the cursor is actually over a live node.
    if (_fbVlpHoveredNode && !_fbVlpHoveredNode.flags?.collapsed && isVlpNodeInGraph(_fbVlpHoveredNode)) {
        return _fbVlpHoveredNode;
    }
    if (_fbVlpHoveredNode && !isVlpNodeInGraph(_fbVlpHoveredNode)) {
        _fbVlpHoveredNode = null;
    }
    return null;
}

function installVlpArrowNavigation() {
    if (_fbVlpArrowListenerInstalled) return;
    _fbVlpArrowListenerInstalled = true;

    window.addEventListener("keydown", async (event) => {
        if (event.defaultPrevented) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (isTypingTarget(event.target)) return;

        const node = getActiveVisualLoraPickerNode();
        if (!node || typeof node._vlpStepImageByDelta !== "function") return;

        const dir = event.key === "ArrowRight" ? 1 : -1;
        const handled = await node._vlpStepImageByDelta(dir);
        if (!handled) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}

function stripAnnotation(filename) {
    if (!filename) return filename;
    const match = String(filename).match(/^(.+)\s+\[(input|output|temp)\]$/);
    return match ? match[1] : filename;
}

async function getLorasRoot() {
    try {
        const resp = await api.fetchApi("/fbnodes/lora-browser/root");
        if (!resp.ok) return "";
        const data = await resp.json();
        return data.ok ? data.root : "";
    } catch (err) {
        console.warn("[VisualLoraPicker] Could not get loras root:", err);
        return "";
    }
}

async function listImagesInFolder(folderPath) {
    if (!folderPath) return [];
    try {
        const resp = await api.fetchApi(
            `/fbnodes/path-browser/list?path=${encodeURIComponent(folderPath)}&kind=image`
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        if (!data.ok) return [];
        return (data.files || [])
            .map((f) => (typeof f === "string" ? f : f?.path))
            .filter(Boolean);
    } catch (err) {
        console.warn("[VisualLoraPicker] Could not list images:", err);
        return [];
    }
}

function buildPreviewUrl(filename) {
    if (isAbsolutePath(filename)) {
        return mediaFileUrl(filename);
    }
    return PLACEHOLDER_IMAGE_PATH;
}

app.registerExtension({
    name: "FBnodes.VisualLoraPicker",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "VisualLoraPicker") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            if (!node.properties) node.properties = {};

            node._configuredFromWorkflow = false;

            const imageWidget = node.widgets?.find((w) => w.name === "image");
            const strengthWidget = node.widgets?.find((w) => w.name === "strength_model");

            // Preview panel: image preview that fills the node body.
            const panel = document.createElement("div");
            panel.style.cssText = `
                display: flex;
                flex-direction: column;
                width: 100%;
                height: 100%;
                box-sizing: border-box;
                gap: 6px;
                overflow: hidden;
                background: transparent;
            `;

            const previewBox = document.createElement("div");
            previewBox.style.cssText = `
                position: relative;
                flex: 1;
                min-height: 80px;
                width: 100%;
                border-radius: 10px;
                background: rgba(34, 39, 48, 0.98);
                border: 1px solid rgba(78, 90, 108, 0.72);
                overflow: hidden;
                box-sizing: border-box;
            `;

            const img = document.createElement("img");
            img.draggable = false;
            img.src = PLACEHOLDER_IMAGE_PATH;
            img.style.cssText = `
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                object-position: center center;
                display: block;
                user-select: none;
                pointer-events: none;
                -webkit-user-drag: none;
            `;

            const emptyLabel = document.createElement("div");
            emptyLabel.textContent = "No LoRA selected";
            emptyLabel.style.cssText = `
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                text-align: center;
                font-size: 11px;
                color: rgba(178, 191, 208, 0.92);
                background: rgba(0, 0, 0, 0.25);
                border-radius: 10px;
                pointer-events: none;
            `;

            previewBox.appendChild(img);
            previewBox.appendChild(emptyLabel);

            // Click catcher overlay: transparent, captures clicks to open the browser.
            const clickCatcher = document.createElement("div");
            clickCatcher.style.cssText = `
                position: absolute;
                inset: 0;
                cursor: pointer;
                background: transparent;
            `;
            clickCatcher.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (browseButton && typeof browseButton.callback === "function") {
                    try {
                        await browseButton.callback();
                    } catch (err) {
                        console.error("[VisualLoraPicker] Error opening browser from image:", err);
                    }
                }
            });
            previewBox.appendChild(clickCatcher);

            // Forward wheel events from the preview area to the canvas so ComfyUI zoom works.
            previewBox.addEventListener("wheel", (e) => {
                const canvas = app.canvas?.canvas || document.querySelector("canvas.lgraphcanvas");
                if (!canvas) return;
                const newEvent = new WheelEvent("wheel", {
                    bubbles: true,
                    cancelable: true,
                    clientX: e.clientX,
                    clientY: e.clientY,
                    deltaX: e.deltaX,
                    deltaY: e.deltaY,
                    deltaZ: e.deltaZ,
                    deltaMode: e.deltaMode,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey,
                    metaKey: e.metaKey,
                });
                canvas.dispatchEvent(newEvent);
            }, { passive: true });

            panel.appendChild(previewBox);

            const domWidget = node.addDOMWidget("vlp_preview", "div", panel, {
                serialize: false,
                hideOnZoom: false,
            });
            // Let the DOM widget fill remaining node height.
            domWidget.getHeight = () => "100%";

            // Numeric strength input displayed under the preview.
            const strengthWidgetIndex = node.widgets.indexOf(strengthWidget);
            const numericStrengthWidget = node.addWidget(
                "number",
                "strength",
                strengthWidget?.value != null ? Number(strengthWidget.value) : 1.0,
                (v) => {
                    if (strengthWidget) strengthWidget.value = Number(v);
                    node.setDirtyCanvas(true, true);
                },
                {
                    min: strengthWidget?.options?.min != null ? Number(strengthWidget.options.min) : -100,
                    max: strengthWidget?.options?.max != null ? Number(strengthWidget.options.max) : 100,
                    step: strengthWidget?.options?.step != null ? Number(strengthWidget.options.step) : 0.01,
                    precision: 2,
                }
            );
            numericStrengthWidget.serialize = false;

            // Persist the visible strength value to the hidden serialized widget on every
            // widget value serialization so tab switches never lose it.
            const originalSerialize = node.serialize;
            node.serialize = function () {
                if (strengthWidget && numericStrengthWidget) {
                    strengthWidget.value = Number(numericStrengthWidget.value);
                }
                return originalSerialize ? originalSerialize.apply(this, arguments) : undefined;
            };

            const syncNumericStrength = () => {
                const v = Number(strengthWidget?.value);
                if (Number.isFinite(v) && numericStrengthWidget) {
                    numericStrengthWidget.value = v;
                }
            };

            if (strengthWidget) {
                const originalStrengthCb = strengthWidget.callback;
                strengthWidget.callback = function (v) {
                    syncNumericStrength();
                    if (originalStrengthCb) return originalStrengthCb.apply(this, arguments);
                };
            }

            syncNumericStrength();

            // Reorder widgets: place numeric strength immediately under the visible controls.
            if (strengthWidgetIndex >= 0 && numericStrengthWidget) {
                const idx = node.widgets.indexOf(numericStrengthWidget);
                if (idx >= 0) {
                    node.widgets.splice(idx, 1);
                    node.widgets.splice(strengthWidgetIndex + 1, 0, numericStrengthWidget);
                }
            }

            // Hide native widgets; their serialized values are still used by the backend.
            if (imageWidget) hideWidget(imageWidget);
            if (strengthWidget) hideWidget(strengthWidget);

            // Build an ordered list of absolute image paths currently known in the picker.
            const listImagePaths = () => {
                const out = [];
                const add = (value) => {
                    if (!value || value === "(none)") return;
                    const cleaned = stripAnnotation(value);
                    if (!out.includes(cleaned)) out.push(cleaned);
                };
                const map = node._vlpImageMap || {};
                for (const value of Object.values(map)) add(value);
                return out;
            };

            node._vlpStepImageByDelta = async (delta) => {
                const paths = listImagePaths();
                if (paths.length <= 1) return false;

                const dir = delta >= 0 ? 1 : -1;
                const current = stripAnnotation(imageWidget?.value);
                const currentIndex = paths.indexOf(current);

                let nextIndex;
                if (currentIndex < 0) {
                    nextIndex = dir > 0 ? 0 : paths.length - 1;
                } else {
                    nextIndex = (currentIndex + dir + paths.length) % paths.length;
                }

                const nextPath = paths[nextIndex];
                const nextDir = dirnameForPath(nextPath);
                node.properties._vlpImageDir = nextDir;
                setImagePath(nextPath);
                await refreshPickerOptions(nextDir, nextPath);
                return true;
            };

            installVlpArrowNavigation();

            // Flat file picker populated with images from the selected folder.
            let filePickerWidget = node.addWidget(
                "combo",
                "file",
                "(none)",
                (label) => {
                    const selected = node._vlpImageMap?.[label] || "(none)";
                    setImagePath(selected);
                },
                { values: ["(none)"] }
            );
            filePickerWidget.serialize = false;
            node._vlpImageMap = { "(none)": "(none)" };

            const setImagePath = (value) => {
                if (!imageWidget) return;
                const cleaned = stripAnnotation(value);

                imageWidget.value = cleaned;
                if (typeof imageWidget.callback === "function") {
                    imageWidget.callback(cleaned);
                }

                // Keep picker label in sync
                const label = Object.keys(node._vlpImageMap || {}).find(
                    (k) => node._vlpImageMap[k] === cleaned
                );
                if (filePickerWidget) filePickerWidget.value = label || "(none)";

                // Update preview and persistence
                loadPreview(cleaned);
                node.properties._vlpImagePath = cleaned || "";
                node.properties._vlpImageDir = cleaned ? dirnameForPath(cleaned) : "";

                node.setDirtyCanvas(true, true);
            };

            const loadPreview = (imagePath) => {
                if (!imagePath || imagePath === "(none)") {
                    img.removeAttribute("src");
                    img.style.display = "none";
                    emptyLabel.style.display = "flex";
                    return;
                }
                img.style.display = "block";
                emptyLabel.style.display = "none";
                img.src = `${buildPreviewUrl(imagePath)}&${Date.now()}`;
            };

            const refreshPickerOptions = async (folderPath, preferredValue = null) => {
                if (!folderPath) return;
                const images = await listImagesInFolder(folderPath);

                const labels = ["(none)"];
                const map = { "(none)": "(none)" };
                const used = new Set(["(none)"]);

                for (const absPath of images) {
                    const base = basenameForDisplay(absPath) || absPath;
                    let label = base;
                    let idx = 2;
                    while (used.has(label)) {
                        label = `${base} (${idx++})`;
                    }
                    used.add(label);
                    labels.push(label);
                    map[label] = absPath;
                }

                node._vlpImageMap = map;
                if (filePickerWidget) filePickerWidget.options.values = labels;

                const desired = preferredValue != null ? preferredValue : imageWidget?.value;
                const desiredLabel = Object.keys(map).find((k) => map[k] === desired);
                if (filePickerWidget) filePickerWidget.value = desiredLabel || "(none)";
            };

            // Select Lora button opens the thumbnail browser in the loras folder.
            const browseButton = {
                type: "button",
                name: "\u{1F4C1} Select Lora",
                value: null,
                callback: async () => {
                    const root = await getLorasRoot();
                    const current = node.properties?._vlpImagePath || imageWidget?.value || "";
                    const currentDir = current ? dirnameForPath(current) : "";

                    createFileBrowserModal(
                        current,
                        (selected, meta) => {
                            const absPath = meta?.absPath || selected;
                            if (!absPath || absPath === "(none)") return;

                            const dir = dirnameForPath(absPath);
                            node.properties._vlpImageDir = dir;
                            setImagePath(absPath);
                            refreshPickerOptions(dir, absPath);
                        },
                        "input",
                        {
                            enableNavigation: true,
                            initialPath: currentDir || root,
                            selectedAbsPath: current,
                            navKind: "image",
                            allowedTypes: ["image"],
                        }
                    );
                },
                serialize: false,
            };
            node.widgets.push(browseButton);

            // Reorder widgets so the visible controls sit directly under the title bar.
            const imageWidgetIndex = node.widgets.indexOf(imageWidget);
            if (imageWidgetIndex >= 0 && filePickerWidget) {
                const pickerIndex = node.widgets.indexOf(filePickerWidget);
                if (pickerIndex >= 0) {
                    node.widgets.splice(pickerIndex, 1);
                    node.widgets.splice(imageWidgetIndex + 1, 0, filePickerWidget);
                }
                const buttonIndex = node.widgets.indexOf(browseButton);
                if (buttonIndex >= 0) {
                    node.widgets.splice(buttonIndex, 1);
                    node.widgets.splice(imageWidgetIndex + 2, 0, browseButton);
                }
            }

            // Track hover the same way SaveImagePlus does: via node mouse events.
            const onMouseMove = node.onMouseMove;
            node.onMouseMove = function (event, localPos, canvas) {
                _fbVlpHoveredNode = this;
                return onMouseMove?.apply(this, arguments);
            };

            // Also wire the DOM preview overlay so it reports hover reliably.
            const onMouseEnter = node.onMouseEnter;
            node.onMouseEnter = function () {
                _fbVlpHoveredNode = this;
                return onMouseEnter?.apply(this, arguments);
            };

            const onMouseLeave = node.onMouseLeave;
            node.onMouseLeave = function () {
                if (_fbVlpHoveredNode === this) {
                    _fbVlpHoveredNode = null;
                }
                return onMouseLeave?.apply(this, arguments);
            };

            if (previewBox) {
                previewBox.addEventListener("mouseenter", () => {
                    _fbVlpHoveredNode = node;
                });
                previewBox.addEventListener("mouseleave", () => {
                    if (_fbVlpHoveredNode === node) {
                        _fbVlpHoveredNode = null;
                    }
                });
            }

            // Size / resize handling
            const oldOnResize = node.onResize;
            node.onResize = function (size) {
                const res = oldOnResize?.apply(this, arguments);
                if (size) {
                    if (size[0] < 200) size[0] = 200;
                    if (size[1] < 320) size[1] = 320;
                }
                return res;
            };

            const origDraw = domWidget.draw;
            domWidget.draw = function (ctx, n, widgetWidth, y, H) {
                if (typeof origDraw === "function") origDraw.apply(this, arguments);
                if (!panel || n.flags?.collapsed) return;
                panel.style.setProperty("width", (n.size[0] - 18) + "px", "important");
                panel.style.setProperty("left", "0px", "important");
                panel.style.setProperty("margin", "0px", "important");
                panel.style.setProperty("padding", "4px", "important");
                panel.style.setProperty("box-sizing", "border-box", "important");
                panel.style.setProperty("overflow", "hidden", "important");
            };

            // Comfortable default size for a new node (saved workflows restore their own).
            if (!node._configuredFromWorkflow) {
                node.setSize([240, 400]);
            }

            // Restore state on workflow load / tab switch
            const onConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                node._configuredFromWorkflow = true;
                const res = onConfigure?.apply(this, arguments);

                const restoredImage = stripAnnotation(imageWidget?.value);
                if (restoredImage) {
                    node.properties._vlpImagePath = restoredImage;
                    node.properties._vlpImageDir = dirnameForPath(restoredImage);
                }

                // Strength can become null/undefined after tab switch if widgets_values
                // deserializes before onConfigure runs. Restore from the serialized
                // widgets_values array when the hidden widget hasn't been set yet.
                if (info && info.widgets_values && strengthWidget) {
                    const idx = this.widgets.findIndex((w) => w.name === "strength_model");
                    if (idx >= 0 && info.widgets_values[idx] !== undefined && info.widgets_values[idx] !== null) {
                        strengthWidget.value = Number(info.widgets_values[idx]);
                    }
                }
                if (strengthWidget && (strengthWidget.value == null || !Number.isFinite(Number(strengthWidget.value)))) {
                    strengthWidget.value = 1.0;
                }
                syncNumericStrength();

                const dir = node.properties?._vlpImageDir || dirnameForPath(restoredImage);
                if (dir) {
                    refreshPickerOptions(dir, node.properties?._vlpImagePath || restoredImage);
                }

                loadPreview(node.properties?._vlpImagePath || restoredImage);

                return res;
            };

            // Initial load
            setTimeout(() => {
                const initial = stripAnnotation(imageWidget?.value);
                if (initial) {
                    node.properties._vlpImagePath = initial;
                    node.properties._vlpImageDir = dirnameForPath(initial);
                    refreshPickerOptions(dirnameForPath(initial), initial);
                    loadPreview(initial);
                } else {
                    loadPreview(null);
                }
            }, 10);

            return result;
        };
    },
});

console.log("[FBnodes] VisualLoraPicker extension loaded");
