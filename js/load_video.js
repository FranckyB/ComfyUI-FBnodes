/**
 * Load Video+ (FBnodes): a video loader with a file browser, an on-node
 * player and a size footnote.
 *
 * The face is one fbui card; the stock widgets (source_folder, video) stay
 * hidden and hold the saved values. Videos the browser cannot play (H265,
 * yuv444) show their first frame, decoded by the backend, with a button that
 * opens them in the system player.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { isVideoFile, previewUrl, stripAnnotation } from "./path_browser.js";
import { mountCard } from "./fbui/card.mjs";
import { toast } from "./fbui/comfy.mjs";
import { button, ICONS } from "./fbui/controls.mjs";
import { chainCallback, el } from "./fbui/dom.mjs";
import { findWidget, hideInputsInDef, hideWidget, suppressCorePreview } from "./fbui/widgets.mjs";
import { CAPTION_HEIGHT } from "./fbui/theme.mjs";
import { BLANK, loadPlus, NONE, sourceLabel } from "./common/load_plus.mjs";

const NODE_NAME = "LoadVideoPlus";
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;
const MIN_WIDTH = 300;
const STAGE_MIN_HEIGHT = 200;

const files = loadPlus({ widget: "video", listKind: "media", navKind: "video", allowedTypes: ["video"], accepts: isVideoFile });

// Videos the browser cannot decode: later loads go straight to the still frame.
const unplayable = new Set();

// { codec, needs_preview, frames, fps, duration } of a video, or null.
async function videoInfo(filename, source) {
    try {
        const response = await api.fetchApi(`/fbnodes/video-info?${new URLSearchParams({ filename, source })}`);
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

// Whether the browser can open the file at all (H265 plays in some browsers).
function browserCanPlay(url) {
    return new Promise((resolve) => {
        const probe = document.createElement("video");
        probe.muted = true;
        probe.preload = "metadata";
        const done = (ok) => {
            clearTimeout(timer);
            probe.onloadedmetadata = probe.onerror = null;
            probe.removeAttribute("src");
            probe.load();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), 2000);
        probe.onloadedmetadata = () => done(true);
        probe.onerror = () => done(false);
        probe.src = url;
    });
}

// Show `filename`: a player, the still frame of an unplayable video, the
// placeholder for (blank), or nothing for (none). A newer call wins.
async function showFile(node, filename) {
    const fb = node._fb;
    const request = ++fb.request;
    const current = () => request === fb.request;
    fb.info = null;
    fb.size = null;
    fb.unplayable = false;
    if (!files.isFile(filename)) {
        fb.stage.show(filename === BLANK ? { image: PLACEHOLDER_IMAGE_PATH } : null);
        fb.card.refresh();
        return;
    }
    const source = files.sourceFolder(node);
    const url = previewUrl(filename, source);
    fb.stage.show(null, "Loading…");
    const info = await videoInfo(filename, source);
    if (!current()) return;
    fb.info = info;
    let playable = !unplayable.has(filename);
    if (playable && info?.needs_preview) playable = await browserCanPlay(url);
    if (!current()) return;
    if (!playable) {
        unplayable.add(filename);
        fb.unplayable = true;
        const frame = api.apiURL(`/fbnodes/video-frame?${new URLSearchParams({ filename, source, position: "0" })}`);
        fb.stage.show({ image: frame });
    } else {
        fb.stage.show({ video: url });
    }
    fb.card.refresh();
}

async function openInPlayer(node) {
    const path = await files.absolutePath(node);
    if (!path) return;
    try {
        const response = await api.fetchApi("/fbnodes/open-in-player", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Request failed (${response.status})`);
        }
    } catch (error) {
        toast(`Could not open the system player: ${error.message}`, { severity: "warn" });
    }
}

// The player: a <video> (or a still <img>) fitted into the media frame, with
// an "open in system player" tool and a notice for unplayable videos.
function stagePanel(node) {
    const fb = node._fb;
    const stage = el("div", "fbui-stage");
    const empty = el("div", "fbui-stage-empty");
    const tools = el("div", "fbui-stage-tools");
    const player = button("", { icon: ICONS.open, small: true, title: "Open in the system player", onClick: () => openInPlayer(node) });
    tools.append(player);
    const notice = el("div", "fbui-stage-empty");
    notice.style.cssText = "inset:auto 0 0 0;padding:8px;background:rgba(10,12,15,.78);pointer-events:auto;gap:6px";
    const noticeText = el("span", "", "This video can't play in the browser (H265 / yuv444).");
    notice.append(noticeText, button("Open in system player", { small: true, icon: ICONS.play, onClick: () => openInPlayer(node) }));
    let media = null;
    stage.append(empty, tools);
    fb.stage = {
        show(content, message = "") {
            media?.remove();
            media = null;
            notice.remove();
            empty.textContent = content ? "" : message || "Browse or drop a video";
            if (content?.video) {
                media = el("video");
                Object.assign(media, { controls: true, loop: true, playsInline: true, preload: "metadata", src: content.video });
                media.addEventListener("loadedmetadata", () => {
                    fb.size = [media.videoWidth, media.videoHeight];
                    fb.card.refresh();
                });
                // The browser gave up after all: fall back to the still frame.
                media.addEventListener("error", () => {
                    const value = files.current(node);
                    if (!files.isFile(value) || unplayable.has(value)) return;
                    unplayable.add(value);
                    showFile(node, value);
                });
            } else if (content?.image) {
                media = el("img");
                media.src = content.image;
                media.draggable = false;
                media.addEventListener("load", () => {
                    if (content.image !== PLACEHOLDER_IMAGE_PATH) fb.size = [media.naturalWidth, media.naturalHeight];
                    fb.card.refresh();
                });
            }
            if (media) stage.prepend(media);
            if (fb.unplayable) stage.append(notice);
        },
    };
    // A click on the empty frame opens the browser.
    stage.addEventListener("click", (event) => {
        if (event.target === stage || event.target === empty) files.openBrowser(node);
    });
    return {
        element: stage,
        sync() {
            player.hidden = !files.isFile(files.current(node));
        },
    };
}

// The footnote: size, length and frame count of the video the node loads.
function captionPanel(node) {
    const fb = node._fb;
    const caption = el("div", "fbui-caption");
    return {
        element: caption,
        sync() {
            const parts = [];
            if (fb.size?.[0]) parts.push(`${fb.size[0]} × ${fb.size[1]}`);
            const duration = Number(fb.info?.duration);
            if (duration > 0) parts.push(`${duration.toFixed(duration < 10 ? 2 : 1)} s`);
            if (fb.info?.frames > 0) parts.push(`${fb.info.frames} frames`);
            caption.textContent = parts.join(" · ") || "—";
        },
    };
}

function setupNode(node) {
    node.properties ??= {};
    suppressCorePreview(node);
    const fb = { request: 0, info: null, size: null, unplayable: false, configured: false, reload: (value) => showFile(node, value) };
    node._fb = fb;
    hideWidget(findWidget(node, "source_folder"));

    const videoWidget = findWidget(node, "video");
    chainCallback(videoWidget, "callback", (value) => {
        // An annotated value ("clip.mp4 [output]") from an older workflow.
        const clean = stripAnnotation(value);
        if (clean !== value) videoWidget.value = clean;
        node.properties._videoFileSelection = clean;
        showFile(node, clean);
    });

    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            {
                widget: "video", label: "Source", kind: "select", labels: sourceLabel,
                button: { text: "", icon: ICONS.folder, title: "Browse files anywhere on disk", onClick: () => files.openBrowser(node) },
            },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    chainCallback(node, "onConfigure", () => {
        fb.configured = true;
        // A tab switch can hand the hidden combo back as (none); the last
        // pick is kept on the node.
        const kept = node.properties._videoFileSelection;
        if (kept && files.current(node) === NONE && kept !== NONE) videoWidget.value = kept;
        files.refreshOptions(node, files.current(node));
        showFile(node, files.current(node));
    });

    node.onDragOver = (event) => Boolean(event.dataTransfer?.types?.includes("Files"));
    node.onDragDrop = async (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (!file || !isVideoFile(file.name)) return false;
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
        files.refreshOptions(node, files.current(node));
        showFile(node, files.current(node));
    });
}

app.registerExtension({
    name: "FBnodes.LoadVideoPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["source_folder", "video"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
