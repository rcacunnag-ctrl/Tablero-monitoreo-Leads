# verif.json

Only what you read. Missing keys are fine.

```json
{
  "sujeto": {
    "beds": 3, "baths": 2,
    "condicion": "full | moderate | light | unknown",
    "condicion_evidencia": "listing says 'handyman special', tar-and-gravel roof",
    "listado": {"estado": "Active", "precio_lista": 220000, "dias": 55, "url": "https://..."}
  },
  "cerradas": {
    "1": {"ren": "yes | partial | no | likely", "beds": 3, "baths": 1, "dom": 14, "nota": "new roof 2026, renovated kitchen", "fuente_verif": "redfin.com"}
  },
  "ventas_extra": [
    {"direccion": "1117 W 23rd St, West Palm Beach", "precio": 280000, "fecha": "2026-08-28", "sqft": 988, "anio": 1962,
     "beds": 3, "baths": 1, "ren": "partial", "dom": 22, "nota": "roof and A/C 2 years old", "fuente": "trulia.com"}
  ],
  "activas": [
    {"direccion": "109 E Example St", "precio": 299000, "sqft": 1010, "beds": 3, "baths": 2, "estado": "Active", "dom": 12, "recortes": 0, "nota": "renovated, pool"}
  ],
  "fuentes": ["https://www.redfin.com/..."]
}
```

- Keys of `cerradas` are the `id` values of `universo.json`.
- `ren`: `yes` renovated (remarks confirm), `partial` improvements with evidence, `no` as-is, `likely` not verified.
- `ventas_extra` are closed sales after the roll cutoff; the analysis geocodes them.

# narrativa.json

```json
{
  "lede": "At <strong>$189,000</strong> with ...",
  "favor": ["..."], "contra": ["..."], "cambia": ["..."],
  "arv_texto": "...",
  "notas_cerradas": {"1": "A flip: bought $185,000 Nov 2025 ..."},
  "riesgos_extra": [{"t": "Court-ordered sale delays closing", "p": "Medium", "i": "High", "expo": "Missed closing date", "q": "Confirm court approval and the deposit terms."}],
  "no_confirmado": ["Condition and rehab scope ...", "..."]
}
```

# analisis.json (read-only, written by `analizar.py`)

Subject, verified comparables with `cat`, bands, ARV (`valor`, `confianza` high|medium|low), the flip model (`base`: compra, cierre, reno, tenencia, costo, arv, venta, ganancia, roi, mao, equilibrio; `filas`: sensitivity), the decision (`veredicto`, `score`, `negociable`, `oferta_sugerida`) and the deterministic risks.

# Thresholds

`assets/umbrales.json`: target profit, holding months, closing and selling percentages, rehab $/sf by condition, the radius, what counts as negotiable. Change them there; the report labels them ASSUMED.
