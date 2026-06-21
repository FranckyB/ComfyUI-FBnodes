/**
 * LoadVideoPlus Extension for ComfyUI (FBnodes)
 * Video loader with file browser, drag-drop, and native video playback.
 * Uses ComfyUI's native video_upload widget with [output] path annotations
 * for output folder support.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    mediaFileUrl,
    getMediaRoots,
    classifySelection,
} from "./path_browser.js";
import { createFileBrowserModal } from "./file_browser.js";

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv'];

// Track videos that the browser can't decode (H265/yuv444) to skip browser attempt on future loads
const _nonBrowserDecodableVideos = new Set();

// Placeholder paths
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;
const PLACEHOLDER_VIDEO_PATH = new URL("./placeholder.mp4", import.meta.url).href;
const UNPLAYABLE_WARNING_LINE1 = "Video not compatible with browser";
const UNPLAYABLE_WARNING_LINE2 = "Use \u25B6 at the top to open in System Player";

/**
 * Strip [input]/[output]/[temp] annotation from a path
 */
function stripAnnotation(value) {
    if (!value) return value;
    return value.replace(/\s*\[(input|output|temp)\]\s*$/, '');
}

function isAbsolutePath(value) {
    if (!value) return false;
    return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(stripAnnotation(value));
}

function basenameForDisplay(value) {
    const s = String(value || "");
    const normalized = s.replace(/\\/g, "/");
    const i = normalized.lastIndexOf("/");
    return i >= 0 ? normalized.substring(i + 1) : normalized;
}

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
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
        y += getWidgetHeight(node, widget) + 4;
    }
    return y + 4;
}

function ensureMinWarningDisplaySize(node) {
    if (!node?._needsPlayabilityWarning) return false;

    const contentTop = getContentStartY(node);
    const minWarningAreaH = 100;
    const footerReserved = 74;
    const minBottomPad = 10;
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

function getNodeVideoElement(node) {
    return node.videoContainer?.querySelector('video')
        || node.widgets?.find(w => w.name === 'video-preview')?.element?.querySelector('video')
        || null;
}

function getPreviewContainer(node) {
    return node.videoContainer
        || node.widgets?.find(w => w.name === 'video-preview')?.element
        || null;
}

function applyWarningOverlay(node) {
    const host = getPreviewContainer(node);
    if (!host) return false;

    if (!host.style.position) {
        host.style.position = 'relative';
    }

    let overlay = host.querySelector('.fbnodes-playability-warning');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'fbnodes-playability-warning';
        overlay.style.position = 'absolute';
        overlay.style.left = '8px';
        overlay.style.right = '8px';
        overlay.style.top = '10px';
        overlay.style.bottom = '10px';
        overlay.style.pointerEvents = 'none';
        overlay.style.display = 'none';
        overlay.style.flexDirection = 'column';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.textAlign = 'center';
        overlay.style.font = '600 13px sans-serif';
        overlay.style.color = '#f6d27a';
        overlay.style.textShadow = '0 1px 2px rgba(0,0,0,0.8)';
        overlay.style.lineHeight = '1.25';
        host.appendChild(overlay);
    }

    if (node._needsPlayabilityWarning) {
        overlay.innerHTML = "";

        const line1 = document.createElement('div');
        line1.textContent = UNPLAYABLE_WARNING_LINE1;
        line1.style.font = '600 16px sans-serif';
        line1.style.color = 'rgba(255, 235, 235, 0.98)';

        const line2 = document.createElement('div');
        line2.textContent = UNPLAYABLE_WARNING_LINE2;
        line2.style.marginTop = '8px';
        line2.style.font = '600 14px sans-serif';
        line2.style.color = 'rgba(255, 235, 235, 0.92)';

        overlay.appendChild(line1);
        overlay.appendChild(line2);
        overlay.style.display = 'flex';
    } else {
        overlay.innerHTML = "";
        overlay.style.display = 'none';
    }

    return true;
}

