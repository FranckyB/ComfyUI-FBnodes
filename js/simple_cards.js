/**
 * Card faces for the FBnodes nodes whose face is only their own settings
 * (no other frontend). Each lists its rows; the stock widgets stay hidden
 * and hold the values.
 */

import { app } from "../../scripts/app.js";
import { mountCard } from "./fbui/card.js";
import { chainCallback } from "./fbui/dom.js";
import { hideInputsInDef } from "./fbui/widgets.js";

const LATENT_FILE = [{ widget: "file_path", label: "File", kind: "text" }];

const CARDS = {
    ApplyLoraPlus: [{ widget: "strength", label: "Strength" }],
    ApplyLTXLoraPlus: [
        { widget: "video_strength", label: "Video" },
        { widget: "audio_strength", label: "Audio" },
        { widget: "other_strength", label: "Other" },
    ],
    SwitchAnyBool: [{ widget: "condition", label: "Condition", offText: "false", onText: "true" }],
    LoadLatentFile: LATENT_FILE,
    LoadLTXLatentFile: LATENT_FILE,
    VACEStitcher_Options: [
        { section: "Frames" },
        { widget: "context_frames", label: "Context" },
        { widget: "replace_frames", label: "Replace" },
        { widget: "new_frames", label: "New" },
        { section: "Sampling" },
        { pair: ["steps_high", "steps_low"], label: "Steps", prefixes: ["High", "Low"] },
        { widget: "cfg", label: "CFG" },
        { widget: "sampler_name", label: "Sampler", kind: "select" },
        { widget: "scheduler", label: "Scheduler", kind: "select" },
        // The frontend adds control_after_generate beside a seed.
        { pair: ["seed", "control_after_generate"], label: "Seed" },
        { widget: "vace_strength", label: "Strength" },
        { section: "Result" },
        { widget: "seamless_loop", label: "Loop" },
        { widget: "crossfade", label: "Crossfade" },
        { widget: "color_match", label: "Color match", title: "Needs the optional color-matcher package" },
        { widget: "decode_batch_size", label: "Decode batch" },
    ],
};

app.registerExtension({
    name: "FBnodes.SimpleCards",
    beforeRegisterNodeDef(nodeType, nodeData) {
        const rows = CARDS[nodeData.name];
        if (!rows) return;
        hideInputsInDef(nodeData, rows.flatMap((row) => row.pair ?? (row.widget ? [row.widget] : [])));
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            mountCard(this, { minWidth: 260, rows });
        });
    },
});
