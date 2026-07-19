/**
 * Load Image Extension for ComfyUI (FBnodes)
 * Stripped-down image/video loader with file browser, preview, and drag-drop.
 * No metadata extraction - just loads and displays images/video frames.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    mediaFileUrl,
    getMediaRoots,
    classifySelection,
} from "./path_browser.js";
import { createFileBrowserModal } from "./file_browser.js";

// Placeholder image path
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;
const MASK_TOOLBAR_MIN_WIDTH = 300;
const MASK_TOOLBAR_HEIGHT = 26;
const MASK_PANEL_INSET = 10;
const MASK_MIN_HEIGHT = 320;
const MASK_RESIZE_STRIP = 18;
const MASK_PREVIEW_FRAME_GAP = 6;
const MASK_FOOTER_HEIGHT = 24;
const MASK_TOOLBAR_FRAME_HEIGHT = MASK_TOOLBAR_HEIGHT + 2;
const MASK_TOP_INSET_OFF = 0;
const MASK_TOP_INSET_ON = MASK_TOOLBAR_FRAME_HEIGHT + 2;

// Track videos that the browser can't decode (H265/yuv444) to skip browser attempt on future scrubs
const _nonBrowserDecodableVideos = new Set();

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

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

function isNodeBypassed(node) {
    return !!(node?.mode === 4 || node?.flags?.bypass || node?.flags?.bypassed);
}

function drawBypassVeil(ctx, node) {
    if (!isNodeBypassed(node) || (node.flags && node.flags.collapsed)) return;
    const titleH = Number(LiteGraph?.NODE_TITLE_HEIGHT || 30);
    const bodyH = Math.max(0, Number(node.size?.[1] || 0) - titleH);
    if (bodyH <= 0) return;

    ctx.save();
    try {
        ctx.fillStyle = "rgba(12, 14, 18, 0.45)";
        ctx.fillRect(0, titleH, Number(node.size?.[0] || 0), bodyH);
    } finally {
        ctx.restore();
    }
}

/**
 * Build a preview URL for a filename. Absolute paths (browsed from anywhere)
 * stream through the raw-file route; relative names use ComfyUI's /view.
 */
function buildPreviewUrl(filename, viewType) {
    if (isAbsolutePath(filename)) {
        return mediaFileUrl(filename);
    }
    let actualFilename = filename;
    let subfolder = "";
    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }
    let url = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType || 'input'}`;
    if (subfolder) {
        url += `&subfolder=${encodeURIComponent(subfolder)}`;
    }
    return url;
}

/**
 * Check if filename is a video file
 */
function isVideoFile(filename) {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv'].includes(ext);
}

/**
 * Check if filename is a previewable file (image or video)
 */
function isPreviewableFile(filename) {
    if (!filename || filename === '(none)') return false;
    const ext = filename.split('.').pop().toLowerCase();
    const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
    const videoExtensions = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv'];
    return imageExtensions.includes(ext) || videoExtensions.includes(ext);
}

/**
 * Send video frame to Python backend for caching
 */
async function cacheVideoFrame(filename, frameData, framePosition) {
    try {
        const response = await api.fetchApi("/fbnodes/cache-video-frame", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename, frame: frameData, frame_position: framePosition })
        });

        if (response.ok) {
            console.log(`[LoadImagePlus] Cached video frame at position ${framePosition.toFixed(2)} for: ${filename}`);
        } else {
            console.error("[LoadImagePlus] Failed to cache video frame:", response.status);
        }
    } catch (error) {
        console.error("[LoadImagePlus] Error caching video frame:", error);
    }
}

/**
 * Create and show image preview modal
 */
function showImagePreviewModal(filename, viewType) {
    const imageUrl = buildPreviewUrl(filename, viewType);

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.85); z-index: 10000;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0;
        padding: 15px 20px; display: flex; justify-content: space-between;
        align-items: center; background: rgba(0, 0, 0, 0.5);
    `;

    const title = document.createElement('span');
    title.textContent = filename;
    title.style.cssText = `
        color: #fff; font-size: 14px; font-family: sans-serif;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        max-width: calc(100% - 50px);
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.1); border: none; color: #fff;
        font-size: 20px; width: 36px; height: 36px; border-radius: 50%;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background 0.2s;
    `;
    closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);

    const imageContainer = document.createElement('div');
    imageContainer.style.cssText = `
        max-width: 90%; max-height: 80%; display: flex;
        align-items: center; justify-content: center;
    `;

    const img = document.createElement('img');
    img.src = imageUrl;
    img.style.cssText = `
        max-width: 100%; max-height: 80vh; border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    `;
    img.onerror = () => {
        imageContainer.innerHTML = `
            <div style="color: #ff6666; font-family: sans-serif; text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">\u26A0\uFE0F</div>
                <div>Failed to load image</div>
                <div style="font-size: 12px; margin-top: 5px; opacity: 0.7;">${filename}</div>
            </div>
        `;
    };

    imageContainer.appendChild(img);

    const hint = document.createElement('div');
    hint.textContent = 'Press ESC or click outside to close';
    hint.style.cssText = `
        position: absolute; bottom: 20px;
        color: rgba(255, 255, 255, 0.5); font-size: 12px; font-family: sans-serif;
    `;

    overlay.appendChild(header);
    overlay.appendChild(imageContainer);
    overlay.appendChild(hint);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const handleKeydown = (e) => {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handleKeydown); }
    };
    document.addEventListener('keydown', handleKeydown);
    document.body.appendChild(overlay);
}

/**
 * Create and show video preview modal
 */
function showVideoPreviewModal(filename, viewType) {
    const videoUrl = buildPreviewUrl(filename, viewType);

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.85); z-index: 10000;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0;
        padding: 15px 20px; display: flex; justify-content: space-between;
        align-items: center; background: rgba(0, 0, 0, 0.5);
    `;

    const title = document.createElement('span');
    title.textContent = filename;
    title.style.cssText = `
        color: #fff; font-size: 14px; font-family: sans-serif;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        max-width: calc(100% - 50px);
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.1); border: none; color: #fff;
        font-size: 20px; width: 36px; height: 36px; border-radius: 50%;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background 0.2s;
    `;
    closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);

    const videoContainer = document.createElement('div');
    videoContainer.style.cssText = `
        max-width: 90%; max-height: 80%; display: flex;
        align-items: center; justify-content: center;
    `;

    const video = document.createElement('video');
    video.src = videoUrl;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.style.cssText = `
        max-width: 100%; max-height: 80vh; border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    `;
    video.onerror = () => {
        // Browser can't decode (H265/yuv444) - show server-extracted frame with overlay
        const viewType = 'input'; // default for preview modal
        const frameUrl = `/fbnodes/video-frame?filename=${encodeURIComponent(filename)}&source=${viewType}&position=0`;
        const fallbackImg = document.createElement('img');
        fallbackImg.style.cssText = `
            max-width: 100%; max-height: 80vh; border-radius: 8px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        `;
        fallbackImg.onload = () => {
            videoContainer.innerHTML = '';
            videoContainer.style.position = 'relative';
            videoContainer.appendChild(fallbackImg);
            // Add overlay message
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: rgba(0, 0, 0, 0.75); color: #ccc; padding: 8px 16px;
                border-radius: 6px; font-family: sans-serif; font-size: 13px;
                pointer-events: none; white-space: nowrap;
            `;
            overlay.textContent = 'H265/yuv444 \u2014 browser playback not supported';
            videoContainer.appendChild(overlay);
        };
        fallbackImg.onerror = () => {
            videoContainer.innerHTML = `
                <div style="color: #aaa; font-family: sans-serif; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 10px;">\uD83C\uDFAC</div>
                    <div>This video format cannot be played in the browser</div>
                    <div style="font-size: 12px; margin-top: 5px; opacity: 0.7;">H265 or yuv444 encoded</div>
                </div>
            `;
        };
        fallbackImg.src = frameUrl;
    };

    videoContainer.appendChild(video);

    const hint = document.createElement('div');
    hint.textContent = 'Press ESC or click outside to close';
    hint.style.cssText = `
        position: absolute; bottom: 20px;
        color: rgba(255, 255, 255, 0.5); font-size: 12px; font-family: sans-serif;
    `;

    overlay.appendChild(header);
    overlay.appendChild(videoContainer);
    overlay.appendChild(hint);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const handleKeydown = (e) => {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handleKeydown); }
    };
    document.addEventListener('keydown', handleKeydown);
    document.body.appendChild(overlay);
    video.focus();
}

/**
 * Strip ComfyUI annotated filepath suffix, e.g. "file.png [input]" -> "file.png"
 */
function stripAnnotation(filename) {
    if (!filename) return filename;
    const match = filename.match(/^(.+)\s+\[(input|output|temp)\]$/);
    return match ? match[1] : filename;
}

function beginPreviewRequest(node, filename, framePosition = 0) {
    node._previewRequestId = (node._previewRequestId || 0) + 1;
    if (!node.properties) node.properties = {};
    // Persist the intended state immediately so tab-switch restores the latest selection.
    node.properties._loadedImageFilename = filename;
    node.properties._loadedFramePosition = framePosition;
    return node._previewRequestId;
}

function isStalePreviewRequest(node, requestId, expectedFilename) {
    if (node._previewRequestId !== requestId) return true;
    const imageWidget = node.widgets?.find(w => w.name === "image");
    const currentFilename = stripAnnotation(imageWidget?.value);
    return !!expectedFilename && currentFilename !== expectedFilename;
}

/**
 * Load and display an image in the node (simplified - no metadata extraction)
 */
async function loadAndDisplayImage(node, filename) {
    if (!filename || filename === '(none)') {
        showEmptyPreview(node);
        return;
    }
    filename = stripAnnotation(filename);
    const framePositionWidget = node.widgets?.find(w => w.name === "frame_position");
    const framePosition = framePositionWidget ? framePositionWidget.value : 0.0;
    const requestId = beginPreviewRequest(node, filename, framePosition);

    const ext = filename.split('.').pop().toLowerCase();

    if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) {
        loadVideoFrame(node, filename, requestId);
        return;
    }

    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        loadImageFile(node, filename, requestId);
        return;
    }

    showPlaceholder(node, requestId);
}

