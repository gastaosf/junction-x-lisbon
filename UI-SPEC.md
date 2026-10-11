# UI-SPEC: astrolabio web console

Companion to `SPEC.md`. Section numbers written "SPEC n" refer to that file; rule numbers (R1–R12) and organiser questions (Q1–Q12) are the ones it defines.

## 1. Goal

One browser application from which everything the project does can be done: load panoramas, check what was parsed, launch and supervise runs, use the three penalised human channels, validate and download the submission, build and label the evaluation set, score and compare runs, replay any past run, and change settings.

The only terminal command left is the one that starts the server:

```
uv run python cli.py serve        # no arguments; opens the console on http://127.0.0.1:8000
```

The CLI commands stay and keep working (scripts and tests use them), but nothing may exist only there.

**Design principles**

1. **The UI adds no channel to the agent.** Exactly three operator inputs reach the model (SPEC 8). Every other control is a harness control and carries no information about the location.
2. **The server is authoritative.** Penalties, lint, deadlines and validation are decided by the backend; the page only renders state and asks.
3. **Attention is the scarce resource** (SPEC 10). At any moment the page must answer "what needs me now?" without scrolling.
4. **Nothing silent.** A defaulted label, a fallback answer, a missing key, an invalid export and a closed human window are shown where the operator is looking, before they cost points.
5. **Survives the venue.** No asset is loaded from the internet except map tiles; a reload, a second tab or a dropped connection never loses state or double-charges a penalty.

**Out of scope:** installing dependencies, running the test suite, editing the system prompt or tool definitions, user accounts, a mobile layout, hosting on a public address.

## 2. Situations the UI must serve

| Situation | When | What the operator needs |
|---|---|---|
| Training / trial batch | Sat | Drop a set in, check labels, run all autonomously, look at answers on a map, download exports |
| Scoring run | Sun 10:00, 60 min | Load 6 panoramas in under 2 min, flag the Special One, launch, watch all six, answer MCQs inside 90 s, send a cue or geocode while a tile is still running, freeze, validate, download |
| Live on-stage panorama | Sun, after | One file, one label, Go; a view an audience can read from the back of a room; 3.5 min hard deadline |
| Evaluation | Any time | Build the ground-truth set, confirm labels by eye, run a configuration, see score and distance, compare two configurations |
| Post-mortem | After any run | Replay one panorama step by step: what the agent looked at, called, believed and why it stopped |
| Recovery | After a crash | See that a run was interrupted, rebuild its exports from the logs, download them |

## 3. Rule compliance in the UI (hard constraints)

These override every other section.

| Constraint | Source | UI requirement |
|---|---|---|
| Three inputs to the agent, no more | SPEC 4, 8 | MCQ buttons, cue box and last-resort geocode are the only controls whose content reaches the model. No notes field, chat box, "hint" or "retry with…" control may be added on any screen. |
| MCQ options come from the agent | R7 | Buttons render only from a pending `ask_multiple_choice`. No text field on that path. An answer needs a deliberate click (or key then Enter); a bare keypress never answers. |
| Cue content | R6 | 1000-character limit and lint enforced by the server; the UI shows both but never decides. The rule text and "the lint is a backstop" stay visible while the box is open. |
| Geocode only for an agent-named place | R8 | The control is disabled until `named_places` is non-empty; the place is chosen from that list, never typed. |
| Penalised actions are confirmed | SPEC 8 | A confirm dialog shows the multiplier before and after. The request carries an idempotency key so a double click or a retry after a timeout charges once. |
| Task input comes from the organisers' files | SPEC 4 | Label, timestamp and the Special One flag are parsed from files. Where the UI lets the operator set one before launch (section 5.3), it is a fixed choice (Urban / non-Urban, a date-time picker, a radio button), never free text, and its provenance is written to `run_start`. Nothing about a task can change after launch. |
| Ground truth never meets a human channel | SPEC 11 | Truth, distance and score are shown only for runs with human channels off. A run with human channels on never loads the evaluation manifest. |
| Everything is logged | Brief p.1 | Every control that changes run state (finalize, MCQ toggle, stop, retry) emits a log event. Read-only navigation does not. |
| Checking a cue leaves no trace | R6 | Lint feedback needs a side-effect-free endpoint. Today a failed dry run writes a `human_cue_rejected` event, so the UI must not lint per keystroke until that exists (section 8.2). |

## 4. Structure

A single-page application with a persistent shell and these routes:

