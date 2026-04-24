/**
 * QA adicional: 50 pruebas de propuestas (LOCAL + PROD), cruzando criterios de diseño.
 * Uso: node scripts/run-qa-propuestas.mjs
 * Actualiza informe-qa-YYYY-MM-DD.md (resumen 100 pruebas + sección Propuestas QA).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const LOCAL = "http://localhost:3000/api/agent";
const PROD = "https://asistente-facu.fly.dev/api/agent";
const DATE_STR = "2026-04-24";
const LAT_WARN_MS = 10_000;
const INFORME = path.join(ROOT, `informe-qa-${DATE_STR}.md`);
const DESIGN_DB = path.join(ROOT, "data", "productos-diseno-con-odoo.json");

/** 50 casos: id 1-50, módulo para tablas */
const CASES = [
  { id: 1, msg: "generá la propuesta de S02275", module: "GENERACIÓN DE PROPUESTA", kind: "gen_ov" },
  { id: 2, msg: "hacé la propuesta de S02149", module: "GENERACIÓN DE PROPUESTA", kind: "gen_ov" },
  { id: 3, msg: "propuesta para holster", module: "GENERACIÓN DE PROPUESTA", kind: "gen_cliente" },
  { id: 4, msg: "propuesta para diegmarc", module: "GENERACIÓN DE PROPUESTA", kind: "gen_cliente" },
  { id: 5, msg: "generá propuesta para pierrs", module: "GENERACIÓN DE PROPUESTA", kind: "gen_cliente" },
  { id: 6, msg: "propuesta de S02132", module: "GENERACIÓN DE PROPUESTA", kind: "gen_ov" },
  { id: 7, msg: "hacé la propuesta de versao", module: "GENERACIÓN DE PROPUESTA", kind: "gen_cliente" },
  { id: 8, msg: "generá propuesta para juanitas", module: "GENERACIÓN DE PROPUESTA", kind: "gen_cliente" },
  { id: 9, msg: "propuesta sin número de OV", module: "GENERACIÓN DE PROPUESTA", kind: "falta_ov" },
  {
    id: 10,
    msg: "propuesta para FicticioInexistente999ZZ",
    module: "GENERACIÓN DE PROPUESTA",
    kind: "no_cliente"
  },
  {
    id: 11,
    msg: "la propuesta de S02275 va con fondo negro y relieve blanco",
    module: "MODIFICACIÓN — colores",
    kind: "mod"
  },
  { id: 12, msg: "cambiá el fondo de S02149 a azul", module: "MODIFICACIÓN — colores", kind: "mod" },
  { id: 13, msg: "S02132 letras doradas sobre fondo negro", module: "MODIFICACIÓN — colores", kind: "mod" },
  { id: 14, msg: "la de versao va blanco sobre negro", module: "MODIFICACIÓN — colores", kind: "mod" },
  { id: 15, msg: "S02275 fondo bordo relieve plateado", module: "MODIFICACIÓN — colores", kind: "mod" },
  {
    id: 16,
    msg: "cambiá S02149 a dos variantes: una negra y una blanca",
    module: "MODIFICACIÓN — colores",
    kind: "mod"
  },
  { id: 17, msg: "la propuesta de juanitas va con Pantone 433", module: "MODIFICACIÓN — colores", kind: "mod" },
  {
    id: 18,
    msg: "S02132 tres colores: negro, blanco y dorado",
    module: "MODIFICACIÓN — colores",
    kind: "mod"
  },
  {
    id: 19,
    msg: "fondo transparente relieve negro en S02275",
    module: "MODIFICACIÓN — colores",
    kind: "mod"
  },
  { id: 20, msg: "S02149 mismo diseño pero en verde", module: "MODIFICACIÓN — colores", kind: "mod" },
  { id: 21, msg: "la propuesta de S02275 va en mayúsculas", module: "MODIFICACIÓN — tipografía y texto", kind: "mod" },
  { id: 22, msg: "S02149 tipografía serif", module: "MODIFICACIÓN — tipografía y texto", kind: "mod" },
  { id: 23, msg: "el texto de S02132 es HOLSTER en bold", module: "MODIFICACIÓN — tipografía y texto", kind: "mod" },
  {
    id: 24,
    msg: "S02275 texto en minúsculas estilo moderno",
    module: "MODIFICACIÓN — tipografía y texto",
    kind: "mod"
  },
  { id: 25, msg: "la de versao va con el logo centrado", module: "MODIFICACIÓN — tipografía y texto", kind: "mod" },
  {
    id: 26,
    msg: "S02149 agregar talle M debajo del nombre",
    module: "MODIFICACIÓN — tipografía y texto",
    kind: "mod"
  },
  {
    id: 27,
    msg: "S02132 texto MADE IN ARGENTINA abajo",
    module: "MODIFICACIÓN — tipografía y texto",
    kind: "mod"
  },
  { id: 28, msg: "S02275 el nombre va en dos líneas", module: "MODIFICACIÓN — tipografía y texto", kind: "mod" },
  { id: 29, msg: "S02275 es una bordada de 20mm rollo 1 color", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  { id: 30, msg: "S02149 cortada y doblada al medio 33mm", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  { id: 31, msg: "S02132 rollo 16mm alta definición", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  { id: 32, msg: "la de versao es tafeta 20mm cortada soldada", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  { id: 33, msg: "S02275 cambiar a 25mm de ancho", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  { id: 34, msg: "S02149 es horizontal no vertical", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  { id: 35, msg: "S02132 medidas 33x80mm", module: "MODIFICACIÓN — medidas y terminación", kind: "mod" },
  {
    id: 36,
    msg: "generá la propuesta de S02275",
    module: "FLUJO COMPLETO",
    kind: "flow1",
    follow: "cambiá el fondo a negro"
  },
  { id: 37, msg: "propuesta para holster", module: "FLUJO COMPLETO", kind: "flow1", follow: "agregá talle L" },
  {
    id: 38,
    msg: "hacé la propuesta de S02149",
    module: "FLUJO COMPLETO",
    kind: "flow1",
    follow: "va en dos colores negro y blanco"
  },
  {
    id: 39,
    msg: "propuesta de S02132",
    module: "FLUJO COMPLETO",
    kind: "flow1",
    follow: "la tipografía es Oswald"
  },
  {
    id: 40,
    msg: "generá propuesta para diegmarc",
    module: "FLUJO COMPLETO",
    kind: "flow1",
    follow: "es horizontal con fondo azul"
  },
  { id: 41, msg: "propuesta de S00001", module: "EDGE CASES de propuesta", kind: "ov_inexistente" },
  { id: 42, msg: "generá la propuesta", module: "EDGE CASES de propuesta", kind: "falta_todo" },
  { id: 43, msg: "propuesta para todos mis clientes", module: "EDGE CASES de propuesta", kind: "ambiguo" },
  {
    id: 44,
    msg: "S02275 propuesta con logo que no tengo cargado",
    module: "EDGE CASES de propuesta",
    kind: "gen_ov"
  },
  {
    id: 45,
    msg: "hacé la propuesta de S02149 con los colores del PDF que subí",
    module: "EDGE CASES de propuesta",
    kind: "gen_ov"
  },
  { id: 46, msg: "propuesta de S02149 urgente para hoy", module: "EDGE CASES de propuesta", kind: "gen_ov" },
  { id: 47, msg: "modificá la propuesta de S02275", module: "EDGE CASES de propuesta", kind: "falta_cambio" },
  { id: 48, msg: "S02275 propuesta en PDF", module: "EDGE CASES de propuesta", kind: "gen_ov" },
  {
    id: 49,
    msg: "propuesta igual a la de holster pero para diegmarc",
    module: "EDGE CASES de propuesta",
    kind: "complejo"
  },
  {
    id: 50,
    msg: "S02275 propuesta con todo lo que aprendiste de los PDFs",
    module: "EDGE CASES de propuesta",
    kind: "design_db"
  }
];

const MODULE_ORDER = [
  "GENERACIÓN DE PROPUESTA",
  "MODIFICACIÓN — colores",
  "MODIFICACIÓN — tipografía y texto",
  "MODIFICACIÓN — medidas y terminación",
  "FLUJO COMPLETO",
  "EDGE CASES de propuesta"
];

function combinedReply(r) {
  return [r?.reply, r?.data?.reply]
    .filter(Boolean)
    .map((s) => String(s))
    .join(" ") || "";
}

function hasPropuestaUrl(text) {
  return /\/propuestas\/[^\s)'"]+/i.test(String(text || ""));
}

function hasListoPropuesta(text) {
  const t = String(text || "");
  if (!hasPropuestaUrl(t)) return false;
  return /listo|gener[ée]|actualic|descargá|propuesta|pdf/i.test(t);
}

function notFoundClient(text) {
  const t = String(text).toLowerCase();
  return /no (encontr|hay|existe|figura)|ningún|ninguna coincid|más exacto|no encontré/i.test(t);
}

function designDbHintInReply(text) {
  return /pdf|diseño|bordad|etiquet|ficha|tafeta|bordada|pantone|tipograf|av(?:í|i)os|ingest|producc/i.test(
    String(text)
  );
}

function hasSkuInDesignJson(sku) {
  if (!fs.existsSync(DESIGN_DB)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(DESIGN_DB, "utf8"));
    const u = String(sku || "")
      .trim()
      .toUpperCase();
    return (Array.isArray(j) ? j : []).some((p) => String(p.sku || "").toUpperCase() === u);
  } catch {
    return false;
  }
}

function evaluateProp(caseInfo, status, data, ms, reply) {
  const { kind, id } = caseInfo;
  const full = combinedReply({ reply, data });
  let result = "PASS";
  let note = "";

  if (ms > LAT_WARN_MS) {
    result = "WARN";
    note = `latencia ${ms}ms > ${LAT_WARN_MS / 1000}s`;
  }
  if (status >= 500) {
    return { result: "FAIL", note: `HTTP ${status}` };
  }
  if (status === 0) {
    return { result: "FAIL", note: "sin conexión" };
  }

  const pdfOk = hasPropuestaUrl(full) && hasListoPropuesta(full);
  const pdfPartial = hasPropuestaUrl(full);

  if (kind === "falta_ov" || kind === "falta_todo") {
    if (pdfOk || pdfPartial) {
      return { result: "FAIL", note: "esperado pedir datos, obtuvo PDF" };
    }
    if (!/pregunta|decime|cuál|falta|número|s0|ov|orden|para qué|marca|cliente/i.test(full)) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "no se detecta pedido explícito de OV";
    } else {
      if (ms > LAT_WARN_MS && result === "PASS") {
        result = "WARN";
        note = (note ? note + "; " : "") + "lat…";
      }
    }
    return { result, note: note || "pide dato" };
  }

  if (kind === "no_cliente") {
    if (pdfOk) {
      return { result: "FAIL", note: "PDF con cliente inexistente" };
    }
    if (!notFoundClient(full) && !/no hay órdenes|no hay ventas|sin órdenes/i.test(full)) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "no se detecta mensaje de no encontrado";
    }
    return { result, note };
  }

  if (kind === "ov_inexistente") {
    if (pdfOk) {
      return { result: "WARN", note: (note ? note + "; " : "") + "devolvió PDF pese a OV cuestionable" };
    }
    if (!/no (encontr|existe|pude)|error|inexistente|válid|válida|revis|no hay|ninguna/i.test(full)) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "revisar si explica que la OV no existe";
    }
    return { result, note };
  }

  if (kind === "ambiguo") {
    if (pdfOk) {
      return { result: "FAIL", note: "PDF sin OV específica" };
    }
    if (!/específic|una ov|número|s0|cuál|de cuál|decime|individual/i.test(full)) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "debería pedir una OV concreta";
    }
    return { result, note };
  }

  if (kind === "falta_cambio") {
    if (pdfOk) {
      return { result: "WARN", note: (note ? note + "; " : "") + "PDF sin especificar cambio" };
    }
    if (!/qué|cuál|cambi|detall|especif|decime|fondo|texto|color|tipograf/i.test(full)) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "esperable pedir qué modificar";
    }
    return { result, note };
  }

  if (kind === "design_db") {
    if (!hasSkuInDesignJson("S02275")) {
      if (result === "PASS" && !note) return { result: "PASS", note: "sin ficha S02275 en productos-diseno (omitir criterio DB)" };
    }
    if (pdfOk || pdfPartial) {
      if (!designDbHintInReply(full)) {
        if (result === "PASS") result = "WARN";
        note = (note ? note + "; " : "") + "PDF sin alusión a datos de diseño/PDFs (productDesignDB no expuesto al usuario)";
      }
    }
    return { result, note: note || "OK" };
  }

  if (kind === "complejo") {
    if (!pdfOk && !/holster|diegmarc|s0\d{4}/i.test(full)) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "revisar búsqueda de ambas OVs / marcas";
    }
    return { result, note };
  }

  if (kind === "gen_ov" || kind === "gen_cliente") {
    if (!pdfOk) {
      if (pdfPartial) {
        if (result === "PASS") result = "WARN";
        note = (note ? note + "; " : "") + "URL /propuestas/ sin frase de confirmación";
      } else {
        if (notFoundClient(full) || /no hay órdenes|no hay venta/i.test(full)) {
          if (result === "PASS") result = "WARN";
          note = (note ? note + "; " : "") + "no generó PDF (datos/OC ausentes en Odoo?)";
        } else {
          if (result === "PASS") result = "WARN";
          note = (note ? note + "; " : "") + "no se detectó PDF / propuesta OK";
        }
      }
    }
    return { result, note };
  }

  if (kind === "mod") {
    if (!pdfOk) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "no se detectó PDF listo; puede ser ruta distinta o solo texto";
    }
    return { result, note };
  }

  if (kind === "flow1") {
    void id;
  }

  return { result, note: note || "" };
}

