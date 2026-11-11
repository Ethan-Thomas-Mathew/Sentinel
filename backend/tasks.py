"""
tasks.py  --  work that runs in the background, off the web request.

Right now that means one job: analysing a video to propose a zone. It takes
a few seconds, which is far too long to hold a web request open, and far too
long to block startup. So it runs on its own thread, reports progress through
pipeline.autozone_status, and applies the result when it is ready.

The dashboard watches that status and shows "ANALYSING FOOTAGE" while it
works, so the operator is never looking at an empty panel wondering whether
anything is happening.
"""

import json
import threading

from .autozone import propose_zone


def start_autozone(pipeline, config_path, only_if_empty=True, name="Monitored Area"):
    """
    Kick off zone analysis on a background thread.

    Returns True if a job was started, False if one was unnecessary (zones
    already exist) or already running.
    """
    if pipeline.autozone_status == "running":
        return False
    if only_if_empty and pipeline.zone_manager.zones:
        return False

    thread = threading.Thread(
        target=_run, args=(pipeline, config_path, name), daemon=True)
    thread.start()
    return True


def _run(pipeline, config_path, name):
    pipeline.autozone_status = "running"
    try:
        config = pipeline.config
        zone = propose_zone(
            video_path=str(config["source"]),
            model_path=str(config.get("model_path", "models/yolov8n.pt")),
            imgsz=config.get("imgsz", 512),
            process_width=config.get("process_width", 720),
            confidence=config.get("confidence", 0.35),
            name=name,
        )

        if zone is None:
            pipeline.autozone_status = "failed"
            print("  auto-zone: no people found, leaving zones empty")
            return

        # Keep any zones that already exist; this adds to them.
        existing = [
            {"name": z.name, "capacity": z.capacity,
             "restricted": z.restricted, "points": z.polygon.tolist()}
            for z in pipeline.zone_manager.zones
        ]
        existing.append(zone)
        pipeline.reload_zones(existing)
        _persist(config_path, existing, config.get("process_width", 720))

        pipeline.autozone_status = "done"
        print(f"  auto-zone: proposed '{zone['name']}' "
              f"({len(zone['points'])} corners, capacity {zone['capacity']})")
    except Exception as error:                      # never kill the thread silently
        pipeline.autozone_status = "failed"
        print(f"  auto-zone failed: {error}")


def _persist(config_path, zones, frame_width):
    """Write the zones into config.json, keeping the explanatory notes."""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            on_disk = json.load(f)
        on_disk["zones"] = zones
        on_disk["zones_frame_width"] = frame_width
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(on_disk, f, indent=2)
    except Exception as error:
        print(f"  could not save auto-zone to config.json: {error}")
