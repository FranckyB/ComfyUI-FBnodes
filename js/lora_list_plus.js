import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SETTING_DEFAULT_PATH = "FBnodes.LoraListDefaultPath";

function getPreferredPath() {
    const pref = app.ui?.settings?.getSettingValue(SETTING_DEFAULT_PATH) || "";
    return typeof pref === "string" ? pref.trim() : "";
}

async function getBrowserRoots() {
    try {
        const data = await fetchBrowser("");
        return Array.isArray(data?.roots) ? data.roots : [];
    } catch {
        return [];
    }
}

async function isValidBrowserPath(path) {
    const value = String(path || "").trim();
    if (!value) return false;
    try {
        const data = await fetchBrowser(value);
        return data?.ok !== false && data?.mode === "browse";
    } catch {
        return false;
    }
}

/**
 * Return the path to open the browser at.
 * Priority: per-node last_path > preference setting > first ComfyUI lora root.
 */
async function resolveInitialPath(savedPath) {
    const trimmedSaved = String(savedPath || "").trim();
    const pref = getPreferredPath();
    const roots = await getBrowserRoots();
    const comfyRoot = roots[0] || "";

    // Prefer per-node path, but only when it still exists.
    if (trimmedSaved && await isValidBrowserPath(trimmedSaved)) {
        return trimmedSaved;
    }

    // Next preference path, if configured and valid.
    if (pref && await isValidBrowserPath(pref)) {
        return pref;
    }

    // Final default: first backend root (ComfyUI LoRA root).
    if (comfyRoot) {
        return comfyRoot;
    }

    return "";
}

function getWidget(node, name) {
    return node.widgets?.find((w) => w?.name === name) || null;
}

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

