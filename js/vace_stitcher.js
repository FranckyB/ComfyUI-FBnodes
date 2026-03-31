/**
 * VACE Clip Joiner UI Extension for ComfyUI (FBnodes)
 * Multi-select file browser, reorderable clip list with enable/disable,
 * thumbnail hover, and delete-intermediates button.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function showConfirm(title, message, confirmText = "Delete", confirmColor = "#c00") {
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

let _currentSourceFolder = "input";
let _currentSubfolder = "";

function isVideoFile(filename) {
    if (!filename) return false;
    const ext = filename.split(".").pop().toLowerCase();
    return ["mp4", "webm", "mov", "avi", "mkv", "m4v"].includes(ext);
}

function getViewUrl(filename, sourceFolder) {
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

// ── Video thumbnail extraction with localStorage caching ─────────────────────

async function extractVideoThumbnailCached(filename, previewElement) {
    const cacheKey = `video_thumb_${filename.replace(/[\/\\]/g, '_')}`;
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const img = document.createElement('img');
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
            img.src = cached;
            previewElement.innerHTML = '';
            previewElement.appendChild(img);
            return;
        }
    } catch (e) {
        console.log('[VACEStitcher] Cache check failed:', e);
    }
    extractVideoThumbnail(filename, previewElement, cacheKey);
}

function showPreviewUnavailable(previewElement) {
    previewElement.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = 'Preview N/A (codec not supported by browser)';
    msg.style.cssText = 'font-size:10px;color:#888;text-align:center;padding:8px;';
    previewElement.appendChild(msg);
}

async function extractVideoThumbnail(filename, previewElement, cacheKey = null) {
    // Show placeholder while loading
    const placeholderImg = document.createElement('img');
    placeholderImg.src = new URL("./placeholder.png", import.meta.url).href;
    placeholderImg.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    previewElement.innerHTML = '';
    previewElement.appendChild(placeholderImg);

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';

    video.onloadedmetadata = () => { video.currentTime = 0; };

    video.onseeked = () => {
        try {
            const maxW = 180, maxH = 150;
            const ar = video.videoWidth / video.videoHeight;
            let w, h;
            if (ar > maxW / maxH) { w = maxW; h = maxW / ar; }
            else { h = maxH; w = maxH * ar; }

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.drawImage(video, 0, 0, w, h);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            const img = document.createElement('img');
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
            img.src = dataUrl;
            previewElement.innerHTML = '';
            previewElement.appendChild(img);

            if (cacheKey) {
                setTimeout(() => {
                    try { localStorage.setItem(cacheKey, dataUrl); }
                    catch (e) { console.log('[VACEStitcher] Cache write failed:', e); }
                }, 0);
            }
            video.remove();
        } catch (e) {
            console.error('[VACEStitcher] Thumbnail extract error:', e);
            showPreviewUnavailable(previewElement);
            video.remove();
        }
    };

    video.onerror = () => {
        console.error('[VACEStitcher] Video load error:', filename);
        showPreviewUnavailable(previewElement);
        video.remove();
    };

    video.src = getViewUrl(filename, _currentSourceFolder) + `&${Date.now()}`;
}

function clearThumbnailCache() {
    try {
        const prefix = 'video_thumb_';
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
        console.log(`[VACEStitcher] Cleared ${keys.length} cached thumbnails`);
    } catch (e) {
        console.error('[VACEStitcher] Error clearing cache:', e);
    }
}

function refreshIndividualThumbnail(filename, previewElement) {
    const cacheKey = `video_thumb_${filename.replace(/[\/\\]/g, '_')}`;
    try { localStorage.removeItem(cacheKey); } catch (e) { /* ignore */ }
    extractVideoThumbnail(filename, previewElement, cacheKey);
}

