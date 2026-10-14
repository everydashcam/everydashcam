# Public-domain face detection source

Credit: NASA, official portrait of astronaut Eileen Collins. This image is used
only as a face-detection regression fixture; no endorsement is implied.

- Downloaded 2026-10-14 from the [official scikit-image v0.25.2 dataset](https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/astronaut.png).
- Original PNG SHA-256: `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`.
- [Official scikit-image provenance and public-domain statement](https://scikit-image.org/docs/0.25.x/api/skimage.data.html#skimage.data.astronaut); it attributes the photo to the [NASA Great Images collection](https://flic.kr/p/r9qvLn).
- [NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) permit factual informational use with source credit. This is test data, not advertising or an application asset.
- Processing: cropped the original 512×512 PNG to `(x=145, y=10, width=170, height=190)` using ffmpeg. Only the head crop is retained; patches, NASA insignia, and surrounding objects are excluded. No metadata, GPS, or private recording is included.
- Reproduce the crop: `ffmpeg -i astronaut.png -vf crop=170:190:145:10 -frames:v 1 face-source.png`.

The photograph is public domain; the repository license applies to the fixture
generator and annotations. Camera model/firmware: not applicable.
