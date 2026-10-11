// Curated game vocabulary per language (our own short lists, no game data).
//
// Two uses:
// - the spell-corrector adds these words to Hunspell (speller.add), so
//   names, moves, items and menu words are never "fixed" into dictionary
//   words ("Tackle" -> "Takle", "Haustiere" -> "Hausiere");
// - the lexicon asks isKnownWord() before merging letters an OCR engine
//   split apart ("Figh t" -> "Fight", "t o" -> "to").
// Common function words are included because short words are where letter
// splits hurt most and Hunspell is not available on the main thread.

const SHARED = `
Pokémon POKéMON Pokédex POKéDEX PokéGear POKéGEAR PokéNav POKéNAV PokéBlock
Poké POKé PkMn PKMN Pikachu Rattata Eevee Mew Mewtwo Onix Snorlax Ditto
Professor Prof Gym Team Rocket TM HM PC
`;

const LANGS = {
  en: {
    common: `
a an and are as at be but by can do for go got had has have he her here him
his how i if in into is it its just let me my no not now of oh ok on or our
out please so that the their them then there they this to too up us very was
we well were what when where which who why will with yes yet you your
hello hi hey welcome name world thanks thank wait sorry okay
`,
    game: `
Bulbasaur Charmander Squirtle Pidgey Caterpie Weedle Spearow Pikachu Torchic
Treecko Mudkip Poochyena Zigzagoon Wurmple Chikorita Cyndaquil Totodile
Oak Elm Birch Red Blue Gary
Tackle Growl Scratch Ember Thundershock Thunderbolt Quick Attack Tail Whip
Vine Whip Water Gun Bubble Gust Sand Attack String Shot Poison Sting Leer
Potion Super Hyper Antidote Repel Escape Rope Rare Candy Ball Balls Great
Ultra Master Revive Elixir Ether Parlyz Heal Burn Awakening Badge Badges
Fight Bag Run Item Items Save Option Options Exit Buy Sell Quit Cancel Party
Switch Summary Trainer Trainers Rival Center Mart Route City Town Pallet
Viridian Pewter Cerulean Vermilion Littleroot Oldale Petalburg New Bark
Cherrygrove Violet Pokéball Pokémart Pokécenter Daycare Bike Bicycle Map
`
  },
  de: {
    common: `
der die das den dem des ein eine einen einem einer und oder aber ist sind
war bin bist hat habe hast zu im in an am auf aus bei mit von vor nach für
du ich er sie es wir ihr mir mich dir dich dein deine mein meine sein
seine nicht kein keine ja nein so da wo wie was wer hier dort noch schon
nur auch doch mal oh hallo willkommen danke bitte gut
`,
    game: `
Bisasam Glumanda Schiggy Taubsi Rattfratz Raupy Hornliu Habitak Flemmli
Geckarbor Hydropi Fiffyen Zigzachs Waumpel Endivie Feurigel Karnimani
Eich Lind Birk
Tackle Heuler Kratzer Glut Donnerschock Donnerblitz Ruckzuckhieb Rutenschlag
Rankenhieb Aquaknarre Blubber Windstoß Sandwirbel Fadenschuss Giftstachel
Silberblick Trank Supertrank Hypertrank Top-Trank Gegengift Schutz
Fluchtseil Sonderbonbon Pokéball Superball Hyperball Meisterball Beleber
Orden Kampf KAMPF Beutel BEUTEL Flucht FLUCHT Item ITEM Sichern SICHERN
Optionen OPTIONEN Zurück ZURÜCK Kaufen KAUFEN Verkaufen VERKAUFEN Tschüss
TSCHÜSS Ja JA Nein NEIN Abbrechen Trainer Trainerin Arena Rivale
Pokémon-Center Pokémon-Markt Pokécenter Alabastia Vertania Marmoria Azuria
Orania Wurzelheim Rosalia Neuborkia Route Haustiere Haustier Spielstand
Volltreffer Fahrrad Karte Pension
`
  },
  fr: {
    common: `
le la les de des du un une et est sont à au aux en dans sur pour par avec
je tu il elle on nous vous ils elles me te se mon ma mes ton ta tes son sa
ses ce cet cette qui que quoi où oui non pas ne plus très bien salut
bonjour bienvenue merci voici voilà
`,
    game: `
Bulbizarre Salamèche Carapuce Roucool Chenipan Aspicot Poussifeu Arcko
Gobou Medhyèna Zigzaton Chen Orme Seko
Charge Rugissement Griffe Flammèche Éclair Tonnerre Vive-Attaque Mimi-Queue
Fouet Lianes Pistolet Écume Tornade Jet Sable Sécrétion Dard-Venin
Potion Antidote Repousse Corde Sortie Bonbon Super Hyper Rappel
Attaque ATTAQUE Sac SAC Fuite FUITE Objet OBJET Sauver SAUVER Options
OPTIONS Retour RETOUR Acheter ACHETER Vendre VENDRE Oui OUI Non NON Annuler
Dresseur Dresseuse Arène Badge Rival Centre Boutique Bourg Palette Jadielle
Argenta Azuria Carmin Bourg-en-Vol Rosyères Vélo Carte
`
  },
  es: {
    common: `
el la los las de del un una unos unas y o es son en a al con por para que
yo tu tú él ella nos se mi mis su sus te me lo le no sí muy más bien hola
bienvenido bienvenida gracias aquí allí está estás
`,
    game: `
Bulbasaur Charmander Squirtle Pidgey Caterpie Weedle Torchic Treecko Mudkip
Poochyena Zigzagoon Oak Abedul Elm
Placaje Gruñido Arañazo Ascuas Impactrueno Rayo Ataque Rápido Látigo Cepa
Pistola Agua Burbuja Tornado Arena Disparo Demora Picotazo Veneno
Poción Superpoción Hiperpoción Antídoto Repelente Cuerda Huida Caramelo Raro
Lucha LUCHA Mochila MOCHILA Huida HUIDA Objeto OBJETO Guardar GUARDAR
Opciones OPCIONES Salir SALIR Comprar COMPRAR Vender VENDER Sí SÍ No NO
Cancelar Entrenador Entrenadora Gimnasio Medalla Rival Centro Tienda Pueblo
Paleta Ciudad Verde Plateada Celeste Raíz Escaso Bici Mapa
`
  },
  it: {
    common: `
il lo la i gli le di del della un una uno e è a al alla in con per da su che
io tu lui lei noi voi mi ti si mio mia tuo tua suo sua non sì no molto più
bene ciao benvenuto benvenuta grazie qui ecco
`,
    game: `
Bulbasaur Charmander Squirtle Pidgey Caterpie Weedle Torchic Treecko Mudkip
Poochyena Zigzagoon Oak Birch Elm
Azione Ruggito Graffio Braciere Tuonoshock Fulmine Attacco Rapido Colpocoda
Frustata Pistolacqua Bolla Raffica Turbosabbia Millebave Velenospina
Pozione Superpozione Iperpozione Antidoto Repellente Fune Fuga Caramella
Rara Lotta LOTTA Zaino ZAINO Fuga FUGA Strumenti STRUMENTI Salva SALVA
Opzioni OPZIONI Esci ESCI Compra COMPRA Vendi VENDI Sì SÌ No NO Annulla
Allenatore Allenatrice Palestra Medaglia Rivale Centro Market Biancavilla
Smeraldopoli Plumbeopoli Celestopoli Albanova Bici Mappa
`
  }
};