function showThumbnailContextMenu(event, filename, previewElement) {
    const existing = document.querySelector('.vcj-thumb-ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'vcj-thumb-ctx-menu';
    menu.style.cssText = `
        position:fixed;left:${event.pageX}px;top:${event.pageY}px;
        background:rgba(30,30,30,0.98);border:1px solid rgba(255,255,255,0.2);
        border-radius:6px;padding:4px;z-index:10001;
        box-shadow:0 4px 12px rgba(0,0,0,0.5);min-width:160px;
    `;

    const btn = document.createElement('div');
    btn.textContent = '\uD83D\uDD04 Refresh Thumbnail';
    btn.style.cssText = 'padding:8px 12px;color:#ccc;cursor:pointer;border-radius:4px;font-size:13px;';
    btn.onmouseenter = () => { btn.style.background = 'rgba(66,153,225,0.3)'; };
    btn.onmouseleave = () => { btn.style.background = 'transparent'; };
    btn.onclick = () => {
        refreshIndividualThumbnail(filename, previewElement);
        menu.remove();
    };

    menu.appendChild(btn);
    document.body.appendChild(menu);

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            e.stopPropagation();
            menu.remove();
            document.removeEventListener('click', closeMenu, true);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 10);
}

// ── Multi-select file browser modal ──────────────────────────────────────────

