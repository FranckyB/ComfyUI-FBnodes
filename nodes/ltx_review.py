"""
LTX Review node

Pauses execution to let the user review an LTX video pass before continuing.
"""

from __future__ import annotations

import os
import re
import shutil
import json
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


def _first(value):
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _extract_latent_samples(latent: dict, label: str) -> torch.Tensor:
    if not isinstance(latent, dict):
        raise TypeError(f"{label} latent must be a dict")
    samples = latent.get("samples")
    if samples is None or not torch.is_tensor(samples):
        raise ValueError(f"{label} latent is missing tensor key 'samples'")
    return samples


def _decode_video_images(video_latent: dict, video_vae) -> torch.Tensor:
    samples = _extract_latent_samples(video_latent, "Video")
    decoded = video_vae.decode(samples)
    if not torch.is_tensor(decoded):
        raise ValueError("Video VAE decode did not return a tensor")

    # Normalize to image sequence [frames, H, W, C] for encoding.
    if decoded.ndim == 5:
        # Common layouts: [B, T, H, W, C] or [B, C, T, H, W].
        if decoded.shape[-1] in (1, 3, 4):
            decoded = decoded.reshape(-1, decoded.shape[2], decoded.shape[3], decoded.shape[4])
        elif decoded.shape[1] in (1, 3, 4):
            decoded = decoded.permute(0, 2, 3, 4, 1).reshape(-1, decoded.shape[3], decoded.shape[4], decoded.shape[1])
        else:
            raise ValueError(f"Unsupported decoded video tensor shape: {tuple(decoded.shape)}")
    elif decoded.ndim == 4:
        # [B, H, W, C] or [B, C, H, W]
        if decoded.shape[-1] in (1, 3, 4):
            decoded = decoded
        elif decoded.shape[1] in (1, 3, 4):
            decoded = decoded.permute(0, 2, 3, 1)
        else:
            raise ValueError(f"Unsupported decoded video tensor shape: {tuple(decoded.shape)}")
    else:
        raise ValueError(f"Unsupported decoded video tensor rank: {decoded.ndim}")

    return decoded[..., :3].clamp(0.0, 1.0)


def _decode_audio_waveform(audio_latent: dict, audio_vae) -> tuple[torch.Tensor, int]:
    samples = _extract_latent_samples(audio_latent, "Audio")
    if getattr(samples, "is_nested", False):
        samples = samples.unbind()[-1]

    if not hasattr(audio_vae, "decode"):
        raise ValueError("audio_vae is not decodable. Connect an LTXV Audio VAE Decode-compatible Audio VAE.")

    decoded = audio_vae.decode(samples)
    if not torch.is_tensor(decoded):
        raise ValueError("Audio VAE decode did not return a tensor")

    waveform = decoded.movedim(-1, 1)
    first_stage = getattr(audio_vae, "first_stage_model", None)
    sample_rate = int(getattr(first_stage, "output_sample_rate", 0) or 0)
    if sample_rate <= 0:
        raise ValueError("audio_vae is missing output sample rate. Use the LTXV Audio VAE model for audio decode.")
    return waveform, sample_rate


def _encode_h264_preview_from_decoded(
    images: torch.Tensor,
    audio_waveform: torch.Tensor | None,
    audio_sample_rate: int | None,
    fps: float,
    dst_path: str,
    metadata_dict: dict | None = None,
):
    frame_rate = float(fps) if float(fps) > 0 else 24.0
    rate = Fraction(round(frame_rate * 1000), 1000)

    if images.ndim != 4:
        raise ValueError(f"Expected decoded images as [frames,H,W,C], got shape {tuple(images.shape)}")

    height = int(images.shape[1])
    width = int(images.shape[2])

    # Use metadata tags in MP4 container so workflow/prompt survive in temp preview files.
    with av.open(dst_path, mode="w", format="mp4", options={"movflags": "use_metadata_tags"}) as dst:
        _apply_container_metadata(dst, metadata_dict)

        out_stream = dst.add_stream("libx264", rate=rate)
        out_stream.width = width
        out_stream.height = height
        out_stream.pix_fmt = "yuv420p"
        out_stream.options = {"crf": "23", "preset": "veryfast"}

        out_audio_stream = None
        if audio_waveform is not None and torch.is_tensor(audio_waveform):
            sr = int(audio_sample_rate or 0) or 44100
            out_audio_stream = dst.add_stream("aac", rate=sr)

        for frame_tensor in images:
            img = (frame_tensor[..., :3] * 255.0).clamp(0, 255).byte().cpu().numpy()
            frame = av.VideoFrame.from_ndarray(img, format="rgb24")
            frame = frame.reformat(format="yuv420p")
            for packet in out_stream.encode(frame):
                dst.mux(packet)

        for packet in out_stream.encode(None):
            dst.mux(packet)

        if out_audio_stream is not None and audio_waveform is not None:
            audio_tensor = audio_waveform
            if audio_tensor.ndim != 3:
                raise ValueError(f"Expected audio waveform as [batch,channels,samples], got shape {tuple(audio_tensor.shape)}")

            sr = int(audio_sample_rate or 0) or 44100
            max_audio_samples = math.ceil((sr / float(frame_rate)) * int(images.shape[0]))
            audio_tensor = audio_tensor[:, :, :max_audio_samples]

            channels = int(audio_tensor.shape[1])
            layout = "mono" if channels <= 1 else "stereo"
            frame = av.AudioFrame.from_ndarray(
                audio_tensor.movedim(2, 1).reshape(1, -1).float().cpu().numpy(),
                format="flt",
                layout=layout,
            )
            frame.sample_rate = sr
            frame.pts = 0
            for packet in out_audio_stream.encode(frame):
                dst.mux(packet)
            for packet in out_audio_stream.encode(None):
                dst.mux(packet)


