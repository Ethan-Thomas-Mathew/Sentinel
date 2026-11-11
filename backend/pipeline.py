"""
pipeline.py  --  the conveyor belt that joins everything together.

WHAT THIS FILE DOES
    Runs a loop, forever, in a background thread:

        read a frame  ->  find people  ->  apply zone rules
                      ->  draw overlays ->  save alerts + evidence
                      ->  store the finished picture + numbers

    The web server (server.py) never does any of this work itself. It just
    reads whatever the pipeline put down last.

WHY A BACKGROUND THREAD
    If the video processing ran inside the web request, the page would freeze
    while YOLO was thinking, and two people opening the dashboard would run
    the video twice. With a thread, the video is processed exactly once, and
    any number of browsers can watch the result.

THE PATTERN TO NAME IN YOUR VIVA
    This is a producer/consumer design. The pipeline thread *produces* frames
    and stats; the web endpoints *consume* the latest one. The shared box
    between them is guarded by a lock so a reader never catches a half-written
    frame.
"""

import threading
import time
from collections import deque
from pathlib import Path

import cv2

from .vision import PersonDetector, VideoSource
from .zones import ZoneManager
from .overlay import (HeatmapAccumulator, FlowField,
                      draw_zones, draw_people, draw_status_bar)


class Pipeline:
    def __init__(self, config, database, snapshot_dir=None):
        self.config = config
        self.database = database

        # Where evidence snapshots are written when an alert fires.
        self.snapshot_dir = Path(snapshot_dir or "snapshots")
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)

        # --- the three building blocks from the other files ---
        self.source = VideoSource(
            source=config["source"],
            loop=config.get("loop_video", True),
            process_width=config.get("process_width", 960),
        )
        self.detector = PersonDetector(
            model_path=config.get("model_path", "models/yolov8n.pt"),
            confidence=config.get("confidence", 0.35),
            device=config.get("device", "cpu"),
            imgsz=config.get("imgsz", 512),
        )
        self.zone_manager = ZoneManager(
            zone_configs=config["zones"],
            dwell_alert_seconds=config.get("dwell_alert_seconds", 20),
            alert_cooldown_seconds=config.get("alert_cooldown_seconds", 15),
        )

        heat_config = config.get("heatmap", {})
        self.heatmap = HeatmapAccumulator(
            decay=heat_config.get("decay", 0.97),
            intensity=heat_config.get("intensity", 0.55),
        )
        self.show_heatmap = heat_config.get("enabled", True)

        flow_config = config.get("flow", {})
        self.flow = FlowField(
            columns=flow_config.get("columns", 12),
            rows=flow_config.get("rows", 16),
            decay=flow_config.get("decay", 0.92),
            min_speed=flow_config.get("min_speed", 1.2),
        )
        self.show_flow = flow_config.get("enabled", True)

        # --- the shared box between this thread and the web server ---
        self.lock = threading.Lock()
        self.latest_jpeg = None       # the most recent annotated frame, as a JPEG
        self.latest_stats = {}        # the most recent numbers
        self.new_alerts = deque(maxlen=100)  # alerts the dashboard has not seen yet

        self.running = False
        self.thread = None

        # --- playback control, for driving a live demo ---
        self.paused = False
        self.seek_request = None      # a frame number to jump to, or None
        self.restart_request = False

        # Forces exactly one processing pass even while paused. Set when the
        # zones change: without it, saving a zone while the video is paused
        # would update the rules but publish no new stats, so the dashboard
        # would show nothing until someone pressed play -- which looks exactly
        # like the save having failed.
        self.force_step = False

        # Performance bookkeeping, so we can report FPS honestly.
        self.frame_times = deque(maxlen=30)
        self.last_headcount_save = 0.0
        self.frame_number = 0
        self.last_people = []
        self.last_raw_frame = None

        # Swapping the video happens here rather than in the web request, so
        # the loop is never halfway through a frame when the source changes.
        self.pending_source = None
        self.source_name = Path(str(config["source"])).name

        # "idle" | "running" | "done" | "failed" -- surfaced to the dashboard
        # so the operator knows the footage is being analysed.
        self.autozone_status = "idle"

    # ------------------------------------------------------------------ #
    # starting and stopping
    # ------------------------------------------------------------------ #

    def start(self):
        self.running = True
        # daemon=True means this thread will not stop the program from closing.
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=3)
        self.source.release()

    # ------------------------------------------------------------------ #
    # the main loop
    # ------------------------------------------------------------------ #

    def _run_loop(self):
        frame_skip = self.config.get("frame_skip", 0)

        # Do not race through a video faster than it was filmed. Without this,
        # a short clip on a fast machine would blur past before anyone saw it.
        source_fps = self.source.source_fps
        target_interval = (1.0 / source_fps) if source_fps else 0.0

        while self.running:
            started_at = time.time()

            # --- playback requests from the dashboard ---
            # A seek while paused must still render one frame, otherwise
            # dragging the scrub bar would move the position but leave the
            # picture frozen on the old frame.
            step_once = False

            if self.restart_request:
                self.source.seek(0)
                self.restart_request = False
                step_once = True
            if self.seek_request is not None:
                self.source.seek(self.seek_request)
                self.seek_request = None
                step_once = True
            if self.force_step:
                self.force_step = False
                step_once = True

            if self.pending_source is not None:
                self._swap_source(self.pending_source)
                self.pending_source = None
                step_once = True

            if self.paused and not step_once:
                # Keep serving the frame we already have; do no work.
                time.sleep(0.05)
                continue

            if self.paused and step_once and self.last_raw_frame is not None:
                # Re-render the frame we are already parked on rather than
                # reading the next one, so saving a zone while paused does not
                # nudge the video forward.
                frame = self.last_raw_frame.copy()
            else:
                frame = self.source.read()
                if frame is None:
                    time.sleep(0.1)
                    continue
                # Keep a clean copy: the drawing steps below write onto the
                # frame, so the original has to be kept separately.
                self.last_raw_frame = frame.copy()

            self.frame_number += 1

            # On a slow laptop you can process only every 2nd or 3rd frame.
            # The video still plays smoothly because we keep showing frames,
            # we just reuse the previous detections for the skipped ones.
            should_detect = (frame_skip == 0) or (self.frame_number % (frame_skip + 1) == 0)

            if should_detect:
                people = self.detector.detect(frame)
                self.last_people = people
            else:
                people = self.last_people

            # --- rules ---
            zone_manager = self.zone_manager      # may be swapped by reload_zones
            zone_stats, alerts = zone_manager.update(people)

            # --- save a headcount reading about once a second ---
            now = time.time()
            if now - self.last_headcount_save >= 1.0:
                self.database.insert_headcount(len(people))
                self.last_headcount_save = now

            # --- draw ---
            if self.show_heatmap:
                self.heatmap.update(frame.shape, people)
                frame = self.heatmap.render(frame)

            # The flow field is always updated, even when it is hidden, so
            # switching it on mid-demo shows current movement immediately
            # instead of an empty grid that takes seconds to fill.
            self.flow.update(frame.shape, people)
            if self.show_flow:
                frame = self.flow.render(frame)

            frame = draw_zones(frame, zone_manager.zones, zone_stats)
            frame = draw_people(frame, people)

            # --- measure how long this frame took, in milliseconds ---
            processing_ms = (time.time() - started_at) * 1000
            self.frame_times.append(processing_ms)
            average_ms = sum(self.frame_times) / len(self.frame_times)
            fps = 1000 / average_ms if average_ms > 0 else 0

            frame = draw_status_bar(frame, len(people), fps, average_ms)

            # --- encode once, reuse for both streaming and evidence ---
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            jpeg = encoded.tobytes() if ok else None

            # --- save alerts, each with the exact frame that triggered it ---
            for alert in alerts:
                saved = self.database.insert_alert(alert)
                if jpeg:
                    filename = f"alert_{saved['id']:06d}.jpg"
                    (self.snapshot_dir / filename).write_bytes(jpeg)
                    self.database.set_snapshot(saved["id"], filename)
                    saved["snapshot"] = filename
                with self.lock:
                    self.new_alerts.append(saved)

            # --- put the finished frame and numbers in the shared box ---
            if jpeg:
                with self.lock:
                    self.latest_jpeg = jpeg
                    self.latest_stats = {
                        "timestamp": now,
                        "total_people": len(people),
                        "zones": zone_stats,
                        "fps": round(fps, 1),
                        "processing_ms": round(average_ms, 1),
                        "heatmap_on": self.show_heatmap,
                        "flow_on": self.show_flow,
                    }

            # --- pace playback so it is never faster than real time ---
            elapsed = time.time() - started_at
            if target_interval and elapsed < target_interval:
                time.sleep(target_interval - elapsed)

    # ------------------------------------------------------------------ #
    # what the web server reads
    # ------------------------------------------------------------------ #

    def get_frame(self):
        with self.lock:
            return self.latest_jpeg

    def get_stats(self):
        with self.lock:
            return dict(self.latest_stats)

    def drain_alerts(self):
        """Hand over any new alerts and clear the queue."""
        with self.lock:
            alerts = list(self.new_alerts)
            self.new_alerts.clear()
        return alerts

    def toggle_heatmap(self, enabled):
        self.show_heatmap = bool(enabled)
        return self.show_heatmap

    def toggle_flow(self, enabled):
        self.show_flow = bool(enabled)
        return self.show_flow

    # ------------------------------------------------------------------ #
    # playback control
    # ------------------------------------------------------------------ #

    def playback_state(self):
        return {
            "is_camera": self.source.is_camera,
            "paused": self.paused,
            "position": self.source.position,
            "total_frames": self.source.total_frames,
            "source_fps": round(self.source.source_fps, 2),
            "source_name": self.source_name,
            "autozone": self.autozone_status,
        }

    def set_paused(self, paused):
        self.paused = bool(paused)
        return self.playback_state()

    def seek(self, frame_index):
        self.seek_request = int(frame_index)
        return self.playback_state()

    def restart(self):
        self.restart_request = True
        return self.playback_state()

    # ------------------------------------------------------------------ #
    # live zone reload
    # ------------------------------------------------------------------ #

    def reload_zones(self, zone_configs):
        """
        Swap in a new set of zones without restarting the program.

        Building a whole new ZoneManager and then assigning it in one step is
        deliberate: the loop reads self.zone_manager once per frame, so it
        either sees the old set or the new set, never a half-updated one.
        """
        self.zone_manager = ZoneManager(
            zone_configs=zone_configs,
            dwell_alert_seconds=self.config.get("dwell_alert_seconds", 20),
            alert_cooldown_seconds=self.config.get("alert_cooldown_seconds", 15),
        )
        self.config["zones"] = zone_configs

        # Publish one frame of stats straight away, so the new zones appear on
        # the dashboard immediately even if playback is paused.
        self.force_step = True
        return len(self.zone_manager.zones)

    # ------------------------------------------------------------------ #
    # changing the video
    # ------------------------------------------------------------------ #

    def request_source(self, path):
        """Ask the loop to switch video. The swap happens between frames."""
        self.pending_source = str(path)

    def _swap_source(self, path):
        """Runs on the pipeline thread, so nothing is mid-frame."""
        try:
            new_source = VideoSource(
                source=path,
                loop=self.config.get("loop_video", True),
                process_width=self.config.get("process_width", 720),
            )
        except RuntimeError as error:
            print(f"  could not open {path}: {error}")
            return

        old = self.source
        self.source = new_source
        self.config["source"] = path
        self.source_name = Path(path).name
        try:
            old.release()
        except Exception:
            pass

        # Different scene, so everything learned about the old one is wrong.
        self.heatmap.accumulator = None
        self.flow.vectors = None
        self.flow.weights = None
        self.flow.previous = {}
        self.last_people = []
        self.last_raw_frame = None
        self.frame_times.clear()
        print(f"  source switched to {self.source_name}")

    def current_frame_size(self):
        """Width and height of the processed frame, so the editor can scale."""
        with self.lock:
            jpeg = self.latest_jpeg
        if not jpeg:
            return {"width": 0, "height": 0}
        import numpy as np
        image = cv2.imdecode(np.frombuffer(jpeg, dtype="uint8"), cv2.IMREAD_COLOR)
        if image is None:
            return {"width": 0, "height": 0}
        height, width = image.shape[:2]
        return {"width": width, "height": height}
