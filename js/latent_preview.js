import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * Latent Preview Extension for FBnodes
 * Provides animated previews during video model sampling.
 * Compatible with VideoHelperSuite - will defer to VHS if installed.
 */

// Track nodes that have latent preview widgets
let latentPreviewNodes = new Set();

// Store preview images per node
let previewImagesDict = {};

// Animation intervals for each node
let animateIntervals = {};

// Avoid log spam if lookup throws in a hot path.
let nodeLookupWarned = false;

// Text decoder for binary messages
const textDecoder = new TextDecoder();

/**
 * Get a node by ID, handling subgraphs
 */
function findNodeInGraphRecursive(graph, id, visited = new Set()) {
    if (!graph?.getNodeById) return null;
    if (visited.has(graph)) return null;
    visited.add(graph);

    const idCandidates = [id];
    const numericId = Number(id);
    if (!Number.isNaN(numericId)) {
        idCandidates.push(numericId);
    }

    for (const candidate of idCandidates) {
        const direct = graph.getNodeById(candidate);
        if (direct) return direct;
    }

    const subgraphs = graph.subgraphs;
    if (subgraphs) {
        const iterable =
            typeof subgraphs.values === "function"
                ? subgraphs.values()
                : Array.isArray(subgraphs)
                    ? subgraphs
                    : Object.values(subgraphs);

        for (const subgraph of iterable) {
            const found = findNodeInGraphRecursive(subgraph, id, visited);
            if (found) return found;
        }
    }

    return null;
}

function resolveCompositeNodeId(rootGraph, compositeId) {
    if (!rootGraph?.getNodeById || !String(compositeId).includes(':')) return null;

    const parts = String(compositeId).split(':').filter(Boolean);
    if (parts.length === 0) return null;

    let currentGraph = rootGraph;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const node = currentGraph.getNodeById(part) || currentGraph.getNodeById(Number(part));
        if (!node) return null;
        if (i === parts.length - 1) {
            return node;
        }
        currentGraph = node.subgraph || node.subGraph;
        if (!currentGraph) return null;
    }

    return null;
}

function getNodeById(id) {
    try {
    const rawCandidates = [
        app.canvas?.graph,
        app.canvas?.graph?.rootGraph,
        app.graph,
        app.graph?.rootGraph,
    ].filter(Boolean);

    const graphCandidates = [];
    const seenGraphs = new Set();
    for (const graph of rawCandidates) {
        if (!seenGraphs.has(graph)) {
            seenGraphs.add(graph);
            graphCandidates.push(graph);
        }
    }

    for (const graph of graphCandidates) {
        const node = findNodeInGraphRecursive(graph, id, new Set());
        if (node) return node;
    }

    // Some nested workflows report ids like parent:child:node. Resolve by path first.
    for (const graph of graphCandidates) {
        const node = resolveCompositeNodeId(graph, id);
        if (node) return node;
    }

    // Final fallback for composite IDs: search by terminal node id across all nested graphs.
    const idParts = String(id).split(':').filter(Boolean);
    if (idParts.length > 1) {
        const leafId = idParts[idParts.length - 1];
        for (const graph of graphCandidates) {
            const node = findNodeInGraphRecursive(graph, leafId, new Set());
            if (node) return node;
        }
    }

    } catch (err) {
        if (!nodeLookupWarned) {
            nodeLookupWarned = true;
            console.warn("[FBnodes] Latent preview node lookup fallback:", err);
        }
    }

    // Safety fallback matching prior behavior.
    let node = app.graph?.getNodeById?.(id);
    if (!node) {
        const n = Number(id);
        if (!Number.isNaN(n)) {
            node = app.graph?.getNodeById?.(n);
        }
    }
    if (node) return node;

    const subgraphs = app.graph?.subgraphs;
    if (subgraphs) {
        const iterable =
            typeof subgraphs.values === "function"
                ? subgraphs.values()
                : Array.isArray(subgraphs)
                    ? subgraphs
                    : Object.values(subgraphs);
        for (const subgraph of iterable) {
            node = subgraph?.getNodeById?.(id);
            if (!node) {
                const n = Number(id);
                if (!Number.isNaN(n)) {
                    node = subgraph?.getNodeById?.(n);
                }
            }
            if (node) return node;
        }
    }

    return null;
}

