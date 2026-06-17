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
                        "tooltip": "Filter checkpoints by comma-separated terms in name/path (e.g., 'sdxl, anime')",
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

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load_checkpoint"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load checkpoint with grouped text filter"

    def load_checkpoint(self, filter: str, ckpt_name: str):
        """Load the selected checkpoint. The filter value is UI-only."""
        ckpt_path = folder_paths.get_full_path("checkpoints", ckpt_name)

        from comfy.sd import load_checkpoint_guess_config

        out = load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        return out


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
                        "tooltip": "Filter diffusion models by comma-separated terms in name/path (e.g., 'flux, fp8')",
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

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("MODEL",)
    FUNCTION = "load_unet"
    CATEGORY = "FBnodes"
    DESCRIPTION = "Load diffusion model with grouped text filter"

    def load_unet(self, filter: str, unet_name: str):
        """Load the selected diffusion model. The filter value is UI-only."""
        full_path = folder_paths.get_full_path_or_raise("diffusion_models", unet_name)

        import comfy.sd

        model = comfy.sd.load_diffusion_model(full_path)
        return (model,)


NODE_CLASS_MAPPINGS = {
    "LoadCheckpointPlus": LoadCheckpointPlus,
    "LoadDiffusionModelPlus": LoadDiffusionModelPlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadCheckpointPlus": "Load Checkpoint+",
    "LoadDiffusionModelPlus": "Load Diffusion Model+",
}
