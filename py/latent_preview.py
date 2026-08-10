"""
Latent Preview for Video Sampling - Provides animated previews during KSampler execution for video models.
Based on VideoHelperSuite implementation, with compatibility checks to avoid conflicts.
"""

from PIL import Image
import time
import io
import struct
from threading import Thread
import functools

import torch
import torch.nn.functional as F

# Rates table for different video models (frames per second / temporal compression)
RATES_TABLE = {
    'Mochi': 24 // 6,
    'LTXV': 24 // 8,
    'HunyuanVideo': 24 // 4,
    'Cosmos1CV8x8x8': 24 // 8,
    'Wan21': 16 // 4,
    'Wan22': 16 // 4,
    'MiniMaxH3Video': 24 // 4,
    'MiniMaxH3AV': 24 // 4
}

# TAESD model overrides: latent format class name -> (vae_approx file prefix, kind).
# ComfyUI's get_previewer() warns "could not find models/vae_approx/None" when a
# latent format doesn't define taesd_decoder_name. Some of those TAESD models are
# variants core can't build (taeh3 is a 24-channel, patch-2 TAEHV for MiniMax H3,
# while core's VAE hardcodes HunyuanVideo's 16ch/patch-4), so 'custom' entries are
# loaded by our built-in tiny-VAE loader instead of being handed to ComfyUI.
TAESD_MODEL_OVERRIDES = {
    'MiniMaxH3Video': ('taeh3', 'custom'),
    'MiniMaxH3AV': ('taeh3', 'custom')
}

# Where to get the MiniMax preview VAE (not shipped with ComfyUI)
MINIMAX_TAE_URL = "https://huggingface.co/Kijai/MiniMax-H3-TAE/tree/main/vae_approx"

# Global flag to track if we've hooked the previewer
_hook_installed = False
_original_get_previewer = None


def hook(obj, attr):
    """Decorator to hook/wrap an existing function on an object."""
    def dec(f):
        f = functools.update_wrapper(f, getattr(obj, attr))
        setattr(obj, attr, f)
        return f
    return dec


# Import latent_preview at module level for proper inheritance
import latent_preview as _latent_preview_module


