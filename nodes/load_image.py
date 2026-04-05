"""
LoadImagePlus - A streamlined image/video loader with file browser and preview.
"""
import os
import json
import time
import base64
import io

import folder_paths
import torch
import server

try:
    import numpy as np
    from PIL import Image
    IMAGE_SUPPORT = True
except ImportError:
    IMAGE_SUPPORT = False
    print("[FBnodes] Warning: PIL/numpy not available, LoadImagePlus disabled")

# Cache for video frames extracted by JavaScript
_video_frames_cache = {}


# ---------------------------------------------------------------------------
# PyAV-based video frame extraction (for H265/yuv444 that browsers can't decode)
# ---------------------------------------------------------------------------

def extract_video_frame_av(file_path, frame_position=0.0):
    """
    Extract a video frame using PyAV. Works with H265, yuv444, and other codecs
    that browsers cannot decode.

    Seeks to the nearest keyframe before the target position, then decodes forward
    to the exact target frame for frame-accurate extraction.

    Args:
        file_path: Absolute path to the video file
        frame_position: float from 0.0 to 1.0 representing position in video

    Returns:
        PIL Image or None on failure
    """
    try:
        import av
    except ImportError:
        print("[FBnodes] PyAV not available, cannot extract frame server-side")
        return None

    try:
        container = av.open(file_path)
        stream = container.streams.video[0]

        # For position 0.0, just return the first frame
        if frame_position <= 0.0:
            for frame in container.decode(video=0):
                img = frame.to_image()
                container.close()
                return img
            container.close()
            return None

        # Calculate target timestamp in stream time_base units
        duration = stream.duration
        target_ts = None

        if duration and stream.time_base:
            target_ts = int(frame_position * duration)
        else:
            # Fallback: estimate from frame count and average rate
            total_frames = stream.frames
            if total_frames > 0 and stream.average_rate:
                target_frame = int(frame_position * total_frames)
                fps = float(stream.average_rate)
                if fps > 0 and stream.time_base:
                    target_sec = target_frame / fps
                    target_ts = int(target_sec / float(stream.time_base))

        if target_ts is not None:
            # Seek to nearest keyframe before target (backward seek)
            container.seek(target_ts, stream=stream, backward=True)

            # Decode forward until we reach or pass the target timestamp
            best_frame = None
            for frame in container.decode(video=0):
                best_frame = frame
                if frame.pts is not None and frame.pts >= target_ts:
                    break

            if best_frame is not None:
                img = best_frame.to_image()
                container.close()
                return img
        else:
            # No duration info - just decode the first frame
            for frame in container.decode(video=0):
                img = frame.to_image()
                container.close()
                return img

        container.close()
        return None
    except Exception as e:
        print(f"[FBnodes] PyAV frame extraction error: {e}")
        return None


def extract_video_frame_av_to_tensor(file_path, frame_position=0.0):
    """
    Extract a video frame using PyAV and return as a ComfyUI tensor.

    Args:
        file_path: Absolute path to the video file
        frame_position: float from 0.0 to 1.0

    Returns:
        Tensor (B, H, W, C) or None
    """
    img = extract_video_frame_av(file_path, frame_position)
    if img is None:
        return None

    try:
        if img.mode != 'RGB':
            img = img.convert('RGB')
        img_array = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(img_array).unsqueeze(0)
    except Exception as e:
        print(f"[FBnodes] Error converting PyAV frame to tensor: {e}")
        return None


# ---------------------------------------------------------------------------
# API routes (using /fbnodes/ prefix to avoid conflicts with Prompt Manager)
# ---------------------------------------------------------------------------

