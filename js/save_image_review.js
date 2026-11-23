/**
 * Save Image+ review: when the node's `review` is on, the run pauses and the
 * images waiting in temp fill the screen. Click the ones to keep, then Send:
 * the picked ones move to the output folder (none picked sends none). Skip
 * keeps none. When the node's timer runs out, every image is saved.
 *
 * Space shows one image at the full size of the screen (←/→ step through,
 * a click picks it, Space or Esc go back to all of them). Enter sends.
 * Picking pauses the timer: a review in progress is never cut short.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { toast } from "./fbui/comfy.js";
import { button, ICONS } from "./fbui/controls.js";
import { el } from "./fbui/dom.js";
import { ensureKitCss, FONT, RADIUS, RADIUS_CARD, T, Z_MODAL } from "./fbui/theme.js";
import { bestGrid } from "./common/grid_math.js";

const DING_URL = new URL("./audio/ding.mp3", import.meta.url).href;
const CSS_ID = "fbnodes-review-css-v2";
// The screen around the pictures: the panel's column on the left.
const MARGIN = 20;
const PANEL_WIDTH = 220;
const GAP = 10;

let open = null; // the review on screen: { requestId, close }
const queued = []; // reviews announced while another is open

function ensureReviewCss() {
    ensureKitCss();
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-review{position:fixed;inset:0;z-index:${Z_MODAL};background:rgba(5,6,8,.95);font:12px ${FONT};color:${T.inkSoft};user-select:none}
.fbnodes-review-panel{position:absolute;left:${MARGIN}px;top:${MARGIN}px;width:${PANEL_WIDTH}px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid ${T.plateEdge};border-radius:${RADIUS_CARD}px;background:${T.panel};box-shadow:0 12px 40px rgba(0,0,0,.6)}
.fbnodes-review-panel .title{color:${T.ink};font:600 13px ${FONT};overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fbnodes-review-panel .count{color:${T.label};font-variant-numeric:tabular-nums}
.fbnodes-review-panel .count b{color:${T.ink}}
.fbnodes-review-panel .actions{display:flex;gap:6px}
.fbnodes-review-panel .hint{color:${T.faint};font-size:11px;line-height:1.5}
.fbnodes-review-panel kbd{padding:0 4px;border-radius:3px;background:${T.fill};color:${T.label};font:600 10px ${FONT}}
.fbnodes-review-timer{display:flex;align-items:center;justify-content:center;gap:6px;height:26px;border:none;border-radius:999px;background:${T.brandSoft};color:${T.brandInk};font:600 11px ${FONT};font-variant-numeric:tabular-nums;cursor:pointer}
.fbnodes-review-timer:hover{background:${T.brandSoftHover}}
.fbnodes-review-timer.paused{background:${T.fill};color:${T.label}}
.fbnodes-review-timer.urgent{background:${T.warnSoft};color:${T.warnInk}}
.fbnodes-review-timer:disabled{cursor:default}
.fbnodes-review-bar{height:3px;border-radius:2px;background:${T.fill};overflow:hidden}
.fbnodes-review-bar>i{display:block;height:100%;background:${T.brand};transition:width 1s linear}
.fbnodes-review-bar.paused>i{background:${T.switchOff}}
.fbnodes-review-area{position:absolute;top:${MARGIN}px;bottom:${MARGIN}px;left:${MARGIN * 2 + PANEL_WIDTH}px;right:${MARGIN}px;display:grid;gap:${GAP}px;justify-content:center;align-content:center}
.fbnodes-review-pic{position:relative;box-sizing:border-box;border:2px solid ${T.plateEdge};border-radius:${RADIUS}px;background:${T.card};overflow:hidden;cursor:pointer}
.fbnodes-review-pic img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}
.fbnodes-review-pic:hover{border-color:${T.brandInk}}
.fbnodes-review-pic.picked{border-color:${T.brand};box-shadow:0 0 0 2px ${T.brand},0 0 24px rgba(66,153,225,.35)}
.fbnodes-review-pic .badge{position:absolute;left:8px;top:8px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:rgba(10,12,15,.72);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.55);color:${T.ink};font:700 11px ${FONT}}
.fbnodes-review-pic .badge svg{display:none;width:14px;height:14px;stroke-width:2.4}
.fbnodes-review-pic.picked .badge{background:${T.brand};box-shadow:none;color:${T.onBrand}}
.fbnodes-review-pic.picked .badge span{display:none}
.fbnodes-review-pic.picked .badge svg{display:block}
.fbnodes-review-area.single{display:block}
.fbnodes-review-area.single .fbnodes-review-pic{position:absolute;inset:0;margin:auto}
.fbnodes-review-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(16,19,23,.8)}
.fbnodes-review-nav svg{width:20px;height:20px}
.fbnodes-review-where{position:absolute;right:${MARGIN}px;top:${MARGIN}px;padding:3px 9px;border-radius:999px;background:rgba(16,19,23,.85);color:${T.ink};font:600 11px ${FONT};font-variant-numeric:tabular-nums}
`;
    document.head.append(style);
}

function imageUrl(info) {
    const shown = info.preview ?? info;
    const params = new URLSearchParams({ filename: shown.filename, type: shown.type || "temp", subfolder: shown.subfolder || "" });
    return api.apiURL(`/view?${params}`);
}

function nodeTitle(nodeId) {
    const node = app.graph?.getNodeById?.(nodeId) ?? app.graph?.getNodeById?.(Number(nodeId));
    return node?.title || "Save Image+";
}

async function answer(requestId, body) {
    try {
        const response = await api.fetchApi("/fbnodes/save-image/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ request_id: requestId, ...body }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

const formatTime = (seconds) => {
    const total = Math.max(0, Math.ceil(seconds));
    return total >= 60 ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}` : `${total}s`;
};

function showReview(detail) {
    ensureReviewCss();
    const requestId = String(detail.request_id);
    const images = Array.isArray(detail.images) ? detail.images : [];
    const timeout = Math.max(0, Number(detail.timeout) || 0);
    const picked = new Set();
    let single = -1; // the image shown alone, or -1 for all of them
    let hovered = 0;
    let finished = false;

    const root = el("div", "fbnodes-review");
    const area = el("div", "fbnodes-review-area");

    // ---- the floating panel
    const panel = el("div", "fbnodes-review-panel");
    const title = el("div", "title", nodeTitle(detail.node_id));
    const count = el("div", "count");
    const timerPill = el("button", "fbnodes-review-timer");
    timerPill.type = "button";
    const bar = el("div", "fbnodes-review-bar");
    const barFill = el("i");
    bar.append(barFill);
    const skip = button("Skip", { grow: true, title: "Keep none of them", onClick: () => finish({ action: "skip" }) });
    const send = button("Send", { grow: true, primary: true, title: "Save the picked images (Enter)", onClick: () => finish({ action: "save", indices: [...picked].sort((a, b) => a - b) }) });
    const actions = el("div", "actions");
    actions.append(skip, send);
    const hint = el("div", "hint");
    hint.innerHTML = "Click to pick · <kbd>Space</kbd> one at a time · <kbd>←</kbd><kbd>→</kbd> step · <kbd>Enter</kbd> send";
    panel.append(title, count, timerPill, bar, actions, hint);

    // ---- the pictures
    const pics = images.map((info, index) => {
        const pic = el("div", "fbnodes-review-pic");
        const img = el("img");
        img.src = imageUrl(info);
        img.decoding = "async";
        img.addEventListener("load", layout);
        const badge = el("span", "badge");
        badge.append(el("span", "", String(index + 1)));
        badge.insertAdjacentHTML("beforeend", ICONS.check);
        pic.append(img, badge);
        pic.addEventListener("click", () => toggle(index));
        pic.addEventListener("pointerenter", () => { hovered = index; });
        return { pic, img };
    });
    area.append(...pics.map((entry) => entry.pic));

    const prev = button("", { icon: ICONS.chevronLeft, title: "Previous (←)", onClick: () => showSingle(single - 1) });
    const next = button("", { icon: ICONS.chevronRight, title: "Next (→)", onClick: () => showSingle(single + 1) });
    prev.classList.add("fbnodes-review-nav");
    next.classList.add("fbnodes-review-nav");
    prev.style.left = `${MARGIN * 2 + PANEL_WIDTH + 8}px`;
    next.style.right = `${MARGIN + 8}px`;
    const where = el("div", "fbnodes-review-where");
    root.append(area, prev, next, where, panel);
    document.body.append(root);

    // All of them as large as the screen allows, or one at the full size.
    function layout() {
        const first = pics.find((entry) => entry.img.naturalWidth)?.img;
        if (!first) return;
        const boxW = area.clientWidth;
        const boxH = area.clientHeight;
        if (single >= 0) {
            const img = pics[single].img;
            const w = img.naturalWidth || first.naturalWidth;
            const h = img.naturalHeight || first.naturalHeight;
            const scale = Math.min(boxW / w, boxH / h);
            pics[single].pic.style.width = `${w * scale}px`;
            pics[single].pic.style.height = `${h * scale}px`;
            return;
        }
        const fit = bestGrid(images.length, first.naturalWidth, first.naturalHeight, boxW, boxH, GAP);
        area.style.gridTemplateColumns = `repeat(${fit.columns}, ${Math.floor(fit.width)}px)`;
        area.style.gridTemplateRows = `repeat(${fit.rows}, ${Math.floor(fit.height)}px)`;
        for (const entry of pics) entry.pic.style.width = entry.pic.style.height = "";
    }

    function refresh() {
        pics.forEach((entry, index) => {
            entry.pic.classList.toggle("picked", picked.has(index));
            entry.pic.hidden = single >= 0 && index !== single;
        });
        area.classList.toggle("single", single >= 0);
        prev.hidden = next.hidden = where.hidden = single < 0 || images.length < 2;
        where.textContent = `${single + 1} / ${images.length}`;
        count.innerHTML = `<b>${picked.size}</b> of ${images.length} picked`;
        layout();
    }

    function toggle(index) {
        if (index < 0 || index >= images.length) return;
        if (picked.has(index)) picked.delete(index);
        else picked.add(index);
        pauseTimer();
        refresh();
    }

    function showSingle(index) {
        single = images.length ? (index + images.length) % images.length : -1;
        pauseTimer();
        refresh();
    }

    function showAll() {
        single = -1;
        refresh();
    }

    function close() {
        clearInterval(ticker);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", layout);
        root.remove();
        open = null;
        const nextReview = queued.shift();
        if (nextReview) showReview(nextReview);
    }

    async function finish(body) {
        if (finished) return;
        finished = true;
        skip.disabled = send.disabled = true;
        if (!(await answer(requestId, body))) toast("This review had already ended.", { severity: "warn" });
        close();
    }

    // ---- timer
    let remaining = timeout;
    let paused = timeout === 0;
    const ticker = setInterval(() => {
        if (paused || finished) return;
        remaining -= 1;
        showTimer();
    }, 1000);

    function showTimer() {
        if (timeout === 0) {
            timerPill.innerHTML = `${ICONS.timer}<span>No time limit</span>`;
            timerPill.disabled = true;
            bar.hidden = true;
            return;
        }
        timerPill.classList.toggle("paused", paused);
        timerPill.classList.toggle("urgent", !paused && remaining <= 10);
        bar.classList.toggle("paused", paused);
        timerPill.innerHTML = paused
            ? `${ICONS.play}<span>Paused · ${formatTime(remaining)} left</span>`
            : `${ICONS.pause}<span>Saving all in ${formatTime(remaining)}</span>`;
        timerPill.title = paused ? "Resume the countdown" : "Pause the countdown (picking pauses it too)";
        barFill.style.width = `${Math.max(0, Math.min(100, (remaining / timeout) * 100))}%`;
    }

    function pauseTimer() {
        if (paused || timeout === 0) return;
        paused = true;
        answer(requestId, { action: "pause" });
        showTimer();
    }

    timerPill.addEventListener("click", () => {
        if (!paused) return pauseTimer();
        paused = false;
        answer(requestId, { action: "resume", seconds: remaining });
        showTimer();
    });

    // ---- keys
    function onKey(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        let handled = true;
        if (key === " ") {
            if (single >= 0) showAll();
            else showSingle(hovered);
        } else if (key === "Escape" && single >= 0) showAll();
        else if (key === "ArrowLeft" || key === "ArrowRight") showSingle((single >= 0 ? single : hovered) + (key === "ArrowRight" ? 1 : -1));
        else if (key === "Enter") send.click();
        else if (/^[1-9]$/.test(key)) toggle(Number(key) - 1);
        else handled = key === "Escape";
        // Keys never reach the canvas while the review is up.
        event.stopPropagation();
        if (handled) event.preventDefault();
    }
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", layout);

    open = { requestId, close };
    refresh();
    showTimer();
    new Audio(DING_URL).play().catch(() => {});
}

app.registerExtension({
    name: "FBnodes.SaveImageReview",
    setup() {
        api.addEventListener("fbnodes.save_image.review", (event) => {
            const detail = event.detail ?? {};
            if (!detail.request_id) return;
            if (open) queued.push(detail);
            else showReview(detail);
        });
        // The run ended the review itself: timed out, or the queue was cancelled.
        api.addEventListener("fbnodes.save_image.review_done", (event) => {
            const { request_id: requestId, outcome } = event.detail ?? {};
            const index = queued.findIndex((detail) => String(detail.request_id) === String(requestId));
            if (index >= 0) queued.splice(index, 1);
            if (open?.requestId !== String(requestId)) return;
            open.close();
            if (outcome === "timeout") toast("Review timed out: every image was saved.");
            else if (outcome === "interrupted") toast("Review cancelled with the run.", { severity: "warn" });
        });
    },
});
