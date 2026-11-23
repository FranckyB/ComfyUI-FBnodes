/**
 * Get Video Components+ (FBnodes) decodes only the outputs that are linked.
 * The hidden outputs_used input names them, so linking one later is a
 * changed input and the node runs again instead of reusing a cached result
 * without that output.
 */

import { app } from "../../scripts/app.js";
import { chainCallback } from "./fbui/dom.js";
import { findWidget, hideInputsInDef, hideWidget } from "./fbui/widgets.js";

const NODE_NAME = "GetVideoComponentsPlus";
// Output slot -> name, for the outputs that cost a decode.
const DECODED = [[0, "images"], [1, "audio"], [4, "latent"]];

function stampOutputs(node) {
    const widget = findWidget(node, "outputs_used");
    if (!widget) return;
    const used = DECODED.filter(([slot]) => node.outputs?.[slot]?.links?.length).map(([, name]) => name);
    widget.value = used.join(",") || "none";
}

app.registerExtension({
    name: "FBnodes.GetVideoComponentsPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["outputs_used"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            hideWidget(findWidget(this, "outputs_used"));
            stampOutputs(this);
        });
        chainCallback(nodeType.prototype, "onConnectionsChange", function () {
            stampOutputs(this);
        });
        chainCallback(nodeType.prototype, "onConfigure", function () {
            stampOutputs(this);
        });
    },
});
