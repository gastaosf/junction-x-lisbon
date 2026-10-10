"""Location-reference lint for operator cues (rule R6, organiser question Q9).

A cue may describe visual features only. Anything that names or encodes a place is blocked:
coordinates, postcodes, phone numbers, URLs, road numbers, toponyms, demonyms and language
names, street and landmark names, country codes, and any capitalised word that could be a
proper name. The lint is deliberately strict: a false positive costs the operator a rephrase, a
false negative breaches the rules on the record.

It is a backstop, not the R6 guarantee: no gazetteer is complete and a place name typed in
lower case that is not in it will pass. The operator remains responsible for what they type.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field


@dataclass
class LintVerdict:
    ok: bool
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"ok": self.ok, "problems": list(self.problems)}


def normalise(text: str) -> str:
    """Accent- and case-insensitive form: lower-case ASCII words separated by single spaces."""
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", stripped.casefold()).strip()


def _names(block: str) -> frozenset[str]:
    return frozenset(n for n in (normalise(part) for part in re.split(r"[,\n]", block)) if n)


_COUNTRIES = _names(
    """
    Portugal, Spain, España, Espanha, Espagne, France, França, Francia, Italy, Italia, Germany,
    Deutschland, United Kingdom, UK, England, Britain, Scotland, Wales, Ireland, Morocco, Maroc,
    Marruecos, Marrocos, Algeria, Tunisia, Andorra, Monaco, Gibraltar, Belgium, Belgique,
    Netherlands, Holland, Switzerland, Suisse, Luxembourg, Austria, Greece, Croatia, Malta,
    Cyprus, Denmark, Sweden, Norway, Finland, Poland, Romania, Bulgaria, Hungary, Czechia,
    Slovakia, Slovenia, Brazil, Brasil, Mexico, Argentina, Cuba, Angola, Mozambique, Cape Verde,
    Cabo Verde, Europe, Europa, Iberia, Iberian Peninsula, Península Ibérica, Maghreb, Africa,
    Latin America, South America
    """
)

_PT_REGIONS = _names(
    """
    Algarve, Alentejo, Ribatejo, Estremadura, Beira, Beiras, Beira Alta, Beira Baixa,
    Beira Litoral, Beira Interior, Trás-os-Montes, Minho, Alto Minho, Douro, Douro Litoral,
    Alto Douro, Azores, Açores, Madeira, Costa Vicentina, Costa da Caparica, Costa de Prata,
    Costa Verde, Oeste, Lezíria, Barrocal, Serra da Estrela, Gerês, Peneda-Gerês, Arrábida,
    Ria Formosa, Ria de Aveiro, Tejo, Tagus, Mondego, Guadiana, Zêzere, Alqueva,
    São Miguel, Terceira, Faial, Pico, São Jorge, Graciosa, Flores, Corvo, Santa Maria,
    Porto Santo, Desertas, Berlengas
    """
)

_PT_PLACES = _names(
    """
    Lisboa, Lisbon, Lisbonne, Porto, Oporto, Braga, Coimbra, Aveiro, Faro, Évora, Beja, Setúbal,
    Leiria, Santarém, Viseu, Guarda, Castelo Branco, Portalegre, Vila Real, Bragança,
    Viana do Castelo, Funchal, Ponta Delgada, Angra do Heroísmo, Horta,
    Sintra, Cascais, Estoril, Oeiras, Amadora, Odivelas, Loures, Vila Franca de Xira, Mafra,
    Ericeira, Torres Vedras, Lourinhã, Cadaval, Alenquer, Azambuja, Arruda dos Vinhos,
    Sobral de Monte Agraço, Belém, Alfama, Benfica, Almada, Seixal, Barreiro, Moita, Montijo,
    Alcochete, Palmela, Sesimbra, Alcácer do Sal, Grândola, Santiago do Cacém, Sines, Tróia,
    Comporta, Vila Nova de Gaia, Gaia, Matosinhos, Maia, Gondomar, Valongo, Póvoa de Varzim,
    Vila do Conde, Santo Tirso, Trofa, Paredes, Penafiel, Paços de Ferreira, Lousada,
    Felgueiras, Amarante, Marco de Canaveses, Baião, Guimarães, Barcelos, Famalicão,
    Vila Nova de Famalicão, Fafe, Esposende, Vila Verde, Amares, Póvoa de Lanhoso,
    Vieira do Minho, Terras de Bouro, Cabeceiras de Basto, Celorico de Basto, Vizela,
    Ponte de Lima, Ponte da Barca, Arcos de Valdevez, Caminha, Vila Nova de Cerveira, Valença,
    Monção, Melgaço, Paredes de Coura, Chaves, Peso da Régua, Régua, Montalegre, Boticas,
    Valpaços, Vila Pouca de Aguiar, Ribeira de Pena, Mondim de Basto, Alijó, Murça, Sabrosa,
    Mesão Frio, Pinhão, Mirandela, Macedo de Cavaleiros, Miranda do Douro, Mogadouro, Vimioso,
    Vinhais, Torre de Moncorvo, Freixo de Espada à Cinta, Alfândega da Fé, Vila Flor,
    Carrazeda de Ansiães, Lamego, Tondela, Mangualde, São Pedro do Sul, Nelas,
    Santa Comba Dão, Mortágua, Castro Daire, Vouzela, Oliveira de Frades, Moimenta da Beira,
    Tarouca, Resende, Cinfães, Sernancelhe, Penedono, São João da Pesqueira, Tabuaço, Armamar,
    Carregal do Sal, Penalva do Castelo, Sátão, Vila Nova de Paiva, Ílhavo, Águeda, Ovar,
    Espinho, Santa Maria da Feira, São João da Madeira, Oliveira de Azeméis, Estarreja,
    Murtosa, Albergaria-a-Velha, Anadia, Mealhada, Oliveira do Bairro, Vagos, Sever do Vouga,
    Vale de Cambra, Arouca, Castelo de Paiva, Costa Nova, Figueira da Foz, Cantanhede,
    Montemor-o-Velho, Condeixa, Lousã, Penacova, Arganil, Oliveira do Hospital, Tábua, Mira,
    Soure, Penela, Góis, Pampilhosa da Serra, Miranda do Corvo, Vila Nova de Poiares,
    Marinha Grande, Pombal, Alcobaça, Nazaré, Caldas da Rainha, Óbidos, Peniche, Bombarral,
    Batalha, Porto de Mós, Ansião, Figueiró dos Vinhos, Pedrógão Grande, Castanheira de Pera,
    Alvaiázere, Fátima, Ourém, Abrantes, Tomar, Torres Novas, Entroncamento, Almeirim, Cartaxo,
    Rio Maior, Coruche, Benavente, Golegã, Chamusca, Constância, Mação, Sardoal,
    Ferreira do Zêzere, Salvaterra de Magos, Covilhã, Fundão, Idanha-a-Nova, Penamacor, Sertã,
    Oleiros, Proença-a-Nova, Vila Velha de Ródão, Belmonte, Monsanto, Seia, Gouveia, Manteigas,
    Sabugal, Almeida, Pinhel, Trancoso, Mêda, Vila Nova de Foz Côa,
    Figueira de Castelo Rodrigo, Celorico da Beira, Fornos de Algodres, Aguiar da Beira,
    Vilar Formoso, Elvas, Estremoz, Borba, Vila Viçosa, Alandroal, Redondo,
    Reguengos de Monsaraz, Monsaraz, Mourão, Portel, Viana do Alentejo, Arraiolos,
    Montemor-o-Novo, Vendas Novas, Mora, Marvão, Castelo de Vide, Nisa, Crato, Sousel,
    Fronteira, Alter do Chão, Gavião, Ponte de Sor, Campo Maior, Arronches, Monforte, Serpa,
    Moura, Mértola, Odemira, Ourique, Castro Verde, Almodôvar, Aljustrel,
    Ferreira do Alentejo, Alvito, Vidigueira, Barrancos, Vila Nova de Milfontes, Zambujeira,
    Tavira, Olhão, Loulé, Albufeira, Silves, Portimão, Lagos, Lagoa, Monchique, Aljezur,
    Vila do Bispo, Sagres, Castro Marim, Alcoutim, São Brás de Alportel,
    Vila Real de Santo António, Quarteira, Vilamoura, Armação de Pêra, Carvoeiro,
    Ribeira Grande, Vila Franca do Campo, Povoação, Furnas, Sete Cidades,
    Praia da Vitória, Madalena, Lajes, Velas, Calheta, Santa Cruz das Flores, Vila do Porto,
    Câmara de Lobos, Machico, Santana, Ribeira Brava, Ponta do Sol, Porto Moniz, São Vicente,
    Santa Cruz
    """
)

_ES_REGIONS = _names(
    """
    Andalucía, Andalusia, Aragón, Asturias, Cantabria, Castilla, Castile, Castilla y León,
    Castilla-La Mancha, La Mancha, Cataluña, Catalunya, Catalonia, Extremadura, Galicia,
    La Rioja, Rioja, Murcia, Navarra, Navarre, País Vasco, Euskadi, Basque Country,
    Comunidad Valenciana, Baleares, Balears, Balearics, Balearic Islands, Canarias, Canaries,
    Canary Islands, Ceuta, Melilla, Mallorca, Majorca, Menorca, Minorca, Ibiza, Eivissa,
    Formentera, Cabrera, Tenerife, Gran Canaria, Lanzarote, Fuerteventura, La Palma, La Gomera,
    El Hierro, La Graciosa, Teide, Costa del Sol, Costa Brava, Costa Blanca, Costa Dorada,
    Costa Daurada, Costa de la Luz, Costa da Morte, Costa Cálida, Costa Tropical, Rías Baixas,
    Rías Altas, Sierra Nevada, Picos de Europa, Sierra Morena, Meseta, Monegros, Alpujarra,
    Alpujarras, Cabo de Gata, Doñana, Ebro, Guadalquivir, Duero, Tajo, Júcar, Bierzo,
    Empordà, Maresme, Garrotxa, Cerdanya, Val d'Aran
    """
)

_ES_PLACES = _names(
    """
    Madrid, Barcelona, Valencia, València, Sevilla, Seville, Zaragoza, Saragossa, Málaga,
    Bilbao, Bilbo, Alicante, Alacant, Córdoba, Valladolid, Vigo, Gijón, Granada, Oviedo,
    Santander, Pamplona, Iruña, San Sebastián, Donostia, Vitoria, Gasteiz, Logroño, Burgos,
    Salamanca, León, Toledo, Badajoz, Cáceres, Mérida, Huelva, Cádiz, Jaén, Almería, Albacete,
    Ciudad Real, Cuenca, Guadalajara, Segovia, Ávila, Soria, Palencia, Zamora, Teruel, Huesca,
    Lleida, Lérida, Girona, Gerona, Tarragona, Castellón, Castelló, Lugo, Ourense, Orense,
    Pontevedra, A Coruña, La Coruña, Corunna, Santiago de Compostela, Compostela, Ferrol,
    Las Palmas, Santa Cruz de Tenerife, La Laguna, Palma de Mallorca, Palma, Álava, Araba,
    Guipúzcoa, Gipuzkoa, Vizcaya, Bizkaia, Biscay, Avilés, Elche, Elx, Cartagena, Lorca,
    Jerez, Jerez de la Frontera, Algeciras, Marbella, Torremolinos, Fuengirola, Estepona,
    Benalmádena, Ronda, Antequera, Motril, Nerja, Úbeda, Baeza, Linares, Plasencia, Trujillo,
    Talavera de la Reina, Alcalá de Henares, Getafe, Leganés, Móstoles, Alcorcón,
    Fuenlabrada, Aranjuez, Hospitalet, L'Hospitalet, Badalona, Sabadell, Terrassa, Tarrasa,
    Mataró, Reus, Figueres, Sitges, Lloret de Mar, Tortosa, Manresa, Vic, Cadaqués, Benidorm,
    Torrevieja, Gandía, Dénia, Alcoy, Sagunto, Peñíscola, Calpe, Jávea, Xàbia, Mahón, Maó,
    Ciutadella, Manacor, Alcúdia, Sóller, Pollença, Arrecife, Puerto del Rosario,
    Maspalomas, Puerto de la Cruz, Ponferrada, Astorga, Aranda de Duero, Miranda de Ebro,
    Medina del Campo, Tudela, Calatayud, Jaca, Barbastro, Alcañiz, Ciudad Rodrigo, Béjar,
    Tui, Verín, Ayamonte, Olivenza, Sanlúcar, Sanlúcar de Barrameda, Chiclana, Tarifa,
    Puertollano, Valdepeñas, Tomelloso, Alcázar de San Juan, Hellín, Yecla, Villena, Elda,
    Orihuela, Mojácar, Roquetas de Mar, El Ejido, Lepe, Écija, Utrera, Dos Hermanas, Osuna,
    Lucena, Santillana del Mar, Llanes, Ribadeo, Viveiro, Monforte de Lemos, Irún,
    Hondarribia, Eibar, Barakaldo, Getxo, Torrelavega, Laredo, Castro Urdiales, Mieres,
    Langreo, Cangas de Onís, Covadonga, Sanxenxo, Vilagarcía, Baiona, Coria, Zafra,
    Don Benito, Almendralejo, Navalmoral de la Mata
    """
)

_FR_REGIONS = _names(
    """
    Île-de-France, Bretagne, Brittany, Normandie, Normandy, Hauts-de-France, Grand Est,
    Alsace, Lorraine, Bourgogne, Franche-Comté, Centre-Val de Loire, Val de Loire,
    Pays de la Loire, Nouvelle-Aquitaine, Aquitaine, Limousin, Poitou, Poitou-Charentes,
    Charentes, Occitanie, Occitania, Languedoc, Roussillon, Midi-Pyrénées, Auvergne,
    Rhône-Alpes, Provence, Côte d'Azur, French Riviera, Riviera, PACA, Corse, Corsica,
    Savoie, Savoy, Haute-Savoie, Dauphiné, Gascogne, Gascony, Périgord, Béarn, Pays Basque,
    Picardie, Picardy, Flandre, Flanders, Vendée, Camargue, Luberon, Cévennes, Quercy,
    Sologne, Beauce, Morvan, Vercors, Queyras, Médoc, Aisne, Allier, Ardèche, Ardennes,
    Ariège, Aube, Aude, Aveyron, Bouches-du-Rhône, Calvados, Cantal, Charente,
    Charente-Maritime, Cher, Corrèze, Côte-d'Or, Côtes-d'Armor, Creuse, Dordogne, Doubs,
    Drôme, Eure, Eure-et-Loir, Finistère, Gard, Haute-Garonne, Gers, Gironde, Hérault,
    Ille-et-Vilaine, Indre, Indre-et-Loire, Isère, Jura, Landes, Loir-et-Cher, Loire,
    Haute-Loire, Loire-Atlantique, Loiret, Lot-et-Garonne, Lozère, Maine-et-Loire, Manche,
    Marne, Haute-Marne, Mayenne, Meurthe-et-Moselle, Meuse, Morbihan, Moselle, Nièvre, Nord,
    Oise, Orne, Pas-de-Calais, Puy-de-Dôme, Pyrénées-Atlantiques, Hautes-Pyrénées,
    Pyrénées-Orientales, Bas-Rhin, Haut-Rhin, Rhône, Haute-Saône, Saône-et-Loire, Saône,
    Sarthe, Seine, Seine-Maritime, Seine-et-Marne, Deux-Sèvres, Somme, Tarn, Tarn-et-Garonne,
    Var, Vaucluse, Vienne, Haute-Vienne, Vosges, Yonne, Essonne, Yvelines, Val-d'Oise,
    Hauts-de-Seine, Seine-Saint-Denis, Val-de-Marne, Alpes-Maritimes, Hautes-Alpes,
    Alpes-de-Haute-Provence, Corse-du-Sud, Haute-Corse, Territoire de Belfort,
    Massif Central, Garonne, Esterel, Calanques, Mont Blanc, Mont Ventoux, Cap Corse,
    Balagne, Île de Ré, Oléron, Belle-Île, Noirmoutier
    """
)

_FR_PLACES = _names(
    """
    Paris, Marseille, Marseilles, Lyon, Lyons, Toulouse, Nantes, Strasbourg, Montpellier,
    Bordeaux, Lille, Rennes, Reims, Le Havre, Saint-Étienne, Toulon, Grenoble, Dijon, Angers,
    Nîmes, Villeurbanne, Clermont-Ferrand, Le Mans, Aix-en-Provence, Brest, Amiens, Limoges,
    Annecy, Perpignan, Metz, Besançon, Orléans, Rouen, Mulhouse, Caen, Nancy, Avignon,
    Poitiers, La Rochelle, Pau, Calais, Dunkerque, Dunkirk, Bayonne, Biarritz, Anglet,
    Saint-Jean-de-Luz, Hendaye, Lourdes, Tarbes, Carcassonne, Narbonne, Béziers, Sète, Arles,
    Cannes, Antibes, Menton, Saint-Tropez, Fréjus, Hyères, Ajaccio, Bastia, Bonifacio, Calvi,
    Porto-Vecchio, Sartène, Propriano, Île-Rousse, Chambéry, Chamonix, Valence, Montélimar,
    Digne, Briançon, Albi, Castres, Montauban, Cahors, Agen, Périgueux, Bergerac, Sarlat,
    Arcachon, Angoulême, Cognac, Saintes, Rochefort, Royan, Niort, Quimper, Lorient, Vannes,
    Saint-Malo, Saint-Brieuc, Morlaix, Cherbourg, Bayeux, Honfleur, Deauville, Dieppe,
    Étretat, Boulogne, Boulogne-sur-Mer, Arras, Roubaix, Tourcoing, Valenciennes, Troyes,
    Chartres, Versailles, Blois, Bourges, Nevers, Auxerre, Beaune, Mâcon, Colmar, Épinal,
    Belfort, Vichy, Le Puy, Le Puy-en-Velay, Aurillac, Rodez, Millau, Mende, Foix, Dax,
    Mont-de-Marsan, Brive, Brive-la-Gaillarde, Guéret, Châteauroux, Laval, Saint-Nazaire,
    La Roche-sur-Yon, Cholet, Saumur, Lisieux, Évreux, Beauvais, Compiègne, Saint-Quentin,
    Charleville-Mézières, Verdun, Thionville, Annemasse, Aix-les-Bains, Grasse, Draguignan,
    Carpentras, Cavaillon, Lunel, Agde, Collioure, Céret, Prades, Font-Romeu, Saint-Girons,
    Pamiers, Luchon, Oloron, Orthez, Mont Saint-Michel, Saint-Denis, Montreuil, Nanterre,
    Créteil, Aubagne, Martigues, Salon-de-Provence, Manosque, Sisteron, Barcelonnette,
    Albertville, Bourg-en-Bresse, Roanne, Montluçon, Moulins, Périgord Noir, Soulac,
    Biscarrosse, Mimizan, Hossegor, Capbreton
    """
)

_NATURAL = _names(
    """
    Atlantic, Atlântico, Atlántico, Atlantique, Mediterranean, Mediterrâneo, Mediterráneo,
    Méditerranée, Bay of Biscay, Golfe de Gascogne, Cantabrian Sea, English Channel,
    La Manche, Strait of Gibraltar, Pyrenees, Pyrénées, Pirineos, Pirenéus, Pirineus, Alps,
    Alpes, Macaronesia
    """
)

_DEMONYMS_AND_LANGUAGES = _names(
    """
    Portuguese, Português, Portuguesa, Portugais, Portugués, Lusitanian, Lusophone, Spanish,
    Español, Española, Espanhol, Espagnol, Castilian, Castellano, Hispanic, French, Français,
    Française, Francés, Francês, Francophone, Iberian, Catalan, Català, Catalán, Valencian,
    Valenciano, Galician, Galego, Gallego, Basque, Euskera, Euskara, Occitan, Breton,
    Corsican, Corsu, Alsatian, Mirandese, Aranese, Asturian, Andalusian, Aragonese,
    Extremaduran, Cantabrian, Navarrese, Murcian, Canarian, Balearic, Mallorcan, Majorcan,
    Menorcan, Ibizan, Azorean, Madeiran, Algarvian, Alentejan, Alentejano, Minhoto, Lisboeta,
    Madrilenian, Parisian, Provençal, Norman, Gascon, Savoyard, Alpine, Pyrenean, European,
    Italian, German, English, British, Irish, Dutch, Belgian, Swiss, Moroccan, Arabic,
    Brazilian, Greek, Flemish
    """
)

_LANDMARKS = _names(
    """
    Sagrada Familia, Sagrada Família, Eiffel, Tour Eiffel, Torre de Belém, Belem Tower, Jerónimos,
    Alhambra, Louvre, Notre-Dame, Notre Dame, Sacré-Cœur, Sacre Coeur, Montmartre, Champs-Élysées,
    Arc de Triomphe, Guggenheim, Mezquita, Giralda, Alcázar, Camp Nou, Bernabéu, Park Güell,
    Parc Güell, Ramblas, La Rambla, Puerta del Sol, Plaza Mayor, Gran Vía, Retiro, Prado,
    Escorial, Montserrat, Tibidabo, Montjuïc, Rossio, Chiado, Bairro Alto, Cais do Sodré,
    Terreiro do Paço, Praça do Comércio, Marquês de Pombal, Parque das Nações, Vasco da Gama,
    25 de Abril, Dom Luís, Clérigos, Ribeira, Boavista, Serralves, Bom Jesus, Batalha, Pena,
    Cristo Rei, Pont du Gard, Pont Neuf, Vieux-Port, Canebière, Promenade des Anglais, Croisette,
    Bellecour, Fourvière, Capitole, Mont Saint Michel, Saint-Michel, Lourdes, Fátima, Santiago,
    Estádio da Luz, Estadio da Luz, Alvalade, Dragão, Mestalla, Wanda, Vélodrome, Parc des Princes
    """
)

_TOPONYMS: frozenset[str] = (
    _COUNTRIES
    | _LANDMARKS
    | _PT_REGIONS
    | _PT_PLACES
    | _ES_REGIONS
    | _ES_PLACES
    | _FR_REGIONS
    | _FR_PLACES
    | _NATURAL
)
_MAX_NAME_WORDS = max(name.count(" ") + 1 for name in _TOPONYMS | _DEMONYMS_AND_LANGUAGES)

# Toponyms that are also ordinary English words. They are flagged only when capitalised in
# the middle of a sentence ("near Nice"), so "nice tiles" and "an orange awning" pass.
_AMBIGUOUS_RE = re.compile(
    r"\b(Nice|Orange|Tours|Lens|Roses|Gap|Die|Sens|Lot|Tulle|Burgundy|Champagne|Avis|Alès|Ain)\b"
)
_SENTENCE_END = ".!?:;\n"

_DEGREES = r"(?:°|º|degrees?|degs?|graus?|grados?|degr[eé]s?)"
_DIRECTION = r"(?:north|south|east|west|norte|sul|sur|este|leste|oeste|nord|sud|ouest)"
# View directions are written the same way as coordinates ("yaw 220.75, pitch -12.50"); they
# are taken out before the coordinate patterns run so that pointing at a view stays possible.
_VIEW_ANGLE_RE = re.compile(r"\b(yaw|pitch|fov)\s*[:=]?\s*[-+]?\d+(?:[.,]\d+)?", re.IGNORECASE)

_COORDINATE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        # decimal pair; one decimal is already about 10 km, near full score for non-Urban
        r"[-+]?\d{1,3}[.,]\d+\s*°?\s*[NSEWOnsewo]?\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d+"
        r"|\d{1,3}\s*°\s*\d{1,2}\s*['′’]"  # degrees and minutes
        r"|\d{1,3}(?:[.,]\d+)?\s*°\s*[NSEWO]\b"  # degrees with a hemisphere letter
        r"|\d{1,3}\.\d{4,}"  # a single high-precision decimal
    ),
    re.compile(
        # "38.72 north", "38 degrees north", "38 north 9 west"
        rf"\d{{1,3}}[.,]\d+\s*{_DEGREES}?\s*{_DIRECTION}\b"
        rf"|\d{{1,3}}\s*{_DEGREES}\s*{_DIRECTION}\b"
        rf"|\d{{1,3}}\s*{_DIRECTION}\W+\d{{1,3}}\s*{_DEGREES}?\s*{_DIRECTION}\b",
        re.IGNORECASE,
    ),
)

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "coordinates",
        re.compile(
            r"\b(?:latitudes?|longitudes?|gps|coordinates?|coords?|utm|what3words|plus\s+code"
            r"|(?:lat|lng|lon|long)\s*[:=]?\s*[-+]?\d)",
            re.IGNORECASE,
        ),
    ),
    (
        "url",
        re.compile(
            r"https?://\S+|\bwww\.\S+|\S+@\S+\.\w+"
            r"|\b[a-z0-9-]+\.(?:pt|es|fr|com|org|net|eu|cat|gal|eus|info|io)\b(?:/\S*)?",
            re.IGNORECASE,
        ),
    ),
    (
        "phone number",
        re.compile(
            r"\+\s?\d{2,3}\b"  # international prefix
            r"|\b00\d{2,3}\b"
            r"|(?<!\d)\d{3}[ .-]?\d{3}[ .-]?\d{3}(?!\d)"  # PT / ES nine digits
            r"|(?<!\d)0\d(?:[ .-]?\d{2}){4}(?!\d)"  # FR ten digits
        ),
    ),
    (
        "postcode",
        re.compile(
            r"(?<!\d)\d{4}-\d{3}(?!\d)|(?<![\d.,])\d{5}(?![\d.,]\d|\d)"
            r"|\b(?:post\s?codes?|postal\s+codes?|zip\s?codes?|area\s+codes?|dialling\s+codes?"
            r"|dialing\s+codes?|country\s+codes?|c[oó]digo\s+postal|code\s+postal)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "road number",
        re.compile(
            # any upper-case road-style token: A1, N125, EN125, AP-7, D906, CV-35, GC-1
            r"(?<![A-Za-z0-9])[A-Z]{1,3}-?\d{1,4}[A-Za-z]?(?![A-Za-z0-9])"
            # spaced forms: "EN 125", "N 125", "D 906"
            r"|(?<![A-Za-z0-9])(?:EN|ER|EM|IP|IC|AP|RN|RD|VR|[NDE])\s\d{1,4}(?![A-Za-z0-9])"
            # "A 2 motorway"
            r"|(?<![A-Za-z0-9])[A-Z]{1,3}[- ]\d{1,4}\s+(?:motorway|highway|autoroute|autopista|autov[ií]a"
            r"|autoestrada)\b"
        ),
    ),
    (
        "road number",
        re.compile(
            # lower-case forms of the common PT/ES/FR prefixes: a1, n-340, en125, d906
            r"(?<![a-z0-9])(?:ap|en|er|em|ip|ic|rn|rd|a|n|d)-?\d{1,4}(?![a-z0-9])"
            # "motorway 7", "estrada nacional 125", "route nationale 7", "road number 3". A letter
            # prefix must be attached or hyphenated ("route n-7"), so "the road is 2 lanes wide" passes.
            r"|\b(?:road|route|highway|motorway|estrada|carretera|autoroute|autopista|autov[ií]a"
            r"|autoestrada|ruta|nacional|nationale|d[eé]partementale|itiner[aá]rio)"
            r"\s+(?:(?:no\.?|number|n[ºo°]\.?|nacional|nationale|principal|complementar)\s*)?"
            r"(?:[a-z]{1,2}-?)?\d{1,4}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "country code",
        # nationality marks as they appear on plates and stickers
        re.compile(r"(?<![A-Za-z0-9])(?:PT|ES|FR|PRT|ESP|FRA|POR)(?![A-Za-z0-9])"),
    ),
)

# --- street and landmark names ------------------------------------------------------------------
# Matched on accent-stripped text with its case kept, because capitalisation is the signal.

# Words that only ever introduce a street name in a cue: blocked with whatever follows them,
# unless that is a function word ("a rua tem ...", "la calle es ...").
_STREET_WORDS = (
    "rua|avenida|av|travessa|praca|praceta|alameda|calle|plaza|paseo|rue|boulevard|bd|impasse|allee"
    "|carrer|avinguda|passeig|kalea|praza"
)
_FUNCTION_WORDS = frozenset(
    """
    is are was has have had with without and or but that which where here there looks seems in on at
    to of the a an it its e tem ha com sem que onde esta parece tambem nao ou mas em no na um uma os
    as o es tiene hay con sin donde y pero en un una el la los las est avec sans qui et mais dans le
    les des du sign signs name names
    """.split()
)
_LINK = r"(?:de\s+la|de\s+los|de\s+las|de|da|do|das|dos|del|du|des|of)"
_STREET_RE = re.compile(
    rf"\b({_STREET_WORDS})\.?\s+((?:{_LINK}\s+)?[A-Za-z0-9][\w'’-]*)", re.IGNORECASE
)

# Feature words that are ordinary nouns on their own ("the church tower", "the place where")
# but name a site when a capitalised word, a number or "de/da/do/del/du/of" + a capitalised word
# follows: "Ponte 25 de Abril", "Estadio da Luz", "Place Bellecour", "Tower Bridge".
_FEATURE_WORDS = (
    "place|pont|largo|calcada|beco|rotunda|estrada|carretera|travesia|glorieta|chemin|quai"
    "|ponte|puente|estadio|stade|igreja|iglesia|eglise|catedral|cathedrale|se|mosteiro"
    "|monasterio|convento|castelo|castillo|chateau|torre|tour|praia|playa|plage|mercado|marche|estacao"
    "|estacion|gare|parque|parc|jardim|jardin|serra|sierra|monte|mont|cabo|cap|lagoa|lago|lac|barragem"
    "|embalse|santuario|capela|ermida|palacio|palais|museu|museo|musee|farol|puerto|port|aeroporto"
    "|aeropuerto|aeroport|universidade|universidad|hospital|miradouro|mirador|cais|fonte|fuente"
    "|fontaine|arco|arc|basilica|basilique|quinta|herdade|bairro|barrio|quartier|vila|villa|ville"
    "|aldeia|pueblo|cidade|ciudad|rio|ribeira|street|road|avenue|square|bridge|tower|cathedral|church"
    "|stadium|station|park|castle|palace|market|beach|lake|river|mount|cape|bay|harbour|harbor|airport"
    "|university|museum|abbey|chapel|lighthouse|hill|valley|island|forest"
)
_FEATURE_THEN_NAME_RE = re.compile(
    rf"\b(?i:{_FEATURE_WORDS})\s+(?:(?:(?i:{_LINK})\s+)?[A-Z][\w'’-]*|\d+\b(?:\s+(?i:{_LINK})\s+\w+)?)"
)
_NAME_THEN_FEATURE_RE = re.compile(
    r"\b[A-Z][a-z'’-]+\s+(?i:street|road|avenue|square|bridge|tower|cathedral|church|stadium|station|park"
    r"|castle|palace|market|beach|lake|river|bay|harbour|harbor|airport|university|museum|abbey|chapel"
    r"|lighthouse|hill|valley|island|forest)\b"
)
# Two or more capitalised words in a row (small linking words allowed) read as a proper name
# wherever they stand: "Sagrada Familia", "Cafe Central", "Vila Nova de Algo".
_NAME_LINK = r"(?:de|da|do|das|dos|del|la|las|los|le|les|du|des|of|the|y|e|i)"
_TITLE = r"[A-Z][a-z][\w'’-]*"
_PROPER_NAME_RE = re.compile(rf"\b{_TITLE}(?:\s+(?:{_NAME_LINK}\s+)*{_TITLE})+")
# A single capitalised word in the middle of a sentence may be a toponym the gazetteer lacks.
_CAPITALISED_RE = re.compile(rf"\b{_TITLE}")
_SINGLE_LETTER_CODE_RE = re.compile(r"(?<![A-Za-z0-9'’.-])[PEF](?![A-Za-z0-9'’-])")
_CAPITALISED_ALLOWED = frozenset(
    """
    january february march april may june july august september october november december monday
    tuesday wednesday thursday friday saturday sunday view views overview up down urban special one
    north south east west northeast northwest southeast southwest yaw pitch fov enhance zoom crop
    renault peugeot citroen fiat seat opel volkswagen toyota ford mercedes audi nissan dacia kia
    hyundai honda volvo skoda mazda tesla mitsubishi suzuki mini jeep yes no ok okay
    """.split()
)


def _strip_accents(text: str) -> str:
    """Accent-free text with case and punctuation kept."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _pattern_problems(text: str) -> list[str]:
    without_view_angles = _VIEW_ANGLE_RE.sub(lambda m: m.group(1), text)
    problems = [
        f"coordinates: {match.group(0).strip()!r}"
        for pattern in _COORDINATE_PATTERNS
        for match in pattern.finditer(without_view_angles)
    ]
    problems += [
        f"{category}: {match.group(0).strip()!r}"
        for category, pattern in _PATTERNS
        for match in pattern.finditer(text)
    ]
    return problems


