import { app } from "../../scripts/app.js";

function applyJpgQualityVisibility(node) {
    const formatWidget = node.widgets?.find((w) => w?.name === "format");
    const qualityWidget = node.widgets?.find((w) => w?.name === "jpg_quality");
    if (!formatWidget || !qualityWidget) {
        return;
    }

    qualityWidget.hidden = String(formatWidget.value || "").toLowerCase() !== "jpg";
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "FBnodes.SaveImagePlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "SaveImagePlus") {
            return;
        }

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);

            const formatWidget = this.widgets?.find((w) => w?.name === "format");
            if (formatWidget && !formatWidget._fbnodesSaveImagePlusWrapped) {
                const originalCallback = formatWidget.callback;
                formatWidget.callback = function (value) {
                    originalCallback?.apply(this, arguments);
                    applyJpgQualityVisibility(this.node);
                };
                formatWidget._fbnodesSaveImagePlusWrapped = true;
            }

            applyJpgQualityVisibility(this);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalOnConfigure?.apply(this, arguments);
            applyJpgQualityVisibility(this);
            return result;
        };
    },
});
