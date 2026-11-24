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
//   region() -> { x, y, width, height } of the picture to show (picture pixels), or
//               null for all of it: a crop made before the turn
//   turn()   -> clockwise degrees; crop and pad then edit the turned picture (region)
//   flips()  -> { x, y }
//   crop()   -> { shown, editable, rect }      rect: display percent; shown but not
//               editable, only the cropped part shows (the result, not the shade)
//   pad()    -> { shown, editable, sides }     sides: pixels beyond the output, and feather
//   mask()   -> { shown, editable, strokes, brushSize, erasing, soft }; Ctrl held
//               erases, Shift held paints a soft stroke
//   rotate() -> { editable }                   a drag anywhere turns the picture
//   onRotate(degrees), onRotateEnd()
//   onCrop(rect, handle), onCropEnd()
//   onPad(sides, handle), onPadEnd()          handle: "n", "se", ... or "move"
//   onStrokeStart(stroke), onStrokeEnd()       stroke points in source space
//   onClick()          a plain click while no tool is active
//   onContextMenu(event)
//   emptyText()
import { el } from "../fbui/dom.js";
import { FONT, T } from "../fbui/theme.js";
import { cropCursor, cropViewRect, dragCrop, dragPad, fitRect, hitCrop, padFitRect, rotatedSize, unturnPoint } from "./stage_math.js";

// The picture fills the frame edge to edge, as the video players do; crop
// edges stay grabbable there because their band reaches inside the picture.
const MARGIN = 0;
const CLICK_SLOP = 4;
// Room around the padded canvas while it is edited, as a share of the
// picture's long side, so its edges can be dragged further out.
const PAD_SLACK = 0.15;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
// Shift while turning snaps to this.
const TURN_SNAP = 15;
// The pointer while Rotate is the tool: a turning arrow, outlined dark so it
// reads on any picture; the hotspot is its centre.
const TURN_PATH = "M19 12a7 7 0 1 1-2.05-4.95M19 4.5v3.5h-3.5";
const TURN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${TURN_PATH}" stroke="#000" stroke-opacity=".7" stroke-width="4"/><path d="${TURN_PATH}" stroke="#fff" stroke-width="2"/></svg>`)}") 12 12, grab`;

