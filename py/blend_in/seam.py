# Adapted from ComfyUI-AusBoss, Stitch Inpaint's "blend in" seam and its Tone
# match (MIT, (c) 2026 ausboss; see LICENSE in this folder). Used by Outpaint Blend.
"""Hand an outpaint over to the source picture across the picture's edge.

Both pictures split into colour and tone (a blur) and detail (the rest);
colour and tone hand over from the model's picture to yours along one ramp,
detail along a shorter one, by depth into the picture, and the texture a
cross-fade loses halfway is put back. Tone match first takes the model's tone
drift, fitted over the strip of your picture it redrew, off its picture.
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as functional

import comfy.model_management
import comfy.utils

try:
    from scipy.ndimage import distance_transform_edt as _scipy_distance
except ImportError:  # scipy is optional; the torch fallback below covers it.
    _scipy_distance = None

# A pixel the generated-area mask holds at or above this is new area, not
# picture. The mask is 1 right up to the picture's edge and feathers inward
# from there, so the cut lands on the edge itself.
SEAM_NEW_AREA = 0.98
# Colour and tone are a picture blurred at this sigma, in pixels.
SEAM_TONE_SIGMA = 8.0
# Picture pixels closer than this to the edge stay out of the picture's
# colour layer: turning or resizing a canvas mixes the fill into them.
SEAM_CLEAN_DEPTH = 4.0
# The detail ramp starts at 3/4 of the depth where the model's mask fell to
# 0.1 - about how deep the model was free to redraw - never shallower than
# SEAM_DETAIL_FLOOR, and runs SEAM_DETAIL_SPAN pixels. The colour ramp runs
# from SEAM_CLEAN_DEPTH to SEAM_TONE_EXTRA pixels past the detail ramp.
# That depth is the median over the picture pixels whose mask value falls
# inside SEAM_REACH_BAND.
SEAM_DETAIL_FLOOR = 8.0
SEAM_DETAIL_SPAN = 10.0
SEAM_TONE_EXTRA = 14.0
SEAM_REACH_BAND = (0.08, 0.12)
# The depth used when the mask has too few pixels in that band to read
# (no feather, or a tiny canvas).
SEAM_DEFAULT_REACH = 13.0
SEAM_REACH_MIN_PIXELS = 200
# A straight cross-fade of two unrelated textures loses strength halfway
# across. This much of the lost strength is put back, read over this blur,
# and never more than SEAM_TEXTURE_MAX_GAIN times the faded detail.
SEAM_TEXTURE_SIGMA = 6.0
SEAM_TEXTURE_KEEP = 0.6
SEAM_TEXTURE_MAX_GAIN = 1.7
# Depth is measured this far, in pixels, and clamped past it. Every ramp
# ends inside it: the deepest colour ramp ends at 3/4 of it plus 24.
SEAM_DEPTH_CAP = 128.0
# Frames are blended in chunks of about this many pixels, at least one frame.
SEAM_CHUNK_PIXELS = 2 * 1024 * 1024

# Tone match under blend in (blend_in_tone_match). The model's picture is
# compared with yours over the band it redrew: picture pixels at least
# SEAM_CLEAN_DEPTH inside the edge where the sampler mask is above
# SEAM_MATCH_MIN_MASK, leaving out any whose tone reaches SEAM_MATCH_CLIP in
# a channel (a clipped highlight has no drift to read).
SEAM_MATCH_MIN_MASK = 0.02
SEAM_MATCH_CLIP = 0.98
# Fewer band pixels than this: nothing to read, no correction.
SEAM_MATCH_MIN_PIXELS = 400
# Robust fit: SEAM_MATCH_PASSES reweighting passes, pixels further than
# SEAM_MATCH_HUBER off the fit counting less (a changed object, a moved edge).
SEAM_MATCH_HUBER = 3.0 / 255.0
SEAM_MATCH_PASSES = 3
# The check: fit on alternate SEAM_MATCH_TILE px tiles, predict the others.
# The correction is used only when it predicts the held-out band
# SEAM_MATCH_MIN_GAIN better than no correction; the local gain along the
# edge only when it predicts it another SEAM_MATCH_LOCAL_GAIN better.
SEAM_MATCH_TILE = 96
SEAM_MATCH_MIN_GAIN = 0.15
SEAM_MATCH_LOCAL_GAIN = 0.05
# The local gain is smoothed along the edge at this sigma (px) and eases
# back to 1 away from it. No curve point drifts more than SEAM_MATCH_MAX.
SEAM_MATCH_ALONG = 48.0
SEAM_MATCH_MAX = 24.0 / 255.0
# Tone match compares tone layers blurred at this sigma (px): narrower than
# blend in's own, so a thin feather's band still reads close to how free the
# model was there, wide enough that texture and small shifts average out.
SEAM_MATCH_SIGMA = 5.0
SEAM_MATCH_FALLBACK = 1e-3


def _smoothstep(x: torch.Tensor) -> torch.Tensor:
    x = x.clamp(0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def _seam_blur(image: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable Gaussian blur of a [B, C, H, W] batch with mirrored edges;
    a side too short to mirror repeats its last pixel instead."""
    radius = max(1, int(math.ceil(3.0 * float(sigma))))
    taps = torch.arange(-radius, radius + 1, dtype=image.dtype, device=image.device)
    kernel = torch.exp(-(taps * taps) / (2.0 * float(sigma) ** 2))
    kernel = kernel / kernel.sum()
    channels = image.shape[1]
    mode = "reflect" if radius < image.shape[3] else "replicate"
    image = functional.pad(image, (radius, radius, 0, 0), mode=mode)
    image = functional.conv2d(image, kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1), groups=channels)
    mode = "reflect" if radius < image.shape[2] else "replicate"
    image = functional.pad(image, (0, 0, radius, radius), mode=mode)
    return functional.conv2d(image, kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1), groups=channels)