def _starts_sentence(text: str, index: int) -> bool:
    before = text[:index].rstrip(" \t\"'“”‘’«»([")
    return not before or before[-1] in _SENTENCE_END


def _proper_name_problems(text: str) -> list[str]:
    """Street, landmark and other proper names, recognised by shape rather than by gazetteer."""
    plain = _strip_accents(text)
    problems: list[str] = []
    covered: list[tuple[int, int]] = []

    def overlaps(start: int, end: int) -> bool:
        return any(start < b and a < end for a, b in covered)

    def add(category: str, start: int, end: int) -> None:
        if not overlaps(start, end):
            problems.append(f"{category}: {plain[start:end].strip()!r}")
            covered.append((start, end))

    for match in _STREET_RE.finditer(plain):
        if match.group(2).casefold() not in _FUNCTION_WORDS:
            add("street name", match.start(), match.end())
    for match in _FEATURE_THEN_NAME_RE.finditer(plain):
        add("landmark name", match.start(), match.end())
    for match in _NAME_THEN_FEATURE_RE.finditer(plain):
        if not _starts_sentence(plain, match.start()):  # "The tower ..." is an ordinary opening
            add("landmark name", match.start(), match.end())
    for match in _PROPER_NAME_RE.finditer(plain):
        start = match.start()
        if _starts_sentence(plain, start):
            # The opening word is capitalised anyway; what follows it must still be a name by itself.
            start += re.match(rf"{_TITLE}\s+", plain[start:]).end()  # type: ignore[union-attr]
            if len(_CAPITALISED_RE.findall(plain[start : match.end()])) < 2:
                continue  # one capitalised word left: the single-word rule below decides
        add("proper name", start, match.end())
    for match in _CAPITALISED_RE.finditer(plain):
        word = match.group(0)
        if overlaps(match.start(), match.end()) or _starts_sentence(plain, match.start()):
            continue
        if word.casefold() not in _CAPITALISED_ALLOWED:
            problems.append(f"capitalised word (names are not allowed; write common nouns in lower case): {word!r}")
    for match in _SINGLE_LETTER_CODE_RE.finditer(plain):
        if not _starts_sentence(plain, match.start()):
            problems.append(f"country code: {match.group(0)!r}")
    return problems


