"""
Shared media path browser API for FBnodes Load+ nodes.

Provides a read-only directory browser that can navigate arbitrary folders
(like the LoRA List browser) plus a path-guarded raw-file route so previews
work for media that lives outside ComfyUI's input/output/temp trees.

Routes:
  GET /fbnodes/path-browser/list?path=&kind=   directory + media file listing
  GET /fbnodes/path-browser/file?path=         serve a single media file
"""

from __future__ import annotations

import os
from typing import List

import folder_paths
import server


_WIN = os.name == "nt"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".wmv"}
AUDIO_EXTS = {".wav", ".flac", ".mp3", ".m4a", ".ogg", ".aac", ".opus"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS
_MEDIA_META_CACHE = {}


def _safe_abspath(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))


def _list_drives() -> List[str]:
    if not _WIN:
        return ["/"]
    drives = []
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        drive = f"{letter}:\\"
        if os.path.exists(drive):
            drives.append(drive)
    return drives


def _get_default_roots() -> List[str]:
    """Preset roots offered by the browser: input, output, then drive fallbacks."""
    roots: List[str] = []
    for getter in (folder_paths.get_input_directory, folder_paths.get_output_directory):
        try:
            ap = _safe_abspath(getter())
            if os.path.isdir(ap) and ap not in roots:
                roots.append(ap)
        except Exception:
            pass

    if not roots:
        roots = _list_drives()

    return roots


def _exts_for_kind(kind: str) -> set:
    kind = (kind or "media").lower()
    if kind == "image":
        return IMAGE_EXTS
    if kind == "video":
        return VIDEO_EXTS
    if kind == "audio":
        return AUDIO_EXTS
    if kind == "audiovideo":
        return AUDIO_EXTS | VIDEO_EXTS
    if kind == "all":
        return ALL_MEDIA_EXTS
    # Default "media" = images + videos.
    return IMAGE_EXTS | VIDEO_EXTS


def _probe_media_meta(file_path: str, ext: str) -> dict:
    """Probe media metadata (duration, width, height) for audio/video files."""
    if ext not in VIDEO_EXTS and ext not in AUDIO_EXTS:
        return {"duration": None, "width": None, "height": None}

    try:
        st = os.stat(file_path)
        cache_key = (file_path, int(st.st_mtime), int(st.st_size))
    except OSError:
        return {"duration": None, "width": None, "height": None}

    cached = _MEDIA_META_CACHE.get(cache_key)
    if cached is not None:
        return cached

    meta = {"duration": None, "width": None, "height": None}

    try:
        import av

        container = av.open(file_path)
        try:
            if container.duration:
                meta["duration"] = float(container.duration) / 1_000_000.0

            if ext in VIDEO_EXTS:
                stream = next((s for s in container.streams if s.type == "video"), None)
                if stream is not None:
                    if stream.width:
                        meta["width"] = int(stream.width)
                    if stream.height:
                        meta["height"] = int(stream.height)
                    if stream.duration is not None and stream.time_base is not None:
                        meta["duration"] = float(stream.duration * stream.time_base)
                    elif stream.frames and stream.average_rate:
                        fps = float(stream.average_rate)
                        if fps > 0:
                            meta["duration"] = float(stream.frames) / fps
            else:
                stream = next((s for s in container.streams if s.type == "audio"), None)
                if stream is not None and stream.duration is not None and stream.time_base is not None:
                    meta["duration"] = float(stream.duration * stream.time_base)
        finally:
            container.close()
    except Exception:
        pass

    if meta["duration"] is not None and meta["duration"] < 0:
        meta["duration"] = None

    _MEDIA_META_CACHE[cache_key] = meta
    return meta


@server.PromptServer.instance.routes.get("/fbnodes/path-browser/list")
async def path_browser_list(request):
    """Read-only browser for directories and media files under any path."""
    try:
        path = request.query.get("path", "").strip()
        kind = request.query.get("kind", "media").strip()
        allowed_exts = _exts_for_kind(kind)
        roots = _get_default_roots()

        if not path:
            return server.web.json_response(
                {"ok": True, "mode": "roots", "roots": roots}
            )

        current = _safe_abspath(path)
        if not os.path.isdir(current):
            return server.web.json_response(
                {"ok": False, "error": "Folder not found"}, status=404
            )

        dirs = []
        files = []

        try:
            entries = list(os.scandir(current))
        except PermissionError:
            return server.web.json_response(
                {"ok": False, "error": "Access denied"}, status=403
            )

        for entry in entries:
            name = entry.name
            if name.startswith("."):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    dirs.append({"name": name, "path": _safe_abspath(entry.path)})
                elif entry.is_file(follow_symlinks=False):
                    ext = os.path.splitext(name)[1].lower()
                    if ext in allowed_exts:
                        size = None
                        modified = None
                        duration = None
                        width = None
                        height = None
                        try:
                            st = entry.stat(follow_symlinks=False)
                            size = int(st.st_size)
                            modified = float(st.st_mtime)
                        except OSError:
                            pass

                        media_meta = _probe_media_meta(entry.path, ext)
                        duration = media_meta.get("duration")
                        width = media_meta.get("width")
                        height = media_meta.get("height")

                        files.append(
                            {
                                "name": name,
                                "path": _safe_abspath(entry.path),
                                "size": size,
                                "modified": modified,
                                "duration": duration,
                                "width": width,
                                "height": height,
                            }
                        )
            except OSError:
                continue

        dirs.sort(key=lambda x: x["name"].lower())
        files.sort(key=lambda x: x["name"].lower())

        parent = os.path.dirname(current.rstrip("\\/"))
        parent_path = parent if parent and parent != current else None

        return server.web.json_response(
            {
                "ok": True,
                "mode": "browse",
                "current_path": current,
                "parent_path": parent_path,
                "roots": roots,
                "dirs": dirs,
                "files": files,
            }
        )
    except Exception as e:
        return server.web.json_response({"ok": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/fbnodes/path-browser/file")
async def path_browser_file(request):
    """Serve a single media file by absolute path (extension-guarded)."""
    try:
        path = request.query.get("path", "").strip()
        if not path:
            return server.web.json_response(
                {"ok": False, "error": "Missing path"}, status=400
            )

        real_path = os.path.realpath(_safe_abspath(path))

        if not os.path.isfile(real_path):
            return server.web.json_response(
                {"ok": False, "error": "File not found"}, status=404
            )

        # Only ever serve known media extensions, never arbitrary files.
        ext = os.path.splitext(real_path)[1].lower()
        if ext not in ALL_MEDIA_EXTS:
            return server.web.json_response(
                {"ok": False, "error": "Unsupported file type"}, status=403
            )

        headers = {"Cache-Control": "no-cache"}
        return server.web.FileResponse(real_path, headers=headers)
    except Exception as e:
        return server.web.json_response({"ok": False, "error": str(e)}, status=500)
