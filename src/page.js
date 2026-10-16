// Página del panel (pestañas Nuevo / Tier 1 / Tier 2 / Compra). Con window.RO (vista de solo lectura) lee datos.json y no muestra acciones.
export const PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor de Propiedades</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e3de;--nuevo:#e3eefc;--pend:#fff1c2;--rev:#fce4d6;--nc:#ececea;--t1:#d7f0dc;--t2:#e4ddfb;--compra:#ffe2bd;--accent:#1f6f50;--danger:#a3322b;--zebra:#f2f6fb;--hover:#e6eef8}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ececea;--muted:#a3a39d;--line:#33332f;--nuevo:#1d3550;--pend:#4d4116;--rev:#4d2c1a;--nc:#3a3a36;--t1:#1e4a2b;--t2:#35295c;--compra:#523713;--accent:#6fcf9f;--danger:#f08a80;--zebra:#262a30;--hover:#2e343c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:18px;margin:0}.bar{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px}.tab{border-radius:20px;padding:7px 14px}.tab b{margin-left:6px}
.tab.on{background:var(--accent);border-color:var(--accent);color:var(--bg)}
select,input,textarea,a.btn,button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 10px;font:inherit}
.portales{display:flex;gap:10px;font-size:12px;margin:2px 0 4px}.portales a{color:var(--accent);font-weight:600}
button.lnk{border:0;padding:2px 0;background:none;color:var(--accent);font-size:12px;font-weight:600}
button{cursor:pointer}a.btn{text-decoration:none;color:var(--accent);font-weight:600}
button.ok{border-color:var(--accent);color:var(--accent);font-weight:600}button.del{color:var(--danger)}
.wrap{padding:0 16px 24px;overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
#rows tr:nth-child(even)>td{background:var(--zebra)}#rows tr:hover>td{background:var(--hover)}
th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:var(--card);font-size:12px;color:var(--muted)}
.e{border-radius:4px;padding:2px 6px;font-weight:600;font-size:12px;white-space:nowrap}
.e.Nuevo{background:var(--nuevo)}.e.Pendiente{background:var(--pend)}.e.Revisar{background:var(--rev)}.e.No{background:var(--nc)}.e.T1{background:var(--t1)}.e.T2{background:var(--t2)}.e.Compra{background:var(--compra)}
.alerta{margin-top:6px;padding:6px 8px;border-radius:6px;background:var(--pend);font-size:12px}
.acc{display:flex;flex-direction:column;gap:6px;min-width:120px}
details summary{cursor:pointer;color:var(--muted)}pre{white-space:pre-wrap;max-width:420px;margin:6px 0}.m{color:var(--muted);font-size:12px}
td img{max-height:60px;border-radius:4px;margin-right:4px}
dialog{border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);padding:18px;max-width:420px;width:calc(100% - 32px)}
dialog form{display:flex;flex-direction:column;gap:10px}dialog h2{font-size:16px;margin:0}dialog .row{display:flex;gap:8px;justify-content:flex-end}
dialog label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
#precioFields:not([hidden]),#inspFields:not([hidden]){display:grid;grid-template-columns:1fr 1fr;gap:8px}#inspFields label:last-child{grid-column:1/-1}
#mapDlg{max-width:760px}#mapDlg iframe{width:100%;height:60vh;border:0;border-radius:8px;margin:10px 0}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:8px;display:none;max-width:calc(100% - 32px)}
</style></head><body>
<header><h1>Monitor de Propiedades</h1><div class="alerta" id="disco" hidden></div></header>
<nav class="tabs" id="tabs"></nav>
<div class="bar">
<select id="estado"></select>
<select id="condado"><option value="">Condado: todos</option></select>
<select id="dup"><option value="">Incluir duplicados</option><option value="NO">Ocultar duplicados</option></select>
<input id="q" placeholder="Buscar (calle, ciudad, grupo...)">
<a class="btn" id="dlXlsx" href="/descargar/xlsx">Descargar Excel</a><a class="btn" id="dlCsv" href="/descargar/csv">CSV</a><span class="m" id="upd"></span>
</div>
<div class="wrap"><table><thead><tr><th>Estado</th><th>Fecha</th><th>Condado</th><th>Dirección</th><th>Precio / ARV</th><th>Beds/Baths · Sqft</th><th>Tipo</th><th>Contacto</th><th>Grupo</th><th>Mensaje</th><th class="act">Acciones</th></tr></thead><tbody id="rows"></tbody></table></div>

