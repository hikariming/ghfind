import importlib.util
import pathlib
import tempfile
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'run-feed-e2e.py'
spec = importlib.util.spec_from_file_location('feed_e2e', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SafetyGates(unittest.TestCase):
    def test_output_and_source_are_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            root = base / 'repo'
            root.mkdir()
            self.assertEqual(module.options_valid('a' * 40, str(base / 'new'), root), base / 'new')
            for target in [root, root / 'inside', base]:
                with self.assertRaises(ValueError):
                    module.options_valid('a' * 40, str(target), root)
            with self.assertRaises(ValueError):
                module.options_valid('main', str(base / 'new'), root)

    def test_cleanup_requires_both_owner_and_source(self):
        config = {'Config': {'Labels': {module.OWNER_LABEL: 'owner', module.SHA_LABEL: 'a' * 40}}}
        self.assertTrue(module.owned(config, 'owner', 'a' * 40))
        self.assertFalse(module.owned(config, 'other', 'a' * 40))
        self.assertFalse(module.owned(config, 'owner', 'b' * 40))

    def test_no_skip_or_partial_pass_can_be_receipt(self):
        report = {'format': module.FORMAT, 'status': 'passed', 'sourceSha': 'a' * 40, 'sourceTree': 'b' * 40, 'cleanupSuccessful': True,
                  'profiles': {key: {'status': 'passed', 'milestones': dict.fromkeys(module.MILESTONES, True)} for key in ['cf_d1_r2', 'postgres']}}
        module.validate_receipt(report, 'a' * 40, 'b' * 40)
        report['profiles']['postgres']['milestones']['deletionCompleted'] = False
        with self.assertRaises(ValueError):
            module.validate_receipt(report, 'a' * 40, 'b' * 40)
        report['profiles'].pop('postgres')
        with self.assertRaises(ValueError):
            module.validate_receipt(report, 'a' * 40, 'b' * 40)


if __name__ == '__main__':
    unittest.main()
