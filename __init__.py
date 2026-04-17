"""
ComfyUI-FBnodes - Utility nodes for ComfyUI
"""

__version__ = "1.1.11"
__author__ = "François Beaudry"
__license__ = "GPL-3.0"

from .nodes import (
    ApplyLoraPlus,
    MonoToStereo,
    GetVideoComponentsPlus,
    LoadImagePlus,
    LoadLatentFile,
    LoadVideoPlus,
    SaveVideoPlus,
    SwitchAny,
    SwitchAnyBool,
    VACEStitcher,
    VACEStitcher_Options,
    install_latent_preview_hook,
)

# Initialize latent preview hook (with VHS conflict detection)
install_latent_preview_hook()

NODE_CLASS_MAPPINGS = {
    "ApplyLoraPlus": ApplyLoraPlus,
    "AudioMonoToStereo": MonoToStereo,
    "GetVideoComponentsPlus": GetVideoComponentsPlus,
    "LoadImagePlus": LoadImagePlus,
    "LoadLatentFile": LoadLatentFile,
    "LoadVideoPlus": LoadVideoPlus,
    "SaveVideoPlus": SaveVideoPlus,
    "SwitchAny": SwitchAny,
    "SwitchAnyBool": SwitchAnyBool,
    "VACEStitcher": VACEStitcher,
    "VACEStitcher_Options": VACEStitcher_Options,

    # compatibility aliases
    "BetterImageLoader": LoadImagePlus,
    "SaveVideoH26x": SaveVideoPlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ApplyLoraPlus": "Apply LoRA+",
    "AudioMonoToStereo": "Audio Mono to Stereo",
    "GetVideoComponentsPlus": "Get Video Components+",
    "LoadImagePlus": "Load Image+",
    "LoadLatentFile": "Load Latent File",
    "LoadVideoPlus": "Load Video+",
    "SaveVideoPlus": "Save Video+",
    "SwitchAny": "Switch Any",
    "SwitchAnyBool": "Switch Any (Boolean)",
    "VACEStitcher": "VACE Stitcher",
    "VACEStitcher_Options": "VACE Stitcher Options",

    # compatibility aliases
    "BetterImageLoader": "Load Image+ (legacy)",
    "SaveVideoH26x": "Save Video+ (legacy)",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("[FBnodes] Nodes registered successfully")
