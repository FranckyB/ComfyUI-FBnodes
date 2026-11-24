"""Load Image+'s edits after the mask: rotate, crop, flip, scale, pad, the output snapped to a step.

Rotation, the step layout and the megapixel budget follow ComfyUI-AusBoss's transform engine (MIT, (c) 2026
ausboss): any angle through Pillow with the canvas grown to hold the turn, the crop measured on the turned
picture, and the picture scaled on its own with the padding rebuilt around it, so the fill never smears into
its edge. js/common/stage_math.js mirrors the geometry for the node's preview and size readout.

Masks: 1 marks the area to paint. A file without alpha gives all ones, which marks nothing; such a mask is
kept as it is until a turn or padding adds an area of its own.
"""

import json

import comfy.utils
import numpy as np
import torch
from PIL import Image

# Core Pad Image for Outpainting's fill.
FILL = 0.5
SCALE_METHODS = ("lanczos", "area", "bicubic", "bilinear", "nearest-exact")


def _parse(data):
    try:
        parsed = json.loads(data) if data else {}
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _enabled(state):
    value = state.get("enabled")
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _marks(mask):
    return mask is not None and bool(mask.min() < 1)


def parse_rotation(rotate_data):
    """Clockwise degrees in -180..180, 0 when rotation is off."""
    state = _parse(rotate_data)
    if not _enabled(state):
        return 0.0
    try:
        degrees = float(state.get("degrees") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return round((degrees + 180.0) % 360.0 - 180.0, 4)


def crop_first(rotate_data):
    """Whether the crop comes before the turn (the cropped part is turned) rather than after it (the crop is
    measured on the turned picture, the default)."""
    return _parse(rotate_data).get("order") == "crop_first"


def parse_crop(crop_data):
    """The crop as fractions (left, top, right, bottom) of the turned picture, or None when off."""
    state = _parse(crop_data)
    if not _enabled(state):
        return None

    def fraction(key, default):
        try:
            return max(0.0, min(1.0, float(state.get(key, default)) / 100.0))
        except (TypeError, ValueError):
            return default / 100.0

    left, top = fraction("left_pct", 0.0), fraction("top_pct", 0.0)
    right, bottom = max(left, fraction("right_pct", 100.0)), max(top, fraction("bottom_pct", 100.0))
    return left, top, right, bottom


def parse_pad(pad_data):
    """Pixels added on each side and the feather; all zero when padding is off."""
    state = _parse(pad_data)
    keys = ("left", "right", "top", "bottom", "feather")
    if not _enabled(state):
        return dict.fromkeys(keys, 0)
    pad = {}
    for key in keys:
        try:
            pad[key] = max(0, int(state.get(key) or 0))
        except (TypeError, ValueError):
            pad[key] = 0
    return pad


def parse_scale(scale_data):
    """(mode, value, method) with mode "factor" or "megapixels", or None when scaling is off."""
    state = _parse(scale_data)
    if not _enabled(state):
        return None
    mode = "factor" if state.get("mode") == "factor" else "megapixels"
    try:
        value = float(state.get(mode, 1.0))
    except (TypeError, ValueError):
        return None
    method = state.get("method") if state.get("method") in SCALE_METHODS else SCALE_METHODS[0]
    return (mode, value, method) if value > 0 else None


def rotate(image, mask, degrees):
    """Turn clockwise, the canvas grown to hold the whole picture (AusBoss's _rotate_rgba). The corners are
    the pad fill and 1 in the mask, like padding."""
    if degrees == 0.0:
        return image, mask
    marks = _marks(mask)
    frames, masks = [], []
    for index in range(image.shape[0]):
        pixels = (image[index].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        picture = Image.fromarray(pixels, "RGB").convert("RGBA")
        turned = np.asarray(picture.rotate(-degrees, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(128, 128, 128, 0)), dtype=np.float32) / 255.0
        cover = torch.from_numpy(turned[..., 3].copy())
        frame = torch.from_numpy(turned[..., :3].copy())
        frames.append(torch.where(cover[..., None] > 0, frame, torch.tensor(FILL)))
        corners = 1.0 - cover
        if marks:
            painted = Image.fromarray((mask[min(index, mask.shape[0] - 1)].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy(), "L")
            turned_mask = torch.from_numpy(np.asarray(painted.rotate(-degrees, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=255), dtype=np.float32) / 255.0)
            corners = torch.maximum(corners, turned_mask)
        elif not bool(corners.any()):
            # A quarter turn adds no corners: a mask that marked nothing still does, in the same form.
            corners = torch.ones_like(corners)
        masks.append(corners)
    return torch.stack(frames).to(image), torch.stack(masks).to(image.device)


def crop(image, mask, fractions):
    """The crop on the turned picture, at least one pixel each way."""
    if fractions is None:
        return image, mask
    height, width = image.shape[1], image.shape[2]
    left, top, right, bottom = fractions
    x0 = max(0, min(int(round(left * width)), width - 1))
    y0 = max(0, min(int(round(top * height)), height - 1))
    x1 = max(x0 + 1, min(int(round(right * width)), width))
    y1 = max(y0 + 1, min(int(round(bottom * height)), height))
    return image[:, y0:y1, x0:x1], None if mask is None else mask[:, y0:y1, x0:x1]


def flip(image, mask, flip_x, flip_y):
    # Width and height are dims 2 and 1 of both the BHWC image and the BHW mask.
    dims = [dim for dim, on in ((2, flip_x), (1, flip_y)) if on]
    if not dims:
        return image, mask
    return torch.flip(image, dims=dims), None if mask is None else torch.flip(mask, dims=dims)


def scale_factor(scale, width, height):
    """The factor for a (mode, value, method) scale, the megapixel budget counted on the whole canvas as
    core Scale Image To Total Pixels does (budget = megapixels * 1024 * 1024)."""
    if scale is None:
        return 1.0
    mode, value, _ = scale
    if mode == "megapixels":
        return (value * 1024 * 1024 / max(1, width * height)) ** 0.5
    return value


def axis_layout(size, before, after, multiple):
    """One axis snapped to the step: (before, after, trim_before, trim_after, length), AusBoss's _axis_layout.
    The length rounds up and the leftover joins a padded side (the far one when both are); an axis nobody padded
    is trimmed evenly to the multiple below instead, so no strip appears that nobody asked for."""
    step = max(1, int(multiple))
    requested = size + before + after
    length = -(-requested // step) * step
    leftover = length - requested
    if leftover == 0 or after > 0:
        return before, after + leftover, 0, 0, length
    if before > 0:
        return before + leftover, after, 0, 0, length
    kept = (size // step) * step
    if kept <= 0:
        return before, after + leftover, 0, 0, length
    trim = size - kept
    return 0, 0, trim // 2, trim - trim // 2, kept


def _feather(height, width, pad, device):
    """Core Pad Image for Outpainting's feather: ((feather - d) / feather)^2 at d pixels from the nearest padded
    edge, none when the feather is half the picture or more."""
    feather = pad["feather"]
    if feather <= 0 or feather * 2 >= height or feather * 2 >= width:
        return torch.zeros((height, width), device=device)

    def edge_distance(size, start, end):
        index = torch.arange(size, dtype=torch.float32, device=device)
        far = torch.full_like(index, float(feather))
        return torch.minimum(index if start else far, size - index if end else far)

    distance = torch.minimum(edge_distance(height, pad["top"], pad["bottom"])[:, None], edge_distance(width, pad["left"], pad["right"])[None, :])
    return ((feather - distance).clamp(min=0) / feather) ** 2


def pad_canvas(image, mask, pad):
    """Extend the canvas for outpainting as core Pad Image for Outpainting does: the new area is the fill and
    1 in the mask, fading into the picture over the feather, joined with the painted (or alpha) mask."""
    if not (pad["left"] or pad["right"] or pad["top"] or pad["bottom"]):
        return image, mask
    batch, height, width, channels = image.shape
    left, right, top, bottom = pad["left"], pad["right"], pad["top"], pad["bottom"]
    padded = torch.full((batch, height + top + bottom, width + left + right, channels), FILL, dtype=image.dtype, device=image.device)
    padded[:, top:top + height, left:left + width] = image

    inner = _feather(height, width, pad, image.device).expand(batch, height, width)
    if _marks(mask) and mask.shape[-2:] == (height, width):
        inner = torch.maximum(inner, mask.to(image.device))
    canvas_mask = torch.ones((batch, height + top + bottom, width + left + right), dtype=torch.float32, device=image.device)
    canvas_mask[:, top:top + height, left:left + width] = inner
    return padded, canvas_mask


def transform(image, mask, crop_data="", flip_x=False, flip_y=False, pad_data="", rotate_data="", scale_data="", step=1):
    """(picture, mask, canvas): the picture turned, cropped, flipped and scaled; the canvas the picture padded;
    both snapped to the step while an edit that changes the size is on, the mask the canvas's."""
    if not any(_enabled(_parse(data)) for data in (crop_data, pad_data, rotate_data, scale_data)):
        step = 1
    if crop_first(rotate_data):
        image, mask = crop(image, mask, parse_crop(crop_data))
        image, mask = rotate(image, mask, parse_rotation(rotate_data))
    else:
        image, mask = rotate(image, mask, parse_rotation(rotate_data))
        image, mask = crop(image, mask, parse_crop(crop_data))
    image, mask = flip(image, mask, flip_x, flip_y)

    pad = parse_pad(pad_data)
    scale = parse_scale(scale_data)
    height, width = image.shape[1], image.shape[2]
    factor = scale_factor(scale, width + pad["left"] + pad["right"], height + pad["top"] + pad["bottom"])
    if factor != 1.0:
        width, height = max(1, round(width * factor)), max(1, round(height * factor))
        image = comfy.utils.common_upscale(image.movedim(-1, 1), width, height, scale[2], "disabled").movedim(1, -1).clamp(0.0, 1.0)
        if mask is not None:
            # Bilinear: the mask is a soft coverage map that a ringing method would push outside 0..1.
            mask = comfy.utils.common_upscale(mask.unsqueeze(1), width, height, "bilinear", "disabled").squeeze(1).clamp(0.0, 1.0)
        pad = {key: round(value * factor) for key, value in pad.items()}

    pad["left"], pad["right"], trim_left, trim_right, _ = axis_layout(width, pad["left"], pad["right"], step)
    pad["top"], pad["bottom"], trim_top, trim_bottom, _ = axis_layout(height, pad["top"], pad["bottom"], step)
    image = image[:, trim_top:height - trim_bottom, trim_left:width - trim_right]
    if mask is not None:
        mask = mask[:, trim_top:height - trim_bottom, trim_left:width - trim_right]
    canvas, mask = pad_canvas(image, mask, pad)
    return image, mask, canvas
