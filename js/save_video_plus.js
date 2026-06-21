import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function firstValue(value) {
    if (Array.isArray(value)) return value[0];
    return value;
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

function applyWarningOverlay(node) {
    const host = getPreviewContainer(node);
    if (!host) return false;

    if (!host.style.position) {
        host.style.position = "relative";
    }

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

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            if (!node.properties) node.properties = {};
            node._saveVideoHoverPlayIcon = false;
            node._saveVideoPlayIconBounds = null;

            updateDisplayState(node);
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
            updateDisplayState(this);
            ensureMinWarningDisplaySize(this);
            syncWarningOverlay(this);
            this.setDirtyCanvas?.(true, true);
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);

            if (!this.properties) this.properties = {};

            const savedPath = firstValue(message?.saved_video_path);
            if (typeof savedPath === "string") {
                this.properties._lastSavedVideoPath = savedPath;
            }

            const needsExternal = firstValue(message?.needs_external_player);
            if (typeof needsExternal !== "undefined") {
                this.properties._needsExternalPlayer = !!needsExternal;
            }

            updateDisplayState(this);
            ensureMinWarningDisplaySize(this);
            syncWarningOverlay(this);
            this.setDirtyCanvas?.(true, true);
            return result;
        };
    },
});
