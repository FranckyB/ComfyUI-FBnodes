import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const ACTIVE_DIALOGS = new Map();
const LTX_REVIEW_DING_URL = new URL("./audio/ding.mp3", import.meta.url).href;

async function playImageFilterDing() {
    try {
        const audio = new Audio(LTX_REVIEW_DING_URL);
        await audio.play();
        return true;
    } catch {
        return false;
    }
}

function removeDialog(requestId) {
    const dialog = ACTIVE_DIALOGS.get(requestId);
    if (typeof dialog?._cleanup === "function") {
        dialog._cleanup();
    }
    if (dialog?.parentElement) {
        dialog.parentElement.removeChild(dialog);
    }
    ACTIVE_DIALOGS.delete(requestId);
}

async function sendDecision(requestId, decision) {
    try {
        await api.fetchApi("/fbnodes/ltx-review/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ request_id: requestId, decision }),
        });
    } catch (error) {
        console.warn("[LTXReview] Failed to send decision:", error);
    }
}

async function tryRequeuePrompt() {
    if (typeof app?.queuePrompt === "function") {
        try {
            await app.queuePrompt(0);
            return true;
        } catch (error) {
            console.warn("[LTXReview] queuePrompt failed:", error);
            return false;
        }
    }

    console.warn("[LTXReview] Requeue requested but queuePrompt is unavailable on this frontend.");
    return false;
}

function buildDialog(detail) {
    const requestId = String(detail?.request_id || "");
    const timeoutSeconds = Number(detail?.timeout || 0);
    const videoUrl = detail?.video_url || "";
    const videoPath = detail?.video_path || "";

    const overlay = document.createElement("div");
    overlay.className = "fbnodes-ltx-review-overlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(8, 10, 14, 0.82)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "100000";

    const panel = document.createElement("div");
    panel.style.width = "min(960px, 92vw)";
    panel.style.maxHeight = "90vh";
    panel.style.background = "#151b24";
    panel.style.border = "1px solid #2f3a49";
    panel.style.borderRadius = "12px";
    panel.style.boxShadow = "0 18px 40px rgba(0,0,0,0.45)";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.overflow = "hidden";

    const header = document.createElement("div");
    header.style.padding = "14px 16px";
    header.style.borderBottom = "1px solid #2f3a49";
    header.style.background = "linear-gradient(180deg, #1a2230, #151b24)";

    const title = document.createElement("div");
    title.textContent = "LTX Review";
    title.style.color = "#e8eef9";
    title.style.font = "700 18px 'Segoe UI', sans-serif";

    const subtitle = document.createElement("div");
    subtitle.textContent = "Review this first pass before continuing.";
    subtitle.style.color = "#9fb1cb";
    subtitle.style.font = "500 13px 'Segoe UI', sans-serif";
    subtitle.style.marginTop = "4px";

    const timer = document.createElement("div");
    timer.style.color = "#d7e2f6";
    timer.style.font = "600 12px 'Segoe UI', sans-serif";
    timer.style.marginTop = "8px";

    let remaining = Number.isFinite(timeoutSeconds) ? Math.max(0, timeoutSeconds) : 0;
    let countdownHandle = null;
    let timeoutSoundHandle = null;

    if (remaining > 0) {
        timer.textContent = `Auto action in ${remaining}s`;
        countdownHandle = setInterval(() => {
            if (!ACTIVE_DIALOGS.has(requestId)) {
                clearInterval(countdownHandle);
                return;
            }
            remaining -= 1;
            if (remaining <= 0) {
                clearInterval(countdownHandle);
                timer.textContent = "Auto action pending...";
            } else {
                timer.textContent = `Auto action in ${remaining}s`;
            }
        }, 1000);

        timeoutSoundHandle = setTimeout(() => {
            if (!ACTIVE_DIALOGS.has(requestId)) return;
            playImageFilterDing();
            removeDialog(requestId);
        }, remaining * 1000);
    } else {
        timer.textContent = "Waiting for action...";
    }

    header.appendChild(title);
    header.appendChild(subtitle);
    header.appendChild(timer);

    const body = document.createElement("div");
    body.style.padding = "12px";
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "10px";
    body.style.overflow = "auto";

    if (videoUrl) {
        const video = document.createElement("video");
        video.controls = true;
        video.loop = true;
        video.autoplay = true;
        video.muted = false;
        video.playsInline = true;
        video.src = videoUrl;
        video.style.width = "100%";
        video.style.maxHeight = "62vh";
        video.style.background = "#0a0e14";
        video.style.border = "1px solid #2c3645";
        video.style.borderRadius = "8px";
        body.appendChild(video);
    } else {
        const noPreview = document.createElement("div");
        noPreview.textContent = "Video preview unavailable in browser for this input.";
        noPreview.style.padding = "16px";
        noPreview.style.border = "1px solid #2c3645";
        noPreview.style.borderRadius = "8px";
        noPreview.style.background = "#101722";
        noPreview.style.color = "#ffcf8b";
        noPreview.style.font = "600 13px 'Segoe UI', sans-serif";
        body.appendChild(noPreview);
    }

    if (videoPath) {
        const pathLine = document.createElement("div");
        pathLine.textContent = videoPath;
        pathLine.style.color = "#8ea4c7";
        pathLine.style.font = "500 12px 'Consolas', monospace";
        pathLine.style.wordBreak = "break-all";
        body.appendChild(pathLine);
    }

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "10px";
    actions.style.justifyContent = "flex-end";
    actions.style.padding = "12px";
    actions.style.borderTop = "1px solid #2f3a49";
    actions.style.background = "#121923";

    const mkBtn = (label, bg, color = "#f4f7fc") => {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.style.border = "1px solid transparent";
        btn.style.borderRadius = "8px";
        btn.style.padding = "8px 13px";
        btn.style.background = bg;
        btn.style.color = color;
        btn.style.font = "600 13px 'Segoe UI', sans-serif";
        btn.style.cursor = "pointer";
        return btn;
    };

    const proceedBtn = mkBtn("Proceed", "#0f6f54");
    const cancelBtn = mkBtn("Cancel", "#8d2e3f");
    const requeueBtn = mkBtn("Requeue", "#2f4767");

    proceedBtn.onclick = async () => {
        await sendDecision(requestId, "proceed");
        removeDialog(requestId);
    };

    cancelBtn.onclick = async () => {
        await sendDecision(requestId, "cancel");
        removeDialog(requestId);
    };

    requeueBtn.onclick = async () => {
        const queued = await tryRequeuePrompt();
        await sendDecision(requestId, queued ? "requeue" : "cancel");
        removeDialog(requestId);
    };

    actions.appendChild(requeueBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(proceedBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(actions);
    overlay.appendChild(panel);

    overlay._cleanup = () => {
        if (countdownHandle) {
            clearInterval(countdownHandle);
            countdownHandle = null;
        }
        if (timeoutSoundHandle) {
            clearTimeout(timeoutSoundHandle);
            timeoutSoundHandle = null;
        }
    };

    return overlay;
}

app.registerExtension({
    name: "FBnodes.LTXReview",

    async setup() {
        api.addEventListener("fbnodes.ltx_review.request", async (event) => {
            const detail = event?.detail || {};
            const requestId = String(detail?.request_id || "");
            if (!requestId) return;

            removeDialog(requestId);
            const dialog = buildDialog(detail);
            ACTIVE_DIALOGS.set(requestId, dialog);
            document.body.appendChild(dialog);
            playImageFilterDing();
        });
    },
});
