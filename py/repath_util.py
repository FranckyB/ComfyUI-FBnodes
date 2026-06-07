"""
ComfyUI-FBnodes - Missing model remap utility API.

This module is additive-only and does not modify existing node behavior.
It exposes a small API used by the frontend to remap missing model-like
widget values by exact basename match across known ComfyUI model folders.
"""

import os
import re
from collections import defaultdict

import folder_paths
import server


CATEGORY_FOLDERS = {
    "checkpoints_unet": ["checkpoints", "diffusion_models", "unet"],
    "latent_upscale": ["latent_upscale_models"],
    "loras": ["loras"],
    "text_encoders": ["text_encoders", "clip"],
    "vae": ["vae", "audio_vae"],
    "controlnet": ["controlnet"],
    "upscale_models": ["upscale_models"],
}

# Direct widget-name mapping when category is unambiguous.
DIRECT_WIDGET_CATEGORY = {
    "unet_name": "checkpoints_unet",
    "ckpt_name": "checkpoints_unet",
    "checkpoint_name": "checkpoints_unet",
    "checkpoint": "checkpoints_unet",
    "lora_name": "loras",
    "clip_name": "text_encoders",
    "text_encoder_name": "text_encoders",
    "text_encoder": "text_encoders",
    "vae_name": "vae",
    "audio_vae": "vae",
    "audio_vae_name": "vae",
    "controlnet_name": "controlnet",
    "control_net_name": "controlnet",
    "upscale_model": "upscale_models",
    "upscale_model_name": "upscale_models",
    "latent_upscale_model": "latent_upscale",
    "latent_upscale_model_name": "latent_upscale",
}

PRECISION_TOKENS = ("fp8", "fp16", "bf16")


def _normalize_rel_path(path):
    return str(path or "").strip().replace("\\", "/")


def _normalize_lookup_key(filename):
    return str(filename or "").strip().lower()


def _to_os_relative_path(path):
    """Convert normalized relative path to host OS separator style."""
    norm = _normalize_rel_path(path)
    if os.sep == "\\":
        return norm.replace("/", "\\")
    return norm


def _precision_fold_key(filename):
    """
    Fold precision tokens out of a filename while preserving extension.

    Examples:
    - flux-2-klein-9b-fp8.safetensors -> flux-2-klein-9b.safetensors
    - flux-2-klein-9b.safetensors -> flux-2-klein-9b.safetensors
    """
    value = _normalize_lookup_key(filename)
    base, ext = os.path.splitext(value)

    # Remove precision markers when they appear as standalone tokens.
    token_group = "|".join(PRECISION_TOKENS)
    pattern = rf"(^|[._-])(?:{token_group})(?=($|[._-]))"
    folded = re.sub(pattern, r"\1", base, flags=re.IGNORECASE)

    # Normalize leftover separator noise after removals.
    folded = re.sub(r"[._-]+", "-", folded).strip("-")
    return f"{folded}{ext}"


def _find_precision_variant_matches(category_index, basename_key):
    """
    Find candidate files equivalent under precision-token folding.

    This is a fallback only after exact basename matching fails.
    """
    folded_target = _precision_fold_key(basename_key)
    matches = set()

    for candidate_key, candidate_paths in category_index.items():
        if candidate_key == basename_key:
            continue
        if _precision_fold_key(candidate_key) == folded_target:
            matches.update(candidate_paths)

    return sorted(matches)


def _version_fold_key(filename):
    """
    Fold explicit version tokens out of a filename while preserving extension.

    Supported version tokens: v1, v2.1, v1_4, v1-4, ver3, version4.
    """
    value = _normalize_lookup_key(filename)
    base, ext = os.path.splitext(value)

    # Match explicit version markers, including multi-part forms separated
    # by dot/underscore/hyphen (e.g. v1_4, version2-1, ver3.5).
    pattern = r"(^|[._-])(?:v|ver|version)\d+(?:[._-]\d+)*(?=($|[._-]))"
    folded = re.sub(pattern, r"\1", base, flags=re.IGNORECASE)

    folded = re.sub(r"[._-]+", "-", folded).strip("-")
    return f"{folded}{ext}"