function syncWarningOverlay(node, attempts = 0) {
    const applied = applyWarningOverlay(node);
    if (!applied && attempts < 10) {
        setTimeout(() => syncWarningOverlay(node, attempts + 1), 80);
    }
}

function createImagePreview(node, imageUrl) {
    let container = getPreviewContainer(node);
    if (!container || !container.classList?.contains('comfy-img-preview')) {
        container = document.createElement('div');
        container.classList.add('comfy-img-preview');
        node.videoContainer = container;

        if (!node.widgets?.some(w => w.name === 'video-preview')) {
            const w = node.addDOMWidget('video-preview', 'video', container, {
                canvasOnly: true,
                hideOnZoom: false
            });
            w.serialize = false;
            w.computeLayoutSize = () => ({
                minHeight: 256,
                minWidth: 256
            });
        }
    }

    // Remove existing dynamic media nodes and show a stable image preview.
    container.innerHTML = '';
    const img = document.createElement('img');
    img.src = imageUrl;
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    img.alt = 'Video frame preview';
    container.appendChild(img);

    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
}

function setStaticFramePreview(node, frameUrl) {
    const vid = getNodeVideoElement(node);
    if (vid) {
        try {
            vid.pause();
            vid.poster = frameUrl;
            const source = vid.querySelector('source');
            if (source) source.removeAttribute('src');
            vid.removeAttribute('src');
            vid.load();
            syncWarningOverlay(node);
            return true;
        } catch {
            // fall through to image preview
        }
    }

    createImagePreview(node, frameUrl);
    return true;
}

/**
 * Add [output] annotation to a path (only if source is not input)
 */
function annotatePath(filename, sourceFolder) {
    if (!filename || filename === '(none)') return filename;
    const stripped = stripAnnotation(filename);
    if (sourceFolder === 'output') {
        return `${stripped} [output]`;
    }
    return stripped;
}

/**
 * Fix the native video player's src to use the correct folder type.
 * The native player defaults to type=input; when source is output we
 * need to rewrite the URL so it fetches from the output directory.
 */
