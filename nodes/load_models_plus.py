"""
Load Models+ nodes - interactive model loaders with text filtering.
"""

from __future__ import annotations

import os

import folder_paths

from ..py.lora_utils import resolve_lora_path


def _get_model_list(folder_name: str) -> list[str]:
    """Get sorted model list from a ComfyUI folder bucket."""
    models = folder_paths.get_filename_list(folder_name)
    return sorted(models) if models else []


def _resolve_model_path(folder_name: str, value: str) -> tuple[str, str]:
    """
    Resolve a model checkpoint/diffusion-model value to a full path and a
    list-relative name.

    Accepts absolute paths, exact relative paths, and display-friendly
    basenames whose extension has been stripped by the frontend.
    """
    candidate = str(value or "").strip()
    if not candidate:
        raise ValueError(f"{folder_name} name/path is empty")

    # Absolute path supplied directly (e.g. from another node or a subgraph).
    if os.path.isabs(candidate) and os.path.isfile(candidate):
        return candidate, candidate

    # Exact match against ComfyUI's folder list.
    full_path = folder_paths.get_full_path(folder_name, candidate)
    if full_path and os.path.exists(full_path):
        return full_path, candidate

    # Basename match ignoring known model extensions (handles frontend display
    # labels that drop the extension or directory prefix).
    target_stem = os.path.splitext(os.path.basename(candidate).lower())[0]
    if target_stem:
        for rel_path in folder_paths.get_filename_list(folder_name):
            if os.path.splitext(os.path.basename(rel_path).lower())[0] == target_stem:
                full_path = folder_paths.get_full_path(folder_name, rel_path)
                if full_path and os.path.exists(full_path):
                    return full_path, rel_path

    raise FileNotFoundError(f"{folder_name} not found: {value}")


class LoadCheckpointPlus:
    """Load a checkpoint model with interactive frontend filtering."""

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _get_model_list("checkpoints")
        default_checkpoint = checkpoints[0] if checkpoints else ""

        return {
            "required": {
                "filter": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Filter checkpoints by multiple terms in name/path (AND match; use spaces/commas, e.g., 'sdxl anime')",
                    },
                ),
                "ckpt_name": (
                    checkpoints if checkpoints else ["No checkpoints found"],
                    {
                        "default": default_checkpoint,
                        "tooltip": "Select checkpoint (filtered by search text above)",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "COMBO")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE", "ckpt_name")
    FUNCTION = "load_checkpoint"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load checkpoint with grouped text filter"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def load_checkpoint(self, filter: str, ckpt_name: str):
        """Load the selected checkpoint. The filter value is UI-only."""
        _ = filter
        ckpt_path, ckpt_list_value = _resolve_model_path("checkpoints", ckpt_name)

        from comfy.sd import load_checkpoint_guess_config

        out = load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        model, clip, vae = out[:3]
        return (model, clip, vae, ckpt_list_value)


class LoadDiffusionModelPlus:
    """Load a diffusion model (UNET) with interactive frontend filtering."""

    @classmethod
    def INPUT_TYPES(cls):
        diffusion_models = _get_model_list("diffusion_models")
        default_model = diffusion_models[0] if diffusion_models else ""

        return {
            "required": {
                "filter": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Filter diffusion models by multiple terms in name/path (AND match; use spaces/commas, e.g., 'flux fp8')",
                    },
                ),
                "unet_name": (
                    diffusion_models if diffusion_models else ["No diffusion models found"],
                    {
                        "default": default_model,
                        "tooltip": "Select diffusion model (filtered by search text above)",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "COMBO")
    RETURN_NAMES = ("MODEL", "unet_name")
    FUNCTION = "load_unet"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load diffusion model with grouped text filter"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def load_unet(self, filter: str, unet_name: str):
        """Load the selected diffusion model. The filter value is UI-only."""
        _ = filter
        full_path, unet_list_value = _resolve_model_path("diffusion_models", unet_name)

        import comfy.sd

        model = comfy.sd.load_diffusion_model(full_path)
        return (model, unet_list_value)


class LoadLoraPlus:
    """Load/apply a LoRA to MODEL with interactive frontend filtering."""

    @classmethod
    def INPUT_TYPES(cls):
        loras = _get_model_list("loras")
        default_lora = loras[0] if loras else ""

        return {
            "required": {
                "filter": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Filter LoRAs by multiple terms in name/path (AND match; use spaces/commas, e.g., 'ltx turbo')",
                    },
                ),
                "lora_name": (
                    loras if loras else ["No LoRAs found"],
                    {
                        "default": default_lora,
                        "tooltip": "Select LoRA (filtered by search text above)",
                    },
                ),
                "strength_model": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 0.01,
                        "tooltip": "Strength applied to MODEL",
                    },
                ),
            },
            "optional": {
                "model": ("MODEL",),
            },
        }

    RETURN_TYPES = ("MODEL", "COMBO")
    RETURN_NAMES = ("model", "lora_name")
    FUNCTION = "load_lora"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load/apply LoRA to MODEL with grouped text filter; outputs selected lora_name for downstream Load LoRA nodes"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def _resolve_lora_file(self, lora_name: str) -> tuple[str, str]:
        """
        Resolve selected LoRA value to a full path and a list-relative name.

        Handles absolute paths, annotated paths, exact folder_paths matches,
        extension-stripped basenames, and fuzzy matches for renamed LoRAs.
        """
        candidate = str(lora_name or "").strip()
        if not candidate:
            raise ValueError("LoRA name/path is empty")

        # Direct absolute/relative file paths or annotated ComfyUI paths.
        if "/" in candidate or "\\" in candidate:
            if folder_paths.exists_annotated_filepath(candidate):
                annotated = folder_paths.get_annotated_filepath(candidate)
                return annotated, annotated
            if os.path.isfile(candidate):
                return candidate, candidate

        # Use the fuzzy LoRA resolver (exact, extension-stripped, then fuzzy).
        lora_path, found = resolve_lora_path(candidate)
        if found:
            for rel_path in folder_paths.get_filename_list("loras"):
                if folder_paths.get_full_path("loras", rel_path) == lora_path:
                    return lora_path, rel_path
            return lora_path, lora_path

        raise FileNotFoundError(f"LoRA not found: {lora_name}")

    def load_lora(
        self,
        filter: str,
        lora_name: str,
        strength_model: float,
        model=None,
    ):
        """Apply selected LoRA to MODEL and return model plus selected lora_name."""
        # Keep filter argument for UI parity; runtime behavior depends on selected lora_name.
        _ = filter

        lora_path, lora_list_value = self._resolve_lora_file(lora_name)

        # Selector-only mode: no model connected, still output selected lora_name.
        if model is None:
            return (model, lora_list_value)

        if strength_model == 0:
            return (model, lora_list_value)

        import comfy.sd
        import comfy.utils

        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
        model_out, _ = comfy.sd.load_lora_for_models(model, None, lora, strength_model, 0)
        return (model_out, lora_list_value)


NODE_CLASS_MAPPINGS = {
    "LoadCheckpointPlus": LoadCheckpointPlus,
    "LoadDiffusionModelPlus": LoadDiffusionModelPlus,
    "LoadLoraPlus": LoadLoraPlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadCheckpointPlus": "Load Checkpoint+",
    "LoadDiffusionModelPlus": "Load Diffusion Model+",
    "LoadLoraPlus": "Load LoRA+",
}
