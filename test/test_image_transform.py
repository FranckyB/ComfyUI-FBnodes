"""Load Image+'s edits after the mask (py/image_transform.py): rotate, crop, flip, scale, pad, step.

Runs on ComfyUI's own Python (torch, Pillow, comfy.utils), e.g.:
    /path/to/ComfyUI/venv/bin/python -m unittest test/test_image_transform.py
"""

import importlib.util
import json
import math
from pathlib import Path
import sys
import unittest

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1]))  # ComfyUI, for comfy.utils
spec = importlib.util.spec_from_file_location("image_transform", ROOT / "py" / "image_transform.py")
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)


def data(**state):
    return json.dumps({"enabled": True, **state})


def gradient(height, width, batch=1):
    """A picture whose every pixel is different, so moves can be traced."""
    ys = torch.linspace(0, 1, height)[:, None].expand(height, width)
    xs = torch.linspace(0, 1, width)[None, :].expand(height, width)
    return torch.stack([xs, ys, (xs + ys) / 2], dim=-1)[None].repeat(batch, 1, 1, 1)


def pillow_expand_size(width, height, degrees):
    """Pillow's rotate(expand=True) size, as AusBoss's rotatedSize computes it."""
    radians = math.radians(degrees % 360)
    cosine, sine = round(math.cos(radians), 15), round(math.sin(radians), 15)
    xs, ys = [], []
    for x, y in ((0, 0), (width, 0), (width, height), (0, height)):
        xs.append(width / 2 + (x - width / 2) * cosine - (y - height / 2) * sine)
        ys.append(height / 2 + (x - width / 2) * sine + (y - height / 2) * cosine)
    return math.ceil(max(xs)) - math.floor(min(xs)), math.ceil(max(ys)) - math.floor(min(ys))


