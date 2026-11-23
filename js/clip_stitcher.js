/**
 * Clip Stitcher (FBnodes): a list of clips joined into one video, cut or
 * cross-dissolved. One fbui card: the clip list, then the clip and blend
 * lengths. The stock widgets stay hidden and hold the values; clip_list is
 * the list as JSON.
 */

import { app } from "../../scripts/app.js";
import { mountCard } from "./fbui/card.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback } from "./fbui/dom.js";
import { confirm } from "./fbui/modal.js";
import { findWidget, hideInputsInDef, hideWidget } from "./fbui/widgets.js";
import { itemList } from "./common/item_list.js";
import { clipLabel, clipPreview, clipTooltip, parseClips, pickClips } from "./common/clips.js";

const NODE_NAME = "ClipStitcher";
const LIST_HEIGHT = 240;
// Earlier versions kept the lengths in properties too, against values that
// shifted in old workflows; those win when present.
const LENGTH_PROPERTIES = { clip_duration: "_clipStitcherClipDuration", blend_duration: "_clipStitcherBlendDuration" };

function setupNode(node) {
    node.properties ??= {};
    const listWidget = findWidget(node, "clip_list");
    hideWidget(listWidget);
    hideWidget(findWidget(node, "source_folder"));
    const save = (entries) => {
        listWidget.value = JSON.stringify(entries);
    };
    // A new node browses the output folder, where generated clips land.
    if (!node.properties._browsePath) findWidget(node, "source_folder").value = "output";

    const add = button("Add clips", {
        icon: ICONS.folder, grow: true, title: "Pick clips in the file browser",
        onClick: () => pickClips(node, list.entries, (added) => {
            list.entries.push(...added);
            list.changed();
        }),
    });
    const clear = button("Clear all", {
        grow: true, title: "Remove every clip from the list",
        onClick: async () => {
            if (!list.entries.length || !(await confirm({ title: "Clear all", message: "Remove every clip from the list?", confirmText: "Clear all", danger: true }))) return;
            list.set([]);
            save([]);
        },
    });
    const list = itemList({
        title: "Clips",
        empty: "No clips yet: Add clips to pick some.",
        label: clipLabel,
        tooltip: clipTooltip,
        preview: clipPreview,
        footer: [add, clear],
        onChange: save,
    });

    mountCard(node, {
        minWidth: 320,
        rows: [
            { panel: () => ({ element: list.element }), grow: true, height: LIST_HEIGHT },
            { pair: ["clip_duration", "blend_duration"], label: "Length", prefixes: ["Clip", "Blend"], suffix: "s", title: "Clip: each clip's length (0 = the whole clip). Blend: the cross-dissolve between clips (0 = a cut)." },
        ],
    });

    for (const [name, key] of Object.entries(LENGTH_PROPERTIES)) {
        chainCallback(findWidget(node, name), "callback", (value) => {
            node.properties[key] = value;
        });
    }
    chainCallback(node, "onConfigure", () => {
        for (const [name, key] of Object.entries(LENGTH_PROPERTIES)) {
            const stored = node.properties[key];
            if (stored !== undefined && stored !== null) findWidget(node, name).value = stored;
        }
        list.set(parseClips(listWidget.value));
    });
    list.set(parseClips(listWidget.value));
}

app.registerExtension({
    name: "FBnodes.ClipStitcher",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["source_folder", "clip_list", "clip_duration", "blend_duration"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
