"""
CropImagePlus - interactive crop node with aspect-ratio presets.
"""

from __future__ import annotations

import base64
import hashlib
import io
import re
from typing import Optional

import numpy as np
import torch
from PIL import Image


ASPECT_RATIO_PRESETS = [
    "None",
    "1:1",
    "1.25:1",
    "1.5:1",
    "1.778:1",
    "1.875:1",
    "2:1",
    "2.4:1",
]


def _parse_ratio(label: str) -> Optional[float]:
    if not label or label == "None":
        return None
    m = re.match(r"\s*([0-9]*\.?[0-9]+)\s*:\s*([0-9]*\.?[0-9]+)\s*", label)
    if not m:
        return None
    a = float(m.group(1))
    b = float(m.group(2))
    if b == 0:
        return None
    return a / b


def _clamp_crop(left: int, right: int, top: int, bottom: int, width: int, height: int):
    left = max(0, min(int(left), width - 1))
    right = max(left + 1, min(int(right), width))
    top = max(0, min(int(top), height - 1))
    bottom = max(top + 1, min(int(bottom), height))
    return left, right, top, bottom


def _fit_rect_aspect(left: int, right: int, top: int, bottom: int, width: int, height: int, ratio: float):
    """Keep center and fit rectangle to requested width/height ratio."""
    if ratio <= 0:
        return left, right, top, bottom

    cx = (left + right) / 2.0
    cy = (top + bottom) / 2.0
    rw = max(1.0, right - left)
    rh = max(1.0, bottom - top)
    current = rw / rh

    if current > ratio:
        rw = rh * ratio
    else:
        rh = rw / ratio

    rw = min(rw, float(width))
    rh = min(rh, float(height))

    left = int(round(cx - rw / 2.0))
    right = int(round(cx + rw / 2.0))
    top = int(round(cy - rh / 2.0))
    bottom = int(round(cy + rh / 2.0))

    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > width:
        left -= (right - width)
        right = width
    if bottom > height:
        top -= (bottom - height)
        bottom = height

    left, right, top, bottom = _clamp_crop(left, right, top, bottom, width, height)
    return left, right, top, bottom


def _preview_data_url(image_tensor: torch.Tensor, max_side: int = 640) -> str:
    arr = image_tensor.cpu().numpy()
    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)

    w, h = img.size
    scale = min(1.0, float(max_side) / float(max(w, h)))
    if scale < 1.0:
        img = img.resize((max(1, int(round(w * scale))), max(1, int(round(h * scale)))), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _preview_from_image_or_mask(image: Optional[torch.Tensor], mask: Optional[torch.Tensor]) -> tuple[str, int, int, str]:
    """Build preview data URL and dimensions from image or mask input."""
    if image is not None and image.shape[0] > 0:
        h = int(image.shape[1])
        w = int(image.shape[2])
        sig_src = image[0, : min(h, 16), : min(w, 16), :].cpu().numpy().tobytes()
        signature = hashlib.sha1(sig_src).hexdigest()[:16]
        preview = _preview_data_url(image[0])
        return preview, w, h, signature

    if mask is not None and mask.shape[0] > 0:
        # MASK is typically [B,H,W]. Convert first sample to grayscale RGB preview.
        h = int(mask.shape[1])
        w = int(mask.shape[2])
        m = mask[0].detach().cpu().numpy()
        m = np.clip(m, 0.0, 1.0)
        m_rgb = np.stack([m, m, m], axis=-1)
        m_tensor = torch.from_numpy(m_rgb.astype(np.float32))
        sig_src = mask[0, : min(h, 16), : min(w, 16)].cpu().numpy().tobytes()
        signature = hashlib.sha1(sig_src).hexdigest()[:16]
        preview = _preview_data_url(m_tensor)
        return preview, w, h, signature

    # No connected media yet.
    blank = torch.zeros((64, 64, 3), dtype=torch.float32)
    preview = _preview_data_url(blank)
    return preview, 64, 64, "none"


class CropImagePlus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "left": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
                "right": ("INT", {"default": 640, "min": 1, "max": 999999, "step": 1}),
                "top": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
                "bottom": ("INT", {"default": 480, "min": 1, "max": 999999, "step": 1}),
                "aspect_ratio": (ASPECT_RATIO_PRESETS, {"default": "None"}),
                "landscape": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "crop"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = "Interactive crop with draggable box and optional aspect-ratio lock."

    def crop(self, left, right, top, bottom, aspect_ratio, landscape, image=None, mask=None):
        preview, width, height, signature = _preview_from_image_or_mask(image, mask)

        left, right, top, bottom = _clamp_crop(left, right, top, bottom, width, height)

        ratio = _parse_ratio(aspect_ratio)
        if ratio is not None and landscape:
            ratio = 1.0 / ratio if ratio != 0 else ratio
        if ratio is not None:
            left, right, top, bottom = _fit_rect_aspect(left, right, top, bottom, width, height, ratio)

        if image is not None and image.shape[0] > 0:
            cropped_image = image[:, top:bottom, left:right, :]
        else:
            cropped_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)

        if mask is not None and mask.shape[0] > 0:
            cropped_mask = mask[:, top:bottom, left:right]
        else:
            cropped_mask = torch.zeros((1, 1, 1), dtype=torch.float32)

        return {
            "ui": {
                "dragcrop": [{
                    "preview": preview,
                    "width": width,
                    "height": height,
                    "signature": signature,
                    "left": left,
                    "right": right,
                    "top": top,
                    "bottom": bottom,
                    "aspect_ratio": aspect_ratio,
                    "landscape": bool(landscape),
                }]
            },
            "result": (cropped_image, cropped_mask),
        }