function openClipBrowserModal(sourceFolder, existingClips, onDone) {
    _currentSourceFolder = sourceFolder || "input";
    _currentSubfolder = "";

    // Track already-selected files
    const selected = new Set(existingClips.map((c) => c.file));

    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position:fixed;top:0;left:0;width:100%;height:100%;
        background:rgba(0,0,0,0.8);display:flex;align-items:center;
        justify-content:center;z-index:10000;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        background:rgba(40,44,52,0.98);border:1px solid rgba(255,255,255,0.1);
        border-radius:6px;width:90%;max-width:1200px;height:80%;max-height:800px;
        display:flex;flex-direction:column;overflow:hidden;
    `;

    // Header
    const header = document.createElement("div");
    header.style.cssText = `padding:15px 20px;border-bottom:1px solid rgba(255,255,255,0.1);
        display:flex;justify-content:space-between;align-items:center;`;
    const title = document.createElement("h3");
    title.style.cssText = "margin:0;color:#aaa;";
    title.textContent = `Select Clips from ${_currentSourceFolder}`;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = `background:none;border:none;color:#aaa;font-size:24px;
        cursor:pointer;padding:0;width:30px;height:30px;`;
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Breadcrumb
    const breadcrumb = document.createElement("div");
    breadcrumb.style.cssText = "padding:4px 20px;font-size:12px;color:#888;cursor:pointer;";
    breadcrumb.textContent = `${_currentSourceFolder}/`;
    breadcrumb.onclick = () => {
        _currentSubfolder = "";
        loadGrid();
    };

    // Filter bar
    const filterBar = document.createElement("div");
    filterBar.style.cssText = `padding:10px 20px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;gap:10px;`;
    const searchInput = document.createElement("input");
    searchInput.placeholder = "Search...";
    searchInput.style.cssText = `flex:1;padding:8px 12px;background:rgba(45,55,72,0.7);
        border:1px solid rgba(226,232,240,0.2);border-radius:6px;color:#ccc;`;
    filterBar.appendChild(searchInput);

    // Grid
    const grid = document.createElement("div");
    grid.style.cssText = `flex:1;overflow-y:auto;padding:20px;display:grid;
        grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:15px;align-content:start;`;

    // Footer with Add Selected + Regenerate Cache buttons
    const footer = document.createElement("div");
    footer.style.cssText = `padding:12px 20px;border-top:1px solid rgba(255,255,255,0.1);
        display:flex;justify-content:space-between;gap:10px;align-items:center;`;

    // Left side: Regenerate Cache
    const regenBtn = document.createElement("button");
    regenBtn.textContent = "\u267B\uFE0F Regenerate Cache";
    regenBtn.style.cssText = `background:rgba(255,255,255,0.08);border:none;border-radius:6px;
        color:#888;padding:8px 16px;cursor:pointer;font-size:12px;`;
    regenBtn.onmouseenter = () => { regenBtn.style.background = "rgba(255,255,255,0.15)"; };
    regenBtn.onmouseleave = () => { regenBtn.style.background = "rgba(255,255,255,0.08)"; };
    regenBtn.onclick = (e) => {
        e.stopPropagation();
        clearThumbnailCache();
        loadGrid();
    };

    // Right side: Cancel + Add Selected
    const rightBtns = document.createElement("div");
    rightBtns.style.cssText = "display:flex;gap:10px;align-items:center;";
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Selected";
    addBtn.style.cssText = `background:rgba(50,112,163,0.9);border:none;border-radius:6px;color:#fff;
        padding:8px 20px;cursor:pointer;font-size:13px;`;
    addBtn.onmouseenter = () => { addBtn.style.background = "rgba(66,153,225,0.9)"; };
    addBtn.onmouseleave = () => { addBtn.style.background = "rgba(50,112,163,0.9)"; };
    addBtn.onclick = () => {
        const newFiles = [...selected].filter(
            (f) => !existingClips.some((c) => c.file === f)
        );
        onDone(newFiles, _currentSourceFolder);
        overlay.remove();
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `background:rgba(255,255,255,0.1);border:none;border-radius:6px;
        color:#ccc;padding:8px 16px;cursor:pointer;font-size:13px;`;
    cancelBtn.onclick = () => overlay.remove();
    rightBtns.appendChild(cancelBtn);
    rightBtns.appendChild(addBtn);
    footer.appendChild(regenBtn);
    footer.appendChild(rightBtns);

    modal.appendChild(header);
    modal.appendChild(breadcrumb);
    modal.appendChild(filterBar);
    modal.appendChild(grid);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.oncontextmenu = (e) => e.preventDefault();
    document.body.appendChild(overlay);

    // Filter
    searchInput.oninput = () => {
        const q = searchInput.value.toLowerCase();
        grid.querySelectorAll(".vcj-item").forEach((el) => {
            const fn = (el.dataset.filename || "").toLowerCase();
            el.style.display = fn.includes(q) ? "flex" : "none";
        });
    };

    async function loadGrid() {
        breadcrumb.textContent = _currentSubfolder
            ? `${_currentSourceFolder}/${_currentSubfolder}/`
            : `${_currentSourceFolder}/`;
        grid.innerHTML = '<div style="text-align:center;padding:40px;color:#aaa;">Loading...</div>';

        try {
            const resp = await fetch(
                `/fbnodes/list-files?source=${encodeURIComponent(_currentSourceFolder)}`
            );
            const data = await resp.json();
            grid.innerHTML = "";

            const allFiles = (data.files || []).filter((f) => f !== "(none)");
            const prefix = _currentSubfolder ? _currentSubfolder + "/" : "";
            const currentFiles = [];
            const subfolders = new Set();
            allFiles.forEach((fp) => {
                if (!fp.startsWith(prefix)) return;
                const remainder = fp.substring(prefix.length);
                const si = remainder.indexOf("/");
                if (si === -1) currentFiles.push(fp);
                else subfolders.add(remainder.substring(0, si));
            });

            // Back button
            if (_currentSubfolder) {
                const back = makeGridItem("←", "Back", false, false);
                back.onclick = () => {
                    const parts = _currentSubfolder.split("/");
                    parts.pop();
                    _currentSubfolder = parts.join("/");
                    loadGrid();
                };
                grid.appendChild(back);
            }

            // Folders
            [...subfolders].sort().forEach((name) => {
                const item = makeGridItem("📁", name, false, false);
                item.onclick = () => {
                    _currentSubfolder = _currentSubfolder ? `${_currentSubfolder}/${name}` : name;
                    loadGrid();
                };
                grid.appendChild(item);
            });

            // Files (only mp4 and latent)
            currentFiles
                .filter((f) => {
                    const ext = f.split(".").pop().toLowerCase();
                    return ["mp4", "webm", "mov", "avi", "latent"].includes(ext);
                })
                .forEach((filename) => {
                    const checked = selected.has(filename);
                    const basename = filename.includes("/") ? filename.split("/").pop() : filename;
                    const item = makeGridItem(null, basename, true, checked);
                    item.classList.add("vcj-item");
                    item.dataset.filename = filename;

                    // Thumbnail
                    const preview = item.querySelector(".vcj-preview");
                    if (isVideoFile(filename)) {
                        extractVideoThumbnailCached(filename, preview);
                        // Right-click to refresh individual thumbnail
                        item.oncontextmenu = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            showThumbnailContextMenu(e, filename, preview);
                            return false;
                        };
                    }

                    const cb = item.querySelector(".vcj-cb");
                    cb.checked = checked;
                    item.onclick = () => {
                        cb.checked = !cb.checked;
                        if (cb.checked) selected.add(filename);
                        else selected.delete(filename);
                        item.style.borderColor = cb.checked
                            ? "rgba(66,153,225,0.9)"
                            : "rgba(226,232,240,0.2)";
                    };
                    grid.appendChild(item);
                });

            if (grid.childElementCount === 0) {
                grid.innerHTML = '<div style="text-align:center;padding:40px;color:#aaa;">No clips found</div>';
            }
        } catch (err) {
            grid.innerHTML =
                '<div style="text-align:center;padding:40px;color:#f66;">Error loading files</div>';
        }
    }

    loadGrid();
}

