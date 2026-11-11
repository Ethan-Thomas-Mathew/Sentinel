# SENTINEL — online demo script, 12 minutes

Written for a video call. The constraints of a remote demo are different from
an in-person one, and most of what follows exists because of them.

---

## Before the call

**Use a video file, not your webcam.** Zoom, Meet and Teams hold the camera to
show your face. The app cannot have it at the same time. Set
`"source": "data/demo.mp4"` in `config.json` and confirm it plays.

**Start the app 5 minutes early.** The first run loads PyTorch and takes a few
seconds. You do not want that happening while people watch.

**Seed some history.** Let it run for two or three minutes before the call so
the chart and the alert list are populated. An empty dashboard is a weak
opening.

**Turn on Presentation mode** (top right). Screen sharing re-encodes your
screen at a low bitrate, and 12px type turns to mush at the other end. This
raises every size that has to stay readable.

**Close everything else.** YOLO and your video encoder are both fighting for
the same CPU. Every other app you close buys you frames per second.

**Share the browser tab, not the whole screen.** Sharper, and nothing private
leaks in.

**Have a fallback.** Record a 60-second screen capture of the working app the
night before. If something fails live, you play the recording and keep
talking. Nobody marks you down for a prepared backup; they do mark you down
for four minutes of silence.

---

## The script

### 0:00 — Problem, in two sentences
> "Crowding in corridors and at entrances is a safety issue, and by the time a
> human notices it on a camera wall it is already a queue. This watches the
> feed continuously and raises an alert the moment a defined area goes over
> its capacity."

Do not open with your architecture. Open with the problem.

### 0:30 — The dashboard, before any explaining
Share the screen with the app already running. Let it move for a few seconds
before you speak. The boxes tracking people are self-explanatory and they buy
you goodwill.

Point out, in this order:
1. The live count rising and falling.
2. The heatmap, and what it means — where people have **recently** stood, not
   everywhere anyone has ever walked, because old heat fades every frame.
3. The **flow arrows**, and this line, which is the strongest thing you will
   say in the first two minutes:
   > "A full zone tells you *that* there is a problem. The arrows start to
   > tell you *why*. Each one is the average velocity of everyone tracked in
   > that cell of the grid — so arrows pointing into each other are a
   > crossing conflict, and arrows shortening towards a doorway mean people
   > are slowing down, which is a queue forming before any count has gone
   > over its limit."

   Then add that it needs no extra model — it is arithmetic on track IDs the
   system already has. Toggle it off and on so they see the difference.
4. The capacity meters on the right, and the notch marking the limit.

### 2:00 — Trigger a congestion alert
Use the scrub bar to jump to the moment you know the zone fills.

When the banner appears, say what happened in system terms:
> "The zone count passed its capacity, the rules engine raised a CRITICAL
> alert, the backend wrote it to SQLite with the exact frame that triggered
> it, and pushed it to this page over a WebSocket. No refresh."

Then click the thumbnail in the alert feed to enlarge the evidence frame.
**This is the moment that separates a demo from a toy** — you are not showing
that something lit up, you are showing the stored proof.

### 3:00 — Trigger an intrusion, then dispatch a unit (Track B)
Scrub to where someone crosses the restricted zone. A second incident type
appears in the queue, tagged `INTRUSION`.

Then say the line that justifies the whole merge:
> "This is Track B's intrusion detection, and it is not new vision code. A
> congestion rule asks whether occupancy is above capacity; an intrusion rule
> asks whether occupancy is above zero. Same point-in-polygon test, same
> tracker — one flag on the zone. What Track B actually adds is the workflow."

Now click **ACK**, then **DISPATCH**. Point at which unit it chose:
> "It suggested Gate Security because the backend measured the distance from
> the centre of that zone to each available unit. It's a simulation, not real
> routing — but it picks the right unit for the right place."

Then **RESOLVE**, and note the queue's OPEN count drop. Finish with the CSV
export: every incident, its status, the unit assigned and when.

