// Avisos al grupo de WhatsApp NOTIF_GRUPO con el mismo número del monitor. Para no parecer un bot:
// solo dos resúmenes al día, en los horarios de NOTIF_HORARIOS (11:00 y 17:30, hora de Colombia),
// y solo si hay novedades. Si a esa hora el servidor no pudo enviar, lo intenta durante la hora siguiente;
// después, lo pendiente pasa al siguiente horario. La cola se guarda en data/notificaciones.json y se
// resuelve contra los leads al enviar (un lead descartado o con la alerta ya resuelta no sale).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listLeads } from './leads.js';

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
  cola.ultimo_envio ||= null;
  return cola;
}

async function guardar() {
  await fs.mkdir(path.dirname(config.notifFile), { recursive: true });
  await fs.writeFile(`${config.notifFile}.tmp`, JSON.stringify(cola, null, 2));
  await fs.rename(`${config.notifFile}.tmp`, config.notifFile);
}

/** Registra la conexión de WhatsApp vigente (cambia en cada reconexión). */
export function conectarNotificaciones(sock, jid) {
  enviarFn = jid ? (text) => sock.sendMessage(jid, { text }) : null;
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
    const texto = armarResumen(c.pendientes, await listLeads(), ahora);
    if (texto) await enviar(texto);
    const n = c.pendientes.length;
    c.pendientes = [];
    c.ultimo_turno = turno;
    if (texto) c.ultimo_envio = ahora.toISOString();
    await guardar();
    return { enviado: Boolean(texto), eventos: n };
  });
}

/** Revisa cada 5 minutos si toca enviar. */
export function iniciarNotificaciones(log = console) {
  if (!config.notifEnabled) return null;
  return setInterval(() => {
    revisarEnvio().then((r) => r.enviado && log.log(`Resumen enviado al grupo (${r.eventos} novedades)`)).catch((e) => log.error(`Avisos: ${e.message}`));
  }, 5 * 60000);
}

/** Solo para pruebas. */
export function _resetNotify() {
  cola = undefined;
  enviarFn = null;
}
