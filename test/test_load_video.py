"""Load Video+ trim: the time window that keeps frames in_frame..out_frame."""

import ast
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "nodes" / "load_video.py"


def load_trim_window():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "trim_window"], type_ignores=[])
    namespace = {}
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace["trim_window"]


class TrimWindowTests(unittest.TestCase):
    trim_window = staticmethod(load_trim_window())

    def frames_kept(self, fps, count, origin, in_frame, out_frame):
        start, duration = self.trim_window(fps, count, origin, in_frame, out_frame)
        return [i for i in range(count) if start <= origin + i / fps < start + duration]

    def test_keeps_the_frames_asked_for(self):
        self.assertEqual(self.frames_kept(24, 60, 0.0, 10, 20), list(range(10, 21)))

    def test_out_zero_runs_to_the_end(self):
        self.assertEqual(self.frames_kept(24, 60, 0.0, 50, 0), list(range(50, 60)))

    def test_single_frame(self):
        self.assertEqual(self.frames_kept(30000 / 1001, 60, 0.0, 30, 30), [30])

    def test_stream_start_offset(self):
        self.assertEqual(self.frames_kept(25, 40, 1.4, 0, 4), [0, 1, 2, 3, 4])

    def test_out_of_range_frames_are_clamped(self):
        self.assertEqual(self.frames_kept(24, 10, 0.0, 30, 500), [9])


if __name__ == "__main__":
    unittest.main()
