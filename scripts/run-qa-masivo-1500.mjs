import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BASE_URL = process.env.QA_BASE_URL || "http://localhost:3000/api/agent";
const DATE_TAG = "2026-04-24";

const MODULE_TARGETS = [
  { key: "PAGOS CLIENTE", count: 260 },
  { key: "PAGOS PROVEEDOR", count: 220 },
  { key: "RECEPCIONES", count: 180 },
  { key: "VENTAS", count: 220 },
  { key: "COMPRAS", count: 180 },
  { key: "REPORTES", count: 220 },
  { key: "PRECIOS", count: 140 },
  { key: "FALLBACK/EDGE", count: 80 }
];

function chunk(arr, n) {
  return arr.slice(0, Math.max(1, n));
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function pick(arr, i) {
  return arr[i % arr.length];
}

async function rpc(service, method, args) {
  const url = String(process.env.ODOO_URL || "").replace(/\/$/, "") + "/jsonrpc";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() })
  });
  if (!r.ok) throw new Error(`ODOO HTTP ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error?.data?.message || data.error?.message || "ODOO error");
  return data.result;
}

async function fetchOdooSeeds() {
  const uid = await rpc("common", "authenticate", [
    process.env.ODOO_DB,
    process.env.ODOO_USERNAME,
    process.env.ODOO_API_KEY,
    {}
  ]);
  const customers = await rpc("object", "execute_kw", [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_API_KEY,
    "res.partner",
    "search_read",
    [[["customer_rank", ">", 0]]],
    { fields: ["id", "name"], limit: 80, order: "id desc" }
  ]);
  const suppliers = await rpc("object", "execute_kw", [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_API_KEY,
    "res.partner",
    "search_read",
    [[["supplier_rank", ">", 0]]],
    { fields: ["id", "name"], limit: 80, order: "id desc" }
  ]);
  const saleOrders = await rpc("object", "execute_kw", [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_API_KEY,
    "sale.order",
    "search_read",
    [[["name", "ilike", "S0"]]],
    { fields: ["id", "name"], limit: 80, order: "id desc" }
  ]);
  const purchaseOrders = await rpc("object", "execute_kw", [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_API_KEY,
    "purchase.order",
    "search_read",
    [[["name", "ilike", "P0"]]],
    { fields: ["id", "name"], limit: 80, order: "id desc" }
  ]);
  return {
    customers: customers.map((x) => cleanText(x.name)).filter(Boolean),
    suppliers: suppliers.map((x) => cleanText(x.name)).filter(Boolean),
    saleOrders: saleOrders.map((x) => cleanText(x.name)).filter(Boolean),
    purchaseOrders: purchaseOrders.map((x) => cleanText(x.name)).filter(Boolean)
  };
}

function makeCases(seeds) {
  const customers = seeds.customers.length ? seeds.customers : ["Cliente COMPLETAR"];
  const suppliers = seeds.suppliers.length ? seeds.suppliers : ["Proveedor COMPLETAR"];
  const sos = seeds.saleOrders.length ? seeds.saleOrders : ["S02275"];
  const pos = seeds.purchaseOrders.length ? seeds.purchaseOrders : ["P01234"];
  const amounts = [50000, 85000, 120000, 230000, 410000, 780000];
  const pct = [5, 8, 10, 12, 15];

  /** @type {Array<{module:string,input:string,expected:string,kind:string}>} */
  const cases = [];

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "PAGOS CLIENTE").count; i++) {
    const c = pick(customers, i);
    const a = amounts[i % amounts.length];
    const v = i % 4;
    const input =
      v === 0
        ? `me pagó ${c} ${a} en banco`
        : v === 1
          ? `entró plata de ${c} ${a} por mp`
          : v === 2
            ? `${c} mandó transferencia por ${a}`
            : `cobré a ${c} ${a} en efectivo`;
    cases.push({ module: "PAGOS CLIENTE", input, expected: "registrar pago cliente", kind: "txn" });
  }

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "PAGOS PROVEEDOR").count; i++) {
    const s = pick(suppliers, i);
    const a = amounts[(i + 2) % amounts.length];
    const v = i % 4;
    const input =
      v === 0
        ? `le pagué a ${s} ${a} en efectivo`
        : v === 1
          ? `mandé transferencia a ${s} por ${a}`
          : v === 2
            ? `pagamos a ${s} ${a} por santander`
            : `abonar ${a} a ${s} por mp`;
    cases.push({ module: "PAGOS PROVEEDOR", input, expected: "registrar pago proveedor", kind: "txn" });
  }

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "RECEPCIONES").count; i++) {
    const s = pick(suppliers, i);
    const c = pick(customers, i);
    const input =
      i % 4 === 0
        ? `llegó la mercadería de ${s} para ${c}`
        : i % 4 === 1
          ? `entró el pedido de ${s} para ${c}`
          : i % 4 === 2
            ? `recibí de proveedor ${s} para ${c}`
            : `llegó la OC de ${s} para ${c}`;
    cases.push({ module: "RECEPCIONES", input, expected: "registrar recepción", kind: "txn_or_flow" });
  }

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "VENTAS").count; i++) {
    const so = pick(sos, i);
    const c = pick(customers, i);
    const v = i % 4;
    const input =
      v === 0
        ? `confirmá la OV ${so}`
        : v === 1
          ? `dejá nota en ${so}: revisar colores`
          : v === 2
            ? `armá una cotización para ${c}`
            : `nueva OV para ${c}`;
    cases.push({ module: "VENTAS", input, expected: "flujo ventas correcto", kind: "mixed" });
  }

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "COMPRAS").count; i++) {
    const po = pick(pos, i);
    const s = pick(suppliers, i);
    const input =
      i % 4 === 0
        ? `cuándo entrega ${s} lo pendiente`
        : i % 4 === 1
          ? `pedidos de ${s}`
          : i % 4 === 2
            ? `qué me debe ${s}`
            : `postergá la entrega de ${po} para el 30/05`;
    cases.push({ module: "COMPRAS", input, expected: "consulta/acción compras correcta", kind: "mixed" });
  }

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "REPORTES").count; i++) {
    const c = pick(customers, i);
    const input =
      i % 4 === 0
        ? `cuánto vendí esta semana`
        : i % 4 === 1
          ? `ventas de la semana`
          : i % 4 === 2
            ? `qué debe ${c}`
            : `saldo de ${c}`;
    cases.push({ module: "REPORTES", input, expected: "reporte correcto", kind: "query" });
  }

  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "PRECIOS").count; i++) {
    const s = pick(suppliers, i);
    const p = pct[i % pct.length];
    const input =
      i % 3 === 0
        ? `${s} subió un ${p}%`
        : i % 3 === 1
          ? `actualizá el costo de ${s} ${p}%`
          : `subieron los precios ${p}%`;
    cases.push({ module: "PRECIOS", input, expected: "actualizar precios", kind: "txn_or_flow" });
  }

  const edgeTemplates = [
    { input: "", expected: "HTTP 400", kind: "edge_empty" },
    { input: "hola", expected: "clarification_form", kind: "fallback" },
    { input: "ayuda", expected: "clarification_form", kind: "fallback" },
    { input: "no sé qué hacer", expected: "clarification_form", kind: "fallback" },
    { input: "pago", expected: "aclaración", kind: "fallback" },
    { input: "le pague a alguien", expected: "pedir datos", kind: "fallback" },
    { input: "entregó mercadería", expected: "aclaración", kind: "fallback" }
  ];
  for (let i = 0; i < MODULE_TARGETS.find((m) => m.key === "FALLBACK/EDGE").count; i++) {
    const e = edgeTemplates[i % edgeTemplates.length];
    cases.push({ module: "FALLBACK/EDGE", input: e.input, expected: e.expected, kind: e.kind });
  }

  return chunk(cases, 1500);
}

function evaluateCase(c, httpStatus, data, ms) {
  const reply = cleanText(data?.reply || data?.message || data?.error || "");
  let status = "PASS";
  let reason = "";
  const action = data?.action || "";
  const isClar = data?.type === "clarification_form" || /opciones|no entend/i.test(reply);

  if (httpStatus >= 500 || httpStatus === 0) return { status: "FAIL", reason: `HTTP ${httpStatus}`, reply };

  if (c.kind === "edge_empty") {
    if (httpStatus !== 400) return { status: "FAIL", reason: `esperado 400, obtuvo ${httpStatus}`, reply };
    return { status: "PASS", reason: "", reply };
  }

  if (c.kind === "fallback") {
    if (!isClar) return { status: "FAIL", reason: "no devolvió aclaración/fallback esperado", reply };
    if (ms > 10000) return { status: "WARN", reason: `latencia ${ms}ms > 10s`, reply };
    return { status: "PASS", reason: "", reply };
  }

  if (c.kind === "txn") {
    if (!(action === "ejecutada" || /listo|registr|hecho|confirm/i.test(reply))) {
      status = "FAIL";
      reason = "no ejecutó acción transaccional esperada";
    }
  } else if (c.kind === "txn_or_flow") {
    if (!(action === "ejecutada" || action === "pregunta" || action === "consulta")) {
      status = "FAIL";
      reason = "acción no manejada";
    }
  } else if (c.kind === "query" || c.kind === "mixed") {
    if (!reply) {
      status = "FAIL";
      reason = "respuesta vacía";
    }
  }

  if (status === "PASS" && ms > 10000) {
    status = "WARN";
    reason = `latencia ${ms}ms > 10s`;
  }
  if (status === "PASS" && (!reply || reply.length < 4)) {
    status = "WARN";
    reason = "respuesta demasiado corta";
  }
  return { status, reason, reply };
}

async function postAgent(message) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: [] })
    });
    const text = await r.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
    return { ms: Date.now() - t0, status: r.status, data };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, data: { error: String(e.message || e) } };
  }
}

function summarizeByModule(rows) {
  const out = {};
  for (const m of MODULE_TARGETS.map((x) => x.key)) {
    const subset = rows.filter((r) => r.module === m);
    const pass = subset.filter((r) => r.result === "PASS").length;
    const fail = subset.filter((r) => r.result === "FAIL").length;
    const warn = subset.filter((r) => r.result === "WARN").length;
    const avg = subset.length ? Math.round(subset.reduce((a, b) => a + b.ms, 0) / subset.length) : 0;
    const max = subset.length ? Math.max(...subset.map((x) => x.ms)) : 0;
    out[m] = { total: subset.length, pass, fail, warn, avg, max };
  }
  return out;
}

function buildMassiveReport(rows, summary) {
  let md = `# QA masivo 1500 — ${DATE_TAG}
\nBase URL: ${BASE_URL}
\nTotal casos ejecutados: ${rows.length}
\n\n## Resumen por módulo
\n| Módulo | Total | PASS | FAIL | WARN | Latencia prom. | Latencia máx. |
\n|---|---:|---:|---:|---:|---:|---:|
`;
  for (const m of Object.keys(summary)) {
    const s = summary[m];
    md += `| ${m} | ${s.total} | ${s.pass} | ${s.fail} | ${s.warn} | ${s.avg}ms | ${s.max}ms |\n`;
  }
  md += `\n## FAILs detallados\n\n`;
  const fails = rows.filter((r) => r.result === "FAIL");
  if (!fails.length) {
    md += `_No se detectaron FAIL._\n`;
  } else {
    md += "| Módulo | Input exacto | Respuesta del agente | Respuesta esperada |\n|---|---|---|---|\n";
    for (const f of fails) {
      md += `| ${f.module} | \`${String(f.input).replace(/\|/g, "\\|")}\` | \`${String(f.reply || "").slice(0, 180).replace(/\|/g, "\\|")}\` | ${f.expected} |\n`;
    }
  }
  return md;
}