| Route | Screen | Section |
|---|---|---|
| `/` | Runs: every run on disk, active ones first | 5.2 |
| `/new` | New run: inputs, preflight, settings, launch | 5.3 |
| `/runs/<run_id>` | Run dashboard: all panoramas of one run | 5.4 |
| `/runs/<run_id>/<panorama_id>` | Panorama focus: operate and replay one panorama | 5.5, 5.6 |
| `/runs/<run_id>/stage` | Stage view for an audience | 5.7 |
| `/runs/<run_id>/submit` | Submission: validate, freeze, download | 5.8 |
| `/eval` | Evaluation: set, labels, results, compare | 5.9 |
| `/settings` | Keys, defaults, organiser flags, health, cache | 5.10 |

Every state worth returning to has a URL (selected panorama, event, filter, compared runs), so a link can be pasted to a teammate and a reload lands in the same place.

## 5. Screens

### 5.1 Shell

Present on every screen except the stage view.

- **Navigation:** Runs, New run, Evaluation, Settings.
- **Active-run strip:** one chip per active run with its clock, `done/total`, spend and lowest multiplier; clicking opens its dashboard.
- **Attention inbox:** a count and a drop-down of items that need a human, most urgent first, across all active runs. Each item links to the control that resolves it.

| Item | Raised when | Cleared when |
|---|---|---|
| MCQ waiting (with seconds left) | `status = awaiting_mcq` | answered or timed out |
| Human window closing | a running tile has under 120 s to its hard deadline and human channels are on | tile final |
| Fallback answer | a final list has `origin = harness_fallback` | acknowledged |
| API failing | `api_error`, or 3 `api_retry` events inside 60 s | next successful turn |
| Invalid export | a `problems` value in the summary | export valid |
| No hypothesis yet | a tile has run 3 min with no `candidates_update` | first update |
| Spend near cap | a tile is above 80% of `max_spend_usd` | tile final |

- **Connection state:** a dot for the event stream; when it drops, a banner says so and controls that charge a penalty are disabled until it is back.
- **Health chips:** OpenAI key, Google key, Mapillary token, internet. Red when missing or failing; each links to section 5.10.
- A pending MCQ also changes the tab title (`(1) MCQ 0:47 — astrolabio`), plays a short sound and, if permitted, raises a browser notification. Sound and notifications are per-browser settings, off in the stage view.

### 5.2 Runs

The landing page. A table of every directory under `RUNS_DIR`, newest first, active runs pinned on top.

| Column | Source |
|---|---|
| Run id, kind (training, scoring, live, eval), mode (autonomous / assisted) | run metadata |
| State: queued, running, finished, interrupted, invalid | manager state, else derived from the logs |
| Panoramas `done/total`, Special One present | sessions or logs |
| Lowest multiplier, penalties used (cues / MCQs / geocodes) | ledger |
| Spend, wall time | `run_end` totals |
| Score % of max, median rank-1 distance | `results.json`, eval runs only |
| Started at | first event |

Row actions: Open, Submission, Rebuild exports (the `export` command), Download zip, Duplicate settings into a new run, Delete. Delete asks for the run id to be typed and is refused for an active run and for a run of kind `scoring`.

A run found on disk with event logs but no `run_end` for every panorama, and not owned by the running server, is **interrupted**: the row offers "Rebuild exports" and explains that panoramas without a final submission will be exported from their last provisional list (`recovered_from_provisional`).

Empty state: two buttons, "New run" and "Try it on an evaluation panorama".

### 5.3 New run

Four steps on one page; later steps unlock when the earlier one is valid. Target: a scoring run launched in under 2 minutes, a live panorama in three interactions (drop, label, Go).

**Step 1: Preset**

| Preset | Human channels | Budget | Concurrency | Extra |
|---|---|---|---|---|
| Autonomous batch | off | standard / special | 6 | training and trial sets |
| Scoring run | on | standard / special | 6 | 60-minute clock, phase guide, requires one Special One |
| Live on stage | off | live (210 s hard) | 1 | opens the stage view on launch |
| Evaluation | off, locked | standard | from settings | inputs come from the eval set; leak guards on |
| Custom | any | any | any | every field below editable |

**Step 2: Panoramas**

