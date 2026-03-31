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
