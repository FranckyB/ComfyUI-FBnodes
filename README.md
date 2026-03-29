# ComfyUI-FBnodes

A grab bag of handy ComfyUI nodes I built for my own workflows and figured someone else might enjoy too. Video saving, universal switches, LoRA helpers, animated latent previews, and whatever else I end up needing next.

## Nodes

### Save Video H264/H265
Save video with H.264 or H.265 (HEVC) codec and quality control. Includes audio muxing and workflow metadata embedding.
If yuv444 is selected, will generate a preview clip, so it can still be seen in browser. (Saved in temp)

- **Codec**: H.264 (8-bit, max compatibility) or H.265/HEVC (10-bit, better compression)
- **Chroma**: yuv420 / yuv422 / yuv444
- **CRF**: Constant Rate Factor quality control (0=lossless, 18-23=high quality)
- **Preview mode**: Toggle save off for fast preview-only encoding
- **Latent saving**: Optionally save the latent alongside the video for easy re-generation

### Better Image Loader:
- **Lightweight Image/Video Loading**: Load images and video frames without metadata extraction or LoRA processing
- **Input/Output Folder Switching**: Toggle between browsing your input or output folder directly from the node
- **File Browser**: Same thumbnail browser as Prompt Extractor with subfolder navigation
- **Video Frame Scrubbing**: Load any frame from a video using the frame position slider
- **Drag-and-Drop Support**: Drop images or videos directly onto the node
- **Image Preview**: Built-in preview with click-to-enlarge modal for images and videos
- **Single IMAGE Output**: Outputs a single IMAGE tensor, ready to connect to any image input

### Load Latent File
Load a `.latent` file saved by Save Video H264/H265. Companion node for video+latent workflows.

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

### Prompt Apply LoRA
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

### version 1.0.0
- Initial release
- Transfered miscellaneous from [ComfyUI-Prompt-Manager](https://github.com/FranckyB/ComfyUI-Prompt-Manager) to keep it more focused.