<dialog id="dlg"><form method="dialog" id="frm">
<h2 id="dlgTitle"></h2><div class="m" id="dlgInfo"></div>
<div id="dirFields" hidden>
<label>Número y calle<input name="calle" placeholder="1234 NW 5th Ave"></label>
<label>Ciudad<input name="ciudad" placeholder="Fort Lauderdale"></label>
<label>ZIP<input name="zip" inputmode="numeric" maxlength="5" placeholder="33311"></label>
</div>
<div id="precioFields" hidden>
<label>Precio (asking)<input name="precio_usd" inputmode="decimal" placeholder="325000 o $325k"></label>
<label>ARV (opcional)<input name="arv_usd" inputmode="decimal" placeholder="480000 o $480k"></label>
</div>
<div id="t2Fields" hidden>
<label>Comparables (Fase 2)<select name="comparables"><option value="8">8 · lectura rápida</option><option value="12" selected>12 · suficiente para decidir</option><option value="20">20 · valuación formal</option></select></label>
</div>
<div id="inspFields" hidden>
<label>¿Se hace inspección?<select name="inspeccion_se_hace"><option>Sí</option><option>No</option></select></label>
<label>¿Se ejecutó?<select name="inspeccion_ejecutada"><option>Pendiente</option><option>Sí</option><option>No</option></select></label>
<label>Observación de la inspección<textarea name="inspeccion_obs" rows="4" maxlength="2000"></textarea></label>
</div>
<label>Usuario que ejecuta<select name="usuario" id="usuario"></select></label>
<div id="pcFields" hidden><label>Ejecutar en<select name="ejecutor" id="ejecutor"></select></label></div>
<div class="m" id="skillNote"></div>
<div class="row"><button value="cancel" formnovalidate>Cancelar</button><button value="ok" class="ok" id="dlgOk"></button></div>
</form></dialog>
<dialog id="mapDlg"><h2 id="mapTitle"></h2><iframe id="mapFrame" title="Mapa" referrerpolicy="no-referrer"></iframe>
<div id="mapPortales"></div>
<div class="row"><a class="btn" id="mapLink" target="_blank" rel="noopener noreferrer">Abrir en Google Maps</a><button id="mapClose">Cerrar</button></div></dialog>
<div id="toast"></div>

