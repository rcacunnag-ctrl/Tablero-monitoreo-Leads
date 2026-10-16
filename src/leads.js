// Almacén de leads activos: data/leads.json. Los descartados se borran; solo queda su dirección
// normalizada en `descartados` para que no vuelvan a entrar si se republican.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const ESTADOS = {
  nuevo: 'Nuevo',
  pendienteDireccion: 'Pendiente dirección',
  revisarCondado: 'Revisar condado',
  noCalifica: 'No califica',
  tier1: 'Tier 1',
  tier2: 'Tier 2',
  compra: 'Compra',
};

let db;
let lock = Promise.resolve();

/** Serializa los cambios: el colector y el panel escriben desde el mismo proceso. */
export function withLeads(fn) {
  const run = lock.then(async () => {
    const data = await loadLeads();
    const out = await fn(data);
    await save(data);
    return out;
  });
  lock = run.catch(() => {});
  return run;
}

export async function loadLeads() {
  if (db) return db;
  try {
    db = JSON.parse(await fs.readFile(config.leadsFile, 'utf8'));
  } catch {
    db = { leads: [], descartados: {} };
  }
  db.leads ||= [];
  db.descartados ||= {};
  return db;
}

async function save(data) {
  await fs.mkdir(path.dirname(config.leadsFile), { recursive: true });
  const tmp = `${config.leadsFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, config.leadsFile);
}

export async function listLeads() {
  return (await loadLeads()).leads;
}

const HORAS_CORRECCION = 48;
const unidad = (d) => (/(?:#|\bUnit\b|\bApt\b|\bSuite\b|\bSte\b)\s*#?\s*([\w-]+)/i.exec(d || '') || [])[1]?.toUpperCase() || '';
const calleSinNumero = (d) => String(d || '').replace(/\s*,?\s*(?:#|\bUnit\b|\bApt\b|\bSuite\b|\bSte\b).*$/i, '')
  .replace(/^\d{1,6}[A-Za-z]?\s+/, '').trim().toUpperCase();

/**
 * ¿El anuncio nuevo corrige la dirección de uno anterior? Mismo autor y grupo, mismo precio y ARV, misma
 * calle y unidad, otro número, dentro de 48 h (p. ej. "731 SE 15th St #513" -> "1731 SE 15th St #513").
 */
function esCorreccion(previo, row) {
  if (!previo.direccion || !row.direccion || previo.direccion === row.direccion) return false;
  if (previo.autor !== row.autor || previo.grupo !== row.grupo) return false;
  if (!row.precio_usd || !row.arv_usd || previo.precio_usd !== row.precio_usd || previo.arv_usd !== row.arv_usd) return false;
  if (unidad(previo.direccion) !== unidad(row.direccion) || calleSinNumero(previo.direccion) !== calleSinNumero(row.direccion)) return false;
  const horas = (new Date(row.fecha_mensaje) - new Date(previo.fecha_mensaje)) / 36e5;
  return horas >= 0 && horas <= HORAS_CORRECCION;
}

const CAMPOS_DIRECCION = ['direccion', 'ciudad', 'zip', 'condado', 'metodo_condado', 'direccion_verificada', 'estado_direccion', 'clave_direccion', 'mensaje_original', 'id_mensaje'];

/**
 * Agrega filas ya clasificadas y devuelve las agregadas. Omite direcciones descartadas antes.
 * Repost (misma dirección que un lead activo): no crea otro; actualiza la última publicación del existente.
 * Corrección del wholesaler (ver esCorreccion): reemplaza la dirección del lead anterior y bloquea la vieja.
 */
export function addLeads(rows) {
  return withLeads((data) => {
    const added = [];
    for (const row of rows) {
      if (row.clave_direccion && data.descartados[row.clave_direccion]) continue;
      const repost = row.clave_direccion && data.leads.find((l) => l.clave_direccion === row.clave_direccion);
      if (repost) {
        repost.publicaciones = (repost.publicaciones || 1) + 1;
        repost.ultima_publicacion = row.fecha_mensaje;
        if (row.precio_usd && row.precio_usd !== repost.precio_usd) repost.precio_repost = row.precio_usd;
        continue;
      }
      const corregido = data.leads.find((l) => esCorreccion(l, row));
      if (corregido) {
        if (corregido.clave_direccion) data.descartados[corregido.clave_direccion] = { en: new Date().toISOString(), motivo: `corregida por el wholesaler: ${row.direccion}` };
        corregido.direccion_corregida_de = corregido.direccion;
        for (const k of CAMPOS_DIRECCION) corregido[k] = row[k] ?? null;
        corregido.actualizado_en = new Date().toISOString();
        continue;
      }
      const lead = { id: crypto.randomUUID(), ...row };
      data.leads.push(lead);
      added.push(lead);
    }
    return added;
  });
}

export function updateLead(id, patch) {
  return withLeads((data) => {
    const lead = data.leads.find((l) => l.id === id);
    if (!lead) throw notFound(id);
    Object.assign(lead, patch, { actualizado_en: new Date().toISOString() });
    return lead;
  });
}

/** Borra el lead. Conserva solo su dirección normalizada para que no reingrese. */
export function discardLead(id, motivo = 'usuario') {
  return withLeads((data) => {
    const i = data.leads.findIndex((l) => l.id === id);
    if (i < 0) throw notFound(id);
    const [lead] = data.leads.splice(i, 1);
    if (lead.clave_direccion) data.descartados[lead.clave_direccion] = { en: new Date().toISOString(), motivo };
    return lead;
  });
}

/** Registra una dirección descartada automáticamente (fuera de condado) sin guardar el lead. */
export function rememberDiscarded(key, motivo) {
  if (!key) return Promise.resolve();
  return withLeads((data) => {
    data.descartados[key] ||= { en: new Date().toISOString(), motivo };
  });
}

export async function isDiscarded(key) {
  return Boolean(key && (await loadLeads()).descartados[key]);
}

function notFound(id) {
  const err = new Error(`Lead no encontrado: ${id}`);
  err.status = 404;
  return err;
}

/** Solo para pruebas: olvida la copia en memoria. */
export function _resetCache() {
  db = undefined;
}
