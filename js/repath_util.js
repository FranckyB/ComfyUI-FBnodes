import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BUTTON_ID = "fbnodes-repath-missing-assets-btn";
const SUMMARY_ID = "fbnodes-repath-summary";
const SUMMARY_BACKDROP_ID = "fbnodes-repath-summary-backdrop";
const COMFY_MENU_MODE_KEY = "Comfy.UseNewMenu";
const MENU_MODE_DISABLED = "Disabled";
const SEARCH_ICON_URL = new URL("./search.png", import.meta.url).href;
const SETUP_GUARD_KEY = "__fbnodesRepathSetupDone";

function dedupeTopBarButtons() {
    const all = Array.from(document.querySelectorAll(`#${BUTTON_ID}, [data-fbnodes-repath-btn="1"]`));
    if (all.length <= 1) {
        return all[0] || null;
    }

    const keep = all[0];
    for (let i = 1; i < all.length; i++) {
        all[i].remove();
    }
    return keep;
}

function placeButtonByMenuMode(button) {
    const menuMode = app.extensionManager?.setting?.get?.(COMFY_MENU_MODE_KEY);

    if (menuMode === MENU_MODE_DISABLED) {
        const queueBtn = document.getElementById("queue-button");
        if (queueBtn) {
            queueBtn.insertAdjacentElement("afterend", button);
            return true;
        }
    }

    const settingsGroup = app.menu?.settingsGroup?.element;
    if (settingsGroup?.parentElement) {
        settingsGroup.before(button);
        return true;
    }

    // Last-resort fallback for unusual layouts.
    if (document.body) {
        document.body.appendChild(button);
        button.style.position = "fixed";
        button.style.top = "12px";
        button.style.right = "12px";
        button.style.zIndex = "10030";
        return true;
    }

    return false;
}

function matchToolbarButtonGeometry(button) {
    const parent = button?.parentElement;
    if (!parent) return;

    const candidates = Array.from(parent.querySelectorAll("button"))
        .filter((el) => el !== button && el.offsetParent !== null)
        .map((el) => ({
            el,
            rect: el.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.width >= 20 && rect.width <= 40 && rect.height >= 20 && rect.height <= 40);

    if (candidates.length === 0) return;

    const best = candidates.sort((a, b) => a.rect.width - b.rect.width)[0].el;
    const styles = getComputedStyle(best);

    const w = styles.width;
    const h = styles.height;

    button.style.width = w;
    button.style.minWidth = w;
    button.style.maxWidth = w;
    button.style.height = h;
    button.style.minHeight = h;
    button.style.maxHeight = h;
    button.style.flex = `0 0 ${w}`;
    button.style.marginTop = styles.marginTop;
    button.style.marginBottom = styles.marginBottom;
    button.style.borderRadius = styles.borderRadius;
    // Keep icon buttons flush so custom bitmap icons can fill the control.
    button.style.padding = "0";
}

function getGraphNodes(graph) {
    return graph?._nodes || graph?.nodes || [];
}

function walkGraphNodes(graph, visit, seenGraphs = new Set()) {
    if (!graph || seenGraphs.has(graph)) {
        return;
    }

    seenGraphs.add(graph);

    for (const node of getGraphNodes(graph)) {
        if (!node) continue;
        visit(node);

        if (node.subgraph && typeof node.subgraph === "object") {
            walkGraphNodes(node.subgraph, visit, seenGraphs);
        }
    }
}

function findNodeByIdAnyGraph(nodeId) {
    let found = null;
    const targetId = String(nodeId);

    walkGraphNodes(app.graph, (node) => {
        if (found) return;
        if (String(node.id) === targetId) {
            found = node;
        }
    });

    return found;
}

function collectGraphWidgets() {
    const result = [];

    walkGraphNodes(app.graph, (node) => {
        const widgets = [];
        for (const widget of node.widgets || []) {
            if (!widget || typeof widget.name !== "string") continue;
            if (typeof widget.value === "string") {
                const value = widget.value.trim();
                if (!value) continue;

                widgets.push({
                    name: widget.name,
                    value,
                });
                continue;
            }

            // Support object-based widgets used by some nodes (e.g., rgthree Power Lora Loader).
            if (widget.value && typeof widget.value === "object" && typeof widget.value.lora === "string") {
                const loraValue = widget.value.lora.trim();
                if (!loraValue) continue;

                widgets.push({
                    name: widget.name,
                    value: loraValue,
                    value_field: "lora",
                });
            }
        }

        if (widgets.length > 0) {
            result.push({
                id: node.id,
                type: node.type || "",
                widgets,
            });
        }
    });

    return result;
}

function applyRemaps(updates) {
    let applied = 0;

    for (const update of updates || []) {
        if (!Object.prototype.hasOwnProperty.call(update, "new_value")) continue;

        const node = findNodeByIdAnyGraph(update.node_id) || app.graph?.getNodeById(update.node_id);
        if (!node || !Array.isArray(node.widgets)) continue;

        const widget = node.widgets.find((w) => w?.name === update.widget_name);
        if (!widget) continue;

        const valueField = typeof update.value_field === "string" ? update.value_field : null;

        if (valueField) {
            if (!widget.value || typeof widget.value !== "object") continue;

            const currentValue = widget.value[valueField];
            if (typeof currentValue !== "string") continue;
            if (currentValue === update.new_value) continue;

            widget.value[valueField] = update.new_value;
        } else {
            if (typeof widget.value !== "string") continue;
            if (widget.value === update.new_value) continue;

            widget.value = update.new_value;
        }

        node.setDirtyCanvas?.(true, true);
        applied += 1;
    }

    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    return applied;
}

function removeExistingSummary() {
    const existing = document.getElementById(SUMMARY_ID);
    if (existing) {
        existing.remove();
    }

    const backdrop = document.getElementById(SUMMARY_BACKDROP_ID);
    if (backdrop) {
        backdrop.remove();
    }
}

function makeDraggable(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseMove = (event) => {
        if (!dragging) return;

        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);

        const nextLeft = Math.min(Math.max(0, event.clientX - offsetX), maxLeft);
        const nextTop = Math.min(Math.max(0, event.clientY - offsetY), maxTop);

        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
    };

    const onMouseUp = () => {
        dragging = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    };

    handle.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;

        event.preventDefault();
        const rect = panel.getBoundingClientRect();

        dragging = true;
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;

        panel.style.transform = "none";
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    });
}

