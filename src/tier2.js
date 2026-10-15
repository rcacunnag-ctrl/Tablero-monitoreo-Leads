// Órdenes de Tier 2 (fases 1–4 del Underwriting) para el PC ejecutor: data/tier2-jobs/<id>.json.
// Una orden por lead que avanza fase a fase: fase N pendiente -> en_proceso -> listo (pasa a la fase N+1;
// tras la 4 queda "completo") | error (se reintenta desde el panel). Los skills corren en Claude, en el PC.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { jobLead } from './tier1.js';

export const FASES = { 1: 'Datos', 2: 'Comparables', 3: 'Informe de comparables', 4: 'Informe de alertas' };
export const ESTADOS_T2 = ['pendiente', 'en_proceso', 'listo', 'error'];
export const COMPARABLES = [8, 12, 20];

const err = (status, msg) => Object.assign(new Error(msg), { status });
const jobFile = (id) => path.join(config.dirs.tier2Jobs, `${path.basename(id)}.json`);

async function leer(id) {
  return JSON.parse(await fs.readFile(jobFile(id), 'utf8').catch(() => { throw err(404, `Orden de Tier 2 no encontrada: ${id}`); }));
}

async function escribir(job) {
  await fs.mkdir(config.dirs.tier2Jobs, { recursive: true });
  const file = jobFile(job.id);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(job, null, 2));
  await fs.rename(`${file}.tmp`, file);
  return job;
}

export async function lanzarTier2(lead, usuario, { comparables = 12, enabled = config.tier2SkillEnabled, ejecutor = config.ejecutores[0] } = {}) {
  if (!enabled) return { lanzado: false, motivo: 'por habilitar (TIER2_SKILL_ENABLED=false)' };
  const now = new Date().toISOString();
  await escribir({
    id: lead.id, usuario, ejecutor, comparables, fase: 1, estado: 'pendiente', creado_en: now, actualizado_en: now, historial: [],
    lead: { ...jobLead(lead), condicion: lead.condicion, tipo_negocio: lead.tipo_negocio },
  });
  return { lanzado: true, estado: 'pendiente', fase: 1, ejecutor };
}

export async function listTier2Jobs({ estado, ejecutor } = {}) {
  const files = await fs.readdir(config.dirs.tier2Jobs).catch(() => []);
  const jobs = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) jobs.push(JSON.parse(await fs.readFile(path.join(config.dirs.tier2Jobs, f), 'utf8')));
  jobs.sort((a, b) => String(a.creado_en).localeCompare(String(b.creado_en)));
  return jobs.filter((j) => (!estado || j.estado === estado) && (!ejecutor || (j.ejecutor || config.ejecutores[0]) === ejecutor));
}

/**
 * Avance que reporta el PC. `fase` debe coincidir con la fase en curso (evita reportes viejos).
 * listo en la fase N<4 deja la fase N+1 pendiente; en la 4, la orden queda "completo".
 */
export async function setTier2State(id, { estado, fase, ruta, detalle, caso_id: casoId }) {
  if (!ESTADOS_T2.includes(estado)) throw err(400, `Estado no válido. Opciones: ${ESTADOS_T2.join(', ')}`);
  const job = await leer(id);
  if (job.estado === 'completo') throw err(400, 'El Tier 2 de este lead ya está completo');
  if (fase !== undefined && Number(fase) !== job.fase) throw err(409, `La orden está en la fase ${job.fase}, no en la ${fase}`);
  const now = new Date().toISOString();
  job.actualizado_en = now;
  if (ruta !== undefined) job.ruta = String(ruta).slice(0, 500);
  if (casoId !== undefined) job.caso_id = String(casoId).slice(0, 300); // caso en el Intake Service del PC
  job.detalle = detalle !== undefined ? String(detalle).slice(0, 2000) : '';
  if (estado === 'listo') {
    job.historial.push({ fase: job.fase, en: now, detalle: job.detalle });
    if (job.fase < 4) {
      job.fase += 1;
      job.estado = 'pendiente';
    } else {
      job.estado = 'completo';
    }
  } else {
    job.estado = estado;
  }
  return escribir(job);
}

/** Desde el panel: vuelve a poner en cola la fase que falló. */
export async function reintentarTier2(id) {
  const job = await leer(id);
  if (job.estado !== 'error') throw err(400, 'Solo se reintenta un Tier 2 con error');
  return setTier2State(id, { estado: 'pendiente', detalle: 'reintento pedido desde el panel' });
}