function buildReeducacion(rows) {
  const fails = rows.filter((r) => r.result === "FAIL");
  const byPattern = {
    "No ejecuta acción transaccional": fails.filter((f) => /transaccional|no ejecutó/i.test(f.reason)),
    "Fallback insuficiente o ambiguo": fails.filter((f) => /aclaración|fallback/i.test(f.reason)),
    "Errores de disponibilidad/red": fails.filter((f) => /HTTP 0|HTTP 5/i.test(f.reason) || /fetch failed/i.test(f.reply || ""))
  };
  let md = `# Reeducación LLM — ${DATE_TAG}
\nObjetivo: corregir patrones recurrentes de FAIL con cambios de prompt en \`buildAgentSystemPrompt()\`.
\n`;
  for (const [title, list] of Object.entries(byPattern)) {
    if (!list.length) continue;
    const ex = list.slice(0, 5).map((x) => `- ${x.input}`).join("\n");
    let expected = "";
    let promptPatch = "";
    if (title === "No ejecuta acción transaccional") {
      expected = "Cuando el input trae entidad + monto + medio, priorizar ejecución y confirmar operación en lenguaje breve.";
      promptPatch = `Cuando detectes intención de pago/cobro con monto y contraparte explícitos, debés priorizar acción ejecutable y devolver confirmación clara de ejecución. No redirigir a explicación general si ya están los datos mínimos.`;
    } else if (title === "Fallback insuficiente o ambiguo") {
      expected = "Si faltan campos críticos, pedir exactamente los faltantes y ofrecer opciones cerradas.";
      promptPatch = `Si la intención es ambigua o incompleta, devolver SIEMPRE una aclaración estructurada con 3-6 opciones concretas y pedir solo los campos faltantes (monto, contraparte, medio, fecha).`;
    } else {
      expected = "Ante fallas externas, degradar con mensaje claro y sugerir reintento sin inventar estado.";
      promptPatch = `Si hay error de red/servicio externo (ODOO/Groq), responder con estado de fallo controlado, sin suponer ejecución, y sugerir reintento con contexto preservado.`;
    }
    md += `\n## ${title}\n`;
    md += `- **Descripción del problema:** ${title} en flujos masivos.\n`;
    md += `- **Ejemplos de inputs que fallan:**\n${ex}\n`;
    md += `- **Corrección esperada:** ${expected}\n`;
    md += `- **Fragmento a modificar en buildAgentSystemPrompt():**\n\n\`\`\`\n${promptPatch}\n\`\`\`\n`;
  }
  if (!fails.length) {
    md += `\nNo hubo FAIL en esta corrida; reforzar prompt para bajar WARN de latencia y confirmación multi-turno.\n`;
  }
  return md;
}

