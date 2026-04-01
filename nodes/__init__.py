"""
ComfyUI-FBnodes - nodes subpackage
"""
from .save_video import SaveVideoH26x, LoadLatentFile, MonoToStereo, GetVideoComponentsPlus
from .switch_any import SwitchAny, SwitchAnyBool
from .apply_lora import PromptApplyLora
from .latent_preview import install_latent_preview_hook
from .load_image import BetterImageLoader
from .load_video import LoadVideoPlus
from .vace_stitcher import VACEStitcher, VACEStitcher_Options
