"""Dependency-free preview routing tests; decoder execution is tested separately."""

import ast
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SOURCE = Path(__file__).resolve().parents[1] / 'py' / 'latent_preview.py'


class LatentPreviewTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(SOURCE.read_text())
        names = {'TAESD_INJECTIONS', '_FORMAT_TO_INJECTION',
                 '_register_krea2_preview_format', 'WrappedPreviewer'}
        selected = [node for node in tree.body if
                    isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names
                    or isinstance(node, ast.Assign) and any(
                        isinstance(target, ast.Name) and target.id in names
                        for target in node.targets)]
        self.env = {'_latent_preview_module': SimpleNamespace(LatentPreviewer=object)}
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), self.env)
        self.comfy = ModuleType('comfy')
        self.supported_models = ModuleType('comfy.supported_models')
        self.cli_args = ModuleType('comfy.cli_args')
        self.cli_args.LatentPreviewMethod = SimpleNamespace(TAESD='taesd', Auto='auto')
        self.cli_args.args = SimpleNamespace(preview_method='auto')
        self.comfy.supported_models = self.supported_models
        self.comfy.cli_args = self.cli_args
        modules = patch.dict(sys.modules, {
            'comfy': self.comfy,
            'comfy.supported_models': self.supported_models,
            'comfy.cli_args': self.cli_args,
        })
        modules.start()
        self.addCleanup(modules.stop)
        self.decoder = Mock()
        self.env['_load_custom_taesd'] = Mock(return_value=self.decoder)
        self.previewer = self.env['WrappedPreviewer'].__new__(self.env['WrappedPreviewer'])
        self.previewer._inject_enabled = True
        self.previewer._injection_file = None

    def test_krea2_registration_preserves_wan_and_is_idempotent(self):
        class Wan21:
            def __init__(self):
                self.taesd_decoder_name = 'lighttaew2_1'

        self.supported_models.Krea2 = type('Krea2', (), {'latent_format': Wan21})
        self.supported_models.Wan = type('Wan', (), {'latent_format': Wan21})
        register = self.env['_register_krea2_preview_format']
        register()
        registered = self.supported_models.Krea2.latent_format
        self.assertTrue(issubclass(registered, Wan21))
        self.assertEqual(self.env['_FORMAT_TO_INJECTION'][registered.__name__], 'krea2')
        self.assertIs(self.supported_models.Wan.latent_format, Wan21)
        self.assertEqual(registered().taesd_decoder_name, 'lighttaew2_1')
        self.assertNotIn('Wan21', self.env['_FORMAT_TO_INJECTION'])
        register()
        self.assertIs(self.supported_models.Krea2.latent_format, registered)

    def test_older_comfy_without_krea2(self):
        self.env['_register_krea2_preview_format']()
        self.assertFalse(hasattr(self.supported_models, 'Krea2'))

    def test_default_and_custom_krea2_filenames(self):
        for filename, expected in [
            (None, 'TAE_Krea2_AcademiaSD.safetensors'),
            ('  ', 'TAE_Krea2_AcademiaSD.safetensors'),
            ('  custom/krea2.safetensors  ', 'custom/krea2.safetensors'),
        ]:
            with self.subTest(filename=filename):
                self.previewer._injection_file = filename
                result = self.previewer._load_override_decoder('Krea2PreviewFormat')
                self.assertIs(result, self.decoder)
                self.env['_load_custom_taesd'].assert_called_with(expected)

    def test_disabled_injection_and_non_taesd_preview_methods(self):
        self.previewer._inject_enabled = False
        self.assertIsNone(self.previewer._load_override_decoder('Krea2PreviewFormat'))
        self.previewer._inject_enabled = True
        for method in ('latent2rgb', 'none'):
            self.cli_args.args.preview_method = method
            self.assertIsNone(self.previewer._load_override_decoder('Krea2PreviewFormat'))
        self.env['_load_custom_taesd'].assert_not_called()

    def test_missing_decoder_and_wan_do_not_use_krea2(self):
        self.assertIsNone(self.previewer._load_override_decoder('Wan21'))
        self.env['_load_custom_taesd'].assert_not_called()
        self.env['_load_custom_taesd'].return_value = None
        self.assertIsNone(self.previewer._load_override_decoder('Krea2PreviewFormat'))


if __name__ == '__main__':
    unittest.main()