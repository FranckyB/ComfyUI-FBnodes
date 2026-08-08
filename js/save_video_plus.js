import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CONTROLS_TOGGLE_WIDGET_KEY = "__fb_save_video_controls_toggle";
const CONTROLS_EXPANDED_PROP = "_saveVideoControlsExpanded";
const CONTROLS_COLLAPSED_SIZE_PROP = "_saveVideoCollapsedSize";
// Serialized widget carrying the last execution result, so the preview can be
// restored after tab switches and workflow reloads (custom node.properties
// keys are not persisted into workflow JSON by ComfyUI).
const LAST_RESULT_WIDGET_NAME = "_fbSaveVideoLastResult";
// Hidden widget the UI stamps with the Execute timestamp (unix seconds) at
// queue time; Python reads it to expand %time% in filename_prefix.
const EXEC_START_WIDGET_NAME = "exec_start";
// Same creation/minimum footprint as LoadVideoPlus.
const SAVE_VIDEO_MIN_WIDTH = 300;
const SAVE_VIDEO_MIN_HEIGHT = 320;

function hideExecStartWidget(node) {
    const widget = node.widgets?.find((w) => w?.name === EXEC_START_WIDGET_NAME);
    if (!widget) return;
    widget.type = "converted-widget";
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

// Stamp every SaveVideoPlus node with the current timestamp right before the
// prompt is serialized (widget values are captured at queue time, so this must
// wrap queuePrompt — the server's execution_start event arrives too late).
let _execStartStampingInstalled = false;
function installExecStartStamping() {
    if (_execStartStampingInstalled) return;
    _execStartStampingInstalled = true;
    const originalQueuePrompt = app.queuePrompt;
    if (typeof originalQueuePrompt !== "function") return;
    app.queuePrompt = async function (...args) {
        const nowSec = (Date.now() / 1000).toFixed(3);
        for (const node of app.graph?._nodes || []) {
            if (node?.type !== "SaveVideoPlus") continue;
            const widget = node.widgets?.find((w) => w?.name === EXEC_START_WIDGET_NAME);
            if (widget) widget.value = nowSec;
        }
        return originalQueuePrompt.apply(this, args);
    };
}

function firstValue(value) {
    if (Array.isArray(value)) return value[0];
    return value;
}

function normalizeBool(value) {
    const raw = firstValue(value);
    if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
            return true;
        }
        if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off" || normalized === "") {
            return false;
        }
    }
    return !!raw;
}

function extractExecutionPayload(message) {
    if (!message || typeof message !== "object") {
        return {};
    }

    const candidates = [
        message,
        message.ui,
        message.output,
        message.data,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") {
            continue;
        }

        if (candidate.saved_video_path !== undefined || candidate.needs_external_player !== undefined) {
            return candidate;
        }
    }

    return message;
}

function hasSavedPath(node) {
    const hasPath = typeof node.properties?._lastSavedVideoPath === "string" && node.properties._lastSavedVideoPath.length > 0;
    return hasPath;
}

function openInSystemPlayer(node) {
    const path = node.properties?._lastSavedVideoPath;
    if (!path) return;

    api.fetchApi("/fbnodes/open-in-player", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
    }).then(async (resp) => {
        if (resp.ok) return;
        let message = `Request failed (${resp.status})`;
        try {
            const body = await resp.json();
            if (body?.error) message = body.error;
        } catch {
            // ignore
        }
        console.warn("[SaveVideoPlus] Could not open in system player:", message);
    }).catch((error) => {
        console.warn("[SaveVideoPlus] Could not open in system player:", error);
    });
}

function updateDisplayState(node) {
    const needsExternal = !!node.properties?._needsExternalPlayer;
    node._saveVideoShowCompatWarning = !!needsExternal;
}

// Reads the Python node's auto_play BOOLEAN widget (default true, matching Python).
function isAutoPlayEnabled(node) {
    const widget = node.widgets?.find((w) => w?.name === "auto_play");
    if (!widget) return true;
    return normalizeBool(widget.value);
}

function payloadHasVideoResult(payload) {
    return payload?.saved_video_path !== undefined || payload?.needs_external_player !== undefined;
}

