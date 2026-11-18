// BirdWatchAI Classroom — English + Español on the board
//
// A per-class switch (🇪🇸 in the stage footer) that puts a Spanish line
// under the question and under each answer, and a Spanish line on the
// reveal. The English stays: this is for a bilingual or dual-language room
// and for children learning English, who are helped by seeing both, not by
// losing the English. Read aloud reads both when it is on.
//
// SCOPE: K-2 first. Every K-2 template has an entry below, and the harness
// (tools/check-classroom.js) reports how many built K-2 questions came out
// with Spanish. Older bands get Spanish wherever a template is shared with
// K-2 and its prompt matches; otherwise just English, never a half-guess.
//
// HOW IT TRANSLATES
// Questions are built from live data, so a prompt is not a fixed string:
// "How many Blue Jays came this week?" carries a species, "62 birds came on
// Wednesday November 18th" a number and a date. Each template therefore has
// a pattern that pulls the data out of the English and a function that puts
// it into the Spanish. A prompt that does not match its pattern gets no
// Spanish at all: a missing line is better than a wrong one in front of a
// class.
//
// WHAT IS NOT TRANSLATED, ON PURPOSE
// Questions about English words themselves (syllables, compound words,
// alphabetical order, unscrambling, the words birders put to songs). Their
// answer depends on the English spelling, so a Spanish version would ask a
// different question with the wrong answer. They get a one-line note
// instead: "Pregunta sobre palabras en inglés".
//
// Bird names: the Spanish names used in Mexico and the US (as in field
// guides such as Peterson / Sibley en español). A bird not on the list keeps
// its English name in the Spanish line.

// ── Words ────────────────────────────────────────────────

const ES_BIRDS = {
    'Northern Cardinal': 'Cardenal norteño', 'Blue Jay': 'Chara azul',
    'Tufted Titmouse': 'Carbonero copetón', 'Carolina Wren': 'Saltapared de Carolina',
    'Mourning Dove': 'Paloma huilota', 'House Finch': 'Pinzón mexicano',
    'Downy Woodpecker': 'Carpintero pubescente', 'Hairy Woodpecker': 'Carpintero velloso',
    'Red-bellied Woodpecker': 'Carpintero de vientre rojo', 'Northern Flicker': 'Carpintero de pechera',
    'Pileated Woodpecker': 'Carpintero crestado',
    'American Goldfinch': 'Jilguero canario', 'Lesser Goldfinch': 'Jilguero dominico',
    'Pine Siskin': 'Jilguero pinero', 'Purple Finch': 'Pinzón purpúreo',
    'Carolina Chickadee': 'Carbonero de Carolina', 'Black-capped Chickadee': 'Carbonero de capucha negra',
    'Northern Mockingbird': 'Cenzontle norteño', 'American Robin': 'Mirlo primavera',
    'House Sparrow': 'Gorrión doméstico', 'European Starling': 'Estornino pinto',
    'White-breasted Nuthatch': 'Bajapalos pechiblanco', 'Red-breasted Nuthatch': 'Bajapalos canadiense',
    'Dark-eyed Junco': 'Junco ojo oscuro', 'Song Sparrow': 'Gorrión cantor',
    'Chipping Sparrow': 'Gorrión ceja blanca', 'White-throated Sparrow': 'Gorrión garganta blanca',
    'White-crowned Sparrow': 'Gorrión corona blanca',
    'Common Grackle': 'Zanate común', 'Boat-tailed Grackle': 'Zanate de pantano',
    'Red-winged Blackbird': 'Tordo sargento', 'Brown-headed Cowbird': 'Tordo cabeza café',
    'Eastern Bluebird': 'Azulejo garganta canela', 'Eastern Towhee': 'Rascador oriental',
    'Barred Owl': 'Búho barrado', 'Great Horned Owl': 'Búho cornudo',
    'Ruby-throated Hummingbird': 'Colibrí garganta rubí', 'Bee Hummingbird': 'Colibrí zunzuncito',
    'Rock Pigeon': 'Paloma doméstica', 'Eurasian Collared-Dove': 'Paloma de collar turca',
    'Gray Catbird': 'Maullador gris', 'Brown Thrasher': 'Cuitlacoche rojizo',
    'Painted Bunting': 'Colorín sietecolores', 'Indigo Bunting': 'Colorín azul',
    'American Crow': 'Cuervo americano', 'Fish Crow': 'Cuervo pescador',
    "Cooper's Hawk": 'Gavilán de Cooper', 'Cooper’s Hawk': 'Gavilán de Cooper',
    'Red-tailed Hawk': 'Aguililla cola roja', 'Peregrine Falcon': 'Halcón peregrino',
    'Yellow-rumped Warbler': 'Chipe rabadilla amarilla', 'Cedar Waxwing': 'Ampelis chinito',
    'American Woodcock': 'Chocha americana', 'Sandhill Crane': 'Grulla gris',
    'Rose-breasted Grosbeak': 'Picogrueso pecho rosa', 'Baltimore Oriole': 'Bolsero de Baltimore',
    'Summer Tanager': 'Piranga roja', 'Scarlet Tanager': 'Piranga escarlata',
    'Carolina Parakeet': 'Cotorra de Carolina', 'Passenger Pigeon': 'Paloma migratoria',
    'Flamingo': 'Flamenco', 'American Flamingo': 'Flamenco americano',
    'Superb Lyrebird': 'Ave lira soberbia', 'Budgerigar': 'Periquito australiano',
    'Arctic Tern': 'Charrán ártico', 'Wild Turkey': 'Guajolote silvestre',
    'Killdeer': 'Chorlo tildío', 'Mallard': 'Pato de collar', 'Canada Goose': 'Ganso canadiense',
};