class WrappedPreviewer(_latent_preview_module.LatentPreviewer):
    """
    Wraps the standard latent previewer to provide animated video previews.
    This class intercepts preview requests and sends frames as an animation
    instead of static images.
    """

    def __init__(self, previewer, rate=8, server_instance=None, model_name=None, max_seconds=5):
        # Don't call super().__init__() as we're wrapping an existing previewer
        self.first_preview = True
        self.last_time = 0
        self.c_index = 0
        self.rate = rate
        self.server = server_instance
        self.is_video_taesd = False
        self.model_name = model_name
        # How many SECONDS of video to show in the preview. The same leading slice
        # is re-decoded each step so you watch it progressively denoise. Converted
        # to latent frames via `rate` (latent frames per video second), so the same
        # value means the same duration regardless of model temporal compression.
        self.max_seconds = max(0.5, float(max_seconds))
        # Latent frames in the window = seconds * (latent frames per second).
        self.max_frames_per_step = max(1, int(round(self.max_seconds * self.rate)))

        # Check for an override decoder first (e.g. taeh3 for MiniMax) - these are
        # TAESD variants ComfyUI's VAE class can't build, so we load them ourselves.
        # Takes precedence over whatever core produced (typically a Latent2RGB
        # fallback since core can't build the custom decoder either).
        override = self._load_override_decoder(model_name)
        if override is not None:
            self.taesd = override
            self.is_video_taesd = True
        elif hasattr(previewer, 'taesd'):
            self.taesd = previewer.taesd
            # Detect if this is a video TAESD (VAE-based) vs regular TAESD
            # Video TAESDs use a full VAE with first_stage_model
            if hasattr(self.taesd, 'first_stage_model'):
                self.is_video_taesd = True
        elif hasattr(previewer, 'latent_rgb_factors'):
            self.latent_rgb_factors = previewer.latent_rgb_factors
            self.latent_rgb_factors_bias = previewer.latent_rgb_factors_bias
            self.latent_rgb_factors_reshape = getattr(previewer, 'latent_rgb_factors_reshape', None)
        else:
            raise Exception('Unsupported preview type for animated latent previews')

    def _load_override_decoder(self, model_name):
        """Load a custom TAESD decoder for formats core can't handle (e.g. taeh3).
        Returns the decoder object or None if unavailable/not applicable."""
        if not model_name or model_name not in TAESD_MODEL_OVERRIDES:
            return None
        taesd_name, kind = TAESD_MODEL_OVERRIDES[model_name]
        if kind != 'custom':
            return None
        decoder = _load_custom_taesd(taesd_name)
        if decoder is not None:
            print(f"[FBnodes] Using TAESD override '{taesd_name}' for {model_name} latent previews")
        else:
            print(f"[FBnodes] MiniMax latent preview: '{taesd_name}' not found in models/vae_approx. "
                  f"Download it from: {MINIMAX_TAE_URL}\n"
                  f"[FBnodes] Falling back to the standard (Latent2RGB) preview. "
                  f"You can disable MiniMax support in Settings > FBnodes > 3. Video Sampling.")
        return decoder

    def decode_latent_to_preview_image(self, preview_format, x0):
        """
        Main preview method - intercepts the standard preview call and
        converts it to animated frame previews for video latents.
        """
        import server

        if x0.ndim == 5:
            # Keep batch major for video tensors
            x0 = x0.movedim(2, 1)
            x0 = x0.reshape((-1,) + x0.shape[-3:])

        num_images = x0.size(0)

        # Fixed preview window: always the FIRST `max_frames_per_step` frames of the
        # clip, re-decoded every step so you watch that slice progressively denoise
        # (same frames, getting cleaner each step). Not a rotating window and not
        # time-growing - a constant-size leading slice. Capped at the clip length.
        num_previews = min(self.max_frames_per_step, num_images)
        if num_previews <= 0:
            return None

        if self.first_preview:
            self.first_preview = False
            # Tell the frontend the loop is exactly this fixed window.
            self.server.send_sync('PM_latentpreview', {
                'length': num_previews,
                'rate': self.rate,
                'id': self.server.last_node_id
            })

        # The leading window [0:num_previews], refreshed (re-decoded) each step.
        x0 = x0[:num_previews]

        # Process previews. NOTE: synchronous (.run()), not a background thread -
        # the async/threaded version silently failed to display (send_sync from a
        # non-event-loop thread + inference-mode tensors). The frame cap above is
        # what bounds the per-step cost, so sync is acceptable and reliable.
        if hasattr(self, 'latent_rgb_factors'):
            self._process_latent2rgb_batch(x0, 0, num_previews)
        else:
            self._process_taesd_batch(x0, 0, num_previews)
        return None

    def _process_taesd_batch(self, latent_frames, ind, leng):
        """Process and send preview frames to the frontend.

        Args:
            latent_frames: Latent tensor, shape (N, C, H, W) where N is number of frames
            ind: Current frame index
            leng: Total number of frames
        """
        import server

        # The sampler hands us an inference-mode tensor; any decode of it (even in
        # this background thread) trips "Inference tensors cannot be saved for
        # backward". Clone into a normal tensor AND run all decode work under
        # no_grad so autograd never touches it.
        with torch.no_grad():
            latent_frames = latent_frames.detach().clone()

            # Tiny-VAE decoders (built-in TAEHV variants / flat TAE) expose decode_video
            # which handles MemBlock temporal state correctly. Use it for the whole
            # batch of frames instead of decoding one at a time.
            if self.is_video_taesd and hasattr(self.taesd, 'decode_video'):
                try:
                    # latent_frames is (N, C, H, W) - restack to (1, C, T, H, W)
                    x0_5d = latent_frames.movedim(0, 1).unsqueeze(0)  # (N,C,H,W) -> (1,C,N,H,W)
                    frames = self.taesd.decode_video(x0_5d)  # -> (T, H, W, 3) in 0-1
                    if frames.ndim == 4:
                        for i in range(frames.shape[0]):
                            preview_image = self._tensor_to_image(frames[i], do_scale=False)
                            preview_image = self._resize_preview(preview_image)
                            self._send_preview_frame(preview_image, ind, leng)
                            ind = (ind + 1) % leng
                        return
                except Exception as e:
                    print(f"[FBnodes] decode_video preview failed, falling back to per-frame: {e}")

            # For TAESD, decode each frame (don't change this - it works)
            for i in range(latent_frames.size(0)):
                frame_latent = latent_frames[i:i + 1]  # Keep batch dim: (1, C, H, W)

                # Decode single frame to PIL Image (same as ComfyUI does)
                preview_image = self.decode_single_frame(frame_latent)

                if preview_image is None:
                    continue

                preview_image = self._resize_preview(preview_image)
                self._send_preview_frame(preview_image, ind, leng)
                ind = (ind + 1) % leng

    def _resize_preview(self, preview_image):
        """Downscale a PIL preview so its longest side is at most 512."""
        if preview_image.width > 512 or preview_image.height > 512:
            if preview_image.width > preview_image.height:
                new_width = 512
                new_height = int(512 * preview_image.height / preview_image.width)
            else:
                new_height = 512
                new_width = int(512 * preview_image.width / preview_image.height)
            preview_image = preview_image.resize((new_width, new_height), Image.LANCZOS)
        return preview_image

    def _send_preview_frame(self, preview_image, ind, leng):
        """Encode and send a single preview frame to the frontend."""
        import server

        message = io.BytesIO()
        message.write((1).to_bytes(length=4, byteorder='big') * 2)
        message.write(ind.to_bytes(length=4, byteorder='big'))
        message.write(struct.pack('16p', self.server.last_node_id.encode('ascii')))
        preview_image.save(message, format="JPEG", quality=95)

        self.server.send_sync(
            server.BinaryEventTypes.PREVIEW_IMAGE,
            message.getvalue(),
            self.server.client_id
        )

    def _process_latent2rgb_batch(self, x0, ind, leng):
        """Process Latent2RGB previews using batch decode (VHS style)."""
        import server

        # Apply reshape if needed
        if self.latent_rgb_factors_reshape is not None:
            x0 = self.latent_rgb_factors_reshape(x0)

        self.latent_rgb_factors = self.latent_rgb_factors.to(dtype=x0.dtype, device=x0.device)
        if self.latent_rgb_factors_bias is not None:
            self.latent_rgb_factors_bias = self.latent_rgb_factors_bias.to(dtype=x0.dtype, device=x0.device)

        # Batch decode: x0 is (N, C, H, W), output is (N, H, W, 3)
        image_tensor = F.linear(x0.movedim(1, -1), self.latent_rgb_factors,
                                bias=self.latent_rgb_factors_bias)

        # Resize if needed
        if image_tensor.size(1) > 512 or image_tensor.size(2) > 512:
            image_tensor = image_tensor.movedim(-1, 0)
            if image_tensor.size(2) < image_tensor.size(3):
                height = (512 * image_tensor.size(2)) // image_tensor.size(3)
                image_tensor = F.interpolate(image_tensor, (height, 512), mode='bilinear')
            else:
                width = (512 * image_tensor.size(3)) // image_tensor.size(2)
                image_tensor = F.interpolate(image_tensor, (512, width), mode='bilinear')
            image_tensor = image_tensor.movedim(0, -1)

        # Convert to uint8 (scale from -1..1 to 0..255)
        previews_ubyte = (((image_tensor + 1.0) / 2.0).clamp(0, 1).mul(0xFF)).to(device="cpu", dtype=torch.uint8)

        # Send each frame
        for preview in previews_ubyte:
            i = Image.fromarray(preview.numpy())
            message = io.BytesIO()
            message.write((1).to_bytes(length=4, byteorder='big') * 2)
            message.write(ind.to_bytes(length=4, byteorder='big'))
            message.write(struct.pack('16p', self.server.last_node_id.encode('ascii')))
            i.save(message, format="JPEG", quality=95)
            self.server.send_sync(
                server.BinaryEventTypes.PREVIEW_IMAGE,
                message.getvalue(),
                self.server.client_id
            )
            ind = (ind + 1) % leng

    def decode_single_frame(self, x0):
        """Decode a single TAESD latent frame to PIL Image.
        Only used by _process_taesd_batch().

        Args:
            x0: Latent tensor, shape (1, C, H, W) for images or (1, C, T, H, W) for video

        Returns:
            PIL.Image
        """
        if self.is_video_taesd:
            # TAEHVPreviewerImpl style: x0[:1, :, :1] then [0][0]
            if x0.ndim == 4:
                x0 = x0.unsqueeze(2)  # (1, C, H, W) -> (1, C, 1, H, W)

            x_sample = self.taesd.decode(x0[:1, :, :1])[0][0]

            # # Apply contrast boost for Wan models (TAESD looks washed out)
            # if self.model_name and self.model_name.startswith('Wan'):
            #     x_sample = self._apply_contrast(x_sample, contrast=1.2, brightness=1.0)

            # Video TAEs output 0-1 range, not -1 to 1
            return self._tensor_to_image(x_sample, do_scale=False)
        else:
            # TAESDPreviewerImpl style: decode(x0[:1])[0].movedim(0, 2)
            x_sample = self.taesd.decode(x0[:1])[0].movedim(0, 2)
            return self._tensor_to_image(x_sample, do_scale=True)

    def _apply_contrast(self, tensor, contrast=1.0, brightness=1.0):
        """Apply contrast and brightness adjustment to a tensor in 0-1 range."""
        # Contrast: (x - 0.5) * contrast + 0.5
        # Brightness: x * brightness
        tensor = (tensor - 0.5) * contrast + 0.5
        tensor = tensor * brightness
        return tensor.clamp(0, 1)

    def _tensor_to_image(self, tensor, do_scale=True):
        """Convert tensor to PIL Image, matching ComfyUI's preview_to_image."""
        import comfy.model_management

        if do_scale:
            latents_ubyte = (((tensor + 1.0) / 2.0).clamp(0, 1).mul(0xFF))
        else:
            latents_ubyte = (tensor.clamp(0, 1).mul(0xFF))

        if comfy.model_management.directml_enabled:
            latents_ubyte = latents_ubyte.to(dtype=torch.uint8)

        latents_ubyte = latents_ubyte.to(
            device="cpu",
            dtype=torch.uint8,
            non_blocking=comfy.model_management.device_supports_non_blocking(tensor.device)
        )

        return Image.fromarray(latents_ubyte.numpy())


