/**
 * VACE Stitcher (FBnodes): the clips to join, with VACE-generated
 * transitions between them. One fbui card: the clip list (a dot marks a clip
 * with a lossless .latent beside it), a status line when clips need resizing
 * or are missing, and the transition cache buttons. The stock widgets
 * (source_folder, clip_list) stay hidden; clip_list is the list as JSON.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mountCard } from "./fbui/card.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { confirm } from "./fbui/modal.js";
import { T } from "./fbui/theme.js";
import { findWidget, hideInputsInDef, hideWidget } from "./fbui/widgets.js";
import { itemList } from "./common/item_list.js";
import { clipLabel, clipPreview, clipTooltip, parseClips, pickClips } from "./common/clips.js";

const NODE_NAME = "VACEStitcher";
const LIST_HEIGHT = 240;

async function postJson(route, body) {
    const response = await api.fetchApi(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
}

async function transitionCount() {
    try {
        const info = await (await api.fetchApi("/fbnodes/vace-transitions-info")).json();
        return info.exists ? Number(info.total_files) || 0 : 0;
    } catch {
        return 0;
    }
}

const deleteTransitions = () => api.fetchApi("/fbnodes/vace-delete-transitions", { method: "POST" });

// What the clips need before a run: missing ones, mixed sizes, or a resize
// to multiples of 32. [kind, text], or null when all is well.
function describeStatus(data) {
    if (Number(data?.missing_count) > 0) return ["error", `Missing or unreadable clips: ${data.missing_count}. Check their paths before running.`];
    if (data?.has_size_mismatch) return ["error", "Size mismatch: every clip must come to the same size."];
    const changed = Number(data?.changed_count) || 0;
    if (!changed) return null;
    const details = (Array.isArray(data?.details) ? data.details : []).filter((detail) => detail?.changed);
    let sizes = "";
    if (details.length) {
        const first = details[0];
        const same = details.every((detail) => detail.width === first.width && detail.height === first.height);
        sizes = `\n${same ? `${first.width}×${first.height}` : "Mixed sizes"} → ${first.normalized_width}×${first.normalized_height}`;
    }
    return ["warn", `${changed} of ${data.total} clips will be resized for VACE (width and height divisible by 32).${sizes}`];
}

function setupNode(node) {
    node.properties ??= {};
    const listWidget = findWidget(node, "clip_list");
    const sourceWidget = findWidget(node, "source_folder");
    hideWidget(listWidget);
    hideWidget(sourceWidget);
    const latents = new Set(); // clips with a .latent beside them
    const stills = new Set(); // clips previewed by their first frame

    let checkToken = 0;
    async function checkClips() {
        const token = ++checkToken;
        const entries = list.entries;
        const source = sourceWidget?.value || "input";
        try {
            const found = await postJson("/fbnodes/vace-check-latents", { source, files: entries.map((entry) => entry.file) });
            if (token !== checkToken) return;
            latents.clear();
            for (const file of found.has_latent ?? []) latents.add(file);
            list.refresh();
        } catch {
            // No dots; the run still finds the latents itself.
        }
        if (!entries.some((entry) => entry.enabled !== false)) return list.status("", "");
        try {
            const data = await postJson("/fbnodes/vace-clip-status", { entries, source });
            if (token !== checkToken) return;
            const status = describeStatus(data);
            list.status(status?.[0] ?? "", status?.[1] ?? "");
        } catch {
            if (token === checkToken) list.status("error", "Could not check the clips' sizes.");
        }
    }

    const save = (entries) => {
        listWidget.value = JSON.stringify(entries);
        checkClips();
    };

    const add = button("Add clips", {
        icon: ICONS.folder, grow: true, title: "Pick clips in the file browser",
        onClick: () => pickClips(node, list.entries, (added) => {
            list.entries.push(...added);
            list.changed();
        }),
    });
    const removeTransitions = button("Delete transitions", {
        grow: true,
        onClick: async () => {
            const count = await transitionCount();
            if (!count || !(await confirm({ title: "Delete transitions", message: `Delete ${count} cached transition file(s)? They are made again on the next run.`, confirmText: "Delete", danger: true }))) return updateTransitions();
            await deleteTransitions();
            updateTransitions();
        },
    });
    const clear = button("Clear all", {
        grow: true, title: "Remove every clip and delete the cached transitions",
        onClick: async () => {
            if (!(await confirm({ title: "Clear all", message: "Remove every clip from the list and delete the cached transitions?", confirmText: "Clear all", danger: true }))) return;
            list.entries.length = 0;
            list.changed();
            await deleteTransitions();
            updateTransitions();
        },
    });

    async function updateTransitions() {
        const count = await transitionCount();
        removeTransitions.disabled = count === 0;
        removeTransitions.title = count ? `${count} cached transition(s)` : "No cached transitions";
    }

    const list = itemList({
        title: "Clips",
        empty: "No clips yet: Add clips to pick some.",
        label: clipLabel,
        tooltip: clipTooltip,
        preview: (entry) => {
            const preview = clipPreview(entry);
            return stills.has(entry.file) ? { url: preview.still } : preview;
        },
        extra: (entry) => {
            if (!latents.has(entry.file)) return null;
            const dot = el("span");
            dot.style.cssText = `flex:none;width:8px;height:8px;margin:0 4px;border-radius:50%;background:${T.latent}`;
            dot.title = "A lossless .latent file sits beside this clip";
            return dot;
        },
        menu: (entry, index) => [
            { label: "Duplicate", action: () => {
                list.entries.splice(index + 1, 0, { ...entry });
                list.changed();
            } },
            { label: entry.enabled === false ? "Turn on" : "Turn off", action: () => {
                entry.enabled = entry.enabled === false;
                list.changed();
            } },
            { label: stills.has(entry.file) ? "Preview the video" : "Preview the first frame", action: () => {
                if (!stills.delete(entry.file)) stills.add(entry.file);
            } },
            { label: "Regenerate transitions", action: () => removeTransitions.click() },
            { label: "Remove", danger: true, action: () => {
                list.entries.splice(index, 1);
                list.changed();
            } },
        ],
        footer: [add, removeTransitions, clear],
        onChange: save,
    });

    mountCard(node, {
        minWidth: 360,
        rows: [{ panel: () => ({ element: list.element }), grow: true, height: LIST_HEIGHT }],
    });

    chainCallback(node, "onConfigure", () => {
        list.set(parseClips(listWidget.value));
        checkClips();
    });
    // A run makes transitions.
    api.addEventListener("executed", (event) => {
        if (String(event.detail?.node) === String(node.id)) updateTransitions();
    });
    api.addEventListener("execution_success", updateTransitions);
    list.set(parseClips(listWidget.value));
    updateTransitions();
}

app.registerExtension({
    name: "FBnodes.VACEStitcher",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["source_folder", "clip_list"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