function showEmptyPreview(node, requestId = null) {
    if (requestId != null && node._previewRequestId !== requestId) {
        return;
    }
    if (!node.properties) node.properties = {};
    node.properties._loadedImageFilename = null;
    node.properties._loadedFramePosition = null;

    node.imgs = [];
    node.imageIndex = 0;
    node._maskDomSourceImg = null;

    const dom = node._maskDom;
    if (dom) {
        dom.hasImage = false;
        dom.img.removeAttribute("src");
        dom.imgWrap.style.display = "none";
        dom.toolbar.style.display = "none";
        dom.toolbarFrame.style.display = "none";
        dom.previewFrame.style.display = "block";
        dom.footer.style.display = "block";
        dom.footerText.textContent = "—";
        const ctx = dom.canvas?.getContext?.("2d");
        if (ctx && dom.canvas.width > 0 && dom.canvas.height > 0) {
            ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
        }
        dom.cursor.style.display = "none";
    }

    node.setDirtyCanvas(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

/**
 * Load an image file and display it (no metadata extraction)
 */
async function loadImageFile(node, filename, requestId) {
    try {
        const viewType = node._sourceFolder || 'input';

        let fileUrl = buildPreviewUrl(filename, viewType);

        const img = new Image();
        img.onload = () => {
            if (isStalePreviewRequest(node, requestId, filename)) {
                return;
            }
            node.imgs = [img];
            node.imageIndex = 0;
            updateMaskDomImage(node);
            if (!node.properties) node.properties = {};
            node.properties._loadedFramePosition = 0;

            node.setDirtyCanvas(true, true);
            app.graph.setDirtyCanvas(true, true);
        };

        img.onerror = () => {
            if (isStalePreviewRequest(node, requestId, filename)) {
                return;
            }
            console.error(`[LoadImagePlus] Failed to load image: ${filename}`);
            showPlaceholder(node, requestId);
        };

        img.src = `${fileUrl}&${Date.now()}`;
    } catch (error) {
        console.error("[LoadImagePlus] Error loading image:", error);
        showPlaceholder(node, requestId);
    }
}

/**
 * Load a video frame from the server-side PyAV endpoint (for H265/yuv444 videos).
 */
function loadVideoFrameFromServer(node, filename, framePosition, viewType, requestId) {
    const frameUrl = `/fbnodes/video-frame?filename=${encodeURIComponent(filename)}&source=${viewType}&position=${framePosition}`;
    const img = new Image();
    img.onload = () => {
        if (isStalePreviewRequest(node, requestId, filename)) {
            return;
        }
        node.imgs = [img];
        node.imageIndex = 0;
        updateMaskDomImage(node);
        if (!node.properties) node.properties = {};
        node.properties._loadedFramePosition = framePosition;

        // Cache as base64 for Python backend
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const frameData = canvas.toDataURL('image/png');
        cacheVideoFrame(filename, frameData, framePosition);

        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);
    };
    img.onerror = () => {
        if (isStalePreviewRequest(node, requestId, filename)) {
            return;
        }
        console.error(`[LoadImagePlus] Server-side frame extraction failed for: ${filename}`);
        showPlaceholder(node, requestId);
    };
    img.src = frameUrl;
}

/**
 * Load frame from a video file at specified position
 */
async function loadVideoFrame(node, filename, requestId = null) {
    let activeRequestId = requestId;
    try {
        const framePositionWidget = node.widgets?.find(w => w.name === "frame_position");
        const framePosition = framePositionWidget ? framePositionWidget.value : 0.0;
        activeRequestId = requestId ?? beginPreviewRequest(node, filename, framePosition);
        const viewType = node._sourceFolder || 'input';

        let videoUrl = buildPreviewUrl(filename, viewType);

        // If this video is already known to be non-browser-decodable, go straight to server
        if (_nonBrowserDecodableVideos.has(filename)) {
            loadVideoFrameFromServer(node, filename, framePosition, viewType, activeRequestId);
            return;
        }

        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

        const cleanupVideo = () => {
            video.onloadedmetadata = null;
            video.onseeked = null;
            video.onerror = null;
            try { video.src = ''; video.load(); } catch (e) { /* ignore */ }
            if (video.parentNode) video.parentNode.removeChild(video);
        };

        video.onloadedmetadata = () => {
            const frameTime = framePosition * Math.max(0, video.duration - 0.1);
            video.currentTime = frameTime;
        };

        video.onseeked = () => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const img = new Image();
            img.onload = () => {
                if (isStalePreviewRequest(node, activeRequestId, filename)) {
                    cleanupVideo();
                    return;
                }
                node.imgs = [img];
                node.imageIndex = 0;
                updateMaskDomImage(node);
                if (!node.properties) node.properties = {};
                node.properties._loadedFramePosition = framePosition;

                const frameData = canvas.toDataURL('image/png');
                cacheVideoFrame(filename, frameData, framePosition);

                node.setDirtyCanvas(true, true);
                app.graph.setDirtyCanvas(true, true);
                cleanupVideo();
            };

            img.onerror = () => {
                if (isStalePreviewRequest(node, activeRequestId, filename)) {
                    cleanupVideo();
                    return;
                }
                console.error(`[LoadImagePlus] Failed to create image from video frame`);
                cleanupVideo();
                showPlaceholder(node, activeRequestId);
            };

            img.src = canvas.toDataURL('image/png');
        };

        video.onerror = () => {
            if (isStalePreviewRequest(node, activeRequestId, filename)) {
                cleanupVideo();
                return;
            }
            console.log(`[LoadImagePlus] Browser cannot decode video, using server-side extraction: ${filename}`);
            // Remember this video can't be decoded by browser - skip browser attempt on future scrubs
            _nonBrowserDecodableVideos.add(filename);
            cleanupVideo();
            loadVideoFrameFromServer(node, filename, framePosition, viewType, activeRequestId);
        };

        document.body.appendChild(video);
        video.src = videoUrl + `&${Date.now()}`;
    } catch (error) {
        console.error("[LoadImagePlus] Error loading video:", error);
        if (activeRequestId != null) {
            showPlaceholder(node, activeRequestId);
        }
    }
}

/**
 * Show placeholder image
 */
function showPlaceholder(node, requestId = null) {
    if (requestId != null && node._previewRequestId !== requestId) {
        return;
    }
    // Clear persisted state
    if (!node.properties) node.properties = {};
    node.properties._loadedImageFilename = null;
    node.properties._loadedFramePosition = null;

    const placeholderImg = new Image();
    placeholderImg.src = PLACEHOLDER_IMAGE_PATH;
    placeholderImg.onload = () => {
        node.imgs = [placeholderImg];
        node.imageIndex = 0;
        updateMaskDomImage(node);

        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);
    };
}

function getMaskDataWidget(node) {
    return node.widgets?.find(w => w.name === "mask_data") || null;
}

function parseMaskData(value) {
    if (!value || typeof value !== "string") {
        return { version: 1, brushSize: 64, erasing: false, strokes: [] };
    }
    try {
        const data = JSON.parse(value);
        return {
            version: 1,
            brushSize: Math.max(1, Number(data?.brushSize || 64)),
            erasing: !!data?.erasing,
            strokes: Array.isArray(data?.strokes) ? data.strokes : [],
        };
    } catch (err) {
        return { version: 1, brushSize: 64, erasing: false, strokes: [] };
    }
}

function ensureMaskState(node) {
    if (!node._maskState) {
        // Vector strokes for editing/undo live in node.properties._maskStrokes
        // (persisted across tab switches / in the workflow). The mask_data widget
        // itself holds a rasterized PNG data URL for the backend (TrixLoader
        // style), so parse strokes from properties, falling back to a legacy
        // JSON widget value for old workflows.
        const strokeJson = node.properties?._maskStrokes
            || (typeof getMaskDataWidget(node)?.value === "string" && getMaskDataWidget(node).value.startsWith("{")
                ? getMaskDataWidget(node).value : "");
        const parsed = parseMaskData(strokeJson);
        node._maskState = {
            enabled: false,
            brushSize: parsed.brushSize,
            erasing: parsed.erasing,
            hideWhilePressed: false,
            drawing: false,
            activeControl: null,
            activeStroke: null,
            strokes: parsed.strokes,
            redo: [],
        };
    }
    return node._maskState;
}

// Rasterize the current strokes into a full-strength PNG data URL at the image's
// natural resolution. The alpha channel encodes mask coverage, exactly matching
// what the user drew (no server-side re-rendering mismatch). This mirrors how
// ComfyUI-TrixLoader saves its mask (canvas -> PNG data URL -> backend decodes
// the alpha channel).
function buildMaskDataURL(node) {
    const state = ensureMaskState(node);
    if (!state.strokes || state.strokes.length === 0) return "";
    const img = getCurrentPreviewImage(node);
    const domCanvas = node._maskDom?.canvas;
    const width = Math.max(1, img?.naturalWidth || img?.width || domCanvas?.width || 512);
    const height = Math.max(1, img?.naturalHeight || img?.height || domCanvas?.height || 512);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const rect = { x: 0, y: 0, w: width, h: height };
    for (const stroke of state.strokes) {
        drawSmoothMaskStroke(ctx, stroke, rect);
    }
    return canvas.toDataURL("image/png");
}

