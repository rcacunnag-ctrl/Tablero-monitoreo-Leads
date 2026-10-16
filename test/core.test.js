import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'wapm-'));
process.env.USE_CENSUS_GEOCODER = 'false';
process.env.VISTA_TOKEN = 'tok-de-prueba-123';

const { countyFromCity, countyFromZip } = await import('../src/counties.js');
const { extractListings, parseMoney } = await import('../src/extract.js');
const { exportOutputs } = await import('../src/sink.js');
const { parseCensusResponse, resolveCounty } = await import('../src/geo.js');
const { parseExport, groupIntoPosts } = await import('../src/import-chat.js');
const { processPost, classify } = await import('../src/pipeline.js');
const leadsMod = await import('../src/leads.js');
const actions = await import('../src/actions.js');
const { ESTADOS } = leadsMod;
const { addressKey } = await import('../src/store.js');

test('ciudad -> condado', () => {
  assert.equal(countyFromCity('Ft. Lauderdale').county, 'Broward');
  assert.equal(countyFromCity('WEST PALM BEACH, FL').county, 'Palm Beach');
  assert.equal(countyFromCity('Hobe Sound').county, 'Martin');
  assert.equal(countyFromCity('Miami').county, 'Miami-Dade');
  assert.equal(countyFromCity('Orlando').county, 'Orange');
  assert.equal(countyFromCity('Springfield').county, null);
  assert.equal(countyFromCity('Jupiter').ambiguous, true);
});

test('respuesta del Census geocoder', () => {
  const json = { result: { addressMatches: [{
    matchedAddress: '1234 NW 5TH AVE, FORT LAUDERDALE, FL, 33311',
    coordinates: { x: -80.15, y: 26.13 },
    addressComponents: { zip: '33311', state: 'FL' },
    geographies: { Counties: [{ NAME: 'Broward County', BASENAME: 'Broward' }] },
  }] } };
  const r = parseCensusResponse(json);
  assert.equal(r.county, 'Broward');
  assert.equal(r.zip, '33311');
  assert.equal(parseCensusResponse({ result: { addressMatches: [] } }), null);
});

test('condado offline: ZIP primero, luego ciudad; Census solo si se habilita', async () => {
  assert.equal(countyFromZip('33062').county, 'Broward');
  assert.equal(countyFromZip('34997').county, 'Martin');
  assert.equal(countyFromZip('33469').ambiguous, true);
  const noNet = async () => { throw new Error('no debería llamar a internet'); };
  const r1 = await resolveCounty({ street_address: '1 Main St', city: 'Stuart', zip: '33311' }, { fetchImpl: noNet });
  assert.equal(r1.county, 'Broward'); // ZIP gana...
  assert.equal(r1.ambiguous, true); // ...pero ZIP y ciudad no coinciden: revisar
  const r2 = await resolveCounty({ street_address: '1 Main St', city: 'Stuart' }, { fetchImpl: noNet });
  assert.equal(r2.method, 'city_table');
  const failing = async () => { throw new Error('network'); };
  const r3 = await resolveCounty({ street_address: '1 Main St', city: 'Jupiter' }, { useCensus: true, fetchImpl: failing });
  assert.equal(r3.county, 'Palm Beach'); // si el Census falla, se queda con la tabla
});

test('dinero', () => {
  assert.equal(parseMoney('325', 'k'), 325000);
  assert.equal(parseMoney('1.2', 'M'), 1200000);
  assert.equal(parseMoney('325,000'), 325000);
});

const ex = async (text) => extractListings({ text }, { ocr: false });

test('extracción: anuncio en inglés completo', async () => {
  const r = await ex(`CASH BUYERS ONLY - Wholesale deal
📍 4521 SE MURRAY ST, STUART FL 34997
4 bed 2 bath, 1,980 sf, lot 10,000 sqft, built 1978
Price: $389,000 / ARV: $525K
Repairs ~$60k. EMD $10k
Contact Mike 772.555.0199 mike@deals.com
https://www.zillow.com/homedetails/4521-SE-Murray-St`);
  assert.equal(r.is_property_listing, true);
  const [l] = r.listings;
  assert.equal(l.street_address, '4521 SE Murray St');
  assert.equal(l.city, 'Stuart');
  assert.equal(l.zip, '34997');
  assert.equal(l.address_status, 'complete');
  assert.equal(l.price_usd, 389000);
  assert.equal(l.arv_usd, 525000);
  assert.deepEqual([l.beds, l.baths, l.sqft, l.lot_sqft, l.year_built], [4, 2, 1980, 10000, 1978]);
  assert.equal(l.deal_type, 'wholesale');
  assert.equal(l.contact_name, 'Mike');
  assert.equal(l.contact_phone, '(772) 555-0199');
  assert.equal(l.contact_email, 'mike@deals.com');
  assert.equal(l.portal_links.length, 1);
});

test('extracción: formato 3/2, precio con k, link de fotos', async () => {
  const [l] = (await ex(`🔥 OFF MARKET 🔥
1234 NW 5th Ave, Fort Lauderdale, FL 33311
3/2 | 1,450 sqft | Needs rehab
Asking $325k  ARV $480k
Fotos: https://photos.app.goo.gl/abc123
Call/Text 561-555-0101`)).listings;
  assert.deepEqual([l.street_address, l.city, l.zip], ['1234 NW 5th Ave', 'Fort Lauderdale', '33311']);
  assert.deepEqual([l.price_usd, l.arv_usd, l.beds, l.baths, l.sqft], [325000, 480000, 3, 2, 1450]);
  assert.equal(l.deal_type, 'off_market');
  assert.equal(l.condition, 'needs rehab');
  assert.deepEqual(l.photo_links, ['https://photos.app.goo.gl/abc123']);
});

test('extracción: español sin dirección (parcial) y fuera de zona', async () => {
  const [l] = (await ex('Se vende casa en Miami, 3 hab 2 baños, $520,000 precio negociable')).listings;
  assert.equal(l.address_status, 'partial');
  assert.equal(l.city, 'Miami');
  assert.deepEqual([l.beds, l.baths, l.price_usd, l.property_type], [3, 2, 520000, 'single_family']);
});

test('extracción: varias propiedades en un mensaje', async () => {
  const r = await ex(`Two deals today:
1) 820 Lake Ave, Lake Worth Beach 33460 - 3/1 - $299k
2) 1500 S Ocean Blvd Unit 1203, Boca Raton, FL 33432 condo 2/2 $650,000`);
  assert.equal(r.listings.length, 2);
  assert.deepEqual(r.listings.map((l) => l.price_usd), [299000, 650000]);
  assert.equal(r.listings[1].street_address, '1500 S Ocean Blvd Unit 1203');
  assert.equal(r.listings[0].property_type, 'unknown');
  assert.equal(r.listings[1].property_type, 'condo');
});

