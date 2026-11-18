// Imágenes de data/media: flyers de WhatsApp (<id>.jpg) y adjuntos de correo (email-<uuid>.<ext>) que se usan para el OCR.
// Se borran cuando el lead que las usó se elimina definitivamente (5 días en Descartados). Un mismo mensaje puede generar varios
// leads y compartir imágenes: una imagen solo se borra si ningún lead activo o descartado ni ninguna publicación por procesar o fallida la referencia.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listLeads, listPapelera } from './leads.js';
import { listInbox } from './store.js';

const nombre = (p) => String(p || '').split(/[\\/]/).pop();
const ES_IMAGEN = /\.(jpe?g|png|webp|gif)$/i;

/** Nombres de archivo que algo todavía usa: leads activos, descartados en papelera y publicaciones en la bandeja por procesar. */
export async function imagenesEnUso() {
  const usadas = new Set();
  for (const l of [...(await listLeads()), ...(await listPapelera())]) for (const p of l.imagenes_locales || []) usadas.add(nombre(p));
  // Publicaciones por procesar (bandeja) y fallidas (pueden reintentarse): sus imágenes todavía se necesitan
  const pendientes = [...(await listInbox())];
  for (const n of await fs.readdir(config.dirs.failed).catch(() => [])) if (n.endsWith('.json')) pendientes.push(path.join(config.dirs.failed, n));
  for (const f of pendientes) {
    try {
      for (const i of JSON.parse(await fs.readFile(f, 'utf8')).images || []) usadas.add(nombre(i.path));
    } catch { /* publicación ilegible: no aporta referencias */ }
  }
  return usadas;
}

/** Borra las imágenes indicadas que ya no usa nadie. Devuelve cuántas y cuántos bytes. */
export async function borrarImagenes(rutas, { dir = config.dirs.media } = {}) {
  const candidatas = [...new Set((rutas || []).map(nombre).filter((n) => ES_IMAGEN.test(n)))];
  if (!candidatas.length) return { borradas: 0, bytes: 0 };
  const usadas = await imagenesEnUso();
  let borradas = 0;
  let bytes = 0;
  for (const n of candidatas) {
    if (usadas.has(n)) continue; // la usa otro lead del mismo mensaje
    const file = path.join(dir, n);
    try {
      const { size } = await fs.stat(file);
      await fs.rm(file);
      borradas += 1;
      bytes += size;
    } catch { /* ya no existe */ }
  }
  return { borradas, bytes };
}

/** Imágenes de la carpeta que ningún lead (activo o descartado) ni publicación pendiente usa y tienen más de `minHoras` horas. */
export async function imagenesHuerfanas({ dir = config.dirs.media, ahora = Date.now(), minHoras = 24 } = {}) {
  const usadas = await imagenesEnUso();
  const out = [];
  for (const n of await fs.readdir(dir).catch(() => [])) {
    if (!ES_IMAGEN.test(n) || usadas.has(n)) continue;
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (st && ahora - st.mtimeMs > minHoras * 36e5) out.push({ nombre: n, bytes: st.size, modificado: new Date(st.mtimeMs).toISOString() });
  }
  return out.sort((a, b) => a.modificado.localeCompare(b.modificado));
}