- Drag and drop or pick files: `.jpg`, `.jpeg`, `.png`, plus any manifest (CSV, TSV, TXT, JSON) and sidecars (`<name>.txt`, `<name>.json`). A dropped folder keeps its `Urban/` and `non-Urban/` sub-directories. A `.zip` is unpacked.
- Or enter a path on the server (a USB stick, a downloads folder) with a directory browser limited to the allowed roots in settings.
- Or choose a stored set: every upload is kept as a named set and can be reused.
- Upload shows per-file progress; files are stored byte for byte (the log records each sha256). Files starting with a dot are ignored and listed as ignored.

**Step 3: Preflight table**

The replacement for the table the CLI prints. One row per panorama:

| Column | Behaviour |
|---|---|
| Thumbnail | click to open the panorama full screen, so the operator can see it is the right image |
| Panorama id, file name, size | warns when the image is not 2:1 or far from 6080 x 3040 |
| Label | parsed value and its source (folder, file name, sidecar, manifest). If none was found the cell is a required Urban / non-Urban choice for that row. An override of a parsed label is possible but asks for confirmation. |
| Timestamp | parsed value and source; "none" warns that `sun_position` will be unavailable. A date-time picker can supply one. |
| Special One | radio button across the rows. In the scoring preset launch is blocked until exactly one is chosen; several flagged in the files is a blocking warning. |
| Budget | effort, soft and hard deadline, turns, spend cap that this row will get |

Above the table: every warning `load_tasks` produces, and a one-line summary ("6 panoramas: 4 Urban, 2 non-Urban, Special One = `pano_3`"). There is no "apply label to all unlabelled" shortcut unless the operator ticks an explicit box, because a wrong label silently changes the scoring function, the allocator and the fallback point.

**Step 4: Settings and launch**

Shown as a summary line with an "Advanced" disclosure; presets fill everything.

| Group | Fields |
|---|---|
| Run | run id (default UTC timestamp; a reused id is explained: logs are appended and penalties carry over), kind, team name |
| Autonomy | human channels on/off, questions allowed at start, max MCQs |
| Model | model, effort (standard, Special One), `max_output_tokens`, image detail |
| Budgets | soft deadline, hard deadline, max turns, max spend, for standard / special / live |
| Tools | web on/off (Q1), and a per-tool switch for ablation; `update_candidates` and `submit_locations` cannot be switched off |
| Answer | hedge, allow duplicates (Q3), penalty scope (Q2) |
| Orchestration | concurrency, global watchdog |
| Export | embed images |

Next to the Launch button:

- **Readiness checklist:** OpenAI key present and answering, optional keys, internet reachable, disk space, no other active run (a warning, not a block).
- **Cost ceiling:** the sum of the spend caps, and the estimate from past runs of the same preset when there are any.
- **What will be sent:** model, effort and tool list, with a link to the read-only system prompt.

With no OpenAI key the button reads "Launch anyway (fallback answers only)" and needs a second click. Launch freezes the settings into the run and navigates to the dashboard or the stage view.

### 5.4 Run dashboard

The successor of the current operator page. Everything on it is live.

**Run header**

- Run id, kind, mode badge (AUTONOMOUS / ASSISTED), model and effort.
- Run clock. In the scoring preset it counts against 60 minutes and shows the phase guide of SPEC 10 as a strip (launch 0–2, autonomous 2–12, Special One 12–26, others 26–52, freeze 52–55, submit 55–60) with the current phase highlighted. The start of the clock can be set to the hand-over time (Q10).
- Watchdog countdown ("everything is finalised in 38:12").
- Totals: `done/total`, spend against the sum of caps, expected-score proxy (below), penalties used.
- Run controls: **Finalize all**, **Stop run** (finalise with best-so-far and export, as the CLI does on Ctrl-C), **Add panoramas** (opens step 2 and 3 of section 5.3 against this run), **Submission**.

**Panorama grid**

Sorted Special One first, then Urban, then non-Urban; a second sort "needs attention first" is one click away. Three densities:

| Density | Shows | Use |
|---|---|---|
| Board | one row per panorama: thumbnail, label, status, time bar, top hypothesis and probability, multiplier, attention flags | 6 or more panoramas on one screen |
| Tiles (default) | the tile of section 5.5 | the scoring run |
| Focus | one panorama full width, the others as a side rail | reviewing the Special One |

**What each tile must make obvious**