def _is_taehv_state_dict(sd):
    """Detect the temporal TAEHV checkpoint format (vs flat TAESD-style)."""
    return 'decoder.1.weight' in sd and 'decoder.22.bias' in sd


# ---------------------------------------------------------------------------
# Built-in tiny-VAE loaders (adapted from kjnodes' tiny_vae.py, MIT).
#
# ComfyUI core can't build these:
# - Flat TAE decoders: core's Decoder hardcodes a 64-wide stack with 3 upsamples;
#   anything else (e.g. the 2D taeh3 at 96 wide with 4 upsamples) fails to load.
#   The architecture is recoverable from the checkpoint: keys are positional
#   module indices, so N.conv.0.weight is a Block, N.weight a conv, and the gaps
#   are parameterless modules.
# - TAEHV variants: core's TAEHV only derives patch_size from a fixed channel
#   table with no entry for MiniMax H3's 24 channels / patch 2.
# ---------------------------------------------------------------------------

def _build_flat_tae_decoder(sd):
    """Reconstruct a flat TAESD-style decoder from a positional-index state dict."""
    import torch.nn as nn
    from comfy.taesd.taesd import Block, Clamp, conv

    by_index = {}
    for k, v in sd.items():
        head, _, rest = k.partition(".")
        if not head.isdigit():
            raise ValueError(f"not a flat TAE decoder state dict (unexpected key '{k}')")
        by_index.setdefault(int(head), {})[rest] = v

    modules = []
    for i in range(max(by_index) + 1):
        entry = by_index.get(i)
        if entry is None:
            # index 0 is the input Clamp, 2 the ReLU after the input conv, the rest are upsamples
            modules.append(Clamp() if i == 0 else nn.ReLU() if i == 2 else nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in entry:
            w = entry["conv.0.weight"]
            # only pass the kwarg when it's needed - older ComfyUI has no midblock-GN variant
            if "pool.0.weight" in entry:
                modules.append(Block(w.shape[1], w.shape[0], use_midblock_gn=True))
            else:
                modules.append(Block(w.shape[1], w.shape[0]))
        elif "weight" in entry:
            w = entry["weight"]
            modules.append(conv(w.shape[1], w.shape[0], bias="bias" in entry))
        else:
            raise ValueError(f"unrecognized TAE decoder module at index {i}: {sorted(entry)}")
    return nn.Sequential(*modules)


def _vae_device_dtype(device=None, dtype=None):
    import comfy.model_management

    device = device if device is not None else comfy.model_management.vae_device()
    dtype = dtype if dtype is not None else comfy.model_management.vae_dtype(
        device, [torch.float16, torch.bfloat16])
    return device, dtype


def _place_model(model, device, dtype):
    import torch.nn as nn  # noqa: F401

    model = model.eval().to(device=device, dtype=dtype)
    if torch.device(device).type == "cuda":
        model.to(memory_format=torch.channels_last)
    return model


class _FlatTAEDecoder:
    """Decode-only flat tiny VAE. Output is [0, 1], matching the TAE convention."""

    def __init__(self, sd, device=None, dtype=None):
        # keys may carry a "taesd_decoder."/"decoder." prefix; strip whatever is common
        prefix = ""
        first = next(iter(sd))
        if not first.split(".")[0].isdigit():
            prefix = first.split(".")[0] + "."
            sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}

        self.device, self.dtype = _vae_device_dtype(device, dtype)
        self.model = _build_flat_tae_decoder(sd)
        self.model.load_state_dict(sd)
        self.model = _place_model(self.model, self.device, self.dtype)

        self.latent_channels = self.model[1].weight.shape[1]
        import torch.nn as nn
        self.upscale_ratio = 2 ** sum(isinstance(m, nn.Upsample) for m in self.model)

    def decode(self, latent):
        """[B, C, H, W] -> [B, 3, H*ratio, W*ratio], float32 on the input device."""
        out = self.model(latent.to(device=self.device, dtype=self.dtype))
        return out.to(device=latent.device, dtype=torch.float32)

    def decode_video(self, latent, frame_indices=None):
        """[B, C, T, H, W] -> [T, H*ratio, W*ratio, 3]. Decodes one frame at a time."""
        x = latent[0]
        indices = range(x.shape[1]) if frame_indices is None else frame_indices
        frames = [self.decode(x[:, t].unsqueeze(0))[0].movedim(0, -1) for t in indices]
        return torch.stack(frames, dim=0)


