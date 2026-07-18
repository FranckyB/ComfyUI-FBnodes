"""
Save Video+ Node
A custom node that saves videos with H.264 or H.265 (HEVC) codec with quality control.
Based on ComfyUI's built-in SaveVideo node but with added H.265 codec and CRF quality options.
"""

from __future__ import annotations

import os
import re
import sys
import av
import json
import math
import torch
import hashlib
import safetensors.torch
from datetime import datetime
import folder_paths
import comfy.utils
from fractions import Fraction
from functools import lru_cache
import subprocess
from comfy.cli_args import args
from aiohttp import web

import server


def _get_cpu_encoder(codec: str) -> str:
    cpu_codec_map = {
        "h264": "libx264",
        "h265": "libx265",
    }
    return cpu_codec_map.get(codec, "libx264")


def _get_nvidia_encoder(codec: str) -> str:
    nvidia_codec_map = {
        "h264": "h264_nvenc",
        "h265": "hevc_nvenc",
    }
    return nvidia_codec_map.get(codec, "h264_nvenc")


def _log(message: str):
    print(f"[SaveVideoPlus] {message}")


def _latent_to_file_tensors(latent):
    """
    Convert a LATENT-style dict to a safetensors-compatible tensor dict.

    Preserves all top-level tensor keys (for richer formats like LTX), while
    also writing legacy keys expected by older loaders when possible.
    """
    if not isinstance(latent, dict):
        raise TypeError("Latent input must be a dict")

    tensor_payload = {}
    for key, value in latent.items():
        if isinstance(key, str) and torch.is_tensor(value):
            tensor_payload[key] = value

    if not tensor_payload:
        raise ValueError("Latent dict does not contain any top-level tensor fields")

    # Backward compatibility with legacy latent files/loaders.
    if "samples" in tensor_payload and "latent_tensor" not in tensor_payload:
        tensor_payload["latent_tensor"] = tensor_payload["samples"]

    # Some workflows provide valid LATENT dicts under nonstandard tensor keys.
    # Pick a stable primary tensor so saving does not fail unnecessarily.
    if "samples" not in tensor_payload and "latent_tensor" not in tensor_payload:
        preferred_keys = ("latents", "latent", "video_latent", "video", "z")
        primary_key = next((k for k in preferred_keys if k in tensor_payload), next(iter(tensor_payload)))
        tensor_payload["samples"] = tensor_payload[primary_key]
        tensor_payload["latent_tensor"] = tensor_payload[primary_key]
        _log(f"LATENT input missing 'samples'; using '{primary_key}' as primary latent tensor")

    if "latent_format_version_0" not in tensor_payload:
        tensor_payload["latent_format_version_0"] = torch.tensor([])

    return tensor_payload


def _latent_from_file_tensors(latent_data):
    """
    Decode safetensors latent payload into a LATENT-style dict.

    - Supports legacy files with latent_tensor.
    - Preserves additional tensor fields (e.g. LTX audio/video tensors).
    """
    if not isinstance(latent_data, dict):
        raise TypeError("Latent file payload must be a dict")

    multiplier = 1.0
    if "latent_format_version_0" not in latent_data:
        multiplier = 1.0 / 0.18215

    out = {}

    if torch.is_tensor(latent_data.get("samples")):
        out["samples"] = latent_data["samples"].float() * multiplier
    elif torch.is_tensor(latent_data.get("latent_tensor")):
        out["samples"] = latent_data["latent_tensor"].float() * multiplier
    else:
        raise KeyError("Latent file missing both 'samples' and 'latent_tensor'")

    reserved_keys = {"latent_tensor", "latent_format_version_0"}
    for key, value in latent_data.items():
        if key in reserved_keys:
            continue
        if key == "samples":
            continue
        if torch.is_tensor(value):
            out[key] = value

    return out


def _open_with_system_player(path: str):
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", path])
        return
    subprocess.Popen(["xdg-open", path])


