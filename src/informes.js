// Informes de Tier 1 y Tier 2 que sube el PC ejecutor al terminar: data/informes/<id del lead>/<archivo>.
// Solo entregables (dashboard HTML, .docx, .pdf, .xlsx); el original y los archivos de trabajo siguen en OneDrive.
// Se borran al descartar el lead.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { listLeads, updateLead } from './leads.js';
import { encolar } from './notify.js';

export const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const MAX_BYTES = 40 * 1024 * 1024;

const ID_RE = /^[\w-]{1,64}$/;
const NOMBRE_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ .,()#&+-]{0,150}$/u;
const err = (status, msg) => Object.assign(new Error(msg), { status });

function validar(id, nombre) {
  if (!ID_RE.test(String(id))) throw err(404, 'Informe no encontrado');
  const n = String(nombre ?? '');
  if (!NOMBRE_RE.test(n) || n.includes('..') || !TIPOS[path.extname(n).toLowerCase()]) {
    throw err(400, `Nombre de archivo no válido: "${n}" (tipos: ${Object.keys(TIPOS).join(', ')})`);
  }
  return n;
}

const archivo = (id, nombre) => path.join(config.dirs.informes, id, nombre);

const ETIQUETAS = [[/\.html$/i, 'Dashboard'], [/Informe_Completo/i, 'Comparables (completo)'], [/Ejecutivo/i, 'Comparables (ejecutivo)'], [/Alertas/i, 'Alertas'], [/Decision/i, 'Decisión']];
/** Nombre legible del entregable (el mismo criterio que usa el panel). */
export const etiquetaInforme = (nombre) => (ETIQUETAS.find(([re]) => re.test(nombre)) || [0, nombre])[1];

/**
 * Guarda un informe recibido como flujo de bytes y lo registra en el lead (lead.informes).
 * Un archivo con el mismo nombre reemplaza al anterior.
 */
export async function guardarInforme(id, { tier, nombre }, body, { maxBytes = MAX_BYTES } = {}) {
  const n = validar(id, nombre);
  if (!['1', '2'].includes(String(tier))) throw err(400, 'tier debe ser 1 o 2');
  if (!(await listLeads()).some((l) => l.id === id)) throw err(404, `Lead no encontrado: ${id}`);
  const file = archivo(id, n);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  const out = createWriteStream(tmp);
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw err(413, `El archivo supera ${Math.round(maxBytes / 1048576)} MB`);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  } catch (e) {
    out.destroy();
    await fs.rm(tmp, { force: true });
    throw e;
  }
  if (!bytes) {
    await fs.rm(tmp, { force: true });
    throw err(400, 'Archivo vacío');
  }
  await fs.rename(tmp, file);
  const informe = { tier: Number(tier), nombre: n, bytes, en: new Date().toISOString() };
  const lead = (await listLeads()).find((l) => l.id === id);
  if (!lead) {
    await borrarInformes(id); // se descartó mientras se subía
    throw err(404, `Lead no encontrado: ${id}`);
  }
  const informes = [...(lead.informes || []).filter((i) => i.nombre !== n), informe].sort((a, b) => a.tier - b.tier || a.nombre.localeCompare(b.nombre));
  await updateLead(id, { informes });
  if (informe.tier === 2) await encolar('informe_t2', id, etiquetaInforme(n));
  return { ok: true, informe };
}

/** Contenido y tipo de un informe. */
export async function leerInforme(id, nombre) {
  const n = validar(id, nombre);
  const data = await fs.readFile(archivo(id, n)).catch(() => { throw err(404, 'Informe no encontrado'); });
  return { data, type: TIPOS[path.extname(n).toLowerCase()], nombre: n };
}

/**
 * Cabeceras para servir un informe. El HTML se abre en un origen aislado (CSP sandbox): sus scripts
 * corren, pero no pueden leer ni usar el panel. Los .docx/.xlsx se descargan.
 */
export function cabecerasInforme({ type, nombre }) {
  // strict-origin: a los mapas (OpenStreetMap) solo llega el dominio, nunca la ruta (que en la vista lleva el token).
  // Con no-referrer, OpenStreetMap responde con la imagen "Access blocked" en cada tile.
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin' };
  if (type.startsWith('text/html')) h['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads';
  const modo = /html|pdf/.test(type) ? 'inline' : 'attachment';
  h['Content-Disposition'] = `${modo}; filename*=UTF-8''${encodeURIComponent(nombre)}`;
  return h;
}

export function borrarInformes(id) {
  if (!ID_RE.test(String(id))) return Promise.resolve();
  return fs.rm(path.join(config.dirs.informes, id), { recursive: true, force: true });
}

/** Uso del disco donde viven los datos (para el aviso del panel al pasar del 80 %). */
export async function usoDisco() {
  try {
    const s = await fs.statfs(DATA_DIR);
    const total = s.blocks * s.bsize;
    const libre = s.bavail * s.bsize;
    return { usado_pct: Math.round((1 - libre / total) * 100), libre_gb: Math.round(libre / 1e8) / 10 };
  } catch {
    return null;
  }
}
