// What the review screens share (Save Image+, Video Review): the screen
// itself, the floating panel at its left and the countdown pill that pauses.
// One review is on screen at a time; reviews announced meanwhile wait.
import { app } from "../../../scripts/app.js";
import { ICONS } from "../fbui/controls.js";
import { el } from "../fbui/dom.js";
import { ensureKitCss, FONT, RADIUS_CARD, T, Z_MODAL } from "../fbui/theme.js";

export const MARGIN = 20;
export const PANEL_WIDTH = 220;
const DING_URL = new URL("../audio/ding.mp3", import.meta.url).href;
const CSS_ID = "fbnodes-review-shell-css-v1";

export function ensureReviewCss() {
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
.fbnodes-review-area{position:absolute;top:${MARGIN}px;bottom:${MARGIN}px;left:${MARGIN * 2 + PANEL_WIDTH}px;right:${MARGIN}px}
`;
    document.head.append(style);
}

export const formatTime = (seconds) => {
    const total = Math.max(0, Math.ceil(seconds));
    return total >= 60 ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}` : `${total}s`;
};

export function nodeTitle(nodeId, fallback) {
    const node = app.graph?.getNodeById?.(nodeId) ?? app.graph?.getNodeById?.(Number(nodeId));
    return node?.title || fallback;
}

export const ding = () => new Audio(DING_URL).play().catch(() => {});

// The countdown: a pill that pauses and resumes it, and a bar that empties.
// countdown({ timeout, running(time), onPause(), onResume(seconds) })
//   -> { pill, bar, pause(), stop() }. A timeout of 0 never runs out.
export function countdown({ timeout, running, onPause, onResume }) {
    const pill = el("button", "fbnodes-review-timer");
    pill.type = "button";
    const bar = el("div", "fbnodes-review-bar");
    const fill = el("i");
    bar.append(fill);
    let remaining = timeout;
    let paused = timeout === 0;

    function show() {
        if (timeout === 0) {
            pill.innerHTML = `${ICONS.timer}<span>No time limit</span>`;
            pill.disabled = true;
            bar.hidden = true;
            return;
        }
        pill.classList.toggle("paused", paused);
        pill.classList.toggle("urgent", !paused && remaining <= 10);
        bar.classList.toggle("paused", paused);
        pill.innerHTML = paused
            ? `${ICONS.play}<span>Paused · ${formatTime(remaining)} left</span>`
            : `${ICONS.pause}<span>${running(formatTime(remaining))}</span>`;
        pill.title = paused ? "Resume the countdown" : "Pause the countdown";
        fill.style.width = `${Math.max(0, Math.min(100, (remaining / timeout) * 100))}%`;
    }

    function pause() {
        if (paused) return;
        paused = true;
        onPause();
        show();
    }

    pill.addEventListener("click", () => {
        if (!paused) return pause();
        paused = false;
        onResume(remaining);
        show();
    });
    const ticker = setInterval(() => {
        if (paused) return;
        remaining -= 1;
        show();
    }, 1000);
    show();
    return { pill, bar, pause, stop: () => clearInterval(ticker) };
}

// One review on screen at a time: show(detail) opens one, or queues it
// while another is open. The opened review calls done() when it closes.
export function reviewQueue(open) {
    let current = null; // the request id on screen
    let close = null;
    const waiting = [];
    function show(detail) {
        if (current) {
            waiting.push(detail);
            return;
        }
        current = String(detail.request_id);
        close = open(detail, () => {
            current = close = null;
            const next = waiting.shift();
            if (next) show(next);
        });
    }
    // The run ended a review itself (timed out, or the queue was cancelled).
    function end(requestId) {
        const index = waiting.findIndex((detail) => String(detail.request_id) === String(requestId));
        if (index >= 0) waiting.splice(index, 1);
        if (current !== String(requestId)) return false;
        close();
        return true;
    }
    return { show, end };
}
