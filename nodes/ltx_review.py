"""
LTX Review node

Pauses execution to let the user review an LTX video pass before continuing.
"""

from __future__ import annotations

import os
import re
import shutil
import math
import threading
import uuid
from datetime import datetime
from fractions import Fraction
from urllib.parse import urlencode

from aiohttp import web
import av
import torch

import folder_paths
import server
from comfy.model_management import InterruptProcessingException


_REVIEW_LOCK = threading.Lock()
_PENDING_REVIEW_REQUESTS: dict[str, dict] = {}
_SAVE_VIDEO_PREVIEW_PREFIX = "Vids/%date:yy-MM-dd%/vid_%date:HH-mm-ss%"


def _normalize(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def _first(value):
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _resolve_video_info(video) -> dict:
    try:
        source = video.get_stream_source()
    except Exception:
        source = None

    path = source if isinstance(source, str) else ""
    if not path:
        return {"path": "", "url": None, "filename": "", "subfolder": "", "source_type": "", "display_path": ""}

    path_real = os.path.realpath(path)
    path_cmp = _normalize(path_real)

    roots = {
        "input": _normalize(folder_paths.get_input_directory()),
        "output": _normalize(folder_paths.get_output_directory()),
        "temp": _normalize(folder_paths.get_temp_directory()),
    }

    source_type = ""
    rel_path = None
    for root_type, root in roots.items():
        if path_cmp == root or path_cmp.startswith(root + os.sep):
            source_type = root_type
            rel_path = os.path.relpath(path_real, os.path.realpath(getattr(folder_paths, f"get_{root_type}_directory")()))
            break

    filename = ""
    subfolder = ""
    url = None
    if rel_path is not None:
        rel_norm = rel_path.replace("\\", "/")
        filename = os.path.basename(rel_norm)
        subfolder = os.path.dirname(rel_norm).replace("\\", "/")
        query = {
            "filename": filename,
            "type": source_type,
        }
        if subfolder:
            query["subfolder"] = subfolder
        url = f"/view?{urlencode(query)}"

    return {
        "path": path_real,
        "url": url,
        "filename": filename,
        "subfolder": subfolder,
        "source_type": source_type,
        "display_path": path_real,
    }


def _is_browser_compatible_file(video_path: str) -> bool:
    """
    Quick compatibility probe for browser playback.

    Conservative rule: HEVC/H265 or 4:2:2/4:4:4/10-bit-like formats are
    treated as not browser-compatible and get a generated preview.
    """
    try:
        with av.open(video_path) as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                return False

            codec_name = str(getattr(stream.codec_context, "name", "") or "").lower()
            pix_fmt = str(getattr(stream.codec_context, "pix_fmt", "") or "").lower()

            if codec_name in {"hevc", "h265"}:
                return False
            if "422" in pix_fmt or "444" in pix_fmt or "10" in pix_fmt:
                return False

            # h264/vp8/vp9/av1 + non-problematic pix fmt are usually browser-safe.
            if codec_name in {"h264", "vp8", "vp9", "av1"}:
                return True

            return False
    except Exception:
        return False


def _temp_view_url(filename: str) -> str:
    return f"/view?{urlencode({'filename': filename, 'type': 'temp'})}"


def _expand_date_format(text: str) -> str:
    def replace_date(match):
        fmt = match.group(1)
        now = datetime.now()
        fmt = fmt.replace("yyyy", "%Y").replace("yy", "%y")
        fmt = fmt.replace("MM", "%m").replace("dd", "%d")
        fmt = fmt.replace("HH", "%H").replace("hh", "%I")
        fmt = fmt.replace("mm", "%M").replace("ss", "%S")
        return now.strftime(fmt)

    return re.sub(r"%date:([^%]+)%", replace_date, text)


def _build_temp_preview_path() -> str:
    """
    Match SaveVideo+ preview naming behavior (save=False) with default prefix.
    """
    temp_dir = folder_paths.get_temp_directory()
    base_filename = os.path.basename(_expand_date_format(_SAVE_VIDEO_PREVIEW_PREFIX))
    if not base_filename:
        base_filename = "vid_preview"

    file = f"{base_filename}.mp4"
    file_path_test = os.path.join(temp_dir, file)
    if os.path.exists(file_path_test):
        pattern = re.compile(rf"^{re.escape(base_filename)}_?(\d+)\.mp4$")
        existing_counters = []
        for existing in os.listdir(temp_dir):
            match = pattern.match(existing)
            if match:
                existing_counters.append(int(match.group(1)))
        next_counter = max(existing_counters, default=0) + 1
        file = f"{base_filename}_{next_counter:05}.mp4"

    return os.path.join(temp_dir, file)


def _encode_h264_preview_from_file(src_path: str, dst_path: str):
    with av.open(src_path) as src, av.open(dst_path, mode="w", format="mp4") as dst:
        in_stream = next((s for s in src.streams if s.type == "video"), None)
        if in_stream is None:
            raise ValueError("No video stream available for preview transcode")

        in_audio_stream = next((s for s in src.streams if s.type == "audio"), None)

        rate = in_stream.average_rate if in_stream.average_rate is not None else Fraction(24, 1)
        out_stream = dst.add_stream("libx264", rate=rate)
        out_stream.width = int(getattr(in_stream, "width", 0) or 0)
        out_stream.height = int(getattr(in_stream, "height", 0) or 0)
        out_stream.pix_fmt = "yuv420p"
        out_stream.options = {"crf": "23", "preset": "veryfast"}

        out_audio_stream = None
        audio_resampler = None
        if in_audio_stream is not None:
            audio_rate = int(getattr(in_audio_stream, "rate", 0) or 0) or 44100
            out_audio_stream = dst.add_stream("aac", rate=audio_rate)
            audio_layout = None
            if getattr(in_audio_stream, "layout", None) is not None:
                audio_layout = in_audio_stream.layout.name
            if not audio_layout:
                channels = int(getattr(in_audio_stream, "channels", 0) or 0)
                audio_layout = "mono" if channels <= 1 else "stereo"

            audio_resampler = av.audio.resampler.AudioResampler(
                format="fltp",
                layout=audio_layout,
                rate=audio_rate,
            )

        for frame in src.decode(video=in_stream.index):
            frame = frame.reformat(format="yuv420p")
            for packet in out_stream.encode(frame):
                dst.mux(packet)

        for packet in out_stream.encode(None):
            dst.mux(packet)

        if in_audio_stream is not None and out_audio_stream is not None and audio_resampler is not None:
            for audio_frame in src.decode(audio=in_audio_stream.index):
                resampled = audio_resampler.resample(audio_frame)
                if resampled is None:
                    continue
                frame_list = resampled if isinstance(resampled, list) else [resampled]
                for frame in frame_list:
                    for packet in out_audio_stream.encode(frame):
                        dst.mux(packet)

            try:
                resampled_tail = audio_resampler.resample(None)
            except Exception:
                resampled_tail = None

            if resampled_tail is not None:
                tail_list = resampled_tail if isinstance(resampled_tail, list) else [resampled_tail]
                for frame in tail_list:
                    for packet in out_audio_stream.encode(frame):
                        dst.mux(packet)

            for packet in out_audio_stream.encode(None):
                dst.mux(packet)


def _encode_h264_preview_from_video_obj(video, dst_path: str):
    components = video.get_components()
    images = getattr(components, "images", None)
    if images is None or not torch.is_tensor(images) or images.ndim < 4:
        raise ValueError("VIDEO input does not provide tensor frames for preview generation")

    width, height = video.get_dimensions()
    frame_rate = float(getattr(components, "frame_rate", 0.0) or 24.0)
    rate = Fraction(round(frame_rate * 1000), 1000)

    with av.open(dst_path, mode="w", format="mp4") as dst:
        out_stream = dst.add_stream("libx264", rate=rate)
        out_stream.width = int(width)
        out_stream.height = int(height)
        out_stream.pix_fmt = "yuv420p"
        out_stream.options = {"crf": "23", "preset": "veryfast"}

        audio = getattr(components, "audio", None)
        out_audio_stream = None
        audio_sample_rate = 1
        if audio is not None:
            audio_sample_rate = int(audio.get("sample_rate", 0) or 0) or 44100
            out_audio_stream = dst.add_stream("aac", rate=audio_sample_rate)

        for frame_tensor in images:
            img = (frame_tensor[..., :3] * 255.0).clamp(0, 255).byte().cpu().numpy()
            frame = av.VideoFrame.from_ndarray(img, format="rgb24")
            frame = frame.reformat(format="yuv420p")
            for packet in out_stream.encode(frame):
                dst.mux(packet)

        for packet in out_stream.encode(None):
            dst.mux(packet)

        if out_audio_stream is not None and audio is not None:
            waveform = audio.get("waveform")
            if waveform is not None and torch.is_tensor(waveform):
                waveform = waveform[:, :, :math.ceil((audio_sample_rate / float(frame_rate)) * images.shape[0])]
                layout = "mono" if waveform.shape[1] == 1 else "stereo"
                frame = av.AudioFrame.from_ndarray(
                    waveform.movedim(2, 1).reshape(1, -1).float().cpu().numpy(),
                    format="flt",
                    layout=layout,
                )
                frame.sample_rate = audio_sample_rate
                frame.pts = 0
                for packet in out_audio_stream.encode(frame):
                    dst.mux(packet)
                for packet in out_audio_stream.encode(None):
                    dst.mux(packet)


def _resolve_review_video_url(video, info: dict) -> tuple[str | None, str]:
    # Use the original file URL when it's already browser-compatible.
    src_path = str(info.get("path") or "")
    src_url = info.get("url")
    if src_path and src_url and os.path.exists(src_path) and _is_browser_compatible_file(src_path):
        return src_url, src_path

    # Otherwise generate a temporary H.264/yuv420 preview clip.
    preview_path = _build_temp_preview_path()
    preview_name = os.path.basename(preview_path)

    if src_path and os.path.exists(src_path):
        _encode_h264_preview_from_file(src_path, preview_path)
    else:
        _encode_h264_preview_from_video_obj(video, preview_path)

    return _temp_view_url(preview_name), preview_path


@server.PromptServer.instance.routes.post("/fbnodes/ltx-review/decision")
async def ltx_review_decision(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

    request_id = body.get("request_id") if isinstance(body, dict) else None
    decision = body.get("decision") if isinstance(body, dict) else None

    if not request_id or not isinstance(request_id, str):
        return web.json_response({"ok": False, "error": "Missing request_id"}, status=400)
    if decision not in {"proceed", "cancel", "requeue"}:
        return web.json_response({"ok": False, "error": "Invalid decision"}, status=400)

    with _REVIEW_LOCK:
        item = _PENDING_REVIEW_REQUESTS.get(request_id)

    if item is None:
        return web.json_response({"ok": False, "error": "Request expired or not found"}, status=404)

    item["decision"] = decision
    item["event"].set()
    return web.json_response({"ok": True})


class LTXReview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO", {"tooltip": "Video to review before continuing."}),
                "video_latent": ("LATENT", {"tooltip": "Video latent to pass through if you proceed."}),
                "audio_latent": ("LATENT", {"tooltip": "Audio latent to pass through if you proceed."}),
                "timeout": ("INT", {
                    "default": 120,
                    "min": 1,
                    "max": 600,
                    "step": 1,
                    "tooltip": "Seconds to wait for user decision before timeout action."
                }),
                "on_timeout": (["proceed", "cancel"], {
                    "default": "proceed",
                    "tooltip": "Action used if no decision is received before timeout."
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("VIDEO", "LATENT", "LATENT", "STRING")
    RETURN_NAMES = ("video", "video_latent", "audio_latent", "review_path")
    FUNCTION = "review"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Pause for user review of an LTX video pass and then proceed or cancel while preserving video/audio latents."

    def review(self, video, video_latent, audio_latent, timeout=120, on_timeout="proceed", unique_id=None):
        info = _resolve_video_info(video)
        review_clip_path = str(info.get("path") or "")
        try:
            review_video_url, review_clip_path = _resolve_review_video_url(video, info)
        except Exception as e:
            print(f"[LTXReview] Could not build browser preview clip: {e}")
            review_video_url = info.get("url")
            review_clip_path = str(info.get("path") or "")

        request_id = str(uuid.uuid4())
        wait_event = threading.Event()

        with _REVIEW_LOCK:
            _PENDING_REVIEW_REQUESTS[request_id] = {
                "event": wait_event,
                "decision": None,
                "node_id": str(_first(unique_id) or ""),
                "video_path": info["path"],
            }

        display_path = (info.get("display_path") or info.get("path") or "").strip()
        if not display_path and review_clip_path:
            display_path = os.path.basename(review_clip_path)

        server.PromptServer.instance.send_sync("fbnodes.ltx_review.request", {
            "request_id": request_id,
            "node_id": str(_first(unique_id) or ""),
            "timeout": int(timeout),
            "video_url": review_video_url,
            "video_path": display_path,
            "source_type": info["source_type"],
            "filename": info["filename"],
            "subfolder": info["subfolder"],
        })

        signaled = wait_event.wait(timeout=float(timeout))

        with _REVIEW_LOCK:
            item = _PENDING_REVIEW_REQUESTS.pop(request_id, None)

        decision = ""
        if signaled and item is not None:
            decision = str(item.get("decision") or "")
        if decision not in {"proceed", "cancel", "requeue"}:
            decision = "cancel" if on_timeout == "cancel" else "proceed"

        if decision in {"cancel", "requeue"}:
            raise InterruptProcessingException()

        ui = {
            "ltx_review_decision": [decision],
            "ltx_review_video_path": [review_clip_path],
        }

        return {"ui": ui, "result": (video, video_latent, audio_latent, review_clip_path)}


def _parse_path_annotation(path_value: str) -> tuple[str, str | None]:
    match = re.match(r"^(.+?)\s*\[(input|output|temp)\]\s*$", path_value)
    if match:
        return match.group(1).strip(), match.group(2)
    return path_value.strip(), None


def _resolve_existing_path(path_value: str) -> str:
    file_path, annotated_type = _parse_path_annotation(path_value)

    if os.path.isabs(file_path):
        if os.path.exists(file_path):
            return os.path.realpath(file_path)
        raise FileNotFoundError(f"Video file not found: {file_path}")

    if annotated_type == "input":
        search_order = [folder_paths.get_input_directory()]
    elif annotated_type == "output":
        search_order = [folder_paths.get_output_directory()]
    elif annotated_type == "temp":
        search_order = [folder_paths.get_temp_directory()]
    else:
        search_order = [
            folder_paths.get_input_directory(),
            folder_paths.get_output_directory(),
            folder_paths.get_temp_directory(),
        ]

    for base_dir in search_order:
        candidate = os.path.join(base_dir, file_path)
        if os.path.exists(candidate):
            return os.path.realpath(candidate)

    raise FileNotFoundError(f"Video file not found: {file_path}")


def _path_to_view_entry(abs_path: str) -> dict:
    abs_real = os.path.realpath(abs_path)
    abs_cmp = os.path.normcase(abs_real)

    roots = [
        ("input", os.path.normcase(os.path.realpath(folder_paths.get_input_directory()))),
        ("output", os.path.normcase(os.path.realpath(folder_paths.get_output_directory()))),
        ("temp", os.path.normcase(os.path.realpath(folder_paths.get_temp_directory()))),
    ]

    for root_type, root in roots:
        if abs_cmp == root or abs_cmp.startswith(root + os.sep):
            rel_path = os.path.relpath(abs_real, os.path.realpath(getattr(folder_paths, f"get_{root_type}_directory")()))
            rel_norm = rel_path.replace("\\", "/")
            return {
                "filename": os.path.basename(rel_norm),
                "subfolder": os.path.dirname(rel_norm).replace("\\", "/"),
                "type": root_type,
            }

    # For out-of-tree paths, copy to temp so /view can load it reliably.
    temp_dir = folder_paths.get_temp_directory()
    base_name = os.path.basename(abs_real)
    stem, ext = os.path.splitext(base_name)
    if not ext:
        ext = ".mp4"

    target_name = f"{stem}{ext}"
    target_path = os.path.join(temp_dir, target_name)
    if os.path.exists(target_path):
        idx = 1
        while True:
            target_name = f"{stem}_{idx:05}{ext}"
            target_path = os.path.join(temp_dir, target_name)
            if not os.path.exists(target_path):
                break
            idx += 1

    shutil.copy2(abs_real, target_path)
    return {
        "filename": os.path.basename(target_path),
        "subfolder": "",
        "type": "temp",
    }


class LTXReviewPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "review_path": ("STRING", {
                    "default": "",
                    "forceInput": True,
                    "tooltip": "Path to a video file (absolute or relative with optional [input]/[output]/[temp])."
                }),
            },
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "preview"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = "Display a video from review_path input."

    def preview(self, review_path=""):
        if isinstance(review_path, (list, tuple)):
            review_path = review_path[0] if review_path else ""

        path_value = str(review_path or "").strip()
        if not path_value:
            raise ValueError("review_path input is empty")

        resolved_path = _resolve_existing_path(path_value)
        view_entry = _path_to_view_entry(resolved_path)

        return {
            "ui": {
                "images": [view_entry],
                "animated": (True,),
            },
            "result": (),
        }