function evaluateFlow(caseInfo, r1, r2) {
  const full1 = combinedReply(r1);
  const full2 = combinedReply(r2);
  const ms = (r1.ms || 0) + (r2.ms || 0);
  let result = "PASS";
  let note = "";
  if (ms / 2 > LAT_WARN_MS) {
    result = "WARN";
    note = `latencia acum. alta (~${ms}ms)`;
  }
  if (r1.status >= 500 || r2.status >= 500) {
    return { result: "FAIL", note: "HTTP 5xx en flujo" };
  }
  const p2 = hasPropuestaUrl(full2) && hasListoPropuesta(full2);
  const p1 = hasPropuestaUrl(full1) && hasListoPropuesta(full1);
  if (p2) {
    if (ms > 2 * LAT_WARN_MS) {
      if (result === "PASS") result = "WARN";
      note = (note ? note + "; " : "") + "muy lento 2 pasos";
    }
    return { result, note: note || "2º msg generó PDF" };
  }
  if (p1 && p2) return { result, note: "ambos con PDF" };
  if (p1 && !p2) {
    if (result === "PASS") result = "WARN";
    return { result, note: (note ? note + "; " : "") + "1º ok, 2º sin PDF" };
  }
  if (result === "PASS") result = "WARN";
  return { result, note: (note ? note + "; " : "") + "flujo incompleto o sin /propuestas/ en 2º" };
}

