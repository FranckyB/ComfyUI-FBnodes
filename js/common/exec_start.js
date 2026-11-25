// %elapsed% in a save node's filename: the whole seconds from pressing Queue to
// the save. The queue time is stamped into the node's hidden `exec_start`
// input just before the prompt is built; the server's own start event
// arrives too late to be read by the node.
import { app } from "../../../scripts/app.js";

const STAMPED = Symbol.for("fbnodes.execStart");
const NODE_TYPES = new Set(["SaveImagePlus", "SaveVideoPlus"]);

function* allNodes(graph, seen = new Set()) {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? graph.nodes ?? []) {
        yield node;
        if (node.subgraph) yield* allNodes(node.subgraph, seen);
    }
}

export function installExecStart() {
    const original = app.queuePrompt;
    if (typeof original !== "function" || original[STAMPED]) return;
    async function queuePrompt(...args) {
        const now = (Date.now() / 1000).toFixed(3);
        for (const node of allNodes(app.graph)) {
            if (!NODE_TYPES.has(node.type)) continue;
            const widget = node.widgets?.find((item) => item.name === "exec_start");
            if (widget) widget.value = now;
        }
        return original.apply(this, args);
    }
    queuePrompt[STAMPED] = true;
    app.queuePrompt = queuePrompt;
}