function setResultData(node, message) {
    const payload = extractExecutionPayload(message);
    if (!payloadHasVideoResult(payload)) {
        return false;
    }

    if (!node.properties) node.properties = {};
    ensurePreviewContainer(node);

    const savedPath = firstValue(payload?.saved_video_path);
    if (typeof savedPath === "string") {
        node.properties._lastSavedVideoPath = savedPath;
    }

    const needsExternal = firstValue(payload?.needs_external_player);
    if (typeof needsExternal !== "undefined") {
        node.properties._needsExternalPlayer = normalizeBool(needsExternal);
    }

    // A new execution result invalidates any restored-preview URL snapshot,
    // so the watcher in onDrawForeground will swap in the fresh video.
    node._saveVideoRestoredUrl = null;

    updateDisplayState(node);
    persistLastResultWidget(node);
    ensureMinWarningDisplaySize(node);
    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
    return true;
}

// Mirrors node.properties into a hidden serialized widget so the last result
// survives workflow save/load (ComfyUI does not persist custom properties).
function persistLastResultWidget(node) {
    const widget = node.widgets?.find((w) => w?.name === LAST_RESULT_WIDGET_NAME);
    if (!widget) return;

    const path = node.properties?._lastSavedVideoPath;
    if (typeof path === "string" && path.length > 0) {
        widget.value = JSON.stringify({
            path,
            needsExternal: !!node.properties?._needsExternalPlayer,
        });
    } else {
        widget.value = "";
    }
}

function restoreLastResultFromWidget(node) {
    const widget = node.widgets?.find((w) => w?.name === LAST_RESULT_WIDGET_NAME);
    const raw = widget?.value;
    if (typeof raw !== "string" || !raw) return false;

    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }
    if (!parsed || typeof parsed.path !== "string" || !parsed.path) return false;

    if (!node.properties) node.properties = {};
    node.properties._lastSavedVideoPath = parsed.path;
    node.properties._needsExternalPlayer = !!parsed.needsExternal;
    updateDisplayState(node);
    return true;
}

function ensureLastResultWidget(node) {
    const existing = node.widgets?.find((w) => w?.name === LAST_RESULT_WIDGET_NAME);
    if (existing) {
        // Already present (e.g. restored from a saved workflow) — enforce that
        // it stays hidden even if it was serialized while Controls was expanded.
        existing.hidden = true;
        existing.computeSize = () => [0, -4];
        if (existing.inputEl) existing.inputEl.style.display = "none";
        return;
    }
    const widget = node.addWidget("text", LAST_RESULT_WIDGET_NAME, "", null, { serialize: true });
    widget.serialize = true;
    // Fully hide: collapse layout height AND hide the DOM input element so it
    // never renders as a visible row in the node.
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    const hideInput = () => { if (widget.inputEl) widget.inputEl.style.display = "none"; };
    // inputEl may not exist yet at creation time; hide it once it does.
    if (widget.inputEl) hideInput();
    else setTimeout(hideInput, 0);
}

// Builds the /view URL used to re-render the video element from the persisted
// saved path. Absolute and output-rooted paths both resolve via type=output.
function buildSavedVideoViewUrl(savedPath) {
    if (!savedPath) return null;
    const normalized = String(savedPath).replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    const filename = lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
    const subfolder = lastSlash >= 0 ? normalized.substring(0, lastSlash) : "";
    if (!filename) return null;
    let url = `/view?filename=${encodeURIComponent(filename)}&type=output`;
    if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
    return url;
}

// Rebuilds the preview player from the persisted saved path when ComfyUI core
// did not restore its own video element (tab switch / workflow reload).
// Returns true when a video element exists (ours or core's).
function ensureRestoredVideoPreview(node) {
    const container = getPreviewContainer(node);
    if (!container) return false;
    if (container.querySelector("video")) return true;

    const url = buildSavedVideoViewUrl(node.properties?._lastSavedVideoPath);
    if (!url) return false;

    ensurePreviewFrame(container);
    const mediaHost = container._previewMediaHost || container;

    const vid = document.createElement("video");
    vid.playsInline = true;
    vid.controls = true;
    vid.loop = true;
    // Mirror core's native preview sizing (.comfy-img-preview video rule),
    // since our element lives inside a nested media host.
    vid.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
    vid.src = url;
    mediaHost.appendChild(vid);
    node._saveVideoRestoredUrl = url;
    syncPreviewFooterFromVideo(node);
    return true;
}

function scheduleRestoredVideoPreview(node, attempts = 0) {
    if (ensureRestoredVideoPreview(node)) {
        node.setDirtyCanvas?.(true, true);
        return;
    }
    if (attempts < 20) {
        setTimeout(() => scheduleRestoredVideoPreview(node, attempts + 1), 100);
    }
}

