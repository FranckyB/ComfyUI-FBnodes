"""
LTX Upsampler node.

Takes a latent produced by another video model (e.g. MiniMax H3 saved via
Save Video+), decodes it to pixels with its own VAE, re-encodes into LTX
latent space, spatially upscales it with the LTX latent upscaler, then runs a
short LTX refinement pass and decodes the result to a VIDEO.

This orchestrates existing ComfyUI core LTX nodes rather than reimplementing
them (recipe-style): LTXVLatentUpsampler, LTXVConcatAVLatent, LTXVDualCFGGuider,
LTXVConditioning, SamplerCustomAdvanced, LTXVSeparateAVLatent, VAE decode nodes.
"""

import json
import os

import torch

import nodes as comfy_nodes

from .save_video import (
    GetVideoComponentsPlus,
    _detect_latent_format_name,
    _is_comfy_nested_tensor,
)


def _get_node(name):
    cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(name)
    if cls is None:
        raise RuntimeError(
            f"[LTXUpsampler] Required node '{name}' is not available. "
            f"It is part of ComfyUI core (LTXV extras) - please update ComfyUI."
        )
    return cls


def _call(name, func_name, **kwargs):
    """Call a core node's FUNCTION (handles both legacy instance methods and V3 classmethods)."""
    cls = _get_node(name)

    # Resolve candidate attribute names in preference order.
    candidates = [func_name, "execute", getattr(cls, "FUNCTION", ""), "EXECUTE_NORMALIZED"]
    for attr in candidates:
        if not attr:
            continue
        fn = getattr(cls, attr, None)
        if fn is None:
            continue
        try:
            out = fn(**kwargs)
        except TypeError as e:
            # Legacy nodes define FUNCTION as an instance method - calling the
            # unbound function without `self` raises "missing 1 required positional
            # argument: 'self'". Instantiate and retry.
            if "self" in str(e):
                out = getattr(cls(), attr)(**kwargs)
            else:
                raise
        # NodeOutput / tuple handling
        if hasattr(out, "result"):
            return out.result
        return out

    raise RuntimeError(f"[LTXUpsampler] Node '{name}' has no callable execute function.")


def _extract_prompt_from_latent(video_path):
    """Pull the positive prompt out of the matching .latent file's embedded prompt.

    Returns (positive, negative). Heuristic: the positive prompt is the longest
    free-text input in the embedded API prompt; the negative is the shortest
    CLIPTextEncode-style text (often a stock negative string).
    """
    if not video_path:
        return None, None
    latent_path = os.path.splitext(video_path)[0] + ".latent"
    if not os.path.exists(latent_path):
        return None, None
    try:
        from safetensors import safe_open
        with safe_open(latent_path, framework="pt") as f:
            meta = f.metadata() or {}
        prompt = meta.get("prompt")
        if not prompt:
            return None, None
        pd = json.loads(prompt)
    except Exception:
        return None, None

    texts = []
    for nd in pd.values():
        if not isinstance(nd, dict):
            continue
        inp = nd.get("inputs", {})
        if not isinstance(inp, dict):
            continue
        for k, v in inp.items():
            if isinstance(v, str) and len(v.strip()) > 3 and not v.startswith("{") and not v.startswith("["):
                # Skip obvious config-ish keys
                if k in ("filename_prefix", "codec", "chroma", "vae_name", "clip_name",
                         "unet_name", "lora_name", "sampler_name", "scheduler", "type",
                         "device", "weight_dtype", "category", "expression", "aspect_ratio",
                         "loras_state_a", "system_prompt", "use_lora_input", "sink_conditioning",
                         "morton_curve", "dense_blocks", "exec_start", "_fbSaveVideoLastResult"):
                    continue
                texts.append(v)

    if not texts:
        return None, None
    # Positive = longest free-text field; negative = None (LTX usually uses empty/stock neg)
    positive = max(texts, key=len)
    return positive, None


