#!/usr/bin/env python3
"""Tier 1-V2, paso 3: analisis.json (+ narrativa.json) -> un HTML autocontenido.

    python render.py <carpeta> <salida.html>

Todo es HTML y SVG estáticos (se lee en la vista previa del celular sin JavaScript); lo único con JavaScript es el
modelo de flip interactivo. Sin mapas externos ni fuentes de red obligatorias. Texto en inglés.
"""
import html
import json
import math
import os
import re
import sys
from datetime import date, datetime

AQUI = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(AQUI, "..", "assets")
e = lambda s: html.escape(str(s if s is not None else ""), quote=True)  # noqa: E731
usd = lambda v: ("-$" if v < 0 else "$") + f"{abs(round(v)):,}" if v is not None else "n/a"  # noqa: E731
k_usd = lambda v: f"${round(v / 1000):,}k"  # noqa: E731
MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fecha_txt(f):
    d = datetime.fromisoformat(f[:10])
    return f"{MESES[d.month - 1]} {d.year}" if f[8:10] == "15" else f"{MESES[d.month - 1]} {d.day}, {d.year}"


def carga(p, d=None):
    try:
        return json.load(open(p, encoding="utf-8"))
    except FileNotFoundError:
        return d


def pill_cond(c):
    ren = c["ren"]
    if ren in ("yes", "new"):
        return '<span class="pill p-ren">Renovated</span>'
    if ren == "partial":
        return '<span class="pill p-ren">Improved</span>'
    if ren == "no":
        return '<span class="pill p-asis">As-is</span>'
    return '<span class="pill p-nv">Not verified</span>'


def marcador(c):
    return {"yes": "m-ren", "new": "m-ren", "partial": "m-ref", "no": "m-asis"}.get(c["ren"], "m-ref")


def escala_precios(a):
    """Escalera de precios: cada dato en su fila, puntos por condición, línea de MAO y de equilibrio."""
    m, base = a["modelo"], a["modelo"]["base"]
    items = []  # (precio, clase, forma, etiqueta)
    for c in sorted(a["cerradas"], key=lambda c: -(c["cat"] in (1, 2)))[:8]:
        items.append((c["precio"], marcador(c), "dot", f"{c['direccion'].split(',')[0]} · {k_usd(c['precio'])}"))
    items.append((m["compra"], "m-act", "dia", f"Price offered to you · {k_usd(m['compra'])}"))
    items.append((a["arv"]["valor"], "m-act", "dia", f"Resale value used · {k_usd(a['arv']['valor'])}"))
    items.sort(key=lambda x: x[0])
    lo = min(min(i[0] for i in items), m["mao"] or 1e9, base["equilibrio"]) * 0.94
    hi = max(i[0] for i in items) * 1.06
    x0, x1 = 40, 860
    X = lambda p: x0 + (p - lo) / (hi - lo) * (x1 - x0)  # noqa: E731
    top, fila = 70, 26
    h = top + fila * len(items) + 50
    out = [f'<svg viewBox="0 0 900 {h}" role="img" aria-label="Price ladder: offered price, maximum offer, break-even and nearby sales by condition">']
    paso = 20000 if hi - lo > 160000 else 10000
    t = math.ceil(lo / paso) * paso
    while t <= hi:
        out.append(f'<line x1="{X(t):.0f}" y1="{top - 10}" x2="{X(t):.0f}" y2="{h - 36}" class="grid"/><text x="{X(t):.0f}" y="{h - 16}" class="tick" text-anchor="middle">{k_usd(t)}</text>')
        t += paso
    for p, cls, tx, anch in ((m["mao"], "basis", f"Maximum offer {usd(m['mao'])}", "end"), (base["equilibrio"], "be", f"Break-even {usd(base['equilibrio'])}", "start")):
        out.append(f'<line x1="{X(p):.0f}" y1="{top - 10}" x2="{X(p):.0f}" y2="{h - 36}" class="{cls}"/><text x="{X(p) + (-6 if anch == "end" else 6):.0f}" y="{top - 16}" class="lab{" bad" if cls == "be" else ""}" text-anchor="{anch}">{e(tx)}</text>')
    if a["bandas"]["renovadas"]:
        r = [c["precio"] for c in a["cerradas"] if c["ren"] in ("yes", "new", "partial") and c["cat"] in (1, 2)]
        out.append(f'<rect x="{X(min(r)):.0f}" y="{top - 10}" width="{max(8, X(max(r)) - X(min(r))):.0f}" height="{h - 36 - top + 10}" class="band"/>')
    for i, (p, cls, forma, tx) in enumerate(items):
        y = top + 14 + fila * i
        cx = X(p)
        if forma == "dot":
            out.append(f'<circle cx="{cx:.0f}" cy="{y}" r="7" class="{cls}"/>')
        else:
            out.append(f'<rect x="{cx - 6:.0f}" y="{y - 6}" width="12" height="12" transform="rotate(45 {cx:.0f} {y})" class="m-act"/>')
        izq = cx > 640
        out.append(f'<text x="{cx + (-12 if izq else 12):.0f}" y="{y + 4}" class="lab" text-anchor="{"end" if izq else "start"}">{e(tx)}</text>')
    out.append("</svg>")
    return "".join(out)


