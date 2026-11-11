"""
run.py  --  start everything.

Usage:      python run.py
Then open:  http://localhost:8000

This is the only file you run. It reads config.json, builds the three pieces
(database, pipeline, web server), wires them together and starts serving.
"""

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent

# Make sure Python can find the "backend" folder no matter which directory you
# happen to be standing in when you run this. Without this line you can get
# "ModuleNotFoundError: No module named 'backend'".
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import uvicorn

from backend.database import Database
from backend.pipeline import Pipeline
from backend.server import create_app
from backend.tasks import start_autozone


def load_config():
    config_path = PROJECT_ROOT / "config.json"
    if not config_path.exists():
        sys.exit("config.json not found. It should sit next to run.py.")

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    # Any key starting with an underscore is just a help note for you, not a
    # setting the program uses. Strip them out so they cannot cause confusion.
    config = {k: v for k, v in config.items() if not k.startswith("_")}

    # Turn the video path into a full path so it works no matter which folder
    # you run the command from.
    source = config.get("source")
    if isinstance(source, str):
        config["source"] = str(PROJECT_ROOT / source)
    config["model_path"] = str(PROJECT_ROOT / config.get("model_path", "models/yolov8n.pt"))

    # Zone polygons are stored in the pixel coordinates of the PROCESSED frame.
    # So if process_width changes -- a different setting, different footage --
    # every saved zone would silently land in the wrong place, with no error
    # and no obvious symptom beyond alerts that never fire.
    #
    # config.json records the width the zones were drawn at, so we can rescale
    # them instead. A zone still means the same part of the scene.
    drawn_at = config.get("zones_frame_width")
    current = config.get("process_width", 960)
    if drawn_at and drawn_at != current:
        factor = current / drawn_at

        for zone in config.get("zones", []):
            zone["points"] = [[int(x * factor), int(y * factor)] for x, y in zone["points"]]

        # Response units live in the same coordinate space -- they are posts
        # marked on the camera's view -- so they move with it. Without this a
        # unit placed near the bottom of a 960px-wide frame ends up off the
        # edge of a 720px one and vanishes from the site map.
        for unit in config.get("units", []):
            x, y = unit.get("position", [0, 0])
            unit["position"] = [int(x * factor), int(y * factor)]

        print(f"  geometry     : rescaled from {drawn_at}px to {current}px wide")
        config["zones_frame_width"] = current

    return config


def main():
    config = load_config()

    print("Starting crowd analytics...")
    print(f"  video source : {config['source']}")
    print(f"  model        : {config['model_path']}")
    print(f"  zones        : {', '.join(z['name'] for z in config['zones'])}")

    database = Database(str(PROJECT_ROOT / "events.db"))

    snapshot_dir = PROJECT_ROOT / "snapshots"
    pipeline = Pipeline(config, database, snapshot_dir=snapshot_dir)
    pipeline.start()

    app = create_app(
        pipeline,
        database,
        config_path=PROJECT_ROOT / "config.json",
        snapshot_dir=snapshot_dir,
    )

    # Analysing the footage to propose a zone is OFF by default. It is a
    # useful capability, but creating a zone nobody asked for is the wrong
    # default: an operator should decide what is worth monitoring. The AUTO
    # button in the zone editor runs exactly the same job on demand.
    if config.get("auto_zone_on_start") and not config.get("zones"):
        print("  zones        : none configured, analysing footage...")
        start_autozone(pipeline, PROJECT_ROOT / "config.json")

    print("\n  Dashboard ready at  ->  http://localhost:8000\n")

    try:
        uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
    finally:
        pipeline.stop()


if __name__ == "__main__":
    main()
