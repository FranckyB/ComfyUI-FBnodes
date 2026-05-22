import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// Displays input text on a node
// TODO: This should need to be so complicated. Refactor at some point.

app.registerExtension({
    name: "FBnodes.ShowTextPlus",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "ShowTextPlus") {
            const DEFAULT_WIDTH = 300;
            const DEFAULT_HEIGHT = 300;

            function populate(text) {
                if (this.widgets) {
                    // On older frontend versions there is a hidden converted-widget
                    const isConvertedWidget = +!!this.inputs?.[0].widget;
                    for (let i = isConvertedWidget; i < this.widgets.length; i++) {
                        this.widgets[i].onRemove?.();
                    }
                    this.widgets.length = isConvertedWidget;
                }

                const values = Array.isArray(text) ? [...text] : [text];
                const rows = values.length ? values : [""];

                for (let list of rows) {
                    // Force list to be an array, not sure why sometimes it is/isn't
                    if (!(list instanceof Array)) list = [list];
                    for (const l of list) {
                        const widgetIndex = this.widgets?.length ?? 0;
                        const widgetName = widgetIndex <= 1 ? "preview_text" : `preview_text_${widgetIndex}`;
                        const w = ComfyWidgets["STRING"](this, widgetName, ["STRING", { multiline: true }], app).widget;
                        w.inputEl.readOnly = true;
                        w.inputEl.style.opacity = 1;
                        w.value = l ?? "";
                    }
                }

                requestAnimationFrame(() => {
                    const sz = this.computeSize();
                    if (sz[0] < this.size[0]) {
                        sz[0] = this.size[0];
                    }
                    if (sz[1] < this.size[1]) {
                        sz[1] = this.size[1];
                    }
                    this.onResize?.(sz);
                    app.graph.setDirtyCanvas(true, false);
                });
            }

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                this.size = this.size || [0, 0];
                this.size[0] = Math.max(this.size[0], DEFAULT_WIDTH);
                this.size[1] = Math.max(this.size[1], DEFAULT_HEIGHT);
                // Ensure the node starts expanded with a visible text area.
                populate.call(this, [""]);
            };

            // When the node is executed we will be sent the input text, display this in the widget
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);
                populate.call(this, message.text);
            };

            const VALUES = Symbol();
            const configure = nodeType.prototype.configure;
            nodeType.prototype.configure = function () {
                // Store unmodified widget values as they get removed on configure by new frontend
                this[VALUES] = arguments[0]?.widgets_values;
                return configure?.apply(this, arguments);
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                const widgets_values = this[VALUES];
                if (widgets_values?.length) {
                    // In newer frontend there seems to be a delay in creating the initial widget
                    requestAnimationFrame(() => {
                        populate.call(this, widgets_values.slice(+(widgets_values.length > 1 && this.inputs?.[0].widget)));
                    });
                }
            };
        }
    },
});
