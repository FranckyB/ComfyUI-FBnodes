/**
 * The list the Clip Stitcher, VACE Stitcher and LoRA List+ cards show: files
 * in order, each one on or off. Drag the grip to reorder; press a check (or
 * a name) to switch it and drag across others to set them the same; ✕
 * removes one. The header counts what is on and switches them all; the
 * footer holds the node's own buttons.
 *
 * itemList({ title, empty, label(entry), tooltip?(entry), preview?(entry),
 *            extra?(entry), menu?(entry, index), footer, onChange(entries) })
 *   -> { element, entries, set(entries), refresh(), changed(), status(kind, text) }
 * Entries are plain objects with `enabled`; onChange runs after any edit.
 * preview(entry) gives { url, video?, still? } for the picture shown while
 * the pointer rests on the name (`still`: an image for a video the browser
 * cannot play). menu(entry, index) gives openMenu items for a right-click.
 */

import { ICONS } from "../fbui/controls.js";
import { el } from "../fbui/dom.js";
import { openMenu } from "../fbui/modal.js";
import { FONT, RADIUS, RADIUS_CARD, ROW_HEIGHT, T, Z_MENU } from "../fbui/theme.js";

const CSS_ID = "fbnodes-item-list-css-v1";

function ensureListCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-list{display:flex;flex-direction:column;height:100%;box-sizing:border-box;border:1px solid ${T.plateEdge};border-radius:${RADIUS_CARD}px;background:${T.plate};overflow:hidden;pointer-events:auto;font:12px ${FONT};color:${T.inkSoft}}
.fbnodes-list .head{display:flex;align-items:center;gap:8px;flex:none;height:30px;padding:0 8px 0 10px;border-bottom:1px solid ${T.plateEdge}}
.fbnodes-list .head .title{flex:1;color:${T.label};font:650 10px ${FONT};letter-spacing:.08em;text-transform:uppercase}
.fbnodes-list .head .count{color:${T.faint};font-size:11px;font-variant-numeric:tabular-nums}
.fbnodes-list .items{flex:1;min-height:0;overflow-y:auto;padding:4px;display:flex;flex-direction:column;gap:2px}
.fbnodes-list .empty{margin:auto;padding:12px;color:${T.faint};font-size:11px;text-align:center}
.fbnodes-list .item{position:relative;display:flex;align-items:center;gap:4px;flex:none;height:${ROW_HEIGHT}px;padding:0 2px;border-radius:${RADIUS}px;background:${T.fill}}
.fbnodes-list .item:hover{background:${T.fillHover}}
.fbnodes-list .item.off .name{color:${T.faint}}
.fbnodes-list .item.drop-before{box-shadow:inset 0 2px 0 ${T.brand}}
.fbnodes-list .item.drop-after{box-shadow:inset 0 -2px 0 ${T.brand}}
.fbnodes-list .item.dragging{opacity:.45}
.fbnodes-list .grip{flex:none;display:grid;place-items:center;width:16px;height:100%;color:${T.faint};cursor:grab;touch-action:none}
.fbnodes-list .grip:hover{color:${T.brandInk}}
.fbnodes-list .check{flex:none;display:grid;place-items:center;width:16px;height:16px;padding:0;border:1.5px solid ${T.switchOff};border-radius:4px;background:none;color:${T.onBrand};cursor:pointer}
.fbnodes-list .check svg{width:11px;height:11px;stroke-width:2.4;visibility:hidden}
.fbnodes-list .check.on{border-color:${T.brand};background:${T.brand}}
.fbnodes-list .check.on svg{visibility:visible}
.fbnodes-list .check.some{border-color:${T.brand}}
.fbnodes-list .name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:${T.ink};cursor:pointer;user-select:none}
.fbnodes-list .remove{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:none;border-radius:${RADIUS}px;background:none;color:${T.faint};cursor:pointer}
.fbnodes-list .remove:hover{background:${T.dangerSoft};color:${T.dangerInk}}
.fbnodes-list .remove svg{width:11px;height:11px}
.fbnodes-list .status{flex:none;margin:0 6px 6px;padding:7px 10px;border-radius:${RADIUS}px;background:${T.brandSoft};color:${T.brandInk};font-size:11px;line-height:1.4;white-space:pre-wrap}
.fbnodes-list .status.warn{background:${T.warnSoft};color:${T.warnInk}}
.fbnodes-list .status.error{background:${T.dangerSoft};color:${T.dangerInk}}
.fbnodes-list .foot{display:flex;gap:6px;flex:none;padding:6px;border-top:1px solid ${T.plateEdge}}
.fbnodes-list-preview{position:fixed;z-index:${Z_MENU};padding:4px;border:1px solid ${T.plateEdge};border-radius:${RADIUS_CARD}px;background:${T.panel};box-shadow:0 8px 24px rgba(0,0,0,.55);pointer-events:none}
.fbnodes-list-preview img,.fbnodes-list-preview video{display:block;max-width:320px;max-height:240px;border-radius:${RADIUS}px}
`;
    document.head.append(style);
}

// ---------------------------------------------------------------- preview

let popup = null;

function hidePreview() {
    popup?.remove();
    popup = null;
}

function showPreview({ url, video = false, still = "" }, anchor) {
    hidePreview();
    const box = el("div", "fbnodes-list-preview");
    const rect = anchor.getBoundingClientRect();
    box.style.left = `${rect.left}px`;
    box.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    const showStill = () => {
        if (!still || popup !== box) return;
        const img = el("img");
        img.src = still;
        box.replaceChildren(img);
    };
    if (video) {
        const player = el("video");
        Object.assign(player, { muted: true, autoplay: true, loop: true, playsInline: true, src: url });
        // The browser cannot play it: the backend's first frame instead.
        player.addEventListener("error", showStill);
        box.append(player);
    } else {
        const img = el("img");
        img.src = url;
        box.append(img);
    }
    document.body.append(box);
    popup = box;
}

// ---------------------------------------------------------------- list

export function itemList({ title, empty, label, tooltip = null, preview = null, extra = null, menu = null, footer = [], onChange }) {
    ensureListCss();
    const root = el("div", "fbnodes-list");
    const head = el("div", "head");
    const count = el("span", "count");
    const all = el("button", "check");
    all.type = "button";
    all.title = "Switch all on or off";
    all.innerHTML = ICONS.check;
    head.append(el("span", "title", title), count, all);
    const items = el("div", "items");
    const status = el("div", "status");
    status.hidden = true;
    const foot = el("div", "foot");
    foot.append(...footer);
    root.append(head, items, status, foot);
    // Presses on the rows (toggling, dragging, scrolling) stay out of the graph.
    items.addEventListener("pointerdown", (event) => event.stopPropagation());

    const list = { element: root, entries: [] };
    const changed = () => {
        onChange(list.entries);
        refresh();
    };

    all.addEventListener("click", () => {
        const on = !list.entries.every((entry) => entry.enabled !== false);
        for (const entry of list.entries) entry.enabled = on;
        changed();
    });

    // Press a check and drag across others: they all take its new state.
    let painting = null;
    const stopPainting = () => {
        if (painting === null) return;
        painting = null;
        changed();
    };
    const paint = (entry, row) => {
        entry.enabled = painting;
        row.classList.toggle("off", !painting);
        row.querySelector(".check").classList.toggle("on", painting);
    };

    // Drag a grip: the row moves to where it is dropped.
    function startDrag(event, index, row) {
        event.preventDefault();
        event.stopPropagation();
        const grip = event.currentTarget;
        grip.setPointerCapture(event.pointerId);
        row.classList.add("dragging");
        let target = index;
        const rows = [...items.querySelectorAll(".item")];
        const move = (moveEvent) => {
            const over = rows.findIndex((other) => {
                const box = other.getBoundingClientRect();
                return moveEvent.clientY >= box.top && moveEvent.clientY <= box.bottom;
            });
            if (over < 0) return;
            target = over;
            rows.forEach((other, i) => {
                other.classList.toggle("drop-before", i === target && target < index);
                other.classList.toggle("drop-after", i === target && target > index);
            });
        };
        const end = () => {
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", end);
            grip.removeEventListener("pointercancel", end);
            if (target !== index) {
                const [moved] = list.entries.splice(index, 1);
                list.entries.splice(target, 0, moved);
                changed();
            } else refresh();
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", end);
        grip.addEventListener("pointercancel", end);
    }

    function row(entry, index) {
        const line = el("div", "item");
        line.classList.toggle("off", entry.enabled === false);
        const grip = el("div", "grip");
        grip.innerHTML = ICONS.grip;
        grip.title = "Drag to reorder";
        grip.addEventListener("pointerdown", (event) => startDrag(event, index, line));
        const check = el("button", "check");
        check.type = "button";
        check.innerHTML = ICONS.check;
        check.classList.toggle("on", entry.enabled !== false);
        check.title = "On or off (drag across rows to set several)";
        const name = el("span", "name", label(entry));
        name.title = tooltip?.(entry) ?? "";
        for (const target of [check, name]) {
            target.addEventListener("pointerdown", (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                painting = entry.enabled === false;
                document.addEventListener("pointerup", stopPainting, { once: true });
                paint(entry, line);
            });
            target.addEventListener("pointerenter", () => {
                if (painting !== null) paint(entry, line);
            });
        }
        if (preview) {
            name.addEventListener("pointerenter", () => {
                if (painting === null) showPreview(preview(entry), name);
            });
            name.addEventListener("pointerleave", hidePreview);
        }
        const remove = el("button", "remove");
        remove.type = "button";
        remove.innerHTML = ICONS.close;
        remove.title = "Remove";
        remove.addEventListener("click", () => {
            list.entries.splice(index, 1);
            changed();
        });
        line.append(grip, check, name);
        const marker = extra?.(entry);
        if (marker) line.append(marker);
        line.append(remove);
        if (menu) {
            line.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                hidePreview();
                openMenu(event.clientX, event.clientY, menu(entry, index));
            });
        }
        return line;
    }

    function refresh() {
        hidePreview();
        const on = list.entries.filter((entry) => entry.enabled !== false).length;
        const total = list.entries.length;
        count.textContent = total ? `${on} / ${total} on` : "";
        all.hidden = total === 0;
        all.classList.toggle("on", total > 0 && on === total);
        all.classList.toggle("some", on > 0 && on < total);
        items.replaceChildren(...(total ? list.entries.map(row) : [el("div", "empty", empty)]));
    }

    list.set = (entries) => {
        list.entries = entries;
        refresh();
    };
    list.refresh = refresh;
    list.status = (kind, text) => {
        status.hidden = !text;
        status.className = `status ${kind || ""}`;
        status.textContent = text || "";
    };
    // After the node edits the entries itself (a menu item).
    list.changed = changed;
    return list;
}
