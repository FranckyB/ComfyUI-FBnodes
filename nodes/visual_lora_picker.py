"""
Visual LoRA Picker - select a LoRA by its thumbnail image and append to a stack.
"""

from __future__ import annotations

import os

import folder_paths
import server
import torch

try:
    import numpy as np
    from PIL import Image
    IMAGE_SUPPORT = True
except ImportError:
    IMAGE_SUPPORT = False
    np = None
    Image = None

from ..py.lora_utils import LORA_EXTENSIONS


class VisualLoraPicker:
    """Pick a LoRA by selecting its thumbnail image in the LoRA folder."""

    NAME = "Visual LoRA Picker+"
    CATEGORY = "FBnodes"

    IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Selected LoRA file path. A matching thumbnail image with the same base name is shown when available.",
                    },
                ),
                "strength_model": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.01,
                        "tooltip": "Strength applied to this LoRA",
                    },
                ),
            },
            "optional": {
                "lora_stack": ("LORA_STACK",),
            },
        }

    RETURN_TYPES = ("LORA_STACK", "IMAGE")
    RETURN_NAMES = ("lora_stack", "image")
    FUNCTION = "pick_lora"
    DESCRIPTION = (
        "Pick a LoRA from the loras folder. "
        "If a thumbnail image with the same base name exists it is shown; otherwise a placeholder is used. "
        "Appends the LoRA to an incoming LORA_STACK or returns a new stack, "
        "plus the preview image as an IMAGE output."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @staticmethod
    def _derive_lora_path(lora_path: str) -> tuple[str, bool]:
        """Find a LoRA file with the same base name as the selected image."""
        if not lora_path:
            return "", False

        base, _ = os.path.splitext(lora_path)
        for ext in LORA_EXTENSIONS:
            candidate = base + ext
            if os.path.isfile(candidate):
                return candidate, True

        return "", False

    @staticmethod
    def _find_preview_image(lora_path: str) -> str:
        """Return the first matching preview image for a LoRA path, or empty string."""
        if not lora_path:
            return ""

        base, _ = os.path.splitext(lora_path)
        for ext in VisualLoraPicker.IMAGE_EXTENSIONS:
            candidate = base + ext
            if os.path.isfile(candidate):
                return candidate

        return ""

    @staticmethod
    def _load_image_tensor(image_path: str):
        """Load an image file as a ComfyUI IMAGE tensor."""
        if not IMAGE_SUPPORT:
            raise RuntimeError("PIL/numpy not available, cannot load preview image")

        img = Image.open(image_path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img_array = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(img_array).unsqueeze(0)

    @staticmethod
    def _blank_image_tensor():
        """Return a small black image tensor for empty selections."""
        return torch.zeros((1, 64, 64, 3), dtype=torch.float32)

    @staticmethod
    def _relative_lora_path(abs_lora_path: str) -> str:
        """Return a ComfyUI-relative LoRA path when the file lives in the loras tree."""
        if not abs_lora_path:
            return abs_lora_path

        try:
            for rel in folder_paths.get_filename_list("loras"):
                if folder_paths.get_full_path("loras", rel) == abs_lora_path:
                    return rel
        except Exception:
            pass

        return abs_lora_path

    def pick_lora(self, image: str, strength_model: float, lora_stack=None):
        """Resolve the LoRA from the selected image and append it to the stack.

        Selecting "(none)" (or an empty value) means "no LoRA" - the incoming
        stack is passed through unchanged.
        """
        # Normalize the "(none)" / empty selection to a no-op passthrough.
        if not image or not str(image).strip() or str(image).strip().lower() == "(none)":
            stack = []
            if lora_stack is not None and isinstance(lora_stack, (list, tuple)):
                for item in lora_stack:
                    if isinstance(item, (list, tuple)) and len(item) >= 1:
                        path = str(item[0] or "").strip()
                        if not path:
                            continue
                        model_strength = float(item[1]) if len(item) >= 2 else 1.0
                        clip_strength = float(item[2]) if len(item) >= 3 else 0.0
                        stack.append((path, model_strength, clip_strength))
            return (stack, self._blank_image_tensor())

        lora_path, found = self._derive_lora_path(image)
        if not found:
            raise FileNotFoundError(f"Matching LoRA not found for image: {image}")

        lora_path = self._relative_lora_path(lora_path)

        preview_path = self._find_preview_image(lora_path)
        image_tensor = (
            self._load_image_tensor(preview_path)
            if preview_path
            else self._blank_image_tensor()
        )

        stack = []
        if lora_stack is not None and isinstance(lora_stack, (list, tuple)):
            for item in lora_stack:
                if isinstance(item, (list, tuple)) and len(item) >= 1:
                    path = str(item[0] or "").strip()
                    if not path:
                        continue
                    model_strength = float(item[1]) if len(item) >= 2 else 1.0
                    clip_strength = float(item[2]) if len(item) >= 3 else 0.0
                    stack.append((path, model_strength, clip_strength))

        stack.append((lora_path, float(strength_model), float(strength_model)))
        return (stack, image_tensor)


NODE_CLASS_MAPPINGS = {"VisualLoraPicker": VisualLoraPicker}
NODE_DISPLAY_NAME_MAPPINGS = {"VisualLoraPicker": "Visual LoRA Picker+"}


@server.PromptServer.instance.routes.get("/fbnodes/lora-browser/root")
async def lora_browser_root(request):
    """Expose the first configured LoRA folder for the frontend browser."""
    try:
        paths = folder_paths.get_folder_paths("loras")
        root = next((p for p in paths if os.path.isdir(p)), None)
        if not root:
            return server.web.json_response(
                {"ok": False, "error": "No loras folder found"}, status=404
            )
        return server.web.json_response({"ok": True, "root": os.path.abspath(root)})
    except Exception as e:
        return server.web.json_response({"ok": False, "error": str(e)}, status=500)