<script>
const TABS={'Nuevo':['Nuevo','Pendiente dirección','Revisar condado','No califica'],'Tier 1':['Tier 1'],'Tier 2':['Tier 2'],'Compra':['Compra']};
const PREVIOS=['Nuevo','Revisar condado','No califica'];
const RO=!!window.RO,MEDIA=RO?'media/':'/media/';
const store={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}}};
let all=[],usuarios=[],ejecutores=[],skillOn=false,current=null,tab=TABS[store.get('tab')]?store.get('tab'):'Nuevo';const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=n=>n?'$'+Number(n).toLocaleString('en-US'):'';
const links=s=>[].concat(s||[]).flatMap(x=>String(x).split(/\\n|,(?=https?)/)).filter(Boolean).map(u=>'<a href="'+esc(u)+'" target="_blank" rel="noopener">link</a>').join(' ');
const cls=e=>({'Tier 1':'T1','Tier 2':'T2'})[e]||String(e||'').split(' ')[0];
const margen=r=>r.precio_usd&&r.arv_usd?Math.round((r.arv_usd-r.precio_usd)/r.arv_usd*1000)/10:null;
const INF={pendiente:'en cola',en_proceso:'generando…',listo:'listo ✓',error:'error'};
const informe=r=>r.informe_estado?'<div class="m" title="'+esc([r.informe_ruta,r.informe_detalle].filter(Boolean).join(' · '))+'">Informe: '+esc(INF[r.informe_estado]||r.informe_estado)+'</div>':'';
const fecha=s=>esc(String(s||'').slice(0,10));
const T2={pendiente:'en cola',en_proceso:'generando…',error:'error'};
// Enlaces a los informes subidos (el HTML se abre en el navegador; .docx/.xlsx se descargan)
const ETIQ=[[/\\.html$/i,'Dashboard'],[/Informe_Completo/i,'Comparables (completo)'],[/Ejecutivo/i,'Comparables (ejecutivo)'],[/Alertas/i,'Alertas'],[/Decision/i,'Decisión']];
const etiqueta=n=>(ETIQ.find(([re])=>re.test(n))||[0,n])[1];
const archivos=r=>(r.informes||[]).map(i=>'<div><a target="_blank" rel="noopener" href="'+(RO?'':'/')+'informes/'+esc(r.id)+'/'+encodeURIComponent(i.nombre)+'" title="'+esc(i.nombre)+'">📄 T'+i.tier+' · '+esc(etiqueta(i.nombre))+'</a></div>').join('');
// Lo que pasó con el lead: motivo de No califica, quién lo movió de etapa y la inspección
function detalle(r){const d=[];
 if(r.estado==='No califica'&&r.criterio)d.push('No califica: '+esc(r.criterio));
 if(r.publicaciones>1)d.push('Publicado '+r.publicaciones+' veces · último '+fechaCorta(r.ultima_publicacion)+(r.precio_repost?' · nuevo precio '+money(r.precio_repost):''));
 if(r.direccion_corregida_de)d.push('Dirección corregida por el wholesaler (antes: '+esc(r.direccion_corregida_de)+')');
 if(r.tier1_usuario)d.push('Tier 1: '+esc(r.tier1_usuario)+' '+fecha(r.tier1_en)+(r.tier1_ejecutor?' · PC '+esc(r.tier1_ejecutor):''));
 if(r.inspeccion_se_hace)d.push('Inspección: '+(r.inspeccion_se_hace==='No'?'no se hace':'ejecutada: '+esc(r.inspeccion_ejecutada))+(r.inspeccion_obs?'<br><i>'+esc(r.inspeccion_obs)+'</i>':''));
 if(r.tier2_usuario)d.push('Tier 2: '+esc(r.tier2_usuario)+' '+fecha(r.tier2_en)+(r.tier2_comparables?' · '+r.tier2_comparables+' comps':'')+(r.tier2_ejecutor?' · PC '+esc(r.tier2_ejecutor):''));
 if(r.tier2_estado)d.push(r.tier2_estado==='completo'?'Fases 1–4: completas ✓':'Fase '+esc(r.tier2_fase)+'/4 · '+esc(T2[r.tier2_estado]||r.tier2_estado)+(r.tier2_detalle?'<br><i>'+esc(r.tier2_detalle)+'</i>':''));
 else if(r.tier2_detalle)d.push('<i>'+esc(r.tier2_detalle)+'</i>');
 if(r.compra_usuario)d.push('Compra: '+esc(r.compra_usuario)+' '+fecha(r.compra_en));
 return d.map(x=>'<div class="m">'+x+'</div>').join('')}
