/**
 * LoRA List+ (FBnodes): an ordered list of LoRA files, each on or off, for
 * testing LoRAs one by one (with an Outputlist Combiner). One fbui card: the
 * list, with Add LoRAs opening the shared file browser on LoRAs. The stock
 * widgets stay hidden: loras_state is the list as JSON, loras_text the paths
 * that are on.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mountCard } from "./fbui/card.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback } from "./fbui/dom.js";
import { confirm } from "./fbui/modal.js";
import { findWidget, hideInputsInDef, hideWidget } from "./fbui/widgets.js";
import { itemList } from "./common/item_list.js";
import { createFileBrowserModal } from "./file_browser.js";
import { basenameOf } from "./path_browser.js";

const NODE_NAME = "LoraListPlus";
const SETTING_CUSTOM_PATH = "FBnodes.LoraListDefaultPath";
const LIST_HEIGHT = 260;

const normalize = (items) => (Array.isArray(items) ? items : [])
    .map((item) => ({ path: String(item?.path || "").trim(), enabled: item?.enabled !== false }))
    .filter((item) => item.path);

function parseState(raw) {
    try {
        return normalize(JSON.parse(raw || "[]"));
    } catch {
        return [];
    }
}

async function folderExists(path) {
    if (!path) return false;
    try {
        const response = await api.fetchApi(`/fbnodes/path-browser/list?${new URLSearchParams({ path, kind: "lora" })}`);
        return response.ok;
    } catch {
        return false;
    }
}

async function lorasRoot() {
    try {
        const response = await api.fetchApi("/fbnodes/lora-browser/root");
        const data = response.ok ? await response.json() : null;
        return data?.ok ? data.root : "";
    } catch {
        return "";
    }
}

// The browser's Custom folder is LoRA List+'s own setting.
const customFolder = {
    get: () => String(app.ui?.settings?.getSettingValue(SETTING_CUSTOM_PATH) || "").trim(),
    set: (path) => app.ui.settings.setSettingValueAsync(SETTING_CUSTOM_PATH, String(path || "").trim()),
    message: "The folder the Custom button opens in LoRA List+ (Settings → FBnodes → LoRA List).",
};
const places = [{ label: "LoRAs", title: "ComfyUI's LoRA folder", path: lorasRoot }];

// Where the browser opens: the node's last folder, else the Custom folder,
// else ComfyUI's first LoRA folder.
async function startFolder(lastPath) {
    for (const path of [lastPath, customFolder.get()]) if (await folderExists(path)) return path;
    return lorasRoot();
}

function setupNode(node) {
    node.properties ??= {};
    const stateWidget = findWidget(node, "loras_state");
    const textWidget = findWidget(node, "loras_text");
    hideWidget(stateWidget);
    hideWidget(textWidget);
    let lastPath = String(node.properties.fb_lora_list?.last_path || "");

    const save = (items) => {
        const compact = items.map((item) => ({ path: item.path, enabled: item.enabled !== false }));
        stateWidget.value = JSON.stringify(compact);
        textWidget.value = compact.filter((item) => item.enabled).map((item) => item.path).join("\n");
        node.properties.fb_lora_list = { items: compact, last_path: lastPath };
    };

    const add = button("Add LoRAs", {
        icon: ICONS.folder, grow: true, title: "Pick LoRA files in the file browser",
        onClick: async () => {
            createFileBrowserModal("", () => {}, "input", {
                initialPath: await startFolder(lastPath),
                navKind: "lora",
                places,
                custom: customFolder,
                allowedTypes: ["other"],
                filterTypeOptions: ["all", "other"],
                defaultFilter: "other",
                multiSelect: true,
                onMultiSelect: (picked) => {
                    const known = new Set(list.entries.map((item) => item.path));
                    for (const { meta } of picked ?? []) {
                        if (meta?.dir) lastPath = meta.dir;
                        if (!meta?.absPath || known.has(meta.absPath)) continue;
                        known.add(meta.absPath);
                        list.entries.push({ path: meta.absPath, enabled: true });
                    }
                    list.changed();
                },
            });
        },
    });
    const clear = button("Clear all", {
        grow: true, title: "Remove every LoRA from the list",
        onClick: async () => {
            if (!list.entries.length || !(await confirm({ title: "Clear all", message: "Remove every LoRA from the list?", confirmText: "Clear all", danger: true }))) return;
            list.entries.length = 0;
            list.changed();
        },
    });
    const list = itemList({
        title: "LoRAs",
        empty: "No LoRAs yet: Add LoRAs to pick some.",
        label: (item) => basenameOf(item.path),
        tooltip: (item) => item.path,
        footer: [add, clear],
        onChange: save,
    });

    mountCard(node, {
        minWidth: 320,
        rows: [{ panel: () => ({ element: list.element }), grow: true, height: LIST_HEIGHT }],
    });

    // The widget holds the list; a workflow from before it did keeps it in
    // the node's properties.
    const restore = () => {
        const items = parseState(stateWidget.value);
        list.set(items.length ? items : normalize(node.properties.fb_lora_list?.items));
        lastPath = String(node.properties.fb_lora_list?.last_path || lastPath);
    };
    chainCallback(node, "onConfigure", restore);
    restore();
}

app.registerExtension({
    name: "FBnodes.LoraListPlus",
    settings: [
        {
            id: SETTING_CUSTOM_PATH,
            category: ["FBnodes", "2. LoRA List", "1. Custom LoRA Path"],
            name: "Custom LoRA List Path",
            tooltip: "Optional folder the LoRA browser opens in. Leave empty to use ComfyUI's LoRA folder.",
            type: "text",
            defaultValue: "",
        },
    ],
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["loras_state", "loras_text"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
