"""Version consistency check (cross-platform, no bash needed)."""
import re, json, sys

files = [
    ('custom_components/deepseek_harness/const.py', r'VERSION\s*=\s*"([^"]+)"'),
    ('custom_components/deepseek_harness/manifest.json', None),
    ('deepseek_harness/config.yaml', r'version:\s*"([^"]+)"'),
    ('deepseek_harness/Dockerfile', r'BUILD_VERSION="([^"]+)"'),
]

versions = {}
for path, pattern in files:
    with open(path, encoding='utf-8') as f:
        content = f.read()
        if pattern:
            m = re.search(pattern, content)
            versions[path] = m.group(1) if m else '(not found)'
        else:
            versions[path] = json.loads(content)['version']

for k, v in versions.items():
    print(f'  {k}: {v}')

vals = list(versions.values())
if len(set(vals)) == 1:
    print(f'\n  All versions match: {vals[0]}')
else:
    print(f'\n  Version mismatch!')
    sys.exit(1)