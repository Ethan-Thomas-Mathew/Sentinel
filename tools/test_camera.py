"""
test_camera.py  --  find a camera index and backend that actually works.

Run it with:      python tools/test_camera.py

It tries camera numbers 0, 1 and 2 with each available backend, reads a few
frames from each, and reports whether the frames contain a real picture or
are just black. Then put the winning number in config.json as "source".

WHY BLACK FRAMES HAPPEN
    On Windows, OpenCV's default backend (Media Foundation) often reports
    that it opened the camera, then returns all-black frames. DirectShow
    usually works where Media Foundation does not.
"""

import sys

import cv2

BACKENDS = (
    [("DirectShow", cv2.CAP_DSHOW),
     ("Media Foundation", cv2.CAP_MSMF),
     ("default", cv2.CAP_ANY)]
    if sys.platform.startswith("win")
    else [("default", cv2.CAP_ANY)]
)


def describe(frame):
    """Say whether a frame holds a real picture or is effectively black."""
    brightness = frame.mean()
    if brightness < 3:
        return f"BLACK (average brightness {brightness:.1f})"
    return f"OK — {frame.shape[1]}x{frame.shape[0]}, average brightness {brightness:.1f}"


def main():
    print("Testing cameras. A webcam light may blink on and off a few times.\n")
    working = []

    for index in (0, 1, 2):
        for name, backend in BACKENDS:
            capture = cv2.VideoCapture(index, backend)
            if not capture.isOpened():
                print(f"camera {index} / {name:17} : could not open")
                capture.release()
                continue

            # Skip the first few frames while the sensor settles.
            frame = None
            for _ in range(10):
                ok, candidate = capture.read()
                if ok and candidate is not None:
                    frame = candidate
            capture.release()

            if frame is None:
                print(f"camera {index} / {name:17} : opened but read no frames")
                continue

            verdict = describe(frame)
            print(f"camera {index} / {name:17} : {verdict}")
            if verdict.startswith("OK"):
                working.append((index, name))

    print()
    if working:
        index, name = working[0]
        print(f"Use this one: set  \"source\": {index}  in config.json")
        print(f"(it worked through the {name} backend, which run.py tries first)")
    else:
        print("No camera produced a real picture. Things to check:")
        print("  - Close Zoom, Teams, WhatsApp or any browser tab using the camera.")
        print("  - Check the physical privacy shutter or the Fn key that disables it.")
        print("  - Settings > Privacy & security > Camera > 'Let desktop apps access your camera'.")
        print("  - If none of that helps, use a video file instead of the webcam.")


if __name__ == "__main__":
    main()