const words = (s) => s.split(/\s+/u).filter(Boolean);

// Accent- and case-insensitive key ("POKéMON" == "pokemon").
export function wordKey(w) {
  return String(w || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const known = new Map();
function knownSet(lang) {
  if (!known.has(lang)) {
    const entry = LANGS[lang] || { common: '', game: '' };
    const all = [...words(SHARED), ...words(entry.common), ...words(entry.game)];
    known.set(lang, new Set(all.map(wordKey)));
  }
  return known.get(lang);
}

// Languages with a curated list.
export const VOCAB_LANGS = Object.keys(LANGS);

// Game words (not the common words - Hunspell already knows those) to add
// to the spell-checker. Each word is listed as written plus lowercase, since
// Hunspell treats "Tackle" and "tackle" as different words.
export function gameWords(lang) {
  const entry = LANGS[lang];
  const out = new Set();
  for (const w of [...words(SHARED), ...(entry ? words(entry.game) : [])]) {
    const clean = w.replace(/[!?.,]+$/u, '');
    if (!clean) continue;
    out.add(clean);
    out.add(clean.toLowerCase());
  }
  return [...out];
}

// Whether a word is in the curated list for the language (or the shared
// game terms). Ignores case and accents.
export function isKnownWord(word, lang) {
  const key = wordKey(word);
  if (!key) return false;
  return knownSet(lang).has(key);
}