| Question | Element |
|---|---|
| Is it working? | status badge (queued, running, awaiting MCQ, done), turn `n/max`, last event age; "stalled" after 60 s of silence |
| How long do I have? | time bar with soft and hard marks, and when human channels are on a separate line **"cue / question window closes in 04:12"**. After final: "closed; only the x0.5 geocode remains". |
| Where does it think it is? | map with hypotheses (circle area = probability, ring = `radius_m`), the provisional answer in amber, the final answer in green |
| How sure is it? | top probability, number of distinct clusters, and the distance between the top two; flagged "multi-modal" when the MCQ gate of SPEC 7.2 passes |
| What did it cost me? | multiplier with the ledger written out (`x0.76 = 0.8 cue x 0.95 MCQ`) |
| How did it end? | origin (`agent`, `harness_fallback`, `human_geocode`) and stop reason in words ("hard deadline: best-so-far list used") |

**Expected-score proxy.** For each tile, `multiplier x 16,050 x expected theta of the chosen point under the agent's own hypotheses` (x3 for the Special One), summed in the header. It is labelled as the agent's own belief, not a score, and exists to rank where review time is best spent: the Special One and low-confidence Urban tiles float up.

### 5.5 Panorama tile and operator controls

**Layout**

1. Head: id, label, Special One banner (`SPECIAL ONE · SCORE x3`), status, multiplier.
2. Time bar and the human-window line.
3. Panorama viewer.
4. MCQ panel (only while a question is pending).
5. Two columns: map and hypothesis table; answer list and reasoning stream.
6. Control bar.

**Panorama viewer**

- A true 360° viewer (drag to look, wheel to zoom, double-click to reset), with a toggle to the flat equirectangular strip. A yaw ruler matches the one the agent sees, so "yaw 135" in the reasoning can be found.
- Overlay "where the agent looked": the footprint of every `view_crop` as an outline, numbered in order; hovering a crop in the stream highlights its footprint and vice versa.
- Full-resolution loading on zoom (tiles or progressive widths); the first paint uses the 1024 px preview.

**Hypotheses and map**

- Table: label, probability, radius, evidence (expandable), coordinates with a copy button. Hovering a row highlights its marker.
- Map layers: street map and satellite; a scale bar; "fit to hypotheses"; the allocator's clusters and the point it chose.
- Copy coordinates is the hand-off to a second device for the plausibility check. Whether the page may also link out to an external map on the same machine is an open decision (section 10); the default is copy only.

**Answer list**

- Ten rows: rank, lat, lng, multiplier, origin. Collapsed to "10 x the same point" when they are identical. Titled "Provisional" until final.
- The allocator's plan in words ("hedge off: best point repeated").

**Reasoning stream**

- One entry per event: time, type, a readable summary. Reasoning summaries and agent text are clamped and expand on click; tool calls show name and arguments; results show duration and a snippet, errors in red; images as thumbnails that open in a lightbox with their yaw, pitch and FOV.
- Filters: reasoning, tools, images, human, harness, errors. Search within the stream.
- Follows the tail unless the operator scrolls up; a "jump to latest" pill shows how many events arrived since.
- Any entry opens the full event JSON in a side panel.

**Control 1: MCQ (x0.95, charged when asked)**

- A panel that cannot be missed: question, 2–4 option buttons, "why it matters", a countdown ring from 90 s, and the note "already charged: x0.95 applied when the agent asked".
- Options are checkable claims about candidate places; each option that names a hypothesis shows that hypothesis's coordinates with a copy button and highlights it on the map.
- After the click the buttons lock and the chosen one stays marked. On timeout the panel says "no answer sent; the agent proceeds".
- The "questions allowed" toggle sits in the control bar with the count left (`2 of 3`), and says what it does: the agent's next question is refused at no cost.

**Control 2: Cue (x0.8)**

- Behind a "Cue…" button; closed by default.
- Text area with a live character count against 1000, the rule text, and the multiplier before and after.
- "Check" runs the server lint without charging; problems are listed against the offending words. "Send cue (x0.8)" opens the confirm dialog, which repeats the text, the multiplier change and the R6 reminder.
- After sending: a state line "queued; delivered at the agent's next turn", then "delivered at 07:42". A cue that could not be delivered is shown as charged and undelivered.
- Disabled, with the reason, when the tile is final or inside the last 30 s. A draft survives a reload (kept in the browser only).

**Control 3: Last-resort geocode (x0.5)**

- Behind a button; disabled until the agent has named a place.
- Choose the place from the agent's list, click the map (the pin is draggable, coordinates shown to 6 decimals), confirm. The dialog states all three consequences: x0.5, the human point becomes all ten entries, the panorama ends at once.

**Harness controls** (no information reaches the agent)

