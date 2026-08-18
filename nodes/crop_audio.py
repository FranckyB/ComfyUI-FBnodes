"""
CropAudioPlus - Trim an incoming AUDIO input between in_point / out_point.
Pure workflow node: no preview player, minimal footprint.
"""

from __future__ import annotations

import torch

from .load_audio import _trim_waveform


class CropAudioPlus:
    """Trim an AUDIO input between in_point and out_point (seconds)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "in_point": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "step": 0.01,
                    "tooltip": "Clip start in seconds",
                }),
                "out_point": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "step": 0.01,
                    "tooltip": "Clip end in seconds (0 = full length)",
                }),
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "Trim an incoming AUDIO clip between in/out points."
    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration")
    FUNCTION = "crop"

    def crop(self, audio, in_point=0.0, out_point=0.0):
        if not isinstance(audio, dict) or "waveform" not in audio:
            return (audio, 0.0)

        waveform = audio["waveform"]
        sample_rate = int(audio.get("sample_rate") or 44100)

        trimmed, trimmed_duration = _trim_waveform(waveform, sample_rate, in_point, out_point)
        return ({"waveform": trimmed, "sample_rate": sample_rate}, trimmed_duration)

    @classmethod
    def IS_CHANGED(cls, audio, in_point=0.0, out_point=0.0, **kwargs):
        # Re-run when the input audio or trim points change.
        wf = audio.get("waveform") if isinstance(audio, dict) else None
        sig = None
        if isinstance(wf, torch.Tensor):
            sig = (tuple(wf.shape), float(wf.sum().item()))
        return (sig, in_point, out_point)
