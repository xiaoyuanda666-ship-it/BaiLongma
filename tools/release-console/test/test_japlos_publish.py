import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from io import BytesIO
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location('publish_japlos', Path(__file__).parents[1] / 'japlos-publish.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublishGates(unittest.TestCase):
    def fixture(self, root):
        (root / 'VERSION').write_text('1.2.3')
        records = []
        for arch in ('arm64', 'x64'):
            source = root / arch
            source.mkdir()
            for name in ('appcast.xml', 'Japlos-v2-1.2.3.dmg'):
                file = source / name
                file.write_bytes(b'checked artifact')
                records.append(dict(arch=arch, name=name, path=str(file), size=file.stat().st_size, sha512=module.checksum(file)))
        return dict(passed=True, records=records, checks=[], version='1.2.3')

    def test_failed_preflight_never_uploads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.fixture(root)
            result['passed'] = False
            with patch.object(module.inspection, 'inspect', return_value=result), patch.object(module.inspection, 'run') as run:
                self.assertFalse(module.publish(root, root, '1.2.3', ['arm64'])['passed'])
                run.assert_not_called()

    def test_changed_second_architecture_prevents_all_uploads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.fixture(root)
            Path(result['records'][-1]['path']).write_bytes(b'changed bytes')
            with patch.object(module.inspection, 'inspect', return_value=result), patch.object(module.inspection, 'run') as run, patch.object(module, 'check_remote_version'):
                with self.assertRaisesRegex(ValueError, '检查后变化'):
                    module.publish(root, root, '1.2.3', ['arm64', 'x64'])
                self.assertTrue(all('--dry-run' in call.args[0] for call in run.call_args_list))

    def test_publish_uses_snapshots_and_verifies_each_architecture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.fixture(root)
            def execute(args, **kwargs):
                source = args[4]
                self.assertNotEqual(source.parent, root)
                self.assertTrue((source / 'appcast.xml').is_file())
                self.assertIn('japlos-v2', args)
                return 'ok'
            with patch.object(module.inspection, 'inspect', return_value=result), patch.object(module.inspection, 'run', side_effect=execute) as run, patch.object(module, 'check_remote_version'), patch.object(module, 'verify_online', return_value='verified') as verify:
                self.assertTrue(module.publish(root, root, '1.2.3', ['arm64', 'x64'])['passed'])
                self.assertEqual(run.call_count, 4)
                self.assertEqual(verify.call_count, 2)
                self.assertTrue(all('--dry-run' in call.args[0] for call in run.call_args_list[:2]))

    def test_second_architecture_failure_preserves_first_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.fixture(root)
            with patch.object(module.inspection, 'inspect', return_value=result), patch.object(module.inspection, 'run', return_value='ok'), patch.object(module, 'check_remote_version'), patch.object(module, 'verify_online', side_effect=['verified', ValueError('download mismatch')]):
                outcome = module.publish(root, root, '1.2.3', ['arm64', 'x64'])
                self.assertFalse(outcome['passed'])
                self.assertTrue(outcome['checks'][1]['ok'])
                self.assertFalse(outcome['checks'][-1]['ok'])
                self.assertIn('可能已更新服务器', outcome['checks'][-1]['name'])

    def test_remote_downgrade_is_blocked(self):
        feed = b'<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>9.0.0</sparkle:version></item></channel></rss>'
        with patch.object(module.urllib.request, 'urlopen', return_value=BytesIO(feed)):
            with self.assertRaisesRegex(ValueError, '禁止版本回退'):
                module.check_remote_version('arm64', '1.2.3')

    def test_only_missing_feed_allows_first_publication(self):
        with patch.object(module.urllib.request, 'urlopen', side_effect=HTTPError('url', 404, 'missing', {}, None)):
            module.check_remote_version('arm64', '1.2.3')
        with patch.object(module.urllib.request, 'urlopen', side_effect=URLError('network unavailable')):
            with self.assertRaises(URLError):
                module.check_remote_version('arm64', '1.2.3')

    def test_stale_version_is_blocked_before_inspection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            with patch.object(module.inspection, 'inspect') as inspect:
                with self.assertRaisesRegex(ValueError, 'VERSION'):
                    module.publish(root, root, '1.2.2', ['arm64'])
                inspect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
