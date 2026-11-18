// Lista (sin borrar) las imágenes de data/media que ningún lead activo ni descartado ni publicación pendiente usa.
//   node scripts/media-huerfanas.mjs              -> conteo, tamaño, antigüedad y lista
//   node scripts/media-huerfanas.mjs --dias 30    -> solo las de más de 30 días (por defecto, más de 1 día)
//   node scripts/media-huerfanas.mjs --borrar     -> borra las listadas (solo después de revisar la lista y con permiso del usuario)
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { imagenesHuerfanas } from '../src/media.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const dias = Number(arg('--dias') || 1);
const huerfanas = await imagenesHuerfanas({ minHoras: dias * 24 });
const todas = (await fs.readdir(config.dirs.media).catch(() => [])).length;
const bytes = huerfanas.reduce((s, h) => s + h.bytes, 0);
console.log(`Carpeta ${config.dirs.media}: ${todas} archivos; huérfanas (más de ${dias} día/s): ${huerfanas.length} (${(bytes / 1e6).toFixed(1)} MB)`);
const cubo = (d) => (d < 7 ? '< 7 días' : d < 30 ? '7 a 30 días' : '> 30 días');
const porEdad = {};
for (const h of huerfanas) { const k = cubo((Date.now() - Date.parse(h.modificado)) / 864e5); porEdad[k] = (porEdad[k] || 0) + 1; }
console.log('Por antigüedad:', JSON.stringify(porEdad));
for (const h of huerfanas) console.log(`  ${h.modificado.slice(0, 10)}  ${(h.bytes / 1024).toFixed(0).padStart(5)} KB  ${h.nombre}`);
if (process.argv.includes('--borrar')) {
  let n = 0;
  for (const h of huerfanas) { await fs.rm(path.join(config.dirs.media, h.nombre), { force: true }); n++; }
  console.log(`Borradas: ${n}`);
}
