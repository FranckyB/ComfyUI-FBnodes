import { app } from "../../scripts/app.js";

const TARGET_NODE_NAMES = new Set(["LoadCheckpointPlus", "LoadDiffusionModelPlus", "LoadLoraPlus"]);

function getSchemaModelWidgetInfo(nodeData) {
    const required = nodeData?.input?.required || {};
    if (Array.isArray(required?.ckpt_name?.[0])) {
        return { widgetName: "ckpt_name", values: [...required.ckpt_name[0]] };
    }
    if (Array.isArray(required?.unet_name?.[0])) {
        return { widgetName: "unet_name", values: [...required.unet_name[0]] };
    }
    if (Array.isArray(required?.lora_name?.[0])) {
        return { widgetName: "lora_name", values: [...required.lora_name[0]] };
    }
    return { widgetName: null, values: [] };
}

app.registerExtension({
    name: "FBnodes.LoadModelsPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!TARGET_NODE_NAMES.has(nodeData?.name)) return;

        const schemaInfo = getSchemaModelWidgetInfo(nodeData);

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            const filterWidget = this.widgets?.find((w) => w?.name === "filter");
            const modelWidget = this.widgets?.find((w) => w?.name === schemaInfo.widgetName)
                || this.widgets?.find((w) => w?.name === "ckpt_name")
                || this.widgets?.find((w) => w?.name === "unet_name")
                || this.widgets?.find((w) => w?.name === "lora_name");

            if (!filterWidget || !modelWidget) return r;

            modelWidget.options = modelWidget.options || {};
            const runtimeValues = Array.isArray(modelWidget.options.values) ? modelWidget.options.values : [];
            const sourceValues = schemaInfo.values.length > 0 ? schemaInfo.values : runtimeValues;
            modelWidget.options.values_original = [...sourceValues];
            modelWidget.options.values = [...sourceValues];

            const modelPaths = new Map();
            const displayToActual = new Map();
            const headerToFirstDisplay = new Map();

            const isHeader = (value) => typeof value === "string" && value.startsWith("----") && value.endsWith("----");
            const stripKnownExtension = (name) => name.replace(/\.(safetensors|ckpt|pt|bin|pth)$/i, "");

            const splitTerms = (raw) => (raw || "")
                .toLowerCase()
                .replace(/\band\b/g, " ")
                .split(/[\s,]+/)
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length > 0);

            const pickFirstModelValue = (values) => {
                for (const value of values) {
                    if (!isHeader(value)) {
                        return value;
                    }
                }
                return values.length > 0 ? values[0] : null;
            };

            const buildGroupedDisplay = (actualPaths) => {
                const outputValues = [];
                const usedDisplay = new Set();

                if (actualPaths.length === 0) {
                    return outputValues;
                }

                let stripLevel = 0;
                const maxDepth = Math.max(...actualPaths.map((p) => p.split(/[\\/]/).length));
                for (let level = 0; level < maxDepth; level++) {
                    const levelOptions = new Set();
                    actualPaths.forEach((modelName) => {
                        const parts = modelName.split(/[\\/]/);
                        if (level < parts.length) {
                            levelOptions.add(parts[level]);
                        }
                    });
                    if (levelOptions.size > 1) {
                        stripLevel = level;
                        break;
                    }
                }

                const sectionOrder = [];
                const sectionItems = new Map();
                const sectionLocalCounts = new Map();

                actualPaths.forEach((actualPath) => {
                    const parts = actualPath.split(/[\\/]/);
                    const relParts = parts.slice(stripLevel);
                    const section = relParts.length > 1 ? relParts[0] : "Other";
                    const fileName = relParts[relParts.length - 1] || actualPath;
                    const baseLabel = stripKnownExtension(fileName);

                    if (!sectionItems.has(section)) {
                        sectionItems.set(section, []);
                        sectionOrder.push(section);
                        sectionLocalCounts.set(section, new Map());
                    }

                    const localCounts = sectionLocalCounts.get(section);
                    const count = (localCounts.get(baseLabel) || 0) + 1;
                    localCounts.set(baseLabel, count);

                    let display = count > 1 ? `${baseLabel} (${count})` : baseLabel;
                    while (usedDisplay.has(display) || isHeader(display)) {
                        const bumped = (localCounts.get(baseLabel) || count) + 1;
                        localCounts.set(baseLabel, bumped);
                        display = `${baseLabel} (${bumped})`;
                    }

                    usedDisplay.add(display);
                    sectionItems.get(section).push({ display, actualPath });
                });

                // If the filtered result only maps to one section, show a plain list
                // (no section header like ----Other----).
                if (sectionOrder.length === 1) {
                    const onlyItems = sectionItems.get(sectionOrder[0]) || [];
                    return onlyItems.map((item) => item.display);
                }

                sectionOrder.forEach((section) => {
                    const items = sectionItems.get(section) || [];
                    if (items.length === 0) return;

                    const header = `----${section}----`;
                    outputValues.push(header);
                    displayToActual.set(header, items[0].actualPath);
                    headerToFirstDisplay.set(header, items[0].display);

                    items.forEach((item) => {
                        outputValues.push(item.display);
                        displayToActual.set(item.display, item.actualPath);
                    });
                });

                return outputValues;
            };

            modelWidget.options.values_original.forEach((name) => {
                modelPaths.set(name, name);
            });

            const updateFilteredModels = () => {
                const currentValue = modelWidget.value;
                const currentActual = displayToActual.get(currentValue) || currentValue;
                displayToActual.clear();
                headerToFirstDisplay.clear();

                const terms = splitTerms(filterWidget.value || "");
                const originalValues = modelWidget.options.values_original || [];
                const filtered = terms.length === 0
                    ? [...originalValues]
                    : originalValues.filter((modelName) => {
                        const pathValue = (modelPaths.get(modelName) || "").toLowerCase();
                        const nameValue = modelName.toLowerCase();
                        return terms.every((term) => pathValue.includes(term) || nameValue.includes(term));
                    });

                const groupedValues = buildGroupedDisplay(filtered);
                const fallbackValues = buildGroupedDisplay(originalValues);
                modelWidget.options.values = groupedValues.length > 0 ? groupedValues : fallbackValues;

                let resolvedDisplay = null;
                for (const displayName of modelWidget.options.values) {
                    if (isHeader(displayName)) {
                        continue;
                    }
                    if (displayToActual.get(displayName) === currentActual) {
                        resolvedDisplay = displayName;
                        break;
                    }
                }

                if (resolvedDisplay !== null) {
                    modelWidget.value = resolvedDisplay;
                } else if (!modelWidget.options.values.includes(modelWidget.value)) {
                    const firstModel = pickFirstModelValue(modelWidget.options.values);
                    if (firstModel) {
                        modelWidget.value = firstModel;
                    }
                }

                if (this.canvas) {
                    this.setDirtyCanvas(true, true);
                }
            };

            this._fbRefreshModelFilter = updateFilteredModels;
            updateFilteredModels();

            const oldFilterCallback = filterWidget.callback;
            filterWidget.callback = function (value) {
                if (oldFilterCallback) {
                    oldFilterCallback.call(this, value);
                }
                updateFilteredModels();
            };

            const oldModelCallback = modelWidget.callback;
            modelWidget.callback = function (value) {
                if (isHeader(value)) {
                    const firstDisplay = headerToFirstDisplay.get(value);
                    if (firstDisplay) {
                        modelWidget.value = firstDisplay;
                        if (oldModelCallback) {
                            oldModelCallback.call(this, firstDisplay);
                        }
                        return;
                    }
                }

                modelWidget.value = value;
                if (oldModelCallback) {
                    oldModelCallback.call(this, value);
                }
            };

            modelWidget.serializeValue = () => displayToActual.get(modelWidget.value) || modelWidget.value;

            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            if (typeof this._fbRefreshModelFilter === "function") {
                this._fbRefreshModelFilter();
            }
            return r;
        };
    },
});