function makeGridItem(icon, label, hasCheckbox, checked) {
    const item = document.createElement("div");
    item.style.cssText = `
        background:rgba(45,55,72,0.7);border:1px solid ${checked ? "rgba(66,153,225,0.9)" : "rgba(226,232,240,0.2)"};
        border-radius:6px;padding:8px;cursor:pointer;transition:all 0.15s ease;
        display:flex;flex-direction:column;gap:6px;position:relative;
    `;
    const preview = document.createElement("div");
    preview.className = "vcj-preview";
    preview.style.cssText = `width:100%;height:150px;background:rgba(0,0,0,0.5);
        border-radius:4px;display:flex;align-items:center;justify-content:center;
        overflow:hidden;position:relative;font-size:48px;`;
    if (icon) preview.textContent = icon;
    item.appendChild(preview);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;";
    if (hasCheckbox) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "vcj-cb";
        cb.checked = !!checked;
        cb.style.cssText = "pointer-events:none;";
        row.appendChild(cb);
    }
    const lbl = document.createElement("div");
    lbl.textContent = label;
    lbl.title = label;
    lbl.style.cssText = `font-size:11px;color:#ccc;white-space:nowrap;overflow:hidden;
        text-overflow:ellipsis;flex:1;`;
    row.appendChild(lbl);
    item.appendChild(row);

    item.onmouseenter = () => {
        if (!checked) item.style.background = "rgba(50,112,163,0.5)";
    };
    item.onmouseleave = () => {
        item.style.background = "rgba(45,55,72,0.7)";
    };
    return item;
}

// ── Hover thumbnail popup ────────────────────────────────────────────────────

let _hoverPopup = null;

function showHoverThumbnail(filename, sourceFolder, anchorRect, overrideUrl) {
    hideHoverThumbnail();
    const popup = document.createElement("div");
    popup.style.cssText = `
        position:fixed;z-index:10001;pointer-events:none;
        background:rgba(20,20,20,0.95);border:1px solid rgba(255,255,255,0.2);
        border-radius:6px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,0.6);
    `;
    // Position above anchor
    popup.style.left = anchorRect.left + "px";
    popup.style.bottom = (window.innerHeight - anchorRect.top + 4) + "px";

    if (overrideUrl) {
        // Use server-generated thumbnail (for yuv444 etc.)
        const img = document.createElement("img");
        img.style.cssText = "max-width:320px;max-height:240px;border-radius:4px;";
        img.src = overrideUrl;
        popup.appendChild(img);
    } else if (isVideoFile(filename)) {
        const vid = document.createElement("video");
        vid.crossOrigin = "anonymous";
        vid.muted = true;
        vid.autoplay = true;
        vid.loop = true;
        vid.style.cssText = "max-width:320px;max-height:240px;border-radius:4px;";

        const showUnable = () => {
            if (popup.parentElement) {
                popup.innerHTML = '';
                const msg = document.createElement("span");
                msg.textContent = "Preview N/A (codec not supported by browser)";
                msg.style.cssText = "font-size:11px;color:#888;padding:12px 16px;white-space:nowrap;";
                popup.appendChild(msg);
            }
        };

        vid.onerror = showUnable;

        // Detect black frame (unsupported codec) after first frame renders
        let checked = false;
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
                        if (d[i] > 2 || d[i+1] > 2 || d[i+2] > 2) { allBlack = false; break; }
                    }
                    if (allBlack) showUnable();
                } catch (_) {}
            }, 80);
        });

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

