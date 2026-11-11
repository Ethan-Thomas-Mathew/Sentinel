"""
database.py  --  the memory of the system.

WHAT THIS FILE DOES
    Saves alerts and headcount readings into a file called events.db so that:
       - the dashboard can show history from before you opened the page
       - you can prove to the panel that events were really recorded
       - closing and reopening the app does not lose anything

WHY SQLITE
    SQLite is a whole database that lives in ONE file and needs no installation
    or server. The brief lists "SQLite or PostgreSQL"; SQLite is the right
    choice for a single-machine demo.

THE THREADING NOTE (worth knowing if asked)
    Our video processing runs in a background thread while the web server runs
    in another. SQLite does not like being used from several threads at once,
    so every write goes through a lock -- a "only one at a time" gate.
"""

import csv
import io
import sqlite3
import threading
import time


class Database:
    def __init__(self, path="events.db"):
        # check_same_thread=False lets more than one thread use this connection.
        # It is only safe because we guard every call with self.lock below.
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row  # lets us read columns by name
        self.lock = threading.Lock()
        self._create_tables()

    def _create_tables(self):
        with self.lock:
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL    NOT NULL,
                    zone      TEXT    NOT NULL,
                    type      TEXT    NOT NULL,
                    severity  TEXT    NOT NULL,
                    message   TEXT    NOT NULL,
                    count     INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS headcounts (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL    NOT NULL,
                    total     INTEGER NOT NULL
                );

                -- An index makes "give me the newest rows" fast once the table
                -- has thousands of rows in it.
                CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(timestamp);
                CREATE INDEX IF NOT EXISTS idx_counts_time ON headcounts(timestamp);
            """)

            # A later version of this project added evidence snapshots. If the
            # database was created before that, add the column now. This is a
            # tiny example of a database migration.
            columns = {row["name"] for row in
                       self.connection.execute("PRAGMA table_info(alerts)")}
            if "snapshot" not in columns:
                self.connection.execute("ALTER TABLE alerts ADD COLUMN snapshot TEXT")

            # Track B's dispatch workflow. An incident moves NEW ->
            # ACKNOWLEDGED -> DISPATCHED -> RESOLVED, and remembers which unit
            # took it. Added as a migration so an existing events.db keeps its
            # history instead of being thrown away.
            if "status" not in columns:
                self.connection.execute(
                    "ALTER TABLE alerts ADD COLUMN status TEXT DEFAULT 'NEW'")
            if "assigned_unit" not in columns:
                self.connection.execute("ALTER TABLE alerts ADD COLUMN assigned_unit TEXT")
            if "dispatched_at" not in columns:
                self.connection.execute("ALTER TABLE alerts ADD COLUMN dispatched_at REAL")

            self.connection.commit()

    def insert_alert(self, alert, snapshot=None):
        """Save one alert. Returns the saved row (including its new id)."""
        timestamp = time.time()
        with self.lock:
            cursor = self.connection.execute(
                "INSERT INTO alerts (timestamp, zone, type, severity, message, count,"
                " snapshot, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'NEW')",
                (timestamp, alert["zone"], alert["type"], alert["severity"],
                 alert["message"], alert["count"], snapshot),
            )
            self.connection.commit()
            alert_id = cursor.lastrowid

        return {**alert, "id": alert_id, "timestamp": timestamp,
                "snapshot": snapshot, "status": "NEW", "assigned_unit": None}

    # ------------------------------------------------------------------ #
    # Track B: the dispatch workflow
    # ------------------------------------------------------------------ #

    def set_status(self, alert_id, status, unit=None):
        """
        Move one incident along the workflow.

        NEW -> ACKNOWLEDGED -> DISPATCHED -> RESOLVED. The unit name and the
        dispatch time are only written when a unit is actually assigned, so
        the record says who took it and when.
        """
        with self.lock:
            if unit is not None:
                self.connection.execute(
                    "UPDATE alerts SET status = ?, assigned_unit = ?, dispatched_at = ?"
                    " WHERE id = ?", (status, unit, time.time(), alert_id))
            else:
                self.connection.execute(
                    "UPDATE alerts SET status = ? WHERE id = ?", (status, alert_id))
            self.connection.commit()
            row = self.connection.execute(
                "SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        return dict(row) if row else None

    def open_incident_count(self):
        """How many incidents still need an operator's attention."""
        with self.lock:
            row = self.connection.execute(
                "SELECT COUNT(*) AS n FROM alerts WHERE status IN ('NEW','ACKNOWLEDGED')"
                " AND severity != 'INFO'").fetchone()
        return row["n"]

    def set_snapshot(self, alert_id, snapshot):
        with self.lock:
            self.connection.execute(
                "UPDATE alerts SET snapshot = ? WHERE id = ?", (snapshot, alert_id)
            )
            self.connection.commit()

    def insert_headcount(self, total):
        with self.lock:
            self.connection.execute(
                "INSERT INTO headcounts (timestamp, total) VALUES (?, ?)",
                (time.time(), total),
            )
            self.connection.commit()

    def recent_alerts(self, limit=50):
        with self.lock:
            rows = self.connection.execute(
                "SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def headcount_history(self, minutes=10):
        since = time.time() - minutes * 60
        with self.lock:
            rows = self.connection.execute(
                "SELECT timestamp, total FROM headcounts WHERE timestamp >= ?"
                " ORDER BY timestamp ASC", (since,)
            ).fetchall()
        return [dict(row) for row in rows]

    def summary(self):
        """A few totals for the dashboard's KPI cards."""
        since = time.time() - 3600  # the last hour
        with self.lock:
            total_alerts = self.connection.execute(
                "SELECT COUNT(*) AS n FROM alerts WHERE timestamp >= ?", (since,)
            ).fetchone()["n"]
            critical = self.connection.execute(
                "SELECT COUNT(*) AS n FROM alerts WHERE timestamp >= ? AND severity = 'CRITICAL'",
                (since,),
            ).fetchone()["n"]
            peak = self.connection.execute(
                "SELECT MAX(total) AS n FROM headcounts WHERE timestamp >= ?", (since,)
            ).fetchone()["n"]
        return {
            "alerts_last_hour": total_alerts,
            "critical_last_hour": critical,
            "peak_headcount": peak or 0,
        }

    def export_alerts_csv(self):
        """
        Produce the whole alert log as CSV text.

        The brief asks for evidence. A reviewer who can download the log and
        open it in Excel can check your claims without running your code.
        """
        with self.lock:
            rows = self.connection.execute(
                "SELECT * FROM alerts ORDER BY timestamp ASC"
            ).fetchall()

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["id", "time_utc", "zone", "type", "severity", "people_in_zone",
                         "status", "assigned_unit", "dispatched_utc", "message"])
        for row in rows:
            keys = row.keys()
            dispatched = row["dispatched_at"] if "dispatched_at" in keys else None
            writer.writerow([
                row["id"],
                time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(row["timestamp"])),
                row["zone"], row["type"], row["severity"], row["count"],
                row["status"] if "status" in keys else "",
                row["assigned_unit"] if "assigned_unit" in keys else "",
                time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(dispatched)) if dispatched else "",
                row["message"],
            ])
        return buffer.getvalue()
