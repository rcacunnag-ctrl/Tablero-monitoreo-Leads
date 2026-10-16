// Acciones sobre un lead: descartar y recuperar, Tier 1 (manual o por criterios), agregar dirección y precio,
// editar, inspección, Tier 2 y Compra.
import { config } from './config.js';
import { ESTADOS, listLeads, updateLead, discardLead, recuperarLead, purgarPapelera } from './leads.js';
import { resolveManualAddress, computeAlerta, evaluarCriterios, pctArv } from './pipeline.js';
import { lanzarCompAnalysis, setJobState } from './tier1.js';
import { parseMoney } from './extract.js';
import { exportOutputs } from './sink.js';
import { borrarInformes } from './informes.js';
import { encolar } from './notify.js';
import { lanzarTier2, setTier2State, reintentarTier2, COMPARABLES, FASES } from './tier2.js';

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
/** Usuario que figura cuando los criterios pasan un lead a Tier 1 sin intervención. */
export const USUARIO_AUTO = 'Automático';
const PREVIOS_TIER1 = [ESTADOS.nuevo, ESTADOS.revisarCondado, ESTADOS.noCalifica];

function checkEjecutor(ejecutor) {
  if (!config.ejecutores.includes(ejecutor)) throw badRequest(`PC no válido. Opciones: ${config.ejecutores.join(', ')}`);
  return ejecutor;
}

function checkUser(usuario) {
  if (!config.tier1Users.includes(usuario)) throw badRequest(`Usuario no válido. Opciones: ${config.tier1Users.join(', ')}`);
}

async function getLead(id) {
  const lead = (await listLeads()).find((l) => l.id === id);
  if (!lead) throw Object.assign(new Error(`Lead no encontrado: ${id}`), { status: 404 });
  return lead;
}

/** Pasa el lead a Descartados (48 h, recuperable). Sus informes se borran al vencer la papelera. */
export async function descartar(id, usuario = '') {
  await discardLead(id, 'usuario', usuario);
  await exportOutputs();
  return { ok: true, resultado: 'descartado' };
}

export async function recuperar(id, usuario) {
  checkUser(usuario);
  const lead = await recuperarLead(id, usuario);
  await exportOutputs();
  return { ok: true, resultado: 'recuperado', estado: lead.estado };
}

/** Borra los descartados de hace más de 48 h y sus informes. */
export async function purgarDescartados(ahora = Date.now()) {
  const ids = await purgarPapelera(ahora);
  for (const id of ids) await borrarInformes(id);
  return ids.length;
}

/**
 * auto=true: lo pasan los criterios (el informe va al PC de TIER1_AUTO_EJECUTOR y cuenta para su tope diario).
 * ejecutor: PC que corre el informe (selector del panel).
 */
export async function pasarATier1(id, usuario, { auto = false, ejecutor } = {}) {
  if (!(auto && usuario === USUARIO_AUTO)) checkUser(usuario);
  const pc = checkEjecutor(ejecutor || (auto ? config.tier1AutoEjecutor : config.ejecutores[0]));
  const lead = await getLead(id);
  if (lead.estado === ESTADOS.pendienteDireccion) throw badRequest('Primero agrega la dirección');
  if (!PREVIOS_TIER1.includes(lead.estado)) throw badRequest(`El lead ya está en ${lead.estado}`);
  if (!lead.precio_usd) throw badRequest('Falta el precio: agrégalo antes de pasar a Tier 1');
  const updated = await updateLead(id, { estado: ESTADOS.tier1, alerta: computeAlerta({ ...lead, estado: ESTADOS.tier1 }), tier1_usuario: usuario, tier1_en: new Date().toISOString(), tier1_auto: auto, tier1_ejecutor: pc });
  const skill = await lanzarCompAnalysis(updated, usuario, { auto, ejecutor: pc });
  if (skill.lanzado) await updateLead(id, { informe_estado: skill.estado, informe_en: new Date().toISOString() });
  await exportOutputs();
  return { ok: true, resultado: 'tier1', auto, skill };
}

