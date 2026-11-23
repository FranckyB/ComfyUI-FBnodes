"""
Load Video+ - Video loader with file browser, preview, and input/output folder switching.
Outputs VIDEO type for use with Get Video Components+.
"""
import os

import av

import folder_paths

from comfy_api.input_impl import VideoFromFile

from .load_image import video_clock

VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.wmv']

# Small black H.264 placeholder clip shipped alongside the frontend.
_PLACEHOLDER_VIDEO_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "js",
    "placeholder.mp4",
)


def trim_window(fps, count, origin, in_frame, out_frame):
    """(start_time, duration) for VideoFromFile that keeps frames in_frame to
    out_frame (inclusive; out 0 = the last frame). Frame i sits i / fps after
    the stream's start (as in Load Image+); half a frame of slack on each side
    keeps rounded timestamps inside."""
    last = count - 1 if out_frame <= 0 else min(out_frame, count - 1)
    first = max(0, min(in_frame, last))
    start = max(0.0, origin + (first - 0.5) / fps)
    return start, origin + (last + 0.5) / fps - start


def trimmed_video(path, in_frame, out_frame):
    with av.open(path) as container:
        fps, count, origin = video_clock(container, container.streams.video[0])
    if fps <= 0 or count <= 0:
        return VideoFromFile(path)
    start, duration = trim_window(fps, count, origin, int(in_frame), int(out_frame))
    return VideoFromFile(path, start_time=start, duration=duration)


class LoadVideoPlus:
    """
    A video loader with file browser, preview, and input/output folder switching.
    Outputs VIDEO for use with Get Video Components+.
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = ["(none)", "(blank)"]

        if os.path.exists(input_dir):
            for root, dirs, filenames in os.walk(input_dir):
                for filename in filenames:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in VIDEO_EXTENSIONS:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, input_dir)
                        rel_path = rel_path.replace('\\', '/')
                        files.append(rel_path)

        files_to_sort = files[2:]
        files_to_sort.sort()
        files = ["(none)", "(blank)"] + files_to_sort

        return {
            "required": {
                "source_folder": (["input", "output"], {
                    "default": "input",
                    "tooltip": "Browse files from the input or output folder"
                }),
                # No video_upload: the node's own card uploads (drop a file) and
                # plays the video; the core upload widget would add a second player.
                "video": (files, {}),
            },
            "optional": {
                "trim": ("BOOLEAN", {"default": False, "tooltip": "Load only the frames from in_frame to out_frame."}),
                "in_frame": ("INT", {"default": 0, "min": 0, "max": 1_000_000, "tooltip": "First frame of the clip (0 = the first)."}),
                "out_frame": ("INT", {"default": 0, "min": 0, "max": 1_000_000, "tooltip": "Last frame of the clip, included (0 = to the end)."}),
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

    @staticmethod
    def _parse_video_path(video):
        """Strip [input]/[output] annotation from video path if present."""
        import re
        match = re.match(r'^(.+?)\s*\[(input|output|temp)\]\s*$', video)
        if match:
            return match.group(1).strip(), match.group(2)
        return video.strip(), None

    def load(self, video="", source_folder="input", trim=False, in_frame=0, out_frame=0, unique_id=None):
        if not video or video == "(none)":
            return (None,)

        if video == "(blank)":
            return (VideoFromFile(_PLACEHOLDER_VIDEO_PATH),)

        file_path, annotated_type = self._parse_video_path(video)
        if annotated_type:
            source_folder = annotated_type

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
            # File missing (e.g. restored workflow referencing a deleted video).
            # Don't error - behave like (blank) so downstream nodes still run.
            print(f"[LoadVideoPlus] Video file not found, using placeholder: {file_path}")
            return (VideoFromFile(_PLACEHOLDER_VIDEO_PATH),)

        if trim:
            return (trimmed_video(resolved_path, in_frame, out_frame),)
        return (VideoFromFile(resolved_path),)

    @classmethod
    def IS_CHANGED(cls, video="", source_folder="input", **kwargs):
        if not video or video == "(none)":
            return "none"
        if video == "(blank)":
            return "blank"

        import re
        match = re.match(r'^(.+?)\s*\[(input|output|temp)\]\s*$', video)
        if match:
            file_path = match.group(1).strip()
            source_folder = match.group(2)
        else:
            file_path = video.strip()

        if not os.path.isabs(file_path):
            if source_folder == "output":
                base_dir = folder_paths.get_output_directory()
            else:
                base_dir = folder_paths.get_input_directory()
            potential_path = os.path.join(base_dir, file_path)
            if os.path.exists(potential_path):
                return os.path.getmtime(potential_path)
            temp_dir = folder_paths.get_temp_directory()
            potential_path = os.path.join(temp_dir, file_path)
            if os.path.exists(potential_path):
                return os.path.getmtime(potential_path)
        elif os.path.exists(file_path):
            return os.path.getmtime(file_path)
        return ""