function syncMaskData(node) {
    const state = ensureMaskState(node);
    // Backend consumes a rasterized PNG data URL (TrixLoader style). When Mask is
    // turned off we output NOTHING (empty value) so the node returns no mask,
    // while still keeping the strokes below so they come back if re-enabled.
    const widget = getMaskDataWidget(node);
    if (widget) widget.value = state.enabled ? buildMaskDataURL(node) : "";
    // Editable vector strokes persist separately so undo/redo survives reloads.
    if (!node.properties) node.properties = {};
    node.properties._maskStrokes = state.strokes.length > 0 ? JSON.stringify({
        version: 1,
        brushSize: state.brushSize,
        erasing: state.erasing,
        strokes: state.strokes,
    }) : "";
    node.setDirtyCanvas(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function pointInRect(pos, rect) {
    return !!rect && pos[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
}

function getMaskBodyTop(node) {
    const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;
    const widgetHeight = LiteGraph.NODE_WIDGET_HEIGHT || 20;
    const visibleWidgets = (node.widgets || []).filter(w => !w.hidden && Number.isFinite(w.last_y));
    if (visibleWidgets.length === 0) return titleHeight;

    let bottom = titleHeight;
    for (const widget of visibleWidgets) {
        const widgetSize = typeof widget.computeSize === "function" ? widget.computeSize(node.size?.[0] || 320) : null;
        const height = Number(widgetSize?.[1]) || widgetHeight;
        bottom = Math.max(bottom, widget.last_y + Math.max(1, height));
    }
    return bottom + 6;
}

function getMaskBodyRect(node) {
    const bodyTop = Math.min(Math.max(0, getMaskBodyTop(node)), Math.max(0, (node.size?.[1] || 1) - 1));
    return {
        x: 0,
        y: bodyTop,
        w: Math.max(1, node.size?.[0] || 1),
        h: Math.max(1, (node.size?.[1] || bodyTop + 1) - bodyTop),
    };
}

function consumeMaskPointerEvent(event, canvas, node) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (canvas) {
        if (canvas.node_dragged === node) canvas.node_dragged = null;
        if (canvas.dragging_node === node) canvas.dragging_node = null;
    }
}

function roundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
}

function firstFiniteNumber(values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return NaN;
}

function getImageDrawRect(node) {
    const img = node.imgs?.[node.imageIndex || 0] || node.imgs?.[0];
    const bodyRect = getMaskBodyRect(node);
    if (!img) return bodyRect;

    const candidates = [
        node._imageRect,
        node.imageRect,
        Array.isArray(node.imageRects) ? node.imageRects[node.imageIndex || 0] : null,
    ];
    for (const r of candidates) {
        if (!r) continue;
        const x = firstFiniteNumber([r.x, r[0]]);
        const y = firstFiniteNumber([r.y, r[1]]);
        const w = firstFiniteNumber([r.w, r.width, r[2]]);
        const h = firstFiniteNumber([r.h, r.height, r[3]]);
        if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0) {
            return { x, y, w, h };
        }
    }

    const imgW = img.naturalWidth || img.videoWidth || img.width || 1;
    const imgH = img.naturalHeight || img.videoHeight || img.height || 1;
    const scale = Math.min(bodyRect.w / imgW, bodyRect.h / imgH);
    const w = imgW * scale;
    const h = imgH * scale;
    return {
        x: bodyRect.x + (bodyRect.w - w) * 0.5,
        y: bodyRect.y + (bodyRect.h - h) * 0.5,
        w,
        h,
    };
}

function ensureMaskNodeWidth(node) {
    if (!node?.size || node.size[0] >= MASK_TOOLBAR_MIN_WIDTH) return;
    if (typeof node.setSize === "function") {
        node.setSize([MASK_TOOLBAR_MIN_WIDTH, node.size[1]]);
    } else {
        node.size[0] = MASK_TOOLBAR_MIN_WIDTH;
    }
}

function localToMaskPoint(pos, rect) {
    return [
        clamp01((pos[0] - rect.x) / rect.w),
        clamp01((pos[1] - rect.y) / rect.h),
    ];
}

function drawSmoothMaskStroke(ctx, stroke, rect) {
    const points = Array.isArray(stroke.points) ? stroke.points : [];
    if (points.length === 0) return;
    const toCanvas = (p) => [rect.x + clamp01(Number(p[0])) * rect.w, rect.y + clamp01(Number(p[1])) * rect.h];
    const scaledSize = Math.max(1, Number(stroke.sizeNorm || 0) * Math.max(rect.w, rect.h) || Number(stroke.size || 24));

    ctx.save();
    try {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = scaledSize;
        ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
        ctx.strokeStyle = "rgba(255, 0, 0, 1)";
        ctx.fillStyle = "rgba(255, 0, 0, 1)";

        const first = toCanvas(points[0]);
        if (points.length === 1) {
            ctx.beginPath();
            ctx.arc(first[0], first[1], scaledSize * 0.5, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        ctx.beginPath();
        ctx.moveTo(first[0], first[1]);
        for (let i = 1; i < points.length - 1; i++) {
            const current = toCanvas(points[i]);
            const next = toCanvas(points[i + 1]);
            ctx.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) * 0.5, (current[1] + next[1]) * 0.5);
        }
        const last = toCanvas(points[points.length - 1]);
        ctx.lineTo(last[0], last[1]);
        ctx.stroke();
    } finally {
        ctx.restore();
    }
}

function drawMaskOverlay(ctx, node) {
    if (node._maskDom) return;
    const state = ensureMaskState(node);
    const rect = getImageDrawRect(node);
    node._maskImageRect = rect;
    if (!state.enabled || !rect) {
        node._maskControls = null;
        return;
    }

    ctx.save();
    try {
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();

        if (!state.hideWhilePressed && state.strokes.length > 0 && rect.w > 0 && rect.h > 0) {
            const maskCanvas = document.createElement("canvas");
            maskCanvas.width = Math.max(1, Math.round(rect.w));
            maskCanvas.height = Math.max(1, Math.round(rect.h));
            const maskCtx = maskCanvas.getContext("2d");
            const localRect = { x: 0, y: 0, w: maskCanvas.width, h: maskCanvas.height };
            for (const stroke of state.strokes) {
                drawSmoothMaskStroke(maskCtx, stroke, localRect);
            }
            ctx.globalAlpha = 0.5;
            ctx.drawImage(maskCanvas, rect.x, rect.y, rect.w, rect.h);
            ctx.globalAlpha = 1;
        }
    } finally {
        ctx.restore();
    }

    drawMaskToolbar(ctx, node, rect, state);
}

function drawToolbarIcon(ctx, type, x, y, size, active) {
    ctx.save();
    try {
        ctx.strokeStyle = active ? "#ffffff" : "#d7d7d7";
        ctx.fillStyle = active ? "#ffffff" : "#d7d7d7";
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const cx = x + size * 0.5;
        const cy = y + size * 0.5;
        if (type === "eye") {
            ctx.beginPath();
            ctx.ellipse(cx, cy, size * 0.34, size * 0.22, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.09, 0, Math.PI * 2);
            ctx.fill();
        } else if (type === "undo" || type === "redo") {
            const dir = type === "undo" ? -1 : 1;
            ctx.beginPath();
            ctx.moveTo(cx + dir * size * 0.28, cy - size * 0.16);
            ctx.quadraticCurveTo(cx - dir * size * 0.16, cy - size * 0.34, cx - dir * size * 0.28, cy + size * 0.02);
            ctx.quadraticCurveTo(cx - dir * size * 0.12, cy + size * 0.28, cx + dir * size * 0.24, cy + size * 0.16);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(cx - dir * size * 0.30, cy + size * 0.02);
            ctx.lineTo(cx - dir * size * 0.10, cy - size * 0.12);
            ctx.lineTo(cx - dir * size * 0.10, cy + size * 0.16);
            ctx.closePath();
            ctx.fill();
        } else if (type === "erase") {
            ctx.translate(cx, cy);
            ctx.rotate(-0.7);
            ctx.strokeRect(-size * 0.22, -size * 0.13, size * 0.44, size * 0.26);
            ctx.beginPath();
            ctx.moveTo(size * 0.02, -size * 0.13);
            ctx.lineTo(size * 0.02, size * 0.13);
            ctx.stroke();
        } else if (type === "clear") {
            ctx.beginPath();
            ctx.moveTo(cx - size * 0.18, cy - size * 0.18);
            ctx.lineTo(cx + size * 0.18, cy + size * 0.18);
            ctx.moveTo(cx + size * 0.18, cy - size * 0.18);
            ctx.lineTo(cx - size * 0.18, cy + size * 0.18);
            ctx.stroke();
        }
    } finally {
        ctx.restore();
    }
}

function drawMaskToolbar(ctx, node, rect, state) {
    const height = MASK_TOOLBAR_HEIGHT;
    const margin = 6;
    const button = 22;
    const gap = 5;
    const fixedControlsW = button * 5 + gap * 5 + 12;
    const bodyRect = getMaskBodyRect(node);
    const toolbarW = Math.max(1, bodyRect.w - margin * 2);
    const toolbarX = bodyRect.x + margin;
    const toolbarY = bodyRect.y + margin;
    const sliderW = Math.max(42, toolbarW - fixedControlsW);
    const controls = {};

    ctx.save();
    try {
        ctx.fillStyle = "rgba(30, 31, 36, 0.92)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        roundedRectPath(ctx, toolbarX, toolbarY, toolbarW, height, 4);
        ctx.fill();
        ctx.stroke();

        const sliderX = toolbarX + 8;
        const sliderY = toolbarY + height * 0.5;
        controls.slider = { x: sliderX, y: toolbarY, w: sliderW, h: height };
        ctx.strokeStyle = "#6e879c";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sliderX, sliderY);
        ctx.lineTo(sliderX + sliderW, sliderY);
        ctx.stroke();
        const t = (Math.max(1, Math.min(512, state.brushSize)) - 1) / 511;
        ctx.strokeStyle = "#41a7d8";
        ctx.beginPath();
        ctx.moveTo(sliderX, sliderY);
        ctx.lineTo(sliderX + sliderW * t, sliderY);
        ctx.stroke();
        ctx.fillStyle = "#d8dce2";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sliderX + sliderW * t, sliderY, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        let x = sliderX + sliderW + gap;
        for (const item of ["eye", "undo", "redo", "erase", "clear"]) {
            const active = (item === "erase" && state.erasing) || (item === "eye" && state.hideWhilePressed);
            controls[item] = { x, y: toolbarY + 2, w: button, h: button };
            ctx.fillStyle = active ? "rgba(65, 167, 216, 0.6)" : "rgba(255, 255, 255, 0.08)";
            ctx.strokeStyle = active ? "rgba(255, 255, 255, 0.45)" : "rgba(255, 255, 255, 0.18)";
            ctx.beginPath();
            roundedRectPath(ctx, x, toolbarY + 2, button, button, 4);
            ctx.fill();
            ctx.stroke();
            drawToolbarIcon(ctx, item, x, toolbarY + 2, button, active);
            x += button + gap;
        }
    } finally {
        ctx.restore();
    }
    node._maskControls = controls;
}

