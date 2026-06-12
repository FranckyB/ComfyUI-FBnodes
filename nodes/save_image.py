"""
Save Image+ Node
Save IMAGE tensors as PNG or JPG with date-token path expansion.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths
from comfy.cli_args import args


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


def _tensor_to_pil(image_tensor):
    """Convert a Comfy IMAGE tensor in [0,1] to a PIL image."""
    array = image_tensor.cpu().numpy()
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(array)


class SaveImagePlus:
    FORMATS = ["png", "jpg"]

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
                "format": (cls.FORMATS, {"default": "png"}),
                "jpg_quality": (
                    "INT",
                    {
                        "default": 95,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "tooltip": "JPEG quality. Ignored for PNG.",
                    },
                ),
            },
            "optional": {
                "Compare": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "FBnodes"
    DESCRIPTION = "Save images as PNG or JPG with date-token filename support."

    def save_images(self, images, filename_prefix, format, jpg_quality, Compare=None, prompt=None, extra_pnginfo=None):
        if images is None or len(images) == 0:
            return ("",)

        filename_prefix = _expand_date_format(filename_prefix)
        ext = "jpg" if format == "jpg" else "png"

        first = images[0]
        height = first.shape[0]
        width = first.shape[1]

        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix,
            folder_paths.get_output_directory(),
            width,
            height,
        )
        ui_subfolder = (subfolder or "").replace("\\", "/")

        ui_images = []
        compare_ui_images = []
        last_file = ""

        for image in images:
            pil_image = _tensor_to_pil(image)

            file_name = f"{filename}_{counter:05}.{ext}"
            file_path = os.path.join(full_output_folder, file_name)

            if ext == "png":
                pnginfo = None
                if not args.disable_metadata:
                    pnginfo = PngInfo()
                    if prompt is not None:
                        pnginfo.add_text("prompt", json.dumps(prompt))
                    if extra_pnginfo is not None:
                        for k, v in extra_pnginfo.items():
                            pnginfo.add_text(k, json.dumps(v))
                pil_image.save(file_path, pnginfo=pnginfo, compress_level=4)
            else:
                pil_image = pil_image.convert("RGB")
                pil_image.save(file_path, quality=int(jpg_quality), optimize=True)

            ui_images.append({
                "filename": file_name,
                "subfolder": ui_subfolder,
                "type": "output",
            })

            last_file = file_name
            counter += 1

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
