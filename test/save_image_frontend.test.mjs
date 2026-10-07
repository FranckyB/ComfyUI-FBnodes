import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

function setup() {
    let extension;
    const context = vm.createContext({
        app: { registerExtension(value) { extension = value; } },
        api: { addEventListener() {} },
        window: { addEventListener() {} },
        LiteGraph: { NODE_WIDGET_HEIGHT: 24, NODE_TITLE_HEIGHT: 24 },
    });
    const source = fs.readFileSync(new URL("../js/save_image_plus.js", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source, context);
    class SaveImageNode {
        constructor() {
            this.properties = {};
            this.size = [320, 500];
            this.widgets = [
                { name: "filename_prefix", value: "old-prefix" },
                { name: "save", value: false },
                { name: "format", value: "png" },
                { name: "bit_depth", value: "8-bit", options: {} },
                { name: "input_color_space", value: "sRGB", options: {} },
                { name: "crf", value: 18 },
            ];
        }
        addWidget(type, name, value, callback, options) {
            const widget = { type, name, value, callback, options };
            this.widgets.push(widget);
            return widget;
        }
        setSize(size) { this.size = size; }
        setDirtyCanvas() {}
    }
    extension.beforeRegisterNodeDef(SaveImageNode, { name: "SaveImagePlus" });
    const node = new SaveImageNode();
    node.onNodeCreated();
    context.node = node;
    return { node, context };
}

test("Controls is last, UI-only, collapsed by default, and retains old widget values", () => {
    const { node } = setup();
    const toggle = node.widgets.at(-1);
    assert.equal(toggle.name, "__fb_save_image_controls_toggle");
    assert.equal(toggle.serialize, false);
    assert.equal(toggle.options.serialize, false);
    assert.equal(toggle.label, "\u25B6 Controls");
    assert(node.widgets.slice(0, -1).every(widget => widget.hidden));
    assert.deepEqual(node.widgets.filter(widget => widget.serialize !== false).map(widget => widget.value),
        ["old-prefix", false, "png", "8-bit", "sRGB", 18]);
});

test("expanding and collapsing preserve preview height and restore widget sizing", () => {
    const { node } = setup();
    const collapsedHeight = node.size[1];
    const toggle = node.widgets.at(-1);
    toggle.callback();
    assert.equal(toggle.label, "\u25B2 Controls");
    assert.equal(node.size[1], collapsedHeight + 5 * 28);
    assert(node.widgets.slice(0, 5).every(widget => !widget.hidden));
    assert.equal(node.widgets[5].hidden, true);
    assert.equal(node.widgets[0].computeSize, undefined);
    assert.equal(toggle.name, "__fb_save_image_controls_toggle");
    toggle.callback();
    assert.equal(toggle.label, "\u25B6 Controls");
    assert.equal(node.size[1], collapsedHeight);
});

test("format changes select valid depths/colors and show CRF only for AVIF", () => {
    const { node } = setup();
    node.widgets.at(-1).callback();
    const format = node.widgets[2];
    format.value = "exr";
    format.callback();
    assert.equal(node.widgets[3].value, "16-bit float");
    assert.deepEqual([...node.widgets[3].options.values], ["16-bit float", "32-bit float"]);
    node.widgets[4].value = "linear";
    format.value = "avif";
    format.callback();
    assert.equal(node.widgets[3].value, "auto");
    assert.equal(node.widgets[4].value, "sRGB");
    assert.equal(node.widgets[5].hidden, false);
    format.value = "png";
    format.callback();
    assert.equal(node.widgets[3].value, "8-bit");
    assert.deepEqual([...node.widgets[4].options.values], ["sRGB"]);
    assert.equal(node.widgets[5].hidden, true);
});

test("configure restores expansion and settings without adding a second toggle or resizing", () => {
    const { node } = setup();
    node.properties._saveImageControlsExpanded = true;
    node.widgets[2].value = "exr";
    node.widgets[3].value = "32-bit float";
    node.widgets[4].value = "linear";
    node.size = [500, 900];
    node.onConfigure();
    node.onConfigure();
    assert.equal(node.widgets.length, 7);
    assert.equal(node.widgets.at(-1).label, "\u25B2 Controls");
    assert.deepEqual(node.size, [500, 900]);
    assert.equal(node.widgets[3].value, "32-bit float");
    assert.equal(node.widgets[4].value, "linear");
    assert.equal(node.widgets[0].hidden, false);
});

test("preview URLs use the temp descriptor without losing the original filename", () => {
    const { context } = setup();
    context.imageInfo = { filename: "saved.exr", type: "output", subfolder: "Pics", preview: {
        filename: "preview image.png", type: "temp", subfolder: "",
    } };
    assert.equal(vm.runInContext("imageInfoToUrl(imageInfo)", context),
        "/view?filename=preview%20image.png&type=temp");
    assert.equal(context.imageInfo.filename, "saved.exr");
    delete context.imageInfo.preview;
    assert.equal(vm.runInContext("imageInfoToUrl(imageInfo)", context),
        "/view?filename=saved.exr&type=output&subfolder=Pics");
});