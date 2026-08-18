/**
 * Clip Stitcher UI Extension for ComfyUI (FBnodes)
 * Simple clip list: browse, drag-reorder, enable/disable, remove.
 * No generation - just merges clips (see nodes/clip_stitcher.py).
 */

import { app } from "../../scripts/app.js";
import { createFileBrowserModal } from "./file_browser.js";
import { getMediaRoots, classifySelection, mediaFileUrl } from "./path_browser.js";

function isAbsolutePath(value) {
    return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(value || ""));
}

function isVideoFile(filename) {
    if (!filename) return false;
    const ext = String(filename).split(".").pop().toLowerCase();
    return ["mp4", "webm", "mov", "avi", "mkv", "m4v"].includes(ext);
}

function getViewUrl(filename, sourceFolder) {
    if (isAbsolutePath(filename)) {
        return mediaFileUrl(filename);
    }
    let base = filename;
    let subfolder = "";
    if (filename.includes("/")) {
        const i = filename.lastIndexOf("/");
        subfolder = filename.substring(0, i);
        base = filename.substring(i + 1);
    }
    let url = `/view?filename=${encodeURIComponent(base)}&type=${sourceFolder}`;
    if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
    return url;
}

// ── Hover thumbnail preview (mirrors VACE Stitcher) ─────────────────────────
let _hoverPopup = null;

function showHoverThumbnail(filename, sourceFolder, anchorRect) {
    hideHoverThumbnail();
    const popup = document.createElement("div");
    popup.style.cssText = `
        position:fixed;z-index:10001;pointer-events:none;
        background:rgba(20,20,20,0.95);border:1px solid rgba(255,255,255,0.2);
        border-radius:6px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,0.6);
    `;
    popup.style.left = anchorRect.left + "px";
    popup.style.bottom = (window.innerHeight - anchorRect.top + 4) + "px";

    if (isVideoFile(filename)) {
        const vid = document.createElement("video");
        vid.crossOrigin = "anonymous";
        vid.muted = true;
        vid.autoplay = true;
        vid.loop = true;
        vid.style.cssText = "max-width:320px;max-height:240px;border-radius:4px;";

        const showServerFrame = () => {
            if (!popup.parentElement) return;
            const frameUrl = `/fbnodes/video-frame?filename=${encodeURIComponent(filename)}&source=${sourceFolder}&position=0`;
            const sImg = new Image();
            sImg.onload = () => {
                if (!popup.parentElement) return;
                const result = new Image();
                result.style.cssText = "max-width:320px;max-height:240px;border-radius:4px;";
                result.src = frameUrl;
                popup.innerHTML = "";
                popup.appendChild(result);
            };
            sImg.onerror = () => {
                if (!popup.parentElement) return;
                popup.innerHTML = "";
                const msg = document.createElement("span");
                msg.textContent = "Preview N/A";
                msg.style.cssText = "font-size:11px;color:#888;padding:12px 16px;white-space:nowrap;";
                popup.appendChild(msg);
            };
            sImg.src = frameUrl;
        };

        vid.onerror = () => { vid.remove(); showServerFrame(); };

        // Detect black frame (unsupported codec) after first frame renders.
        let checked = false;
        let resolved = false;
        vid.addEventListener("playing", () => {
            if (checked) return;
            checked = true;
            setTimeout(() => {
                try {
                    const c = document.createElement("canvas");
                    c.width = Math.min(vid.videoWidth, 64);
                    c.height = Math.min(vid.videoHeight, 4);
                    const ctx = c.getContext("2d", { alpha: false });
                    ctx.drawImage(vid, 0, 0, c.width, c.height);
                    const d = ctx.getImageData(0, 0, c.width, c.height).data;
                    let allBlack = true;
                    for (let i = 0; i < d.length; i += 16) {
                        if (d[i] > 2 || d[i + 1] > 2 || d[i + 2] > 2) { allBlack = false; break; }
                    }
                    if (allBlack && !resolved) { resolved = true; vid.remove(); showServerFrame(); }
                    else { resolved = true; }
                } catch (_) {}
            }, 80);
        });

        setTimeout(() => {
            if (!resolved && !checked) {
                resolved = true;
                vid.remove();
                showServerFrame();
            }
        }, 2000);

        vid.src = getViewUrl(filename, sourceFolder) + `&${Date.now()}`;
        popup.appendChild(vid);
    } else {
        const img = document.createElement("img");
        img.style.cssText = "max-width:320px;max-height:240px;border-radius:4px;";
        img.src = getViewUrl(filename, sourceFolder) + `&${Date.now()}`;
        popup.appendChild(img);
    }
    document.body.appendChild(popup);
    _hoverPopup = popup;
}