- **Finalize now:** fix the current best list. Confirmed.
- **Retry:** only for a tile that ended without an agent answer (`api_error`, `panorama_load_failed`, `not_started`). Starts a new conversation in the same log, so penalties already recorded carry over.
- **Export JSON:** download this panorama's export.

In an autonomous run none of the three penalised controls is rendered and the bar says "Autonomous: human channels disabled".

### 5.6 Panorama focus and replay

The same screen serves a running panorama (live) and a finished one (replay).

- **Timeline scrubber** over the whole run: turns as ticks, marks for candidates updates, human interactions, the soft-deadline notice and the final submission. Dragging it rewinds the map, the hypothesis table, the answer list and the multiplier to that moment.
- **Hypothesis evolution:** probability of each hypothesis over time as a small chart; the path of the top point on the map.
- **Turn inspector:** per turn the request size, images sent, tokens (input, cached, output, reasoning), latency, cost, stop reason; a bar chart of cost and latency per turn; `api_retry` events inline.
- **Tool inspector:** full input and output of any call, the external URL called, duration, cache hit, and the images returned, with street-level and satellite results shown beside the matching panorama crop for comparison.
- **Image gallery:** every view sent to the model in order, with yaw, pitch, FOV, pixel size and estimated token cost; budget used (images of 80, megabytes of 24).
- **Penalty ledger:** each charge with its time, kind, and multiplier before and after.
- **Run facts:** model, effort, budget, flags, git SHA, the system prompt and tool definitions exactly as sent (read-only).
- **Ground truth** (eval runs only): truth marker, a line from each distinct answer to it, rank-1 distance, theta, the score and its share of the maximum; in replay, the distance of the top hypothesis over time.
- Downloads: export JSON, `events.jsonl`, the images as a zip.

### 5.7 Stage view

Full screen, for a projector; no shell, no penalised controls, large type, high contrast, light and dark.

- Left: the 360° viewer, auto-panning slowly until touched, flashing each crop footprint as the agent zooms.
- Right: the map, flying to each new top hypothesis, with a satellite toggle.
- Bottom: a ticker of the agent's current activity in plain words ("Reading a shop sign", "Searching OpenStreetMap for a church beside a roundabout", "Comparing street-level imagery"), derived from tool calls, with the latest reasoning summary beneath.
- A countdown to the hard deadline, the turn count and the current top guess with its probability.
- At the end: the final point, the map zooming to street level, the elapsed time and the list ("10 x 38.716900, -9.139900").
- **Reveal truth** (after final only): the presenter enters the coordinates the organisers announce; the view draws the line, the distance and the score. It is stored as a note on the run, is not an event in the interaction log, and is unavailable while the panorama is running.
- A presenter key (`P`) toggles a small overlay with status, spend and errors. `Esc` returns to the dashboard.

### 5.8 Submission

The freeze of SPEC 10 (minutes 52–60) as a checklist that turns green.

| Check | Passes when |
|---|---|
| Every panorama is final | no tile is queued, running or awaiting an MCQ; otherwise "Finalize all" is offered here |
| Ten entries each | each export has exactly 10 locations, 6 decimals, in range |
| Exports valid | `validate_export` returns no problem for every panorama; problems are listed per panorama |
| Ledger consistent | penalties in the final state match the events |
| Files match the page | exports were written after the last state change; otherwise "Rebuild" |
| No fallback answers | none has `origin = harness_fallback`; a failing check here is a warning the operator may accept |

Below it:

- `answers.csv` as a table (panorama, rank, lat, lng) and on one map, with copy-to-clipboard.
- `summary.csv` as a table with the `problems` column highlighted.
- Options: embed images in the exports (Q4), then **Rebuild exports**.
- **Download submission (.zip):** the per-panorama JSON files, `answers.csv`, `summary.csv`. Also each file individually, and the paths on disk.
- A "Submitted at" stamp the operator sets, shown on the run from then on.

For an interrupted run this screen is where recovery happens: rebuild from the logs, then the same checklist.

### 5.9 Evaluation

**Set** (replaces `eval.build_set build` and `label`)

- State of `eval/data`: number of panoramas, confirmed / unconfirmed / `TODO` labels, split by label, country and kind; a map of where they are.
- **Build:** count (1–50), seed, images per area, "replace the existing set" (asks for confirmation and says hand labels are lost). Runs as a background job with progress per area and a log; needs `MAPILLARY_TOKEN`, and says so if it is missing.
- **Label:** one panorama at a time in the 360° viewer with the pre-filled guess; keys `U`, `N`, `S` (skip), arrows to move; progress "12 of 40 confirmed". A table view allows bulk review. Runs refuse to start while any label is `TODO`.
- Sets built before the sequence guard (ids of the form `mly_<image id>`) are flagged as leaking, with a rebuild prompt.

