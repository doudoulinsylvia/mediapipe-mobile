#!/usr/bin/env python3
"""Fetch public author assets at one immutable Git revision; never runs them."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = 'GanchengZhu/GazeFollower'
PATHS = [
    'README.md', 'LICENSE-CC-BY-NC-SA', 'requirements.txt',
    'gazefollower/gaze_estimator/MGazeNetGazeEstimator.py',
    'gazefollower/face_alignment/MediaPipeFaceAlignment.py',
    'gazefollower/camera/WebCamCamera.py',
    'gazefollower/res/model_weights/base.mnn',
    'gazefollower/res/model_weights/mobilenet_v4.mnn',
]


def get(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'phone-gaze-research-audit'})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def main():
    tree = json.loads(get(f'https://api.github.com/repos/{REPO}/git/trees/main?recursive=1'))
    if tree.get('truncated'):
        raise RuntimeError('Git tree is truncated; refusing incomplete asset inventory')
    commit = tree['sha']
    known = {entry['path']: entry for entry in tree['tree'] if entry['type'] == 'blob'}
    manifest = {'repository': f'https://github.com/{REPO}', 'revision': commit,
                'downloaded': [], 'missing': [],
                'all_model_files': [p for p in known if p.endswith(('.mnn', '.onnx', '.pth', '.pt', '.tflite'))]}
    for path in PATHS:
        if path not in known:
            manifest['missing'].append(path)
            continue
        url = f'https://raw.githubusercontent.com/{REPO}/{commit}/{path}'
        data = get(url)
        expected_blob = known[path]['sha']
        actual_blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if expected_blob != actual_blob:
            raise RuntimeError(f'Git blob hash mismatch: {path}')
        if path.endswith('.mnn') and data.startswith(b'version https://git-lfs'):
            raise RuntimeError(f'Only an LFS pointer received: {path}')
        destination = ROOT / 'upstream' / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        manifest['downloaded'].append({'path': path, 'source': url, 'bytes': len(data),
                                      'sha256': hashlib.sha256(data).hexdigest(), 'git_blob': actual_blob})
    (ROOT / 'asset-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
