// Clips for the Stitcher lists: picking them in the file browser, their names
// and the preview shown while the pointer rests on one.
import { api } from "../../../scripts/api.js";
import { createFileBrowserModal } from "../file_browser.js";
import { basenameOf, classifySelection, getMediaRoots, isAbsolutePath, previewUrl } from "../path_browser.js";
import { findWidget } from "../fbui/widgets.js";

// The saved list (the node's clip_list widget): [{ file, source, enabled }].
export function parseClips(raw) {
    try {
        const entries = JSON.parse(raw || "[]");
        return Array.isArray(entries) ? entries.filter((entry) => typeof entry?.file === "string" && entry.file) : [];
    } catch {
        return [];
    }
}

export const clipLabel = (entry) => basenameOf(entry.file);
export const clipTooltip = (entry) => `[${entry.source || "input"}] ${entry.file}`;

export function clipPreview(entry) {
    const source = entry.source || "input";
    return {
        url: previewUrl(entry.file, source),
        video: true,
        still: api.apiURL(`/fbnodes/video-frame?${new URLSearchParams({ filename: entry.file, source, position: "0" })}`),
    };
}

// Several clips at once; the browser opens where the last clip came from.
export async function pickClips(node, entries, onAdd) {
    const source = findWidget(node, "source_folder")?.value || "input";
    const roots = await getMediaRoots();
    const last = entries[entries.length - 1]?.file || "";
    const initialPath = isAbsolutePath(last)
        ? last.replace(/[\\/][^\\/]*$/, "")
        : node.properties._browsePath || (source === "output" ? roots.output : roots.input);
    createFileBrowserModal("", () => {}, source, {
        initialPath,
        navKind: "video",
        allowedTypes: ["video"],
        multiSelect: true,
        onMultiSelect: (items) => {
            const added = [];
            for (const item of items ?? []) {
                const meta = item?.meta;
                if (meta?.dir) node.properties._browsePath = meta.dir;
                const picked = meta?.absPath ? classifySelection(meta.absPath, meta.roots || roots) : null;
                const file = picked?.value || meta?.absPath || item?.value;
                if (file && file !== "(none)") added.push({ file, source: picked?.sourceFolder || source, enabled: true });
            }
            if (added.length) onAdd(added);
        },
    });
}