const ES_DAYS = { Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles', Thursday: 'jueves',
                  Friday: 'viernes', Saturday: 'sábado', Sunday: 'domingo' };
const ES_DAYS_SHORT = { Mon: 'lun', Tue: 'mar', Wed: 'mié', Thu: 'jue', Fri: 'vie', Sat: 'sáb', Sun: 'dom' };
const ES_MONTHS = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo',
                    June: 'junio', July: 'julio', August: 'agosto', September: 'septiembre',
                    October: 'octubre', November: 'noviembre', December: 'diciembre' };

const ES_COLORS = { red: 'rojo', 'black and white': 'blanco y negro', brown: 'café', yellow: 'amarillo',
                    black: 'negro', gray: 'gris', grey: 'gris', orange: 'anaranjado', blue: 'azul',
                    green: 'verde', white: 'blanco', purple: 'morado', pink: 'rosado' };

// Answers that are fixed sentences in their templates.
const ES_FIXED = {
    'Yes': 'Sí', 'No': 'No', 'Morning': 'Por la mañana', 'Afternoon': 'Por la tarde',
    'Even': 'Par', 'Odd': 'Impar', 'Warm': 'Cálido', 'Cool': 'Frío',
    'About the same': 'Más o menos igual', 'Fewer than today': 'Menos que hoy', 'More than today': 'Más que hoy',
    'Our feeder': 'Nuestro comedero',
    'Eating': 'Comiendo', 'Looking around': 'Mirando alrededor', 'Flying away': 'Volando',
    'A puppy': 'Un cachorro', 'A chick': 'Un pollito', 'A kitten': 'Un gatito', 'A calf': 'Un becerro',
    'Feathers': 'Plumas', 'Fur': 'Pelo', 'Scales': 'Escamas', 'Shells': 'Conchas',
    'Only food': 'Solo comida', 'Only water': 'Solo agua', 'Food, water and a safe place': 'Comida, agua y un lugar seguro',
    'Toys to play with': 'Juguetes para jugar',
    'The Equator': 'El ecuador', 'The North Pole': 'El Polo Norte', 'The South Pole': 'El Polo Sur',
    'The Prime Meridian': 'El meridiano de Greenwich',
    'The big bird': 'El pájaro grande', 'The small bird': 'El pájaro pequeño',
    'They sound the same': 'Suenan igual', 'It depends on the weather': 'Depende del tiempo',
    'We built it correctly': 'Lo hicimos bien', 'We needed another go': 'Necesitamos otro intento',
    'What colors it has': 'Qué colores tiene', 'Whether it has babies': 'Si tiene crías',
    'How old it is': 'Cuántos años tiene', 'What it ate for breakfast': 'Qué desayunó',
    'How many birds came each day': 'Cuántos pájaros vinieron cada día',
    'How many different kinds of bird came': 'Cuántas clases de pájaros vinieron',
    'What the weather was each day': 'Qué tiempo hizo cada día',
    'What time of day the birds came': 'A qué hora vinieron los pájaros',
    'A compass rose, so you know which way is north': 'Una rosa de los vientos, para saber dónde está el norte',
    'A list of the days of the week': 'Una lista de los días de la semana',
    'A photograph of every bird': 'Una foto de cada pájaro',
    'The names of everyone who looked at it': 'Los nombres de todos los que lo miraron',
    'Because they can find food, water and shelter here': 'Porque aquí encuentran comida, agua y refugio',
    'Because they like our school': 'Porque les gusta nuestra escuela',
    'Because somebody told them to come': 'Porque alguien les dijo que vinieran',
    'Because every animal can live anywhere': 'Porque todos los animales pueden vivir en cualquier lugar',
    'Because we would forget, and a record can be checked': 'Porque se nos olvidaría, y un registro se puede revisar',
    'Because it makes the birds come back': 'Porque hace que los pájaros vuelvan',
    'Because it is a rule': 'Porque es una regla', 'Because the birds want us to': 'Porque los pájaros quieren',
    'Down the middle, head to tail': 'Por el medio, de la cabeza a la cola',
    'Across the middle, side to side': 'De lado a lado, por el medio',
    'Corner to corner': 'De esquina a esquina', 'A bird has no line of symmetry': 'Un pájaro no tiene eje de simetría',
    'They look exactly like their parents': 'Son exactamente iguales a sus padres',
    'They look mostly like their parents, but not exactly': 'Se parecen a sus padres, pero no del todo',
    'They look nothing like their parents': 'No se parecen nada a sus padres',
    'They choose what they will look like': 'Ellos eligen cómo van a ser',
    'Close to the same, but not exactly the same': 'Parecido, pero no exactamente igual',
    'Exactly the same every time': 'Exactamente igual cada vez',
    'Completely different every time': 'Totalmente distinto cada vez',
    'It would stop working': 'Dejaría de funcionar',
    'Watch it again together and agree how to count': 'Verlo otra vez juntos y ponerse de acuerdo en cómo contar',
    'Watch it again together and count out loud': 'Verlo otra vez juntos y contar en voz alta',
    'The bigger number must be right': 'El número más grande tiene que ser el correcto',
    'The group that finished first is right': 'El grupo que terminó primero tiene razón',
    'The one who finished first is right': 'El que terminó primero tiene razón',
    'The one who counted more is right': 'El que contó más tiene razón',
    'Nobody can ever know': 'Nadie lo puede saber', 'Stop counting and pick a number': 'Dejar de contar y elegir un número',
    'Show them the photo the camera took': 'Enseñarle la foto que tomó la cámara',
    'Guess again tomorrow': 'Adivinar otra vez mañana', 'Ask them to believe you': 'Pedirle que te crea',
    'Say it louder': 'Decirlo más fuerte',
    'They say the same thing in two different ways': 'Dicen lo mismo de dos maneras distintas',
    'The chart is right and the words are wrong': 'La gráfica está bien y las palabras están mal',
    'The words are right and the chart is wrong': 'Las palabras están bien y la gráfica está mal',
    'They are about different birds': 'Hablan de pájaros distintos',
    'Pitch — how high or low a sound is': 'Tono: qué tan agudo o grave es un sonido',
    'Tempo — how fast it goes': 'Tempo: qué tan rápido va',
    'Dynamics — how loud it is': 'Intensidad: qué tan fuerte suena',
    'Timbre — what kind of thing is making it': 'Timbre: qué cosa lo produce',
    'Pitched, like a xylophone — you could sing it back': 'Con tono, como un xilófono: lo podrías cantar',
    'Unpitched, like a drum — you could not sing it': 'Sin tono, como un tambor: no lo podrías cantar',
    'It is both at the same time': 'Es las dos cosas a la vez', 'It is silent': 'No suena',
    'It repeats the same few notes over and over': 'Repite las mismas notas una y otra vez',
    'It gets faster and faster until it stops': 'Va cada vez más rápido hasta parar',
    'Every part of it is different': 'Cada parte es distinta',
    'It is one long note that never changes': 'Es una nota larga que nunca cambia',
    'It stays at exactly the same speed all the way through': 'Va a la misma velocidad todo el tiempo',
    'It starts fast and then slows right down': 'Empieza rápido y luego va muy despacio',
    'It starts slow and then speeds up into a trill': 'Empieza despacio y luego acelera en un trino',
    'It stops and starts at random': 'Para y arranca sin orden',
    // Wonders
    'Over 200 mph': 'Más de 320 km/h (200 mph)',
    'About 20 mph - a fast bicycle': 'Unos 32 km/h (20 mph): una bicicleta rápida',
    'About 50 mph - a car on the highway': 'Unos 80 km/h (50 mph): un coche en la carretera',
    'About 100 mph - a fastball times two': 'Unos 160 km/h (100 mph): dos veces una bola rápida',
    'About 2 inches': 'Unos 5 cm (2 pulgadas)', 'About half an inch': 'Poco más de 1 cm (media pulgada)',
    'About 6 inches - a pencil': 'Unos 15 cm (6 pulgadas): un lápiz',
    'About 12 inches - a ruler': 'Unos 30 cm (12 pulgadas): una regla',
    'To tell her mate when to bring food': 'Para avisar a su pareja cuándo traer comida',
    'To frighten away cats': 'Para asustar a los gatos', 'To keep her eggs warm': 'Para mantener calientes sus huevos',
    'To call the chicks out': 'Para llamar a los pollitos',
    'About three quarters of a circle': 'Unas tres cuartas partes de un círculo',
    'About a quarter of a circle': 'Un cuarto de círculo', 'Halfway round': 'Media vuelta',
    'All the way round': 'La vuelta completa',
    'Spider silk': 'Seda de araña', 'Mud': 'Barro', 'Its own feathers': 'Sus propias plumas', 'Tree sap': 'Savia de árbol',
    'The food it eats': 'La comida que come', 'The sun': 'El sol',
    'The salty water it stands in': 'El agua salada donde se para', 'It is born pink underneath': 'Nace rosado por debajo',
    'Blue shields the chick from sun': 'El azul protege al pollito del sol', 'To match the sky': 'Para combinar con el cielo',
    'Because robins eat blueberries': 'Porque los petirrojos comen arándanos', 'To look like a stone': 'Para parecer una piedra',
    'To make worms move so it can feel them': 'Para que los gusanos se muevan y pueda sentirlos',
    'To keep warm': 'Para calentarse', 'To scare off rivals': 'Para asustar a sus rivales',
    'To look bigger than it is': 'Para parecer más grande',
    'All year, not only when courting': 'Todo el año, no solo en el cortejo',
    'Only in spring': 'Solo en primavera', 'Only when they are frightened': 'Solo cuando tienen miedo',
    'Only the young ones dance': 'Solo bailan los jóvenes',
};

