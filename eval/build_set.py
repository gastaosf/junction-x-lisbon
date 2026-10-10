"""Build the evaluation set: Mapillary 360 panoramas with known coordinates in PT/ES/FR (SPEC 11).

    python -m eval.build_set build --count 40 --seed 7
    python -m eval.build_set label                     # list entries
    python -m eval.build_set label <panorama_id> Urban # set one label by hand
    python -m eval.build_set label --todo              # walk through unconfirmed labels
"""

from __future__ import annotations

import hashlib
import json
import os
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import cv2
import httpx
import numpy as np
import typer
from dotenv import load_dotenv

from geoagent.schema import Label

MAPILLARY_URL = "https://graph.mapillary.com/images"
FIELDS = "id,computed_geometry,geometry,captured_at,is_pano,thumb_original_url,thumb_2048_url,sequence,creator"
TARGET_SIZE = (6080, 3040)  # width, height of the organisers' panoramas
DEFAULT_DATA_DIR = Path(__file__).parent / "data"
MANIFEST_NAME = "manifest.json"
TODO_LABEL = "TODO"

Kind = Literal["city", "town", "village", "rural", "track"]

# Half-size of the search box in degrees. The Graph API rejects filtered bbox searches larger
# than 0.01 square degrees, so the widest box (0.09 x 0.09) stays under that.
_HALF_DEG: dict[str, float] = {"city": 0.010, "town": 0.010, "village": 0.008, "rural": 0.045, "track": 0.045}
# OSM-free label guess from the kind of place the box was drawn around; villages are ambiguous.
_LABEL_GUESS: dict[str, str] = {
    "city": Label.URBAN.value,
    "town": Label.URBAN.value,
    "village": TODO_LABEL,
    "rural": Label.NON_URBAN.value,
    "track": Label.NON_URBAN.value,
}


@dataclass(frozen=True)
class Area:
    name: str
    country: str
    lat: float
    lng: float
    kind: Kind

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        """min_lng, min_lat, max_lng, max_lat."""
        h = _HALF_DEG[self.kind]
        return (self.lng - h, self.lat - h, self.lng + h, self.lat + h)

    @property
    def label_guess(self) -> str:
        return _LABEL_GUESS[self.kind]


