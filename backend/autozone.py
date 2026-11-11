"""
autozone.py  --  propose a zone by watching where people actually walk.

WHY THIS EXISTS
    A zone drawn before anyone has looked at the footage is a guess. This
    samples frames spread across the clip, finds where people's feet actually
    are, and fits a polygon around that region. So the moment a video is
    loaded there is already a sensible zone covering the walked area, with a
    capacity chosen from the real headcount rather than invented.

HOW IT WORKS, in four steps
    1. Sample frames spread across the whole clip, not just the start, so a
       quiet opening does not bias the result. Frames are read in order and
       most are skipped, because seeking around an mp4 costs far more than
       decoding straight through it -- random seeking made this take 21
       seconds, sequential reading takes about four.
    2. Detect people in each sample and keep their feet positions.
    3. Build a density grid from those positions and outline the BUSY part.
       Wrapping every point in a convex hull was the obvious approach and it
       was wrong: one person crossing a far corner stretches the hull over
       the entire frame, and a zone covering everything measures nothing.
       Density finds the walkway instead of the extent.
    4. Choose a capacity from the headcounts seen INSIDE that polygon, picked
       so the zone is usually under its limit and occasionally over -- a
       threshold that is always breached teaches an operator nothing.

WHAT IT IS NOT
    This is not segmentation and it does not understand the scene. It is a
    hull around observed foot traffic. Say that plainly if asked: it is a
    sensible starting proposal, meant to be adjusted, not an answer.
"""

import cv2
import numpy as np

from .vision import PersonDetector


def propose_zone(video_path, model_path="models/yolov8n.pt", imgsz=512,
                 process_width=720, confidence=0.35, samples=24,
                 name="Monitored Area"):
    """
    Returns a zone dict ready to save, or None if nobody was found.

        {"name": ..., "capacity": 4, "restricted": False,
         "points": [[x, y], ...]}

    Points are in the coordinates of the PROCESSED frame, the same space the
    rules engine and the zone editor use.
    """
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return None

    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total <= 0:
        capture.release()
        return None

    detector = PersonDetector(model_path, confidence=confidence,
                              device="cpu", imgsz=imgsz)

    frames_of_points = []     # one list of foot positions per sampled frame
    frame_size = None

    # Read straight through and keep every Nth frame. Decoding in order is
    # much cheaper than seeking to each sample position.
    step = max(1, total // samples)
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % step == 0:
            height, width = frame.shape[:2]
            if width > process_width:
                frame = cv2.resize(frame, (process_width,
                                           int(height * process_width / width)))
            frame_size = (frame.shape[1], frame.shape[0])
            # Detection only. Tracking IDs add nothing here.
            people = detector.detect(frame)
            frames_of_points.append([p["point"] for p in people])
        index += 1

    capture.release()

    all_points = [p for frame_points in frames_of_points for p in frame_points]
    if len(all_points) < 8 or frame_size is None:
        return None

    polygon = _busy_area_polygon(all_points, frame_size)
    if polygon is None:
        return None

    # Capacity from how many people are inside THIS polygon, not the frame.
    contour = np.array(polygon, dtype=np.int32)
    inside_counts = [
        sum(1 for (x, y) in frame_points
            if cv2.pointPolygonTest(contour, (float(x), float(y)), False) >= 0)
        for frame_points in frames_of_points
    ]

    return {
        "name": name,
        "capacity": _sensible_capacity(inside_counts),
        "restricted": False,
        "points": polygon,
    }


def _busy_area_polygon(points, frame_size, max_corners=8, scale=8):
    """
    Outline where foot traffic is DENSE, not everywhere it ever occurred.

    Same idea as the live heatmap: drop every foot position onto a coarse
    grid, blur it so neighbouring traffic merges, then keep only the cells
    well above the quiet background. The largest remaining blob is the main
    walkway, and its outline becomes the zone.
    """
    width, height = frame_size
    small_w, small_h = max(8, width // scale), max(8, height // scale)

    grid = np.zeros((small_h, small_w), dtype=np.float32)
    for x, y in points:
        gx, gy = int(x) // scale, int(y) // scale
        if 0 <= gx < small_w and 0 <= gy < small_h:
            grid[gy, gx] += 1.0

    grid = cv2.GaussianBlur(grid, (0, 0), sigmaX=max(2.5, 40 / scale))
    if grid.max() <= 0:
        return None

    # THE THRESHOLD, and the reason it is not a fraction of the busiest cell.
    #
    # Comparing against the peak is fragile: one spot where several people
    # happened to stand becomes the maximum, and everything else falls below
    # the cut -- that produced a zone covering 1% of the frame. Comparing
    # against the TOTAL is stable, because it does not care how tall the
    # tallest peak is.
    #
    # So: keep the busiest cells until they account for 75% of all observed
    # foot traffic. In words, "the smallest area that contains three quarters
    # of the footfall" -- which is a sentence you can defend, unlike a magic
    # fraction of a maximum.
    values = np.sort(grid.ravel())[::-1]
    cumulative = np.cumsum(values)
    needed = cumulative[-1] * 0.75
    cut_index = int(np.searchsorted(cumulative, needed))
    threshold = float(values[min(cut_index, len(values) - 1)])

    mask = (grid >= max(threshold, 1e-6)).astype(np.uint8) * 255

    # Close small gaps so a walkway briefly empty in the middle stays one
    # region instead of splitting into two.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    biggest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(biggest) < 4:
        return None

    # approxPolyDP removes corners that barely change the shape. The tolerance
    # grows until the polygon is simple enough to drag around by hand.
    perimeter = cv2.arcLength(biggest, True)
    simplified = biggest
    for tolerance in (0.01, 0.02, 0.03, 0.05, 0.08, 0.12):
        simplified = cv2.approxPolyDP(biggest, tolerance * perimeter, True)
        if len(simplified) <= max_corners:
            break

    # Back to full-frame coordinates.
    polygon = [[int(p[0][0]) * scale, int(p[0][1]) * scale] for p in simplified]
    if len(polygon) < 3:
        return None

    # Grow it slightly so people at the edge of the observed traffic are
    # inside the zone rather than skimming its border, then keep it on screen.
    width, height = frame_size
    centre_x = sum(p[0] for p in polygon) / len(polygon)
    centre_y = sum(p[1] for p in polygon) / len(polygon)
    grown = []
    for x, y in polygon:
        gx = int(centre_x + (x - centre_x) * 1.06)
        gy = int(centre_y + (y - centre_y) * 1.06)
        grown.append([max(0, min(width - 1, gx)), max(0, min(height - 1, gy))])
    return grown


def _sensible_capacity(counts):
    """
    Pick a limit the zone sits under most of the time and crosses sometimes.

    The 75th percentile means roughly one frame in four is over the limit --
    often enough to demonstrate, rare enough to mean something. A capacity set
    to the average would sit on the threshold and flicker; one set to the
    maximum would never fire at all.
    """
    if not counts:
        return 3
    return max(1, int(np.percentile(counts, 75)))
