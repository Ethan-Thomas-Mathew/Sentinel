"""
draw_zones.py  --  draw your zones with the mouse instead of typing numbers.

Run it with:      python tools/draw_zones.py

HOW TO USE
    1. A window opens showing the first frame of your video.
    2. LEFT-CLICK each corner of a zone. A line follows your clicks.
    3. Press  N  to finish that zone and start the next one.
    4. Press  U  to undo the last point.
    5. Press  S  to save all zones into config.json.
    6. Press  Q  to quit without saving.

You will be asked for a name and a capacity for each zone in the terminal.
"""

import json
import sys
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.json"

current_points = []
finished_zones = []


def on_mouse(event, x, y, flags, param):
    if event == cv2.EVENT_LBUTTONDOWN:
        current_points.append([x, y])


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    source = config["source"]
    if isinstance(source, str):
        source = str(PROJECT_ROOT / source)

    capture = cv2.VideoCapture(source)
    ok, frame = capture.read()
    capture.release()

    if not ok:
        sys.exit(f"Could not read a frame from {source}. Check the path in config.json.")

    # Match the size the pipeline will actually process at, so the pixel
    # coordinates you click are the same ones the rules will use.
    process_width = config.get("process_width", 960)
    height, width = frame.shape[:2]
    if width > process_width:
        scale = process_width / width
        frame = cv2.resize(frame, (process_width, int(height * scale)))

    cv2.namedWindow("Draw zones")
    cv2.setMouseCallback("Draw zones", on_mouse)

    print(__doc__)

    while True:
        canvas = frame.copy()

        # already-finished zones in green
        for zone in finished_zones:
            points = zone["points"]
            for i in range(len(points)):
                cv2.line(canvas, tuple(points[i]), tuple(points[(i + 1) % len(points)]),
                         (120, 220, 130), 2)
            cv2.putText(canvas, zone["name"], tuple(points[0]),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (120, 220, 130), 2)

        # the zone you are drawing right now, in yellow
        for i, point in enumerate(current_points):
            cv2.circle(canvas, tuple(point), 5, (90, 220, 255), -1)
            if i > 0:
                cv2.line(canvas, tuple(current_points[i - 1]), tuple(point), (90, 220, 255), 2)

        cv2.putText(canvas, "click corners | N next zone | U undo | S save | Q quit",
                    (10, canvas.shape[0] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 1, cv2.LINE_AA)

        cv2.imshow("Draw zones", canvas)
        key = cv2.waitKey(20) & 0xFF

        if key == ord("u") and current_points:
            current_points.pop()

        elif key == ord("n"):
            if len(current_points) < 3:
                print("A zone needs at least 3 corners.")
                continue
            name = input("Zone name: ").strip() or f"Zone {len(finished_zones) + 1}"
            try:
                capacity = int(input("Capacity (max people before it alerts): ").strip())
            except ValueError:
                capacity = 5
                print("Not a number, using 5.")
            finished_zones.append({
                "name": name,
                "capacity": capacity,
                "points": list(current_points),
            })
            current_points.clear()
            print(f"Saved '{name}'. Draw the next zone, or press S to finish.\n")

        elif key == ord("s"):
            if current_points and len(current_points) >= 3:
                print("You have an unfinished zone. Press N to save it first.")
                continue
            if not finished_zones:
                print("No zones drawn yet.")
                continue
            config["zones"] = finished_zones
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
            print(f"\nWrote {len(finished_zones)} zone(s) to config.json. Done.")
            break

        elif key == ord("q"):
            print("Quit without saving.")
            break

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
