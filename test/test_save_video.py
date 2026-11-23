"""Save Video+ Auto: the encoding picked from the incoming video."""

import ast
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "nodes" / "save_video.py"


def load_auto_encoding():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_auto_encoding"], type_ignores=[])
    namespace = {}
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace["_auto_encoding"]


class FakeVideo:
    def __init__(self, bit_depth=8, chroma=None):
        self.bit_depth = bit_depth
        self.chroma = chroma

    def get_bit_depth(self):
        return self.bit_depth

    def get_chroma_subsampling(self):
        return self.chroma


class AutoEncodingTests(unittest.TestCase):
    auto_encoding = staticmethod(load_auto_encoding())

    def test_unset_video_uses_defaults(self):
        self.assertEqual(self.auto_encoding(FakeVideo()), ("h264", "yuv420", 16))

    def test_ten_bit_video_uses_h265(self):
        self.assertEqual(self.auto_encoding(FakeVideo(10, "420")), ("h265", "yuv420", 16))

    def test_chroma_follows_video(self):
        self.assertEqual(self.auto_encoding(FakeVideo(8, "444"))[1], "yuv444")
        self.assertEqual(self.auto_encoding(FakeVideo(10, "422"))[1], "yuv422")


if __name__ == "__main__":
    unittest.main()
