import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

function setup(values = {}, vhsActive = false) {
    let extension;
    const app = {
        extensions: vhsActive ? [{ name: "VideoHelperSuite.Core" }] : [],
        registerExtension(value) { extension = value; },
        async graphToPrompt() { return { workflow: { extra: { existing: true } } }; },
        ui: { settings: { getSettingValue(id) {
            if (id === "VHS.LatentPreview") return vhsActive;
            return values[id] ?? extension.settings.find(setting => setting.id === id)?.defaultValue;
        } } },
    };
    const context = vm.createContext({ app, TextDecoder, console: { log() {} } });
    const source = fs.readFileSync(new URL("../js/latent_preview.js", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source, context);
    return { app, extension };
}

test("Krea2 settings enable injection and pass the default filename choice", async () => {
    const { app, extension } = setup();
    assert.equal(extension.settings.find(setting => setting.id === "FBnodes.InjectKrea2File").type, "text");
    await extension.setup();
    const { workflow } = await app.graphToPrompt();
    assert.equal(workflow.extra.FB_inject_krea2, true);
    assert.equal(workflow.extra.FB_inject_krea2_file, "");
});

test("Krea2 custom filename and disabled toggle survive prompt serialization", async () => {
    const { app, extension } = setup({
        "FBnodes.InjectKrea2": false,
        "FBnodes.InjectKrea2File": "custom/alternate.safetensors",
    });
    await extension.setup();
    const { workflow } = await app.graphToPrompt();
    assert.equal(workflow.extra.FB_inject_krea2, false);
    assert.equal(workflow.extra.FB_inject_krea2_file, "custom/alternate.safetensors");
});

test("VHS preview ownership still suppresses FBnodes settings", async () => {
    const { app, extension } = setup({}, true);
    await extension.setup();
    const { workflow } = await app.graphToPrompt();
    assert.equal(workflow.extra.FB_inject_krea2, undefined);
    assert.equal(workflow.extra.PM_latentpreview, undefined);
});