def mapa_escala(a):
    s = a["sujeto"]
    pts = [c for c in a["cerradas"] if c.get("lat") and c["cat"] in (1, 2, 3)][:12]
    if "lat" not in s or not pts:
        return '<p class="sub">Coordinates were not available, so no map is drawn.</p>'
    cx0, cy0 = 260, 220
    dx = lambda c: (c["lng"] - s["lng"]) * math.cos(math.radians(s["lat"])) * 69.17  # noqa: E731
    dy = lambda c: (c["lat"] - s["lat"]) * 69.0  # noqa: E731
    ext = max(max(abs(dx(c)), abs(dy(c))) for c in pts) or 0.5
    esc = 190 / ext  # px por milla
    out = ['<svg viewBox="0 0 520 440" role="img" aria-label="To-scale plot of the subject and comps">']
    for r in (0.5, 1.0, 1.5):
        if r <= ext * 1.05:
            out.append(f'<circle cx="{cx0}" cy="{cy0}" r="{r * esc:.0f}" class="ring"/><text x="{cx0 + r * esc * 0.7 + 3:.0f}" y="{cy0 - r * esc * 0.7:.0f}" class="tick">{r} mi</text>')
    for c in pts:
        x, y = cx0 + dx(c) * esc, cy0 - dy(c) * esc
        izq = x > 330
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="7" class="{marcador(c)}"/><text x="{x + (-11 if izq else 11):.0f}" y="{y + 4:.0f}" class="lab" text-anchor="{"end" if izq else "start"}">{e(c["direccion"].split(",")[0])} {k_usd(c["precio"])}</text>')
    out.append(f'<path d="M{cx0} {cy0 - 9} l3.2 7 7.6 .8 -5.7 5.1 1.7 7.5 -6.8 -3.9 -6.8 3.9 1.7 -7.5 -5.7 -5.1 7.6 -.8z" class="m-subj"/><text x="{cx0 - 12}" y="{cy0 + 20}" class="lab strong" text-anchor="end">Subject</text>')
    out.append(f'<line x1="30" y1="426" x2="{30 + 0.5 * esc:.0f}" y2="426" class="basis" style="stroke-dasharray:none"/><text x="{36 + 0.5 * esc:.0f}" y="430" class="tick">0.5 mi</text><text x="506" y="24" class="tick" text-anchor="end">N ↑</text></svg>')
    return "".join(out)


def ventanas(a):
    hoy = date.fromisoformat(a["generado"])
    out = []
    for n in (30, 60, 90, 180, 365):
        en = [c for c in a["cerradas"] if (hoy - date.fromisoformat(c["fecha"][:10])).days <= n]
        out.append(f'<div class="win"><span class="k">{n} days</span><span class="v">{len(en)}</span><span class="s">{sum(1 for c in en if c["ren"] in ("yes", "new", "partial"))} renovated</span></div>')
    return "".join(out)


