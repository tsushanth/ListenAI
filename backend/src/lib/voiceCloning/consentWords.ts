// Code-word lists for the non-English consent phrases. Common, concrete nouns that are easy to read aloud and that a
// transcriber spells one way. Written with their real spelling (accents show in the phrase; matching ignores accents).
// Each list is checked by consentPhrase.test.ts: no duplicates, at least 4 letters, and no two words within one
// letter of each other, so the one-letter tolerance in codeWordHeard can never map a heard word onto two list words.

export const CODE_WORDS_ES = [
  'abeja', 'aceite', 'almendra', 'amarillo', 'anillo', 'arena', 'ballena', 'banana', 'barco', 'bosque', 'botella',
  'caballo', 'cabeza', 'cadena', 'calle', 'camino', 'campana', 'canela', 'cascada', 'castillo', 'cebolla', 'cereza',
  'cielo', 'ciudad', 'cocina', 'cohete', 'conejo', 'corona', 'cuaderno', 'cuchara', 'ensalada', 'escalera', 'espejo',
  'estrella', 'fresa', 'galleta', 'gallina', 'gaviota', 'girasol', 'guitarra', 'hormiga', 'huevo', 'isla', 'jirafa',
  'lagarto', 'leche', 'lechuga', 'leopardo', 'libreta', 'linterna', 'llave', 'lluvia', 'lobo', 'maleta', 'mantel',
  'manzana', 'mariposa', 'martillo', 'melón', 'montaña', 'naranja', 'nieve', 'nube', 'nuez', 'oveja', 'palmera',
  'pantalón', 'papel', 'paraguas', 'pelota', 'pepino', 'pescado', 'pimienta', 'piscina', 'planeta', 'plátano',
  'playa', 'puente', 'puerta', 'queso', 'rana', 'ratón', 'reloj', 'ropa', 'sandia', 'semilla', 'serpiente', 'silla',
  'sombrero', 'tambor', 'tarde', 'taza', 'tenedor', 'tiburón', 'tigre', 'tomate', 'toalla', 'tormenta', 'tortuga',
  'trigo', 'trueno', 'ventana', 'verde', 'violín', 'vela', 'volcán', 'zanahoria', 'zapato', 'zorro', 'abrigo',
  'arroz', 'azul', 'bandera', 'bolsa', 'bufanda', 'café', 'camisa', 'cuchillo', 'dinero', 'espada', 'flauta',
  'frasco', 'fuego', 'gafas', 'jabón', 'laguna', 'lápiz', 'libro', 'luna', 'madera', 'mesa', 'moneda', 'mono',
  'mundo', 'pájaro', 'pastel', 'pecera', 'pizarra', 'radio', 'tijeras', 'vaso', 'viento',
];

export const CODE_WORDS_DE = [
  'apfel', 'birne', 'tisch', 'stuhl', 'fenster', 'garten', 'wiese', 'berg', 'fluss', 'wolke', 'sonne', 'stern',
  'regen', 'schnee', 'feuer', 'wasser', 'kuchen', 'zucker', 'honig', 'milch', 'pfeffer', 'tomate', 'banane',
  'orange', 'zitrone', 'kirsche', 'erdbeere', 'himbeere', 'pilz', 'kartoffel', 'gurke', 'zwiebel', 'spinat', 'salat',
  'nudel', 'suppe', 'teller', 'gabel', 'messer', 'tasse', 'flasche', 'koffer', 'rucksack', 'mantel', 'jacke',
  'schuhe', 'handschuh', 'schal', 'kleid', 'hose', 'hund', 'katze', 'pferd', 'ziege', 'huhn', 'ente', 'gans',
  'frosch', 'schlange', 'adler', 'eule', 'tiger', 'igel', 'fuchs', 'wolf', 'affe', 'delfin', 'spinne', 'ameise',
  'hafen', 'insel', 'strand', 'wald', 'schloss', 'markt', 'strasse', 'bahnhof', 'flughafen', 'schiff', 'fahrrad',
  'motor', 'rakete', 'laterne', 'kerze', 'lampe', 'spiegel', 'buch', 'heft', 'stift', 'papier', 'glocke', 'trommel',
  'geige', 'klavier', 'gitarre', 'trompete', 'ball', 'drachen', 'ballon', 'kette', 'krone', 'schatz', 'karte',
  'brief', 'gelb', 'blau', 'schwarz', 'weiss', 'braun', 'silber', 'gold', 'lilie', 'tulpe', 'blume', 'baum', 'blatt',
  'gras', 'sand', 'wüste', 'meer', 'quelle', 'hügel', 'dorf', 'stadt', 'haus', 'dach', 'treppe', 'zimmer', 'bett',
  'kissen', 'decke', 'teppich', 'vorhang', 'schrank', 'regal', 'sofa', 'radio', 'telefon', 'kamera', 'brille',
  'hammer', 'nagel', 'schraube', 'leiter', 'eimer', 'seife', 'bürste', 'schwamm', 'handtuch', 'faden', 'knopf',
  'tasche', 'geldbeutel', 'münze', 'fahne', 'segel', 'anker', 'kompass', 'fernglas', 'zelt',
];
