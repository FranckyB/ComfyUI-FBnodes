"""Dependency-free adapter tests. Core image codecs are mocked, not exercised."""

import ast
import inspect
import json
import os
from pathlib import Path
import re
import tempfile
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
        }
        tree = ast.parse(SOURCE.read_text())
        selected = [node for node in tree.body if
                    isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in ("SaveImagePlus", "_expand_date_format")
                    or isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "IMAGE_FORMAT_OPTIONS" for target in node.targets)]
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"), self.env)
        self.node = self.env["SaveImagePlus"]()
        self.images = [FakeImage(), FakeImage()]

    def test_legacy_schema_signature_defaults_and_metadata(self):
        schema = self.node.INPUT_TYPES()
        self.assertEqual(list(schema["required"]), ["images", "filename_prefix", "save"])
        self.assertEqual(list(schema["optional"]), ["Compare", "format", "bit_depth", "input_color_space", "crf"])
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