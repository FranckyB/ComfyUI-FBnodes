"""MiniMax-H3 AdaLN LoRA fix: rebase LoRA AdaLN weights between the dense and the
pruned (curve-form) H3 checkpoints, so they apply instead of being skipped with
"ERROR lora ... adaln_proj" lines. Adapted from ComfyUI-PlagueKind-Nodes (MIT,
see LICENSE in this folder)."""

from .patch import fix_model, format_report

__all__ = ["fix_model", "format_report"]
