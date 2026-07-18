import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CONTROLS_TOGGLE_WIDGET_KEY = "__fb_save_video_controls_toggle";
const CONTROLS_EXPANDED_PROP = "_saveVideoControlsExpanded";
const CONTROLS_COLLAPSED_SIZE_PROP = "_saveVideoCollapsedSize";

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

    updateDisplayState(node);
    ensureMinWarningDisplaySize(node);
    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
    return true;
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

function ensurePreviewContainer(node) {
    let container = getPreviewContainer(node);
    if (container) {
        if (!node.videoContainer) {
            node.videoContainer = container;
        }
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
    frameImg.style.background = "rgba(0, 0, 0, 0.28)";
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

function getControlsExpanded(node) {
    if (typeof node.properties?.[CONTROLS_EXPANDED_PROP] !== "undefined") {
        return !!node.properties[CONTROLS_EXPANDED_PROP];
    }
    return false;
}

function getCollapsibleWidgets(node) {
    return (node.widgets || []).filter((widget) => !isControlsToggleWidget(widget) && !isPreviewWidget(widget));
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

function applyControlsCollapsedState(node) {
    const collapsed = !getControlsExpanded(node);
    for (const widget of getCollapsibleWidgets(node)) {
        setWidgetCollapsed(widget, collapsed);
    }
    updateControlsToggleLabel(node);

    // Recompute node height after widget visibility changes so controls are not clipped.
    try {
        const nextH = node.computeSize?.()[1];
        if (Number.isFinite(nextH)) {
            const nextW = node.size?.[0] || 320;
            node.setSize?.([nextW, nextH]);
        }
    } catch {
        // Ignore size recompute failures and still refresh canvas.
    }

    // Restore the exact pre-expand footprint when collapsing controls.
    if (collapsed) {
        const saved = node.properties?.[CONTROLS_COLLAPSED_SIZE_PROP];
        if (Array.isArray(saved) && saved.length >= 2) {
            const savedW = Number(saved[0]);
            const savedH = Number(saved[1]);
            if (Number.isFinite(savedW) && Number.isFinite(savedH) && savedW > 0 && savedH > 0) {
                node.setSize?.([savedW, savedH]);
            }
        }
    }

    node.setDirtyCanvas?.(true, true);
}

function ensureControlsToggleWidget(node) {
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

    applyControlsCollapsedState(node);
}

function applyWarningOverlay(node) {
    const host = ensurePreviewContainer(node);
    if (!host) return false;

    if (!host.style.position) {
        host.style.position = "relative";
    }

    syncFramePreviewLayer(node, host);

    let overlay = host.querySelector(".fbnodes-save-video-warning");
    if (!overlay) {
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
        host.appendChild(overlay);
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

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            if (!node.properties) node.properties = {};
            node._saveVideoHoverPlayIcon = false;
            node._saveVideoPlayIconBounds = null;

            ensureControlsToggleWidget(node);
            ensurePreviewContainer(node);
            updateDisplayState(node);
            restoreFromExecutedCache(node);
            ensureMinWarningDisplaySize(node);
            syncWarningOverlay(node);

            const onDrawForeground = node.onDrawForeground;
            node.onDrawForeground = function (ctx) {
                const drawResult = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
                drawTitlePlayIcon(node, ctx);
                syncWarningOverlay(node);
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
            ensureControlsToggleWidget(this);
            ensurePreviewContainer(this);
            updateDisplayState(this);
            restoreFromExecutedCache(this);
            ensureMinWarningDisplaySize(this);
            syncWarningOverlay(this);
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
            return result;
        };
    },
});
