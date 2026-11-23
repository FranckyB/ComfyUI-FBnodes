"""
Save Image+ Node
Save IMAGE tensors with date-token path expansion and advanced image formats.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime

import numpy as np
from aiohttp import web
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import comfy.model_management
import folder_paths
import server
from comfy.cli_args import args

try:
    from comfy_extras.nodes_images import _encode_image, _save_avif, inject_exr_metadata, inject_png_metadata
except ImportError:
    _encode_image = _save_avif = inject_exr_metadata = inject_png_metadata = None


IMAGE_FORMAT_OPTIONS = {
    "png": {"bit_depth": ["8-bit", "16-bit"], "input_color_space": ["sRGB"]},
    "exr": {"bit_depth": ["16-bit float", "32-bit float"], "input_color_space": ["sRGB", "HDR", "linear"]},
    "avif": {"bit_depth": ["auto", "8-bit YUV420", "10-bit YUV420"], "input_color_space": ["sRGB", "HDR", "HDR PQ"]},
}


def _expand_date_format(text: str) -> str:
    """Expand %date:...% patterns similarly to frontend path expansion."""

    def _replace_date(match):
        fmt = match.group(1)
        now = datetime.now()
        fmt = fmt.replace("yyyy", "%Y").replace("yy", "%y")
        fmt = fmt.replace("MM", "%m").replace("dd", "%d")
        fmt = fmt.replace("HH", "%H").replace("hh", "%I")
        fmt = fmt.replace("mm", "%M").replace("ss", "%S")
        return now.strftime(fmt)

    return re.sub(r"%date:([^%]+)%", _replace_date, text or "")


# Review before saving: the images wait in temp while the frontend shows them,
# and the picked ones move to the output folder. One entry per waiting node.
_REVIEW_LOCK = threading.Lock()
_PENDING_REVIEWS: dict[str, dict] = {}


@server.PromptServer.instance.routes.post("/fbnodes/save-image/review")
async def save_image_review(request):
    """Answer a pending review: save (with indices), skip, or pause / resume the timer."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)

    request_id = body.get("request_id")
    action = body.get("action")
    with _REVIEW_LOCK:
        item = _PENDING_REVIEWS.get(request_id)
        if item is None:
            return web.json_response({"ok": False, "error": "Review expired or not found"}, status=404)
        if action == "pause":
            item["deadline"] = None
        elif action == "resume":
            item["deadline"] = time.monotonic() + max(0.0, float(body.get("seconds") or 0))
        elif action == "save":
            count = item["count"]
            indices = body.get("indices")
            if not isinstance(indices, list) or not all(isinstance(i, int) and 0 <= i < count for i in indices):
                return web.json_response({"ok": False, "error": "Invalid indices"}, status=400)
            item["selected"] = sorted(set(indices))
            item["event"].set()
        elif action == "skip":
            item["selected"] = []
            item["event"].set()
        else:
            return web.json_response({"ok": False, "error": "Invalid action"}, status=400)
    return web.json_response({"ok": True})


def _wait_for_review(item) -> str:
    """Block until the frontend answers ("decided") or the timer runs out
    ("timeout"). A queue interrupt raises right away instead of waiting."""
    while not item["event"].wait(0.25):
        comfy.model_management.throw_exception_if_processing_interrupted()
        with _REVIEW_LOCK:
            deadline = item["deadline"]
        if deadline is not None and time.monotonic() >= deadline:
            return "timeout"
    return "decided"


def _tensor_to_pil(image_tensor):
    """Convert a Comfy IMAGE tensor in [0,1] to a PIL image."""
    array = image_tensor.cpu().numpy()
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(array)


