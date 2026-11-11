"""
vision.py  --  the "eyes" of the system.

WHAT THIS FILE DOES
    1. Loads the YOLO model (the thing that recognises people in a picture).
    2. Takes one video frame and finds every person in it.
    3. Gives each person a stable ID number so we can follow the same person
       across many frames. That is called *tracking*.

WHAT THIS FILE DOES **NOT** DO
    It knows nothing about zones, alerts, the database or the web page.
    Keeping those separate is what the brief calls "modular" architecture.

THE ONE IDEA YOU MUST BE ABLE TO EXPLAIN
    Detection answers "is there a person here?" for a single frame.
    Tracking answers "is this the SAME person I saw a moment ago?" across frames.
    You need tracking to measure dwell time -- without IDs you cannot tell
    whether one person stood still for 30 seconds or 30 people walked past.
"""

import sys

import cv2
from ultralytics import YOLO

# YOLO was trained on a dataset called COCO, which has 80 object classes.
# Class number 0 is "person". We ask for only that class so the model ignores
# cars, chairs, bags and everything else.
PERSON_CLASS_ID = 0


class PersonDetector:
    """Finds people in frames and keeps a stable ID for each one."""

    def __init__(self, model_path="models/yolov8n.pt", confidence=0.35,
                 device="cpu", imgsz=512):
        # Loading the model takes a second or two. We do it ONCE here, not
        # once per frame, otherwise the app would be unusably slow.
        self.model = YOLO(model_path)
        self.confidence = confidence
        self.device = device

        # THE SETTING THAT ACTUALLY CONTROLS SPEED.
        #
        # YOLO resizes whatever you hand it to its own working size before
        # running the network, so shrinking the frame yourself barely helps --
        # measured on this project's demo clip, going from a 960px frame to a
        # 480px frame gained about 6%. Changing the network's working size is
        # what matters. On the same clip and the same CPU:
        #
        #     imgsz 640 -> 15.0 fps, 11.9 people detected on average
        #     imgsz 512 -> 26.8 fps, 11.9 people   <-- same accuracy, 79% faster
        #     imgsz 416 -> 34.8 fps, 11.4 people
        #     imgsz 320 -> 53.4 fps, 10.0 people   <-- now missing people
        #
        # 512 is the default because it is free speed. Below it, accuracy
        # starts to cost something. Re-measure on your own footage: the right
        # value depends on how small the people are in the frame.
        self.imgsz = imgsz

    def detect(self, frame):
        """
        Input:  one video frame (an image).
        Output: a list of dictionaries, one per person found. For example:

            [{"id": 3,
              "box": [100, 200, 160, 400],   # x1, y1, x2, y2 corners in pixels
              "conf": 0.87,                  # how sure the model is (0 to 1)
              "point": (130, 400)}]          # the person's FEET position
        """
        # model.track() runs detection AND tracking together.
        #   persist=True  -> remember IDs from the previous call to this method
        #   classes=[0]   -> only look for people
        #   tracker=...   -> use ByteTrack, the tracking algorithm the brief names
        #   verbose=False -> stop it printing a line for every single frame
        results = self.model.track(
            frame,
            persist=True,
            classes=[PERSON_CLASS_ID],
            conf=self.confidence,
            tracker="bytetrack.yaml",
            verbose=False,
            device=self.device,
            imgsz=self.imgsz,
        )

        people = []
        result = results[0]  # we sent one frame, so we get one result back

        # If nothing was found, or the tracker has not assigned IDs yet,
        # just return an empty list instead of crashing.
        if result.boxes is None or result.boxes.id is None:
            return people

        # .cpu().numpy() copies the numbers out of the model into plain arrays
        # we can loop over in normal Python.
        boxes = result.boxes.xyxy.cpu().numpy()
        ids = result.boxes.id.cpu().numpy().astype(int)
        confidences = result.boxes.conf.cpu().numpy()

        for (x1, y1, x2, y2), track_id, conf in zip(boxes, ids, confidences):
            # IMPORTANT DESIGN CHOICE, worth explaining to the panel:
            # We represent a person by their FEET (bottom-centre of the box),
            # not the middle of the box. A person standing at the edge of a
            # zone has their head outside it but their feet inside it -- and
            # where their feet are is where they actually are standing.
            feet_x = int((x1 + x2) / 2)
            feet_y = int(y2)

            people.append({
                "id": int(track_id),
                "box": [int(x1), int(y1), int(x2), int(y2)],
                "conf": float(conf),
                "point": (feet_x, feet_y),
            })

        return people


