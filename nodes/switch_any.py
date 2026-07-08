"""
ComfyUI Switch Any - A universal switch node with named inputs.
Selects one of up to 10 inputs to pass through. Non-selected inputs are
stripped from the execution graph so they are never evaluated by ComfyUI.
"""

import re


def _coerce_bool(value):
    """Normalize booleans from UI/runtime values (bool/int/str)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def parse_names(names_str, count):
    """Split a names string by comma or semicolon into a list of *count* names."""
    parts = re.split(r"[;,]", names_str)
    parts = [p.strip() for p in parts if p.strip()]
    # Pad with defaults if the user provided fewer names than count
    result = []
    for i in range(count):
        if i < len(parts):
            result.append(parts[i])
        else:
            result.append(f"Input {i + 1}")
    return result


class SwitchAny:
    """Universal switch node that passes through one of up to 10 named inputs."""

    @classmethod
    def INPUT_TYPES(cls):
        default_names = [f"Input {i + 1}" for i in range(10)]
        return {
            "required": {
                "select": (default_names, {"default": default_names[0]}),
                "num_inputs": ("INT", {
                    "default": 2, "min": 1, "max": 10, "step": 1,
                    "tooltip": "Number of active inputs (1-10)"
                }),
                "names": ("STRING", {
                    "default": "",
                    "placeholder": "WAN; FLUX; SDXL  (comma or semicolon separated)",
                    "tooltip": "Custom names for each input, separated by comma or semicolon"
                }),
            },
            "optional": {
                **{
                    f"input_{i + 1}": ("*", {"lazy": True})
                    for i in range(10)
                },
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "A Universal switch with up to 10 named inputs. With True Lazy Evaluation, only the selected input is evaluated. Other inputs are completely ignored by ComfyUI, allowing you to switch between different branches of your workflow without any performance cost from the inactive branches."
    RETURN_TYPES = ("*", "INT")
    RETURN_NAMES = ("output", "index")
    FUNCTION = "switch"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def check_lazy_status(self, select, num_inputs=2, names="", **kwargs):
        """Only request the single selected input — everything else stays dormant."""
        name_list = parse_names(names, num_inputs)
        for i, name in enumerate(name_list):
            if name == select:
                key = f"input_{i + 1}"
                # Only request if actually connected
                if key not in kwargs:
                    return []
                return [key]
        # Fallback: first input
        if "input_1" not in kwargs:
            return []
        return ["input_1"]

    def switch(self, select, num_inputs=2, names="", **kwargs):
        name_list = parse_names(names, num_inputs)
        for i, name in enumerate(name_list):
            if name == select:
                value = kwargs.get(f"input_{i + 1}")
                return (value, i + 1)
        return (None, 1)


class SwitchAnyBool:
    """Boolean switch node — passes through the on_true or on_false input based on a toggle."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "condition": ("BOOLEAN", {"default": True}),
                "on_true": ("*", {"lazy": True}),
                "on_false": ("*", {"lazy": True}),
            },
        }

    CATEGORY = "FBnodes"
    DESCRIPTION = "Boolean switch with true/false inputs. Only the active branch is evaluated."
    RETURN_TYPES = ("*", "BOOLEAN")
    RETURN_NAMES = ("output", "bool")
    FUNCTION = "switch"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def check_lazy_status(self, condition, on_true=None, on_false=None):
        condition = _coerce_bool(condition)
        if condition and on_true is None:
            return ["on_true"]
        if not condition and on_false is None:
            return ["on_false"]
        return []

    def switch(self, condition, on_true=None, on_false=None):
        condition = _coerce_bool(condition)
        # Explicitly force the inactive branch to None.
        on_true = on_true if condition else None
        on_false = on_false if not condition else None
        value = on_true if condition else on_false
        return (value, condition)
