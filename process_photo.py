#!/usr/bin/env python3
"""
Helper script: crop and resize a photo for the avatar.
Usage: python3 process_photo.py /path/to/original_photo.jpg
Creates amelia.jpg (cropped square, 400x400) in the current directory.
"""
import sys
from PIL import Image

if len(sys.argv) < 2:
    print("Usage: python3 process_photo.py <path_to_photo>")
    sys.exit(1)

img = Image.open(sys.argv[1])
w, h = img.size

# Crop to square centered horizontally, shifted up for face
size = min(w, h)
left = (w - size) // 2
# Shift crop area up by 10% to focus on the face
top = max(0, (h - size) // 2 - int(h * 0.1))
img_cropped = img.crop((left, top, left + size, top + size))

# Resize to 400x400 for web
img_cropped = img_cropped.resize((400, 400), Image.LANCZOS)
img_cropped.save("amelia.jpg", "JPEG", quality=85)
print("Saved amelia.jpg (400x400)")
