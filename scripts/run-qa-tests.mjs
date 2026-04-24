/**
 * QA runner: 50 tests x LOCAL + PROD → informe-qa-YYYY-MM-DD.md
 * Run: node scripts/run-qa-tests.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const LOCAL = "http://localhost:3000/api/agent";
const PROD = "https://asistente-facu.fly.dev/api/agent";

const DATE_STR = new Date().toISOString().slice(0, 10);

function hasDeliveryBugReply(reply) {
  const r = String(reply || "").toLowerCase();
  return (
    (r.includes("entreg") && r.includes("mercader")) ||
    r.includes("te entregó") ||
    r.includes("te entrego")
  );
}

function isClarificationForm(d) {
  return (
    d &&
    d.type === "clarification_form" &&
    Array.isArray(d.options) &&
    d.options.length >= 6
  );
}

/** @type {Array<{ id: number; msg: string; module: string; kind: string }>} */
const CASES = [
  { id: 1, msg: "me pagó holster 500k en banco", module: "PAGOS CLIENTE", kind: "pago_cliente" },
  { id: 2, msg: "calzon quitao me mandó 400k por mp", module: "PAGOS CLIENTE", kind: "pago_cliente" },
  { id: 3, msg: "me entró 200k de diegmarc en efectivo", module: "PAGOS CLIENTE", kind: "pago_cliente" },
  { id: 4, msg: "cobré 150k de versao por mercadopago", module: "PAGOS CLIENTE", kind: "pago_cliente" },
  { id: 5, msg: "me dio 80k jhonkey en efectivo", module: "PAGOS CLIENTE", kind: "pago_cliente" },
  { id: 6, msg: "pago", module: "PAGOS CLIENTE", kind: "ambiguo" },
  { id: 7, msg: "me pagó alguien", module: "PAGOS CLIENTE", kind: "falta_monto" },
  { id: 8, msg: "cobro de cliente sin nombre", module: "PAGOS CLIENTE", kind: "falta_nombre" },
  { id: 9, msg: "le pagué a carvi 200k en efectivo", module: "PAGOS PROVEEDOR", kind: "pago_prov" },
  { id: 10, msg: "le pague a omar 100k en mp", module: "PAGOS PROVEEDOR", kind: "pago_prov" },
  { id: 11, msg: "le mandé 300k a arslanian por banco", module: "PAGOS PROVEEDOR", kind: "pago_prov" },
  { id: 12, msg: "pagué a acuario 50k en efectivo", module: "PAGOS PROVEEDOR", kind: "pago_prov" },
  { id: 13, msg: "le transferí 180k a carvi por santander", module: "PAGOS PROVEEDOR", kind: "pago_prov" },
  { id: 14, msg: "le pague a alguien", module: "PAGOS PROVEEDOR", kind: "falta_datos" },
  { id: 15, msg: "pague a proveedor sin monto", module: "PAGOS PROVEEDOR", kind: "falta_monto" },
  { id: 16, msg: "carvi entregó de dafne", module: "RECEPCIONES", kind: "recepcion" },
  { id: 17, msg: "arslanian trajo los hang tag de buenos hijos", module: "RECEPCIONES", kind: "recepcion" },
  { id: 18, msg: "llegó mercadería de carvi para pierrs", module: "RECEPCIONES", kind: "recepcion" },
  { id: 19, msg: "recibí de acuario", module: "RECEPCIONES", kind: "recepcion" },
  { id: 20, msg: "carvi entregó", module: "RECEPCIONES", kind: "falta_cliente" },
  { id: 21, msg: "entregó mercadería", module: "RECEPCIONES", kind: "falta_ambos" },
  { id: 22, msg: "armá una cotización para holster", module: "VENTAS", kind: "ventas" },
  { id: 23, msg: "nueva OV para diegmarc", module: "VENTAS", kind: "ventas" },
  { id: 24, msg: "generá propuesta para pierrs", module: "VENTAS", kind: "ventas" },
  { id: 25, msg: "confirmá la OV de S02275", module: "VENTAS", kind: "ventas" },
  { id: 26, msg: "dejá nota en S02275: revisar colores", module: "VENTAS", kind: "ventas" },
  { id: 27, msg: "presupuesto para cliente nuevo", module: "VENTAS", kind: "ventas" },
  { id: 28, msg: "cuándo entrega carvi lo de pierrs", module: "COMPRAS", kind: "compras" },
  { id: 29, msg: "pedidos de arslanian", module: "COMPRAS", kind: "compras" },
  { id: 30, msg: "qué me debe carvi", module: "COMPRAS", kind: "compras" },
  { id: 31, msg: "postergá la entrega de P01234 para el 30/05", module: "COMPRAS", kind: "compras" },
  { id: 32, msg: "pedidos en producción de esta semana", module: "COMPRAS", kind: "compras" },
  { id: 33, msg: "pedidos en producción", module: "REPORTES", kind: "reportes" },
  { id: 34, msg: "cuentas a cobrar", module: "REPORTES", kind: "reportes" },
  { id: 35, msg: "caja de hoy", module: "REPORTES", kind: "reportes" },
  { id: 36, msg: "cuánto me debe holster", module: "REPORTES", kind: "reportes" },
  { id: 37, msg: "qué facturé este mes", module: "REPORTES", kind: "reportes" },
  { id: 38, msg: "resumen de caja de esta semana", module: "REPORTES", kind: "reportes" },
  { id: 39, msg: "carvi subió un 10%", module: "PRECIOS", kind: "precios" },
  { id: 40, msg: "los bordados aumentaron 500 pesos", module: "PRECIOS", kind: "precios" },
  { id: 41, msg: "actualizá el costo de arslanian 8%", module: "PRECIOS", kind: "precios" },
  { id: 42, msg: "subieron los hang tag 15%", module: "PRECIOS", kind: "precios" },
  { id: 43, msg: "necesito ver algo de la semana", module: "FALLBACK", kind: "fallback" },
  { id: 44, msg: "qué hago con esto", module: "FALLBACK", kind: "fallback" },
  { id: 45, msg: "ayuda", module: "FALLBACK", kind: "fallback" },
  { id: 46, msg: "hola", module: "FALLBACK", kind: "fallback" },
  { id: 47, msg: "no sé qué hacer", module: "FALLBACK", kind: "fallback" },
  { id: 48, msg: "", module: "EDGE", kind: "empty_400" },
  { id: 49, msg: "le pague a carvi 200k en efectivo", module: "EDGE", kind: "no_delivery_bug" },
  { id: 50, msg: "carvi entregó de dafne → sí confirmo (2 pasos)", module: "EDGE", kind: "recepcion_confirm" }
];