test('extracción: charla y preguntas no son anuncios; renta mencionada no cambia el tipo', async () => {
  assert.equal((await ex('Buenas tardes a todos!')).is_property_listing, false);
  assert.equal((await ex('Who has buyers in Port St Lucie? Need something under $300k')).is_property_listing, false);
  const [l] = (await ex('Townhome in Weston, 3/2.5, asking 715k, rent $3,500/mo')).listings;
  assert.deepEqual([l.price_usd, l.baths, l.property_type, l.deal_type], [715000, 2.5, 'townhouse', 'unknown']);
});

test('OCR local de un flyer (sin internet)', { timeout: 120000 }, async () => {
  const r = await extractListings({ text: '', images: [{ path: new URL('./fixtures/flyer.png', import.meta.url).pathname }] }, { ocr: true });
  (await import('../src/ocr.js')).closeOcr();
  const [l] = r.listings;
  assert.equal(l.street_address, '2750 NE 15th St');
  assert.equal(l.zip, '33062');
  assert.equal(l.price_usd, 410000);
});

test('salida local: CSV + Excel desde leads.json', async () => {
  await leadsMod.addLeads([{ estado: ESTADOS.nuevo, fecha_mensaje: 't', direccion: '1 Main St', precio_usd: 100000, imagenes_locales: [] }]);
  const file = await exportOutputs();
  assert.ok(file && (await fs.stat(file)).size > 0);
  const csv = await fs.readFile(path.join(process.env.DATA_DIR, 'propiedades.csv'), 'utf8');
  assert.match(csv, /"estado"/);
  assert.match(csv, /1 Main St/);
});

test('reglas de entrada R2-R6', () => {
  const geoB = { county: 'Broward', ambiguous: false };
  assert.deepEqual(classify({ street_address: null, arv_usd: null }, {}), { descartar: 'sin dirección ni ARV' });
  assert.equal(classify({ street_address: null, arv_usd: 400000 }, {}).estado, ESTADOS.pendienteDireccion);
  assert.match(classify({ street_address: null, arv_usd: 400000 }, {}).alerta, /wholesaler/);
  assert.equal(classify({ street_address: '1 Main St' }, geoB).estado, ESTADOS.nuevo);
  assert.equal(classify({ street_address: '1 Main St' }, { county: 'Martin' }).estado, ESTADOS.nuevo);
  assert.match(classify({ street_address: '1 Main St' }, { county: 'Miami-Dade' }).descartar, /fuera de condado/);
  assert.equal(classify({ street_address: '1 Main St' }, { county: null }).estado, ESTADOS.revisarCondado);
  assert.equal(classify({ street_address: '1 Main St' }, { county: 'Palm Beach', ambiguous: true }).estado, ESTADOS.revisarCondado);
});

test('parser de chat exportado (iOS) y agrupación por autor', async () => {
  const raw = await fs.readFile(new URL('./fixtures/chat-ios.txt', import.meta.url), 'utf8');
  const msgs = parseExport(raw);
  assert.equal(msgs.length, 5);
  assert.equal(msgs[1].sender, 'Carlos Wholesale');
  assert.match(msgs[1].text, /Call\/Text 561-555-0101/);
  assert.equal(msgs[3].date.getHours(), 14);
  const posts = groupIntoPosts(msgs, 90);
  assert.equal(posts.length, 4); // texto + foto de Carlos se unen
  assert.equal(posts[1].parts.length, 2);
});

test('parser formato Android', () => {
  const msgs = parseExport('10/2/26, 8:05 PM - Ana: Casa en Weston $900k\nsegunda línea');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].date.getHours(), 20);
  assert.match(msgs[0].text, /segunda línea/);
});

test('normalización de direcciones para duplicados', () => {
  const a = addressKey({ street_address: '1234 Northwest 5th Avenue', zip: '33311' });
  const b = addressKey({ street_address: '1234 NW 5th Ave.', zip: '33311' });
  assert.equal(a, b);
  assert.equal(addressKey({ street_address: null, city: 'Weston' }), null);
});

test('pipeline completo con extracción simulada y detección de duplicados', async () => {
  const listing = {
    street_address: '1234 NW 5th Ave', city: 'Fort Lauderdale', state: 'FL', zip: '33311',
    address_status: 'complete', price_usd: 325000, arv_usd: 480000, beds: 3, baths: 2, sqft: 1450,
    lot_sqft: null, year_built: null, property_type: 'single_family', deal_type: 'off_market',
    condition: 'needs rehab', contact_name: null, contact_phone: '561-555-0101', contact_email: null,
    photo_links: ['https://photos.app.goo.gl/abc123'], portal_links: [], summary: 'SFH off-market en Fort Lauderdale',
  };
  const deps = {
    extract: async () => ({ is_property_listing: true, listings: [listing] }),
    geocode: async () => ({ county: 'Broward', method: 'census_geocoder', matchedAddress: '1234 NW 5TH AVE, FORT LAUDERDALE, FL, 33311', ambiguous: false }),
  };
  const { rows: [row] } = await processPost({ id: 'm1', timestamp: 't1', groupName: 'G1', sender: 'Carlos', text: 'x' }, deps);
  assert.equal(row.estado, ESTADOS.nuevo);
  assert.equal(row.estado_direccion, 'COMPLETA');
  assert.equal(row.duplicado, 'NO');
  assert.ok(row.clave_direccion);
  const { rows: [dup] } = await processPost({ id: 'm2', timestamp: 't2', groupName: 'G2', sender: 'Otro', text: 'x' }, deps);
  assert.match(dup.duplicado, /^SI/);

  const fuera = await processPost({ id: 'm4', text: 'x' }, { ...deps, geocode: async () => ({ county: 'Miami-Dade', ambiguous: false }) });
  assert.equal(fuera.rows.length, 0);
  assert.equal(fuera.descartes.length, 1);

  const none = await processPost({ id: 'm3', text: 'hola' }, { extract: async () => ({ is_property_listing: false, listings: [] }) });
  assert.deepEqual(none, { rows: [], descartes: [] });
});