// If the saved path changed (a new execution result arrived while this node
// was hidden in a subgraph, so core's native preview never updated here),
// rebuild our restored player to point at the new video.
function syncRestoredPreviewUrl(node) {
    const container = getPreviewContainer(node);
    const vid = container?.querySelector("video") || null;
    if (!vid || !container?._previewMediaHost || vid.parentElement !== container._previewMediaHost) return;

    const url = buildSavedVideoViewUrl(node.properties?._lastSavedVideoPath);
    if (!url || url === node._saveVideoRestoredUrl) return;

    try { vid.pause(); } catch { /* ignore */ }
    vid.remove();
    node._saveVideoRestoredUrl = null;
    ensureRestoredVideoPreview(node);
}

const _fbSaveVideoExecutedCache = new Map();
let _fbSaveVideoExecutedListenerInstalled = false;

function cacheExecutedPayload(detail) {
    const nodeId = detail?.node;
    if (nodeId === undefined || nodeId === null) {
        return;
    }

    const payload = extractExecutionPayload(detail?.output);
    if (!payloadHasVideoResult(payload)) {
        return;
    }

    _fbSaveVideoExecutedCache.set(String(nodeId), payload);
}

function restoreFromExecutedCache(node) {
    const nodeId = node?.id;
    if (nodeId === undefined || nodeId === null) {
        return false;
    }

    const cached = _fbSaveVideoExecutedCache.get(String(nodeId));
    if (!cached) {
        return false;
    }

    return setResultData(node, cached);
}

function installExecutedSync() {
    if (_fbSaveVideoExecutedListenerInstalled) {
        return;
    }
    _fbSaveVideoExecutedListenerInstalled = true;

    api.addEventListener("executed", (event) => {
        cacheExecutedPayload(event?.detail || {});
    });
}

function getWidgetHeight(node, widget) {
    if (widget?.hidden) return 0;
    if (typeof widget?.computeSize === "function") {
        try {
            const size = widget.computeSize(Number(node.size?.[0] || 320));
            if (Array.isArray(size) && Number.isFinite(size[1])) {
                return Number(size[1]);
            }
        } catch {
            return Number(LiteGraph?.NODE_WIDGET_HEIGHT || 24);
        }
    }
    return Number(LiteGraph?.NODE_WIDGET_HEIGHT || 24);
}

function getContentStartY(node) {
    const titleH = Number(LiteGraph?.NODE_TITLE_HEIGHT || 30);
    let y = titleH + 6;
    for (const widget of node.widgets || []) {
        // Stop at preview widget; we only want the controls stack height.
        if (widget?.name === "video-preview") {
            break;
        }
        y += getWidgetHeight(node, widget) + 4;
    }
    return y + 4;
}

function ensureMinWarningDisplaySize(node) {
    if (!node?._saveVideoShowCompatWarning) return false;

    const contentTop = getContentStartY(node);
    const minWarningAreaH = 140;
    const footerReserved = 84; // leave room for native video control strip
    const minBottomPad = 14;
    const minW = 460;
    const minH = Math.ceil(contentTop + minWarningAreaH + footerReserved + minBottomPad);

    const curW = Number(node.size?.[0] || 0);
    const curH = Number(node.size?.[1] || 0);
    const nextW = Math.max(curW, minW);
    const nextH = Math.max(curH, minH);

    if (nextW !== curW || nextH !== curH) {
        node.size = [nextW, nextH];
        node.setDirtyCanvas?.(true, true);
        return true;
    }

    return false;
}

function getPreviewContainer(node) {
    return node.videoContainer
        || node.widgets?.find((w) => w.name === "video-preview")?.element
        || null;
}

