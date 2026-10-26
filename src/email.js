// Leads por correo: lee un buzón IMAP dedicado y convierte cada correo en publicaciones con el mismo formato
// que las de WhatsApp ({ id, timestamp, groupName, sender, text, images }), que entran a la misma cola y pasan
// por las mismas reglas (extracción, condado, criterios, Tier 1 automático, avisos, mercado).
// No mueve ni borra correos; solo los marca como leídos (\Seen) una vez procesados (EMAIL_MARCAR_LEIDO=false lo desactiva). El texto del correo es dato, nunca instrucciones.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { config, DATA_DIR } from './config.js';
import { enqueuePost, ensureDirs } from './store.js';
import { processInbox } from './process-inbox.js';

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decodificar = (s) => s.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e) => {
  if (ENT[m]) return ENT[m];
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : e[0] === '#' ? Number(e.slice(1)) : NaN;
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
});
const sinEtiquetas = (h) => decodificar(String(h).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const dinero = (s) => /\$\s*([\d,]{3,})/.exec(s)?.[1].replace(/,/g, '');

/**
 * Boletines de wholesalers con tarjetas (un precio, ciudad, dirección, ARV y datos por propiedad, cada una en
 * su celda <td>): cada tarjeta pasa a ser una publicación de texto simple. Devuelve [] si el HTML no las trae.
 */
export function tarjetasDeHtml(html) {
  const out = [];
  for (const celda of String(html || '').split(/<td\b/i).slice(1)) {
    const divs = [...celda.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/gi)].map((m) => sinEtiquetas(m[1])).filter(Boolean);
    const i = divs.findIndex((d) => /^\$\s*[\d,]{4,}$/.test(d));
    if (i < 0) continue;
    const resto = divs.slice(i + 1);
    const iArv = resto.findIndex((d) => /^ARV\s*:/i.test(d));
    if (iArv < 1) continue; // sin línea ARV no es una tarjeta de propiedad
    const [, ...detalle] = resto.slice(0, iArv); // la primera línea es la ciudad en mayúsculas
    const extra = resto.slice(iArv + 1);
    let linea = detalle.join(' ').replace(/\s+,/g, ',').replace(/(\d),\s+(\d{3})\b/g, '$1,$2').replace(/\bN\/A,?/gi, '').replace(/\s+/g, ' ').trim();
    // La plantilla parte el lote en dos líneas ("| 10" + "503 Sq Ft Lot" = 10,503)
    const frag = /[|,]\s*(\d{1,3})$/.exec(linea);
    const lote = extra.findIndex((d) => /^\d{3}\s*Sq Ft Lot/i.test(d));
    if (frag && lote >= 0) {
      linea = linea.slice(0, frag.index).trim();
      extra[lote] = `${frag[1]},${extra[lote]}`;
    }
    const arv = dinero(resto[iArv]);
    // "7,013 Sq Ft Lot (~0.16 Acre)" -> "Lot size: 7,013 sqft": el extractor reconoce la etiqueta antes del número
    const datos = extra.map((d) => d.replace(/(\d[\d,]*)\s*Sq Ft Lot(?:\s*\([^)]*\))?/gi, 'Lot size: $1 sqft'));
    out.push([linea, `Asking price: $${divs[i].replace(/[^\d,]/g, '')}`, arv ? `ARV: $${arv}` : '', ...datos].filter(Boolean).join('\n'));
  }
  return out;
}

