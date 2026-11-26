/**
 * Video Review (FBnodes): the run pauses on the decoded clip, which fills the
 * screen with the review panel beside it. Proceed lets the run go on, Cancel
 * stops it, Requeue stops it and queues the workflow again. When the node's
 * timer runs out its timeout action (proceed or cancel) happens.
 *
 * Space plays / pauses, ← / → step a frame, Enter proceeds. The node's face
 * is one fbui card; its stock widgets stay hidden and hold the values.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mountCard } from "./fbui/card.js";
import { toast } from "./fbui/comfy.js";
import { button } from "./fbui/controls.js";
import { chainCallback, el } from "./fbui/dom.js";
import { hideInputsInDef, widgetLinked } from "./fbui/widgets.js";
import { countdown, ding, ensureReviewCss, nodeTitle, reviewQueue } from "./common/review.js";

const NODE_NAME = "LTXReview";
const CSS_ID = "fbnodes-video-review-css-v1";
const WORKFLOW_ID_TO_TAB = new Map();

function ensureVideoReviewCss() {
    ensureReviewCss();
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.fbnodes-review-video{width:100%;height:100%;object-fit:contain;display:block;background:#000}
`;
    document.head.append(style);
}

async function answer(requestId, body) {
    try {
        const response = await api.fetchApi("/fbnodes/ltx-review/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ request_id: requestId, ...body }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- requeue

// Requeue queues the workflow the review came from, so its tab is brought
// to the front first.
function getActiveWorkflowId() {
    try {
        if (typeof app?.graph?.serialize === "function") {
            const serialized = app.graph.serialize();
            const workflowId = String(serialized?.id || "").trim();
            if (workflowId) return workflowId;
        }
    } catch {
        // Ignore and fall through to empty id.
    }
    return "";
}

function getActiveTabElement() {
    const tab = document.getElementsByClassName("p-togglebutton-checked")[0];
    return tab || null;
}

function rememberActiveWorkflowTab() {
    const workflowId = getActiveWorkflowId();
    if (!workflowId) return;
    const tab = getActiveTabElement();
    if (!tab) return;
    WORKFLOW_ID_TO_TAB.set(workflowId, tab);
}

function getTabClickTarget(tab) {
    if (!tab) return null;

    const roleButton = tab.querySelector("[role='button']");
    if (roleButton && typeof roleButton.click === "function") return roleButton;

    const button = tab.querySelector("button");
    if (button && typeof button.click === "function") return button;

    if (typeof tab.click === "function") return tab;
    return null;
}

function waitFrames(count = 1) {
    return new Promise((resolve) => {
        const step = (remaining) => {
            if (remaining <= 0) {
                resolve();
                return;
            }
            requestAnimationFrame(() => step(remaining - 1));
        };
        step(count);
    });
}

function dispatchSafeClick(target) {
    if (!target) return false;
    try {
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
        return true;
    } catch {
        try {
            target.click();
            return true;
        } catch {
            return false;
        }
    }
}

async function tryActivateWorkflowTab(workflowId) {
    const targetWorkflowId = String(workflowId || "").trim();
    if (!targetWorkflowId) return true;

    if (getActiveWorkflowId() === targetWorkflowId) {
        return true;
    }

    const tab = WORKFLOW_ID_TO_TAB.get(targetWorkflowId);
    if (!tab || !tab.isConnected) {
        return false;
    }

    const clickTarget = getTabClickTarget(tab);
    if (!clickTarget) {
        return false;
    }

    const clicked = dispatchSafeClick(clickTarget);
    if (!clicked) {
        console.warn("[VideoReview] Failed to activate source workflow tab: click dispatch failed");
        return false;
    }

    await waitFrames(4);

    // Some tab systems attach handlers to parent wrappers instead of inner button.
    if (getActiveWorkflowId() !== targetWorkflowId) {
        dispatchSafeClick(tab);
        await waitFrames(4);
    }

    return getActiveWorkflowId() === targetWorkflowId;
}

async function tryRequeuePrompt(originWorkflowId) {
    const switched = await tryActivateWorkflowTab(originWorkflowId);
    if (!switched) {
        console.warn("[VideoReview] Requeue aborted: could not activate source workflow tab.", { originWorkflowId });
        return false;
    }

    if (typeof app?.queuePrompt === "function") {
        try {
            await app.queuePrompt(0);
            return true;
        } catch (error) {
            console.warn("[VideoReview] queuePrompt failed:", error);
            return false;
        }
    }

    console.warn("[VideoReview] Requeue requested but queuePrompt is unavailable on this frontend.");
    return false;
}

// ---------------------------------------------------------------- screen

// Opens the review for `detail`; done() hands the screen to the next one.
// Returns the function that closes it.
function showReview(detail, done) {
    ensureVideoReviewCss();
    const requestId = String(detail.request_id);
    const timeout = Math.max(0, Number(detail.timeout) || 0);
    const fps = Number(detail.fps) || 24;
    const proceeds = detail.on_timeout !== "cancel";
    let finished = false;

    const root = el("div", "fbnodes-review");
    const area = el("div", "fbnodes-review-area");
    const video = el("video", "fbnodes-review-video");
    Object.assign(video, { controls: true, loop: true, autoplay: true, playsInline: true, src: detail.video_url || "" });
    area.append(video);

    const panel = el("div", "fbnodes-review-panel");
    const title = el("div", "title", nodeTitle(detail.node_id, "Video Review"));
    const count = el("div", "count", "—");
    video.addEventListener("loadedmetadata", () => {
        count.innerHTML = `<b>${video.videoWidth} × ${video.videoHeight}</b> · ${video.duration.toFixed(2)} s · ${Math.round(video.duration * fps)} frames`;
    });
    const timer = countdown({
        timeout,
        running: (time) => `${proceeds ? "Proceeding" : "Cancelling"} in ${time}`,
        onPause: () => answer(requestId, { action: "pause" }),
        onResume: (seconds) => answer(requestId, { action: "resume", seconds }),
    });
    // Requeue (2/3) and Cancel (1/3) on one line, Proceed big beneath them.
    const requeue = button("Requeue", { grow: true, title: "Stop the run and queue the workflow again", onClick: requeueRun });
    requeue.classList.add("major");
    const cancel = button("Cancel", { grow: true, title: "Stop the run here", onClick: () => decide("cancel") });
    const actions = el("div", "actions");
    actions.append(requeue, cancel);
    const proceed = button("Proceed", { primary: true, title: "Let the run go on (Enter)", onClick: () => decide("proceed") });
    proceed.classList.add("accept");
    const hint = el("div", "hint");
    hint.innerHTML = "<kbd>Space</kbd> play / pause · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>Enter</kbd> proceed";
    panel.append(title, count, timer.pill, timer.bar, actions, proceed, hint);
    root.append(area, panel);
    document.body.append(root);

    function close() {
        timer.stop();
        document.removeEventListener("keydown", onKey, true);
        video.pause();
        video.removeAttribute("src");
        video.load();
        root.remove();
        done();
    }

    async function decide(decision) {
        if (finished) return;
        finished = true;
        cancel.disabled = proceed.disabled = requeue.disabled = true;
        if (!(await answer(requestId, { decision }))) toast("This review had already ended.", { severity: "warn" });
        close();
    }

    async function requeueRun() {
        if (finished) return;
        timer.pause();
        if (!(await tryRequeuePrompt(String(detail.graph_id || "").trim()))) {
            toast("Could not switch to the workflow this review came from: open its tab, then press Requeue again.", { severity: "warn" });
            return;
        }
        decide("requeue");
    }

    function onKey(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        let handled = true;
        if (key === " ") {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
            video.pause();
            video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (key === "ArrowRight" ? 1 : -1) / fps));
        } else if (key === "Enter") proceed.click();
        else handled = false;
        // Keys never reach the canvas while the review is up.
        event.stopPropagation();
        if (handled) event.preventDefault();
    }
    document.addEventListener("keydown", onKey, true);

    ding();
    return close;
}

const reviews = reviewQueue(showReview);

// ---------------------------------------------------------------- node

app.registerExtension({
    name: "FBnodes.VideoReview",

    afterConfigureGraph() {
        rememberActiveWorkflowTab();
    },

    setup() {
        rememberActiveWorkflowTab();
        // Keep the workflow -> tab map fresh as tabs change.
        document.addEventListener("click", () => {
            waitFrames(1).then(() => rememberActiveWorkflowTab());
        }, true);

        api.addEventListener("fbnodes.ltx_review.request", (event) => {
            rememberActiveWorkflowTab();
            const detail = event.detail ?? {};
            if (detail.request_id) reviews.show(detail);
        });
        // The run ended the review itself: timed out, or the queue was cancelled.
        api.addEventListener("fbnodes.ltx_review.review_done", (event) => {
            const { request_id: requestId, outcome, on_timeout: onTimeout } = event.detail ?? {};
            if (!reviews.end(requestId)) return;
            if (outcome === "timeout") toast(onTimeout === "cancel" ? "Review timed out: the run was cancelled." : "Review timed out: the run went on.");
            else if (outcome === "interrupted") toast("Review cancelled with the run.", { severity: "warn" });
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        hideInputsInDef(nodeData, ["fps", "timeout", "on_timeout", "enable"]);
        // A linked Review is only known at run time: its settings stay shown.
        const reviewing = (values, node) => values.enable !== false || widgetLinked(node, "enable");
        const onTimeout = (values, node) => reviewing(values, node) && (Number(values.timeout) > 0 || widgetLinked(node, "timeout"));
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            mountCard(this, {
                minWidth: 260,
                rows: [
                    { widget: "enable", label: "Review" },
                    { widget: "fps", label: "FPS", when: reviewing },
                    { widget: "timeout", label: "Timeout", suffix: "s", title: "Seconds to wait for your decision (0 = until you decide)", when: reviewing },
                    { widget: "on_timeout", label: "Then", kind: "segment", labels: { proceed: "proceed", cancel: "cancel" }, title: "What happens when the timer runs out", when: onTimeout },
                ],
            });
        });
    },
});