AREAS: tuple[Area, ...] = (
    # Portugal, mainland
    Area("Lisboa Baixa", "PT", 38.7139, -9.1394, "city"),
    Area("Porto Ribeira", "PT", 41.1456, -8.6110, "city"),
    Area("Coimbra", "PT", 40.2056, -8.4196, "city"),
    Area("Braga", "PT", 41.5503, -8.4201, "city"),
    Area("Faro", "PT", 37.0194, -7.9304, "city"),
    Area("Evora", "PT", 38.5714, -7.9135, "city"),
    Area("Aveiro", "PT", 40.6405, -8.6538, "city"),
    Area("Setubal", "PT", 38.5244, -8.8882, "city"),
    Area("Viseu", "PT", 40.6566, -7.9125, "city"),
    Area("Tomar", "PT", 39.6036, -8.4151, "town"),
    Area("Lagos", "PT", 37.1028, -8.6730, "town"),
    Area("Chaves", "PT", 41.7400, -7.4710, "town"),
    Area("Elvas", "PT", 38.8810, -7.1630, "town"),
    Area("Peniche", "PT", 39.3558, -9.3811, "town"),
    Area("Mertola", "PT", 37.6420, -7.6610, "town"),
    Area("Monsanto", "PT", 40.0389, -7.1144, "village"),
    Area("Obidos", "PT", 39.3606, -9.1571, "village"),
    Area("Marvao", "PT", 39.3940, -7.3766, "village"),
    Area("Piodao", "PT", 40.2296, -7.8250, "village"),
    Area("Baixo Alentejo plain", "PT", 37.7000, -8.0800, "rural"),
    Area("Douro valley", "PT", 41.1900, -7.5450, "rural"),
    Area("Serra da Estrela", "PT", 40.3200, -7.6100, "rural"),
    Area("Peneda-Geres", "PT", 41.7300, -8.1600, "rural"),
    Area("Ribatejo leziria", "PT", 39.0500, -8.7500, "rural"),
    Area("Planalto Mirandes", "PT", 41.5000, -6.2700, "rural"),
    Area("Costa Vicentina tracks", "PT", 37.5200, -8.7800, "track"),
    Area("Barrocal algarvio tracks", "PT", 37.2200, -8.0500, "track"),
    Area("Montado tracks", "PT", 38.6500, -8.2000, "track"),
    # Portugal, islands
    Area("Ponta Delgada", "PT", 37.7412, -25.6756, "city"),
    Area("Sao Miguel interior", "PT", 37.8600, -25.7900, "rural"),
    Area("Funchal", "PT", 32.6496, -16.9086, "city"),
    Area("Madeira plateau", "PT", 32.7500, -17.0800, "rural"),
    Area("Angra do Heroismo", "PT", 38.6550, -27.2200, "town"),
    Area("Pico island", "PT", 38.4700, -28.3000, "rural"),
    # Spain, mainland
    Area("Madrid Centro", "ES", 40.4168, -3.7038, "city"),
    Area("Barcelona Eixample", "ES", 41.3900, 2.1650, "city"),
    Area("Sevilla", "ES", 37.3891, -5.9845, "city"),
    Area("Valencia", "ES", 39.4699, -0.3763, "city"),
    Area("Bilbao", "ES", 43.2630, -2.9350, "city"),
    Area("Santiago de Compostela", "ES", 42.8805, -8.5457, "city"),
    Area("Salamanca", "ES", 40.9650, -5.6640, "city"),
    Area("Ronda", "ES", 36.7420, -5.1660, "town"),
    Area("Caceres", "ES", 39.4750, -6.3720, "town"),
    Area("Jaca", "ES", 42.5700, -0.5500, "town"),
    Area("Albarracin", "ES", 40.4080, -1.4440, "village"),
    Area("La Mancha plain", "ES", 39.4000, -3.1200, "rural"),
    Area("Extremadura dehesa", "ES", 39.8500, -6.0300, "rural"),
    Area("Tabernas desert", "ES", 37.0500, -2.3900, "rural"),
    Area("Tierra de Campos", "ES", 42.2700, -4.4000, "rural"),
    Area("Pirineo aragones", "ES", 42.6300, -0.1100, "rural"),
    Area("Galicia interior tracks", "ES", 42.6600, -8.1100, "track"),
    # Spain, islands
    Area("Palma", "ES", 39.5696, 2.6502, "city"),
    Area("Serra de Tramuntana", "ES", 39.7670, 2.7150, "rural"),
    Area("Las Palmas de Gran Canaria", "ES", 28.1235, -15.4363, "city"),
    Area("Teide caldera", "ES", 28.2600, -16.6200, "rural"),
    Area("Lanzarote lava fields", "ES", 28.9500, -13.7700, "rural"),
    # France, mainland
    Area("Paris centre", "FR", 48.8566, 2.3522, "city"),
    Area("Lyon Presqu'ile", "FR", 45.7640, 4.8357, "city"),
    Area("Marseille Vieux-Port", "FR", 43.2965, 5.3698, "city"),
    Area("Toulouse", "FR", 43.6045, 1.4440, "city"),
    Area("Bordeaux", "FR", 44.8378, -0.5792, "city"),
    Area("Nantes", "FR", 47.2184, -1.5536, "city"),
    Area("Annecy", "FR", 45.8992, 6.1294, "town"),
    Area("Bayonne", "FR", 43.4929, -1.4748, "town"),
    Area("Sarlat", "FR", 44.8900, 1.2170, "town"),
    Area("Gordes", "FR", 43.9110, 5.2000, "village"),
    Area("Beauce plain", "FR", 48.3000, 1.6500, "rural"),
    Area("Cantal", "FR", 45.1000, 2.7000, "rural"),
    Area("Landes forest tracks", "FR", 44.2000, -0.9000, "track"),
    Area("Vercors", "FR", 44.9500, 5.4500, "rural"),
    Area("Camargue", "FR", 43.5000, 4.5500, "rural"),
    Area("Bretagne bocage", "FR", 48.2000, -3.1000, "rural"),
    # France, Corsica
    Area("Ajaccio", "FR", 41.9192, 8.7386, "city"),
    Area("Corte", "FR", 42.3060, 9.1500, "town"),
    Area("Cap Corse", "FR", 42.9000, 9.4000, "rural"),
)