/** "Tuesday November 17th" → "martes 17 de noviembre", "Mon 11/16" → "lun 16/11". */
function esDates(t) {
    return String(t)
        .replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th)?\b/g,
                 (m, d, mo, n) => `${ES_DAYS[d]} ${n} de ${ES_MONTHS[mo]}`)
        .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2})\/(\d{1,2})\b/g,
                 (m, d, mo, n) => `${ES_DAYS_SHORT[d]} ${n}/${mo}`)
        .replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, d => ES_DAYS[d]);
}

const ES_DAYS_FROM_SHORT = { Mon: 'lunes', Tue: 'martes', Wed: 'miércoles', Thu: 'jueves', Fri: 'viernes', Sat: 'sábado', Sun: 'domingo' };
/** "Tue 11/17" in a sentence → "martes 17/11". */
function esLongDay(t) {
    return String(t).replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2})\/(\d{1,2})\b/g,
        (m, d, mo, n) => `${ES_DAYS_FROM_SHORT[d]} ${n}/${mo}`);
}

function esBird(name) { return ES_BIRDS[name] || name; }
/** A bird name inside a sentence, plural "Blue Jays" folded back to "Blue Jay". */
function esBirdIn(name) {
    if (ES_BIRDS[name]) return ES_BIRDS[name];
    if (/s$/.test(name) && ES_BIRDS[name.slice(0, -1)]) return ES_BIRDS[name.slice(0, -1)];
    return name;
}
// Spanish bird names that are feminine nouns, by their first word.
const ES_FEMININE = new Set(['Chara', 'Paloma', 'Chocha', 'Grulla', 'Cotorra', 'Piranga', 'Aguililla',
                             'Golondrina', 'Garza', 'Calandria', 'Codorniz', 'Gallina', 'Urraca']);