function evaluate(caseInfo, status, data, ms, reply) {
  const { id, kind } = caseInfo;
  let result = "PASS";
  let note = "";

  if (ms > 5000) {
    result = "WARN";
    note = (note ? note + "; " : "") + `latencia ${ms}ms > 5s`;
  }

  if (id === 48) {
    if (status !== 400) {
      result = "FAIL";
      note = `esperado HTTP 400, obtuvo ${status}`;
    }
    return { result, note };
  }

  if (status >= 500) {
    return { result: "FAIL", note: `HTTP ${status}` };
  }

  if (kind === "pago_cliente" || kind === "pago_prov" || kind === "no_delivery_bug") {
    if (hasDeliveryBugReply(reply)) {
      result = "FAIL";
      note = "pregunta por entrega/mercadería (bug)";
    }
  }

  if (kind === "fallback") {
    if (!isClarificationForm(data)) {
      const r = result === "WARN" ? "WARN" : "FAIL";
      result = r;
      note = (note ? note + "; " : "") + `esperado clarification_form (type + 6 opciones), obtuvo type=${data?.type || "none"}`;
    }
  }

  if (kind === "ambiguo") {
    const ok =
      isClarificationForm(data) ||
      /cobro|proveedor|cliente|medio|qué|aclara|opciones|pagos/i.test(reply) ||
      (Array.isArray(data?.options) && data.options.length > 0);
    if (!ok && result === "PASS") {
      result = "WARN";
      note = "ambiguo: no se detectó aclaración explícita";
    }
  }

  if (kind === "falta_monto" || kind === "falta_nombre" || kind === "falta_datos") {
    const asksSomething = /monto|quién|nombre|medio|proveedor|cuánto|decime/i.test(reply);
    if (!asksSomething && !isClarificationForm(data) && result === "PASS") {
      result = "WARN";
      note = "no se detectó pregunta por dato faltante";
    }
  }

  return { result, note };
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
      data: { error: String(e.message || e) },
      reply: "",
      err: String(e.message || e)
    };
  }
  const ms = Date.now() - t0;
  const reply = data?.reply ?? data?.message ?? text ?? "";
  return { ms, status, data, reply };
}