function buildEstadoProduccion(summary) {
  const risk = [];
  const stable = [];
  const conf = {};
  let totalFail = 0;
  for (const [m, s] of Object.entries(summary)) {
    totalFail += s.fail;
    const confidence = Math.max(0, Math.min(100, Math.round(((s.pass + s.warn * 0.5) / Math.max(1, s.total)) * 100)));
    conf[m] = confidence;
    if (s.fail === 0 && confidence >= 90) stable.push(m);
    else risk.push(m);
  }
  const ready = totalFail === 0 ? "SI (con monitoreo)" : "NO";
  return `# Estado de producción — ${DATE_TAG}

## Resumen ejecutivo
- **Sistema listo para usuarios:** ${ready}
- **Módulos 100% estables:** ${stable.length ? stable.join(", ") : "Ninguno"}
- **Módulos con riesgo:** ${risk.length ? risk.join(", ") : "Ninguno"}
- **3 acciones prioritarias antes de lanzar:**
  1. Bajar latencia >10s con retry/backoff y circuit breaker en integraciones externas.
  2. Endurecer prompt para confirmaciones multi-turno (pagos/recepciones ambiguas).
  3. Añadir validaciones previas de campos críticos y respuesta guiada por faltantes.

## Estimación de confianza por módulo (0-100%)
${Object.entries(conf)
  .map(([k, v]) => `- ${k}: ${v}%`)
  .join("\n")}
`;
}

