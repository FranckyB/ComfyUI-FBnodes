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
            loadServerPreviewClip(node, filename, sourceFolder);
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

                    // Files outside input/output are absolute paths the native
                    // player can't fetch via /view; render our own preview, then
                    // run H265 detection so unplayable codecs get a server clip.
                    if (isAbsolutePath(value)) {
                        if (origVideoCallback) origVideoCallback.apply(this, arguments);
                        videoWidget.value = clean;
                        createVideoPreview(node, mediaFileUrl(clean));
                        checkVideoPlayability(node, clean);
                        return;
                    }

                    // The native player reads widget.value to build the video URL.
                    // Temporarily set value with [output] so it resolves correctly,
                    // then restore the clean name for display.
                    if (node._sourceFolder === 'output' && clean && clean !== '(none)') {
                        videoWidget.value = clean + ' [output]';
                    }
                    if (origVideoCallback) origVideoCallback.apply(this, arguments);
                    // Restore clean display name
                    if (clean) videoWidget.value = clean;

                    if (clean && clean !== '(none)') {
                        checkVideoPlayability(node, clean);
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
                        createFileBrowserModal(
                            isAbsolutePath(videoWidget.value) ? stripAnnotation(videoWidget.value) : null,
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
                            checkVideoPlayability(node, filename);
                        }, 200);
                    } else if (filename && filename !== '(none)') {
                        // Ensure native player can resolve output files
                        if (node._sourceFolder === 'output') {
                            videoWidget.value = filename + ' [output]';
                            setTimeout(() => { videoWidget.value = filename; }, 200);
                        }
                        setTimeout(() => checkVideoPlayability(node, filename), 500);
                    } else {
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
