"""
VACE Clip Joiner Node
Takes a directory of .latent files, generates VACE transitions between them,
and stitches everything into a single continuous latent sequence.
"""

from __future__ import annotations

import os
import glob
import torch
import safetensors.torch

import comfy.sample
import comfy.samplers
import comfy.utils
import comfy.model_management
import comfy.model_sampling
import comfy.latent_formats
import node_helpers
import folder_paths
import latent_preview


def load_latent_file(file_path: str) -> torch.Tensor:
    """Load a .latent file and return the raw samples tensor."""
    latent = safetensors.torch.load_file(file_path, device="cpu")
    multiplier = 1.0
    if "latent_format_version_0" not in latent:
        multiplier = 1.0 / 0.18215
    return latent["latent_tensor"].float() * multiplier


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


def encode_text(clip, text: str):
    """Encode text using CLIP, returning conditioning."""
    tokens = clip.tokenize(text)
    return clip.encode_from_tokens_scheduled(tokens)


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


def build_control_video_and_mask(
    frames_a: torch.Tensor, frames_b: torch.Tensor,
    context_frames: int, new_frames: int,
):
    """
    Build VACE control video and mask from two sets of pixel-space frames.
    frames_a: context frames from end of clip A (N, H, W, 3)
    frames_b: context frames from start of clip B (N, H, W, 3)

    Returns (control_video, control_mask, total_length)
    """
    height, width, channels = frames_a.shape[1], frames_a.shape[2], frames_a.shape[3]

    # Wan generates 4n+1 frames, add 1 to ensure proper alignment
    vace_count = new_frames + 1

    # Middle section: gray frames (unknown, to be generated)
    vace_frames = torch.full(
        (vace_count, height, width, channels), 0.5,
        dtype=frames_a.dtype, device=frames_a.device,
    )

    # Concatenate: [context_A | unknown | context_B]
    control_video = torch.cat([frames_a, vace_frames, frames_b], dim=0)

    # Mask: 0 = keep (context), 1 = generate (middle)
    total_frames = control_video.shape[0]
    mask = torch.zeros((total_frames, height, width), dtype=torch.float32, device=frames_a.device)
    mask[context_frames:context_frames + vace_count] = 1.0

    return control_video, mask, total_frames


