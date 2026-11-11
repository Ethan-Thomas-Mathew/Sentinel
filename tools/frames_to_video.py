"""
frames_to_video.py  --  turn a folder of numbered images into an .mp4

Public tracking datasets (MOT17, MOT20) ship as folders of numbered JPEGs
rather than video files. This turns one of those folders into a video this
project can read.

Usage:
    python tools/frames_to_video.py  <folder of images>  <output.mp4>  [fps]

Example:
    python tools/frames_to_video.py MOT20/train/MOT20-01/img1 data/demo.mp4 25
"""

import sys
from pathlib import Path

import cv2


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    folder = Path(sys.argv[1])
    output = Path(sys.argv[2])
    fps = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0

    if not folder.is_dir():
        sys.exit(f"Not a folder: {folder}")

    # sorted() puts 000001.jpg, 000002.jpg ... in the right order.
    images = sorted(
        [p for p in folder.iterdir()
         if p.suffix.lower() in (".jpg", ".jpeg", ".png")]
    )
    if not images:
        sys.exit(f"No .jpg or .png files found in {folder}")

    first = cv2.imread(str(images[0]))
    if first is None:
        sys.exit(f"Could not read {images[0]}")
    height, width = first.shape[:2]

    output.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )

    print(f"Writing {len(images)} frames at {width}x{height}, {fps} fps ...")
    for index, path in enumerate(images, 1):
        frame = cv2.imread(str(path))
        if frame is None:
            print(f"  skipped unreadable file: {path.name}")
            continue
        # Every frame in an mp4 must be the same size.
        if frame.shape[:2] != (height, width):
            frame = cv2.resize(frame, (width, height))
        writer.write(frame)
        if index % 200 == 0:
            print(f"  {index}/{len(images)}")

    writer.release()
    size_mb = output.stat().st_size / 1_000_000
    print(f"Done. Wrote {output}  ({size_mb:.1f} MB)")
    print("Now set  \"source\": \"data/demo.mp4\"  in config.json and run  python run.py")


if __name__ == "__main__":
    main()
