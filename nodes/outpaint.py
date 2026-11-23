'''
Outpainting beside MiniMax H3 Image Conditioning. Load Image+'s Pad makes the
canvas and its mask:

  Outpaint Latent  the canvas, VAE-encoded at the conditioning's resolution,
                   with a noise mask that frees the new area for KSampler.
                   Picture 1's reference becomes the picture alone, placed on
                   the canvas where it sits, so the model never sees the pad.
  Outpaint Blend   the decoded result back on the canvas: tone matched across
                   the seam, the original pixels kept where the mask is 0.

Inspired by TwoAbove's ComfyUI-H3VideoOutpaint.
'''

import math

import torch.nn.functional as F

import comfy.ldm.minimax.model
import comfy.patcher_extension
import comfy.utils

# Known picture just inside the seam that Outpaint Blend reads the tone from, in pixels.
SEAM_RING = 16


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


def _picture_cells(mask, width, height, cell):
    """The canvas's picture (where the mask is below 1) as whole 2x2-cell DiT patches inside it, in latent
    cells (top, left, bottom, right) on a width x height canvas, or None when no patch fits."""
    inside = mask.reshape(-1, mask.shape[-2], mask.shape[-1])[0] < 1
    rows = inside.any(dim=1).nonzero()
    cols = inside.any(dim=0).nonzero()
    if not len(rows):
        return None
    patch = cell * 2
    scale_y, scale_x = height / mask.shape[-2], width / mask.shape[-1]
    top = math.ceil(int(rows[0]) * scale_y / patch) * 2
    bottom = math.floor((int(rows[-1]) + 1) * scale_y / patch) * 2
    left = math.ceil(int(cols[0]) * scale_x / patch) * 2
    right = math.floor((int(cols[-1]) + 1) * scale_x / patch) * 2
    if bottom <= top or right <= left:
        return None
    return top, left, bottom, right


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


def _place_references(executor, x, timestep, context, transformer_options={}, minimax_payload=None, **kwargs):
    """Model wrapper: a placed reference takes the canvas positions of the cells it was cut from, instead of a
    grid of its own, so the model reads it as that part of the picture it paints."""
    refs = (minimax_payload or {}).get("refs") or []
    if any("outpaint_place" in ref for ref in refs):
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
        minimax_payload = {**minimax_payload, "layout": layout}
    return executor(x, timestep, context, transformer_options, minimax_payload=minimax_payload, **kwargs)


class OutpaintLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The MiniMax H3 Image model, after any LoRAs."}),
                "positive": ("CONDITIONING", {"tooltip": "From MiniMax H3 Image Conditioning."}),
                "vae": ("VAE",),
                "image": ("IMAGE", {"tooltip": "The padded canvas (Load Image+ with Pad)."}),
                "mask": ("MASK", {"tooltip": "1 where to paint: the new area, and anything painted."}),
                "latent": ("LATENT", {"tooltip": "The latent of MiniMax H3 Image Conditioning: its size sets the resolution."}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("model", "positive", "latent")
    FUNCTION = "encode"
    CATEGORY = "FBnodes"
    DESCRIPTION = "VAE-encodes a padded canvas at the conditioning latent's resolution (keeping the canvas's aspect) with a noise mask, so KSampler paints only the new area. Picture 1's reference becomes the picture alone, placed where it sits on the canvas, so the model continues it instead of copying the pad."

    def encode(self, model, positive, vae, image, mask, latent):
        cell = vae.spacial_compression_encode()
        latent_h, latent_w = latent["samples"].shape[-2:]
        width, height = _canvas_size(image.shape[2], image.shape[1], latent_w, latent_h, cell)
        samples = vae.encode(_resize(image[:1], width, height))
        # A latent cell is as free as the most-masked pixel in it, and one cell more around the masked area
        # lets the sampler repaint the seam itself.
        noise_mask = F.max_pool2d(_mask_at(mask[:1], width, height), cell)
        noise_mask = F.max_pool2d(noise_mask, 3, stride=1, padding=1)
        out = latent.copy()
        out["samples"] = samples
        out["noise_mask"] = noise_mask

        cells = _picture_cells(mask, width, height, cell)
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
                "canvas": ("IMAGE", {"tooltip": "The padded canvas the result was painted on."}),
                "mask": ("MASK", {"tooltip": "The canvas's mask: the result shows where it is 1, the canvas where it is 0."}),
                "match_tone": ("BOOLEAN", {"default": True, "tooltip": "Shift the result's colours to meet the picture's at the seam."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "blend"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Puts an outpainted result back on its canvas at the canvas's size: the original pixels where the mask is 0, the result where it is 1, faded along the mask's feather."

    def blend(self, image, canvas, mask, match_tone):
        height, width = canvas.shape[1:3]
        result = _resize(image, width, height)
        canvas = canvas[..., :3].to(result)
        mask = _mask_at(mask, width, height).to(result)
        if match_tone:
            # The mean colour difference over the kept picture just inside the masked area.
            near = F.max_pool2d(mask, (1, SEAM_RING * 2 + 1), stride=1, padding=(0, SEAM_RING))
            near = F.max_pool2d(near, (SEAM_RING * 2 + 1, 1), stride=1, padding=(SEAM_RING, 0))
            ring = ((near > 0) & (mask == 0)).movedim(1, -1).to(result)
            offset = ((canvas - result) * ring).sum(dim=(1, 2), keepdim=True) / ring.sum(dim=(1, 2), keepdim=True).clamp(min=1)
            result = result + offset
        mask = mask.movedim(1, -1)
        return ((canvas * (1 - mask) + result * mask).clamp(0, 1),)
