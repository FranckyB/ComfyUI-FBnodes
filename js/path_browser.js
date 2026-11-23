/**
 * Shared media path browser helpers for FBnodes Load+ nodes.
 *
 * Provides the backend-list/file URL helpers, root resolution, and the
 * input/output/absolute selection classifier used by the thumbnail browser
 * (file_browser.js) so the loader nodes can browse anywhere while keeping
 * old workflows working.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const SETTING_CUSTOM_PATH = "FBnodes.LoadPlusCustomPath";

// This pack's routes for the shared file browser (file_browser.js is the
// same file in every pack; each pack's path_browser.js names its own).
export const BROWSER_ROUTES = {
    list: "/fbnodes/path-browser/list",
    file: "/fbnodes/path-browser/file",
    remove: "/fbnodes/path-browser/delete",
    videoFrame: "/fbnodes/video-frame",
};

export function getCustomPresetPath() {
    const pref = app.ui?.settings?.getSettingValue(SETTING_CUSTOM_PATH) || "";
    return typeof pref === "string" ? pref.trim() : "";
}

/** Store the Custom preset folder (the same setting as in Preferences). */
export function setCustomPresetPath(path) {
    return app.ui.settings.setSettingValueAsync(SETTING_CUSTOM_PATH, String(path || "").trim());
}

/** URL that streams a media file from any path (for previews of out-of-tree files). */
export function mediaFileUrl(absPath) {
    return api.apiURL(`${BROWSER_ROUTES.file}?path=${encodeURIComponent(absPath)}`);
}

/** "name.png [output]" (the MaskEditor's annotation) -> "name.png". */
export function stripAnnotation(value) {
    return typeof value === "string" ? value.replace(/\s+\[(input|output|temp)\]$/, "") : value;
}

export function isAbsolutePath(value) {
    return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(stripAnnotation(String(value || "")));
}

export function basenameOf(value) {
    return String(value || "").replace(/\\/g, "/").split("/").pop();
}

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const extensionOf = (value) => String(stripAnnotation(value) || "").split(".").pop().toLowerCase();
export const isVideoFile = (value) => VIDEO_EXTENSIONS.has(extensionOf(value));
export const isImageFile = (value) => IMAGE_EXTENSIONS.has(extensionOf(value));

/**
 * Preview URL for a loader value: absolute paths stream through the
 * path-browser route, relative names go through ComfyUI's /view.
 */
export function previewUrl(value, type = "input") {
    const clean = stripAnnotation(value);
    if (isAbsolutePath(clean)) return mediaFileUrl(clean);
    const normalized = String(clean).replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    const params = new URLSearchParams({ filename: normalized.slice(slash + 1), type });
    if (slash > 0) params.set("subfolder", normalized.slice(0, slash));
    return api.apiURL(`/view?${params}`);
}

function normalizeSlashes(p) {
    return String(p || "").replace(/\\/g, "/");
}

/** True when `child` is inside `parent` (both absolute), case-insensitive on Windows. */
function isUnder(child, parent) {
    if (!child || !parent) return false;
    let c = normalizeSlashes(child).replace(/\/+$/, "");
    let p = normalizeSlashes(parent).replace(/\/+$/, "");
    if (navigator.platform.startsWith("Win")) {
        c = c.toLowerCase();
        p = p.toLowerCase();
    }
    return c === p || c.startsWith(p + "/");
}

/**
 * Given a selected absolute path and the input/output roots, work out how to
 * store it so old workflows keep working:
 *   - inside input  -> { sourceFolder:"input",  value:<relative> }
 *   - inside output -> { sourceFolder:"output", value:<relative> }
 *   - elsewhere     -> { sourceFolder:null,     value:<absolute> }
 */
export function classifySelection(absPath, roots) {
    const inputRoot = roots?.input || "";
    const outputRoot = roots?.output || "";
    const norm = normalizeSlashes(absPath);

    if (inputRoot && isUnder(absPath, inputRoot)) {
        const rel = norm.slice(normalizeSlashes(inputRoot).replace(/\/+$/, "").length + 1);
        return { sourceFolder: "input", value: rel, absPath };
    }
    if (outputRoot && isUnder(absPath, outputRoot)) {
        const rel = norm.slice(normalizeSlashes(outputRoot).replace(/\/+$/, "").length + 1);
        return { sourceFolder: "output", value: rel, absPath };
    }
    return { sourceFolder: null, value: absPath, absPath };
}

async function fetchBrowser(path, kind) {
    const params = [];
    if (path) params.push(`path=${encodeURIComponent(path)}`);
    if (kind) params.push(`kind=${encodeURIComponent(kind)}`);
    const query = params.length ? `?${params.join("&")}` : "";
    const resp = await api.fetchApi(`${BROWSER_ROUTES.list}${query}`);
    if (!resp.ok) {
        let msg = `Request failed (${resp.status})`;
        try {
            const err = await resp.json();
            if (err?.error) msg = err.error;
        } catch {
            // ignore
        }
        throw new Error(msg);
    }
    return await resp.json();
}

/** Resolve the input/output preset roots once (backend "roots" mode). */
export async function getMediaRoots() {
    try {
        const data = await fetchBrowser("", "");
        const roots = Array.isArray(data?.roots) ? data.roots : [];
        return { input: roots[0] || "", output: roots[1] || "" };
    } catch {
        return { input: "", output: "" };
    }
}

// Register the shared Custom-path preference once.
app.registerExtension({
    name: "FBnodes.LoadPlusPathBrowser",
    settings: [
        {
            id: SETTING_CUSTOM_PATH,
            category: ["FBnodes", "1. Load+ Nodes", "1. Custom Browser Path"],
            name: "Load+ Custom Browser Path",
            tooltip: "Folder the Custom button opens in the Load+ file browsers. Also set from the browser itself: click Custom while empty, or right-click it.",
            type: "text",
            defaultValue: "",
        },
    ],
});
