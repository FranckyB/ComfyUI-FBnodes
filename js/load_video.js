/**
 * Load Video+ (FBnodes): a video loader with a file browser, an on-node
 * player and a size footnote.
 *
 * The face is one fbui card; the stock widgets (source_folder, video, trim,
 * in_frame, out_frame) stay hidden and hold the saved values. Videos the
 * browser cannot play (H265, yuv444) show their first frame, decoded by the
 * backend, with a button that opens them in the system player.
 *
 * Trim loads frames in_frame to out_frame (out 0 = the last). While an edge
 * moves, the stage shows that exact frame, decoded by the backend the same
 * way the node loads it.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { isVideoFile, previewUrl, stripAnnotation } from "./path_browser.js";
import { mountCard } from "./fbui/card.js";
import { notifyChange, toast } from "./fbui/comfy.js";
import { button, ICONS, rangeRail } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { commitWidgetValue, findWidget, hideInputsInDef, hideWidget, suppressCorePreview } from "./fbui/widgets.js";
import { CAPTION_HEIGHT } from "./fbui/theme.js";
import { BLANK, loadPlus, NONE, sourceLabel } from "./common/load_plus.js";

const NODE_NAME = "LoadVideoPlus";
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;
const MIN_WIDTH = 300;
const STAGE_MIN_HEIGHT = 200;
const RAIL_HEIGHT = 28;

const files = loadPlus({ widget: "video", navKind: "video", allowedTypes: ["video"], accepts: isVideoFile });

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

// ---------------------------------------------------------------- trim

const frameCount = (node) => (node._fb.info?.frames > 0 ? node._fb.info.frames : 0);
const trimOn = (node) => findWidget(node, "trim")?.value === true;

// The trim as frames, both included: out_frame 0 means the last frame.
function trimFrames(node) {
    const last = Math.max(0, frameCount(node) - 1);
    const out = Number(findWidget(node, "out_frame")?.value) || 0;
    const stop = out > 0 ? Math.min(out, last) : last;
    const start = Math.min(Math.max(0, Number(findWidget(node, "in_frame")?.value) || 0), stop);
    return { start, stop };
}

// The whole video as the trim, with the real last frame so Out reads it.
function resetTrim(node) {
    findWidget(node, "in_frame").value = 0;
    findWidget(node, "out_frame").value = Math.max(0, frameCount(node) - 1);
}

function toggleTrim(node) {
    const on = !trimOn(node);
    if (on && !(Number(findWidget(node, "out_frame").value) > 0)) resetTrim(node);
    commitWidgetValue(node, findWidget(node, "trim"), on);
    if (!on) node._fb.stage.hideFrame();
    node._fb.card.refresh();
    notifyChange();
}

// Show an edge's exact frame on the stage while it moves.
function previewEdge(node, edge) {
    const { start, stop } = trimFrames(node);
    node._fb.stage.showFrame(edge === "in" ? start : stop);
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
    if (fb.resetTrim) {
        fb.resetTrim = false;
        resetTrim(node);
    }
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
// an open tool (large preview, or the system player for an unplayable video)
// and a notice for unplayable videos.
function stagePanel(node) {
    const fb = node._fb;
    const stage = el("div", "fbui-stage");
    const empty = el("div", "fbui-stage-empty");
    const tools = el("div", "fbui-stage-tools");
    // A large preview in the browser; the system player for a video the
    // browser cannot play (shown as its first frame).
    const large = button("", { icon: ICONS.open, small: true, onClick: () => (fb.unplayable ? openInPlayer(node) : files.openPreview(node)) });
    tools.append(large);
    const notice = el("div", "fbui-stage-empty");
    notice.style.cssText = "inset:auto 0 0 0;padding:8px;background:rgba(10,12,15,.78);pointer-events:auto;gap:6px";
    const noticeText = el("span", "", "This video can't play in the browser (H265 / yuv444).");
    notice.append(noticeText, button("Open in system player", { small: true, icon: ICONS.play, onClick: () => openInPlayer(node) }));
    let media = null;
    let still = null;
    let stillTimer = 0;
    stage.append(empty, tools);
    // Playback stays inside the trim and loops there; frame i is i / fps in.
    const trimTimes = () => {
        const fps = Number(fb.info?.fps) || 0;
        if (!trimOn(node) || !fps || !frameCount(node)) return null;
        const { start, stop } = trimFrames(node);
        return { start: start / fps, stop: (stop + 1) / fps };
    };
    fb.stage = {
        video: () => (media?.tagName === "VIDEO" ? media : null),
        showFrame(index) {
            clearTimeout(stillTimer);
            stillTimer = setTimeout(() => {
                const value = files.current(node);
                const count = frameCount(node);
                if (!files.isFile(value) || !count) return;
                fb.stage.video()?.pause();
                if (!still) {
                    // Under the pointer the player's own controls stay usable.
                    still = Object.assign(el("img"), { draggable: false });
                    still.style.pointerEvents = "none";
                }
                still.src = api.apiURL(`/fbnodes/video-frame?${new URLSearchParams({ filename: value, source: files.sourceFolder(node), position: String(index / count) })}`);
                if (!still.isConnected) stage.insertBefore(still, empty);
            }, 120);
        },
        hideFrame() {
            clearTimeout(stillTimer);
            still?.remove();
        },
        seek(fraction) {
            const video = fb.stage.video();
            if (!video?.duration) return;
            fb.stage.hideFrame();
            const span = trimTimes() ?? { start: 0, stop: video.duration };
            video.currentTime = Math.max(span.start, Math.min(span.stop - 0.001, fraction * video.duration));
        },
        show(content, message = "") {
            media?.remove();
            media = null;
            fb.stage.hideFrame();
            notice.remove();
            empty.textContent = content ? "" : message || "Browse or drop a video";
            if (content?.video) {
                media = el("video");
                Object.assign(media, { controls: true, loop: true, playsInline: true, preload: "metadata", src: content.video });
                const video = media;
                video.addEventListener("loadedmetadata", () => {
                    fb.size = [video.videoWidth, video.videoHeight];
                    const span = trimTimes();
                    if (span) video.currentTime = span.start;
                    fb.card.refresh();
                });
                video.addEventListener("play", () => {
                    fb.stage.hideFrame();
                    const span = trimTimes();
                    if (span && (video.currentTime < span.start || video.currentTime >= span.stop)) video.currentTime = span.start;
                });
                video.addEventListener("timeupdate", () => {
                    const span = trimTimes();
                    if (span && !video.paused && video.currentTime >= span.stop) video.currentTime = span.start;
                    fb.trimSync?.();
                });
                video.addEventListener("seeked", () => fb.trimSync?.());
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
            large.hidden = !files.isFile(files.current(node));
            large.title = fb.unplayable ? "Open in the system player" : "Open a large preview";
        },
    };
}

// The Edit row: the Trim switch.
function editControl(node) {
    const field = el("div", "fbui-field");
    const trim = button("Trim", { icon: ICONS.scissors, grow: true, title: "Load only part of the video. Press again to load all of it.", onClick: () => toggleTrim(node) });
    field.append(trim);
    return {
        element: field,
        sync() {
            trim.classList.toggle("primary", trimOn(node));
        },
    };
}

// The trim rail: drag the in / out edges, or anywhere else to move the playhead.
function trimPanel(node) {
    const fb = node._fb;
    const toFrame = (fraction) => Math.round(fraction * Math.max(0, frameCount(node) - 1));
    const track = rangeRail({
        title: "Drag an edge to set the first or last frame; press anywhere else to move the playhead.",
        onEdge(edge, fraction, settled) {
            const { start, stop } = trimFrames(node);
            const frame = toFrame(fraction);
            findWidget(node, "in_frame").value = edge === "in" ? Math.min(frame, stop) : start;
            findWidget(node, "out_frame").value = edge === "out" ? Math.max(frame, start) : stop;
            previewEdge(node, edge);
            fb.card.refresh();
            if (settled) notifyChange();
        },
        onSeek: (fraction) => fb.stage.seek(fraction),
    });
    const sync = () => {
        const last = Math.max(1, frameCount(node) - 1);
        const { start, stop } = trimFrames(node);
        const video = fb.stage.video();
        track.set({ start: start / last, stop: stop / last, head: video?.duration ? video.currentTime / video.duration : start / last });
    };
    fb.trimSync = sync;
    return { element: track.root, sync };
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
            const count = frameCount(node);
            const fps = Number(fb.info?.fps) || 0;
            if (trimOn(node) && count && fps) {
                const { start, stop } = trimFrames(node);
                const clip = (stop - start + 1) / fps;
                parts.push(`${clip.toFixed(clip < 10 ? 2 : 1)} s`, `frames ${start}–${stop} of ${count}`);
            } else {
                const duration = Number(fb.info?.duration);
                if (duration > 0) parts.push(`${duration.toFixed(duration < 10 ? 2 : 1)} s`);
                if (count) parts.push(`${count} frames`);
            }
            caption.textContent = parts.join(" · ") || "—";
        },
    };
}

function setupNode(node) {
    node.properties ??= {};
    suppressCorePreview(node);
    const fb = { request: 0, info: null, size: null, unplayable: false, resetTrim: false, configured: false, reload: (value) => showFile(node, value) };
    node._fb = fb;
    hideWidget(findWidget(node, "source_folder"));

    const videoWidget = findWidget(node, "video");
    chainCallback(videoWidget, "callback", (value) => {
        // An annotated value ("clip.mp4 [output]") from an older workflow.
        const clean = stripAnnotation(value);
        if (clean !== value) videoWidget.value = clean;
        node.properties._videoFileSelection = clean;
        // A file picked by hand starts with the whole of it as the trim.
        fb.resetTrim = files.isFile(clean);
        showFile(node, clean);
    });

    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            {
                widget: "video", label: "Source", kind: "select", labels: sourceLabel,
                button: files.sourceButtons,
            },
            { label: "Edit", control: editControl, widgets: ["trim"] },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: trimPanel, height: RAIL_HEIGHT, when: (_values, n) => trimOn(n) },
            { pair: ["in_frame", "out_frame"], label: "Frames", prefixes: ["In", "Out"], title: "First and last frame of the clip, both included", when: (_values, n) => trimOn(n) },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });
    files.track(node);
    // Typed or scrubbed frames show the edge they move.
    for (const [name, edge] of [["in_frame", "in"], ["out_frame", "out"]]) {
        chainCallback(findWidget(node, name), "callback", () => {
            previewEdge(node, edge);
            fb.card.refresh();
        });
    }

    chainCallback(node, "onConfigure", () => {
        fb.configured = true;
        fb.resetTrim = false;
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
        hideInputsInDef(nodeData, ["source_folder", "video", "trim", "in_frame", "out_frame"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
