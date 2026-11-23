// The image stage: one canvas that shows a picture and edits a crop rect and
// a painted mask on it. The picture, mask and crop shade are drawn into the
// canvas, so hit-testing does not drift with zoom and works the same in both
// renderers; numbers (size, crop) belong in the caption under it, never on
// the picture. Interaction follows the AusBoss pad
// stage: the whole crop edge is the handle, the geometry freezes while a drag
// runs, and a press that grabs nothing falls through to the node.
//
// Everything node-specific is injected:
//   image()  -> { bitmap, width, height } | null
//   flips()  -> { x, y }
//   crop()   -> { shown, editable, rect }      rect: display percent
//   mask()   -> { shown, editable, strokes, brushSize, erasing }
//   onCrop(rect), onCropEnd()
//   onStrokeStart(stroke), onStrokeEnd()       stroke points in source space
//   onClick()          a plain click while no tool is active
//   onContextMenu(event)
//   emptyText()
import { el } from "../fbui/dom.js";
import { FONT, T } from "../fbui/theme.js";
import { cropCursor, cropViewRect, dragCrop, fitRect, hitCrop } from "./stage_math.js";

// The picture fills the frame edge to edge, as the video players do; crop
// edges stay grabbable there because their band reaches inside the picture.
const MARGIN = 0;
const CLICK_SLOP = 4;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// One stroke in a rect, the same smoothing the backend's raster matches.
export function drawStroke(ctx, stroke, rect) {
  const points = Array.isArray(stroke.points) ? stroke.points : [];
  if (!points.length) return;
  const at = (p) => [rect.x + clamp01(Number(p[0])) * rect.w, rect.y + clamp01(Number(p[1])) * rect.h];
  const size = Math.max(1, Number(stroke.sizeNorm || 0) * Math.max(rect.w, rect.h) || Number(stroke.size || 24));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = size;
  ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = T.maskInk;
  ctx.fillStyle = T.maskInk;
  const first = at(points[0]);
  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(first[0], first[1], size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < points.length - 1; i++) {
      const current = at(points[i]);
      const next = at(points[i + 1]);
      ctx.quadraticCurveTo(current[0], current[1], (current[0] + next[0]) / 2, (current[1] + next[1]) / 2);
    }
    const last = at(points[points.length - 1]);
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }
  ctx.restore();
}