function fixVideoSrcFolder(node, filename, sourceFolder) {
    const vid = node.videoContainer?.querySelector('video')
        || node.widgets?.find(w => w.name === 'video-preview')?.element?.querySelector('video');
    if (!vid) return;

    // Build the correct URL
    let actualFilename = filename;
    let subfolder = "";
    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }
    let correctUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${sourceFolder}`;
    if (subfolder) correctUrl += `&subfolder=${encodeURIComponent(subfolder)}`;

    // Fix <source> child or direct src
    const source = vid.querySelector('source');
    if (source && source.src && source.src.includes('type=input')) {
        source.src = correctUrl;
        vid.load();
    } else if (vid.src && vid.src.includes('type=input')) {
        vid.src = correctUrl;
        vid.load();
    }
}

/**
 * Ask the server whether the video is H265/yuv444 (not browser-playable).
 * If so, generate a 1-frame H264 preview clip and display that instead.
 */
async function checkVideoPlayability(node, filename) {
    if (!filename || filename === '(none)') return;

    const sourceFolder = node._sourceFolder || 'input';

    // If already known non-decodable, go straight to server fallback
    if (_nonBrowserDecodableVideos.has(filename)) {
        node._needsPlayabilityWarning = true;
        node.setDirtyCanvas(true, true);
        loadServerPreviewClip(node, filename, sourceFolder);
        return;
    }

    try {
        const resp = await api.fetchApi(
            `/fbnodes/video-info?filename=${encodeURIComponent(filename)}&source=${sourceFolder}`
        );
        if (!resp.ok) return;
        const info = await resp.json();

        if (info.needs_preview) {
            console.log(`[LoadVideoPlus] Server reports ${info.codec}/${info.pix_fmt}, requesting preview clip: ${filename}`);
            _nonBrowserDecodableVideos.add(filename);
            node._needsPlayabilityWarning = true;
            node.setDirtyCanvas(true, true);
            loadServerPreviewClip(node, filename, sourceFolder);
        } else {
            node._needsPlayabilityWarning = false;
            node.setDirtyCanvas(true, true);
        }
    } catch (err) {
        console.warn(`[LoadVideoPlus] Could not check video info:`, err);
    }
}

/**
 * Ask the server to produce a 1-frame H264 mp4 from the H265 source,
 * then point the native video_upload widget at that clip so ComfyUI's
 * own player renders it with no special treatment.
 */
async function loadServerPreviewClip(node, filename, sourceFolder) {
    try {
        // Always provide a static JPEG poster fallback from the original source clip.
        const frameFallbackUrl = `/fbnodes/video-frame?filename=${encodeURIComponent(filename)}&source=${encodeURIComponent(sourceFolder)}&position=0`;

        if (setStaticFramePreview(node, frameFallbackUrl)) return;

        // Poll for up to 1 second waiting for the native player to initialise
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            if (setStaticFramePreview(node, frameFallbackUrl)) {
                clearInterval(poll);
            } else if (attempts >= 10) {
                clearInterval(poll);
                createImagePreview(node, frameFallbackUrl);
            }
        }, 100);
    } catch (err) {
        console.error(`[LoadVideoPlus] Error loading preview clip:`, err);
    }
}

/**
 * Create a video-preview DOM widget on the node, mirroring how ComfyUI's
 * native useNodeVideo adds one.  Used when the native player never
 * initialised (e.g. first selection is an H265 clip the browser can't decode).
 */
function createVideoPreview(node, clipViewUrl, posterUrl = null) {
    // Don't duplicate if one was created in the meantime
    if (node.videoContainer?.querySelector('video')) {
        const vid = node.videoContainer.querySelector('video');
        vid.src = clipViewUrl;
        vid.load();
        return;
    }

    const container = document.createElement('div');
    container.classList.add('comfy-img-preview');

    const vid = document.createElement('video');
    vid.playsInline = true;
    vid.controls = true;
    vid.loop = true;
    vid.muted = true;
    vid.style.cssText = 'width:100%;height:100%;object-fit:contain;';
    if (posterUrl) {
        vid.poster = posterUrl;
        vid.preload = 'metadata';
    }
    vid.src = clipViewUrl;
    container.appendChild(vid);

    node.videoContainer = container;

    // Only add the widget if one doesn't already exist
    if (!node.widgets?.some(w => w.name === 'video-preview')) {
        const w = node.addDOMWidget('video-preview', 'video', container, {
            canvasOnly: true,
            hideOnZoom: false
        });
        w.serialize = false;
        w.computeLayoutSize = () => ({
            minHeight: 256,
            minWidth: 256
        });
    }

    node.setDirtyCanvas(true, true);
}

async function getCurrentVideoPath(node) {
    const videoWidget = node.widgets?.find((w) => w.name === "video");
    const current = stripAnnotation(videoWidget?.value);
    if (!current || current === "(none)") return null;

    if (isAbsolutePath(current)) {
        return current;
    }

    const roots = await getMediaRoots();
    const sourceFolder = node._sourceFolder || "input";
    const root = sourceFolder === "output" ? roots.output : roots.input;
    if (!root) return null;

    const rootNorm = String(root).replace(/[\\/]+$/, "");
    const relNorm = String(current).replace(/^[\\/]+/, "");
    return `${rootNorm}/${relNorm}`;
}

async function openCurrentVideoInSystemPlayer(node) {
    const path = await getCurrentVideoPath(node);
    if (!path) return;

    try {
        const resp = await api.fetchApi("/fbnodes/open-in-player", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });

        if (!resp.ok) {
            let message = `Request failed (${resp.status})`;
            try {
                const body = await resp.json();
                if (body?.error) message = body.error;
            } catch {
                // ignore
            }
            console.warn("[LoadVideoPlus] Could not open in system player:", message);
        }
    } catch (error) {
        console.warn("[LoadVideoPlus] Could not open in system player:", error);
    }
}

/**
 * LoadVideoPlus extension registration
 */
app.registerExtension({
    name: "FBnodes.LoadVideoPlus",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "LoadVideoPlus") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            node._openPlayIconBounds = null;
            node._hoverOpenPlayIcon = false;
            node._needsPlayabilityWarning = false;
            node._playabilityCheckToken = 0;

            const setPlayabilityWarning = (enabled) => {
                node._needsPlayabilityWarning = Boolean(enabled);
                ensureMinWarningDisplaySize(node);
                syncWarningOverlay(node);
                node.setDirtyCanvas(true, true);
            };

            const runPlayabilityCheck = async (cleanFilename, onCompatible = null) => {
                const token = ++node._playabilityCheckToken;
                const filename = stripAnnotation(cleanFilename);

                if (!filename || filename === '(none)') {
                    if (token === node._playabilityCheckToken) {
                        setPlayabilityWarning(false);
                    }
                    return;
                }

                // Optimistic clear while checking the new selection.
                setPlayabilityWarning(false);

                if (_nonBrowserDecodableVideos.has(filename)) {
                    if (token !== node._playabilityCheckToken) return;
                    setPlayabilityWarning(true);
                    loadServerPreviewClip(node, filename, node._sourceFolder || 'input');
                    return;
                }

                const sourceFolder = node._sourceFolder || 'input';
                try {
                    const resp = await api.fetchApi(
                        `/fbnodes/video-info?filename=${encodeURIComponent(filename)}&source=${sourceFolder}`
                    );
                    if (!resp.ok) {
                        // If probe fails, do not block native preview for compatible clips.
                        if (token === node._playabilityCheckToken && typeof onCompatible === 'function') {
                            onCompatible();
                        }
                        return;
                    }

                    const info = await resp.json();
                    if (token !== node._playabilityCheckToken) return;

                    if (info.needs_preview) {
                        _nonBrowserDecodableVideos.add(filename);
                        setPlayabilityWarning(true);
                        loadServerPreviewClip(node, filename, sourceFolder);
                    } else {
                        setPlayabilityWarning(false);
                        if (typeof onCompatible === 'function') {
                            onCompatible();
                        }
                    }
                } catch (err) {
                    console.warn(`[LoadVideoPlus] Could not check video info:`, err);
                    if (token === node._playabilityCheckToken && typeof onCompatible === 'function') {
                        onCompatible();
                    }
                }
            };

            const onDrawForeground = node.onDrawForeground;
            node.onDrawForeground = function(ctx) {
                const drawResult = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

                if (!(node.flags && node.flags.collapsed)) {
                    syncWarningOverlay(node);

                    const videoWidgetForIcon = node.widgets?.find((w) => w.name === "video");
                    const currentValue = stripAnnotation(videoWidgetForIcon?.value);
                    if (currentValue && currentValue !== "(none)") {
                        const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;
                        const playX = node.size[0] - 8 - 14;
                        const playY = (titleHeight / 2) - 30;
                        const triSize = 8;

                        ctx.beginPath();
                        ctx.moveTo(playX - triSize, playY - triSize);
                        ctx.lineTo(playX - triSize, playY + triSize);
                        ctx.lineTo(playX + triSize, playY);
                        ctx.closePath();
                        ctx.fillStyle = node._hoverOpenPlayIcon ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
                        ctx.fill();

                        node._openPlayIconBounds = {
                            x: playX - triSize - 3,
                            y: playY - triSize - 3,
                            width: triSize * 2 + 6,
                            height: triSize * 2 + 6,
                        };
                    } else {
                        node._openPlayIconBounds = null;
                    }
                } else {
                    node._openPlayIconBounds = null;
                }

                return drawResult;
            };

            const onMouseMove = node.onMouseMove;
            node.onMouseMove = function(e, localPos, canvas) {
                const moveResult = onMouseMove ? onMouseMove.apply(this, arguments) : undefined;
                if (!node._openPlayIconBounds) return moveResult;

                const b = node._openPlayIconBounds;
                const inside = localPos[0] >= b.x && localPos[0] <= b.x + b.width && localPos[1] >= b.y && localPos[1] <= b.y + b.height;

                if (inside) {
                    canvas.canvas.style.cursor = 'pointer';
                    canvas.canvas.title = 'Play in system player';
                    if (!node._hoverOpenPlayIcon) {
                        node._hoverOpenPlayIcon = true;
                        node.setDirtyCanvas(true, true);
                    }
                } else {
                    if (node._hoverOpenPlayIcon) {
                        node._hoverOpenPlayIcon = false;
                        node.setDirtyCanvas(true, true);
                    }
                    if (canvas?.canvas?.title === 'Play in system player') {
                        canvas.canvas.title = '';
                        canvas.canvas.style.cursor = '';
                    }
                }

                return moveResult;
            };

            const onMouseDown = node.onMouseDown;
            node.onMouseDown = function(e, localPos, canvas) {
                if (node._openPlayIconBounds) {
                    const b = node._openPlayIconBounds;
                    const inside = localPos[0] >= b.x && localPos[0] <= b.x + b.width && localPos[1] >= b.y && localPos[1] <= b.y + b.height;
                    if (inside) {
                        openCurrentVideoInSystemPlayer(node);
                        return true;
                    }
                }
                return onMouseDown ? onMouseDown.apply(this, arguments) : undefined;
            };

            node._sourceFolder = 'input';
            let videoPickerWidget = null;
            node._videoPickerMap = { '(none)': '(none)' };

            const updateVideoPickerOptions = (values, preferredValue = null) => {
                if (!videoPickerWidget) return;

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

                node._videoPickerMap = map;
                videoPickerWidget.options.values = labels;

                const desired = stripAnnotation(preferredValue != null ? preferredValue : videoWidget?.value);
                if (desired && desired !== '(none)') {
                    const label = Object.keys(map).find((k) => map[k] === desired);
                    videoPickerWidget.value = label || '(none)';
                } else {
                    videoPickerWidget.value = '(none)';
                }
            };

            // Source folder widget
            const sourceFolderWidget = this.widgets?.find(w => w.name === "source_folder");
            if (sourceFolderWidget) {
                node._sourceFolder = sourceFolderWidget.value || 'input';
                // Hidden for backward compatibility: still serialized so old
                // workflows resolve relative paths, but driven by the browser now.
                hideWidget(sourceFolderWidget);
            }

            // Set the video combo to an arbitrary value (relative or absolute),
            // adding it to the option list so the combo can display it.
            const setVideoFilename = (value) => {
                if (!videoWidget) return;
                if (!videoWidget.options) videoWidget.options = {};
                const values = videoWidget.options.values;
                if (Array.isArray(values)) {
                    if (value && !values.includes(value)) {
                        videoWidget.options.values = [...values, value];
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
                        videoWidget.options.values = { ...values, [label]: value };
                    }
                } else {
                    videoWidget.options.values = ["(none)"];
                    if (value && value !== "(none)") {
                        videoWidget.options.values.push(value);
                    }
                }
                videoWidget.value = value;
                if (videoWidget.callback) videoWidget.callback(value);

                const map = node._videoPickerMap || { '(none)': '(none)' };
                const currentLabel = Object.keys(map).find((k) => map[k] === value);
                if (videoPickerWidget) {
                    videoPickerWidget.value = currentLabel || '(none)';
                }
                node.setDirtyCanvas(true);
            };

            const refreshVideoOptionsForBrowsePath = async (browsePath, preferredValue = null) => {
                if (!videoWidget || !browsePath) return false;
                try {
                    const roots = await getMediaRoots();
                    const resp = await api.fetchApi(
                        `/fbnodes/path-browser/list?path=${encodeURIComponent(browsePath)}&kind=video`
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

                    const desired = stripAnnotation(preferredValue != null ? preferredValue : videoWidget.value);
                    videoWidget.options.values = ['(none)', ...mapped];
                    updateVideoPickerOptions(mapped, desired);
                    if (desired && desired !== '(none)') videoWidget.value = desired;
                    return true;
                } catch (err) {
                    console.warn('[LoadVideoPlus] Could not refresh options for browse path:', err);
                    return false;
                }
            };

            // Video widget
            const videoWidget = this.widgets?.find(w => w.name === "video");
            if (videoWidget) {
                hideWidget(videoWidget);
                const videoWidgetIndex = this.widgets.indexOf(videoWidget);

                // Hook into video widget callback to detect H265 and show server-extracted frame
                const origVideoCallback = videoWidget.callback;
                videoWidget.callback = function(value) {
                    const clean = stripAnnotation(value);

                    if (!clean || clean === '(none)') {
                        node._playabilityCheckToken++;
                        setPlayabilityWarning(false);
                    }

                    if (clean && clean !== '(none)') {
                        const applyNativePreview = () => {
                            // Files outside input/output are absolute paths the native
                            // player can't fetch via /view; render through raw-file URL.
                            if (isAbsolutePath(value)) {
                                if (origVideoCallback) origVideoCallback.apply(this, arguments);
                                videoWidget.value = clean;
                                createVideoPreview(node, mediaFileUrl(clean));
                                return;
                            }

                            // The native player reads widget.value to build the video URL.
                            // Temporarily set value with [output] so it resolves correctly,
                            // then restore the clean name for display.
                            if (node._sourceFolder === 'output') {
                                videoWidget.value = clean + ' [output]';
                            }
                            if (origVideoCallback) origVideoCallback.apply(this, arguments);
                            if (clean) videoWidget.value = clean;
                        };

                        // Compatibility is resolved first. Incompatible clips never go through native playback.
                        runPlayabilityCheck(clean, applyNativePreview);
                    } else {
                        // Show placeholder video when nothing is selected
                        setTimeout(() => {
                            const vid = node.videoContainer?.querySelector('video')
                                || node.widgets?.find(w => w.name === 'video-preview')?.element?.querySelector('video');
                            if (vid) {
                                const source = vid.querySelector('source');
                                if (source) {
                                    source.src = PLACEHOLDER_VIDEO_PATH;
                                    source.removeAttribute('type');
                                } else {
                                    vid.src = PLACEHOLDER_VIDEO_PATH;
                                }
                                vid.load();
                            } else {
                                createVideoPreview(node, PLACEHOLDER_VIDEO_PATH);
                            }
                        }, 100);
                    }
                };

                videoPickerWidget = this.addWidget(
                    'combo',
                    'file',
                    '(none)',
                    (label) => {
                        const selected = node._videoPickerMap?.[label] || '(none)';
                        setVideoFilename(selected);
                    },
                    { values: ['(none)'] }
                );
                videoPickerWidget.serialize = false;

                const pickerIndex = this.widgets.indexOf(videoPickerWidget);
                if (pickerIndex >= 0) {
                    this.widgets.splice(pickerIndex, 1);
                    this.widgets.splice(videoWidgetIndex + 1, 0, videoPickerWidget);
                }

                // Browse Files button
                const browseButton = {
                    type: "button",
                    name: "\u{1F4C1} Browse Files",
                    value: null,
                    callback: async () => {
                        const roots = await getMediaRoots();
                        let initial = node.properties?._browsePath || "";
                        if (!initial) {
                            const sf = node.widgets?.find(w => w.name === "source_folder")?.value || "input";
                            initial = sf === "output" ? roots.output : roots.input;
                        }
                        const sf = node.widgets?.find(w => w.name === "source_folder")?.value || "input";
                        const currentSelection = stripAnnotation(videoWidget.value);
                        let selectedAbsPath = "";
                        if (currentSelection && currentSelection !== "(none)") {
                            if (isAbsolutePath(currentSelection)) {
                                selectedAbsPath = currentSelection;
                            } else {
                                const root = sf === "output" ? roots.output : roots.input;
                                if (root) {
                                    const rootNorm = String(root).replace(/[\\/]+$/, "");
                                    const relNorm = String(currentSelection).replace(/^[\\/]+/, "");
                                    selectedAbsPath = `${rootNorm}/${relNorm}`;
                                }
                            }
                        }
                        createFileBrowserModal(
                            currentSelection,
                            (selected, meta) => {
                                if (!node.properties) node.properties = {};
                                if (meta && meta.absPath) {
                                    node.properties._browsePath = meta.dir;
                                    const cls = classifySelection(meta.absPath, meta.roots);
                                    const sfW = node.widgets?.find(w => w.name === "source_folder");
                                    if (cls.sourceFolder && sfW) {
                                        sfW.value = cls.sourceFolder;
                                        node._sourceFolder = cls.sourceFolder;
                                    }
                                    setVideoFilename(cls.value);
                                    refreshVideoOptionsForBrowsePath(meta.dir, cls.value);
                                } else {
                                    setVideoFilename(selected);
                                    if (node.properties?._browsePath) {
                                        refreshVideoOptionsForBrowsePath(node.properties._browsePath, selected);
                                    }
                                }
                            },
                            sf,
                            {
                                enableNavigation: true,
                                initialPath: initial,
                                selectedAbsPath,
                                viewMode: node.properties?._fileBrowserViewMode || "medium",
                                onViewModeChange: (mode) => {
                                    if (!node.properties) node.properties = {};
                                    node.properties._fileBrowserViewMode = mode;
                                },
                                navKind: "video",
                                allowedTypes: ["video"],
                            }
                        );
                    },
                    serialize: false
                };
                this.widgets.splice(videoWidgetIndex + 2, 0, browseButton);
                Object.defineProperty(browseButton, "node", { value: node });
            }

            // Show placeholder video on initial node creation
            if (videoWidget && (!videoWidget.value || videoWidget.value === '(none)')) {
                setTimeout(() => createVideoPreview(node, PLACEHOLDER_VIDEO_PATH), 100);
            }

            // Restore on workflow load
            const onConfigure = node.onConfigure;
            node._initialConfigDone = false;
            node.onConfigure = function(info) {
                const isFirstConfigure = !node._initialConfigDone;
                node._initialConfigDone = true;

                const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;

                const sfWidget = this.widgets?.find(w => w.name === "source_folder");
                if (sfWidget) node._sourceFolder = sfWidget.value || 'input';

                const hasBrowsePath = Boolean(node.properties?._browsePath);

                if (!hasBrowsePath && node._sourceFolder === 'output' && videoWidget) {
                    api.fetchApi(`/fbnodes/list-files?source=output`).then(resp => {
                        if (resp.ok) return resp.json();
                    }).then(data => {
                        if (data && data.files) {
                            const savedValue = videoWidget.value;
                            const savedStripped = stripAnnotation(savedValue);
                            const videoFiles = data.files.filter(f => {
                                const ext = f.split('.').pop().toLowerCase();
                                return VIDEO_EXTENSIONS.includes(ext);
                            });
                            videoWidget.options.values = ["(none)", ...videoFiles];
                            updateVideoPickerOptions(videoFiles, savedStripped);
                            // Restore the saved value
                            if (savedStripped && videoFiles.includes(savedStripped)) {
                                videoWidget.value = savedStripped;
                                // Only trigger H265 detection on first load;
                                // on tab switch the native player handles it
                                if (isFirstConfigure) {
                                    if (videoWidget.callback) videoWidget.callback(savedStripped);
                                }
                            }
                        }
                    }).catch(() => {});
                }

                if (hasBrowsePath && videoWidget) {
                    refreshVideoOptionsForBrowsePath(node.properties._browsePath, videoWidget.value);
                }

                // Check video playability (H265/yuv444 fallback).
                // Server check is fast and the preview clip is cached in temp/.
                if (videoWidget) {
                    const filename = stripAnnotation(videoWidget.value);
                    if (isAbsolutePath(filename)) {
                        // Out-of-tree absolute path: render via our raw-file route,
                        // then detect H265/yuv444 and swap in a server preview clip.
                        setTimeout(() => {
                            createVideoPreview(node, mediaFileUrl(filename));
                            runPlayabilityCheck(filename);
                        }, 200);
                    } else if (filename && filename !== '(none)') {
                        // Ensure native player can resolve output files
                        if (node._sourceFolder === 'output') {
                            videoWidget.value = filename + ' [output]';
                            setTimeout(() => { videoWidget.value = filename; }, 200);
                        }
                        setTimeout(() => runPlayabilityCheck(filename), 500);
                    } else {
                        node._playabilityCheckToken++;
                        setPlayabilityWarning(false);
                        // Show placeholder when no video is selected
                        setTimeout(() => {
                            const vid = node.videoContainer?.querySelector('video')
                                || node.widgets?.find(w => w.name === 'video-preview')?.element?.querySelector('video');
                            if (vid) {
                                const source = vid.querySelector('source');
                                if (source) {
                                    source.src = PLACEHOLDER_VIDEO_PATH;
                                    source.removeAttribute('type');
                                } else {
                                    vid.src = PLACEHOLDER_VIDEO_PATH;
                                }
                                vid.load();
                            } else {
                                createVideoPreview(node, PLACEHOLDER_VIDEO_PATH);
                            }
                        }, 100);
                    }
                }

                return result;
            };

            // Drag and drop (video files only)
            node.onDragOver = function(e) {
                if (e.dataTransfer && e.dataTransfer.items) {
                    e.preventDefault();
                    e.stopPropagation();
                    return true;
                }
                return false;
            };

            node.onDragDrop = async function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return false;

                const file = e.dataTransfer.files[0];
                const filename = file.name;
                const ext = filename.split('.').pop().toLowerCase();
                if (!VIDEO_EXTENSIONS.includes(ext)) return false;

                const formData = new FormData();
                formData.append('image', file);
                formData.append('subfolder', '');
                formData.append('type', 'input');

                try {
                    const response = await api.fetchApi('/upload/image', { method: 'POST', body: formData });
                    if (response.ok) {
                        const data = await response.json();
                        if (videoWidget) {
                            // Switch to input folder since drag-drop uploads to input
                            if (sourceFolderWidget && node._sourceFolder !== 'input') {
                                sourceFolderWidget.value = 'input';
                                if (typeof sourceFolderWidget.callback === 'function') {
                                    await sourceFolderWidget.callback('input');
                                } else {
                                    node._sourceFolder = 'input';
                                }
                            }

                            try {
                                const listResponse = await api.fetchApi(`/fbnodes/list-files?source=input`);
                                if (listResponse.ok) {
                                    const listData = await listResponse.json();
                                    const videoFiles = (listData.files || []).filter(f => {
                                        const ext2 = f.split('.').pop().toLowerCase();
                                        return VIDEO_EXTENSIONS.includes(ext2);
                                    });
                                    videoWidget.options.values = ["(none)", ...videoFiles];
                                }
                            } catch (err) {
                                console.warn('[LoadVideoPlus] Could not refresh file list:', err);
                            }

                            const uploadedName = data.name || data.filename || filename;
                            videoWidget.value = uploadedName;
                            if (videoWidget.callback) videoWidget.callback(uploadedName);
                            node.setDirtyCanvas(true);
                        }
                    }
                } catch (error) {
                    console.error("[LoadVideoPlus] Error uploading video:", error);
                }
                return true;
            };

            return result;
        };
    }
});
