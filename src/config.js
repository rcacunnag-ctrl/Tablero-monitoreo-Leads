import 'dotenv/config';
import path from 'node:path';

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|si)$/i.test(v));

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  // WhatsApp (única dependencia externa)
  waPhoneNumber: (process.env.WA_PHONE_NUMBER || '').replace(/\D/g, ''),
  waGroups: list(process.env.WA_GROUPS), // JIDs (xxxx@g.us) o parte del nombre del grupo
  authDir: path.resolve(process.env.WA_AUTH_DIR || './auth'),
  // Segundos que se agrupan mensajes consecutivos del mismo autor como una sola publicación
  postWindowSec: Number(process.env.POST_WINDOW_SEC || 90),
  // realtime: procesa al llegar | batch: solo encola (procesar con `npm run process`)
  processMode: process.env.PROCESS_MODE || 'realtime',

  // Extracción local
  ocrEnabled: bool(process.env.OCR_ENABLED, true), // leer texto de flyers con Tesseract (offline)
  useCensusGeocoder: bool(process.env.USE_CENSUS_GEOCODER, false), // opcional, gratuito, requiere internet

  // Panel local
  dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
  dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1',
  // Vista de solo lectura para terceros (vacío = desactivada). Se sirve en /v/<token>/
  vistaToken: (process.env.VISTA_TOKEN || '').trim(),
  vistaPort: Number(process.env.VISTA_PORT || 3001),

  targetCounties: list(process.env.TARGET_COUNTIES || 'Palm Beach,Broward,Martin'),

  // Tier 1: usuarios que pueden ejecutar el comp-analysis-report y si el lanzamiento está activo
  tier1Users: list(process.env.TIER1_USERS || 'Andres,Carlos,Jaime'),
  tier1SkillEnabled: bool(process.env.TIER1_SKILL_ENABLED, false),
  // Criterios de Tier 1 automático: % of ARV = precio / ARV * 100 <= CRIT_PCT_ARV_MAX y precio < CRIT_PRECIO_MAX
  critPctArvMax: Number(process.env.CRIT_PCT_ARV_MAX || 75),
  critPrecioMax: Number(process.env.CRIT_PRECIO_MAX || 300000),
  // Informes Tier 1 automáticos que pueden empezar por día (los demás esperan al día siguiente)
  tier1AutoMaxDia: Number(process.env.TIER1_AUTO_MAX_DIA || 3),
  // PCs que ejecutan los informes (cada uno corre scripts/tier1-runner.ps1 -Ejecutor <nombre>).
  // El primero es el predeterminado de las órdenes viejas; los Tier 1 automáticos van a TIER1_AUTO_EJECUTOR.
  ejecutores: list(process.env.EJECUTORES || 'Roberto,Andres'),
  tier1AutoEjecutor: (process.env.TIER1_AUTO_EJECUTOR || 'Andres').trim(),
  // Modelo y esfuerzo del Tier 1 por PC: "Andres=claude-fable-5-1:medium,Roberto=..." (sin entrada = el
  // predeterminado de la cuenta de ese PC). Viaja en cada orden, así se cambia sin tocar el PC.
  tier1Modelos: Object.fromEntries(list(process.env.TIER1_MODELO_POR_PC || '').map((x) => {
    const [pc, v = ''] = x.split('=');
    const [modelo, esfuerzo] = v.split(':');
    return [pc.trim(), { modelo: (modelo || '').trim() || undefined, esfuerzo: (esfuerzo || '').trim() || undefined }];
  })),
  // Tier 2: fases 1–4 en el PC ejecutor. Los skills cubren solo estos condados (Martin es excepción manual)
  tier2SkillEnabled: bool(process.env.TIER2_SKILL_ENABLED, false),
  tier2Counties: list(process.env.TIER2_COUNTIES || 'Broward,Palm Beach'),
  timeZone: process.env.TZ_NEGOCIO || 'America/New_York',

  // Avisos por WhatsApp (mismo número) al grupo NOTIF_GRUPO: un resumen en cada horario de NOTIF_HORARIOS (hora de NOTIF_TZ)
  notifEnabled: bool(process.env.NOTIF_ENABLED, false),
  notifGrupo: (process.env.NOTIF_GRUPO || 'Grupo prueba Wholesaler').trim(),
  notifHorarios: list(process.env.NOTIF_HORARIOS || '11:00,17:30').filter((h) => /^\d{1,2}:\d{2}$/.test(h)),
  notifTz: process.env.NOTIF_TZ || 'America/Bogota',

  dirs: {
    inbox: path.join(DATA_DIR, 'inbox'),
    processed: path.join(DATA_DIR, 'processed'),
    failed: path.join(DATA_DIR, 'failed'),
    media: path.join(DATA_DIR, 'media'),
    tier1Jobs: path.join(DATA_DIR, 'tier1-jobs'),
    informes: path.join(DATA_DIR, 'informes'),
    tier2Jobs: path.join(DATA_DIR, 'tier2-jobs'),
    vista: path.join(DATA_DIR, 'vista'),
  },
  leadsFile: path.join(DATA_DIR, 'leads.json'),
  notifFile: path.join(DATA_DIR, 'notificaciones.json'),
  stateFile: path.join(DATA_DIR, 'state.json'),
  jsonlFile: path.join(DATA_DIR, 'propiedades.jsonl'),
  csvFile: path.join(DATA_DIR, 'propiedades.csv'),
  xlsxFile: path.join(DATA_DIR, 'propiedades.xlsx'),
};
