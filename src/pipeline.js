import { config } from './config.js';
import { extractListings } from './extract.js';
import { resolveCounty } from './geo.js';
import { loadState, addressKey } from './store.js';
import { ESTADOS } from './leads.js';

const ADDRESS_STATUS = { complete: 'COMPLETA', partial: 'PARCIAL', missing: 'SIN DIRECCION' };
export const ALERTA_DIRECCION = 'Solicitar dirección al wholesaler';

/**
 * Alerta del lead según lo que falta pedirle al wholesaler: dirección (Pendiente dirección), precio
 * y precio. El ARV no se pide: el wholesaler no lo envía después (sin ARV no se evalúan los criterios
 * y el Tier 1 se decide a mano).
 */
export function computeAlerta(lead) {
  const falta = [];
  if (lead.estado === ESTADOS.pendienteDireccion) falta.push('dirección');
  if (!lead.precio_usd) falta.push('precio');
  if (!falta.length) return '';
  const lista = falta.length > 1 ? `${falta.slice(0, -1).join(', ')} y ${falta.at(-1)}` : falta[0];
  return `Solicitar ${lista} al wholesaler`;
}

/** % of ARV: precio / ARV * 100 (1 decimal). null si falta precio o ARV. */
export function pctArv({ precio_usd: precio, arv_usd: arv }) {
  if (!precio || !arv) return null;
  return Math.round((precio / arv) * 1000) / 10;
}

/**
 * Criterios de Tier 1 automático: % of ARV <= critPctArvMax y precio < critPrecioMax.
 * califica: true | false | null (falta precio o ARV). motivo: por qué no califica.
 */
export function evaluarCriterios(lead) {
  const pct = pctArv(lead);
  if (pct === null) return { califica: null, pct, motivo: '' };
  const fallos = [];
  if (pct > config.critPctArvMax) fallos.push(`${pct}% of ARV > ${config.critPctArvMax}%`);
  if (lead.precio_usd >= config.critPrecioMax) fallos.push(`precio ≥ $${config.critPrecioMax.toLocaleString('en-US')}`);
  return { califica: !fallos.length, pct, motivo: fallos.join(' y ') };
}

export function inTargetCounty(county) {
  return Boolean(county) && config.targetCounties.some((t) => t.toLowerCase() === county.toLowerCase());
}

/**
 * Reglas de entrada (docs/PLAN-FLUJO-LEADS.md):
 *  sin calle y sin ARV -> descartar | sin calle con ARV -> Pendiente dirección (o descartar si la ciudad es de otro condado)
 *  con calle: condado objetivo -> Nuevo | otro condado -> descartar | sin determinar -> Revisar condado
 * @returns {{ estado: string, alerta?: string } | { descartar: string }}
 */
export function classify(listing, geo) {
  if (!listing.street_address) {
    if (!listing.arv_usd) return { descartar: 'sin dirección ni ARV' };
    // Sin calle pero con ciudad conocida: si es de otro condado tampoco entra
    if (geo.county && !geo.ambiguous && !inTargetCounty(geo.county)) return { descartar: `fuera de condado (${geo.county})` };
    return { estado: ESTADOS.pendienteDireccion, alerta: ALERTA_DIRECCION };
  }
  if (!geo.county || geo.ambiguous) return { estado: ESTADOS.revisarCondado };
  return inTargetCounty(geo.county) ? { estado: ESTADOS.nuevo } : { descartar: `fuera de condado (${geo.county})` };
}

/**
 * Procesa una publicación cruda y devuelve los leads que entran y los descartes automáticos.
 * @param {{id, timestamp, groupName, sender, text, images}} post
 * @param {{extract?: Function, geocode?: Function}} deps  (inyectables para pruebas)
 * @returns {Promise<{rows: object[], descartes: {motivo, direccion, ciudad}[]}>}
 */
export async function processPost(post, deps = {}) {
  const extract = deps.extract || extractListings;
  const geocode = deps.geocode || resolveCounty;
  const state = await loadState();
  const now = new Date().toISOString();
  const out = { rows: [], descartes: [] };

  if (post.id && state.seenMessageIds[post.id]) return out;

  const result = await extract(post);
  if (!result.is_property_listing) return out;

  for (const l of result.listings) {
    const geo = await geocode(l);
    const decision = classify(l, geo);
    if (decision.descartar) {
      out.descartes.push({ motivo: decision.descartar, direccion: l.street_address, ciudad: l.city });
      continue;
    }

    const key = addressKey(l, geo);
    let first = key ? state.addresses[key] : null;
    if (key && !first) state.addresses[key] = { at: post.timestamp, group: post.groupName, id: post.id };
    if (first && first.id === post.id) first = null; // reintento del mismo mensaje, no es duplicado

    out.rows.push({
      estado: decision.estado,
      alerta: computeAlerta({ estado: decision.estado, precio_usd: l.price_usd, arv_usd: l.arv_usd }),
      pct_arv: pctArv({ precio_usd: l.price_usd, arv_usd: l.arv_usd }),
      fecha_mensaje: post.timestamp,
      grupo: post.groupName,
      autor: post.sender,
      condado: geo.county,
      estado_direccion: ADDRESS_STATUS[l.address_status],
      direccion: l.street_address,
      ciudad: l.city,
      zip: l.zip || geo.zip,
      direccion_verificada: geo.matchedAddress,
      metodo_condado: geo.method,
      precio_usd: l.price_usd,
      arv_usd: l.arv_usd,
      beds: l.beds,
      baths: l.baths,
      sqft: l.sqft,
      lote_sqft: l.lot_sqft,
      anio: l.year_built,
      tipo: l.property_type,
      tipo_negocio: l.deal_type,
      condicion: l.condition,
      contacto: l.contact_name,
      telefono: l.contact_phone,
      email: l.contact_email,
      links_fotos: l.photo_links,
      links_portales: l.portal_links,
      resumen: l.summary,
      texto_ocr: result.ocr_text || '',
      duplicado: first ? `SI (visto ${first.at} en ${first.group})` : 'NO',
      mensaje_original: l.segment || post.text, // con varias propiedades, solo el bloque de esta
      imagenes_locales: (post.images || []).map((i) => i.path),
      id_mensaje: post.id,
      clave_direccion: key,
      procesado_en: now,
    });
  }

  return out;
}

/**
 * Valida una dirección que el usuario obtuvo del wholesaler.
 * enZona: true (condado objetivo) | false (otro condado) | null (no se pudo determinar)
 */
export async function resolveManualAddress({ calle, ciudad, zip }, deps = {}) {
  const geocode = deps.geocode || resolveCounty;
  const clean = (v) => String(v ?? '').trim() || null;
  const listing = { street_address: clean(calle), city: clean(ciudad), zip: clean(zip), state: 'FL' };
  if (!listing.street_address) throw Object.assign(new Error('La dirección debe incluir número y calle'), { status: 400 });
  const geo = await geocode(listing);
  const enZona = !geo.county || geo.ambiguous ? null : inTargetCounty(geo.county);
  return { listing, geo, key: addressKey(listing, geo), enZona };
}
