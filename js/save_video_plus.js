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

function drawCompatWarning(node, ctx) {
    if (!node._saveVideoShowCompatWarning || (node.flags && node.flags.collapsed)) return;

    const line1 = "Video not compatible with browser";
    const line2 = "Use \u25B6 at the top to open in System Player";

    const titleH = LiteGraph.NODE_TITLE_HEIGHT || 30;
    const footerReserved = 74; // native video control strip space
    const topY = titleH + 24;
    const bottomY = Math.max(topY + 40, node.size[1] - footerReserved - 24);
    const centerY = (topY + bottomY) * 0.5;

    ctx.save();
    try {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        ctx.font = "600 16px sans-serif";
        ctx.fillStyle = "rgba(255, 235, 235, 0.98)";
        ctx.fillText(line1, node.size[0] * 0.5, centerY - 12);

        ctx.font = "600 14px sans-serif";
        ctx.fillStyle = "rgba(255, 235, 235, 0.92)";
        ctx.fillText(line2, node.size[0] * 0.5, centerY + 12);
    } finally {
        ctx.restore();
    }
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

            const onDrawForeground = node.onDrawForeground;
            node.onDrawForeground = function (ctx) {
                const drawResult = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
                drawTitlePlayIcon(node, ctx);
                drawCompatWarning(node, ctx);
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
            this.setDirtyCanvas?.(true, true);
            return result;
        };
    },
});