@server.PromptServer.instance.routes.post("/fbnodes/open-in-player")
async def open_in_player(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

    path = data.get("path") if isinstance(data, dict) else None
    if not path or not isinstance(path, str):
        return web.json_response({"ok": False, "error": "Missing path"}, status=400)

    normalized = os.path.realpath(path)
    normalized_cmp = os.path.normcase(normalized)
    if not os.path.isfile(normalized):
        return web.json_response({"ok": False, "error": "File not found"}, status=404)

    allowed_roots = [
        os.path.normcase(os.path.realpath(folder_paths.get_input_directory())),
        os.path.normcase(os.path.realpath(folder_paths.get_output_directory())),
        os.path.normcase(os.path.realpath(folder_paths.get_temp_directory())),
    ]
    if not any(normalized_cmp.startswith(root + os.sep) or normalized_cmp == root for root in allowed_roots):
        return web.json_response({"ok": False, "error": "Path not allowed"}, status=403)

    try:
        _open_with_system_player(normalized)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@lru_cache(maxsize=2)
def _get_supported_nvenc_pix_fmts(codec: str) -> set[str]:
    encoder = _get_nvidia_encoder(codec)
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-h", f"encoder={encoder}"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode != 0:
            return set()

        # Typical format: "Supported pixel formats: yuv420p nv12 ..."
        match = re.search(r"Supported pixel formats:\s*(.+)", result.stdout)
        if not match:
            return set()

        return set(match.group(1).split())
    except Exception:
        return set()


def _get_pixel_format(chroma: str, is_10bit: bool, is_nvidia: bool, codec: str) -> str:
    if not is_nvidia:
        return f"{chroma}p" if not is_10bit else f"{chroma}p10le"

    supported = _get_supported_nvenc_pix_fmts(codec)

    # Preference order by chroma/bit-depth. Pick first actually supported by this NVENC build/device.
    if is_10bit:
        preferred = {
            "yuv420": ["p010le", "p016le", "yuv420p"],
            "yuv422": ["p210le", "p216le", "nv16", "p010le"],
            "yuv444": ["yuv444p10le", "yuv444p10msble", "yuv444p", "p010le"],
        }.get(chroma, ["p010le"])
    else:
        preferred = {
            "yuv420": ["yuv420p", "nv12"],
            "yuv422": ["nv16", "yuv420p"],
            "yuv444": ["yuv444p", "gbrp", "yuv420p"],
        }.get(chroma, ["yuv420p"])

    for pix_fmt in preferred:
        if not supported or pix_fmt in supported:
            return pix_fmt

    # Last-resort fallback when detection fails or device is restrictive.
    return "p010le" if is_10bit else "yuv420p"


@lru_cache(maxsize=2)
def _detect_nvidia_encoder(codec: str) -> tuple[str, bool]:
    """
    Detect if NVIDIA encoder is available for the given codec.
    Returns (codec_name, is_nvidia) tuple.
    
    Args:
        codec: "h264" or "h265"
    
    Returns:
        (codec_name, is_nvidia) - e.g., ("h264_nvenc", True) or ("libx264", False)
    """
    nvidia_codec_map = {
        "h264": "h264_nvenc",
        "h265": "hevc_nvenc",
    }
    
    nvidia_name = nvidia_codec_map.get(codec)
    cpu_name = _get_cpu_encoder(codec)
    
    if not nvidia_name:
        return (cpu_name, False)
    
    try:
        # Try to detect NVIDIA encoder by attempting to create a dummy context
        # This is a safe way to check without actually encoding
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if nvidia_name in result.stdout:
            print(f"[SaveVideoPlus] NVIDIA encoder detected: {nvidia_name}")
            return (nvidia_name, True)
    except Exception as e:
        print(f"[SaveVideoPlus] Could not detect NVIDIA encoder: {e}")
    
    # Fallback to CPU encoder
    return (cpu_name, False)


class SaveVideoPlus:
    """
    Save video with H.264 or H.265 codec and quality control.
    Takes VIDEO input (with audio support) and saves workflow metadata.
    Clone of ComfyUI's SaveVideo with H.265 and CRF quality control added.
    """

    CODECS = ["h264", "h265"]
    CHROMA_SUBSAMPLING = ["yuv420", "yuv422", "yuv444"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {"tooltip": "The video to save."}),
                "filename_prefix": ("STRING", {
                    "default": "Vids/%date:yy-MM-dd%/vid_%date:HH-mm-ss%",
                    "tooltip": "The prefix for the file to save.\nSupports %date:format% patterns."
                }),
                "codec": (cls.CODECS, {
                    "default": "h264",
                    "tooltip": "Video codec.\nh264 = 8-bit, better compatibility.\nh265/HEVC = 10-bit, better compression & gradients."
                }),
                "chroma": (cls.CHROMA_SUBSAMPLING, {
                    "default": "yuv420",
                    "tooltip": "Chroma subsampling.\nyuv420 = most compatible.\nyuv422 = better color for video editing.\nyuv444 = best color, no chroma loss.\n"
                }),
                "crf": ("INT", {
                    "default": 18,
                    "min": 0,
                    "max": 51,
                    "step": 1,
                    "tooltip": "Constant Rate Factor (quality).\nLower = better quality, larger file.\n0 = lossless\n18-23 = high quality\n28+ = lower quality.\nRecommended: 18-28."
                }),
                "save": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Save to output folder.\nOff = preview only (saves to temp with fast encoding)."
                }),
                "save_latent": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Save latent alongside the video.\nOff = don't save the connected latent."
                }),
                "browser_compat": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "When ON, non-browser-compatible clips get an auto-generated H.264 preview for UI playback.\nWhen OFF, UI uses the original file and may not preview in browser."
                }),
            },
            "optional": {
                "latent": ("LATENT", {"tooltip": "Optional latent to save alongside the video (same filename with .latent extension)."}),
                "metadata": ("STRING", {"forceInput": True, "tooltip": "Optional metadata JSON string to embed in the video (e.g. from VACE Stitcher)."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    FUNCTION = "save_video"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = "Saves video with H.264 or H.265 codec and quality control. Includes audio and workflow metadata."

    def save_video(self, video, filename_prefix, codec, chroma, crf, save, save_latent, browser_compat=True, latent=None, metadata=None, prompt=None, extra_pnginfo=None):
        # Expand %date:format% patterns (e.g., %date:yy-MM-dd_hh-mm%)
        # This mimics ComfyUI's frontend JS date expansion
        def expand_date_format(text):
            def replace_date(match):
                fmt = match.group(1)
                now = datetime.now()
                # Convert common date format tokens to Python strftime
                fmt = fmt.replace('yyyy', '%Y').replace('yy', '%y')
                fmt = fmt.replace('MM', '%m').replace('dd', '%d')
                fmt = fmt.replace('HH', '%H').replace('hh', '%I')
                fmt = fmt.replace('mm', '%M').replace('ss', '%S')
                return now.strftime(fmt)
            return re.sub(r'%date:([^%]+)%', replace_date, text)

        filename_prefix = expand_date_format(filename_prefix)

        # Bit depth determined by codec: h264=8-bit, h265=10-bit
        is_10bit = (codec == "h265")

        # Get video components (images, audio, frame_rate)
        components = video.get_components()
        images = components.images
        audio = components.audio
        frame_rate = components.frame_rate

        # Get dimensions
        width, height = video.get_dimensions()

        # Preview mode: save to temp with fast encoding
        if not save:
            temp_dir = folder_paths.get_temp_directory()
            # Use filename without subfolders, add counter if needed
            base_filename = os.path.basename(expand_date_format(filename_prefix))
            file = f"{base_filename}.mp4"
            file_path_test = os.path.join(temp_dir, file)
            if os.path.exists(file_path_test):
                # Find next available counter
                pattern = re.compile(rf"^{re.escape(base_filename)}_?(\d+)\.mp4$")
                existing_counters = []
                for f in os.listdir(temp_dir):
                    match = pattern.match(f)
                    if match:
                        existing_counters.append(int(match.group(1)))
                next_counter = max(existing_counters, default=0) + 1
                file = f"{base_filename}_{next_counter:05}.mp4"
            file_path = os.path.join(temp_dir, file)
            subfolder = ""
            output_type = "temp"
            # Override to fast settings for preview
            codec = "h264"
            codec_name, is_nvidia_preview = _detect_nvidia_encoder("h264")
            is_10bit = False
            pixel_format = _get_pixel_format("yuv420", is_10bit, is_nvidia_preview, codec)
            crf = 23
            preset = "fast" if is_nvidia_preview else "veryfast"
            is_nvidia = is_nvidia_preview
        else:
            output_type = "output"
            codec_name, is_nvidia = _detect_nvidia_encoder(codec)
            preset = "fast" if is_nvidia else "medium"
            pixel_format = _get_pixel_format(chroma, is_10bit, is_nvidia, codec)

            # Get output path
            full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
                filename_prefix,
                folder_paths.get_output_directory(),
                width,
                height
            )

            # Build filename - add counter only if file already exists
            file = f"{filename}.mp4"
            file_path_test = os.path.join(full_output_folder, file)
            if os.path.exists(file_path_test):
                # File exists, find next available counter
                pattern = re.compile(rf"^{re.escape(filename)}_?(\d+)\.mp4$")
                existing_counters = []
                if os.path.isdir(full_output_folder):
                    for f in os.listdir(full_output_folder):
                        match = pattern.match(f)
                        if match:
                            existing_counters.append(int(match.group(1)))
                # Start from 1 if no counters found, otherwise next available
                next_counter = max(existing_counters, default=0) + 1
                file = f"{filename}_{next_counter:05}.mp4"

            file_path = os.path.join(full_output_folder, file)

            # Save latent if connected and enabled (only when saving to output)
            if save_latent and latent is not None:
                latent_file = file_path.replace('.mp4', '.latent')
                # Prepare latent metadata
                prompt_info = json.dumps(prompt) if prompt else ""
                latent_metadata = {"prompt": prompt_info}
                if extra_pnginfo:
                    for x in extra_pnginfo:
                        latent_metadata[x] = json.dumps(extra_pnginfo[x])
                # Save the latent
                latent_output = _latent_to_file_tensors(latent)
                if os.path.exists(latent_file):
                    os.remove(latent_file)
                comfy.utils.save_torch_file(latent_output, latent_file, metadata=latent_metadata)

        # Build metadata dict for MP4 container
        metadata_dict = {}
        if not args.disable_metadata:
            if metadata is not None:
                # Connected metadata replaces the default workflow/prompt metadata
                try:
                    parsed = json.loads(metadata)
                    if isinstance(parsed, dict):
                        metadata_dict.update(parsed)
                except (json.JSONDecodeError, TypeError):
                    pass
            else:
                if extra_pnginfo is not None:
                    metadata_dict.update(extra_pnginfo)
                if prompt is not None:
                    metadata_dict["prompt"] = prompt

        # Prepare frame rate as fraction
        frame_rate_frac = Fraction(round(float(frame_rate) * 1000), 1000)

        def _encode_video_to_path(target_path: str, selected_codec_name: str, selected_is_nvidia: bool):
            selected_pixel_format = _get_pixel_format(chroma, is_10bit, selected_is_nvidia, codec)
            method = "nvidia" if selected_is_nvidia else "cpu"
            _log(
                f"Encoding video: method={method}, encoder={selected_codec_name}, pix_fmt={selected_pixel_format}, "
                f"codec={codec}, chroma={chroma}, path={target_path}"
            )
            with av.open(target_path, mode='w', options={'movflags': 'use_metadata_tags'}) as output:
                # Add metadata
                if metadata_dict:
                    for key, value in metadata_dict.items():
                        output.metadata[key] = json.dumps(value) if not isinstance(value, str) else value

                # Create video stream
                video_stream = output.add_stream(selected_codec_name, rate=frame_rate_frac)
                video_stream.width = width
                video_stream.height = height
                video_stream.pix_fmt = selected_pixel_format

                # Set encoding options - different for NVIDIA vs CPU
                if selected_is_nvidia:
                    # NVIDIA encoder options
                    # Use cq/rc for wider compatibility across ffmpeg NVENC builds.
                    video_stream.options = {
                        'cq': str(crf),
                        'rc': 'vbr',
                    }
                    if codec == "h265":
                        video_stream.options['tag'] = 'hvc1'
                else:
                    # CPU encoder options (libx264/libx265)
                    video_stream.options = {
                        'crf': str(crf),
                        'preset': preset,
                    }

                    # For H.265, add tag for Apple/browser compatibility
                    if codec == "h265":
                        video_stream.options['tag'] = 'hvc1'
                        video_stream.options['x265-params'] = 'log-level=error'

                # Create audio stream if audio is present
                audio_stream = None
                audio_sample_rate = 1
                if audio is not None:
                    audio_sample_rate = int(audio['sample_rate'])
                    audio_stream = output.add_stream('aac', rate=audio_sample_rate)

                # Encode video frames
                for frame_tensor in images:
                    if is_10bit:
                        # Convert tensor to 16-bit for 10-bit encoding
                        img = (frame_tensor[..., :3] * 65535).clamp(0, 65535).to(torch.int16).cpu().numpy().astype('uint16')
                        frame = av.VideoFrame.from_ndarray(img, format='rgb48le')
                    else:
                        # Convert tensor to 8-bit
                        img = (frame_tensor[..., :3] * 255).clamp(0, 255).byte().cpu().numpy()
                        frame = av.VideoFrame.from_ndarray(img, format='rgb24')

                    # IMPORTANT: Explicitly reformat frame to target pixel format
                    frame = frame.reformat(format=selected_pixel_format)

                    # Encode and mux
                    for packet in video_stream.encode(frame):
                        output.mux(packet)

                # Flush video encoder
                for packet in video_stream.encode(None):
                    output.mux(packet)

                # Encode audio if present
                if audio_stream is not None and audio is not None:
                    waveform = audio['waveform']
                    # Trim audio to match video duration
                    waveform = waveform[:, :, :math.ceil((audio_sample_rate / float(frame_rate)) * images.shape[0])]

                    # Create audio frame
                    layout = 'mono' if waveform.shape[1] == 1 else 'stereo'
                    frame = av.AudioFrame.from_ndarray(
                        waveform.movedim(2, 1).reshape(1, -1).float().numpy(),
                        format='flt',
                        layout=layout
                    )
                    frame.sample_rate = audio_sample_rate
                    frame.pts = 0

                    # Encode audio
                    for packet in audio_stream.encode(frame):
                        output.mux(packet)

                    # Flush audio encoder
                    for packet in audio_stream.encode(None):
                        output.mux(packet)

        try:
            _encode_video_to_path(file_path, codec_name, is_nvidia)
        except Exception as e:
            if is_nvidia:
                fallback_codec = _get_cpu_encoder(codec)
                print(f"[SaveVideoPlus] NVIDIA encoder failed ({e}). Falling back to {fallback_codec}.")
                _encode_video_to_path(file_path, fallback_codec, False)
            else:
                raise

        # h265 + yuv422/444 won't play in browser, so generate a browser-compatible preview in temp
        if not save or codec == "h264" or (codec == "h265" and chroma == "yuv420"):
            # Browser can play this directly (or it's already a preview)
            return {
                "ui": {
                    "images": [{"filename": file, "subfolder": subfolder, "type": output_type}],
                    "animated": (True,),
                    "saved_video_path": (file_path,),
                    "needs_external_player": (False,),
                },
                "result": (file_path,),
            }
        elif not browser_compat:
            # Respect user choice and do not generate a browser-compatible transcode.
            return {
                "ui": {
                    "images": [{"filename": file, "subfolder": subfolder, "type": output_type}],
                    "animated": (True,),
                    "saved_video_path": (file_path,),
                    "needs_external_player": (True,),
                },
                "result": (file_path,),
            }
        else:
            # Create a browser-compatible h264 preview in temp folder
            temp_dir = folder_paths.get_temp_directory()
            preview_file = os.path.basename(file)
            # preview_file = f"preview_{counter:05}_{width}x{height}.mp4"
            preview_path = os.path.join(temp_dir, preview_file)

            # Use NVIDIA encoder for preview if available
            preview_codec, preview_is_nvidia = _detect_nvidia_encoder("h264")

            def _transcode_preview_from_file(source_path: str, target_path: str, selected_codec_name: str, selected_is_nvidia: bool):
                method = "nvidia" if selected_is_nvidia else "cpu"
                _log(
                    f"Transcoding preview from encoded file (PyAV): method={method}, encoder={selected_codec_name}, "
                    f"source={source_path}, target={target_path}"
                )

                with av.open(source_path) as source, av.open(target_path, mode='w', format='mp4') as output:
                    src_video = next((s for s in source.streams if s.type == 'video'), None)
                    if src_video is None:
                        raise RuntimeError("Source file has no video stream")

                    src_rate = src_video.average_rate if src_video.average_rate is not None else frame_rate_frac
                    out_video = output.add_stream(selected_codec_name, rate=src_rate)
                    out_video.width = int(getattr(src_video, 'width', 0) or width)
                    out_video.height = int(getattr(src_video, 'height', 0) or height)
                    out_video.pix_fmt = 'yuv420p'

                    if selected_is_nvidia:
                        out_video.options = {'cq': '23', 'rc': 'vbr'}
                    else:
                        out_video.options = {'crf': '23', 'preset': 'fast'}

                    src_audio = next((s for s in source.streams if s.type == 'audio'), None)
                    out_audio = None
                    resampler = None
                    if src_audio is not None:
                        sample_rate = int(getattr(src_audio, 'rate', 0) or 44100)
                        channels = int(getattr(src_audio, 'channels', 0) or 2)
                        layout = 'mono' if channels <= 1 else 'stereo'
                        out_audio = output.add_stream('aac', rate=sample_rate)
                        resampler = av.audio.resampler.AudioResampler(
                            format='fltp',
                            layout=layout,
                            rate=sample_rate,
                        )

                    # PyAV decode(video=...) expects the Nth video stream (0-based),
                    # not the container-wide stream index. 
                    for frame in source.decode(video=0):
                        frame = frame.reformat(format='yuv420p')
                        for packet in out_video.encode(frame):
                            output.mux(packet)

                    for packet in out_video.encode(None):
                        output.mux(packet)

                    if src_audio is not None and out_audio is not None:
                        for frame in source.decode(audio=0):
                            converted = resampler.resample(frame) if resampler is not None else frame
                            frames = converted if isinstance(converted, list) else [converted]
                            for audio_frame in frames:
                                if audio_frame is None:
                                    continue
                                for packet in out_audio.encode(audio_frame):
                                    output.mux(packet)

                        if resampler is not None:
                            try:
                                tail = resampler.resample(None)
                            except Exception:
                                tail = None
                            if tail is not None:
                                tail_frames = tail if isinstance(tail, list) else [tail]
                                for audio_frame in tail_frames:
                                    if audio_frame is None:
                                        continue
                                    for packet in out_audio.encode(audio_frame):
                                        output.mux(packet)

                        for packet in out_audio.encode(None):
                            output.mux(packet)

            def _encode_preview_to_path(target_path: str, selected_codec_name: str, selected_is_nvidia: bool):
                method = "nvidia" if selected_is_nvidia else "cpu"
                _log(f"Encoding preview: method={method}, encoder={selected_codec_name}, path={target_path}")
                with av.open(target_path, mode='w', format='mp4') as preview_output:
                    preview_stream = preview_output.add_stream(selected_codec_name, rate=frame_rate)
                    preview_stream.width = width
                    preview_stream.height = height
                    preview_stream.pix_fmt = 'yuv420p'

                    # Set preview encoding options
                    if selected_is_nvidia:
                        preview_stream.options = {'cq': '23', 'rc': 'vbr'}
                    else:
                        preview_stream.options = {'crf': '23', 'preset': 'fast'}

                    # Add audio stream if we have audio
                    preview_audio_stream = None
                    if audio is not None:
                        preview_audio_stream = preview_output.add_stream('aac', rate=int(audio['sample_rate']))

                    for img_tensor in images:
                        frame_np = (img_tensor[..., :3] * 255).clamp(0, 255).byte().cpu().numpy()
                        frame = av.VideoFrame.from_ndarray(frame_np, format='rgb24')
                        frame = frame.reformat(format='yuv420p')
                        for packet in preview_stream.encode(frame):
                            preview_output.mux(packet)

                    for packet in preview_stream.encode(None):
                        preview_output.mux(packet)

                    # Encode audio for preview
                    if audio is not None and preview_audio_stream is not None:
                        waveform = audio['waveform']
                        preview_sample_rate = int(audio['sample_rate'])
                        # Trim audio to match video duration
                        waveform = waveform[:, :, :math.ceil((preview_sample_rate / float(frame_rate)) * images.shape[0])]

                        layout = 'mono' if waveform.shape[1] == 1 else 'stereo'
                        frame = av.AudioFrame.from_ndarray(
                            waveform.movedim(2, 1).reshape(1, -1).float().numpy(),
                            format='flt',
                            layout=layout
                        )
                        frame.sample_rate = preview_sample_rate
                        frame.pts = 0
                        for packet in preview_audio_stream.encode(frame):
                            preview_output.mux(packet)
                        for packet in preview_audio_stream.encode(None):
                            preview_output.mux(packet)

            try:
                _transcode_preview_from_file(file_path, preview_path, preview_codec, preview_is_nvidia)
            except Exception as e:
                if preview_is_nvidia:
                    print(f"[SaveVideoPlus] NVIDIA preview transcode failed ({e}). Falling back to libx264.")
                    try:
                        _transcode_preview_from_file(file_path, preview_path, 'libx264', False)
                    except Exception as e2:
                        print(f"[SaveVideoPlus] libx264 preview transcode failed ({e2}). Falling back to tensor encode.")
                        _encode_preview_to_path(preview_path, 'libx264', False)
                else:
                    print(f"[SaveVideoPlus] Preview transcode failed ({e}). Falling back to tensor encode.")
                    _encode_preview_to_path(preview_path, 'libx264', False)

            return {
                "ui": {
                    "images": [{"filename": preview_file, "subfolder": "", "type": "temp"}],
                    "animated": (True,),
                    "saved_video_path": (file_path,),
                    "needs_external_player": (False,),
                },
                "result": (file_path,),
            }


class LoadLatentFile:
    """
    Load a latent from a file path.
    Companion to SaveVideoPlus for loading latents saved alongside videos.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {
                    "default": "",
                    "tooltip": "Path to the .latent file to load."
                })
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "load"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load a latent from a file. Use with Save Video+ to reload saved latents."

    def load(self, file_path):
        if not file_path or not os.path.exists(file_path):
            raise FileNotFoundError(f"Latent file not found: {file_path}")

        # Load the latent file
        latent = safetensors.torch.load_file(file_path, device="cpu")

        samples = _latent_from_file_tensors(latent)
        return (samples,)


class LoadLTXLatentFile:
    """
    Load a latent from a file, preserving additional tensor fields used by LTX
    workflows (e.g. separate audio/video latent tensors).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {
                    "default": "",
                    "tooltip": "Path to the .latent file to load. Supports LTX-style latent payloads."
                })
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "load"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load an LTX latent from a file, preserving extra latent tensors (audio/video)."

    def load(self, file_path):
        if not file_path or not os.path.exists(file_path):
            raise FileNotFoundError(f"Latent file not found: {file_path}")

        latent_data = safetensors.torch.load_file(file_path, device="cpu")
        return (_latent_from_file_tensors(latent_data),)

    @classmethod
    def IS_CHANGED(cls, file_path):
        if not file_path or not os.path.exists(file_path):
            return ""
        m = hashlib.sha256()
        with open(file_path, 'rb') as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, file_path):
        if not file_path:
            return True
        if not os.path.exists(file_path):
            return f"Latent file not found: {file_path}"
        return True

    @classmethod
    def IS_CHANGED(cls, file_path):
        """Return hash of file to detect changes."""
        if not file_path or not os.path.exists(file_path):
            return ""
        m = hashlib.sha256()
        with open(file_path, 'rb') as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, file_path):
        if not file_path:
            return True  # Empty is valid (will error at runtime)
        if not os.path.exists(file_path):
            return f"Latent file not found: {file_path}"
        return True