async function runAll(baseUrl, envLabel) {
  const results = [];
  for (const c of CASES) {
    if (c.id === 48) {
      const t0 = Date.now();
      let status = 0;
      let data = {};
      let reply = "";
      try {
        const res = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "", history: [] })
        });
        status = res.status;
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = { _raw: text };
        }
        reply = data?.error || data?.reply || text;
      } catch (e) {
        data = { error: String(e.message || e) };
      }
      const ms = Date.now() - t0;
      const ev = evaluate(c, status, data, ms, reply);
      results.push({ ...c, _env: envLabel, ms, status, reply: String(reply).slice(0, 400), data, ...ev });
      continue;
    }

    if (c.id === 50) {
      const r1 = await postAgent(baseUrl, { message: "carvi entregó de dafne", history: [] });
      const sid = r1.data?.sessionId;
      const r2 = sid
        ? await postAgent(baseUrl, { message: "sí confirmo", history: [], sessionId: sid })
        : { ms: 0, status: 0, data: {}, reply: "" };

      const note50 = `paso1 ${r1.status} action=${r1.data?.action}; paso2 ${r2.status} action=${r2.data?.action}`;
      let result50 = "PASS";
      let n50 = note50;
      if (r1.status >= 500 || (r2.status && r2.status >= 500)) {
        result50 = "FAIL";
        n50 += "; error HTTP";
      } else if (hasDeliveryBugReply(r1.reply)) {
        result50 = "FAIL";
        n50 += "; paso1 parece pago/recepción mezclado";
      } else if (r2.data?.action === "ejecutada" || r1.data?.action === "ejecutada") {
        result50 = "PASS";
      } else {
        result50 = "WARN";
        n50 += "; confirmación no ejecutó (pendiente/otra acción)";
      }
      if (r1.ms + r2.ms > 5000) {
        if (result50 === "PASS") result50 = "WARN";
        n50 += "; latencia total >5s";
      }

      results.push({
        ...c,
        _env: envLabel,
        ms: r1.ms + r2.ms,
        status: r2.status || r1.status,
        reply: `[1] ${String(r1.reply).slice(0, 220)} | [2] ${String(r2.reply).slice(0, 220)}`,
        data: r2.data,
        result: result50,
        note: n50
      });
      continue;
    }

    const { ms, status, data, reply, err } = await postAgent(baseUrl, { message: c.msg, history: [] });
    if (err) {
      results.push({
        ...c,
        _env: envLabel,
        ms,
        status,
        reply: err,
        data,
        result: "FAIL",
        note: `network: ${err}`
      });
      continue;
    }
    const ev = evaluate(c, status, data, ms, reply);
    results.push({ ...c, _env: envLabel, ms, status, reply: String(reply).slice(0, 500), data, ...ev });
  }
  return results;
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
  return {
    pass,
    fail,
    warn,
    avg: rows.length ? Math.round(latSum / rows.length) : 0,
    max: latMax
  };
}

function diffResults(local, prod) {
  const d = [];
  for (const a of local) {
    const b = prod.find((x) => x.id === a.id);
    if (!b) continue;
    if (a.result !== b.result || a.status !== b.status) {
      d.push({
        id: a.id,
        local: `${a.result} (${a.status})`,
        prod: `${b.result} (${b.status})`
      });
    }
  }
  return d;
}