class _TAEHVDecoder:
    """Temporal tiny VAE (taehv family, incl. MiniMax H3's taeh3), decode only."""

    def __init__(self, sd, device=None, dtype=None):
        from comfy.taesd.taehv import TAEHV, conv

        latent_channels = sd['decoder.1.weight'].shape[1]
        # final conv emits image_channels * patch_size**2
        patch_size = max(1, int(round((sd['decoder.22.bias'].shape[0] / 3) ** 0.5)))

        model = TAEHV(latent_channels=latent_channels)
        # core derives patch_size from the channel count and has no entry for H3's 24;
        # the input/output convs are the only parts of the model that depend on it
        if getattr(model, 'patch_size', None) != patch_size:
            model.patch_size = patch_size
            model.encoder[0] = conv(3 * patch_size ** 2, model.encoder[0].out_channels)
            model.decoder[-1] = conv(model.decoder[-1].in_channels, 3 * patch_size ** 2)
        model.load_state_dict(sd)
        del model.encoder  # decode only, keep it off the device

        self.device, self.dtype = _vae_device_dtype(device, dtype)
        self.model = _place_model(model, self.device, self.dtype)
        self.latent_channels = latent_channels
        # marker so WrappedPreviewer detects this as a video TAESD
        self.first_stage_model = self.model
        self.is_h3 = latent_channels == 24 and patch_size == 2
        # spatial upscale factor (patch embed * decoder upsamples) - lets the
        # previewer downscale the latent before decoding to the 512px display cap
        import torch.nn as nn
        self.upscale_ratio = patch_size * 2 ** sum(
            isinstance(m, nn.Upsample) for m in self.model.decoder)

    def _decode(self, latent):
        """[B, C, T, H, W] -> [B, 3, T*t_upscale - trim, H*ratio, W*ratio]"""
        out = self.model.decode(latent.to(device=self.device, dtype=self.dtype))
        return out.to(device=latent.device, dtype=torch.float32)

    def decode(self, latent):
        """Decode to image. Accepts [B, C, H, W] (adds a T dim) or [B, C, T, H, W]
        (used as-is). Returns [B, 3, H*ratio, W*ratio] for the first frame."""
        if latent.ndim == 4:
            latent = latent.unsqueeze(2)  # [B, C, H, W] -> [B, C, 1, H, W]
        # latent is now [B, C, T, H, W]; decode and take the first temporal frame
        return self._decode(latent)[:, :, 0]

    def decode_video(self, latent, frame_indices=None):
        """[B, C, T, H, W] -> [n, H*ratio, W*ratio, 3], contiguous."""
        t_total = latent.shape[2]
        n = t_total if frame_indices is None else max(1, min(len(frame_indices), t_total))
        # MemBlock state chains forward, so frames can't be sampled across the clip
        # without decoding everything before them - take a prefix to keep cost bounded
        out = self._decode(latent[:1, :, :n])[0].movedim(0, -1)
        if out.shape[0] > n:
            # subsample before paying for the host copy
            out = out[torch.linspace(0, out.shape[0] - 1, n).round().long()]
        return out.contiguous()