class MonoToStereo:
    """
    Convert mono audio to stereo by duplicating the channel.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {"tooltip": "Mono audio input to convert to stereo."}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "convert"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Convert mono audio to stereo by duplicating the single channel to left and right."

    def convert(self, audio):
        waveform = audio['waveform']
        sample_rate = audio['sample_rate']

        # Check if already stereo (or more)
        if waveform.shape[1] >= 2:
            # Already stereo, return as-is
            return (audio,)

        # Duplicate mono channel to create stereo: (batch, 1, samples) -> (batch, 2, samples)
        stereo_waveform = waveform.repeat(1, 2, 1)

        return ({"waveform": stereo_waveform, "sample_rate": sample_rate},)


class GetVideoComponentsPlus:
    """
    Efficient video inspection/extraction node.

    By default this node only probes metadata and returns placeholders for heavy outputs,
    so it does not decode the full video into memory unless explicitly requested.
    """

    IMAGE_OUTPUT_INDEX = 0
    AUDIO_OUTPUT_INDEX = 1
    LATENT_OUTPUT_INDEX = 4
    IMAGE_CHUNK_SIZE = 128

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {"tooltip": "The video to extract components from."}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "STRING", "LATENT", "INT", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("images", "audio", "fps", "filepath", "latent", "width", "height", "frame_count", "duration")
    FUNCTION = "get_components"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Extract metadata and auto-decode images/audio only when those outputs are connected."

    @staticmethod
    def _empty_image():
        return torch.zeros((1, 1, 1, 3), dtype=torch.float32)

    @staticmethod
    def _get_video_path(video) -> str:
        try:
            source = video.get_stream_source()
            if isinstance(source, str):
                return source
        except Exception as e:
            print(f"[GetVideoComponentsPlus] Could not get video path: {e}")
        return ""

    @staticmethod
    def _load_matching_latent(video_path: str):
        latent = None
        if video_path and os.path.exists(video_path):
            latent_path = os.path.splitext(video_path)[0] + '.latent'
            if os.path.exists(latent_path):
                try:
                    latent_data = safetensors.torch.load_file(latent_path, device="cpu")
                    latent = _latent_from_file_tensors(latent_data)
                except Exception as e:
                    print(f"[GetVideoComponentsPlus] Could not load latent file: {e}")
        return latent

    @staticmethod
    def _probe_video_metadata(video, video_path: str, trim_in: float = 0.0, trim_out: float = 0.0):
        fps = 0.0
        width = 0
        height = 0
        frame_count = 0
        duration = 0.0

        if video_path and os.path.exists(video_path):
            try:
                with av.open(video_path) as container:
                    stream = next((s for s in container.streams if s.type == "video"), None)
                    if stream is not None:
                        if stream.average_rate is not None:
                            fps = float(stream.average_rate)
                        width = int(getattr(stream, "width", 0) or 0)
                        height = int(getattr(stream, "height", 0) or 0)
                        frame_count = int(getattr(stream, "frames", 0) or 0)

                        if stream.duration is not None and stream.time_base is not None:
                            duration = float(stream.duration * stream.time_base)
                        elif container.duration is not None:
                            duration = float(container.duration) / float(av.time_base)

                        if frame_count <= 0 and fps > 0.0 and duration > 0.0:
                            frame_count = int(round(duration * fps))
            except Exception as e:
                print(f"[GetVideoComponentsPlus] Metadata probe failed: {e}")

        if duration > 0.0:
            clip_start = max(0.0, float(trim_in or 0.0))
            clip_end = float(trim_out or 0.0)
            if clip_end > clip_start:
                duration = max(0.0, min(duration, clip_end) - clip_start)
            elif clip_start > 0.0:
                duration = max(0.0, duration - clip_start)

            if fps > 0.0:
                frame_count = int(round(duration * fps))

        if (width <= 0 or height <= 0) and video is not None:
            try:
                dims = video.get_dimensions()
                if isinstance(dims, (tuple, list)) and len(dims) >= 2:
                    width = int(dims[0])
                    height = int(dims[1])
            except Exception:
                pass

        return fps, width, height, frame_count, duration

    @staticmethod
    def _decode_images_chunked(video_path: str, chunk_size: int, trim_in: float = 0.0, trim_out: float = 0.0):
        import numpy as np

        chunks = []
        frame_buffer = []
        decoded_frames = 0

        with av.open(video_path) as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                return GetVideoComponentsPlus._empty_image(), 0

            for frame in container.decode(video=stream.index):
                if frame.pts is not None and frame.time_base is not None:
                    t = float(frame.pts * frame.time_base)
                    if t < trim_in:
                        continue
                    if trim_out > trim_in and t >= trim_out:
                        break

                arr = frame.to_ndarray(format="rgb24")
                tensor = torch.from_numpy(arr.astype(np.float32, copy=False) / 255.0)
                frame_buffer.append(tensor)
                decoded_frames += 1

                if len(frame_buffer) >= chunk_size:
                    chunks.append(torch.stack(frame_buffer, dim=0))
                    frame_buffer = []

        if frame_buffer:
            chunks.append(torch.stack(frame_buffer, dim=0))

        if not chunks:
            return GetVideoComponentsPlus._empty_image(), 0

        return torch.cat(chunks, dim=0), decoded_frames

    @staticmethod
    def _decode_audio(video_path: str, trim_in: float = 0.0, trim_out: float = 0.0):
        import numpy as np

        with av.open(video_path) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                return None

            sample_rate = int(getattr(stream, "rate", 0) or 0)
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

            chunks = []
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

            # Flush any buffered samples from resampler state.
            try:
                resampled_tail = resampler.resample(None)
            except Exception:
                resampled_tail = None

            if resampled_tail is not None:
                tail_list = resampled_tail if isinstance(resampled_tail, list) else [resampled_tail]
                for audio_frame in tail_list:
                    arr = audio_frame.to_ndarray()
                    if arr is None or arr.size == 0:
                        continue

                    if arr.ndim == 1:
                        arr = arr[None, :]
                    elif arr.ndim == 2 and arr.shape[0] > arr.shape[1] and arr.shape[1] <= 8:
                        arr = arr.T

                    chunks.append(arr.astype(np.float32, copy=False))

        if not chunks:
            return None

        waveform_np = np.concatenate(chunks, axis=1)
        start_sample = int(max(0.0, float(trim_in or 0.0)) * sample_rate)
        end_sample = waveform_np.shape[1]
        if trim_out > trim_in:
            end_sample = min(end_sample, int(float(trim_out) * sample_rate))
        end_sample = max(start_sample, end_sample)
        waveform_np = waveform_np[:, start_sample:end_sample]
        if waveform_np.shape[1] == 0:
            waveform_np = np.zeros((waveform_np.shape[0], 1), dtype=np.float32)

        waveform = torch.from_numpy(waveform_np).unsqueeze(0).contiguous()
        return {"waveform": waveform, "sample_rate": sample_rate}

    @staticmethod
    def _is_output_connected(prompt, unique_id, output_index: int) -> bool:
        if prompt is None or unique_id is None:
            return True

        try:
            uid = str(unique_id)
            for node_data in prompt.values():
                if not isinstance(node_data, dict):
                    continue
                inputs = node_data.get("inputs", {})
                if not isinstance(inputs, dict):
                    continue
                for value in inputs.values():
                    if not isinstance(value, (list, tuple)) or len(value) < 2:
                        continue
                    src_id, src_output = value[0], value[1]
                    if str(src_id) != uid:
                        continue
                    try:
                        if int(src_output) == int(output_index):
                            return True
                    except Exception:
                        continue
        except Exception as e:
            print(f"[GetVideoComponentsPlus] Connection detection failed: {e}")
            return True

        return False

    @staticmethod
    def _get_trim_points(video):
        if video is None:
            return 0.0, 0.0
        getter = getattr(video, "get_trim_points", None)
        if getter is None:
            return 0.0, 0.0
        try:
            trim = getter()
            if isinstance(trim, (tuple, list)) and len(trim) >= 2:
                trim_in = max(0.0, float(trim[0] or 0.0))
                trim_out = max(0.0, float(trim[1] or 0.0))
                return trim_in, trim_out
        except Exception:
            pass
        return 0.0, 0.0

    def get_components(self, video, unique_id=None, prompt=None):
        if video is None:
            return (self._empty_image(), None, 0.0, "", None, 0, 0, 0, 0.0)

        video_path = self._get_video_path(video)
        trim_in, trim_out = self._get_trim_points(video)

        fps, width, height, frame_count, duration = self._probe_video_metadata(video, video_path, trim_in=trim_in, trim_out=trim_out)

        decode_images = self._is_output_connected(prompt, unique_id, self.IMAGE_OUTPUT_INDEX)
        decode_audio = self._is_output_connected(prompt, unique_id, self.AUDIO_OUTPUT_INDEX)
        load_latent = self._is_output_connected(prompt, unique_id, self.LATENT_OUTPUT_INDEX)

        latent = self._load_matching_latent(video_path) if load_latent else None

        images = self._empty_image()
        audio = None

        # Fast path: metadata only, no expensive decode.
        if not decode_images and not decode_audio:
            return (images, audio, fps, video_path, latent, width, height, frame_count, duration)

        # Prefer Comfy's VIDEO API first for reliability/compatibility.
        decoded_with_comfy = False
        try:
            components = video.get_components()
            fps = float(components.frame_rate)

            if decode_images:
                images = components.images
                frame_count = int(images.shape[0])

            if decode_audio:
                audio = components.audio

            if duration <= 0.0 and fps > 0.0 and frame_count > 0:
                duration = float(frame_count) / float(fps)

            decoded_with_comfy = True
        except Exception as e:
            print(f"[GetVideoComponentsPlus] Comfy VIDEO API failed, trying PyAV fallback: {e}")

        if not decoded_with_comfy and video_path and os.path.exists(video_path):
            try:
                if decode_images:
                    images, decoded_count = self._decode_images_chunked(
                        video_path,
                        self.IMAGE_CHUNK_SIZE,
                        trim_in=trim_in,
                        trim_out=trim_out,
                    )
                    frame_count = decoded_count or frame_count
                    if duration <= 0.0 and fps > 0.0 and decoded_count > 0:
                        duration = float(decoded_count) / float(fps)

                if decode_audio:
                    audio = self._decode_audio(video_path, trim_in=trim_in, trim_out=trim_out)

                if (decode_audio and audio is None) or (decode_images and int(frame_count or 0) <= 0):
                    raise RuntimeError("PyAV fallback returned incomplete components")
            except Exception as e:
                raise RuntimeError(f"Could not extract video components (Comfy + PyAV fallback failed): {e}") from e

        return (images, audio, fps, video_path, latent, width, height, frame_count, duration)