function maskControlAt(node, localPos) {
    const controls = node._maskControls;
    if (!controls) return null;
    for (const [name, rect] of Object.entries(controls)) {
        if (pointInRect(localPos, rect)) return name;
    }
    return null;
}

function updateBrushFromSlider(node, localPos) {
    const slider = node._maskControls?.slider;
    if (!slider) return;
    const state = ensureMaskState(node);
    const t = clamp01((localPos[0] - slider.x) / slider.w);
    state.brushSize = Math.round(1 + t * 511);
    syncMaskData(node);
}

function appendMaskPoint(node, localPos) {
    const state = ensureMaskState(node);
    const rect = node._maskImageRect || getImageDrawRect(node);
    if (!state.activeStroke || !rect) return;
    const point = localToMaskPoint(localPos, rect);
    const points = state.activeStroke.points;
    const last = points[points.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 0.0015 && Math.abs(last[1] - point[1]) < 0.0015) return;
    points.push(point);
    node.setDirtyCanvas(true, true);
}

function getCurrentPreviewImage(node) {
    return node.imgs?.[node.imageIndex || 0] || node.imgs?.[0] || node._maskDomSourceImg || null;
}

function updateMaskDomImage(node) {
    if (!node._maskDom) return;
    const dom = node._maskDom;
    const img = getCurrentPreviewImage(node);
    if (!img || !img.src) {
        dom.hasImage = false;
        dom.img.removeAttribute("src");
        dom.imgWrap.style.display = "none";
        dom.toolbar.style.display = "none";
        dom.toolbarFrame.style.display = "none";
        dom.previewFrame.style.top = `${MASK_TOP_INSET_OFF}px`;
        dom.previewFrame.style.display = "block";
        dom.footer.style.display = "block";
        dom.footerText.textContent = "—";
        return;
    }
    dom.hasImage = true;
    node._maskDomSourceImg = img;
    const changed = dom.img.src !== img.src;
    if (changed) dom.img.src = img.src;
    dom.img.draggable = false;
    dom.imgWrap.style.display = "block";
    const showToolbar = ensureMaskState(node).enabled;
    dom.toolbarFrame.style.display = showToolbar ? "block" : "none";
    dom.toolbar.style.display = showToolbar ? "grid" : "none";
    dom.previewFrame.style.top = showToolbar
        ? `${MASK_TOP_INSET_ON}px`
        : `${MASK_TOP_INSET_OFF}px`;
    dom.previewFrame.style.display = "block";
    dom.footer.style.display = "block";
    updateMaskFooter(dom);
    if (changed) resizeMaskNodeToFit(node);
}

function updateMaskFooter(dom) {
    if (!dom?.footerText) return;
    const width = Number(dom.img?.naturalWidth || 0);
    const height = Number(dom.img?.naturalHeight || 0);
    dom.footerText.textContent = width > 0 && height > 0 ? `${width} × ${height}` : "—";
}

