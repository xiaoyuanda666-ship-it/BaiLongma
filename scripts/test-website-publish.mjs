import { spawnSync } from 'node:child_process'
import { websitePublishScript } from './publish-updates-lib.mjs'

// Exercise the real transaction in a temporary directory; no production paths.
const encoded = Buffer.from(websitePublishScript()).toString('base64')
const test = `
import base64, hashlib, pathlib, subprocess, tempfile
script = base64.b64decode('${encoded}').decode()
assert 'ossutil' not in script
with tempfile.TemporaryDirectory(prefix='bailongma-publish-test-') as directory:
    root = pathlib.Path(directory)
    script = script.replace('/srv/bailongma-release-staging.', str(root / 'stage.'))
    script = script.replace('/srv/bailongma-updates', str(root / 'updates'))
    script = script.replace('/run/lock/bailongma-update-publish.lock', str(root / 'publish.lock'))
    assert '/srv/' not in script and '/run/lock/' not in script
    stage = root / 'stage.fixture'
    stage.mkdir()
    def prepare(version, corrupt=False, filename=None):
        lines = []
        for arch in ['arm64', 'x64']:
            name = filename or f'Bailongma-{version}-{arch}.zip'
            for kind, staged, remote, content in [
                ('artifact', name, name, f'fixture {version} {arch}'.encode()),
                ('manifest', f'latest-{arch}.yml', 'latest-mac.yml', f'version: {version}\\n'.encode())
            ]:
                (stage / staged).write_bytes(content)
                checksum = hashlib.sha512(content).hexdigest()
                lines.append('\\t'.join([arch, kind, staged, remote, checksum, str(len(content)), 'text/yaml' if kind == 'manifest' else 'application/octet-stream']))
        (stage / 'inventory.tsv').write_text('\\n'.join(lines) + '\\n')
        if corrupt:
            (stage / name).write_bytes(b'corrupt')
    def publish(version):
        return subprocess.run(['sh', '-s', '--', str(stage), version, 'mac', 'Bailongma', 'latest-mac.yml', 'inventory.tsv', 'arm64', 'x64'], input=script, text=True, capture_output=True)
    prepare('1.0.0')
    result = publish('1.0.0')
    assert result.returncode == 0, result.stderr
    def pointers():
        return [(root / 'updates/stable/mac' / arch / 'latest-mac.yml').read_text() for arch in ['arm64','x64']]
    initial = pointers()
    assert initial == ['version: 1.0.0\\n'] * 2
    assert publish('1.0.0').returncode != 0, 'same version must be refused'
    prepare('1.0.1', corrupt=True)
    assert publish('1.0.1').returncode != 0, 'corrupted upload must be refused'
    assert pointers() == initial, 'failed validation changed release pointers'
    prepare('1.0.1')
    assert publish('1.0.1').returncode == 0
    prepare('1.0.0')
    assert publish('1.0.0').returncode != 0, 'downgrade must be refused'
    assert pointers() == ['version: 1.0.1\\n'] * 2
print('Website transaction: two architectures, hashes, same-version rejection, corruption rejection and downgrade protection passed')
`
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--ssh' || !/^(?!-)[A-Za-z0-9._@-]+$/.test(args[1]))) throw new Error('Usage: node scripts/test-website-publish.mjs [--ssh HOST]')
const command = args.length ? 'ssh' : 'python3'
const commandArgs = args.length ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', args[1], 'python3', '-'] : ['-']
const result = spawnSync(command, commandArgs, { input: test, encoding: 'utf8' })
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) throw result.error
process.exitCode = result.status ?? 1