/**
 * Fit the node height to accommodate the preview widget
 */
function fitHeight(node) {
    node.setSize([node.size[0], node.computeSize()[1]]);
    node.graph?.setDirtyCanvas(true, true);
}

/**
 * Allow drag from the preview widget
 */
function allowDragFromWidget(widget) {
    widget.element.addEventListener('pointerdown', (e) => {
        if (e.button === 0) {
            // Prevent default to allow canvas interaction
            e.stopPropagation();
        }
    });
}

/**
 * Get or create the canvas context for latent preview
 */
function getLatentPreviewCtx(id, width, height) {
    const node = getNodeById(id);
    if (!node) {
        return undefined;
    }

    let previewWidget = node.widgets?.find((w) => w.name === "pmlatentpreview");
    
    if (!previewWidget) {
        // Check for and remove any native preview
        const nativePreview = node.widgets?.findIndex((w) => w.name === '$$canvas-image-preview');
        if (nativePreview >= 0) {
            node.imgs = [];
            node.widgets.splice(nativePreview, 1);
        }
        
        // Create canvas element
        const canvasEl = document.createElement("canvas");
        canvasEl.style.width = "100%";
        
        previewWidget = node.addDOMWidget("pmlatentpreview", "pmcanvas", canvasEl, {
            serialize: false,
            hideOnZoom: false,
        });
        previewWidget.serialize = false;
        
        allowDragFromWidget(previewWidget);
        
        // Forward mouse events to canvas for interaction
        const forwardEvent = (eventName, handler) => {
            canvasEl.addEventListener(eventName, (e) => {
                e.preventDefault();
                return handler(e);
            }, true);
        };
        
        forwardEvent('contextmenu', (e) => app.canvas._mousedown_callback(e));
        forwardEvent('pointerdown', (e) => app.canvas._mousedown_callback(e));
        forwardEvent('mousewheel', (e) => app.canvas._mousewheel_callback(e));
        forwardEvent('pointermove', (e) => app.canvas._mousemove_callback(e));
        forwardEvent('pointerup', (e) => app.canvas._mouseup_callback(e));

        previewWidget.computeSize = function(width) {
            if (this.aspectRatio) {
                let height = (node.size[0] - 20) / this.aspectRatio + 10;
                if (!(height > 0)) {
                    height = 0;
                }
                this.computedHeight = height + 10;
                return [width, height];
            }
            return [width, -4]; // No loaded src, widget should not display
        };
    }
    
    const canvasEl = previewWidget.element;
    if (!previewWidget.ctx || canvasEl.width !== width || canvasEl.height !== height) {
        previewWidget.aspectRatio = width / height;
        canvasEl.width = width;
        canvasEl.height = height;
        fitHeight(node);
    }
    
    return canvasEl.getContext("2d");
}

/**
 * Begin animated latent preview for a node
 *
 * `rate` is the number of latent frames per second of real video
 * (video_fps / temporal_compression, sent by the backend). Advancing one frame
 * every 1000/rate ms therefore plays back in real time. If a frame hasn't been
 * decoded yet we skip it (advance the clock anyway) rather than pausing, so
 * playback speed stays locked to real time instead of stretching into slow-mo.
 */
function beginLatentPreview(id, previewImages, rate) {
    latentPreviewNodes.add(id);

    if (animateIntervals[id]) {
        clearInterval(animateIntervals[id]);
    }

    let displayIndex = 0;
    // Last frame we actually drew - reused as a placeholder when the current
    // frame hasn't arrived yet, so timing never stalls waiting for the decoder.
    let lastDrawn = null;
    const node = getNodeById(id);

    // Initialize progress to avoid race condition
    if (node) {
        node.progress = 0;
    }

    const frameDuration = 1000 / Math.max(1, rate);

    animateIntervals[id] = setInterval(() => {
        const currentNode = getNodeById(id);
        if (!currentNode?.progress && currentNode?.progress !== 0) {
            clearInterval(animateIntervals[id]);
            delete animateIntervals[id];
            return;
        }

        // Check if we're still on the right graph
        if (app.canvas.graph.rootGraph !== currentNode.graph?.rootGraph) {
            clearInterval(animateIntervals[id]);
            delete animateIntervals[id];
            return;
        }

        // Prefer the frame for this timeslot; if it isn't decoded yet, fall back
        // to the last drawn frame so the display updates but the clock keeps moving.
        let frame = previewImages[displayIndex];
        if (frame) {
            lastDrawn = frame;
        } else {
            frame = lastDrawn;
        }

        if (frame) {
            const ctx = getLatentPreviewCtx(id, frame.width, frame.height);
            ctx?.drawImage?.(frame, 0, 0);
        }

        // Always advance - real-time pacing, never slow down waiting for frames.
        displayIndex = (displayIndex + 1) % previewImages.length;
    }, frameDuration);
}

