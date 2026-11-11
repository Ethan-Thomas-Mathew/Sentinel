# Demo dataset

Put your demo video here as `demo.mp4` (or change `source` in `config.json`).

The brief asks for "a folder or link with the images or videos used to
validate your chosen track(s), including expected results". Record three short
clips and fill in this table with what actually happened when you ran them.

| Clip | What is in it | Expected result | Observed result |
|---|---|---|---|
| `01_congestion.mp4` | Enough people walk into the corridor zone to pass its capacity | Count rises past capacity, zone turns red, congestion banner appears, a CRITICAL alert is logged | *fill in* |
| `02_dwell.mp4` | One person stands still inside a zone past the dwell limit | A WARNING alert naming that person's track ID | *fill in* |
| `03_normal.mp4` | Ordinary foot traffic that stays under capacity | No alerts. This is the false-positive check the brief asks for | *fill in* |

## Measured performance

Run the app and read the figures off the status bar at the top of the video.
Record them here — the brief asks for processing time measured on your own
hardware, not a number copied from a benchmark.

| | Value |
|---|---|
| Machine | *e.g. Windows 11, Intel i5-1135G7, 8 GB RAM, no GPU* |
| `process_width` | 960 |
| Frames per second | *fill in* |
| Milliseconds per frame | *fill in* |

## Filming notes

- Hold the camera still. A moving camera makes the heatmap meaningless,
  because zones are fixed pixel areas on the frame.
- Shoot from slightly above head height looking down. This separates people
  who would otherwise overlap.
- Keep clips to 30–60 seconds. Long clips make the live demo drag.
- Set zone `capacity` low (2 or 3) in `config.json` so an alert actually
  fires during a short clip.
- Tell anyone appearing on camera what the footage is for.
