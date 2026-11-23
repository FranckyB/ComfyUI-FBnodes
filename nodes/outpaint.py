'''
Outpainting beside MiniMax H3 Image Conditioning. Load Image+'s Pad (or core
Pad Image for Outpainting) makes the canvas and its mask:

  Outpaint Source  the picture cut from the canvas for the conditioning's
                   image_1, so the text encoder never sees the pad, and the
                   canvas's size at a pixel count for its width and height.

  Outpaint Latent  the canvas, VAE-encoded at the conditioning's resolution,
                   with a noise mask that frees the new area for KSampler.
                   Picture 1's reference becomes the cells of the picture the
                   mask keeps whole, placed on the canvas where they sit, so
                   the model continues the picture instead of copying the pad.
  Outpaint Blend   the decoded result back on the canvas with AusBoss's
                   "blend in" seam and its Tone match (py/blend_in).

Inspired by TwoAbove's ComfyUI-H3VideoOutpaint and the Outpaint Anchor / Prepare of
aitrepreneur's ComfyUI-Aitrepreneur-Image-Tools (MIT).
'''

import math

import torch.nn.functional as F

import comfy.ldm.minimax.model
import comfy.patcher_extension
import comfy.utils

from ..py.blend_in import blend as blend_in


def _resize(image, width, height):
    return comfy.utils.common_upscale(image[..., :3].movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)


def _mask_at(mask, width, height):
    """A MASK as [B, 1, height, width]."""
    mask = mask.reshape(-1, 1, mask.shape[-2], mask.shape[-1])
    return F.interpolate(mask, size=(height, width), mode="bilinear")


def _canvas_size(width, height, latent_w, latent_h, cell):
    """The conditioning latent's pixel area at the canvas's aspect, on a two-cell grid (MiniMax canvases are
    multiples of 32 px); its exact size when the two aspects already agree."""
    step = cell * 2
    scale = math.sqrt(latent_w * latent_h * cell * cell / (width * height))
    size_w = max(step, round(width * scale / step) * step)
    size_h = max(step, round(height * scale / step) * step)
    if abs(size_w - latent_w * cell) <= step and abs(size_h - latent_h * cell) <= step:
        return latent_w * cell, latent_h * cell
    return size_w, size_h


def _box(inside):
    """(top, left, bottom, right) around the True cells of a [H, W] grid, or None."""
    rows = inside.any(dim=1).nonzero()
    cols = inside.any(dim=0).nonzero()
    if not len(rows):
        return None
    return int(rows[0]), int(cols[0]), int(rows[-1]) + 1, int(cols[-1]) + 1


def _edge_context(canvas, mask):
    """The canvas with the picture's edges stretched over the new area, so no fill colour leaks into the
    picture's latent cells along the seam."""
    height, width = canvas.shape[1:3]
    box = _box(_mask_at(mask[:1], width, height)[0, 0] < 1)
    if box is None:
        return canvas
    top, left, bottom, right = box
    picture = canvas[:, top:bottom, left:right, :3].movedim(-1, 1)
    return F.pad(picture, (left, width - right, top, height - bottom), mode="replicate").movedim(1, -1)


def _kept_cells(mask, cell):
    """The DiT patches (2x2 latent cells) the mask keeps whole, as latent cells (top, left, bottom, right), or
    None. `mask` is [1, 1, H, W] at the sampling size."""
    box = _box(F.max_pool2d(mask, cell * 2)[0, 0] <= 1e-3)
    return None if box is None else tuple(side * 2 for side in box)


def _placed_refs(refs, samples, cells):
    """The conditioning's references with Picture 1 swapped for the picture cut from the canvas latent, carrying
    where it sits on the canvas."""
    top, left, bottom, right = cells
    placed = {
        "kind": "image", "latent_h": bottom - top, "latent_w": right - left,
        "latent": samples[..., top:bottom, left:right].clone(),
        "outpaint_place": (samples.shape[-2], samples.shape[-1], top, left),
    }
    refs = list(refs or [])
    first = next((i for i, ref in enumerate(refs) if ref.get("kind") == "image"), None)
    if first is None:
        return [placed] + refs
    refs[first] = placed
    return refs