function setButtonBusy(button, busy) {
    if (!button) return;
    button.dataset.busy = busy ? "1" : "0";
    button.disabled = busy;
    button.style.opacity = busy ? "0.7" : "1";
    if (busy) {
        button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="display:block;animation:fbnodes-spin 1s linear infinite"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2z"/></svg>`;
        return;
    }

    button.innerHTML = `<img src="${SEARCH_ICON_URL}" alt="" aria-hidden="true" style="display:block;width:100%;height:100%;object-fit:cover;border-radius:2px;"/>`;
    button.style.borderColor = "rgba(255,255,255,0.22)";
    button.style.background = "rgba(42, 118, 170, 0.35)";
    button.title = "Find and remap missing model paths";
}

function ensureStyles() {
    if (document.getElementById("fbnodes-repath-style")) {
        return;
    }

    const style = document.createElement("style");
    style.id = "fbnodes-repath-style";
    style.textContent = `
@keyframes fbnodes-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}`;
    document.head.appendChild(style);
}

function showSummary(result, appliedCount) {
    removeExistingSummary();

    const stats = result?.stats || {};
    const unresolved = (result?.updates || []).filter(
        (u) => u.status === "unresolved" || u.status === "ambiguous"
    );
    const allResolved = unresolved.length === 0;

    const backdrop = document.createElement("div");
    backdrop.id = SUMMARY_BACKDROP_ID;
    backdrop.style.cssText = [
        "position: fixed",
        "inset: 0",
        "z-index: 10039",
        "background: transparent",
    ].join(";");
    backdrop.addEventListener("click", () => removeExistingSummary());

    const wrapper = document.createElement("div");
    wrapper.id = SUMMARY_ID;
    wrapper.style.cssText = [
        "position: fixed",
        "left: 50%",
        "top: 50%",
        "transform: translate(-50%, -50%)",
        "z-index: 10040",
        "background: rgba(26, 30, 38, 0.98)",
        "border: 1px solid rgba(255,255,255,0.12)",
        "border-radius: 10px",
        "box-shadow: 0 10px 30px rgba(0,0,0,0.4)",
        "width: min(560px, calc(100vw - 32px))",
        "max-height: 70vh",
        "color: #d8dde7",
        "font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
    ].join(";");

    const title = document.createElement("div");
    title.style.cssText = "padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); display:flex; justify-content:flex-start; align-items:center; cursor:move; user-select:none;";
    title.innerHTML = allResolved
        ? `<strong style=\"font-size:20px; display:flex; align-items:center; gap:8px;\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path fill=\"#72e6ad\" d=\"M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m4.1 7.8l-4.8 5.6a1 1 0 0 1-1.5.1l-2-2a1 1 0 0 1 1.4-1.4l1.2 1.2l4.1-4.8a1 1 0 0 1 1.5 1.3\"/></svg>All Paths Resolved</strong>`
        : `<strong style=\"font-size:20px\">Missing Model Remap</strong>`;

    const body = document.createElement("div");
    body.style.cssText = "padding: 14px 16px; font-size: 18px; line-height: 1.6; overflow:auto; max-height: calc(70vh - 44px);";

    const lines = [
        `Scanned: ${stats.scanned || 0}`,
        `Remapped: ${stats.remapped || 0}`,
        `Applied: ${appliedCount}`,
        `Unchanged: ${stats.unchanged || 0}`,
        `Unresolved: ${stats.unresolved || 0}`,
        `Ambiguous: ${stats.ambiguous || 0}`,
    ];

    const summary = document.createElement("div");
    summary.style.cssText = "display:grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-bottom: 12px;";
    for (const line of lines) {
        const item = document.createElement("div");
        item.textContent = line;
        item.style.cssText = "font-weight:600; letter-spacing:0.1px;";
        summary.appendChild(item);
    }

    body.appendChild(summary);

    if (unresolved.length > 0) {
        const details = document.createElement("details");
        details.style.cssText = "border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;";

        const summaryEl = document.createElement("summary");
        summaryEl.textContent = `Show unresolved/ambiguous (${unresolved.length})`;
        summaryEl.style.cssText = "cursor:pointer; color:#8fc8ff; margin-bottom:8px; font-weight:600;";
        details.appendChild(summaryEl);

        const list = document.createElement("div");
        list.style.cssText = "display:flex; flex-direction:column; gap:4px;";

        for (const item of unresolved.slice(0, 50)) {
            const row = document.createElement("div");
            const reason = item.reason ? ` (${item.reason})` : "";
            row.textContent = `#${item.node_id} ${item.widget_name}: ${item.old_value}${reason}`;
            row.style.cssText = "color:#d8dde7; font-size:16px; line-height:1.45;";
            list.appendChild(row);
        }

        if (unresolved.length > 50) {
            const more = document.createElement("div");
            more.textContent = `... ${unresolved.length - 50} more`;
            more.style.cssText = "opacity:0.7;";
            list.appendChild(more);
        }

        details.appendChild(list);
        body.appendChild(details);
    }

    document.body.appendChild(backdrop);
    wrapper.appendChild(title);
    wrapper.appendChild(body);
    document.body.appendChild(wrapper);
    makeDraggable(wrapper, title);
}

