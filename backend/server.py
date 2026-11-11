"""
server.py  --  the web layer.

WHAT THIS FILE DOES
    Opens the doors that the browser knocks on:

        GET  /                      the dashboard page
        GET  /video.mjpg            the live annotated video
        WS   /ws                    live stats + alerts, pushed as they happen
        GET  /api/alerts            alert history
        GET  /api/history           headcount over time (for the chart)
        GET  /api/summary           totals for the KPI cards
        GET  /api/zones             current zone shapes
        POST /api/zones             save new zone shapes and reload them live
        GET  /api/playback          where the video is up to
        POST /api/playback/...      pause, seek, restart
        POST /api/heatmap           turn the heatmap overlay on or off
        GET  /api/export.csv        download the alert log
        GET  /snapshots/<file>      evidence image for one alert

WHY THREE DIFFERENT WAYS OF SENDING DATA
    The brief's architecture table asks for exactly this split, and each one
    suits a different job:

        MJPEG      -- video. A never-ending stream of JPEG images.
        WebSocket  -- live numbers. The server pushes without being asked,
                      which is why the dashboard updates with no page refresh.
        REST       -- history and commands. Normal request/response.
"""

import asyncio
import json
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .tasks import start_autozone

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


class ZoneIn(BaseModel):
    """
    The shape of one zone as the dashboard sends it.

    Declaring it like this means FastAPI checks the data for us and returns a
    clear error if the browser sends something malformed, instead of the
    pipeline crashing later on bad input.
    """
    name: str
    capacity: int = 1
    points: list[list[int]]
    # A restricted zone is off-limits to everyone: any occupancy is an
    # intrusion incident. This single flag is what merges Track B's intrusion
    # detection into Track A's geometry.
    restricted: bool = False


class UnitIn(BaseModel):
    """
    One response unit as the site map sends it.

    A unit is a post marked on the camera's view -- a guard at a gate, a
    medic at a stand. Its position is in the same pixel coordinates as a
    zone's points, which is what lets nearest_unit() measure the distance
    from an incident to a responder without needing any real-world survey.
    """
    name: str
    position: list[int]
    available: bool = True


