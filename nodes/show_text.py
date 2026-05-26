'''
ShowTextPlus - A Show Text node, that, unlike preview as text, survives workflow reloads and tab switching
'''

import json


def _stringify(value):
    if isinstance(value, str):
        return value
    try:
        if isinstance(value, (dict, list, tuple, set)):
            return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        pass
    try:
        return str(value)
    except Exception:
        return "<unprintable>"


class ShowTextPlus:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # Accept any input type and convert to text internally.
                "text": ("*", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("STRING",)
    FUNCTION = "notify"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = (True,)

    CATEGORY = "FBnodes"
    DESCRIPTION = "Show any input as text. Input values are converted to strings and persisted with the workflow."

    def notify(self, text, unique_id=None, extra_pnginfo=None):
        text_out = [_stringify(t) for t in text] if isinstance(text, list) else [_stringify(text)]

        if unique_id is not None and extra_pnginfo is not None:
            if not isinstance(extra_pnginfo, list):
                print("Error: extra_pnginfo is not a list")
            elif (
                not isinstance(extra_pnginfo[0], dict)
                or "workflow" not in extra_pnginfo[0]
            ):
                print("Error: extra_pnginfo[0] is not a dict or missing 'workflow' key")
            else:
                workflow = extra_pnginfo[0]["workflow"]
                node = next(
                    (x for x in workflow["nodes"] if str(x["id"]) == str(unique_id[0])),
                    None,
                )
                if node:
                    node["widgets_values"] = [text_out]

        return {"ui": {"text": text_out}, "result": (text_out,)}
