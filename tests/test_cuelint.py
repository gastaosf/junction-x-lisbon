import pytest

from astrolabio.cuelint import LintVerdict, lint_cue, normalise

LEGITIMATE_CUES = [
    "look at the blue tiled building on the left; the bollards have a red reflector",
    "Zoom in on the shop sign behind the white van, at about yaw 120.",
    "The road markings are yellow near the roadworks; check the kilometre stone on the right.",
    "There is a church tower with two bells behind the palm trees.",
    "Read the phone number on the awning above the cafe.",
    "The sun is low on the right; shadows point towards the hill.",
    "Nice tiles on the facade. Orange awning over the door.",
    "Count the lanes; it is a 2 lane road with a roundabout ahead.",
    "the orange building has a lens-shaped window",
    "Check the tulle curtains and the roses in the garden; there is a gap in the wall.",
    "The pole has 3 crossarms and a transformer about 30 degrees above the horizon.",
    "Try enhance on the crop at yaw 215, pitch -5, fov 20.",
    "The plate on the parked car has a yellow strip on the right.",
    "the cork trees have numbers painted on the trunks",
    "There are a lot of wind turbines on the ridge, maybe 12.",
    "Turn 90° to the left and look at the red post box next to the pharmacy cross.",
    "The pavement is a black and white mosaic; the street lamps are wrought iron.",
    "Field boundaries are dry stone walls, 1.5 m high, and the soil is reddish.",
    "The bus stop shelter has a timetable; it was built in 2019 according to the plaque.",
    "It ain't the first sign, it's the second one, which says something about a lot for sale.",
]


@pytest.mark.parametrize("cue", LEGITIMATE_CUES)
def test_visual_cues_pass(cue: str) -> None:
    verdict = lint_cue(cue)
    assert verdict.ok, verdict.problems
    assert verdict.problems == []


def _blocked(cue: str, category: str) -> None:
    verdict = lint_cue(cue)
    assert not verdict.ok, cue
    assert any(p.startswith(category) for p in verdict.problems), verdict.problems


@pytest.mark.parametrize(
    "cue",
    [
        "try 38.7223, -9.1393",
        "it is at 38,72 -9,14",
        "41.15N 8.61W is closer",
        "38°43'20\"N 9°08'21\"W",
        "around 43° N",
        "the point 37.01642 looks right",
        "latitude is about 40",
        "check the GPS coordinates",
        "lat: 40 and lng: -8",
    ],
)
def test_coordinates_blocked(cue: str) -> None:
    _blocked(cue, "coordinates")


@pytest.mark.parametrize(
    "cue",
    [
        "follow the A1 north",
        "this is on the N125",
        "the EN125 runs past",
        "near the AP-7 exit",
        "D906 is the road",
        "it looks like the n-340",
        "the en 125? no: the EN 125",
        "on the N 2",
        "that is the IC 1",
        "CV-35 heading out",
        "the GC-1 by the coast",
        "estrada nacional 125",
        "route nationale 7",
        "motorway 7 is behind you",
        "the A 2 motorway",
        "road number 340",
    ],
)
def test_road_numbers_blocked(cue: str) -> None:
    _blocked(cue, "road number")


@pytest.mark.parametrize("cue", ["postcode 8000-123", "the sign says 29600", "code postal 13200", "what is the zip code"])
def test_postcodes_blocked(cue: str) -> None:
    _blocked(cue, "postcode")


@pytest.mark.parametrize("cue", ["call +351 912 345 678", "the number is 289 123 456", "it says 04 91 12 34 56"])
def test_phone_numbers_blocked(cue: str) -> None:
    _blocked(cue, "phone number")


@pytest.mark.parametrize(
    "cue",
    ["see https://maps.example/x", "www.cm-evora.example has it", "look up cafecentral.pt", "mail info@hotel.es"],
)
def test_urls_blocked(cue: str) -> None:
    _blocked(cue, "url")


@pytest.mark.parametrize(
    "cue",
    [
        "This is Évora",
        "this is evora",
        "THIS IS ÉVORA!",
        "it is in Portugal",
        "looks like the Algarve to me",
        "somewhere in Trás-os-Montes",
        "tras os montes maybe",
        "near Vila Nova de Gaia",
        "A Coruña harbour",
        "la coruna harbour",
        "Castilla-La Mancha plains",
        "Saint-Étienne or saint etienne",
        "the Côte d'Azur",
        "cote d azur light",
        "Île-de-France suburbs",
        "this is São Miguel in the Azores",
        "sao miguel, acores",
        "Tenerife north coast",
        "Mallorca or Menorca",
        "Corsica, not the mainland",
        "the Pyrenees are behind you",
        "that is the Atlantic",
        "Lisbon's waterfront",
        "(Sevilla)",
        "you are in España",
    ],
)
def test_toponyms_blocked(cue: str) -> None:
    _blocked(cue, "place name")


@pytest.mark.parametrize(
    "cue",
    [
        "the signs are in Portuguese",
        "the signs are in português",
        "that is a Spanish plate",
        "French road markings",
        "it reads like Catalan",
        "Basque-style farmhouse",
        "those are Azoreans",
        "a typical alentejano house",
        "Mediterranean? no, European for sure",
    ],
)
def test_demonyms_and_languages_blocked(cue: str) -> None:
    verdict = lint_cue(cue)
    assert not verdict.ok, cue