**Run** (replaces `eval run`)

The Evaluation preset of section 5.3 with: effort override, hedge, web on/off, tools off, limit to the first N, concurrency, run id. Always autonomous. The page states that the run costs money and shows the ceiling. Progress is the ordinary run dashboard; results are computed when it ends.

**Results**

- Summary table for all, Urban and non-Urban: n, mean score, share of maximum, median rank-1 distance, share within 100 m / 1 km / 10 km, mean and total cost, mean time.
- Per-panorama table, sortable: label, score, share of maximum, rank-1 and best distance, multiplier, origin, allocator plan, hypotheses, cost, time, turns. A row opens the replay.
- Map of truth against answer for every panorama, lines coloured by distance band.
- Charts: distribution of rank-1 distance on a log axis by label; score against cost.
- The configuration that produced the results.

**Rescore** (replaces `eval rescore`): on any eval run, re-allocate offline with hedge on, hedge off or distinct points; each variant is saved (`results.<tag>.json`) and listed beside the original. No API access; a few seconds.

**Compare** (replaces `eval compare`): pick two result files (runs or rescore variants). Shows metric deltas per group, the paired win / loss / tie count, the mean score delta, and a per-panorama table of both scores with the difference, sorted by largest change, each row linking to both replays.

### 5.10 Settings and health

**Keys**

| Key | Shown | Actions |
|---|---|---|
| `OPENAI_API_KEY` | set / not set, last four characters | replace, test (one minimal request; reports model access and whether reasoning summaries are granted) |
| `GOOGLE_MAPS_API_KEY` | set / not set | replace, test |
| `MAPILLARY_TOKEN` | set / not set | replace, test |

Values are write-only: the page never receives a stored key. Saving writes `.env`.

**Defaults:** every field of step 4 in section 5.3, saved as the defaults for new runs, plus team name, runs directory, cache directory, allowed upload roots.

**Organiser answers:** the Q1–Q12 table of SPEC 13 as a form: the question, our default, the control that implements it, and a free-text note of what the organisers said and when. Changing one changes the default for new runs only.

**Health**

- Reachability and latency of OpenAI, Nominatim, Photon, both Overpass servers, Esri imagery, Google, Mapillary.
- Over the last 15 minutes: API retries, timeouts, median turn latency, upload size per turn.
- Disk: size of `runs/`, uploads and the HTTP cache; **Clear HTTP cache** (confirmed; says that cached lookups will be fetched again).
- Version: git SHA, model, SDK version.

Settings never affect a run that has started: a run's configuration is frozen at launch, because the system prompt and tool list must stay byte-stable.

## 6. CLI parity

| CLI | In the UI |
|---|---|
| `run <pano> --label … [--special] [--live]` | New run, one file, any preset |
| `batch <dir> --concurrency N --no-human` | New run, preset "Autonomous batch" |
| `serve <dir> --special <file>` | New run, preset "Scoring run" |
| `run … --live` | New run, preset "Live on stage" |
| `--hedge`, `--no-web`, `--run-id`, `--label`, `--no-human` | Step 3 and 4 of New run |
| `export <run_dir> [--embed-images]` | Runs: Rebuild exports; Submission: Rebuild |
| Ctrl-C (finalise and export) | Run dashboard: Stop run |
| `eval run [--effort …] [--tools-off …] [--limit N]` | Evaluation: Run |
| `eval rescore [--hedge] [--distinct]` | Evaluation: Rescore |
| `eval compare a b` | Evaluation: Compare |
| `python -m eval.build_set build` | Evaluation: Set, Build |
| `python -m eval.build_set label [--todo]` | Evaluation: Set, Label |
| Editing `.env` | Settings |
| Reading `runs/<id>/*.json`, `summary.csv`, `answers.csv` | Submission, replay, downloads |

## 7. Behaviour across screens

**Live updates.** One event stream per browser tab carries every active run. On connect and on reconnect the client takes a full snapshot, then applies events by sequence number, so a gap is detected and repaired rather than ignored. Clocks tick locally from server-supplied elapsed times.

