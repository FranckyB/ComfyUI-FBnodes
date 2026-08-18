/**
 * CropAudioPlus Extension for ComfyUI (FBnodes)
 * Minimal crop node: in_point / out_point sliders only. No preview player.
 */

import { app } from "../../scripts/app.js";

const MIN_NODE_WIDTH = 220;

app.registerExtension({
    name: "FBnodes.CropAudioPlus",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "CropAudioPlus") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            // Shrink to fit just the widgets (audio input + 2 sliders).
            try {
                const computed = node.computeSize ? node.computeSize() : null;
                if (computed && computed.length >= 2) {
                    const w = Math.max(MIN_NODE_WIDTH, Math.ceil(computed[0]));
                    const h = Math.ceil(computed[1]) + 4;
                    node.size = [w, h];
                }
            } catch (_) { /* ignore */ }

            const onResize = node.onResize;
            node.onResize = function () {
                const out = onResize ? onResize.apply(this, arguments) : undefined;
                if (Array.isArray(node.size) && node.size[0] < MIN_NODE_WIDTH) {
                    node.size[0] = MIN_NODE_WIDTH;
                }
                return out;
            };

            return result;
        };
    },
});

console.log("[FBnodes] CropAudioPlus extension loaded");