def _place_references(executor, *args, **kwargs):
    """Model wrapper: a placed reference takes the canvas positions of the cells it was cut from, instead of a
    grid of its own, so the model reads it as that part of the picture it paints. Only MiniMax H3 Image carries
    references this way; any other model passes straight through."""
    payload = kwargs.get("minimax_payload") or {}
    refs = payload.get("refs") or []
    if any("outpaint_place" in ref for ref in refs):
        x, context = args[0], args[2]
        lat_h, lat_w = (x.shape[3] + 1) // 2 * 2, (x.shape[4] + 1) // 2 * 2
        layout = comfy.ldm.minimax.model.PackedLayout(context.shape[1], x.shape[2], lat_h, lat_w, 0, refs=refs)
        va, vb, _ = layout.segments[-1]  # the target picture
        canvas = layout.position_ids[va:va + (lat_h // 2) * (lat_w // 2), 1:].reshape(lat_h // 2, lat_w // 2, 2)
        segments = [(a, b) for a, b, kind in layout.segments if kind == "ref_img"]
        for (a, b), ref in zip(segments, [ref for ref in refs if ref.get("kind") != "audio"]):
            place = ref.get("outpaint_place")
            if place is None or place[:2] != (lat_h, lat_w):
                continue
            top, left = place[2] // 2, place[3] // 2
            layout.position_ids[a:b, 1:] = canvas[top:top + ref["latent_h"] // 2, left:left + ref["latent_w"] // 2].reshape(-1, 2)
        kwargs["minimax_payload"] = {**payload, "layout": layout}
    return executor(*args, **kwargs)


class OutpaintSource:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK", {"tooltip": "The canvas's mask: 1 over the new area."}),
                "canvas": ("IMAGE", {"tooltip": "The padded canvas."}),
                "megapixels": ("FLOAT", {"default": 4.0, "min": 0.0, "max": 64.0, "step": 0.25,
                                         "tooltip": "The pixel count to sample the canvas at; 0 keeps the canvas's own. MiniMax H3 Image is tuned for about 4."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")
    OUTPUT_TOOLTIPS = ("The picture without the pad: image_1 of MiniMax H3 Image Conditioning.", "The canvas's width at that pixel count, a multiple of 32.", "The canvas's height at that pixel count, a multiple of 32.")
    FUNCTION = "source"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Cuts the picture out of an outpaint canvas for MiniMax H3 Image Conditioning's image_1, and gives the canvas's width and height at a pixel count, for the conditioning's width and height."

    def source(self, mask, canvas, megapixels):
        height, width = canvas.shape[1:3]
        box = _box(_mask_at(mask[:1], width, height)[0, 0] < 1)
        top, left, bottom, right = box or (0, 0, height, width)
        scale = math.sqrt(megapixels * 1e6 / (width * height)) if megapixels > 0 else 1.0
        size_w = max(32, round(width * scale / 32) * 32)
        size_h = max(32, round(height * scale / 32) * 32)
        return (canvas[:, top:bottom, left:right, :3].clone(), size_w, size_h)


class OutpaintLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The MiniMax H3 Image model, after any LoRAs."}),
                "positive": ("CONDITIONING", {"tooltip": "From MiniMax H3 Image Conditioning."}),
                "vae": ("VAE",),
                "mask": ("MASK", {"tooltip": "1 where to paint: the new area, and anything painted."}),
                "canvas": ("IMAGE", {"tooltip": "The padded canvas (Load Image+'s canvas with Pad on). Its image output goes to the conditioning's image_1."}),
                "latent": ("LATENT", {"tooltip": "The latent of MiniMax H3 Image Conditioning: its size sets the resolution."}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("model", "positive", "latent")
    FUNCTION = "encode"
    CATEGORY = "FBnodes"
    DESCRIPTION = "VAE-encodes a padded canvas at the latent's resolution (keeping the canvas's aspect) with a noise mask, so KSampler paints only the new area; any model. With MiniMax H3 Image, Picture 1's reference also becomes the picture alone, placed where it sits on the canvas, so the model continues it instead of copying the pad. Give the conditioning the unpadded picture (Load Image+'s image) as image_1."

    def encode(self, model, positive, vae, mask, canvas, latent):
        cell = vae.spacial_compression_encode()
        latent_h, latent_w = latent["samples"].shape[-2:]
        width, height = _canvas_size(canvas.shape[2], canvas.shape[1], latent_w, latent_h, cell)
        samples = vae.encode(_resize(_edge_context(canvas[:1], mask), width, height))
        noise_mask = _mask_at(mask[:1], width, height)
        out = latent.copy()
        out["samples"] = samples
        out["noise_mask"] = noise_mask

        cells = _kept_cells(noise_mask, cell)
        if cells is None:
            return (model, positive, out)
        positive = [[text, {**values, "minimax_refs": _placed_refs(values.get("minimax_refs"), samples, cells)}] for text, values in positive]
        model = model.clone()
        model.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, "fbnodes_outpaint", _place_references)
        return (model, positive, out)


class OutpaintBlend:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The decoded result."}),
                "mask": ("MASK", {"tooltip": "The canvas's mask, as the sampler had it."}),
                "canvas": ("IMAGE", {"tooltip": "The padded canvas the result was painted on."}),
                "tone_match": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                         "tooltip": "Match the new area's tone to your picture when it comes back lighter, darker or warmer. 1 is the full match, 0 is off; it needs a feather, since it reads the strip of your picture the model repainted."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "blend"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Puts an outpainted result back on its canvas at the canvas's size with AusBoss's blend in seam: colour, tone and detail hand over from the result to your picture across its edge, and deeper in the picture is yours bit for bit."

    def blend(self, image, mask, canvas, tone_match):
        height, width = canvas.shape[1:3]
        result = _resize(image, width, height)
        canvas = canvas[..., :3].to(result)
        return (blend_in(canvas, result, _mask_at(mask[:1], width, height)[0, 0], tone_match),)
