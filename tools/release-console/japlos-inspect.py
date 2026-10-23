#!/usr/bin/env python3
"""Read-only release inspection for Japlos v2. Never publishes or generates feeds."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

SPARKLE = '{http://www.andymatuschak.org/xml-namespaces/sparkle}'


def run(args, env=None, timeout=180):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True,
                            timeout=timeout, env=env)
    if result.returncode:
        raise ValueError((result.stdout + '\n' + result.stderr).strip()[-10000:] or f'{args[0]} exited {result.returncode}')
    return result.stdout.strip()


def inspect(action, root, update_root, archs):
    version = (root / 'VERSION').read_text().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid VERSION')
    sys.path.insert(0, str(update_root / 'scripts'))
    from sparkle_release import validate_appcast, release_version
    result = dict(product='Japlos v2', version=version, root=str(root), records=[], checks=[], action=action)
    for arch in archs:
        build_arch = 'x86_64' if arch == 'x64' else 'arm64'
        source = root / 'dist' / build_arch / 'updates' / 'japlos-v2' / version
        dmg = source / f'Japlos-v2-{version}-{build_arch}.dmg'
        feed = source / 'appcast.xml'
        for file in (dmg, feed):
            record = dict(arch=arch, name=file.name, path=str(file), exists=file.is_file(), size=0, sha512='')
            if record['exists']:
                record['size'] = file.stat().st_size
                digest = hashlib.sha512()
                with file.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                record['sha512'] = digest.hexdigest()
            result['records'].append(record)

        def check(name, fn):
            try:
                detail = fn()
                result['checks'].append(dict(arch=arch, name=name, ok=True, detail=str(detail or '通过')))
                return True
            except Exception as error:
                result['checks'].append(dict(arch=arch, name=name, ok=False, detail=str(error)))
                return False

        def manifest():
            validate_appcast(source, f'japlos-v2/stable/mac/{arch}')
            if release_version(feed) != tuple(map(int, version.split('.'))):
                raise ValueError('appcast version differs from VERSION')
            return f'版本 {version} · japlos-v2/stable/mac/{arch} · 安装包大小与清单一致'
        valid = check('版本、架构、更新地址与产物完整性', manifest)
        if action == 'scan' or not valid:
            continue
        check('本地发布 Dry Run（不上传）', lambda: run([
            sys.executable, update_root / 'scripts/publish_release.py', 'mac', arch,
            source, 'stable', '--product', 'japlos-v2', '--backend', 'local', '--dry-run'], timeout=300))
        if action == 'dry-run':
            continue
        tools = root / '.build/sparkle-tools/2.10.0/bin'
        check('Sparkle 清单签名', lambda: run([tools / 'sign_update', '--account', 'com.japlos.updates', '--verify', feed]))
        signature = ET.parse(feed).find('./channel/item/enclosure').get(SPARKLE + 'edSignature')
        check('Sparkle 安装包签名', lambda: run([tools / 'sign_update', '--account', 'com.japlos.updates', '--verify', dmg, signature]))
        check('DMG 代码签名', lambda: run(['/usr/bin/codesign', '--verify', '--strict', dmg]))
        check('DMG 公证票据', lambda: run(['/usr/bin/xcrun', 'stapler', 'validate', dmg]))
        with tempfile.TemporaryDirectory(prefix='japlos-preflight-') as directory:
            mount = Path(directory) / 'volume'
            mount.mkdir()
            attached = check('挂载实际更新安装包', lambda: run(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]))
            if not attached:
                continue
            try:
                app = mount / 'Japlos-v2.app'
                env = dict(os.environ, BAILONGMA_BUILD_ARCH=build_arch)
                def identity():
                    with (app / 'Contents/Info.plist').open('rb') as stream:
                        info = plistlib.load(stream)
                    if info.get('JaplosTestInstanceID') or info.get('CFBundleIdentifier') != 'com.japlos.app.v2':
                        raise ValueError('测试实例不能作为 stable 安装包')
                    if info.get('SUFeedURL') != f'https://bailongma.top/updates/japlos-v2/stable/mac/{arch}/appcast.xml':
                        raise ValueError('更新地址不匹配')
                    return '正式 Japlos v2 · 独立更新源'
                check('正式产品身份', identity)
                check('内置 daemon、资源、签名与实际版本', lambda: run([
                    '/bin/zsh', '-x', root / 'Scripts/verify-bundled-japlos-daemon.sh', app], env=env, timeout=300))
                check('App 产品规范、版本、签名与架构', lambda: run([
                    '/bin/zsh', '-x', root / 'Scripts/verify-japlos-v2-product.sh', app], env=env, timeout=300))
                check('App 公证票据', lambda: run(['/usr/bin/xcrun', 'stapler', 'validate', app]))
                check('Gatekeeper', lambda: run(['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=2', app]))
            finally:
                # Never remove a temporary directory while an image is still mounted.
                try:
                    run(['/usr/bin/hdiutil', 'detach', mount])
                except Exception:
                    run(['/usr/bin/hdiutil', 'detach', '-force', mount])
    result['passed'] = bool(result['checks']) and all(item['ok'] for item in result['checks'])
    return result


if __name__ == '__main__':
    action, root, update_root, *archs = sys.argv[1:]
    if action not in ('scan', 'preflight', 'dry-run') or not archs or any(a not in ('arm64', 'x64') for a in archs):
        raise SystemExit('Invalid inspection request')
    print(json.dumps(inspect(action, Path(root), Path(update_root), archs), ensure_ascii=False))
