/**
 * SwitchAny Extension for ComfyUI
 * - Parses the "names" widget (comma/semicolon separated) to populate the "select" dropdown
 * - Shows/hides input slots based on "num_inputs" slider
 * - Strips non-selected inputs from the execution payload so upstream nodes are never evaluated
 */

import { app } from "../../scripts/app.js";

const MAX_INPUTS = 10;

/**
 * Parse a names string the same way Python does.
 */
function parseNames(namesStr, count) {
    const parts = namesStr.split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push(i < parts.length ? parts[i] : `Input ${i + 1}`);
    }
    return result;
}

app.registerExtension({
    name: "SwitchAny",

    setup() {
        // Strip non-selected inputs from execution payload so ComfyUI never
        // validates or executes upstream nodes that aren't the active selection.
        const originalGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function (...args) {
            const result = await originalGraphToPrompt.apply(this, args);
            if (result?.output) {
                for (const nodeData of Object.values(result.output)) {
                    if (nodeData.class_type !== "SwitchAny") continue;

                    const selected = nodeData.inputs.select;
                    const numInputs = nodeData.inputs.num_inputs ?? 2;
                    const namesStr = nodeData.inputs.names ?? "";
                    const names = parseNames(namesStr, numInputs);

                    let selectedIndex = -1;
                    for (let i = 0; i < names.length; i++) {
                        if (names[i] === selected) {
                            selectedIndex = i + 1;
                            break;
                        }
                    }
                    // Remove every input_* except the selected one
                    for (let i = 1; i <= MAX_INPUTS; i++) {
                        if (i !== selectedIndex) {
                            delete nodeData.inputs[`input_${i}`];
                        }
                    }
                }
            }
            return result;
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "SwitchAny") return;

        // Synchronous relabel: populate the select dropdown from `names` and set each input slot's label + visibility.
        // that keeps ComfyUI's native link handling and subgraph widget connection intact.
        function refreshSwitchAny(node) {
            const selectWidget = node.widgets?.find(w => w.name === "select");
            const numWidget = node.widgets?.find(w => w.name === "num_inputs");
            const namesWidget = node.widgets?.find(w => w.name === "names");
            if (!numWidget || !namesWidget) return;

            const count = Math.max(1, Math.min(MAX_INPUTS, numWidget.value ?? 2));
            const names = parseNames(namesWidget.value || "", count);

            // Populate the dropdown choices, preserving the current selection.
            // Skip entirely if `select` was converted to an input socket.
            if (selectWidget && selectWidget.options) {
                const prev = selectWidget.value;
                selectWidget.options.values = names;
                if (!names.includes(prev)) {
                    selectWidget.value = names[0];
                }
            }

            // Relabel + show/hide the dynamic input slots in place (no destruction).
            if (node.inputs) {
                for (let i = 0; i < MAX_INPUTS; i++) {
                    const slot = node.inputs.find(inp => inp.name === `input_${i + 1}`);
                    if (!slot) continue;
                    slot.label = i < count ? names[i] : `input_${i + 1}`;
                    slot.hidden = i >= count;
                }
            }

            node.setDirtyCanvas(true, true);
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.setSize([260, node.size[1]]);
            node._refreshSwitchAny = () => refreshSwitchAny(node);

            const numWidget = node.widgets.find(w => w.name === "num_inputs");
            const namesWidget = node.widgets.find(w => w.name === "names");

            // Hook callbacks (fire on user edits).
            const origNum = numWidget?.callback;
            if (numWidget) {
                numWidget.callback = function (value) {
                    if (origNum) origNum.apply(this, arguments);
                    refreshSwitchAny(node);
                };
            }
            const origNames = namesWidget?.callback;
            if (namesWidget) {
                namesWidget.callback = function (value) {
                    if (origNames) origNames.apply(this, arguments);
                    refreshSwitchAny(node);
                };
            }

            // Only refresh live when NOT restoring from a workflow - onConfigure
            // handles restoration synchronously.
            if (!node._configuredFromWorkflow) {
                refreshSwitchAny(node);
            }

            return result;
        };

        // Refresh names every time the node is executed.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (data) {
            const result = onExecuted?.apply(this, arguments);
            if (this._refreshSwitchAny) this._refreshSwitchAny();
            return result;
        };

        // Restore state on workflow load / page reload / tab switch. Synchronous -
        // no setTimeout - so labels are re-applied before the node renders (this is
        // what fixes subgraphs, where slots are rebuilt from the Python definition).
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            this._configuredFromWorkflow = true;
            const result = onConfigure?.apply(this, arguments);

            // Re-apply labels/visibility synchronously from the saved widget values.
            refreshSwitchAny(this);

            // Restore the saved select value if it's still a widget.
            const selectWidget = this.widgets?.find(w => w.name === "select");
            if (selectWidget && info.widgets_values) {
                const idx = this.widgets.indexOf(selectWidget);
                const saved = info.widgets_values[idx];
                if (saved && selectWidget.options?.values?.includes(saved)) {
                    selectWidget.value = saved;
                }
            }

            this.setDirtyCanvas(true, true);
            return result;
        };
    }
});