### 3:30 — Show a false positive check
Scrub to a quiet stretch where people walk through normally and nothing fires.
> "The brief asked for false positives. Here is normal traffic under capacity,
> and the system correctly stays silent. Over-alerting is how operators learn
> to ignore a system."

Volunteering this is worth more than being asked.

### 4:30 — Draw a zone live
Click **Edit zones**. It pauses the video automatically. Draw a polygon over a
new area, name it, set capacity 2, save.

> "Saved zones reload without restarting the process, and they are written
> back to config.json so they survive a restart too."

Then the point that shows you understand the problem rather than just the code:
> "These are polygons rather than rectangles for a reason. A camera flattens
> 3D space by perspective, so a rectangular patch of floor appears on screen
> as a trapezoid. The rectangle, square and circle tools are conveniences —
> each one converts to an ordered list of points before it is saved, so the
> rules engine only ever deals with one kind of geometry. A circle is stored
> as a 32-sided polygon."

### 6:30 — The architecture, now that they have seen it work
Show the diagram in the README. Four layers: input, vision and rules, backend
and storage, dashboard.

The two things to say:
> "Video processing runs in a background thread, not inside the web request.
> The web layer only reads the latest finished frame from a lock-protected
> shared object. So the video is processed once no matter how many browsers
> are watching, and a slow frame never freezes the page."

> "Three transports, three jobs. MJPEG for video, WebSocket for live numbers,
> REST for history and commands."

### 8:00 — Code walkthrough
Four files, roughly 90 seconds each. Do not scroll through everything.

- `vision.py` — detection versus tracking, and **why** tracking matters: without
  stable IDs you cannot tell one person standing still for 30 seconds from 30
  people walking past.
- `zones.py` — point-in-polygon against the person's **feet**, not the centre
  of the box, because a zone is an area of floor. Then the dwell timer and the
  alert cooldown.
- `pipeline.py` — the producer/consumer loop.
- `index.html` — the WebSocket handler and the capacity meter.

### 11:00 — Limitations, unprompted
State these before anyone asks:

- Counts under-read in dense crowds because overlapping people merge into one
  detection.
- A track ID can change if someone is occluded for several seconds, which
  restarts their dwell timer.
- Occupancy has no sense of depth; a distant person can read as inside a zone
  they are standing behind.
- Measured at roughly N fps / N ms per frame on this laptop, CPU only.
  **Fill in your real numbers.** Never quote a benchmark you did not run.

Knowing your system's limits reads as engineering maturity. Pretending it has
none reads as not having tested it.

---

## Questions you will probably get

**"Why YOLOv8n and not something bigger?"**
It runs at a usable frame rate on a CPU laptop. The model path is one line in
`config.json`; a bigger model is a drop-in swap if there is a GPU.

**"How would this scale to 50 cameras?"**
Not like this. One pipeline per camera on one machine will not hold. You would
run detection as its own service per camera, publish events to a queue, and
keep the dashboard as a consumer. The layer boundaries are already in the
right place for that split.

**"What is the AGPL on YOLO going to do to you?"**
It is copyleft. Fine for coursework. For a commercial product it would need an
Ultralytics commercial licence or a permissively licensed detector instead.
This is documented in the README.

**"Did you write this yourself?"**
Answer honestly and specifically. The thing that proves authorship is not a
claim, it is being able to explain *why* each decision was made — feet instead
of box centre, polygons instead of rectangles, a background thread instead of
work inside the request. Know those three cold and the question answers itself.

**"What would you build next?"**
Multi-camera support and line-crossing counts for directional flow. Both fit
the existing layering without restructuring anything.

---

## If something breaks mid-demo

Say what you are doing, do it, keep talking. Silence is the only real failure.

- Feed freezes → reload the browser tab. The backend keeps running.
- Backend crashed → `python run.py` again; talk through the architecture
  diagram while it loads.
- Frame rate collapses → say so, and say why: "detection and the screen-share
  encoder are competing for the same CPU." That is a correct diagnosis, which
  is worth more than a smooth frame rate.