test('acciones: descartar va a la papelera 48 h, se recupera y bloquea reingreso; Tier 1 registra usuario', async () => {
  const [a, b, sinPrecio] = await leadsMod.addLeads([
    { estado: ESTADOS.nuevo, direccion: '10 A St', clave_direccion: '10 A ST 33311' },
    { estado: ESTADOS.nuevo, direccion: '20 B St', clave_direccion: '20 B ST 33311' },
    { estado: ESTADOS.nuevo, direccion: '30 C St' },
  ]);
  await actions.descartar(a.id);
  const ids = (await leadsMod.listLeads()).map((l) => l.id);
  assert.ok(!ids.includes(a.id));
  const again = await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '10 A St', clave_direccion: '10 A ST 33311' }]);
  assert.equal(again.length, 0);
  assert.equal((await leadsMod.listPapelera()).find((l) => l.id === a.id).descartado_motivo, 'usuario');
  // Recuperar: vuelve con su etapa y la dirección se desbloquea
  assert.equal((await actions.recuperar(a.id, 'Carlos')).estado, ESTADOS.nuevo);
  assert.ok((await leadsMod.listLeads()).some((l) => l.id === a.id));
  assert.equal((await leadsMod.loadLeads()).descartados['10 A ST 33311'], undefined);
  await assert.rejects(actions.recuperar(a.id, 'Carlos'), /no encontrado/);
  // A las 48 h se borra: no deja ningún dato, solo la clave
  await actions.descartar(a.id, 'Carlos');
  assert.equal(await actions.purgarDescartados(Date.now() + 47 * 36e5), 0);
  assert.equal(await actions.purgarDescartados(Date.now() + 49 * 36e5), 1);
  const raw = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'leads.json'), 'utf8'));
  assert.ok(raw.descartados['10 A ST 33311']);
  assert.ok(!JSON.stringify([raw.leads, raw.papelera]).includes('10 A St'));

  await assert.rejects(actions.pasarATier1(b.id, 'Pedro'), /Usuario no válido/);
  await assert.rejects(actions.pasarATier1(sinPrecio.id, 'Carlos'), /Falta el precio/);
  await leadsMod.updateLead(b.id, { precio_usd: 300000 });
  const t1 = await actions.pasarATier1(b.id, 'Carlos');
  assert.equal(t1.skill.lanzado, false); // por habilitar
  const lead = (await leadsMod.listLeads()).find((l) => l.id === b.id);
  assert.equal(lead.estado, ESTADOS.tier1);
  assert.equal(lead.tier1_usuario, 'Carlos');
});

test('acciones: agregar dirección a un lead con ARV', async () => {
  const [p1, p2, p3, p4, p5] = await leadsMod.addLeads([
    { estado: ESTADOS.pendienteDireccion, arv_usd: 400000, precio_usd: 150000, alerta: 'x' },
    { estado: ESTADOS.pendienteDireccion, arv_usd: 400000, alerta: 'x' },
    { estado: ESTADOS.pendienteDireccion, arv_usd: 400000, alerta: 'x' },
    { estado: ESTADOS.pendienteDireccion, arv_usd: 400000, alerta: 'x' },
    { estado: ESTADOS.pendienteDireccion, arv_usd: 400000, precio_usd: 300000, alerta: 'x' },
  ]);
  await assert.rejects(actions.pasarATier1(p1.id, 'Jaime'), /Primero agrega la dirección/);
  const geo = (county, ambiguous = false) => ({ geocode: async () => ({ county, ambiguous, method: 'test' }) });

  const ok = await actions.agregarDireccion(p1.id, { calle: '500 E Ocean Ave', ciudad: 'Boynton Beach', zip: '33435' }, 'Jaime', geo('Palm Beach'));
  assert.equal(ok.resultado, 'tier1');
  const lead = (await leadsMod.listLeads()).find((l) => l.id === p1.id);
  assert.equal(lead.estado, ESTADOS.tier1);
  assert.equal(lead.direccion, '500 E Ocean Ave');
  assert.equal(lead.alerta, '');
  assert.equal(lead.tier1_usuario, 'Jaime');
  assert.equal(lead.tier1_auto, true);

  // En zona con precio, 75 % of ARV pero precio ≥ $300k: no califica
  const nc = await actions.agregarDireccion(p5.id, { calle: '700 E Ocean Ave', ciudad: 'Boynton Beach', zip: '33435' }, 'Jaime', geo('Palm Beach'));
  assert.equal(nc.resultado, 'no_califica');
  assert.equal((await leadsMod.listLeads()).find((l) => l.id === p5.id).estado, ESTADOS.noCalifica);

  // En zona pero sin precio: queda como Nuevo con la alerta de precio, no pasa a Tier 1
  const sp = await actions.agregarDireccion(p4.id, { calle: '600 E Ocean Ave', ciudad: 'Boynton Beach', zip: '33435' }, 'Jaime', geo('Palm Beach'));
  assert.equal(sp.resultado, 'falta_precio');
  const l4 = (await leadsMod.listLeads()).find((l) => l.id === p4.id);
  assert.equal(l4.estado, ESTADOS.nuevo);
  assert.equal(l4.alerta, 'Solicitar precio al wholesaler');

  const out = await actions.agregarDireccion(p2.id, { calle: '1 Brickell Ave', ciudad: 'Miami' }, 'Jaime', geo('Miami-Dade'));
  assert.equal(out.resultado, 'descartado');
  assert.ok(!(await leadsMod.listLeads()).some((l) => l.id === p2.id));

  await assert.rejects(actions.agregarDireccion(p3.id, { calle: '1 Main St' }, 'Jaime', geo(null)), /No se pudo confirmar el condado/);
  await assert.rejects(actions.agregarDireccion(p3.id, { calle: '' }, 'Jaime', geo('Broward')), /número y calle/);
  assert.equal((await leadsMod.listLeads()).find((l) => l.id === p3.id).estado, ESTADOS.pendienteDireccion);
});

test('extracción: ignora comps y ventas, y la calle no cruza líneas', async () => {
  const text = [
    'N F St, Lake Worth, FL 33460', '', 'Asking: $325,000', 'ARV: $485,000+', '',
    'Comps', '211 N A St, Lake Worth, FL 33460', '$485,000', '', '1025 N H St Lake Worth, FL 33460', '$485,000',
  ].join('\n');
  const r = await extractListings({ text, images: [] }, { ocr: false });
  assert.equal(r.listings.length, 1);
  assert.equal(r.listings[0].street_address, null);
  assert.equal(r.listings[0].arv_usd, 485000);

  const t2 = '5088 2nd Rd, Lake Worth, FL 33467\nASKING: $479,900\nComps:\n5587 3rd Rd — SOLD: $699,000\nTerms: Cash';
  const r2 = await extractListings({ text: t2, images: [] }, { ocr: false });
  assert.deepEqual(r2.listings.map((l) => l.street_address), ['5088 2nd Rd']);

  const t3 = 'ASKING: $389,900\n* 2255 NW 96th St — SOLD: $540,000\n1951 NE 59th Place, Fort Lauderdale, FL 33308';
  const r3 = await extractListings({ text: t3, images: [] }, { ocr: false });
  assert.deepEqual(r3.listings.map((l) => l.street_address), ['1951 NE 59th Place']);
});

test('extracción: varias propiedades guardan solo su bloque', async () => {
  const text = '1951 NE 59th Place, Fort Lauderdale, FL 33308\nASKING: $650,000\n\n5088 2nd Rd, Lake Worth, FL 33467\nASKING: $479,900';
  const r = await extractListings({ text, images: [] }, { ocr: false });
  assert.equal(r.listings.length, 2);
  assert.doesNotMatch(r.listings[0].segment, /5088/);
  assert.match(r.listings[1].segment, /^5088 2nd Rd/);
});