/**
 * Criterios (docs/PLAN-FLUJO-LEADS.md, C1-C3) para un lead Nuevo o No califica:
 * califica -> Tier 1 automático | no califica -> "No califica" con el motivo | falta precio o ARV -> Nuevo.
 */
export async function aplicarCriterios(id, usuario = USUARIO_AUTO) {
  const lead = await getLead(id);
  if (![ESTADOS.nuevo, ESTADOS.noCalifica].includes(lead.estado)) return { ok: true, resultado: 'sin_cambio' };
  const c = evaluarCriterios(lead);
  await updateLead(id, { pct_arv: c.pct, criterio: c.motivo });
  if (c.califica) return pasarATier1(id, usuario, { auto: true });
  const estado = c.califica === false ? ESTADOS.noCalifica : ESTADOS.nuevo;
  await updateLead(id, { estado, alerta: computeAlerta({ ...lead, estado }) });
  await exportOutputs();
  return { ok: true, resultado: c.califica === false ? 'no_califica' : 'falta_arv', motivo: c.motivo };
}

/** Leads recién ingresados desde WhatsApp: se evalúan con los criterios y se avisan al grupo. */
export async function evaluarIngresados(leads, log = console) {
  for (const lead of leads) {
    try {
      if (lead.estado === ESTADOS.nuevo) {
        const r = await aplicarCriterios(lead.id);
        if (r.resultado === 'tier1') log.log?.(`Tier 1 automático: ${lead.direccion} (${(await getLead(lead.id)).pct_arv}% of ARV)`);
      }
      if ((await getLead(lead.id)).alerta) await encolar('alerta', lead.id);
    } catch (err) {
      log.error?.(`Criterios ${lead.id}: ${err.message}`);
    }
  }
}

const money = (v) => {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mm)?$/i.exec(String(v).trim());
  const n = m ? parseMoney(m[1], m[2]) : NaN;
  if (!(n >= 1000)) throw badRequest(`Monto no válido: "${v}" (ej. 325000, 325,000 o $325k)`);
  return n;
};

/**
 * Agrega el precio que dio el wholesaler (y el ARV, opcional) a un lead que no lo tenía.
 * Un ARV vacío deja el que ya hubiera. Registra quién lo hizo.
 */
export async function agregarPrecio(id, body, usuario) {
  checkUser(usuario);
  const lead = await getLead(id);
  if (lead.precio_usd) throw badRequest('Este lead ya tiene precio');
  if (!String(body.precio_usd ?? '').trim()) throw badRequest('Falta el precio');
  const patch = { precio_usd: money(body.precio_usd) };
  if (String(body.arv_usd ?? '').trim()) patch.arv_usd = money(body.arv_usd);
  const cambios = [...(lead.cambios || []), { en: new Date().toISOString(), usuario, campos: Object.keys(patch) }].slice(-20);
  await updateLead(id, { ...patch, cambios, alerta: computeAlerta({ ...lead, ...patch }) });
  if (lead.estado === ESTADOS.nuevo) return aplicarCriterios(id, usuario);
  await exportOutputs();
  return { ok: true, resultado: 'precio' };
}

/** Recalcula alertas, % of ARV y motivo de No califica de todos los leads (al arrancar, por si cambian las reglas). */
export async function refreshAlertas() {
  let n = 0;
  for (const lead of await listLeads()) {
    const patch = {};
    const alerta = computeAlerta(lead);
    if (alerta !== (lead.alerta || '')) patch.alerta = alerta;
    const pct = pctArv(lead);
    if (pct !== (lead.pct_arv ?? null) || 'margen_pct' in lead) Object.assign(patch, { pct_arv: pct, margen_pct: undefined });
    if (lead.estado === ESTADOS.noCalifica) {
      const { motivo } = evaluarCriterios(lead);
      if (motivo && motivo !== lead.criterio) patch.criterio = motivo;
    }
    if (Object.keys(patch).length) {
      await updateLead(lead.id, patch);
      n++;
    }
  }
  if (n) await exportOutputs();
  return n;
}