def timestamp_from_ms(captured_at_ms: int | float) -> str:
    """Mapillary's captured_at (epoch milliseconds) as the organisers' YYYYMMDDhhmmss, in UTC."""
    return datetime.fromtimestamp(captured_at_ms / 1000, tz=timezone.utc).strftime("%Y%m%d%H%M%S")


def normalise_image(raw: dict[str, Any], area: Area) -> dict[str, Any] | None:
    """One Graph API image as a sampling candidate, or None if it is not a usable panorama."""
    if not raw.get("is_pano"):
        return None
    geometry = raw.get("computed_geometry") or raw.get("geometry") or {}
    coords = geometry.get("coordinates")
    url = raw.get("thumb_original_url") or raw.get("thumb_2048_url")
    if not coords or len(coords) < 2 or not url or raw.get("captured_at") is None or not raw.get("id"):
        return None
    return {
        "id": str(raw["id"]),
        "lat": float(coords[1]),
        "lng": float(coords[0]),
        "timestamp": timestamp_from_ms(raw["captured_at"]),
        "url": url,
        "sequence": str(raw.get("sequence") or ""),
        "creator": (raw.get("creator") or {}).get("username", ""),
        "area": area.name,
        "country": area.country,
        "kind": area.kind,
        "label_guess": area.label_guess,
    }


def fetch_area(client: httpx.Client, token: str, area: Area, *, limit: int = 100) -> list[dict[str, Any]]:
    """Panoramas inside one area's box. Raises httpx.HTTPError on a failed request."""
    response = client.get(
        MAPILLARY_URL,
        params={
            "fields": FIELDS,
            "bbox": ",".join(f"{v:.6f}" for v in area.bbox),
            "is_pano": "true",
            "limit": str(limit),
        },
        headers={"Authorization": f"OAuth {token}"},
    )
    response.raise_for_status()
    candidates = (normalise_image(raw, area) for raw in response.json().get("data", []))
    return [c for c in candidates if c is not None]


def sampling_order(by_area: dict[str, list[dict[str, Any]]], rng: random.Random) -> list[dict[str, Any]]:
    """Every usable candidate in the order the builder should try them.

    Round-robin over shuffled areas so a prefix of any length is spread across areas, taking at
    most one image per Mapillary sequence (neighbouring frames are near-duplicates). API result
    order is not stable, so candidates are sorted by id before the seeded shuffle.
    """
    area_names = sorted(by_area)
    rng.shuffle(area_names)
    queues: dict[str, list[dict[str, Any]]] = {}
    for name in area_names:
        queue = sorted(by_area[name], key=lambda c: c["id"])
        rng.shuffle(queue)
        queues[name] = queue

    order: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_sequences: set[str] = set()
    while any(queues.values()):
        for name in area_names:
            queue = queues[name]
            while queue:
                candidate = queue.pop()
                if candidate["id"] in seen_ids or (candidate["sequence"] and candidate["sequence"] in seen_sequences):
                    continue
                seen_ids.add(candidate["id"])
                seen_sequences.add(candidate["sequence"])
                order.append(candidate)
                break
    return order


def prepare_image(raw: bytes) -> bytes | None:
    """Decode, resize to 6080 x 3040 and re-encode from pixels only, which drops EXIF/XMP/GPS.

    Returns None for anything that is not a decodable 2:1 equirectangular image.
    """
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    height, width = image.shape[:2]
    if height == 0 or abs(width / height - 2.0) > 0.02:
        return None
    resized = cv2.resize(image, TARGET_SIZE, interpolation=cv2.INTER_LANCZOS4)
    ok, encoded = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return encoded.tobytes() if ok else None