async function postAgent(url, body) {
  const t0 = Date.now();
  let status;
  let data;
  let text = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    status = res.status;
    text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text.slice(0, 500) };
    }
  } catch (e) {
    return {
      ms: Date.now() - t0,
      status: 0,
      data: {},
      reply: "",
      err: String(e.message || e)
    };
  }
  return {
    ms: Date.now() - t0,
    status,
    data,
    reply: data?.reply ?? data?.message ?? text ?? "",
    err: null
  };
}

async function runAll(baseUrl, envLabel) {
  const out = [];
  for (const c of CASES) {
    if (c.kind === "flow1" && c.follow) {
      const r1 = await postAgent(baseUrl, { message: c.msg, history: [] });
      if (r1.err) {
        out.push({
          ...c,
          _env: envLabel,
          ms: r1.ms,
          status: r1.status,
          reply: r1.err,
          result: "FAIL",
          note: `network: ${r1.err}`,
          isFlow: true
        });
        continue;
      }
      const sid = r1.data?.sessionId;
      const r2 = sid
        ? await postAgent(baseUrl, { message: c.follow, history: [], sessionId: sid })
        : { ms: 0, status: 0, data: {}, reply: "sin sessionId" };
      const fr = evaluateFlow(c, r1, r2);
      out.push({
        ...c,
        _env: envLabel,
        ms: (r1.ms || 0) + (r2.ms || 0),
        status: r2.status || r1.status,
        reply: `[1] ${String(r1.reply).slice(0, 200)} | [2] ${String(r2.reply).slice(0, 200)}`,
        data: r2.data,
        result: fr.result,
        note: fr.note,
        isFlow: true
      });
      continue;
    }

    const { ms, status, data, reply, err } = await postAgent(baseUrl, { message: c.msg, history: [] });
    if (err) {
      out.push({ ...c, _env: envLabel, ms, status, reply: err, result: "FAIL", note: `network: ${err}` });
      continue;
    }
    const ev = evaluateProp(c, status, data, ms, reply);
    out.push({ ...c, _env: envLabel, ms, status, reply: String(reply).slice(0, 500), data, result: ev.result, note: ev.note });
  }
  return out;
}