class LTXUpsampler:
    """
    Upscale + refine a source video (e.g. MiniMax) using LTX.

    Takes a VIDEO input. If a matching .latent file exists alongside the video
    (written by Save Video+) and `use_latent` is on, the latent is decoded with
    the source VAEs for max fidelity; otherwise the video's decoded frames/audio
    are used directly. Either way the pixels are re-encoded into LTX space,
    spatially upscaled with the LTX latent upscaler, refined with a short LTX
    sampler pass, and decoded back to IMAGE + AUDIO.

    If the matching latent is already in LTX space (128-channel), the decode ->
    re-encode -> LTXVLatentUpsampler steps are skipped and it is refined directly.

    Frame rate is detected from the source video. `use_video_prompt` (off by
    default) pulls the positive prompt from the video's embedded workflow.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {"tooltip": "The source video to upscale (e.g. from Save Video+). If a matching .latent file exists it is used automatically when use_latent is on."}),
                "use_latent": ("BOOLEAN", {"default": True, "tooltip": "Use the matching .latent file (if found) for higher-fidelity re-encoding. If off, the video's decoded pixels/audio are used directly."}),
                "model": ("MODEL", {"tooltip": "The LTX diffusion model used for the refinement pass."}),
                "video_vae": ("VAE", {"tooltip": "The LTX video VAE. Used to encode pixels into LTX latent space and decode the final result."}),
                "audio_vae": ("VAE", {"tooltip": "The LTX audio VAE."}),
                "clip": ("CLIP", {"tooltip": "The LTX text encoder (CLIP)."}),
                "upscale_model": ("LATENT_UPSCALE_MODEL", {"tooltip": "The LTX latent spatial upscaler model (LatentUpscaleModelLoader)."}),
                "positive": ("STRING", {"forceInput": True, "tooltip": "Positive prompt guiding the refinement pass. Connect a text source."}),
                "use_video_prompt": ("BOOLEAN", {"default": False, "tooltip": "Pull the positive prompt from the video's embedded workflow metadata, overriding the positive input above."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip": "Noise seed for the refinement pass."}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "tooltip": "CFG (video and audio) for the refinement pass."}),
                "sampler_name": (["euler_ancestral", "euler", "dpmpp_2m", "ddim"], {"default": "euler_ancestral"}),
            },
            "optional": {
                "source_video_vae": ("VAE", {"tooltip": "The video VAE matching the source latent (e.g. MiniMax H3 video VAE). Only needed when using a non-LTX latent."}),
                "source_audio_vae": ("VAE", {"tooltip": "The audio VAE matching the source latent (e.g. MiniMax H3 audio VAE). Only needed when using a non-LTX latent."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "LATENT")
    RETURN_NAMES = ("images", "audio", "ltx_latent")
    FUNCTION = "upscale"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Upscale + refine a source video (e.g. MiniMax) into LTX space using the LTX latent upscaler and a short refinement pass. Outputs decoded frames (IMAGE) and audio (AUDIO)."

    def upscale(self, video, use_latent, model, video_vae, audio_vae, clip,
                upscale_model, positive, use_video_prompt, seed, cfg,
                sampler_name, source_video_vae=None, source_audio_vae=None):

        negative = ""  # LTX refinement uses an empty negative prompt.

        gvc = GetVideoComponentsPlus

        # --- Resolve source video path, fps, and (optionally) the matching latent ---
        video_path = gvc._get_video_path(video)
        trim_in, trim_out = gvc._get_trim_points(video)
        fps, _w, _h, _fc, _dur = gvc._probe_video_metadata(video, video_path, trim_in=trim_in, trim_out=trim_out)
        if not fps or fps <= 0:
            fps = 24.0
        frame_rate = int(round(fps))
        print(f"[LTXUpsampler] Source video: {os.path.basename(video_path) if video_path else '(in-memory)'} @ {fps:.3f} fps")

        # --- Optional: pull the positive prompt from the embedded workflow ---
        if use_video_prompt:
            p_pos, _p_neg = _extract_prompt_from_latent(video_path)
            if p_pos:
                positive = p_pos
                print(f"[LTXUpsampler] Using embedded positive prompt ({len(p_pos)} chars)")

        # --- Find the matching latent (written by Save Video+), if enabled ---
        latent = gvc._load_matching_latent(video_path) if use_latent else None

        audio_latent = None     # LTX-space audio latent for the concat
        upscaled_latent = None  # LTX-space video latent ready for sampling

        if latent is not None and isinstance(latent, dict) and "samples" in latent:
            samples = latent["samples"]
            is_ltx = _detect_latent_format_name(samples) == "LTX"

            if is_ltx:
                # Already LTX space - refine directly, skip decode/re-encode/upscale.
                upscaled_latent = latent
            else:
                # Unwrap the AV NestedTensor into video (idx 0) and audio (idx 1).
                if _is_comfy_nested_tensor(samples):
                    parts = list(samples.tensors)
                    video_samples = parts[0]
                    audio_samples = parts[1] if len(parts) > 1 else None
                else:
                    video_samples = samples
                    audio_samples = None

                if source_video_vae is None:
                    raise RuntimeError("[LTXUpsampler] source_video_vae is required to decode a non-LTX latent.")

                # 1. Decode the source latent's video stream with the source video VAE.
                pixels = source_video_vae.decode(video_samples)
                if pixels.ndim == 5:
                    pixels = pixels[0]

                # 2. Re-encode pixels into LTX latent space with the LTX video VAE.
                # VAE.encode does movedim(-1,1) internally and handles video reshaping.
                ltx_samples = video_vae.encode(pixels)
                ltx_latent = {"samples": ltx_samples}

                # 3. Spatially upscale the LTX latent with the LTX latent upscaler.
                upscaled = _call("LTXVLatentUpsampler", "EXECUTE_NORMALIZED",
                                 samples=ltx_latent, upscale_model=upscale_model, vae=video_vae)
                upscaled_latent = upscaled[0] if isinstance(upscaled, (tuple, list)) else upscaled

                # 4. Decode + re-encode the source audio into LTX audio latent space.
                if audio_samples is not None and source_audio_vae is not None:
                    try:
                        src_audio = _call("VAEDecodeAudio", "EXECUTE_NORMALIZED",
                                          samples={"samples": audio_samples}, vae=source_audio_vae)
                        src_audio = src_audio[0] if isinstance(src_audio, (tuple, list)) else src_audio
                        if isinstance(src_audio, dict) and "waveform" in src_audio:
                            ltx_audio_samples = audio_vae.encode(src_audio["waveform"])
                            if ltx_audio_samples is not None:
                                audio_latent = {"samples": ltx_audio_samples}
                    except Exception as e:
                        print(f"[LTXUpsampler] Source audio decode failed, using silent audio: {e}")
                        audio_latent = None
        else:
            # No latent (or use_latent off): decode the video's pixels/audio directly.
            print("[LTXUpsampler] No matching latent (or use_latent off) - using video pixels directly.")
            pixels = None
            src_audio = None
            try:
                components = video.get_components()
                pixels = components.images
                src_audio = components.audio
            except Exception as e:
                print(f"[LTXUpsampler] Comfy VIDEO API failed, trying PyAV fallback: {e}")
                if video_path and os.path.exists(video_path):
                    pixels, _n = gvc._decode_images_chunked(video_path, gvc.IMAGE_CHUNK_SIZE, trim_in=trim_in, trim_out=trim_out)
                    src_audio = gvc._decode_audio(video_path, trim_in=trim_in, trim_out=trim_out)

            if pixels is None or (torch.is_tensor(pixels) and pixels.shape[0] == 0):
                raise RuntimeError("[LTXUpsampler] Could not decode any frames from the source video.")

            if pixels.ndim == 5:
                pixels = pixels[0]

            # Re-encode pixels into LTX latent space and upscale.
            ltx_samples = video_vae.encode(pixels)
            ltx_latent = {"samples": ltx_samples}
            upscaled = _call("LTXVLatentUpsampler", "EXECUTE_NORMALIZED",
                             samples=ltx_latent, upscale_model=upscale_model, vae=video_vae)
            upscaled_latent = upscaled[0] if isinstance(upscaled, (tuple, list)) else upscaled

            # Re-encode the video's audio into LTX audio latent space.
            if isinstance(src_audio, dict) and "waveform" in src_audio:
                try:
                    ltx_audio_samples = audio_vae.encode(src_audio["waveform"])
                    if ltx_audio_samples is not None:
                        audio_latent = {"samples": ltx_audio_samples}
                except Exception as e:
                    print(f"[LTXUpsampler] Video audio encode failed, using silent audio: {e}")
                    audio_latent = None

        # Build text conditioning.
        pos = _call("CLIPTextEncode", "encode", clip=clip, text=positive)
        neg = _call("CLIPTextEncode", "encode", clip=clip, text=negative)
        pos = pos[0] if isinstance(pos, (tuple, list)) else pos
        neg = neg[0] if isinstance(neg, (tuple, list)) else neg

        cond = _call("LTXVConditioning", "EXECUTE_NORMALIZED",
                     positive=pos, negative=neg, frame_rate=frame_rate)
        pos_c, neg_c = cond[0], cond[1]

        # Audio latent to combine with the video latent. If we decoded + re-encoded
        # the source audio above, use it; otherwise fall back to a silent empty latent.
        num_frames = int(upscaled_latent["samples"].shape[2])
        if audio_latent is None:
            audio_latent = _call("LTXVEmptyLatentAudio", "EXECUTE_NORMALIZED",
                                 frames_number=num_frames, frame_rate=frame_rate, batch_size=1, audio_vae=audio_vae)
            audio_latent = audio_latent[0] if isinstance(audio_latent, (tuple, list)) else audio_latent

        # Combine video + audio latents into the AV latent the sampler expects.
        av_latent = _call("LTXVConcatAVLatent", "EXECUTE_NORMALIZED",
                          video_latent=upscaled_latent, audio_latent=audio_latent)
        av_latent = av_latent[0] if isinstance(av_latent, (tuple, list)) else av_latent

        # Guider + sampler + LTX upscale sigma schedule, then run the refinement pass.
        guider = _call("LTXVDualCFGGuider", "EXECUTE_NORMALIZED",
                       model=model, positive=pos_c, negative=neg_c,
                       video_cfg=cfg, audio_cfg=cfg)
        guider = guider[0] if isinstance(guider, (tuple, list)) else guider

        sampler = _call("KSamplerSelect", "EXECUTE_NORMALIZED", sampler_name=sampler_name)
        sampler = sampler[0] if isinstance(sampler, (tuple, list)) else sampler

        noise = _call("RandomNoise", "EXECUTE_NORMALIZED", noise_seed=seed)
        noise = noise[0] if isinstance(noise, (tuple, list)) else noise

        # Use LTX's upscale refinement sigma schedule (from the reference LTX
        # upscale workflow). This is the model's own upsampling schedule, not a
        # generic denoise fraction.
        sigmas = _call("ManualSigmas", "EXECUTE_NORMALIZED",
                       sigmas="0.85, 0.7250, 0.4219, 0.0")
        sigmas = sigmas[0] if isinstance(sigmas, (tuple, list)) else sigmas

        sampled = _call("SamplerCustomAdvanced", "EXECUTE_NORMALIZED",
                        noise=noise, guider=guider, sampler=sampler,
                        sigmas=sigmas, latent_image=av_latent)
        refined_latent = sampled[0] if isinstance(sampled, (tuple, list)) else sampled

        # Split the AV latent back into video + audio, then decode both.
        sep = _call("LTXVSeparateAVLatent", "EXECUTE_NORMALIZED", av_latent=refined_latent)
        video_lat, audio_lat = sep[0], sep[1]

        images = video_vae.decode(video_lat["samples"])
        if images.ndim == 5:
            images = images[0]

        audio = _call("LTXVAudioVAEDecode", "EXECUTE_NORMALIZED",
                      samples=audio_lat, audio_vae=audio_vae)
        audio_out = audio[0] if isinstance(audio, (tuple, list)) else audio

        return (images, audio_out, refined_latent)