// Blue framed media area, mirroring LoadVideoPlus's preview host.
// The footer lives outside the frame so the native video control strip
// never overlaps it. Core wipes container children via replaceChildren()
// when the native video loads, so this re-applies idempotently and
// re-inserts the native video back inside the frame's media host.
function ensurePreviewFrame(container) {
    if (!container) return;

    if (!container.style.position) container.style.position = "relative";

    let frame = container._previewFrame;
    if (!frame || frame.parentElement !== container) {
        frame = document.createElement("div");
        frame.className = "fbnodes-save-video-frame";
        frame.style.cssText = `
            position: absolute; left: 8px; top: 8px; right: 8px; bottom: 34px;
            overflow: hidden; background: rgba(34, 39, 48, 0.98);
            border: 1px solid rgba(78, 90, 108, 0.72); border-radius: 10px;
            box-sizing: border-box;
        `;

        const mediaHost = document.createElement("div");
        mediaHost.className = "fbnodes-save-video-media-host";
        mediaHost.style.cssText = `
            position: absolute; left: 1px; top: 1px; right: 1px; bottom: 1px;
            overflow: hidden; background: transparent;
        `;

        frame.appendChild(mediaHost);
        container.appendChild(frame);
        container._previewFrame = frame;
        container._previewMediaHost = mediaHost;
    }

    let footer = container._previewFooter;
    if (!footer || footer.parentElement !== container) {
        footer = document.createElement("div");
        footer.className = "fbnodes-save-video-preview-footer";
        footer.style.cssText = `
            position: absolute; left: 8px; right: 8px; bottom: 8px; height: 22px;
            border-radius: 8px; border: 1px solid rgba(66, 72, 84, 0.95);
            background: rgba(34, 39, 48, 0.98); box-sizing: border-box;
            color: rgba(192, 206, 222, 0.95); font: 600 10px "Segoe UI", sans-serif;
            line-height: 20px; text-align: center; pointer-events: none;
        `;
        footer.textContent = "—";
        container.appendChild(footer);
        container._previewFooter = footer;
    }

    // Re-home the core-injected native video inside the frame if a
    // replaceChildren() call dropped it alongside our frame elements.
    const mediaHost = container._previewMediaHost;
    const nativeVideo = container.querySelector(":scope > video");
    if (nativeVideo && mediaHost && nativeVideo.parentElement !== mediaHost) {
        mediaHost.appendChild(nativeVideo);
    }
}

function setSavePreviewFooter(container, text) {
    if (container?._previewFooter) {
        container._previewFooter.textContent = text || "—";
    }
}

function ensurePreviewContainer(node) {
    let container = getPreviewContainer(node);
    if (container) {
        if (!node.videoContainer) {
            node.videoContainer = container;
        }
        ensurePreviewFrame(container);
        return container;
    }

    container = document.createElement("div");
    container.classList.add("comfy-img-preview");
    node.videoContainer = container;

    if (!node.widgets?.some((w) => w.name === "video-preview")) {
        const w = node.addDOMWidget("video-preview", "video", container, {
            canvasOnly: true,
            hideOnZoom: false,
        });
        w.serialize = false;
        w.computeLayoutSize = () => ({
            minHeight: 256,
            minWidth: 256,
        });
    }

    ensurePreviewFrame(container);
    return container;
}

function getFramePreviewUrl(node) {
    const path = node.properties?._lastSavedVideoPath;
    if (!path) return null;
    return `/fbnodes/video-frame?filename=${encodeURIComponent(path)}&source=output&position=0`;
}

function getFramePreviewLayer(host) {
    let frameImg = host?.querySelector(".fbnodes-save-video-frame-preview");
    if (frameImg) return frameImg;

    frameImg = document.createElement("img");
    frameImg.className = "fbnodes-save-video-frame-preview";
    frameImg.alt = "Video frame preview";
    frameImg.style.position = "absolute";
    frameImg.style.left = "8px";
    frameImg.style.right = "8px";
    frameImg.style.top = "12px";
    frameImg.style.bottom = "84px";
    frameImg.style.width = "calc(100% - 16px)";
    frameImg.style.height = "calc(100% - 96px)";
    frameImg.style.objectFit = "contain";
    frameImg.style.background = "transparent";
    frameImg.style.borderRadius = "4px";
    frameImg.style.pointerEvents = "none";
    frameImg.style.display = "none";
    frameImg.style.zIndex = "9";
    host.appendChild(frameImg);
    return frameImg;
}

function syncFramePreviewLayer(node, host) {
    if (!host) return;

    const frameImg = getFramePreviewLayer(host);
    const showWarning = !!node._saveVideoShowCompatWarning;
    if (!showWarning) {
        frameImg.style.display = "none";
        return;
    }

    const frameUrl = getFramePreviewUrl(node);
    if (!frameUrl) {
        frameImg.style.display = "none";
        return;
    }

    const savedPath = node.properties?._lastSavedVideoPath || "";
    if (node._saveVideoFramePreviewForPath !== savedPath) {
        node._saveVideoFramePreviewForPath = savedPath;
        frameImg.onload = () => {
            const w = frameImg.naturalWidth || 0;
            const h = frameImg.naturalHeight || 0;
            setSavePreviewFooter(host, w && h ? `${w} × ${h}` : "—");
        };
        frameImg.src = `${frameUrl}&t=${Date.now()}`;
    }

    frameImg.style.display = "block";
}

