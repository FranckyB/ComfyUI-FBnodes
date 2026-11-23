"""
LoRA List+ - Build an ordered, toggleable list of LoRA paths and output as newline text.
Used with Outputlist Combiner the feed into Apply LoRA++ to test Loras.
"""

from __future__ import annotations

import json
import os


class LoraListPlus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loras_state": ("STRING", {"default": "[]", "multiline": True}),
                "loras_text": ("STRING", {"default": "", "multiline": True}),
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "Build an ordered LoRA list with enable/disable and output enabled paths as multiline text.\nFor use with Outputlist Combiner for LoRA testing"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("loras", "names")
    FUNCTION = "build"
    OUTPUT_NODE = False

    def build(self, loras_state: str, loras_text: str):
        enabled_paths = []

        # Primary source: UI JSON state (preserves order + enable flags).
        try:
            parsed = json.loads(loras_state or "[]")
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    path = str(item.get("path", "")).strip()
                    enabled = bool(item.get("enabled", True))
                    if path and enabled:
                        enabled_paths.append(path)
        except Exception:
            pass

        # Fallback: user-provided multiline string.
        if not enabled_paths and isinstance(loras_text, str):
            enabled_paths = [line.strip() for line in loras_text.splitlines() if line.strip()]

        output = "\n".join(enabled_paths)
        output_basename = "\n".join(
            os.path.splitext(os.path.basename(path))[0]
            for path in enabled_paths
        )
        return {
            "ui": {"text": [output]},
            "result": (output, output_basename),
        }
