# Evaluation set and harness (SPEC 11)

The organisers never disclose true locations, so this builds our own ground truth from Mapillary
360° imagery and scores the agent against it with the exact competition formula.

All commands run from the repo root.

## 1. Build the set

Needs a free Mapillary client token in `MAPILLARY_TOKEN` (environment or `.env`).

```
python -m eval.build_set build --count 40 --seed 7
```

- Searches about 75 small boxes across Portugal, Spain and France (cities, towns, villages, rural
  roads, tracks, islands), keeps `is_pano` images, and samples round-robin across areas, one image
  per Mapillary sequence. The same seed and API results give the same set.
- Each image is resized to 6080 x 3040 and re-encoded from pixels, so no EXIF/GPS survives.
- Writes `eval/data/eval_<hash>.jpg` and `eval/data/manifest.json` (gitignored). The panorama id
  is shown to the agent, so it is an opaque hash; the Mapillary image id is kept only in the
  manifest (`source_image_id`), together with its `sequence`. An existing manifest
  is only replaced with `--force`, because that discards hand labels.

## 2. Label by hand

Labels are pre-filled from the kind of area searched (city/town: Urban, rural/track: non-Urban,
village: `TODO`) and marked unconfirmed. Look at each image and confirm:

```
python -m eval.build_set label                      # list entries and label state
python -m eval.build_set label eval_1a2b3c4d5e6f non-Urban   # set one (the Mapillary image id works too)
python -m eval.build_set label --todo               # prompt for every unconfirmed entry
```

`run_eval` refuses to run while any label is `TODO` and warns about unconfirmed guesses.

## 3. Run and score

```
python -m eval.run_eval run                                   # defaults: effort per budget, hedge off, web on
python -m eval.run_eval run --effort medium --concurrency 4
python -m eval.run_eval run --no-web
python -m eval.run_eval run --tools-off streetview_lookup,satellite_tile
python -m eval.run_eval run --limit 5 --run-id smoke          # first 5 panoramas only
```

This calls the OpenAI API (and the external tools) and costs money. It always runs in
`--no-human` mode. Each panorama's own Mapillary image id, everything within 25 m of it and the
whole Mapillary sequence (drive) it came from are excluded from `streetview_lookup`, so the agent
cannot be handed its source imagery or the neighbouring frames of the same drive. A set built
before the sequence guard existed has ids of the form `mly_<image id>`, which tell the agent the
source: rebuild it with `build --force` (hand labels are lost) before trusting Urban numbers.

Output: a table on stdout, plus `results.json` and `results.csv` next to the exports in
`runs/<run_id>/`. Metrics are reported for all panoramas and split by label:

| Column | Meaning |
|---|---|
| mean score, % max | Competition score per panorama, using the multiplier stamped on each entry; share of the 16,050 maximum |
| median d1 m | Median distance from the rank-1 entry to the truth |
| <=100m, <=1km, <=10km | Share of panoramas whose rank-1 entry is within that distance (no answer counts as a miss) |
| mean $, total $, mean s | Cost and wall time from each run's `run_end` totals |

## 4. Rescore and compare offline

```
python -m eval.run_eval rescore runs/<run_id>               # same answers  -> results.rescore.json
python -m eval.run_eval rescore runs/<run_id> --hedge       # re-allocate   -> results.hedge.json
python -m eval.run_eval rescore runs/<run_id> --no-hedge    #               -> results.nohedge.json
python -m eval.run_eval rescore runs/<run_id> --distinct    # ALLOW_DUPLICATES=false
python -m eval.run_eval compare runs/a/results.json runs/b/results.hedge.json
```

`rescore` needs no API access. With `--hedge`/`--no-hedge`/`--distinct` it rebuilds each list from
the hypotheses logged in the export, so allocator settings can be compared on one paid run.
Human-geocoded answers and answers with no logged hypotheses are scored as submitted.

`compare` prints metric deltas (b - a) per group and a paired per-panorama win/loss count.

## Notes

- `--tools-off` removes the tool from the definitions sent to the model and turns its handler into
  a free error. It edits process-wide tables, which is fine for this one-shot CLI.
- Mapillary imagery is CC BY-SA; the manifest keeps each image's `creator` for attribution. Do not
  commit the images.
- Mapillary coordinates come from consumer GPS and can be several metres off, which matters at the
  10 m snap for Urban scores; treat small Urban differences between runs as noise.
