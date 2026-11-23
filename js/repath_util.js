import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { button as kitButton } from "./fbui/controls.js";
import { el } from "./fbui/dom.js";
import { openModal } from "./fbui/modal.js";
import { MONO, T } from "./fbui/theme.js";

const BUTTON_ID = "fbnodes-repath-missing-assets-btn";
const COMFY_MENU_MODE_KEY = "Comfy.UseNewMenu";
const MENU_MODE_DISABLED = "Disabled";
const SEARCH_ICON_URL = new URL("./search.png", import.meta.url).href;
const SETUP_GUARD_KEY = "__fbnodesRepathSetupDone";
const BUTTON_SINGLETON_KEY = "__fbnodesRepathButton";

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

    const triggerWidgetRefresh = (node, widget, oldValue, newValue) => {
        try {
            if (typeof widget?.callback === "function") {
                widget.callback.call(widget, newValue, app.canvas, node, null, null);
            }
        } catch (err) {
            console.warn("[FBnodes] Repath widget callback failed", {
                nodeId: node?.id,
                widget: widget?.name,
                error: err,
            });
        }

        try {
            if (typeof node?.onWidgetChanged === "function") {
                node.onWidgetChanged(widget?.name, newValue, oldValue, widget);
            }
        } catch (err) {
            console.warn("[FBnodes] Repath onWidgetChanged failed", {
                nodeId: node?.id,
                widget: widget?.name,
                error: err,
            });
        }

        try {
            node?.graph?.change?.();
        } catch (err) {
            // no-op
        }
    };

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
            triggerWidgetRefresh(node, widget, currentValue, widget.value);
        } else {
            if (typeof widget.value !== "string") continue;
            if (widget.value === update.new_value) continue;

            const oldValue = widget.value;
            widget.value = update.new_value;
            triggerWidgetRefresh(node, widget, oldValue, update.new_value);
        }

        node.setDirtyCanvas?.(true, true);
        applied += 1;
    }

    app.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    return applied;
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

// The result: counts, then the models still missing or ambiguous.
function showSummary(result, appliedCount) {
    const stats = result?.stats || {};
    const unresolved = (result?.updates || []).filter((u) => u.status === "unresolved" || u.status === "ambiguous");

    const counts = el("div");
    counts.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-variant-numeric:tabular-nums";
    for (const [label, value] of [
        ["Scanned", stats.scanned], ["Remapped", stats.remapped], ["Applied", appliedCount],
        ["Unchanged", stats.unchanged], ["Unresolved", stats.unresolved], ["Ambiguous", stats.ambiguous],
    ]) {
        const line = el("div", "", `${label} `);
        line.style.color = T.label;
        const number = el("b", "", String(value || 0));
        number.style.color = T.ink;
        line.append(number);
        counts.append(line);
    }
    const body = [counts];

    if (unresolved.length) {
        const details = el("details");
        details.style.cssText = `margin-top:12px;padding-top:8px;border-top:1px solid ${T.plateEdge}`;
        const toggle = el("summary", "", `Unresolved or ambiguous (${unresolved.length})`);
        toggle.style.cssText = `cursor:pointer;color:${T.brandInk};font-weight:600`;
        const list = el("div");
        list.style.cssText = `display:flex;flex-direction:column;gap:3px;margin-top:6px;font:12px ${MONO};color:${T.inkSoft}`;
        for (const item of unresolved.slice(0, 50)) {
            list.append(el("div", "", `#${item.node_id} ${item.widget_name}: ${item.old_value}${item.reason ? ` (${item.reason})` : ""}`));
        }
        if (unresolved.length > 50) list.append(el("div", "", `… ${unresolved.length - 50} more`));
        details.append(toggle, list);
        body.push(details);
    }

    const dialog = openModal({
        title: unresolved.length ? "Missing model remap" : "All paths resolved",
        body,
        footer: kitButton("Close", { primary: true, onClick: () => dialog.close() }),
        width: 520,
    });
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
    let button = null;

    if (globalThis[BUTTON_SINGLETON_KEY] instanceof HTMLElement) {
        button = globalThis[BUTTON_SINGLETON_KEY];
    }

    if (!button) {
        button = dedupeTopBarButtons() || document.getElementById(BUTTON_ID);
    }

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

    globalThis[BUTTON_SINGLETON_KEY] = button;

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
