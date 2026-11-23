/**
 * Right-click a core Load Image, Load Video, Save Image or Save Video node
 * for "Replace with …+": the FBnodes node takes its place, with its links
 * and its file (loaders) or a changed filename prefix (savers).
 */

import { app } from "../../scripts/app.js";
import { findWidget } from "./fbui/widgets.js";

// "clip.mp4 [output]": a file picked from another folder.
const ANNOTATED = /^(.*?)\s*\[(input|output)\]$/;

function setValue(node, name, value) {
    const widget = findWidget(node, name);
    if (widget) widget.value = value;
}

function carryFile(old, from, node, to) {
    const value = findWidget(old, from)?.value;
    if (typeof value !== "string" || !value) return;
    const match = ANNOTATED.exec(value);
    setValue(node, "source_folder", match ? match[2] : "input");
    setValue(node, to, match ? match[1] : value);
}

// A prefix left at the core default gives way to ours (dated folders).
function carryPrefix(coreDefault) {
    return (old, node) => {
        const prefix = findWidget(old, "filename_prefix")?.value;
        if (typeof prefix === "string" && prefix && prefix !== coreDefault) setValue(node, "filename_prefix", prefix);
    };
}

const REPLACEMENTS = {
    LoadImage: { type: "LoadImagePlus", title: "Load Image+", carry: (old, node) => carryFile(old, "image", node, "image") },
    LoadVideo: { type: "LoadVideoPlus", title: "Load Video+", carry: (old, node) => carryFile(old, "file", node, "video") },
    SaveImage: { type: "SaveImagePlus", title: "Save Image+", carry: carryPrefix("ComfyUI") },
    SaveVideo: { type: "SaveVideoPlus", title: "Save Video+", carry: carryPrefix("video/ComfyUI") },
};

function replace(old, { type, carry }) {
    const graph = old.graph;
    const node = globalThis.LiteGraph.createNode(type);
    node.pos = [old.pos[0], old.pos[1]];
    graph.add(node);
    // Before the node's first refresh (a microtask) shows the default file.
    carry(old, node);

    // Links in, by input name.
    for (const input of old.inputs ?? []) {
        const link = graph.getLink(input.link);
        const slot = link ? node.findInputSlot(input.name) : -1;
        if (slot >= 0) graph.getNodeById(link.origin_id)?.connect(link.origin_slot, node, slot);
    }
    // Links out: to the new node's output of the same type, in the same order.
    old.outputs?.forEach((output, index) => {
        const nth = old.outputs.slice(0, index).filter((other) => other.type === output.type).length;
        const slot = (node.outputs ?? []).map((other, i) => (other.type === output.type ? i : -1)).filter((i) => i >= 0)[nth];
        if (slot === undefined) return;
        for (const id of [...(output.links ?? [])]) {
            const link = graph.getLink(id);
            const target = link && graph.getNodeById(link.target_id);
            if (target) node.connect(slot, target, link.target_slot);
        }
    });
    graph.remove(old);
    graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "FBnodes.ReplaceWithPlus",
    getNodeMenuItems(node) {
        const target = REPLACEMENTS[node.constructor?.comfyClass];
        if (!target) return [];
        return [{ content: `Replace with ${target.title}`, callback: () => replace(node, target) }];
    },
});
