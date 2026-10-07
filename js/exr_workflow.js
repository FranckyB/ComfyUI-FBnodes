import { app } from "../../scripts/app.js";

function parseExrWorkflowHeader(bytes) {
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 20000630 || (view.getUint32(4, true) & 255) !== 2) {
        throw new Error("Invalid EXR header");
    }
    const decoder = new TextDecoder();
    const metadata = {};
    let offset = 8;
    while (offset < bytes.length) {
        if (bytes[offset] === 0) return metadata;
        const nameEnd = bytes.indexOf(0, offset);
        if (nameEnd < 0) return null;
        const name = decoder.decode(bytes.subarray(offset, nameEnd));
        const typeStart = nameEnd + 1;
        const typeEnd = bytes.indexOf(0, typeStart);
        if (typeEnd < 0 || typeEnd + 5 > bytes.length) return null;
        const type = decoder.decode(bytes.subarray(typeStart, typeEnd));
        const size = view.getInt32(typeEnd + 1, true);
        if (size < 0) throw new Error("Invalid EXR attribute size");
        const valueStart = typeEnd + 5;
        const valueEnd = valueStart + size;
        if (valueEnd > bytes.length) return null;
        if (type === "string" && (name === "workflow" || name === "prompt")) {
            metadata[name] = decoder.decode(bytes.subarray(valueStart, valueEnd));
        }
        offset = valueEnd;
    }
    return null;
}

async function readExrWorkflowMetadata(file) {
    const reader = file.stream().getReader();
    let bytes = new Uint8Array();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return null;
            const combined = new Uint8Array(bytes.length + value.length);
            combined.set(bytes);
            combined.set(value, bytes.length);
            bytes = combined;
            const metadata = parseExrWorkflowHeader(bytes);
            if (metadata !== null) return metadata;
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}

app.registerExtension({
    name: "FBnodes.ExrWorkflowImport",
    setup() {
        const handleFile = app.handleFile;
        app.handleFile = async function (file, ...args) {
            if (/\.exr$/i.test(file.name || "")) {
                let metadata;
                try {
                    metadata = await readExrWorkflowMetadata(file);
                } catch {
                    metadata = null;
                }
                const json = metadata?.workflow || metadata?.prompt;
                if (json) {
                    const workflowFile = new File([json], file.name.replace(/\.exr$/i, ".json"), {
                        type: "application/json",
                    });
                    return handleFile.call(this, workflowFile, ...args);
                }
            }
            return handleFile.call(this, file, ...args);
        };
    },
});