/** "el Cardenal norteño", "la Chara azul"; "un" / "una" with indef. */
function esArt(english, indef) {
    const name = esBirdIn(english);
    const fem = ES_FEMININE.has(String(name).split(' ')[0]);
    return `${indef ? (fem ? 'una' : 'un') : (fem ? 'la' : 'el')} ${name}`;
}

function esFeeder(name) {
    const m = String(name).match(/^(.*)’s feeder$/);
    return m ? `el comedero de ${m[1]}` : name;
}

/** One answer, or null when there is nothing safe to say. */
function esChoice(label) {
    const l = String(label);
    if (ES_FIXED[l]) return ES_FIXED[l];
    if (ES_BIRDS[l]) return ES_BIRDS[l];
    if (ES_COLORS[l]) return ES_COLORS[l];
    if (/^\d[\d,.]*$/.test(l)) return l;
    let m;
    if ((m = l.match(/^about (\d[\d,.]*)$/i))) return `unos ${m[1]}`;
    if ((m = l.match(/^(\d{1,2}) o’clock$/))) return `las ${m[1]}`;
    if ((m = l.match(/^(\d{1,2}) (am|pm)$/i))) return `${m[1]} ${m[2].toLowerCase() === 'am' ? 'a. m.' : 'p. m.'}`;
    if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/.test(l)) return esDates(l);
    if ((m = l.match(/^(.*)’s feeder$/))) return `El comedero de ${m[1]}`;
    return null;
}

// ── Prompts, by template ─────────────────────────────────
//
// [pattern, (match) => Spanish]. The pattern must match the WHOLE English
// prompt; anything else gets no Spanish line.

const ES_ENGLISH_ONLY = new Set(['word-jumble', 'lang-alphabetical', 'music-match-written']);
const ES_ENGLISH_ONLY_PREFIX = ['lang-', 'sound-'];