class VACEClipJoiner:
    """
    Loads .latent files from a directory, generates VACE transitions between
    consecutive clips, and stitches everything into one continuous latent.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_high": ("MODEL", {
                    "tooltip": "Model for high-noise sampling stage (first N steps). Connect LoRAs externally.",
                }),
                "model_low": ("MODEL", {
                    "tooltip": "Model for low-noise sampling stage (remaining steps). Connect LoRAs externally.",
                }),
                "clip": ("CLIP", {}),
                "vae": ("VAE", {}),
                "latent_dir": ("STRING", {
                    "default": "",
                    "tooltip": "Directory containing .latent files (sorted alphabetically).",
                }),
                "positive_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Positive text prompt for VACE generation.",
                }),
                "negative_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Negative text prompt for VACE generation.",
                }),
                "context_frames": ("INT", {
                    "default": 8, "min": 4, "max": 120, "step": 4,
                    "tooltip": "Reference frames from each clip edge used as VACE context.",
                }),
                "new_frames": ("INT", {
                    "default": 8, "min": 0, "max": 240, "step": 4,
                    "tooltip": "New transition frames to generate between clips.",
                }),
                "steps_high": ("INT", {
                    "default": 4, "min": 1, "max": 100,
                    "tooltip": "Sampling steps for high-noise stage.",
                }),
                "steps_low": ("INT", {
                    "default": 4, "min": 1, "max": 100,
                    "tooltip": "Sampling steps for low-noise stage.",
                }),
                "cfg": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1,
                    "tooltip": "Classifier-free guidance scale.",
                }),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {
                    "default": "euler",
                }),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {
                    "default": "simple",
                }),
                "shift": ("FLOAT", {
                    "default": 5.0, "min": 0.0, "max": 100.0, "step": 0.01,
                    "tooltip": "ModelSamplingSD3 shift value applied to both models.",
                }),
                "seed": ("INT", {
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                }),
                "seamless_loop": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Generate a transition from last clip back to first clip.",
                }),
                "save_intermediates": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Save transition latents to a subfolder for resumability.",
                }),
                "vace_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01,
                    "tooltip": "VACE conditioning strength.",
                }),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = (
        "Loads .latent files from a directory, generates VACE transitions between "
        "consecutive clips using 2-stage sampling, and outputs a single stitched latent. "
        "VAE decode the output to get the final video."
    )

    def execute(
        self,
        model_high, model_low, clip, vae,
        latent_dir, positive_prompt, negative_prompt,
        context_frames, new_frames,
        steps_high, steps_low, cfg, sampler_name, scheduler,
        shift, seed, seamless_loop, save_intermediates, vace_strength,
    ):
        # ── 1. Discover and load latent files ──
        if not os.path.isdir(latent_dir):
            raise FileNotFoundError(f"Latent directory not found: {latent_dir}")

        latent_files = sorted(glob.glob(os.path.join(latent_dir, "*.latent")))
        if len(latent_files) < 2:
            raise ValueError(f"Need at least 2 .latent files, found {len(latent_files)} in {latent_dir}")

        print(f"[VACE Clip Joiner] Found {len(latent_files)} latent files")
        latents = []
        for f in latent_files:
            print(f"[VACE Clip Joiner]   Loading: {os.path.basename(f)}")
            latents.append(load_latent_file(f))

        # ── 2. Apply shift to both models ──
        model_high_shifted = apply_model_shift(model_high, shift)
        model_low_shifted = apply_model_shift(model_low, shift)

        # ── 3. Encode prompts ──
        positive_cond = encode_text(clip, positive_prompt)
        negative_cond = encode_text(clip, negative_prompt)

        # ── 4. Build transition pairs ──
        num_clips = len(latents)
        pairs = []
        for i in range(num_clips - 1):
            pairs.append((i, i + 1))
        if seamless_loop:
            pairs.append((num_clips - 1, 0))

        print(f"[VACE Clip Joiner] Generating {len(pairs)} transitions"
              f"{' (seamless loop)' if seamless_loop else ''}")

        # ── 5. Intermediates directory ──
        intermediates_dir = None
        if save_intermediates:
            intermediates_dir = os.path.join(latent_dir, "_vace_transitions")
            os.makedirs(intermediates_dir, exist_ok=True)

        # ── 6. Determine clip dimensions from first latent ──
        # Latent shape: (1, 16, T_latent, H_latent, W_latent)
        sample_latent = latents[0]
        _, _, _, h_latent, w_latent = sample_latent.shape
        width = w_latent * 8
        height = h_latent * 8

        # Context frames in latent space: 4 pixel frames = 1 latent frame (roughly)
        # But we need pixel-space context for VACE, so decode from latent
        context_latent_frames = ((context_frames - 1) // 4) + 1

        # ── 7. Generate all transitions ──
        transition_latents = {}
        pbar = comfy.utils.ProgressBar(len(pairs))

        for pair_idx, (idx_a, idx_b) in enumerate(pairs):
            pair_key = f"{idx_a:03d}_to_{idx_b:03d}"
            print(f"[VACE Clip Joiner] Transition {pair_idx + 1}/{len(pairs)}: "
                  f"clip {idx_a} -> clip {idx_b}")

            # Check for cached intermediate
            if intermediates_dir:
                cached_path = os.path.join(intermediates_dir, f"transition_{pair_key}.latent")
                if os.path.exists(cached_path):
                    print(f"[VACE Clip Joiner]   Using cached transition: {cached_path}")
                    transition_latents[pair_key] = load_latent_file(cached_path)
                    pbar.update(1)
                    continue

            latent_a = latents[idx_a]  # (1, 16, T, H, W)
            latent_b = latents[idx_b]

            # Extract context frames from latent space (end of A, start of B)
            context_a_latent = latent_a[:, :, -context_latent_frames:, :, :]
            context_b_latent = latent_b[:, :, :context_latent_frames, :, :]

            # Decode context frames to pixel space for VACE conditioning
            # VAE decode may return 5D (1, T, H, W, 3) for video — squeeze batch dim
            print(f"[VACE Clip Joiner]   Decoding {context_latent_frames * 2} context latent frames...")
            context_a_pixels = vae.decode(context_a_latent)
            context_b_pixels = vae.decode(context_b_latent)

            # Ensure 4D (T, H, W, 3) — squeeze batch dimension if present
            if context_a_pixels.ndim == 5:
                context_a_pixels = context_a_pixels.squeeze(0)
            if context_b_pixels.ndim == 5:
                context_b_pixels = context_b_pixels.squeeze(0)

            print(f"[VACE Clip Joiner]   Decoded shapes: A={context_a_pixels.shape}, B={context_b_pixels.shape}")

            # Build VACE control video and mask
            control_video, control_mask, total_length = build_control_video_and_mask(
                context_a_pixels, context_b_pixels,
                context_frames=context_a_pixels.shape[0],
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
            print(f"[VACE Clip Joiner]   Sampling ({steps_high}+{steps_low} steps)...")
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

            # The result contains [context_A_regen | transition | context_B_regen]
            # We only want the generated middle portion (new_frames)
            # Context frames in latent: context_latent_frames on each side
            result_samples = result_latent["samples"]
            total_latent_len = result_samples.shape[2]

            # The new transition frames in latent space
            new_latent_frames = ((new_frames - 1) // 4) + 1 if new_frames > 0 else 0

            # Extract just the transition portion (skip context on both sides)
            if new_latent_frames > 0:
                start = context_latent_frames
                end = start + new_latent_frames
                # Clamp to available range
                end = min(end, total_latent_len - context_latent_frames)
                transition_samples = result_samples[:, :, start:end, :, :]
            else:
                # No new frames, just a direct stitch (empty transition)
                transition_samples = result_samples[:, :, 0:0, :, :]

            transition_latents[pair_key] = transition_samples

            # Save intermediate
            if intermediates_dir:
                save_path = os.path.join(intermediates_dir, f"transition_{pair_key}.latent")
                save_data = {
                    "latent_tensor": transition_samples.contiguous(),
                    "latent_format_version_0": torch.tensor([]),
                }
                comfy.utils.save_torch_file(save_data, save_path)
                print(f"[VACE Clip Joiner]   Saved: {save_path}")

            pbar.update(1)

        # ── 8. Stitch everything together ──
        print(f"[VACE Clip Joiner] Stitching {num_clips} clips + {len(pairs)} transitions...")

        parts = []
        for i in range(num_clips):
            clip_latent = latents[i]  # (1, 16, T, H, W)

            if seamless_loop:
                # In loop mode, trim context from both ends of every clip
                # (each end participates in a transition)
                start_trim = context_latent_frames if i > 0 or seamless_loop else 0
                end_trim = context_latent_frames if i < num_clips - 1 or seamless_loop else 0
            else:
                # Trim context from ends that participate in transitions
                start_trim = context_latent_frames if i > 0 else 0
                end_trim = context_latent_frames if i < num_clips - 1 else 0

            t_len = clip_latent.shape[2]
            trimmed = clip_latent[:, :, start_trim:t_len - end_trim if end_trim > 0 else t_len, :, :]
            parts.append(trimmed)

            # Add transition after this clip (if exists)
            if i < num_clips - 1:
                pair_key = f"{i:03d}_to_{i + 1:03d}"
                trans = transition_latents[pair_key]
                if trans.shape[2] > 0:
                    parts.append(trans)

        # Add loop transition at the end
        if seamless_loop:
            pair_key = f"{num_clips - 1:03d}_to_000"
            trans = transition_latents[pair_key]
            if trans.shape[2] > 0:
                parts.append(trans)

        # Concatenate along time dimension
        stitched = torch.cat(parts, dim=2)
        total_frames_latent = stitched.shape[2]
        total_frames_pixel = (total_frames_latent - 1) * 4 + 1
        print(f"[VACE Clip Joiner] Final latent: {stitched.shape} "
              f"(~{total_frames_pixel} pixel frames)")

        return ({"samples": stitched},)