def _find_version_variant_matches(category_index, basename_key):
    """
    Find candidate files equivalent under version-token folding.

    This fallback is applied after exact and precision-token matching.
    """
    # Use precision-folded keys so version fallback can still match fp variants.
    folded_target = _version_fold_key(_precision_fold_key(basename_key))
    matches = set()

    for candidate_key, candidate_paths in category_index.items():
        if candidate_key == basename_key:
            continue
        folded_candidate = _version_fold_key(_precision_fold_key(candidate_key))
        if folded_candidate == folded_target:
            matches.update(candidate_paths)

    return sorted(matches)


def _is_unsafe_path(value):
    """Reject absolute and traversal-like values."""
    raw = str(value or "").strip()
    norm = _normalize_rel_path(raw)

    if not norm:
        return True

    if os.path.isabs(raw) or os.path.isabs(norm):
        return True

    parts = [p for p in norm.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return True

    return False


def _is_resolvable(folder_types, rel_value):
    for folder_type in folder_types:
        try:
            full = folder_paths.get_full_path(folder_type, rel_value)
        except Exception:
            full = None
        if full and os.path.exists(full):
            return True
    return False


def _build_category_index(folder_types):
    """
    Build exact basename -> [relative_path] index for a logical category.
    Paths are slash-normalized and sorted for deterministic output.
    """
    by_basename = defaultdict(set)

    def _add_relative_file(rel_file):
        rel_norm = _normalize_rel_path(rel_file)
        if not rel_norm:
            return
        basename = os.path.basename(rel_norm)
        key = _normalize_lookup_key(basename)
        if not key:
            return
        by_basename[key].add(rel_norm)

    for folder_type in folder_types:
        try:
            rel_files = folder_paths.get_filename_list(folder_type)
        except Exception:
            continue

        for rel_file in rel_files:
            _add_relative_file(rel_file)

        # Explicit recursive fallback for deeply nested files.
        try:
            root_paths = folder_paths.get_folder_paths(folder_type)
        except Exception:
            root_paths = []

        for root_path in root_paths:
            if not root_path or not os.path.isdir(root_path):
                continue

            for walk_root, _dirs, files in os.walk(root_path):
                for file_name in files:
                    full_path = os.path.join(walk_root, file_name)
                    try:
                        rel_file = os.path.relpath(full_path, root_path)
                    except Exception:
                        continue
                    _add_relative_file(rel_file)

    return {k: sorted(v) for k, v in by_basename.items()}


def _build_all_indexes():
    indexes = {}
    for category, folder_types in CATEGORY_FOLDERS.items():
        indexes[category] = _build_category_index(folder_types)
    return indexes


def _infer_category(widget_name, node_type, value=None, value_field=None):
    widget_key = str(widget_name or "").strip().lower()
    node_type_l = str(node_type or "").strip().lower()
    node_type_compact = node_type_l.replace(" ", "").replace("_", "")
    value_l = str(value or "").strip().lower().replace("\\", "/")
    value_base = os.path.basename(value_l)
    value_field_l = str(value_field or "").strip().lower()

    is_latent_upscale_node = (
        ("latent" in node_type_l and "upscale" in node_type_l)
        or "loadlatentupscalemodel" in node_type_compact
    )

    if value_field_l == "lora":
        return "loras"

    direct = DIRECT_WIDGET_CATEGORY.get(widget_key)
    if direct:
        return direct

    # Handle ambiguous fields by node type hints.
    if widget_key == "model_name":
        if is_latent_upscale_node:
            return "latent_upscale"
        if "control" in node_type_l:
            return "controlnet"
        if "upscale" in node_type_l:
            return "upscale_models"
        if "unet" in node_type_l or "checkpoint" in node_type_l or "diffusion" in node_type_l:
            return "checkpoints_unet"

        # Value-based hints for nodes whose type names don't contain clear category tokens.
        if "upscaler" in value_base or "upscale" in value_base:
            return "latent_upscale"

    if widget_key == "model":
        if is_latent_upscale_node:
            return "latent_upscale"
        if "upscale" in node_type_l:
            return "upscale_models"
        if "unet" in node_type_l or "checkpoint" in node_type_l:
            return "checkpoints_unet"

        # Same fallback for generic model fields.
        if "upscaler" in value_base or "upscale" in value_base:
            return "latent_upscale"

    # rgthree Power Lora Loader uses dynamic lora_* inputs.
    if widget_key.startswith("lora_") and "power lora" in node_type_l:
        return "loras"

    return None


def remap_missing_assets(nodes_payload):
    """
    Remap missing model-like widget values by exact basename match.

    Args:
        nodes_payload: list of dicts, each containing:
            - id: node id
            - type: node class/type name
            - widgets: [{name, value}, ...]

    Returns:
        dict summary and per-widget decisions.
    """
    indexes = _build_all_indexes()
    updates = []

    stats = {
        "scanned": 0,
        "remapped": 0,
        "unchanged": 0,
        "unresolved": 0,
        "ambiguous": 0,
    }

    for node in nodes_payload:
        node_id = node.get("id")
        node_type = node.get("type") or ""
        widgets = node.get("widgets") or []

        for widget in widgets:
            widget_name = widget.get("name")
            value = widget.get("value")
            value_field = widget.get("value_field")

            if not isinstance(value, str):
                continue

            category = _infer_category(widget_name, node_type, value, value_field)
            if not category:
                continue

            old_value = value
            rel_value = _normalize_rel_path(value)
            if not rel_value:
                continue

            stats["scanned"] += 1

            if _is_unsafe_path(rel_value):
                stats["unresolved"] += 1
                updates.append({
                    "node_id": node_id,
                    "node_type": node_type,
                    "widget_name": widget_name,
                    "value_field": value_field,
                    "category": category,
                    "status": "unresolved",
                    "old_value": old_value,
                    "reason": "unsafe_path",
                })
                continue

            folder_types = CATEGORY_FOLDERS.get(category, [])

            # Keep existing valid values unchanged.
            if _is_resolvable(folder_types, rel_value):
                stats["unchanged"] += 1
                updates.append({
                    "node_id": node_id,
                    "node_type": node_type,
                    "widget_name": widget_name,
                    "value_field": value_field,
                    "category": category,
                    "status": "unchanged",
                    "old_value": old_value,
                    "new_value": _to_os_relative_path(rel_value),
                    "reason": "already_resolvable",
                })
                continue

            basename = os.path.basename(rel_value)
            basename_key = _normalize_lookup_key(basename)
            category_index = indexes.get(category, {})
            matches = category_index.get(basename_key, [])
            match_reason = "exact_basename"
            ambiguous_reason = "duplicate_exact_basename"

            # Conservative fuzzy fallback: precision-token equivalents only.
            if len(matches) == 0:
                matches = _find_precision_variant_matches(category_index, basename_key)
                if len(matches) > 0:
                    match_reason = "precision_variant_equivalent"
                    ambiguous_reason = "duplicate_or_multiple_precision_variants"

            # Secondary fuzzy fallback: explicit version-token equivalents.
            if len(matches) == 0:
                matches = _find_version_variant_matches(category_index, basename_key)
                if len(matches) > 0:
                    match_reason = "version_variant_equivalent"
                    ambiguous_reason = "duplicate_or_multiple_version_variants"

            if len(matches) == 1:
                new_value = matches[0]
                stats["remapped"] += 1
                updates.append({
                    "node_id": node_id,
                    "node_type": node_type,
                    "widget_name": widget_name,
                    "value_field": value_field,
                    "category": category,
                    "status": "remapped",
                    "old_value": old_value,
                    "new_value": _to_os_relative_path(new_value),
                    "reason": match_reason,
                })
            elif len(matches) > 1:
                stats["ambiguous"] += 1
                updates.append({
                    "node_id": node_id,
                    "node_type": node_type,
                    "widget_name": widget_name,
                    "value_field": value_field,
                    "category": category,
                    "status": "ambiguous",
                    "old_value": old_value,
                    "matches": matches,
                    "reason": ambiguous_reason,
                })
            else:
                stats["unresolved"] += 1
                updates.append({
                    "node_id": node_id,
                    "node_type": node_type,
                    "widget_name": widget_name,
                    "value_field": value_field,
                    "category": category,
                    "status": "unresolved",
                    "old_value": old_value,
                    "reason": "basename_not_found",
                })

    return {
        "success": True,
        "stats": stats,
        "updates": updates,
    }


@server.PromptServer.instance.routes.post("/fbnodes/remap_missing_assets")
async def remap_missing_assets_api(request):
    try:
        body = await request.json()
        nodes = body.get("nodes", [])
        if not isinstance(nodes, list):
            return server.web.json_response(
                {"success": False, "error": "Invalid payload: nodes must be a list"},
                status=400,
            )

        result = remap_missing_assets(nodes)
        return server.web.json_response(result)
    except Exception as exc:
        return server.web.json_response(
            {"success": False, "error": str(exc)},
            status=500,
        )