const ES_PROMPTS = {
    'id-snapshot':        [/^Which bird came to our feeder\?$/, () => '¿Qué pájaro vino a nuestro comedero?'],
    'clip-which-bird':    [/^Watch the video\. Which bird is it\?$/, () => 'Mira el video. ¿Qué pájaro es?'],
    'which-bird-is-color':[/^Which of these birds is (.+)\?$/, m => ES_COLORS[m[1]] ? `¿Cuál de estos pájaros es ${ES_COLORS[m[1]]}?` : null],
    'what-color-is':      [/^What color is an? (.+)\?$/, m => `¿De qué color es ${esArt(m[1])}?`],
    'spot-the-feature':   [/^Which bird has (.+)\?$/, m => ES_FEATURES[m[1]] ? `¿Qué pájaro tiene ${ES_FEATURES[m[1]]}?` : null],
    'odd-one-out':        [/^Three of these birds came to the feeder this week\. Which one did NOT\?$/,
                           () => 'Tres de estos pájaros vinieron al comedero esta semana. ¿Cuál NO vino?'],
    'build-tally':        [/^The table says how many DAYS each bird came\. Build the chart to match — one mark for every day\.$/,
                           () => 'La tabla dice cuántos DÍAS vino cada pájaro. Haz la gráfica igual: una marca por cada día.'],
    'penpal-both-saw':    [/^Which bird came to our feeder AND to (.+)’s feeder this week\?$/,
                           m => `¿Qué pájaro vino a nuestro comedero Y al comedero de ${m[1]} esta semana?`],
    'penpal-more-visits': [/^(?:Our pen-pal class watches (.+)\. )?Which feeder had more bird visits this week\?$/,
                           () => '¿Qué comedero tuvo más visitas de pájaros esta semana?'],
    'music-pitched-unpitched': [/^Instruments are pitched, like a xylophone, or unpitched, like a drum\. Listen to this bird\. Which is it most like\?$/,
                           () => 'Los instrumentos tienen tono, como un xilófono, o no tienen tono, como un tambor. Escucha este pájaro. ¿A cuál se parece más?'],
    'ten-more-ten-less':  [/^There were (\d+) visits on (.+)\. What is TEN (MORE|LESS) than (\d+)\?$/,
                           m => `Hubo ${m[1]} visitas el ${esDates(m[2])}. ¿Cuánto es DIEZ ${m[3] === 'MORE' ? 'MÁS' : 'MENOS'} que ${m[4]}?`],
    'map-elements':       [/^We use a map to find where our feeders are\. What does every good map need\?$/,
                           () => 'Usamos un mapa para encontrar nuestros comederos. ¿Qué necesita todo buen mapa?'],
    // "How many cardinals came" counts visits, which is how Spanish says it
    // without pluralising a two-word bird name.
    'count-one-species':  [/^How many (.+) came this week\?$/, m => `¿Cuántas veces vino ${esArt(m[1])} esta semana?`],
    'music-high-or-low':  [/^Listen to this bird, then think of a crow\. Which part of music is most different between them\?$/,
                           () => 'Escucha este pájaro y luego piensa en un cuervo. ¿Qué parte de la música es más distinta entre los dos?'],
    'round-to-ten':       [/^(\d+) birds came on (.+)\. Rounded to the nearest TEN, about how many is that\?$/,
                           m => `${m[1]} pájaros vinieron el ${esDates(m[2])}. Redondeado a la DECENA más cercana, ¿cuántos son más o menos?`],
    'chart-and-words':    [/^The chart shows our week\. The words say: "(.+) was our busiest day\." How do the picture and the words go together\?$/,
                           m => `La gráfica muestra nuestra semana. Las palabras dicen: "El ${esLongDay(m[1])} fue nuestro día con más pájaros". ¿Cómo se relacionan la imagen y las palabras?`],
    'habitat-needs':      [/^Birds come to our feeder, but a fish could not live here\. Why do the birds come\?$/,
                           () => 'Los pájaros vienen a nuestro comedero, pero un pez no podría vivir aquí. ¿Por qué vienen los pájaros?'],
    'keeping-records':    [/^Our feeder writes down every bird it sees\. Why is that a good idea\?$/,
                           () => 'Nuestro comedero anota cada pájaro que ve. ¿Por qué es una buena idea?'],
    'morning-or-afternoon': [/^Did more birds come in the morning or the afternoon\?$/,
                           () => '¿Vinieron más pájaros por la mañana o por la tarde?'],
    'observe-carefully':  [/^Look at our photo carefully\. Which of these can you find out just by LOOKING\?$/,
                           () => 'Mira nuestra foto con cuidado. ¿Cuál de estas cosas puedes saber solo MIRANDO?'],
    'art-symmetry':       [/^A bird seen from the front is symmetrical\. Where is its line of symmetry\?$/,
                           () => 'Un pájaro visto de frente es simétrico. ¿Dónde está su eje de simetría?'],
    'music-pitch':        [/^A tiny chickadee and a big crow are both calling\. Which one makes the HIGHER sound\?$/,
                           () => 'Un carbonero pequeñito y un cuervo grande están cantando. ¿Cuál hace el sonido más AGUDO?'],
    'art-color-match':    [/^Which color matches this bird\?$/, () => '¿Qué color combina con este pájaro?'],
    'music-tempo-change': [/^Listen to the whole phrase\. What happens to the SPEED inside it\?$/,
                           () => 'Escucha toda la frase. ¿Qué pasa con la VELOCIDAD?'],
    'most-common-week':   [/^Which bird came the most times this week\?$/, () => '¿Qué pájaro vino más veces esta semana?'],
    'parents-and-variation': [/^When baby birds grow up, what do they look like\?$/,
                           () => 'Cuando los pajaritos crecen, ¿cómo son?'],
    'ordinal-rank':       [/^Put the birds in order, most visits first\. Which bird is (first|second|third|fourth)\?$/,
                           m => `Ordena los pájaros, primero el que tuvo más visitas. ¿Cuál es el ${{ first: 'primero', second: 'segundo', third: 'tercero', fourth: 'cuarto' }[m[1]]}?`],
    'music-same-or-different': [/^Listen to the (chickadee|sparrow)\. What happens to its pattern\?$/,
                           m => `Escucha al ${m[1] === 'chickadee' ? 'carbonero' : 'gorrión'}. ¿Qué pasa con su patrón?`],
    'repeat-the-count':   [/^We count the birds at our feeder every day\. If we do it again next week, what should we expect\?$/,
                           () => 'Contamos los pájaros de nuestro comedero cada día. Si lo hacemos otra vez la semana que viene, ¿qué debemos esperar?'],
    'equator-poles':      [/^Some birds fly south every winter to stay warm\. What is the name of the line around the middle of the Earth, where it is (?:hottest|warmest)\?$/,
                           () => 'Algunos pájaros vuelan al sur cada invierno para estar calientes. ¿Cómo se llama la línea alrededor del medio de la Tierra, donde hace más calor?'],
    'two-step-k2':        [/^(\d+) birds came on (.+) and (\d+) came on (.+)\. If (\d+) of them flew away again, how many were left\?$/,
                           m => `${m[1]} pájaros vinieron el ${esDates(m[2])} y ${m[3]} el ${esDates(m[4])}. Si ${m[5]} se volaron, ¿cuántos quedaron?`],
    'picto-read':         [/^Use the key\. About how many times did an? (.+) visit\?$/,
                           m => `Usa la clave. ¿Más o menos cuántas veces vino ${esArt(m[1])}?`],
    'more-or-fewer':      [/^Did more (.+) or more (.+) come this week\?$/,
                           m => `¿Quién vino más veces esta semana: ${esArt(m[1])} o ${esArt(m[2])}?`],
    'same-tools-different-counts': [/^Two groups watched this same clip\. One counted (\d+) birds and one counted (\d+)\. What should they do\?$/,
                           m => `Dos grupos vieron el mismo video. Uno contó ${m[1]} pájaros y otro contó ${m[2]}. ¿Qué deben hacer?`],
    'how-do-you-know':    [/^You tell a friend an? (.+) came to our feeder\. They ask, "how do you know\?" What is the best thing to do\?$/,
                           m => `Le dices a un amigo que ${esArt(m[1], true)} vino a nuestro comedero. Te pregunta: "¿Cómo lo sabes?". ¿Qué es lo mejor que puedes hacer?`],
    'sci-baby-bird':      [/^A baby dog is a puppy\. What is a baby bird called\?$/,
                           () => 'Un perro bebé es un cachorro. ¿Cómo se llama un pájaro bebé?'],
    'clip-what-doing':    [/^Watch the bird\. What is it doing most of the time\?$/,
                           () => 'Mira el pájaro. ¿Qué hace la mayor parte del tiempo?'],
    'chart-title':        [/^Someone rubbed out the title\. What is this chart showing\?$/,
                           () => 'Alguien borró el título. ¿Qué muestra esta gráfica?'],
    'sci-what-birds-need':[/^Every living thing needs the same few things to stay alive\. What do the birds at our feeder need\?$/,
                           () => 'Todos los seres vivos necesitan las mismas cosas para vivir. ¿Qué necesitan los pájaros de nuestro comedero?'],
    'art-missing-color':  [/^Look at the chart\. Which of these colors was NOT on any bird at our feeder this week\?$/,
                           () => 'Mira la gráfica. ¿Qué color NO tenía ningún pájaro de nuestro comedero esta semana?'],
    'how-many-days':      [/^On how many days did birds come to the feeder\?$/, () => '¿Cuántos días vinieron pájaros al comedero?'],
    'sci-feathers':       [/^Cats have fur and fish have scales\. What covers a bird\?$/,
                           () => 'Los gatos tienen pelo y los peces tienen escamas. ¿Qué cubre a un pájaro?'],
    'partner-count':      [/^Watch with your partner\. Both of you count the birds on your own — no talking\. Now compare\. If your numbers are different, what should you do\?$/,
                           () => 'Mira con tu compañero. Cuenten los pájaros cada uno por su cuenta, sin hablar. Ahora comparen. Si sus números son distintos, ¿qué deben hacer?'],
    'day-difference-k2':  [/^How many more visits were there on (.+) than on (.+)\?$/,
                           m => `¿Cuántas visitas más hubo el ${esDates(esLongDay(m[1]))} que el ${esDates(esLongDay(m[2]))}?`],
    'art-pattern':        [/^Artists look for pattern: stripes, spots, bars\. Which of our birds has (.+)\?$/,
                           m => ES_FEATURES[m[1]] ? `Los artistas buscan patrones: rayas, manchas, franjas. ¿Cuál de nuestros pájaros tiene ${ES_FEATURES[m[1]]}?` : null],
    'predict-tomorrow':   [/^Today (.+) had (\d+) bird visits\. Will tomorrow have more or fewer\?$/,
                           m => `Hoy ${m[1]} tuvo ${m[2]} visitas de pájaros. ¿Mañana tendrá más o menos?`],
    'odd-or-even':        [/^(\d+) birds came on (.+)\. Is (\d+) an odd number or an even number\?$/,
                           m => `${m[1]} pájaros vinieron el ${esDates(m[2])}. ¿${m[3]} es un número par o impar?`],
    'did-it-visit':       [/^Did an? (.+) come to the feeder this week\?$/,
                           m => `¿Vino ${esArt(m[1], true)} al comedero esta semana?`],
    'art-warm-cool':      [/^Artists call red, orange and yellow WARM colors, and blue and gray COOL colors\. The (.+) is (.+)\. Is that (?:a )?warm or (?:a )?cool(?: color)?\?$/,
                           m => ES_COLORS[m[2]] ? `Los artistas llaman CÁLIDOS al rojo, al anaranjado y al amarillo, y FRÍOS al azul y al gris. ${esArt(m[1]).replace(/^./, c => c.toUpperCase())} es ${ES_COLORS[m[2]]}. ¿Es un color cálido o frío?` : null],
    'clock-hour':         [/^The birds were busiest at this time\.\s*Look at the clock — what time is it\?$/,
                           () => 'A esta hora vinieron más pájaros. Mira el reloj: ¿qué hora es?'],
    'total-visits':       [/^How many birds came on (.+)\?$/, m => `¿Cuántos pájaros vinieron el ${esDates(m[1])}?`],
    'count-one-day':      [/^How many birds came on (.+)\?$/, m => `¿Cuántos pájaros vinieron el ${esDates(m[1])}?`],
    'busiest-day':        [/^Which day did the most birds come\?$/, () => '¿Qué día vinieron más pájaros?'],
    'order-the-days':     [/^If we put the days in order from FEWEST birds to MOST, which day comes last\?$/,
                           () => 'Si ordenamos los días de MENOS pájaros a MÁS, ¿qué día queda al final?'],
    // Wonders
    'wonder-peregrine':        [/^How fast can a Peregrine Falcon go in that dive\?$/, () => '¿Qué tan rápido puede ir un halcón peregrino en esa caída?'],
    'wonder-bee-hummingbird':  [/^How long is a Bee Hummingbird from beak to tail\?$/, () => '¿Cuánto mide un colibrí zunzuncito del pico a la cola?'],
    'wonder-cardinal-female-sings': [/^Why do people think the female cardinal sings from the nest\?$/, () => '¿Por qué se cree que la hembra del cardenal canta desde el nido?'],
    'wonder-owl-neck':         [/^How far around can an owl turn its head\?$/, () => '¿Cuánto puede girar la cabeza un búho?'],
    'wonder-hummingbird-nest': [/^What does a hummingbird use to hold its nest together\?$/, () => '¿Qué usa un colibrí para mantener su nido unido?'],
    'wonder-flamingo-pink':    [/^Where does a flamingo’s pink come from\?$/, () => '¿De dónde viene el color rosado del flamenco?'],
    'wonder-robin-egg':        [/^Why might a robin’s egg be blue rather than white\?$/, () => '¿Por qué el huevo del petirrojo podría ser azul y no blanco?'],
    'wonder-woodcock-walk':    [/^Why do people think the woodcock rocks like that\?$/, () => '¿Por qué se cree que la chocha se mece así?'],
    'wonder-crane-dance':      [/^When do Sandhill Cranes dance\?$/, () => '¿Cuándo bailan las grullas grises?'],
};