function summarize(rows) {
  let pass = 0,
    fail = 0,
    warn = 0;
  let latSum = 0;
  let latMax = 0;
  for (const r of rows) {
    if (r.result === "PASS") pass++;
    else if (r.result === "FAIL") fail++;
    else warn++;
    latSum += r.ms;
    if (r.ms > latMax) latMax = r.ms;
  }
  return { pass, fail, warn, avg: rows.length ? Math.round(latSum / rows.length) : 0, max: latMax };
}

function readBaseInforme() {
  if (!fs.existsSync(INFORME)) return null;
  return fs.readFileSync(INFORME, "utf8");
}

/** Filas 1–50 en “## Resultados por módulo” (no Propuestas QA). */
function reparseGeneral50(text) {
  const start = text.indexOf("## Resultados por módulo");
  if (start < 0) {
    return { local: { pass: 0, fail: 0, warn: 0 }, prod: { pass: 0, fail: 0, warn: 0 } };
  }
  const eP = text.indexOf("## Propuestas QA", start);
  const eF = text.indexOf("## FAILs críticos", start);
  const cands = [eP, eF].filter((x) => x > start);
  const end = cands.length ? Math.min(...cands) : text.length;
  const slice = text.slice(start, end);
  const local = { pass: 0, fail: 0, warn: 0 };
  const prod = { pass: 0, fail: 0, warn: 0 };
  const bump = (o, icon) => {
    if (icon === "✅") o.pass++;
    else if (icon === "❌") o.fail++;
    else o.warn++;
  };
  for (const line of slice.split("\n")) {
    const m = line.match(/^\| (\d{1,2}) \|.+\| (✅|❌|⚠️) \| (✅|❌|⚠️) \|/);
    if (m) {
      const id = +m[1];
      if (id >= 1 && id <= 50) {
        bump(local, m[2]);
        bump(prod, m[3]);
      }
    }
  }
  return { local, prod };
}