export function createImageStage(options) {
  const root = el("div", "fbui-stage");
  const canvas = el("canvas", "fbui-fit");
  canvas.style.touchAction = "none";
  root.append(canvas);
  const maskLayer = document.createElement("canvas");
  const state = { raf: 0, drag: null, hover: null, imageRect: null, cropRect: null, disposed: false };

  const localPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * canvas.clientWidth,
      y: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * canvas.clientHeight,
    };
  };

  // A view point as a picture point in source space (undoing the flips).
  const toSource = (point, rect) => {
    const flips = options.flips();
    const x = clamp01((point.x - rect.x) / rect.width);
    const y = clamp01((point.y - rect.y) / rect.height);
    return [flips.x ? 1 - x : x, flips.y ? 1 - y : y];
  };

  function draw() {
    if (state.disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Transparent: the frame's neutral plate shows around the picture.
    ctx.clearRect(0, 0, w, h);

    const image = options.image();
    if (!image?.bitmap) {
      state.imageRect = null;
      state.cropRect = null;
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = T.faint;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(options.emptyText?.() ?? "", w / 2, h / 2);
      return;
    }

    // The fit freezes while a drag runs, so an edge never slips from the pointer.
    const rect = state.drag?.imageRect ?? fitRect(image.width, image.height, w, h, MARGIN);
    state.imageRect = rect;
    const flips = options.flips();
    const mask = options.mask();

    ctx.save();
    ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
    ctx.scale(flips.x ? -1 : 1, flips.y ? -1 : 1);
    ctx.translate(-rect.width / 2, -rect.height / 2);
    ctx.drawImage(image.bitmap, 0, 0, rect.width, rect.height);
    if (mask.shown && mask.strokes.length) {
      maskLayer.width = Math.max(1, Math.round(rect.width * dpr));
      maskLayer.height = Math.max(1, Math.round(rect.height * dpr));
      const layer = maskLayer.getContext("2d");
      const area = { x: 0, y: 0, w: maskLayer.width, h: maskLayer.height };
      for (const stroke of mask.strokes) drawStroke(layer, stroke, area);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(maskLayer, 0, 0, rect.width, rect.height);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    const crop = options.crop();
    state.cropRect = null;
    if (crop.shown) {
      const view = cropViewRect(crop.rect, rect);
      state.cropRect = view;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.rect(view.x, view.y, view.width, view.height);
      ctx.fillStyle = T.shade;
      ctx.fill("evenodd");
      // While the crop is edited its outline is dotted over a dark underlay,
      // readable on any picture; otherwise a quiet dashed line.
      if (crop.editable) {
        ctx.strokeStyle = "rgba(0,0,0,.65)";
        ctx.lineWidth = 3;
        ctx.strokeRect(view.x, view.y, view.width, view.height);
        ctx.strokeStyle = T.ink;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 4]);
        ctx.lineCap = "round";
      } else {
        ctx.strokeStyle = T.label;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
      }
      ctx.strokeRect(view.x, view.y, view.width, view.height);
      ctx.restore();
    }
    if (mask.editable && state.hover && !state.drag?.handle) {
      const inside = state.hover.x >= rect.x && state.hover.x <= rect.x + rect.width && state.hover.y >= rect.y && state.hover.y <= rect.y + rect.height;
      if (inside) {
        const radius = Math.max(1, (mask.brushSize / Math.max(image.width, image.height)) * Math.max(rect.width, rect.height) / 2);
        ctx.save();
        ctx.beginPath();
        ctx.arc(state.hover.x, state.hover.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,0,0,.7)";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = mask.erasing ? T.warn : T.ink;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function redraw() {
    if (state.raf || state.disposed) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      draw();
    });
  }

  const consume = (event) => {
    event.preventDefault();
    event.stopPropagation();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* mouse fallback */ }
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.drag) return;
    const point = localPoint(event);
    const rect = state.imageRect;
    const crop = options.crop();
    const mask = options.mask();
    if (rect && crop.editable) {
      const handle = hitCrop(point, state.cropRect);
      if (handle) {
        consume(event);
        state.drag = { handle, start: point, rect: { ...crop.rect }, imageRect: rect };
        redraw();
        return;
      }
    }
    if (rect && mask.editable && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) {
      consume(event);
      const image = options.image();
      const stroke = {
        mode: mask.erasing ? "erase" : "draw",
        size: mask.brushSize,
        sizeNorm: mask.brushSize / Math.max(image.width, image.height),
        points: [toSource(point, rect)],
      };
      state.drag = { stroke, imageRect: rect };
      options.onStrokeStart?.(stroke);
      redraw();
      return;
    }
    // Nothing grabbed: no preventDefault, so the node still drags. A press
    // that stays put is a click (open the browser).
    state.press = point;
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = localPoint(event);
    state.hover = point;
    const drag = state.drag;
    if (drag?.handle) {
      const dx = ((point.x - drag.start.x) / drag.imageRect.width) * 100;
      const dy = ((point.y - drag.start.y) / drag.imageRect.height) * 100;
      options.onCrop?.(dragCrop(drag.handle, drag.rect, dx, dy));
    } else if (drag?.stroke) {
      const next = toSource(point, drag.imageRect);
      const last = drag.stroke.points[drag.stroke.points.length - 1];
      if (Math.abs(last[0] - next[0]) > 0.0015 || Math.abs(last[1] - next[1]) > 0.0015) drag.stroke.points.push(next);
    } else {
      const crop = options.crop();
      const handle = crop.editable ? hitCrop(point, state.cropRect) : null;
      const rect = state.imageRect;
      const onPicture = rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
      const painting = options.mask().editable && onPicture;
      canvas.style.cursor = handle ? cropCursor(handle) : painting ? "none" : "";
      // Redraw while the brush ring shows, and once more as it leaves.
      const was = state.painting;
      state.painting = painting;
      if (!painting && !was) return;
    }
    redraw();
  });

  const end = (event) => {
    const drag = state.drag;
    const press = state.press;
    state.drag = null;
    state.press = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    if (drag?.handle) options.onCropEnd?.();
    else if (drag?.stroke) options.onStrokeEnd?.();
    else if (press && event.type === "pointerup") {
      const point = localPoint(event);
      if (Math.hypot(point.x - press.x, point.y - press.y) <= CLICK_SLOP) options.onClick?.();
    }
    redraw();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => {
    state.hover = null;
    redraw();
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onContextMenu?.(event);
  });

  const observer = new ResizeObserver(redraw);
  observer.observe(canvas);

  return {
    element: root,
    canvas,
    redraw,
    dispose() {
      state.disposed = true;
      if (state.raf) cancelAnimationFrame(state.raf);
      observer.disconnect();
    },
  };
}