def matriz(riesgos):
    nivel = {"Low": 1, "Medium": 2, "High": 3}
    celdas = {}
    for i, r in enumerate(riesgos, 1):
        celdas.setdefault((nivel[r["i"]], nivel[r["p"]]), []).append(i)
        r["rating"] = "High" if nivel[r["i"]] * nivel[r["p"]] >= 6 else "Medium" if nivel[r["i"]] * nivel[r["p"]] >= 3 else "Low"
    cls = lambda i, p: "r-hi" if i * p >= 6 else "r-md" if i * p >= 3 else "r-lo"  # noqa: E731
    g = ['<div class="rx">']
    for i, nom in ((3, "High impact"), (2, "Medium impact"), (1, "Low impact")):
        g.append(f'<div class="rx-ax">{nom}</div>')
        for p in (1, 2, 3):
            g.append(f'<div class="rx-c {cls(i, p)}">' + "".join(f'<span class="chip">{n}</span>' for n in celdas.get((i, p), [])) + "</div>")
    g.append('<div class="rx-ax"></div>' + "".join(f'<div class="rx-ax b">{t}</div>' for t in ("Low likelihood", "Medium likelihood", "High likelihood")) + "</div>")
    return "".join(g)


def auto_texto(a):
    """Lectura determinista cuando Claude no escribió narrativa.json."""
    m, b, d = a["modelo"], a["modelo"]["base"], a["decision"]
    nR = a["bandas"]["renovadas"]
    lede = (f"At <strong>{usd(m['compra'])}</strong> with a {usd(m['reno'])} rehab and a <strong>{usd(a['arv']['valor'])}</strong> resale, the profit is about "
            f"<strong>{usd(b['ganancia'])}</strong>. The deal works at a price near <strong>{usd(m['mao'])}</strong>.")
    favor = [f"{a['bandas']['cat']['1'] + a['bandas']['cat']['2']} Cat. 1-2 closed sales within {a['cobertura']['radio_millas']} miles; {nR} are renovated or improved."]
    contra = [f"The break-even price is {usd(b['equilibrio'])}; the price offered is {usd(m['compra'])}."] if m["brecha"] and m["brecha"] > 0 else []
    cambia = [f"A price at or under {usd(m['mao'])}."]
    return lede, favor, contra, cambia


