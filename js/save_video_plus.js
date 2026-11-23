/**
 * Save Video+ (FBnodes): saves H.264 / H.265 with date tokens in the name
 * and plays what was saved: the node's own player, the still frame and a
 * system-player button for clips the browser cannot play, and a footnote
 * with the size and length.
 *
 * The face is one fbui card; the stock widgets stay hidden and hold every
 * saved value. The last result lives in a hidden serialized widget
 * (_fbSaveVideoLastResult, always the last one), so a reloaded workflow
 * shows it again.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mountCard } from "./fbui/card.js";
import { toast } from "./fbui/comfy.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { findWidget, hideInputsInDef, hideWidget, suppressCorePreview } from "./fbui/widgets.js";
import { CAPTION_HEIGHT } from "./fbui/theme.js";
import { installExecStart } from "./common/exec_start.js";

const NODE_NAME = "SaveVideoPlus";
const LAST_RESULT_WIDGET = "_fbSaveVideoLastResult";
const MIN_WIDTH = 300;
const STAGE_MIN_HEIGHT = 200;

// What the Filename field understands, shown from its (i).
const FILENAME_HELP = [
    "The default Vids/%yy%-%month%-%day%/vid_%hour%-%minute%-%second% saves Vids/26-11-22/vid_14-05-09.mp4 in the output folder (then _00001, _00002 … if the name is taken).",
    ["a/b/name", "a / makes subfolders"],
    ["%yy% %month% %day%", "today's date: 26 11 22"],
    ["%year%", "the year in four digits: 2026"],
    ["%hour% %minute% %second%", "the time now"],
    ["%time%", "the seconds the run took, from pressing Queue"],
    ["%width% %height%", "the video size"],
    "With Save off, only the name after the last / is used, in the temp folder.",
];

const first = (value) => (Array.isArray(value) ? value[0] : value);

// ---------------------------------------------------------------- result

// The last result: { path, needsExternal, preview: { filename, subfolder, type } }.
function readResult(node) {
    try {
        const parsed = JSON.parse(findWidget(node, LAST_RESULT_WIDGET)?.value || "null");
        return typeof parsed?.path === "string" && parsed.path ? parsed : null;
    } catch {
        return null;
    }
}

function setResult(node, payload) {
    const path = first(payload?.saved_video_path);
    if (typeof path !== "string") return false;
    const preview = first(payload?.images);
    const result = {
        path,
        needsExternal: Boolean(first(payload?.needs_external_player)),
        preview: preview?.filename ? { filename: preview.filename, subfolder: preview.subfolder || "", type: preview.type || "output" } : null,
    };
    findWidget(node, LAST_RESULT_WIDGET).value = JSON.stringify(result);
    node._fb.show(result, { fresh: true });
    return true;
}

function viewUrl(result) {
    const preview = result.preview;
    if (preview?.filename) {
        return api.apiURL(`/view?${new URLSearchParams({ filename: preview.filename, type: preview.type, subfolder: preview.subfolder })}`);
    }
    return "";
}

async function openInPlayer(node) {
    const path = readResult(node)?.path;
    if (!path) return;
    try {
        const response = await api.fetchApi("/fbnodes/open-in-player", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Request failed (${response.status})`);
        }
    } catch (error) {
        toast(`Could not open the system player: ${error.message}`, { severity: "warn" });
    }
}

// ---------------------------------------------------------------- panels

function stagePanel(node) {
    const fb = node._fb;
    const stage = el("div", "fbui-stage");
    const empty = el("div", "fbui-stage-empty", "Run the workflow to see the saved video");
    const tools = el("div", "fbui-stage-tools");
    const player = button("", { icon: ICONS.open, small: true, title: "Open in the system player", onClick: () => openInPlayer(node) });
    tools.append(player);
    const notice = el("div", "fbui-stage-empty");
    notice.style.cssText = "inset:auto 0 0 0;padding:8px;background:rgba(10,12,15,.78);pointer-events:auto;gap:6px";
    notice.append(
        el("span", "", "This video can't play in the browser."),
        button("Open in system player", { small: true, icon: ICONS.play, onClick: () => openInPlayer(node) }),
    );
    stage.append(empty, tools);
    let media = null;

    // A still of the saved file (decoded by the backend) for a clip the
    // browser cannot play.
    const showStill = (result) => {
        media?.remove();
        media = el("img");
        media.draggable = false;
        media.src = api.apiURL(`/fbnodes/video-frame?${new URLSearchParams({ filename: result.path, position: "0" })}`);
        media.addEventListener("load", () => {
            fb.size = [media.naturalWidth, media.naturalHeight];
            fb.card.refresh();
        });
        stage.prepend(media);
        stage.append(notice);
    };

    fb.show = (result, { fresh = false } = {}) => {
        fb.result = result;
        fb.size = null;
        fb.duration = 0;
        media?.remove();
        media = null;
        notice.remove();
        empty.hidden = Boolean(result);
        if (result) {
            const url = viewUrl(result);
            if (result.needsExternal || !url) showStill(result);
            else {
                media = el("video");
                Object.assign(media, { controls: true, loop: true, playsInline: true, preload: "metadata", src: url });
                media.addEventListener("loadedmetadata", () => {
                    fb.size = [media.videoWidth, media.videoHeight];
                    fb.duration = media.duration;
                    fb.card.refresh();
                });
                media.addEventListener("error", () => showStill(result));
                // A new result plays by itself when Autoplay is on; muted if the
                // browser refuses sound without a click.
                if (fresh && findWidget(node, "auto_play")?.value !== false) {
                    media.addEventListener("loadeddata", () => {
                        media.play().catch(() => {
                            media.muted = true;
                            media.play().catch(() => {});
                        });
                    }, { once: true });
                }
                stage.prepend(media);
            }
        }
        fb.card.refresh();
    };

    return {
        element: stage,
        sync() {
            player.hidden = !fb.result;
        },
    };
}

function captionPanel(node) {
    const fb = node._fb;
    const caption = el("div", "fbui-caption");
    return {
        element: caption,
        sync() {
            const parts = [];
            if (fb.size?.[0]) parts.push(`${fb.size[0]} × ${fb.size[1]}`);
            if (fb.duration > 0) parts.push(`${fb.duration.toFixed(fb.duration < 10 ? 2 : 1)} s`);
            caption.textContent = parts.join(" · ") || "—";
            caption.title = fb.result?.path ?? "";
        },
    };
}

// ---------------------------------------------------------------- node

// Results that arrive while the node's workflow is not open are kept here
// and shown when it is.
const lastResults = new Map();

function setupNode(node) {
    node.properties ??= {};
    suppressCorePreview(node);
    const fb = { result: null, size: null, duration: 0 };
    node._fb = fb;

    // The last result, saved with the workflow; created last so it stays the
    // last saved value, as in every earlier version of the node.
    let lastResult = findWidget(node, LAST_RESULT_WIDGET);
    if (!lastResult) {
        lastResult = node.addWidget("text", LAST_RESULT_WIDGET, "", null, { serialize: true });
        lastResult.serialize = true;
    }
    hideWidget(lastResult);
    hideWidget(findWidget(node, "exec_start"));

    const saving = (values) => values.save !== false;
    const manual = (values) => saving(values) && !values.auto;
    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            { group: "options", label: "Options" },
            { widget: "filename_prefix", label: "Filename", kind: "text", info: FILENAME_HELP, group: "options" },
            { widget: "save", label: "Save", offText: "preview only", onText: "save", group: "options" },
            { widget: "auto", label: "Auto", offText: "off", onText: "from video", group: "options", when: saving },
            { widget: "codec", label: "Codec", kind: "segment", labels: { h264: "H.264", h265: "H.265" }, group: "options", when: manual },
            { widget: "chroma", label: "Chroma", kind: "segment", labels: { yuv420: "4:2:0", yuv422: "4:2:2", yuv444: "4:4:4" }, group: "options", when: manual },
            { widget: "crf", label: "CRF", group: "options", when: manual },
            { widget: "save_latent", label: "Latent", offText: "off", onText: "save beside", group: "options", when: saving },
            { widget: "browser_compat", label: "Preview", offText: "original", onText: "H.264 copy", group: "options", when: (values) => saving(values) && (values.auto || values.codec === "h265") },
            { widget: "auto_play", label: "Autoplay", group: "options" },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    chainCallback(node, "onExecuted", (message) => setResult(node, message));
    chainCallback(node, "onConfigure", () => {
        // A workflow saved with the canvas face's Controls open opens Options.
        if (node.properties._saveVideoControlsExpanded && node.properties.fbui_open_options === undefined) node.properties.fbui_open_options = true;
        // Saved before Auto existed: values restore by position, so the last
        // result landed in Auto.
        const auto = findWidget(node, "auto");
        if (typeof auto.value !== "boolean") {
            findWidget(node, LAST_RESULT_WIDGET).value = typeof auto.value === "string" ? auto.value : "";
            auto.value = false;
        }
        hideWidget(findWidget(node, LAST_RESULT_WIDGET));
        const kept = lastResults.get(String(node.id));
        if (kept) setResult(node, kept);
        else fb.show(readResult(node));
    });
    queueMicrotask(() => {
        if (!fb.result) fb.show(readResult(node));
    });
}

app.registerExtension({
    name: "FBnodes.SaveVideoPlus",
    setup() {
        installExecStart();
        api.addEventListener("executed", (event) => {
            const { node, output } = event.detail ?? {};
            if (node != null && output?.saved_video_path !== undefined) lastResults.set(String(node), output);
        });
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["filename_prefix", "codec", "chroma", "crf", "save", "save_latent", "browser_compat", "auto_play", "exec_start", "auto"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
