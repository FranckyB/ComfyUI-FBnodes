"""
BetterImageLoader - A streamlined image/video loader with file browser and preview.
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
    print("[FBnodes] Warning: PIL/numpy not available, BetterImageLoader disabled")

# Cache for video frames extracted by JavaScript
_video_frames_cache = {}


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
    """Load an image file and convert to ComfyUI tensor format (B, H, W, C)."""
    if not IMAGE_SUPPORT:
        return None
    try:
        img = Image.open(file_path)
        if img.mode != 'RGB':
            img = img.convert('RGB')

        img_array = np.array(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_array).unsqueeze(0)
        return img_tensor
    except Exception as e:
        print(f"[FBnodes] Error loading image: {e}")
        return None


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

class BetterImageLoader:
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
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
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

        if resolved_path:
            ext = os.path.splitext(resolved_path)[1].lower()

            if ext in ['.png', '.jpg', '.jpeg', '.webp']:
                image_tensor = load_image_as_tensor(resolved_path)

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
                image_tensor = get_cached_video_frame(relative_path, frame_position)

                if image_tensor is None:
                    image_tensor = get_placeholder_image_tensor()

        if image_tensor is None:
            image_tensor = get_placeholder_image_tensor()

        preview_images = self._save_preview_images(image_tensor)

        return {
            "ui": {"images": preview_images},
            "result": (image_tensor,)
        }

    def _save_preview_images(self, images):
        import random
        results = []
        output_dir = folder_paths.get_temp_directory()

        for i in range(images.shape[0]):
            img = images[i]
            if hasattr(img, 'cpu'):
                img = img.cpu().numpy()
            img = (img * 255).astype(np.uint8)
            pil_img = Image.fromarray(img)

            filename = f"better_image_loader_preview_{random.randint(0, 0xFFFFFF):06x}.png"
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