**Several tabs and operators.** Any number of tabs may be open; all show the same state within a second. A penalised action confirmed in one tab disables the same pending dialog in the others ("already sent by another tab"). Access from a second laptop is off by default; when enabled in settings the server binds to the LAN and requires a shared token.

**Errors.** Every failed request produces a message that says what happened and what to do next, at the control that caused it. A rejected cue keeps its text. A server restart is detected and the page reloads its state by itself.

**Keyboard.**

| Key | Action |
|---|---|
| `1`–`9` | focus that panorama |
| `g` then `r` / `n` / `e` / `s` | Runs / New run / Evaluation / Settings |
| `m` | jump to the oldest pending MCQ |
| `a`–`d` then `Enter` | choose and send an MCQ option in the focused panel |
| `c` | open the cue box of the focused panorama |
| `f` | toggle focus density |
| `/` | search the reasoning stream |
| `?` | list of shortcuts |

No single key ever triggers a penalised or irreversible action.

**Visual design.** Dark by default with a light theme; the stage view follows its own setting. Status is never colour alone (badge text and icon as well). Penalised controls share one distinct colour used for nothing else. Numbers are tabular. The layout works from 1280 px wide to a 4K projector.

**Performance.** A dashboard with 10 running panoramas stays responsive: streams are virtualised beyond a few hundred entries, images load lazily, maps are created only for visible tiles.

**Offline assets.** Leaflet, the 360° viewer, fonts and icons are served by the app. Map tiles are the only thing fetched from the internet; without them the maps show a coordinate grid and everything else works.

## 8. Backend requirements

The current server owns one run, fixed at start-up. The console needs a workspace of runs.

### 8.1 Model

| Concept | Requirement |
|---|---|
| Workspace | Holds all `RunManager`s of the process plus a read-only index of `RUNS_DIR` built from the logs. Runs outlive browser tabs. Stopping the server finalises and exports every active run, as today. |
| Run metadata | `runs/<run_id>/run.json`: kind, preset, frozen settings, creation time, task provenance, submitted-at stamp, stage truth note. Not part of the interaction log. |
| Per-run settings | A `Settings` object per run, built from the defaults and the launch form. Per-tool switches must be per run; today `disable_tools` edits process-wide tables. |
| Late additions | Panoramas added to a started run must run; today `start()` only picks up what was pending when it was called. |
| Panorama sets | Uploads stored under a data directory (gitignored), one directory per set, original bytes untouched. `load_tasks` gains per-file overrides for label, timestamp and Special One, and reports where each value came from. |
| Jobs | Long operations (set build, export rebuild, eval scoring, unzip) run as background jobs with progress, a log and a final state, observable over the event stream. |
| Idempotency | Penalised endpoints accept a client-generated key and return the first result for a repeat. |
| Pure lint | A lint endpoint that logs nothing. |

### 8.2 API

Existing endpoints move under `/api/runs/<run_id>/…` and keep their behaviour. New surface:

| Method and path | Purpose |
|---|---|
| `GET /api/runs` | index of runs with the columns of section 5.2 |
| `POST /api/runs` | create and launch: set, overrides, settings |
| `GET /api/runs/<id>` | full state of one run |
| `POST /api/runs/<id>/stop` | finalise all and export |
| `POST /api/runs/<id>/panoramas` | add panoramas to a run |
| `POST /api/runs/<id>/pano/<pid>/retry` | new conversation for a panorama that ended without an agent answer |
| `POST /api/runs/<id>/export` | rebuild exports (`embed_images` option) |
| `GET /api/runs/<id>/validation` | the checklist of section 5.8 |
| `GET /api/runs/<id>/download` | submission zip; also per-file downloads |
| `DELETE /api/runs/<id>` | delete a run directory |
| `GET /api/runs/<id>/pano/<pid>/events?after=&full=` | digests, or full event JSON |
| `GET /api/runs/<id>/pano/<pid>/replay?at=<seq>` | state reconstructed at an event |
| `POST /api/runs/<id>/pano/<pid>/cue/check` | lint with no side effect |
| `POST /api/sets`, `GET /api/sets`, `GET /api/sets/<id>` | upload, list, preflight (parsed tasks and warnings) |
| `GET /api/fs?path=` | directory browser inside the allowed roots |
| `GET /api/eval/set`, `POST /api/eval/set/build`, `PATCH /api/eval/set/<pid>` | eval set state, build job, set one label |
| `POST /api/eval/runs` | launch an eval run with leak guards |
| `GET /api/runs/<id>/results`, `POST /api/runs/<id>/rescore` | results and variants |
| `GET /api/eval/compare?a=&b=` | comparison |
| `GET /api/settings`, `PUT /api/settings`, `PUT /api/settings/keys/<name>`, `POST /api/settings/keys/<name>/test` | settings and keys |
| `GET /api/health`, `POST /api/cache/clear` | health and cache |
| `GET /api/jobs/<id>` | job state |
| `GET /api/stream` | one event stream for every active run and job |