class TransformTests(unittest.TestCase):
    def test_nothing_on_is_untouched(self):
        image, mask = gradient(30, 40), torch.ones(1, 30, 40)
        picture, out_mask, canvas = T.transform(image, mask)
        self.assertTrue(torch.equal(picture, image))
        self.assertTrue(torch.equal(out_mask, mask))
        self.assertTrue(torch.equal(canvas, image))

    def test_tools_switched_off_are_ignored(self):
        image = gradient(30, 40)
        off = json.dumps({"enabled": False, "degrees": 30, "factor": 2, "left": 10})
        picture, _, canvas = T.transform(image, None, rotate_data=off, scale_data=off, pad_data=off)
        self.assertTrue(torch.equal(picture, image))
        self.assertTrue(torch.equal(canvas, image))

    def test_quarter_turn_is_clockwise_and_marks_nothing(self):
        image = gradient(30, 40)
        picture, mask, _ = T.transform(image, torch.ones(1, 30, 40), rotate_data=data(degrees=90))
        self.assertEqual(tuple(picture.shape), (1, 40, 30, 3))
        # Clockwise: the top-left pixel ends at the top right.
        self.assertTrue(torch.allclose(picture[0, 0, -1], image[0, 0, 0], atol=1 / 255))
        self.assertTrue(torch.equal(mask, torch.ones(1, 40, 30)))

    def test_any_angle_grows_like_pillow_and_fills_corners(self):
        image = gradient(60, 100)
        picture, mask, _ = T.transform(image, torch.ones(1, 60, 100), rotate_data=data(degrees=30))
        self.assertEqual(tuple(picture.shape[1:3]), pillow_expand_size(100, 60, 30)[::-1])
        self.assertTrue(torch.allclose(picture[0, 0, 0], torch.full((3,), T.FILL)))
        self.assertEqual(mask[0, 0, 0].item(), 1.0)
        middle = picture.shape[1] // 2, picture.shape[2] // 2
        self.assertEqual(mask[0, middle[0], middle[1]].item(), 0.0)

    def test_painted_mask_turns_with_the_picture(self):
        mask = torch.zeros(1, 30, 40)
        mask[:, :10, :10] = 1.0
        _, turned, _ = T.transform(gradient(30, 40), mask, rotate_data=data(degrees=90))
        self.assertEqual(turned[0, :10, -10:].min().item(), 1.0)
        self.assertEqual(turned[0, -10:, :10].max().item(), 0.0)

    def test_crop_is_measured_on_the_turned_picture(self):
        image = gradient(30, 40)
        picture, _, _ = T.transform(image, None, rotate_data=data(degrees=90), crop_data=data(left_pct=0, right_pct=50, top_pct=0, bottom_pct=100))
        self.assertEqual(tuple(picture.shape[1:3]), (40, 15))

    def test_crop_first_turns_the_cropped_part(self):
        image = gradient(30, 40)
        crop = data(left_pct=0, right_pct=50, top_pct=0, bottom_pct=100)
        picture, _, _ = T.transform(image, None, rotate_data=data(degrees=90, order="crop_first"), crop_data=crop)
        # The left half (30 x 20) turned a quarter: 20 x 30, its top-left pixel at the top right.
        self.assertEqual(tuple(picture.shape[1:3]), (20, 30))
        self.assertTrue(torch.allclose(picture[0, 0, -1], image[0, 0, 0], atol=1 / 255))

    def test_crop_flip_pad_as_before(self):
        image, mask = gradient(30, 40), torch.zeros(1, 30, 40)
        picture, out_mask, canvas = T.transform(
            image, mask, crop_data=data(left_pct=25, right_pct=75, top_pct=0, bottom_pct=50), flip_x=True,
            pad_data=data(left=5, right=0, top=0, bottom=3, feather=0),
        )
        self.assertTrue(torch.equal(picture, torch.flip(image[:, 0:15, 10:30], dims=[2])))
        self.assertEqual(tuple(canvas.shape[1:3]), (18, 25))
        self.assertTrue(torch.equal(canvas[:, :15, 5:], picture))
        self.assertEqual(canvas[0, 0, 0, 0].item(), T.FILL)
        self.assertEqual(out_mask[0, :, :5].min().item(), 1.0)
        self.assertEqual(out_mask[0, :15, 5:].max().item(), 0.0)

    def test_scale_factor_scales_picture_and_padding(self):
        picture, _, canvas = T.transform(gradient(40, 60), None, scale_data=data(mode="factor", factor=0.5), pad_data=data(left=10, right=0, top=0, bottom=0))
        self.assertEqual(tuple(picture.shape[1:3]), (20, 30))
        self.assertEqual(tuple(canvas.shape[1:3]), (20, 35))

    def test_megapixels_count_the_whole_canvas(self):
        _, _, canvas = T.transform(gradient(64, 64), None, scale_data=data(mode="megapixels", megapixels=16384 / 1024 / 1024))
        self.assertEqual(tuple(canvas.shape[1:3]), (128, 128))

    def test_step_trims_an_unpadded_axis_evenly(self):
        picture, _, canvas = T.transform(gradient(70, 100), None, step=32, crop_data=data())
        self.assertEqual(tuple(picture.shape[1:3]), (64, 96))
        self.assertTrue(torch.equal(picture, gradient(70, 100)[:, 3:67, 2:98]))
        self.assertTrue(torch.equal(canvas, picture))

    def test_step_waits_for_an_edit_that_sizes(self):
        image = gradient(70, 100)
        picture, _, _ = T.transform(image, None, step=32)
        self.assertTrue(torch.equal(picture, image))
        picture, _, _ = T.transform(image, None, step=32, rotate_data=data(degrees=0))
        self.assertEqual(tuple(picture.shape[1:3]), (64, 96))

    def test_step_grows_a_padded_side(self):
        picture, mask, canvas = T.transform(gradient(64, 100), None, step=32, pad_data=data(left=10, right=0, top=0, bottom=0))
        self.assertEqual(tuple(picture.shape[1:3]), (64, 100))
        self.assertEqual(tuple(canvas.shape[1:3]), (64, 128))
        self.assertEqual(mask[0, :, :28].min().item(), 1.0)

    def test_axis_layout_matches_ausboss(self):
        self.assertEqual(T.axis_layout(100, 0, 0, 1), (0, 0, 0, 0, 100))
        self.assertEqual(T.axis_layout(100, 0, 10, 32), (0, 28, 0, 0, 128))
        self.assertEqual(T.axis_layout(100, 10, 10, 32), (10, 18, 0, 0, 128))
        self.assertEqual(T.axis_layout(100, 0, 0, 32), (0, 0, 2, 2, 96))
        self.assertEqual(T.axis_layout(20, 0, 0, 32), (0, 12, 0, 0, 32))


if __name__ == "__main__":
    unittest.main()