@pytest.mark.parametrize(
    "cue",
    ["this is near Nice", "the town of Orange", "close to Tours", "maybe Lens or Gap", "in the Lot valley"],
)
def test_ambiguous_toponyms_blocked_when_capitalised_mid_sentence(cue: str) -> None:
    _blocked(cue, "place name")


def test_word_boundaries() -> None:
    assert lint_cue("the important portal has a faroese-looking parish notice").ok
    assert lint_cue("a porthole, a brag about bragging, lagoons and madrigals").ok


def test_longest_match_reported_once() -> None:
    verdict = lint_cue("Vila Real de Santo António")
    assert verdict.problems == ["place name: 'vila real de santo antonio'"]


def test_problems_are_deduplicated_and_serialisable() -> None:
    verdict = lint_cue("Porto, porto, PORTO")
    assert verdict.problems == ["place name: 'porto'"]
    assert verdict.to_dict() == {"ok": False, "problems": ["place name: 'porto'"]}
    assert isinstance(verdict, LintVerdict)


def test_empty_text_has_no_location_reference() -> None:
    assert lint_cue("").ok
    assert lint_cue("   ").ok


def test_normalise() -> None:
    assert normalise("  Évora,  L'Hospitalet — São-João ") == "evora l hospitalet sao joao"


# --- location references that used to pass (R6) ---------------------------------------------------


@pytest.mark.parametrize(
    "cue",
    [
        "38.7, -9.1",  # one decimal is still about 10 km
        "38,7 / -9,1",
        "38 degrees north, 9 degrees west",
        "38.72 north 9.14 west",
        "38 north 9 west",
        "41,1 norte e 8,6 oeste",
    ],
)
def test_coarse_and_spelled_out_coordinates_blocked(cue: str) -> None:
    _blocked(cue, "coordinates")


@pytest.mark.parametrize(
    "cue",
    [
        "It is on Rua Augusta near the arch",
        "Avenida da Liberdade",
        "calle mayor",
        "on the rua augusta",
        "rue de la Paix is behind you",
        "the carrer nou",
    ],
)
def test_street_names_blocked(cue: str) -> None:
    _blocked(cue, "street name")


@pytest.mark.parametrize(
    "cue",
    [
        "near the Sagrada Familia",
        "next to the Eiffel Tower",
        "Ponte 25 de Abril is visible",
        "Estadio da Luz",
        "Ponte 25 de Outubro",
        "Largo do Carmo",
        "the Mercado do Bolhao",
        "look for Tower Bridge",
        "Quinta Nova is nearby",
        "by the Praia da Rocha",
        "Pont Vieux",
    ],
)
def test_landmarks_blocked(cue: str) -> None:
    verdict = lint_cue(cue)
    assert not verdict.ok, cue
    assert any(p.startswith(("landmark name", "place name")) for p in verdict.problems), verdict.problems


@pytest.mark.parametrize("cue", ["PT plates", "an ES sticker on the van", "the plate has a blue band with a P", "the oval says F"])
def test_country_codes_blocked(cue: str) -> None:
    _blocked(cue, "country code")


@pytest.mark.parametrize("cue", ["it is near Odeceixe", "this must be Zambujal", "the sign says Cafe Central"])
def test_names_outside_the_gazetteer_are_blocked_by_their_capital_letter(cue: str) -> None:
    verdict = lint_cue(cue)
    assert not verdict.ok, cue
    assert any(p.startswith(("capitalised word", "proper name")) for p in verdict.problems), verdict.problems


def test_lint_is_a_backstop_not_a_guarantee() -> None:
    """Documented limit: a toponym missing from the gazetteer, typed in lower case, cannot be told
    from an ordinary word. The operator stays responsible for R6."""
    assert lint_cue("it is near odeceixe").ok


# --- ordinary descriptions that must not be blocked -----------------------------------------------


@pytest.mark.parametrize(
    "cue",
    [
        "the road is 2 lanes wide",
        "a road of 3 m width",
        "the route to 2 houses",
        "look at yaw 220.75, -12.50 pitch",
        "crop at yaw 220.5, pitch -12.5, fov 17.5",
        "the place where the road bends",
        "the church tower of the village has 2 bells",
        "There is a white Renault van. Look behind it.",
        "I think the STOP sign and the LED panel matter",
        "the tower is 12 m tall; the bridge has 3 arches",
        "look at View 3 again",
        "it slopes 10 degrees to the left",
        "there are 2 north-facing windows",
        "a rua tem calcada preta e branca",
        "la calle es estrecha y la plaza tiene una fuente",
        "the port has 3 cranes and the beach is sandy",
    ],
)
def test_ordinary_descriptions_pass(cue: str) -> None:
    verdict = lint_cue(cue)
    assert verdict.ok, verdict.problems


def test_spaced_road_numbers_are_still_blocked_after_the_prefix_fix() -> None:
    for cue in ("route n-7", "estrada en125", "road number 340", "the N 2", "motorway 7"):
        _blocked(cue, "road number")


def test_a_known_toponym_is_reported_once_as_a_place_name() -> None:
    assert lint_cue("it is near Lisboa").problems == ["place name: 'lisboa'"]