async function main() {
  console.log("Running LOCAL...");
  const local = await runAll(LOCAL, "Local");
  console.log("Running PROD...");
  const prod = await runAll(PROD, "Prod");

  const sL = summarize(local);
  const sP = summarize(prod);
  const diffs = diffResults(local, prod);
  let md = `# Informe QA — Asistente Facu
Fecha: ${DATE_STR}
Local: http://localhost:3000
Prod: https://asistente-facu.fly.dev

## Resumen ejecutivo
| Métrica | Local | Prod |
|---|---|---|
| Total pruebas | 50 | 50 |
| PASS | ${sL.pass} | ${sP.pass} |
| FAIL | ${sL.fail} | ${sP.fail} |
| WARN | ${sL.warn} | ${sP.warn} |
| Latencia promedio | ${sL.avg}ms | ${sP.avg}ms |
| Latencia máxima | ${sL.max}ms | ${sP.max}ms |

## Resultados por módulo
`;

  const modules = [
    "PAGOS CLIENTE",
    "PAGOS PROVEEDOR",
    "RECEPCIONES",
    "VENTAS",
    "COMPRAS",
    "REPORTES",
    "PRECIOS",
    "FALLBACK",
    "EDGE"
  ];
  for (const mod of modules) {
    md += `### ${mod}\n\n`;
    md += "| # | Mensaje | Local | Prod | Notas |\n|---|---|---|---|---|\n";
    const ids = CASES.filter((c) => c.module === mod).map((c) => c.id);
    for (const id of ids) {
      const l = local.find((x) => x.id === id);
      const p = prod.find((x) => x.id === id);
      const msg = CASES.find((c) => c.id === id)?.msg?.replace(/\|/g, "\\|") || "";
      const iconL = l?.result === "PASS" ? "✅" : l?.result === "FAIL" ? "❌" : "⚠️";
      const iconP = p?.result === "PASS" ? "✅" : p?.result === "FAIL" ? "❌" : "⚠️";
      const notes = [l?.note, p?.note].filter(Boolean).join(" / ").slice(0, 120);
      md += `| ${id} | \`${msg.slice(0, 60)}${msg.length > 60 ? "…" : ""}\` | ${iconL} | ${iconP} | ${notes} |\n`;
    }
    md += "\n";
  }

  md += `## FAILs críticos\n\n`;
  const failRows = [...local, ...prod].filter((r) => r.result === "FAIL");
  if (!failRows.length) md += "_Ningún FAIL automático._\n\n";
  else {
    for (const r of failRows) {
      md += `- **#${r.id} [${r._env}]** ${r.module}: ${r.note}\n  - Respuesta (recorte): \`${String(r.reply).slice(0, 280).replace(/\n/g, " ")}\`\n`;
    }
  }

  md += `\n## Diferencias LOCAL vs PROD\n\n`;
  if (!diffs.length) md += "_Mismo resultado/status en ambas ejecuciones (según heurística)._";
  else {
    md += "| # | Local | Prod |\n|---|---|---|\n";
    for (const d of diffs) {
      md += `| ${d.id} | ${d.local} | ${d.prod} |\n`;
    }
  }

  md += `\n\n## Recomendaciones\n\n`;
  const recs = [];
  if (sL.fail + sP.fail > 0) recs.push("Revisar los FAILs listados: alinear prompts, validaciones o IntentRouter con el comportamiento esperado.");
  if (diffs.length) recs.push("Investigar divergencias Local vs Prod (versiones, secretos, cold start, rate limit Odoo/Groq).");
  if (sL.warn + sP.warn > 5) recs.push("Muchos WARN: afinar heurísticas de QA o suavizar criterios de negocio documentados.");
  recs.push("Mantener pruebas #49 (no regresión recepción vs pago) y #50 (confirmación) en CI.");
  recs.push("Monitorizar latencia >5s (Groq/Odoo) y reintentos/backoff en carga de OCs.");
  recs.push("Para FALLBACK (#43–47), validar que UNKNOWN siempre devuelve clarification_form sin pasar por consultas genéricas.");
  recs.slice(0, 5).forEach((r, i) => (md += `${i + 1}. ${r}\n`));

  md += `\n---\n_Generado por scripts/run-qa-tests.mjs — evaluación heurística; revisar manualmente los casos límite._\n`;

  const outPath = path.join(ROOT, `informe-qa-${DATE_STR}.md`);
  fs.writeFileSync(outPath, md, "utf8");
  console.log("Written:", outPath);
  return outPath;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