def create_app(pipeline, database, config_path, snapshot_dir):
    app = FastAPI(title="Crowd Density and Bottleneck Analytics")

    # ---------------------------------------------------------------- #
    # the dashboard page
    # ---------------------------------------------------------------- #

    @app.get("/")
    def dashboard():
        return FileResponse(FRONTEND_DIR / "index.html")

    # ---------------------------------------------------------------- #
    # live video
    # ---------------------------------------------------------------- #

    @app.get("/video.mjpg")
    def video_stream():
        """
        MJPEG works by sending one JPEG after another down a single connection
        that never closes. The browser shows each new one as it arrives, which
        looks like video. The --frame lines are the separators between images.
        """
        def generate():
            # Only send a frame when it is actually a NEW one.
            #
            # The obvious version of this loop -- "read the latest frame and
            # yield it, forever" -- re-sends the same picture as fast as the
            # socket will take it. That pegs a CPU core, floods the browser
            # with thousands of duplicate frames a second, and starves the
            # detector of the CPU it needs. When playback is paused it never
            # stops, because the frame never changes.
            #
            # The pipeline swaps in a brand-new bytes object for every frame,
            # so an identity check is enough to tell "new" from "unchanged",
            # and costs nothing.
            # A stream that goes COMPLETELY silent has its own problem: the
            # tail of the last frame can sit unflushed in a buffer, so the
            # browser never finishes decoding it and shows nothing at all.
            # So when the picture is not changing we still resend it, but
            # about twice a second instead of thousands of times.
            last = None
            last_sent_at = 0.0
            KEEPALIVE = 0.5

            while True:
                jpeg = pipeline.get_frame()
                if jpeg is None:
                    time.sleep(0.02)
                    continue

                now = time.time()
                if jpeg is not last or now - last_sent_at >= KEEPALIVE:
                    last = jpeg
                    last_sent_at = now
                    yield (b"--frame\r\n"
                           b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n")
                else:
                    time.sleep(0.02)

        return StreamingResponse(
            generate(),
            media_type="multipart/x-mixed-replace; boundary=frame",
        )

    @app.get("/api/frame-size")
    def frame_size():
        """
        The pixel size of the processed frame.

        The zone editor needs this: you click at a position on a scaled-down
        picture in the browser, and those clicks must be converted back into
        the frame's real pixel coordinates before they are saved.
        """
        return JSONResponse(pipeline.current_frame_size())

    # ---------------------------------------------------------------- #
    # live numbers and alerts
    # ---------------------------------------------------------------- #

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        try:
            while True:
                payload = {
                    "stats": pipeline.get_stats(),
                    "alerts": pipeline.drain_alerts(),
                    "playback": pipeline.playback_state(),
                }
                await websocket.send_text(json.dumps(payload))
                # Twice a second. Fast enough to feel live, slow enough that
                # the browser is not doing work constantly.
                await asyncio.sleep(0.5)
        except WebSocketDisconnect:
            pass
        except Exception:
            # The browser tab was closed or refreshed. Nothing to fix.
            pass

    # ---------------------------------------------------------------- #
    # history (plain REST)
    # ---------------------------------------------------------------- #

    @app.get("/api/alerts")
    def get_alerts(limit: int = 50):
        return JSONResponse(database.recent_alerts(limit))

    @app.get("/api/history")
    def get_history(minutes: int = 10):
        return JSONResponse(database.headcount_history(minutes))

    @app.get("/api/summary")
    def get_summary():
        data = database.summary()
        data["open_incidents"] = database.open_incident_count()
        return JSONResponse(data)

    @app.get("/api/export.csv")
    def export_csv():
        """Download the whole alert log as a spreadsheet file."""
        return PlainTextResponse(
            database.export_alerts_csv(),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="alerts.csv"'},
        )

    # ---------------------------------------------------------------- #
    # zones -- read and write
    # ---------------------------------------------------------------- #

    @app.get("/api/zones")
    def get_zones():
        return JSONResponse([
            {"name": z.name, "capacity": z.capacity, "restricted": z.restricted,
             "points": z.polygon.tolist()}
            for z in pipeline.zone_manager.zones
        ])

    # ---------------------------------------------------------------- #
    # Track B: response units and the dispatch workflow
    # ---------------------------------------------------------------- #

    def write_config(changes: dict):
        """
        Merge a few keys into config.json on disk.

        It re-reads the file rather than dumping the in-memory config, because
        the file carries "_help" notes that run.py strips out on load. Writing
        the loaded copy back would silently delete every one of them.
        """
        with open(config_path, "r", encoding="utf-8") as f:
            on_disk = json.load(f)
        on_disk.update(changes)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(on_disk, f, indent=2)

    @app.get("/api/units")
    def get_units():
        """The response units an operator can send, from config.json."""
        return JSONResponse(pipeline.config.get("units", []))

    @app.post("/api/units")
    def save_units(units: list[UnitIn]):
        """
        Save the response units placed on the site map.

        Units used to be editable only by hand-writing coordinates into
        config.json, which is fine for a developer and useless for an
        operator: where the medical post stands is site knowledge, not a
        setting. Dragging a marker on the plan is the honest interface for it.

        The change applies immediately -- pipeline.config is the same dict the
        dispatch endpoints read -- so the next incident is routed to the new
        positions with no restart.
        """
        payload = [u.model_dump() for u in units]
        write_config({
            "units": payload,
            # Positions are frame pixels, exactly like zone points, so they
            # need the same record of the width they were placed at. Without
            # it, changing process_width would leave every unit in the wrong
            # spot. run.py rescales both on load using this value.
            "zones_frame_width": pipeline.config.get("process_width", 960),
        })
        pipeline.config["units"] = payload
        return {"saved": len(payload)}

    @app.get("/api/alerts/{alert_id}/suggest")
    def suggest_unit(alert_id: int):
        """
        Which unit is nearest to this incident.

        The dashboard calls this when the operator opens the dispatch picker,
        so the closest unit is already selected for them. Distance is measured
        from the middle of the zone to the unit's position on the camera view.
        """
        rows = [a for a in database.recent_alerts(500) if a["id"] == alert_id]
        if not rows:
            return JSONResponse({"error": "no such incident"}, status_code=404)
        suggestion = pipeline.zone_manager.nearest_unit(
            rows[0]["zone"], pipeline.config.get("units", []))
        return JSONResponse(suggestion or {})

    @app.post("/api/alerts/{alert_id}/status")
    def set_alert_status(alert_id: int, status: str):
        allowed = {"NEW", "ACKNOWLEDGED", "DISPATCHED", "RESOLVED"}
        if status not in allowed:
            return JSONResponse({"error": f"status must be one of {sorted(allowed)}"},
                                status_code=400)
        updated = database.set_status(alert_id, status)
        if updated is None:
            return JSONResponse({"error": "no such incident"}, status_code=404)
        return JSONResponse(updated)

    @app.post("/api/alerts/{alert_id}/dispatch")
    def dispatch_alert(alert_id: int, unit: str = ""):
        """
        Send a unit to an incident. With no unit named, the nearest free one
        is chosen automatically.
        """
        rows = [a for a in database.recent_alerts(500) if a["id"] == alert_id]
        if not rows:
            return JSONResponse({"error": "no such incident"}, status_code=404)

        if not unit:
            suggestion = pipeline.zone_manager.nearest_unit(
                rows[0]["zone"], pipeline.config.get("units", []))
            if not suggestion:
                return JSONResponse({"error": "no units available"}, status_code=409)
            unit = suggestion["name"]

        return JSONResponse(database.set_status(alert_id, "DISPATCHED", unit=unit))

    @app.post("/api/zones")
    def save_zones(zones: list[ZoneIn]):
        """
        Save zones drawn in the browser, then apply them immediately.

        Note what is NOT here: there is no separate shape type for circles or
        rectangles. The editor converts every shape it draws into a list of
        points before sending it, so the rules engine only ever deals with
        one kind of thing -- a polygon.
        """
        payload = [z.model_dump() for z in zones]

        write_config({
            "zones": payload,
            # Record the frame width these points were drawn at, so they can
            # be rescaled automatically if process_width ever changes.
            "zones_frame_width": pipeline.config.get("process_width", 960),
        })

        count = pipeline.reload_zones(payload)
        return {"saved": count}

    # ---------------------------------------------------------------- #
    # video sources: list, upload, switch
    # ---------------------------------------------------------------- #

    VIDEO_TYPES = {".mp4", ".avi", ".mov", ".mkv", ".webm"}

    @app.get("/api/videos")
    def list_videos():
        """Every clip sitting in data/, plus which one is playing."""
        data_dir = Path(pipeline.config["source"]).parent
        files = sorted(
            (p for p in data_dir.iterdir()
             if p.is_file() and p.suffix.lower() in VIDEO_TYPES),
            key=lambda p: p.name.lower())
        return JSONResponse({
            "current": pipeline.source_name,
            "videos": [{"name": p.name, "size_mb": round(p.stat().st_size / 1e6, 1)}
                       for p in files],
        })

    @app.post("/api/videos/upload")
    async def upload_video(file: UploadFile = File(...)):
        """
        Accept a video from the dashboard and make it the active source.

        The filename is reduced to its last path component and checked against
        a list of video extensions, so an upload cannot write outside data/
        or drop an executable into the project.
        """
        safe_name = Path(file.filename or "upload.mp4").name
        if Path(safe_name).suffix.lower() not in VIDEO_TYPES:
            return JSONResponse(
                {"error": f"not a video file: {safe_name}"}, status_code=400)

        data_dir = Path(pipeline.config["source"]).parent
        data_dir.mkdir(parents=True, exist_ok=True)
        destination = data_dir / safe_name

        # Stream it to disk in chunks rather than loading the whole clip into
        # memory -- a 4K video can be hundreds of megabytes.
        with open(destination, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)

        pipeline.request_source(str(destination))
        return JSONResponse({"saved": safe_name,
                             "size_mb": round(destination.stat().st_size / 1e6, 1)})

    @app.post("/api/videos/select")
    def select_video(name: str):
        data_dir = Path(pipeline.config["source"]).parent
        target = data_dir / Path(name).name          # no directory traversal
        if not target.exists():
            return JSONResponse({"error": f"no such video: {name}"}, status_code=404)
        pipeline.request_source(str(target))
        return JSONResponse({"source": target.name})

    @app.post("/api/zones/auto")
    def auto_zone(replace: bool = False):
        """
        Analyse the current video and propose a zone over the busy area.

        Runs on a background thread -- it takes a few seconds -- and the
        dashboard follows progress through playback.autozone.
        """
        if replace:
            pipeline.reload_zones([])
        started = start_autozone(pipeline, config_path, only_if_empty=False)
        return JSONResponse({"started": started, "status": pipeline.autozone_status})

    # ---------------------------------------------------------------- #
    # playback control -- what makes a live demo controllable
    # ---------------------------------------------------------------- #

    @app.get("/api/playback")
    def get_playback():
        return JSONResponse(pipeline.playback_state())

    @app.post("/api/playback/pause")
    def set_pause(paused: bool = True):
        return JSONResponse(pipeline.set_paused(paused))

    @app.post("/api/playback/seek")
    def seek(frame: int = 0):
        return JSONResponse(pipeline.seek(frame))

    @app.post("/api/playback/restart")
    def restart():
        return JSONResponse(pipeline.restart())

    # ---------------------------------------------------------------- #
    # operator controls
    # ---------------------------------------------------------------- #

    @app.post("/api/heatmap")
    def set_heatmap(enabled: bool = True):
        return {"heatmap_on": pipeline.toggle_heatmap(enabled)}

    @app.post("/api/flow")
    def set_flow(enabled: bool = True):
        return {"flow_on": pipeline.toggle_flow(enabled)}

    # Evidence images.
    app.mount("/snapshots", StaticFiles(directory=str(snapshot_dir)), name="snapshots")

    # The compiled React app. Vite writes hashed bundles into frontend/assets,
    # and the hash in the filename is what makes them safe to cache forever --
    # a new build produces a new name, so a browser can never serve a stale
    # bundle against a new backend.
    assets_dir = FRONTEND_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    return app