def _temp_view_url(filename: str) -> str:
    return f"/view?{urlencode({'filename': filename, 'type': 'temp'})}"


def _apply_container_metadata(container, metadata_dict: dict | None):
    if not metadata_dict:
        return

    for key, value in metadata_dict.items():
        try:
            container.metadata[str(key)] = json.dumps(value) if not isinstance(value, str) else value
        except Exception:
            # Skip invalid metadata fields rather than failing preview generation.
            continue


def _build_review_metadata(extra_pnginfo) -> dict:
    metadata_dict = {}
    try:
        epi = extra_pnginfo
        if isinstance(epi, list):
            epi = epi[0] if epi else None
        if isinstance(epi, dict):
            # Keep metadata payload focused for drag/drop workflow reuse.
            if "workflow" in epi:
                metadata_dict["workflow"] = epi["workflow"]
            if "prompt" in epi:
                metadata_dict["prompt"] = epi["prompt"]
    except Exception:
        return {}

    return metadata_dict


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
    os.makedirs(temp_dir, exist_ok=True)
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
                "video_latent": ("LATENT", {"tooltip": "Video latent to pass through if you proceed."}),
                "audio_latent": ("LATENT", {"tooltip": "Audio latent to pass through if you proceed."}),
                "video_vae": ("VAE", {"tooltip": "Video VAE used to decode video_latent for review clip generation."}),
                "audio_vae": ("VAE", {"tooltip": "Audio VAE used by LTXV Audio VAE Decode behavior to decode audio_latent for review clip generation."}),
                "fps": ("FLOAT", {
                    "default": 24.0,
                    "min": 1.0,
                    "max": 240.0,
                    "step": 0.1,
                    "tooltip": "Frame rate used when encoding the review clip."
                }),
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
                "enable": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "When ON, run review flow and decode latents for preview. When OFF, pass through latents immediately and skip decoding."
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("LATENT", "LATENT", "STRING")
    RETURN_NAMES = ("video_latent", "audio_latent", "review_path")
    FUNCTION = "review"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Pause for user review of an LTX pass. Decodes video/audio latents with VAEs and generates review clip internally, then proceed/cancel while preserving latents."

    def review(self, video_latent, audio_latent, video_vae, audio_vae, fps=24.0, timeout=120, on_timeout="proceed", enable=True, unique_id=None, extra_pnginfo=None):
        review_metadata = _build_review_metadata(extra_pnginfo)

        origin_graph_id = ""
        try:
            epi = extra_pnginfo
            if isinstance(epi, list):
                epi = epi[0] if epi else None
            if isinstance(epi, dict):
                workflow = epi.get("workflow")
                if isinstance(workflow, dict):
                    origin_graph_id = str(workflow.get("id") or "").strip()
        except Exception:
            origin_graph_id = ""

        if not bool(enable):
            passthrough_path = ""
            ui = {
                "ltx_review_video_path": [passthrough_path],
            }
            return {"ui": ui, "result": (video_latent, audio_latent, passthrough_path)}

        review_video_url = None
        review_clip_path = ""

        try:
            decoded_images = _decode_video_images(video_latent, video_vae)
            decoded_audio, decoded_sample_rate = _decode_audio_waveform(audio_latent, audio_vae)
            review_clip_path = _build_temp_preview_path()
            _encode_h264_preview_from_decoded(
                decoded_images,
                decoded_audio,
                decoded_sample_rate,
                fps,
                review_clip_path,
                review_metadata,
            )
            review_video_url = _temp_view_url(os.path.basename(review_clip_path))
        except Exception as e:
            raise RuntimeError(f"LTXReview could not decode/encode review clip: {e}") from e

        request_id = str(uuid.uuid4())
        wait_event = threading.Event()

        with _REVIEW_LOCK:
            _PENDING_REVIEW_REQUESTS[request_id] = {
                "event": wait_event,
                "decision": None,
                "node_id": str(_first(unique_id) or ""),
                "graph_id": origin_graph_id,
                "video_path": review_clip_path,
            }

        display_path = str(review_clip_path or "").strip()
        if not display_path and review_clip_path:
            display_path = os.path.basename(review_clip_path)

        server.PromptServer.instance.send_sync("fbnodes.ltx_review.request", {
            "request_id": request_id,
            "node_id": str(_first(unique_id) or ""),
            "graph_id": origin_graph_id,
            "timeout": int(timeout),
            "video_url": review_video_url,
            "video_path": display_path,
            "source_type": "temp",
            "filename": os.path.basename(review_clip_path),
            "subfolder": "",
            "workflow_embedded": bool(review_metadata.get("workflow")),
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

        return {"ui": ui, "result": (video_latent, audio_latent, review_clip_path)}


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
    os.makedirs(temp_dir, exist_ok=True)
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
            return {
                "ui": {
                    "images": [],
                    "animated": (True,),
                },
                "result": (),
            }

        try:
            resolved_path = _resolve_existing_path(path_value)
            view_entry = _path_to_view_entry(resolved_path)
        except Exception as e:
            print(f"[LTXReviewPreview] Could not resolve review_path '{path_value}': {e}")
            return {
                "ui": {
                    "images": [],
                    "animated": (True,),
                },
                "result": (),
            }

        return {
            "ui": {
                "images": [view_entry],
                "animated": (True,),
            },
            "result": (),
        }
