// Leads de la exportación semanal de Matrix (Beaches MLS). El importador del PC (mls/mls_importar.py --publicar) los envía aquí
// ya filtrados y con sus señales. Para no generar más ruido del que se puede manejar, todos entran a una COLA (mls_cola):
// ocultos y sin que el Tier 1-V2 los toque. Desde MLS_LIBERAR_DESDE se sueltan MLS_LIBERAR_DIA por día (liberarMls), primero los
// que tienen señal de negociación (condición especial, Listing Terms de financiamiento, comentarios de vendedor motivado o de
// financiamiento) y después los demás. Al liberarse:
//  - con señal: quedan visibles en el tablero y el Tier 1-V2 los puntúa;
//  - sin señal: siguen ocultos (mls_oculto) y solo se muestran si el Tier 1-V2 da MLS_SCORE_MIN (60) o más; si no, pasan a
//    Descartados (5 días) con el puntaje. Si después el precio baja 5 % o más, vuelven a entrar a la cola.
// No pasan por los criterios de Tier 1 automático (no traen ARV). El texto de los comentarios se guarda solo para mostrarlo.
import crypto from 'node:crypto';
import { config } from './config.js';
import { withLeads, discardLead, esOportunidad, listLeads } from './leads.js';
import { encolarOportunidad } from './notify.js';
import { addressKey } from './store.js';
import { inTargetCounty } from './pipeline.js';
import { exportOutputs } from './sink.js';

export const USUARIO_MLS = 'Automático';
const REBAJA_REENTRADA = 0.95;
const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && v !== null && v !== '' ? Number(v) : null);
const lista = (v, max, n) => [...new Set([].concat(v || []).map((x) => texto(x, max)).filter(Boolean))].slice(0, n);

/** Valida una fila del importador; devuelve el lead (sin id) o { rechazo }. */
export function filaMls(r) {
  const mlsId = texto(r.mls_id, 20).toUpperCase();
  if (!/^[A-Z]{1,2}\d{5,}$/.test(mlsId)) return { rechazo: `MLS# no válido: ${mlsId || '(vacío)'}` };
  const direccion = texto(r.direccion, 120);
  if (!direccion || !/^\d/.test(direccion)) return { rechazo: `${mlsId}: dirección sin número` };
  const precio = num(r.precio_usd);
  if (!precio) return { rechazo: `${mlsId}: sin precio` };
  const condado = (config.targetCounties.find((c) => c.toLowerCase() === texto(r.condado, 30).toLowerCase()));
  if (!condado || !inTargetCounty(condado)) return { rechazo: `${mlsId}: fuera de condado (${texto(r.condado, 30)})` };
  const ciudad = texto(r.ciudad, 60);
  const zip = texto(r.zip, 10).slice(0, 5);
  const senales = lista(r.senales, 60, 8);
  const ahora = new Date().toISOString();
  return {
    lead: {
      estado: 'Nuevo', alerta: '', origen: 'MLS', mls_oculto: true, mls_cola: true,
      mls: { id: mlsId, fuentes: lista(r.fuentes, 40, 6), senales, estado: texto(r.estado, 20), dom: num(r.dom), fecha_lista: texto(r.fecha_lista, 10) || null,
        condiciones: texto(r.condiciones_especiales, 80), folio: texto(r.folio, 30), comentarios: texto(r.comentarios, 600), snapshot: texto(r.snapshot, 10) || null, visto_en: ahora },
      fecha_mensaje: texto(r.fecha_lista, 10) ? `${texto(r.fecha_lista, 10)}T12:00:00.000Z` : ahora, grupo: 'MLS Matrix', autor: 'MLS',
      condado, metodo_condado: 'mls', estado_direccion: 'COMPLETA', direccion, ciudad, zip: zip || null,
      precio_usd: precio, arv_usd: null, beds: num(r.beds), baths: num(r.baths), sqft: num(r.sqft), lote_sqft: num(r.lote_sqft), anio: num(r.anio),
      tipo: 'single_family', tipo_negocio: null, condicion: null, resumen: senales.join(' · ') || null, mensaje_original: '', duplicado: 'NO',
      clave_direccion: addressKey({ street_address: direccion }, { matchedAddress: [direccion, ciudad, 'FL', zip].filter(Boolean).join(', ') }),
      procesado_en: ahora,
    },
  };
}

/**
 * Ingresa las filas de una exportación. Devuelve el resumen: nuevos (visibles y ocultos), actualizados, repetidos de lo ya descartado y rechazados.
 */
