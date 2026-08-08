/**
 * Video Metadata Reader - VHS Compatible
 * Enables drag-and-drop workflow loading from videos saved by VideoHelperSuite
 * without needing VHS installed.
 * 
 * Based on VideoHelperSuite's videoinfo.js implementation.
 */

import { app } from '../../../scripts/app.js'

/**
 * Walk MP4 atoms and extract mdta-style metadata keys ('workflow', 'prompt')
 * from the moov/udta/meta/keys+ilst structure.
 * Returns an object like { workflow: "...", prompt: "..." } or null.
 */
function parseMp4MdtaMetadata(videoData, dataView, decoder) {
    const u32 = (o) => dataView.getUint32(o);
    const tag = (o) => String.fromCharCode(videoData[o], videoData[o + 1], videoData[o + 2], videoData[o + 3]);

    // Iterate child atoms within [start, end)
    function* atoms(start, end) {
        let off = start;
        while (off + 8 <= end && off + 8 <= videoData.length) {
            let size = u32(off);
            const type = tag(off + 4);
            let header = 8;
            if (size === 1) { // 64-bit largesize
                size = Number(dataView.getBigUint64(off + 8));
                header = 16;
            } else if (size === 0) {
                size = end - off;
            }
            if (size < header || off + size > end) break;
            yield { type, start: off, header, size, end: off + size };
            off += size;
        }
    }

    // Find the meta atom (under moov or moov/udta)
    function findMeta() {
        for (const a of atoms(0, videoData.length)) {
            if (a.type !== 'moov') continue;
            for (const b of atoms(a.start + a.header, a.end)) {
                if (b.type === 'meta') return b;
                if (b.type === 'udta') {
                    for (const c of atoms(b.start + b.header, b.end)) {
                        if (c.type === 'meta') return c;
                    }
                }
            }
        }
        return null;
    }

    const meta = findMeta();
    if (!meta) return null;

    // meta is a FullBox: skip 4-byte version/flags after the header
    let keysAtom = null;
    let ilstAtom = null;
    for (const a of atoms(meta.start + meta.header + 4, meta.end)) {
        if (a.type === 'keys') keysAtom = a;
        if (a.type === 'ilst') ilstAtom = a;
    }
    if (!keysAtom || !ilstAtom) return null;

    // Parse keys: 4-byte version/flags + 4-byte count, then entries
    const keyNames = [];
    {
        const base = keysAtom.start + keysAtom.header;
        const count = u32(base + 4);
        let off = base + 8;
        for (let i = 0; i < count && off + 8 <= keysAtom.end; i++) {
            const sz = u32(off);
            // off + 4 is the namespace ('mdta'), name follows
            keyNames.push(decoder.decode(videoData.slice(off + 8, off + sz)));
            off += sz;
        }
    }

    // Parse ilst: items are NOT typed atoms — the field after size is the
    // 1-based key index. Child atoms (e.g. 'data') start right after it.
    const result = {};
    for (const item of atoms(ilstAtom.start + ilstAtom.header, ilstAtom.end)) {
        const index = u32(item.start + 4);
        const name = keyNames[index - 1];
        if (!name) continue;
        for (const d of atoms(item.start + 8, item.end)) {
            if (d.type !== 'data') continue;
            // data atom: 4-byte type indicator + 4-byte locale, then payload
            const payload = videoData.slice(d.start + d.header + 8, d.end);
            result[name] = decoder.decode(payload);
            break;
        }
    }

    return ('workflow' in result || 'prompt' in result) ? result : null;
}

/**
 * Parse video file bytes to extract embedded workflow/prompt metadata.
 * Supports webm/mkv (EBML/Matroska) and mp4 (QuickTime) formats.
 */