def _torch_distance(inside: torch.Tensor, reach: float = SEAM_DEPTH_CAP) -> torch.Tensor:
    """Distance from every True pixel of an [H, W] mask to the nearest False
    pixel, centre to centre, exact up to ``reach`` pixels and at least
    ``reach`` past it. The frame's border does not count as False.

    Stands in for scipy's distance transform when scipy is missing: the
    nearest False pixel along each row first, then the best row within
    ``reach`` above or below.
    """
    height, width = inside.shape
    outside = ~inside
    columns = torch.arange(width, dtype=torch.float32, device=inside.device).expand(height, width)
    far = torch.full((height, width), math.inf, device=inside.device)
    before = torch.where(outside, columns, -far).cummax(dim=1).values
    after = -torch.where(outside, -columns, -far).flip(1).cummax(dim=1).values.flip(1)
    along = torch.minimum(columns - before, after - columns)
    along = along * along
    best = along.clone()
    for step in range(1, min(int(math.ceil(reach)), height - 1) + 1):
        lift = float(step * step)
        best[step:] = torch.minimum(best[step:], along[:-step] + lift)
        best[:-step] = torch.minimum(best[:-step], along[step:] + lift)
    return best.sqrt()


def _distance(inside: torch.Tensor) -> torch.Tensor:
    if _scipy_distance is not None:
        return torch.from_numpy(_scipy_distance(inside.cpu().numpy()).astype("float32"))
    return _torch_distance(inside.cpu())


def _signed_depth(picture: torch.Tensor) -> torch.Tensor:
    """[H, W] signed distance, in pixels, from each pixel's centre to the
    picture's edge: positive inside ``picture`` (a bool map), negative
    outside, clamped to SEAM_DEPTH_CAP either way. A side of the picture
    that meets the frame is no edge, so the picture stays deep up to it."""
    if bool(picture.all()):
        return torch.full(tuple(picture.shape), SEAM_DEPTH_CAP)
    if not bool(picture.any()):
        return torch.full(tuple(picture.shape), -SEAM_DEPTH_CAP)
    inward = _distance(picture) - 0.5
    outward = 0.5 - _distance(~picture)
    return torch.where(picture.cpu(), inward, outward).clamp(-SEAM_DEPTH_CAP, SEAM_DEPTH_CAP)