def main():
    carpeta, destino = sys.argv[1], sys.argv[2]
    a = carga(os.path.join(carpeta, "analisis.json"))
    n = carga(os.path.join(carpeta, "narrativa.json"), {})
    css = open(os.path.join(ASSETS, "style.css"), encoding="utf-8").read()
    js = open(os.path.join(ASSETS, "flip.js"), encoding="utf-8").read()
    s, m, d, cob = a["sujeto"], a["modelo"], a["decision"], a["cobertura"]
    b = m["base"]
    if not b:
        open(destino, "w", encoding="utf-8").write(f"<!doctype html><meta charset=utf-8><title>{e(s['direccion'])} Tier 1</title><p>No price or no supportable ARV for {e(s['direccion'])}: no analysis could be computed.</p>")
        return
    lede, favor, contra, cambia = auto_texto(a)
    lede = n.get("lede", lede)
    favor, contra, cambia = n.get("favor", favor), n.get("contra", contra), n.get("cambia", cambia)
    liv = b["ganancia"] + 0
    from_liviano = next((f["liviano"] for f in m["filas"] if f["nota"] == "Price offered."), None)
    claro = "good" if b["ganancia"] >= m["u"]["ganancia_objetivo_usd"] else "bad" if b["ganancia"] < 0 else "warn"
    verde = {"Advance to Tier 2": "good", "Advance with conditions": "warn", "Do not advance": "bad"}[d["veredicto"]]

    cerr = sorted(a["cerradas"], key=lambda c: (c["cat"], c["dist"] if c["dist"] is not None else 9))[:15]
    filas_cerr = "".join(
        f'<tr><td style="white-space:nowrap"><strong>{e(c["direccion"].split(",")[0])}</strong></td><td><span class="pill c{c["cat"]}">Cat. {c["cat"]}</span></td><td>{pill_cond(c)}</td>'
        f'<td class="n">{usd(c["precio"])}</td><td class="n">{usd(c["ppsf"]) if c["ppsf"] else "n/a"}</td><td>{fecha_txt(c["fecha"])}</td>'
        f'<td class="n">{(date.fromisoformat(a["generado"]) - date.fromisoformat(c["fecha"][:10])).days}</td><td>{(str(c["beds"]).rstrip("0").rstrip(".") + "/" + str(c["baths"]).rstrip("0").rstrip(".")) if c.get("beds") else "n/a"}</td>'
        f'<td class="n">{c["sqft"]:,.0f}</td><td class="n">{c["anio"]:.0f}</td><td class="n">{c["dist"] if c["dist"] is not None else "n/a"}</td><td class="n">{c["dom"] if c.get("dom") else "n/a"}</td>'
        f'<td class="note">{e((n.get("notas_cerradas") or {}).get(str(c["id"])) or c.get("nota") or (c["cat_why"][:140] if c.get("cat_why") else ""))}</td></tr>'
        for c in cerr)

    act = a["activas"]
    if act:
        filas_act = "".join(
            f'<tr><td style="white-space:nowrap"><strong>{e(x["direccion"])}</strong></td><td><span class="pill">{e(x.get("estado", "Active"))}</span></td><td class="n">{usd(x["precio"])}</td>'
            f'<td class="n">{usd(x["precio"] / x["sqft"]) if x.get("sqft") else "n/a"}</td><td>{e(x.get("beds", ""))}/{e(x.get("baths", ""))}</td><td class="n">{x.get("sqft") or "n/a"}</td><td class="n">{x.get("dom") or "n/a"}</td><td class="n">{x.get("recortes", "n/a")}</td><td class="note">{e(x.get("nota", ""))}</td></tr>'
            for x in act)
        listados = f'<div class="tw"><table><thead><tr><th>Address</th><th>Status</th><th>Ask</th><th>$/sf</th><th>Bed/Bath</th><th>SF</th><th>DOM</th><th>Cuts</th><th>Notes</th></tr></thead><tbody>{filas_act}</tbody></table></div>'
    else:
        listados = '<p class="sub">Active and pending competition was not surveyed in this run: the state roll has no listings. Connect the MLS (or run a listing scan) to fill this section.</p>'
    ls = a["verificacion"].get("listado")
    if ls:
        listados = f'<p><strong>Subject listing:</strong> {e(ls.get("estado", ""))} at {usd(ls["precio_lista"]) if ls.get("precio_lista") else "n/a"}' + (f", {ls['dias']} days on market" if ls.get("dias") else "") + ".</p>" + listados

    filas_sens = "".join(f'<tr><td class="n">{usd(f["compra"])}</td><td class="n">{usd(f["completo"])}</td><td class="n">{usd(f["liviano"])}</td><td class="n">{usd(f["arv_alto"])}</td><td>{e(f["nota"])}</td></tr>' for f in m["filas"])
    prest = round(m["compra"] * 0.8, -4)
    interes = prest * 0.12 * m["meses"] / 12 + prest * 0.02
    riesgos = a["riesgos"] + n.get("riesgos_extra", [])
    mat = matriz(riesgos)
    filas_r = "".join(
        f'<tr><td class="n"><span class="chip">{i}</span></td><td><strong>{e(r["t"])}</strong></td><td>{r["p"]}</td><td>{r["i"]}</td><td><span class="pill r-{"hi" if r["rating"] == "High" else "md" if r["rating"] == "Medium" else "lo"}">{r["rating"]}</span></td><td>{e(r["expo"])}</td><td class="note">{e(r["q"])}</td></tr>'
        for i, r in enumerate(riesgos, 1))
    nconf = n.get("no_confirmado") or [
        f"Rehab scope and condition: the ${m['reno']:,.0f} budget is ASSUMED from a per-sf rate for a {m['reno_condicion']} rehab; no walk-through or photos were reviewed.",
        f"Sales after {cob.get('ultima_venta', 'n/a')[:7]} and all active or pending listings are not covered by the state roll.",
        f"{sum(1 for c in a['cerradas'] if not c.get('verificada'))} of {len(a['cerradas'])} comparables have no verified bed/bath count or renovation status; their category is provisional.",
        "Title, liens, owner of record and open permits were not pulled; closing, holding and selling costs are ASSUMED."]
    fuentes = f"Sources: {cob['fuente']}; U.S. Census batch geocoder" + ("; " + "; ".join(a["fuentes_extra"]) if a["fuentes_extra"] else "") + f". {cob['aviso']}"
    contexto = f"new purchase at {usd(m['compra'])}" + (f" · claimed ARV {usd(a['arv']['declarado'])}" if a["arv"]["declarado"] else "")
    nbr = e(s.get("barrio", ""))
    js = js.replace("var CL=0.02,CF=200,CP=0.0023;", f"var CL={m['u']['cierre_compra_pct']},CF={m['u']['tenencia_fija_mensual_usd']},CP={m['u']['tenencia_pct_anual'] / 12:.6f};")

    html_out = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(s['calle'].title())} Tier 1</title>