def opaque_id(source_image_id: str) -> str:
    """Panorama id shown to the agent (task text, file name). It must not reveal the source or its
    image key; the Mapillary id stays in the manifest only, as `source_image_id`."""
    return "eval_" + hashlib.sha256(f"geoagent-eval:{source_image_id}".encode()).hexdigest()[:12]


def manifest_entry(candidate: dict[str, Any]) -> dict[str, Any]:
    panorama_id = opaque_id(candidate["id"])
    return {
        "panorama_id": panorama_id,
        "filename": f"{panorama_id}.jpg",
        "lat": round(candidate["lat"], 7),
        "lng": round(candidate["lng"], 7),
        "label": candidate["label_guess"],
        "label_confirmed": False,
        "timestamp": candidate["timestamp"],
        "source_image_id": candidate["id"],
        "sequence": candidate["sequence"],
        "area": candidate["area"],
        "country": candidate["country"],
        "kind": candidate["kind"],
        "creator": candidate["creator"],  # Mapillary imagery is CC BY-SA: keep the attribution
    }


def load_manifest(path: Path) -> list[dict[str, Any]]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    entries = doc.get("panoramas", []) if isinstance(doc, dict) else doc
    if not isinstance(entries, list):
        raise ValueError(f"{path}: expected a list of panorama entries")
    return entries


