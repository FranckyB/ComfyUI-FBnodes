/**
 * LoadAudioPlus Extension for ComfyUI (FBnodes)
 * Audio loader with file browser and unified draggable in/out trim timeline.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    mediaFileUrl,
    getMediaRoots,
    classifySelection,
} from "./path_browser.js";
import { createFileBrowserModal } from "./file_browser.js";

const AUDIO_EXTENSIONS = ["wav", "flac", "mp3", "mp4", "m4a"];

function stripAnnotation(value) {
    if (!value) return value;
    return value.replace(/\s*\[(input|output|temp)\]\s*$/, "");
}

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

function isAudioFile(filename) {
    if (!filename || filename === "(none)") return false;
    const ext = filename.split(".").pop().toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext);
}

function buildAudioViewUrl(filename, sourceFolder) {
    if (isAbsolutePath(filename)) {
        return mediaFileUrl(filename);
    }

    let actualFilename = filename;
    let subfolder = "";

    if (filename.includes("/")) {
        const lastSlash = filename.lastIndexOf("/");
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }

    let fileUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${sourceFolder || "input"}`;
    if (subfolder) {
        fileUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
    }
    return fileUrl;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00.0";
    }

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const tenths = Math.floor((seconds % 1) * 10);

    return `${mins}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function getWidget(node, name) {
    return node.widgets?.find(w => w.name === name);
}

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

function markGraphChanged(node) {
    try {
        node.graph?.change?.();
    } catch (error) {
        // Ignore graph change hook errors.
    }
}

function applyDefaultNodeSize(node, force = false) {
    const computed = node.computeSize ? node.computeSize() : null;
    const minWidth = 260;
    const defaultWidth = 300;
    const minHeight = 204;
    const extraHeight = 4;
    const creationWidthBoost = 0;
    const creationHeightBoost = 4;

    if (!computed || computed.length < 2) {
        return;
    }

    const baseWidth = Math.max(minWidth, Math.ceil(computed[0]));
    const targetWidth = force
        ? Math.max(minWidth, defaultWidth + creationWidthBoost)
        : baseWidth;
    const baseHeight = Math.max(minHeight, Math.ceil(computed[1]) + extraHeight);
    const targetHeight = force ? (baseHeight + creationHeightBoost) : baseHeight;

    if (!node.size || force) {
        node.size = [targetWidth, targetHeight];
        return;
    }

    // Do not force width/height expansion after initial creation.
    // This preserves the user's manual sizing choices.
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function setPlayButtonIcon(preview, isPaused) {
    if (!preview?.playButton) return;

    if (isPaused) {
        preview.playButton.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <polygon points="3,2 12,7 3,12" fill="#f2f2f2"></polygon>
            </svg>
        `;
    } else {
        preview.playButton.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <rect x="3" y="2" width="3" height="10" fill="#f2f2f2"></rect>
                <rect x="8" y="2" width="3" height="10" fill="#f2f2f2"></rect>
            </svg>
        `;
    }
}

function getPlaybackBounds(node, audioElement) {
    const inWidget = getWidget(node, "in_point");
    const outWidget = getWidget(node, "out_point");

    let inPoint = Math.max(0, Number(inWidget?.value) || 0);
    let outPoint = Math.max(0, Number(outWidget?.value) || 0);

    const duration = Number.isFinite(audioElement?.duration)
        ? audioElement.duration
        : (Number.isFinite(node._audioDuration) ? node._audioDuration : 0);

    if (duration > 0) {
        inPoint = Math.min(inPoint, duration);
    }

    if (outPoint <= 0 && duration > 0) {
        outPoint = duration;
    }

    if (duration > 0) {
        outPoint = Math.min(outPoint, duration);
    }

    if (!Number.isFinite(outPoint) || outPoint < inPoint) {
        outPoint = inPoint;
    }

    return { inPoint, outPoint, duration };
}

function normalizeClipPoints(node) {
    const inWidget = getWidget(node, "in_point");
    const outWidget = getWidget(node, "out_point");
    if (!inWidget || !outWidget) return;

    const bounds = getPlaybackBounds(node, node._audioPreview?.audio);
    inWidget.value = bounds.inPoint;

    // Preserve the semantic of 0 = full length when possible.
    const requestedOut = Math.max(0, Number(outWidget.value) || 0);
    if (requestedOut > 0) {
        outWidget.value = Math.max(bounds.inPoint, bounds.outPoint);
    }

    if (!node.properties) node.properties = {};
    node.properties._audioInPoint = Number(inWidget.value) || 0;
    node.properties._audioOutPoint = Number(outWidget.value) || 0;
}

function setClipPoints(node, inPoint, outPoint) {
    const inWidget = getWidget(node, "in_point");
    const outWidget = getWidget(node, "out_point");
    if (!inWidget || !outWidget) return;

    inWidget.value = Math.max(0, Number(inPoint) || 0);
    outWidget.value = Math.max(0, Number(outPoint) || 0);
    normalizeClipPoints(node);
    markGraphChanged(node);
}

function resetClipToFullDuration(node, duration) {
    const inWidget = getWidget(node, "in_point");
    const outWidget = getWidget(node, "out_point");
    if (!inWidget || !outWidget) return;

    const clipDuration = Math.max(0, Number(duration) || 0);
    inWidget.value = 0;
    outWidget.value = clipDuration;
    normalizeClipPoints(node);
    markGraphChanged(node);
}

function updateClipSummary(node) {
    const preview = node._audioPreview;
    if (!preview) return;
}

function enforcePlaybackWindow(node, lockToIn = false) {
    const preview = node._audioPreview;
    if (!preview) return;

    const audio = preview.audio;
    const bounds = getPlaybackBounds(node, audio);

    if (lockToIn || audio.currentTime < bounds.inPoint || audio.currentTime >= bounds.outPoint) {
        audio.currentTime = bounds.inPoint;
    }
}

function rewindToClipStart(node) {
    const preview = node._audioPreview;
    if (!preview) return;

    const audio = preview.audio;
    const bounds = getPlaybackBounds(node, audio);
    const target = bounds.inPoint;
    const nudge = 0.01;
    node._ignoreEndUntil = 0;
    audio.pause();

    // Force a real seek transition so browsers clear stale ended state.
    try {
        const preTarget = target > nudge ? (target - nudge) : 0;
        if (audio.ended || Math.abs((audio.currentTime || 0) - target) < 0.0005) {
            audio.currentTime = preTarget;
        }
        audio.currentTime = target;
    } catch (error) {
        audio.currentTime = target;
    }
}

function playClip(node) {
    const preview = node._audioPreview;
    if (!preview) return;

    const audio = preview.audio;
    const bounds = getPlaybackBounds(node, audio);
    const target = bounds.inPoint;
    const nudge = 0.01;

    // Guard against immediate stale timeupdate >= out_point right after play.
    node._ignoreEndUntil = performance.now() + 650;

    // Keep play inside the direct click gesture path: set start position,
    // then play immediately (no deferred seeked callback).
    try {
        // Two-step seek makes replay from non-zero in_point reliable across browsers.
        const preTarget = target > nudge ? (target - nudge) : 0;
        if (audio.ended || Math.abs((audio.currentTime || 0) - target) < 0.0005) {
            audio.currentTime = preTarget;
        }
        audio.currentTime = target;
    } catch (error) {
        // Ignore seek errors and still attempt playback.
    }

    updateTimelineVisuals(node);
    audio.play().catch(() => {});
}

function updateTimelineVisuals(node) {
    const preview = node._audioPreview;
    if (!preview) return;

    const audio = preview.audio;
    const bounds = getPlaybackBounds(node, audio);
    const duration = bounds.duration;

    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const safeCurrent = clamp(current, 0, duration || 0);

    if (duration <= 0) {
        preview.timeLabel.textContent = `0:00.0/0:00.0`;
        preview.selection.style.left = "0%";
        preview.selection.style.width = "0%";
        preview.inHandle.style.left = "0%";
        preview.outHandle.style.left = "0%";
        preview.playhead.style.left = "0%";
        return;
    }

    const inPct = (bounds.inPoint / duration) * 100;
    const outPct = (bounds.outPoint / duration) * 100;
    const currentPct = (safeCurrent / duration) * 100;
    const clipDuration = Math.max(0, bounds.outPoint - bounds.inPoint);
    const clipCurrent = clamp(safeCurrent - bounds.inPoint, 0, clipDuration);

    preview.selection.style.left = `${inPct}%`;
    preview.selection.style.width = `${Math.max(0, outPct - inPct)}%`;
    preview.inHandle.style.left = `${inPct}%`;
    preview.outHandle.style.left = `${outPct}%`;
    preview.playhead.style.left = `${currentPct}%`;
    preview.timeLabel.textContent = `${formatTime(clipCurrent)}/${formatTime(clipDuration)}`;
}

function updatePlayButtonState(node) {
    const preview = node._audioPreview;
    if (!preview) return;
    setPlayButtonIcon(preview, preview.audio.paused);
}

function bindTimelinePointerHandlers(node) {
    const preview = node._audioPreview;
    if (!preview) return;

    const getTimeAtClientX = (clientX) => {
        const rect = preview.timeline.getBoundingClientRect();
        const pct = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const duration = Number.isFinite(preview.audio.duration) ? preview.audio.duration : (node._audioDuration || 0);
        return pct * Math.max(0, duration);
    };

    const beginDrag = (type, event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();

        const onMove = (moveEvent) => {
            const audio = preview.audio;
            const bounds = getPlaybackBounds(node, audio);
            const duration = bounds.duration;
            if (duration <= 0) return;

            const t = getTimeAtClientX(moveEvent.clientX);

            if (type === "in") {
                const outTime = bounds.outPoint;
                const nextIn = clamp(t, 0, outTime);
                const outWidgetValue = Number(getWidget(node, "out_point")?.value) || 0;
                setClipPoints(node, nextIn, outWidgetValue);
                if (audio.currentTime < nextIn) {
                    audio.currentTime = nextIn;
                }
            } else if (type === "out") {
                const nextOut = clamp(t, bounds.inPoint, duration);
                setClipPoints(node, bounds.inPoint, nextOut);
                if (audio.currentTime > nextOut) {
                    audio.currentTime = bounds.inPoint;
                    audio.pause();
                }
            } else {
                const clamped = clamp(t, bounds.inPoint, bounds.outPoint);
                audio.currentTime = clamped;
            }

            normalizeClipPoints(node);
            updateClipSummary(node);
            updateTimelineVisuals(node);
            node.setDirtyCanvas(true, true);
        };

        const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        onMove(event);
    };

    preview.timeline.addEventListener("pointerdown", (e) => beginDrag("scrub", e));
    preview.inHandle.addEventListener("pointerdown", (e) => beginDrag("in", e));
    preview.outHandle.addEventListener("pointerdown", (e) => beginDrag("out", e));
    preview.playhead.addEventListener("pointerdown", (e) => beginDrag("scrub", e));
}

function ensureAudioPreview(node) {
    if (node._audioPreview) return;

    const container = document.createElement("div");
    container.style.cssText = `
        width: 100%;
        height: 30px;
        display: block;
        padding: 0;
        box-sizing: border-box;
        background: transparent;
        overflow: visible;
    `;

    const transportRow = document.createElement("div");
    transportRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        height: 34px;
        padding: 0 8px;
        border-radius: 18px;
        background: rgba(74, 74, 74, 0.96);
        box-sizing: border-box;
        margin: -7px 0 0 0;
        width: 100%;
    `;

    const playButton = document.createElement("button");
    playButton.style.cssText = `
        width: 20px;
        height: 20px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: #efefef;
        cursor: pointer;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    `;

    const timeLabel = document.createElement("div");
    timeLabel.style.cssText = `
        width: 84px;
        color: #d3d3d3;
        font-size: 12px;
        text-align: center;
        font-family: "Segoe UI", Tahoma, sans-serif;
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum" 1;
        line-height: 1;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
    `;
    timeLabel.textContent = "0:00.0/0:00.0";

    const timeline = document.createElement("div");
    timeline.style.cssText = `
        position: relative;
        flex: 1;
        height: 16px;
        cursor: pointer;
        user-select: none;
        min-width: 90px;
    `;

    const baseTrack = document.createElement("div");
    baseTrack.style.cssText = `
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: 5px;
        transform: translateY(-50%);
        border-radius: 99px;
        background: rgba(255,255,255,0.36);
    `;

    const selection = document.createElement("div");
    selection.style.cssText = `
        position: absolute;
        top: 50%;
        height: 7px;
        transform: translateY(-50%);
        border-radius: 99px;
        background: rgba(64, 192, 255, 0.62);
        left: 0%;
        width: 0%;
        pointer-events: none;
    `;

    const makeHandle = () => {
        const handle = document.createElement("div");
        handle.style.cssText = `
            position: absolute;
            top: 50%;
            width: 8px;
            height: 15px;
            transform: translate(-50%, -50%);
            border-radius: 3px;
            border: 1px solid rgba(0,0,0,0.45);
            background: #36b6ff;
            cursor: ew-resize;
            z-index: 3;
        `;
        return handle;
    };

    const inHandle = makeHandle();
    const outHandle = makeHandle();

    const playhead = document.createElement("div");
    playhead.style.cssText = `
        position: absolute;
        top: 50%;
        width: 2px;
        height: 15px;
        transform: translate(-50%, -50%);
        border-radius: 2px;
        background: #ffffff;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
        cursor: ew-resize;
        z-index: 2;
    `;

    timeline.appendChild(baseTrack);
    timeline.appendChild(selection);
    timeline.appendChild(playhead);
    timeline.appendChild(inHandle);
    timeline.appendChild(outHandle);

    transportRow.appendChild(playButton);
    transportRow.appendChild(timeLabel);
    transportRow.appendChild(timeline);

    const audio = document.createElement("audio");
    audio.controls = false;
    audio.preload = "metadata";
    audio.style.cssText = "display:none;";

    const previewState = {
        playButton,
    };
    setPlayButtonIcon(previewState, true);

    playButton.onclick = () => {
        if (!audio.src) return;

        if (audio.paused) {
            playClip(node);
        } else {
            audio.pause();
        }
        updatePlayButtonState(node);
    };

    container.appendChild(transportRow);
    container.appendChild(audio);

    const previewWidget = node.addDOMWidget("audio_preview", "audio", container, {
        canvasOnly: true,
        hideOnZoom: false,
    });
    previewWidget.serialize = false;
    previewWidget.computeLayoutSize = () => ({ minHeight: 30, minWidth: 220 });
    if (previewWidget.element) {
        previewWidget.element.style.minHeight = "30px";
        previewWidget.element.style.height = "auto";
        previewWidget.element.style.padding = "0";
    }

    node._audioPreview = {
        container,
        audio,
        playButton,
        timeLabel,
        timeline,
        selection,
        inHandle,
        outHandle,
        playhead,
        previewWidget,
    };

    bindTimelinePointerHandlers(node);

    audio.addEventListener("loadedmetadata", () => {
        node._audioDuration = Number.isFinite(audio.duration) ? audio.duration : null;
        if (node._resetTrimOnNextMetadata) {
            resetClipToFullDuration(node, node._audioDuration || 0);
            node._resetTrimOnNextMetadata = false;
        } else {
            normalizeClipPoints(node);
        }
        updateClipSummary(node);
        updateTimelineVisuals(node);
        updatePlayButtonState(node);
        node.setDirtyCanvas(true, true);
    });

    audio.addEventListener("play", () => {
        enforcePlaybackWindow(node, true);
        updatePlayButtonState(node);
    });

    audio.addEventListener("seeking", () => {
        enforcePlaybackWindow(node, false);
        updateTimelineVisuals(node);
    });

    audio.addEventListener("timeupdate", () => {
        const bounds = getPlaybackBounds(node, audio);

        if ((node._ignoreEndUntil || 0) > performance.now()) {
            // Let seek/play settle before enforcing end-boundary rewind.
            if (audio.currentTime < bounds.inPoint) {
                audio.currentTime = bounds.inPoint;
            }
            updateTimelineVisuals(node);
            return;
        }

        if (audio.currentTime < bounds.inPoint) {
            audio.currentTime = bounds.inPoint;
            updateTimelineVisuals(node);
            return;
        }
        if (bounds.outPoint > bounds.inPoint && audio.currentTime >= bounds.outPoint) {
            rewindToClipStart(node);
        }
        updateTimelineVisuals(node);
    });

    audio.addEventListener("pause", () => {
        node._ignoreEndUntil = 0;
        updatePlayButtonState(node);
    });

    audio.addEventListener("ended", () => {
        // Browser can fire ended before timeupdate catches the boundary.
        node._ignoreEndUntil = 0;
        rewindToClipStart(node);
        updateTimelineVisuals(node);
        updatePlayButtonState(node);
    });
}

function syncAudioPreview(node) {
    ensureAudioPreview(node);

    const preview = node._audioPreview;
    const audioWidget = getWidget(node, "audio");
    const selected = stripAnnotation(audioWidget?.value);

    if (!selected || selected === "(none)") {
        preview.audio.removeAttribute("src");
        preview.audio.load();
        node._audioDuration = null;
        node._ignoreEndUntil = 0;
        updateClipSummary(node);
        updateTimelineVisuals(node);
        updatePlayButtonState(node);
        return;
    }

    const sourceFolder = node._sourceFolder || "input";
    const sourceUrl = buildAudioViewUrl(selected, sourceFolder);

    if (preview.audio.dataset.sourceUrl !== sourceUrl) {
        preview.audio.dataset.sourceUrl = sourceUrl;
        preview.audio.src = `${sourceUrl}&${Date.now()}`;
        preview.audio.load();
    }

    updateClipSummary(node);
    updateTimelineVisuals(node);
    updatePlayButtonState(node);
}

app.registerExtension({
    name: "FBnodes.LoadAudioPlus",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoadAudioPlus") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            if (!node.properties) node.properties = {};
            node._sourceFolder = "input";

            const sourceFolderWidget = getWidget(node, "source_folder");
            const audioWidget = getWidget(node, "audio");
            const inPointWidget = getWidget(node, "in_point");
            const outPointWidget = getWidget(node, "out_point");

            node._resetTrimOnNextMetadata = false;
            node._suppressResetOnAudioCallback = false;
            node._activeAudioFile = stripAnnotation(audioWidget?.value) || "";
            node._ignoreEndUntil = 0;

            if (inPointWidget) inPointWidget.serialize = true;
            if (outPointWidget) outPointWidget.serialize = true;
            let audioPickerWidget = null;
            node._audioPickerMap = { '(none)': '(none)' };

            const updateAudioPickerOptions = (values, preferredValue = null) => {
                if (!audioPickerWidget) return;

                const labels = ['(none)'];
                const map = { '(none)': '(none)' };
                const usedLabels = new Set(['(none)']);

                for (const fullValue of values || []) {
                    const base = basenameForDisplay(fullValue) || fullValue;
                    let label = base;
                    let idx = 2;
                    while (usedLabels.has(label)) {
                        label = `${base} (${idx++})`;
                    }
                    usedLabels.add(label);
                    labels.push(label);
                    map[label] = fullValue;
                }

                node._audioPickerMap = map;
                audioPickerWidget.options.values = labels;

                const desired = stripAnnotation(preferredValue != null ? preferredValue : audioWidget?.value);
                if (desired && desired !== '(none)') {
                    const label = Object.keys(map).find((k) => map[k] === desired);
                    audioPickerWidget.value = label || '(none)';
                } else {
                    audioPickerWidget.value = '(none)';
                }
            };

            const placeTimelineUnderBrowse = () => {
                const widgets = node.widgets;
                if (!widgets) return;

                const previewWidget = widgets.find(w => w.name === "audio_preview");
                const browseWidget = widgets.find(w => w.name === "\u{1F4C1} Browse Files");
                if (!previewWidget || !browseWidget) return;

                const previewIndex = widgets.indexOf(previewWidget);
                const browseIndex = widgets.indexOf(browseWidget);
                if (previewIndex < 0 || browseIndex < 0) return;

                const targetIndex = browseIndex + 1;
                if (previewIndex === targetIndex) return;

                widgets.splice(previewIndex, 1);
                const insertIndex = previewIndex < targetIndex ? targetIndex - 1 : targetIndex;
                widgets.splice(insertIndex, 0, previewWidget);
            };

            ensureAudioPreview(node);
            applyDefaultNodeSize(node, true);

            if (sourceFolderWidget) {
                node._sourceFolder = sourceFolderWidget.value || "input";
                // Hidden for backward compatibility: still serialized so old
                // workflows resolve relative paths, but driven by the browser now.
                hideWidget(sourceFolderWidget);
            }

            // Set the audio combo to an arbitrary value (relative or absolute),
            // adding it to the option list so the combo can display it.
            const setAudioFilename = (value) => {
                if (!audioWidget) return;
                if (!audioWidget.options) audioWidget.options = {};
                const values = audioWidget.options.values;
                if (Array.isArray(values)) {
                    if (value && !values.includes(value)) {
                        audioWidget.options.values = [...values, value];
                    }
                } else if (values && typeof values === 'object') {
                    const existingValues = Object.values(values);
                    if (value && !existingValues.includes(value)) {
                        const base = basenameForDisplay(value) || value;
                        let label = base;
                        let n = 2;
                        while (Object.prototype.hasOwnProperty.call(values, label)) {
                            label = `${base} (${n++})`;
                        }
                        audioWidget.options.values = { ...values, [label]: value };
                    }
                } else {
                    audioWidget.options.values = ["(none)"];
                    if (value && value !== "(none)") {
                        audioWidget.options.values.push(value);
                    }
                }
                audioWidget.value = value;
                if (audioWidget.callback) audioWidget.callback(value);

                const map = node._audioPickerMap || { '(none)': '(none)' };
                const currentLabel = Object.keys(map).find((k) => map[k] === value);
                if (audioPickerWidget) {
                    audioPickerWidget.value = currentLabel || '(none)';
                }
                node.setDirtyCanvas(true, true);
            };

            const refreshAudioOptionsForBrowsePath = async (browsePath, preferredValue = null) => {
                if (!audioWidget || !browsePath) return false;
                try {
                    const roots = await getMediaRoots();
                    const resp = await api.fetchApi(
                        `/fbnodes/path-browser/list?path=${encodeURIComponent(browsePath)}&kind=audiovideo`
                    );
                    if (!resp.ok) return false;

                    const data = await resp.json();
                    const files = Array.isArray(data?.files) ? data.files : [];
                    const mapped = [];
                    const seen = new Set();

                    for (const f of files) {
                        const absPath = typeof f === 'string' ? f : f?.path;
                        if (!absPath) continue;
                        const cls = classifySelection(absPath, roots);
                        const value = cls?.value || absPath;
                        if (!seen.has(value)) {
                            seen.add(value);
                            mapped.push(value);
                        }
                    }

                    const desired = stripAnnotation(preferredValue != null ? preferredValue : audioWidget.value);
                    audioWidget.options.values = ['(none)', ...mapped];
                    updateAudioPickerOptions(mapped, desired);
                    if (desired && desired !== '(none)') audioWidget.value = desired;
                    return true;
                } catch (err) {
                    console.warn('[LoadAudioPlus] Could not refresh options for browse path:', err);
                    return false;
                }
            };

            if (audioWidget) {
                hideWidget(audioWidget);
                const audioWidgetIndex = this.widgets.indexOf(audioWidget);

                const originalAudioCallback = audioWidget.callback;
                audioWidget.callback = function (value) {
                    const cleaned = stripAnnotation(value);
                    if (cleaned !== value) {
                        audioWidget.value = cleaned;
                        value = cleaned;
                    }

                    if (originalAudioCallback) originalAudioCallback.apply(this, arguments);

                    if (!isAudioFile(value) && value !== "(none)") {
                        console.warn(`[LoadAudioPlus] Unsupported audio extension: ${value}`);
                    }

                    const nextAudio = (value && value !== "(none)") ? value : "";
                    if (nextAudio && !node._suppressResetOnAudioCallback) {
                        node._resetTrimOnNextMetadata = true;
                    }
                    node._activeAudioFile = nextAudio;

                    node.properties._audioFile = value || "";
                    syncAudioPreview(node);
                    node.setDirtyCanvas(true, true);
                };

                audioPickerWidget = this.addWidget(
                    'combo',
                    'file',
                    '(none)',
                    (label) => {
                        const selected = node._audioPickerMap?.[label] || '(none)';
                        setAudioFilename(selected);
                    },
                    { values: ['(none)'] }
                );
                audioPickerWidget.serialize = false;

                const pickerIndex = this.widgets.indexOf(audioPickerWidget);
                if (pickerIndex >= 0) {
                    this.widgets.splice(pickerIndex, 1);
                    this.widgets.splice(audioWidgetIndex + 1, 0, audioPickerWidget);
                }

                const browseButton = {
                    type: "button",
                    name: "\u{1F4C1} Browse Files",
                    value: null,
                    callback: async () => {
                        const roots = await getMediaRoots();
                        let initial = node.properties?._browsePath || "";
                        if (!initial) {
                            const sf = getWidget(node, "source_folder")?.value || "input";
                            initial = sf === "output" ? roots.output : roots.input;
                        }
                        const sf = getWidget(node, "source_folder")?.value || "input";
                        createFileBrowserModal(
                            isAbsolutePath(audioWidget.value) ? audioWidget.value : null,
                            (selected, meta) => {
                                if (!node.properties) node.properties = {};
                                if (meta && meta.absPath) {
                                    node.properties._browsePath = meta.dir;
                                    const cls = classifySelection(meta.absPath, meta.roots);
                                    const sfW = getWidget(node, "source_folder");
                                    if (cls.sourceFolder && sfW) {
                                        sfW.value = cls.sourceFolder;
                                        node._sourceFolder = cls.sourceFolder;
                                        node.properties._audioSourceFolder = cls.sourceFolder;
                                    }
                                    setAudioFilename(cls.value);
                                    refreshAudioOptionsForBrowsePath(meta.dir, cls.value);
                                } else {
                                    setAudioFilename(selected);
                                    if (node.properties?._browsePath) {
                                        refreshAudioOptionsForBrowsePath(node.properties._browsePath, selected);
                                    }
                                }
                                node.setDirtyCanvas(true, true);
                            },
                            sf,
                            {
                                enableNavigation: true,
                                initialPath: initial,
                                navKind: "audiovideo",
                                listKind: "all",
                                showListKindSelector: true,
                                allowedTypes: ["audio", "video"],
                            }
                        );
                    },
                    serialize: false,
                };

                this.widgets.splice(audioWidgetIndex + 2, 0, browseButton);
                Object.defineProperty(browseButton, "node", { value: node });
                placeTimelineUnderBrowse();
            }

            const onClipWidgetChanged = (widget, originalCallback) => {
                widget.callback = function (value) {
                    if (originalCallback) originalCallback.apply(this, arguments);
                    if (!node.properties) node.properties = {};

                    normalizeClipPoints(node);
                    node.properties._audioInPoint = Number(inPointWidget?.value) || 0;
                    node.properties._audioOutPoint = Number(outPointWidget?.value) || 0;
                    markGraphChanged(node);
                    updateClipSummary(node);
                    updateTimelineVisuals(node);
                    node.setDirtyCanvas(true, true);
                };
            };

            if (inPointWidget) {
                onClipWidgetChanged(inPointWidget, inPointWidget.callback);
            }
            if (outPointWidget) {
                onClipWidgetChanged(outPointWidget, outPointWidget.callback);
            }

            const onConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                node._suppressResetOnAudioCallback = true;
                let configureResult;
                try {
                    configureResult = onConfigure ? onConfigure.apply(this, arguments) : undefined;

                    const sfWidget = getWidget(node, "source_folder");
                    if (sfWidget) {
                        node._sourceFolder = sfWidget.value || "input";
                    }

                    if (node.properties?._browsePath && audioWidget) {
                        refreshAudioOptionsForBrowsePath(node.properties._browsePath, audioWidget.value);
                    }

                    if (node.properties) {
                        if (typeof node.properties._audioInPoint === "number" && inPointWidget) {
                            inPointWidget.value = node.properties._audioInPoint;
                        }
                        if (typeof node.properties._audioOutPoint === "number" && outPointWidget) {
                            outPointWidget.value = node.properties._audioOutPoint;
                        }
                    }

                    normalizeClipPoints(node);
                    syncAudioPreview(node);
                    node._activeAudioFile = stripAnnotation(audioWidget?.value) || "";
                    placeTimelineUnderBrowse();
                    applyDefaultNodeSize(node, false);
                } finally {
                    node._suppressResetOnAudioCallback = false;
                }

                return configureResult;
            };

            // Drag-and-drop upload support.
            node.onDragOver = function (e) {
                if (e.dataTransfer && e.dataTransfer.items) {
                    e.preventDefault();
                    e.stopPropagation();
                    return true;
                }
                return false;
            };

            node.onDragDrop = async function (e) {
                e.preventDefault();
                e.stopPropagation();

                if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) {
                    return false;
                }

                const file = e.dataTransfer.files[0];
                const ext = file.name.split(".").pop().toLowerCase();
                if (!AUDIO_EXTENSIONS.includes(ext)) {
                    return false;
                }

                const formData = new FormData();
                formData.append("image", file);
                formData.append("subfolder", "");
                formData.append("type", "input");

                try {
                    const uploadResponse = await api.fetchApi("/upload/image", {
                        method: "POST",
                        body: formData,
                    });

                    if (uploadResponse.ok) {
                        const uploadData = await uploadResponse.json();

                        if (sourceFolderWidget && node._sourceFolder !== "input") {
                            sourceFolderWidget.value = "input";
                            if (typeof sourceFolderWidget.callback === "function") {
                                await sourceFolderWidget.callback("input");
                            } else {
                                node._sourceFolder = "input";
                            }
                        }

                        if (audioWidget) {
                            try {
                                const listResponse = await api.fetchApi("/fbnodes/list-files?source=input&kind=audio");
                                if (listResponse.ok) {
                                    const listData = await listResponse.json();
                                    audioWidget.options.values = ["(none)", ...(listData.files || [])];
                                }
                            } catch (refreshError) {
                                console.warn("[LoadAudioPlus] Could not refresh audio list:", refreshError);
                            }

                            const uploadedName = uploadData.name || uploadData.filename || file.name;
                            audioWidget.value = uploadedName;
                            if (audioWidget.callback) audioWidget.callback(uploadedName);
                        }
                    }
                } catch (error) {
                    console.error("[LoadAudioPlus] Error uploading audio:", error);
                }

                return true;
            };

            setTimeout(() => {
                normalizeClipPoints(node);
                syncAudioPreview(node);
                placeTimelineUnderBrowse();
                updateTimelineVisuals(node);
                updatePlayButtonState(node);
            }, 10);

            return result;
        };
    },
});

console.log("[FBnodes] LoadAudioPlus extension loaded");