<style>{css}</style></head><body>
<div class="wrap">
<header>
<div class="eyebrow">Tier 1-V2 comp analysis · {contexto} · as of {fecha_txt(a['generado'])} · preliminary draft, not an appraisal</div>
<h1>{e(s['direccion'])}</h1>
<p class="lede">{lede}</p>
</header>
<div class="tiles">
<div class="tile hero"><span class="k">Maximum offer for a flip</span><span class="v">{usd(m['mao'])}</span><span class="s">For a {usd(m['u']['ganancia_objetivo_usd'])} profit with a {usd(m['reno'])} rehab, sold at {usd(a['arv']['valor'])}</span></div>
<div class="tile"><span class="k">Resale value used</span><span class="v">{usd(a['arv']['valor'])}</span><span class="s">{e(a['arv']['nota'])}. Confidence: {a['arv']['confianza']}</span></div>
<div class="tile"><span class="k">Price offered to you</span><span class="v">{usd(m['compra'])}</span><span class="s">{usd(m['compra'] - m['mao'])} {"above" if m['compra'] > m['mao'] else "under"} the maximum offer</span></div>
<div class="tile"><span class="k">Profit at {usd(m['compra'])}, base rehab</span><span class="v {claro}" id="t_profit">{usd(b['ganancia'])}</span><span class="s" id="t_roi">{b['roi'] * 100:.1f}% on cash, before any financing cost</span></div>
<div class="tile"><span class="k">Profit at {usd(m['compra'])}, lighter rehab</span><span class="v warn">{usd(from_liviano)}</span><span class="s">Rehab at {int(m['u']['rehab_liviano_factor'] * 100)}% of the base budget</span></div>
</div>

<section><h2>Lead read: {e(d['veredicto'].lower())} <span class="pill r-{ 'lo' if verde == 'good' else 'md' if verde == 'warn' else 'hi'}" style="vertical-align:middle">{d['score']}/100</span></h2>
<p>This is a read on stated evidence, not an instruction to buy.{" <strong>Provisional:</strong> the resale value is not backed by verified renovated sales, so confirm it before acting on this verdict." if d.get("provisional") else ""}{" A negotiable lead: an offer near " + usd(d['oferta_sugerida']) + " would work." if d['negociable'] else ""}</p>
<ul>{"".join(f"<li><strong>In favor:</strong> {x}</li>" for x in favor)}{"".join(f"<li><strong>Against:</strong> {x}</li>" for x in contra)}{"".join(f"<li><strong>What would change it:</strong> {x}</li>" for x in cambia)}</ul></section>

