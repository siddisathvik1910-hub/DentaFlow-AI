#!/usr/bin/env python3
"""Generates the site's raster images (favicon set, social preview) and compresses them.
Requires Pillow:  pip install pillow      Run:  python3 scripts/make-images.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'img')
os.makedirs(OUT, exist_ok=True)
BLUE = (11, 92, 173)
DARK = (15, 39, 64)
TEAL = (14, 124, 123)
WHITE = (255, 255, 255)

def font(size, bold=False):
    for p in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
              '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
              'C:/Windows/Fonts/arialbd.ttf' if bold else 'C:/Windows/Fonts/arial.ttf']:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def tooth(d, cx, cy, s, fill):
    """Simple tooth glyph centred at (cx, cy) with scale s."""
    pts = [(-0.55, -0.45), (-0.3, -0.62), (0, -0.5), (0.3, -0.62), (0.55, -0.45), (0.5, -0.05), (0.38, 0.55), (0.2, 0.62),
           (0.1, 0.2), (-0.1, 0.2), (-0.2, 0.62), (-0.38, 0.55), (-0.5, -0.05)]
    d.polygon([(cx + x * s, cy + y * s) for x, y in pts], fill=fill)

def icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=BLUE)
    tooth(d, size / 2, size / 2, size * 0.62, WHITE)
    return img

def save_png(img, name, colors=None):
    path = os.path.join(OUT, name)
    if colors:
        img = img.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    img.save(path, 'PNG', optimize=True)
    print(f'{name:24s} {os.path.getsize(path):>7,d} bytes')

# --- favicon set
big = icon(512)
save_png(big, 'icon-512.png'); save_png(icon(192), 'icon-192.png'); save_png(icon(180), 'apple-touch-icon.png')
save_png(icon(32), 'favicon-32.png'); save_png(icon(16), 'favicon-16.png')
big.resize((48, 48), Image.LANCZOS).save(os.path.join(OUT, 'favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
print(f'{"favicon.ico":24s} {os.path.getsize(os.path.join(OUT, "favicon.ico")):>7,d} bytes')

# --- social preview (1200x630)
W, H = 1200, 630
og = Image.new('RGB', (W, H), DARK)
d = ImageDraw.Draw(og)
for y in range(H):  # vertical gradient
    t = y / H
    d.line([(0, y), (W, y)], fill=(int(15 + 0 * t), int(39 + 53 * t), int(64 + 109 * t)))
d.rounded_rectangle([72, 72, 168, 168], radius=22, fill=WHITE)
tooth(d, 120, 120, 62, BLUE)
d.text((192, 96), 'DentaFlow AI', font=font(44, True), fill=WHITE)
d.text((72, 220), 'The AI front desk', font=font(62, True), fill=WHITE)
d.text((72, 296), 'for dental clinics', font=font(62, True), fill=WHITE)
d.text((72, 410), 'Answers every call and text 24/7.', font=font(28), fill=(214, 232, 250))
d.text((72, 450), 'Books straight into your schedule.', font=font(28), fill=(214, 232, 250))
d.rounded_rectangle([72, 516, 432, 580], radius=14, fill=WHITE)
d.text((104, 532), 'Book a free demo', font=font(30, True), fill=BLUE)
# decorative chat bubbles (right side, clear of the text column)
d.rounded_rectangle([740, 130, 1140, 210], radius=26, fill=(255, 255, 255))
d.text((768, 155), 'I need a cleaning this week', font=font(23), fill=DARK)
d.rounded_rectangle([700, 240, 1140, 350], radius=26, fill=(14, 124, 123))
d.text((728, 258), 'I have Thursday at 1:00 PM', font=font(23), fill=WHITE)
d.text((728, 296), 'with Dr. Patel. Shall I book it?', font=font(23), fill=WHITE)
d.rounded_rectangle([900, 380, 1140, 450], radius=26, fill=(255, 255, 255))
d.text((928, 402), 'Yes, please!', font=font(23), fill=DARK)
save_png(og, 'og-image.png', colors=128)
og.save(os.path.join(OUT, 'og-image.webp'), 'WEBP', quality=82, method=6)
print(f'{"og-image.webp":24s} {os.path.getsize(os.path.join(OUT, "og-image.webp")):>7,d} bytes')