/** Texto plano del correo cuando no hay tarjetas: sin enlaces de seguimiento ni marcadores de imagen. */
export function limpiarTexto(t) {
  return String(t || '').replace(/<https?:\/\/[^>\s]*>/g, '').replace(/^\[image:[^\]]*\]\s*$/gim, '').replace(/https?:\/\/\S{80,}/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Autor efectivo: el remitente original de un reenvío ("From: Juan Maya <…>") o, si no hay, quien lo envió. */
export function autorDe(parsed) {
  const texto = parsed.text || '';
  const cabeceras = [...texto.split(/Forwarded message/i).slice(1).join('\n').matchAll(/^\s*(?:From|De)\s*:\s*"?([^<"\n]+?)"?\s*</gim)];
  const reenviado = cabeceras.at(-1)?.[1]; // el más interno: quien escribió el original, no quien lo reenvió
  return (reenviado || parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || 'desconocido').trim().slice(0, 80);
}

const TIPOS_IMAGEN = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/**
 * Correo ya analizado (mailparser) -> publicaciones. Adjuntos: solo imágenes (para el OCR); el resto, PDF
 * incluidos, se ignora. `guardarImagen(adjunto)` devuelve la ruta donde quedó la imagen.
 */
export async function correoAPublicaciones(parsed, { guardarImagen } = {}) {
  const idBase = `email:${(parsed.messageId || crypto.createHash('sha1').update(`${parsed.date}|${parsed.subject}|${parsed.text}`).digest('hex')).replace(/[<>]/g, '')}`;
  const autor = autorDe(parsed);
  const base = { timestamp: (parsed.date || new Date()).toISOString(), groupName: `Email: ${autor}`, sender: autor };
  const adjuntos = (parsed.attachments || []).filter((a) => a.size <= config.emailMaxAdjuntoMb * 1e6);
  const imagenes = [];
  for (const a of adjuntos.filter((x) => TIPOS_IMAGEN[x.contentType] && x.contentDisposition === 'attachment')) {
    if (guardarImagen) imagenes.push({ path: await guardarImagen(a) });
  }
  const tarjetas = tarjetasDeHtml(parsed.html);
  if (tarjetas.length) return tarjetas.map((text, i) => ({ ...base, id: `${idBase}#${i + 1}`, text, images: [] }));
  const text = [parsed.subject, limpiarTexto(parsed.text || sinEtiquetas(parsed.html || ''))].filter(Boolean).join('\n\n').slice(0, 30000);
  if (!text && !imagenes.length) return [];
  return [{ ...base, id: idBase, text, images: imagenes }];
}

// ---------- Lectura de los buzones ----------
const estadoFile = () => path.join(DATA_DIR, 'email-state.json');

/** Último correo leído de cada cuenta: { cuentas: { "usuario@host": { uidValidity, ultimoUid } } }. */
async function leerEstado() {
  try { return JSON.parse(await fs.readFile(estadoFile(), 'utf8')); } catch { return {}; }
}

async function guardarEstado(estado) {
  await ensureDirs();
  await fs.writeFile(estadoFile(), JSON.stringify(estado, null, 2));
}

async function guardarImagen(a) {
  await fs.mkdir(config.dirs.media, { recursive: true });
  const file = path.join(config.dirs.media, `email-${crypto.randomUUID()}${TIPOS_IMAGEN[a.contentType]}`);
  await fs.writeFile(file, a.content);
  return file;
}

/** Lee una cuenta: correos con UID mayor al último visto -> publicaciones en cola. */
async function leerCuenta(cuenta, imap, log, resumen) {
  const lock = await imap.getMailboxLock('INBOX', { readOnly: !config.emailMarcarLeido });
  try {
    const estado = await leerEstado();
    estado.cuentas ||= {};
    const previo = estado.cuentas[cuenta.id];
    const validez = String(imap.mailbox.uidValidity);
    let ultimo = previo && previo.uidValidity === validez ? previo.ultimoUid || 0 : 0;
    const guardar = () => { estado.cuentas[cuenta.id] = { uidValidity: validez, ultimoUid: ultimo }; return guardarEstado(estado); };
    const todos = (await imap.search({ uid: `${ultimo + 1}:*` }, { uid: true })).filter((u) => u > ultimo).sort((a, b) => a - b);
    if (!previo && cuenta.soloNuevos) { // primera lectura: se ignora lo que ya había en el buzón
      if (todos.length) ultimo = todos.at(-1);
      await guardar();
      log.log?.(`Correo ${cuenta.id}: solo nuevos; ${todos.length} correo(s) previos ignorados`);
      return;
    }
    for (const uid of todos.slice(0, config.emailMaxPorPasada)) {
      const msg = await imap.fetchOne(uid, { source: true, size: true }, { uid: true });
      if (msg.size > config.emailMaxMensajeMb * 1e6) {
        log.warn?.(`Correo ${cuenta.id} UID ${uid} omitido: ${Math.round(msg.size / 1e6)} MB`);
      } else {
        const posts = await correoAPublicaciones(await simpleParser(msg.source), { guardarImagen });
        for (const p of posts) await enqueuePost(p);
        resumen.publicaciones += posts.length;
      }
      resumen.correos++;
      ultimo = uid;
      await guardar();
      if (config.emailMarcarLeido) {
        try { await imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch (e) { log.warn?.(`Correo ${cuenta.id} UID ${uid}: no se pudo marcar como leído (${e.message})`); }
      }
    }
  } finally {
    lock.release();
  }
}

let sondeando = false;

/**
 * Una pasada por todas las cuentas configuradas (una falla sin afectar a las demás) y luego el proceso normal de
 * la cola. `cliente` (solo pruebas) reemplaza la conexión IMAP.
 */
export async function sondearCorreo(log = console, { cliente, cuentas = config.emailCuentas } = {}) {
  const resumen = { correos: 0, publicaciones: 0 };
  if (sondeando) return resumen;
  sondeando = true;
  try {
    const { ImapFlow } = await import('imapflow');
    for (const cuenta of cliente && !cuentas.length ? [{ id: 'prueba' }] : cuentas) {
      const imap = cliente || new ImapFlow({ host: cuenta.host, port: cuenta.port, secure: cuenta.port === 993, auth: { user: cuenta.user, pass: cuenta.pass }, logger: false });
      try {
        await imap.connect();
        await leerCuenta(cuenta, imap, log, resumen);
        await imap.logout();
      } catch (err) {
        log.error?.(`Correo ${cuenta.id}: ${err.message}`);
        try { await imap.close(); } catch { /* ya cerrado */ }
      }
    }
  } finally {
    sondeando = false;
  }
  if (resumen.publicaciones && config.processMode === 'realtime') {
    const s = await processInbox(log);
    if (s) log.log?.(`Correo: ${resumen.correos} correo(s), ${resumen.publicaciones} publicación(es) -> leads nuevos: ${s.rows}, descartadas: ${s.discarded}, fallidas: ${s.failed}`);
  }
  return resumen;
}

/** Arranca el sondeo periódico si hay al menos una cuenta configurada. */
export function iniciarCorreo(log = console) {
  const cuentas = config.emailCuentas;
  if (!cuentas.length) return null;
  log.log?.(`Correo: leyendo ${cuentas.map((c) => c.id).join(', ')} cada ${config.emailSondeoMin} min`);
  const paso = () => sondearCorreo(log).catch((e) => log.error?.(`Correo: ${e.message}`));
  paso();
  return setInterval(paso, config.emailSondeoMin * 60_000).unref();
}