def _load_custom_taesd(taesd_name):
    """
    Load a TAESD variant that ComfyUI core can't build (e.g. taeh3 for MiniMax H3)
    using the built-in tiny-VAE loaders. Returns a decoder with .decode(),
    .decode_video() and .first_stage_model, or None if the model can't be loaded.
    """
    try:
        import folder_paths
        path = next(
            (fn for fn in folder_paths.get_filename_list('vae_approx')
             if fn.startswith(taesd_name)),
            None
        )
        if path is None:
            return None
        full_path = folder_paths.get_full_path('vae_approx', path)

        import comfy.utils
        sd = comfy.utils.load_torch_file(full_path, safe_load=True)
        if _is_taehv_state_dict(sd):
            return _TAEHVDecoder(sd)
        return _FlatTAEDecoder(sd)

    except Exception as e:
        print(f"[FBnodes] Failed to load TAESD override '{taesd_name}': {e}")
        return None


def inject_taesd_overrides():
    """
    Fix ComfyUI's "could not find models/vae_approx/None" warning for latent
    formats that don't define taesd_decoder_name (e.g. MiniMaxH3Video).

    - 'core' kind: sets taesd_decoder_name on the latent format class and registers
      the name in ComfyUI's VIDEO_TAES list (for VAE-style video TAEs core can build).
    - 'custom' kind: the decoder can't be built by core's VAE class (e.g. taeh3 is a
      24ch/patch-2 TAEHV), so we load it ourselves in WrappedPreviewer. The format
      gets a placeholder name (absent from VIDEO_TAES) so core takes the plain TAESD
      path, fails gracefully, and falls back to Latent2RGB - no warning, no crash.
    """
    try:
        import folder_paths
        import comfy.latent_formats as latent_formats

        video_taes = getattr(_latent_preview_module, 'VIDEO_TAES', None)
        available = folder_paths.get_filename_list('vae_approx')

        patched = []
        for format_name, (taesd_name, kind) in TAESD_MODEL_OVERRIDES.items():
            latent_cls = getattr(latent_formats, format_name, None)
            if latent_cls is None:
                continue

            # Respect ComfyUI if it already defines a decoder for this format
            if getattr(latent_cls, 'taesd_decoder_name', None):
                continue

            # Only patch if the TAESD model file is actually present
            if not any(fn.startswith(taesd_name) for fn in available):
                print(f"[FBnodes] MiniMax latent preview: models/vae_approx/{taesd_name}.* not found.")
                print(f"[FBnodes] Download it from: {MINIMAX_TAE_URL}")
                print(f"[FBnodes] MiniMax will use the standard (Latent2RGB) preview. "
                      f"You can disable this support in Settings > FBnodes > 3. Video Sampling.")
                continue

            if kind == 'core':
                # Full video TAEs (VAE-style), loadable by core via TAEHVPreviewerImpl
                latent_cls.taesd_decoder_name = taesd_name
                if video_taes is not None and taesd_name not in video_taes:
                    video_taes.append(taesd_name)
            else:
                # 'custom': core can't build this variant (plain TAESD AND VAE paths
                # both fail on e.g. taeh3), so give it a placeholder name that won't
                # match any file. Core finds nothing -> falls back to Latent2RGB
                # silently (no warning, no crash), and WrappedPreviewer swaps in our
                # correctly-sized decoder at preview time.
                latent_cls.taesd_decoder_name = '_fbnodes_custom_' + taesd_name

            patched.append(format_name)

        if patched:
            print(f"[FBnodes] TAESD preview override installed for: {', '.join(patched)}")
        return True

    except Exception as e:
        print(f"[FBnodes] Failed to inject TAESD overrides: {e}")
        return False


