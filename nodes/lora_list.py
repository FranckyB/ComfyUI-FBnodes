"""
LoRA List+ - Build an ordered, toggleable list of LoRA paths and output as newline text.
Used with Outputlist Combiner the feed into Apply LoRA++ to test Loras.
"""

from __future__ import annotations

import json
import os
from typing import List

import folder_paths
import server


_WIN = os.name == "nt"


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
    roots = []

    # Preferred: configured LoRA directories from ComfyUI.
    try:
        for p in folder_paths.get_folder_paths("loras"):
            ap = _safe_abspath(p)
            if os.path.isdir(ap) and ap not in roots:
                roots.append(ap)
    except Exception:
        pass

    # Helpful fallbacks.
    for getter in (folder_paths.get_input_directory, folder_paths.get_output_directory):
        try:
            ap = _safe_abspath(getter())
            if os.path.isdir(ap) and ap not in roots:
                roots.append(ap)
        except Exception:
            pass

    # Last fallback: drives/root.
    if not roots:
        roots = _list_drives()

    return roots


def _is_safetensors(filename: str) -> bool:
    return filename.lower().endswith(".safetensors")


@server.PromptServer.instance.routes.get("/fbnodes/lora-browser/list")
async def lora_browser_list(request):
    """Read-only browser for directories and .safetensors files."""
    try:
        path = request.query.get("path", "").strip()
        roots = _get_default_roots()

        if not path:
            return server.web.json_response(
                {
                    "ok": True,
                    "mode": "roots",
                    "roots": roots,
                }
            )

        current = _safe_abspath(path)
        if not os.path.isdir(current):
            return server.web.json_response({"ok": False, "error": "Folder not found"}, status=404)

        dirs = []
        files = []

        try:
            entries = list(os.scandir(current))
        except PermissionError:
            return server.web.json_response({"ok": False, "error": "Access denied"}, status=403)

        for entry in entries:
            name = entry.name
            if name.startswith("."):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    dirs.append({"name": name, "path": _safe_abspath(entry.path)})
                elif entry.is_file(follow_symlinks=False) and _is_safetensors(name):
                    files.append({"name": name, "path": _safe_abspath(entry.path)})
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


class LoraListPlus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loras_state": ("STRING", {"default": "[]", "multiline": True}),
                "loras_text": ("STRING", {"default": "", "multiline": True}),
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "Build an ordered LoRA list with enable/disable and output enabled paths as multiline text.\nFor use with Outputlist Combiner for LoRA testing"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("loras", "names")
    FUNCTION = "build"
    OUTPUT_NODE = False

    def build(self, loras_state: str, loras_text: str):
        enabled_paths = []

        # Primary source: UI JSON state (preserves order + enable flags).
        try:
            parsed = json.loads(loras_state or "[]")
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    path = str(item.get("path", "")).strip()
                    enabled = bool(item.get("enabled", True))
                    if path and enabled:
                        enabled_paths.append(path)
        except Exception:
            pass

        # Fallback: user-provided multiline string.
        if not enabled_paths and isinstance(loras_text, str):
            enabled_paths = [line.strip() for line in loras_text.splitlines() if line.strip()]

        output = "\n".join(enabled_paths)
        output_basename = "\n".join(
            os.path.splitext(os.path.basename(path))[0]
            for path in enabled_paths
        )
        return {
            "ui": {"text": [output]},
            "result": (output, output_basename),
        }
