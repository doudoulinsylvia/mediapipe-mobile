#!/usr/bin/env python3
"""Download pinned official build tools locally, without changing shell profiles."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
SOURCES = [
    ('MNN-3.5.0', 'https://codeload.github.com/alibaba/MNN/tar.gz/refs/tags/3.5.0'),
]


def main():
    downloads = ROOT / 'downloads'
    vendor = ROOT / 'vendor'
    downloads.mkdir(exist_ok=True)
    vendor.mkdir(exist_ok=True)
    manifest = []
    for name, url in SOURCES:
        archive = downloads / (name + '.tar.gz')
        if not archive.exists():
            print('Downloading', name, flush=True)
            request = urllib.request.Request(url, headers={'User-Agent': 'phone-gaze-research-build'})
            with urllib.request.urlopen(request, timeout=60) as source, archive.open('wb') as sink:
                while chunk := source.read(1024 * 1024):
                    sink.write(chunk)
        manifest.append({'name': name, 'source': url, 'bytes': archive.stat().st_size,
                         'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
        destination = vendor / name
        if not destination.exists():
            with tarfile.open(archive) as contents:
                contents.extractall(vendor, filter='data')
    (ROOT / 'build-tools-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    emsdk = ROOT / 'emsdk' / 'emsdk'
    if not emsdk.exists():
        raise RuntimeError('Expected the existing official emsdk checkout in image-model/emsdk')
    subprocess.run([str(emsdk), 'install', '4.0.14'], check=True, cwd=emsdk.parent)
    subprocess.run([str(emsdk), 'activate', '4.0.14'], check=True, cwd=emsdk.parent)
    print('Local Emscripten / MNN ready; reuse ../.venv/bin/cmake.', flush=True)


if __name__ == '__main__':
    main()