### 8.3 Security

- Binds to `127.0.0.1` unless LAN access is switched on, and then requires a token on every request.
- State-changing requests are rejected unless their `Origin` is the app's own, so another site open in the same browser cannot charge a penalty or delete a run.
- Keys are never returned by any endpoint. The directory browser and the upload path are confined to the allowed roots; archive entries are checked against path traversal.
- Ground-truth coordinates are served only by the eval endpoints and only for runs with human channels off.

### 8.4 Front end

No build step: ES modules served as static files, with the few libraries (map, 360° viewer, charts) vendored in the repository. The current `server/static/index.html` stays reachable at `/legacy` until the new dashboard has been used in a full run.

## 9. Build plan

The existing operator page works and is what the scoring run depends on. Nothing in M1 may be merged in a way that puts it at risk.

| Milestone | Scope |
|---|---|
| **M1: no CLI for a run** | Long-lived server with a workspace; Runs list; New run with upload, preflight table and presets; run dashboard under `/runs/<id>` with the existing tile and its three controls; Stop run; Submission with checklist and zip; idempotency keys; vendored assets; legacy page kept. |
| **M2: operate well** | Attention inbox, tab title, sound; human-window countdown; Board and Focus densities; 360° viewer with crop footprints; stream filters and event JSON; pure lint and the "Check" button; Retry; Settings with keys and health. |
| **M3: stage and replay** | Stage view; timeline scrubber and replay; turn, tool and image inspectors; expected-score proxy. |
| **M4: evaluation** | Eval set build and labelling; eval runs; results, rescore, compare; ground truth in replay. |
| **Later** | LAN access with token; organiser-answers form; add panoramas to a running run; reveal truth on stage. |

## 10. Decisions to confirm

Each has the default the spec is written to.

| # | Question | Default |
|---|---|---|
| U1 | May the operator set a label, timestamp or Special One flag in the preflight table when the files do not carry it? | Yes, as fixed choices with provenance logged; this replaces `--label` and `--special` |
| U2 | May the page link to an external map or street-level site for a candidate, given the brief's "other equipment"? | No; copy coordinates only |
| U3 | Can a scoring run be deleted or re-run from the UI? | No delete; re-running creates a new run and the original stays on disk |
| U4 | More than one active run at a time? | Allowed with a warning; they share rate limits and the OSM semaphore |
| U5 | Is "Reveal truth" on stage acceptable to the organisers? | Yes; it happens after final and reaches nothing |
| U6 | Should keys be editable from the browser at all? | Yes while the server is local-only; hidden when LAN access is on |
| U7 | Does the 60-minute clock start at hand-over or at launch (Q10)? | At launch, adjustable in the run header |

## 11. Acceptance

The UI is done when each of these can be completed without touching a terminal after `serve` has started:

1. Drop six panoramas and a manifest, see labels and timestamps parsed correctly, pick the Special One, launch a scoring run, and reach the dashboard in under 2 minutes.
2. Answer an MCQ within its 90 s from any screen of the app, having been alerted by the tab title and the inbox.
3. Send a cue: the lint blocks a place name, a compliant cue is charged x0.8 exactly once despite a double click, and its delivery is shown.
4. Geocode a place the agent named; the tile ends, the list becomes the human point at x0.5, and the files on disk follow.
5. Reload the page and open a second tab during a run: both show the same state and no penalty is charged twice.
6. Kill the server with `kill -9` mid-run, restart it, find the run marked interrupted, rebuild its exports and download a valid submission zip.
7. Pass the submission checklist and download `answers.csv` with 10 rows per panorama.
8. Run one panorama in the Live preset and present it from the stage view inside 3.5 minutes.
9. Build an evaluation set, confirm its labels, run it, read the results, rescore it with hedge on, and compare the two.
10. Replay a finished panorama and find, for any turn, what the agent saw, called and concluded.
11. Run the whole flow with the network cable out except for the model API and map tiles: no missing script, font or icon.