class VideoSource:
    """
    Reads frames from a video file or a webcam.

    Wrapping OpenCV in our own small class means the rest of the program does
    not care whether the frames come from a file, a webcam or (later) an RTSP
    camera. That is the "image/video input layer" in the brief's architecture.
    """

    def __init__(self, source, loop=True, process_width=960):
        self.source = source
        self.loop = loop
        self.process_width = process_width

        # A webcam is given as a number (0, 1, ...); a video is given as a path.
        self.is_camera = isinstance(source, int)

        self.capture = self._open_capture(source)

        if not self.capture.isOpened():
            raise RuntimeError(
                f"Could not open the video source: {source!r}\n"
                "  - If it is a file, check the path in config.json is correct.\n"
                "  - If it is a webcam, try 0 (no quotes) in config.json,\n"
                "    and run  python tools/test_camera.py  to find a camera that works."
            )

        if self.is_camera:
            # Many webcams hand back a few black or garbage frames while the
            # sensor adjusts its exposure. Throw those away so the dashboard
            # does not open on a black rectangle.
            for _ in range(10):
                self.capture.read()

    def _open_capture(self, source):
        """
        Open the source, trying the backends that actually work on this OS.

        WHY THIS EXISTS (a good thing to be able to explain):
        On Windows, OpenCV defaults to a backend called Media Foundation
        (MSMF). With many laptop webcams it opens "successfully" but then
        returns all-black frames, or takes 30 seconds to start. DirectShow
        (DSHOW) is the older backend and is far more reliable for webcams,
        so on Windows we try it first and fall back if it fails.
        """
        if not self.is_camera:
            return cv2.VideoCapture(source)

        if sys.platform.startswith("win"):
            backends = [("DirectShow", cv2.CAP_DSHOW),
                        ("Media Foundation", cv2.CAP_MSMF),
                        ("default", cv2.CAP_ANY)]
        else:
            backends = [("default", cv2.CAP_ANY)]

        for name, backend in backends:
            capture = cv2.VideoCapture(source, backend)
            if not capture.isOpened():
                capture.release()
                continue

            # "Opened" is not good enough -- check we can actually read a frame.
            ok, frame = capture.read()
            if ok and frame is not None:
                print(f"  camera       : index {source} via {name}")
                return capture
            capture.release()

        # Nothing worked; return an unopened capture so the error above fires.
        return cv2.VideoCapture(source)

    def read(self):
        """Returns the next frame, or None when the video has truly finished."""
        ok, frame = self.capture.read()

        if not ok:
            # Only a file can be rewound. A webcam that drops a frame just
            # needs us to ask again on the next loop.
            if self.loop and not self.is_camera:
                # Rewind to frame 0 and try once more. This is what makes the
                # demo video play forever during a presentation.
                self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self.capture.read()
            if not ok:
                return None

        # Shrink the frame before detection. A 4K frame takes about 9 times
        # longer to process than a 960-wide one, for almost no extra accuracy
        # at normal distances.
        height, width = frame.shape[:2]
        if width > self.process_width:
            scale = self.process_width / width
            frame = cv2.resize(frame, (self.process_width, int(height * scale)))

        return frame

    # ------------------------------------------------------------------ #
    # playback position -- only meaningful for a video file, not a camera
    # ------------------------------------------------------------------ #

    @property
    def total_frames(self):
        if self.is_camera:
            return 0
        return int(self.capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    @property
    def source_fps(self):
        """The frame rate the video was recorded at (25.0 if unknown)."""
        if self.is_camera:
            return 0.0
        fps = self.capture.get(cv2.CAP_PROP_FPS) or 0.0
        return fps if 1 <= fps <= 240 else 25.0

    @property
    def position(self):
        if self.is_camera:
            return 0
        return int(self.capture.get(cv2.CAP_PROP_POS_FRAMES) or 0)

    def seek(self, frame_index):
        """Jump to a frame. This is what makes the scrub bar work."""
        if self.is_camera:
            return False
        total = self.total_frames
        if total:
            frame_index = max(0, min(int(frame_index), total - 1))
        self.capture.set(cv2.CAP_PROP_POS_FRAMES, float(frame_index))
        return True

    def release(self):
        self.capture.release()
