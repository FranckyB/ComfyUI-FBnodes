"""
Load Video+ - Video loader with file browser, preview, and input/output folder switching.
Outputs VIDEO type for use with Get Video Components+.
"""
import os
import hashlib

import folder_paths

from comfy_api.input_impl import VideoFromFile

VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.wmv']


class LoadVideoPlus:
    """
    A video loader with file browser, preview, and input/output folder switching.
    Outputs VIDEO for use with Get Video Components+.
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = ["(none)"]

        if os.path.exists(input_dir):
            for root, dirs, filenames in os.walk(input_dir):
                for filename in filenames:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in VIDEO_EXTENSIONS:
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
                "video": (files, {"video_upload": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "Video loader with file browser, preview, and input/output folder switching. Outputs VIDEO for Get Video Components+."
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "load"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def load(self, video="", source_folder="input", unique_id=None):
        if not video or video == "(none)":
            raise ValueError("No video file selected. Please select a video using the file browser.")

        file_path = video.strip()
        resolved_path = None

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

        if not resolved_path:
            raise FileNotFoundError(f"Video file not found: {file_path}")

        return (VideoFromFile(resolved_path),)

    @classmethod
    def IS_CHANGED(cls, video="", source_folder="input", **kwargs):
        if not video or video == "(none)":
            return ""
        file_path = video.strip()
        if not os.path.isabs(file_path):
            if source_folder == "output":
                base_dir = folder_paths.get_output_directory()
            else:
                base_dir = folder_paths.get_input_directory()
            potential_path = os.path.join(base_dir, file_path)
            if os.path.exists(potential_path):
                return os.path.getmtime(potential_path)
        elif os.path.exists(file_path):
            return os.path.getmtime(file_path)
        return ""
