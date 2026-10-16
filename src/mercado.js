// Estado en el mercado de cada lead con dirección (For sale / Contingent / Pending / Off market / Sold).
// Lo consulta el PC de MERCADO_EJECUTOR (tier1-runner.ps1: Codex con búsqueda web y, si falla, Claude Haiku)
// una sola vez: al entrar el lead o si cambia su dirección. Aquí: la cola y la validación de lo que reporta.
import { config } from './config.js';
import { listLeads, updateLead } from './leads.js';
import { exportOutputs } from './sink.js';

export const ESTADOS_MERCADO = ['For sale', 'Contingent', 'Pending', 'Off market', 'Sold', 'Unknown'];
const CONFIANZA = ['alta', 'media', 'baja'];
const MOTORES = ['codex', 'haiku'];
/** Intentos fallidos por dirección antes de dejarla "sin dato". */
export const MAX_INTENTOS = 3;

/** Dirección que se consulta (y con la que se compara si cambió). El panel arma la misma. */
export const direccionMercado = (l) => [l.direccion, l.ciudad, ['FL', l.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

function pendiente(l) {
  if (!l.direccion) return false;
  const d = direccionMercado(l);
  if (l.mercado?.direccion === d) return false;
  return !(l.mercado_error?.direccion === d && l.mercado_error.intentos >= MAX_INTENTOS);
}

/** Leads por consultar. Solo el PC de MERCADO_EJECUTOR recibe la cola (los demás, lista vacía). */
export async function listMercadoJobs({ ejecutor } = {}) {
  if (ejecutor && ejecutor !== config.mercadoEjecutor) return [];
  return (await listLeads()).filter(pendiente).map((l) => ({ id: l.id, direccion: direccionMercado(l), tipo: l.tipo }));
}

const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && v !== null && v !== '' ? Number(v) : null);
const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Normaliza la respuesta del modelo: solo campos conocidos, tipos correctos y textos acotados. */
export function limpiarMercado(r = {}) {
  return {
    estado: ESTADOS_MERCADO.includes(r.estado) ? r.estado : 'Unknown',
    fecha_publicacion: fecha(r.fecha_publicacion),
    precio_lista: num(r.precio_lista),
    precio_original: num(r.precio_original),
    reducciones: (Array.isArray(r.reducciones) ? r.reducciones : []).slice(0, 10)
      .map((x) => ({ fecha: fecha(x?.fecha), precio: num(x?.precio) })).filter((x) => x.precio),
    dias_en_mercado: num(r.dias_en_mercado),
    en_alquiler: num(r.en_alquiler),
    fuentes: (Array.isArray(r.fuentes) ? r.fuentes : []).map((u) => texto(u, 300)).filter((u) => /^https?:\/\/[^\s"<>]+$/.test(u)).slice(0, 5),
    confianza: CONFIANZA.includes(r.confianza) ? r.confianza : 'baja',
    notas: texto(r.notas, 600),
  };
}

/**
 * El PC reporta la consulta: { direccion, motor, resultado } o { direccion, error }. Si la dirección del
 * lead cambió mientras tanto, se ignora (la nueva entra a la cola).
 */
export async function reportarMercado(id, body = {}) {
  const lead = (await listLeads()).find((l) => l.id === id);
  if (!lead) throw Object.assign(new Error(`Lead no encontrado: ${id}`), { status: 404 });
  const direccion = direccionMercado(lead);
  if (body.direccion && body.direccion !== direccion) return { ok: true, ignorado: 'la dirección cambió' };
  const en = new Date().toISOString();
  if (body.error || !body.resultado) {
    const intentos = (lead.mercado_error?.direccion === direccion ? lead.mercado_error.intentos : 0) + 1;
    await updateLead(id, { mercado_error: { direccion, intentos, detalle: texto(body.error || 'sin resultado', 300), en } });
    return { ok: true, intentos };
  }
  const mercado = { ...limpiarMercado(body.resultado), direccion, motor: MOTORES.includes(body.motor) ? body.motor : '', consultado_en: en };
  await updateLead(id, { mercado, mercado_error: undefined });
  await exportOutputs();
  return { ok: true, mercado };
}