<section><h2>Where the price sits</h2>
<p class="sub">Dots are closed sales near the subject, colored by condition. Diamonds are the price offered and the resale value used. The shaded band is what renovated or improved Cat. 1-2 sales closed for.</p>
<div class="fig">{escala_precios(a)}</div>
<div class="legend"><span><i style="background:var(--acc)"></i>Renovated, sold</span><span><i style="background:var(--asis)"></i>As-is, sold</span><span><i style="background:var(--card);border:2px solid var(--acc)"></i>Improved or not verified, sold</span><span><i style="background:var(--act);border-radius:0;transform:rotate(45deg)"></i>Price offered or resale used</span></div>
<div class="tiles">
<div class="tile"><span class="k">As-is median</span><span class="v">{('$' + format(round(a['bandas']['mediana_asis_ppsf']), ',') + '/sf') if a['bandas']['mediana_asis_ppsf'] else 'n/a'}</span><span class="s">{a['bandas']['asis']} as-is sales</span></div>
<div class="tile"><span class="k">Renovated median</span><span class="v">{('$' + format(round(a['bandas']['mediana_renovada_ppsf']), ',') + '/sf') if a['bandas']['mediana_renovada_ppsf'] else 'n/a'}</span><span class="s">{a['bandas']['renovadas']} renovated or improved Cat. 1-2 sales</span></div>
<div class="tile"><span class="k">Ceiling</span><span class="v">{usd(a['bandas']['techo']) if a['bandas']['techo'] else 'n/a'}</span><span class="s">Highest renovated Cat. 1-2 sale</span></div>
<div class="tile"><span class="k">Categories</span><span class="v">{a['bandas']['cat']['1']} / {a['bandas']['cat']['2']} / {a['bandas']['cat']['3']}</span><span class="s">Cat. 1 / Cat. 2 / Cat. 3 closed sales</span></div>
</div>
{f'<p><strong>How the resale value was set.</strong> {e(n["arv_texto"])}</p>' if n.get('arv_texto') else ''}
</section>

<section><h2>Location and sales windows</h2>
<div class="two"><div class="fig map">{mapa_escala(a)}</div>
<div style="display:flex;flex-direction:column;gap:14px">
<p>{cob['dentro_del_radio']} closed sales within {cob['radio_millas']} miles from {e(cob['fuente'])}. Plotted to scale from geocoded coordinates.</p>
<div class="wins">{ventanas(a)}</div>
<p class="sub">Counts are closed sales in the comp set. Sale dates in the state roll are month-level.</p></div></div>
</section>

<section><h2>Closed sales</h2>
<p class="sub">Cat. 1 is renovated and the closest match; Cat. 2 is a looser match; Cat. 3 is a reference only. Categories come from the shared criteria sheet, not by eye. Showing the {len(cerr)} closest of {len(a['cerradas'])}.</p>
<p class="sub">Coverage: {a['uso_comps']['candidatas']} qualified sales of similar houses found in the state roll; {a['uso_comps']['fuera_del_radio']} fall outside {cob['radio_millas']} miles and {a['uso_comps']['sin_coordenadas']} could not be geocoded. {a['uso_comps']['en_radio_total']} are within {cob['radio_millas']} miles; the {a['uso_comps']['dentro_del_radio']} closest were analyzed, and {a['uso_comps']['usadas_para_arv']} are close enough in size and age to support the resale value ({a['uso_comps']['fuera_por_tamano_o_anio']} are not); {a['uso_comps']['verificadas']} had their page read and {a['uso_comps']['renovadas_verificadas']} were confirmed renovated or improved.</p>
<div class="tw"><table><thead><tr><th>Address</th><th>Cat.</th><th>Condition</th><th>Sold</th><th>$/sf</th><th>Date</th><th>Days ago</th><th>Bed/Bath</th><th>SF</th><th>Year</th><th>Miles</th><th>DOM</th><th>Notes</th></tr></thead><tbody>{filas_cerr}</tbody></table></div>
</section>

<section><h2>Listings</h2>{listados}</section>

