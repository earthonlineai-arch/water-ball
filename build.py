"""Build the self-contained page. Python standard library only."""
from pathlib import Path
import base64
import re

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'source'

def text(name):
    return (SOURCE / name).read_text(encoding='utf-8')

def encoded(name):
    return base64.b64encode((SOURCE / name).read_bytes()).decode('ascii')

page = text('water-ball.template.html')
resources = {
    'FRAGMENT': text('water-fusion.frag'),
    'ANTIALIAS': text('water-aa.frag'),
    'GPU_JS': text('water-gpu.js'),
    'RUNTIME_JS': text('water-runtime.js'),
    'NORMALS': encoded('water-normals.webp'),
    'ENVIRONMENT': encoded('water-environment.png'),
    'POSTER': encoded('water-poster.webp'),
    'STATIC_DROPLETS': encoded('water-static-droplets.webp'),
}
for name, value in resources.items():
    token = '@@' + name + '@@'
    if page.count(token) != 1:
        raise ValueError('Expected exactly one template token: ' + token)
    page = page.replace(token, value)
if re.search(r'@@[A-Z_]+@@', page):
    raise ValueError('Unresolved template token')
(ROOT / 'water-ball.html').write_text(page, encoding='utf-8')
print('Built water-ball.html:', (ROOT / 'water-ball.html').stat().st_size, 'bytes')