/** El PC que ejecuta el skill reporta el avance de la orden; se refleja en el lead (si sigue activo). */
export async function reportarInforme(id, body) {
  const job = await setJobState(id, body);
  if ((await listLeads()).some((l) => l.id === id)) {
    if (job.estado === 'listo') await encolar('informe_t1', id, job.detalle || '');
    if (job.estado === 'error') await encolar('informe_t1_error', id, job.detalle || '');
    await updateLead(id, { informe_estado: job.estado, informe_ruta: job.ruta || '', informe_detalle: job.detalle || '', informe_en: job.actualizado_en });
    await exportOutputs();
  }
  return { ok: true, orden: job };
}

/**
 * El usuario ingresa la dirección que le dio el wholesaler.
 * En condado objetivo -> Tier 1 (o Nuevo si falta el precio) | otro condado -> descartado |
 * sin determinar -> no cambia y pide ciudad/ZIP.
 */
export async function agregarDireccion(id, direccion, usuario, deps = {}) {
  checkUser(usuario);
  await getLead(id);
  const { listing, geo, key, enZona } = await resolveManualAddress(direccion, deps);
  if (enZona === null) {
    throw badRequest('No se pudo confirmar el condado. Revisa la calle y agrega ciudad y ZIP.');
  }
  const lead = await getLead(id);
  await updateLead(id, {
    estado: ESTADOS.nuevo,
    alerta: computeAlerta({ ...lead, estado: ESTADOS.nuevo }),
    direccion: listing.street_address,
    ciudad: listing.city || geo.city || null,
    zip: listing.zip || geo.zip || null,
    condado: geo.county,
    metodo_condado: geo.method,
    direccion_verificada: geo.matchedAddress,
    estado_direccion: listing.city || listing.zip ? 'COMPLETA' : 'PARCIAL',
    clave_direccion: key,
    direccion_manual: true,
  });
  if (!enZona) {
    await discardLead(id, `fuera de condado (${geo.county})`);
    await exportOutputs();
    return { ok: true, resultado: 'descartado', condado: geo.county };
  }
  if (!lead.precio_usd) {
    // En zona pero sin precio: queda como Nuevo con la alerta de precio hasta que se agregue
    await exportOutputs();
    return { ok: true, resultado: 'falta_precio', condado: geo.county };
  }
  const out = await aplicarCriterios(id, usuario);
  return { ...out, condado: geo.county };
}

/** Tipos de propiedad (como los guarda la extracción; el panel los muestra en español). */
export const TIPOS = ['single_family', 'condo', 'townhouse', 'multifamily', 'land', 'commercial', 'mobile_home', 'other', 'unknown'];
const EDITABLES = [ESTADOS.nuevo, ESTADOS.pendienteDireccion, ESTADOS.revisarCondado, ESTADOS.noCalifica];
const numero = (v, campo) => {
  const t = String(v ?? '').trim().replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  if (!(n >= 0)) throw badRequest(`${campo} no válido: "${v}"`);
  return n;
};

/**
 * Edita los datos de un lead en Nuevo (piñón del panel). Si cambia la dirección se vuelve a verificar el
 * condado (fuera de zona -> Descartados); si cambian precio, ARV o la etapa se recalculan los criterios.
 */
