/**
 * Save Image+ review: when the node's `review` is on, the run pauses and
 * this dialog shows the images waiting in temp. Pick the ones to keep; Save
 * moves them to the output folder, Skip leaves them in temp. The node's own
 * timer applies on_timeout ("save all" / "skip all") if nobody answers.
 *
 * Click a picture to pick it, double-click (or its zoom button, or Space)
 * to look at it large. Keys: 1-9 pick, A all, N none, I invert, Enter save,
 * ←/→ and Space in the large view, Escape back to the grid. Picking pauses
 * the timer: a review in progress is never cut short.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { toast } from "./fbui/comfy.mjs";
import { button, ICONS } from "./fbui/controls.mjs";
import { el } from "./fbui/dom.mjs";
import { openModal } from "./fbui/modal.mjs";
import { FONT, RADIUS, RADIUS_CARD, T } from "./fbui/theme.mjs";

const DING_URL = new URL("./audio/ding.mp3", import.meta.url).href;
const CSS_ID = "fbnodes-review-css-v1";

let open = null; // the dialog on screen: { requestId, close }
const queued = []; // reviews announced while another is open

function ensureReviewCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-review .fbui-modal-body{position:relative;display:flex;flex-direction:column;padding:0;overflow:hidden}
.fbnodes-review-bar{flex:none;display:flex;align-items:center;gap:6px;padding:0 12px 8px}
.fbnodes-review-bar .count{min-width:110px;color:${T.label};font:12px ${FONT};font-variant-numeric:tabular-nums}
.fbnodes-review-bar .count b{color:${T.ink}}
.fbnodes-review-bar .spacer{flex:1}
.fbnodes-review-timer{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border:none;border-radius:999px;background:${T.brandSoft};color:${T.brandInk};font:600 11px ${FONT};font-variant-numeric:tabular-nums;cursor:pointer}
.fbnodes-review-timer:hover{background:${T.brandSoftHover}}
.fbnodes-review-timer.paused{background:${T.fill};color:${T.label}}
.fbnodes-review-timer.urgent{background:${T.warnSoft};color:${T.warnInk}}
.fbnodes-review-progress{flex:none;height:2px;margin:0 12px 10px;border-radius:2px;background:${T.fill};overflow:hidden}
.fbnodes-review-progress>i{display:block;height:100%;background:${T.brand};transition:width 1s linear}
.fbnodes-review-progress.paused>i{background:${T.switchOff}}
.fbnodes-review-grid{flex:1 1 auto;min-height:0;overflow:auto;display:grid;gap:12px;padding:2px 12px 12px;align-content:start;grid-template-columns:repeat(auto-fill,minmax(var(--card),1fr))}
.fbnodes-review-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:6px;border:1px solid ${T.plateEdge};border-radius:${RADIUS_CARD}px;background:${T.plate};cursor:pointer;transition:opacity .15s,border-color .15s,box-shadow .15s;user-select:none}
.fbnodes-review-card:hover{border-color:${T.brandInk}}
.fbnodes-review-card .pic{height:var(--pic);border-radius:${RADIUS}px;background:${T.card};display:flex;align-items:center;justify-content:center;overflow:hidden}
.fbnodes-review-card .pic img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}
.fbnodes-review-card .cap{text-align:center;color:${T.faint};font:600 11px ${FONT};font-variant-numeric:tabular-nums}
.fbnodes-review-card .badge{position:absolute;left:12px;top:12px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:rgba(10,12,15,.72);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.55);color:${T.ink};font:700 11px ${FONT}}
.fbnodes-review-card .badge svg{display:none;width:14px;height:14px;stroke-width:2.4}
.fbnodes-review-card .zoom{position:absolute;right:12px;top:12px;opacity:0;transition:opacity .15s;background:rgba(10,12,15,.72)}
.fbnodes-review-card:hover .zoom{opacity:1}
.fbnodes-review-card.picked{border-color:${T.brand};box-shadow:0 0 0 2px ${T.brandSoftHover}}
.fbnodes-review-card.picked .badge{background:${T.brand};box-shadow:none;color:${T.onBrand}}
.fbnodes-review-card.picked .badge span{display:none}
.fbnodes-review-card.picked .badge svg{display:block}
.fbnodes-review-card.picked .cap{color:${T.brandInk}}
.fbnodes-review-grid.has-picks .fbnodes-review-card:not(.picked){opacity:.55}
.fbnodes-review-grid.has-picks .fbnodes-review-card:not(.picked):hover{opacity:.9}
.fbnodes-review-zoom{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;background:${T.panel}}
.fbnodes-review-zoom[hidden]{display:none}
.fbnodes-review-zoom .stage{position:relative;flex:1 1 auto;min-height:0;border:1px solid ${T.plateEdge};border-radius:${RADIUS_CARD}px;background:${T.plate};overflow:hidden}
.fbnodes-review-zoom .stage.picked{border-color:${T.brand};box-shadow:0 0 0 2px ${T.brandSoftHover}}
.fbnodes-review-zoom .stage img{position:absolute;inset:8px;width:calc(100% - 16px);height:calc(100% - 16px);object-fit:contain}
.fbnodes-review-zoom .nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;background:rgba(10,12,15,.72)}
.fbnodes-review-zoom .nav.prev{left:12px}
.fbnodes-review-zoom .nav.next{right:12px}
.fbnodes-review-zoom .nav svg{width:18px;height:18px}
.fbnodes-review-zoom .line{flex:none;display:flex;align-items:center;gap:8px}
.fbnodes-review-zoom .where{min-width:70px;color:${T.label};font:600 12px ${FONT};font-variant-numeric:tabular-nums}
.fbnodes-review-zoom .strip{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;padding:2px}
.fbnodes-review-zoom .strip img{flex:none;width:52px;height:40px;object-fit:cover;border-radius:4px;border:2px solid transparent;opacity:.55;cursor:pointer}
.fbnodes-review-zoom .strip img.picked{opacity:1;border-color:${T.brand}}
.fbnodes-review-zoom .strip img.here{opacity:1;outline:2px solid ${T.ink};outline-offset:1px}
.fbnodes-review .hint{margin-right:auto;align-self:center;color:${T.faint};font:11px ${FONT}}
.fbnodes-review .hint kbd{padding:0 4px;border-radius:3px;background:${T.fill};color:${T.label};font:600 10px ${FONT}}
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
    const saveAll = detail.on_timeout !== "skip all";
    const picked = new Set();
    let finished = false;

    // ---- the bar: count, quick picks, timer
    const count = el("span", "count");
    const pickAll = button("All", { small: true, title: "Pick every image (A)", onClick: () => setPicked(images.map((_, i) => i)) });
    const pickNone = button("None", { small: true, title: "Clear the picks (N)", onClick: () => setPicked([]) });
    const invert = button("Invert", { small: true, title: "Swap picked and not picked (I)", onClick: () => setPicked(images.map((_, i) => i).filter((i) => !picked.has(i))) });
    const timerPill = el("button", "fbnodes-review-timer");
    timerPill.type = "button";
    const bar = el("div", "fbnodes-review-bar");
    bar.append(count, pickAll, pickNone, invert, el("span", "spacer"), timerPill);
    const progress = el("div", "fbnodes-review-progress");
    const progressFill = el("i");
    progress.append(progressFill);

    // ---- the grid
    const grid = el("div", "fbnodes-review-grid");
    // Fewer pictures get bigger cards.
    const size = images.length <= 1 ? [520, "58vh"] : images.length <= 2 ? [380, "52vh"] : images.length <= 6 ? [260, "30vh"] : [200, "22vh"];
    grid.style.setProperty("--card", `${size[0]}px`);
    grid.style.setProperty("--pic", size[1]);
    const cards = images.map((info, index) => {
        const card = el("div", "fbnodes-review-card");
        const pic = el("div", "pic");
        const img = el("img");
        img.src = imageUrl(info);
        img.decoding = "async";
        const cap = el("div", "cap", `#${index + 1}`);
        img.addEventListener("load", () => { cap.textContent = `#${index + 1} · ${img.naturalWidth} × ${img.naturalHeight}`; });
        pic.append(img);
        const badge = el("span", "badge");
        badge.append(el("span", "", String(index + 1)));
        badge.insertAdjacentHTML("beforeend", ICONS.check);
        const zoom = button("", { icon: ICONS.expand, small: true, title: "Look at it large (Space)", onClick: (event) => { event.stopPropagation(); showZoom(index); } });
        zoom.classList.add("zoom");
        card.append(pic, cap, badge, zoom);
        card.addEventListener("click", () => toggle(index));
        card.addEventListener("dblclick", () => showZoom(index));
        card.addEventListener("pointerenter", () => { hovered = index; });
        return card;
    });
    grid.append(...cards);
    let hovered = 0;

    // ---- the large view
    const zoomView = el("div", "fbnodes-review-zoom");
    zoomView.hidden = true;
    const stage = el("div", "stage");
    const stageImg = el("img");
    const prev = button("", { icon: ICONS.chevronLeft, title: "Previous (←)", onClick: () => showZoom(zoomAt - 1) });
    const next = button("", { icon: ICONS.chevronRight, title: "Next (→)", onClick: () => showZoom(zoomAt + 1) });
    prev.classList.add("nav", "prev");
    next.classList.add("nav", "next");
    stage.append(stageImg, prev, next);
    stage.addEventListener("click", (event) => { if (event.target === stage || event.target === stageImg) toggle(zoomAt); });
    const where = el("span", "where");
    const strip = el("div", "strip");
    const thumbs = images.map((info, index) => {
        const thumb = el("img");
        thumb.src = imageUrl(info);
        thumb.title = `#${index + 1}`;
        thumb.addEventListener("click", () => showZoom(index));
        strip.append(thumb);
        return thumb;
    });
    const zoomPick = button("Pick", { icon: ICONS.check, title: "Pick or unpick this image (Space)", onClick: () => toggle(zoomAt) });
    const back = button("Grid", { icon: ICONS.grid, title: "Back to all images (Esc)", onClick: () => hideZoom() });
    const line = el("div", "line");
    line.append(where, strip, zoomPick, back);
    zoomView.append(stage, line);
    let zoomAt = -1;

    // ---- footer
    const hint = el("span", "hint");
    hint.innerHTML = "Click to pick · <kbd>1</kbd>–<kbd>9</kbd> · <kbd>A</kbd> all · <kbd>N</kbd> none · <kbd>Space</kbd> zoom · <kbd>Enter</kbd> save";
    const skip = button("Skip all", { title: "Keep none: the images stay in temp and the run goes on", onClick: () => finish({ action: "skip" }) });
    const save = button("Save", { primary: true, onClick: () => finish(picked.size ? { action: "save", indices: [...picked].sort((a, b) => a - b) } : { action: "skip" }) });

    const dialog = openModal({
        title: `${nodeTitle(detail.node_id)} · pick the images to save`,
        body: [bar, progress, grid, zoomView],
        footer: [hint, skip, save],
        width: "min(1280px, 94vw)",
        height: "min(920px, 90vh)",
        closable: false,
        onClose: () => {
            clearInterval(ticker);
            document.removeEventListener("keydown", onKey, true);
            open = null;
            const nextReview = queued.shift();
            if (nextReview) showReview(nextReview);
        },
    });
    dialog.overlay.classList.add("fbnodes-review");
    dialog.modal.style.maxWidth = "none";
    dialog.modal.style.maxHeight = "none";
    open = { requestId, close: dialog.close };

    // ---- picking
    function refresh() {
        cards.forEach((card, index) => card.classList.toggle("picked", picked.has(index)));
        thumbs.forEach((thumb, index) => thumb.classList.toggle("picked", picked.has(index)));
        grid.classList.toggle("has-picks", picked.size > 0);
        count.innerHTML = `<b>${picked.size}</b> of ${images.length} picked`;
        save.querySelector("span").textContent = picked.size ? `Save ${picked.size}` : "Continue without saving";
        if (zoomAt >= 0) {
            stage.classList.toggle("picked", picked.has(zoomAt));
            zoomPick.querySelector("span").textContent = picked.has(zoomAt) ? "Picked" : "Pick";
            zoomPick.classList.toggle("on", picked.has(zoomAt));
        }
    }

    function setPicked(indices) {
        picked.clear();
        for (const index of indices) picked.add(index);
        pauseTimer();
        refresh();
    }

    function toggle(index) {
        if (index < 0 || index >= images.length) return;
        if (picked.has(index)) picked.delete(index);
        else picked.add(index);
        pauseTimer();
        refresh();
    }

    function showZoom(index) {
        if (!images.length) return;
        zoomAt = (index + images.length) % images.length;
        stageImg.src = imageUrl(images[zoomAt]);
        where.textContent = `${zoomAt + 1} / ${images.length}`;
        thumbs.forEach((thumb, i) => thumb.classList.toggle("here", i === zoomAt));
        thumbs[zoomAt].scrollIntoView({ block: "nearest", inline: "nearest" });
        prev.hidden = next.hidden = images.length < 2;
        zoomView.hidden = false;
        pauseTimer();
        refresh();
    }

    function hideZoom() {
        if (zoomAt >= 0) cards[zoomAt].scrollIntoView({ block: "nearest" });
        zoomAt = -1;
        zoomView.hidden = true;
    }

    async function finish(body) {
        if (finished) return;
        finished = true;
        skip.disabled = save.disabled = true;
        if (await answer(requestId, body)) {
            dialog.close();
            return;
        }
        // The run already moved on (timed out or was cancelled): its done event closes us.
        finished = false;
        skip.disabled = save.disabled = false;
        toast("This review has already ended.", { severity: "warn" });
        dialog.close();
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
        const verb = saveAll ? "Saving all" : "Skipping all";
        timerPill.classList.toggle("paused", paused);
        timerPill.classList.toggle("urgent", !paused && remaining <= 10);
        progress.classList.toggle("paused", paused);
        if (timeout === 0) {
            timerPill.innerHTML = `${ICONS.timer}<span>No time limit</span>`;
            timerPill.disabled = true;
            progress.hidden = true;
            return;
        }
        timerPill.innerHTML = paused
            ? `${ICONS.play}<span>Paused · ${formatTime(remaining)} left</span>`
            : `${ICONS.pause}<span>${verb} in ${formatTime(remaining)}</span>`;
        timerPill.title = paused ? "Resume the countdown" : `Pause the countdown (it pauses by itself once you pick). Then: ${detail.on_timeout}.`;
        progressFill.style.width = `${Math.max(0, Math.min(100, (remaining / timeout) * 100))}%`;
    }

    function pauseTimer() {
        if (paused || timeout === 0) return;
        paused = true;
        answer(requestId, { action: "pause" });
        showTimer();
    }

    timerPill.addEventListener("click", () => {
        if (timeout === 0) return;
        if (paused) {
            paused = false;
            answer(requestId, { action: "resume", seconds: remaining });
            showTimer();
        } else {
            pauseTimer();
        }
    });

    // ---- keys
    function onKey(event) {
        if (!dialog.isTop() || event.ctrlKey || event.metaKey || event.altKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? "")) return;
        const key = event.key;
        let handled = true;
        if (/^[1-9]$/.test(key)) toggle(Number(key) - 1);
        else if (key === "a" || key === "A") setPicked(images.map((_, i) => i));
        else if (key === "n" || key === "N") setPicked([]);
        else if (key === "i" || key === "I") setPicked(images.map((_, i) => i).filter((i) => !picked.has(i)));
        else if (key === "Enter") save.click();
        else if (zoomAt >= 0 && key === "ArrowLeft") showZoom(zoomAt - 1);
        else if (zoomAt >= 0 && key === "ArrowRight") showZoom(zoomAt + 1);
        else if (zoomAt >= 0 && key === " ") toggle(zoomAt);
        else if (zoomAt >= 0 && key === "Escape") hideZoom();
        else if (zoomAt < 0 && key === " ") showZoom(hovered);
        else handled = false;
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    }
    document.addEventListener("keydown", onKey, true);

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
            if (outcome === "timeout") toast("Review timed out; the node's on_timeout choice was applied.");
            else if (outcome === "interrupted") toast("Review cancelled with the run.", { severity: "warn" });
        });
    },
});