const fullAddr=r=>[r.direccion,r.ciudad,(r.ciudad||r.zip)&&r.direccion?'FL '+(r.zip||''):r.zip].filter(Boolean).join(', ').trim()||'—';
// Fecha del mensaje como "Friday, Oct 16"
const fechaCorta=s=>{const d=new Date(s);return isNaN(d)?esc(s||''):esc(d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'}))};
// Ficha de la propiedad en cada portal: Zillow por su URL de dirección; Redfin y Realtor por la redirección
// al primer resultado de DuckDuckGo (las fichas de esos portales llevan un ID que no se conoce de antemano)
const portales=r=>{if(!r.direccion)return '';const q=fullAddr(r),ddg=s=>'https://duckduckgo.com/?q=%5C'+encodeURIComponent('site:'+s+' '+q);
 return '<div class="portales">'+[['Redfin',ddg('redfin.com')],['Zillow','https://www.zillow.com/homes/'+encodeURIComponent(q.replace(/\\s+/g,'-'))+'_rb/'],['Realtor',ddg('realtor.com')]]
  .map(([n,u])=>'<a href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">'+n+'</a>').join('')+'</div>'};
function toast(t){const el=$('toast');el.textContent=t;el.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>el.style.display='none',4000)}
if(RO){document.querySelectorAll('.act').forEach(e=>e.remove());$('dlXlsx').href='propiedades.xlsx';$('dlCsv').href='propiedades.csv';document.title+=' (solo vista)'}
function fillEstado(){const op=TABS[tab];$('estado').hidden=op.length<2;$('estado').innerHTML='<option value="">Estado: todos</option>'+op.map(e=>'<option>'+e+'</option>').join('')}
async function load(){if($('dlg').open)return;const d=await (await fetch(RO?'datos.json?t='+Date.now():'/api/leads',{cache:'no-store'})).json();
 if(RO&&d.generado_en)$('upd').textContent='Actualizado: '+new Date(d.generado_en).toLocaleString();
 all=d.leads.slice().reverse();usuarios=d.usuarios||[];ejecutores=d.ejecutores||[];skillOn=!!d.skillHabilitado;
 const pcPrev=store.get('ejecutor');$('ejecutor').innerHTML=ejecutores.map(u=>'<option value="'+esc(u)+'"'+(u===pcPrev?' selected':'')+'>PC '+esc(u)+'</option>').join('');
 const dk=d.disco;$('disco').hidden=!(dk&&dk.usado_pct>=80);if(dk)$('disco').textContent='⚠ Disco del servidor al '+dk.usado_pct+' % ('+dk.libre_gb+' GB libres)';
 const prev=store.get('usuario');$('usuario').innerHTML=usuarios.map(u=>'<option'+(u===prev?' selected':'')+'>'+esc(u)+'</option>').join('');
 const cs=[...new Set(all.map(r=>r.condado).filter(Boolean))].sort(),cv=$('condado').value;
 $('condado').innerHTML='<option value="">Condado: todos</option>'+cs.map(c=>'<option'+(c===cv?' selected':'')+'>'+esc(c)+'</option>').join('');render()}
function actions(r){if(RO)return '';const b=[],btn=(a,t,c)=>'<button class="'+(c||'ok')+'" data-a="'+a+'" data-id="'+r.id+'">'+t+'</button>';
 if(r.estado==='Pendiente dirección'||r.estado==='Revisar condado')b.push(btn('direccion',r.estado==='Revisar condado'?'Corregir dirección':'Agregar dirección'));
 if(PREVIOS.includes(r.estado)&&r.precio_usd)b.push(btn('tier1','Tier 1'));
 if(!r.precio_usd)b.push(btn('precio','Agregar precio'));
 if(r.estado==='Tier 1')b.push(btn('inspeccion',r.inspeccion_se_hace?'Editar inspección':'Inspección'),btn('tier2','Pasar a Tier 2'));
 if(r.estado==='Tier 2'&&r.tier2_estado==='error')b.push(btn('reintentar2','Reintentar fase '+r.tier2_fase));
 if(r.estado==='Tier 2')b.push(btn('compra','Pasar a Compra'));
 b.push(btn('descartar','Descartar','del'));return '<div class="acc">'+b.join('')+'</div>'}
function render(){const e=$('estado').value,c=$('condado').value,dup=$('dup').value,q=$('q').value.toLowerCase(),en=TABS[tab];
 $('tabs').innerHTML=Object.keys(TABS).map(t=>'<button class="tab'+(t===tab?' on':'')+'" data-tab="'+t+'">'+t+'<b>'+all.filter(r=>TABS[t].includes(r.estado)).length+'</b></button>').join('');
 const f=all.filter(r=>en.includes(r.estado)&&(!e||r.estado===e)&&(!c||r.condado===c)&&(!dup||r.duplicado==='NO')&&(!q||JSON.stringify(r).toLowerCase().includes(q)));
 $('rows').innerHTML=f.map(r=>'<tr><td><span class="e '+esc(cls(r.estado))+'">'+esc(r.estado)+'</span>'+informe(r)+archivos(r)+detalle(r)+'</td><td class="m">'+fechaCorta(r.fecha_mensaje)+'</td><td>'+esc(r.condado||'—')+'<div class="m">'+esc(r.metodo_condado||'')+'</div></td><td>'+esc(fullAddr(r))+(fullAddr(r)!=='—'?'<div><button class="lnk" data-map="'+r.id+'">📍 Ver mapa</button></div>'+portales(r):'')+'<div class="m">'+esc(r.estado_direccion)+'</div>'+(r.duplicado&&r.duplicado!=='NO'?'<div class="m">Duplicado</div>':'')+(r.alerta?'<div class="alerta">⚠ '+esc(r.alerta)+(r.contacto||r.telefono?': '+esc(r.contacto||r.autor||'')+' '+(r.telefono?'<a href="tel:'+esc(r.telefono)+'">'+esc(r.telefono)+'</a>':''):'')+'</div>':'')+'</td><td>'+money(r.precio_usd)+(r.arv_usd?'<div class="m">ARV '+money(r.arv_usd)+'</div>':'')+(margen(r)!==null?'<div class="m">Margen '+margen(r)+'%</div>':'')+'</td><td>'+esc([r.beds,r.baths].some(x=>x!=null&&x!=='')?(r.beds??'?')+'/'+(r.baths??'?'):'')+'<div class="m">'+esc(r.sqft?r.sqft+' sqft':'')+'</div></td><td>'+esc(r.tipo)+'<div class="m">'+esc(r.tipo_negocio)+'</div></td><td>'+esc(r.contacto||'')+'<div class="m">'+esc(r.telefono||'')+'</div></td><td class="m">'+esc(r.grupo)+'<br>'+esc(r.autor)+'</td><td><details><summary>'+esc(r.resumen)+'</summary><pre>'+esc(r.mensaje_original)+'</pre>'+(r.imagenes_locales||[]).map(p=>'<img src="'+MEDIA+encodeURIComponent(String(p).split(/[\\\\/]/).pop())+'">').join('')+' '+links(r.links_fotos)+' '+links(r.links_portales)+'</details></td>'+(RO?'':'<td>'+actions(r)+'</td>')+'</tr>').join('')||'<tr><td colspan="11" class="m">Sin resultados</td></tr>'}
async function post(id,a,body){const res=await fetch('/api/leads/'+id+'/'+a,{method:'POST',headers:{'Content-Type':'application/json','X-Monitor':'1'},body:JSON.stringify(body||{})});
 const d=await res.json().catch(()=>({}));if(!res.ok)throw new Error(d.error||'Error '+res.status);return d}
// Muestra un grupo de campos; los ocultos se deshabilitan para que no viajen en el formulario.
function show(id,on){$(id).hidden=!on;$(id).querySelectorAll('input,select,textarea').forEach(i=>i.disabled=!on)}
const CRIT='margen ≥ 60 % y precio < $300k';
const TITULO={direccion:'Dirección del wholesaler',tier1:'Pasar a Tier 1',precio:'Precio del wholesaler',inspeccion:'Inspección',tier2:'Pasar a Tier 2',reintentar2:'Reintentar Tier 2',compra:'Pasar a Compra'};
const BOTON={direccion:'Validar y continuar',tier1:'Pasar a Tier 1',precio:'Guardar precio',inspeccion:'Guardar inspección',tier2:'Pasar a Tier 2',reintentar2:'Reintentar',compra:'Pasar a Compra'};
function openDlg(a,r){current={a,id:r.id};const f=$('frm'),dir=a==='direccion',pre=a==='precio',ins=a==='inspeccion';
 show('dirFields',dir);show('precioFields',pre);show('inspFields',ins);show('t2Fields',a==='tier2');show('pcFields',a==='tier1'||a==='tier2');
 f.calle.value=dir&&r.estado==='Revisar condado'?(r.direccion||''):'';f.ciudad.value=dir?(r.ciudad||''):'';f.zip.value=dir?(r.zip||''):'';f.calle.required=dir;
 f.precio_usd.value=r.precio_usd??'';f.arv_usd.value=r.arv_usd??'';f.precio_usd.required=pre;
 if(ins){f.inspeccion_se_hace.value=r.inspeccion_se_hace||'Sí';f.inspeccion_ejecutada.value=r.inspeccion_ejecutada||'Pendiente';f.inspeccion_obs.value=r.inspeccion_obs||'';f.inspeccion_ejecutada.disabled=f.inspeccion_se_hace.value==='No'}
 $('dlgTitle').textContent=TITULO[a];
 $('dlgInfo').textContent=dir?'Si está en Broward, Palm Beach o Martin se evalúan los criterios ('+CRIT+'): si cumple pasa a Tier 1 automático; si no, queda "No califica". Fuera de esos condados se descarta.':fullAddr(r);
 const skill='Lanzar comp-analysis-report: '+(skillOn?'se enviará al PC elegido.':'por habilitar.');
 $('skillNote').textContent={tier1:skill,direccion:skill,precio:'Si cumple los criterios ('+CRIT+') pasa a Tier 1 automático. Queda registrado quién agregó el precio.',inspeccion:'Queda registrado quién la documentó y cuándo.',tier2:'Se ejecutan las fases 1–4 en el PC (Intake Service), una tras otra; se avisa al grupo al terminar los informes. La Fase 2 consume ~400k tokens con 20 comparables. Solo Broward y Palm Beach; otro condado queda como Tier 2 manual.',reintentar2:'Vuelve a correr la fase que falló.',compra:'Queda registrado quién lo pasó y cuándo.'}[a];
 $('dlgOk').textContent=BOTON[a];$('dlg').showModal()}
$('frm').inspeccion_se_hace.onchange=ev=>{$('frm').inspeccion_ejecutada.disabled=ev.target.value==='No'};
const MSG=d=>({descartado:'Descartado: fuera de condado ('+(d.condado||'?')+')',precio:'Precio guardado',falta_precio:'Dirección guardada ('+(d.condado||'')+'). Falta el precio para pasar a Tier 1',falta_arv:'Guardado. Sin ARV no se evalúan los criterios: Tier 1 a mano',no_califica:'No califica: '+(d.motivo||''),tier1:'Lead en Tier 1'+(d.auto?' (cumple los criterios)':'')+(d.condado?' ('+d.condado+')':''),inspeccion:'Inspección guardada',tier2:'Lead en Tier 2'+(d.skill&&d.skill.lanzado?': fases 1–4 en cola':''),reintento:'Fase '+d.fase+' en cola de nuevo',compra:'Lead en Compra'})[d.resultado]||'Listo';
// Se guarda en el envío del formulario (no en el evento close del diálogo, que no siempre se dispara).
$('frm').addEventListener('submit',async ev=>{if(ev.submitter?.value!=='ok'||!current)return;const fd=Object.fromEntries(new FormData($('frm')));store.set('usuario',fd.usuario);if(fd.ejecutor)store.set('ejecutor',fd.ejecutor);
 try{toast(MSG(await post(current.id,current.a,fd)))}catch(e){toast(e.message)}current=null;load()});
function openMap(r){const q=fullAddr(r);$('mapTitle').textContent=q;$('mapFrame').src='https://maps.google.com/maps?q='+encodeURIComponent(q)+'&z=16&output=embed';
 $('mapLink').href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(q);$('mapPortales').innerHTML=portales(r);$('mapDlg').showModal()}
$('mapClose').onclick=()=>$('mapDlg').close();$('mapDlg').addEventListener('close',()=>{$('mapFrame').src='about:blank'});
document.addEventListener('click',async ev=>{const t=ev.target.closest('[data-tab]');if(t){tab=t.dataset.tab;store.set('tab',tab);fillEstado();render();return}
 const m=ev.target.closest('[data-map]');if(m){const r=all.find(x=>x.id===m.dataset.map);if(r)openMap(r);return}
 const b=ev.target.closest('button[data-a]');if(!b||RO)return;const r=all.find(x=>x.id===b.dataset.id);if(!r)return;
 if(b.dataset.a==='descartar'){if(!confirm('¿Descartar este lead? Se borra y la dirección no volverá a entrar.'))return;try{await post(r.id,'descartar');toast('Lead descartado')}catch(e){toast(e.message)}return load()}
 openDlg(b.dataset.a,r)});
['estado','condado','dup'].forEach(id=>$(id).onchange=render);$('q').oninput=render;fillEstado();load();setInterval(load,60000);
</script></body></html>`;
