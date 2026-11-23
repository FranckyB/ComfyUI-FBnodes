// Pure geometry for the image stage (image_stage.mjs): fitting the picture
// into the view, and grabbing and dragging a crop rect. No DOM, for node:test.
// A crop rect is in percent of the displayed picture:
// { left_pct, right_pct, top_pct, bottom_pct }.

// The grab tolerance around a crop edge, in CSS pixels: the whole edge is
// the handle, not a small dot on it.
export const EDGE_BAND = 12;
const MIN_PCT = 1;

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
// size that is left. Mirror of _apply_crop_and_flip in nodes/load_image.py.
export function cropPixels(crop, width, height) {
  const left = Math.max(0, Math.min(Math.round((crop.left_pct / 100) * width), width - 1));
  const right = Math.max(left + 1, Math.min(Math.round((crop.right_pct / 100) * width), width));
  const top = Math.max(0, Math.min(Math.round((crop.top_pct / 100) * height), height - 1));
  const bottom = Math.max(top + 1, Math.min(Math.round((crop.bottom_pct / 100) * height), height));
  return { left, right: width - right, top, bottom: height - bottom, width: right - left, height: bottom - top };
}

export function isFullCrop(crop) {
  return crop.left_pct <= 0 && crop.top_pct <= 0 && crop.right_pct >= 100 && crop.bottom_pct >= 100;
}