<section><h2>Flip model</h2>
<div class="ctl">
<label>Purchase price<input id="buy" type="number" step="1000" value="{round(m['compra'])}"></label>
<label>Rehab budget<input id="reno" type="number" step="1000" value="{round(m['reno'])}"></label>
<label>Resale price<input id="arv" type="number" step="5000" value="{round(a['arv']['valor'])}"></label>
<label>Months held<input id="months" type="number" step="1" min="1" value="{m['meses']}"></label>
<label>Selling costs, % of price<input id="sellpct" type="number" step="0.1" value="{m['u']['venta_pct'] * 100:g}"></label>
<label>Hard money: loan amount<input id="loan" type="number" step="10000" value="0"></label>
<label>Hard money: rate %, plus 2 points<input id="rate" type="number" step="0.5" value="12"></label>
<label>Target profit<input id="target" type="number" step="5000" value="{m['u']['ganancia_objetivo_usd']}"></label>
</div>
<div class="tw"><table class="pl"><tbody>
<tr><td>Purchase price</td><td class="n" id="p_buy">{usd(b['compra'])}</td></tr>
<tr><td>Buyer closing costs <span class="note">(ASSUMED {m['u']['cierre_compra_pct'] * 100:g}%)</span></td><td class="n" id="p_close">{usd(b['cierre'])}</td></tr>
<tr><td>Rehab <span class="note">(ASSUMED: {m['reno_condicion']} scope until the house is walked)</span></td><td class="n" id="p_reno">{usd(b['reno'])}</td></tr>
<tr><td>Holding: {e(m['u']['tenencia_detalle'])} <span class="note">(ASSUMED)</span></td><td class="n" id="p_hold">{usd(b['tenencia'])}</td></tr>
<tr><td>Hard money interest and points <span class="note">(none unless you enter a loan)</span></td><td class="n" id="p_int">$0</td></tr>
<tr class="tot"><td>Total cash in</td><td class="n" id="p_cost">{usd(b['costo'])}</td></tr>
<tr><td>Resale price</td><td class="n" id="p_arv">{usd(b['arv'])}</td></tr>
<tr><td>Selling: commission, doc stamps, title <span class="note">(ASSUMED {m['u']['venta_pct'] * 100:g}%)</span></td><td class="n" id="p_sell">{usd(b['venta'])}</td></tr>
<tr class="res"><td>Net profit</td><td class="n {claro}" id="p_profit">{usd(b['ganancia'])}</td></tr>
<tr><td>Return on cash</td><td class="n" id="p_roi">{b['roi'] * 100:.1f}%</td></tr>
<tr><td>Maximum offer for the target profit</td><td class="n" id="p_mao">{usd(b['mao'])}</td></tr>
<tr><td>Break-even purchase price</td><td class="n" id="p_bep">{usd(b['equilibrio'])}</td></tr>
</tbody></table></div>
<h3>Profit at different purchase prices</h3>
<div class="tw"><table><thead><tr><th class="n">Purchase price</th><th class="n">Base rehab: {usd(m['reno'])}</th><th class="n">Lighter rehab: {usd(m['reno'] * m['u']['rehab_liviano_factor'])}</th><th class="n">Resale +{round((m['u']['arv_alto_factor'] - 1) * 100)}%</th><th>Note</th></tr></thead><tbody>{filas_sens}</tbody></table></div>
<div class="callout"><p><strong>Hard money changes the answer.</strong> A {usd(prest)} loan at 12% with 2 points for {m['meses']} months costs about {usd(interes)}, which takes the base case to about {usd(b['ganancia'] - interes)}. Enter your terms above.</p></div>
</section>

<section><h2>Risk matrix</h2>
<p class="sub">{len(riesgos)} risks rated by likelihood and impact on profit or timing. {sum(1 for r in riesgos if r['rating'] == 'High')} rate high. Ratings are judgment calls from the comp evidence and the unknowns listed below.</p>
{mat}
<div class="tw"><table><thead><tr><th>#</th><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Rating</th><th>Exposure</th><th>What to do</th></tr></thead><tbody>{filas_r}</tbody></table></div>
</section>

<section><h2>What is not confirmed</h2><ul>{"".join(f"<li>{e(x)}</li>" for x in nconf)}</ul></section>

<footer><span>{e(fuentes)}</span><span>Preliminary draft. Not an appraisal.</span></footer>
</div>
<script>
{js}
</script>
</body></html>"""
    with open(destino, "w", encoding="utf-8") as fh:
        fh.write(html_out)
    print(f"{destino}: {len(html_out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