def _name_problems(text: str) -> list[str]:
    """Word-boundary gazetteer match on the normalised text, longest names first."""
    tokens = normalise(text).split()
    problems: list[str] = []
    covered: set[int] = set()
    for size in range(min(_MAX_NAME_WORDS, len(tokens)), 0, -1):
        for start in range(len(tokens) - size + 1):
            span = range(start, start + size)
            if covered.intersection(span):
                continue
            phrase = " ".join(tokens[start : start + size])
            category = _classify(phrase)
            if category:
                covered.update(span)
                problems.append(f"{category}: {phrase!r}")
    return problems


def _classify(phrase: str) -> str | None:
    if phrase in _TOPONYMS:
        return "place name"
    singular = phrase[:-1] if phrase.endswith("s") else phrase
    if phrase in _DEMONYMS_AND_LANGUAGES or singular in _DEMONYMS_AND_LANGUAGES:
        return "demonym or language"
    return None


def _ambiguous_problems(text: str) -> list[str]:
    problems = []
    for match in _AMBIGUOUS_RE.finditer(text):
        before = text[: match.start()].rstrip()
        if before and before[-1] not in _SENTENCE_END:
            problems.append(f"place name: {match.group(0)!r}")
    return problems


def lint_cue(text: str) -> LintVerdict:
    """Verdict on whether a cue is free of direct or indirect location references."""
    found = _pattern_problems(text) + _name_problems(text) + _ambiguous_problems(text)
    if not found:
        # Shape-based rules run only on text the specific rules passed, so a known toponym is
        # reported once, as what it is, rather than again as "a capitalised word".
        found = _proper_name_problems(text)
    problems = list(dict.fromkeys(found))
    return LintVerdict(ok=not problems, problems=problems)
