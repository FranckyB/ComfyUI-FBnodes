"""
VACE Stitcher Node
Takes video clips (.mp4), generates VACE transitions between them,
and stitches everything into a single continuous pixel sequence.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import glob
import logging
import random
import tempfile
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import torch
import numpy as np
import av

import safetensors.torch

import comfy.sample
import comfy.samplers
import comfy.utils
import comfy.model_management
import comfy.model_sampling
import folder_paths
import node_helpers
import server
import latent_preview


def load_latent_file(file_path: str) -> torch.Tensor:
    """Load a .latent file and return the latent samples tensor (1, C, T, H, W)."""
    latent_data = safetensors.torch.load_file(file_path, device="cpu")
    multiplier = 1.0
    if "latent_format_version_0" not in latent_data:
        multiplier = 1.0 / 0.18215
    return latent_data["latent_tensor"].float() * multiplier


def save_latent_file(file_path: str, latent_samples: torch.Tensor):
    """Save latent samples tensor to a .latent file (lossless)."""
    latent_output = {
        "latent_tensor": latent_samples,
        "latent_format_version_0": torch.tensor([]),
    }
    if os.path.exists(file_path):
        os.remove(file_path)
    comfy.utils.save_torch_file(latent_output, file_path)


def find_matching_latent(video_path: str) -> str | None:
    """Check if a .latent file exists alongside a video file. Returns path or None."""
    latent_path = os.path.splitext(video_path)[0] + '.latent'
    return latent_path if os.path.exists(latent_path) else None


def load_video_file(file_path: str) -> torch.Tensor:
    """Load a video file and return pixel frames as (T, H, W, 3) float32 tensor in [0, 1]."""
    frames = []
    with av.open(file_path, mode='r') as container:
        stream = container.streams.video[0]
        stream.codec_context.thread_type = "AUTO"
        for frame in container.decode(stream):
            arr = frame.to_ndarray(format='rgb24')
            frames.append(arr)
    video = np.stack(frames, axis=0)  # (T, H, W, 3) uint8
    return torch.from_numpy(video).float() / 255.0


def save_video_444_10bit(file_path: str, pixels: torch.Tensor, fps: float = 24.0):
    """Save pixel frames as h265 yuv444p10le MP4 for maximum quality intermediate storage."""
    t, h, w, c = pixels.shape
    with av.open(file_path, mode='w') as output:
        stream = output.add_stream('libx265', rate=Fraction(round(fps * 1000), 1000))
        stream.width = w
        stream.height = h
        stream.pix_fmt = 'yuv444p10le'
        stream.options = {
            'crf': '0',
            'preset': 'fast',
            'tag': 'hvc1',
            'x265-params': 'log-level=error',
        }
        for i in range(t):
            img = (pixels[i, :, :, :3] * 65535).clamp(0, 65535).to(torch.int16).cpu().numpy().astype('uint16')
            frame = av.VideoFrame.from_ndarray(img, format='rgb48le')
            frame = frame.reformat(format='yuv444p10le')
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)


def _get_transitions_dir(clip_files):
    """Get a stable transitions directory in temp based on the clip list hash."""
    key_str = "|".join(os.path.abspath(f) for f in clip_files)
    h = hashlib.md5(key_str.encode()).hexdigest()[:12]
    temp_dir = folder_paths.get_temp_directory()
    d = os.path.join(temp_dir, "_vace_transitions", h)
    os.makedirs(d, exist_ok=True)
    return d


def _list_all_transitions():
    """List all intermediate transition directories in temp."""
    temp_dir = folder_paths.get_temp_directory()
    base = os.path.join(temp_dir, "_vace_transitions")
    if not os.path.isdir(base):
        return []
    result = []
    for name in os.listdir(base):
        full = os.path.join(base, name)
        if os.path.isdir(full):
            files = glob.glob(os.path.join(full, "*.latent")) + glob.glob(os.path.join(full, "*.mp4"))
            result.append({"dir": full, "hash": name, "count": len(files)})
    return result


# ---------------------------------------------------------------------------
# API routes for VACE Clip Joiner
# ---------------------------------------------------------------------------

@server.PromptServer.instance.routes.post("/fbnodes/vace-check-latents")
async def vace_check_latents(request):
    """Check which clip files have a matching .latent file alongside them."""
    try:
        body = await request.json()
        source = body.get("source", "input")
        files = body.get("files", [])

        if source == "output":
            base_dir = folder_paths.get_output_directory()
        else:
            base_dir = folder_paths.get_input_directory()

        has_latent = []
        for f in files:
            # Sanitize: only allow relative paths, no ..
            if ".." in f or os.path.isabs(f):
                continue
            video_path = os.path.join(base_dir, f.replace("/", os.sep))
            latent_path = os.path.splitext(video_path)[0] + ".latent"
            if os.path.isfile(latent_path):
                has_latent.append(f)

        return server.web.json_response({"has_latent": has_latent})
    except Exception as e:
        return server.web.json_response({"has_latent": [], "error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/fbnodes/vace-delete-transitions")
async def vace_delete_transitions(request):
    """Delete all VACE transition transitions from temp."""
    import shutil
    try:
        temp_dir = folder_paths.get_temp_directory()
        base = os.path.join(temp_dir, "_vace_transitions")
        count = 0
        if os.path.isdir(base):
            for name in os.listdir(base):
                full = os.path.join(base, name)
                if os.path.isdir(full):
                    shutil.rmtree(full, ignore_errors=True)
                    count += 1
        return server.web.json_response({"success": True, "deleted": count})
    except Exception as e:
        return server.web.json_response({"success": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/fbnodes/vace-transitions-info")
async def vace_transitions_info(request):
    """Check if transitions exist."""
    try:
        items = _list_all_transitions()
        total = sum(i["count"] for i in items)
        return server.web.json_response({"exists": total > 0, "total_files": total, "dirs": len(items)})
    except Exception as e:
        return server.web.json_response({"exists": False, "total_files": 0, "error": str(e)})


@server.PromptServer.instance.routes.get("/fbnodes/video-thumbnail")
async def video_thumbnail(request):
    """Extract a frame from a video and return it as JPEG thumbnail.

    Query params:
        filename  – url-encoded filename
        type      – 'input' | 'output' | 'temp'  (default 'input')
        subfolder – optional subfolder within the type directory
        width     – optional max width (default 256)
    """
    import io
    try:
        filename = request.query.get("filename", "")
        folder_type = request.query.get("type", "input")
        subfolder = request.query.get("subfolder", "")
        max_w = min(int(request.query.get("width", "256")), 1024)

        if not filename:
            return server.web.Response(status=400, text="Missing filename")

        if folder_type == "input":
            base = folder_paths.get_input_directory()
        elif folder_type == "output":
            base = folder_paths.get_output_directory()
        elif folder_type == "temp":
            base = folder_paths.get_temp_directory()
        else:
            return server.web.Response(status=400, text="Invalid type")

        if subfolder:
            base = os.path.join(base, subfolder)

        filepath = os.path.join(base, filename)
        filepath = os.path.abspath(filepath)

        # Security: ensure resolved path is within the base directory
        if not filepath.startswith(os.path.abspath(base)):
            return server.web.Response(status=403, text="Access denied")

        if not os.path.isfile(filepath):
            return server.web.Response(status=404, text="File not found")

        with av.open(filepath, mode='r') as container:
            stream = container.streams.video[0]
            stream.codec_context.thread_type = "AUTO"
            for frame in container.decode(stream):
                img = frame.to_ndarray(format='rgb24')
                break
            else:
                return server.web.Response(status=500, text="No frames in video")

        from PIL import Image as PILImage
        pil_img = PILImage.fromarray(img)
        h, w = img.shape[:2]
        if w > max_w:
            new_h = int(h * (max_w / w))
            pil_img = pil_img.resize((max_w, new_h), PILImage.LANCZOS)

        buf = io.BytesIO()
        pil_img.save(buf, format='JPEG', quality=80)

        return server.web.Response(
            body=buf.getvalue(),
            content_type='image/jpeg',
            headers={'Cache-Control': 'public, max-age=3600'},
        )
    except Exception as e:
        logging.error(f"[VACEStitcher] Thumbnail error: {e}")
        return server.web.Response(status=500, text=str(e))


def apply_model_shift(model, shift: float):
    """Apply ModelSamplingSD3-style shift to a model clone."""
    m = model.clone()
    sampling_base = comfy.model_sampling.ModelSamplingDiscreteFlow
    sampling_type = comfy.model_sampling.CONST

    class ModelSamplingAdvanced(sampling_base, sampling_type):
        pass

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=shift, multiplier=1000)
    m.add_object_patch("model_sampling", model_sampling)
    return m


def build_vace_conditioning(
    positive, negative, vae,
    control_video: torch.Tensor, control_mask: torch.Tensor,
    width: int, height: int, length: int,
    strength: float = 1.0,
):
    """
    Build VACE conditioning from control video and mask.
    Equivalent to WanVaceToVideo.execute() but callable as a function.

    Args:
        positive: positive conditioning from CLIP
        negative: negative conditioning from CLIP
        vae: VAE model
        control_video: (N, H, W, 3) tensor of control frames in [0, 1]
        control_mask: (N, H, W) tensor, 1.0 = generate, 0.0 = keep
        width, height, length: target dimensions
        strength: VACE conditioning strength

    Returns:
        (positive, negative, latent_dict, trim_latent)
    """
    latent_length = ((length - 1) // 4) + 1

    # Resize control video to target dimensions
    cv = comfy.utils.common_upscale(
        control_video[:length].movedim(-1, 1), width, height, "bilinear", "center"
    ).movedim(1, -1)
    if cv.shape[0] < length:
        cv = torch.nn.functional.pad(cv, (0, 0, 0, 0, 0, 0, 0, length - cv.shape[0]), value=0.5)

    # Resize mask
    mask = control_mask
    if mask.ndim == 3:
        mask = mask.unsqueeze(-1)  # (N, H, W) -> (N, H, W, 1)
    elif mask.ndim == 2:
        mask = mask.unsqueeze(0).unsqueeze(-1)

    # If mask is (N, 1, H, W) from some sources, handle that
    if mask.shape[1] == 1 and mask.ndim == 4 and mask.shape[-1] != 1:
        mask = mask.movedim(1, -1)

    # Ensure mask is (N, H, W, 1) before upscale
    if mask.ndim == 4 and mask.shape[-1] == 1:
        mask_for_upscale = mask[..., 0].unsqueeze(1)  # (N, 1, H, W)
    else:
        mask_for_upscale = mask.unsqueeze(1) if mask.ndim == 3 else mask

    mask = comfy.utils.common_upscale(
        mask_for_upscale[:length], width, height, "bilinear", "center"
    ).movedim(1, -1)
    if mask.shape[0] < length:
        mask = torch.nn.functional.pad(mask, (0, 0, 0, 0, 0, 0, 0, length - mask.shape[0]), value=1.0)

    # Build inactive/reactive split
    cv_centered = cv - 0.5
    inactive = (cv_centered * (1 - mask)) + 0.5
    reactive = (cv_centered * mask) + 0.5

    # VAE encode both halves
    inactive_latent = vae.encode(inactive[:, :, :, :3])
    reactive_latent = vae.encode(reactive[:, :, :, :3])
    control_video_latent = torch.cat((inactive_latent, reactive_latent), dim=1)

    # Build downsampled mask for latent space
    vae_stride = 8
    height_mask = height // vae_stride
    width_mask = width // vae_stride
    mask_reshape = mask[..., 0] if mask.shape[-1] == 1 else mask
    if mask_reshape.ndim == 4:
        mask_reshape = mask_reshape[:, :, :, 0]
    # mask_reshape is now (length, H, W)
    mask_view = mask_reshape.view(length, height_mask, vae_stride, width_mask, vae_stride)
    mask_view = mask_view.permute(2, 4, 0, 1, 3)
    mask_view = mask_view.reshape(vae_stride * vae_stride, length, height_mask, width_mask)
    mask_latent = torch.nn.functional.interpolate(
        mask_view.unsqueeze(0), size=(latent_length, height_mask, width_mask), mode='nearest-exact'
    ).squeeze(0).unsqueeze(0)

    # Apply VACE conditioning
    positive = node_helpers.conditioning_set_values(
        positive,
        {"vace_frames": [control_video_latent], "vace_mask": [mask_latent], "vace_strength": [strength]},
        append=True,
    )
    negative = node_helpers.conditioning_set_values(
        negative,
        {"vace_frames": [control_video_latent], "vace_mask": [mask_latent], "vace_strength": [strength]},
        append=True,
    )

    # Create empty latent
    latent = torch.zeros(
        [1, 16, latent_length, height // 8, width // 8],
        device=comfy.model_management.intermediate_device(),
    )

    return positive, negative, {"samples": latent}, 0


def sample_two_stage(
    model_high, model_low,
    positive, negative, latent,
    seed: int, steps_high: int, steps_low: int,
    cfg: float, sampler_name: str, scheduler: str,
):
    """
    Two-stage KSampler: high-noise model for first half, low-noise model for second half.
    Equivalent to the 2x KSamplerAdvanced setup in the workflow.
    """
    total_steps = steps_high + steps_low
    latent_image = latent["samples"]
    latent_image = comfy.sample.fix_empty_latent_channels(model_high, latent_image)
    noise = comfy.sample.prepare_noise(latent_image, seed)

    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    # Stage 1: High noise model (steps 0 -> steps_high, return with leftover noise)
    callback_high = latent_preview.prepare_callback(model_high, total_steps)
    samples = comfy.sample.sample(
        model_high, noise, total_steps, cfg, sampler_name, scheduler,
        positive, negative, latent_image,
        denoise=1.0, disable_noise=False,
        start_step=0, last_step=steps_high,
        force_full_denoise=False,
        callback=callback_high, disable_pbar=disable_pbar,
        seed=seed,
    )

    # Stage 2: Low noise model (steps_high -> total, force full denoise)
    # Zero noise — noise was already added in stage 1; stage 2 continues denoising
    noise_zero = torch.zeros_like(noise)
    callback_low = latent_preview.prepare_callback(model_low, total_steps)
    samples = comfy.sample.sample(
        model_low, noise_zero, total_steps, cfg, sampler_name, scheduler,
        positive, negative, samples,
        denoise=1.0, disable_noise=True,
        start_step=steps_high, last_step=total_steps,
        force_full_denoise=True,
        callback=callback_low, disable_pbar=disable_pbar,
        seed=seed,
    )

    samples = samples.to(
        device=comfy.model_management.intermediate_device(),
    )
    return {"samples": samples}


def batched_vae_decode(vae, latent: torch.Tensor, frames_per_batch: int = 16) -> torch.Tensor:
    """
    Decode a latent tensor to pixel space in batches to manage memory.
    latent: (1, 16, T, H, W) latent tensor
    Returns: (N, H, W, 3) pixel tensor
    """
    total_latent_frames = latent.shape[2]
    all_pixels = []

    for start in range(0, total_latent_frames, frames_per_batch):
        end = min(start + frames_per_batch, total_latent_frames)
        batch_latent = latent[:, :, start:end, :, :]
        pixels = vae.decode(batch_latent)
        if pixels.ndim == 5:
            pixels = pixels.squeeze(0)
        all_pixels.append(pixels.cpu())
        # Free GPU memory
        del pixels
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    return torch.cat(all_pixels, dim=0)


def decode_edge_pixels(vae, latent: torch.Tensor, edge: str, num_pixels: int,
                       frames_per_batch: int = 16) -> torch.Tensor:
    """
    Decode only the head or tail pixel frames from a latent tensor.
    Minimizes memory by decoding only the latent frames needed to cover the edge.

    Args:
        vae: VAE model
        latent: (1, C, T, H, W) latent tensor
        edge: 'head' (first N frames) or 'tail' (last N frames)
        num_pixels: number of pixel frames needed
        frames_per_batch: decode batch size in latent frames

    Returns: (num_pixels, H, W, 3) pixel tensor
    """
    total_latent = latent.shape[2]
    # Wan VAE: pixel_frames = (latent_frames - 1) * 4 + 1
    # To get at least N pixel frames: latent_frames_needed = ceil((N - 1) / 4) + 1
    latent_needed = ((num_pixels - 1 + 3) // 4) + 1  # ceiling division
    latent_needed = min(latent_needed, total_latent)

    if edge == 'tail':
        sub_latent = latent[:, :, -latent_needed:, :, :]
    else:  # head
        sub_latent = latent[:, :, :latent_needed, :, :]

    pixels = batched_vae_decode(vae, sub_latent, frames_per_batch)

    if edge == 'tail':
        return pixels[-num_pixels:]
    else:
        return pixels[:num_pixels]


def build_control_video_and_mask(
    context_a: torch.Tensor, context_b: torch.Tensor,
    context_frames: int, replace_frames: int, new_frames: int,
):
    """
    Build VACE control video and mask, matching WanVACEPrepBatch logic.
    context_a: context frames from clip A (context_frames, H, W, 3)
    context_b: context frames from clip B (context_frames, H, W, 3)

    Returns (control_video, control_mask, total_length)
    """
    height, width, channels = context_a.shape[1], context_a.shape[2], context_a.shape[3]

    # VACE generates replace zones + new frames + 1 alignment frame
    vace_count = (replace_frames * 2) + new_frames + 1

    # Middle section: gray frames (unknown, to be generated)
    vace_frames = torch.full(
        (vace_count, height, width, channels), 0.5,
        dtype=context_a.dtype, device=context_a.device,
    )

    # Concatenate: [context_A | gray_zone | context_B]
    control_video = torch.cat([context_a, vace_frames, context_b], dim=0)

    # Mask: 0 = keep (context), 1 = generate (middle)
    total_frames = control_video.shape[0]
    mask = torch.zeros((total_frames, height, width), dtype=torch.float32, device=context_a.device)
    mask[context_frames:context_frames + vace_count] = 1.0

    return control_video, mask, total_frames


class VACEStitcher_Options:
    """Provides option overrides for the VACE Clip Joiner node."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "context_frames": ("INT", {
                    "default": 8, "min": 4, "max": 40, "step": 4,
                    "tooltip": "Reference frames from each clip edge used as VACE context (kept unchanged).",
                }),
                "replace_frames": ("INT", {
                    "default": 8, "min": 0, "max": 40, "step": 4,
                    "tooltip": "Frames to regenerate at each clip edge for seamless blending.",
                }),
                "new_frames": ("INT", {
                    "default": 0, "min": 0, "max": 40, "step": 4,
                    "tooltip": "Brand new transition frames to generate between clips.",
                }),
                "steps_high": ("INT", {
                    "default": 4, "min": 1, "max": 20,
                    "tooltip": "Sampling steps for high-noise stage.",
                }),
                "steps_low": ("INT", {
                    "default": 4, "min": 1, "max": 20,
                    "tooltip": "Sampling steps for low-noise stage.",
                }),
                "cfg": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                    "tooltip": "Classifier-free guidance scale.",
                }),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {
                    "default": "euler",
                }),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {
                    "default": "simple",
                }),
                "seed": ("INT", {
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                }),
                "seamless_loop": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Generate a transition from last clip back to first clip.",
                }),
                "vace_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01,
                    "tooltip": "VACE conditioning strength.",
                }),
                "crossfade": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Crossfade over context_frames between original clips and VACE transitions.",
                }),
                "color_match": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Color match VACE transitions to original clips using MKL method.",
                }),
                "decode_batch_size": ("INT", {
                    "default": 160, "min": 1, "max": 640, "step": 1,
                    "tooltip": "Frames per VAE decode batch. Lower = less memory, slower.",
                }),
            },
        }

    RETURN_TYPES = ("VACE_OPTIONS",)
    RETURN_NAMES = ("options",)
    FUNCTION = "execute"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Options for the VACE Stitcher node. Connect to the 'options' input."

    def execute(self, **kwargs):
        return (kwargs,)


