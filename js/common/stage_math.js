// Pure geometry for the image stage (image_stage.js): fitting the picture
// into the view, and grabbing and dragging a crop rect. No DOM, for node:test.
// A crop rect is in percent of the displayed picture:
// { left_pct, right_pct, top_pct, bottom_pct }.

// The grab tolerance around a crop edge, in CSS pixels: the whole edge is
// the handle, not a small dot on it.
export const EDGE_BAND = 12;
const MIN_PCT = 1;

// Python's round(): a half goes to the even neighbour, so sizes here match
// the backend's to the pixel.
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

// Aspect-fit a world size into a view with a uniform margin.
export function fitRect(worldW, worldH, viewW, viewH, margin = 0) {
  const availW = Math.max(1, viewW - margin * 2);
  const availH = Math.max(1, viewH - margin * 2);
  const scale = Math.max(0.0001, Math.min(availW / Math.max(1, worldW), availH / Math.max(1, worldH)));
  const width = worldW * scale;
  const height = worldH * scale;
  return { x: (viewW - width) / 2, y: (viewH - height) / 2, width, height, scale };
}

// A crop rect in view pixels, given the picture's rect in the view.
export function cropViewRect(crop, image) {
  const x = image.x + (crop.left_pct / 100) * image.width;
  const y = image.y + (crop.top_pct / 100) * image.height;
  return {
    x,
    y,
    width: image.x + (crop.right_pct / 100) * image.width - x,
    height: image.y + (crop.bottom_pct / 100) * image.height - y,
  };
}

// What a press at `point` grabs: an edge ("n", "e", "s", "w"), a corner
// ("ne", ...) where two edges meet, "move" inside the rect, or null outside,
// so the press falls through to the node.
export function hitCrop(point, rect, band = EDGE_BAND) {
  if (!rect || !point) return null;
  const { x, y } = point;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (x < rect.x - band || x > right + band || y < rect.y - band || y > bottom + band) return null;
  // On a small rect the bands overlap; the nearer edge wins.
  const nearX = Math.abs(x - rect.x) <= Math.abs(x - right) ? "w" : "e";
  const nearY = Math.abs(y - rect.y) <= Math.abs(y - bottom) ? "n" : "s";
  const onX = Math.min(Math.abs(x - rect.x), Math.abs(x - right)) <= band;
  const onY = Math.min(Math.abs(y - rect.y), Math.abs(y - bottom)) <= band;
  if (onX && onY) return nearY + nearX;
  if (onX) return nearX;
  if (onY) return nearY;
  return "move";
}

export function cropCursor(handle) {
  return {
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
    move: "move",
  }[handle] ?? "";
}

// The rect after dragging `handle` by (dx, dy) percent from `start`.
export function dragCrop(handle, start, dxPct, dyPct) {
  const rect = { ...start };
  if (handle === "move") {
    const width = start.right_pct - start.left_pct;
    const height = start.bottom_pct - start.top_pct;
    rect.left_pct = Math.max(0, Math.min(100 - width, start.left_pct + dxPct));
    rect.right_pct = rect.left_pct + width;
    rect.top_pct = Math.max(0, Math.min(100 - height, start.top_pct + dyPct));
    rect.bottom_pct = rect.top_pct + height;
    return rect;
  }
  if (handle.includes("w")) rect.left_pct = Math.max(0, Math.min(start.right_pct - MIN_PCT, start.left_pct + dxPct));
  if (handle.includes("e")) rect.right_pct = Math.min(100, Math.max(start.left_pct + MIN_PCT, start.right_pct + dxPct));
  if (handle.includes("n")) rect.top_pct = Math.max(0, Math.min(start.bottom_pct - MIN_PCT, start.top_pct + dyPct));
  if (handle.includes("s")) rect.bottom_pct = Math.min(100, Math.max(start.top_pct + MIN_PCT, start.bottom_pct + dyPct));
  return rect;
}

// Pixels a crop trims from each side of a width x height picture, and the
// size that is left. Mirror of crop in py/image_transform.py.
export function cropPixels(crop, width, height) {
  const left = Math.max(0, Math.min(roundHalfEven((crop.left_pct / 100) * width), width - 1));
  const right = Math.max(left + 1, Math.min(roundHalfEven((crop.right_pct / 100) * width), width));
  const top = Math.max(0, Math.min(roundHalfEven((crop.top_pct / 100) * height), height - 1));
  const bottom = Math.max(top + 1, Math.min(roundHalfEven((crop.bottom_pct / 100) * height), height));
  return { left, right: width - right, top, bottom: height - bottom, width: right - left, height: bottom - top };
}

export function isFullCrop(crop) {
  return crop.left_pct <= 0 && crop.top_pct <= 0 && crop.right_pct >= 100 && crop.bottom_pct >= 100;
}

