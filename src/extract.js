// Extracción por reglas (sin APIs): dirección, ciudad, ZIP, precio, beds/baths, sqft, contacto y links.
// Diseñado para anuncios típicos en inglés/español de grupos de inversionistas del sur de Florida.
import { KNOWN_CITIES, countyFromZip } from './counties.js';
import { ocrImages } from './ocr.js';
import { config } from './config.js';

const DIRS = 'N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest';
const SUFFIXES = [
  'St', 'Street', 'Ave', 'Av', 'Avenue', 'Rd', 'Road', 'Dr', 'Drive', 'Blvd', 'Boulevard', 'Ct', 'Court', 'Ln', 'Lane',
  'Way', 'Ter', 'Terr', 'Terrace', 'Pl', 'Place', 'Cir', 'Circle', 'Hwy', 'Highway', 'Pkwy', 'Parkway', 'Trl', 'Trail',
  'Path', 'Run', 'Pt', 'Point', 'Sq', 'Square', 'Loop', 'Row', 'Cv', 'Cove', 'Xing', 'Crossing', 'Pass', 'Plz', 'Plaza',
  'Walk', 'Isle', 'Bnd', 'Bend', 'Glen', 'Grv', 'Grove', 'Holw', 'Hollow', 'Lndg', 'Landing', 'Mnr', 'Manor', 'Pike',
  'Rdg', 'Ridge', 'Tpke', 'Turnpike', 'Vw', 'View', 'Vis', 'Vista', 'Cswy', 'Causeway', 'Aly', 'Alley',
].join('|');
const UNIT = String.raw`(?:\s*,?\s*(?:Unit|Apt|Apartment|Suite|Ste|#)\s*#?\s*[\w-]+)?`;
// número + (dirección cardinal) + 0-4 palabras + sufijo (+ cardinal) | rutas como A1A / US-1 / US Hwy 1
// Los espacios son [ \t] (no \s): una calle no cruza saltos de línea. El número no puede venir pegado a
// un precio u otro número ("$485,000\n1025 N H St" no debe dar "000 1025 N H St").
const STREET_RE = new RegExp(
  String.raw`(?<![\d$,.])\b(\d{1,6}[A-Za-z]?)[ \t]+((?:(?:${DIRS})\.?[ \t]+)?(?:[A-Za-z0-9'.-]+[ \t]+){0,4}?(?:${SUFFIXES})\.?(?:[ \t]+(?:${DIRS})\.?(?![A-Za-z]))?` +
  String.raw`|(?:(?:${DIRS})\.?[ \t]+)?(?:A1A|US[- ]?(?:Hwy|Highway)?[ \t]?1|(?:State Road|SR|US Highway|US Hwy)[ \t]?\d{1,3}|Federal Hwy|Dixie Hwy))\b${UNIT}`,
  'gi',
);
// Secciones de comparables: desde una línea "Comps" hasta "Terms"/"Photos" o el final. Sus direcciones no son la propiedad.
const COMPS_START_RE = /^[\s*•#-]*(?:comps?|comparables?|comparable\s+sales|sold\s+comps?)\b.*$/gim;
const COMPS_END_RE = /^[\s*•#-]*(?:terms?|t[eé]rminos|photos?|fotos|contact(?:o)?|asking|price|precio)\b/im;
const SOLD_LINE_RE = /\b(?:sold|vendid[ao])\b/i;
// Palabras que indican que el "número + palabras" no es una calle (p. ej. "2 family home on quiet street").
const STREET_STOPWORDS = /\b(bed|beds|bd|br|bath|baths|ba|car|garage|home|house|family|story|stories|units?|acres?|years?|with|on|the|and|for|in|of|to|near|close|from|quiet|corner|hab|baños|banos|casa|en|de|la|el|y|con|days?|min|minutes|blocks?|miles?)\b/i;

const DIR_SET = new Set(DIRS.toLowerCase().split('|'));
const SUFFIX_SET = new Set(SUFFIXES.toLowerCase().split('|'));
const ROUTE_RE = new RegExp(String.raw`^(?:(?:${DIRS})\.?\s+)?(?:A1A|US\b|State Road|SR\s*\d|Federal Hwy|Dixie Hwy)`, 'i');
// Nombres de calle reales de 1-2 letras (artículos y abreviaturas) que no son ruido de OCR
const NOMBRE_CORTO_OK = new Set(['la', 'le', 'el', 'de', 'du', 'di', 'da', 'lo', 'st', 'mt', 'ft']);

/**
 * ¿La dirección tiene un nombre de calle creíble? Filtra el ruido del OCR de los flyers ("1 Sr", "4 Rd",
 * "20 Od Gal Rd SE", "5 Ie Le RF A St"). Nombre = lo que queda sin número, unidad, cardinales de los extremos
 * ni el sufijo final. Válido: una sola letra (calles de Lake Worth: "211 N E St"), ordinales ("20th"),
 * o palabras de 3+ letras (se admiten artículos como "La", "De").
 */
export function esCalleValida(street) {
  const resto = String(street || '').replace(/\s*,?\s*(?:Unit|Apt|Apartment|Suite|Ste|#).*$/i, '').trim()
    .replace(/^\d{1,6}[A-Za-z]?\s+/, '');
  if (ROUTE_RE.test(resto)) return true;
  const toks = resto.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  if (toks.length && DIR_SET.has(toks[0].toLowerCase()) && toks.length > 2) toks.shift();
  if (toks.length && DIR_SET.has(toks.at(-1).toLowerCase()) && toks.length > 2) toks.pop();
  if (toks.length && SUFFIX_SET.has(toks.at(-1).toLowerCase())) toks.pop();
  if (!toks.length) return false;
  if (toks.length === 1 && /^[A-Za-z]$/.test(toks[0])) return true;
  const ordinal = (t) => /^\d+(?:st|nd|rd|th)$/i.test(t);
  return toks.every((t) => ordinal(t) || /^[A-Za-z'-]{3,}$/.test(t) || NOMBRE_CORTO_OK.has(t.toLowerCase()))
    && toks.some((t) => ordinal(t) || /[A-Za-z]{3,}/.test(t));
}

const ZIP_RE = /\b(3[234]\d{3})(?:-\d{4})?\b/g;
const PHONE_RE = /(?<![\d$])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b(?:zillow|redfin|realtor|trulia|homes)\.com\/[^\s<>"')\]]+/gi;

const PORTAL_DOMAINS = /zillow|redfin|realtor\.com|trulia|homes\.com|mls|matrix|flexmls|loopnet|crexi|auction\.com|hubzu|xome|homesnap|compass\.com|movoto|propstream|beachesmls|miamirealtors/i;
const PHOTO_DOMAINS = /drive\.google|docs\.google|photos\.app\.goo\.gl|photos\.google|dropbox|icloud|onedrive|1drv\.ms|box\.com|imgur|flickr|wetransfer|we\.tl|youtu|matterport|vimeo|canva|instagram|facebook\.com\/media|fb\.watch/i;

// Ciudades que son también palabras comunes: no se buscan sueltas en el texto.
const RISKY_CITY_WORDS = new Set(['golf', 'rio', 'acreage', 'the acreage', 'boca', 'dania', 'pompano', 'psl', 'wpb', 'westlake', 'sunrise', 'plantation', 'atlantis']);

/** "$325k" -> 325000 ; "1.2M" -> 1200000 ; "$325,000" -> 325000 */
export function parseMoney(num, unit) {
  if (!num) return null;
  let n = Number(String(num).replace(/,/g, '').replace(/\.(?=\d{3}\b)/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (unit || '').toLowerCase();
  if (u === 'k') n *= 1e3;
  else if (['m', 'mm', 'million', 'mil', 'millones'].includes(u)) n *= 1e6;
  return Math.round(n);
}

const MONEY = String.raw`\$?\s*(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k|mm|m|million|millones|mil)?\b`;
const PRICE_LABEL_RE = new RegExp(String.raw`(?:asking(?:\s+price)?|price|precio(?:\s+de\s+venta)?|list(?:ed)?\s*(?:price|at)?|sale\s+price|purchase\s+price|contract\s+price|selling\s+for|offered\s+at|venta|pide|piden)\s*[:\-–=]?\s*${MONEY}`, 'i');
const ARV_RE = new RegExp(String.raw`\bARV\s*(?:of|de|is|es)?\s*[:\-–=]?\s*(?:~|aprox\.?|approx\.?)?\s*${MONEY}`, 'i');
const DOLLAR_RE = new RegExp(String.raw`\$\s*(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k|mm|m|million|millones|mil)?\b`, 'gi');
const NOT_PRICE_CONTEXT = /(arv|rent|renta|alquiler|repair|rehab|reparaci|fee|emd|deposit|dep[oó]sito|taxes?|impuestos|hoa|insurance|seguro|\/\s*mo|per\s+month|mensual|profit|ganancia|spread|comps?)\W*$/i;

function findPrice(text) {
  const labeled = PRICE_LABEL_RE.exec(text);
  if (labeled) {
    const v = parseMoney(labeled[1], labeled[2]);
    if (v >= 10000) return v;
  }
  for (const m of text.matchAll(DOLLAR_RE)) {
    const before = text.slice(Math.max(0, m.index - 25), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (NOT_PRICE_CONTEXT.test(before) || /^\s*(\/\s*mo|per\s+month|mensual|a\s+month|al\s+mes)/i.test(after)) continue;
    const v = parseMoney(m[1], m[2]);
    if (v >= 10000) return v;
  }
  return null;
}

function findArv(text) {
  const m = ARV_RE.exec(text);
  const v = m ? parseMoney(m[1], m[2]) : null;
  return v >= 10000 ? v : null;
}

function findBedsBaths(text) {
  let beds = null;
  let baths = null;
  const b1 = /(\d+(?:\.\d)?)\s*(?:-\s*)?(?:bed(?:room)?s?|bd|br|bdr|hab(?:itaciones|s)?\.?|cuartos|rec[aá]maras|dormitorios)\b/i.exec(text);
  const b2 = /(\d+(?:\.\d)?)\s*(?:-\s*)?(?:bath(?:room)?s?|ba|bth|baños|banos)\b/i.exec(text);
  if (b1) beds = Number(b1[1]);
  if (b2) baths = Number(b2[1]);
  if (beds === null || baths === null) {
    // "3/2", "3/2.5", "4/2/1" (beds/baths/garage). Excluye fechas (10/5/26) y precios.
    const slash = /(?<![\d/.$])([1-9])\s?\/\s?([1-9](?:\.5)?)(?:\s?\/\s?\d)?(?![\d/])/.exec(text);
    if (slash) {
      beds ??= Number(slash[1]);
      baths ??= Number(slash[2]);
    }
  }
  return { beds, baths };
}

function findSqft(text) {
  let sqft = null;
  let lot = null;
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:\+\s*)?(?:sq\.?\s?ft\.?|sqft|sf|square\s+f(?:ee|oo)t|ft2|ft²|pies(?:\s+cuadrados)?|p2)(?![a-z])/gi)) {
    const v = Number(m[1].replace(/,/g, ''));
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/lot|lote|terreno|land/i.test(before)) lot ??= v;
    else sqft ??= v;
  }
  const lotLabel = /\b(?:lot(?:\s+size)?|lote|terreno)\s*[:\-–]?\s*(\d{1,3}(?:,\d{3})+|\d{3,7})\b/i.exec(text);
  if (lotLabel && lot === null) lot = Number(lotLabel[1].replace(/,/g, ''));
  const acres = /(\d+(?:\.\d+)?)\s*(?:acres?|acre)\b/i.exec(text);
  if (acres && lot === null) lot = Math.round(Number(acres[1]) * 43560);
  return { sqft, lot };
}

function findYear(text) {
  const m = /(?:built(?:\s+in)?|year\s+built|yr\s+built|yb|constru(?:ida|ido|cci[oó]n)(?:\s+en)?|a[ñn]o)\s*[:\-–]?\s*((?:19|20)\d{2})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

function findPropertyType(text) {
  const t = text.toLowerCase();
  if (/\b(duplex|d[uú]plex|triplex|fourplex|quadplex|4-?plex|3-?plex|multi-?\s?family|multifamiliar|\d+\s*units?\b|\d+\s*unidades)/.test(t)) return 'multifamily';
  if (/\b(condo|condominium|condominio|apartamento|apartment)\b/.test(t)) return 'condo';
  if (/\b(townhouse|townhome|town\s?house|villa)\b/.test(t)) return 'townhouse';
  if (/\b(mobile\s+home|manufactured|trailer|casa\s+m[oó]vil)\b/.test(t)) return 'mobile_home';
  if (/\b(commercial|comercial|retail|warehouse|bodega|office\s+building|strip\s+mall|mixed\s+use)\b/.test(t)) return 'commercial';
  if (/\b(vacant\s+(?:lot|land)|land\s+for\s+sale|buildable\s+lot|terreno|lote\s+bald[ií]o|raw\s+land)\b/.test(t)) return 'land';
  if (/\b(single[\s-]?family|sfh|sfr|casa|house|home|residence|residencia)\b/.test(t)) return 'single_family';
  return 'unknown';
}

function findDealType(text) {
  const t = text.toLowerCase();
  if (/\b(auction|subasta|foreclosure\s+sale)\b/.test(t)) return 'auction';
  if (/(off[\s-]?market|pocket\s+listing|fuera\s+(?:del?\s+)?mercado)/.test(t)) return 'off_market';
  if (/\b(wholesale|assignment|assign|cash\s+buyers?\s+only|emd|double\s+close|mayorista)\b/.test(t)) return 'wholesale';
  if (/\b(mls|listed|active\s+listing|listado)\b/.test(t)) return 'mls_listing';
  if (/\b(for\s+rent|for\s+lease|se\s+(?:alquila|renta)|en\s+alquiler|en\s+renta)\b/.test(t)) return 'rental';
  return 'unknown';
}

function findCondition(text) {
  const found = new Set();
  const re = /\b(needs?\s+(?:full|major|light|some|minor|cosmetic)?\s*(?:rehab|work|tlc|repairs?)|tlc|fixer(?:[\s-]?upper)?|handyman\s+special|turn[\s-]?key|move[\s-]?in\s+ready|fully\s+(?:remodeled|renovated|updated)|remodeled|renovated|updated|as[\s-]is|new\s+roof|roof\s+\d{4}|gut\s+job|cosmetic|necesita\s+(?:reparaciones|remodelaci[oó]n|trabajo)|remodelad[ao]|para\s+remodelar|lista\s+para\s+habitar)\b/gi;
  for (const m of text.matchAll(re)) found.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  return found.size ? [...found].join(', ') : null;
}

function findContacts(text) {
  const phones = new Set();
  for (const m of text.matchAll(PHONE_RE)) phones.add(`(${m[1]}) ${m[2]}-${m[3]}`);
  const emails = [...new Set(text.match(EMAIL_RE) || [])];
  const name = /(?<![A-Za-z])(?:[Cc]ontact(?:o|ar)?|CONTACT|[Cc]all|[Tt]ext|[Ll]lamar\s+a|[Ee]scribir(?:le)?\s+a|[Aa]gent(?:e)?|[Aa]sk\s+for|[Pp]regunta(?:r)?\s+por)\s*[:\-–]?\s*(?:me\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/.exec(text);
  return { phones: [...phones], emails, name: name ? name[1] : null };
}

function findLinks(text) {
  const photo = [];
  const portal = [];
  const other = [];
  for (const raw of text.match(URL_RE) || []) {
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (PHOTO_DOMAINS.test(url)) photo.push(url);
    else if (PORTAL_DOMAINS.test(url)) portal.push(url);
    else other.push(url);
  }
  return { photo: [...new Set(photo)], portal: [...new Set(portal)], other: [...new Set(other)] };
}

/** Busca una ciudad conocida dentro del texto (la primera que aparece). */
export function findCity(text, { allowRisky = false } = {}) {
  const t = ` ${text.toLowerCase().replace(/[.’']/g, '').replace(/\bft\s/g, 'fort ').replace(/\bst\s(?=lucie)/g, 'saint ').replace(/[^a-záéíóúñ0-9]+/g, ' ')} `;
  let best = null;
  for (const c of KNOWN_CITIES) {
    if (!allowRisky && RISKY_CITY_WORDS.has(c)) continue;
    const idx = t.indexOf(` ${c} `);
    if (idx >= 0 && (!best || idx < best.idx)) best = { city: c, idx };
  }
  return best ? titleCase(best.city) : null;
}

function findZip(text, { strict = true } = {}) {
  for (const m of text.matchAll(ZIP_RE)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/[$,.\d]\s*$/.test(before) && !/\b(fl|florida)\W*$/i.test(before)) continue; // parte de un precio o número
    if (!strict || /\b(fl|florida)\W*$/i.test(before) || countyFromZip(m[1]).county) return m[1];
  }
  return null;
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Encuentra direcciones de calle con su ciudad/ZIP cercanos. */
/** Rangos [inicio, fin) del texto que son secciones de comparables. */
function compsRanges(text) {
  const ranges = [];
  for (const m of text.matchAll(COMPS_START_RE)) {
    const from = m.index + m[0].length;
    const end = COMPS_END_RE.exec(text.slice(from));
    ranges.push([m.index, end ? from + end.index : text.length]);
  }
  return ranges;
}

export function findAddresses(text) {
  const out = [];
  const comps = compsRanges(text);
  for (const m of text.matchAll(STREET_RE)) {
    if (comps.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const lineEnd = text.indexOf('\n', m.index);
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, lineEnd < 0 ? undefined : lineEnd);
    if (SOLD_LINE_RE.test(line)) continue; // comparable vendido
    const street = m[0].replace(/\s+/g, ' ').trim();
    const nameWords = m[2] || '';
    if (STREET_STOPWORDS.test(nameWords)) continue;
    if (/^\d{4}$/.test(m[1]) && /^(19|20)/.test(m[1]) && !/\s/.test(nameWords.trim())) continue; // "2024 St" improbable
    if (!esCalleValida(street)) continue; // ruido del OCR
    // Ciudad / estado / ZIP suelen venir justo después (misma línea o la siguiente)
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 90).split('\n').slice(0, 2).join(' ');
    const zip = findZip(tail, { strict: false });
    let city = findCity(tail.split(/\b(?:FL|Florida)\b/i)[0], { allowRisky: true });
    if (!city) {
      const c = /^\s*,?\s*([A-Za-z][A-Za-z .'-]{2,30}?)\s*,?\s*(?:FL|Florida)\b/i.exec(tail);
      if (c) city = titleCase(c[1].trim().toLowerCase());
    }
    const state = /\b(FL|Florida)\b/i.test(tail) ? 'FL' : null;
    out.push({ street_address: titleCaseStreet(street), city, zip, state, index: m.index });
  }
  // Quitar repetidos (misma calle mencionada dos veces)
  const seen = new Set();
  return out.filter((a) => {
    const k = a.street_address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function titleCaseStreet(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Nw|Ne|Sw|Se)\b/g, (d) => d.toUpperCase()).replace(/\bA1a\b/g, 'A1A').replace(/\bUs\b/g, 'US');
}

const TYPE_ES = {
  single_family: 'Casa', condo: 'Condo', townhouse: 'Townhouse', multifamily: 'Multifamiliar',
  land: 'Terreno', commercial: 'Comercial', mobile_home: 'Casa móvil', other: 'Propiedad', unknown: 'Propiedad',
};

function buildListing(segment, address, whole, { multi = false } = {}) {
  const { beds, baths } = findBedsBaths(segment);
  const { sqft, lot } = findSqft(segment);
  const contacts = findContacts(segment);
  const wholeContacts = findContacts(whole);
  const links = findLinks(segment);
  const city = address?.city || findCity(segment) || findCity(whole);
  const zip = address?.zip || findZip(segment) || null;
  const price = findPrice(segment);
  // Con varias propiedades en un mensaje, el tipo se toma solo de su segmento (no del mensaje completo).
  const segType = findPropertyType(segment);
  const property_type = segType !== 'unknown' || multi ? segType : findPropertyType(whole);
  const segDeal = findDealType(segment);
  const deal_type = segDeal !== 'unknown' ? segDeal : findDealType(whole);

  let address_status = 'missing';
  if (address && (city || zip)) address_status = 'complete';
  else if (address || city || zip) address_status = 'partial';

  const parts = [TYPE_ES[property_type]];
  if (beds || baths) parts.push(`${beds ?? '?'}/${baths ?? '?'}`);
  if (city) parts.push(`en ${city}`);
  if (price) parts.push(`- $${price.toLocaleString('en-US')}`);
  if (deal_type === 'off_market') parts.push('(off-market)');

  return {
    street_address: address?.street_address || null,
    city,
    state: address?.state || (city || zip ? 'FL' : null),
    zip,
    address_status,
    price_usd: price,
    arv_usd: findArv(segment),
    beds,
    baths,
    sqft,
    lot_sqft: lot,
    year_built: findYear(segment),
    property_type,
    deal_type,
    condition: findCondition(segment),
    contact_name: contacts.name || wholeContacts.name,
    contact_phone: (contacts.phones.length ? contacts.phones : wholeContacts.phones).join(', ') || null,
    contact_email: (contacts.emails.length ? contacts.emails : wholeContacts.emails).join(', ') || null,
    photo_links: links.photo.length ? links.photo : findLinks(whole).photo,
    portal_links: [...links.portal, ...links.other],
    summary: parts.join(' '),
    segment: multi ? segment.trim() : null,
  };
}

const LISTING_HINT = /\b(sale|venta|vendo|se\s+vende|for\s+sale|asking|price|precio|arv|off[\s-]?market|wholesale|deal|investor|inversi[oó]n|cash|flip|rehab|bed|bath|sqft|duplex|condo|townhouse|single\s+family|casa|propiedad|property|listing|mls)\b/i;

/** Extrae los anuncios de una publicación (texto + OCR opcional de imágenes). */
export async function extractListings(post, { ocr = config.ocrEnabled } = {}) {
  let ocrText = '';
  if (ocr && post.images?.length) ocrText = await ocrImages(post.images.map((i) => i.path));
  const text = [post.text || '', ocrText].filter(Boolean).join('\n');

  const addresses = findAddresses(text);
  const hasPrice = findPrice(text) !== null;
  const isListing = addresses.length > 0 ? (hasPrice || LISTING_HINT.test(text)) : (hasPrice && LISTING_HINT.test(text));
  if (!isListing) return { is_property_listing: false, listings: [], ocr_text: ocrText };

  if (addresses.length <= 1) {
    return { is_property_listing: true, listings: [buildListing(text, addresses[0], text)], ocr_text: ocrText };
  }
  // Varias direcciones: cada segmento va desde el inicio de la línea de una dirección hasta la siguiente.
  const starts = addresses.map((a) => text.lastIndexOf('\n', a.index) + 1);
  const listings = addresses.map((a, i) => buildListing(text.slice(starts[i], starts[i + 1] ?? text.length), a, text, { multi: true }));
  return { is_property_listing: true, listings, ocr_text: ocrText };
}