test('vista de solo lectura: solo con el código, sin acciones', async () => {
  const { writeVista, startVista } = await import('../src/vista.js');
  await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '77 Vista St', mensaje_original: 'texto completo', imagenes_locales: [] }]);
  await exportOutputs(); // regenera también la vista
  assert.ok(await writeVista());
  const server = startVista({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/v/tok-de-prueba-123/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /window\.RO=true/);
    const datos = await (await fetch(`${base}/v/tok-de-prueba-123/datos.json`)).json();
    assert.ok(datos.leads.some((l) => l.direccion === '77 Vista St' && l.mensaje_original === 'texto completo'));
    assert.equal((await fetch(`${base}/v/tok-de-prueba-123/propiedades.csv`)).status, 200);
    assert.equal((await fetch(`${base}/v/otro-codigo/`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/api/leads`)).status, 404);
    assert.equal((await fetch(`${base}/v/tok-de-prueba-123/../leads.json`)).status, 404);
    assert.equal((await fetch(`${base}/v/tok-de-prueba-123/media/..%2Fleads.json`)).status, 404);
    assert.equal((await fetch(`${base}/v/tok-de-prueba-123/`, { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});

test('órdenes Tier 1: pendiente -> en proceso -> listo, reflejado en el lead', async () => {
  const { lanzarCompAnalysis, listJobs } = await import('../src/tier1.js');
  const [lead] = await leadsMod.addLeads([{ estado: ESTADOS.tier1, direccion: '1951 NE 59th Place', ciudad: 'Fort Lauderdale', zip: '33308' }]);
  const r = await lanzarCompAnalysis(lead, 'Carlos', { enabled: true });
  assert.equal(r.lanzado, true);
  const [job] = (await listJobs({ estado: 'pendiente' })).filter((j) => j.id === lead.id);
  assert.equal(job.lead.direccion, '1951 NE 59th Place, Fort Lauderdale, FL 33308');
  assert.equal(job.usuario, 'Carlos');

  await actions.reportarInforme(lead.id, { estado: 'en_proceso' });
  assert.equal((await listJobs({ estado: 'pendiente' })).filter((j) => j.id === lead.id).length, 0);
  await actions.reportarInforme(lead.id, { estado: 'listo', ruta: 'C:/Leads/Informes Tier 1' });
  const updated = (await leadsMod.listLeads()).find((l) => l.id === lead.id);
  assert.equal(updated.informe_estado, 'listo');
  assert.match(updated.informe_ruta, /Informes Tier 1/);
  await assert.rejects(actions.reportarInforme(lead.id, { estado: 'otro' }), /Estado no válido/);
  await assert.rejects(actions.reportarInforme('no-existe', { estado: 'listo' }), /no encontrada/);
});

test('regla de precio: alerta, agregar precio y Tier 1', async () => {
  const { computeAlerta } = await import('../src/pipeline.js');
  assert.equal(computeAlerta({ estado: ESTADOS.nuevo, precio_usd: 300000, arv_usd: 1 }), '');
  assert.equal(computeAlerta({ estado: ESTADOS.nuevo, arv_usd: 1 }), 'Solicitar precio al wholesaler');
  assert.equal(computeAlerta({ estado: ESTADOS.nuevo }), 'Solicitar precio al wholesaler'); // el ARV no se pide
  assert.equal(computeAlerta({ estado: ESTADOS.tier1, precio_usd: 1 }), '');
  assert.equal(computeAlerta({ estado: ESTADOS.pendienteDireccion }), 'Solicitar dirección y precio al wholesaler');
  assert.equal(computeAlerta({ estado: ESTADOS.pendienteDireccion, precio_usd: 1 }), 'Solicitar dirección al wholesaler');

  const [lead] = await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '9 Price St', ciudad: 'Jupiter', zip: '33458', arv_usd: 450000, alerta: 'Solicitar precio al wholesaler' }]);
  await assert.rejects(actions.agregarPrecio(lead.id, { precio_usd: 'mucho' }, 'Andres'), /Monto no válido/);
  await assert.rejects(actions.agregarPrecio(lead.id, { precio_usd: '' }, 'Andres'), /Falta el precio/);
  await assert.rejects(actions.agregarPrecio(lead.id, { precio_usd: '300000' }, 'Pedro'), /Usuario no válido/);
  await assert.rejects(actions.pasarATier1(lead.id, 'Andres'), /Falta el precio/);

  // 325k / 450k = 72.2 % of ARV, pero precio ≥ $300k: queda No califica
  assert.equal((await actions.agregarPrecio(lead.id, { precio_usd: '$325k', arv_usd: '' }, 'Andres')).resultado, 'no_califica');
  const l = (await leadsMod.listLeads()).find((x) => x.id === lead.id);
  assert.equal(l.precio_usd, 325000);
  assert.equal(l.arv_usd, 450000); // ARV vacío deja el que había
  assert.equal(l.alerta, '');
  assert.equal(l.cambios.at(-1).usuario, 'Andres');
  assert.equal(l.estado, ESTADOS.noCalifica);
  assert.equal(l.pct_arv, 72.2);
  // Con precio ya no se puede volver a cambiar desde el panel; Tier 1 manual sigue disponible
  await assert.rejects(actions.agregarPrecio(lead.id, { precio_usd: '400000' }, 'Carlos'), /ya tiene precio/);
  assert.equal((await actions.pasarATier1(lead.id, 'Carlos')).resultado, 'tier1');
});

test('editar: datos del lead en Nuevo, condado y criterios', async () => {
  const geo = (county) => ({ geocode: async () => ({ county, ambiguous: false, method: 'test' }) });
  const [l] = await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '1 Edit St', ciudad: 'Jupiter', zip: '33458', condado: 'Palm Beach', tipo: 'single_family', precio_usd: 250000, arv_usd: 300000, beds: 3 }]);
  const base = { calle: '1 Edit St', ciudad: 'Jupiter', zip: '33458', condado: 'Palm Beach', tipo: 'single_family', precio_usd: '250000', arv_usd: '300000', beds: '3', baths: '', sqft: '' };
  assert.equal((await actions.editarLead(l.id, base, 'Carlos')).resultado, 'sin_cambio');
  await assert.rejects(actions.editarLead(l.id, { ...base, tipo: 'Castillo' }, 'Carlos'), /Tipo no válido/);
  assert.equal((await actions.editarLead(l.id, { ...base, tipo: 'land', sqft: '1,200' }, 'Carlos')).resultado, 'editado');
  let x = (await leadsMod.listLeads()).find((y) => y.id === l.id);
  assert.equal(x.tipo, 'land');
  assert.equal(x.sqft, 1200);
  assert.deepEqual(x.cambios.at(-1).campos, ['sqft', 'tipo']);
  Object.assign(base, { tipo: 'land', sqft: '1200' });
  assert.equal((await actions.editarLead(l.id, { ...base, arv_usd: '$300k', precio_usd: '250k' }, 'Carlos')).resultado, 'sin_cambio');
  // 250k / 290k = 86.2 % of ARV -> No califica
  const nc = await actions.editarLead(l.id, { ...base, arv_usd: '290000' }, 'Carlos');
  assert.equal(nc.resultado, 'no_califica');
  // Dirección fuera de zona -> Descartados
  const out = await actions.editarLead(l.id, { ...base, arv_usd: '290000', calle: '1 Brickell Ave', ciudad: 'Miami', zip: '' }, 'Carlos', geo('Miami-Dade'));
  assert.equal(out.resultado, 'descartado');
  assert.ok((await leadsMod.listPapelera()).some((y) => y.id === l.id));
  // Revisar condado con condado a mano -> Nuevo y criterios
  const [r] = await leadsMod.addLeads([{ estado: ESTADOS.revisarCondado, direccion: '2 Edit St', precio_usd: 100000, arv_usd: 400000 }]);
  assert.equal((await actions.editarLead(r.id, { calle: '2 Edit St', condado: 'Broward', precio_usd: '100000', arv_usd: '400000' }, 'Carlos')).resultado, 'tier1');
  x = (await leadsMod.listLeads()).find((y) => y.id === r.id);
  assert.equal(x.metodo_condado, 'manual');
  await assert.rejects(actions.editarLead(r.id, base, 'Carlos'), /Solo se editan leads en Nuevo/);
});

test('criterios: Tier 1 automático con tope diario, No califica y falta ARV', async () => {
  const { evaluarCriterios } = await import('../src/pipeline.js');
  const { listJobs } = await import('../src/tier1.js');
  const { config } = await import('../src/config.js');
  assert.deepEqual(evaluarCriterios({ precio_usd: 150000, arv_usd: 400000 }), { califica: true, pct: 37.5, motivo: '' });
  assert.equal(evaluarCriterios({ precio_usd: 225000, arv_usd: 300000 }).califica, true); // 75 % exacto
  assert.match(evaluarCriterios({ precio_usd: 240000, arv_usd: 300000 }).motivo, /80% of ARV > 75%/);
  assert.match(evaluarCriterios({ precio_usd: 300000, arv_usd: 900000 }).motivo, /precio ≥ \$300,000/);
  assert.equal(evaluarCriterios({ precio_usd: 150000 }).califica, null);

  config.tier1SkillEnabled = true;
  try {
    const nuevos = await leadsMod.addLeads([
      ...[1, 2, 3, 4].map((n) => ({ estado: ESTADOS.nuevo, direccion: `${n}0 Auto St`, precio_usd: 100000, arv_usd: 400000 })),
      { estado: ESTADOS.nuevo, direccion: '50 Caro St', precio_usd: 350000, arv_usd: 1000000 },
      { estado: ESTADOS.nuevo, direccion: '60 SinArv St', precio_usd: 100000 },
      { estado: ESTADOS.pendienteDireccion, arv_usd: 400000, precio_usd: 100000 },
    ]);
    await actions.evaluarIngresados(nuevos, {});
    const get = async (id) => (await leadsMod.listLeads()).find((l) => l.id === id);
    for (const n of nuevos.slice(0, 4)) {
      const l = await get(n.id);
      assert.equal(l.estado, ESTADOS.tier1);
      assert.equal(l.tier1_usuario, 'Automático');
      assert.equal(l.pct_arv, 25);
    }
    assert.equal((await get(nuevos[4].id)).estado, ESTADOS.noCalifica);
    assert.match((await get(nuevos[4].id)).criterio, /precio/);
    assert.equal((await get(nuevos[5].id)).estado, ESTADOS.nuevo);
    assert.equal((await get(nuevos[5].id)).alerta, ''); // sin ARV: queda Nuevo, sin alerta
    assert.equal((await get(nuevos[6].id)).estado, ESTADOS.pendienteDireccion); // sin dirección no se evalúa

    // Tope diario de 3 automáticos: el cuarto espera; los que empiezan consumen cupo
    const ids = new Set(nuevos.map((n) => n.id));
    const pend = async () => (await listJobs({ estado: 'pendiente' })).filter((j) => ids.has(j.id));
    assert.equal((await pend()).length, 3);
    const [j1, j2] = await pend();
    await actions.reportarInforme(j1.id, { estado: 'en_proceso' });
    await actions.reportarInforme(j2.id, { estado: 'en_proceso' });
    assert.equal((await pend()).length, 1);
    // Un Tier 1 manual no tiene tope
    const [m] = await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '80 Manual St', precio_usd: 390000, arv_usd: 400000 }]);
    await actions.pasarATier1(m.id, 'Carlos');
    assert.ok((await listJobs({ estado: 'pendiente' })).some((j) => j.id === m.id && !j.auto));
  } finally {
    config.tier1SkillEnabled = false;
  }
});

test('Tier 1: inspección, Tier 2 y Compra', async () => {
  const get = async (id) => (await leadsMod.listLeads()).find((l) => l.id === id);
  const [l] = await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '70 Insp St', precio_usd: 250000, arv_usd: 400000 }]);
  await assert.rejects(actions.registrarInspeccion(l.id, { inspeccion_se_hace: 'Sí' }, 'Andres'), /en Tier 1/);
  await assert.rejects(actions.pasarATier2(l.id, {}, 'Andres'), /Solo un lead en Tier 1/);
  await actions.pasarATier1(l.id, 'Andres');
  await assert.rejects(actions.registrarInspeccion(l.id, { inspeccion_se_hace: 'Tal vez' }, 'Andres'), /Sí o No/);
  await assert.rejects(actions.registrarInspeccion(l.id, { inspeccion_se_hace: 'Sí' }, 'Pedro'), /Usuario no válido/);
  await actions.registrarInspeccion(l.id, { inspeccion_se_hace: 'No', inspeccion_ejecutada: 'Sí' }, 'Andres');
  assert.equal((await get(l.id)).inspeccion_ejecutada, 'No');
  await actions.registrarInspeccion(l.id, { inspeccion_se_hace: 'Sí', inspeccion_ejecutada: 'Sí', inspeccion_obs: '  Techo con filtraciones  ' }, 'Carlos');
  const insp = await get(l.id);
  assert.equal(insp.inspeccion_obs, 'Techo con filtraciones');
  assert.equal(insp.inspeccion_usuario, 'Carlos');
  await assert.rejects(actions.pasarATier1(l.id, 'Andres'), /ya está en Tier 1/);

  await assert.rejects(actions.avanzar(l.id, 'compra', 'Jaime'), /Solo un lead en Tier 2/);
  assert.equal((await actions.pasarATier2(l.id, { comparables: 12 }, 'Jaime')).resultado, 'tier2');
  await assert.rejects(actions.registrarInspeccion(l.id, { inspeccion_se_hace: 'Sí' }, 'Jaime'), /en Tier 1/);
  assert.equal((await actions.avanzar(l.id, 'compra', 'Jaime')).resultado, 'compra');
  const fin = await get(l.id);
  assert.equal(fin.estado, ESTADOS.compra);
  assert.equal(fin.tier2_usuario, 'Jaime');
  assert.equal(fin.compra_usuario, 'Jaime');
  const csv = await fs.readFile(path.join(process.env.DATA_DIR, 'propiedades.csv'), 'utf8');
  assert.match(csv, /Techo con filtraciones/);
});

test('informes: subir, servir aislado, vista pública y borrar al descartar', async () => {
  const { startDashboard } = await import('../src/dashboard.js');
  const { startVista } = await import('../src/vista.js');
  const { guardarInforme } = await import('../src/informes.js');
  const { Readable } = await import('node:stream');
  const [lead] = await leadsMod.addLeads([{ estado: ESTADOS.tier1, direccion: '90 Informe St', precio_usd: 100000, arv_usd: 400000 }]);
  const panel = startDashboard({ port: 0, host: '127.0.0.1' });
  const vista = startVista({ port: 0, host: '127.0.0.1' });
  await Promise.all([panel, vista].map((s) => (s.listening ? null : new Promise((r) => s.once('listening', r)))));
  const base = `http://127.0.0.1:${panel.address().port}`;
  const vbase = `http://127.0.0.1:${vista.address().port}/v/tok-de-prueba-123`;
  const subir = (nombre, body, headers = { 'X-Monitor': '1', 'Content-Type': 'application/octet-stream' }, id = lead.id) =>
    fetch(`${base}/api/leads/${id}/informes?tier=1&nombre=${encodeURIComponent(nombre)}`, { method: 'POST', headers, body });
  try {
    assert.equal((await subir('x.html', '<p>hola</p>', { 'Content-Type': 'application/octet-stream' })).status, 403);
    assert.equal((await subir('x.html', '<p>hola</p>', { 'X-Monitor': '1', 'Content-Type': 'text/html' })).status, 403);
    assert.equal((await subir('../leads.html', 'x')).status, 400);
    assert.equal((await subir('virus.exe', 'x')).status, 400);
    assert.equal((await subir('x.html', 'x', undefined, 'no-existe')).status, 404);
    const nombre = '1500-N-Congress C-comp-dashboard.html';
    const up = await subir(nombre, '<h1>Dashboard</h1><script>1</script>');
    assert.equal(up.status, 200);
    const l = (await leadsMod.listLeads()).find((x) => x.id === lead.id);
    assert.deepEqual(l.informes.map((i) => [i.tier, i.nombre]), [[1, nombre]]);
    await subir(nombre, '<h1>Dashboard v2</h1>'); // mismo nombre reemplaza
    assert.equal((await leadsMod.listLeads()).find((x) => x.id === lead.id).informes.length, 1);

    const get = await fetch(`${base}/informes/${lead.id}/${encodeURIComponent(nombre)}`);
    assert.equal(get.status, 200);
    assert.match(get.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    assert.equal(await get.text(), '<h1>Dashboard v2</h1>');
    const pub = await fetch(`${vbase}/informes/${lead.id}/${encodeURIComponent(nombre)}`);
    assert.equal(pub.status, 200);
    assert.match(pub.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await fetch(`http://127.0.0.1:${vista.address().port}/v/otro/informes/${lead.id}/${encodeURIComponent(nombre)}`)).status, 404);
    assert.equal((await fetch(`${base}/informes/${lead.id}/..%2F..%2Fleads.json`)).status, 400);

    await guardarInforme(lead.id, { tier: 2, nombre: 'Informe_Alertas_90.docx' }, Readable.from([Buffer.from('PK')]));
    const docx = await fetch(`${base}/informes/${lead.id}/Informe_Alertas_90.docx`);
    assert.match(docx.headers.get('content-disposition'), /^attachment/);
    await assert.rejects(guardarInforme(lead.id, { tier: 1, nombre: 'grande.pdf' }, Readable.from([Buffer.alloc(10)]), { maxBytes: 5 }), /supera/);
    assert.ok((await (await fetch(`${base}/api/leads`)).json()).disco);

    // Descartado: el panel lo sigue mostrando (pestaña Descartados); se borra al vencer la papelera (48 h)
    await actions.descartar(lead.id);
    assert.equal((await fetch(`${base}/informes/${lead.id}/${encodeURIComponent(nombre)}`)).status, 200);
    await actions.purgarDescartados(Date.now() + 49 * 36e5);
    assert.equal((await fetch(`${base}/informes/${lead.id}/${encodeURIComponent(nombre)}`)).status, 404);
    await assert.rejects(fs.stat(path.join(process.env.DATA_DIR, 'informes', lead.id)));
  } finally {
    panel.close();
    vista.close();
  }
});

test('avisos por WhatsApp: resumen a las 11:00 y 17:30 (Colombia), solo novedades vigentes', async () => {
  const { config } = await import('../src/config.js');
  const notify = await import('../src/notify.js');
  config.notifEnabled = true;
  try {
    const [conAlerta, auto, resuelta] = await leadsMod.addLeads([
      { estado: ESTADOS.nuevo, direccion: '85 Flamingo Dr', ciudad: 'Boynton Beach', arv_usd: 500000, contacto: 'Luis', telefono: '561-555-0202' },
      { estado: ESTADOS.nuevo, direccion: '11 Auto Ave', ciudad: 'Jupiter', precio_usd: 120000, arv_usd: 400000 },
      { estado: ESTADOS.nuevo, direccion: '12 Ok St', arv_usd: 400000 },
    ]);
    await actions.evaluarIngresados([conAlerta, auto, resuelta], {});
    await actions.agregarPrecio(resuelta.id, { precio_usd: '390000' }, 'Andres'); // su alerta ya no aplica
    await notify.encolar('informe_t1', auto.id, 'Advance — score 72/100');

    const enviados = [];
    const enviar = async (t) => enviados.push(t);
    // 10:00 en Colombia (UTC-5): todavía no es horario
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-10T15:00:00Z'), enviar })).motivo, 'fuera de horario');
    assert.equal(notify.turnoVigente(new Date('2026-10-10T16:05:00Z')), '2026-10-10 11:00');
    // 11:05 en Colombia: envía un solo mensaje
    const r = await notify.revisarEnvio({ ahora: new Date('2026-10-10T16:05:00Z'), enviar });
    assert.equal(r.enviado, true);
    assert.equal(enviados.length, 1);
    const t = enviados[0];
    assert.match(t, /Pedir datos al wholesaler \(1\)/);
    assert.match(t, /85 Flamingo Dr, Boynton Beach \(ARV \$500k\) — precio · Luis 561-555-0202/);
    assert.ok(!/Tier 1 \(cumplen|Panel:/.test(t)); // sin sección de Tier 1 automático ni enlace al panel
    assert.match(t, /Informes Tier 1 listos \(1\)\*\n• 11 Auto Ave, Jupiter — Advance — score 72\/100/);
    assert.ok(!t.includes('12 Ok St'));

    // El mismo turno no se repite; entre turnos no se envía; si falla, la cola se conserva para el siguiente intento
    await notify.encolar('alerta', conAlerta.id);
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-10T16:40:00Z'), enviar })).motivo, 'turno ya enviado');
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-10T19:00:00Z'), enviar })).motivo, 'fuera de horario');
    await assert.rejects(notify.revisarEnvio({ ahora: new Date('2026-10-10T22:35:00Z'), enviar: async () => { throw new Error('sin red'); } }), /sin red/);
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-10T22:40:00Z'), enviar })).enviado, true); // 17:40
    assert.equal(enviados.length, 2);
    // Pasada la hora de gracia (18:45) ya no envía: espera al horario de las 11:00 del día siguiente
    await notify.encolar('alerta', conAlerta.id);
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-10T23:45:00Z'), enviar })).motivo, 'fuera de horario');
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-11T16:00:00Z'), enviar })).enviado, true);
    // Sin novedades no se envía nada
    assert.equal((await notify.revisarEnvio({ ahora: new Date('2026-10-11T22:30:00Z'), enviar })).motivo, 'sin novedades');
  } finally {
    config.notifEnabled = false;
  }
});

test('Tier 2: orden por fases para el Intake, avance, error, reintento y condado no cubierto', async () => {
  const { config } = await import('../src/config.js');
  const { listTier2Jobs } = await import('../src/tier2.js');
  const get = async (id) => (await leadsMod.listLeads()).find((l) => l.id === id);
  const [pb, martin] = await leadsMod.addLeads([
    { estado: ESTADOS.tier1, direccion: '1500 N Congress Ave', ciudad: 'West Palm Beach', zip: '33401', condado: 'Palm Beach', precio_usd: 149900, arv_usd: 225000 },
    { estado: ESTADOS.tier1, direccion: '8 SE Steeplechase Cir', ciudad: 'Jupiter', zip: '33469', condado: 'Martin', precio_usd: 200000, arv_usd: 600000 },
  ]);
  config.tier2SkillEnabled = true;
  try {
    await assert.rejects(actions.pasarATier2(pb.id, { comparables: 15 }, 'Carlos'), /Comparables: 8, 12, 20/);
    const r = await actions.pasarATier2(pb.id, { comparables: 12 }, 'Carlos');
    assert.equal(r.skill.lanzado, true);
    const [job] = (await listTier2Jobs({ estado: 'pendiente' })).filter((j) => j.id === pb.id);
    assert.equal(job.fase, 1);
    assert.equal(job.comparables, 12);
    assert.equal(job.lead.direccion, '1500 N Congress Ave, West Palm Beach, FL 33401');

    // Martin: solo cambia la etapa, sin orden
    const m = await actions.pasarATier2(martin.id, {}, 'Carlos');
    assert.equal(m.skill.lanzado, false);
    assert.equal((await get(martin.id)).estado, ESTADOS.tier2);
    assert.match((await get(martin.id)).tier2_detalle, /Martin: Tier 2 manual/);

    await actions.reportarTier2(pb.id, { estado: 'en_proceso', fase: 1, caso_id: 'caso-1' });
    await actions.reportarTier2(pb.id, { estado: 'listo', fase: 1 });
    await assert.rejects(actions.reportarTier2(pb.id, { estado: 'listo', fase: 1 }), /fase 2, no en la 1/);
    assert.deepEqual([(await get(pb.id)).tier2_fase, (await get(pb.id)).tier2_estado], [2, 'pendiente']);
    await actions.reportarTier2(pb.id, { estado: 'error', fase: 2, detalle: 'Zillow bloqueó' });
    assert.equal((await get(pb.id)).tier2_estado, 'error');
    const re = await actions.reintentarTier2Lead(pb.id, 'Carlos');
    assert.equal(re.fase, 2);
    const [j2] = (await listTier2Jobs({ estado: 'pendiente' })).filter((j) => j.id === pb.id);
    assert.equal(j2.caso_id, 'caso-1');
    assert.match(j2.detalle, /^reintento/);
    for (const f of [2, 3, 4]) await actions.reportarTier2(pb.id, { estado: 'listo', fase: f });
    assert.equal((await get(pb.id)).tier2_estado, 'completo');
    await assert.rejects(actions.reportarTier2(pb.id, { estado: 'en_proceso' }), /ya está completo/);
  } finally {
    config.tier2SkillEnabled = false;
  }
});

test('ejecutores: cada PC recibe solo sus órdenes; los automáticos van al PC configurado', async () => {
  const { config } = await import('../src/config.js');
  const { listJobs } = await import('../src/tier1.js');
  config.tier1SkillEnabled = true;
  try {
    const [a, b, c] = await leadsMod.addLeads([
      { estado: ESTADOS.nuevo, direccion: '1 Pc Roberto St', precio_usd: 390000, arv_usd: 400000 },
      { estado: ESTADOS.nuevo, direccion: '2 Pc Andres St', precio_usd: 390000, arv_usd: 400000 },
      { estado: ESTADOS.nuevo, direccion: '3 Auto Pc St', precio_usd: 100000, arv_usd: 400000 },
    ]);
    await assert.rejects(actions.pasarATier1(a.id, 'Carlos', { ejecutor: 'Pedro' }), /PC no válido/);
    await actions.pasarATier1(a.id, 'Carlos', { ejecutor: 'Roberto' });
    await actions.pasarATier1(b.id, 'Carlos', { ejecutor: 'Andres' });
    await actions.evaluarIngresados([c], {});
    const ids = async (pc) => (await listJobs({ estado: 'pendiente', ejecutor: pc })).map((j) => j.id);
    assert.ok((await ids('Roberto')).includes(a.id) && !(await ids('Roberto')).includes(b.id));
    assert.ok((await ids('Andres')).includes(b.id));
    // el automático va al PC de Andres (sin filtrar por estado: el tope diario lo puede dejar para mañana)
    assert.equal((await listJobs({ ejecutor: 'Andres' })).find((j) => j.id === c.id)?.auto, true);
    assert.equal((await leadsMod.listLeads()).find((l) => l.id === c.id).tier1_ejecutor, config.tier1AutoEjecutor);
  } finally {
    config.tier1SkillEnabled = false;
  }
});

test('modelo por PC: las órdenes de un PC llevan el modelo y esfuerzo configurados', async () => {
  const { config } = await import('../src/config.js');
  const { lanzarCompAnalysis, listJobs } = await import('../src/tier1.js');
  const antes = config.tier1Modelos;
  config.tier1Modelos = { Andres: { modelo: 'claude-fable-5-1', esfuerzo: 'medium' } };
  try {
    const [a, r] = await leadsMod.addLeads([{ estado: ESTADOS.tier1, direccion: '5 Modelo A St' }, { estado: ESTADOS.tier1, direccion: '6 Modelo R St' }]);
    await lanzarCompAnalysis(a, 'Carlos', { enabled: true, ejecutor: 'Andres' });
    await lanzarCompAnalysis(r, 'Carlos', { enabled: true, ejecutor: 'Roberto' });
    const ja = (await listJobs({ estado: 'pendiente', ejecutor: 'Andres' })).find((j) => j.id === a.id);
    const jr = (await listJobs({ estado: 'pendiente', ejecutor: 'Roberto' })).find((j) => j.id === r.id);
    assert.deepEqual([ja.modelo, ja.esfuerzo], ['claude-fable-5-1', 'medium']);
    assert.equal(jr.modelo, undefined);
  } finally {
    config.tier1Modelos = antes;
  }
});

test('extracción: filtra direcciones basura del OCR y conserva las reales', async () => {
  const { esCalleValida } = await import('../src/extract.js');
  for (const b of ['1 Sr', '25 Sr', '4 rd', '20 od gal RD SE', '5 ie le RF a ST']) assert.equal(esCalleValida(b), false, b);
  for (const ok of ['211 N E St', '407 N H St', '824 S F St', '1208 3rd Ave S', '814 42nd St West', '1731 SE 15th St #513',
    '85 Flamingo Dr', '123 La Costa Dr', '100 SR 7', '2000 US Hwy 1', '300 A1A', '4500 N Federal Hwy']) assert.equal(esCalleValida(ok), true, ok);
  const r = await ex('Flyer\n1 Sr Fort Lauderdale\n4 rd Hollywood FL\n441 NW 18th Ave, Fort Lauderdale, FL 33311 $435,000');
  assert.deepEqual(r.listings.map((l) => l.street_address), ['441 NW 18th Ave']);
});

test('reposts y correcciones del wholesaler; "West Palm Beach" sin coma', async () => {
  const { findAddresses } = await import('../src/extract.js');
  assert.deepEqual(findAddresses('814 42nd St West Palm Beach FL 33407').map((a) => [a.street_address, a.city]), [['814 42nd St', 'West Palm Beach']]);
  assert.equal(findAddresses('123 Main St W, Lake Worth FL')[0].street_address, '123 Main St W');

  const base = { estado: ESTADOS.nuevo, ciudad: 'Fort Lauderdale', autor: 'Wh1', grupo: 'G', precio_usd: 174900, arv_usd: 264900 };
  const [orig] = await leadsMod.addLeads([{ ...base, direccion: '731 SE 15th St #513', clave_direccion: '731 SE 15TH ST 513 FTL', fecha_mensaje: '2026-10-08T19:08:00Z' }]);
  // corrección 17 min después: misma calle, unidad, precio y ARV; otro número
  const r1 = await leadsMod.addLeads([{ ...base, direccion: '1731 SE 15th St #513', clave_direccion: '1731 SE 15TH ST 513 FTL', fecha_mensaje: '2026-10-08T19:25:00Z' }]);
  assert.equal(r1.length, 0);
  const get = async () => (await leadsMod.listLeads()).find((l) => l.id === orig.id);
  assert.equal((await get()).direccion, '1731 SE 15th St #513');
  assert.equal((await get()).direccion_corregida_de, '731 SE 15th St #513');
  assert.ok(await leadsMod.isDiscarded('731 SE 15TH ST 513 FTL'));
  // repost al día siguiente con otro precio: no crea lead, actualiza el existente
  const r2 = await leadsMod.addLeads([{ ...base, precio_usd: 169900, direccion: '1731 SE 15th St #513', clave_direccion: '1731 SE 15TH ST 513 FTL', fecha_mensaje: '2026-10-09T16:37:00Z' }]);
  assert.equal(r2.length, 0);
  assert.deepEqual([(await get()).publicaciones, (await get()).ultima_publicacion, (await get()).precio_repost], [2, '2026-10-09T16:37:00Z', 169900]);
  // otro autor u otra unidad no es corrección
  const r3 = await leadsMod.addLeads([{ ...base, autor: 'Otro', direccion: '1733 SE 15th St #513', clave_direccion: 'X1', fecha_mensaje: '2026-10-08T20:00:00Z' },
    { ...base, direccion: '1735 SE 15th St #514', clave_direccion: 'X2', fecha_mensaje: '2026-10-08T20:00:00Z' }]);
  assert.equal(r3.length, 2);
});

test('mercado: cola por dirección, validación del reporte y reintentos', async () => {
  const { config } = await import('../src/config.js');
  const m = await import('../src/mercado.js');
  config.mercadoEjecutor = 'Roberto';
  const [l] = await leadsMod.addLeads([{ estado: ESTADOS.nuevo, direccion: '7 Market St', ciudad: 'Jupiter', zip: '33458' }]);
  const cola = async (e = 'Roberto') => (await m.listMercadoJobs({ ejecutor: e })).filter((j) => j.id === l.id);
  assert.deepEqual((await cola())[0].direccion, '7 Market St, Jupiter, FL 33458');
  assert.equal((await cola('Andres')).length, 0); // otro PC no recibe la cola
  // Respuesta con basura: se normaliza
  const out = await m.reportarMercado(l.id, { direccion: '7 Market St, Jupiter, FL 33458', motor: 'codex', resultado: {
    estado: 'For sale', fecha_publicacion: '2026-08-14', precio_lista: '565000', precio_original: 600000, extra: 'x',
    reducciones: [{ fecha: 'ayer', precio: 580000 }, { fecha: '2026-09-01', precio: 'no' }], fuentes: ['https://zillow.com/a', 'javascript:alert(1)'],
    confianza: 'total', notas: 'x'.repeat(900) } });
  assert.equal(out.mercado.precio_lista, 565000);
  assert.deepEqual(out.mercado.reducciones, [{ fecha: null, precio: 580000 }]);
  assert.deepEqual(out.mercado.fuentes, ['https://zillow.com/a']);
  assert.equal(out.mercado.confianza, 'baja');
  assert.equal(out.mercado.notas.length, 600);
  assert.equal('extra' in out.mercado, false);
  assert.equal((await cola()).length, 0);
  // Si cambia la dirección vuelve a la cola; un reporte de la dirección vieja se ignora
  await leadsMod.updateLead(l.id, { direccion: '9 Market St' });
  assert.equal((await cola()).length, 1);
  assert.ok((await m.reportarMercado(l.id, { direccion: '7 Market St, Jupiter, FL 33458', resultado: { estado: 'Sold' } })).ignorado);
  // Tres errores: sale de la cola
  for (let i = 0; i < 3; i++) await m.reportarMercado(l.id, { error: 'cupo' });
  assert.equal((await cola()).length, 0);
});
