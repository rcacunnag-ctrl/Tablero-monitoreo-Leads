// Tier 1-V2 (propiedades), en paralelo con el Tier 1 actual: no cambia el estado del lead ni toca sus informes.
// La cola se deriva de los leads (como el estado en el mercado): todo lead con dirección y precio, que no sea terreno,
// condominio, townhouse ni multifamiliar, en un condado de TARGET_COUNTIES, sin análisis vigente. Solo el PC de V2_EJECUTOR
// (el que tiene el rol estatal de Florida indexado) recibe la cola; ahí corre el skill tier1-v2-propiedades con `claude -p`
// y reporta aquí. El resultado queda en `lead.v2` y el HTML en `lead.informes` (nombre *-tier1-v2.html).
import { config } from './config.js';
import { listLeads, updateLead, esOportunidad } from './leads.js';
import { encolarOportunidad } from './notify.js';
import { jobLead } from './tier1.js';
import { exportOutputs } from './sink.js';
import { resolverMlsOculto } from './mls.js';

const TIPOS_NO = new Set(['land', 'condo', 'townhouse', 'multifamily', 'commercial', 'mobile_home']);
export const MAX_INTENTOS_V2 = 3;
const HORAS_ATASCADA = 4;
export const VEREDICTOS = ['Advance to Tier 2', 'Advance with conditions', 'Do not advance'];
const CONFIANZA = ['high', 'medium', 'low'];
const ESTADOS = ['pendiente', 'en_proceso', 'listo', 'error']; // pendiente: el PC devuelve la orden (p. ej. sin sesión de Claude)

/** Si cambia la dirección o el precio, el análisis anterior ya no vale y se hace de nuevo. */
export const firmaV2 = (l) => `${[l.direccion, l.ciudad, l.zip].filter(Boolean).join(',')}|${l.precio_usd}`.toLowerCase();
const dia = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: config.timeZone });

// `excepcion`: lead de un condado fuera de TARGET_COUNTIES que el usuario agregó a mano (se analiza igual)
export const elegibleV2 = (l) => Boolean(l.direccion && Number(l.precio_usd) > 0 && !TIPOS_NO.has(l.tipo) && (config.targetCounties.includes(l.condado) || l.excepcion));

function pendienteV2(l, ahora) {
  if (!elegibleV2(l) || l.mls_cola) return false; // los de MLS en cola esperan su turno (src/mls.js)
  const v = l.v2;
  if (!v || v.firma !== firmaV2(l)) return true;
  if (v.estado === 'listo') return false;
  if (v.estado === 'en_proceso') return ahora - Date.parse(v.actualizado_en) > HORAS_ATASCADA * 36e5; // el PC se apagó a mitad
  return (v.intentos || 0) < MAX_INTENTOS_V2;
}

/** Órdenes para el PC ejecutor (con el cupo diario de V2_MAX_DIA ya descontado), las más nuevas primero. */
export async function listV2Jobs({ ejecutor, ahora = Date.now() } = {}) {
  if (!config.v2Enabled || (ejecutor && ejecutor !== config.v2Ejecutor)) return [];
  const leads = await listLeads();
  const hoy = dia(ahora);
  const cupo = config.v2MaxDia - leads.filter((l) => l.v2?.iniciado_en && dia(l.v2.iniciado_en) === hoy).length;
  const [modelo, esfuerzo] = config.v2Modelo.split(':');
  return leads.filter((l) => pendienteV2(l, ahora))
    .sort((a, b) => String(b.procesado_en || '').localeCompare(String(a.procesado_en || '')))
    .slice(0, Math.max(0, cupo))
    .map((l) => ({ id: l.id, tipo: 'v2', skill: config.v2Skill, estado: 'pendiente', creado_en: l.procesado_en, modelo: modelo || undefined, esfuerzo: esfuerzo || undefined, lead: jobLead(l) }));
}

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** El PC reporta: { estado: en_proceso | listo | error, detalle, ruta, resultado: { veredicto, score, mao, arv, ... } }. */
export async function reportarV2(id, body = {}) {
  const lead = (await listLeads()).find((l) => l.id === id);
  if (!lead) throw Object.assign(new Error(`Lead no encontrado: ${id}`), { status: 404 });
  if (!ESTADOS.includes(body.estado)) throw Object.assign(new Error(`Estado no válido. Opciones: ${ESTADOS.join(', ')}`), { status: 400 });
  const firma = firmaV2(lead);
  const prev = lead.v2?.firma === firma ? lead.v2 : {};
  const ahora = new Date().toISOString();
  const v2 = { ...prev, firma, estado: body.estado, actualizado_en: ahora, intentos: prev.intentos || 0 };
  if (body.estado === 'en_proceso') v2.iniciado_en = ahora;
  if (body.detalle !== undefined) v2.detalle = String(body.detalle).replace(/\s+/g, ' ').trim().slice(0, 600);
  if (body.ruta !== undefined) v2.ruta = String(body.ruta).slice(0, 500);
  if (body.estado === 'error') v2.intentos += 1;
  if (body.estado === 'listo') {
    const r = body.resultado || {};
    Object.assign(v2, {
      veredicto: VEREDICTOS.includes(r.veredicto) ? r.veredicto : undefined, score: num(r.score), mao: num(r.mao), arv: num(r.arv), ganancia: num(r.ganancia),
      confianza: CONFIANZA.includes(r.confianza) ? r.confianza : undefined, negociable: Boolean(r.negociable), provisional: Boolean(r.provisional), terminado_en: ahora,
    });
  }
  await updateLead(id, { v2 });
  let mls;
  if (body.estado === 'listo' && lead.mls_oculto && !lead.mls_cola) mls = await resolverMlsOculto({ ...lead, v2 }, v2.score); // leads de MLS sin señal: se muestran si puntúan
  if (body.estado === 'listo') {
    const actual = (await listLeads()).find((l) => l.id === id);
    if (actual && esOportunidad(actual) && !actual.oport_avisada) await encolarOportunidad(id); // aviso al grupo de oportunidades
    await exportOutputs();
  }
  return { ok: true, v2, ...(mls ? { mls } : {}) };
}
