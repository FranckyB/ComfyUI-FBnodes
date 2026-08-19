"""
Clip Stitcher Node
Merges multiple video clips into one continuous output.

No generation - pure blending. With blend_duration=0 the clips are simply
concatenated. With blend_duration>0 the last N seconds of each clip cross-dissolve
over the first N frames of the next clip (audio crossfaded too).

Reuses the VACE Stitcher's video/audio loading helpers.
"""

from __future__ import annotations

import json
import os

import torch
import av

import folder_paths

from .vace_stitcher import (
    load_video_file,
    load_video_audio,
    resolve_clip_entry_path,
    _to_stereo_waveform,
    _resample_waveform_linear,
)


def _probe_video(file_path: str):
    """Return (fps, width, height, frame_count) for a video file."""
    with av.open(file_path, mode='r') as container:
        stream = container.streams.video[0]
        fps = 0.0
        if stream.average_rate:
            fps = float(stream.average_rate)
        elif stream.guessed_rate:
            fps = float(stream.guessed_rate)
        width = int(stream.codec_context.width or 0)
        height = int(stream.codec_context.height or 0)
        return fps, width, height


def _extract_video_window(pixels: torch.Tensor, start_frame: int, end_frame: int) -> torch.Tensor:
    """Extract frames [start_frame, end_frame), padding with black if out of bounds."""
    t = pixels.shape[0]
    start_frame = int(start_frame)
    end_frame = int(end_frame)
    if start_frame >= t:
        return torch.zeros((end_frame - start_frame, *pixels.shape[1:]), dtype=pixels.dtype, device=pixels.device)
    if end_frame <= 0:
        return torch.zeros((end_frame - start_frame, *pixels.shape[1:]), dtype=pixels.dtype, device=pixels.device)
    pre_pad = max(0, -start_frame)
    post_pad = max(0, end_frame - t)
    s = max(0, start_frame)
    e = min(t, end_frame)
    chunk = pixels[s:e]
    if pre_pad > 0:
        chunk = torch.cat([torch.zeros((pre_pad, *pixels.shape[1:]), dtype=pixels.dtype, device=pixels.device), chunk], dim=0)
    if post_pad > 0:
        chunk = torch.cat([chunk, torch.zeros((post_pad, *pixels.shape[1:]), dtype=pixels.dtype, device=pixels.device)], dim=0)
    return chunk


def _extract_audio_window(payload, start_frame: int, end_frame: int, samples_per_frame: float, seg_samples: int) -> torch.Tensor:
    """Extract audio samples matching [start_frame, end_frame), padding with silence."""
    start_sample = int(round(start_frame * samples_per_frame))
    end_sample = int(round(end_frame * samples_per_frame))
    if payload is None or "waveform" not in payload:
        return torch.zeros((1, 2, seg_samples), dtype=torch.float32)
    w = payload["waveform"]
    channels = w.shape[-2]
    total = w.shape[-1]
    if start_sample >= total:
        return torch.zeros((1, channels, seg_samples), dtype=w.dtype, device=w.device)
    if end_sample <= 0:
        return torch.zeros((1, channels, seg_samples), dtype=w.dtype, device=w.device)
    pre_pad = max(0, -start_sample)
    post_pad = max(0, end_sample - total)
    s = max(0, start_sample)
    e = min(total, end_sample)
    chunk = w[..., s:e]
    if pre_pad > 0:
        chunk = torch.cat([torch.zeros((1, channels, pre_pad), dtype=w.dtype, device=w.device), chunk], dim=-1)
    if post_pad > 0:
        chunk = torch.cat([chunk, torch.zeros((1, channels, post_pad), dtype=w.dtype, device=w.device)], dim=-1)
    # Trim/pad to exact seg_samples length.
    if chunk.shape[-1] > seg_samples:
        chunk = chunk[..., :seg_samples]
    elif chunk.shape[-1] < seg_samples:
        chunk = torch.nn.functional.pad(chunk, (0, seg_samples - chunk.shape[-1]))
    return chunk


