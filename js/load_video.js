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
const LOAD_VIDEO_MIN_WIDTH = 300;
const LOAD_VIDEO_MIN_HEIGHT = 320;

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

function buildVideoPreviewUrl(filename, sourceFolder) {
    const clean = stripAnnotation(filename);
    if (!clean || clean === '(none)' || clean === '(blank)') return '';

    if (isAbsolutePath(clean)) {
        return mediaFileUrl(clean);
    }

    let actualFilename = clean;
    let subfolder = '';
    const normalized = clean.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
        subfolder = normalized.substring(0, lastSlash);
        actualFilename = normalized.substring(lastSlash + 1);
    }

    let url = `/view?filename=${encodeURIComponent(actualFilename)}&type=${encodeURIComponent(sourceFolder || 'input')}`;
    if (subfolder) {
        url += `&subfolder=${encodeURIComponent(subfolder)}`;
    }
    return url;
}

function probeBrowserPlayback(url, timeoutMs = 1500) {
    return new Promise((resolve) => {
        if (!url) {
            resolve(false);
            return;
        }

        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            video.onloadedmetadata = null;
            video.oncanplay = null;
            video.onerror = null;
            try { video.pause(); } catch {}
            video.removeAttribute('src');
            try { video.load(); } catch {}
            if (video.parentNode) video.parentNode.removeChild(video);
            resolve(ok);
        };

        const timer = setTimeout(() => finish(false), timeoutMs);
        video.onloadedmetadata = () => finish(true);
        video.oncanplay = () => finish(true);
        video.onerror = () => finish(false);

        document.body.appendChild(video);
        video.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    });
}

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
    if (widget.element && widget.element.style) {
        widget.element.style.display = "none";
        widget.element.style.height = "0px";
        widget.element.style.overflow = "hidden";
    }
}