class SaveImagePlus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": (
                    "STRING",
                    {
                        "default": "Pics/%date:yy-MM-dd%/img_%date:HH_mm_ss%",
                        "tooltip": "Output path prefix. Supports %date:format% patterns.",
                    },
                ),
                "save": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "When ON, save to output folder. When OFF, save preview images to temp using filename_prefix basename.",
                    },
                ),
            },
            "optional": {
                "Compare": ("IMAGE",),
                "format": (["png", "exr", "avif"], {"default": "png"}),
                "bit_depth": (
                    ["8-bit", "16-bit", "16-bit float", "32-bit float", "auto", "8-bit YUV420", "10-bit YUV420"],
                    {"default": "8-bit"},
                ),
                "input_color_space": (
                    ["sRGB", "HDR", "linear", "HDR PQ"],
                    {"default": "sRGB", "tooltip": "Input tensor color space. EXR is stored scene-linear; AVIF HDR uses BT.2020."},
                ),
                "crf": ("INT", {"default": 18, "min": 1, "max": 63, "tooltip": "AVIF quality. Lower values give higher quality and larger files."}),
                "review": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "When ON (and save is ON), the run pauses and shows the images: pick the ones to keep. They wait in temp and only the picked ones move to the output folder.",
                    },
                ),
                "review_timeout": (
                    "INT",
                    {"default": 60, "min": 0, "max": 3600, "tooltip": "Seconds to wait for your pick before on_timeout applies. 0 waits until you decide."},
                ),
                "on_timeout": (
                    ["save all", "skip all"],
                    {"default": "save all", "tooltip": "What happens to the images when the review timer runs out."},
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = "Save PNG, EXR, or AVIF images with bit-depth, input color-space, and date-token filename support."

    def save_images(self, images, filename_prefix, save=True, Compare=None, prompt=None, extra_pnginfo=None,
                    format="png", bit_depth="8-bit", input_color_space="sRGB", crf=18,
                    review=False, review_timeout=60, on_timeout="save all", unique_id=None):
        if images is None or len(images) == 0:
            return ("",)

        options = IMAGE_FORMAT_OPTIONS.get(format)
        if options is None or bit_depth not in options["bit_depth"] or input_color_space not in options["input_color_space"]:
            raise ValueError(f"Unsupported image settings: {format}, {bit_depth}, {input_color_space}")
        if (format != "png" or bit_depth != "8-bit") and _encode_image is None:
            raise RuntimeError("Advanced image saving requires a ComfyUI version with Save Image (Advanced).")

        filename_prefix = _expand_date_format(filename_prefix)
        ext = format

        first = images[0]
        height = first.shape[0]
        width = first.shape[1]

        # Reviewed images are written to temp first; the picked ones move to output.
        reviewing = bool(save and review)
        if save and not reviewing:
            full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                filename_prefix,
                folder_paths.get_output_directory(),
                width,
                height,
            )
            ui_subfolder = (subfolder or "").replace("\\", "/")
            output_type = "output"
            use_plain_basename = False
        elif reviewing:
            # Unique names while the images wait: the picked ones get their
            # output names when they move.
            full_output_folder = folder_paths.get_temp_directory()
            filename = f"fbnodes_review_{uuid.uuid4().hex[:12]}"
            counter = 0
            ui_subfolder = ""
            output_type = "temp"
            use_plain_basename = False
        else:
            full_output_folder = folder_paths.get_temp_directory()
            filename = os.path.basename(filename_prefix).strip() or "img"
            subfolder = ""
            ui_subfolder = ""
            output_type = "temp"

            plain_name = f"{filename}.{ext}"
            plain_path = os.path.join(full_output_folder, plain_name)
            base_exists = os.path.exists(plain_path)

            pattern = re.compile(rf"^{re.escape(filename)}_?(\d+)\.{re.escape(ext)}$")
            existing_counters = []
            for existing_file in os.listdir(full_output_folder):
                match = pattern.match(existing_file)
                if match:
                    existing_counters.append(int(match.group(1)))

            if base_exists:
                counter = max(existing_counters, default=0) + 1
            else:
                counter = max(existing_counters, default=0)

            use_plain_basename = not base_exists

        ui_images = []
        written_paths = []
        compare_ui_images = []
        last_file = ""

        for image in images:
            if format == "avif" and len(image.shape) == 3 and image.shape[-1] == 4:
                image = image[..., :3]
            if not save and use_plain_basename:
                file_name = f"{filename}.{ext}"
                use_plain_basename = False
                if len(images) > 1 and counter == 0:
                    counter = 1
            else:
                file_name = f"{filename}_{counter:05}.{ext}"
            file_path = os.path.join(full_output_folder, file_name)

            if format == "png" and bit_depth == "8-bit":
                pil_image = _tensor_to_pil(image)
                pnginfo = None
                if not args.disable_metadata:
                    pnginfo = PngInfo()
                    if prompt is not None:
                        pnginfo.add_text("prompt", json.dumps(prompt))
                    if extra_pnginfo is not None:
                        for key, value in extra_pnginfo.items():
                            pnginfo.add_text(key, json.dumps(value))
                pil_image.save(file_path, pnginfo=pnginfo, compress_level=4)
            elif format == "avif":
                metadata = None
                if not args.disable_metadata:
                    metadata = dict(extra_pnginfo or {})
                    if prompt is not None:
                        metadata["prompt"] = prompt
                _save_avif(image.unsqueeze(0), file_path, bit_depth, input_color_space, crf, metadata=metadata)
            else:
                encoded = _encode_image(image, format, bit_depth, input_color_space)
                if not args.disable_metadata:
                    if format == "png":
                        encoded = inject_png_metadata(encoded, prompt, extra_pnginfo)
                    else:
                        encoded = inject_exr_metadata(encoded, prompt, extra_pnginfo, input_color_space)
                with open(file_path, "wb") as output:
                    output.write(encoded)

            image_info = {
                "filename": file_name,
                "subfolder": ui_subfolder,
                "type": output_type,
            }
            if format in ("exr", "avif"):
                preview_name = f"fbnodes_preview_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.png"
                preview_path = os.path.join(folder_paths.get_temp_directory(), preview_name)
                _tensor_to_pil(image).save(preview_path, compress_level=4)
                image_info["preview"] = {"filename": preview_name, "subfolder": "", "type": "temp"}
            ui_images.append(image_info)
            written_paths.append(file_path)

            last_file = file_name
            counter += 1

        if reviewing:
            ui_images, last_file = self._review(
                ui_images, written_paths, filename_prefix, width, height, ext, review_timeout, on_timeout, unique_id
            )

        if Compare is not None and len(Compare) > 0:
            temp_dir = folder_paths.get_temp_directory()
            compare_prefix = f"fbnodes_compare_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"

            for index, compare_image in enumerate(Compare):
                compare_pil = _tensor_to_pil(compare_image)
                compare_name = f"{compare_prefix}_{index:05}.png"
                compare_path = os.path.join(temp_dir, compare_name)
                compare_pil.save(compare_path, compress_level=4)

                compare_ui_images.append({
                    "filename": compare_name,
                    "subfolder": "",
                    "type": "temp",
                })

        ui_payload = {
            "saved_images": ui_images,
            "compare_images": compare_ui_images,
            "compare_paired": [len(compare_ui_images) > 0 and len(compare_ui_images) == len(ui_images)],
        }
        return {"ui": ui_payload, "result": (last_file,)}

    def _review(self, ui_images, written_paths, filename_prefix, width, height, ext, review_timeout, on_timeout, unique_id):
        """Show the temp images in the frontend and move the picked ones to the
        output folder. Returns the node's ui images and the last saved name."""
        request_id = str(uuid.uuid4())
        timeout = max(0, int(review_timeout or 0))
        item = {
            "event": threading.Event(),
            "selected": None,
            "count": len(ui_images),
            "deadline": time.monotonic() + timeout if timeout > 0 else None,
        }
        with _REVIEW_LOCK:
            _PENDING_REVIEWS[request_id] = item

        outcome = "interrupted"
        try:
            server.PromptServer.instance.send_sync("fbnodes.save_image.review", {
                "request_id": request_id,
                "node_id": str(unique_id or ""),
                "timeout": timeout,
                "on_timeout": on_timeout,
                "images": ui_images,
            })
            outcome = _wait_for_review(item)
        finally:
            with _REVIEW_LOCK:
                _PENDING_REVIEWS.pop(request_id, None)
            server.PromptServer.instance.send_sync("fbnodes.save_image.review_done", {
                "request_id": request_id,
                "outcome": outcome,
            })

        if outcome == "decided":
            selected = item["selected"] or []
        else:
            selected = list(range(len(ui_images))) if on_timeout == "save all" else []
        if not selected:
            # Nothing kept: the node still shows what was made, from temp.
            return ui_images, ""

        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), width, height
        )
        saved = []
        last_file = ""
        for index in selected:
            file_name = f"{filename}_{counter:05}.{ext}"
            shutil.move(written_paths[index], os.path.join(full_output_folder, file_name))
            saved.append({**ui_images[index], "filename": file_name, "subfolder": (subfolder or "").replace("\\", "/"), "type": "output"})
            last_file = file_name
            counter += 1
        return saved, last_file