/**
 * Check if VideoHelperSuite is providing latent preview
 */
function isVHSLatentPreviewActive() {
    // Check if VHS extension is registered and has latent preview enabled
    const vhsExtension = app.extensions.find(ext => ext.name === "VideoHelperSuite.Core");
    if (vhsExtension) {
        try {
            const vhsSetting = app.ui.settings.getSettingValue("VHS.LatentPreview");
            return vhsSetting === true;
        } catch (e) {
            // Setting doesn't exist or error
        }
    }
    return false;
}

app.registerExtension({
    name: "FBnodes.LatentPreview",
    settings: [
        // NOTE: the settings panel renders this array in REVERSE order, so the
        // last entry appears first. Kept so "Display animated..." shows on top.
        {
            id: "FBnodes.PreviewMaxRes",
            category: ["FBnodes", "Preview Injection", "Preview Resolution"],
            name: "Max preview resolution",
            tooltip: "Maximum resolution (longest side) the TAESD preview is displayed at.\nMatches ComfyUI's 512px default. Raise for sharper previews (slower), lower for faster.\nApplies to the displayed preview only - the video is decoded at full size first.",
            type: "number",
            defaultValue: 512,
            attrs: { min: 128, max: 1024, step: 16 },
        },
        {
            id: "FBnodes.InjectLtxFile",
            category: ["FBnodes", "Preview Injection", "LTX"],
            name: "LTX TAESD filename",
            tooltip: "The vae_approx file used for LTX true-color previews.\nLeave blank to use the default (taeltx2_3.safetensors).",
            type: "text",
            defaultValue: "",
        },
        {
            id: "FBnodes.InjectLtx",
            category: ["FBnodes", "Preview Injection", "LTX Enable"],
            name: "Enable LTX latent preview injection",
            tooltip: "Enables true-color (TAESD) animated previews for LTX video models.\n\nComfyUI does not ship a preview VAE for LTX - place the LTX TAESD file in models/vae_approx.",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "FBnodes.InjectMinimaxFile",
            category: ["FBnodes", "Preview Injection", "MiniMax"],
            name: "MiniMax TAESD filename",
            tooltip: "The vae_approx file used for MiniMax true-color previews.\nLeave blank to use the default (taeh3.safetensors).",
            type: "text",
            defaultValue: "",
        },
        {
            id: "FBnodes.InjectMinimax",
            category: ["FBnodes", "Preview Injection", "MiniMax Enable"],
            name: "Enable MiniMax latent preview injection",
            tooltip: "Enables true-color (TAESD) animated previews for MiniMax H3 video models.\n\nComfyUI does not ship a preview VAE for MiniMax - place the MiniMax TAESD file in models/vae_approx.",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "FBnodes.LatentPreviewSeconds",
            category: ["FBnodes", "3. Video Sampling", "Animated Preview"],
            name: "Preview length (seconds)",
            tooltip: "How many seconds of the video (from the start) are shown in the animated preview.\nThe same segment is re-decoded each sampling step, so you watch it progressively sharpen.\nLower = less decode cost per step.",
            type: "number",
            defaultValue: 5,
            attrs: { min: 1, max: 30, step: 1 },
        },
        {
            id: "FBnodes.LatentPreview",
            category: ["FBnodes", "3. Video Sampling", "Animated Latent Preview"],
            name: "Display animated or subgraph previews when sampling",
            tooltip: "Enable animated preview as well as subgraph previews during ksampling.\nWill be ignored if VideoHelperSuite provides this feature.",
            type: "boolean",
            defaultValue: true,
            onChange(value) {
                if (!value) {
                    // Remove any preview widgets when disabled
                    for (const id of latentPreviewNodes) {
                        const node = app.graph?.getNodeById(id);
                        const widgetIndex = node?.widgets?.findIndex((w) => w.name === 'pmlatentpreview');
                        if (widgetIndex >= 0) {
                            const widget = node.widgets.splice(widgetIndex, 1)[0];
                            widget.onRemove?.();
                        }
                    }
                    latentPreviewNodes = new Set();
                }
            },
        },
    ],
    
    async setup() {
        // Hook into graphToPrompt to pass our settings to the backend
        const originalGraphToPrompt = app.graphToPrompt;
        
        app.graphToPrompt = async function() {
            const res = await originalGraphToPrompt.apply(this, arguments);
            
            // Check if VHS is handling latent preview
            const vhsActive = isVHSLatentPreviewActive();
            
            if (!vhsActive) {
                // Add our settings to the workflow extra data
                res.workflow.extra['PM_latentpreview'] = app.ui.settings.getSettingValue("FBnodes.LatentPreview");
                res.workflow.extra['FB_preview_seconds'] = app.ui.settings.getSettingValue("FBnodes.LatentPreviewSeconds");
                // Per-model TAESD injection toggles + optional custom filenames
                res.workflow.extra['FB_inject_minimax'] = app.ui.settings.getSettingValue("FBnodes.InjectMinimax");
                res.workflow.extra['FB_inject_minimax_file'] = app.ui.settings.getSettingValue("FBnodes.InjectMinimaxFile");
                res.workflow.extra['FB_inject_ltx'] = app.ui.settings.getSettingValue("FBnodes.InjectLtx");
                res.workflow.extra['FB_inject_ltx_file'] = app.ui.settings.getSettingValue("FBnodes.InjectLtxFile");
                res.workflow.extra['FB_preview_max_res'] = app.ui.settings.getSettingValue("FBnodes.PreviewMaxRes");
            }
            
            return res;
        };
        
        console.log("[FBnodes] Latent preview extension loaded");
    },
    
    async init() {
        // Clear preview nodes on execution complete
        api.addEventListener('executing', ({ detail }) => {
            if (detail === null) {
                // Execution complete - clean up progress indicators
                for (const id of latentPreviewNodes) {
                    const node = getNodeById(id);
                    if (node) {
                        delete node.progress;
                    }
                }
            }
        });
        
        // Handler for latent preview init events (shared by PM and VHS-compatible sources)
        function handleLatentPreviewInit(detail) {
            if (detail.id == null) {
                return;
            }
            
            // Skip if VHS is active (it handles its own previews)
            if (isVHSLatentPreviewActive()) {
                return;
            }
            
            const previewImages = previewImagesDict[detail.id] = [];
            previewImages.length = detail.length;

            // Handle node ID parts (for subgraphs)
            const idParts = detail.id.split(':');
            for (let i = 1; i <= idParts.length; i++) {
                const id = idParts.slice(0, i).join(':');
                beginLatentPreview(id, previewImages, detail.rate);
            }
        }

        // Listen for our own latent preview initialization
        api.addEventListener('PM_latentpreview', ({ detail }) => handleLatentPreviewInit(detail));

        // Also catch VHS_latentpreview events (e.g. from KJNodes' LTX2SamplingPreviewOverride)
        // so animated previews work for LTX2 even without VideoHelperSuite installed
        api.addEventListener('VHS_latentpreview', ({ detail }) => handleLatentPreviewInit(detail));
        
        // Listen for binary preview images
        api.addEventListener('b_preview', async (e) => {
            // Only handle if we have active animations and VHS isn't handling it
            if (Object.keys(animateIntervals).length === 0 || isVHSLatentPreviewActive()) {
                return;
            }
            
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            
            const dv = new DataView(await e.detail.slice(0, 24).arrayBuffer());
            const index = dv.getUint32(4);
            const idlen = dv.getUint8(8);
            const id = textDecoder.decode(dv.buffer.slice(9, 9 + idlen));
            
            // Only process if this is our preview (PM_ prefix in the workflow extra)
            if (previewImagesDict[id]) {
                previewImagesDict[id][index] = await window.createImageBitmap(e.detail.slice(24));
            }
            
            return false;
        }, true);
    },
});