// The story before a wonder question, which a teacher reads aloud.
const ES_INTROS = {
    'wonder-peregrine': ['El animal más rápido del planeta no es el guepardo. Es un pájaro.',
        'El halcón peregrino caza subiendo muy alto sobre su presa; luego pliega las alas y se deja caer.'],
    'wonder-bee-hummingbird': ['El pájaro más pequeño del mundo vive en Cuba y se llama colibrí zunzuncito, porque la gente de verdad lo confunde con una abeja.',
        'Hace un nido del tamaño de una cáscara de nuez.'],
    'wonder-cardinal-female-sings': ['En la mayoría de los pájaros cantores solo canta el macho. El cardenal norteño es una excepción.',
        'La hembra también canta, muchas veces desde el nido, y ella y su pareja se contestan.'],
    'wonder-owl-neck': ['Un búho no puede mover los ojos. Están fijos en su cráneo como dos telescopios, así que para mirar a un lado tiene que girar toda la cabeza.',
        'Es muy bueno girando la cabeza.'],
    'wonder-hummingbird-nest': ['El nido de un colibrí es del tamaño de media cáscara de nuez, y los huevos son del tamaño de un chícharo.',
        'El nido tiene que estirarse cuando crecen los pollitos, así que está hecho de algo muy especial.'],
    'wonder-flamingo-pink': ['Los pollitos de flamenco nacen grises. El rosado llega después.',
        'Un flamenco de zoológico que come la comida equivocada se pone pálido y blanco.'],
    'wonder-robin-egg': ['"Azul huevo de petirrojo" es el nombre de un color de pinturas y crayones, porque el huevo del petirrojo de verdad es así de azul.',
        'El color no está pintado. Se hace dentro de la mamá.'],
    'wonder-woodcock-walk': ['La chocha americana es un pájaro café y gordito que caza gusanos en la tierra blanda, y tiene una costumbre muy rara.',
        'Antes de avanzar, mece todo el cuerpo hacia adelante y hacia atrás, una y otra vez, con la cabeza quieta.'],
    'wonder-crane-dance': ['Las grullas grises bailan. Hacen reverencias, saltan con las alas abiertas y lanzan palitos y pasto por encima de la cabeza.',
        'Las parejas bailan juntas y se quedan juntas toda la vida.'],
};

