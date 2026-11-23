/**
 * Load Audio+ (FBnodes): an audio loader with a file browser, a player with
 * a trim timeline over the waveform, and in / out points.
 *
 * The face is one fbui card; the stock widgets (source_folder, audio,
 * in_point, out_point) stay hidden and hold the saved values. out_point 0
 * means "to the end". Playback stays inside the trim and loops there.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { previewUrl, stripAnnotation } from "./path_browser.js";
import { mountCard } from "./fbui/card.js";
import { notifyChange, toast } from "./fbui/comfy.js";
import { ICONS } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { findWidget, hideInputsInDef, hideWidget } from "./fbui/widgets.js";
import { CAPTION_HEIGHT, FONT, RADIUS, RADIUS_CARD, T } from "./fbui/theme.js";
import { loadPlus, NONE, sourceLabel } from "./common/load_plus.js";

const NODE_NAME = "LoadAudioPlus";
const MIN_WIDTH = 300;
const PLAYER_HEIGHT = 84;
// The backend lists .mp4 among audio files too (their soundtrack).
const AUDIO_FILE = /\.(wav|flac|mp3|m4a|mp4)$/i;
// Files past this size get no waveform: decoding them would stall the page.
const WAVEFORM_MAX_BYTES = 80 * 1024 * 1024;
const WAVEFORM_BUCKETS = 800;
const HANDLE_GRAB = 8;

const files = loadPlus({
    widget: "audio", listKind: "audio", navKind: "audiovideo", allowedTypes: ["audio", "video"],
    accepts: (value) => AUDIO_FILE.test(stripAnnotation(value)), sentinels: [NONE],
});

const CSS_ID = "fbnodes-audio-css-v1";
function ensureAudioCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-audio{position:relative;height:100%;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid ${T.plateEdge};border-radius:${RADIUS_CARD}px;background:${T.plate};pointer-events:auto}
.fbnodes-audio .play{flex:none;width:34px;height:34px;border-radius:50%;padding:0;background:${T.brand};color:${T.onBrand}}
.fbnodes-audio .play:hover{filter:brightness(1.1);background:${T.brand};color:${T.onBrand}}
.fbnodes-audio .play:disabled{background:${T.fill};color:${T.faint}}
.fbnodes-audio .play svg{width:14px;height:14px}
.fbnodes-audio .side{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.fbnodes-audio .time{color:${T.label};font:600 11px ${FONT};font-variant-numeric:tabular-nums}
.fbnodes-audio .time b{color:${T.ink}}
.fbnodes-audio .track{position:relative;height:44px;border-radius:${RADIUS}px;background:${T.card};overflow:hidden;cursor:pointer;touch-action:none}
.fbnodes-audio .track canvas{position:absolute;inset:0;width:100%;height:100%}
.fbnodes-audio .shade{position:absolute;top:0;bottom:0;background:rgba(8,10,12,.6);pointer-events:none}
.fbnodes-audio .edge{position:absolute;top:0;bottom:0;width:3px;margin-left:-1.5px;background:${T.brand};pointer-events:none}
.fbnodes-audio .edge::after{content:"";position:absolute;top:50%;left:50%;width:9px;height:18px;transform:translate(-50%,-50%);border-radius:3px;background:${T.brand};box-shadow:0 0 0 1px rgba(0,0,0,.45)}
.fbnodes-audio .head{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:${T.ink};box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none}
.fbnodes-audio .empty{position:absolute;inset:0;display:grid;place-items:center;color:${T.faint};font:11px ${FONT};pointer-events:none}
`;
    document.head.append(style);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
    const mins = Math.floor(seconds / 60);
    const secs = seconds - mins * 60;
    return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

// The trim as seconds: out_point 0 means the end of the file.
function trimOf(node, duration) {
    const inPoint = Math.max(0, Number(findWidget(node, "in_point")?.value) || 0);
    const rawOut = Math.max(0, Number(findWidget(node, "out_point")?.value) || 0);
    const end = duration > 0 ? duration : Infinity;
    const start = Math.min(inPoint, end);
    const stop = rawOut > 0 ? clamp(rawOut, start, end) : end;
    return { start, stop: Number.isFinite(stop) ? stop : start };
}

function setTrim(node, start, stop) {
    findWidget(node, "in_point").value = Number(Math.max(0, start).toFixed(3));
    findWidget(node, "out_point").value = Number(Math.max(0, stop).toFixed(3));
    node._fb.card.refresh();
}

// Peaks of the file's samples, one bucket per few pixels, drawn as a
// mirrored waveform. Fetched and decoded once per file.
async function waveformPeaks(url) {
    const response = await fetch(url);
    if (!response.ok) return null;
    const size = Number(response.headers.get("content-length")) || 0;
    if (size > WAVEFORM_MAX_BYTES) return null;
    const context = new (window.AudioContext || window.webkitAudioContext)();
    try {
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const data = buffer.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / WAVEFORM_BUCKETS));
        const peaks = new Float32Array(Math.ceil(data.length / step));
        for (let bucket = 0; bucket < peaks.length; bucket++) {
            let peak = 0;
            const end = Math.min(data.length, (bucket + 1) * step);
            for (let i = bucket * step; i < end; i++) peak = Math.max(peak, Math.abs(data[i]));
            peaks[bucket] = peak;
        }
        return peaks;
    } finally {
        context.close();
    }
}

function playerPanel(node) {
    ensureAudioCss();
    const fb = node._fb;
    const audio = new Audio();
    audio.preload = "metadata";
    fb.audio = audio;

    const root = el("div", "fbnodes-audio");
    const play = el("button", "fbui-btn play");
    play.type = "button";
    play.title = "Play the trimmed clip";
    const side = el("div", "side");
    const time = el("div", "time");
    const track = el("div", "track");
    const canvas = el("canvas");
    const shadeLeft = el("div", "shade");
    const shadeRight = el("div", "shade");
    const edgeIn = el("div", "edge");
    const edgeOut = el("div", "edge");
    const head = el("div", "head");
    const empty = el("div", "empty", "Browse or drop an audio file");
    track.append(canvas, shadeLeft, shadeRight, edgeIn, edgeOut, head, empty);
    side.append(time, track);
    root.append(play, side);

    const duration = () => (Number.isFinite(audio.duration) ? audio.duration : 0);
    const at = (fraction) => `${clamp(fraction, 0, 1) * 100}%`;

    function drawWave() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, track.clientWidth);
        const h = Math.max(1, track.clientHeight);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const peaks = fb.peaks;
        ctx.fillStyle = peaks ? T.brandInk : T.fill;
        if (!peaks) {
            ctx.fillRect(0, h / 2 - 1, w, 2);
            return;
        }
        const top = Math.max(...peaks) || 1;
        for (let x = 0; x < w; x++) {
            const peak = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))] / top;
            const bar = Math.max(1, peak * (h - 6));
            ctx.fillRect(x, (h - bar) / 2, 1, bar);
        }
    }

    function draw() {
        const total = duration();
        const { start, stop } = trimOf(node, total);
        const has = total > 0;
        empty.hidden = files.isFile(files.current(node));
        play.disabled = !has;
        play.innerHTML = audio.paused ? ICONS.play : ICONS.pause;
        for (const part of [shadeLeft, shadeRight, edgeIn, edgeOut, head]) part.hidden = !has;
        if (has) {
            shadeLeft.style.left = "0";
            shadeLeft.style.width = at(start / total);
            shadeRight.style.left = at(stop / total);
            shadeRight.style.right = "0";
            edgeIn.style.left = at(start / total);
            edgeOut.style.left = at(stop / total);
            head.style.left = at(audio.currentTime / total);
        }
        const clipNow = clamp(audio.currentTime - start, 0, Math.max(0, stop - start));
        time.innerHTML = has ? `<b>${formatTime(clipNow)}</b> / ${formatTime(stop - start)}` : "—";
    }
    fb.drawPlayer = draw;
    fb.drawWave = drawWave;

    // Playback stays inside the trim and loops there.
    function startPlaying() {
        const { start, stop } = trimOf(node, duration());
        if (audio.currentTime < start || audio.currentTime >= stop - 0.02) audio.currentTime = start;
        audio.play().catch(() => {});
    }
    play.addEventListener("click", () => {
        if (audio.paused) startPlaying();
        else audio.pause();
    });
    audio.addEventListener("timeupdate", () => {
        const { start, stop } = trimOf(node, duration());
        if (!audio.paused && audio.currentTime >= stop) audio.currentTime = start;
        draw();
    });
    audio.addEventListener("ended", () => {
        audio.currentTime = trimOf(node, duration()).start;
        audio.play().catch(() => {});
    });
    for (const type of ["play", "pause", "seeked"]) audio.addEventListener(type, draw);
    audio.addEventListener("loadedmetadata", () => {
        // A file picked by hand starts with the whole of it as the trim.
        if (fb.resetTrim) {
            fb.resetTrim = false;
            setTrim(node, 0, duration());
            notifyChange();
        }
        audio.currentTime = trimOf(node, duration()).start;
        fb.card.refresh();
    });

    // Press near an edge to move it, anywhere else to move the playhead.
    let drag = null;
    const timeAt = (event) => {
        const box = track.getBoundingClientRect();
        return clamp((event.clientX - box.left) / Math.max(1, box.width), 0, 1) * duration();
    };
    track.addEventListener("pointerdown", (event) => {
        const total = duration();
        if (event.button !== 0 || !total) return;
        event.preventDefault();
        event.stopPropagation();
        track.setPointerCapture(event.pointerId);
        const box = track.getBoundingClientRect();
        const x = event.clientX - box.left;
        const { start, stop } = trimOf(node, total);
        const near = (seconds) => Math.abs(x - (seconds / total) * box.width) <= HANDLE_GRAB;
        drag = near(stop) && !near(start) ? "out" : near(start) ? "in" : "head";
        move(event);
    });
    const move = (event) => {
        if (!drag) return;
        const total = duration();
        const t = timeAt(event);
        const { start, stop } = trimOf(node, total);
        if (drag === "in") setTrim(node, Math.min(t, stop), stop);
        else if (drag === "out") setTrim(node, start, Math.max(t, start));
        else audio.currentTime = clamp(t, start, stop);
        if (drag !== "head" && (audio.currentTime < trimOf(node, total).start || audio.currentTime > trimOf(node, total).stop)) {
            audio.currentTime = trimOf(node, total).start;
        }
        draw();
    };
    track.addEventListener("pointermove", move);
    const end = (event) => {
        if (!drag) return;
        if (drag !== "head") notifyChange();
        drag = null;
        try { track.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    new ResizeObserver(drawWave).observe(track);

    return { element: root, sync: draw };
}

// The footnote: the clip's length, and the file's when the trim is shorter.
function captionPanel(node) {
    const fb = node._fb;
    const caption = el("div", "fbui-caption");
    return {
        element: caption,
        sync() {
            const total = Number.isFinite(fb.audio?.duration) ? fb.audio.duration : 0;
            if (!total) {
                caption.textContent = "—";
                return;
            }
            const { start, stop } = trimOf(node, total);
            const clip = stop - start;
            caption.textContent = clip < total - 0.05 ? `Clip ${clip.toFixed(2)} s of ${total.toFixed(2)} s` : `${total.toFixed(2)} s`;
        },
    };
}

async function showFile(node, filename) {
    const fb = node._fb;
    const request = ++fb.request;
    fb.audio.pause();
    fb.peaks = null;
    fb.drawWave();
    if (!files.isFile(filename)) {
        fb.audio.removeAttribute("src");
        fb.audio.load();
        fb.card.refresh();
        return;
    }
    const url = previewUrl(filename, files.sourceFolder(node));
    fb.audio.src = url;
    try {
        const peaks = await waveformPeaks(url);
        if (request !== fb.request) return;
        fb.peaks = peaks;
        fb.drawWave();
    } catch {
        // No waveform for this file; the timeline still works.
    }
}

function setupNode(node) {
    node.properties ??= {};
    const fb = { request: 0, peaks: null, resetTrim: false, configured: false, reload: (value) => showFile(node, value) };
    node._fb = fb;
    hideWidget(findWidget(node, "source_folder"));

    const audioWidget = findWidget(node, "audio");
    chainCallback(audioWidget, "callback", (value) => {
        const clean = stripAnnotation(value);
        if (clean !== value) audioWidget.value = clean;
        fb.resetTrim = files.isFile(clean);
        showFile(node, clean);
    });

    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            {
                widget: "audio", label: "Source", kind: "select", labels: sourceLabel,
                button: files.sourceButtons,
            },
            { panel: playerPanel, height: PLAYER_HEIGHT },
            { pair: ["in_point", "out_point"], label: "Trim", prefixes: ["In", "Out"], suffix: "s", title: "Clip start and end in seconds (out 0 = to the end)" },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });
    files.track(node);

    // The trim fields move the timeline and keep playback inside the trim.
    for (const name of ["in_point", "out_point"]) {
        chainCallback(findWidget(node, name), "callback", () => {
            const { start, stop } = trimOf(node, fb.audio.duration || 0);
            if (fb.audio.currentTime < start || fb.audio.currentTime > stop) fb.audio.currentTime = start;
            fb.drawPlayer();
        });
    }

    chainCallback(node, "onConfigure", () => {
        fb.configured = true;
        fb.resetTrim = false;
        files.refreshOptions(node, files.current(node));
        showFile(node, files.current(node));
    });
    chainCallback(node, "onRemoved", () => {
        fb.audio.pause();
        fb.audio.removeAttribute("src");
    });

    node.onDragOver = (event) => Boolean(event.dataTransfer?.types?.includes("Files"));
    node.onDragDrop = async (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (!file || !AUDIO_FILE.test(file.name)) return false;
        try {
            await files.upload(node, file, file.name, file.type);
        } catch (error) {
            toast(`Upload failed: ${error.message}`, { severity: "error" });
        }
        return true;
    };

    queueMicrotask(() => {
        if (fb.configured) return;
        files.refreshOptions(node, files.current(node));
        showFile(node, files.current(node));
    });
}

app.registerExtension({
    name: "FBnodes.LoadAudioPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["source_folder", "audio", "in_point", "out_point"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
