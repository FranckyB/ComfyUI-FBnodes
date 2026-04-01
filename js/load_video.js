/**
 * LoadVideoPlus Extension for ComfyUI (FBnodes)
 * Video loader with file browser, drag-drop, and native video playback.
 * Uses ComfyUI's native video_upload widget with [output] path annotations
 * for output folder support.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createFileBrowserModal } from "./file_browser.js";

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv'];

// Track videos that the browser can't decode (H265/yuv444) to skip browser attempt on future loads
const _nonBrowserDecodableVideos = new Set();

// Placeholder image path
const PLACEHOLDER_IMAGE_PATH = new URL("./placeholder.png", import.meta.url).href;

/**
 * Strip [input]/[output]/[temp] annotation from a path
 */
function stripAnnotation(value) {
    if (!value) return value;
    return value.replace(/\s*\[(input|output|temp)\]\s*$/, '');
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
 * Check if a video can be played in the browser.
 * If not (H265/yuv444), ask the server to generate a browser-playable 1-frame
 * H264 clip and feed that to ComfyUI's native video player instead.
 */
function checkVideoPlayability(node, filename) {
    if (!filename || filename === '(none)') return;

    const sourceFolder = node._sourceFolder || 'input';

    // If already known non-decodable, go straight to server fallback
    if (_nonBrowserDecodableVideos.has(filename)) {
        loadServerPreviewClip(node, filename, sourceFolder);
        return;
    }

    // Instant synchronous check: ask the browser if it can play H265 at all.
    // canPlayType returns "" (no), "maybe", or "probably".
    // If the browser flat-out says no to both hvc1 and hev1, skip the slow
    // async probe and request the server clip immediately.
    const testEl = document.createElement('video');
    const h265Support = testEl.canPlayType('video/mp4; codecs="hvc1"')
                     || testEl.canPlayType('video/mp4; codecs="hev1"');
    if (!h265Support) {
        // Browser definitively cannot play H265 — go straight to server clip
        const ext = filename.split('.').pop().toLowerCase();
        if (['mp4', 'mov', 'm4v', 'mkv'].includes(ext)) {
            console.log(`[LoadVideoPlus] Browser has no H265 support, requesting preview clip: ${filename}`);
            _nonBrowserDecodableVideos.add(filename);
            loadServerPreviewClip(node, filename, sourceFolder);
            return;
        }
    }

    // Build the video URL (same as ComfyUI's native player uses)
    let actualFilename = filename;
    let subfolder = "";
    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }
    let videoUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${sourceFolder}`;
    if (subfolder) {
        videoUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
    }

    // Async probe for ambiguous cases (browser said "maybe"/"probably" but
    // the specific file might still fail, e.g. yuv444 pixel format).
    const testVideo = document.createElement('video');
    testVideo.preload = 'auto';
    testVideo.muted = true;
    testVideo.playsInline = true;
    testVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

    let resolved = false;
    const cleanup = () => {
        if (resolved) return;
        resolved = true;
        testVideo.onloadeddata = null;
        testVideo.onerror = null;
        try { testVideo.src = ''; testVideo.load(); } catch (e) { /* ignore */ }
        if (testVideo.parentNode) testVideo.parentNode.removeChild(testVideo);
    };

    // 'loadeddata' = browser successfully decoded at least one video frame
    testVideo.onloadeddata = () => {
        cleanup();
        // Browser plays this fine — nothing to do
    };

    testVideo.onerror = () => {
        console.log(`[LoadVideoPlus] Browser cannot decode video, requesting H264 preview clip: ${filename}`);
        _nonBrowserDecodableVideos.add(filename);
        cleanup();
        loadServerPreviewClip(node, filename, sourceFolder);
    };

    // Safety timeout – if neither event fires within 3s, assume playable
    setTimeout(() => {
        if (!resolved) {
            console.log(`[LoadVideoPlus] Video probe timed out, assuming playable: ${filename}`);
            cleanup();
        }
    }, 3000);

    document.body.appendChild(testVideo);
    testVideo.src = videoUrl;
}

/**
 * Ask the server to produce a 1-frame H264 mp4 from the H265 source,
 * then point the native video_upload widget at that clip so ComfyUI's
 * own player renders it with no special treatment.
 */
async function loadServerPreviewClip(node, filename, sourceFolder) {
    try {
        const resp = await api.fetchApi(
            `/fbnodes/video-frame-clip?filename=${encodeURIComponent(filename)}&source=${sourceFolder}`
        );
        if (!resp.ok) {
            console.error(`[LoadVideoPlus] Server clip generation failed: ${resp.status}`);
            return;
        }
        const data = await resp.json();
        // data = { filename, type, subfolder }

        // Build a /view URL for the generated clip in temp/
        let clipViewUrl = `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}`;
        if (data.subfolder) clipViewUrl += `&subfolder=${encodeURIComponent(data.subfolder)}`;

        // Swap the native video element's src to our H264 clip.
        // The native player may not have created videoContainer yet (e.g. first
        // selection via Browse), so poll briefly until it appears.
        const swapVideoSrc = () => {
            const vid = node.videoContainer?.querySelector('video')
                || node.widgets?.find(w => w.name === 'video-preview')?.element?.querySelector('video');
            if (!vid) return false;
            const source = vid.querySelector('source');
            if (source) {
                source.src = clipViewUrl;
                source.removeAttribute('type');
            } else {
                vid.src = clipViewUrl;
            }
            vid.load();
            return true;
        };

        if (swapVideoSrc()) return;

        // Poll for up to 1 second waiting for the native player to initialise
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            if (swapVideoSrc()) {
                clearInterval(poll);
            } else if (attempts >= 10) {
                clearInterval(poll);
                // Native player never created a video element (H265 failed to
                // load there too).  Create the container + video ourselves,
                // mirroring ComfyUI's own useNodeVideo pattern.
                createVideoPreview(node, clipViewUrl);
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
function createVideoPreview(node, clipViewUrl) {
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

            node._sourceFolder = 'input';

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
                            if (videoWidget) {
                                const videoFiles = (result.files || []).filter(f => {
                                    const ext = f.split('.').pop().toLowerCase();
                                    return VIDEO_EXTENSIONS.includes(ext);
                                });
                                // Annotate output files so native player uses type=output
                                const annotated = videoFiles.map(f => annotatePath(f, value));
                                videoWidget.options.values = ["(none)", ...annotated];
                                videoWidget.value = "(none)";
                                if (videoWidget.callback) videoWidget.callback("(none)");
                            }
                        }
                    } catch (err) {
                        console.warn('[LoadVideoPlus] Could not fetch file list:', err);
                    }
                    node.setDirtyCanvas(true);
                };
            }

            // Video widget
            const videoWidget = this.widgets?.find(w => w.name === "video");
            if (videoWidget) {
                // Hook into video widget callback to detect H265 and show server-extracted frame
                const origVideoCallback = videoWidget.callback;
                videoWidget.callback = function(value) {
                    if (origVideoCallback) origVideoCallback.apply(this, arguments);
                    const filename = stripAnnotation(value);
                    if (filename && filename !== '(none)') {
                        checkVideoPlayability(node, filename);
                    }
                };

                // Browse Files button
                const videoWidgetIndex = this.widgets.indexOf(videoWidget);
                const browseButton = {
                    type: "button",
                    name: "\u{1F4C1} Browse Files",
                    value: null,
                    callback: () => {
                        const rawValue = videoWidget.value;
                        const currentFile = (!rawValue || rawValue === "(none)") ? null : stripAnnotation(rawValue);
                        const sourceFolder = node._sourceFolder || 'input';
                        createFileBrowserModal(currentFile, (selectedFile) => {
                            const annotated = annotatePath(selectedFile, node._sourceFolder);
                            videoWidget.value = annotated;
                            if (videoWidget.callback) videoWidget.callback(annotated);
                            node.setDirtyCanvas(true);
                        }, sourceFolder, { defaultFilter: 'video' });
                    },
                    serialize: false
                };
                this.widgets.splice(videoWidgetIndex + 1, 0, browseButton);
                Object.defineProperty(browseButton, "node", { value: node });
            }

            // Restore on workflow load
            const onConfigure = node.onConfigure;
            node.onConfigure = function(info) {
                const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;

                const sfWidget = this.widgets?.find(w => w.name === "source_folder");
                if (sfWidget) node._sourceFolder = sfWidget.value || 'input';

                if (node._sourceFolder === 'output' && videoWidget) {
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
                            const annotated = videoFiles.map(f => annotatePath(f, 'output'));
                            videoWidget.options.values = ["(none)", ...annotated];
                            // Restore the saved value (ensure it has annotation)
                            if (savedStripped && videoFiles.includes(savedStripped)) {
                                const restoredValue = annotatePath(savedStripped, 'output');
                                videoWidget.value = restoredValue;
                                if (videoWidget.callback) videoWidget.callback(restoredValue);
                            }
                        }
                    }).catch(() => {});
                }

                // Check video playability on workflow load (H265 fallback)
                if (videoWidget) {
                    const filename = stripAnnotation(videoWidget.value);
                    if (filename && filename !== '(none)') {
                        // Small delay to let native player attempt to load first
                        setTimeout(() => checkVideoPlayability(node, filename), 500);
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
                                node._sourceFolder = 'input';
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