// Field marks as spot-the-feature and art-pattern write them.
const ES_FEATURES = {
    'a pointy crest on its head': 'un copete puntiagudo en la cabeza',
    'a black cap and a black bib': 'una gorra negra y un babero negro',
    'a little gray crest': 'un copetito gris',
    'a white stripe over its eye and a tail that points up': 'una raya blanca sobre el ojo y la cola levantada',
    'a red head and chest': 'la cabeza y el pecho rojos',
    'black wings with white bars': 'alas negras con franjas blancas',
    'a blue crest and a black necklace': 'un copete azul y un collar negro',
    'a long pointed tail': 'una cola larga y puntiaguda',
    'a chisel beak for tapping wood': 'un pico como cincel para picar madera',
    'a red cap and zebra stripes on its back': 'una gorra roja y rayas de cebra en la espalda',
    'walking DOWN the tree head first': 'la costumbre de bajar por el árbol de cabeza',
    'a gray cap and a black bib': 'una gorra gris y un babero negro',
    'shiny feathers with little white spots': 'plumas brillantes con manchitas blancas',
    'an orange tummy': 'la pancita anaranjada',
    'gray on top and white underneath': 'gris por arriba y blanco por abajo',
    'white flashes in its wings when it flies': 'destellos blancos en las alas cuando vuela',
};