function getVideoMetadata(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const videoData = new Uint8Array(event.target.result);
            const dataView = new DataView(videoData.buffer);
            const decoder = new TextDecoder();

            // Check for known valid magic bytes
            if (dataView.getUint32(0) === 0x1A45DFA3) {
                // webm/mkv - EBML/Matroska format
                // Metadata stored in COMMENT tags
                // See: http://wiki.webmproject.org/webm-metadata/global-metadata
                // See: https://www.matroska.org/technical/elements.html
                let offset = 4 + 8; // Skip header, COMMENT is 7 chars + 1 to realign

                while (offset < videoData.length - 16) {
                    // Check for text tags (0x4487 = TagString element)
                    if (dataView.getUint16(offset) === 0x4487) {
                        // Check that name of tag is COMMENT
                        const name = String.fromCharCode(...videoData.slice(offset - 7, offset));
                        if (name === "COMMENT") {
                            // Parse EBML variable-length integer
                            // See: https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown
                            let vint = dataView.getUint32(offset + 2);
                            let n_octets = Math.clz32(vint) + 1;
                            if (n_octets < 4) { // 250MB sanity cutoff
                                let length = (vint >> (8 * (4 - n_octets))) & ~(1 << (7 * n_octets));
                                const content = decoder.decode(videoData.slice(offset + 2 + n_octets, offset + 2 + n_octets + length));
                                try {
                                    const json = JSON.parse(content);
                                    resolve(json);
                                    return;
                                } catch (e) {
                                    console.warn("[VideoMetadata] Failed to parse COMMENT JSON:", e);
                                }
                            }
                        }
                    }
                    offset += 1;
                }
            } else if (dataView.getUint32(4) === 0x66747970) {
                // mp4 - QuickTime/ISO format
                // See: https://developer.apple.com/documentation/quicktime-file-format
                // Metadata can be in various locations, search from end

                // First try: Look for ©cmt (comment) atom - VHS style
                let offset = videoData.length - 4;
                while (offset > 16) {
                    if (dataView.getUint32(offset) === 0x64617461) { // 'data' tag
                        if (dataView.getUint32(offset - 8) === 0xa9636d74) { // '©cmt' (comment) tag
                            let size = dataView.getUint32(offset - 4) - 4 * 4;
                            const content = decoder.decode(videoData.slice(offset + 12, offset + 12 + size));
                            try {
                                const json = JSON.parse(content);
                                resolve(json);
                                return;
                            } catch (e) {
                                console.warn("[VideoMetadata] Failed to parse ©cmt JSON:", e);
                            }
                        }
                    }
                    offset -= 1;
                }

                // Second try: Parse udta/meta/keys/ilst atoms properly.
                // SaveVideoPlus stores 'workflow'/'prompt' as mdta keys via
                // movflags=use_metadata_tags. Blind byte-scanning is unreliable:
                // 'prompt' and 'workflow' sit 16 bytes apart in the keys atom, so
                // a stride scan may grab the prompt payload and mistake it for a
                // workflow (it has a 'prompt' key but no 'nodes').
                const meta = parseMp4MdtaMetadata(videoData, dataView, decoder);
                if (meta) {
                    // Prefer the true workflow payload; fall back to prompt-only.
                    let wf = meta.workflow;
                    if (typeof wf === "string") {
                        try { wf = JSON.parse(wf); } catch (e) { wf = null; }
                    }
                    if (wf && typeof wf === "object" && Array.isArray(wf.nodes)) {
                        resolve({ workflow: wf, prompt: meta.prompt ?? null });
                        return;
                    }
                    let pr = meta.prompt;
                    if (typeof pr === "string") {
                        try { pr = JSON.parse(pr); } catch (e) { pr = null; }
                    }
                    if (pr && typeof pr === "object") {
                        resolve({ prompt: pr });
                        return;
                    }
                }
            }

            // No metadata found
            resolve(undefined);
        };

        reader.onerror = () => {
            console.error("[VideoMetadata] Failed to read file");
            resolve(undefined);
        };

        reader.readAsArrayBuffer(file);
    });
}

/**
 * Check if file is a video by extension
 */
function isVideoFile(file) {
    const videoExtensions = ['.webm', '.mp4', '.mkv', '.mov', '.avi'];
    const name = file?.name?.toLowerCase() || '';
    return videoExtensions.some(ext => name.endsWith(ext));
}

// Store original handler
let originalHandleFile = null;

/**
 * Custom file handler that intercepts video files to extract workflow metadata
 */
async function handleFile(file) {
    // Check if this is a video file
    if (file?.type?.startsWith("video/") || isVideoFile(file)) {
        console.log("[VideoMetadata] Processing video file:", file.name);
        
        try {
            const videoInfo = await getVideoMetadata(file);
            
            if (videoInfo?.workflow) {
                console.log("[VideoMetadata] Found workflow in video, loading...");
                await app.loadGraphData(videoInfo.workflow);
                return;
            } else {
                console.log("[VideoMetadata] No workflow metadata found in video");
            }
        } catch (e) {
            console.error("[VideoMetadata] Error extracting metadata:", e);
        }
    }
    
    // Fall through to original handler
    if (originalHandleFile) {
        return await originalHandleFile.apply(this, arguments);
    }
}

// Register extension
app.registerExtension({
    name: "FBnodes.VideoMetadata",
    
    async setup() {
        // Only hijack if not already done by VHS
        if (!window._vhsVideoMetadataRegistered) {
            // Store and replace the file handler
            originalHandleFile = app.handleFile;
            app.handleFile = handleFile;
            
            // Add video formats to file input accept attribute
            const fileInput = document.getElementById("comfy-file-input");
            if (fileInput && !fileInput.accept.includes("video/")) {
                fileInput.accept += ",video/webm,video/mp4,video/x-matroska";
            }
            
            // Mark as registered to avoid double-registration if VHS loads later
            window._vhsVideoMetadataRegistered = true;
            
            console.log("[FBnodes] VHS-compatible video metadata reader registered");
        } else {
            console.log("[FBnodes] Video metadata handler already registered (likely by VHS)");
        }
    }
});