async function main() {
  const seeds = await fetchOdooSeeds();
  const cases = makeCases(seeds);
  const rows = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const reqMsg = c.input;
    const { ms, status, data } = await postAgent(reqMsg);
    const ev = evaluateCase(c, status, data, ms);
    rows.push({
      idx: i + 1,
      module: c.module,
      input: reqMsg,
      expected: c.expected,
      ms,
      httpStatus: status,
      result: ev.status,
      reason: ev.reason,
      reply: ev.reply
    });
    if ((i + 1) % 100 === 0) {
      console.log(`QA masivo: ${i + 1}/${cases.length}`);
    }
  }

  const summary = summarizeByModule(rows);
  const md1 = buildMassiveReport(rows, summary);
  const md2 = buildReeducacion(rows);
  const md3 = buildEstadoProduccion(summary);

  const out1 = path.join(ROOT, "informes", `qa-masivo-1500-${DATE_TAG}.md`);
  const out2 = path.join(ROOT, "informes", `reeducacion-llm-${DATE_TAG}.md`);
  const out3 = path.join(ROOT, "informes", `estado-produccion-${DATE_TAG}.md`);
  fs.mkdirSync(path.dirname(out1), { recursive: true });
  fs.writeFileSync(out1, md1, "utf8");
  fs.writeFileSync(out2, md2, "utf8");
  fs.writeFileSync(out3, md3, "utf8");
  console.log("OUTPUT_1", out1);
  console.log("OUTPUT_2", out2);
  console.log("OUTPUT_3", out3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
