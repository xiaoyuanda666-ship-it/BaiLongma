#!/usr/bin/env python3
"""Publish inspected Japlos v2 snapshots through the existing server publisher."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('japlos_inspect', Path(__file__).with_name('japlos-inspect.py'))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)
BASE = 'https://bailongma.top/updates/japlos-v2/stable/mac'
SPARKLE = inspection.SPARKLE


def log(message):
    print(message, file=sys.stderr, flush=True)


def checksum(file):
    digest = hashlib.sha512()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def assert_version(root, expected):
    if (root / 'VERSION').read_text().strip() != expected:
        raise ValueError('VERSION 已变化，请重新检查发布计划')


def copy_checked(record, destination):
    source = Path(record['path'])
    if source.is_symlink() or not source.is_file():
        raise ValueError('发布输入已变化')
    shutil.copyfile(source, destination)
    if destination.stat().st_size != record['size'] or checksum(destination) != record['sha512']:
        raise ValueError('发布输入在检查后变化，已停止上传')


def check_remote_version(arch, version):
    try:
        with urllib.request.urlopen(f'{BASE}/{arch}/appcast.xml', timeout=45) as response:
            feed = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        raise
    previous = ET.fromstring(feed).findtext('./channel/item/' + SPARKLE + 'version')
    if not previous or not re.fullmatch(r'\d+\.\d+\.\d+', previous):
        raise ValueError('线上版本无法确认')
    if tuple(map(int, previous.split('.'))) > tuple(map(int, version.split('.'))):
        raise ValueError(f'{arch}: 禁止版本回退 {previous} → {version}')
    log(f'{arch}: 线上版本 {previous} → {version}')


def verify_online(source, arch):
    prefix = f'{BASE}/{arch}/'
    with urllib.request.urlopen(prefix + 'appcast.xml', timeout=45) as response:
        feed = response.read()
    if feed != (source / 'appcast.xml').read_bytes():
        raise ValueError('线上 Sparkle 清单与发布快照不一致')
    enclosure = ET.fromstring(feed).find('./channel/item/enclosure')
    local = next(source.glob('*.dmg'))
    url = prefix + local.name
    if enclosure.get('url') != url:
        raise ValueError('线上安装包地址不匹配')
    digest, size = hashlib.sha512(), 0
    with urllib.request.urlopen(url, timeout=120) as response:
        for chunk in iter(lambda: response.read(1024 * 1024), b''):
            size += len(chunk)
            digest.update(chunk)
    if size != local.stat().st_size or digest.hexdigest() != checksum(local):
        raise ValueError('线上安装包大小或 SHA-512 不一致')
    request = urllib.request.Request(url, headers={'Range': 'bytes=0-1023'})
    with urllib.request.urlopen(request, timeout=45) as response, local.open('rb') as stream:
        if response.status != 206 or response.headers.get('Content-Range') != f'bytes 0-1023/{size}' or response.read() != stream.read(1024):
            raise ValueError('线上 Range 验收失败')
    return f'{url}\n{size} bytes · SHA-512 一致 · Range 通过'


def publish(root, update_root, version, archs):
    assert_version(root, version)
    log('正在完整检查所有所选架构：App、daemon、Developer ID、Sparkle、公证和 Gatekeeper')
    result = inspection.inspect('preflight', root, update_root, archs)
    result['action'] = 'publish'
    if not result['passed']:
        log('完整检查未通过，没有上传任何文件')
        return result
    with tempfile.TemporaryDirectory(prefix='japlos-v2-publish-') as directory:
        snapshots = {}
        for arch in archs:
            source = Path(directory) / arch
            source.mkdir()
            for record in result['records']:
                if record['arch'] == arch:
                    copy_checked(record, source / record['name'])
            inspection.run([sys.executable, update_root / 'scripts/publish_release.py',
                            'mac', arch, source, 'stable', '--product', 'japlos-v2',
                            '--backend', 'local', '--dry-run'], timeout=300)
            check_remote_version(arch, version)
            snapshots[arch] = source
        assert_version(root, version)
        for arch, source in snapshots.items():
            log(f'{arch}: 正在上传安装包并发布 Sparkle 更新清单')
            try:
                detail = inspection.run([sys.executable, update_root / 'scripts/publish_release.py',
                                         'mac', arch, source, 'stable', '--product', 'japlos-v2',
                                         '--backend', 'local'], timeout=3600)
                result['checks'].append(dict(arch=arch, name='服务器发布', ok=True, detail=detail))
                log(f'{arch}: 上传完成，正在完整下载校验 SHA-512 与 Range')
                detail = verify_online(source, arch)
                result['checks'].append(dict(arch=arch, name='线上下载、SHA-512 与 Range', ok=True, detail=detail))
                log(f'{arch}: 发布及线上验收通过')
            except Exception as error:
                result['checks'].append(dict(arch=arch, name='发布或线上验收失败（可能已更新服务器）', ok=False, detail=str(error)))
                result['passed'] = False
                return result
    return result


if __name__ == '__main__':
    root, updates, version, *archs = sys.argv[1:]
    if not archs or any(arch not in ('arm64', 'x64') for arch in archs):
        raise SystemExit('Invalid architectures')
    print(json.dumps(publish(Path(root), Path(updates), version, list(dict.fromkeys(archs))), ensure_ascii=False))
