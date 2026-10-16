// Salida 100 % local: propiedades.csv (se abre en Excel) y propiedades.xlsx, regenerados desde data/leads.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { config } from './config.js';
import { listLeads } from './leads.js';
import { writeVista } from './vista.js';

export const COLUMNS = [
  'estado', 'alerta', 'pct_arv', 'criterio', 'mercado_estado', 'mercado_precio', 'mercado_publicado', 'mercado_dias', 'mercado_reducciones', 'tier1_usuario', 'tier1_en', 'tier1_auto', 'tier1_ejecutor', 'informe_estado',
  'inspeccion_se_hace', 'inspeccion_ejecutada', 'inspeccion_obs', 'inspeccion_usuario', 'inspeccion_en',
  'tier2_usuario', 'tier2_en', 'tier2_ejecutor', 'tier2_comparables', 'tier2_fase', 'tier2_estado', 'tier2_detalle', 'compra_usuario', 'compra_en', 'fecha_mensaje', 'grupo', 'autor', 'condado',
  'estado_direccion', 'direccion', 'ciudad', 'zip', 'direccion_verificada', 'metodo_condado',
  'precio_usd', 'arv_usd', 'beds', 'baths', 'sqft', 'lote_sqft', 'anio', 'tipo', 'tipo_negocio',
  'condicion', 'contacto', 'telefono', 'email', 'links_fotos', 'links_portales', 'resumen',
  'duplicado', 'mensaje_original', 'texto_ocr', 'imagenes_locales', 'id_mensaje', 'id', 'procesado_en',
];

/** Campos del estado en el mercado (objeto `mercado`) como columnas planas. */
const fila = (r) => ({ ...r, mercado_estado: r.mercado?.estado, mercado_precio: r.mercado?.precio_lista, mercado_publicado: r.mercado?.fecha_publicacion,
  mercado_dias: r.mercado?.dias_en_mercado, mercado_reducciones: r.mercado?.reducciones?.length });
const toCell = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join('\n') : v);
const csvLine = (vals) => vals.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');

/** Filas del formato anterior (propiedades.jsonl), solo para la migración. */
export async function readLegacyRows() {
  try {
    const raw = await fs.readFile(config.jsonlFile, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Reescribe propiedades.csv, propiedades.xlsx y la vista de solo lectura con los leads activos. */
export async function exportOutputs() {
  const file = await exportCsvXlsx();
  await writeVista().catch((err) => console.warn(`No se pudo actualizar la vista de solo lectura: ${err.message}`));
  return file;
}

async function exportCsvXlsx() {
  const rows = (await listLeads()).map(fila);
  await fs.mkdir(path.dirname(config.csvFile), { recursive: true });
  const lines = [csvLine(COLUMNS), ...rows.map((r) => csvLine(COLUMNS.map((c) => toCell(r[c]))))];
  // BOM para que Excel muestre bien acentos y ñ
  await fs.writeFile(config.csvFile, '﻿' + lines.join('\n') + '\n');
  return exportXlsx();
}

/** Regenera propiedades.xlsx con los leads activos (filtros, encabezado fijo, estado resaltado). */
export async function exportXlsx(file = config.xlsxFile) {
  const rows = (await listLeads()).map(fila);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Propiedades', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c, key: c, width: WIDTHS[c] || 14 }));
  for (const r of rows.slice().reverse()) {
    const row = ws.addRow(Object.fromEntries(COLUMNS.map((c) => [c, toCell(r[c])])));
    const fill = ESTADO_FILL[r.estado];
    if (fill) row.getCell('estado').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  for (const c of ['precio_usd', 'arv_usd']) ws.getColumn(c).numFmt = '$#,##0';
  try {
    await wb.xlsx.writeFile(file);
    return file;
  } catch (err) {
    // En Windows falla si el archivo está abierto en Excel; el CSV sigue actualizado.
    console.warn(`No se pudo actualizar ${file} (¿está abierto en Excel?): ${err.message}`);
    return null;
  }
}

const ESTADO_FILL = { 'Tier 1': 'FFC6EFCE', 'Pendiente dirección': 'FFFFEB9C', 'Revisar condado': 'FFFCE4D6' };
const WIDTHS = { estado: 18, alerta: 30, fecha_mensaje: 20, grupo: 22, direccion: 30, ciudad: 18, resumen: 40, mensaje_original: 60, texto_ocr: 40, links_fotos: 30, links_portales: 30, duplicado: 24, condicion: 22 };
