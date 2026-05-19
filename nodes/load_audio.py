"""
LoadAudioPlus - Audio loader with file browser and clip trimming support.
"""

from __future__ import annotations

import os
import re

import folder_paths
import torch


AUDIO_EXTENSIONS = [".wav", ".flac", ".mp3", ".mp4", ".m4a"]


def _list_audio_files(base_dir: str) -> list[str]:
    files = ["(none)"]
    if not os.path.exists(base_dir):
        return files

    for root, _, filenames in os.walk(base_dir):
        for filename in filenames:
            ext = os.path.splitext(filename)[1].lower()
            if ext in AUDIO_EXTENSIONS:
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, base_dir)
                rel_path = rel_path.replace("\\", "/")
                files.append(rel_path)

    files_to_sort = files[1:]
    files_to_sort.sort()
    return ["(none)"] + files_to_sort


def _parse_annotated_path(path: str) -> tuple[str, str | None]:
    match = re.match(r"^(.+?)\s*\[(input|output|temp)\]\s*$", path or "")
    if match:
        return match.group(1).strip(), match.group(2)
    return (path or "").strip(), None


def _resolve_audio_path(audio_path: str, source_folder: str) -> str:
    if not audio_path:
        return ""

    if os.path.isabs(audio_path):
        return audio_path if os.path.exists(audio_path) else ""

    if source_folder == "output":
        base_dir = folder_paths.get_output_directory()
    else:
        base_dir = folder_paths.get_input_directory()

    candidate = os.path.join(base_dir, audio_path)
    if os.path.exists(candidate):
        return candidate

    temp_candidate = os.path.join(folder_paths.get_temp_directory(), audio_path)
    if os.path.exists(temp_candidate):
        return temp_candidate

    return ""


def _decode_audio_waveform(file_path: str) -> tuple[torch.Tensor, int]:
    try:
        import av
        import numpy as np
    except ImportError as e:
        raise RuntimeError("LoadAudioPlus requires PyAV and numpy") from e

    container = av.open(file_path)
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError(f"No audio stream found: {file_path}")

        sample_rate = int(stream.rate or 0)
        if sample_rate <= 0:
            sample_rate = 44100

        layout_name = None
        if stream.layout is not None:
            layout_name = stream.layout.name
        if not layout_name:
            channels = int(getattr(stream, "channels", 0) or 0)
            layout_name = "mono" if channels <= 1 else "stereo"

        resampler = av.audio.resampler.AudioResampler(
            format="fltp",
            layout=layout_name,
            rate=sample_rate,
        )

        chunks: list[np.ndarray] = []
        for frame in container.decode(audio=stream.index):
            resampled = resampler.resample(frame)
            if resampled is None:
                continue

            frame_list = resampled if isinstance(resampled, list) else [resampled]
            for audio_frame in frame_list:
                arr = audio_frame.to_ndarray()
                if arr is None or arr.size == 0:
                    continue

                if arr.ndim == 1:
                    arr = arr[None, :]
                elif arr.ndim == 2 and arr.shape[0] > arr.shape[1] and arr.shape[1] <= 8:
                    arr = arr.T

                chunks.append(arr.astype(np.float32, copy=False))

        if not chunks:
            raise ValueError(f"Could not decode audio samples: {file_path}")

        waveform_np = np.concatenate(chunks, axis=1)
        waveform = torch.from_numpy(waveform_np).unsqueeze(0).contiguous()
        return waveform, sample_rate
    finally:
        container.close()


def _trim_waveform(
    waveform: torch.Tensor,
    sample_rate: int,
    in_point: float,
    out_point: float,
) -> tuple[torch.Tensor, float]:
    total_samples = waveform.shape[-1]

    start_seconds = max(0.0, float(in_point or 0.0))
    end_seconds = float(out_point or 0.0)

    start_sample = min(total_samples, int(start_seconds * sample_rate))

    if end_seconds <= 0.0:
        end_sample = total_samples
    else:
        end_sample = min(total_samples, int(end_seconds * sample_rate))

    if end_sample < start_sample:
        end_sample = start_sample

    trimmed_sample_count = max(0, end_sample - start_sample)
    trimmed_duration = float(trimmed_sample_count) / float(sample_rate) if sample_rate > 0 else 0.0

    trimmed = waveform[:, :, start_sample:end_sample]
    if trimmed.shape[-1] == 0:
        trimmed = torch.zeros(
            (waveform.shape[0], waveform.shape[1], 1),
            dtype=waveform.dtype,
            device=waveform.device,
        )
    return trimmed, trimmed_duration


class LoadAudioPlus:
    """
    Audio loader with file browser, input/output folder switching, and clip trim points.
    """

    @classmethod
    def INPUT_TYPES(cls):
        files = _list_audio_files(folder_paths.get_input_directory())

        return {
            "required": {
                "source_folder": (["input", "output"], {
                    "default": "input",
                    "tooltip": "Browse files from the input or output folder"
                }),
                "audio": (files, {
                    "tooltip": "Audio file to load"
                }),
                "in_point": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "step": 0.01,
                    "tooltip": "Clip start in seconds"
                }),
                "out_point": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "step": 0.01,
                    "tooltip": "Clip end in seconds (0 = full length)"
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "Audio loader with file browser, in/out trim points, and trimmed duration output."
    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration")
    FUNCTION = "load"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def load(self, audio="", source_folder="input", in_point=0.0, out_point=0.0, unique_id=None):
        if not audio or audio == "(none)":
            raise ValueError("No audio file selected. Please choose an audio file.")

        file_path, annotated_type = _parse_annotated_path(audio)
        if annotated_type:
            source_folder = annotated_type

        resolved_path = _resolve_audio_path(file_path, source_folder)
        if not resolved_path:
            raise FileNotFoundError(f"Audio file not found: {file_path}")

        waveform, sample_rate = _decode_audio_waveform(resolved_path)
        trimmed, trimmed_duration = _trim_waveform(waveform, sample_rate, in_point, out_point)

        return ({"waveform": trimmed, "sample_rate": sample_rate}, trimmed_duration)

    @classmethod
    def IS_CHANGED(cls, audio="", source_folder="input", in_point=0.0, out_point=0.0, **kwargs):
        if not audio or audio == "(none)":
            return ("", source_folder, in_point, out_point)

        file_path, annotated_type = _parse_annotated_path(audio)
        if annotated_type:
            source_folder = annotated_type

        resolved_path = _resolve_audio_path(file_path, source_folder)
        if resolved_path and os.path.exists(resolved_path):
            return (os.path.getmtime(resolved_path), source_folder, in_point, out_point)

        return ("", source_folder, in_point, out_point)