async function runRemap(button) {
    if (button?.dataset?.busy === "1") {
        return;
    }

    if (button) {
        setButtonBusy(button, true);
    }

    try {
        const nodes = collectGraphWidgets();
        const response = await api.fetchApi("/fbnodes/remap_missing_assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodes }),
        });

        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        const result = await response.json();
        if (!result?.success) {
            throw new Error(result?.error || "Unknown remap error");
        }

        const applied = applyRemaps(result.updates);
        showSummary(result, applied);
    } catch (err) {
        console.error("[FBnodes] Remap failed:", err);
        showSummary(
            {
                stats: { scanned: 0, remapped: 0, unchanged: 0, unresolved: 0, ambiguous: 0 },
                updates: [
                    {
                        status: "unresolved",
                        node_id: "-",
                        widget_name: "error",
                        old_value: String(err),
                        reason: "request_failed",
                    },
                ],
            },
            0
        );
    } finally {
        if (button) {
            setButtonBusy(button, false);
        }
    }
}

function ensureTopBarButton() {
    let button = dedupeTopBarButtons() || document.getElementById(BUTTON_ID);

    if (!button) {
        button = document.createElement("button");
        button.id = BUTTON_ID;
        button.dataset.fbnodesRepathBtn = "1";
        button.type = "button";
        button.title = "Find and remap missing model paths";
        button.ariaLabel = "Find and remap missing model paths";
        button.style.cssText = [
            "margin-left: -4px",
            "margin-top: 0",
            "width: 30px",
            "min-width: 30px",
            "max-width: 30px",
            "height: 30px",
            "min-height: 30px",
            "max-height: 30px",
            "padding: 0",
            "border-radius: 6px",
            "border: 1px solid rgba(255,255,255,0.22)",
            "background: rgba(42, 118, 170, 0.35)",
            "color: #d7ecff",
            "display: inline-flex",
            "flex: 0 0 30px",
            "align-items: center",
            "justify-content: center",
            "align-self: center",
            "cursor: pointer",
        ].join(";");

        button.addEventListener("click", () => runRemap(button));
        setButtonBusy(button, false);
    }

    const attached = placeButtonByMenuMode(button);
    if (attached) {
        dedupeTopBarButtons();
        matchToolbarButtonGeometry(button);
        console.log("[FBnodes] Repath button attached", { menuMode: app.extensionManager?.setting?.get?.(COMFY_MENU_MODE_KEY) });
    }
}

app.registerExtension({
    name: "FBnodes.RepathUtil",
    commands: [
        {
            id: "fbnodes.remapMissingModels",
            label: "Remap Missing Models",
            function: () => runRemap(null),
        },
    ],
    menuCommands: [
        {
            path: ["FBnodes"],
            commands: ["fbnodes.remapMissingModels"],
        },
    ],
    async setup() {
        if (globalThis[SETUP_GUARD_KEY]) {
            ensureTopBarButton();
            return;
        }
        globalThis[SETUP_GUARD_KEY] = true;

        console.log("[FBnodes] Repath extension setup");
        ensureStyles();
        const tryAttach = () => {
            ensureTopBarButton();
        };

        tryAttach();

        const observer = new MutationObserver(() => {
            if (!document.getElementById(BUTTON_ID)) {
                tryAttach();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        // Mirror Crystools behavior: move widget if menu mode changes.
        app.ui?.settings?.addEventListener?.(`${COMFY_MENU_MODE_KEY}.change`, () => {
            ensureTopBarButton();
        });

        // Retry periodically because toolbar DOM can be created after extension setup.
        setInterval(() => {
            if (!document.getElementById(BUTTON_ID)) {
                tryAttach();
            }
        }, 1500);
    },
});