def save_manifest(path: Path, entries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def set_label(entries: list[dict[str, Any]], panorama_id: str, raw_label: str) -> dict[str, Any]:
    """Set one hand label in place. Raises KeyError for an unknown id, ValueError for a bad label."""
    label = Label.parse(raw_label)
    for entry in entries:
        if panorama_id in (entry["panorama_id"], entry.get("source_image_id")):
            entry["label"] = label.value
            entry["label_confirmed"] = True
            return entry
    raise KeyError(panorama_id)


def mapillary_token() -> str | None:
    load_dotenv()
    return os.environ.get("MAPILLARY_TOKEN") or None


def collect_candidates(
    client: httpx.Client, token: str, areas: tuple[Area, ...], *, per_area_limit: int
) -> dict[str, list[dict[str, Any]]]:
    by_area: dict[str, list[dict[str, Any]]] = {}
    for area in areas:
        try:
            by_area[area.name] = fetch_area(client, token, area, limit=per_area_limit)
        except (httpx.HTTPError, ValueError) as exc:
            typer.echo(f"  {area.name}: search failed ({exc}); skipping", err=True)
            by_area[area.name] = []
            continue
        typer.echo(f"  {area.name} [{area.country}, {area.kind}]: {len(by_area[area.name])} panoramas")
    return by_area


def download_set(
    client: httpx.Client, order: list[dict[str, Any]], count: int, data_dir: Path
) -> list[dict[str, Any]]:
    """Walk the sampling order until `count` panoramas are on disk; failures fall through to the next one."""
    data_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for candidate in order:
        if len(entries) == count:
            break
        try:
            response = client.get(candidate["url"])
            response.raise_for_status()
        except httpx.HTTPError as exc:
            typer.echo(f"  {candidate['id']}: download failed ({exc}); trying the next candidate", err=True)
            continue
        jpeg = prepare_image(response.content)
        if jpeg is None:
            typer.echo(f"  {candidate['id']}: not a 2:1 equirectangular image; skipped", err=True)
            continue
        entry = manifest_entry(candidate)
        (data_dir / entry["filename"]).write_bytes(jpeg)
        entries.append(entry)
        typer.echo(f"  [{len(entries)}/{count}] {entry['filename']}  {entry['area']}  label guess: {entry['label']}")
    return entries


app = typer.Typer(add_completion=False, help=__doc__)


@app.command()
def build(
    count: int = typer.Option(40, min=1, max=50, help="Panoramas to collect (SPEC: 30-50)."),
    seed: int = typer.Option(0, help="Sampling seed; the same seed and API results give the same set."),
    out: Path = typer.Option(DEFAULT_DATA_DIR, help="Directory for the images and manifest.json."),
    per_area_limit: int = typer.Option(100, min=1, max=2000, help="Images requested per area."),
    force: bool = typer.Option(False, "--force", help="Replace an existing manifest (hand labels are lost)."),
) -> None:
    """Query Mapillary, sample panoramas across the built-in areas and write images + manifest."""
    token = mapillary_token()
    if not token:
        typer.echo(
            "MAPILLARY_TOKEN is not set. Create a free client token at "
            "https://www.mapillary.com/dashboard/developers and export MAPILLARY_TOKEN (or add it to .env).",
            err=True,
        )
        raise typer.Exit(code=2)
    manifest_path = out / MANIFEST_NAME
    if manifest_path.exists() and not force:
        typer.echo(f"{manifest_path} already exists; pass --force to rebuild (hand labels would be lost).", err=True)
        raise typer.Exit(code=2)

    with httpx.Client(timeout=60.0, follow_redirects=True) as client:
        typer.echo(f"Searching {len(AREAS)} areas...")
        by_area = collect_candidates(client, token, AREAS, per_area_limit=per_area_limit)
        order = sampling_order(by_area, random.Random(seed))
        typer.echo(f"Downloading up to {count} of {len(order)} candidates...")
        entries = download_set(client, order, count, out)

    save_manifest(manifest_path, entries)
    todo = sum(1 for e in entries if e["label"] == TODO_LABEL)
    typer.echo(f"Wrote {len(entries)} panoramas to {manifest_path} ({todo} labelled TODO, none confirmed).")
    if len(entries) < count:
        typer.echo(f"Only {len(entries)} of {count} requested panoramas were available.", err=True)
        raise typer.Exit(code=1)


def _describe(entry: dict[str, Any]) -> str:
    state = "confirmed" if entry.get("label_confirmed") else "guess"
    return (
        f"{entry['panorama_id']:<28} {entry['label']:<10} {state:<10} "
        f"{entry.get('kind', ''):<8} {entry.get('area', '')}"
    )


def _label_todo(entries: list[dict[str, Any]]) -> int:
    changed = 0
    for entry in entries:
        if entry.get("label_confirmed"):
            continue
        answer = typer.prompt(f"{_describe(entry)}\n  [u]rban / [n]on-urban / [s]kip / [q]uit", default="s")
        choice = answer.strip().lower()[:1]
        if choice == "q":
            break
        if choice in {"u", "n"}:
            set_label(entries, entry["panorama_id"], "Urban" if choice == "u" else "non-Urban")
            changed += 1
    return changed


@app.command()
def label(
    panorama_id: str = typer.Argument(None, help="panorama_id or Mapillary image id."),
    value: str = typer.Argument(None, help="Urban or non-Urban."),
    todo: bool = typer.Option(False, "--todo", help="Prompt for every label not yet confirmed by hand."),
    data: Path = typer.Option(DEFAULT_DATA_DIR, help="Directory holding manifest.json."),
) -> None:
    """Set labels by hand. With no arguments, list the entries and their label state."""
    manifest_path = data / MANIFEST_NAME
    if not manifest_path.exists():
        typer.echo(f"{manifest_path} not found; run the build command first.", err=True)
        raise typer.Exit(code=2)
    entries = load_manifest(manifest_path)

    if todo:
        changed = _label_todo(entries)
        save_manifest(manifest_path, entries)
        typer.echo(f"{changed} labels set.")
        return
    if panorama_id is None:
        for entry in entries:
            typer.echo(_describe(entry))
        return
    if value is None:
        typer.echo("Give a label: Urban or non-Urban.", err=True)
        raise typer.Exit(code=2)
    try:
        entry = set_label(entries, panorama_id, value)
    except KeyError:
        typer.echo(f"No panorama {panorama_id!r} in {manifest_path}.", err=True)
        raise typer.Exit(code=2) from None
    except ValueError as exc:
        typer.echo(f"{exc}; use Urban or non-Urban.", err=True)
        raise typer.Exit(code=2) from None
    save_manifest(manifest_path, entries)
    typer.echo(_describe(entry))


if __name__ == "__main__":
    app()