function basename(path) {
    if (!path) return "";
    const norm = String(path).replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function parseState(raw) {
    try {
        const arr = JSON.parse(raw || "[]");
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((x) => x && typeof x === "object")
            .map((x) => ({ path: String(x.path || "").trim(), enabled: x.enabled !== false }))
            .filter((x) => !!x.path);
    } catch {
        return [];
    }
}

async function fetchBrowser(path) {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const resp = await api.fetchApi(`/fbnodes/lora-browser/list${query}`);
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

function openLoraBrowserModal(initialPath, onDone) {
    let currentPath = initialPath || "";
    let parentPath = null;
    let roots = [];
    let pathSuggestions = [];
    const selected = new Set();
    let visibleFilePaths = [];
    let fileDragSelecting = false;
    let fileDragValue = true;

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.76);display:flex;align-items:center;justify-content:center;z-index:10000;";

    const modal = document.createElement("div");
    modal.style.cssText = "width:min(900px,92vw);height:min(680px,88vh);background:rgba(35,39,46,0.98);border:1px solid rgba(255,255,255,0.16);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;";

    const header = document.createElement("div");
    header.style.cssText = "padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:space-between;gap:10px;";

    const title = document.createElement("div");
    title.textContent = "Select LoRA .safetensors";
    title.style.cssText = "color:#d7dee7;font-weight:600;";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "x";
    closeBtn.style.cssText = "background:transparent;border:none;color:#c8d0da;font-size:18px;cursor:pointer;";

    header.appendChild(title);
    header.appendChild(closeBtn);

    const controls = document.createElement("div");
    controls.style.cssText = "padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.12);display:flex;gap:8px;align-items:center;";

    const pathWrap = document.createElement("div");
    pathWrap.style.cssText = "flex:1;min-width:0;position:relative;display:flex;align-items:stretch;";

    const rootPathInput = document.createElement("input");
    rootPathInput.type = "text";
    rootPathInput.placeholder = "Paste folder path and press Enter";
    rootPathInput.style.cssText = "flex:1;min-width:0;font-size:12px;color:#dce6f2;background:#222a33;border:1px solid rgba(255,255,255,0.2);border-right:none;border-radius:6px 0 0 6px;padding:6px 8px;";

    const pathDropdownBtn = document.createElement("button");
    pathDropdownBtn.type = "button";
    pathDropdownBtn.textContent = "\u25BE";
    pathDropdownBtn.title = "Quick folders";
    pathDropdownBtn.style.cssText = "width:28px;min-width:28px;border:1px solid rgba(255,255,255,0.2);border-radius:0 6px 6px 0;background:#222a33;color:#dce6f2;cursor:pointer;font-size:11px;";

    const pathDropdown = document.createElement("div");
    pathDropdown.style.cssText = "position:absolute;left:0;right:0;top:calc(100% + 4px);display:none;max-height:220px;overflow:auto;background:rgba(35,39,46,0.98);border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.35);z-index:6;";

    const upBtn = document.createElement("button");
    upBtn.textContent = "Up";
    upBtn.style.cssText = "background:#2e3b4a;border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#dce6f2;padding:6px 10px;cursor:pointer;";

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "Refresh";
    refreshBtn.style.cssText = "background:#2e3b4a;border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#dce6f2;padding:6px 10px;cursor:pointer;";

    controls.appendChild(upBtn);
    controls.appendChild(refreshBtn);
    pathWrap.appendChild(rootPathInput);
    pathWrap.appendChild(pathDropdownBtn);
    pathWrap.appendChild(pathDropdown);
    controls.appendChild(pathWrap);

    const body = document.createElement("div");
    body.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:0;";

    const itemsTitle = document.createElement("div");
    itemsTitle.textContent = "Folders and Safetensors";
    itemsTitle.style.cssText = "padding:8px 12px;color:#c7d1dc;font-size:12px;border-top:1px solid rgba(255,255,255,0.08);border-bottom:1px solid rgba(255,255,255,0.08);";

    const itemsList = document.createElement("div");
    itemsList.style.cssText = "flex:1;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:2px;";

    body.appendChild(itemsTitle);
    body.appendChild(itemsList);

    const footer = document.createElement("div");
    footer.style.cssText = "padding:10px 14px;border-top:1px solid rgba(255,255,255,0.12);display:flex;justify-content:space-between;align-items:center;gap:10px;";

    const footerLeft = document.createElement("div");
    footerLeft.style.cssText = "display:flex;align-items:center;gap:12px;min-width:0;";

    const selectAllWrap = document.createElement("label");
    selectAllWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:#c7d1dc;font-size:12px;cursor:pointer;user-select:none;";
    const selectAllToggle = document.createElement("input");
    selectAllToggle.type = "checkbox";
    const selectAllText = document.createElement("span");
    selectAllText.textContent = "Select All";
    selectAllWrap.appendChild(selectAllToggle);
    selectAllWrap.appendChild(selectAllText);

    const selectedCount = document.createElement("div");
    selectedCount.style.cssText = "color:#a9b6c4;font-size:12px;";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "background:#2c2f37;border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#dce6f2;padding:7px 12px;cursor:pointer;";

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Selected";
    addBtn.style.cssText = "background:#3078c6;border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:white;padding:7px 12px;cursor:pointer;";

    actions.appendChild(cancelBtn);
    actions.appendChild(addBtn);
    footerLeft.appendChild(selectAllWrap);
    footerLeft.appendChild(selectedCount);
    footer.appendChild(footerLeft);
    footer.appendChild(actions);

    modal.appendChild(header);
    modal.appendChild(controls);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function hidePathDropdown() {
        pathDropdown.style.display = "none";
    }

    function renderPathDropdown() {
        const preferredPath = getPreferredPath();
        const comfyRoot = roots[0] || "";

        pathDropdown.innerHTML = "";
        if (!pathSuggestions.length) {
            const empty = document.createElement("div");
            empty.textContent = "No quick folders available";
            empty.style.cssText = "padding:8px 10px;color:#9badc2;font-size:12px;";
            pathDropdown.appendChild(empty);
            return;
        }

        for (const path of pathSuggestions) {
            const item = document.createElement("button");
            item.type = "button";

            let tag = "";
            if (path === preferredPath) tag = "Preferred";
            else if (path === comfyRoot) tag = "Comfy LoRA";

            item.style.cssText = "width:100%;padding:8px 10px;border:none;background:transparent;color:#dce6f2;font-size:12px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;";
            item.onmouseenter = () => { item.style.background = "rgba(66,153,225,0.18)"; };
            item.onmouseleave = () => { item.style.background = "transparent"; };

            const pathText = document.createElement("span");
            pathText.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            pathText.textContent = path;
            item.appendChild(pathText);

            if (tag) {
                const tagText = document.createElement("span");
                tagText.style.cssText = "flex-shrink:0;color:#9fc4ec;font-size:11px;";
                tagText.textContent = tag;
                item.appendChild(tagText);
            }

            item.onclick = () => {
                rootPathInput.value = path;
                hidePathDropdown();
                loadPath(path);
            };
            pathDropdown.appendChild(item);
        }
    }

    function togglePathDropdown() {
        if (pathDropdown.style.display === "block") {
            hidePathDropdown();
            return;
        }
        renderPathDropdown();
        pathDropdown.style.display = "block";
    }

    function onDocumentMouseDown(e) {
        if (!pathWrap.contains(e.target)) {
            hidePathDropdown();
        }
    }
    document.addEventListener("mousedown", onDocumentMouseDown);

    function cleanup() {
        document.removeEventListener("mousedown", onDocumentMouseDown);
        document.removeEventListener("mouseup", onFileDragEnd);
        overlay.remove();
    }

    function updateSelectAllToggle() {
        if (!visibleFilePaths.length) {
            selectAllToggle.checked = false;
            selectAllToggle.indeterminate = false;
            selectAllToggle.disabled = true;
            return;
        }
        selectAllToggle.disabled = false;
        const selectedCountVisible = visibleFilePaths.filter((p) => selected.has(p)).length;
        if (selectedCountVisible === 0) {
            selectAllToggle.checked = false;
            selectAllToggle.indeterminate = false;
        } else if (selectedCountVisible === visibleFilePaths.length) {
            selectAllToggle.checked = true;
            selectAllToggle.indeterminate = false;
        } else {
            selectAllToggle.checked = false;
            selectAllToggle.indeterminate = true;
        }
    }

    function updateSelectedCount() {
        selectedCount.textContent = `${selected.size} selected`;
        addBtn.disabled = selected.size === 0;
        addBtn.style.opacity = selected.size === 0 ? "0.6" : "1";
        addBtn.style.cursor = selected.size === 0 ? "default" : "pointer";
        updateSelectAllToggle();
    }

    function setFileSelected(path, isSelected) {
        if (isSelected) selected.add(path);
        else selected.delete(path);

        const row = itemsList.querySelector(`[data-file-path="${encodeURIComponent(path)}"]`);
        if (row) {
            const cb = row.querySelector("input[type='checkbox']");
            if (cb) cb.checked = isSelected;
            row.style.background = isSelected ? "rgba(66,153,225,0.22)" : "transparent";
        }
    }

    function onFileDragEnd() {
        fileDragSelecting = false;
        updateSelectedCount();
        document.removeEventListener("mouseup", onFileDragEnd);
    }

    function renderRootsSelect() {
        const preferredPath = getPreferredPath();
        const comfyRoot = roots[0] || "";

        const suggestions = [];
        const addSuggestion = (value) => {
            const path = String(value || "").trim();
            if (!path) return;
            if (suggestions.includes(path)) return;
            suggestions.push(path);
        };

        // Keep high-value shortcuts first.
        addSuggestion(preferredPath);
        addSuggestion(comfyRoot);
        for (const root of roots) addSuggestion(root);
        addSuggestion(currentPath);

        pathSuggestions = suggestions;
        if (currentPath) rootPathInput.value = currentPath;

        if (pathDropdown.style.display === "block") {
            renderPathDropdown();
        }
    }

    function makeDirRow(dir) {
        const row = document.createElement("div");
        row.style.cssText = "padding:7px 8px;border-radius:6px;color:#dce6f2;cursor:pointer;display:flex;align-items:center;gap:8px;";
        row.innerHTML = `<span style=\"opacity:0.85\">[DIR]</span><span style=\"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\">${dir.name}</span>`;
        row.title = `${dir.path}\nClick to open`;
        row.onmouseenter = () => { row.style.background = "rgba(66,153,225,0.16)"; };
        row.onmouseleave = () => { row.style.background = "transparent"; };
        row.onclick = () => loadPath(dir.path);
        return row;
    }

    function makeFileRow(file) {
        const row = document.createElement("div");
        row.dataset.filePath = encodeURIComponent(file.path);
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;color:#dce6f2;cursor:pointer;";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(file.path);
        cb.onchange = () => {
            setFileSelected(file.path, cb.checked);
            updateSelectedCount();
        };

        const txt = document.createElement("span");
        txt.textContent = file.name;
        txt.title = file.path;
        txt.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

        row.appendChild(cb);
        row.appendChild(txt);
        row.onmouseenter = () => {
            if (fileDragSelecting) {
                setFileSelected(file.path, fileDragValue);
                updateSelectedCount();
            } else if (selected.has(file.path)) {
                row.style.background = "rgba(66,153,225,0.22)";
            } else {
                row.style.background = "rgba(66,153,225,0.16)";
            }
        };
        row.onmouseleave = () => {
            row.style.background = selected.has(file.path) ? "rgba(66,153,225,0.22)" : "transparent";
        };

        const startDragSelect = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            fileDragSelecting = true;
            fileDragValue = !selected.has(file.path);
            setFileSelected(file.path, fileDragValue);
            updateSelectedCount();
            document.addEventListener("mouseup", onFileDragEnd);
        };

        row.onmousedown = startDragSelect;
        cb.onmousedown = startDragSelect;

        return row;
    }

    async function loadPath(path) {
        itemsList.textContent = "Loading...";
        try {
            const data = await fetchBrowser(path);

            if (data.mode === "roots") {
                roots = Array.isArray(data.roots) ? data.roots : [];
                currentPath = roots[0] || "";
                renderRootsSelect();
                if (currentPath) {
                    await loadPath(currentPath);
                } else {
                    itemsList.textContent = "No roots available.";
                }
                return;
            }

            roots = Array.isArray(data.roots) ? data.roots : roots;
            currentPath = data.current_path || "";
            parentPath = data.parent_path || null;
            rootPathInput.value = currentPath || "";
            renderRootsSelect();

            itemsList.innerHTML = "";

            const dirs = Array.isArray(data.dirs) ? data.dirs : [];
            const files = Array.isArray(data.files) ? data.files : [];
            visibleFilePaths = files.map((f) => f.path);

            if (!dirs.length && !files.length) {
                const empty = document.createElement("div");
                empty.textContent = "No subfolders or .safetensors files";
                empty.style.cssText = "padding:8px;color:#8f9aac;font-size:12px;";
                itemsList.appendChild(empty);
            }

            for (const d of dirs) itemsList.appendChild(makeDirRow(d));
            for (const f of files) itemsList.appendChild(makeFileRow(f));
        } catch (e) {
            itemsList.innerHTML = "";
            visibleFilePaths = [];
            const err = document.createElement("div");
            err.textContent = `Error: ${e.message || e}`;
            err.style.cssText = "padding:8px;color:#ff9090;font-size:12px;";
            itemsList.appendChild(err);
        }
        updateSelectedCount();
    }

    selectAllToggle.onchange = () => {
        const next = !!selectAllToggle.checked;
        for (const p of visibleFilePaths) setFileSelected(p, next);
        updateSelectedCount();
    };

    rootPathInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const nextPath = rootPathInput.value.trim();
        if (!nextPath) return;
        hidePathDropdown();
        loadPath(nextPath);
    });

    rootPathInput.addEventListener("change", () => {
        const nextPath = rootPathInput.value.trim();
        if (!nextPath) return;
        hidePathDropdown();
        loadPath(nextPath);
    });

    pathDropdownBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePathDropdown();
    };

    upBtn.onclick = () => {
        if (parentPath) loadPath(parentPath);
    };

    refreshBtn.onclick = () => loadPath(currentPath);

    closeBtn.onclick = cleanup;
    cancelBtn.onclick = cleanup;
    overlay.onclick = (e) => {
        if (e.target === overlay) cleanup();
    };

    addBtn.onclick = () => {
        const items = Array.from(selected);
        onDone(items, currentPath);
        cleanup();
    };

    updateSelectedCount();
    loadPath(currentPath);
}