@server.PromptServer.instance.routes.post("/fbnodes/cache-video-frame")
async def cache_video_frame(request):
    """Cache a single video frame extracted by JavaScript."""
    try:
        data = await request.json()
        filename = data.get('filename')
        frame = data.get('frame')
        frame_position = data.get('frame_position', 0.0)
        if frame_position is None:
            frame_position = 0.0

        if not filename:
            return server.web.json_response({"success": False, "error": "Missing filename"}, status=400)

        if frame:
            path_key = filename.replace('\\', '/').replace('/', '_')
            _video_frames_cache[path_key] = frame

        return server.web.json_response({"success": True})
    except Exception as e:
        print(f"[FBnodes] Error caching video frame: {e}")
        return server.web.json_response({"success": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/fbnodes/video-frame")
async def extract_video_frame_api(request):
    """Extract a video frame server-side for videos the browser can't decode (H265, yuv444)"""
    try:
        filename = request.rel_url.query.get('filename', '')
        source = request.rel_url.query.get('source', 'input')
        position = float(request.rel_url.query.get('position', '0.0'))

        if not filename:
            return server.web.json_response({"error": "Missing filename"}, status=400)

        # Build full path
        if source == 'output':
            base_dir = folder_paths.get_output_directory()
        else:
            base_dir = folder_paths.get_input_directory()

        file_path = os.path.join(base_dir, filename.replace('/', os.sep))

        if not os.path.exists(file_path):
            return server.web.json_response({"error": "File not found"}, status=404)

        # Validate path stays within base directory
        real_base = os.path.realpath(base_dir)
        real_path = os.path.realpath(file_path)
        if not real_path.startswith(real_base):
            return server.web.json_response({"error": "Invalid path"}, status=403)

        img = extract_video_frame_av(file_path, position)
        if img is None:
            return server.web.json_response({"error": "Failed to extract frame"}, status=500)

        # Return as JPEG image
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=85)
        buf.seek(0)

        return server.web.Response(
            body=buf.read(),
            content_type='image/jpeg'
        )
    except Exception as e:
        print(f"[FBnodes] Error in video-frame API: {e}")
        return server.web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/fbnodes/video-info")
async def video_info_api(request):
    """Return codec and pixel format for a video file so the frontend can
    decide whether the browser will be able to play it."""
    try:
        import av
    except ImportError:
        return server.web.json_response(
            {"error": "PyAV not available"}, status=500
        )

    filename = request.rel_url.query.get('filename', '')
    source = request.rel_url.query.get('source', 'input')

    if not filename:
        return server.web.json_response({"error": "Missing filename"}, status=400)

    if source == 'output':
        base_dir = folder_paths.get_output_directory()
    else:
        base_dir = folder_paths.get_input_directory()

    file_path = os.path.join(base_dir, filename.replace('/', os.sep))
    real_base = os.path.realpath(base_dir)
    real_path = os.path.realpath(file_path)
    if not real_path.startswith(real_base):
        return server.web.json_response({"error": "Invalid path"}, status=403)
    if not os.path.exists(file_path):
        return server.web.json_response({"error": "File not found"}, status=404)

    try:
        container = av.open(file_path)
        stream = container.streams.video[0]
        codec_name = stream.codec_context.name or ""
        pix_fmt = stream.codec_context.pix_fmt or ""
        container.close()

        needs_preview = codec_name in ("hevc", "h265") or "444" in pix_fmt

        return server.web.json_response({
            "codec": codec_name,
            "pix_fmt": pix_fmt,
            "needs_preview": needs_preview,
        })
    except Exception as e:
        return server.web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/fbnodes/video-frame-clip")
async def extract_video_frame_clip_api(request):
    """
    Generate a browser-playable 1-frame H264 mp4 clip from a video the browser
    can't decode (H265, yuv444, etc.).  The result is cached to temp/ so
    subsequent requests for the same source just redirect to the cached file via
    ComfyUI's /view endpoint.
    """
    try:
        import av
    except ImportError:
        return server.web.json_response(
            {"error": "PyAV not available"}, status=500
        )

    filename = request.rel_url.query.get('filename', '')
    source = request.rel_url.query.get('source', 'input')

    if not filename:
        return server.web.json_response({"error": "Missing filename"}, status=400)

    # Build & validate full path
    if source == 'output':
        base_dir = folder_paths.get_output_directory()
    else:
        base_dir = folder_paths.get_input_directory()

    file_path = os.path.join(base_dir, filename.replace('/', os.sep))
    if not os.path.exists(file_path):
        return server.web.json_response({"error": "File not found"}, status=404)
    real_base = os.path.realpath(base_dir)
    real_path = os.path.realpath(file_path)
    if not real_path.startswith(real_base):
        return server.web.json_response({"error": "Invalid path"}, status=403)

    # Deterministic cache name in temp/
    import hashlib
    name_hash = hashlib.sha256(real_path.encode()).hexdigest()[:16]
    clip_name = f"_fbnodes_preview_{name_hash}.mp4"
    temp_dir = folder_paths.get_temp_directory()
    clip_path = os.path.join(temp_dir, clip_name)

    # If cached clip already exists (and source hasn't been modified), serve it
    if os.path.exists(clip_path):
        src_mtime = os.path.getmtime(real_path)
        clip_mtime = os.path.getmtime(clip_path)
        if clip_mtime >= src_mtime:
            return server.web.json_response({
                "filename": clip_name,
                "type": "temp",
                "subfolder": ""
            })

    try:
        # Extract first frame with PyAV
        img = extract_video_frame_av(file_path, 0.0)
        if img is None:
            return server.web.json_response({"error": "Frame extraction failed"}, status=500)

        if img.mode != 'RGB':
            img = img.convert('RGB')

        # Burn "H265/yuv444 — browser playback not supported" overlay onto the frame
        from PIL import ImageDraw, ImageFont
        draw = ImageDraw.Draw(img)
        w, h = img.size
        bar_height = max(28, int(h * 0.05))
        draw.rectangle([(0, h - bar_height), (w, h)], fill=(0, 0, 0, 180))
        font_size = max(12, int(bar_height * 0.5))
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()
        text = "H265/yuv444 \u2014 browser playback not supported"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        tx = (w - tw) // 2
        ty = h - bar_height + (bar_height - font_size) // 2
        draw.text((tx, ty), text, fill=(204, 204, 204), font=font)

        import numpy as np

        frame_np = np.array(img)
        height, width = frame_np.shape[:2]

        # Ensure even dimensions (H264 requirement)
        width = width if width % 2 == 0 else width - 1
        height = height if height % 2 == 0 else height - 1
        frame_np = frame_np[:height, :width]

        os.makedirs(temp_dir, exist_ok=True)

        # Write a 1-frame H264 mp4
        out_container = av.open(clip_path, mode='w')
        out_stream = out_container.add_stream('libx264', rate=1)
        out_stream.width = width
        out_stream.height = height
        out_stream.pix_fmt = 'yuv420p'
        out_stream.options = {'crf': '18', 'preset': 'ultrafast'}

        av_frame = av.VideoFrame.from_ndarray(frame_np, format='rgb24')
        for packet in out_stream.encode(av_frame):
            out_container.mux(packet)
        for packet in out_stream.encode():
            out_container.mux(packet)
        out_container.close()

        return server.web.json_response({
            "filename": clip_name,
            "type": "temp",
            "subfolder": ""
        })
    except Exception as e:
        print(f"[FBnodes] Error generating preview clip: {e}")
        return server.web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/fbnodes/list-files")
async def list_files(request):
    """List supported files in input or output directory, including subfolders."""
    try:
        source = request.rel_url.query.get('source', 'input')
        if source == 'output':
            base_dir = folder_paths.get_output_directory()
        else:
            base_dir = folder_paths.get_input_directory()

        files = []
        supported_extensions = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.mov', '.avi']

        if os.path.exists(base_dir):
            for root, dirs, filenames in os.walk(base_dir):
                for filename in filenames:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in supported_extensions:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, base_dir)
                        rel_path = rel_path.replace('\\', '/')
                        files.append(rel_path)

        files.sort()
        return server.web.json_response({"files": files})
    except Exception as e:
        print(f"[FBnodes] Error listing files: {e}")
        return server.web.json_response({"files": [], "error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def base64_to_tensor(base64_data):
    """Convert base64 data URL to ComfyUI tensor format."""
    try:
        if ',' in base64_data:
            base64_data = base64_data.split(',', 1)[1]

        img_bytes = base64.b64decode(base64_data)
        img = Image.open(io.BytesIO(img_bytes))

        if img.mode != 'RGB':
            img = img.convert('RGB')

        img_array = np.array(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_array).unsqueeze(0)
        return img_tensor
    except Exception as e:
        print(f"[FBnodes] Error converting base64 to tensor: {e}")
        return None


def get_cached_video_frame(relative_path, frame_position):
    """
    Retrieve cached video frame extracted by JavaScript at the specified position.
    """
    if frame_position is None:
        frame_position = 0.01

    path_key = relative_path.replace('\\', '/').replace('/', '_')

    if path_key not in _video_frames_cache:
        print(f"[FBnodes] Cache missing for: {relative_path} at position {frame_position}, requesting extraction...")

        try:
            server.PromptServer.instance.send_sync("better-image-loader-extract-frame", {
                "filename": relative_path,
                "frame_position": frame_position
            })

            max_wait = 5
            start_time = time.time()
            while path_key not in _video_frames_cache and (time.time() - start_time) < max_wait:
                time.sleep(0.1)

            if path_key in _video_frames_cache:
                print(f"[FBnodes] Frame cached successfully for: {relative_path}")
            else:
                print(f"[FBnodes] Timeout waiting for frame extraction: {relative_path}")
                return None
        except Exception as e:
            print(f"[FBnodes] Error requesting frame extraction: {e}")
            return None

    frame_data = _video_frames_cache[path_key]
    return base64_to_tensor(frame_data)


def load_image_as_tensor(file_path):
    """Load an image file and convert to ComfyUI tensor format (B, H, W, C).
    Returns (image_tensor, mask_tensor) tuple."""
    if not IMAGE_SUPPORT:
        return None, None
    try:
        from PIL import ImageOps, ImageSequence
        img = Image.open(file_path)

        output_images = []
        output_masks = []
        w, h = None, None

        for i in ImageSequence.Iterator(img):
            i = ImageOps.exif_transpose(i)

            if i.mode == 'I':
                i = i.point(lambda x: x * (1 / 255))
            image = i.convert("RGB")

            if len(output_images) == 0:
                w = image.size[0]
                h = image.size[1]

            if image.size[0] != w or image.size[1] != h:
                continue

            image_np = np.array(image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np)[None,]

            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            elif i.mode == 'P' and 'transparency' in i.info:
                mask = np.array(i.convert('RGBA').getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")

            output_images.append(image_tensor)
            output_masks.append(mask.unsqueeze(0))

            if img.format == "MPO":
                break

        if len(output_images) > 1:
            img_tensor = torch.cat(output_images, dim=0)
            mask_tensor = torch.cat(output_masks, dim=0)
        elif len(output_images) == 1:
            img_tensor = output_images[0]
            mask_tensor = output_masks[0]
        else:
            return None, None

        return img_tensor, mask_tensor
    except Exception as e:
        print(f"[FBnodes] Error loading image: {e}")
        return None, None


def get_placeholder_image_tensor():
    """Load the placeholder PNG as a tensor."""
    if not IMAGE_SUPPORT:
        return torch.zeros((1, 128, 128, 3), dtype=torch.float32)
    try:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        png_path = os.path.join(current_dir, '..', 'js', 'placeholder.png')

        if os.path.exists(png_path):
            return load_image_as_tensor(png_path)
    except Exception as e:
        print(f"[FBnodes] Could not load placeholder PNG: {e}")

    img_array = np.full((128, 128, 3), 42 / 255.0, dtype=np.float32)
    return torch.from_numpy(img_array).unsqueeze(0)


# ---------------------------------------------------------------------------
# Node class
# ---------------------------------------------------------------------------

class LoadImagePlus:
    """
    A streamlined image loader with file browser, preview, and input/output folder switching.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = ["(none)"]
        supported_extensions = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.mov', '.avi']

        if os.path.exists(input_dir):
            for root, dirs, filenames in os.walk(input_dir):
                for filename in filenames:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in supported_extensions:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, input_dir)
                        rel_path = rel_path.replace('\\', '/')
                        files.append(rel_path)

        files_to_sort = files[1:]
        files_to_sort.sort()
        files = ["(none)"] + files_to_sort

        return {
            "required": {
                "source_folder": (["input", "output"], {
                    "default": "input",
                    "tooltip": "Browse files from the input or output folder"
                }),
                "image": (files, {}),
                "frame_position": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "display": "slider"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "A better image/video loader with file browser, preview, and input/output folder switching."
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def load(self, image="", source_folder="input", frame_position=0.0, unique_id=None):
        if frame_position is None:
            frame_position = 0.0

        image_tensor = None

        if image is None:
            image = ""
        if image == "(none)":
            image = ""

        resolved_path = None
        file_path = ""
        if image and image.strip():
            file_path = image.strip()

            # Strip annotated filepath suffix from MaskEditor (e.g. "file.png [input]")
            if ' [' in file_path:
                file_path = file_path[:file_path.rindex(' [')]

            if not os.path.isabs(file_path):
                if source_folder == "output":
                    base_dir = folder_paths.get_output_directory()
                else:
                    base_dir = folder_paths.get_input_directory()
                potential_path = os.path.join(base_dir, file_path)
                if os.path.exists(potential_path):
                    resolved_path = potential_path
                else:
                    temp_dir = folder_paths.get_temp_directory()
                    potential_path = os.path.join(temp_dir, file_path)
                    if os.path.exists(potential_path):
                        resolved_path = potential_path
            else:
                if os.path.exists(file_path):
                    resolved_path = file_path

        mask_tensor = None

        if resolved_path:
            ext = os.path.splitext(resolved_path)[1].lower()

            if ext in ['.png', '.jpg', '.jpeg', '.webp']:
                image_tensor, mask_tensor = load_image_as_tensor(resolved_path)

            elif ext in ['.mp4', '.webm', '.mov', '.avi']:
                if source_folder == "output":
                    base_dir = folder_paths.get_output_directory()
                else:
                    base_dir = folder_paths.get_input_directory()
                if resolved_path.startswith(base_dir):
                    relative_path = os.path.relpath(resolved_path, base_dir)
                    relative_path = relative_path.replace('\\', '/')
                else:
                    relative_path = os.path.basename(resolved_path)

                # Prefer PyAV for frame extraction (accurate frame_position, handles H265/yuv444)
                image_tensor = extract_video_frame_av_to_tensor(resolved_path, frame_position)

                # Fall back to JS-cached frame if PyAV unavailable
                if image_tensor is None:
                    image_tensor = get_cached_video_frame(relative_path, frame_position)

                # Last resort: placeholder
                if image_tensor is None:
                    image_tensor = get_placeholder_image_tensor()

        if image_tensor is None:
            image_tensor = get_placeholder_image_tensor()

        if mask_tensor is None:
            mask_tensor = torch.zeros((64, 64), dtype=torch.float32, device="cpu").unsqueeze(0)

        preview_images = self._save_preview_images(image_tensor, mask_tensor)

        return {
            "ui": {"images": preview_images},
            "result": (image_tensor, mask_tensor)
        }

    def _save_preview_images(self, images, masks=None):
        import random
        results = []
        output_dir = folder_paths.get_temp_directory()

        if not hasattr(images, 'shape'):
            return results

        has_mask = (masks is not None and hasattr(masks, 'shape')
                    and masks.shape[-1] != 64 and masks.shape[-2] != 64)
        if has_mask:
            m = masks[0] if len(masks.shape) > 2 else masks
            if hasattr(m, 'cpu'):
                m = m.cpu()
            has_mask = m.max().item() > 0.01

        for i in range(images.shape[0]):
            img = images[i]
            if hasattr(img, 'cpu'):
                img = img.cpu().numpy()
            img = (img * 255).astype(np.uint8)
            pil_img = Image.fromarray(img)

            if has_mask and i < masks.shape[0]:
                mask = masks[i] if len(masks.shape) > 2 else masks
                if hasattr(mask, 'cpu'):
                    mask = mask.cpu().numpy()
                mask_uint8 = (mask * 255).astype(np.uint8)
                mask_pil = Image.fromarray(mask_uint8, mode='L')
                if mask_pil.size != pil_img.size:
                    mask_pil = mask_pil.resize(pil_img.size, Image.NEAREST)
                # Invert mask: masked regions become transparent (mask=1 means masked)
                alpha = 255 - mask_uint8
                alpha_pil = Image.fromarray(alpha, mode='L')
                if alpha_pil.size != pil_img.size:
                    alpha_pil = alpha_pil.resize(pil_img.size, Image.NEAREST)
                pil_img = pil_img.convert('RGBA')
                pil_img.putalpha(alpha_pil)
                # Save as PNG to preserve transparency

            filename = f"load_image_preview_{random.randint(0, 0xFFFFFF):06x}.png"
            filepath = os.path.join(output_dir, filename)
            pil_img.save(filepath)

            results.append({
                "filename": filename,
                "subfolder": "",
                "type": "temp"
            })

        return results

    @classmethod
    def IS_CHANGED(cls, image, source_folder="input", frame_position=0.0, **kwargs):
        mtime = "no_file"
        if image:
            file_path = image.strip()
            if not os.path.isabs(file_path):
                if source_folder == "output":
                    base_dir = folder_paths.get_output_directory()
                else:
                    base_dir = folder_paths.get_input_directory()
                potential_path = os.path.join(base_dir, file_path)
                if os.path.exists(potential_path):
                    mtime = os.path.getmtime(potential_path)
            elif os.path.exists(file_path):
                mtime = os.path.getmtime(file_path)

        return (mtime, source_folder, frame_position)
