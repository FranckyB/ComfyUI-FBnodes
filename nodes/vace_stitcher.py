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

import comfy.sample
import comfy.samplers
import comfy.utils
import comfy.model_management
import comfy.model_sampling
import folder_paths
import node_helpers
import server
import latent_preview


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
            mp4s = glob.glob(os.path.join(full, "*.mp4"))
            result.append({"dir": full, "hash": name, "count": len(mp4s)})
    return result


# ---------------------------------------------------------------------------
# API routes for VACE Clip Joiner
# ---------------------------------------------------------------------------

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

        if not isinstance(entries, list) or len(entries) < 2:
            raise ValueError("Need at least 2 enabled clips. Use the Browse button to add clips.")

        # Filter to enabled clips only
        enabled = [e for e in entries if e.get("enabled", True)]
        if len(enabled) < 2:
            raise ValueError(f"Need at least 2 enabled clips, got {len(enabled)}.")

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

        # Load clips
        clip_pixels = []
        for f in clip_files:
            print(f"[VACE Stitcher]   Loading: {os.path.basename(f)}")
            clip_pixels.append(load_video_file(f))

        # ── 2. Use models directly (user applies shift externally if needed) ──
        model_high_shifted = model_high
        model_low_shifted = model_low

        # ── 3. Use provided conditioning directly ──
        positive_cond = positive
        negative_cond = negative

        # ── 4. Build transition pairs ──
        num_clips = len(clip_files)
        pairs = []
        for i in range(num_clips - 1):
            pairs.append((i, i + 1))
        if seamless_loop:
            pairs.append((num_clips - 1, 0))

        print(f"[VACE Stitcher] Generating {len(pairs)} transitions"
              f"{' (seamless loop)' if seamless_loop else ''}")

        # ── 5. transitions directory (always save to temp) ──
        transitions_dir = _get_transitions_dir(clip_files)

        # ── 6. Determine clip dimensions ──
        height = clip_pixels[0].shape[1]
        width = clip_pixels[0].shape[2]

        # Compute how many pixel frames we need from each clip edge
        required_pixels = context_frames + replace_frames
        print(f"[VACE Stitcher] Context={context_frames}, Replace={replace_frames}, "
              f"Required pixels per edge={required_pixels}")

        # Convert pixel-frame batch size to latent frames for VAE decode
        decode_latent_batch = max(1, ((decode_batch_size - 1) // 4) + 1)

        # ── 7. Generate all transitions ──
        transition_pixels = {}
        pbar = comfy.utils.ProgressBar(len(pairs))

        for pair_idx, (idx_a, idx_b) in enumerate(pairs):
            pair_key = f"{idx_a:03d}_to_{idx_b:03d}"
            print(f"[VACE Stitcher] Transition {pair_idx + 1}/{len(pairs)}: "
                  f"clip {idx_a} -> clip {idx_b}")

            # Check for cached intermediate (MP4)
            if transitions_dir:
                cached_path = os.path.join(transitions_dir, f"transition_{pair_key}.mp4")
                if os.path.exists(cached_path):
                    print(f"[VACE Stitcher]   Using cached transition: {cached_path}")
                    transition_pixels[pair_key] = load_video_file(cached_path)
                    pbar.update(1)
                    continue

            # Use the already-decoded pixel frames directly (no second VAE decode!)
            pixels_a = clip_pixels[idx_a]  # (T, H, W, 3)
            pixels_b = clip_pixels[idx_b]

            # Extract edge regions from pixel space
            edge_a = pixels_a[-required_pixels:]  # last required_pixels from A
            edge_b = pixels_b[:required_pixels]   # first required_pixels from B

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

            # Build VACE conditioning
            vace_positive, vace_negative, vace_latent, trim_latent = build_vace_conditioning(
                positive_cond, negative_cond, vae,
                control_video, control_mask,
                width, height, total_length,
                strength=vace_strength,
            )

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

            # Decode transition to pixels immediately
            transition_samples = result_latent["samples"]
            print(f"[VACE Stitcher]   Decoding transition {pair_key}...")
            pixels = batched_vae_decode(vae, transition_samples, decode_latent_batch)

            transition_pixels[pair_key] = pixels

            # Save intermediate as h265 yuv444 10-bit MP4
            if transitions_dir:
                save_path = os.path.join(transitions_dir, f"transition_{pair_key}.mp4")
                save_video_444_10bit(save_path, pixels)
                print(f"[VACE Stitcher]   Saved: {save_path}")

            pbar.update(1)

        # ── 8. Stitch in pixel space ──
        # clip_pixels were already decoded in step 6 (same pixels used for VACE context).
        # Transitions are already decoded (step 7). Apply color matching now.
        print("[VACE Stitcher] Stitching in pixel space...")

        # Apply color matching to all transition pixels
        if color_match:
            for pair_key in list(transition_pixels.keys()):
                pixels = transition_pixels[pair_key]
                try:
                    from color_matcher import ColorMatcher
                    # Parse pair key to get clip indices
                    parts = pair_key.split("_to_")
                    idx_a, idx_b = int(parts[0]), int(parts[1])
                    # Use last frame of A as reference (matching KJNodes pattern: float32, no uint8)
                    ref_np = clip_pixels[idx_a][-1].numpy()  # (H, W, 3) float32

                    pixels_np = pixels.cpu().numpy()
                    n_frames = pixels_np.shape[0]
                    color_strength = 0.7

                    def match_frame(i):
                        try:
                            cm = ColorMatcher()  # new instance per thread (thread safety)
                            image_result = cm.transfer(src=pixels_np[i], ref=ref_np, method='mkl')
                            if color_strength != 1.0:
                                image_result = pixels_np[i] + color_strength * (image_result - pixels_np[i])
                            return torch.from_numpy(image_result)
                        except Exception as e:
                            logging.warning(f"Color match frame {i} error: {e}")
                            return pixels[i]

                    max_threads = min(os.cpu_count() or 1, n_frames)
                    with ThreadPoolExecutor(max_workers=max_threads) as executor:
                        matched = list(executor.map(match_frame, range(n_frames)))

                    transition_pixels[pair_key] = torch.stack(matched, dim=0).to(torch.float32).clamp_(0, 1)
                    print(f"[VACE Stitcher]   Color matched {pair_key} (mkl, strength=0.7)")
                except ImportError:
                    print("[VACE Stitcher]   WARNING: color-matcher not installed. pip install color-matcher")
                except Exception as e:
                    print(f"[VACE Stitcher]   WARNING: Color match failed for {pair_key}: {e}")

        # Stitch pattern (matching the workflow):
        #   [clip_A trimmed] [FULL VACE output] [clip_B trimmed] [FULL VACE output] ...
        #
        # Without crossfade:
        #   clip_A is trimmed by required_pixels (context+replace) from its trailing edge
        #   clip_B is trimmed by required_pixels from its leading edge
        #   The full VACE output bridges the gap: [context_A | generated | context_B]
        #
        # With crossfade:
        #   clip_A is trimmed by only replace_frames from its trailing edge (keeps context zone)
        #   The VACE output's leading context_frames overlap with clip_A's trailing context zone
        #   We crossfade over that overlap (context_frames long)
        #   Same on the B side: VACE output's trailing context_frames overlap with clip_B's leading context zone
        #
        # This matches the workflow exactly:
        #   WanVACEPrepBatch outputs start_images = clip[:-required_frames] and end_images = clip[required_frames:]
        #   The full VACE output (including context) is placed between them

        segments = []
        for i in range(num_clips):
            cp = clip_pixels[i]  # (T, H, W, 3)
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

            if pair_key and pair_key in transition_pixels:
                trans_px = transition_pixels[pair_key]
                t_trans = trans_px.shape[0]
                cf = context_frames

                if crossfade and cf > 0:
                    # Matching the workflow: split VACE output into 3 parts
                    #   [vace_ctx_A (cf)] [vace_middle] [vace_ctx_B (cf)]
                    # Get original context frames from each clip edge
                    parts = pair_key.split("_to_")
                    idx_a, idx_b = int(parts[0]), int(parts[1])
                    original_ctx_a = clip_pixels[idx_a][-(cf + replace_frames):-(replace_frames)] if replace_frames > 0 else clip_pixels[idx_a][-cf:]
                    original_ctx_b = clip_pixels[idx_b][replace_frames:replace_frames + cf] if replace_frames > 0 else clip_pixels[idx_b][:cf]

                    vace_ctx_a = trans_px[:cf]
                    vace_middle = trans_px[cf:t_trans - cf]
                    vace_ctx_b = trans_px[t_trans - cf:]

                    # Cross Fade: video1 → VACE (ease_in: original snaps to VACE)
                    t_a = torch.linspace(0.0, 1.0, cf, device=trans_px.device)
                    alpha_a = (t_a * t_a).view(-1, 1, 1, 1)  # ease_in = t²
                    crossfade_a = (1.0 - alpha_a) * original_ctx_a + alpha_a * vace_ctx_a

                    # Cross Fade: VACE → video2 (ease_in: VACE snaps to original)
                    t_b = torch.linspace(0.0, 1.0, cf, device=trans_px.device)
                    alpha_b = (t_b * t_b).view(-1, 1, 1, 1)  # ease_in = t²
                    crossfade_b = (1.0 - alpha_b) * vace_ctx_b + alpha_b * original_ctx_b

                    # Assemble: [crossfade_A | vace_middle | crossfade_B]
                    segments.append(crossfade_a)
                    if vace_middle.shape[0] > 0:
                        segments.append(vace_middle)
                    segments.append(crossfade_b)
                else:
                    # No crossfade: use full VACE output as-is
                    segments.append(trans_px)

        # Concatenate all segments, filtering out empties
        segments = [s for s in segments if s.shape[0] > 0]
        stitched_pixels = torch.cat(segments, dim=0)
        total_pixel_frames = stitched_pixels.shape[0]
        print(f"[VACE Stitcher] Final output: {stitched_pixels.shape} "
              f"({total_pixel_frames} pixel frames)")

        return (stitched_pixels,)
