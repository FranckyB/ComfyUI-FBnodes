'''
Outpainting beside MiniMax H3 Image Conditioning (or any model that samples
with a noise mask). Load Image+'s Pad makes the canvas and its mask:

  Outpaint Latent  the canvas, VAE-encoded at the conditioning's resolution,
                   with a noise mask that frees the new area for KSampler.
  Outpaint Blend   the decoded result back on the canvas: tone matched across
                   the seam, the original pixels kept where the mask is 0.

Inspired by TwoAbove's ComfyUI-H3VideoOutpaint.
'''

import math

import torch.nn.functional as F

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


class OutpaintLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("VAE",),
                "image": ("IMAGE", {"tooltip": "The padded canvas (Load Image+ with Pad)."}),
                "mask": ("MASK", {"tooltip": "1 where to paint: the new area, and anything painted."}),
                "latent": ("LATENT", {"tooltip": "The latent of MiniMax H3 Image Conditioning: its size sets the resolution."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "encode"
    CATEGORY = "FBnodes"
    DESCRIPTION = "VAE-encodes a padded canvas at the conditioning latent's resolution (keeping the canvas's aspect) with a noise mask, so KSampler paints only the new area."

    def encode(self, vae, image, mask, latent):
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
        return (out,)


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