// ── Node extension ───────────────────────────────────────────────────────────

app.registerExtension({
    name: "FBnodes.VACEStitcher",

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "VACEStitcher") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            // ── locate widgets ──
            const clipListWidget = node.widgets?.find((w) => w.name === "clip_list");
            const sourceFolderWidget = node.widgets?.find((w) => w.name === "source_folder");

            if (!clipListWidget) return result;

            // Hide the raw JSON widget
            clipListWidget.type = "converted-widget";
            clipListWidget.computeSize = () => [0, -4];
            clipListWidget.hidden = true;

            // ── internal state ──
            // Each entry: { file: "relative/path.mp4", enabled: true }
            let clipEntries = [];
            try {
                const parsed = JSON.parse(clipListWidget.value || "[]");
                if (Array.isArray(parsed)) clipEntries = parsed;
            } catch (_) {}

            function syncWidget() {
                clipListWidget.value = JSON.stringify(clipEntries);
            }

            // ── Build UI widgets ──

            // "Browse Clips" button
            const browseIdx = node.widgets.indexOf(clipListWidget);
            const browseBtn = {
                type: "button",
                name: "\uD83D\uDCC1 Browse Clips",
                value: null,
                callback: () => {
                    const sf = sourceFolderWidget?.value || "input";
                    openClipBrowserModal(sf, clipEntries, (newFiles, sourceFolder) => {
                        for (const f of newFiles) {
                            clipEntries.push({ file: f, enabled: true, source: sourceFolder });
                        }
                        syncWidget();
                        rebuildClipListDisplay();
                    });
                },
                serialize: false,
            };
            node.widgets.splice(browseIdx + 1, 0, browseBtn);
            Object.defineProperty(browseBtn, "node", { value: node });

            // ── Clip list section (single DOM widget with header, scrollable list, footer) ──
            const sectionContainer = document.createElement("div");
            sectionContainer.style.cssText = `
                display:flex;flex-direction:column;width:100%;height:100%;
                box-sizing:border-box;
                background:rgba(40,44,52,0.6);border-radius:6px;
                border:1px solid rgba(255,255,255,0.08);overflow:hidden;
            `;

            // Section header
            const sectionHeader = document.createElement("div");
            sectionHeader.style.cssText = `
                display:flex;justify-content:space-between;align-items:center;
                padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.1);
                flex-shrink:0;
            `;
            const sectionTitle = document.createElement("span");
            sectionTitle.textContent = "Clip List";
            sectionTitle.style.cssText = "font-size:12px;font-weight:bold;color:#aaa;";
            const clipCountLabel = document.createElement("span");
            clipCountLabel.style.cssText = "font-size:10px;color:#666;";
            sectionHeader.appendChild(sectionTitle);
            sectionHeader.appendChild(clipCountLabel);
            sectionContainer.appendChild(sectionHeader);

            // Scrollable clip list area
            const clipListContainer = document.createElement("div");
            clipListContainer.style.cssText = `
                flex:1;overflow-y:auto;padding:4px 6px;display:flex;
                flex-direction:column;gap:2px;min-height:0;
            `;
            sectionContainer.appendChild(clipListContainer);

            // Footer with Delete Intermediates button
            const sectionFooter = document.createElement("div");
            sectionFooter.style.cssText = `
                padding:6px 8px;border-top:1px solid rgba(255,255,255,0.1);
                flex-shrink:0;
            `;
            const deleteBtn = document.createElement("button");
            deleteBtn.textContent = "\uD83D\uDDD1\uFE0F Delete Transitions";
            deleteBtn.style.cssText = `
                width:100%;padding:5px 12px;border:none;border-radius:4px;
                font-size:11px;cursor:default;
                background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.3);
                transition:background 0.15s, color 0.15s;
            `;
            deleteBtn.disabled = true;
            sectionFooter.appendChild(deleteBtn);
            sectionContainer.appendChild(sectionFooter);

            const sectionWidget = node.addDOMWidget(
                "clip_list_section",
                "customwidget",
                sectionContainer,
                { serialize: false, hideOnZoom: false }
            );

            // Ensure the ComfyUI wrapper div also stretches to fill
            // (ComfyUI wraps DOM widgets in a div with overflow:hidden)
            if (sectionContainer.parentElement) {
                sectionContainer.parentElement.style.overflow = "visible";
            }
            // Also try after a tick (widget may not be mounted yet)
            requestAnimationFrame(() => {
                if (sectionContainer.parentElement) {
                    sectionContainer.parentElement.style.overflow = "visible";
                    sectionContainer.parentElement.style.height = "100%";
                }
            });

            // computeSize: fixed height based on clip count, min 3 rows, max 10 rows
            sectionWidget.computeSize = function (width) {
                const ROW_H = 30;
                const HEADER_FOOTER = 78;
                const visibleRows = Math.max(3, Math.min(10, clipEntries.length));
                const h = HEADER_FOOTER + visibleRows * ROW_H;
                return [width, h];
            };

            // ── Delete button state management ──
            async function updateDeleteBtnState() {
                try {
                    const info = await (await fetch("/fbnodes/vace-intermediates-info")).json();
                    if (info.exists && info.total_files > 0) {
                        deleteBtn.disabled = false;
                        deleteBtn.style.background = "rgba(200,60,60,0.2)";
                        deleteBtn.style.color = "rgba(255,130,130,0.8)";
                        deleteBtn.style.cursor = "pointer";
                        deleteBtn.title = `${info.total_files} cached transition(s) in ${info.dirs} set(s)`;
                    } else {
                        deleteBtn.disabled = true;
                        deleteBtn.style.background = "rgba(255,255,255,0.06)";
                        deleteBtn.style.color = "rgba(255,255,255,0.3)";
                        deleteBtn.style.cursor = "default";
                        deleteBtn.title = "No cached intermediates";
                    }
                } catch (_) {
                    deleteBtn.disabled = true;
                }
            }

            deleteBtn.onclick = async () => {
                if (deleteBtn.disabled) return;
                try {
                    const info = await (await fetch("/fbnodes/vace-intermediates-info")).json();
                    if (!info.exists || info.total_files === 0) {
                        updateDeleteBtnState();
                        return;
                    }
                    const confirmed = await showConfirm(
                        "Delete Transitions",
                        `Delete ${info.total_files} cached transition(s) in ${info.dirs} set(s)?`,
                        "Delete", "#c00"
                    );
                    if (!confirmed) return;
                    const resp = await (await fetch("/fbnodes/vace-delete-intermediates", { method: "POST" })).json();
                    if (resp.success) {
                        console.log(`[VACEClipJoiner] Deleted ${resp.deleted} intermediate set(s).`);
                    }
                    updateDeleteBtnState();
                    // Mark node as needing re-execution
                    if (clipListWidget) {
                        clipListWidget.value = clipListWidget.value; // trigger dirty
                    }
                } catch (err) {
                    console.error("[VACEClipJoiner] Error deleting intermediates:", err);
                }
            };
            deleteBtn.onmouseenter = () => {
                if (!deleteBtn.disabled) deleteBtn.style.background = "rgba(200,60,60,0.35)";
            };
            deleteBtn.onmouseleave = () => {
                if (!deleteBtn.disabled) deleteBtn.style.background = "rgba(200,60,60,0.2)";
            };

            updateDeleteBtnState();
            setInterval(updateDeleteBtnState, 30000);

            // ── Drag reorder state ──
            let _dragIdx = null;
            let _dragOverIdx = null;
            let _dragPlaceholder = null;

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
                    node.setDirtyCanvas(true, true);
                    return;
                }

                clipEntries.forEach((entry, idx) => {
                    const isEnabled = entry.enabled !== false;

                    // Row colors matching Prompt Manager blue scheme
                    const bgColor = isEnabled
                        ? "rgba(50, 112, 163, 0.35)"
                        : "rgba(45, 55, 72, 0.5)";
                    const borderColor = isEnabled
                        ? "rgba(66, 153, 225, 0.4)"
                        : "rgba(226, 232, 240, 0.1)";
                    const textColor = isEnabled
                        ? "rgba(226, 232, 240, 0.95)"
                        : "rgba(226, 232, 240, 0.4)";

                    const row = document.createElement("div");
                    row.dataset.clipIdx = idx;
                    row.style.cssText = `
                        display:flex;align-items:center;gap:4px;padding:3px 4px;
                        background:${bgColor};border-radius:4px;
                        border:1px solid ${borderColor};
                        font-size:11px;color:${textColor};min-height:24px;
                        transition:background 0.15s ease, border-color 0.15s ease;
                    `;

                    // Drag handle (6-dot grip)
                    const grip = document.createElement("div");
                    grip.title = "Drag to reorder";
                    grip.style.cssText = `
                        flex-shrink:0;width:16px;height:20px;cursor:grab;
                        display:flex;align-items:center;justify-content:center;
                        color:rgba(255,255,255,0.3);font-size:11px;user-select:none;
                        letter-spacing:2px;line-height:1;
                    `;
                    grip.textContent = "\u22EE\u22EE";
                    grip.onmouseenter = () => { grip.style.color = "rgba(66,153,225,0.9)"; };
                    grip.onmouseleave = () => { grip.style.color = "rgba(255,255,255,0.3)"; };

                    // Drag events on grip
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
                                // Show visual indicator
                                rows.forEach((r) => {
                                    const ri = parseInt(r.dataset.clipIdx);
                                    r.style.borderTop = ri === overIdx && overIdx < _dragIdx
                                        ? "2px solid rgba(66,153,225,0.9)" : "";
                                    r.style.borderBottom = ri === overIdx && overIdx > _dragIdx
                                        ? "2px solid rgba(66,153,225,0.9)" : "";
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
                                // Reset visual
                                const rows = clipListContainer.querySelectorAll("[data-clip-idx]");
                                rows.forEach((r) => {
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
                        entry.enabled = cb.checked;
                        syncWidget();
                        rebuildClipListDisplay();
                    };
                    row.appendChild(cb);

                    // Filename label
                    const basename = entry.file.includes("/")
                        ? entry.file.split("/").pop()
                        : entry.file;
                    const lbl = document.createElement("span");
                    lbl.textContent = basename;
                    lbl.title = `[${entry.source || "input"}] ${entry.file}`;
                    lbl.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;
                        white-space:nowrap;color:${textColor};cursor:default;`;

                    // Hover thumbnail on label
                    lbl.onmouseenter = (e) => {
                        const sf = entry.source || sourceFolderWidget?.value || "input";
                        const rect = lbl.getBoundingClientRect();
                        showHoverThumbnail(entry.file, sf, rect, entry._thumbUrl);
                    };
                    lbl.onmouseleave = () => hideHoverThumbnail();
                    row.appendChild(lbl);

                    // Remove button
                    const removeBtn = document.createElement("button");
                    removeBtn.textContent = "\u2715";
                    removeBtn.title = "Remove clip";
                    removeBtn.style.cssText = `
                        background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;
                        font-size:10px;padding:0 3px;width:18px;height:18px;flex-shrink:0;
                        display:flex;align-items:center;justify-content:center;border-radius:3px;
                        transition:color 0.15s, background 0.15s;
                    `;
                    removeBtn.onmouseenter = () => {
                        removeBtn.style.color = "#f66";
                        removeBtn.style.background = "rgba(255,100,100,0.15)";
                    };
                    removeBtn.onmouseleave = () => {
                        removeBtn.style.color = "rgba(255,100,100,0.6)";
                        removeBtn.style.background = "none";
                    };
                    removeBtn.onclick = () => {
                        clipEntries.splice(idx, 1);
                        syncWidget();
                        rebuildClipListDisplay();
                    };
                    row.appendChild(removeBtn);

                    // Right-click context menu on row
                    row.oncontextmenu = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showClipContextMenu(e.clientX, e.clientY, entry, idx);
                    };

                    // Hover highlight
                    row.onmouseenter = () => {
                        if (_dragIdx === null) {
                            row.style.background = isEnabled
                                ? "rgba(50, 112, 163, 0.55)"
                                : "rgba(50, 112, 163, 0.25)";
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

                // Update node height
                node.setDirtyCanvas(true, true);
            }

            // ── Right-click context menu for clips ──
            function showClipContextMenu(x, y, entry, idx) {
                // Remove any existing context menu
                document.querySelectorAll(".vcj-context-menu").forEach((m) => m.remove());

                const menu = document.createElement("div");
                menu.className = "vcj-context-menu";
                menu.style.cssText = `
                    position:fixed;left:${x}px;top:${y}px;z-index:10002;
                    background:rgba(40,44,52,0.98);border:1px solid rgba(255,255,255,0.15);
                    border-radius:6px;padding:4px 0;min-width:180px;
                    box-shadow:0 4px 16px rgba(0,0,0,0.6);font-size:12px;
                `;

                function addMenuItem(label, onClick) {
                    const item = document.createElement("div");
                    item.textContent = label;
                    item.style.cssText = `padding:6px 14px;color:#ccc;cursor:pointer;`;
                    item.onmouseenter = () => { item.style.background = "rgba(66,153,225,0.3)"; };
                    item.onmouseleave = () => { item.style.background = "none"; };
                    item.onclick = () => { menu.remove(); onClick(); };
                    menu.appendChild(item);
                }

                addMenuItem("\u267B\uFE0F Regenerate Transitions", async () => {
                    try {
                        const info = await (await fetch("/fbnodes/vace-intermediates-info")).json();
                        if (!info.exists || info.total_files === 0) return;
                        if (!confirm(`Delete all cached transitions so they regenerate on next run?`)) return;
                        await fetch("/fbnodes/vace-delete-intermediates", { method: "POST" });
                        console.log("[VACEClipJoiner] Cache cleared for regeneration");
                    } catch (err) {
                        console.error("[VACEClipJoiner] Error:", err);
                    }
                });

                addMenuItem("\uD83D\uDDBC\uFE0F Refresh Thumbnail", () => {
                    const sf = entry.source || sourceFolderWidget?.value || "input";
                    const thumbUrl = getThumbnailUrl(entry.file, sf, 320) + `&${Date.now()}`;
                    // Store the server-generated thumbnail URL on the entry for hover
                    entry._thumbUrl = thumbUrl;
                    // Show it immediately as a hover preview
                    const rect = clipListContainer.querySelector(`[data-clip-idx="${idx}"]`)?.getBoundingClientRect();
                    if (rect) {
                        showHoverThumbnail(entry.file, sf, rect, thumbUrl);
                    }
                });

                addMenuItem(entry.enabled !== false ? "\u23F8 Disable Clip" : "\u25B6 Enable Clip", () => {
                    entry.enabled = entry.enabled === false;
                    syncWidget();
                    rebuildClipListDisplay();
                });

                addMenuItem("\u2715 Remove Clip", () => {
                    clipEntries.splice(idx, 1);
                    syncWidget();
                    rebuildClipListDisplay();
                });

                // Close on click outside
                const closeMenu = (e) => {
                    if (!menu.contains(e.target)) {
                        menu.remove();
                        document.removeEventListener("mousedown", closeMenu);
                    }
                };
                setTimeout(() => document.addEventListener("mousedown", closeMenu), 0);

                document.body.appendChild(menu);
            }

            // ── Source folder change: just controls which folder to browse next ──
            if (sourceFolderWidget) {
                const origCb = sourceFolderWidget.callback;
                sourceFolderWidget.callback = function (value) {
                    if (origCb) origCb.apply(this, arguments);
                    // Don't clear clips on source change — each clip stores its own source
                };
            }

            // ── Restore on configure (workflow load) ──
            const onConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                const res = onConfigure ? onConfigure.apply(this, arguments) : undefined;
                try {
                    const parsed = JSON.parse(clipListWidget.value || "[]");
                    if (Array.isArray(parsed)) clipEntries = parsed;
                } catch (_) {
                    clipEntries = [];
                }
                rebuildClipListDisplay();
                return res;
            };

            // Initial render
            setTimeout(() => rebuildClipListDisplay(), 50);

            return result;
        };
    },
});