function hideHoverThumbnail() {
    if (_hoverPopup) {
        _hoverPopup.remove();
        _hoverPopup = null;
    }
}

function showConfirm(title, message, confirmText = "Clear", confirmColor = "#c00") {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;`;
        const dialog = document.createElement("div");
        dialog.style.cssText = `
            position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:#222;border:2px solid #444;border-radius:8px;padding:20px;
            z-index:10000;min-width:300px;box-shadow:0 4px 20px rgba(0,0,0,0.5);
        `;
        dialog.innerHTML = `
            <div style="margin-bottom:15px;font-size:16px;font-weight:bold;color:#fff;">${title}</div>
            <div style="margin-bottom:20px;color:#ccc;">${message}</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button class="cancel-btn" style="padding:8px 16px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
                <button class="ok-btn" style="padding:8px 16px;background:${confirmColor};color:#fff;border:none;border-radius:4px;cursor:pointer;">${confirmText}</button>
            </div>
        `;
        const cleanup = () => { document.body.removeChild(overlay); document.body.removeChild(dialog); };
        dialog.querySelector(".ok-btn").onclick = () => { resolve(true); cleanup(); };
        dialog.querySelector(".cancel-btn").onclick = () => { resolve(false); cleanup(); };
        overlay.onclick = () => { resolve(false); cleanup(); };
        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
        dialog.querySelector(".ok-btn").focus();
    });
}

// ── Height management (mirrors PM multi_lora_stacker_lm.js) ──────────
// Report content height via getMinHeight + CSS vars so the layout
// system sizes the node; the DOM fills the rest via getHeight "100%".
function computeContentHeight(clipEntries) {
    const ROW_H = 30;
    const HEADER_FOOTER = 78;
    const visibleRows = Math.max(3, Math.min(10, clipEntries.length));
    return HEADER_FOOTER + visibleRows * ROW_H;
}

function notifyHeightChange(node, rootEl, clipEntries) {
    if (!rootEl) return;
    const h = computeContentHeight(clipEntries);
    rootEl.style.setProperty('--comfy-widget-min-height', `${h}px`);
    rootEl.style.setProperty('--comfy-widget-height', `${h}px`);
    setTimeout(() => { node?.setDirtyCanvas?.(true, true); }, 10);
}

app.registerExtension({
    name: "FBnodes.ClipStitcher",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "ClipStitcher") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            const MIN_NODE_WIDTH = 430;

            // Reasonable default size; DOM fills the node body.
            try {
                node.setSize([300, 420]);
            } catch (e) { /* ignore */ }

            const clipListWidget = node.widgets?.find((w) => w.name === "clip_list");
            const sourceFolderWidget = node.widgets?.find((w) => w.name === "source_folder");
            if (!clipListWidget) return result;

            // Hide source_folder + raw JSON widget from the UI.
            if (sourceFolderWidget) {
                sourceFolderWidget.hidden = true;
                sourceFolderWidget.computeSize = () => [0, -4];
                if (sourceFolderWidget.inputEl) sourceFolderWidget.inputEl.style.display = "none";
                // Default new nodes to output so generated clips are easy to find.
                // onConfigure will overwrite this when loading a saved workflow.
                if (!node.properties?._browsePath) {
                    sourceFolderWidget.value = "output";
                }
            }
            clipListWidget.type = "converted-widget";
            clipListWidget.computeSize = () => [0, -4];
            clipListWidget.hidden = true;

            // ── state ──
            let _clipUidCounter = 1;
            const allocateClipUid = () => _clipUidCounter++;
            function normalizeClipEntries(rawEntries) {
                if (!Array.isArray(rawEntries)) return [];
                const usedUids = new Set();
                return rawEntries.map((raw) => {
                    const next = { ...(raw || {}) };
                    let uid = Number.isInteger(next._uid) ? next._uid : null;
                    if (uid === null || usedUids.has(uid)) uid = allocateClipUid();
                    usedUids.add(uid);
                    if (uid >= _clipUidCounter) _clipUidCounter = uid + 1;
                    next._uid = uid;
                    if (typeof next.enabled !== "boolean") next.enabled = true;
                    return next;
                });
            }
            let clipEntries = [];
            try {
                clipEntries = normalizeClipEntries(JSON.parse(clipListWidget.value || "[]"));
            } catch (_) {}

            function syncWidget() {
                clipListWidget.value = JSON.stringify(clipEntries);
            }

            // Persist numeric widget changes to properties; restore on configure.
            function persistProp(key, value) {
                if (!node.properties) node.properties = {};
                node.properties[key] = value;
            }

            function wrapWidgetCallback(widgetName, propKey) {
                const widget = node.widgets?.find((w) => w.name === widgetName);
                if (!widget || widget._fbPropWrapped) return;
                widget._fbPropWrapped = true;
                const orig = widget.callback;
                widget.callback = function (value) {
                    if (orig) orig.apply(this, arguments);
                    persistProp(propKey, value);
                };
            }

            function restoreWidgetFromProperty(widgetName, propKey) {
                const widget = node.widgets?.find((w) => w.name === widgetName);
                if (!widget) return;
                wrapWidgetCallback(widgetName, propKey);
                const stored = node.properties?.[propKey];
                if (stored !== undefined && stored !== null) {
                    widget.value = stored;
                }
            }

            // Wrap callbacks so changes are saved; do NOT set values here.
            wrapWidgetCallback("clip_duration", "_clipStitcherClipDuration");
            wrapWidgetCallback("blend_duration", "_clipStitcherBlendDuration");

            // ── Browse button ──
            const browseIdx = node.widgets.indexOf(clipListWidget);
            const browseBtn = {
                type: "button",
                name: "📁 Browse Clips",
                value: null,
                serialize: false,
                callback: () => {
                    const sf = sourceFolderWidget?.value || "input";
                    void getMediaRoots().then((roots) => {
                        let initialPath = node.properties?._browsePath || "";
                        if (!initialPath) {
                            initialPath = sf === "output" ? roots.output : roots.input;
                        }
                        if (clipEntries.length > 0) {
                            const lastFile = clipEntries[clipEntries.length - 1]?.file || "";
                            if (isAbsolutePath(lastFile)) {
                                initialPath = lastFile.replace(/[\\/][^\\/]*$/, "");
                            }
                        }
                        createFileBrowserModal("", () => {}, sf, {
                            enableNavigation: true,
                            initialPath,
                            navKind: "video",
                            allowedTypes: ["video"],
                            multiSelect: true,
                            onMultiSelect: (items) => {
                                for (const item of items || []) {
                                    let value = item?.value || "";
                                    let resolvedSource = sf;
                                    const meta = item?.meta || null;
                                    if (meta?.absPath) {
                                        if (!node.properties) node.properties = {};
                                        node.properties._browsePath = meta.dir;
                                        const cls = classifySelection(meta.absPath, meta.roots || roots);
                                        value = cls?.value || meta.absPath;
                                        resolvedSource = cls?.sourceFolder || resolvedSource;
                                    }
                                    if (value && value !== "(none)") {
                                        clipEntries.push({ file: value, source: resolvedSource, enabled: true, _uid: allocateClipUid() });
                                    }
                                }
                                syncWidget();
                                rebuildClipListDisplay();
                            },
                        });
                    });
                },
            };
            node.widgets.splice(browseIdx + 1, 0, browseBtn);
            Object.defineProperty(browseBtn, "node", { value: node });

            // ── Clip list container ──
            const sectionContainer = document.createElement("div");
            sectionContainer.style.cssText = `
                display:flex;flex-direction:column;width:100%;height:100%;
                box-sizing:border-box;background:rgba(40,44,52,0.6);border-radius:6px;
                border:1px solid rgba(255,255,255,0.08);overflow:hidden;
            `;

            const sectionHeader = document.createElement("div");
            sectionHeader.style.cssText = `
                display:flex;justify-content:space-between;align-items:center;
                padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.1);flex-shrink:0;
            `;
            const sectionTitle = document.createElement("span");
            sectionTitle.textContent = "Clip List";
            sectionTitle.style.cssText = "font-size:12px;font-weight:bold;color:#aaa;";
            const clipCountLabel = document.createElement("span");
            clipCountLabel.style.cssText = "font-size:10px;color:#666;";
            sectionHeader.appendChild(sectionTitle);
            sectionHeader.appendChild(clipCountLabel);
            sectionContainer.appendChild(sectionHeader);

            const clipListContainer = document.createElement("div");
            clipListContainer.style.cssText = `
                flex:1;overflow-y:auto;padding:4px 6px;display:flex;
                flex-direction:column;gap:2px;min-height:0;
            `;
            sectionContainer.appendChild(clipListContainer);

            // ── Footer with Clear All button ──
            const sectionFooter = document.createElement("div");
            sectionFooter.style.cssText = `
                padding:6px 8px;border-top:1px solid rgba(255,255,255,0.1);
                flex-shrink:0;display:flex;gap:6px;
            `;
            const clearAllBtn = document.createElement("button");
            clearAllBtn.textContent = "Clear All";
            clearAllBtn.style.cssText = `
                flex:1;padding:5px 12px;border:none;border-radius:4px;
                font-size:11px;cursor:pointer;
                background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);
                transition:background 0.15s, color 0.15s;
            `;
            clearAllBtn.title = "Remove all clips from the list";
            clearAllBtn.onmouseenter = () => {
                clearAllBtn.style.background = "rgba(200,60,60,0.25)";
                clearAllBtn.style.color = "rgba(255,130,130,0.9)";
            };
            clearAllBtn.onmouseleave = () => {
                clearAllBtn.style.background = "rgba(255,255,255,0.06)";
                clearAllBtn.style.color = "rgba(255,255,255,0.5)";
            };
            clearAllBtn.onclick = async () => {
                const confirmed = await showConfirm(
                    "Clear All",
                    "Remove all clips from the list?",
                    "Clear All", "#c00"
                );
                if (!confirmed) return;
                clipEntries.length = 0;
                syncWidget();
                rebuildClipListDisplay();
            };
            sectionFooter.appendChild(clearAllBtn);
            sectionContainer.appendChild(sectionFooter);

            const sectionWidget = node.addDOMWidget(
                "clip_list_section",
                "customwidget",
                sectionContainer,
                {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => computeContentHeight(clipEntries),
                    getHeight: () => "100%",
                }
            );
            // No computeSize override — fixed computeSize locks the widget to a
            // fixed strip and leaves dead space below. The layout system sizes
            // the node from getMinHeight/CSS vars; DOM fills via height:100%.

            // ── drag reorder state ──
            let _dragIdx = null;
            let _dragOverIdx = null;

            function rebuildClipListDisplay() {
                clipListContainer.innerHTML = "";
                const enabledCount = clipEntries.filter((e) => e.enabled !== false).length;
                clipCountLabel.textContent = clipEntries.length > 0
                    ? `${enabledCount}/${clipEntries.length} enabled`
                    : "";
                if (clipEntries.length === 0) {
                    const empty = document.createElement("div");
                    empty.textContent = "No clips added. Use Browse to add clips.";
                    empty.style.cssText = "color:#888;font-size:11px;text-align:center;padding:8px;";
                    clipListContainer.appendChild(empty);
                    notifyHeightChange(node, sectionContainer, clipEntries);
                    return;
                }

                clipEntries.forEach((entry, idx) => {
                    const isEnabled = entry.enabled !== false;
                    const bgColor = isEnabled ? "rgba(50, 112, 163, 0.35)" : "rgba(45, 55, 72, 0.5)";
                    const borderColor = isEnabled ? "rgba(66, 153, 225, 0.4)" : "rgba(226, 232, 240, 0.1)";
                    const textColor = isEnabled ? "rgba(226, 232, 240, 0.95)" : "rgba(226, 232, 240, 0.4)";

                    const row = document.createElement("div");
                    row.dataset.clipIdx = idx;
                    row.style.cssText = `
                        display:flex;align-items:center;gap:4px;padding:3px 4px;
                        background:${bgColor};border-radius:4px;border:1px solid ${borderColor};
                        font-size:11px;color:${textColor};min-height:24px;
                        transition:background 0.15s ease, border-color 0.15s ease;
                    `;

                    // Drag handle
                    const grip = document.createElement("div");
                    grip.title = "Drag to reorder";
                    grip.style.cssText = `
                        flex-shrink:0;width:16px;height:20px;cursor:grab;
                        display:flex;align-items:center;justify-content:center;
                        color:rgba(255,255,255,0.3);font-size:11px;user-select:none;
                        letter-spacing:2px;line-height:1;
                    `;
                    grip.textContent = "⋮⋮";
                    grip.onmousedown = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        _dragIdx = idx;
                        row.style.opacity = "0.5";
                        grip.style.cursor = "grabbing";

                        const onMouseMove = (me) => {
                            const rows = clipListContainer.querySelectorAll("[data-clip-idx]");
                            let overIdx = null;
                            rows.forEach((r) => {
                                const rect = r.getBoundingClientRect();
                                if (me.clientY >= rect.top && me.clientY <= rect.bottom) {
                                    overIdx = parseInt(r.dataset.clipIdx);
                                }
                            });
                            if (overIdx !== null && overIdx !== _dragIdx) {
                                rows.forEach((r) => {
                                    const ri = parseInt(r.dataset.clipIdx);
                                    r.style.borderTop = ri === overIdx && overIdx < _dragIdx ? "2px solid rgba(66,153,225,0.9)" : "";
                                    r.style.borderBottom = ri === overIdx && overIdx > _dragIdx ? "2px solid rgba(66,153,225,0.9)" : "";
                                });
                                _dragOverIdx = overIdx;
                            }
                        };
                        const onMouseUp = () => {
                            document.removeEventListener("mousemove", onMouseMove);
                            document.removeEventListener("mouseup", onMouseUp);
                            row.style.opacity = "1";
                            grip.style.cursor = "grab";
                            if (_dragOverIdx !== null && _dragOverIdx !== _dragIdx) {
                                const [moved] = clipEntries.splice(_dragIdx, 1);
                                clipEntries.splice(_dragOverIdx, 0, moved);
                                syncWidget();
                                rebuildClipListDisplay();
                            } else {
                                clipListContainer.querySelectorAll("[data-clip-idx]").forEach((r) => {
                                    r.style.borderTop = "";
                                    r.style.borderBottom = "";
                                });
                            }
                            _dragIdx = null;
                            _dragOverIdx = null;
                        };
                        document.addEventListener("mousemove", onMouseMove);
                        document.addEventListener("mouseup", onMouseUp);
                    };
                    row.appendChild(grip);

                    // Enable/disable checkbox
                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = isEnabled;
                    cb.title = "Enable/disable this clip";
                    cb.style.cssText = "cursor:pointer;flex-shrink:0;accent-color:rgba(66,153,225,0.9);";
                    cb.onchange = () => {
                        clipEntries[idx] = { ...clipEntries[idx], enabled: cb.checked };
                        syncWidget();
                        rebuildClipListDisplay();
                    };
                    row.appendChild(cb);

                    // Filename label
                    const basename = entry.file.includes("/") ? entry.file.split("/").pop() : entry.file;
                    const lbl = document.createElement("span");
                    lbl.textContent = basename;
                    lbl.title = `[${entry.source || "input"}] ${entry.file}`;
                    lbl.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;
                        white-space:nowrap;color:${textColor};cursor:default;`;

                    // Hover video thumbnail (like VACE Stitcher).
                    lbl.onmouseenter = () => {
                        const sf = entry.source || sourceFolderWidget?.value || "input";
                        const rect = lbl.getBoundingClientRect();
                        showHoverThumbnail(entry.file, sf, rect);
                    };
                    lbl.onmouseleave = () => hideHoverThumbnail();
                    row.appendChild(lbl);

                    // Remove button
                    const removeBtn = document.createElement("button");
                    removeBtn.textContent = "✕";
                    removeBtn.title = "Remove clip";
                    removeBtn.style.cssText = `
                        background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;
                        font-size:10px;padding:0 3px;width:18px;height:18px;flex-shrink:0;
                        display:flex;align-items:center;justify-content:center;border-radius:3px;
                        transition:color 0.15s, background 0.15s;
                    `;
                    removeBtn.onclick = () => {
                        clipEntries.splice(idx, 1);
                        syncWidget();
                        rebuildClipListDisplay();
                    };
                    row.appendChild(removeBtn);

                    row.onmouseenter = () => {
                        if (_dragIdx === null) {
                            row.style.background = isEnabled ? "rgba(50, 112, 163, 0.55)" : "rgba(50, 112, 163, 0.25)";
                            row.style.borderColor = "rgba(66, 153, 225, 0.6)";
                        }
                    };
                    row.onmouseleave = () => {
                        if (_dragIdx === null) {
                            row.style.background = bgColor;
                            row.style.borderColor = borderColor;
                        }
                    };

                    clipListContainer.appendChild(row);
                });

                notifyHeightChange(node, sectionContainer, clipEntries);
            }

            // Enforce minimum width
            const onResize = node.onResize;
            node.onResize = function () {
                const out = onResize ? onResize.apply(this, arguments) : undefined;
                if (Array.isArray(node.size) && node.size[0] < MIN_NODE_WIDTH) {
                    node.size[0] = MIN_NODE_WIDTH;
                }
                return out;
            };

            // Restore clip list on workflow load / tab switch (synchronous).
            const onConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                const r = onConfigure?.apply(this, arguments);
                try {
                    clipEntries = normalizeClipEntries(JSON.parse(clipListWidget.value || "[]"));
                } catch (_) {}
                rebuildClipListDisplay();
                // Only restore from properties if they exist; do NOT overwrite
                // properties with potentially-shifted widget values.
                restoreWidgetFromProperty("clip_duration", "_clipStitcherClipDuration");
                restoreWidgetFromProperty("blend_duration", "_clipStitcherBlendDuration");
                return r;
            };

            rebuildClipListDisplay();
            if (Array.isArray(node.size) && node.size[0] < MIN_NODE_WIDTH) {
                node.size[0] = MIN_NODE_WIDTH;
            }

            return result;
        };
    },
});