function isControlsToggleWidget(widget) {
    return !!widget?._fbSaveVideoControlsToggle || widget?.name === CONTROLS_TOGGLE_WIDGET_KEY;
}

function isPreviewWidget(widget) {
    return widget?.name === "video-preview";
}

// The internal last-result widget is a persistence vehicle only — never shown,
// never part of the collapsible Controls section.
function isLastResultWidget(widget) {
    return widget?.name === LAST_RESULT_WIDGET_NAME;
}

function getControlsExpanded(node) {
    if (typeof node.properties?.[CONTROLS_EXPANDED_PROP] !== "undefined") {
        return !!node.properties[CONTROLS_EXPANDED_PROP];
    }
    return false;
}

function getCollapsibleWidgets(node) {
    return (node.widgets || []).filter((widget) => !isControlsToggleWidget(widget) && !isPreviewWidget(widget) && !isLastResultWidget(widget));
}

function updateControlsToggleLabel(node) {
    const toggle = node.widgets?.find((w) => isControlsToggleWidget(w));
    if (!toggle) return;
    toggle.name = getControlsExpanded(node) ? "▲ Controls" : "▶ Controls";
}

function setWidgetCollapsed(widget, collapsed) {
    if (!widget) return;
    widget.hidden = !!collapsed;
    if (widget.inputEl) widget.inputEl.style.display = collapsed ? "none" : "";
}

function getControlsStackHeight(node) {
    let total = 0;
    for (const widget of getCollapsibleWidgets(node)) {
        let h = Number(LiteGraph?.NODE_WIDGET_HEIGHT || 24);
        if (typeof widget?.computeSize === "function") {
            try {
                const size = widget.computeSize(Number(node.size?.[0] || 320));
                if (Array.isArray(size) && Number.isFinite(size[1])) {
                    h = Number(size[1]);
                }
            } catch {
                // fall back to default widget height
            }
        }
        total += h + 4;
    }
    return total;
}

function applyControlsCollapsedState(node, { skipSize = false } = {}) {
    const collapsed = !getControlsExpanded(node);
    for (const widget of getCollapsibleWidgets(node)) {
        setWidgetCollapsed(widget, collapsed);
    }
    updateControlsToggleLabel(node);

    if (!skipSize) {
        const curW = Number(node.size?.[0] || 0);
        const curH = Number(node.size?.[1] || 0);
        const controlsHeight = getControlsStackHeight(node);

        if (collapsed) {
            // Remember the preview-area footprint (without the controls stack) so a later
            // expand can restore the same preview height plus the controls.
            const savedH = Math.max(1, curH - controlsHeight);
            node.properties[CONTROLS_COLLAPSED_SIZE_PROP] = [curW, savedH];

            const saved = node.properties?.[CONTROLS_COLLAPSED_SIZE_PROP];
            if (Array.isArray(saved) && saved.length >= 2) {
                const savedW = Number(saved[0]);
                const savedH2 = Number(saved[1]);
                if (Number.isFinite(savedW) && Number.isFinite(savedH2) && savedW > 0 && savedH2 > 0) {
                    node.setSize?.([savedW, savedH2]);
                }
            }
        } else {
            // Expand the node by adding the controls stack height on top of the
            // collapsed/preview footprint, instead of recomputing a smaller size.
            const saved = node.properties?.[CONTROLS_COLLAPSED_SIZE_PROP];
            let baseW = curW > 0 ? curW : 320;
            let baseH = curH > 0 ? curH : 240;
            if (Array.isArray(saved) && saved.length >= 2) {
                const savedW = Number(saved[0]);
                const savedH = Number(saved[1]);
                if (Number.isFinite(savedW) && savedW > 0) baseW = savedW;
                if (Number.isFinite(savedH) && savedH > 0) baseH = savedH;
            }
            const nextH = Math.max(curH, baseH + controlsHeight);
            if (Number.isFinite(nextH) && nextH > 0) {
                node.setSize?.([baseW, nextH]);
            }
        }
    }

    node.setDirtyCanvas?.(true, true);
}