export async function ingresarMls(rows) {
  const out = { nuevos: 0, en_cola: 0, con_senal: 0, actualizados: 0, reentradas: 0, omitidos_descartados: 0, rechazados: [] };
  await withLeads((data) => {
    for (const row of rows) {
      const v = filaMls(row);
      if (v.rechazo) { out.rechazados.push(v.rechazo); continue; }
      const nuevo = v.lead;
      const previo = data.leads.find((l) => l.mls?.id === nuevo.mls.id || (nuevo.clave_direccion && l.clave_direccion === nuevo.clave_direccion));
      if (previo) {
        const senales = [...new Set([...(previo.mls?.senales || []), ...nuevo.mls.senales])];
        const rebaja = previo.precio_usd && nuevo.precio_usd < previo.precio_usd;
        if (previo.origen === 'MLS') {
          previo.mls = { ...previo.mls, ...nuevo.mls, senales, fuentes: [...new Set([...(previo.mls?.fuentes || []), ...nuevo.mls.fuentes])], ...(rebaja ? { precio_anterior: previo.precio_usd } : {}) };
          previo.resumen = senales.join(' · ') || null;
          if (previo.mls_oculto && !previo.mls_cola && senales.length) previo.mls_oculto = false; // ya liberado y apareció una señal de negociación
        }
        if (nuevo.precio_usd !== previo.precio_usd) { previo.precio_repost = nuevo.precio_usd; if (previo.origen === 'MLS') previo.precio_usd = nuevo.precio_usd; }
        previo.actualizado_en = nuevo.mls.visto_en;
        out.actualizados += 1;
        continue;
      }
      const bloqueo = nuevo.clave_direccion && data.descartados[nuevo.clave_direccion];
      if (bloqueo) {
        const baja = bloqueo.motivo?.startsWith('MLS:') && bloqueo.precio && nuevo.precio_usd <= bloqueo.precio * REBAJA_REENTRADA;
        if (!baja) { out.omitidos_descartados += 1; continue; }
        delete data.descartados[nuevo.clave_direccion];
        nuevo.mls.reentrada = `precio ${bloqueo.precio} → ${nuevo.precio_usd}`;
        out.reentradas += 1;
      }
      data.leads.push({ id: crypto.randomUUID(), ...nuevo });
      out.nuevos += 1;
      if (nuevo.mls.senales.length) out.con_senal += 1;
      out.en_cola += 1;
    }
  });
  await exportOutputs();
  return out;
}

const dia = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: config.timeZone });

/**
 * Suelta de la cola hasta MLS_LIBERAR_DIA leads por día desde MLS_LIBERAR_DESDE: primero los que tienen señal (más señales y menor
 * precio primero), luego los demás. Los liberados con señal quedan visibles; los demás esperan el puntaje del Tier 1-V2.
 */
export async function liberarMls(ahora = Date.now()) {
  const hoy = dia(ahora);
  if (hoy < config.mlsLiberarDesde) return { liberados: 0, motivo: `desde ${config.mlsLiberarDesde}` };
  const liberados = await withLeads((data) => {
    const ya = [...data.leads, ...data.papelera].filter((l) => l.mls?.liberado_en && dia(l.mls.liberado_en) === hoy).length;
    const cupo = Math.max(0, config.mlsLiberarDia - ya);
    const cola = data.leads.filter((l) => l.mls_cola)
      .sort((a, b) => (b.mls.senales.length > 0) - (a.mls.senales.length > 0) || b.mls.senales.length - a.mls.senales.length || a.precio_usd - b.precio_usd)
      .slice(0, cupo);
    for (const l of cola) {
      l.mls_cola = false;
      l.mls_oculto = !l.mls.senales.length;
      l.mls = { ...l.mls, liberado_en: new Date(ahora).toISOString() };
      l.actualizado_en = l.mls.liberado_en;
    }
    return cola.map((l) => l.id);
  });
  if (liberados.length) {
    for (const l of (await listLeads()).filter((x) => liberados.includes(x.id) && esOportunidad(x))) await encolarOportunidad(l.id); // los liberados con señal
    await exportOutputs();
  }
  return { liberados: liberados.length };
}

/** El Tier 1-V2 terminó un lead oculto de MLS: se muestra con MLS_SCORE_MIN o más; si no, a Descartados con el puntaje. */
export async function resolverMlsOculto(lead, score) {
  if (lead.mls?.senales?.length) return 'señal'; // con señal de negociación nunca se descarta por puntaje
  const min = config.mlsScoreMin;
  if (Number.isFinite(score) && score >= min) {
    await withLeads((data) => {
      const l = data.leads.find((x) => x.id === lead.id);
      if (!l) return;
      l.mls_oculto = false;
      l.mls = { ...l.mls, visible_por: `Tier 1-V2 ${score}/100` };
      l.resumen = [`Tier 1-V2 ${score}/100`, ...(l.mls?.senales || [])].join(' · ');
      l.actualizado_en = new Date().toISOString();
    });
    return 'visible';
  }
  const precio = lead.precio_usd;
  await discardLead(lead.id, `MLS: Tier 1-V2 ${Number.isFinite(score) ? `${score}/100` : 'sin puntaje'} (mínimo ${min})`, USUARIO_MLS);
  await withLeads((data) => {
    const e = lead.clave_direccion && data.descartados[lead.clave_direccion];
    if (e) e.precio = precio;
  });
  return 'descartado';
}
