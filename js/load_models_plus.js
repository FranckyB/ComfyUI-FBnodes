/**
 * Load Checkpoint+ / Load Diffusion Model+ / Load LoRA+ (FBnodes): a model
 * list narrowed by a text filter, on one fbui card.
 *
 * The model combo always holds real file paths, so the value is right
 * wherever it goes (a promoted subgraph input, the API prompt); only what is
 * shown is short: the file name without its extension, under its folder
 * (getOptionLabel for ComfyUI's own combos, <optgroup>s on the card).
 */

import { app } from "../../scripts/app.js";
import { mountCard } from "./fbui/card.js";
import { chainCallback } from "./fbui/dom.js";
import { findWidget, hideInputsInDef } from "./fbui/widgets.js";

const MODEL_WIDGETS = { LoadCheckpointPlus: "ckpt_name", LoadDiffusionModelPlus: "unet_name", LoadLoraPlus: "lora_name" };
const MODEL_LABELS = { ckpt_name: "Checkpoint", unet_name: "Model", lora_name: "LoRA" };
const EXTENSION = /\.(safetensors|ckpt|pt|bin|pth|gguf|sft)$/i;
// What earlier versions stored as the value: a display label.
const OLD_HEADER = /^----(.*)----$/;
const OLD_COUNT = /^(.*) \(\d+\)$/;

const parts = (path) => String(path).split(/[\\/]/);
const stem = (path) => parts(path).pop().replace(EXTENSION, "");

// The folder a path sits in, below the folders every model shares.
function folderOf(path, values) {
    const dirs = parts(path).slice(0, -1);
    let shared = 0;
    const others = values.map((value) => parts(value).slice(0, -1));
    while (shared < dirs.length && others.every((other) => other[shared] === dirs[shared])) shared++;
    return dirs.slice(shared).join(" / ");
}

const splitTerms = (raw) => String(raw || "").toLowerCase().replace(/\band\b/g, " ").split(/[\s,]+/).filter(Boolean);

function setupNode(node, name) {
    const filter = findWidget(node, "filter");
    const model = findWidget(node, name);
    const options = model.options;
    let all = [...(Array.isArray(options.values) ? options.values : [])];
    let shown = all;

    // A short name; the folder joins it where two files share one.
    options.getOptionLabel = (value) => {
        if (!value) return value;
        const short = stem(value);
        const twin = shown.some((other) => other !== value && stem(other) === short);
        const folder = twin ? folderOf(value, shown) : "";
        return folder ? `${short} (${folder})` : short;
    };

    // ComfyUI's refresh (R) hands the combo a new full list: keep it as the
    // list to filter.
    let internal = false;
    let values = shown;
    Object.defineProperty(options, "values", {
        get: () => values,
        set(next) {
            values = next;
            if (internal) return;
            all = [...(Array.isArray(next) ? next : [])];
            queueMicrotask(applyFilter);
        },
        enumerable: true,
        configurable: true,
    });

    function applyFilter() {
        const terms = splitTerms(filter.value);
        const matching = terms.length ? all.filter((path) => terms.every((term) => path.toLowerCase().includes(term))) : all;
        shown = matching.length ? matching : all;
        internal = true;
        options.values = shown;
        internal = false;
        // A model the filter hides gives way to the first shown; a missing one
        // stays, so the run (or the remap tool) can name it.
        if (all.includes(model.value) && !shown.includes(model.value)) model.value = shown[0];
        node._fb?.card.refresh();
        node.setDirtyCanvas?.(true, true);
    }

    // An older workflow saved the display label: find its file again.
    function adoptOldValue() {
        const value = model.value;
        if (typeof value !== "string" || !value || all.includes(value)) return;
        const header = OLD_HEADER.exec(value);
        const wanted = (OLD_COUNT.exec(value)?.[1] ?? value).toLowerCase();
        const found = header
            ? all.find((path) => folderOf(path, all).replace(/ \/ /g, " - ") === header[1])
            : all.find((path) => stem(path).toLowerCase() === wanted);
        if (found) model.value = found;
    }

    chainCallback(filter, "callback", applyFilter);
    chainCallback(node, "onConfigure", () => {
        adoptOldValue();
        applyFilter();
    });

    node._fb = {};
    const rows = [
        { widget: "filter", label: "Filter", kind: "text", title: "Show only models whose path holds every word (e.g. sdxl anime)" },
        {
            widget: name, label: MODEL_LABELS[name], kind: "select",
            labels: (value) => options.getOptionLabel(value),
            groups: (value) => folderOf(value, shown) || null,
        },
    ];
    if (name === "lora_name") rows.push({ widget: "strength_model", label: "Strength" });
    node._fb.card = mountCard(node, { minWidth: 280, rows });
    applyFilter();
}

app.registerExtension({
    name: "FBnodes.LoadModelsPlus",
    beforeRegisterNodeDef(nodeType, nodeData) {
        const name = MODEL_WIDGETS[nodeData.name];
        if (!name) return;
        hideInputsInDef(nodeData, ["filter", name, "strength_model"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this, name);
        });
    },
});
