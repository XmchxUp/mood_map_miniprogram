# Required image assets

## pin.png
- Size: 32×40px (@2x: 64×80px)
- A simple map pin / teardrop shape
- Suggested: dark navy (#1a1a2e) fill, white border, transparent background
- The anchor point is set to { x: 0.5, y: 1.0 } so the pin tip points at the tapped coord

You can generate this with any icon tool (Figma, etc.) or use a free map-pin SVG
converted to PNG. A 32×40px PNG is small enough to bundle in the app package.

## Generating pin.png programmatically (optional)

If you prefer not to bundle an image file, you can generate the pin at runtime
using the Canvas 2D API and cache the tempFilePath in app.globalData.pinIcon.
See the comment in pages/map/map.js onLoad() for where to wire this up.
