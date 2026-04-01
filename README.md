# ComfyUI-FBnodes

A grab bag of handy ComfyUI nodes I built for my own workflows and figured someone else might enjoy too. Video saving, universal switches, LoRA helpers, animated latent previews, and whatever else I end up needing next.

## Nodes

### Save Video+
Save video with H.264 or H.265 (HEVC) codec and quality control. Includes audio muxing and workflow metadata embedding.
If yuv444 is selected, will generate a preview clip, so it can still be seen in browser. (Saved in temp)

- **Codec**: H.264 (8-bit, max compatibility) or H.265/HEVC (10-bit, better compression)
- **Chroma**: yuv420 / yuv422 / yuv444
- **CRF**: Constant Rate Factor quality control (0=lossless, 18-23=high quality)
- **Preview mode**: Toggle save off for fast preview-only encoding
- **Latent saving**: Optionally save the latent alongside the video for easy re-generation

### Load Image+:
- **Image/Video Screenshot Loading**: Image loader, based on Prompt Extractor from [Prompt Manager](https://github.com/FranckyB/ComfyUI-Prompt-Manager)
- **Input/Output Folder Switching**: Toggle between browsing your input or output folder directly from the node
- **File Browser**: Same thumbnail browser as Prompt Extractor with subfolder navigation
- **Video Frame Scrubbing**: Load any frame from a video using the frame position slider
- **Drag-and-Drop Support**: Drop images or videos directly onto the node
- **Image Preview**: Built-in preview with click-to-enlarge modal for images and videos
- **Single IMAGE Output**: Outputs a single IMAGE tensor, ready to connect to any image input

### Load Video+
Video loader with the same file browser and UX as Load Image+, but for videos. Outputs a VIDEO type for use with **Get Video Components+**.

- **Input/Output Folder Switching**: Toggle between browsing your input or output folder
- **File Browser**: Thumbnail browser with video-first filtering and subfolder navigation
- **Video Preview**: Click-to-enlarge modal with playback controls
- **Drag-and-Drop Support**: Drop video files directly onto the node
- **VIDEO Output**: Outputs a VIDEO, ready to pipe into Get Video Components+

### VACE Stitcher
Generate smooth AI-powered transitions between video clips using VACE conditioning and 2-stage sampling with a single node featuring a built-in clip browser, drag-to-reorder list, and cached h265 transitions for resumability.

- **File browser modal**: Browse input/output folders, multi-select clips, subfolder navigation
- **Reorderable clip list**: Drag-to-reorder, enable/disable individual clips, hover thumbnails
- **2-stage sampling**: High-noise + low-noise models for quality transitions
- **Pixel-space stitching**: Crossfade with easing curves, optional color matching
- **Lossless latent support**: Load `.latent` clips directly — skips lossy video decode, with memory-efficient on-demand decoding
- **Cached transitions**: Transitions cached as lossless `.latent` files (with `.mp4` fallback) — skip already-generated pairs on re-run
- **Options node**: Connect a separate "VACE Stitcher Options" node to tune all parameters, or use sensible defaults

Inspired by [__Bob__](https://civitai.com/user/__Bob__)'s [Wan VACE Clip Joiner workflow](https://civitai.com/models/2024299/wan-vace-clip-joiner-smooth-ai-video-transitions-for-wan-ltx-2-hunyuan-and-any-other-video-source) on CivitAI.

[![VACE Stitcher](docs/VACEStitcher.png)](docs/VACEStitcher.png)

<details>
<summary><strong>How to use VACE Stitcher</strong></summary>

An example workflow can be found ....  If starting from scratch here are some basic instructions.

#### Required Models

You need **both** the high-noise and low-noise Wan 2.2 VACE models. Choose one format:

**bf16 or fp8** (from Comfy-Org):
- [`wan2.2_vace_i2v_high_noise_14B-*.safetensors`](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/tree/main/split_files/diffusion_models)

or **GGUF** (from QuantStack):
- [`Wan2.2-VACE-Fun-A14B-*.gguf`](https://huggingface.co/QuantStack/Wan2.2-VACE-Fun-A14B-GGUF/tree/main) (high + low noise variants)

Place models in `/models/diffusion_models/` or '/models/unet' if GGUF

#### Tips

- Use a Wan 2.2 i2v‑distilled LoRA to lower the required step count.
- **Lossless clips**: Save your source clips with **Save Video+** using the "Save Latent" option. VACE Stitcher will automatically detect and use the `.latent` file for lossless quality — no video decode needed. A magenta dot in the clip list indicates which clips have a latent available. For now only wan latents are supported.
- **First run** generates and caches all transitions. Subsequent runs skip cached pairs.
- **Delete Transitions** clears the cache so you can regenerate with different settings.
- Without an **Options** node connected, the seed is random each run — just delete transitions and re-queue for a new result.
- Connect a **VACE Stitcher Options** node to control context/replace frames, steps, sampler, crossfade, color matching, and more.
- Disable clips in the list (uncheck) to skip them without removing.

</details>

### Load Latent File
Load a `.latent` file saved by Save Video+. Companion node for video+latent workflows.

### Get Video Components+
Like ComfyUI's built-in GetVideoComponents but also outputs the file path and automatically loads a matching `.latent` file if one exists alongside the video.

### Audio Mono to Stereo
Convert mono audio to stereo by duplicating the channel. Useful for video models that output mono audio.

### Switch Any
Universal switch with up to 10 named inputs. True lazy evaluation — only the selected input is evaluated. Other inputs are completely ignored by ComfyUI, with zero performance cost from inactive branches.

- Custom names via comma/semicolon-separated list
- Dynamic input count (1-10)
- Names display on input slots

### Switch Any (Boolean)
Boolean switch — passes through `on_true` or `on_false` based on a condition toggle. Only the active branch is evaluated.

### Apply LoRA+
Apply a LORA_STACK (list of LoRA tuples) to a model and optional CLIP. Works with Prompt Manager Advanced's LoRA stack output.

## Animated Latent Preview
Provides animated video previews during KSampler execution for video models (Wan, HunyuanVideo, Mochi, LTXV, Cosmos). Compatible with VideoHelperSuite — automatically defers if VHS is installed.

Enable in ComfyUI Settings: **FBnodes > Video Sampling > Animated Latent Preview**

## Installation

### ComfyUI Manager
Search for "ComfyUI-FBnodes" in ComfyUI Manager.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/francoisBeaudworker/ComfyUI-FBnodes.git
pip install -r ComfyUI-FBnodes/requirements.txt
```

## Requirements
- `av` (PyAV) — for video encoding

## License
GPL-3.0

## Changelog

### version 1.1.9
- **Renamed nodes**: Prompt Apply LoRA → **Apply LoRA+**, cleaned up internal node IDs (`SaveVideoH26x` → `SaveVideoPlus`, `PromptApplyLora` → `ApplyLoraPlus`, `BetterImageLoader` → `LoadImagePlus`). Existing workflows are automatically migrated via the Node Replacement API.

### version 1.1.8
- **Speed Improvement**: Thumbnail generation now uses server-side PyAV instead of browser-based video decoding — substantially faster, especially with many clips.
- **Improved Handling of H265 Clip**
- **Renamed nodes**: Save Video H264/H265 → **Save Video+**, Better Image Loader → **Load Image+**. Existing workflows are unaffected.
- **New node**: Added **Load Video+** — video loader with file browser, preview, and drag-drop. Outputs VIDEO for Get Video Components+.

### version 1.1.5
- **VACE Stitcher**: Added lossless `.latent` file support for clips and transitions
  - Clips with a `.latent` file alongside are loaded in latent space, avoiding lossy video decode
  - Transitions now cached as `.latent` files instead of h265 video — lossless quality
  - Memory-efficient on-demand decoding: only decode what's needed, when it's needed
  - Latent indicator (magenta dot) in clip list UI shows which clips have `.latent` files

### version 1.1.1
- Renamed node from "VACE Transition Builder" to **VACE Stitcher**
- Added Workflow example.

### version 1.1.0
- Added **VACE Stitcher** node — generates smooth AI transitions between video clips using VACE conditioning
- Added **VACE Stitcher Options** node — optional parameter overrides for the stitcher
- Credit to [__Bob__](https://civitai.com/user/__Bob__) for the [original workflow](https://civitai.com/models/2024299/wan-vace-clip-joiner-smooth-ai-video-transitions-for-wan-ltx-2-hunyuan-and-any-other-video-source)

### version 1.0.0
- Initial release
- Transfered miscellaneous from [ComfyUI-Prompt-Manager](https://github.com/FranckyB/ComfyUI-Prompt-Manager) to keep it more focused.