// Padding is in pixels added beyond the output on each side:
// { left, right, top, bottom }.

// The pad after dragging `handle` by (dx, dy) picture pixels from `start`;
// "move" slides the canvas around the picture without changing its size.
export function dragPad(handle, start, dx, dy) {
  const pad = { ...start };
  if (handle === "move") {
    const x = Math.max(-start.right, Math.min(start.left, Math.round(dx)));
    const y = Math.max(-start.bottom, Math.min(start.top, Math.round(dy)));
    return { ...pad, left: start.left - x, right: start.right + x, top: start.top - y, bottom: start.bottom + y };
  }
  const px = (value) => Math.max(0, Math.round(value));
  if (handle.includes("w")) pad.left = px(start.left - dx);
  if (handle.includes("e")) pad.right = px(start.right + dx);
  if (handle.includes("n")) pad.top = px(start.top - dy);
  if (handle.includes("s")) pad.bottom = px(start.bottom + dy);
  return pad;
}

// The pad after an edit by `handle`, held to `ratio` (canvas width / height)
// around a width x height output. An edge drives its own axis and the other
// follows, evenly about its centre; a corner (or "", a new ratio) grows the
// canvas to cover both. The canvas never gets smaller than the output.
export function lockPad(pad, handle, width, height, ratio) {
  if (handle === "move") return pad;
  const horizontal = /[ew]/.test(handle);
  const vertical = /[ns]/.test(handle);
  let w = width + pad.left + pad.right;
  const h = height + pad.top + pad.bottom;
  if (vertical && !horizontal) w = h * ratio;
  else if (vertical === horizontal) w = Math.max(w, h * ratio);
  w = Math.round(Math.max(w, width, height * ratio));
  const next = { ...pad };
  // The dragged side takes the change; without one, both share it.
  const share = (first, second, extra, letterFirst, letterSecond) => {
    if (handle.includes(letterFirst)) next[first] += extra;
    else if (handle.includes(letterSecond)) next[second] += extra;
    else {
      next[first] += Math.trunc(extra / 2);
      next[second] += extra - Math.trunc(extra / 2);
    }
    if (next[first] < 0) [next[second], next[first]] = [next[second] + next[first], 0];
    if (next[second] < 0) [next[first], next[second]] = [next[first] + next[second], 0];
  };
  share("left", "right", w - width - pad.left - pad.right, "w", "e");
  share("top", "bottom", Math.round(w / ratio) - height - pad.top - pad.bottom, "n", "s");
  return next;
}

// The picture's rect in the view when the padded canvas (and `slack` picture
// pixels around it) must fit too. `base` is the output inside the picture, in
// picture pixels { x, y, width, height }.
export function padFitRect(imageW, imageH, base, pad, viewW, viewH, slack = 0) {
  const x0 = Math.min(0, base.x - pad.left) - slack;
  const y0 = Math.min(0, base.y - pad.top) - slack;
  const x1 = Math.max(imageW, base.x + base.width + pad.right) + slack;
  const y1 = Math.max(imageH, base.y + base.height + pad.bottom) + slack;
  const world = fitRect(x1 - x0, y1 - y0, viewW, viewH);
  return { x: world.x - x0 * world.scale, y: world.y - y0 * world.scale, width: imageW * world.scale, height: imageH * world.scale, scale: world.scale };
}

// A crop held to `ratio` (width / height in picture pixels) on a width x
// height picture, after an edit by `handle`: an edge drives its own axis and
// the other follows evenly about its centre, a corner keeps the opposite
// corner, and "" (a new ratio) fits inside the crop about its centre. The
// crop stays inside the picture.
export function lockCrop(rect, handle, width, height, ratio) {
  if (handle === "move") return rect;
  const horizontal = /[ew]/.test(handle);
  const vertical = /[ns]/.test(handle);
  const x0 = (rect.left_pct / 100) * width;
  const x1 = (rect.right_pct / 100) * width;
  const y0 = (rect.top_pct / 100) * height;
  const y1 = (rect.bottom_pct / 100) * height;
  let w = x1 - x0;
  let h = y1 - y0;
  if (vertical && !horizontal) w = h * ratio;
  else if (horizontal) h = w / ratio;
  else if (w / h > ratio) w = h * ratio;
  else h = w / ratio;
  if (w > width) [w, h] = [width, width / ratio];
  if (h > height) [w, h] = [height * ratio, height];
  // The dragged side moves; an axis with none dragged keeps its centre.
  const place = (lo, hi, size, total, fromLo, fromHi) => {
    const start = fromHi ? lo : fromLo ? hi - size : (lo + hi - size) / 2;
    const at = Math.max(0, Math.min(total - size, start));
    return [(at / total) * 100, ((at + size) / total) * 100];
  };
  const [left_pct, right_pct] = place(x0, x1, w, width, handle.includes("w"), handle.includes("e"));
  const [top_pct, bottom_pct] = place(y0, y1, h, height, handle.includes("n"), handle.includes("s"));
  return { ...rect, left_pct, right_pct, top_pct, bottom_pct };
}