def seam_ramps(
    mask: torch.Tensor | None, depth: torch.Tensor
) -> tuple[tuple[float, float], tuple[float, float]]:
    """(tone, detail) ramps for blend in, each (start, end) in pixels inside
    the picture's edge, read off ``mask`` [H, W] - the mask the model was
    handed - against ``depth`` [H, W].

    The model was free to redraw the picture down to about where its mask
    fell to 0.1, and its version lines up with the picture a little before
    that; the detail ramp starts there. Without a readable mask the ramps
    fall back to SEAM_DEFAULT_REACH.
    """
    reach = SEAM_DEFAULT_REACH
    if mask is not None:
        low, high = SEAM_REACH_BAND
        ring = (mask >= low) & (mask <= high) & (depth > 0)
        count = int(ring.sum())
        if count > SEAM_REACH_MIN_PIXELS:
            values = depth[ring].sort().values
            reach = (float(values[(count - 1) // 2]) + float(values[count // 2])) / 2.0
    start = max(SEAM_DETAIL_FLOOR, 0.75 * reach)
    detail = (start, start + SEAM_DETAIL_SPAN)
    return (SEAM_CLEAN_DEPTH, detail[1] + SEAM_TONE_EXTRA), detail


# --- blend in: Tone match -----------------------------------------------------
#
# The model redraws the strip of your picture next to the new area, so there
# its version and yours can be compared pixel for pixel. The difference is
# the model's tone drift, and it depends on brightness: Klein darkens
# mid-tones and keeps black black, Krea darkens a little all over, Qwen
# barely drifts. Where the sampler mask pinned the picture the drift is
# smaller (Krea: none) or of its own kind (Klein re-renders a pinned picture).
# Tone match fits that drift as curves over brightness, checks the fit on
# part of the strip it was not fitted on, and takes it back off the model's
# picture before blend in runs, so the new area meets your picture in tone
# on any edge, turned or straight. When the check fails, or there is no
# strip to read (no feather), nothing changes. One fit serves every frame.

# Brightness knots of the drift curves, denser in the shadows.
SEAM_MATCH_KNOTS = (0.0, 0.02, 0.05, 0.1, 0.18, 0.3, 0.45, 0.62, 0.8, 1.0)
# The pinned curve A is smoothed lightly and anchored weakly at no drift;
# the free curve is A plus a difference that is smoothed a little more and
# shrunk a little toward zero. Weights are relative to the band's size.
SEAM_MATCH_SMOOTH = 0.01
SEAM_MATCH_ANCHOR = 0.001
SEAM_MATCH_SMOOTH_FREE = 0.05
SEAM_MATCH_SHRINK_FREE = 0.01
# At most this many band pixels feed a fit; a larger band is thinned evenly.
SEAM_MATCH_SAMPLES = 200_000
# The local gain along the edge: smoothed at this sigma (px), at most this
# far from 1, used only when it predicts the held-out band this much better.
SEAM_MATCH_GAIN_MAX = 0.05
SEAM_MATCH_INVERT_STEPS = 3


# How it runs. PyTorch splits a large operation across all the CPUs it sees,
# and a cloud container can show it far more CPUs than it may use: there every
# such operation waits its turn, however little work it does. So Tone match
# keeps those operations to a few large ones - the blurs, each over every layer
# it needs at once - and does the rest with NumPy, which uses one thread: the
# band's samples are summed per knot segment (sorted once, then one reduction
# per pass for all three fits), every curve is solved in one batched call, and
# the curves are read and inverted over whole pictures at once.

_KNOTS = np.asarray(SEAM_MATCH_KNOTS, dtype=np.float32)
_KNOT_WIDTHS = _KNOTS[1:] - _KNOTS[:-1]
_INNER_KNOTS = torch.from_numpy(_KNOTS[1:-1].copy())
_POINTS = len(SEAM_MATCH_KNOTS)
_SEGMENTS = _POINTS - 1
# The fit's sums per sample, channel and knot segment: products of the four
# non-zero entries of the sample's row in the design (1 - t and t for the
# pinned curve, the same times the mask for the free one) with each other and
# with the drift.
_UU, _UT, _TT, _UUM, _UTM, _TTM, _UUMM, _UTMM, _TTMM, _UD, _TD, _UMD, _TMD = range(13)


def _numpy32(tensor: torch.Tensor) -> np.ndarray:
    """A float32 NumPy array of ``tensor`` on the CPU (shared, not copied,
    when it already is one)."""
    return tensor.detach().to(device="cpu", dtype=torch.float32).numpy()


def _knot_positions(values: np.ndarray):
    """(segment, t, 1 - t) for ``values`` clamped to 0..1: the knot segment
    each falls in, counted as ``torch.bucketize`` counts it, and how far
    across it."""
    values = np.clip(values, 0.0, 1.0)
    segment = torch.bucketize(torch.from_numpy(values), _INNER_KNOTS, out_int32=True).numpy()
    t = (values - np.take(_KNOTS, segment)) / np.take(_KNOT_WIDTHS, segment)
    return segment, t, np.float32(1.0) - t


def _curves_at(points: np.ndarray, flat: np.ndarray, t: np.ndarray, u: np.ndarray) -> np.ndarray:
    """Piecewise-linear curves read off ``points`` (knot values, flattened so
    that ``flat`` is each value's segment start) with ``t`` and ``u = 1 - t``."""
    return np.take(points, flat) * u + np.take(points, flat + 1) * t


def _penalty() -> np.ndarray:
    """[20, 20] smoothing and shrinking penalty of the pinned and free curves,
    per unit of sample weight."""
    steps = np.zeros((_SEGMENTS, _POINTS))
    steps[np.arange(_SEGMENTS), np.arange(_SEGMENTS)] = -1.0
    steps[np.arange(_SEGMENTS), np.arange(1, _POINTS)] = 1.0
    rough, eye = steps.T @ steps, np.eye(_POINTS)
    penalty = np.zeros((2 * _POINTS, 2 * _POINTS))
    penalty[:_POINTS, :_POINTS] = SEAM_MATCH_SMOOTH * rough + SEAM_MATCH_ANCHOR * eye
    penalty[_POINTS:, _POINTS:] = SEAM_MATCH_SMOOTH_FREE * rough + SEAM_MATCH_SHRINK_FREE * eye
    return penalty


def _solve_curves(sums: np.ndarray, weights: np.ndarray):
    """Knot values of the pinned curve A and the free curve E for every fit
    and channel, from ``sums`` [fits, 3, segments, 13] (see _UU...) and each
    fit's total sample weight ``weights`` [fits]. The drift is modelled as
    d = A(v) + m * (E(v) - A(v)); least squares with SEAM_MATCH_* penalties.
    Returns float32 (pinned, free), each [fits, 3, knots]."""
    fits = sums.shape[0]
    gram = np.zeros((fits, 3, 2 * _POINTS, 2 * _POINTS))
    target = np.zeros((fits, 3, 2 * _POINTS))
    low = np.arange(_SEGMENTS)
    high = low + 1
    for rows, cols, same, cross, other in (
        (0, 0, _UU, _UT, _TT),
        (0, _POINTS, _UUM, _UTM, _TTM),
        (_POINTS, 0, _UUM, _UTM, _TTM),
        (_POINTS, _POINTS, _UUMM, _UTMM, _TTMM),
    ):
        gram[..., rows + low, cols + low] += sums[..., same]
        gram[..., rows + low, cols + high] += sums[..., cross]
        gram[..., rows + high, cols + low] += sums[..., cross]
        gram[..., rows + high, cols + high] += sums[..., other]
    target[..., low] += sums[..., _UD]
    target[..., high] += sums[..., _TD]
    target[..., _POINTS + low] += sums[..., _UMD]
    target[..., _POINTS + high] += sums[..., _TMD]
    gram += _penalty() * weights.reshape(fits, 1, 1, 1)
    solved = np.linalg.solve(gram, target[..., None])[..., 0].astype(np.float32)
    pinned, free = solved[..., :_POINTS], solved[..., :_POINTS] + solved[..., _POINTS:]
    return np.clip(pinned, -SEAM_MATCH_MAX, SEAM_MATCH_MAX), np.clip(free, -SEAM_MATCH_MAX, SEAM_MATCH_MAX)


class _DriftSamples:
    """The band's samples, set up once for every fit that reads them: your
    picture's tone ``v`` [N, 3], the mask ``m`` [N] and the drift ``d`` [N, 3]."""

    def __init__(self, v: np.ndarray, m: np.ndarray, d: np.ndarray):
        self.m, self.d = m, d
        self.segment, self.t, self.u = _knot_positions(v)
        um, tm = self.u * m[:, None], self.t * m[:, None]
        u, t = self.u, self.t
        # [N, 3, 13] products, float32 like the design they come from.
        self.products = np.stack(
            (u * u, u * t, t * t, u * um, u * tm, t * tm, um * um, um * tm, tm * tm, u * d, t * d, um * d, tm * d),
            axis=-1,
        )

    def layer(self, fit: np.ndarray):
        """Sort the samples of one layer - each sample fitted by ``fit`` [N]
        (a fit index) - by fit, channel and segment once, so every pass sums
        them with one reduction. Returns what :meth:`sums` needs."""
        count = self.segment.shape[0]
        bins = ((fit[:, None].astype(np.int64) * 3 + np.arange(3)) * _SEGMENTS + self.segment).reshape(-1)
        order = np.argsort(bins.astype(np.int16), kind="stable")
        ordered = bins[order]
        starts = np.flatnonzero(np.concatenate(([True], ordered[1:] != ordered[:-1])))
        return {
            "bins": ordered[starts],
            "starts": starts,
            "sample": order // 3,
            "products": self.products.reshape(count * 3, 13)[order],
            "flat": ((fit[:, None].astype(np.int64) * 3 + np.arange(3)) * _POINTS + self.segment),
        }

    def sums(self, layer: dict, weight: np.ndarray, fits: int) -> np.ndarray:
        """[fits, 3, segments, 13] weighted sums of one layer's samples."""
        out = np.zeros((fits * 3 * _SEGMENTS, 13))
        weighted = layer["products"] * weight[layer["sample"], None]
        out[layer["bins"]] = np.add.reduceat(weighted, layer["starts"], axis=0, dtype=np.float64)
        return out.reshape(fits, 3, _SEGMENTS, 13)

    def drift(self, pinned: np.ndarray, free: np.ndarray, flat: np.ndarray) -> np.ndarray:
        """[N, 3] fitted drift of every sample, read off the curves (flattened
        [fits * 3 * knots]) of the fit ``flat`` points each sample to."""
        a = _curves_at(pinned.reshape(-1), flat, self.t, self.u)
        return a + self.m[:, None] * (_curves_at(free.reshape(-1), flat, self.t, self.u) - a)


def _robust_fits(samples: _DriftSamples, halves: np.ndarray):
    """Three robust drift fits at once: every sample (fit 0), and each half
    of the check - fit 1 on the samples ``halves`` marks, fit 2 on the rest.
    Each runs SEAM_MATCH_PASSES reweighting passes, pixels further than
    SEAM_MATCH_HUBER off its fit counting less.

    Returns ``(pinned, free)`` [3, 3, knots] and the whole-band fit's final
    weights [N].
    """
    count = samples.d.shape[0]
    fit = halves.astype(np.int64) * -1 + 2  # 1 on the marked half, 2 elsewhere
    layers = (samples.layer(np.zeros(count, dtype=np.int64)), samples.layer(fit))
    weights = [np.ones(count, dtype=np.float32), np.ones(count, dtype=np.float32)]
    pinned = free = None
    for _ in range(SEAM_MATCH_PASSES):
        sums = samples.sums(layers[0], weights[0], 3) + samples.sums(layers[1], weights[1], 3)
        totals = np.array(
            (weights[0].sum(dtype=np.float64), weights[1][halves].sum(dtype=np.float64), weights[1][~halves].sum(dtype=np.float64))
        )
        pinned, free = _solve_curves(sums, totals)
        for index, layer in enumerate(layers):
            miss = np.abs(samples.d - samples.drift(pinned, free, layer["flat"])).max(axis=1)
            weights[index] = np.where(miss <= SEAM_MATCH_HUBER, np.float32(1.0), np.float32(SEAM_MATCH_HUBER) / np.maximum(miss, np.float32(1e-9)))
    return pinned, free, weights[0]


def _curve_lines(points: np.ndarray):
    """Each segment of the curves with knot values ``points`` [..., knots] as
    a line: (offset, slope) [..., segments], the value at v being
    offset + slope * v."""
    slope = (points[..., 1:] - points[..., :-1]) / _KNOT_WIDTHS
    return points[..., :-1] - slope * _KNOTS[:-1], slope


def _undo_drift(values: np.ndarray, pinned: np.ndarray, free: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Take each RGB value of ``values`` [..., H, W, 3] back through its drift
    curve: the picture value v with v + drift(v) = value, found by
    SEAM_MATCH_INVERT_STEPS fixed-point steps, so a value the model kept
    (black stays black) is kept. ``pinned`` and ``free`` are [3, knots], ``m``
    [H, W, 1] mixes them. Returns the found values, not yet mixed by strength."""
    offset, slope = _curve_lines(pinned)
    free_offset, free_slope = _curve_lines(free)
    # drift = offset + slope * v + m * (extra offset + extra slope * v)
    tables = [part.reshape(-1) for part in (offset, slope, free_offset - offset, free_slope - slope)]
    channels = np.arange(3, dtype=np.int32) * _SEGMENTS
    guess = values
    for _ in range(SEAM_MATCH_INVERT_STEPS):
        clamped = np.clip(guess, 0.0, 1.0)
        flat = torch.bucketize(torch.from_numpy(clamped), _INNER_KNOTS, out_int32=True).numpy()
        flat += channels
        drift = np.take(tables[1], flat) * clamped
        drift += np.take(tables[0], flat)
        extra = np.take(tables[3], flat) * clamped
        extra += np.take(tables[2], flat)
        extra *= m
        drift += extra
        guess = np.clip(np.subtract(values, drift, out=drift), 0.0, 1.0, out=drift)
    return guess


def _checkerboard(rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    return ((rows // SEAM_MATCH_TILE + cols // SEAM_MATCH_TILE) % 2) == 0


def _held_out_gain(errors) -> float:
    """1 - (held-out error with the fit) / (held-out error with nothing)."""
    none, fitted = errors
    return 1.0 - fitted / max(none, 1e-12)


def _smooth_fields(fields: np.ndarray, sigma: float) -> np.ndarray:
    """Every layer of ``fields`` [L, H, W] smoothed along the edge: averaged
    over 4 px cells, blurred at a quarter of ``sigma`` there and scaled back
    up, all layers in one go."""
    height, width = fields.shape[-2:]
    small = functional.avg_pool2d(torch.from_numpy(fields).unsqueeze(0), 4, stride=4, ceil_mode=True)
    small = _seam_blur(small, max(0.5, sigma / 4.0))
    return functional.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)[0].numpy()


def _gain_fields(pixels, shape, weights: np.ndarray, tone: np.ndarray, miss: np.ndarray):
    """The [L, 3, H, W] numerators and denominators of local gains g with
    miss ~ g * tone, one per weight layer in ``weights`` [L, n] over the band
    ``pixels`` (rows, cols), whose ``tone`` and ``miss`` are [3, n]: both
    smoothed along the edge (see :func:`_smooth_fields`)."""
    layers = weights.shape[0]
    fields = np.zeros((2 * layers, 3) + tuple(shape), dtype=np.float32)
    weighted = weights[:, None, :] * tone[None]
    fields[:layers, :, pixels[0], pixels[1]] = weighted * miss[None]
    fields[layers:, :, pixels[0], pixels[1]] = weighted * tone[None]
    smoothed = _smooth_fields(fields.reshape((-1,) + tuple(shape)), SEAM_MATCH_ALONG)
    smoothed = smoothed.reshape((2 * layers, 3) + tuple(shape))
    return smoothed[:layers], smoothed[layers:]


def _gain_floor(denominator: np.ndarray) -> float:
    return SEAM_MATCH_FALLBACK * float(denominator.max()) + 1e-12


def _gain(numerator: np.ndarray, denominator: np.ndarray, floor: float) -> np.ndarray:
    """The local gain, capped at SEAM_MATCH_GAIN_MAX and easing to 0 away
    from any measurement (``floor``, from :func:`_gain_floor`)."""
    return np.clip(numerator / (denominator + np.float32(floor)), -SEAM_MATCH_GAIN_MAX, SEAM_MATCH_GAIN_MAX)


def blend_in_tone_match(canvas: torch.Tensor, patch: torch.Tensor, plan: dict) -> dict | None:
    """What Tone match takes off the model's picture before blend in, or None
    when there is nothing it can trust.

    ``canvas`` [1 or B, H, W, C] and ``patch`` [B, H, W, C] as in
    :func:`blend_in_seam`, ``plan`` from :func:`seam_plan`. Your picture and
    the model's are compared as tone layers (blur sigma SEAM_MATCH_SIGMA, both
    over the same clean picture pixels) over the band the model redrew: picture pixels at
    least SEAM_CLEAN_DEPTH inside the edge where the sampler mask is above
    SEAM_MATCH_MIN_MASK, clipped highlights left out. Every frame is measured
    at once through the frames' mean, so a clip gets one correction and no
    flicker. The drift curves (:func:`_solve_curves`) must predict a
    held-out half of the band - alternate SEAM_MATCH_TILE px tiles - at least
    SEAM_MATCH_MIN_GAIN better than no correction, and the local gain along
    the edge another SEAM_MATCH_LOCAL_GAIN better than the curves alone.
    """
    sampler = plan.get("sampler")
    if sampler is None or canvas.shape[-1] < 3:
        return None
    frames, height, width = patch.shape[:3]
    depth = _numpy32(plan["depth"]).reshape(height, width)
    mask = _numpy32(sampler).reshape(height, width)
    inside = depth >= SEAM_CLEAN_DEPTH
    clean = inside.astype(np.float32)
    base = canvas[..., :3] if canvas.shape[0] == 1 else canvas[..., :3].float().mean(dim=0, keepdim=True)
    model = patch[..., :3] if frames == 1 else patch[..., :3].float().mean(dim=0, keepdim=True)
    base, model = _numpy32(base[0]), _numpy32(model[0])  # [H, W, 3]
    # Every tone layer in one blur: the clean share itself, your picture and
    # the model's over the same clean pixels (blurred across the edge, the
    # model's would carry the new area's content into the band and read it as
    # drift), and the mask, which the tone layers average the same way.
    layers = np.empty((8, height, width), dtype=np.float32)
    layers[0] = clean
    np.multiply(base.transpose(2, 0, 1), clean, out=layers[1:4])
    np.multiply(model.transpose(2, 0, 1), clean, out=layers[4:7])
    np.multiply(mask, clean, out=layers[7])
    blurred = _seam_blur(torch.from_numpy(layers).unsqueeze(0), SEAM_MATCH_SIGMA)[0].numpy()
    rows, cols = np.nonzero(inside & (mask > np.float32(SEAM_MATCH_MIN_MASK)))
    share = np.maximum(blurred[0, rows, cols], np.float32(1e-4))
    tones = blurred[1:, rows, cols] / share
    del blurred
    band = (tones[0:3].max(axis=0) < np.float32(SEAM_MATCH_CLIP)) & (tones[3:6].max(axis=0) < np.float32(SEAM_MATCH_CLIP))
    rows, cols, share, tones = rows[band], cols[band], share[band], tones[:, band]
    if rows.size < SEAM_MATCH_MIN_PIXELS:
        return None
    stride = max(1, rows.size // SEAM_MATCH_SAMPLES)
    v = np.ascontiguousarray(tones[0:3, ::stride].T)
    d = np.ascontiguousarray(tones[3:6, ::stride].T) - v
    halves = _checkerboard(rows[::stride], cols[::stride])
    if min(int(halves.sum()), int((~halves).sum())) < 50:
        return None
    samples = _DriftSamples(v, np.ascontiguousarray(tones[6, ::stride]), d)
    pinned, free, weight = _robust_fits(samples, halves)

    # The check: each half's fit predicts the other half.
    other = np.where(halves, 2, 1)[:, None].astype(np.int64)
    held_out = samples.d - samples.drift(pinned, free, (other * 3 + np.arange(3)) * _POINTS + samples.segment)
    errors = (
        float((weight.astype(np.float64)[:, None] * np.abs(samples.d)).sum()),
        float((weight.astype(np.float64)[:, None] * np.abs(held_out)).sum()),
    )
    if _held_out_gain(errors) < SEAM_MATCH_MIN_GAIN:
        return None
    curves = (pinned[0], free[0])

    # Drift that changes along the edge (sky and water on one side) is left
    # in the model's curve-corrected tone; a local gain, which leaves black
    # black, takes it off when it holds out as well.
    undone = _undo_drift(model, curves[0], curves[1], mask[..., None])
    fixed = model + np.float32(1.0) * (undone - model)
    np.multiply(fixed.transpose(2, 0, 1), clean, out=layers[1:4])
    fixed_tone = _seam_blur(torch.from_numpy(layers[1:4]).unsqueeze(0), SEAM_MATCH_SIGMA)[0].numpy()[:, rows, cols] / share
    del layers
    tone = tones[0:3]
    miss = fixed_tone - tone
    band_w = mask[rows, cols] * mask[rows, cols]
    black = _checkerboard(rows, cols).astype(np.float32)
    parts = np.stack((black, np.float32(1.0) - black))
    numerator, denominator = _gain_fields((rows, cols), (height, width), band_w * parts, tone, miss)
    band_mask = mask[rows, cols]
    errors = [0.0, 0.0]
    for index in range(2):
        test = parts[1 - index] > 0
        gain = _gain(numerator[index][:, rows, cols], denominator[index][:, rows, cols], _gain_floor(denominator[index]))
        errors[0] += float(np.abs(miss[:, test]).sum(dtype=np.float64))
        errors[1] += float(np.abs(miss - band_mask * gain * tone)[:, test].sum(dtype=np.float64))
    match = {"curves": curves, "mask": torch.from_numpy(mask).view(1, 1, height, width).to(patch.device), "gain": None}
    if frames == 1:
        # One picture: blend in applies the correction to this same picture,
        # so the values found here are kept for it.
        match["undone"] = (patch, undone)
    if _held_out_gain(errors) >= SEAM_MATCH_LOCAL_GAIN:
        # Smoothing is linear, so the whole band's field is its two halves'.
        numerator, denominator = numerator[0] + numerator[1], denominator[0] + denominator[1]
        gain = _gain(numerator, denominator, _gain_floor(denominator))
        match["gain"] = torch.from_numpy(np.ascontiguousarray(gain)).unsqueeze(0).to(patch.device)
    return match


def _apply_tone_match(model: torch.Tensor, match: dict, strength: float, undone: np.ndarray | None = None) -> torch.Tensor:
    """The model's frames [B, C, H, W] with Tone match's correction taken off,
    at ``strength`` (0..1). Channels past RGB pass through. ``undone`` is the
    frames' values already taken back through the curves, when known."""
    frames, height, width = model.shape[0], model.shape[2], model.shape[3]
    rgb = _numpy32(model[:, :3].movedim(1, -1))  # [B, H, W, 3]
    mask = _numpy32(match["mask"]).reshape(height, width, 1)
    if undone is None:
        undone = _undo_drift(rgb, match["curves"][0], match["curves"][1], mask)
    rgb = rgb + np.float32(strength) * (undone - rgb)
    gain = match["gain"]
    if gain is not None:
        gain = _numpy32(gain).reshape(3, height, width).transpose(1, 2, 0)
        rgb = rgb / (1.0 + np.float32(strength) * mask * gain)
    rgb = torch.from_numpy(np.clip(rgb, 0.0, 1.0).reshape(frames, height, width, 3))
    rgb = rgb.to(device=model.device, dtype=model.dtype).movedim(-1, 1)
    if model.shape[1] > 3:
        return torch.cat([rgb, model[:, 3:]], dim=1)
    return rgb


def blend_in_seam(
    canvas: torch.Tensor,
    patch: torch.Tensor,
    depth: torch.Tensor,
    tone: tuple[float, float],
    detail: tuple[float, float],
    out: torch.Tensor | None = None,
    match: dict | None = None,
    strength: float = 1.0,
) -> torch.Tensor:
    """Blend the model's full-canvas result into the canvas across the
    picture's edge and return [B, H, W, C], written into ``out`` when one
    is given (a long clip then holds no second copy of itself).

    ``canvas`` [1 or B, H, W, C] is the source and fill the model was given,
    ``patch`` [B, H, W, C] what came back, ``depth`` [1, H, W] and the ramps
    come from :func:`seam_plan`. Both pictures split into colour and tone (a
    blur at SEAM_TONE_SIGMA, the canvas's taken only over picture pixels
    SEAM_CLEAN_DEPTH or more inside, so the fill never leaks in) and detail
    (the rest). Colour and tone hand over from the patch to the canvas along
    ``tone``, detail along ``detail``, and part of the texture a cross-fade
    loses halfway is put back. Deeper than both ramps the result is the
    canvas bit for bit; at or outside the first ramp's start it is the patch
    bit for bit - or, with a ``match`` from :func:`blend_in_tone_match`, the
    patch with Tone match's correction taken off at ``strength``. Frames
    never read each other: they go through in chunks, with a cancel check and
    progress between chunks.
    """
    frames, height, width, channels = patch.shape
    dtype, device = patch.dtype, patch.device
    sd = depth.to(device=device, dtype=dtype).view(1, 1, height, width)
    tone_w = _smoothstep((sd - tone[0]) / (tone[1] - tone[0]))
    detail_w = _smoothstep((sd - detail[0]) / (detail[1] - detail[0]))
    model_w = 1.0 - detail_w
    clean = (sd >= SEAM_CLEAN_DEPTH).to(dtype)
    clean_share = _seam_blur(clean, SEAM_TONE_SIGMA).clamp_min(1e-4)
    source = sd >= max(tone[1], detail[1])
    new = sd <= min(tone[0], detail[0])
    ramp = (detail_w > 0) & (detail_w < 1)
    luma = torch.full((1, channels, 1, 1), 1.0 / channels, dtype=dtype, device=device)
    if channels >= 3:
        luma.zero_()
        luma[0, :3, 0, 0] = torch.tensor((0.299, 0.587, 0.114), dtype=dtype, device=device)

    def canvas_layers(image: torch.Tensor):
        tone_layer = _seam_blur(image * clean, SEAM_TONE_SIGMA) / clean_share
        grain = image - tone_layer
        grain_luma = (grain * luma).sum(dim=1, keepdim=True)
        return tone_layer, grain, grain_luma, _seam_blur(grain_luma * grain_luma, SEAM_TEXTURE_SIGMA)

    shared = canvas_layers(canvas[:1].movedim(-1, 1)) if canvas.shape[0] == 1 else None
    if out is None:
        out = torch.empty_like(patch)
    step = max(1, SEAM_CHUNK_PIXELS // max(1, height * width))
    starts = range(0, frames, step)
    progress = comfy.utils.ProgressBar(len(starts)) if len(starts) > 1 else None
    for done, start in enumerate(starts, 1):
        comfy.model_management.throw_exception_if_processing_interrupted()
        stop = min(frames, start + step)
        model = patch[start:stop].movedim(-1, 1)
        if match is not None and strength > 0:
            undone = match.get("undone")
            # A single picture was already taken back through the curves.
            undone = undone[1] if undone is not None and undone[0] is patch and frames == 1 else None
            model = _apply_tone_match(model, match, strength, undone)
        base = (canvas[:1] if shared is not None else canvas[start:stop]).movedim(-1, 1)
        base_tone, base_grain, base_luma, base_power = shared if shared is not None else canvas_layers(base)
        model_tone = _seam_blur(model, SEAM_TONE_SIGMA)
        model_grain = model - model_tone
        grain = model_w * model_grain + detail_w * base_grain
        model_luma = (model_grain * luma).sum(dim=1, keepdim=True)
        model_power = _seam_blur(model_luma * model_luma, SEAM_TEXTURE_SIGMA)
        cross_power = _seam_blur(model_luma * base_luma, SEAM_TEXTURE_SIGMA)
        faded = model_w**2 * model_power + detail_w**2 * base_power + 2.0 * model_w * detail_w * cross_power
        wanted = model_w * model_power + detail_w * base_power
        gain = (wanted.clamp_min(1e-9) / faded.clamp_min(1e-9)).sqrt().clamp(1.0, SEAM_TEXTURE_MAX_GAIN)
        gain = torch.where(ramp, 1.0 + SEAM_TEXTURE_KEEP * (gain - 1.0), torch.ones_like(gain))
        blended = model + tone_w * (base_tone - model_tone) + (grain * gain - model_grain)
        blended = torch.where(source, base, torch.where(new, model, blended.clamp(0.0, 1.0)))
        out[start:stop] = blended.movedim(1, -1)
        if progress is not None:
            progress.update_absolute(done, len(starts))
    return out


def blend(canvas: torch.Tensor, patch: torch.Tensor, mask: torch.Tensor, tone_match: float) -> torch.Tensor:
    """The model's picture ``patch`` [B, H, W, C] blended into ``canvas``
    [1 or B, H, W, C] across the picture's edge. ``mask`` [H, W] is the mask
    the model was handed: 1 over the new area, feathering into the picture.
    ``tone_match`` 0..1 is Tone match's strength, 0 off."""
    mask = mask.float().cpu()
    depth = _signed_depth(mask < SEAM_NEW_AREA)
    tone, detail = seam_ramps(mask, depth)
    depth = depth.unsqueeze(0).to(patch.device)
    match = None
    if tone_match > 0:
        match = blend_in_tone_match(canvas, patch, {"depth": depth, "sampler": mask.unsqueeze(0).to(patch.device)})
    return blend_in_seam(canvas, patch, depth, tone, detail, match=match, strength=tone_match)