// A soft stroke's blur, as a share of its width: its edge fades over about
// half the brush's radius.
const SOFT_BLUR = 0.25;

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
  // The mask keeps the soft edge: the backend reads the raster's alpha as is.
  if (stroke.soft) ctx.filter = `blur(${size * SOFT_BLUR}px)`;
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
  const state = { raf: 0, drag: null, hover: null, imageRect: null, cropRect: null, padRect: null, paintRect: null, ctrl: false, shift: false, disposed: false };
  // The brush erases while the eraser is on, or while Ctrl is held.
  const erasing = (mask) => mask.erasing || state.ctrl;
  // A soft stroke while the soft brush is on, or while Shift is held.
  const softly = (mask) => mask.soft || state.shift;

  const localPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * canvas.clientWidth,
      y: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * canvas.clientHeight,
    };
  };

  const turnOf = () => Number(options.turn?.()) || 0;
  const regionOf = (image) => options.region?.() ?? { x: 0, y: 0, width: image.width, height: image.height };
  // The picture (or its region) as the stage edits it: turned (Pillow's expanded size).
  const worldOf = (image) => {
    const region = regionOf(image);
    return rotatedSize(region.width, region.height, turnOf());
  };

  // A view point as a picture point in source space: the flips undone, then the turn.
  const toSource = (point, rect) => {
    const flips = options.flips();
    let x = (point.x - rect.x) / rect.width;
    let y = (point.y - rect.y) / rect.height;
    if (flips.x) x = 1 - x;
    if (flips.y) y = 1 - y;
    const image = options.image();
    const region = regionOf(image);
    const world = worldOf(image);
    const [rx, ry] = unturnPoint(x * world.width, y * world.height, region, world, turnOf());
    return [clamp01((region.x + rx) / image.width), clamp01((region.y + ry) / image.height)];
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
      state.paintRect = null;
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
    const degrees = turnOf();
    const world = worldOf(image);
    const output = crop.shown ? cropViewRect(crop.rect, { x: 0, y: 0, width: world.width, height: world.height }) : { x: 0, y: 0, width: world.width, height: world.height };
    const slack = pad.editable ? PAD_SLACK * Math.max(world.width, world.height) : 0;
    // While another tool is active a crop shows as its result: the view fits
    // the cropped part (and its padding), and the rest is clipped away.
    const cropOnly = crop.shown && !crop.editable;
    const fitWorld = () => {
      if (!cropOnly) {
        return pad.shown ? padFitRect(world.width, world.height, output, pad.sides, w, h, slack) : fitRect(world.width, world.height, w, h, MARGIN);
      }
      const sides = pad.shown ? pad.sides : { left: 0, right: 0, top: 0, bottom: 0 };
      const part = padFitRect(output.width, output.height, { x: 0, y: 0, width: output.width, height: output.height }, sides, w, h, slack);
      return { x: part.x - output.x * part.scale, y: part.y - output.y * part.scale, width: world.width * part.scale, height: world.height * part.scale, scale: part.scale };
    };
    const rect = state.drag?.imageRect ?? fitWorld();
    state.imageRect = rect;
    const cropView = crop.shown ? cropViewRect(crop.rect, rect) : null;
    // Where the picture shows, so where a brush paints.
    state.paintRect = cropOnly ? cropView : rect;
    const flips = options.flips();
    const mask = options.mask();
    // View pixels per picture pixel, the picture's own size in the view, and
    // the region of it shown (all of it unless a crop comes before the turn).
    const perPixel = rect.width / world.width;
    const pictureW = image.width * perPixel;
    const pictureH = image.height * perPixel;
    const region = regionOf(image);
    const regionW = region.width * perPixel;
    const regionH = region.height * perPixel;
    const pictureX = -regionW / 2 - region.x * perPixel;
    const pictureY = -regionH / 2 - region.y * perPixel;

    ctx.save();
    if (cropOnly) {
      ctx.beginPath();
      ctx.rect(cropView.x, cropView.y, cropView.width, cropView.height);
      ctx.clip();
    }
    ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
    ctx.scale(flips.x ? -1 : 1, flips.y ? -1 : 1);
    if (degrees) {
      // The corners a turn opens are filled and masked like padding.
      ctx.fillStyle = hatch(ctx);
      ctx.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
      ctx.rotate(degrees * Math.PI / 180);
    }
    ctx.beginPath();
    ctx.rect(-regionW / 2, -regionH / 2, regionW, regionH);
    ctx.clip();
    ctx.drawImage(image.bitmap, pictureX, pictureY, pictureW, pictureH);
    if (mask.shown && mask.strokes.length) {
      maskLayer.width = Math.max(1, Math.round(pictureW * dpr));
      maskLayer.height = Math.max(1, Math.round(pictureH * dpr));
      const layer = maskLayer.getContext("2d");
      const area = { x: 0, y: 0, w: maskLayer.width, h: maskLayer.height };
      for (const stroke of mask.strokes) drawStroke(layer, stroke, area);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(maskLayer, pictureX, pictureY, pictureW, pictureH);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (options.rotate?.().editable) {
      // A level grid to straighten against while turning.
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const spacing = Math.max(24, Math.min(w, h) / 8);
      for (let x = (w / 2) % spacing; x < w; x += spacing) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
      for (let y = (h / 2) % spacing; y < h; y += spacing) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
      ctx.stroke();
      ctx.restore();
    }

    state.cropRect = cropView;
    if (crop.shown && !cropOnly) {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.rect(cropView.x, cropView.y, cropView.width, cropView.height);
      ctx.fillStyle = T.shade;
      ctx.fill("evenodd");
      outline(ctx, cropView, crop.editable);
    }
    state.padRect = null;
    if (pad.shown) {
      const base = state.cropRect ?? rect;
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
      const area = state.paintRect;
      const inside = state.hover.x >= area.x && state.hover.x <= area.x + area.width && state.hover.y >= area.y && state.hover.y <= area.y + area.height;
      if (inside) {
        const radius = Math.max(1, (mask.brushSize / 2) * perPixel);
        ctx.save();
        ctx.beginPath();
        ctx.arc(state.hover.x, state.hover.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,0,0,.7)";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = erasing(mask) ? T.warn : T.ink;
        ctx.lineWidth = 1.2;
        // A dashed ring: the stroke will be soft.
        if (softly(mask)) ctx.setLineDash([3, 3]);
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
    state.ctrl = event.ctrlKey;
    state.shift = event.shiftKey;
    if (event.button !== 0 || state.drag) return;
    const point = localPoint(event);
    const rect = state.imageRect;
    const crop = options.crop();
    const mask = options.mask();
    const pad = options.pad();
    if (rect && options.rotate?.().editable) {
      consume(event);
      const shown = state.paintRect;
      const center = { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 };
      state.drag = { turn: true, center, angle: Math.atan2(point.y - center.y, point.x - center.x), degrees: turnOf() };
      canvas.style.cursor = TURN_CURSOR;
      return;
    }
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
    const area = state.paintRect;
    if (rect && mask.editable && point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height) {
      consume(event);
      const image = options.image();
      const stroke = {
        mode: erasing(mask) ? "erase" : "draw",
        soft: softly(mask),
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
    state.ctrl = event.ctrlKey;
    state.shift = event.shiftKey;
    const point = localPoint(event);
    state.hover = point;
    const drag = state.drag;
    if (drag?.handle) {
      const dx = ((point.x - drag.start.x) / drag.imageRect.width) * 100;
      const dy = ((point.y - drag.start.y) / drag.imageRect.height) * 100;
      options.onCrop?.(dragCrop(drag.handle, drag.rect, dx, dy), drag.handle);
    } else if (drag?.turn) {
      const angle = Math.atan2(point.y - drag.center.y, point.x - drag.center.x);
      let degrees = drag.degrees + ((angle - drag.angle) * 180) / Math.PI;
      degrees = event.shiftKey ? Math.round(degrees / TURN_SNAP) * TURN_SNAP : Math.round(degrees * 10) / 10;
      options.onRotate?.((((degrees + 180) % 360) + 360) % 360 - 180);
    } else if (drag?.padHandle) {
      const perPixel = drag.imageRect.width / worldOf(options.image()).width;
      options.onPad?.(dragPad(drag.padHandle, drag.sides, (point.x - drag.start.x) / perPixel, (point.y - drag.start.y) / perPixel), drag.padHandle);
    } else if (drag?.stroke) {
      const next = toSource(point, drag.imageRect);
      const last = drag.stroke.points[drag.stroke.points.length - 1];
      if (Math.abs(last[0] - next[0]) > 0.0015 || Math.abs(last[1] - next[1]) > 0.0015) drag.stroke.points.push(next);
    } else {
      const handle = options.crop().editable ? hitCrop(point, state.cropRect) : options.pad().editable ? hitCrop(point, state.padRect) : null;
      const rect = state.imageRect;
      const area = state.paintRect;
      const onPicture = area && point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height;
      const painting = options.mask().editable && onPicture;
      canvas.style.cursor = handle ? cropCursor(handle) : painting ? "none" : options.rotate?.().editable ? TURN_CURSOR : "";
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
    if (drag?.turn) options.onRotateEnd?.();
    else if (drag?.handle) options.onCropEnd?.();
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
  // Ctrl or Shift pressed or let go over a still pointer: the brush ring follows.
  const onKey = (event) => {
    const key = { Control: "ctrl", Shift: "shift" }[event.key];
    if (!key || state[key] === (event.type === "keydown")) return;
    state[key] = event.type === "keydown";
    if (state.painting) redraw();
  };
  const onBlur = () => {
    state.ctrl = false;
    state.shift = false;
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", onBlur);

  return {
    element: root,
    canvas,
    redraw,
    dispose() {
      state.disposed = true;
      if (state.raf) cancelAnimationFrame(state.raf);
      observer.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    },
  };
}