function ensureUi(node) {
    if (node._loraListUi) return node._loraListUi;

    const root = document.createElement("div");
    root.style.cssText = `
        display:flex;flex-direction:column;width:100%;height:100%;
        box-sizing:border-box;
        background:rgba(40,44,52,0.6);border-radius:6px;
        border:1px solid rgba(255,255,255,0.08);overflow:hidden;
    `;

    const header = document.createElement("div");
    header.style.cssText = `
        display:flex;justify-content:space-between;align-items:center;
        padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.1);
        flex-shrink:0;
    `;
    const title = document.createElement("span");
    title.textContent = "LoRA List";
    title.style.cssText = "font-size:12px;font-weight:bold;color:#aaa;";
    const countLabel = document.createElement("span");
    countLabel.style.cssText = "font-size:10px;color:#666;";
    header.appendChild(title);
    header.appendChild(countLabel);

    const list = document.createElement("div");
    list.style.cssText = `
        flex:1;overflow-y:auto;padding:4px 6px;display:flex;
        flex-direction:column;gap:2px;min-height:0;user-select:none;
    `;
    list.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        return false;
    };

    const footer = document.createElement("div");
    footer.style.cssText = `
        padding:6px 8px;border-top:1px solid rgba(255,255,255,0.1);
        flex-shrink:0;display:flex;gap:6px;
    `;

    const nodeSelectAllWrap = document.createElement("label");
    nodeSelectAllWrap.style.cssText = "display:flex;align-items:center;gap:5px;color:rgba(255,255,255,0.65);font-size:11px;user-select:none;padding:0 4px;";
    const nodeSelectAllToggle = document.createElement("input");
    nodeSelectAllToggle.type = "checkbox";
    const nodeSelectAllText = document.createElement("span");
    nodeSelectAllText.textContent = "All";
    nodeSelectAllWrap.appendChild(nodeSelectAllToggle);
    nodeSelectAllWrap.appendChild(nodeSelectAllText);

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add LoRAs";
    addBtn.style.cssText = `
        flex:1;padding:5px 12px;border:none;border-radius:4px;
        font-size:11px;cursor:pointer;
        background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);
        transition:background 0.15s, color 0.15s;
    `;
    addBtn.onmouseenter = () => {
        addBtn.style.background = "rgba(66,153,225,0.25)";
        addBtn.style.color = "rgba(180,220,255,0.95)";
    };
    addBtn.onmouseleave = () => {
        addBtn.style.background = "rgba(255,255,255,0.06)";
        addBtn.style.color = "rgba(255,255,255,0.5)";
    };

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear All";
    clearBtn.style.cssText = `
        flex:1;padding:5px 12px;border:none;border-radius:4px;
        font-size:11px;cursor:pointer;
        background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);
        transition:background 0.15s, color 0.15s;
    `;
    clearBtn.onmouseenter = () => {
        clearBtn.style.background = "rgba(200,60,60,0.25)";
        clearBtn.style.color = "rgba(255,130,130,0.9)";
    };
    clearBtn.onmouseleave = () => {
        clearBtn.style.background = "rgba(255,255,255,0.06)";
        clearBtn.style.color = "rgba(255,255,255,0.5)";
    };

    footer.appendChild(nodeSelectAllWrap);
    footer.appendChild(addBtn);
    footer.appendChild(clearBtn);

    root.appendChild(header);
    root.appendChild(list);
    root.appendChild(footer);

    const ui = {
        root,
        list,
        countLabel,
        addBtn,
        clearBtn,
        nodeSelectAllToggle,
        items: [],
        lastPath: "",
        dragIndex: null,
        dragOverIndex: null,
        enableDragActive: false,
        enableDragValue: true,
    };

    node._loraListUi = ui;
    return ui;
}