export async function editarLead(id, body, usuario, deps = {}) {
  checkUser(usuario);
  const lead = await getLead(id);
  if (!EDITABLES.includes(lead.estado)) throw badRequest('Solo se editan leads en Nuevo');
  const txt = (k) => String(body[k] ?? '').trim();
  const patch = {
    precio_usd: txt('precio_usd') ? money(body.precio_usd) : null,
    arv_usd: txt('arv_usd') ? money(body.arv_usd) : null,
    beds: numero(body.beds, 'Beds'),
    baths: numero(body.baths, 'Baths'),
    sqft: numero(body.sqft, 'Sqft'),
  };
  if (txt('tipo')) {
    if (!TIPOS.includes(txt('tipo'))) throw badRequest(`Tipo no válido. Opciones: ${TIPOS.join(', ')}`);
    patch.tipo = txt('tipo');
  }
  let estado = lead.estado;
  const calle = txt('calle'), ciudad = txt('ciudad'), zip = txt('zip'), condado = txt('condado');
  if (!calle && lead.direccion) throw badRequest('La dirección no puede quedar vacía');
  if (calle && (calle !== (lead.direccion || '') || ciudad !== (lead.ciudad || '') || zip !== (lead.zip || ''))) {
    const { listing, geo, key, enZona } = await resolveManualAddress({ calle, ciudad, zip }, deps);
    Object.assign(patch, {
      direccion: listing.street_address, ciudad: listing.city || geo.city || null, zip: listing.zip || geo.zip || null,
      condado: geo.county, metodo_condado: geo.method, direccion_verificada: geo.matchedAddress,
      estado_direccion: listing.city || listing.zip ? 'COMPLETA' : 'PARCIAL', clave_direccion: key, direccion_manual: true,
    });
    if (enZona === false) {
      await updateLead(id, patch);
      await discardLead(id, `fuera de condado (${geo.county})`, usuario);
      await exportOutputs();
      return { ok: true, resultado: 'descartado', condado: geo.county };
    }
    estado = enZona ? (estado === ESTADOS.noCalifica ? estado : ESTADOS.nuevo) : ESTADOS.revisarCondado;
  }
  // Condado a mano: solo si no lo resolvió la dirección
  const geoCondado = 'condado' in patch && patch.condado;
  if (condado && !geoCondado && ('condado' in patch || condado !== (lead.condado || ''))) {
    if (!config.targetCounties.includes(condado)) throw badRequest(`Condado no válido. Opciones: ${config.targetCounties.join(', ')}`);
    Object.assign(patch, { condado, metodo_condado: 'manual' });
    if (estado === ESTADOS.revisarCondado) estado = ESTADOS.nuevo;
  }
  const campos = Object.keys(patch).filter((k) => (patch[k] ?? null) !== (lead[k] ?? null));
  if (!campos.length && estado === lead.estado) return { ok: true, resultado: 'sin_cambio' };
  const cambios = [...(lead.cambios || []), { en: new Date().toISOString(), usuario, campos }].slice(-20);
  const nuevo = { ...lead, ...patch, estado };
  // Antes de guardar: updateLead modifica el mismo objeto `lead`
  const criterios = campos.some((k) => ['precio_usd', 'arv_usd'].includes(k)) || estado !== lead.estado;
  await updateLead(id, { ...patch, estado, cambios, pct_arv: pctArv(nuevo), alerta: computeAlerta(nuevo) });
  if (criterios && [ESTADOS.nuevo, ESTADOS.noCalifica].includes(estado)) {
    return aplicarCriterios(id, usuario);
  }
  await exportOutputs();
  return { ok: true, resultado: 'editado' };
}

const SI_NO = ['Sí', 'No'];
const EJECUCION = ['Pendiente', 'Sí', 'No'];

/** Inspección de un lead en Tier 1: si se hace, si se ejecutó y la observación. */
export async function registrarInspeccion(id, body, usuario) {
  checkUser(usuario);
  const lead = await getLead(id);
  if (lead.estado !== ESTADOS.tier1) throw badRequest('La inspección se registra en Tier 1');
  const seHace = String(body.inspeccion_se_hace ?? '');
  const ejecutada = seHace === 'No' ? 'No' : String(body.inspeccion_ejecutada ?? 'Pendiente');
  if (!SI_NO.includes(seHace)) throw badRequest('Indica si se hace la inspección (Sí o No)');
  if (!EJECUCION.includes(ejecutada)) throw badRequest(`Ejecución no válida. Opciones: ${EJECUCION.join(', ')}`);
  await updateLead(id, {
    inspeccion_se_hace: seHace,
    inspeccion_ejecutada: ejecutada,
    inspeccion_obs: String(body.inspeccion_obs ?? '').trim().slice(0, 2000),
    inspeccion_usuario: usuario,
    inspeccion_en: new Date().toISOString(),
  });
  await exportOutputs();
  return { ok: true, resultado: 'inspeccion' };
}