function ensureControlsToggleWidget(node, { skipSize = false } = {}) {
    if (!node.properties) node.properties = {};

    let toggle = node.widgets?.find((w) => isControlsToggleWidget(w));
    if (!toggle) {
        toggle = node.addWidget("button", "▶ Controls", null, () => {
            const expanding = !getControlsExpanded(node);
            if (expanding) {
                node.properties[CONTROLS_COLLAPSED_SIZE_PROP] = [
                    Number(node.size?.[0] || 320),
                    Number(node.size?.[1] || 240),
                ];
            }
            node.properties[CONTROLS_EXPANDED_PROP] = !getControlsExpanded(node);
            applyControlsCollapsedState(node);
            ensureMinWarningDisplaySize(node);
            syncWarningOverlay(node);
        }, {
            serialize: false,
        });

        toggle.name = CONTROLS_TOGGLE_WIDGET_KEY;
        toggle.serialize = false;
        toggle._fbSaveVideoControlsToggle = true;
    }

    if (typeof node.properties[CONTROLS_EXPANDED_PROP] === "undefined") {
        node.properties[CONTROLS_EXPANDED_PROP] = false;
    }

    applyControlsCollapsedState(node, { skipSize });
}

function applyWarningOverlay(node) {
    const host = ensurePreviewContainer(node);
    if (!host) return false;

    ensurePreviewFrame(host);

    // Keep the warning overlay and frame preview layer anchored inside the
    // blue frame area, above the footer.
    const warningParent = host._previewFrame || host;

    syncFramePreviewLayer(node, warningParent);

    let overlay = host._warningOverlay;
    if (!overlay || overlay.parentElement !== warningParent) {
        overlay = document.createElement("div");
        overlay.className = "fbnodes-save-video-warning";
        overlay.style.position = "absolute";
        overlay.style.left = "8px";
        overlay.style.right = "8px";
        // Keep warning away from the native control strip and slightly higher.
        overlay.style.top = "12px";
        overlay.style.bottom = "84px";
        overlay.style.zIndex = "11";
        overlay.style.pointerEvents = "none";
        overlay.style.display = "none";
        overlay.style.flexDirection = "column";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.textAlign = "center";
        overlay.style.lineHeight = "1.25";
        warningParent.appendChild(overlay);
        host._warningOverlay = overlay;
    }

    if (node._saveVideoShowCompatWarning) {
        overlay.innerHTML = "";

        const line1 = document.createElement("div");
        line1.textContent = "Video not compatible with browser";
        line1.style.font = "600 16px sans-serif";
        line1.style.color = "rgba(255, 235, 235, 0.98)";

        const line2 = document.createElement("div");
        line2.textContent = "Use \u25B6 at the top to open in System Player";
        line2.style.marginTop = "8px";
        line2.style.font = "600 14px sans-serif";
        line2.style.color = "rgba(255, 235, 235, 0.92)";

        overlay.appendChild(line1);
        overlay.appendChild(line2);
        overlay.style.display = "flex";
    } else {
        overlay.innerHTML = "";
        overlay.style.display = "none";
    }

    return true;
}

function syncWarningOverlay(node, attempts = 0) {
    const applied = applyWarningOverlay(node);
    if (!applied && attempts < 10) {
        setTimeout(() => syncWarningOverlay(node, attempts + 1), 80);
    }
}

// Fill the resolution footer once the native video element reports its size.
function syncPreviewFooterFromVideo(node) {
    const container = getPreviewContainer(node);
    if (!container) return;

    const vid = container.querySelector("video");
    if (!vid) return;

    const update = () => {
        const w = vid.videoWidth || 0;
        const h = vid.videoHeight || 0;
        if (w && h) setSavePreviewFooter(container, `${w} × ${h}`);
    };

    if (vid._fbSaveVideoFooterHooked) {
        update();
        return;
    }
    vid._fbSaveVideoFooterHooked = true;
    vid.addEventListener("loadedmetadata", update);
    update();
}