def is_vhs_installed():
    """Check if VideoHelperSuite is installed and has latent preview enabled."""
    try:
        # Check if VHS module is loaded
        import sys
        for module_name in sys.modules:
            if 'videohelpersuite' in module_name.lower():
                # VHS is installed, check if it has hooked the previewer
                func = getattr(_latent_preview_module, 'get_previewer', None)
                if func and hasattr(func, '__wrapped__'):
                    # VHS has already hooked the previewer
                    return True
        return False
    except:
        return False


def install_latent_preview_hook():
    """
    Install the latent preview hook if:
    1. It's not already installed by us
    2. VideoHelperSuite hasn't already installed it
    """
    global _hook_installed, _original_get_previewer

    # Inject TAESD model overrides regardless of hook state - this fixes the
    # core "could not find models/vae_approx/None" warning and is independent
    # of the animated preview hook (also applies when VHS handles previews).
    inject_taesd_overrides()

    if _hook_installed:
        print("[FBnodes] Latent preview hook already installed")
        return True

    if is_vhs_installed():
        print("[FBnodes] VideoHelperSuite detected with latent preview - skipping to avoid conflict")
        return False

    try:
        import server
        serv = server.PromptServer.instance

        # Store original function
        _original_get_previewer = _latent_preview_module.get_previewer

        @hook(_latent_preview_module, 'get_previewer')
        def get_latent_video_previewer(device, latent_format, *args, **kwargs):
            """Wrapped previewer that checks settings and returns animated previewer if enabled."""
            previewer = get_latent_video_previewer.__wrapped__(device, latent_format, *args, **kwargs)

            try:
                extra_info = next(serv.prompt_queue.currently_running.values().__iter__())[3]['extra_pnginfo']['workflow']['extra']
                prev_setting = extra_info.get('PM_latentpreview', False)
                minimax_setting = extra_info.get('FB_minimax_latentpreview', True)
                max_seconds = extra_info.get('FB_preview_seconds', 5)
            except:
                # For safety since there's lots of keys, any of which can fail
                prev_setting = False
                minimax_setting = True
                max_seconds = 5

            if not prev_setting or not hasattr(previewer, "decode_latent_to_preview"):
                return previewer

            model_name = latent_format.__class__.__name__

            # Respect the MiniMax support toggle - skip the custom TAESD override
            # (and its decoder load) when the user disabled it in settings.
            if model_name in TAESD_MODEL_OVERRIDES and not minimax_setting:
                return previewer

            rate_setting = RATES_TABLE.get(model_name, 8)
            return WrappedPreviewer(previewer, rate_setting, serv, model_name, max_seconds=max_seconds)

        _hook_installed = True
        print("[FBnodes] Latent preview hook installed successfully")
        return True

    except Exception as e:
        print(f"[FBnodes] Failed to install latent preview hook: {e}")
        return False


def uninstall_latent_preview_hook():
    """Restore the original get_previewer function."""
    global _hook_installed, _original_get_previewer

    if not _hook_installed or _original_get_previewer is None:
        return

    try:
        _latent_preview_module.get_previewer = _original_get_previewer
        _hook_installed = False
        _original_get_previewer = None
        print("[FBnodes] Latent preview hook uninstalled")
    except Exception as e:
        print(f"[FBnodes] Failed to uninstall latent preview hook: {e}")
