import base64
import importlib.util
import tempfile
import unittest
from pathlib import Path
import os

spec = importlib.util.spec_from_file_location('inspect_release', Path(__file__).parents[1] / 'japlos-inspect.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
UPDATE_ROOT = Path(os.environ.get('JAPLOS_UPDATE_SERVER_PROJECT', Path.home() / 'Documents/小白龙更新服务器'))


class ProductIsolation(unittest.TestCase):
    def fixture(self, root, product='japlos-v2', version='1.2.3'):
        (root / 'VERSION').write_text('1.2.3')
        source = root / 'dist/arm64/updates/japlos-v2/1.2.3'
        source.mkdir(parents=True)
        name = f'Japlos-v2-{version}-arm64.dmg'
        (source / name).write_bytes(b'fixture')
        signature = base64.b64encode(bytes(64)).decode()
        (source / 'appcast.xml').write_text(f'''<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>{version}</sparkle:version><enclosure url="https://bailongma.top/updates/{product}/stable/mac/arm64/{name}" length="7" sparkle:edSignature="{signature}"/></item></channel></rss>''')

    def test_scan_reports_missing_current_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'VERSION').write_text('1.2.3')
            result = module.inspect('scan', root, UPDATE_ROOT, ['arm64'])
            self.assertFalse(result['passed'])
            self.assertTrue(all(not file['exists'] for file in result['records']))

    def test_other_product_feed_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root, product='japlos')
            self.assertFalse(module.inspect('scan', root, UPDATE_ROOT, ['arm64'])['passed'])

    def test_version_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root, version='1.2.2')
            self.assertFalse(module.inspect('scan', root, UPDATE_ROOT, ['arm64'])['passed'])

    def test_matching_feed_scan_passes_without_claiming_signature_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            result = module.inspect('scan', root, UPDATE_ROOT, ['arm64'])
            self.assertTrue(result['passed'])
            self.assertEqual(len(result['checks']), 1)


if __name__ == '__main__':
    unittest.main()