# Default options used when no VACEClipJoinerOptions node is connected
_VACE_DEFAULTS = {
    "context_frames": 8,
    "replace_frames": 8,
    "new_frames": 0,
    "steps_high": 4,
    "steps_low": 4,
    "cfg": 1.0,
    "sampler_name": "euler",
    "scheduler": "simple",
    "seed": 0,
    "seamless_loop": False,
    "vace_strength": 1.0,
    "crossfade": True,
    "color_match": False,
    "decode_batch_size": 160,
}


class VACEStitcher:
    """
    Loads video/latent clips, generates VACE transitions between
    consecutive clips, and stitches everything into one continuous output.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_high": ("MODEL", {
                    "tooltip": "Model for high-noise sampling stage (first N steps).",
                }),
                "model_low": ("MODEL", {
                    "tooltip": "Model for low-noise sampling stage (remaining steps).",
                }),
                "positive": ("CONDITIONING", {
                    "tooltip": "Positive conditioning from a CLIP Text Encode node.",
                }),
                "negative": ("CONDITIONING", {
                    "tooltip": "Negative conditioning from a CLIP Text Encode node.",
                }),
                "vae": ("VAE", {}),
                "source_folder": (["input", "output"], {
                    "tooltip": "Select which folder to browse.",
                }),
                "clip_list": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": "JSON list of clips (managed by the UI browser widget).",
                }),
            },
            "optional": {
                "options": ("VACE_OPTIONS", {
                    "tooltip": "Connect a VACE Clip Joiner Options node to override defaults.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = (
        "Select video/latent clips via browser, reorder them, and generate VACE "
        "transitions between consecutive clips using 2-stage sampling. "
        "transitions saved to temp for resumability."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(
        self,
        model_high, model_low, positive, negative, vae,
        source_folder, clip_list,
        options=None,
    ):
        # ── Merge options with defaults ──
        opts = dict(_VACE_DEFAULTS)
        if options is not None:
            opts.update(options)
        # Random seed when no Options node is connected (seed stays at 0)
        if opts["seed"] == 0:
            opts["seed"] = random.randint(1, 0xFFFFFFFFFFFFFFFF)

        context_frames = opts["context_frames"]
        replace_frames = opts["replace_frames"]
        new_frames = opts["new_frames"]
        steps_high = opts["steps_high"]
        steps_low = opts["steps_low"]
        cfg = opts["cfg"]
        sampler_name = opts["sampler_name"]
        scheduler = opts["scheduler"]
        seed = opts["seed"]
        seamless_loop = opts["seamless_loop"]
        vace_strength = opts["vace_strength"]
        crossfade = opts["crossfade"]
        color_match = opts["color_match"]
        decode_batch_size = opts["decode_batch_size"]

        # ── 1. Parse clip list and resolve paths ──
        try:
            entries = json.loads(clip_list) if isinstance(clip_list, str) else clip_list
        except (json.JSONDecodeError, TypeError):
            entries = []

        if not isinstance(entries, list) or len(entries) < 1:
            raise ValueError("Need at least 1 enabled clip. Use the Browse button to add clips.")

        # Filter to enabled clips only
        enabled = [e for e in entries if e.get("enabled", True)]
        if len(enabled) < 1:
            raise ValueError(f"Need at least 1 enabled clip, got {len(enabled)}.")

        # Resolve file paths – each clip stores its own source folder
        clip_files = []
        for entry in enabled:
            rel = entry.get("file", "")
            if os.path.isabs(rel):
                full = rel
            else:
                entry_source = entry.get("source", source_folder)
                if entry_source == "output":
                    base_dir = folder_paths.get_output_directory()
                else:
                    base_dir = folder_paths.get_input_directory()
                full = os.path.join(base_dir, rel)
            if not os.path.isfile(full):
                raise FileNotFoundError(f"Clip not found: {full}")
            clip_files.append(full)

        # Determine mode from file extensions
        ext0 = os.path.splitext(clip_files[0])[1].lower()
        if ext0 not in ('.mp4', '.webm', '.mov', '.avi'):
            raise ValueError(f"Unsupported file type: {ext0}. Only video files (.mp4, .webm, .mov, .avi) are supported.")

        print(f"[VACE Stitcher] {len(clip_files)} clips")

        # Load clips: prefer .latent files (lossless) with .mp4 fallback
        clip_pixels = []    # pixel tensors (T, H, W, 3) — may be None if latent available
        clip_latents = []   # latent tensors (1, C, T, H, W) — None if no .latent file
        for f in clip_files:
            latent_path = find_matching_latent(f)
            if latent_path:
                print(f"[VACE Stitcher]   Loading latent: {os.path.basename(latent_path)}")
                clip_latents.append(load_latent_file(latent_path))
                clip_pixels.append(None)  # will decode on demand
            else:
                print(f"[VACE Stitcher]   Loading video: {os.path.basename(f)}")
                clip_latents.append(None)
                clip_pixels.append(load_video_file(f))

        latent_count = sum(1 for latent in clip_latents if latent is not None)
        video_count = sum(1 for pixels in clip_pixels if pixels is not None)
        print(f"[VACE Stitcher] Loaded {len(clip_files)} clips: {latent_count} from .latent, {video_count} from video")

        # ── 2. Use models directly (user applies shift externally if needed) ──
        model_high_shifted = model_high
        model_low_shifted = model_low

        # ── 3. Use provided conditioning directly ──
        positive_cond = positive
        negative_cond = negative

        # Convert pixel-frame batch size to latent frames for VAE decode
        decode_latent_batch = max(1, ((decode_batch_size - 1) // 4) + 1)

        # Helper: get edge pixels from a clip without decoding the full thing
        def get_clip_edge(clip_idx, edge, num_frames):
            """Get head or tail pixel frames from a clip, decoding only what's needed."""
            if clip_latents[clip_idx] is not None:
                return decode_edge_pixels(
                    vae, clip_latents[clip_idx], edge, num_frames, decode_latent_batch
                )
            else:
                px = clip_pixels[clip_idx]
                return px[:num_frames] if edge == 'head' else px[-num_frames:]

        # Helper: get full clip pixels (decode latent or return loaded video)
        def get_clip_pixels(clip_idx):
            """Decode full clip to pixels on demand. Returns (T, H, W, 3) tensor."""
            if clip_latents[clip_idx] is not None:
                return batched_vae_decode(vae, clip_latents[clip_idx], decode_latent_batch)
            else:
                return clip_pixels[clip_idx]

        # ── 4. Determine clip dimensions and validate ──
        # Get dimensions from first clip (decode a single frame if latent-only)
        if clip_latents[0] is not None:
            # Infer pixel dims from latent: (1, C, T, H//8, W//8)
            height = clip_latents[0].shape[3] * 8
            width = clip_latents[0].shape[4] * 8
        else:
            height = clip_pixels[0].shape[1]
            width = clip_pixels[0].shape[2]

        # Validate all clips have the same dimensions
        for ci in range(1, len(clip_files)):
            if clip_latents[ci] is not None:
                ch = clip_latents[ci].shape[3] * 8
                cw = clip_latents[ci].shape[4] * 8
            else:
                ch = clip_pixels[ci].shape[1]
                cw = clip_pixels[ci].shape[2]
            if ch != height or cw != width:
                basename = os.path.basename(clip_files[ci])
                raise ValueError(
                    f"Clip size mismatch! Clip 0 is {width}x{height} but clip {ci} "
                    f"({basename}) is {cw}x{ch}. All clips must have the same resolution."
                )

        # ── 5. Build transition pairs ──
        num_clips = len(clip_files)

        if num_clips == 1 and not seamless_loop:
            raise ValueError(
                "Only 1 clip is enabled. Either add more clips or enable "
                "'seamless_loop' in VACE Stitcher Options to loop a single clip."
            )

        pairs = []
        if num_clips == 1 and seamless_loop:
            # Single-clip loop: transition from clip end back to clip start
            pairs.append((0, 0))
        else:
            for i in range(num_clips - 1):
                pairs.append((i, i + 1))
            if seamless_loop:
                pairs.append((num_clips - 1, 0))

        print(f"[VACE Stitcher] Generating {len(pairs)} transitions"
              f"{' (seamless loop)' if seamless_loop else ''}")

        # ── 6. Transitions directory (always save to temp) ──
        transitions_dir = _get_transitions_dir(clip_files)

        # Compute how many pixel frames we need from each clip edge
        required_pixels = context_frames + replace_frames
        print(f"[VACE Stitcher] Context={context_frames}, Replace={replace_frames}, "
              f"Required pixels per edge={required_pixels}")

        # ── 7. Generate all transitions (memory-efficient: only decode edges) ──
        # Transitions are saved as .latent files; decoding deferred to stitch step.
        pbar = comfy.utils.ProgressBar(len(pairs))

        for pair_idx, (idx_a, idx_b) in enumerate(pairs):
            pair_key = f"{idx_a:03d}_to_{idx_b:03d}"
            print(f"[VACE Stitcher] Transition {pair_idx + 1}/{len(pairs)}: "
                  f"clip {idx_a} -> clip {idx_b}")

            # Check for cached transition (.latent preferred, .mp4 fallback)
            if transitions_dir:
                cached_latent = os.path.join(transitions_dir, f"transition_{pair_key}.latent")
                cached_mp4 = os.path.join(transitions_dir, f"transition_{pair_key}.mp4")
                if os.path.exists(cached_latent) or os.path.exists(cached_mp4):
                    print("[VACE Stitcher]   Cached transition exists, skipping generation")
                    pbar.update(1)
                    continue

            # Decode only the edge pixels needed for VACE context (not the full clips)
            edge_a = get_clip_edge(idx_a, 'tail', required_pixels)
            edge_b = get_clip_edge(idx_b, 'head', required_pixels)

            # Extract context frames offset by replace_frames (matching WanVACEPrepBatch)
            if replace_frames > 0:
                context_a = edge_a[:context_frames]   # before the replace zone
                context_b = edge_b[replace_frames:]   # after the replace zone
            else:
                context_a = edge_a[-context_frames:]  # last context_frames
                context_b = edge_b[:context_frames]   # first context_frames

            print(f"[VACE Stitcher]   Edge A: {edge_a.shape[0]}px, "
                  f"Edge B: {edge_b.shape[0]}px, "
                  f"Context A: {context_a.shape[0]}px, Context B: {context_b.shape[0]}px")

            # Build VACE control video and mask
            control_video, control_mask, total_length = build_control_video_and_mask(
                context_a, context_b,
                context_frames=context_frames,
                replace_frames=replace_frames,
                new_frames=new_frames,
            )

            # Free edge pixels before VACE sampling (model needs GPU memory)
            del edge_a, edge_b, context_a, context_b

            # Build VACE conditioning
            vace_positive, vace_negative, vace_latent, trim_latent = build_vace_conditioning(
                positive_cond, negative_cond, vae,
                control_video, control_mask,
                width, height, total_length,
                strength=vace_strength,
            )

            # Free control tensors
            del control_video, control_mask

            # Two-stage sampling
            print(f"[VACE Stitcher]   Sampling ({steps_high}+{steps_low} steps)...")
            result_latent = sample_two_stage(
                model_high_shifted, model_low_shifted,
                vace_positive, vace_negative, vace_latent,
                seed=seed + pair_idx,
                steps_high=steps_high, steps_low=steps_low,
                cfg=cfg, sampler_name=sampler_name, scheduler=scheduler,
            )

            # Trim if needed
            if trim_latent > 0:
                result_latent["samples"] = result_latent["samples"][:, :, trim_latent:]

            # Save transition as lossless .latent (no decode yet — deferred to stitch step)
            transition_samples = result_latent["samples"].cpu()
            if transitions_dir:
                save_path = os.path.join(transitions_dir, f"transition_{pair_key}.latent")
                save_latent_file(save_path, transition_samples)
                print(f"[VACE Stitcher]   Saved latent: {save_path}")

            # Free sampling results
            del result_latent, transition_samples
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            pbar.update(1)

        # ── 8. Stitch in pixel space (on-demand decode, one clip/transition at a time) ──
        print("[VACE Stitcher] Stitching in pixel space...")

        # Helper: load a transition's pixels (decode from .latent or load .mp4)
        def load_transition_pixels(pair_key):
            if transitions_dir:
                cached_latent = os.path.join(transitions_dir, f"transition_{pair_key}.latent")
                cached_mp4 = os.path.join(transitions_dir, f"transition_{pair_key}.mp4")
                if os.path.exists(cached_latent):
                    print(f"[VACE Stitcher]   Decoding transition {pair_key} from latent...")
                    samples = load_latent_file(cached_latent)
                    px = batched_vae_decode(vae, samples, decode_latent_batch)
                    del samples
                    return px
                elif os.path.exists(cached_mp4):
                    print(f"[VACE Stitcher]   Loading transition {pair_key} from MP4...")
                    return load_video_file(cached_mp4)
            return None

        # Helper: apply color matching to transition pixels
        def apply_color_match(trans_px, ref_frame):
            """Color match transition pixels to a reference frame."""
            try:
                from color_matcher import ColorMatcher
                ref_np = ref_frame.numpy()  # (H, W, 3) float32
                pixels_np = trans_px.cpu().numpy()
                n_frames = pixels_np.shape[0]
                color_strength = 0.7

                def match_frame(i):
                    try:
                        cm = ColorMatcher()
                        image_result = cm.transfer(src=pixels_np[i], ref=ref_np, method='mkl')
                        if color_strength != 1.0:
                            image_result = pixels_np[i] + color_strength * (image_result - pixels_np[i])
                        return torch.from_numpy(image_result)
                    except Exception as e:
                        logging.warning(f"Color match frame {i} error: {e}")
                        return trans_px[i]

                max_threads = min(os.cpu_count() or 1, n_frames)
                with ThreadPoolExecutor(max_workers=max_threads) as executor:
                    matched = list(executor.map(match_frame, range(n_frames)))

                return torch.stack(matched, dim=0).to(torch.float32).clamp_(0, 1)
            except ImportError:
                print("[VACE Stitcher]   WARNING: color-matcher not installed. pip install color-matcher")
                return trans_px
            except Exception as e:
                print(f"[VACE Stitcher]   WARNING: Color match failed: {e}")
                return trans_px

        # Stitch pattern (matching the workflow):
        #   [clip_A trimmed] [FULL VACE output] [clip_B trimmed] [FULL VACE output] ...
        #
        # Without crossfade:
        #   clip_A is trimmed by required_pixels (context+replace) from its trailing edge
        #   clip_B is trimmed by required_pixels from its leading edge
        #   The full VACE output bridges the gap: [context_A | generated | context_B]
        #
        # With crossfade:
        #   The VACE output's leading context_frames overlap with clip_A's trailing context zone
        #   We crossfade over that overlap (context_frames long)
        #   Same on the B side
        #
        # Single-clip seamless loop:
        #   One transition (clip end → clip start) is split in half.
        #   2nd half goes at the START (dissolves into clip head), trimmed clip in middle,
        #   1st half goes at the END (dissolves from clip tail). On loop playback the two
        #   halves meet seamlessly at the loop point.

        single_clip_loop = (num_clips == 1 and seamless_loop)

        segments = []

        if single_clip_loop:
            # ── Single-clip seamless loop stitch ──
            print("[VACE Stitcher]   Single-clip seamless loop mode")
            cp = get_clip_pixels(0)
            t_len = cp.shape[0]

            pair_key = f"{num_clips - 1:03d}_to_000"
            trans_px = load_transition_pixels(pair_key)

            if trans_px is None:
                # No transition generated — just output the clip as-is
                segments.append(cp)
            else:
                if color_match:
                    ref_frame = cp[-1]
                    trans_px = apply_color_match(trans_px, ref_frame)
                    print(f"[VACE Stitcher]   Color matched {pair_key}")

                t_trans = trans_px.shape[0]
                mid = t_trans // 2

                # Split transition in half:
                #   1st half = transition from clip_tail into generated middle
                #   2nd half = transition from generated middle into clip_head
                trans_first_half = trans_px[:mid]   # tail side (goes at END of output)
                trans_second_half = trans_px[mid:]  # head side (goes at START of output)

                # Trim clip: remove required_pixels from both edges
                trimmed = cp[required_pixels:t_len - required_pixels]

                cf = context_frames
                if crossfade and cf > 0:
                    cf = min(cf, mid)  # don't exceed half-transition length

                    if cf >= 1:
                        # Crossfade 2nd half (head side) → dissolves into clip start
                        # The last cf frames of trans_second_half overlap with clip's leading context
                        vace_ctx_head = trans_second_half[-cf:]
                        original_ctx_head = cp[replace_frames:replace_frames + cf] if replace_frames > 0 else cp[:cf]
                        actual_cf_head = min(cf, original_ctx_head.shape[0], vace_ctx_head.shape[0])
                        vace_ctx_head = vace_ctx_head[-actual_cf_head:]
                        original_ctx_head = original_ctx_head[:actual_cf_head]

                        t_h = torch.linspace(0.0, 1.0, actual_cf_head, device=trans_px.device)
                        alpha_h = (t_h * t_h).view(-1, 1, 1, 1)
                        crossfade_head = (1.0 - alpha_h) * vace_ctx_head + alpha_h * original_ctx_head

                        # 2nd half with crossfade at end
                        segments.append(trans_second_half[:-actual_cf_head])
                        segments.append(crossfade_head)

                        # Trimmed clip middle
                        segments.append(trimmed)

                        # Crossfade 1st half (tail side) → clip end dissolves into transition
                        vace_ctx_tail = trans_first_half[:cf]
                        if replace_frames > 0:
                            original_ctx_tail = cp[-(cf + replace_frames):-replace_frames]
                        else:
                            original_ctx_tail = cp[-cf:]
                        actual_cf_tail = min(cf, original_ctx_tail.shape[0], vace_ctx_tail.shape[0])
                        original_ctx_tail = original_ctx_tail[:actual_cf_tail]
                        vace_ctx_tail = vace_ctx_tail[:actual_cf_tail]

                        t_t = torch.linspace(0.0, 1.0, actual_cf_tail, device=trans_px.device)
                        alpha_t = (t_t * t_t).view(-1, 1, 1, 1)
                        crossfade_tail = (1.0 - alpha_t) * original_ctx_tail + alpha_t * vace_ctx_tail

                        segments.append(crossfade_tail)
                        segments.append(trans_first_half[actual_cf_tail:])
                    else:
                        # Too short for crossfade
                        segments.append(trans_second_half)
                        segments.append(trimmed)
                        segments.append(trans_first_half)
                else:
                    # No crossfade
                    segments.append(trans_second_half)
                    segments.append(trimmed)
                    segments.append(trans_first_half)

                del trans_px
            del cp
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        else:
            # ── Multi-clip stitch ──
            _next_cp = None  # cache: pre-decoded clip B from crossfade becomes next iteration's clip
            for i in range(num_clips):
                # Decode full clip pixels on demand (or reuse cached from previous crossfade)
                print(f"[VACE Stitcher]   Processing clip {i}...")
                if _next_cp is not None:
                    cp = _next_cp
                    _next_cp = None
                else:
                    cp = get_clip_pixels(i)
                t_len = cp.shape[0]

                # Determine which edges participate in transitions
                has_prev_transition = (i > 0) or seamless_loop
                has_next_transition = (i < num_clips - 1) or seamless_loop

                # Trim required_pixels (context+replace) from transition edges
                start_trim = required_pixels if has_prev_transition else 0
                end_trim = required_pixels if has_next_transition else 0

                end_idx = t_len - end_trim if end_trim > 0 else t_len
                trimmed = cp[start_trim:end_idx]
                segments.append(trimmed)

                # Build and insert the transition after this clip
                if i < num_clips - 1:
                    pair_key = f"{i:03d}_to_{i + 1:03d}"
                elif seamless_loop and i == num_clips - 1:
                    pair_key = f"{num_clips - 1:03d}_to_000"
                else:
                    pair_key = None

                if pair_key:
                    trans_px = load_transition_pixels(pair_key)
                    if trans_px is not None:
                        # Apply color matching if enabled
                        if color_match:
                            # Use last frame of clip A as reference
                            ref_frame = cp[-1]
                            trans_px = apply_color_match(trans_px, ref_frame)
                            print(f"[VACE Stitcher]   Color matched {pair_key}")

                        t_trans = trans_px.shape[0]
                        cf = context_frames

                        if crossfade and cf > 0:
                            # Clamp cf so we don't exceed half the transition length
                            cf = min(cf, t_trans // 2)

                            if cf < 1:
                                # Transition too short for crossfade, use as-is
                                segments.append(trans_px)
                            else:
                                # Split VACE output: [vace_ctx_A (cf)] [vace_middle] [vace_ctx_B (cf)]
                                # Use fully-decoded clip pixels for crossfade references
                                # (edge-only decode produces different pixels due to VAE temporal convolution)
                                idx_a, idx_b = (int(x) for x in pair_key.split("_to_"))

                                # Clip A context: from the full decode we already have (cp)
                                if replace_frames > 0:
                                    original_ctx_a = cp[-(cf + replace_frames):-replace_frames]
                                else:
                                    original_ctx_a = cp[-cf:]

                                # Clip B context: need full decode to get consistent pixels
                                cp_b = get_clip_pixels(idx_b)
                                if replace_frames > 0:
                                    original_ctx_b = cp_b[replace_frames:replace_frames + cf]
                                else:
                                    original_ctx_b = cp_b[:cf]
                                # Cache clip B's full decode for the next iteration
                                _next_cp = cp_b

                                # Ensure matched lengths (safety)
                                actual_cf_a = min(cf, original_ctx_a.shape[0])
                                actual_cf_b = min(cf, original_ctx_b.shape[0])
                                original_ctx_a = original_ctx_a[:actual_cf_a]
                                original_ctx_b = original_ctx_b[:actual_cf_b]

                                vace_ctx_a = trans_px[:actual_cf_a]
                                vace_middle = trans_px[actual_cf_a:t_trans - actual_cf_b]
                                vace_ctx_b = trans_px[t_trans - actual_cf_b:]

                                # Cross Fade: video1 → VACE (ease_in: original snaps to VACE)
                                t_a = torch.linspace(0.0, 1.0, actual_cf_a, device=trans_px.device)
                                alpha_a = (t_a * t_a).view(-1, 1, 1, 1)  # ease_in = t²
                                crossfade_a = (1.0 - alpha_a) * original_ctx_a + alpha_a * vace_ctx_a

                                # Cross Fade: VACE → video2 (ease_in: VACE snaps to original)
                                t_b = torch.linspace(0.0, 1.0, actual_cf_b, device=trans_px.device)
                                alpha_b = (t_b * t_b).view(-1, 1, 1, 1)  # ease_in = t²
                                crossfade_b = (1.0 - alpha_b) * vace_ctx_b + alpha_b * original_ctx_b

                                # Assemble: [crossfade_A | vace_middle | crossfade_B]
                                segments.append(crossfade_a)
                                if vace_middle.shape[0] > 0:
                                    segments.append(vace_middle)
                                segments.append(crossfade_b)

                                del original_ctx_a, original_ctx_b
                        else:
                            # No crossfade: use full VACE output as-is
                            segments.append(trans_px)

                        del trans_px

                # Free clip pixels after processing
                del cp
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

        # Concatenate all segments, filtering out empties
        segments = [s for s in segments if s.shape[0] > 0]
        stitched_pixels = torch.cat(segments, dim=0)
        total_pixel_frames = stitched_pixels.shape[0]
        print(f"[VACE Stitcher] Final output: {stitched_pixels.shape} "
              f"({total_pixel_frames} pixel frames)")

        return (stitched_pixels,)