/** Avance manual Tier 2 -> Compra, con usuario y fecha (Tier 1 -> Tier 2 es pasarATier2). */
const AVANCES = { compra: [ESTADOS.tier2, ESTADOS.compra] };

export async function avanzar(id, a, usuario) {
  checkUser(usuario);
  if (!AVANCES[a]) throw badRequest(`Avance no válido: ${a}`);
  const [desde, hacia] = AVANCES[a];
  const lead = await getLead(id);
  if (lead.estado !== desde) throw badRequest(`Solo un lead en ${desde} puede pasar a ${hacia}`);
  await updateLead(id, { estado: hacia, [`${a}_usuario`]: usuario, [`${a}_en`]: new Date().toISOString() });
  await exportOutputs();
  return { ok: true, resultado: a };
}

/**
 * Tier 1 -> Tier 2. Si el condado lo cubren los skills (Broward, Palm Beach) deja la orden de las
 * fases 1–4 para el PC; en otro condado (Martin) solo cambia la etapa: es excepción manual.
 */
export async function pasarATier2(id, body, usuario) {
  checkUser(usuario);
  const lead = await getLead(id);
  if (lead.estado !== ESTADOS.tier1) throw badRequest('Solo un lead en Tier 1 puede pasar a Tier 2');
  const comparables = Number(body.comparables || 12);
  const pc = checkEjecutor(body.ejecutor || config.ejecutores[0]);
  if (!COMPARABLES.includes(comparables)) throw badRequest(`Comparables: ${COMPARABLES.join(', ')}`);
  const cubierto = config.tier2Counties.some((c) => c.toLowerCase() === String(lead.condado || '').toLowerCase());
  const updated = await updateLead(id, { estado: ESTADOS.tier2, tier2_usuario: usuario, tier2_en: new Date().toISOString(), tier2_comparables: comparables, tier2_ejecutor: pc });
  const skill = cubierto ? await lanzarTier2(updated, usuario, { comparables, ejecutor: pc }) : { lanzado: false, motivo: `${lead.condado || 'condado sin confirmar'}: Tier 2 manual (los skills cubren ${config.tier2Counties.join(' y ')})` };
  await updateLead(id, skill.lanzado ? { tier2_estado: 'pendiente', tier2_fase: 1, tier2_detalle: '' } : { tier2_estado: '', tier2_detalle: skill.motivo });
  await exportOutputs();
  return { ok: true, resultado: 'tier2', skill };
}

/** El PC reporta el avance de una fase de Tier 2; se refleja en el lead y avisa si falla. */
export async function reportarTier2(id, body) {
  const job = await setTier2State(id, body);
  if ((await listLeads()).some((l) => l.id === id)) {
    await updateLead(id, { tier2_estado: job.estado, tier2_fase: job.fase, tier2_detalle: job.detalle || '', tier2_actualizado: job.actualizado_en });
    if (job.estado === 'error') await encolar('informe_t2_error', id, `Fase ${job.fase} (${FASES[job.fase]}): ${job.detalle || 'sin detalle'}`);
    await exportOutputs();
  }
  return { ok: true, orden: job };
}

export async function reintentarTier2Lead(id, usuario) {
  checkUser(usuario);
  const job = await reintentarTier2(id);
  await updateLead(id, { tier2_estado: job.estado, tier2_detalle: job.detalle });
  await exportOutputs();
  return { ok: true, resultado: 'reintento', fase: job.fase };
}