function suppressNativeVideoWidget(node, videoWidget) {
    // Keep ComfyUI's native video_upload widget from rendering its own player.
    // We provide all preview rendering through our own DOM widget.
    if (!videoWidget) return;

    // Hide and neuter the native widget element.
    if (videoWidget.element) {
        videoWidget.element.style.display = "none";
        videoWidget.element.style.height = "0px";
        videoWidget.element.style.overflow = "hidden";
        videoWidget.element.innerHTML = "";
    }

    // Prevent the native callback from creating a player.
    // We handle all preview rendering ourselves.
    if (!videoWidget._fbNativeCallbackSuppressed) {
        videoWidget._fbNativeCallbackSuppressed = true;
        videoWidget.callback = function(value) {
            videoWidget.value = value;
            // Do not call the original handler — it injects the native player.
        };
    }

    if (node._nativeVideoSuppressor) return;

    // Observe both our preview container and the node's root element so any
    // native video element that leaks in (e.g. after tab-switch) is removed.
    const targets = [getPreviewContainer(node), node.element].filter(Boolean);
    if (targets.length === 0) return;

    const scrubNativeVideos = () => {
        const scope = node.element || document;
        for (const vid of scope.querySelectorAll('video')) {
            if (vid.closest('.fbnodes-video-media-host')) continue;
            vid.remove();
        }
        if (videoWidget.element) {
            videoWidget.element.style.display = 'none';
            videoWidget.element.style.height = '0px';
            videoWidget.element.style.overflow = 'hidden';
            videoWidget.element.innerHTML = '';
        }
    };

    scrubNativeVideos();

    node._nativeVideoSuppressor = new MutationObserver((mutations) => {
        let hasNativeVideo = false;
        for (const mutation of mutations) {
            for (const added of mutation.addedNodes) {
                if (added.nodeType !== Node.ELEMENT_NODE) continue;
                const videos = added.matches?.('video') ? [added] : added.querySelectorAll?.('video') || [];
                if (videos.length > 0) hasNativeVideo = true;
                for (const vid of videos) {
                    if (vid.closest('.fbnodes-video-media-host')) continue;
                    vid.remove();
                }
            }
        }
        if (hasNativeVideo) {
            const clean = stripAnnotation(videoWidget?.value);
            if (!clean || clean === '(none)') showEmptyVideoPreview(node);
            else if (clean === '(blank)') showPlaceholderVideoPreview(node);
            else createVideoPreview(
                node,
                buildVideoPreviewUrl(clean, node._sourceFolder || 'input'),
                null,
                clean,
                node._sourceFolder || 'input'
            );
        }
    });

    for (const target of targets) {
        node._nativeVideoSuppressor.observe(target, { childList: true, subtree: true });
    }
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

function clearVideoPreview(node) {
    const container = getPreviewContainer(node);
    if (container) {
        container.innerHTML = '';
    }
    node._needsPlayabilityWarning = false;
    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
}

function showEmptyVideoPreview(node) {
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

    createPreviewMediaHost(container);
    node._needsPlayabilityWarning = false;
    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
}

function showPlaceholderVideoPreview(node) {
    createImagePreview(node, PLACEHOLDER_IMAGE_PATH);
    setVideoPreviewFooter(getPreviewContainer(node), '\u2014');
    node._needsPlayabilityWarning = false;
    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
}

function isNodeBypassed(node) {
    return !!(node?.mode === 4 || node?.flags?.bypass || node?.flags?.bypassed);
}

function syncBypassPreviewStyle(node) {
    const host = getPreviewContainer(node);
    if (!host) return false;

    const bypassed = isNodeBypassed(node);
    host.style.opacity = bypassed ? '0.42' : '';
    host.style.filter = bypassed ? 'grayscale(0.35) brightness(0.82)' : '';

    const media = host.querySelector('video, img');
    if (media) {
        media.style.opacity = bypassed ? '0.9' : '';
    }

    return true;
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
    syncBypassPreviewStyle(node);
    if (!applied && attempts < 10) {
        setTimeout(() => syncWarningOverlay(node, attempts + 1), 80);
    }
}

function createPreviewMediaHost(container) {
    container.innerHTML = '';
    container.style.position = 'relative';
    container.style.width = '100%';
    container.style.height = '100%';

    const frame = document.createElement('div');
    frame.style.cssText = `
        position: absolute; left: 8px; top: 8px; right: 8px; bottom: 34px;
        overflow: hidden; background: rgba(34, 39, 48, 0.98);
        border: 1px solid rgba(78, 90, 108, 0.72); border-radius: 10px;
        box-sizing: border-box;
    `;

    const mediaHost = document.createElement('div');
    mediaHost.style.cssText = `
        position: absolute; left: 1px; top: 1px; right: 1px; bottom: 1px;
        overflow: hidden; background: transparent;
    `;

    const footer = document.createElement('div');
    footer.className = 'fbnodes-video-preview-footer';
    footer.style.cssText = `
        position: absolute; left: 8px; right: 8px; bottom: 8px; height: 22px;
        border-radius: 8px; border: 1px solid rgba(66, 72, 84, 0.95);
        background: rgba(34, 39, 48, 0.98); box-sizing: border-box;
        color: rgba(192, 206, 222, 0.95); font: 600 10px "Segoe UI", sans-serif;
        line-height: 20px; text-align: center; pointer-events: none;
    `;
    footer.textContent = '\u2014';

    frame.appendChild(mediaHost);
    container.appendChild(frame);
    container.appendChild(footer);
    container._previewFooter = footer;
    return mediaHost;
}

function setVideoPreviewFooter(container, text) {
    if (container?._previewFooter) {
        container._previewFooter.textContent = text || '\u2014';
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

    const isPlaceholder = imageUrl === PLACEHOLDER_IMAGE_PATH;
    const mediaHost = createPreviewMediaHost(container);
    const img = document.createElement('img');
    img.src = imageUrl;
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    img.alt = 'Video frame preview';
    img.onload = () => {
        if (isPlaceholder) return;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w && h) setVideoPreviewFooter(container, `${w} \u00d7 ${h}`);
    };
    mediaHost.appendChild(img);

    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
}

function setStaticFramePreview(node, frameUrl) {
    const vid = getNodeVideoElement(node);
    if (vid) {
        try {
            vid.pause();
            const source = vid.querySelector('source');
            if (source) source.remove();
            vid.removeAttribute('src');
            vid.removeAttribute('controls');
            vid.style.display = 'none';
            vid.remove();
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
    if (!filename || filename === '(none)' || filename === '(blank)') return filename;
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
    if (!filename || filename === '(none)' || filename === '(blank)') return;

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
function createVideoPreview(node, clipViewUrl, posterUrl = null, sourceFilename = null, sourceFolder = null) {
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

    const onVideoError = (event) => {
        const failedVideo = event?.currentTarget;
        if (failedVideo && failedVideo.remove) {
            failedVideo.removeAttribute('controls');
            failedVideo.style.display = 'none';
            failedVideo.remove();
        }
        if (sourceFilename) {
            _nonBrowserDecodableVideos.add(sourceFilename);
        }
        node._needsPlayabilityWarning = true;
        syncWarningOverlay(node);
        node.setDirtyCanvas?.(true, true);
        if (sourceFilename) {
            loadServerPreviewClip(node, sourceFilename, sourceFolder || node._sourceFolder || 'input');
        }
    };

    // Reuse existing video element if the frame is already set up.
    const existingVid = container.querySelector('video');
    if (existingVid && existingVid.parentElement?.classList?.contains('fbnodes-video-media-host')) {
        existingVid.onerror = onVideoError;
        existingVid.muted = false;
        existingVid.src = clipViewUrl;
        if (posterUrl) {
            existingVid.poster = posterUrl;
            existingVid.preload = 'metadata';
        }
        existingVid.load();
        syncWarningOverlay(node);
        node.setDirtyCanvas?.(true, true);
        return;
    }

    const mediaHost = createPreviewMediaHost(container);
    mediaHost.classList.add('fbnodes-video-media-host');

    const vid = document.createElement('video');
    vid.playsInline = true;
    vid.controls = true;
    vid.loop = true;
    vid.muted = false;
    vid.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    if (posterUrl) {
        vid.poster = posterUrl;
        vid.preload = 'metadata';
    }
    vid.src = clipViewUrl;
    vid.onerror = onVideoError;
    vid.onloadedmetadata = () => {
        const w = vid.videoWidth || 0;
        const h = vid.videoHeight || 0;
        if (w && h) setVideoPreviewFooter(container, `${w} \u00d7 ${h}`);
    };
    mediaHost.appendChild(vid);

    syncWarningOverlay(node);
    node.setDirtyCanvas?.(true, true);
}

async function getCurrentVideoPath(node) {
    const videoWidget = node.widgets?.find((w) => w.name === "video");
    const current = stripAnnotation(videoWidget?.value);
    if (!current || current === "(none)" || current === "(blank)") return null;

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
            node._configuredFromWorkflow = false;

            const setPlayabilityWarning = (enabled) => {
                node._needsPlayabilityWarning = Boolean(enabled);
                ensureMinWarningDisplaySize(node);
                syncWarningOverlay(node);
                node.setDirtyCanvas(true, true);
            };

            const runPlayabilityCheck = async (cleanFilename, onCompatible = null) => {
                const token = ++node._playabilityCheckToken;
                const filename = stripAnnotation(cleanFilename);

                if (!filename || filename === '(none)' || filename === '(blank)') {
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
                        if (token !== node._playabilityCheckToken) return;
                        if (resp.status === 404) {
                            // File missing (e.g. restored workflow referencing a deleted
                            // video) - show the placeholder, not an error/warning.
                            setPlayabilityWarning(false);
                            showPlaceholderVideoPreview(node);
                            return;
                        }
                        // If probe fails for another reason, do not block native preview.
                        if (typeof onCompatible === 'function') {
                            onCompatible();
                        }
                        return;
                    }

                    const info = await resp.json();
                    if (token !== node._playabilityCheckToken) return;

                    if (info.needs_preview) {
                        const probeUrl = buildVideoPreviewUrl(filename, sourceFolder);
                        const browserCanPlay = await probeBrowserPlayback(probeUrl);
                        if (token !== node._playabilityCheckToken) return;

                        if (browserCanPlay) {
                            setPlayabilityWarning(false);
                            if (typeof onCompatible === 'function') {
                                onCompatible();
                            }
                            return;
                        }

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
                syncBypassPreviewStyle(node);

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
            node._videoPickerMap = { '(none)': '(none)', '(blank)': '(blank)' };

            const updateVideoPickerOptions = (values, preferredValue = null) => {
                if (!videoPickerWidget) return;

                const labels = ['(none)', '(blank)'];
                const map = { '(none)': '(none)', '(blank)': '(blank)' };
                const usedLabels = new Set(['(none)', '(blank)']);

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
                    videoWidget.options.values = ["(none)", "(blank)"];
                    if (value && value !== "(none)" && value !== "(blank)") {
                        videoWidget.options.values.push(value);
                    }
                }
                videoWidget.value = value;
                if (!node.properties) node.properties = {};
                node.properties._videoFileSelection = value;

                if (videoWidget.callback) videoWidget.callback(value);

                const map = node._videoPickerMap || { '(none)': '(none)', '(blank)': '(blank)' };
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
                    videoWidget.options.values = ['(none)', '(blank)', ...mapped];
                    updateVideoPickerOptions(mapped, desired);
                    if (desired && desired !== '(none)' && desired !== '(blank)') videoWidget.value = desired;
                    return true;
                } catch (err) {
                    console.warn('[LoadVideoPlus] Could not refresh options for browse path:', err);
                    return false;
                }
            };

            // Video widget
            const videoWidget = this.widgets?.find(w => w.name === "video");
            let videoWidgetIndex = -1;
            if (videoWidget) {
                hideWidget(videoWidget);
                suppressNativeVideoWidget(node, videoWidget);
                videoWidgetIndex = this.widgets.indexOf(videoWidget);

                // Hook into video widget callback to detect H265 and show server-extracted frame
                const origVideoCallback = videoWidget.callback;
                videoWidget.callback = function(value) {
                    const clean = stripAnnotation(value);

                    if (!clean || clean === '(none)') {
                        node._playabilityCheckToken++;
                        setPlayabilityWarning(false);
                        showEmptyVideoPreview(node);
                        return;
                    }

                    if (clean === '(blank)') {
                        node._playabilityCheckToken++;
                        setPlayabilityWarning(false);
                        showPlaceholderVideoPreview(node);
                        return;
                    }

                    if (clean && clean !== '(none)' && clean !== '(blank)') {
                        const applyNativePreview = () => {
                            // Render all previews through our framed video host.
                            // Out-of-tree absolute paths use the raw-file route.
                            createVideoPreview(
                                node,
                                buildVideoPreviewUrl(clean, node._sourceFolder || 'input'),
                                null,
                                clean,
                                node._sourceFolder || 'input'
                            );
                        };

                        // Compatibility is resolved first. Incompatible clips never go through native playback.
                        runPlayabilityCheck(clean, applyNativePreview);
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
                    { values: ['(none)', '(blank)'] }
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
                        if (currentSelection && currentSelection !== "(none)" && currentSelection !== "(blank)") {
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
                                navKind: "video",
                                allowedTypes: ["video"],
                            }
                        );
                    },
                    serialize: false
                };
                this.widgets.splice(videoWidgetIndex + 2, 0, browseButton);
                Object.defineProperty(browseButton, "node", { value: node });

                // Start at a comfortable default size (brand-new nodes).
                if (!node._configuredFromWorkflow) {
                    const cw = Math.max(node.size?.[0] || 0, LOAD_VIDEO_MIN_WIDTH + 40);
                    const ch = Math.max(node.size?.[1] || 0, LOAD_VIDEO_MIN_HEIGHT + 140);
                    node.setSize([cw, ch]);
                }

                const originalOnResize = node.onResize;
                node.onResize = function(size) {
                    if (size) {
                        if (size[0] < LOAD_VIDEO_MIN_WIDTH) size[0] = LOAD_VIDEO_MIN_WIDTH;
                        if (size[1] < LOAD_VIDEO_MIN_HEIGHT) size[1] = LOAD_VIDEO_MIN_HEIGHT;
                    }
                    return originalOnResize ? originalOnResize.apply(this, arguments) : undefined;
                };
            }

            // Initial preview: empty canvas for (none), placeholder for (blank)
            if (videoWidget) {
                if (videoWidget.value === '(blank)') {
                    setTimeout(() => showPlaceholderVideoPreview(node), 100);
                } else if (!videoWidget.value || videoWidget.value === '(none)') {
                    setTimeout(() => showEmptyVideoPreview(node), 100);
                }
            }

            // Restore on workflow load / tab switch
            const onConfigure = node.onConfigure;
            node._initialConfigDone = false;
            node.onConfigure = function(info) {
                const isFirstConfigure = !node._initialConfigDone;
                node._initialConfigDone = true;
                node._configuredFromWorkflow = true;

                const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;

                const sfWidget = this.widgets?.find(w => w.name === "source_folder");
                if (sfWidget) node._sourceFolder = sfWidget.value || 'input';

                // Restore sentinel selection from properties; ComfyUI may reset the
                // hidden video widget to (none) on tab switch. Restore synchronously
                // and unconditionally - the options list is repopulated async below,
                // so we must not gate on its current (stale) contents. Inject the
                // persisted value into the options if it isn't there yet.
                const persistedSelection = node.properties?._videoFileSelection;
                if (persistedSelection && videoWidget) {
                    const allowed = Array.isArray(videoWidget.options?.values)
                        ? videoWidget.options.values
                        : Object.values(videoWidget.options?.values || {});
                    if (!allowed.includes(persistedSelection)) {
                        if (Array.isArray(videoWidget.options.values)) {
                            videoWidget.options.values.push(persistedSelection);
                        } else {
                            videoWidget.options.values = { ...videoWidget.options.values, [persistedSelection]: persistedSelection };
                        }
                    }
                    if (videoWidget.value !== persistedSelection) {
                        videoWidget.value = persistedSelection;
                    }
                }

                if (videoPickerWidget && videoWidget) {
                    const map = node._videoPickerMap || { '(none)': '(none)', '(blank)': '(blank)' };
                    const label = Object.keys(map).find((k) => map[k] === videoWidget.value) || '(none)';
                    if (videoPickerWidget.options?.values?.includes(label)) {
                        videoPickerWidget.value = label;
                    }
                }

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
                            videoWidget.options.values = ["(none)", "(blank)", ...videoFiles];
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
                    if (!filename || filename === '(none)') {
                        node._playabilityCheckToken++;
                        setPlayabilityWarning(false);
                        setTimeout(() => showEmptyVideoPreview(node), 100);
                    } else if (filename === '(blank)') {
                        node._playabilityCheckToken++;
                        setPlayabilityWarning(false);
                        setTimeout(() => showPlaceholderVideoPreview(node), 100);
                    } else if (isAbsolutePath(filename)) {
                        // Out-of-tree absolute path: render via our raw-file route,
                        // then detect H265/yuv444 and swap in a server preview clip.
                        setTimeout(() => {
                            runPlayabilityCheck(filename, () => createVideoPreview(
                                node,
                                buildVideoPreviewUrl(filename, node._sourceFolder || 'input'),
                                null,
                                filename,
                                node._sourceFolder || 'input'
                            ));
                        }, 200);
                    } else {
                        // Render through our framed video host. The playability check
                        // runs first; only compatible/existing files create the player.
                        setTimeout(() => {
                            runPlayabilityCheck(filename, () => createVideoPreview(
                                node,
                                buildVideoPreviewUrl(filename, node._sourceFolder || 'input'),
                                null,
                                filename,
                                node._sourceFolder || 'input'
                            ));
                        }, 200);
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
                                    videoWidget.options.values = ["(none)", "(blank)", ...videoFiles];
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
