"""
overlay.py  --  turns numbers back into a picture.

WHAT THIS FILE DOES
    Draws on top of the video frame so a human can see what the computer saw:
       - a coloured box around each person, with their track ID
       - the zone polygons, green when fine and red when over capacity
       - a density heatmap showing where people have been standing

WHY IT IS A SEPARATE FILE
    Drawing is presentation, not logic. If you later wanted to send the raw
    numbers to a phone app instead of a web page, you would not touch zones.py
    at all -- you would just skip this file.
"""

import cv2
import numpy as np

# Colours in OpenCV are (Blue, Green, Red), NOT (Red, Green, Blue).
# This trips up almost everyone the first time.
COLOUR_PERSON = (255, 190, 90)    # light blue
COLOUR_OK = (120, 220, 130)       # green
COLOUR_ALERT = (80, 80, 245)      # red
COLOUR_TEXT = (255, 255, 255)     # white
COLOUR_FLOW = (235, 235, 255)     # near-white, for movement arrows


class HeatmapAccumulator:
    """
    Builds the density heatmap.

    HOW IT WORKS, in one sentence:
        We keep a grey picture the same size as the video, add a bright blob
        wherever someone's feet are, fade the whole picture slightly every
        frame, and then colour it in.

    The fading is what makes it a *recent activity* map rather than a map of
    everywhere anyone has ever walked.
    """

    # The heatmap is computed at 1/SCALE resolution and stretched back up.
    #
    # WHY, and it is the single biggest performance decision in this project:
    # profiling the pipeline showed the heatmap taking 64.7 ms per frame --
    # about half the total, and more than YOLO itself. Almost all of it was
    # one Gaussian blur with a 22-pixel radius over a 960x1706 float array.
    #
    # A heatmap is a field of smooth blobs by definition. It has no fine
    # detail to lose, so computing it on a quarter-size grid gives a result
    # that is visually identical after upscaling, for about a sixteenth of
    # the work. The blur radius is divided by the same factor so the blobs
    # come out the same size on screen.
    SCALE = 4

    def __init__(self, decay=0.94, intensity=0.35):
        self.accumulator = None
        self.decay = decay
        self.intensity = intensity

    def update(self, frame_shape, people):
        height, width = frame_shape[:2]
        small_h, small_w = height // self.SCALE, width // self.SCALE

        # First frame: create an empty (all-zero) canvas.
        if self.accumulator is None or self.accumulator.shape != (small_h, small_w):
            self.accumulator = np.zeros((small_h, small_w), dtype=np.float32)

        # Fade what is already there. 0.94 means "keep 94% of last frame".
        self.accumulator *= self.decay

        # Add a bright dot at each person's feet, in small-grid coordinates.
        radius = max(2, 26 // self.SCALE)
        for person in people:
            x = person["point"][0] // self.SCALE
            y = person["point"][1] // self.SCALE
            if 0 <= x < small_w and 0 <= y < small_h:
                cv2.circle(self.accumulator, (int(x), int(y)), radius, 1.0, -1)

        return self.accumulator

    def render(self, frame):
        """Blend the heatmap over the video frame and return the result."""
        if self.accumulator is None:
            return frame

        # Blur so the dots merge into smooth blobs instead of hard circles.
        blurred = cv2.GaussianBlur(self.accumulator, (0, 0),
                                   sigmaX=22 / self.SCALE)

        peak = float(blurred.max())
        if peak < 0.01:
            return frame  # nothing to show yet

        normalised = np.clip(blurred / peak, 0, 1)

        # Colour it while it is still small -- applyColorMap on a quarter-size
        # image is sixteen times cheaper than on the full frame.
        coloured_small = cv2.applyColorMap((normalised * 255).astype(np.uint8),
                                           cv2.COLORMAP_JET)

        height, width = frame.shape[:2]
        coloured = cv2.resize(coloured_small, (width, height),
                              interpolation=cv2.INTER_LINEAR)

        # Only blend where the heat is actually noticeable, so cold areas of
        # the video keep their normal colour instead of going blue. The mask
        # is built small and stretched up with the same interpolation, which
        # also softens its edge for free.
        mask_small = np.clip((normalised - 0.12) * 6.0, 0, 1).astype(np.float32)
        mask = cv2.resize(mask_small, (width, height),
                          interpolation=cv2.INTER_LINEAR)[:, :, None] * self.intensity

        blended = frame * (1 - mask) + coloured * mask
        return blended.astype(np.uint8)


class FlowField:
    """
    Shows which way the crowd is moving.

    THE IDEA IN ONE SENTENCE
        Every tracked person has a position this frame and a position last
        frame; the difference is their velocity. Average those velocities
        inside each cell of a grid laid over the picture, and you get the
        direction people typically travel through each part of the scene.

    WHY THIS MATTERS FOR BOTTLENECKS, which is the thing worth saying aloud:
        A zone being full tells you *that* there is a problem. The flow field
        starts to tell you *why*. Two groups of arrows pointing into each
        other is a crossing conflict; arrows that shorten as they approach a
        doorway means people are slowing down, which is a queue forming
        before any count has gone over its limit.

    This is the brief's "estimate movement" requirement. It needs no extra
    model -- it is arithmetic on the track IDs we already have.
    """

    def __init__(self, columns=12, rows=16, decay=0.92, min_speed=1.2):
        self.columns = columns
        self.rows = rows
        self.decay = decay            # how fast old motion is forgotten
        self.min_speed = min_speed    # ignore jitter from people standing still
        self.vectors = None           # averaged velocity per cell
        self.weights = None           # how much evidence each cell has
        self.previous = {}            # track_id -> last known (x, y)

    def update(self, frame_shape, people):
        height, width = frame_shape[:2]

        if self.vectors is None:
            self.vectors = np.zeros((self.rows, self.columns, 2), dtype=np.float32)
            self.weights = np.zeros((self.rows, self.columns), dtype=np.float32)

        # Fade what we learned before, so the field follows current movement
        # rather than everything that has ever happened.
        self.vectors *= self.decay
        self.weights *= self.decay

        current = {}
        cell_w = width / self.columns
        cell_h = height / self.rows

        for person in people:
            x, y = person["point"]
            current[person["id"]] = (x, y)

            last = self.previous.get(person["id"])
            if last is None:
                continue        # first time we have seen them: no velocity yet

            dx, dy = x - last[0], y - last[1]
            if (dx * dx + dy * dy) ** 0.5 < self.min_speed:
                continue        # standing still; not movement worth drawing

            column = min(int(x / cell_w), self.columns - 1)
            row = min(int(y / cell_h), self.rows - 1)
            if column < 0 or row < 0:
                continue

            self.vectors[row, column] += (dx, dy)
            self.weights[row, column] += 1

        # Anyone not seen this frame is dropped, so a returning person does
        # not produce one enormous bogus velocity across the whole screen.
        self.previous = current

    def render(self, frame):
        if self.vectors is None:
            return frame

        height, width = frame.shape[:2]
        cell_w = width / self.columns
        cell_h = height / self.rows

        for row in range(self.rows):
            for column in range(self.columns):
                weight = self.weights[row, column]
                if weight < 0.6:
                    continue

                vx, vy = self.vectors[row, column] / weight
                speed = (vx * vx + vy * vy) ** 0.5
                if speed < self.min_speed:
                    continue

                # Arrow length is scaled by speed but capped, so one fast
                # person cannot draw an arrow across the whole frame.
                length = min(speed * 9, cell_w * 0.85)
                scale = length / speed

                cx = int((column + 0.5) * cell_w)
                cy = int((row + 0.5) * cell_h)
                tip = (int(cx + vx * scale), int(cy + vy * scale))

                cv2.arrowedLine(frame, (cx, cy), tip, COLOUR_FLOW, 2,
                                cv2.LINE_AA, tipLength=0.35)
        return frame


def draw_zones(frame, zones, zone_stats):
    """Draw each zone polygon, tinted red if it is over capacity."""
    overlay = frame.copy()

    for zone, stats in zip(zones, zone_stats):
        colour = COLOUR_ALERT if stats["over_capacity"] else COLOUR_OK

        # Fill the polygon on a copy, then blend it so it looks translucent.
        cv2.fillPoly(overlay, [zone.polygon], colour)
        cv2.polylines(frame, [zone.polygon], True, colour, 2)

        # Label the zone with its live count, e.g. "Main Corridor  7/6"
        label_x, label_y = zone.polygon[0]
        label = f"{zone.name}  {stats['count']}/{stats['capacity']}"
        _draw_label(frame, label, (int(label_x), int(label_y) - 10), colour)

    # 0.18 = how strong the tint is. Low, so you can still see the video.
    cv2.addWeighted(overlay, 0.18, frame, 0.82, 0, frame)
    return frame


def draw_people(frame, people):
    """Draw a box and an ID number over each detected person."""
    for person in people:
        x1, y1, x2, y2 = person["box"]
        cv2.rectangle(frame, (x1, y1), (x2, y2), COLOUR_PERSON, 2)
        _draw_label(frame, f"#{person['id']}", (x1, y1 - 6), COLOUR_PERSON)

        # A small dot at the feet, so during the demo you can point out that
        # this is the point we actually test against the zone polygon.
        cv2.circle(frame, person["point"], 4, COLOUR_PERSON, -1)
    return frame


def draw_status_bar(frame, total_people, fps, processing_ms):
    """A small strip along the top showing live performance numbers."""
    height, width = frame.shape[:2]
    cv2.rectangle(frame, (0, 0), (width, 34), (18, 20, 28), -1)
    text = f"People: {total_people}    {fps:.1f} FPS    {processing_ms:.0f} ms/frame"
    cv2.putText(frame, text, (12, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.6, COLOUR_TEXT, 1, cv2.LINE_AA)
    return frame


def _draw_label(frame, text, position, colour):
    """Draw text with a dark strip behind it so it stays readable."""
    x, y = position
    (text_width, text_height), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    cv2.rectangle(frame, (x, y - text_height - 6), (x + text_width + 8, y + 4), (18, 20, 28), -1)
    cv2.putText(frame, text, (x + 4, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)
