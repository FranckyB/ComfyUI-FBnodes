import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

function exr(attributes, pixels = Buffer.alloc(0)) {
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(20000630);
    prefix.writeUInt32LE(2, 4);
    const header = Object.entries(attributes).map(([name, value]) => {
        const payload = Buffer.from(JSON.stringify(value), "utf8");
        const size = Buffer.alloc(4);
        size.writeInt32LE(payload.length);
        return Buffer.concat([Buffer.from(`${name}\0string\0`), size, payload]);
    });
    return Buffer.concat([prefix, ...header, Buffer.from([0]), pixels]);
}

function setup() {
    let extension;
    const calls = [];
    const app = {
        registerExtension(value) { extension = value; },
        async handleFile(file, ...args) { calls.push({ receiver: this, file, args }); return "loaded"; },
    };
    const context = vm.createContext({ app, File, TextDecoder, Uint8Array, DataView });
    const source = fs.readFileSync(new URL("../js/exr_workflow.js", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source, context);
    extension.setup();
    return { app, calls, context };
}

test("EXR workflow uses the native JSON importer, retaining the caller and options", async () => {
    const { app, calls } = setup();
    const workflow = { nodes: [{ id: 1, title: "EXR test" }], links: [] };
    const file = new File([exr({ workflow, prompt: { node: { class_type: "SaveImagePlus" } } })], "saved.EXR");
    const options = { deferWarnings: true };
    assert.equal(await app.handleFile(file, "drag-drop", options), "loaded");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiver, app);
    assert.equal(calls[0].file.name, "saved.json");
    assert.equal(calls[0].file.type, "application/json");
    assert.deepEqual(JSON.parse(await calls[0].file.text()), workflow);
    assert.deepEqual(calls[0].args, ["drag-drop", options]);
});

test("prompt-only EXR can use the native API JSON importer", async () => {
    const { app, calls } = setup();
    const prompt = { "1": { class_type: "SaveImagePlus", inputs: {} } };
    await app.handleFile(new File([exr({ prompt })], "prompt.exr"));
    assert.deepEqual(JSON.parse(await calls[0].file.text()), prompt);
});

test("other files, metadata-free EXRs, and invalid EXRs keep native handling", async () => {
    const { app, calls } = setup();
    for (const file of [
        new File(["original PNG"], "image.png", { type: "image/png" }),
        new File(["original AVIF"], "image.avif", { type: "image/avif" }),
        new File([exr({})], "no-workflow.exr"),
        new File(["not an EXR file"], "invalid.exr"),
        new File([exr({ workflow: {} }).subarray(0, 12)], "truncated.exr"),
    ]) {
        await app.handleFile(file);
        assert.equal(calls.at(-1).file, file);
    }
});

test("header reader handles chunk boundaries and stops before pixel data", async () => {
    const { context } = setup();
    const workflow = { nodes: [{ title: "Unicode \u00e9" }], links: [], padding: "x".repeat(70000) };
    const header = exr({ workflow });
    let offset = 0;
    let cancelled = false;
    context.file = {
        stream() {
            return {
                getReader() {
                    return {
                        async read() {
                            assert(offset < header.length, "Reader must stop at the header terminator");
                            const value = new Uint8Array(header.subarray(offset, offset + 8192));
                            offset += value.length;
                            return { done: false, value };
                        },
                        async cancel() { cancelled = true; },
                        releaseLock() {},
                    };
                },
            };
        },
    };
    const metadata = await vm.runInContext("readExrWorkflowMetadata(file)", context);
    assert.deepEqual(JSON.parse(metadata.workflow), workflow);
    assert.equal(cancelled, true);
});