"""
ComfyUI Prompt Apply LoRA - Apply a LORA_STACK to model and clip
"""
import os

import comfy.sd
import comfy.lora
import comfy.utils

from ..py.lora_utils import resolve_lora_path


class ApplyLoraPlus:
    """
    Apply a LoRA stack to a model and optionally a CLIP.
    Accepts either a LORA_STACK (list of tuples) or a multiline STRING with one
    LoRA path/name per line.
    Uses fuzzy matching to find LoRAs on disk — LoRAs not found are skipped.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                # Accept both a LORA_STACK and STRING on this same socket.
                "lora_stack": ("*",),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
            },
            "optional": {
                "clip_optional": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "apply_stack"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Apply LoRAs to model/CLIP from either LORA_STACK or newline-separated STRING input, with a global strength multiplier."

    @staticmethod
    def _coerce_lora_stack(lora_stack):
        """Normalize accepted input formats into (name_or_path, model_strength, clip_strength) tuples."""
        if not lora_stack:
            return []

        # Native LORA_STACK format: list[tuple(name, model_strength, clip_strength)]
        if isinstance(lora_stack, (list, tuple)):
            normalized = []
            for entry in lora_stack:
                if isinstance(entry, (list, tuple)) and len(entry) >= 3:
                    normalized.append((entry[0], float(entry[1]), float(entry[2])))
            return normalized

        # STRING format: one LoRA per line (name or full path)
        if isinstance(lora_stack, str):
            lines = [line.strip() for line in lora_stack.splitlines() if line.strip()]
            return [(line, 1.0, 1.0) for line in lines]

        return []

    @staticmethod
    def _resolve_lora_path_or_name(lora_name):
        """Use direct path when available, otherwise fallback to fuzzy resolver."""
        candidate = str(lora_name).strip()
        if candidate and ("/" in candidate or "\\" in candidate) and os.path.isfile(candidate):
            return candidate, True
        return resolve_lora_path(candidate)

    def apply_stack(self, model, lora_stack, strength=1.0, clip_optional=None):
        clip = clip_optional
        stack = self._coerce_lora_stack(lora_stack)
        if not stack:
            return (model, clip)

        model_out = model
        clip_out = clip

        for lora_name, model_strength, clip_strength in stack:
            scaled_model_strength = model_strength * strength
            scaled_clip_strength = clip_strength * strength

            # Skip if no strength
            if scaled_model_strength == 0 and scaled_clip_strength == 0:
                continue

            # Resolve LoRA using direct path first, then fuzzy matching.
            lora_path, found = self._resolve_lora_path_or_name(lora_name)
            if not found:
                print(f"[ApplyLoraPlus] Warning: LoRA not found, skipping: {lora_name}")
                continue

            # Load the LoRA
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)

            # Apply to model and clip
            model_out, clip_out = comfy.sd.load_lora_for_models(
                model_out, clip_out, lora, scaled_model_strength, scaled_clip_strength
            )

        return (model_out, clip_out)


class ApplyLTXLoraPlus:
    """
    Apply a LoRA stack to an LTX model with separate video/audio strength multipliers.
    Accepts either a LORA_STACK (list of tuples) or a multiline STRING with one
    LoRA path/name per line.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_stack": ("*",),
                "video_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "audio_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "other_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.01}),
            },
            "optional": {
                "clip_optional": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("model", "clip")
    FUNCTION = "apply_stack_ltx"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Apply LoRAs to LTX MODEL from LORA_STACK or newline-separated STRING with separate video/audio/other strength multipliers."

    @staticmethod
    def _coerce_lora_stack(lora_stack):
        return ApplyLoraPlus._coerce_lora_stack(lora_stack)

    @staticmethod
    def _resolve_lora_path_or_name(lora_name):
        return ApplyLoraPlus._resolve_lora_path_or_name(lora_name)

    @staticmethod
    def _key_to_string(key):
        if isinstance(key, str):
            return key
        if isinstance(key, tuple) and len(key) > 0:
            return " ".join(str(k) for k in key)
        return str(key)

    @staticmethod
    def _is_audio_key(key_str):
        return (
            "video_to_audio_attn" in key_str
            or "audio_to_video_attn" in key_str
            or "audio_attn" in key_str
            or "audio_ff.net" in key_str
        )

    @staticmethod
    def _is_video_key(key_str):
        return "attn" in key_str or "ff.net" in key_str

    def apply_stack_ltx(self, model, lora_stack, video_strength=1.0, audio_strength=1.0, other_strength=1.0, clip_optional=None):
        clip_out = clip_optional
        stack = self._coerce_lora_stack(lora_stack)
        if not stack:
            return (model, clip_out)

        model_out = model

        for lora_name, model_strength, _clip_strength in stack:
            # Resolve LoRA using direct path first, then fuzzy matching.
            lora_path, found = self._resolve_lora_path_or_name(lora_name)
            if not found:
                print(f"[ApplyLTXLoraPlus] Warning: LoRA not found, skipping: {lora_name}")
                continue

            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)

            key_map = comfy.lora.model_lora_keys_unet(model_out.model, {})
            loaded = comfy.lora.load_lora(lora, key_map)

            keys_to_delete = []

            # Apply per-layer scaling following the LTX2 advanced loader logic.
            for key in list(loaded.keys()):
                key_str = self._key_to_string(key)
                if self._is_audio_key(key_str):
                    strength_multiplier = float(audio_strength)
                elif self._is_video_key(key_str):
                    strength_multiplier = float(video_strength)
                else:
                    strength_multiplier = float(other_strength)

                if strength_multiplier == 0:
                    keys_to_delete.append(key)
                    continue

                value = loaded[key]
                if hasattr(value, "weights") and strength_multiplier != 1.0:
                    weights_list = list(value.weights)
                    current_alpha = weights_list[2] if weights_list[2] is not None else 1.0
                    weights_list[2] = current_alpha * strength_multiplier
                    loaded[key].weights = tuple(weights_list)

            for key in keys_to_delete:
                if key in loaded:
                    del loaded[key]

            if not loaded:
                continue

            model_next = model_out.clone()
            # Keep per-LoRA model strength at add_patches stage (reference behavior).
            model_next.add_patches(loaded, float(model_strength))
            model_out = model_next

        return (model_out, clip_out)
