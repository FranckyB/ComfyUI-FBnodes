"""Save Video+ Auto: saving through ComfyUI's own encoder."""

import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "nodes" / "save_video.py"


class FakeComponents:
    pass


def load_functions():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("_native_target", "_native_metadata")], type_ignores=[])
    namespace = {"json": json, "InputImpl": SimpleNamespace(VideoFromComponents=FakeComponents)}
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace


class NativeSaveTests(unittest.TestCase):
    functions = load_functions()

    def test_unencoded_video_gets_crf_16(self):
        self.assertEqual(self.functions["_native_target"](FakeComponents()), ("mp4", 16))

    def test_json_text_is_not_encoded_twice(self):
        metadata = self.functions["_native_metadata"]({"workflow": json.dumps({"nodes": []}), "prompt": {"1": {}}, "note": "plain"})
        self.assertEqual(metadata, {"workflow": {"nodes": []}, "prompt": {"1": {}}, "note": "plain"})


if __name__ == "__main__":
    unittest.main()
