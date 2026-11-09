// Avisos al grupo de WhatsApp NOTIF_GRUPO con el mismo número del monitor. Para no parecer un bot:
// solo dos resúmenes al día, en los horarios de NOTIF_HORARIOS (11:00 y 17:30, hora de Colombia),
// y solo si hay novedades. Si a esa hora el servidor no pudo enviar, lo intenta durante la hora siguiente;
// después, lo pendiente pasa al siguiente horario. La cola se guarda en data/notificaciones.json y se
// resuelve contra los leads al enviar (un lead descartado o con la alerta ya resuelta no sale).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listLeads, esVisible, esOportunidad, withLeads } from './leads.js';

const SECCIONES = [
  ['alerta', '⚠️ Pedir datos al wholesaler'],
  ['informe_t1', '✅ Informes Tier 1 listos'],
  ['informe_t1_error', '❌ Informes Tier 1 con error'],
  ['informe_t2', '📄 Informes Tier 2 listos'],
  ['informe_t2_error', '❌ Tier 2 con error'],
];
const MAX_POR_SECCION = 10;

let cola;
let lock = Promise.resolve();
let enviarFn = null;
let enviarOportFn = null;

function serial(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

async function cargar() {
  if (cola) return cola;
  try {
    cola = JSON.parse(await fs.readFile(config.notifFile, 'utf8'));
  } catch {
    cola = {};
  }
  cola.pendientes ||= [];
  cola.oport ||= [];
  cola.ultimo_envio ||= null;
  return cola;
}

async function guardar() {
  await fs.mkdir(path.dirname(config.notifFile), { recursive: true });
  await fs.writeFile(`${config.notifFile}.tmp`, JSON.stringify(cola, null, 2));
  await fs.rename(`${config.notifFile}.tmp`, config.notifFile);
}

/** Registra la conexión de WhatsApp vigente (cambia en cada reconexión). */
export function conectarNotificaciones(sock, jid, jidOport) {
  enviarFn = jid ? (text) => sock.sendMessage(jid, { text }) : null;
  enviarOportFn = jidOport ? (text) => sock.sendMessage(jidOport, { text }) : null;
}

/** Agrega una novedad a la cola. tipo: alerta | informe_t1 | informe_t1_error | informe_t2 | informe_t2_error */
export function encolar(tipo, id, detalle = '') {
  if (!config.notifEnabled) return Promise.resolve();
  return serial(async () => {
    const c = await cargar();
    const clave = `${tipo}|${id}|${tipo === 'informe_t2' ? detalle : ''}`;
    c.pendientes = c.pendientes.filter((e) => e.clave !== clave);
    c.pendientes.push({ clave, tipo, id, detalle: String(detalle).slice(0, 200), en: new Date().toISOString() });
    await guardar();
  });
}

const corto = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M` : `$${Math.round(n / 1000)}k`);
const direccion = (l) => [l.direccion, l.ciudad].filter(Boolean).join(', ') || `Sin dirección${l.ciudad || l.zip ? ` (${l.ciudad || l.zip})` : ''}`;

function linea(tipo, l, detalle) {
  const precio = [l.precio_usd && corto(l.precio_usd), l.arv_usd && `ARV ${corto(l.arv_usd)}`].filter(Boolean).join(' / ');
  if (tipo === 'alerta') {
    const quien = [l.contacto || l.autor, l.telefono].filter(Boolean).join(' ');
    return `• ${direccion(l)}${precio ? ` (${precio})` : ''} — ${l.alerta.replace(/^Solicitar /, '').replace(/ al wholesaler$/, '')}${quien ? ` · ${quien}` : ''}`;
  }
  return `• ${direccion(l)}${detalle ? ` — ${detalle}` : ''}`;
}

/** Texto del resumen. Devuelve '' si ninguna novedad sigue vigente. */
export function armarResumen(eventos, leads, ahora = new Date()) {
  const porId = new Map(leads.map((l) => [l.id, l]));
  const partes = [];
  for (const [tipo, titulo] of SECCIONES) {
    const lineas = eventos
      .filter((e) => e.tipo === tipo && porId.has(e.id) && (tipo !== 'alerta' || porId.get(e.id).alerta))
      .map((e) => linea(tipo, porId.get(e.id), e.detalle));
    if (!lineas.length) continue;
    const extra = lineas.length > MAX_POR_SECCION ? [`…y ${lineas.length - MAX_POR_SECCION} más en el panel`] : [];
    partes.push([`*${titulo} (${lineas.length})*`, ...lineas.slice(0, MAX_POR_SECCION), ...extra].join('\n'));
  }
  if (!partes.length) return '';
  const hora = ahora.toLocaleString('es-CO', { timeZone: config.notifTz, dateStyle: 'short', timeStyle: 'short' });
  return [`*Monitor de Propiedades* · resumen ${hora}`, ...partes].join('\n\n');
}

const VENTANA_MIN = 60;

/** Turno vigente ("AAAA-MM-DD HH:MM" en NOTIF_TZ): el último horario de hoy ya alcanzado hace menos de 60 min. */
export function turnoVigente(ahora) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.notifTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ahora).map((x) => [x.type, x.value]));
  const min = Number(p.hour) * 60 + Number(p.minute);
  const turno = config.notifHorarios
    .map((h) => [h, h.split(':').reduce((a, b) => Number(a) * 60 + Number(b))])
    .filter(([, m]) => min >= m && min - m < VENTANA_MIN)
    .at(-1);
  return turno ? `${p.year}-${p.month}-${p.day} ${turno[0]}` : null;
}

/** Envía el resumen si toca (horario del día no enviado y novedades). Si el envío falla, la cola se conserva. */
export function revisarEnvio({ ahora = new Date(), enviar = enviarFn } = {}) {
  return serial(async () => {
    if (!config.notifEnabled) return { enviado: false, motivo: 'desactivado' };
    const c = await cargar();
    if (!c.pendientes.length) return { enviado: false, motivo: 'sin novedades' };
    if (!enviar) return { enviado: false, motivo: 'sin conexión' };
    const turno = turnoVigente(ahora);
    if (!turno) return { enviado: false, motivo: 'fuera de horario' };
    if (c.ultimo_turno === turno) return { enviado: false, motivo: 'turno ya enviado' };
    const texto = armarResumen(c.pendientes, (await listLeads()).filter(esVisible), ahora);
    if (texto) await enviar(texto);
    const n = c.pendientes.length;
    c.pendientes = [];
    c.ultimo_turno = turno;
    if (texto) c.ultimo_envio = ahora.toISOString();
    await guardar();
    return { enviado: Boolean(texto), eventos: n };
  });
}

// --- Oportunidades: grupo aparte (NOTIF_OPORT_GRUPO) que recibe solo esto ---

/** Marca un lead como oportunidad nueva por avisar (una sola vez por lead). */
export function encolarOportunidad(id) {
  if (!config.notifOportGrupo) return Promise.resolve();
  return serial(async () => {
    const c = await cargar();
    if (c.oport.some((e) => e.id === id)) return;
    c.oport.push({ id, en: new Date().toISOString() });
    await guardar();
  });
}

const VEREDICTO = { 'Advance to Tier 2': 'avanzar a Tier 2', 'Advance with conditions': 'avanzar con condiciones', 'Do not advance': 'no avanzar' };

function datosOport(l) {
  const dato = [l.precio_usd && corto(l.precio_usd), (l.beds || l.baths) && `${l.beds ?? '?'}/${l.baths ?? '?'}`, l.sqft && `${Number(l.sqft).toLocaleString('en-US')} sqft`].filter(Boolean).join(' · ');
  const v2 = l.v2?.estado === 'listo' && Number.isFinite(l.v2.score)
    ? `Tier 1-V2 ${l.v2.score}/100 (${VEREDICTO[l.v2.veredicto] || l.v2.veredicto})${l.v2.mao ? ` · MAO ${corto(l.v2.mao)}` : ''}${l.v2.arv ? ` · ARV ${corto(l.v2.arv)}` : ''}` : '';
  const mls = l.mls ? [...(l.mls.senales || []), l.mls.dom != null && `${l.mls.dom} d en el mercado`, l.mls.precio_anterior && `rebaja desde ${corto(l.mls.precio_anterior)}`].filter(Boolean).join(' · ') : '';
  return { titulo: direccion(l), dato, detalle: [v2, mls].filter(Boolean).join(' — ') };
}

/** Texto del aviso de oportunidades: una descrita; hasta NOTIF_OPORT_MAX en lista breve; más de eso, solo el aviso de ir al portal. */
export function armarAvisoOport(leads) {
  const n = leads.length;
  if (!n) return '';
  const portal = config.notifPortalUrl;
  if (n > config.notifOportMax) return [`*${n} oportunidades nuevas* en el tablero.`, `Revísalas en el portal (pestaña Oportunidades): ${portal}`].join('\n');
  if (n === 1) {
    const d = datosOport(leads[0]);
    return [`*Nueva oportunidad*`, d.titulo, d.dato, d.detalle, `Portal: ${portal}`].filter(Boolean).join('\n');
  }
  const lineas = leads.map((l) => { const d = datosOport(l); return [`• ${d.titulo}${d.dato ? ` — ${d.dato}` : ''}`, d.detalle && `   ${d.detalle}`].filter(Boolean).join('\n'); });
  return [`*${n} oportunidades nuevas*`, ...lineas, `Portal: ${portal}`].join('\n');
}

/** Envía las oportunidades nuevas al grupo si toca (mismos horarios), solo las que siguen vigentes y no se han avisado. */
export function revisarEnvioOport({ ahora = new Date(), enviar = enviarOportFn } = {}) {
  return serial(async () => {
    if (!config.notifOportGrupo) return { enviado: false, motivo: 'desactivado' };
    const c = await cargar();
    if (!c.oport.length) return { enviado: false, motivo: 'sin novedades' };
    if (!enviar) return { enviado: false, motivo: 'sin conexión' };
    const turno = turnoVigente(ahora);
    if (!turno) return { enviado: false, motivo: 'fuera de horario' };
    if (c.ultimo_turno_oport === turno) return { enviado: false, motivo: 'turno ya enviado' };
    const ids = new Set(c.oport.map((e) => e.id));
    const leads = (await listLeads()).filter((l) => ids.has(l.id) && esOportunidad(l) && !l.oport_avisada);
    const texto = armarAvisoOport(leads);
    if (texto) await enviar(texto);
    if (texto) await withLeads((data) => { for (const l of data.leads) if (leads.some((x) => x.id === l.id)) l.oport_avisada = ahora.toISOString(); });
    c.oport = [];
    c.ultimo_turno_oport = turno;
    await guardar();
    return { enviado: Boolean(texto), oportunidades: leads.length };
  });
}

/** Revisa cada 5 minutos si toca enviar. */
export function iniciarNotificaciones(log = console) {
  if (!config.notifEnabled && !config.notifOportGrupo) return null;
  return setInterval(() => {
    revisarEnvio().then((r) => r.enviado && log.log(`Resumen enviado al grupo (${r.eventos} novedades)`)).catch((e) => log.error(`Avisos: ${e.message}`));
    revisarEnvioOport().then((r) => r.enviado && log.log(`Oportunidades avisadas al grupo (${r.oportunidades})`)).catch((e) => log.error(`Avisos de oportunidades: ${e.message}`));
  }, 5 * 60000);
}

/** Solo para pruebas. */
export function _resetNotify() {
  cola = undefined;
  enviarFn = null;
  enviarOportFn = null;
}
