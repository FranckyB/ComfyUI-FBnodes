"""
ComfyUI-FBnodes - Utility nodes for ComfyUI
"""

__version__ = "1.3.0"
__author__ = "François Beaudry"
__license__ = "GPL-3.0"

from .nodes import (
    ApplyLoraPlus,
    LoadAudioPlus,
    MonoToStereo,
    GetVideoComponentsPlus,
    CropImagePlus,
    LoadImagePlus,
    LoadLatentFile,
    LoadVideoPlus,
    SaveImagePlus,
    SaveVideoPlus,
    ShowTextPlus,
    SwitchAny,
    SwitchAnyBool,
    VACEStitcher,
    VACEStitcher_Options,
    install_latent_preview_hook,
)
from .py import repath_util  # noqa: F401

# Initialize latent preview hook (with VHS conflict detection)
install_latent_preview_hook()

NODE_CLASS_MAPPINGS = {
    "ApplyLoraPlus": ApplyLoraPlus,
    "LoadAudioPlus": LoadAudioPlus,
    "AudioMonoToStereo": MonoToStereo,
    "GetVideoComponentsPlus": GetVideoComponentsPlus,
    "CropImagePlus": CropImagePlus,
    "LoadImagePlus": LoadImagePlus,
    "LoadLatentFile": LoadLatentFile,
    "LoadVideoPlus": LoadVideoPlus,
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
    "LoadAudioPlus": "Load Audio+",
    "AudioMonoToStereo": "Audio Mono to Stereo",
    "GetVideoComponentsPlus": "Get Video Components+",
    "CropImagePlus": "Crop Image+",
    "LoadImagePlus": "Load Image+",
    "LoadLatentFile": "Load Latent File",
    "LoadVideoPlus": "Load Video+",
    "SaveImagePlus": "Save Image+",
    "SaveVideoPlus": "Save Video+",
    "ShowTextPlus": "Show Text+",
    "SwitchAny": "Switch Any",
    "SwitchAnyBool": "Switch Any (Boolean)",
    "VACEStitcher": "VACE Stitcher",
    "VACEStitcher_Options": "VACE Stitcher Options",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("[FBnodes] Nodes registered successfully")
