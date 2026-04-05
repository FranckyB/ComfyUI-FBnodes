/**
 * Load Image Extension for ComfyUI (FBnodes)
 * Stripped-down image/video loader with file browser, preview, and drag-drop.
 * No metadata extraction - just loads and displays images/video frames.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createFileBrowserModal } from "./file_browser.js";

// Placeholder image path
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;

// Track videos that the browser can't decode (H265/yuv444) to skip browser attempt on future scrubs
const _nonBrowserDecodableVideos = new Set();

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
    let actualFilename = filename;
    let subfolder = "";

    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }

    let imageUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType || 'input'}`;
    if (subfolder) {
        imageUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
    }

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
    let actualFilename = filename;
    let subfolder = "";

    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }

    let videoUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType || 'input'}`;
    if (subfolder) {
        videoUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
    }

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

/**
 * Load and display an image in the node (simplified - no metadata extraction)
 */
async function loadAndDisplayImage(node, filename) {
    if (!filename || filename === '(none)') {
        showPlaceholder(node);
        return;
    }
    filename = stripAnnotation(filename);

    const ext = filename.split('.').pop().toLowerCase();

    if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) {
        loadVideoFrame(node, filename);
        return;
    }

    if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        loadImageFile(node, filename);
        return;
    }

    showPlaceholder(node);
}

/**
 * Load an image file and display it (no metadata extraction)
 */
async function loadImageFile(node, filename) {
    try {
        const viewType = node._sourceFolder || 'input';

        let actualFilename = filename;
        let subfolder = "";
        if (filename.includes('/')) {
            const lastSlash = filename.lastIndexOf('/');
            subfolder = filename.substring(0, lastSlash);
            actualFilename = filename.substring(lastSlash + 1);
        }
        let fileUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType}`;
        if (subfolder) {
            fileUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
        }

        const img = new Image();
        img.onload = () => {
            node.imgs = [img];
            node.imageIndex = 0;
            node._loadedImageFilename = filename;

            const targetWidth = Math.max(node.size[0], 256);
            const targetHeight = Math.max(node.size[1], img.naturalHeight * (targetWidth / img.naturalWidth) + 100);
            node.setSize([targetWidth, targetHeight]);

            node.setDirtyCanvas(true, true);
            app.graph.setDirtyCanvas(true, true);
        };

        img.onerror = () => {
            console.error(`[LoadImagePlus] Failed to load image: ${filename}`);
            showPlaceholder(node);
        };

        img.src = `${fileUrl}&${Date.now()}`;
    } catch (error) {
        console.error("[LoadImagePlus] Error loading image:", error);
        showPlaceholder(node);
    }
}

/**
 * Load a video frame from the server-side PyAV endpoint (for H265/yuv444 videos).
 */
function loadVideoFrameFromServer(node, filename, framePosition, viewType) {
    const frameUrl = `/fbnodes/video-frame?filename=${encodeURIComponent(filename)}&source=${viewType}&position=${framePosition}`;
    const img = new Image();
    img.onload = () => {
        node.imgs = [img];
        node.imageIndex = 0;
        node._loadedImageFilename = filename;
        node._loadedFramePosition = framePosition;

        // Cache as base64 for Python backend
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const frameData = canvas.toDataURL('image/png');
        cacheVideoFrame(filename, frameData, framePosition);

        // Resize node to fit image
        const targetWidth = Math.max(node.size[0], 256);
        const targetHeight = Math.max(node.size[1], img.naturalHeight * (targetWidth / img.naturalWidth) + 100);
        node.setSize([targetWidth, targetHeight]);

        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);
    };
    img.onerror = () => {
        console.error(`[LoadImagePlus] Server-side frame extraction failed for: ${filename}`);
        showPlaceholder(node);
    };
    img.src = frameUrl;
}

/**
 * Load frame from a video file at specified position
 */
async function loadVideoFrame(node, filename) {
    try {
        const framePositionWidget = node.widgets?.find(w => w.name === "frame_position");
        const framePosition = framePositionWidget ? framePositionWidget.value : 0.0;
        const viewType = node._sourceFolder || 'input';

        let actualFilename = filename;
        let subfolder = "";

        if (filename.includes('/')) {
            const lastSlash = filename.lastIndexOf('/');
            subfolder = filename.substring(0, lastSlash);
            actualFilename = filename.substring(lastSlash + 1);
        }

        let videoUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType}`;
        if (subfolder) {
            videoUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
        }

        // If this video is already known to be non-browser-decodable, go straight to server
        if (_nonBrowserDecodableVideos.has(filename)) {
            loadVideoFrameFromServer(node, filename, framePosition, viewType);
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
                node.imgs = [img];
                node.imageIndex = 0;
                node._loadedImageFilename = filename;
                node._loadedFramePosition = framePosition;

                const frameData = canvas.toDataURL('image/png');
                cacheVideoFrame(filename, frameData, framePosition);

                const targetWidth = Math.max(node.size[0], 256);
                const targetHeight = Math.max(node.size[1], img.naturalHeight * (targetWidth / img.naturalWidth) + 100);
                node.setSize([targetWidth, targetHeight]);

                node.setDirtyCanvas(true, true);
                app.graph.setDirtyCanvas(true, true);
                cleanupVideo();
            };

            img.onerror = () => {
                console.error(`[LoadImagePlus] Failed to create image from video frame`);
                cleanupVideo();
                showPlaceholder(node);
            };

            img.src = canvas.toDataURL('image/png');
        };

        video.onerror = () => {
            console.log(`[LoadImagePlus] Browser cannot decode video, using server-side extraction: ${filename}`);
            // Remember this video can't be decoded by browser - skip browser attempt on future scrubs
            _nonBrowserDecodableVideos.add(filename);
            cleanupVideo();
            loadVideoFrameFromServer(node, filename, framePosition, viewType);
        };

        document.body.appendChild(video);
        video.src = videoUrl + `&${Date.now()}`;
    } catch (error) {
        console.error("[LoadImagePlus] Error loading video:", error);
        showPlaceholder(node);
    }
}

