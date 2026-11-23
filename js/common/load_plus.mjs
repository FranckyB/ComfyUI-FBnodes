// The source plumbing shared by the Load+ nodes (Load Image+, Load Video+,
// Load Audio+). The node's file widget holds the picked file: relative to
// the input or output folder (source_folder says which), or an absolute path
// picked anywhere on disk. Its option list is the folder last browsed, or the
// source folder. Each node keeps node._fb = { card, reload(value) }.
import { api } from "../../../scripts/api.js";
import { createFileBrowserModal } from "../file_browser.js";
import { basenameOf, classifySelection, getMediaRoots, isAbsolutePath, stripAnnotation } from "../path_browser.js";
import { findWidget } from "../fbui/widgets.mjs";

export const NONE = "(none)";
export const BLANK = "(blank)";

// Basenames for a source list; a repeated name gets " (2)", " (3)".
const labelCache = new WeakMap();
export function sourceLabel(value, values) {
    let labels = labelCache.get(values);
    if (!labels) {
        labels = new Map();
        const used = new Map();
        for (const item of values) {
            const base = item === NONE || item === BLANK ? item : basenameOf(item) || item;
            const count = (used.get(base) ?? 0) + 1;
            used.set(base, count);
            labels.set(item, count > 1 ? `${base} (${count})` : base);
        }
        labelCache.set(values, labels);
    }
    return labels.get(value) ?? basenameOf(value);
}

// loadPlus({ widget, listKind, navKind, allowedTypes, accepts, sentinels, uploadType })
//   widget       the file widget's name ("image", "video", "audio")
//   listKind     what /fbnodes/list-files lists for a source folder
//   navKind      what the file browser and a browsed folder list
//   accepts      (value) => bool, keeps only the node's own files from a listing
//   sentinels    the values that are not files, first in the list
export function loadPlus({ widget, listKind = "media", navKind = "media", allowedTypes, accepts = () => true, sentinels = [NONE, BLANK] }) {
    const isFile = (value) => Boolean(value) && !sentinels.includes(value);
    const sourceFolder = (node) => findWidget(node, "source_folder")?.value || "input";
    const current = (node) => stripAnnotation(findWidget(node, widget)?.value);

    function setOptions(node, files, preferred) {
        const target = findWidget(node, widget);
        const values = [...sentinels, ...files.filter((file) => isFile(file) && accepts(file))];
        const keep = stripAnnotation(preferred ?? target.value);
        if (keep && !values.includes(keep)) values.push(keep);
        target.options.values = values;
        node._fb.card?.refresh();
    }

    async function refreshForSource(node, source, preferred = null) {
        try {
            const params = new URLSearchParams({ source: source || "input", kind: listKind });
            const response = await api.fetchApi(`/fbnodes/list-files?${params}`);
            if (!response.ok) return;
            const result = await response.json();
            setOptions(node, Array.isArray(result?.files) ? result.files : [], preferred);
        } catch (error) {
            console.warn(`[FBnodes] Could not list the ${source} folder:`, error);
        }
    }

    async function refreshForBrowsePath(node, path, preferred = null) {
        try {
            const roots = await getMediaRoots();
            const params = new URLSearchParams({ path, kind: navKind });
            const response = await api.fetchApi(`/fbnodes/path-browser/list?${params}`);
            if (!response.ok) return;
            const data = await response.json();
            const files = [];
            for (const item of Array.isArray(data?.files) ? data.files : []) {
                const absPath = typeof item === "string" ? item : item?.path;
                const value = absPath && (classifySelection(absPath, roots)?.value || absPath);
                if (value && !files.includes(value)) files.push(value);
            }
            setOptions(node, files, preferred);
        } catch (error) {
            console.warn("[FBnodes] Could not list the browsed folder:", error);
        }
    }

    function refreshOptions(node, preferred = null) {
        const path = node.properties._browsePath;
        return path ? refreshForBrowsePath(node, path, preferred) : refreshForSource(node, sourceFolder(node), preferred);
    }

    function setSourceFolder(node, folder) {
        const target = findWidget(node, "source_folder");
        if (target && folder) target.value = folder;
    }

    function setFile(node, value) {
        const target = findWidget(node, widget);
        if (!target.options.values.includes(value)) target.options.values = [...target.options.values, value];
        // The same name again (an upload that replaced the file) still reloads.
        if (stripAnnotation(target.value) === value) node._fb.reload(value);
        else node._fb.card.setWidget(widget, value);
    }

    async function openBrowser(node) {
        const roots = await getMediaRoots();
        const source = sourceFolder(node);
        const value = current(node);
        const initialPath = node.properties._browsePath || (source === "output" ? roots.output : roots.input);
        let selectedAbsPath = "";
        if (isFile(value)) {
            if (isAbsolutePath(value)) selectedAbsPath = value;
            else {
                const root = source === "output" ? roots.output : roots.input;
                if (root) selectedAbsPath = `${String(root).replace(/[\\/]+$/, "")}/${String(value).replace(/^[\\/]+/, "")}`;
            }
        }
        selectedAbsPath ||= node.properties._browseSelectedAbsPath || "";
        createFileBrowserModal(value, (selected, meta) => {
            const picked = classifySelection(meta.absPath, meta.roots);
            node.properties._browsePath = meta.dir;
            node.properties._browseSelectedAbsPath = meta.absPath;
            setSourceFolder(node, picked.sourceFolder);
            setFile(node, picked.value);
            refreshForBrowsePath(node, meta.dir, picked.value);
        }, source, { initialPath, selectedAbsPath, navKind, allowedTypes });
    }

    function step(node, direction) {
        const values = (findWidget(node, widget)?.options?.values ?? []).filter(isFile);
        if (values.length <= 1) return false;
        const index = values.indexOf(current(node));
        const next = index < 0 ? (direction > 0 ? 0 : values.length - 1) : (index + direction + values.length) % values.length;
        setFile(node, values[next]);
        return true;
    }

    // Upload to the input folder (ComfyUI's /upload/image takes any file) and pick it.
    async function upload(node, blob, filename, mime) {
        const file = blob instanceof File ? blob : new File([blob], filename, { type: mime || blob.type || "application/octet-stream" });
        const form = new FormData();
        form.append("image", file);
        form.append("subfolder", "");
        form.append("type", "input");
        const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (!response.ok) throw new Error(`Upload failed (${response.status})`);
        const data = await response.json();
        setSourceFolder(node, "input");
        node.properties._browsePath = "";
        await refreshForSource(node, "input", data.name);
        setFile(node, data.name);
    }

    // The absolute path of the picked file, for the system player and the like.
    async function absolutePath(node) {
        const value = current(node);
        if (!isFile(value)) return null;
        if (isAbsolutePath(value)) return value;
        const roots = await getMediaRoots();
        const root = sourceFolder(node) === "output" ? roots.output : roots.input;
        return root ? `${String(root).replace(/[\\/]+$/, "")}/${String(value).replace(/^[\\/]+/, "")}` : null;
    }

    return { isFile, sourceFolder, current, refreshForSource, refreshOptions, setFile, openBrowser, step, upload, absolutePath };
}
