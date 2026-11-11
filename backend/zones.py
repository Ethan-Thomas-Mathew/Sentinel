"""
zones.py  --  the "rules" of the system.

WHAT THIS FILE DOES
    vision.py tells us WHERE people are. This file decides what that MEANS:
       - how many people are inside each zone right now (occupancy)
       - how long each person has been standing in a zone (dwell time)
       - whether anyone is inside an area nobody should enter (intrusion)
       - whether any of that breaks a rule and should raise an incident

WHY IT IS A SEPARATE FILE
    The brief's architecture table splits "vision" from "rules". A reviewer can
    read this file and understand your alert logic without reading any AI code.

THE FOUR RULES
    1. CONGESTION (critical) -- a zone holds more people than its capacity.
    2. INTRUSION  (critical) -- anyone at all is inside a restricted zone.
                                This is Track B's "intrusion" incident type,
                                and it reuses exactly the same geometry as
                                Track A's occupancy counting.
    3. DWELL      (warning)  -- one person stays in a zone past the time limit.
    4. CLEARED    (info)     -- a zone that was over capacity is normal again.

    Rule 4 is worth noticing: it is the only rule that fires on a *change*
    rather than a state. An operator needs to know when something is resolved,
    not only when it breaks, and it is what gives the incident queue its
    third severity level.
"""

import time
import cv2
import numpy as np


class Zone:
    """One area drawn on the camera view."""

    def __init__(self, name, points, capacity, restricted=False):
        self.name = name
        self.capacity = capacity

        # A restricted zone is off-limits to everyone, so its capacity is
        # effectively zero and any occupancy at all is an incident.
        self.restricted = bool(restricted)

        # OpenCV needs the polygon corners as a numpy array of whole numbers.
        self.polygon = np.array(points, dtype=np.int32)

        # Remembers, for each person currently inside, the moment they arrived.
        #   {track_id: timestamp_when_they_entered}
        self.entry_times = {}

        # People we have already raised a dwell alert about, so we do not
        # raise the same alert every single frame.
        self.dwell_alerted = set()

        # Used by the CLEARED rule to spot the moment a zone recovers.
        self.was_breached = False

    def contains(self, point):
        """True if the (x, y) point is inside this zone's polygon."""
        # pointPolygonTest returns a positive number when the point is inside,
        # 0 when exactly on the edge, negative when outside.
        x, y = float(point[0]), float(point[1])
        return cv2.pointPolygonTest(self.polygon, (x, y), False) >= 0

    @property
    def centroid(self):
        """
        The middle of the zone, in frame pixels.

        Used to work out which response unit is nearest when an incident is
        dispatched. It is the average of the corners -- good enough for a
        simulated dispatch, and simple to explain.
        """
        return (int(self.polygon[:, 0].mean()), int(self.polygon[:, 1].mean()))


class ZoneManager:
    """Holds all the zones and applies the rules to them each frame."""

    def __init__(self, zone_configs, dwell_alert_seconds=20, alert_cooldown_seconds=15):
        self.zones = [
            Zone(z["name"], z["points"], z.get("capacity", 1), z.get("restricted", False))
            for z in zone_configs
        ]
        self.dwell_alert_seconds = dwell_alert_seconds
        self.alert_cooldown_seconds = alert_cooldown_seconds

        # When each kind of alert last fired, so we can hold it back for a while.
        #   {(zone_name, alert_type): timestamp}
        self.last_alert_at = {}

    def update(self, people, now=None):
        """
        Run once per processed frame.

        Input:  the list of people from PersonDetector.detect()
        Output: (zone_stats, new_alerts)
        """
        if now is None:
            now = time.time()

        zone_stats = []
        new_alerts = []

        for zone in self.zones:
            # ---- Step 1: who is inside this zone right now? ----
            inside_ids = {p["id"] for p in people if zone.contains(p["point"])}
            count = len(inside_ids)

            # ---- Step 2: update the dwell clocks ----
            for track_id in inside_ids:
                if track_id not in zone.entry_times:
                    zone.entry_times[track_id] = now

            # Anyone who has left is forgotten, so if they come back later
            # their dwell time starts again from zero.
            for track_id in set(zone.entry_times) - inside_ids:
                del zone.entry_times[track_id]
                zone.dwell_alerted.discard(track_id)

            longest_dwell = (now - min(zone.entry_times.values())) if zone.entry_times else 0.0

            # ---- Step 3: apply the rules ----
            if zone.restricted:
                breached = count > 0
                if breached and self._cooldown_passed(zone.name, "INTRUSION", now):
                    new_alerts.append({
                        "zone": zone.name,
                        "type": "INTRUSION",
                        "severity": "CRITICAL",
                        "message": (f"{count} person(s) inside restricted area {zone.name}."),
                        "count": count,
                    })
            else:
                breached = count > zone.capacity
                if breached and self._cooldown_passed(zone.name, "CONGESTION", now):
                    new_alerts.append({
                        "zone": zone.name,
                        "type": "CONGESTION",
                        "severity": "CRITICAL",
                        "message": (f"{zone.name} is over capacity: {count} people "
                                    f"(limit {zone.capacity})."),
                        "count": count,
                    })

            # RULE 3: one person standing too long.
            for track_id, entered_at in zone.entry_times.items():
                dwell = now - entered_at
                if dwell >= self.dwell_alert_seconds and track_id not in zone.dwell_alerted:
                    zone.dwell_alerted.add(track_id)
                    new_alerts.append({
                        "zone": zone.name,
                        "type": "DWELL",
                        "severity": "WARNING",
                        "message": f"Person #{track_id} has stayed in {zone.name} for {int(dwell)}s.",
                        "count": count,
                    })

            # RULE 4: the zone has recovered. Fires once, on the change.
            if zone.was_breached and not breached:
                new_alerts.append({
                    "zone": zone.name,
                    "type": "CLEARED",
                    "severity": "INFO",
                    "message": f"{zone.name} is back within normal limits ({count}).",
                    "count": count,
                })
            zone.was_breached = breached

            zone_stats.append({
                "name": zone.name,
                "count": count,
                "capacity": zone.capacity,
                "restricted": zone.restricted,
                "occupancy_pct": round(100 * count / zone.capacity) if zone.capacity else 0,
                "over_capacity": breached,
                "longest_dwell": round(longest_dwell, 1),
                "centroid": zone.centroid,
            })

        return zone_stats, new_alerts

    def _cooldown_passed(self, zone_name, alert_type, now):
        """
        Stops the same alert firing 30 times a second.

        Without this, a crowded corridor would write thousands of rows to the
        database in a minute and the incident queue would be unreadable.
        """
        key = (zone_name, alert_type)
        if now - self.last_alert_at.get(key, 0) < self.alert_cooldown_seconds:
            return False
        self.last_alert_at[key] = now
        return True

    def nearest_unit(self, zone_name, units):
        """
        Track B's "assign the nearest available patrol unit".

        Each unit has a position on the camera view. We measure straight-line
        distance from the middle of the zone to each unit and pick the closest
        one that is free. This is a simulation, and saying so is better than
        pretending it is routing on a real map.
        """
        zone = next((z for z in self.zones if z.name == zone_name), None)
        if zone is None or not units:
            return None

        zx, zy = zone.centroid
        available = [u for u in units if u.get("available", True)]
        if not available:
            return None

        def distance(unit):
            ux, uy = unit.get("position", [0, 0])
            return ((ux - zx) ** 2 + (uy - zy) ** 2) ** 0.5

        closest = min(available, key=distance)
        return {"name": closest["name"], "distance_px": round(distance(closest))}