// ── Applying it ──────────────────────────────────────────

function esIsEnglishOnly(id) {
    return ES_ENGLISH_ONLY.has(id) || ES_ENGLISH_ONLY_PREFIX.some(p => String(id).startsWith(p));
}

/**
 * The Spanish for one built question: { prompt, choices[], intro[] } or
 * { englishOnly: true }, or null when there is none. Cached on the question.
 */
function esForQuestion(q) {
    if (!q) return null;
    if (q.cc_es !== undefined) return q.cc_es;
    let out = null;
    try {
        if (esIsEnglishOnly(q.template_id)) {
            out = { englishOnly: true };
        } else {
            const rule = ES_PROMPTS[q.template_id];
            const m = rule && String(q.prompt || '').match(rule[0]);
            const prompt = m ? rule[1](m) : null;
            if (prompt) {
                out = {
                    prompt,
                    choices: (q.choices || []).map(c => esChoice(c.label)),
                    intro: ES_INTROS[q.template_id] || null,
                };
            }
        }
    } catch { out = null; }
    q.cc_es = out;
    return out;
}

function esOn(room) {
    if (!room) return false;
    try { return localStorage.getItem('cc-es-' + room.id) === '1'; } catch { return false; }
}

function esSet(on) {
    const S = classroomSession;
    if (!S) return;
    try { localStorage.setItem('cc-es-' + S.room.id, on ? '1' : '0'); } catch { /* fine */ }
    renderClassroomStage();
}

function esActive(S, q) {
    return S && esOn(S.room) ? esForQuestion(q) : null;
}

/** Under the English prompt. */
function esPromptHtml(S, q) {
    const es = esActive(S, q);
    if (!es) return '';
    if (es.englishOnly) return '<p class="cc-es cc-es-note" lang="es">Pregunta sobre palabras en inglés</p>';
    return `${es.intro ? es.intro.map(t => `<p class="cc-es cc-es-intro" lang="es">${esc(t)}</p>`).join('') : ''}
            <p class="cc-es cc-es-prompt" lang="es">${esc(es.prompt)}</p>`;
}

/** Under one answer's English label. */
function esChoiceHtml(S, q, i) {
    const es = esActive(S, q);
    if (!es || es.englishOnly || !es.choices) return '';
    const t = es.choices[i];
    const en = q.choices && q.choices[i] ? String(q.choices[i].label) : '';
    return t && t !== en ? `<span class="cc-es cc-es-choice" lang="es">${esc(t)}</span>` : '';
}

/** On the reveal, under the verdict. */
function esRevealHtml(S, q) {
    const es = esActive(S, q);
    if (!es || es.englishOnly) return '';
    let line;
    if (q.poll) line = 'No hay una sola respuesta correcta. ¿Qué observaron?';
    else if (q.correct_index == null) line = 'Respuesta guardada. La revisamos en la próxima clase.';
    else {
        const right = (es.choices && es.choices[q.correct_index]) || String(q.choices[q.correct_index].label);
        line = `${q.class_index === q.correct_index ? '¡La clase acertó!' : 'Casi.'} La respuesta es: ${right}.`;
    }
    return `<div class="cc-es cc-es-reveal" lang="es">${esc(line)}</div>`;
}

/** The switch, in the stage foot. */
function esControlsHtml(S) {
    if (!S) return '';
    return `<label class="cc-voice-auto" title="Show Spanish under the English (K-2 questions)">
        <input type="checkbox" ${esOn(S.room) ? 'checked' : ''} onchange="esSet(this.checked)"> Español</label>`;
}

/** What Read aloud says in Spanish after the English, or ''. */
function esSpeech(S, q) {
    const es = esActive(S, q);
    if (!es || es.englishOnly) return '';
    if (!S.revealed) {
        const parts = [...(es.intro || []), es.prompt];
        const ch = (es.choices || []).filter(Boolean);
        if (!q.build && !q.grid && ch.length === (q.choices || []).length && ch.length >= 2 && ch.length <= 6) {
            parts.push(ch.slice(0, -1).join(', ') + ' o ' + ch[ch.length - 1] + '?');
        }
        return parts.join(' ');
    }
    const el = document.createElement('div');
    el.innerHTML = esRevealHtml(S, q);
    return el.textContent || '';
}