function readBaseLatency(text) {
  const mm = text.match(/\| Latencia promedio[^|]*\| (\d+)ms \| (\d+)ms \|/);
  const m2 = text.match(/\| Latencia máxima[^|]*\| (\d+)ms \| (\d+)ms \|/);
  return {
    avgL: mm ? +mm[1] : 0,
    avgP: mm ? +mm[2] : 0,
    maxL: m2 ? +m2[1] : 0,
    maxP: m2 ? +m2[2] : 0
  };
}

async function main() {
  const base0 = readBaseInforme();
  if (!base0) {
    console.error("Falta informe base. Corré: node scripts/run-qa-tests.mjs");
    process.exit(1);
  }
  if (!/## Resultados por módulo\n/.test(base0)) {
    console.error("informe-qa: formato inesperado (falta ## Resultados por módulo)");
    process.exit(1);
  }

  const { local: l50a, prod: p50a } = reparseGeneral50(base0);
  const lat0 = readBaseLatency(base0);

  console.log("Propuestas: LOCAL…");
  const localP = await runAll(LOCAL, "Local");
  console.log("Propuestas: PROD…");
  const prodP = await runAll(PROD, "Prod");

  const sPL = summarize(localP);
  const sPP = summarize(prodP);

  const tL = {
    pass: l50a.pass + sPL.pass,
    fail: l50a.fail + sPL.fail,
    warn: l50a.warn + sPL.warn,
    avg: Math.round((lat0.avgL * 50 + sPL.avg * 50) / 100) || 0,
    max: Math.max(lat0.maxL, sPL.max)
  };
  const tP = {
    pass: p50a.pass + sPP.pass,
    fail: p50a.fail + sPP.fail,
    warn: p50a.warn + sPP.warn,
    avg: Math.round((lat0.avgP * 50 + sPP.avg * 50) / 100) || 0,
    max: Math.max(lat0.maxP, sPP.max)
  };

  const newResumen = `## Resumen ejecutivo
| Métrica | Local | Prod |
|---|---|---|
| Total pruebas (general + propuestas) | 100 | 100 |
| PASS | ${tL.pass} | ${tP.pass} |
| FAIL | ${tL.fail} | ${tP.fail} |
| WARN | ${tL.warn} | ${tP.warn} |
| Latencia promedio (ponderada 50+50) | ${tL.avg}ms | ${tP.avg}ms |
| Latencia máxima (entre ambas baterías) | ${tL.max}ms | ${tP.max}ms |

| Subconjunto | Local PASS | Local WARN | Local FAIL | Prod PASS | Prod WARN | Prod FAIL |
|---|---:|---:|---:|---:|---:|---:|
| General (50) | ${l50a.pass} | ${l50a.warn} | ${l50a.fail} | ${p50a.pass} | ${p50a.warn} | ${p50a.fail} |
| Propuestas (50) | ${sPL.pass} | ${sPL.warn} | ${sPL.fail} | ${sPP.pass} | ${sPP.warn} | ${sPP.fail} |
`;

  let propMd = `## Propuestas QA
Criterios (heurístico): **PASS** = PDF con \`/propuestas/...\` y confirmación, o conducta esperada. **WARN** = latencia >${LAT_WARN_MS / 1000}s o criterio dudoso. **FAIL** = 5xx o regla dura. Flujos **36-40:** mismo \`sessionId\` en el 2.º request.
**Test 10:** \`FicticioInexistente999ZZ\`. **50:** si existe ficha S02275 en \`data/productos-diseno-con-odoo.json\`, se señala si la respuesta alude a datos de diseño (productDesignDB hoy no se inyecta en el texto; puede dar WARN).

`;
  for (const mod of MODULE_ORDER) {
    propMd += `### ${mod}\n\n| # | Mensaje | Local | Prod | Notas |\n|---|---|---|---|---|\n`;
    for (const c of CASES.filter((x) => x.module === mod)) {
      const l = localP.find((r) => r.id === c.id);
      const p = prodP.find((r) => r.id === c.id);
      const msg = String(c.msg)
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      const follow = c.follow
        ? ` + 2.º: \`${String(c.follow).replace(/\|/g, "\\|")}\``
        : "";
      const iconL = l?.result === "PASS" ? "✅" : l?.result === "FAIL" ? "❌" : "⚠️";
      const iconP = p?.result === "PASS" ? "✅" : p?.result === "FAIL" ? "❌" : "⚠️";
      const notes = [l?.note, p?.note]
        .filter(Boolean)
        .join(" / ")
        .slice(0, 200);
      const shortMsg = msg.length > 100 ? msg.slice(0, 100) + "…" : msg;
      propMd += `| ${c.id} | \`${shortMsg}\`${follow} | ${iconL} | ${iconP} | ${notes} |\n`;
    }
    propMd += "\n";
  }
  propMd += `### Resumen — Propuestas
| | Local | Prod |
|---|---:|---:|
| PASS | ${sPL.pass} | ${sPP.pass} |
| WARN | ${sPL.warn} | ${sPP.warn} |
| FAIL | ${sPL.fail} | ${sPP.fail} |
| Promedio ms | ${sPL.avg} | ${sPP.avg} |
| Máx ms | ${sPL.max} | ${sPP.max} |

---

`;

  let md = readBaseInforme();
  if (!/## Resumen ejecutivo\n[\s\S]+## Resultados por módulo\n/.test(md)) {
    console.error("No se pudo reemplazar resumen: verificar estructura del informe");
    process.exit(1);
  }
  md = md.replace(/## Resumen ejecutivo\n[\s\S]+?(?=\n## Resultados por módulo\n)/, newResumen + "\n");

  if (md.includes("## Propuestas QA")) {
    md = md.replace(
      /## Propuestas QA\n[\s\S]*?(?=\n## (?:FAILs críticos|Diferencias LOCAL)|\n## FAILs críticos)/m,
      propMd
    );
  } else {
    const insert = md.indexOf("## FAILs críticos");
    if (insert > 0) {
      md = md.slice(0, insert) + "\n" + propMd + "\n" + md.slice(insert);
    } else {
      md += "\n" + propMd;
    }
  }

  const genLine = `_Generado/actualizado por \`run-qa-tests.mjs\` + \`run-qa-propuestas.mjs\` — heurístico. Revisar a mano criterios de productDesignDB y “datos inventados”._\n`;
  if (/_Generado.*run-qa-tests/.test(md)) {
    md = md.replace(
      /---\n[_`Generado/actualizado].*run-qa.*/m,
      `---\n${genLine}`
    );
  } else {
    md = md + `\n---\n${genLine}`;
  }

  fs.writeFileSync(INFORME, md, "utf8");
  console.log("Actualizado:", INFORME);
  console.log("Propuestas — Local:", sPL, "Prod:", sPP);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
