"""
ComfyUI-FBnodes - Utility nodes for ComfyUI
"""

__version__ = "1.3.5"
__author__ = "François Beaudry"
__license__ = "GPL-3.0"

from .nodes import (
    ApplyLoraPlus,
    ApplyLTXLoraPlus,
    LoadAudioPlus,
    MonoToStereo,
    GetVideoComponentsPlus,
    CropImagePlus,
    LoraListPlus,
    LTXReview,
    LTXReviewPreview,
    LoadCheckpointPlus,
    LoadDiffusionModelPlus,
    LoadLoraPlus,
    LoadImagePlus,
    LoadLatentFile,
    LoadLTXLatentFile,
    LoadVideoPlus,
    PromptBatcher,
    SaveImagePlus,
    SaveVideoPlus,
    ShowTextPlus,
    SwitchAny,
    SwitchAnyBool,
    VACEStitcher,
    VACEStitcher_Options,
    install_latent_preview_hook,
)
from .py import repath_util

# Initialize latent preview hook (with VHS conflict detection)
install_latent_preview_hook()

NODE_CLASS_MAPPINGS = {
    "ApplyLoraPlus": ApplyLoraPlus,
    "ApplyLTXLoraPlus": ApplyLTXLoraPlus,
    "LoadAudioPlus": LoadAudioPlus,
    "AudioMonoToStereo": MonoToStereo,
    "GetVideoComponentsPlus": GetVideoComponentsPlus,
    "CropImagePlus": CropImagePlus,
    "LoraListPlus": LoraListPlus,
    "LTXReview": LTXReview,
    "LTXReviewPreview": LTXReviewPreview,
    "LoadCheckpointPlus": LoadCheckpointPlus,
    "LoadDiffusionModelPlus": LoadDiffusionModelPlus,
    "LoadLoraPlus": LoadLoraPlus,
    "LoadImagePlus": LoadImagePlus,
    "LoadLatentFile": LoadLatentFile,
    "LoadLTXLatentFile": LoadLTXLatentFile,
    "LoadVideoPlus": LoadVideoPlus,
    "PromptBatcher": PromptBatcher,
    "SaveImagePlus": SaveImagePlus,
    "SaveVideoPlus": SaveVideoPlus,
    "ShowTextPlus": ShowTextPlus,
    "SwitchAny": SwitchAny,
    "SwitchAnyBool": SwitchAnyBool,
    "VACEStitcher": VACEStitcher,
    "VACEStitcher_Options": VACEStitcher_Options,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ApplyLoraPlus": "Apply LoRA+",
    "ApplyLTXLoraPlus": "Apply LTX LoRA+",
    "LoadAudioPlus": "Load Audio+",
    "AudioMonoToStereo": "Audio Mono to Stereo",
    "GetVideoComponentsPlus": "Get Video Components+",
    "CropImagePlus": "Crop Image+",
    "LoraListPlus": "LoRA List+",
    "LTXReview": "LTX Review",
    "LTXReviewPreview": "LTX Review Preview",
    "LoadCheckpointPlus": "Load Checkpoint+",
    "LoadDiffusionModelPlus": "Load Diffusion Model+",
    "LoadLoraPlus": "Load LoRA+",
    "LoadImagePlus": "Load Image+",
    "LoadLatentFile": "Load Latent File",
    "LoadLTXLatentFile": "Load LTX Latent File",
    "LoadVideoPlus": "Load Video+",
    "PromptBatcher": "Prompt Batcher",
    "SaveImagePlus": "Save Image+",
    "SaveVideoPlus": "Save Video+",
    "ShowTextPlus": "Show as Text",
    "SwitchAny": "Switch Any",
    "SwitchAnyBool": "Switch Any (Boolean)",
    "VACEStitcher": "VACE Stitcher",
    "VACEStitcher_Options": "VACE Stitcher Options",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("[FBnodes] Nodes registered successfully")