// Starts playback on the freshly injected video when auto_play is enabled.
// Core replaces the <video> element on every run, so we only play an element
// that is different from the one present when execution completed — this
// avoids playing the stale clip in the window before core swaps the new one in.
function syncAutoplay(node) {
    if (!node._saveVideoPendingAutoplay) return;

    const container = getPreviewContainer(node);
    const vid = container?.querySelector("video") || null;
    if (!vid) return;

    // Wait until core has injected the FRESH video element for this run.
    // Core replaces the element after onExecuted, so the element snapshotted
    // at execution time (_saveVideoAutoplayPrevVideo) is the stale one. Only
    // proceed once a different element is present (or, for restored nodes where
    // no snapshot exists, once any loaded video is present).
    const isFresh = !node._saveVideoAutoplayPrevVideo || vid !== node._saveVideoAutoplayPrevVideo;
    if (!isFresh) return;

    // Fresh element found — wait until it has loaded enough data to play.
    if (vid.readyState < 2) {
        if (!vid._saveVideoAutoplayHooked) {
            vid._saveVideoAutoplayHooked = true;
            const onReady = () => {
                vid._saveVideoAutoplayHooked = false;
                // Re-run now that data is available.
                syncAutoplay(node);
            };
            vid.addEventListener("loadeddata", onReady, { once: true });
            vid.addEventListener("canplay", onReady, { once: true });
        }
        return;
    }

    node._saveVideoPendingAutoplay = false;
    node._saveVideoAutoplayPrevVideo = null;
    if (node.properties) node.properties._saveVideoPendingAutoplay = false;

    try {
        const playPromise = vid.play?.();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {
                // Browser blocked unmuted autoplay — retry muted.
                try {
                    vid.muted = true;
                    vid.play()?.catch?.(() => {});
                } catch {
                    // ignore
                }
            });
        }
    } catch {
        // ignore
    }
}

function drawTitlePlayIcon(node, ctx) {
    if (!hasSavedPath(node) || (node.flags && node.flags.collapsed)) {
        node._saveVideoPlayIconBounds = null;
        return;
    }

    const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;
    const playX = node.size[0] - 8 - 14;
    const playY = (titleHeight / 2) - 30;
    const triSize = 8;

    ctx.save();
    try {
        ctx.beginPath();
        ctx.moveTo(playX - triSize, playY - triSize);
        ctx.lineTo(playX - triSize, playY + triSize);
        ctx.lineTo(playX + triSize, playY);
        ctx.closePath();
        ctx.fillStyle = node._saveVideoHoverPlayIcon ? "#ffffff" : "rgba(255, 255, 255, 0.7)";
        ctx.fill();
    } finally {
        ctx.restore();
    }

    node._saveVideoPlayIconBounds = {
        x: playX - triSize - 3,
        y: playY - triSize - 3,
        width: triSize * 2 + 6,
        height: triSize * 2 + 6,
    };
}

function handlePlayIconHover(node, localPos, canvas) {
    const bounds = node._saveVideoPlayIconBounds;
    if (!bounds) return false;

    const inside =
        localPos[0] >= bounds.x &&
        localPos[0] <= bounds.x + bounds.width &&
        localPos[1] >= bounds.y &&
        localPos[1] <= bounds.y + bounds.height;

    if (inside) {
        canvas.canvas.style.cursor = "pointer";
        canvas.canvas.title = "Play in system player";
        if (!node._saveVideoHoverPlayIcon) {
            node._saveVideoHoverPlayIcon = true;
            node.setDirtyCanvas?.(true, true);
        }
        return true;
    }

    if (node._saveVideoHoverPlayIcon) {
        node._saveVideoHoverPlayIcon = false;
        node.setDirtyCanvas?.(true, true);
    }

    return false;
}