function syncNode(node) {
    const ui = node._loraListUi;
    if (!ui) return;

    const stateWidget = getWidget(node, "loras_state");
    const textWidget = getWidget(node, "loras_text");

    const compact = ui.items.map((x) => ({ path: x.path, enabled: x.enabled !== false }));
    const enabledLines = compact.filter((x) => x.enabled).map((x) => x.path);

    const stateValue = JSON.stringify(compact);
    const textValue = enabledLines.join("\n");

    if (stateWidget) stateWidget.value = stateValue;
    if (textWidget) textWidget.value = textValue;

    node.properties = node.properties || {};
    node.properties.fb_lora_list = {
        items: compact,
        last_path: ui.lastPath || "",
    };

    node.setDirtyCanvas?.(true, true);
}

function renderList(node) {
    const ui = node._loraListUi;
    if (!ui) return;

    const updateHeaderAndToggle = () => {
        const enabled = ui.items.filter((e) => e.enabled !== false).length;
        const total = ui.items.length;
        ui.countLabel.textContent = total > 0 ? `${enabled}/${total} enabled` : "";
        if (!total) {
            ui.nodeSelectAllToggle.checked = false;
            ui.nodeSelectAllToggle.indeterminate = false;
        } else if (enabled === 0) {
            ui.nodeSelectAllToggle.checked = false;
            ui.nodeSelectAllToggle.indeterminate = false;
        } else if (enabled === total) {
            ui.nodeSelectAllToggle.checked = true;
            ui.nodeSelectAllToggle.indeterminate = false;
        } else {
            ui.nodeSelectAllToggle.checked = false;
            ui.nodeSelectAllToggle.indeterminate = true;
        }
    };

    const getRowColors = (isEnabled) => ({
        bg: isEnabled ? "rgba(50, 112, 163, 0.35)" : "rgba(45, 55, 72, 0.5)",
        border: isEnabled ? "rgba(66, 153, 225, 0.4)" : "rgba(226, 232, 240, 0.1)",
        text: isEnabled ? "rgba(226, 232, 240, 0.95)" : "rgba(226, 232, 240, 0.4)",
    });

    const applyRowState = (row, isEnabled) => {
        const c = getRowColors(isEnabled);
        row.dataset.enabled = isEnabled ? "1" : "0";
        row.style.background = c.bg;
        row.style.borderColor = c.border;
        const name = row.querySelector(".lora-name");
        if (name) name.style.color = c.text;
    };

    const setEnabledAt = (idx, value) => {
        if (idx < 0 || idx >= ui.items.length) return;
        ui.items[idx].enabled = value;
        const row = ui.list.querySelector(`[data-clip-idx="${idx}"]`);
        if (row) applyRowState(row, value);
        updateHeaderAndToggle();
        syncNode(node);
    };

    const stopEnableDrag = () => {
        ui.enableDragActive = false;
        document.removeEventListener("mouseup", stopEnableDrag);
    };

    const startEnableDrag = (idx) => {
        ui.enableDragActive = true;
        ui.enableDragValue = !(ui.items[idx]?.enabled !== false);
        setEnabledAt(idx, ui.enableDragValue);
        document.addEventListener("mouseup", stopEnableDrag);
    };

    ui.list.innerHTML = "";
    updateHeaderAndToggle();

    if (!ui.items.length) {
        const hint = document.createElement("div");
        hint.textContent = "No LoRAs added. Use Add LoRAs to add files.";
        hint.style.cssText = "color:#888;font-size:11px;text-align:center;padding:8px;";
        ui.list.appendChild(hint);
        node.setDirtyCanvas?.(true, true);
        syncNode(node);
        return;
    }

    const moveItem = (from, to) => {
        if (from < 0 || to < 0 || from === to || from >= ui.items.length || to >= ui.items.length) return;
        const [item] = ui.items.splice(from, 1);
        ui.items.splice(to, 0, item);
        renderList(node);
    };

    ui.items.forEach((item, idx) => {
        const isEnabled = item.enabled !== false;
        const colors = getRowColors(isEnabled);

        const row = document.createElement("div");
        row.dataset.clipIdx = idx;
        row.dataset.enabled = isEnabled ? "1" : "0";
        row.style.cssText = `
            display:flex;align-items:center;gap:4px;padding:3px 4px;
            background:${colors.bg};border-radius:4px;
            border:1px solid ${colors.border};
            font-size:11px;color:${colors.text};min-height:24px;
            transition:background 0.15s ease, border-color 0.15s ease;
        `;
        row.title = item.path;

        const handle = document.createElement("div");
        handle.title = "Drag to reorder";
        handle.style.cssText = `
            flex-shrink:0;width:16px;height:20px;cursor:grab;
            display:flex;align-items:center;justify-content:center;
            color:rgba(255,255,255,0.3);font-size:14px;user-select:none;
        `;
        handle.textContent = "\u2630";
        handle.onmouseenter = () => { handle.style.color = "rgba(66,153,225,0.9)"; };
        handle.onmouseleave = () => { handle.style.color = "rgba(255,255,255,0.3)"; };

        handle.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            ui.dragIndex = idx;
            row.style.opacity = "0.5";
            handle.style.cursor = "grabbing";

            const onMouseMove = (me) => {
                const rows = ui.list.querySelectorAll("[data-clip-idx]");
                let overIdx = null;
                rows.forEach((r) => {
                    const rect = r.getBoundingClientRect();
                    if (me.clientY >= rect.top && me.clientY <= rect.bottom) {
                        overIdx = parseInt(r.dataset.clipIdx, 10);
                    }
                });
                if (overIdx !== null && overIdx !== ui.dragIndex) {
                    rows.forEach((r) => {
                        const ri = parseInt(r.dataset.clipIdx, 10);
                        r.style.borderTop = ri === overIdx && overIdx < ui.dragIndex
                            ? "2px solid rgba(66,153,225,0.9)" : "";
                        r.style.borderBottom = ri === overIdx && overIdx > ui.dragIndex
                            ? "2px solid rgba(66,153,225,0.9)" : "";
                    });
                    ui.dragOverIndex = overIdx;
                } else if (overIdx === ui.dragIndex) {
                    // Dragged back to original slot — cancel the pending drop.
                    rows.forEach((r) => { r.style.borderTop = ""; r.style.borderBottom = ""; });
                    ui.dragOverIndex = null;
                }
            };

            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                row.style.opacity = "1";
                handle.style.cursor = "grab";

                if (ui.dragOverIndex !== null && ui.dragOverIndex !== ui.dragIndex) {
                    const [moved] = ui.items.splice(ui.dragIndex, 1);
                    ui.items.splice(ui.dragOverIndex, 0, moved);
                    renderList(node);
                } else {
                    const rows = ui.list.querySelectorAll("[data-clip-idx]");
                    rows.forEach((r) => {
                        r.style.borderTop = "";
                        r.style.borderBottom = "";
                    });
                }
                ui.dragIndex = null;
                ui.dragOverIndex = null;
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        };

        const textWrap = document.createElement("div");
        textWrap.style.cssText = "flex:1;min-width:0;";
        textWrap.title = item.path;

        const name = document.createElement("div");
        name.className = "lora-name";
        name.textContent = basename(item.path);
        name.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;color:${colors.text};cursor:default;font-size:11px;`;
        name.title = item.path;

        textWrap.appendChild(name);

        const remove = document.createElement("button");
        remove.textContent = "\u2715";
        remove.title = "Remove";
        remove.style.cssText = `
            background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;
            font-size:10px;padding:0 3px;width:18px;height:18px;flex-shrink:0;
            display:flex;align-items:center;justify-content:center;border-radius:3px;
            transition:color 0.15s, background 0.15s;
        `;
        remove.onmouseenter = () => {
            remove.style.color = "#f66";
            remove.style.background = "rgba(255,100,100,0.15)";
        };
        remove.onmouseleave = () => {
            remove.style.color = "rgba(255,100,100,0.6)";
            remove.style.background = "none";
        };
        remove.onclick = () => {
            ui.items.splice(idx, 1);
            renderList(node);
        };

        row.appendChild(handle);
        row.appendChild(textWrap);
        row.appendChild(remove);

        row.onmouseenter = () => {
            if (ui.enableDragActive) {
                setEnabledAt(idx, ui.enableDragValue);
                return;
            }
            if (ui.dragIndex === null) {
                const enabled = row.dataset.enabled === "1";
                row.style.background = enabled ? "rgba(50, 112, 163, 0.55)" : "rgba(50, 112, 163, 0.25)";
                row.style.borderColor = "rgba(66, 153, 225, 0.6)";
            }
        };
        row.onmouseleave = () => {
            if (ui.dragIndex === null) {
                const enabled = row.dataset.enabled === "1";
                const c = getRowColors(enabled);
                row.style.background = c.bg;
                row.style.borderColor = c.border;
            }
        };

        row.onmousedown = (e) => {
            if (e.button !== 0) return;
            if (e.target === handle || e.target === remove) return;
            e.preventDefault();
            startEnableDrag(idx);
        };

        ui.list.appendChild(row);
    });

    ui.nodeSelectAllToggle.onchange = () => {
        const next = !!ui.nodeSelectAllToggle.checked;
        ui.items.forEach((_, i) => {
            ui.items[i].enabled = next;
        });
        renderList(node);
    };

    node.setDirtyCanvas?.(true, true);
    syncNode(node);
}

app.registerExtension({
    name: "FBnodes.LoraListPlus",
    settings: [
        {
            id: SETTING_DEFAULT_PATH,
            category: ["FBnodes", "2. LoRA List", "1. Default LoRA Path"],
            name: "Default LoRA List Path",
            tooltip: "Starting folder for the LoRA browser. Leave empty to use ComfyUI's default LoRA folder.",
            type: "text",
            defaultValue: "",
        },
    ],
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "LoraListPlus") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            const ui = ensureUi(this);

            const stateWidget = getWidget(this, "loras_state");
            const textWidget = getWidget(this, "loras_text");
            hideWidget(stateWidget);
            hideWidget(textWidget);

            let initial = parseState(stateWidget?.value || "[]");
            if (!initial.length) {
                const propState = this.properties?.fb_lora_list?.items;
                if (Array.isArray(propState)) {
                    initial = propState
                        .filter((x) => x && typeof x === "object")
                        .map((x) => ({ path: String(x.path || "").trim(), enabled: x.enabled !== false }))
                        .filter((x) => !!x.path);
                }
            }
            ui.items = initial;
            ui.lastPath = String(this.properties?.fb_lora_list?.last_path || "");

            ui.addBtn.onclick = async () => {
                const startPath = await resolveInitialPath(ui.lastPath);
                openLoraBrowserModal(startPath, (selectedPaths, currentPath) => {
                    ui.lastPath = currentPath || ui.lastPath;
                    const seen = new Set(ui.items.map((x) => x.path));
                    for (const p of selectedPaths) {
                        const path = String(p || "").trim();
                        if (!path || seen.has(path)) continue;
                        ui.items.push({ path, enabled: true });
                        seen.add(path);
                    }
                    renderList(this);
                });
            };

            ui.clearBtn.onclick = () => {
                ui.items = [];
                renderList(this);
            };

            const dom = this.addDOMWidget("lora_list_ui", "customwidget", ui.root, {
                serialize: false,
                hideOnZoom: false,
            });
            dom.computeSize = (width) => {
                const ROW_H = 30;
                const HEADER_FOOTER = 78;
                const visibleRows = 10;
                const h = HEADER_FOOTER + visibleRows * ROW_H;
                return [Math.max(260, width), h];
            };

            this.size = this.size || [320, 320];
            this.size[0] = Math.max(this.size[0], 320);
            this.size[1] = Math.max(this.size[1], 320);

            renderList(this);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            const ui = this._loraListUi;
            if (ui) {
                const stateWidget = getWidget(this, "loras_state");
                const restored = parseState(stateWidget?.value || "[]");
                if (restored.length) ui.items = restored;
                ui.lastPath = String(this.properties?.fb_lora_list?.last_path || ui.lastPath || "");
                renderList(this);
            }
            return r;
        };
    },
});
