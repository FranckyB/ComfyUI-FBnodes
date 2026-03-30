"""
ComfyUI-FBnodes - Utility nodes for ComfyUI
Video saving, universal switches, LoRA application, and animated latent preview.
"""
__version__ = "1.1.0"
__author__ = "François Beaudry"
__license__ = "GPL-3.0"

from .nodes import (
    SaveVideoH26x, LoadLatentFile, MonoToStereo, GetVideoComponentsPlus,
    SwitchAny, SwitchAnyBool,
    PromptApplyLora,
    BetterImageLoader,
    FBVACETransitionBuilder,
    FBVACETransitionBuilderOptions,
    install_latent_preview_hook,
)

# Initialize latent preview hook (with VHS conflict detection)
install_latent_preview_hook()

NODE_CLASS_MAPPINGS = {
    "SaveVideoH26x": SaveVideoH26x,
    "LoadLatentFile": LoadLatentFile,
    "AudioMonoToStereo": MonoToStereo,
    "GetVideoComponentsPlus": GetVideoComponentsPlus,
    "SwitchAny": SwitchAny,
    "SwitchAnyBool": SwitchAnyBool,
    "PromptApplyLora": PromptApplyLora,
    "BetterImageLoader": BetterImageLoader,
    "FBVACETransitionBuilder": FBVACETransitionBuilder,
    "FBVACETransitionBuilderOptions": FBVACETransitionBuilderOptions,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SaveVideoH26x": "Save Video H264/H265",
    "LoadLatentFile": "Load Latent File",
    "AudioMonoToStereo": "Audio Mono to Stereo",
    "GetVideoComponentsPlus": "Get Video Components+",
    "SwitchAny": "Switch Any",
    "SwitchAnyBool": "Switch Any (Boolean)",
    "PromptApplyLora": "Prompt Apply LoRA",
    "BetterImageLoader": "Better Image Loader",
    "FBVACETransitionBuilder": "VACE Transition Builder",
    "FBVACETransitionBuilderOptions": "VACE Transition Options",
}

WEB_DIRECTORY = "./js"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']

print("[FBnodes] Nodes registered successfully")
