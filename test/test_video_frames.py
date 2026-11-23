"""Frame-exact video extraction for Load Image+. Encodes a synthetic clip whose
frames each carry a distinct grey level, then checks every frame index decodes
to its own frame. Needs PyAV (a declared dependency)."""

import ast
from pathlib import Path
import tempfile
import unittest

import av
import numpy as np

SOURCE = Path(__file__).resolve().parents[1] / "nodes" / "load_image.py"
FUNCTIONS = {"video_clock", "frame_index_for", "extract_video_frame_av"}


def load_functions():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS], type_ignores=[])
    namespace = {}
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace


def grey(index):
    return 8 + (index * 3) % 240


def write_clip(path, frames, fps, codec, container_format=None):
    with av.open(str(path), "w", format=container_format) as container:
        stream = container.add_stream(codec, rate=fps)
        stream.width, stream.height = 64, 48
        stream.pix_fmt = "yuv420p"
        # Keyframes far apart, so most targets need a seek plus a forward decode.
        stream.gop_size = 48
        for index in range(frames):
            pixels = np.full((48, 64, 3), grey(index), dtype=np.uint8)
            for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


class VideoFrameTests(unittest.TestCase):
    def setUp(self):
        self.fn = load_functions()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def check_every_frame(self, path, frames):
        with av.open(str(path)) as container:
            fps, count, _origin = self.fn["video_clock"](container, container.streams.video[0])
        self.assertEqual(count, frames)
        for index in range(frames):
            image = self.fn["extract_video_frame_av"](str(path), index / count)
            self.assertIsNotNone(image, f"frame {index}")
            level = float(np.asarray(image.convert("L")).mean())
            self.assertLess(abs(level - grey(index)), 3, f"frame {index}: got level {level:.1f}, want {grey(index)}")

    def test_mp4_every_index_decodes_its_own_frame(self):
        path = Path(self.temp.name) / "clip.mp4"
        write_clip(path, 120, 24, "libx264")
        self.check_every_frame(path, 120)

    def test_webm_without_frame_count(self):
        path = Path(self.temp.name) / "clip.webm"
        write_clip(path, 60, 30, "libvpx-vp9")
        self.check_every_frame(path, 60)

    def test_positions_map_to_frames(self):
        index_for = self.fn["frame_index_for"]
        self.assertEqual(index_for(0.0, 1000), 0)
        self.assertEqual(index_for(991 / 1000, 1000), 991)
        self.assertEqual(index_for(992 / 1000, 1000), 992)
        self.assertEqual(index_for(1.0, 1000), 999)
        self.assertEqual(index_for(0.5, 0), 0)


if __name__ == "__main__":
    unittest.main()
