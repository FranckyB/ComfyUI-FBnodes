// The image stage: one canvas that shows a picture and edits a crop rect, the
// padding around it and a painted mask. The picture, mask, crop shade and pad
// hatch are drawn into the canvas, so hit-testing does not drift with zoom and
// works the same in both renderers; numbers (size, crop) belong in the caption
// under it, never on the picture. Interaction follows the AusBoss pad
// stage: the whole crop edge is the handle, the geometry freezes while a drag
// runs, and a press that grabs nothing falls through to the node.
//
// Everything node-specific is injected:
//   image()  -> { bitmap, width, height } | null
//   flips()  -> { x, y }
//   crop()   -> { shown, editable, rect }      rect: display percent
//   pad()    -> { shown, editable, sides }     sides: pixels beyond the output, and feather
//   mask()   -> { shown, editable, strokes, brushSize, erasing }
//   onCrop(rect, handle), onCropEnd()
//   onPad(sides, handle), onPadEnd()          handle: "n", "se", ... or "move"
//   onStrokeStart(stroke), onStrokeEnd()       stroke points in source space
//   onClick()          a plain click while no tool is active
//   onContextMenu(event)
//   emptyText()
import { el } from "../fbui/dom.js";
import { FONT, T } from "../fbui/theme.js";
import { cropCursor, cropViewRect, dragCrop, dragPad, fitRect, hitCrop, padFitRect } from "./stage_math.js";

// The picture fills the frame edge to edge, as the video players do; crop
// edges stay grabbable there because their band reaches inside the picture.
const MARGIN = 0;
const CLICK_SLOP = 4;
// Room around the padded canvas while it is edited, as a share of the
// picture's long side, so its edges can be dragged further out.
const PAD_SLACK = 0.15;

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

// A crop or pad outline: dotted over a dark underlay while it is edited,
// readable on any picture; otherwise a quiet dashed line.
function outline(ctx, view, editable) {
  ctx.save();
  if (editable) {
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

// The added canvas: hatched over the crop shade, so it reads as "to be painted".
const PAD_SHADE = T.shade.match(/[\d.]+/g).map(Number);

function hatch(ctx) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 8;
  const t = tile.getContext("2d");
  t.fillStyle = T.shade;
  t.fillRect(0, 0, 8, 8);
  t.strokeStyle = "rgba(255,255,255,.16)";
  t.beginPath();
  t.moveTo(-1, 9);
  t.lineTo(9, -1);
  t.stroke();
  return ctx.createPattern(tile, "repeat");
}

// The feather: the shade fading into the picture as the mask does,
// ((feather - d) / feather)^2 at d pixels from each padded edge (none when
// the feather is half the picture or more, as in the output).
function drawFeather(ctx, base, sides, perPixel) {
  const reach = sides.feather * perPixel;
  if (!reach || reach * 2 >= base.width || reach * 2 >= base.height) return;
  const right = base.x + base.width;
  const bottom = base.y + base.height;
  const edges = {
    left: [base.x, base.y, base.x + reach, base.y],
    right: [right, base.y, right - reach, base.y],
    top: [base.x, base.y, base.x, base.y + reach],
    bottom: [base.x, bottom, base.x, bottom - reach],
  };
  for (const [side, line] of Object.entries(edges)) {
    if (!sides[side]) continue;
    const fade = ctx.createLinearGradient(...line);
    const [r, g, b, a] = PAD_SHADE;
    for (const at of [0, 0.25, 0.5, 0.75, 1]) fade.addColorStop(at, `rgba(${r},${g},${b},${a * (1 - at) ** 2})`);
    ctx.fillStyle = fade;
    ctx.fillRect(base.x, base.y, base.width, base.height);
  }
}

export function createImageStage(options) {
  const root = el("div", "fbui-stage");
  const canvas = el("canvas", "fbui-fit");
  canvas.style.touchAction = "none";
  root.append(canvas);
  const maskLayer = document.createElement("canvas");
  const state = { raf: 0, drag: null, hover: null, imageRect: null, cropRect: null, padRect: null, disposed: false };

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
      state.padRect = null;
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = T.faint;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(options.emptyText?.() ?? "", w / 2, h / 2);
      return;
    }

    // The fit freezes while a drag runs, so an edge never slips from the pointer.
    const crop = options.crop();
    const pad = options.pad();
    const output = crop.shown ? cropViewRect(crop.rect, { x: 0, y: 0, width: image.width, height: image.height }) : { x: 0, y: 0, width: image.width, height: image.height };
    const slack = pad.editable ? PAD_SLACK * Math.max(image.width, image.height) : 0;
    const rect = state.drag?.imageRect ?? (pad.shown
      ? padFitRect(image.width, image.height, output, pad.sides, w, h, slack)
      : fitRect(image.width, image.height, w, h, MARGIN));
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

    state.cropRect = null;
    if (crop.shown) {
      const view = cropViewRect(crop.rect, rect);
      state.cropRect = view;
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.rect(view.x, view.y, view.width, view.height);
      ctx.fillStyle = T.shade;
      ctx.fill("evenodd");
      outline(ctx, view, crop.editable);
    }
    state.padRect = null;
    if (pad.shown) {
      const base = state.cropRect ?? rect;
      const perPixel = rect.width / image.width;
      const { left, right, top, bottom } = pad.sides;
      const view = { x: base.x - left * perPixel, y: base.y - top * perPixel, width: base.width + (left + right) * perPixel, height: base.height + (top + bottom) * perPixel };
      state.padRect = view;
      ctx.beginPath();
      ctx.rect(view.x, view.y, view.width, view.height);
      ctx.rect(base.x, base.y, base.width, base.height);
      ctx.fillStyle = hatch(ctx);
      ctx.fill("evenodd");
      drawFeather(ctx, base, pad.sides, perPixel);
      outline(ctx, view, pad.editable);
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
    const pad = options.pad();
    if (rect && pad.editable) {
      const handle = hitCrop(point, state.padRect);
      if (handle) {
        consume(event);
        state.drag = { padHandle: handle, start: point, sides: { ...pad.sides }, imageRect: rect };
        redraw();
        return;
      }
    }
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
      options.onCrop?.(dragCrop(drag.handle, drag.rect, dx, dy), drag.handle);
    } else if (drag?.padHandle) {
      const perPixel = drag.imageRect.width / options.image().width;
      options.onPad?.(dragPad(drag.padHandle, drag.sides, (point.x - drag.start.x) / perPixel, (point.y - drag.start.y) / perPixel), drag.padHandle);
    } else if (drag?.stroke) {
      const next = toSource(point, drag.imageRect);
      const last = drag.stroke.points[drag.stroke.points.length - 1];
      if (Math.abs(last[0] - next[0]) > 0.0015 || Math.abs(last[1] - next[1]) > 0.0015) drag.stroke.points.push(next);
    } else {
      const handle = options.crop().editable ? hitCrop(point, state.cropRect) : options.pad().editable ? hitCrop(point, state.padRect) : null;
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
    else if (drag?.padHandle) options.onPadEnd?.();
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
