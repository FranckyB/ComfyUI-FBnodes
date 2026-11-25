"""Dependency-free adapter tests. Core image codecs are mocked, not exercised."""

import ast
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import time
import uuid
from datetime import datetime
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock


SOURCE = Path(__file__).resolve().parents[1] / "nodes" / "save_image.py"


class FakeImage:
    shape = (32, 48, 3)

    def unsqueeze(self, dimension):
        return [self]


class FakePngInfo:
    def __init__(self):
        self.text = {}

    def add_text(self, key, value):
        self.text[key] = value


class SaveImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "output"
        self.preview = Path(self.temp.name) / "temp"
        self.output.mkdir()
        self.preview.mkdir()
        self.pil_saves = []

        def save_pil(path, **kwargs):
            Path(path).write_bytes(b"mock PNG")
            self.pil_saves.append((Path(path), kwargs))

        def save_avif(images, path, *args, **kwargs):
            Path(path).write_bytes(b"mock AVIF")

        self.env = {
            "os": os, "re": re, "json": json, "datetime": datetime,
            "PngInfo": FakePngInfo, "args": SimpleNamespace(disable_metadata=False),
            "_tensor_to_pil": Mock(return_value=SimpleNamespace(save=save_pil)),
            "_encode_image": Mock(return_value=b"encoded"),
            "_save_avif": Mock(side_effect=save_avif),
            "inject_png_metadata": Mock(return_value=b"PNG metadata"),
            "inject_exr_metadata": Mock(return_value=b"EXR metadata"),
            "folder_paths": SimpleNamespace(
                get_output_directory=lambda: str(self.output),
                get_temp_directory=lambda: str(self.preview),
                get_save_image_path=lambda *args: (str(self.output), "image", 1, "", "image"),
            ),
            "uuid": uuid, "threading": threading, "time": time, "shutil": shutil,
            "_REVIEW_LOCK": threading.Lock(), "_PENDING_REVIEWS": {},
            "comfy": SimpleNamespace(model_management=SimpleNamespace(throw_exception_if_processing_interrupted=lambda: None)),
            "server": SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(send_sync=self.send_sync))),
        }
        # The review dialog's answer, given as soon as the review is announced.
        self.events = []
        self.answer = None
        tree = ast.parse(SOURCE.read_text())
        selected = [node for node in tree.body if
                    isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in ("SaveImagePlus", "_expand_date_format", "_expand_elapsed", "expand_name_tokens", "_wait_for_review")
                    or isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "IMAGE_FORMAT_OPTIONS" for target in node.targets)]
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"), self.env)
        self.node = self.env["SaveImagePlus"]()
        self.images = [FakeImage(), FakeImage()]

    def send_sync(self, event, data):
        self.events.append((event, data))
        if event == "fbnodes.save_image.review" and self.answer is not None:
            item = self.env["_PENDING_REVIEWS"][data["request_id"]]
            item["selected"] = self.answer
            item["event"].set()

    def test_review_moves_only_picked_images_to_output(self):
        self.answer = [0, 2]
        result = self.node.save_images([FakeImage(), FakeImage(), FakeImage()], "prefix", review=True, review_timeout=0)
        announced = self.events[0][1]
        self.assertEqual([info["type"] for info in announced["images"]], ["temp"] * 3)
        self.assertEqual([info["filename"] for info in result["ui"]["saved_images"]], ["image_00001.png", "image_00002.png"])
        self.assertTrue(all(info["type"] == "output" for info in result["ui"]["saved_images"]))
        self.assertEqual(result["result"], ("image_00002.png",))
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), ["image_00001.png", "image_00002.png"])
        # The image left out stays in temp; nothing waits in the registry.
        self.assertTrue((self.preview / announced["images"][1]["filename"]).exists())
        self.assertEqual(self.events[-1], ("fbnodes.save_image.review_done", {"request_id": announced["request_id"], "outcome": "decided"}))
        self.assertEqual(self.env["_PENDING_REVIEWS"], {})

    def test_skipped_review_saves_nothing_and_leaves_the_view(self):
        self.answer = []
        result = self.node.save_images(self.images, "prefix", review=True, review_timeout=0)
        self.assertEqual(list(self.output.iterdir()), [])
        # No ui: the node keeps showing its last images.
        self.assertEqual(result, {"result": ("",)})

    def test_review_timeout_saves_everything(self):
        result = self.node.save_images(self.images, "prefix", review=True, review_timeout=1)
        self.assertEqual(self.events[-1][1]["outcome"], "timeout")
        self.assertEqual(len(list(self.output.iterdir())), 2)
        self.assertEqual([info["type"] for info in result["ui"]["saved_images"]], ["output"] * 2)

    def test_elapsed_token_counts_from_queue(self):
        result = self.node.save_images(self.images[:1], "run_%elapsed%s", exec_start=str(time.time() - 42))
        self.assertEqual(result["result"], ("image_00001.png",))
        self.assertEqual(self.env["_expand_elapsed"]("run_%elapsed%s", str(time.time() - 42)), "run_42s")
        self.assertEqual(self.env["_expand_elapsed"]("run_%elapsed%s", ""), "run_0s")

    def test_date_and_time_tokens(self):
        name = self.env["expand_name_tokens"]("%date%/img_%time%", 48, 32, "")
        self.assertRegex(name, r"^\d{2}-\d{2}-\d{2}/img_\d{2}-\d{2}-\d{2}$")

    def test_name_tokens_expand_for_previews_too(self):
        result = self.node.save_images(self.images[:1], "dir/shot_%year%-%yy%-%month%_%width%x%height%", save=False)
        name = result["result"][0]
        self.assertRegex(name, r"^shot_(\d{2})(\d{2})-\2-\d{2}_48x32\.png$")
        self.assertEqual(self.node.INPUT_TYPES()["required"]["filename_prefix"][1]["default"], "Pics/%date%/img_%time%")

    def test_review_is_skipped_when_not_saving(self):
        self.node.save_images(self.images, "prefix", save=False, review=True)
        self.assertEqual(self.events, [])

    def test_legacy_schema_signature_defaults_and_metadata(self):
        schema = self.node.INPUT_TYPES()
        self.assertEqual(list(schema["required"]), ["images", "filename_prefix", "save"])
        # New inputs are only ever appended, so saved widgets_values keep their places.
        self.assertEqual(list(schema["optional"]), ["Compare", "format", "bit_depth", "input_color_space", "crf", "review", "review_timeout", "exec_start"])
        self.assertEqual(list(inspect.signature(self.node.save_images).parameters)[:6],
                         ["images", "filename_prefix", "save", "Compare", "prompt", "extra_pnginfo"])
        result = self.node.save_images(self.images, "old", True, self.images, {"node": 1}, {"workflow": {"id": 2}})
        self.assertEqual(result["result"], ("image_00002.png",))
        self.assertEqual(result["ui"]["compare_paired"], [True])
        self.assertEqual(json.loads(self.pil_saves[0][1]["pnginfo"].text["workflow"]), {"id": 2})
        self.env["_encode_image"].assert_not_called()

    def test_png16_delegates_encoding_and_metadata(self):
        result = self.node.save_images(self.images[:1], "prefix", format="png", bit_depth="16-bit", prompt={"id": 1})
        self.env["_encode_image"].assert_called_once_with(self.images[0], "png", "16-bit", "sRGB")
        self.env["inject_png_metadata"].assert_called_once_with(b"encoded", {"id": 1}, None)
        self.assertEqual((self.output / result["result"][0]).read_bytes(), b"PNG metadata")

    def test_exr_returns_actual_file_and_separate_temp_preview(self):
        result = self.node.save_images(self.images[:1], "prefix", format="exr", bit_depth="32-bit float", input_color_space="linear")
        self.env["_encode_image"].assert_called_once_with(self.images[0], "exr", "32-bit float", "linear")
        self.env["inject_exr_metadata"].assert_called_once_with(b"encoded", None, None, "linear")
        info = result["ui"]["saved_images"][0]
        self.assertEqual(result["result"], ("image_00001.exr",))
        self.assertEqual(info["filename"], "image_00001.exr")
        self.assertEqual(info["type"], "output")
        self.assertEqual(info["preview"]["type"], "temp")
        self.assertTrue((self.preview / info["preview"]["filename"]).exists())

    def test_avif_hdr_crf_metadata_and_temp_counter(self):
        for _ in range(2):
            result = self.node.save_images(self.images, "folder/prefix", save=False, format="avif", bit_depth="auto",
                                           input_color_space="HDR", crf=12, prompt={"id": 1}, extra_pnginfo={"workflow": {"id": 2}})
        self.assertEqual(result["result"], ("prefix_00004.avif",))
        call = self.env["_save_avif"].call_args
        self.assertEqual(call.args[2:], ("auto", "HDR", 12))
        self.assertEqual(call.kwargs["metadata"], {"prompt": {"id": 1}, "workflow": {"id": 2}})
        self.assertTrue(all(info["type"] == "temp" for info in result["ui"]["saved_images"]))

    def test_metadata_disabled_and_invalid_settings(self):
        self.env["args"].disable_metadata = True
        self.node.save_images(self.images[:1], "prefix", format="exr", bit_depth="16-bit float")
        self.env["inject_exr_metadata"].assert_not_called()
        with self.assertRaisesRegex(ValueError, "Unsupported image settings"):
            self.node.save_images(self.images, "prefix", format="png", bit_depth="32-bit float")
        self.env["_encode_image"] = None
        with self.assertRaisesRegex(RuntimeError, "Save Image"):
            self.node.save_images(self.images, "prefix", bit_depth="16-bit")
        self.node.save_images(self.images, "prefix")

    def test_avif_strips_rgba_for_encoding_and_preview_without_mutating_input(self):
        rgba = MagicMock()
        rgba.shape = (32, 48, 4)
        rgb = FakeImage()
        rgba.__getitem__.return_value = rgb
        for save in (True, False):
            with self.subTest(save=save):
                rgba.reset_mock()
                self.env["_save_avif"].reset_mock()
                self.env["_tensor_to_pil"].reset_mock()
                self.node.save_images([rgba], "prefix", save=save, format="avif", bit_depth="auto")
                rgba.__getitem__.assert_called_once_with((Ellipsis, slice(None, 3)))
                self.assertIs(self.env["_save_avif"].call_args.args[0][0], rgb)
                self.env["_tensor_to_pil"].assert_called_once_with(rgb)
                self.assertEqual(rgba.shape, (32, 48, 4))

    def test_png_and_exr_keep_rgba(self):
        rgba = MagicMock()
        rgba.shape = (32, 48, 4)
        self.node.save_images([rgba], "prefix")
        self.env["_tensor_to_pil"].assert_called_once_with(rgba)
        self.node.save_images([rgba], "prefix", format="exr", bit_depth="16-bit float")
        self.env["_encode_image"].assert_called_once_with(rgba, "exr", "16-bit float", "sRGB")
        rgba.__getitem__.assert_not_called()

    def test_avif_leaves_channel_less_grayscale_unchanged(self):
        grayscale = FakeImage()
        grayscale.shape = (32, 4)
        self.node.save_images([grayscale], "prefix", format="avif", bit_depth="auto")
        self.assertIs(self.env["_save_avif"].call_args.args[0][0], grayscale)


if __name__ == "__main__":
    unittest.main()