class ClipStitcher:
    """Merge video clips into one with optional cross-dissolve blending."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_folder": (["input", "output"], {
                    "tooltip": "Select which folder to browse clips from.",
                }),
                "clip_list": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": "JSON list of clips (managed by the UI browser widget).",
                }),
                "clip_duration": ("FLOAT", {
                    "default": 5.0,
                    "min": 0.0,
                    "max": 600.0,
                    "step": 0.05,
                    "tooltip": "Fixed segment length per clip in seconds. 0 = use full clip length (legacy). When > 0, clip 0 starts at 0; clip i starts at i*clip_duration - blend, and ends at (i+1)*clip_duration.",
                }),
                "blend_duration": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 60.0,
                    "step": 0.05,
                    "tooltip": "Seconds to cross-dissolve between clips. 0 = hard cut. In fixed-segment mode, each clip after the first spans clip_duration + blend so it overlaps the previous clip by blend.",
                }),

            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = (
        "Merge video clips into one. blend_duration=0 concatenates; >0 cross-dissolves. "
        "Set clip_duration > 0 to force fixed segment lengths instead of using full clips."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, source_folder, clip_list, clip_duration, blend_duration):
        # ── Parse clip list and resolve paths ──
        try:
            entries = json.loads(clip_list) if isinstance(clip_list, str) else clip_list
        except (json.JSONDecodeError, TypeError):
            entries = []

        if not isinstance(entries, list):
            entries = []

        enabled = [e for e in entries if isinstance(e, dict) and e.get("enabled", True)]
        if len(enabled) < 1:
            raise ValueError("Need at least 1 enabled clip. Use the Browse button to add clips.")

        clip_files = []
        for entry in enabled:
            full = resolve_clip_entry_path(entry, source_folder)
            if not full or not os.path.isfile(full):
                raise FileNotFoundError(f"Clip not found: {full or entry}")
            clip_files.append(full)

        # ── Validate compatibility (format/fps/resolution) ──
        ext0 = os.path.splitext(clip_files[0])[1].lower()
        if ext0 not in ('.mp4', '.webm', '.mov', '.avi'):
            raise ValueError(f"Unsupported file type: {ext0}. Only video files (.mp4, .webm, .mov, .avi) are supported.")

        fps0, w0, h0 = _probe_video(clip_files[0])
        for f in clip_files[1:]:
            ext = os.path.splitext(f)[1].lower()
            if ext != ext0:
                raise ValueError(f"Clip format mismatch: {os.path.basename(clip_files[0])} is {ext0} but {os.path.basename(f)} is {ext}.")
            fps, w, h = _probe_video(f)
            if abs(fps - fps0) > 0.01:
                raise ValueError(f"Clip fps mismatch: {os.path.basename(clip_files[0])} is {fps0:.3f} but {os.path.basename(f)} is {fps:.3f}.")
            if w != w0 or h != h0:
                raise ValueError(f"Clip resolution mismatch: {os.path.basename(clip_files[0])} is {w0}x{h0} but {os.path.basename(f)} is {w}x{h}.")

        fps = float(fps0 or 16.0)
        # blend_duration is in seconds; convert to frames using the clip fps.
        blend = max(0, int(round(float(blend_duration) * fps)))
        use_fixed_segments = float(clip_duration or 0.0) > 0.0
        if use_fixed_segments:
            seg_dur = max(float(blend_duration or 0.0) + 0.001, float(clip_duration))
            seg_frames = max(1, int(round(seg_dur * fps)))
            blend = min(blend, seg_frames - 1) if seg_frames > 1 else 0
        else:
            seg_frames = None
        print(f"[Clip Stitcher] {len(clip_files)} clips @ {fps:.3f} fps, {w0}x{h0}, blend={blend} frames ({float(blend_duration):.2f}s){', fixed segment=' + str(seg_frames) + ' frames (' + f'{clip_duration:.2f}s)' if use_fixed_segments else ''}")

        # ── Load clip pixels ──
        clip_pixels = [load_video_file(f) for f in clip_files]  # each (T, H, W, 3) float32

        # ── Load + normalize clip audio ──
        clip_audio = []
        first_audio_sr = None
        for f in clip_files:
            waveform, sample_rate = load_video_audio(f)
            if waveform is None:
                clip_audio.append(None)
                continue
            if first_audio_sr is None:
                first_audio_sr = int(sample_rate)
            clip_audio.append({"waveform": waveform.to(torch.float32).contiguous(), "sample_rate": int(sample_rate)})

        target_sr = int(first_audio_sr or 44100)
        for i, payload in enumerate(clip_audio):
            if payload is None:
                continue
            w = payload["waveform"]
            sr = int(payload["sample_rate"])
            if sr != target_sr:
                w = _resample_waveform_linear(w, sr, target_sr)
            clip_audio[i] = {"waveform": _to_stereo_waveform(w).contiguous(), "sample_rate": target_sr}

        # ── Build fixed-length video segments (pad with black if source is too short) ──
        # Each source clip is taken from its OWN start. Only the overlap with the
        # previous output segment shifts; we never skip into the source.
        # The LAST clip is not padded: it plays to its natural end (no trailing black).
        if use_fixed_segments and len(clip_pixels) > 1:
            segments = []
            last_idx = len(clip_pixels) - 1
            for i, px in enumerate(clip_pixels):
                if i == last_idx:
                    # Last clip: keep natural length, but still overlap previous by blend.
                    seg_len = px.shape[0]
                else:
                    seg_len = seg_frames if i == 0 else seg_frames + blend
                segments.append(_extract_video_window(px, 0, seg_len))
        else:
            segments = list(clip_pixels)

        # ── Blend / concatenate video frames ──
        if blend == 0 or len(segments) == 1:
            images = torch.cat(segments, dim=0)
        else:
            out_segments = [segments[0]]
            for i in range(1, len(segments)):
                prev = out_segments[-1]
                nxt = segments[i]
                n = min(blend, prev.shape[0], nxt.shape[0])
                if n <= 0:
                    out_segments.append(nxt)
                    continue
                tail = prev[-n:]
                head = nxt[:n]
                alpha = torch.linspace(0.0, 1.0, n, dtype=prev.dtype, device=prev.device).view(n, 1, 1, 1)
                blended = (1.0 - alpha) * tail + alpha * head
                out_segments[-1] = prev[:-n]
                out_segments.append(blended)
                if nxt.shape[0] > n:
                    out_segments.append(nxt[n:])
            images = torch.cat(out_segments, dim=0)

        # ── Build fixed-length audio segments (pad with silence if source is too short) ──
        # The LAST clip's audio is not padded; it ends with the video.
        samples_per_frame = target_sr / fps
        audio_segments = []
        last_idx = len(clip_audio) - 1
        for i, payload in enumerate(clip_audio):
            if use_fixed_segments and len(clip_pixels) > 1:
                if i == last_idx:
                    seg_len = clip_pixels[i].shape[0]
                else:
                    seg_len = seg_frames if i == 0 else seg_frames + blend
                seg_samples = max(1, int(round(seg_len * samples_per_frame)))
                w = _extract_audio_window(payload, 0, seg_len, samples_per_frame, seg_samples)
            else:
                clip_len = clip_pixels[i].shape[0]
                seg_samples = max(1, int(round(clip_len * samples_per_frame)))
                if payload is None:
                    w = torch.zeros((1, 2, seg_samples), dtype=torch.float32)
                else:
                    w = payload["waveform"]
                    if w.shape[-1] > seg_samples:
                        w = w[..., :seg_samples]
                    elif w.shape[-1] < seg_samples:
                        w = torch.nn.functional.pad(w, (0, seg_samples - w.shape[-1]))
            audio_segments.append(w)

        # ── Blend / concatenate audio to match the video timeline ──
        audio_out = None
        if any(w is not None for w in audio_segments):
            if blend == 0 or len(audio_segments) == 1:
                audio_w = torch.cat(audio_segments, dim=-1)
            else:
                out = audio_segments[0]
                overlap_samples = int(round(blend * samples_per_frame))
                for i in range(1, len(audio_segments)):
                    nxt = audio_segments[i]
                    n = min(overlap_samples, out.shape[-1], nxt.shape[-1])
                    if n <= 0:
                        out = torch.cat([out, nxt], dim=-1)
                        continue
                    alpha = torch.linspace(0.0, 1.0, n, dtype=out.dtype, device=out.device).view(1, 1, n)
                    blended = (1.0 - alpha) * out[..., -n:] + alpha * nxt[..., :n]
                    out = torch.cat([out[..., :-n], blended, nxt[..., n:]], dim=-1)
                audio_w = out

            audio_out = {"waveform": audio_w.contiguous(), "sample_rate": target_sr}

        # ── Build the output VIDEO at 10-bit via ComfyUI's CreateVideo ──
        video = self._create_video(images, fps, audio_out)

        return (video,)

    @staticmethod
    def _create_video(images, fps, audio_out):
        """Build a VIDEO from frames/audio at 10-bit using ComfyUI's CreateVideo node."""
        try:
            import nodes as comfy_nodes
            cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("CreateVideo")
            if cls is None:
                raise RuntimeError("CreateVideo node not available")
            out = cls.execute(images=images, fps=float(fps), audio=audio_out, bit_depth=10)
            return out.result[0] if hasattr(out, "result") else out[0]
        except Exception as e:
            raise RuntimeError(f"[Clip Stitcher] Could not build output video: {e}") from e