function resizeMaskNodeToFit(node) {
    const dom = node._maskDom;
    if (!dom || typeof node.setSize !== "function") return;
    // Auto-size the node ONCE (first image) to the image aspect, exactly like
    // TrixLoader. After that the node is freely resizable: we never touch its
    // height again, so there is no feedback loop fighting the resize handle.
    if (node._maskAutoSized || node._configuredFromWorkflow) return;
    node._maskAutoSized = true;
    const width = Math.max(MASK_TOOLBAR_MIN_WIDTH, node.size?.[0] || MASK_TOOLBAR_MIN_WIDTH);
    const top = getMaskControlBottom(node);
    const target = top + dom.getDefaultHeight(width);
    node.setSize([width, target]);
    node.setDirtyCanvas(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

function setMaskDomVisible(node, editing) {
    if (!node._maskDom) return;
    const dom = node._maskDom;
    // The DOM image display is ALWAYS shown so the image looks identical whether
    // mask editing is on or off. Only the toolbar and drawing input are toggled.
    // The DOM root stays pointer-events:none so empty/transparent areas pass
    // clicks through to LiteGraph (node stays draggable/resizable). Only the
    // toolbar (always) and the drawing canvas (only when Mask is On) capture
    // input. This matches TrixLoader's canvas gating.
    dom.root.style.display = "block";
    const showImageArea = !!dom.hasImage;
    const showToolbar = showImageArea && editing;
    dom.toolbarFrame.style.display = showToolbar ? "block" : "none";
    dom.toolbar.style.display = showToolbar ? "grid" : "none";
    dom.previewFrame.style.top = showToolbar
        ? `${MASK_TOP_INSET_ON}px`
        : `${MASK_TOP_INSET_OFF}px`;
    dom.previewFrame.style.display = "block";
    dom.footer.style.display = "block";
    dom.canvas.style.pointerEvents = editing ? "auto" : "none";
    dom.canvas.style.cursor = editing ? "crosshair" : "default";
    if (!editing) dom.cursor.style.display = "none";
    updateMaskDomImage(node);
    renderMaskDomCanvas(node);
    node.setDirtyCanvas(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

function getMaskControlBottom(node) {
    const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;
    const widgetHeight = LiteGraph.NODE_WIDGET_HEIGHT || 20;
    let bottom = titleHeight;
    for (const widget of node.widgets || []) {
        if (!widget || widget.hidden || widget.name === "fb_mask_editor" || !Number.isFinite(widget.last_y)) continue;
        const widgetSize = typeof widget.computeSize === "function" ? widget.computeSize(node.size?.[0] || 320) : null;
        bottom = Math.max(bottom, widget.last_y + (Number(widgetSize?.[1]) || widgetHeight));
    }
    return bottom + 6;
}

function createMaskDomUI(node) {
    if (node._maskDom || typeof node.addDOMWidget !== "function") return node._maskDom || null;

    const stop = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
    };
    const stopBubble = (event) => {
        event.stopPropagation?.();
    };

    const root = document.createElement("div");
    root.style.cssText = `
        display: none; position: relative; width: 100%; height: 100%;
        background: transparent; box-sizing: border-box; pointer-events: none;
        user-select: none; overflow: hidden; gap: 0;
    `;

    const toolbarFrame = document.createElement("div");
    toolbarFrame.style.cssText = `
        position: absolute; left: ${MASK_PANEL_INSET}px; right: ${MASK_PANEL_INSET}px;
        top: 0; height: ${MASK_TOOLBAR_FRAME_HEIGHT}px; z-index: 8;
        overflow: hidden; background: rgba(34, 39, 48, 0.98); display: none;
        border: 1px solid rgba(78, 90, 108, 0.72); border-radius: 10px;
        box-sizing: border-box; pointer-events: none;
    `;

    const toolbar = document.createElement("div");
    toolbar.style.cssText = `
        position: absolute; left: 1px; top: 1px; z-index: 8; width: calc(100% - 2px); height: calc(100% - 2px);
        display: grid; grid-template-columns: minmax(44px, 1fr) 22px 22px 22px 22px 22px;
        align-items: center; gap: 4px;
        padding: 0 10px; box-sizing: border-box; background: transparent;
        pointer-events: auto;
    `;
    for (const name of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "pointerdown", "pointermove", "pointerup"]) {
        toolbar.addEventListener(name, name === "contextmenu" ? stop : stopBubble, { passive: false });
    }

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = "512";
    slider.value = String(ensureMaskState(node).brushSize || 64);
    slider.title = "Brush size";
    slider.style.cssText = "width: 100%; min-width: 16px; height: 14px; margin: 0; accent-color: #41a7d8; cursor: pointer;";
    slider.addEventListener("input", () => {
        const state = ensureMaskState(node);
        state.brushSize = Math.max(1, Number(slider.value) || 64);
        syncMaskData(node);
        updateMaskCursor(node);
    });
    slider.addEventListener("pointerdown", stopBubble, { passive: false });
    slider.addEventListener("mousedown", stopBubble, { passive: false });

    const svgIcon = (inner) =>
        `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    const ICON_EYE = svgIcon('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>');
    const ICON_UNDO = svgIcon('<polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>');
    const ICON_REDO = svgIcon('<polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path>');
    const ICON_ERASE = svgIcon('<path d="M20 20H7L3 16C2.5 15.5 2.5 14.5 3 14L13 4C13.5 3.5 14.5 3.5 15 4L20 9C20.5 9.5 20.5 10.5 20 11L11 20H20V20Z"></path><line x1="17" y1="14" x2="10" y2="7"></line>');
    const ICON_CLEAR = svgIcon('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>');

    const makeButton = (iconSvg, title) => {
        const button = document.createElement("button");
        button.type = "button";
        button.innerHTML = iconSvg;
        button.title = title;
        button.style.cssText = `
            width: 22px; height: 20px; padding: 0; margin: 0; border-radius: 4px;
            border: none; background: transparent; color: #b9c2ce; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            line-height: 0; flex-shrink: 0; transition: background 0.12s, color 0.12s;
        `;
        button.addEventListener("pointerenter", () => {
            if (button.dataset.active !== "1") button.style.background = "rgba(255,255,255,0.10)";
            button.style.color = "#eef2f7";
        });
        button.addEventListener("pointerleave", () => {
            if (button.dataset.active !== "1") {
                button.style.background = "transparent";
                button.style.color = "#b9c2ce";
            }
        });
        button.addEventListener("pointerdown", stop, { passive: false });
        button.addEventListener("click", stop, { passive: false });
        return button;
    };

    const eyeBtn = makeButton(ICON_EYE, "Hold to hide mask");
    const undoBtn = makeButton(ICON_UNDO, "Undo");
    const redoBtn = makeButton(ICON_REDO, "Redo");
    const eraseBtn = makeButton(ICON_ERASE, "Erase");
    const clearBtn = makeButton(ICON_CLEAR, "Clear");

    toolbar.append(slider, eyeBtn, undoBtn, redoBtn, eraseBtn, clearBtn);
    toolbarFrame.append(toolbar);

    const previewFrame = document.createElement("div");
    previewFrame.style.cssText = `
        position: absolute; left: ${MASK_PANEL_INSET}px; top: ${MASK_TOP_INSET_OFF}px;
        right: ${MASK_PANEL_INSET}px; bottom: ${MASK_FOOTER_HEIGHT + MASK_PREVIEW_FRAME_GAP + 8}px;
        overflow: hidden; background: rgba(34, 39, 48, 0.98); display: none;
        border: 1px solid rgba(78, 90, 108, 0.72); border-radius: 10px;
        box-sizing: border-box;
    `;

    const preview = document.createElement("div");
    preview.style.cssText = "position: absolute; left: 1px; top: 1px; right: 1px; bottom: 1px; overflow: hidden; background: transparent; display: block;";

    const footer = document.createElement("div");
    footer.style.cssText = `
        position: absolute; left: ${MASK_PANEL_INSET}px; right: ${MASK_PANEL_INSET}px;
        bottom: 8px; height: ${MASK_FOOTER_HEIGHT}px; display: none;
        border-radius: 8px; border: 1px solid rgba(66, 72, 84, 0.95);
        background: rgba(34, 39, 48, 0.98); box-sizing: border-box;
        color: rgba(192, 206, 222, 0.95); font: 600 10px "Segoe UI";
        line-height: ${MASK_FOOTER_HEIGHT}px; text-align: center;
        pointer-events: none;
    `;
    const footerText = document.createElement("span");
    footerText.textContent = "—";
    footer.appendChild(footerText);

    const imgWrap = document.createElement("div");
    imgWrap.style.cssText = "position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: visible;";

    const img = document.createElement("img");
    img.draggable = false;
    img.crossOrigin = "anonymous";
    img.style.cssText = "position: absolute; left: 0; top: 0; display: block; object-fit: fill; user-select: none; pointer-events: none;";

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position: absolute; left: 0; top: 0; pointer-events: auto; cursor: crosshair; touch-action: none;";

    const cursor = document.createElement("div");
    cursor.style.cssText = `
        position: absolute; display: none; border: 1.5px solid rgba(255,255,255,0.9);
        border-radius: 50%; pointer-events: none; transform: translate(-50%, -50%);
        box-sizing: border-box; z-index: 4; box-shadow: 0 0 2px rgba(0,0,0,0.85);
    `;
    cursor.innerHTML = `<div style="position:absolute;left:50%;top:50%;width:2px;height:2px;border-radius:50%;background:white;transform:translate(-50%,-50%);box-shadow:0 0 1px black;"></div>`;

    imgWrap.append(img, canvas, cursor);
    preview.append(imgWrap);
    previewFrame.append(preview);
    root.append(toolbarFrame, previewFrame, footer);

    const fitCanvas = () => {
        const naturalW = img.naturalWidth || 1;
        const naturalH = img.naturalHeight || 1;
        // Use layout box (clientWidth/Height) which is NOT affected by LiteGraph
        // canvas zoom, unlike getBoundingClientRect (screen pixels).
        const boxW = preview.clientWidth;
        const boxH = preview.clientHeight;
        if (boxW <= 0 || boxH <= 0) return;
        const scale = Math.min(boxW / naturalW, boxH / naturalH);
        const width = Math.max(1, naturalW * scale);
        const height = Math.max(1, naturalH * scale);
        const left = (boxW - width) * 0.5;
        const top = (boxH - height) * 0.5;
        imgWrap.style.left = `${left}px`;
        imgWrap.style.top = `${top}px`;
        imgWrap.style.width = `${width}px`;
        imgWrap.style.height = `${height}px`;
        img.style.left = "0px";
        img.style.top = "0px";
        img.style.width = `${width}px`;
        img.style.height = `${height}px`;
        canvas.style.left = "0px";
        canvas.style.top = "0px";
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = Math.max(1, naturalW);
        canvas.height = Math.max(1, naturalH);
        updateMaskFooter(node._maskDom);
        renderMaskDomCanvas(node);
        updateMaskCursor(node);
    };

    const toNormPoint = (event) => {
        const rect = canvas.getBoundingClientRect();
        return [
            clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
            clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
        ];
    };

    const addPoint = (event) => {
        const state = ensureMaskState(node);
        if (!state.activeStroke) return;
        const point = toNormPoint(event);
        const points = state.activeStroke.points;
        const last = points[points.length - 1];
        if (!last || Math.abs(last[0] - point[0]) > 0.0015 || Math.abs(last[1] - point[1]) > 0.0015) {
            points.push(point);
            renderMaskDomCanvas(node);
        }
    };

    const updateCursorFromEvent = (event) => {
        node._maskDom.lastPointerEvent = event;
        updateMaskCursor(node);
    };

    canvas.addEventListener("pointerenter", (event) => {
        updateCursorFromEvent(event);
        cursor.style.display = "block";
    }, { passive: false });

    canvas.addEventListener("pointerleave", () => {
        if (!ensureMaskState(node).drawing) cursor.style.display = "none";
        node._maskDom.lastPointerEvent = null;
    }, { passive: false });

    canvas.addEventListener("pointerdown", (event) => {
        stop(event);
        if (event.button !== 0) return;
        if (app.canvas) app.canvas.allow_dragcanvas = false;
        try { canvas.setPointerCapture(event.pointerId); } catch (err) {}
        const state = ensureMaskState(node);
        state.redo = [];
        state.drawing = true;
        state.activeStroke = {
            mode: state.erasing ? "erase" : "draw",
            size: state.brushSize,
            sizeNorm: state.brushSize / Math.max(canvas.width, canvas.height),
            points: [],
        };
        state.strokes.push(state.activeStroke);
        updateCursorFromEvent(event);
        addPoint(event);
    }, { passive: false });

    canvas.addEventListener("pointermove", (event) => {
        const state = ensureMaskState(node);
        updateCursorFromEvent(event);
        if (!state.drawing) return;
        stop(event);
        addPoint(event);
    }, { passive: false });

    const finishDrawing = (event) => {
        const state = ensureMaskState(node);
        if (!state.drawing && !state.activeStroke) return;
        stop(event);
        addPoint(event);
        state.drawing = false;
        state.activeStroke = null;
        if (app.canvas) app.canvas.allow_dragcanvas = true;
        try { canvas.releasePointerCapture(event.pointerId); } catch (err) {}
        syncMaskData(node);
        renderMaskDomCanvas(node);
        updateMaskCursor(node);
    };
    canvas.addEventListener("pointerup", finishDrawing, { passive: false });
    canvas.addEventListener("pointercancel", finishDrawing, { passive: false });

    eyeBtn.addEventListener("pointerdown", (event) => {
        stop(event);
        ensureMaskState(node).hideWhilePressed = true;
        renderMaskDomCanvas(node);
    }, { passive: false });
    const restoreEye = (event) => {
        stop(event);
        ensureMaskState(node).hideWhilePressed = false;
        renderMaskDomCanvas(node);
    };
    eyeBtn.addEventListener("pointerup", restoreEye, { passive: false });
    eyeBtn.addEventListener("pointerleave", restoreEye, { passive: false });

    undoBtn.addEventListener("click", (event) => {
        stop(event);
        const state = ensureMaskState(node);
        const stroke = state.strokes.pop();
        if (stroke) state.redo.push(stroke);
        syncMaskData(node);
        renderMaskDomCanvas(node);
    }, { passive: false });
    redoBtn.addEventListener("click", (event) => {
        stop(event);
        const state = ensureMaskState(node);
        const stroke = state.redo.pop();
        if (stroke) state.strokes.push(stroke);
        syncMaskData(node);
        renderMaskDomCanvas(node);
    }, { passive: false });
    eraseBtn.addEventListener("click", (event) => {
        stop(event);
        const state = ensureMaskState(node);
        state.erasing = !state.erasing;
        eraseBtn.dataset.active = state.erasing ? "1" : "0";
        eraseBtn.style.background = state.erasing ? "#2f6f92" : "transparent";
        eraseBtn.style.color = state.erasing ? "#ffffff" : "#b9c2ce";
        syncMaskData(node);
    }, { passive: false });
    clearBtn.addEventListener("click", (event) => {
        stop(event);
        const state = ensureMaskState(node);
        state.strokes = [];
        state.redo = [];
        syncMaskData(node);
        renderMaskDomCanvas(node);
    }, { passive: false });

    img.onload = fitCanvas;
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(preview);

    const dom = {
        root, toolbarFrame, toolbar, previewFrame, preview, footer, footerText, imgWrap, img, canvas, cursor, slider, eraseBtn,
        hasImage: false,
        observer,
        // Aspect-fit height used ONCE to pick a sensible default node size on the
        // first image load. After that the widget just fills the user's node size.
        getDefaultHeight: (width) => {
            const imgNode = getCurrentPreviewImage(node);
            const naturalW = imgNode?.naturalWidth || imgNode?.width || img.naturalWidth || 1;
            const naturalH = imgNode?.naturalHeight || imgNode?.height || img.naturalHeight || 1;
            // Panel inner width = node width minus the two side insets.
            const availableW = Math.max(120, (width || node.size?.[0] || 320) - MASK_PANEL_INSET * 2);
            const imageH = Math.round(availableW * naturalH / naturalW);
            return Math.max(
                MASK_MIN_HEIGHT - 40,
                imageH + MASK_TOOLBAR_HEIGHT + MASK_PREVIEW_FRAME_GAP + MASK_FOOTER_HEIGHT + MASK_PREVIEW_FRAME_GAP + 8,
            );
        },
    };
    node._maskDom = dom;

    const widget = node.addDOMWidget("fb_mask_editor", "div", root, { hideOnZoom: false });
    dom.widget = widget;
    if (widget?.element) {
        widget.element.style.pointerEvents = "auto";
        widget.element.style.background = "transparent";
        widget.element.style.overflow = "hidden";
    }
    // Force the DOM panel to match the node width (inset on both sides like the
    // save image node). Its height is the image-aspect panel height (width-based,
    // no vertical feedback). A bare strip is left below the panel so the node's
    // bottom-right resize handle stays reachable.
    const origWidgetDraw = widget.draw;
    widget.draw = function (ctx, n, widgetWidth, y, H) {
        if (origWidgetDraw) origWidgetDraw.apply(this, arguments);
        if (!this.element || (n.flags && n.flags.collapsed)) return;
        // Match TrixLoader: pin width/position only, NEVER force height. Letting
        // the DOM widget fill the node body is what keeps the node freely
        // resizable. Transparent bg means empty areas show the node's own colour.
        this.element.style.setProperty("width", (n.size[0] - 2) + "px", "important");
        this.element.style.setProperty("left", "-9px", "important");
        this.element.style.setProperty("margin", "0px", "important");
        this.element.style.setProperty("padding", "0px 2px", "important");
        this.element.style.setProperty("box-sizing", "border-box", "important");
        this.element.style.setProperty("background", "transparent", "important");
        this.element.style.setProperty("overflow", "hidden", "important");
    };
    setMaskDomVisible(node, false);
    return dom;
}

function renderMaskDomCanvas(node) {
    const dom = node._maskDom;
    if (!dom?.canvas) return;
    const state = ensureMaskState(node);
    const canvas = dom.canvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!dom.hasImage) return;
    // Mask turned off (or momentarily hidden) => show no red overlay.
    if (!state.enabled || state.hideWhilePressed) return;

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskCtx = maskCanvas.getContext("2d");
    const rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    for (const stroke of state.strokes) {
        drawSmoothMaskStroke(maskCtx, stroke, rect);
    }

    ctx.globalAlpha = 0.5;
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalAlpha = 1;
}

function updateMaskCursor(node) {
    const dom = node._maskDom;
    if (!dom?.cursor || !dom?.canvas) return;

    const state = ensureMaskState(node);
    // imgWrap layout size (unscaled) vs its on-screen rect (scaled by zoom).
    const layoutW = dom.imgWrap.offsetWidth || 1;
    const wrapRect = dom.imgWrap.getBoundingClientRect();
    const zoom = wrapRect.width / Math.max(1, layoutW);
    // Brush size is stored in natural pixels; convert to imgWrap-local layout px.
    const localScale = layoutW / Math.max(1, dom.canvas.width);
    const size = Math.max(2, state.brushSize * localScale);

    dom.cursor.style.width = `${size}px`;
    dom.cursor.style.height = `${size}px`;

    const event = dom.lastPointerEvent;
    if (event && wrapRect.width > 0 && wrapRect.height > 0) {
        // Convert screen delta into imgWrap-local layout coordinates.
        dom.cursor.style.left = `${(event.clientX - wrapRect.left) / zoom}px`;
        dom.cursor.style.top = `${(event.clientY - wrapRect.top) / zoom}px`;
        dom.cursor.style.display = "block";
    }
}

let _fbLoadImageKeyListenerInstalled = false;

// --- Mask keyboard shortcut helpers (active when Mask is On + node selected) ---
function maskSetBrushSize(node, size) {
    const state = ensureMaskState(node);
    state.brushSize = Math.max(1, Math.min(512, Math.round(size)));
    const dom = node._maskDom;
    if (dom?.slider) dom.slider.value = String(state.brushSize);
    syncMaskData(node);
    updateMaskCursor(node);
}

function maskToggleErase(node) {
    const state = ensureMaskState(node);
    state.erasing = !state.erasing;
    const dom = node._maskDom;
    if (dom?.eraseBtn) {
        dom.eraseBtn.dataset.active = state.erasing ? "1" : "0";
        dom.eraseBtn.style.background = state.erasing ? "#2f6f92" : "transparent";
        dom.eraseBtn.style.color = state.erasing ? "#ffffff" : "#b9c2ce";
    }
    syncMaskData(node);
}

function maskUndo(node) {
    const state = ensureMaskState(node);
    const stroke = state.strokes.pop();
    if (stroke) state.redo.push(stroke);
    syncMaskData(node);
    renderMaskDomCanvas(node);
}

function maskRedo(node) {
    const state = ensureMaskState(node);
    const stroke = state.redo.pop();
    if (stroke) state.strokes.push(stroke);
    syncMaskData(node);
    renderMaskDomCanvas(node);
}

function getActiveLoadImageNode() {
    const selected = app.canvas?.selected_nodes;
    if (!selected) return null;

    const nodes = Object.values(selected).filter((n) => {
        const cls = n?.comfyClass || n?.type;
        return cls === "LoadImagePlus" || cls === "BetterImageLoader";
    });

    return nodes.length === 1 ? nodes[0] : null;
}

function isTypingTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable;
}

function installArrowKeyNavigation() {
    if (_fbLoadImageKeyListenerInstalled) return;
    _fbLoadImageKeyListenerInstalled = true;

    window.addEventListener("keydown", (event) => {
        if (event.defaultPrevented) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (isTypingTarget(event.target)) return;

        const node = getActiveLoadImageNode();
        if (!node || typeof node._stepImageByDelta !== "function") return;

        const dir = event.key === "ArrowRight" ? 1 : -1;
        if (node._stepImageByDelta(dir)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    // Mask editing shortcuts: only when Mask is On and a single Load Image node is
    // selected. [ / ] resize the brush, Space toggles the eraser, Ctrl+Z undo and
    // Ctrl+Shift+Z (or Ctrl+Y) redo.
    window.addEventListener("keydown", (event) => {
        if (event.defaultPrevented) return;
        if (isTypingTarget(event.target)) return;

        const node = getActiveLoadImageNode();
        if (!node) return;
        const state = ensureMaskState(node);
        if (!state.enabled) return;

        const key = event.key;
        if (key === "[" || key === "]") {
            const step = Math.max(1, Math.round(state.brushSize * 0.15));
            maskSetBrushSize(node, state.brushSize + (key === "]" ? step : -step));
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (key === " " || key === "Spacebar") {
            maskToggleErase(node);
            event.preventDefault();
            event.stopPropagation();
            return;
        }
    }, true);
}

/**
 * LoadImagePlus extension registration
 */
app.registerExtension({
    name: "FBnodes.LoadImagePlus",

    async setup() {
        api.addEventListener("better-image-loader-extract-frame", async (event) => {
            const { filename, frame_position } = event.detail;
            if (app.graph && app.graph._nodes) {
                for (const node of app.graph._nodes) {
                    if (node.type === "LoadImagePlus") {
                        const imageWidget = node.widgets?.find(w => w.name === "image");
                        const frameWidget = node.widgets?.find(w => w.name === "frame_position");
                        if (imageWidget && imageWidget.value === filename) {
                            if (frameWidget && frame_position !== undefined) {
                                frameWidget.value = frame_position;
                            }
                            await loadAndDisplayImage(node, filename);
                            break;
                        }
                    }
                }
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "LoadImagePlus" && nodeData.name !== "BetterImageLoader") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            installArrowKeyNavigation();

            const coerceFramePosition = (value) => {
                const n = Number(value);
                if (!Number.isFinite(n)) return 0.0;
                if (n < 0) return 0.0;
                if (n > 1) return 1.0;
                return n;
            };

            // Initialize properties for persistence across tab switches
            if (!node.properties) node.properties = {};
            node._configuredFromWorkflow = false;
            node._sourceFolder = 'input';

            const framePositionWidget = this.widgets?.find(w => w.name === "frame_position");
            if (framePositionWidget) {
                framePositionWidget.value = coerceFramePosition(framePositionWidget.value);
            }
            const maskDataWidget = this.widgets?.find(w => w.name === "mask_data");
            if (maskDataWidget) {
                hideWidget(maskDataWidget);
            }
            let imageWidget = null;
            let imagePickerWidget = null;
            node._imagePickerMap = { "(none)": "(none)" };

            const updateImagePickerOptions = (values, preferredValue = null) => {
                if (!imagePickerWidget) return;

                const labels = ["(none)"];
                const map = { "(none)": "(none)" };
                const usedLabels = new Set(["(none)"]);

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

                node._imagePickerMap = map;
                imagePickerWidget.options.values = labels;

                const desired = stripAnnotation(preferredValue != null ? preferredValue : imageWidget?.value);
                if (desired && desired !== "(none)") {
                    const label = Object.keys(map).find((k) => map[k] === desired);
                    imagePickerWidget.value = label || "(none)";
                } else {
                    imagePickerWidget.value = "(none)";
                }
            };

            const refreshImageOptionsForSource = async (source, options = {}) => {
                const { resetSelection = false, preferredValue = null } = options;
                if (!imageWidget) return;

                try {
                    const listResponse = await api.fetchApi(`/fbnodes/list-files?source=${encodeURIComponent(source || 'input')}`);
                    if (!listResponse.ok) return;

                    const result = await listResponse.json();
                    const files = Array.isArray(result?.files) ? result.files : [];
                    imageWidget.options.values = ["(none)", ...files];
                    updateImagePickerOptions(files, preferredValue);

                    if (resetSelection) {
                        if (imageWidget.value !== "(none)") {
                            imageWidget.value = "(none)";
                            if (imageWidget.callback) imageWidget.callback("(none)");
                        }
                        return;
                    }

                    const desiredRaw = preferredValue != null ? preferredValue : imageWidget.value;
                    const desired = stripAnnotation(desiredRaw);
                    if (desired && desired !== "(none)") {
                        if (!imageWidget.options.values.includes(desired)) {
                            imageWidget.options.values = ["(none)", desired, ...files.filter((f) => f !== desired)];
                        }
                        imageWidget.value = desired;
                    }
                } catch (err) {
                    console.warn('[LoadImagePlus] Could not fetch file list:', err);
                }
            };

            const refreshImageOptionsForBrowsePath = async (browsePath, preferredValue = null) => {
                if (!imageWidget || !browsePath) return false;
                try {
                    const roots = await getMediaRoots();
                    const resp = await api.fetchApi(
                        `/fbnodes/path-browser/list?path=${encodeURIComponent(browsePath)}&kind=media`
                    );
                    if (!resp.ok) return false;

                    const data = await resp.json();
                    const files = Array.isArray(data?.files) ? data.files : [];
                    const mapped = [];
                    const seen = new Set();

                    for (const f of files) {
                        const absPath = typeof f === "string" ? f : f?.path;
                        if (!absPath) continue;
                        const cls = classifySelection(absPath, roots);
                        const value = cls?.value || absPath;
                        if (!seen.has(value)) {
                            seen.add(value);
                            mapped.push(value);
                        }
                    }

                    const desiredRaw = preferredValue != null ? preferredValue : imageWidget.value;
                    const desired = stripAnnotation(desiredRaw);
                    imageWidget.options.values = ["(none)", ...mapped];
                    updateImagePickerOptions(mapped, desired);
                    if (desired && desired !== "(none)") imageWidget.value = desired;
                    return true;
                } catch (err) {
                    console.warn('[LoadImagePlus] Could not refresh options for browse path:', err);
                    return false;
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

            // Set the image combo to an arbitrary value (relative or absolute),
            // adding it to the option list so the combo can display it.
            const setImageFilename = (value) => {
                if (!imageWidget) return;
                if (!imageWidget.options) imageWidget.options = {};
                const values = imageWidget.options.values;
                if (Array.isArray(values)) {
                    if (value && !values.includes(value)) {
                        imageWidget.options.values = [...values, value];
                    }
                } else if (values && typeof values === "object") {
                    const existingValues = Object.values(values);
                    if (value && !existingValues.includes(value)) {
                        const base = basenameForDisplay(value) || value;
                        let label = base;
                        let n = 2;
                        while (Object.prototype.hasOwnProperty.call(values, label)) {
                            label = `${base} (${n++})`;
                        }
                        imageWidget.options.values = { ...values, [label]: value };
                    }
                } else {
                    imageWidget.options.values = ["(none)"];
                    if (value && value !== "(none)") {
                        imageWidget.options.values.push(value);
                    }
                }
                imageWidget.value = value;
                if (imageWidget.callback) imageWidget.callback(value);

                // Keep custom flat picker in sync with current value.
                const map = node._imagePickerMap || { "(none)": "(none)" };
                const currentLabel = Object.keys(map).find((k) => map[k] === value);
                if (imagePickerWidget) {
                    imagePickerWidget.value = currentLabel || "(none)";
                }
                node.setDirtyCanvas(true);
            };

            const listImageValues = () => {
                const out = [];
                const seen = new Set();

                const add = (v) => {
                    if (typeof v !== "string") return;
                    const value = stripAnnotation(v);
                    if (!value || value === "(none)" || seen.has(value)) return;
                    seen.add(value);
                    out.push(value);
                };

                const map = node._imagePickerMap;
                if (map && typeof map === "object") {
                    for (const value of Object.values(map)) {
                        add(value);
                    }
                    if (out.length > 0) return out;
                }

                const values = imageWidget?.options?.values;
                if (Array.isArray(values)) {
                    for (const value of values) add(value);
                } else if (values && typeof values === "object") {
                    for (const value of Object.values(values)) add(value);
                }

                return out;
            };

            node._stepImageByDelta = (delta) => {
                if (!imageWidget) return false;

                const values = listImageValues();
                if (values.length <= 1) return false;

                const dir = delta >= 0 ? 1 : -1;
                const current = stripAnnotation(imageWidget.value);
                const currentIndex = values.indexOf(current);

                let nextIndex;
                if (currentIndex < 0) {
                    nextIndex = dir > 0 ? 0 : values.length - 1;
                } else {
                    nextIndex = (currentIndex + dir + values.length) % values.length;
                }

                setImageFilename(values[nextIndex]);
                return true;
            };

            // Image widget
            imageWidget = this.widgets?.find(w => w.name === "image");
            if (imageWidget) {
                // Hide native Comfy combo (tree behavior for slash paths) and use
                // our own flat picker widget below.
                hideWidget(imageWidget);

                const originalCallback = imageWidget.callback;
                imageWidget.callback = function(value) {
                    // Strip annotated filepath suffix from MaskEditor
                    const cleaned = stripAnnotation(value);
                    if (cleaned !== value) {
                        imageWidget.value = cleaned;
                        value = cleaned;
                    }
                    if (originalCallback) originalCallback.apply(this, arguments);

                    if (value && framePositionWidget) {
                        const ext = value.split('.').pop().toLowerCase();
                        if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) {
                            framePositionWidget.value = 0;
                        }
                    }

                    // Only reload if not already configured from workflow (prevents execution re-load)
                    if (!node._configuredFromWorkflow || node.properties?._loadedImageFilename !== value) {
                        loadAndDisplayImage(node, value);
                    }
                    node._configuredFromWorkflow = false;
                };

                imagePickerWidget = this.addWidget(
                    "combo",
                    "file",
                    "(none)",
                    (label) => {
                        const selected = node._imagePickerMap?.[label] || "(none)";
                        setImageFilename(selected);
                    },
                    { values: ["(none)"] }
                );
                imagePickerWidget.serialize = false;

                const imageWidgetIndex = this.widgets.indexOf(imageWidget);

                const pickerIndex = this.widgets.indexOf(imagePickerWidget);
                if (pickerIndex >= 0) {
                    this.widgets.splice(pickerIndex, 1);
                    this.widgets.splice(imageWidgetIndex + 1, 0, imagePickerWidget);
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
                        const currentSelection = stripAnnotation(imageWidget.value);
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
                        if (!selectedAbsPath && node.properties?._browseSelectedAbsPath) {
                            selectedAbsPath = node.properties._browseSelectedAbsPath;
                        }
                        createFileBrowserModal(
                            currentSelection,
                            (selected, meta) => {
                                if (!node.properties) node.properties = {};
                                if (meta && meta.absPath) {
                                    node.properties._browsePath = meta.dir;
                                    node.properties._browseSelectedAbsPath = meta.absPath;
                                    const cls = classifySelection(meta.absPath, meta.roots);
                                    const sfW = node.widgets?.find(w => w.name === "source_folder");
                                    if (cls.sourceFolder && sfW) {
                                        sfW.value = cls.sourceFolder;
                                        node._sourceFolder = cls.sourceFolder;
                                    }
                                    setImageFilename(cls.value);
                                    refreshImageOptionsForBrowsePath(meta.dir, cls.value);
                                } else {
                                    node.properties._browseSelectedAbsPath = "";
                                    setImageFilename(selected);
                                    if (node.properties?._browsePath) {
                                        refreshImageOptionsForBrowsePath(node.properties._browsePath, selected);
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
                                navKind: "media",
                                allowedTypes: ["image", "video"],
                            }
                        );
                    },
                    serialize: false
                };
                this.widgets.splice(imageWidgetIndex + 2, 0, browseButton);
                Object.defineProperty(browseButton, "node", { value: node });

                const maskButton = {
                    type: "button",
                    name: "Mask",
                    value: null,
                    callback: () => {
                        const state = ensureMaskState(node);
                        state.enabled = !state.enabled;
                        if (state.enabled) {
                            ensureMaskNodeWidth(node);
                            createMaskDomUI(node);
                            updateMaskDomImage(node);
                        }
                        setMaskDomVisible(node, state.enabled);
                        syncMaskData(node);
                        maskButton.name = state.enabled ? "Mask: On" : "Mask";
                        node.setDirtyCanvas(true, true);
                        app.graph?.setDirtyCanvas(true, true);
                    },
                    serialize: false
                };
                this.widgets.splice(imageWidgetIndex + 3, 0, maskButton);
                Object.defineProperty(maskButton, "node", { value: node });
                createMaskDomUI(node);

                // Start at a comfortable default size (only for brand-new nodes;
                // configured nodes get their saved size restored in onConfigure).
                if (!node._configuredFromWorkflow) {
                    const cw = Math.max(node.size?.[0] || 0, MASK_TOOLBAR_MIN_WIDTH + 40);
                    const ch = Math.max(node.size?.[1] || 0, MASK_MIN_HEIGHT + 140);
                    node.setSize([cw, ch]);
                }

                const originalOnResize = node.onResize;
                node.onResize = function(size) {
                    // Clamp minimums so the toolbar/image are never cut off. The
                    // image itself re-fits via the preview ResizeObserver.
                    if (size) {
                        if (size[0] < MASK_TOOLBAR_MIN_WIDTH) size[0] = MASK_TOOLBAR_MIN_WIDTH;
                        if (size[1] < MASK_MIN_HEIGHT) size[1] = MASK_MIN_HEIGHT;
                    }
                    return originalOnResize ? originalOnResize.apply(this, arguments) : undefined;
                };

                node._isVideoFile = false;

                const updateVideoUIVisibility = () => {
                    const isVideo = isVideoFile(imageWidget.value);
                    node._isVideoFile = isVideo;
                    if (framePositionWidget) {
                        framePositionWidget.hidden = !isVideo;
                    }
                    node.setDirtyCanvas(true);
                };

                // Wrap callback to update UI visibility while preserving existing logic
                const originalWidgetCallback = imageWidget.callback;
                imageWidget.callback = function(value) {
                    if (originalWidgetCallback) originalWidgetCallback.apply(this, arguments);
                    updateVideoUIVisibility();
                };

                setTimeout(updateVideoUIVisibility, 100);
            }

            // Frame position widget
            if (framePositionWidget) {
                framePositionWidget.serialize = true;
                framePositionWidget.hidden = true;

                const origFrameCb = framePositionWidget.callback;
                let frameUpdateTimer = null;

                framePositionWidget.callback = function(value) {
                    framePositionWidget.value = coerceFramePosition(value);
                    if (origFrameCb) origFrameCb.apply(this, arguments);
                    if (frameUpdateTimer) clearTimeout(frameUpdateTimer);
                    frameUpdateTimer = setTimeout(() => {
                        if (imageWidget && imageWidget.value) {
                            const ext = imageWidget.value.split('.').pop().toLowerCase();
                            if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) {
                                loadVideoFrame(node, imageWidget.value);
                            }
                        }
                    }, 300);
                };
            }

            // Restore on workflow load
            const onConfigure = node.onConfigure;
            node.onConfigure = function(info) {
                // Mark as configured from workflow - prevents re-loading during execution
                node._configuredFromWorkflow = true;

                const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;

                // Restore source folder
                const sfWidget = this.widgets?.find(w => w.name === "source_folder");
                if (sfWidget) node._sourceFolder = sfWidget.value || 'input';

                // Prefer last browsed folder for dropdown options. Only fall back
                // to source-folder list when no browse path was persisted.
                if (node.properties?._browsePath) {
                    refreshImageOptionsForBrowsePath(node.properties._browsePath, imageWidget?.value);
                } else {
                    refreshImageOptionsForSource(node._sourceFolder, { preferredValue: imageWidget?.value });
                }

                node._maskState = null;
                const maskWidget = getMaskDataWidget(node);
                if (maskWidget && !maskWidget.value && node.properties?._maskData) {
                    maskWidget.value = node.properties._maskData;
                }
                ensureMaskState(node);

                // Restore persisted display state from properties (survives tab switches)
                if (!node.properties) node.properties = {};
                const persistedImageFilename = node.properties._loadedImageFilename;
                const persistedFramePosition = node.properties._loadedFramePosition;

                // Restore frame position from saved widgets_values if available
                if (info && info.widgets_values && framePositionWidget) {
                    const idx = this.widgets.findIndex(w => w.name === "frame_position");
                    if (idx >= 0 && info.widgets_values[idx] !== undefined) {
                        framePositionWidget.value = coerceFramePosition(info.widgets_values[idx]);
                    }
                }

                if (framePositionWidget) {
                    framePositionWidget.value = coerceFramePosition(framePositionWidget.value);
                }

                // Check if display state matches current widget value
                const imageWidget_val = imageWidget?.value;
                const currentFramePos = framePositionWidget ? framePositionWidget.value : 0.0;
                const imageValueMatches = imageWidget_val === persistedImageFilename;
                const frameValueMatches = !isVideoFile(imageWidget_val) || currentFramePos === persistedFramePosition;
                const hasCorrectImage = node.imgs && node.imgs[0];
                const alreadyLoaded = persistedImageFilename && imageValueMatches && frameValueMatches && hasCorrectImage;

                // Restore from persisted state synchronously if no image is loaded yet.
                // During workflow execution, _configuredFromWorkflow stays true so no reload happens.
                if (persistedImageFilename && !hasCorrectImage) {
                    loadAndDisplayImage(node, persistedImageFilename);
                } else if (imageWidget_val && imageWidget_val !== "(none)" && !alreadyLoaded) {
                    // Only reload if widget value changed from persisted state
                    loadAndDisplayImage(node, imageWidget_val);
                }

                return result;
            };

            // After execution: reload from the source file so the correct image
            // is always shown (prevents ComfyUI's default behaviour from replacing
            // node.imgs with whatever temp preview Python returned).
            node.onExecuted = function(output) {
                const iw = node.widgets?.find(w => w.name === "image");
                if (iw?.value && iw.value !== "(none)") {
                    loadAndDisplayImage(node, iw.value);
                }
            };

            // Initial load
            if (imageWidget) {
                setTimeout(() => {
                    if (imageWidget.value && imageWidget.value !== "(none)") {
                        const persistedFilename = node.properties?._loadedImageFilename;
                        if (persistedFilename !== imageWidget.value || !node.imgs) {
                            loadAndDisplayImage(node, imageWidget.value);
                        }
                    } else {
                        showEmptyPreview(node);
                    }
                }, 10);
            }

            // Drag and drop
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
                if (!['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov', 'avi'].includes(ext)) return false;

                const formData = new FormData();
                formData.append('image', file);
                formData.append('subfolder', '');
                formData.append('type', 'input');

                try {
                    const response = await api.fetchApi('/upload/image', { method: 'POST', body: formData });
                    if (response.ok) {
                        const data = await response.json();
                        if (imageWidget) {
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
                                    const result = await listResponse.json();
                                    imageWidget.options.values = ["(none)", ...(result.files || [])];
                                }
                            } catch (err) {}
                            imageWidget.value = data.name;
                            if (imageWidget.callback) imageWidget.callback(data.name);
                        }
                    }
                } catch (error) {
                    console.error('[LoadImagePlus] Error uploading file:', error);
                }
                return true;
            };

            // The image is always shown through the DOM mask-editor widget, so
            // suppress ComfyUI's native node.imgs preview to avoid a duplicate
            // copy of the image being drawn (e.g. after the workflow executes).
            const onDrawBackground = node.onDrawBackground;
            node.onDrawBackground = function(ctx) {
                const savedImgs = this.imgs;
                this.imgs = null;
                try {
                    return onDrawBackground ? onDrawBackground.apply(this, arguments) : undefined;
                } finally {
                    this.imgs = savedImgs;
                }
            };

            // Preview play icon
            const onDrawForeground = node.onDrawForeground;
            node.onDrawForeground = function(ctx) {
                const result = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;

                if (node.imgs && node.imgs.length > 0 && !(node.flags && node.flags.collapsed)) {
                    const titleHeight = LiteGraph.NODE_TITLE_HEIGHT || 30;
                    const imageWidget = node.widgets?.find(w => w.name === "image");
                    const currentFile = imageWidget?.value;

                    if (isPreviewableFile(currentFile)) {
                        const playX = node.size[0] - 8 - 14;
                        const playY = (titleHeight / 2) - 30;
                        const triSize = 8;

                        ctx.beginPath();
                        ctx.moveTo(playX - triSize, playY - triSize);
                        ctx.lineTo(playX - triSize, playY + triSize);
                        ctx.lineTo(playX + triSize, playY);
                        ctx.closePath();
                        ctx.fillStyle = node._hoverPreviewIcon ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
                        ctx.fill();

                        node._previewIconBounds = {
                            x: playX - triSize - 3,
                            y: playY - triSize - 3,
                            width: triSize * 2 + 6,
                            height: triSize * 2 + 6
                        };
                    } else {
                        node._previewIconBounds = null;
                    }
                } else {
                    node._previewIconBounds = null;
                }

                drawMaskOverlay(ctx, node);
                drawBypassVeil(ctx, node);

                return result;
            };

            const onMouseMove = node.onMouseMove;
            node.onMouseMove = function(e, localPos, canvas) {
                // Mask drawing is handled entirely by the DOM canvas (over the
                // image only). The node body must NOT start strokes, otherwise it
                // captures clicks in the corners/margins and blocks resizing.
                const result = onMouseMove ? onMouseMove.apply(this, arguments) : undefined;
                if (node._previewIconBounds) {
                    const bounds = node._previewIconBounds;
                    if (localPos[0] >= bounds.x && localPos[0] <= bounds.x + bounds.width &&
                        localPos[1] >= bounds.y && localPos[1] <= bounds.y + bounds.height) {
                        canvas.canvas.style.cursor = 'pointer';
                        canvas.canvas.title = 'Click to preview';
                        node._hoverPreviewIcon = true;
                        node.setDirtyCanvas(true);
                    } else {
                        if (node._hoverPreviewIcon) {
                            node._hoverPreviewIcon = false;
                            node.setDirtyCanvas(true);
                        }
                        canvas.canvas.style.cursor = '';
                    }
                }
                return result;
            };

            const onMouseDown = node.onMouseDown;
            node.onMouseDown = function(e, localPos, canvas) {
                // Mask strokes are captured by the DOM canvas over the image only,
                // never by the node body — keeps corners/margins free for resizing.
                if (node._previewIconBounds && node.imgs && node.imgs.length > 0) {
                    const bounds = node._previewIconBounds;
                    if (localPos[0] >= bounds.x && localPos[0] <= bounds.x + bounds.width &&
                        localPos[1] >= bounds.y && localPos[1] <= bounds.y + bounds.height) {
                        const imageWidget = node.widgets?.find(w => w.name === "image");
                        const viewType = node._sourceFolder || 'input';
                        if (imageWidget && imageWidget.value) {
                            if (node._isVideoFile) {
                                showVideoPreviewModal(imageWidget.value, viewType);
                            } else {
                                showImagePreviewModal(imageWidget.value, viewType);
                            }
                        }
                        return true;
                    }
                }
                return onMouseDown ? onMouseDown.apply(this, arguments) : undefined;
            };

            const onMouseUp = node.onMouseUp;
            node.onMouseUp = function(e, localPos, canvas) {
                return onMouseUp ? onMouseUp.apply(this, arguments) : undefined;
            };

            return result;
        };
    }
});

console.log("[FBnodes] LoadImagePlus extension loaded");
