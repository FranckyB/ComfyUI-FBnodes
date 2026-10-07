"""
Save Image+ Node
Save IMAGE tensors with date-token path expansion and advanced image formats.
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
    DESCRIPTION = "Save PNG, EXR, or AVIF images with bit-depth, input color-space, and date-token filename support."

    def save_images(self, images, filename_prefix, save=True, Compare=None, prompt=None, extra_pnginfo=None,
                    format="png", bit_depth="8-bit", input_color_space="sRGB", crf=18):
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

        if save:
            full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                filename_prefix,
                folder_paths.get_output_directory(),
                width,
                height,
            )
            ui_subfolder = (subfolder or "").replace("\\", "/")
            output_type = "output"
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
