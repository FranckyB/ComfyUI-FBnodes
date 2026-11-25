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
import { notifyChange, toast } from "./fbui/comfy.js";
import { button, ICONS } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { makeScrub } from "./fbui/scrub.js";
import { findWidget, hideInputsInDef, hideWidget, suppressCorePreview } from "./fbui/widgets.js";
import { chip, chipRow, comboSelect, prefixControl } from "./common/save_rows.js";
import { CAPTION_HEIGHT } from "./fbui/theme.js";
import { installExecStart } from "./common/exec_start.js";

const NODE_NAME = "SaveVideoPlus";
const LAST_RESULT_WIDGET = "_fbSaveVideoLastResult";
const MIN_WIDTH = 380;
const STAGE_MIN_HEIGHT = 200;

// What the Filename field understands, shown from its (i).
const FILENAME_HELP = [
    ["%date%", "today's date: 26-11-22"],
    ["%time%", "the time now: 14-05-09"],
    ["%elapsed%", "time in seconds the run took"],
    ["%width% %height%", "the video size"],
    "ComfyUI's own keywords work too, such as %year% or %date:yyyy-MM-dd%.",
];

const first = (value) => (Array.isArray(value) ? value[0] : value);

const saving = (node) => findWidget(node, "save")?.value !== false;
const customEncoding = (node) => saving(node) && findWidget(node, "custom_encoding")?.value === true;

// Save, Latent and Custom encoding; the last two grey out with Save off.
function outputControl(node, card) {
    const chips = [
        chip(node, card, "save", { text: "Save", icon: ICONS.save, title: "Lit: save to the output folder. Unlit: a preview only, in temp." }),
        chip(node, card, "save_latent", { text: "Latent", icon: ICONS.tiles, active: () => saving(node), title: "Lit: save the connected latent beside the video (same name, .latent)." }),
        chip(node, card, "custom_encoding", { text: "Custom", icon: ICONS.film, active: () => saving(node), title: "Lit: encode with the codec, chroma and CRF below. Unlit: ComfyUI's own encoder, with the incoming video's settings." }),
    ];
    return { element: chipRow(...chips), sync: () => chips.forEach((item) => item.sync()) };
}

// Codec, chroma and CRF on one line, as Save Image+'s Format row.
function encodingControl(node, card) {
    const codec = comboSelect(node, card, "codec", { title: "Codec", labels: { h264: "H.264", h265: "H.265" } });
    const chroma = comboSelect(node, card, "chroma", { title: "Chroma subsampling", labels: { yuv420: "4:2:0", yuv422: "4:2:2", yuv444: "4:4:4" } });
    const options = findWidget(node, "crf")?.options ?? {};
    const crf = makeScrub({
        value: 0, min: options.min ?? 0, max: options.max ?? 51, step: 1, decimals: 0, unit: "crf",
        title: "Quality: lower is better and larger.",
        onChange: (value) => card.setWidget("crf", value, { settle: false }),
        onSettle: notifyChange,
    });
    return {
        element: chipRow(codec, chroma, crf.root),
        sync() {
            codec.sync();
            chroma.sync();
            crf.set(Number(findWidget(node, "crf")?.value) || 0);
        },
    };
}

// The on-node player: Autoplay, and Preview (a browser-playable copy, for
// what the browser cannot play: the auto encoder's or H.265 output).
function playerControl(node, card) {
    const chips = [
        chip(node, card, "auto_play", { text: "Autoplay", icon: ICONS.play, title: "Lit: the video plays on the node as soon as it is shown." }),
        chip(node, card, "browser_compat", {
            text: "Preview", icon: ICONS.eye,
            active: () => saving(node) && (!customEncoding(node) || findWidget(node, "codec")?.value === "h265"),
            title: "Lit: a clip the browser cannot play gets an H.264 copy for the node's player.",
        }),
    ];
    return { element: chipRow(...chips), sync: () => chips.forEach((item) => item.sync()) };
}

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

// Runs started since the page loaded. ComfyUI hands a node its last output
// again when its workflow tab is shown; only a result from a run started
// since the node last showed one is new (Autoplay plays it).
let runsStarted = 0;
api.addEventListener("execution_start", () => { runsStarted += 1; });

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
    const fresh = node._fb.runsSeen !== runsStarted;
    node._fb.runsSeen = runsStarted;
    node._fb.show(result, { fresh });
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
    const empty = el("div", "fbui-stage-empty");
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
    // browser cannot play. A file that is gone (temp is cleared when ComfyUI
    // restarts) says so instead of showing a broken picture.
    const showStill = (result) => {
        media?.remove();
        const still = el("img");
        media = still;
        still.draggable = false;
        still.src = api.apiURL(`/fbnodes/video-frame?${new URLSearchParams({ filename: result.path, position: "0" })}`);
        still.addEventListener("load", () => {
            fb.size = [still.naturalWidth, still.naturalHeight];
            fb.card.refresh();
        });
        still.addEventListener("error", () => {
            if (media !== still) return;
            still.remove();
            media = null;
            notice.remove();
            fb.gone = true;
            empty.textContent = "This video is no longer available";
            empty.hidden = false;
            fb.card.refresh();
        });
        stage.prepend(still);
        stage.append(notice);
    };

    fb.show = (result, { fresh = false } = {}) => {
        fb.result = result;
        fb.gone = false;
        fb.size = null;
        fb.duration = 0;
        media?.remove();
        media = null;
        notice.remove();
        empty.textContent = "Run the workflow to see the saved video";
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
            player.hidden = !fb.result || fb.gone;
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
    const fb = { result: null, gone: false, size: null, duration: 0, runsSeen: runsStarted };
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

    fb.card = mountCard(node, {
        minWidth: MIN_WIDTH,
        rows: [
            { group: "options", label: "Options" },
            { label: "Folder", control: prefixControl(0, { help: FILENAME_HELP, name: "vid" }), widgets: ["filename_prefix"], group: "options" },
            { label: "Name", control: prefixControl(1, { help: FILENAME_HELP, name: "vid" }), group: "options" },
            { label: "Output", control: outputControl, widgets: ["save", "save_latent", "custom_encoding"], group: "options" },
            { label: "Encoding", control: encodingControl, widgets: ["codec", "chroma", "crf"], group: "options", when: (_values, n) => customEncoding(n) },
            { label: "Player", control: playerControl, widgets: ["auto_play", "browser_compat"], group: "options" },
            { panel: stagePanel, grow: true, height: STAGE_MIN_HEIGHT },
            { panel: captionPanel, height: CAPTION_HEIGHT },
        ],
    });

    chainCallback(node, "onExecuted", (message) => setResult(node, message));
    chainCallback(node, "onConfigure", () => {
        // A workflow saved with the canvas face's Controls open opens Options.
        if (node.properties._saveVideoControlsExpanded && node.properties.fbui_open_options === undefined) node.properties.fbui_open_options = true;
        // Saved before Encoding existed: values restore by position, so the
        // last result landed in Encoding. Those workflows chose their own
        // codec, so they stay custom.
        const encoding = findWidget(node, "custom_encoding");
        if (encoding && typeof encoding.value !== "boolean") {
            findWidget(node, LAST_RESULT_WIDGET).value = typeof encoding.value === "string" ? encoding.value : "";
            encoding.value = true;
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
        hideInputsInDef(nodeData, ["filename_prefix", "codec", "chroma", "crf", "save", "save_latent", "browser_compat", "auto_play", "exec_start", "custom_encoding"]);
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            setupNode(this);
        });
    },
});