/**
 * Show placeholder image
 */
function showPlaceholder(node) {
    node._loadedImageFilename = null;
    node._loadedFramePosition = null;

    const placeholderImg = new Image();
    placeholderImg.src = PLACEHOLDER_IMAGE_PATH;
    placeholderImg.onload = () => {
        node.imgs = [placeholderImg];
        node.imageIndex = 0;

        const targetWidth = Math.max(node.size[0], 256);
        const targetHeight = Math.max(node.size[1], placeholderImg.naturalHeight * (targetWidth / placeholderImg.naturalWidth) + 100);
        node.setSize([targetWidth, targetHeight]);

        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);
    };
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

            node._loadedImageFilename = null;
            node._loadedFramePosition = null;
            node._sourceFolder = 'input';

            const framePositionWidget = this.widgets?.find(w => w.name === "frame_position");

            // Source folder widget
            const sourceFolderWidget = this.widgets?.find(w => w.name === "source_folder");
            if (sourceFolderWidget) {
                node._sourceFolder = sourceFolderWidget.value || 'input';
                const origSfCb = sourceFolderWidget.callback;
                sourceFolderWidget.callback = async function(value) {
                    if (origSfCb) origSfCb.apply(this, arguments);
                    node._sourceFolder = value || 'input';
                    try {
                        const listResponse = await api.fetchApi(`/fbnodes/list-files?source=${encodeURIComponent(value)}`);
                        if (listResponse.ok) {
                            const result = await listResponse.json();
                            if (imageWidget) {
                                imageWidget.options.values = ["(none)", ...(result.files || [])];
                                imageWidget.value = "(none)";
                                if (imageWidget.callback) imageWidget.callback("(none)");
                            }
                        }
                    } catch (err) {
                        console.warn('[LoadImagePlus] Could not fetch file list:', err);
                    }
                    node.setDirtyCanvas(true);
                };
            }

            // Image widget
            const imageWidget = this.widgets?.find(w => w.name === "image");
            if (imageWidget) {
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

                    loadAndDisplayImage(node, value);
                };

                // Browse Files button
                const imageWidgetIndex = this.widgets.indexOf(imageWidget);
                const browseButton = {
                    type: "button",
                    name: "\u{1F4C1} Browse Files",
                    value: null,
                    callback: () => {
                        const currentFile = imageWidget.value === "(none)" ? null : imageWidget.value;
                        const sourceFolder = node._sourceFolder || 'input';
                        createFileBrowserModal(currentFile, (selectedFile) => {
                            imageWidget.value = selectedFile;
                            if (imageWidget.callback) imageWidget.callback(selectedFile);
                            node.setDirtyCanvas(true);
                        }, sourceFolder);
                    },
                    serialize: false
                };
                this.widgets.splice(imageWidgetIndex + 1, 0, browseButton);
                Object.defineProperty(browseButton, "node", { value: node });

                node._isVideoFile = false;

                const updateVideoUIVisibility = () => {
                    const isVideo = isVideoFile(imageWidget.value);
                    node._isVideoFile = isVideo;
                    if (framePositionWidget) {
                        framePositionWidget.hidden = !isVideo;
                    }
                    node.setDirtyCanvas(true);
                };

                const wrappedCallback = imageWidget.callback;
                imageWidget.callback = function(value) {
                    if (wrappedCallback) wrappedCallback.apply(this, arguments);
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
                const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;

                const sfWidget = this.widgets?.find(w => w.name === "source_folder");
                if (sfWidget) node._sourceFolder = sfWidget.value || 'input';

                if (node._sourceFolder === 'output' && imageWidget) {
                    api.fetchApi(`/fbnodes/list-files?source=output`).then(resp => {
                        if (resp.ok) return resp.json();
                    }).then(data => {
                        if (data && data.files) {
                            const savedValue = imageWidget.value;
                            imageWidget.options.values = ["(none)", ...data.files];
                            if (savedValue && data.files.includes(savedValue)) {
                                imageWidget.value = savedValue;
                            }
                        }
                    }).catch(() => {});
                }

                if (info && info.widgets_values && framePositionWidget) {
                    const idx = this.widgets.findIndex(w => w.name === "frame_position");
                    if (idx >= 0 && info.widgets_values[idx] !== undefined) {
                        framePositionWidget.value = info.widgets_values[idx];
                    }
                }

                if (imageWidget && imageWidget.value && imageWidget.value !== "(none)") {
                    const isVideo = isVideoFile(imageWidget.value);
                    const currentFramePos = framePositionWidget ? framePositionWidget.value : 0.0;
                    const expectedFilename = encodeURIComponent(imageWidget.value);
                    const hasCorrectImage = node.imgs && node.imgs[0] &&
                        node.imgs[0].src && node.imgs[0].src.includes(expectedFilename);
                    const alreadyLoaded = node._loadedImageFilename === imageWidget.value &&
                        (!isVideo || node._loadedFramePosition === currentFramePos) &&
                        hasCorrectImage;
                    if (!alreadyLoaded) {
                        loadAndDisplayImage(node, imageWidget.value);
                    }
                }
                return result;
            };

            // Initial load
            if (imageWidget) {
                setTimeout(() => {
                    if (imageWidget.value && imageWidget.value !== "(none)") {
                        if (node._loadedImageFilename !== imageWidget.value) {
                            loadAndDisplayImage(node, imageWidget.value);
                        }
                    } else {
                        showPlaceholder(node);
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
                            try {
                                const sf = node._sourceFolder || 'input';
                                const listResponse = await api.fetchApi(`/fbnodes/list-files?source=${encodeURIComponent(sf)}`);
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

                return result;
            };

            const onMouseMove = node.onMouseMove;
            node.onMouseMove = function(e, localPos, canvas) {
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

            return result;
        };
    }
});

console.log("[FBnodes] LoadImagePlus extension loaded");