// The turned picture's size: Pillow's rotate(expand=True), so the stage and
// the caption match the run. AusBoss's transform_geometry.mjs rotatedSize
// (MIT, (c) 2026 ausboss); py/image_transform.py rotate.
export function rotatedSize(width, height, degrees) {
  const normalized = ((Number(degrees) || 0) % 360 + 360) % 360;
  if (normalized === 0 || normalized === 180) return { width: Math.max(1, width), height: Math.max(1, height) };
  if (normalized === 90 || normalized === 270) return { width: Math.max(1, height), height: Math.max(1, width) };
  const radians = normalized * Math.PI / 180;
  const round15 = (value) => Math.round(value * 1e15) / 1e15;
  const cosine = round15(Math.cos(radians));
  const sine = round15(Math.sin(radians));
  const xs = [];
  const ys = [];
  for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
    xs.push(width / 2 + (x - width / 2) * cosine - (y - height / 2) * sine);
    ys.push(height / 2 + (x - width / 2) * sine + (y - height / 2) * cosine);
  }
  return {
    width: Math.max(1, Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs))),
    height: Math.max(1, Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys))),
  };
}

// A point on the turned picture (pixels, origin top left) as a point on the
// picture itself, for a clockwise turn by `degrees` about the centre.
export function unturnPoint(x, y, picture, turned, degrees) {
  const radians = (Number(degrees) || 0) * Math.PI / 180;
  const dx = x - turned.width / 2;
  const dy = y - turned.height / 2;
  return [picture.width / 2 + dx * Math.cos(radians) + dy * Math.sin(radians), picture.height / 2 - dx * Math.sin(radians) + dy * Math.cos(radians)];
}

// One axis snapped to the step: [before, after, trimBefore, trimAfter, length].
// The length rounds up and the leftover joins a padded side (the far one when
// both are); an axis nobody padded is trimmed evenly to the multiple below.
// AusBoss's _axis_layout; py/image_transform.py axis_layout.
export function axisLayout(size, before, after, multiple) {
  const step = Math.max(1, Math.trunc(multiple) || 1);
  const requested = size + before + after;
  const length = Math.ceil(requested / step) * step;
  const leftover = length - requested;
  if (leftover === 0 || after > 0) return [before, after + leftover, 0, 0, length];
  if (before > 0) return [before + leftover, after, 0, 0, length];
  const kept = Math.floor(size / step) * step;
  if (kept <= 0) return [before, after + leftover, 0, 0, length];
  const trim = size - kept;
  return [0, 0, Math.floor(trim / 2), trim - Math.floor(trim / 2), kept];
}

// The scale factor for { mode, factor, megapixels }, the megapixel budget
// counted on the whole canvas (core Scale Image To Total Pixels).
export function scaleFactor(scale, width, height) {
  if (!scale?.enabled) return 1;
  if (scale.mode === "megapixels") return Math.sqrt((Number(scale.megapixels) * 1024 * 1024) / Math.max(1, width * height));
  return Number(scale.factor) || 1;
}

// What the node outputs for a `cropped` picture (after the turn and crop),
// mirroring py/image_transform.py transform: the picture scaled, its padding
// scaled with it, both snapped to the step. Returns the picture's size, the
// canvas's and the padding on each side.
export function outputLayout(cropped, pad, scale, step) {
  const sides = pad?.enabled ? pad : { left: 0, right: 0, top: 0, bottom: 0 };
  const factor = scaleFactor(scale, cropped.width + sides.left + sides.right, cropped.height + sides.top + sides.bottom);
  let width = cropped.width;
  let height = cropped.height;
  let { left, right, top, bottom } = sides;
  if (factor !== 1) {
    width = Math.max(1, roundHalfEven(width * factor));
    height = Math.max(1, roundHalfEven(height * factor));
    [left, right, top, bottom] = [left, right, top, bottom].map((value) => roundHalfEven(value * factor));
  }
  const [padLeft, padRight, trimLeft, trimRight, canvasWidth] = axisLayout(width, left, right, step);
  const [padTop, padBottom, trimTop, trimBottom, canvasHeight] = axisLayout(height, top, bottom, step);
  return {
    picture: { width: width - trimLeft - trimRight, height: height - trimTop - trimBottom },
    canvas: { width: canvasWidth, height: canvasHeight },
    pad: { left: padLeft, right: padRight, top: padTop, bottom: padBottom },
  };
}
