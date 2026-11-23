/**
 * Show as Text (FBnodes): whatever comes in, as text, kept with the workflow
 * (and with the workflow saved in an output file). One fbui card: the texts
 * in a read-only frame, each selectable, with a button that copies them.
 *
 * The texts live in a hidden widget, saved as [[text, ...]]: the shape the
 * backend writes into the workflow it embeds in outputs. Older workflows
 * saved one widget per text, ["text", ...]; both load.
 */

import { app } from "../../scripts/app.js";
import { mountCard } from "./fbui/card.js";
import { toast } from "./fbui/comfy.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { FONT, MONO, RADIUS, T } from "./fbui/theme.js";
import { findWidget, hideWidget } from "./fbui/widgets.js";

const NODE_NAME = "ShowTextPlus";
const TEXT_WIDGET = "preview_text";
const CSS_ID = "fbnodes-show-text-css-v2";

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-text{position:relative;height:100%;box-sizing:border-box;display:flex;flex-direction:column;padding:4px 10px;overflow-y:auto;border:1px solid ${T.plateEdge};border-radius:${RADIUS}px;background:${T.card};pointer-events:auto}
.fbnodes-text pre{margin:0;padding:6px 0;color:${T.ink};font:12px/1.45 ${MONO};white-space:pre-wrap;word-break:break-word;user-select:text;cursor:text}
.fbnodes-text pre+pre{border-top:1px solid ${T.rule}}
.fbnodes-text .empty{margin:auto;color:${T.faint};font:11px ${FONT}}
.fbnodes-text .fbui-stage-tools{position:sticky;top:0;align-self:flex-end;margin-bottom:-28px}
`;
    document.head.append(style);
}

const texts = (node) => {
    const value = findWidget(node, TEXT_WIDGET)?.value;
    return Array.isArray(value) ? value : [];
};

function textPanel(node) {
    ensureCss();
    const panel = el("div", "fbnodes-text");
    const tools = el("div", "fbui-stage-tools");
    const copy = button("Copy", {
        small: true, title: "Copy the text",
        onClick: () => navigator.clipboard?.writeText(texts(node).join("\n\n")).then(() => toast("Text copied.")),
    });
    tools.append(copy);
    // Selecting text must not drag the node.
    panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    return {
        element: panel,
        sync() {
            const shown = texts(node).filter((text) => text !== "");
            copy.hidden = !shown.length;
            panel.replaceChildren(tools, ...(shown.length ? shown.map((text) => el("pre", "", text)) : [el("div", "empty", "Run the workflow to see the text")]));
        },
    };
}

function setTexts(node, values) {
    findWidget(node, TEXT_WIDGET).value = (Array.isArray(values) ? values : [values]).flat().map((value) => String(value ?? ""));
    node._fb.card.refresh();
}

app.registerExtension({
    name: "FBnodes.ShowTextPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            const widget = this.addWidget("text", TEXT_WIDGET, [], null, { serialize: true });
            widget.serialize = true;
            hideWidget(widget);
            this._fb = {};
            this._fb.card = mountCard(this, { minWidth: 260, rows: [{ panel: textPanel, grow: true, height: 160 }] });
        });
        chainCallback(nodeType.prototype, "onExecuted", function (message) {
            setTexts(this, message?.text ?? []);
        });
        // The saved texts, whichever shape they were saved in.
        chainCallback(nodeType.prototype, "onConfigure", function (info) {
            const saved = info?.widgets_values ?? [];
            setTexts(this, Array.isArray(saved[0]) ? saved[0] : saved.filter((value) => typeof value === "string"));
        });
    },
});
