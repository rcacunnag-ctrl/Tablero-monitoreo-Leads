// Panel local (navegador): leads por pestañas, acciones (descartar, recuperar, editar, Tier 1, dirección, precio, inspección, Tier 2, Compra) y descarga de Excel/CSV.
// Sin dependencias externas. No tiene login: el acceso se limita por red (localhost o Tailscale).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { config } from './config.js';
import { exportXlsx, exportOutputs } from './sink.js';
import { listLeads, listPapelera } from './leads.js';
import { descartar, recuperar, editarLead, TIPOS, pasarATier1, agregarDireccion, agregarPrecio, reportarInforme, registrarInspeccion, avanzar, pasarATier2, reportarTier2, reintentarTier2Lead } from './actions.js';
import { listTier2Jobs } from './tier2.js';
import { listJobs } from './tier1.js';
import { migrateLegacy } from './migrate.js';
import { PAGE } from './page.js';
import { guardarInforme, leerInforme, cabecerasInforme, usoDisco } from './informes.js';

const ACTIONS = {
  descartar: (id, body) => descartar(id, body.usuario),
  recuperar: (id, body) => recuperar(id, body.usuario),
  editar: (id, body) => editarLead(id, body, body.usuario),
  tier1: (id, body) => pasarATier1(id, body.usuario, { ejecutor: body.ejecutor }),
  direccion: (id, body) => agregarDireccion(id, body, body.usuario),
  precio: (id, body) => agregarPrecio(id, body, body.usuario),
  inspeccion: (id, body) => registrarInspeccion(id, body, body.usuario),
  tier2: (id, body) => pasarATier2(id, body, body.usuario),
  reintentar2: (id, body) => reintentarTier2Lead(id, body.usuario),
  compra: (id, body) => avanzar(id, 'compra', body.usuario),
};

export function startDashboard({ port = config.dashboardPort, host = config.dashboardHost } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST') {
        const subida = url.pathname.match(/^\/api\/leads\/([\w-]+)\/informes$/);
        checkSameOrigin(req, subida ? /^application\/octet-stream/ : /^application\/json/);
        if (subida) {
          const params = { tier: url.searchParams.get('tier'), nombre: url.searchParams.get('nombre') };
          const out = await guardarInforme(subida[1], params, req);
          await exportOutputs();
          return send(res, 200, 'application/json', JSON.stringify(out));
        }
        const job = url.pathname.match(/^\/api\/tier1-jobs\/([\w-]+)\/estado$/);
        if (job) return send(res, 200, 'application/json', JSON.stringify(await reportarInforme(job[1], await readJson(req))));
        const job2 = url.pathname.match(/^\/api\/tier2-jobs\/([\w-]+)\/estado$/);
        if (job2) return send(res, 200, 'application/json', JSON.stringify(await reportarTier2(job2[1], await readJson(req))));
        const m = url.pathname.match(/^\/api\/leads\/([\w-]+)\/(descartar|recuperar|editar|tier1|direccion|precio|inspeccion|tier2|reintentar2|compra)$/);
        if (!m) return send(res, 404, 'text/plain', 'No encontrado');
        const out = await ACTIONS[m[2]](m[1], await readJson(req));
        return send(res, 200, 'application/json', JSON.stringify(out));
      }
      if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
      if (url.pathname === '/api/leads') {
        const body = { leads: await listLeads(), descartados: await listPapelera(), tipos: TIPOS, condados: config.targetCounties, usuarios: config.tier1Users, ejecutores: config.ejecutores, skillHabilitado: config.tier1SkillEnabled, disco: await usoDisco() };
        return send(res, 200, 'application/json', JSON.stringify(body));
      }
      if (url.pathname === '/api/tier1-jobs') {
        return send(res, 200, 'application/json', JSON.stringify(await listJobs({ estado: url.searchParams.get('estado') || undefined, ejecutor: url.searchParams.get('ejecutor') || undefined })));
      }
      if (url.pathname === '/api/tier2-jobs') {
        return send(res, 200, 'application/json', JSON.stringify(await listTier2Jobs({ estado: url.searchParams.get('estado') || undefined, ejecutor: url.searchParams.get('ejecutor') || undefined })));
      }
      if (url.pathname === '/descargar/csv') {
        const data = await fs.readFile(config.csvFile).catch(() => Buffer.from(''));
        return send(res, 200, 'text/csv; charset=utf-8', data, 'propiedades.csv');
      }
      if (url.pathname === '/descargar/xlsx') {
        const tmp = path.join(os.tmpdir(), `propiedades-${Date.now()}.xlsx`);
        await exportXlsx(tmp);
        const data = await fs.readFile(tmp);
        await fs.rm(tmp, { force: true });
        return send(res, 200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data, 'propiedades.xlsx');
      }
      const inf = url.pathname.match(/^\/informes\/([\w-]+)\/([^/]+)$/);
      if (inf) {
        const r = await leerInforme(inf[1], decodeURIComponent(inf[2]));
        res.writeHead(200, cabecerasInforme(r));
        return res.end(r.data);
      }
      // Scripts del PC ejecutor, para actualizarlos desde cada PC por Tailscale (no tienen secretos)
      const script = url.pathname.match(/^\/scripts\/(tier1-runner|subir-informe|instalar-ejecutor)\.ps1$/);
      if (script) {
        const data = await fs.readFile(fileURLToPath(new URL(`../scripts/${script[1]}.ps1`, import.meta.url)));
        return send(res, 200, 'text/plain; charset=utf-8', data);
      }
      if (url.pathname.startsWith('/media/')) {
        const name = path.basename(decodeURIComponent(url.pathname.slice(7)));
        const data = await fs.readFile(path.join(config.dirs.media, name));
        return send(res, 200, 'image/jpeg', data);
      }
      send(res, 404, 'text/plain', 'No encontrado');
    } catch (err) {
      const status = err.status || 500;
      send(res, status, 'application/json', JSON.stringify({ error: err.message }));
    }
  });
  server.listen(port, host, () => console.log(`Panel: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  return server;
}

/**
 * Las acciones solo se aceptan desde el propio panel o el PC ejecutor: JSON (u octet-stream para subir
 * informes) con la cabecera X-Monitor
 * (otro sitio no puede enviarla sin preflight CORS, que este servidor no autoriza) y Origin igual al Host.
 */
function checkSameOrigin(req, tipo = /^application\/json/) {
  const ok = req.headers['x-monitor'] === '1' && tipo.test(req.headers['content-type'] || '');
  const origin = req.headers.origin;
  if (!ok || (origin && new URL(origin).host !== req.headers.host)) {
    throw Object.assign(new Error('Petición no permitida'), { status: 403 });
  }
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function send(res, status, type, body, download) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
  res.writeHead(status, headers);
  res.end(body);
}


if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrateLegacy();
  startDashboard();
}
