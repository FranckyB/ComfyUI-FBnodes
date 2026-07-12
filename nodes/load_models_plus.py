"""
Load Models+ nodes - interactive model loaders with text filtering.
"""

from __future__ import annotations

import folder_paths


def _get_model_list(folder_name: str) -> list[str]:
    """Get sorted model list from a ComfyUI folder bucket."""
    models = folder_paths.get_filename_list(folder_name)
    return sorted(models) if models else []


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

    def load_checkpoint(self, filter: str, ckpt_name: str):
        """Load the selected checkpoint. The filter value is UI-only."""
        _ = filter
        ckpt_path = folder_paths.get_full_path("checkpoints", ckpt_name)

        from comfy.sd import load_checkpoint_guess_config

        out = load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        model, clip, vae = out[:3]
        return (model, clip, vae, ckpt_name)


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

    def load_unet(self, filter: str, unet_name: str):
        """Load the selected diffusion model. The filter value is UI-only."""
        _ = filter
        full_path = folder_paths.get_full_path_or_raise("diffusion_models", unet_name)

        import comfy.sd

        model = comfy.sd.load_diffusion_model(full_path)
        return (model, unet_name)


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

    def _resolve_lora_file(self, lora_name: str) -> str:
        """Resolve selected LoRA value to a valid file path."""
        candidate = str(lora_name or "").strip()
        if not candidate:
            raise ValueError("LoRA name/path is empty")

        # Support direct absolute/relative file paths when provided.
        if ("/" in candidate or "\\" in candidate) and folder_paths.exists_annotated_filepath(candidate):
            return folder_paths.get_annotated_filepath(candidate)

        return folder_paths.get_full_path_or_raise("loras", candidate)

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

        # Selector-only mode: no model connected, still output selected lora_name.
        if model is None:
            return (model, lora_name)

        if strength_model == 0:
            return (model, lora_name)

        lora_path = self._resolve_lora_file(lora_name)

        import comfy.sd
        import comfy.utils

        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
        model_out, _ = comfy.sd.load_lora_for_models(model, None, lora, strength_model, 0)
        return (model_out, lora_name)


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