app.registerExtension({
    name: "FBnodes.SaveVideoPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "SaveVideoPlus") return;

        installExecutedSync();
        installExecStartStamping();

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            if (!node.properties) node.properties = {};
            node._saveVideoHoverPlayIcon = false;
            node._saveVideoPlayIconBounds = null;
            node._configuredFromWorkflow = false;

            ensureControlsToggleWidget(node);
            ensureLastResultWidget(node);
            ensurePreviewContainer(node);
            hideExecStartWidget(node);

            // Match LoadVideoPlus creation size. Runs after the default
            // controls-collapse (which shrinks the fresh node) so the visible
            // node starts at the intended footprint.
            if (!node._configuredFromWorkflow) {
                const cw = Math.max(node.size?.[0] || 0, SAVE_VIDEO_MIN_WIDTH + 40);
                const ch = Math.max(node.size?.[1] || 0, SAVE_VIDEO_MIN_HEIGHT + 140);
                node.setSize?.([cw, ch]);
                // Treat this as the collapsed preview footprint so a later
                // expand grows the node instead of squeezing the preview.
                node.properties[CONTROLS_COLLAPSED_SIZE_PROP] = [cw, ch];
            }

            const originalOnResize = node.onResize;
            node.onResize = function (size) {
                if (size) {
                    if (size[0] < SAVE_VIDEO_MIN_WIDTH) size[0] = SAVE_VIDEO_MIN_WIDTH;
                    if (size[1] < SAVE_VIDEO_MIN_HEIGHT) size[1] = SAVE_VIDEO_MIN_HEIGHT;
                }
                return originalOnResize ? originalOnResize.apply(this, arguments) : undefined;
            };

            updateDisplayState(node);
            restoreFromExecutedCache(node);
            ensureMinWarningDisplaySize(node);
            syncWarningOverlay(node);
            // An execution may have completed while this node lived in a hidden
            // subgraph; its result survives only in properties/caches, so the
            // restored player (and pending autoplay) apply as soon as we render.
            if (hasSavedPath(node)) {
                if (node.properties?._saveVideoPendingAutoplay) {
                    node._saveVideoPendingAutoplay = true;
                    node.properties._saveVideoPendingAutoplay = false;
                }
                scheduleRestoredVideoPreview(node);
            }

            const onDrawForeground = node.onDrawForeground;
            node.onDrawForeground = function (ctx) {
                const drawResult = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
                drawTitlePlayIcon(node, ctx);
                syncWarningOverlay(node);
                syncRestoredPreviewUrl(node);
                syncPreviewFooterFromVideo(node);
                syncAutoplay(node);
                return drawResult;
            };

            const onMouseMove = node.onMouseMove;
            node.onMouseMove = function (e, localPos, canvas) {
                const moveResult = onMouseMove ? onMouseMove.apply(this, arguments) : undefined;
                const handled = handlePlayIconHover(node, localPos, canvas);
                if (!handled && canvas?.canvas?.title === "Play in system player") {
                    canvas.canvas.title = "";
                    canvas.canvas.style.cursor = "";
                }
                return moveResult;
            };

            const onMouseDown = node.onMouseDown;
            node.onMouseDown = function (e, localPos, canvas) {
                const bounds = node._saveVideoPlayIconBounds;
                if (bounds) {
                    const inside =
                        localPos[0] >= bounds.x &&
                        localPos[0] <= bounds.x + bounds.width &&
                        localPos[1] >= bounds.y &&
                        localPos[1] <= bounds.y + bounds.height;
                    if (inside) {
                        openInSystemPlayer(node);
                        return true;
                    }
                }
                return onMouseDown ? onMouseDown.apply(this, arguments) : undefined;
            };

            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            // ComfyUI has applied the workflow size; never let creation-time
            // sizing override it (mirrors LoadVideoPlus).
            this._configuredFromWorkflow = true;
            // Restore widget visibility without overwriting the size ComfyUI just loaded from the workflow.
            ensureControlsToggleWidget(this, { skipSize: true });
            ensureLastResultWidget(this);
            ensurePreviewContainer(this);
            hideExecStartWidget(this);
            // Widget values are applied during onConfigure — the serialized
            // last-result widget is the source of truth across save/load.
            restoreLastResultFromWidget(this);
            updateDisplayState(this);
            restoreFromExecutedCache(this);
            ensureMinWarningDisplaySize(this);
            syncWarningOverlay(this);
            if (hasSavedPath(this)) {
                scheduleRestoredVideoPreview(this);
            }
            this.setDirtyCanvas?.(true, true);
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);
            const payload = extractExecutionPayload(message);

            setResultData(this, payload);
            if (this.id !== undefined && this.id !== null && payloadHasVideoResult(payload)) {
                _fbSaveVideoExecutedCache.set(String(this.id), payload);
            }

            if (payloadHasVideoResult(payload) && isAutoPlayEnabled(this)) {
                // Flag pending autoplay. Core injects the fresh <video> element
                // AFTER onExecuted returns, so we must not touch the (old) element
                // here. syncAutoplay (running every onDrawForeground) picks up the
                // new element and plays it once it has loaded.
                this._saveVideoPendingAutoplay = true;
                // Remember the element present now so syncAutoplay can detect the
                // fresh replacement core is about to inject.
                this._saveVideoAutoplayPrevVideo = getPreviewContainer(this)?.querySelector("video") || null;
                // Persist through node destruction (subgraph/tab switches) so
                // playback can start when the node becomes visible again.
                if (this.properties) this.properties._saveVideoPendingAutoplay = true;
            }
            return result;
        };
    },
});
