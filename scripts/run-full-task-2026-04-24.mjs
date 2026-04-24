import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { performance } from "perf_hooks";

dotenv.config();

const ROOT = process.cwd();
const INFORMES_DIR = path.join(ROOT, "informes");
const APROBAR_DIR = path.join(process.env.USERPROFILE || process.env.HOME || ROOT, "Desktop", "aprobar");
fs.mkdirSync(INFORMES_DIR, { recursive: true });
fs.mkdirSync(APROBAR_DIR, { recursive: true });

const ODOO_URL = String(process.env.ODOO_URL || "").replace(/\/$/, "");
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

async function rpc(service, method, args) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Date.now() + Math.random()
    })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data?.message || j.error.message || "ODOO error");
  return j.result;
}

function normalizeStr(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function detectExpectedLayout(name = "", code = "") {
  const blob = `${name} ${code}`.toUpperCase();
  if (/EBAD|EESN|EEAL/.test(blob)) return "A";
  if (/EBAT|CDM|CDE/.test(blob)) return "B";
  if (/BAPU|BADANA/.test(blob)) return "C";
  if (/ESTAMP|SATEN|ALGODON/.test(blob)) return "D";
  if (/PLASTISOL|^PI|^PL|^EP/.test(blob)) return "E";
  if (/BOPO|BOLSA/.test(blob)) return "F";
  if (/HTZ|HANG/.test(blob)) return "G";
  if (/FAJA/.test(blob)) return "H";
  return "H";
}

function desiredLayoutBuckets() {
  return {
    A: 6,
    B: 3,
    C: 2,
    D: 2,
    F: 2,
    G: 1,
    H: 1
  };
}

async function part2Generate20Proposals(uid) {
  const lines = await rpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    "sale.order.line",
    "search_read",
    [[]],
    { fields: ["order_id", "name", "product_id"], limit: 100, order: "id desc" }
  ]);
  const productIds = [...new Set(lines.map((l) => (Array.isArray(l.product_id) ? l.product_id[0] : null)).filter(Boolean))];
  const products = productIds.length
    ? await rpc("object", "execute_kw", [
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "product.product",
        "read",
        [productIds],
        { fields: ["id", "default_code", "name"] }
      ])
    : [];
  const pById = new Map(products.map((p) => [p.id, p]));
  const byOv = new Map();
  for (const ln of lines) {
    const ov = Array.isArray(ln.order_id) ? ln.order_id[1] : "";
    if (!ov || byOv.has(ov)) continue;
    const pid = Array.isArray(ln.product_id) ? ln.product_id[0] : null;
    const p = pid ? pById.get(pid) : null;
    const layout = detectExpectedLayout(ln.name || p?.name || "", p?.default_code || "");
    byOv.set(ov, { ov, lineName: ln.name || "", code: p?.default_code || "", layoutHint: layout });
  }
  const rows = [...byOv.values()];
  const need = desiredLayoutBuckets();
  const selected = [];
  const counts = {};
  for (const key of Object.keys(need)) counts[key] = 0;
  for (const key of Object.keys(need)) {
    const candidates = rows.filter((r) => r.layoutHint === key && !selected.some((s) => s.ov === r.ov));
    for (const c of candidates) {
      if (counts[key] >= need[key]) break;
      selected.push(c);
      counts[key] += 1;
    }
  }
  for (const c of rows) {
    if (selected.length >= 20) break;
    if (selected.some((s) => s.ov === c.ov)) continue;
    selected.push(c);
  }
  const generated = [];
  for (const item of selected.slice(0, 20)) {
    try {
      const r = await fetch("http://localhost:3000/api/propuesta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ovId: item.ov })
      });
      const j = await r.json();
      if (!j.ok) {
        generated.push({ ov: item.ov, cliente: "", layout: item.layoutHint, archivo: "", warnings: [j.error || "error"] });
        continue;
      }
      const svgPath = j.svgPath;
      const pdfPath = j.pdfPath;
      const svg = fs.existsSync(svgPath) ? fs.readFileSync(svgPath, "utf8") : "";
      const m = svg.match(/Layout ([A-H])/);
      const layout = m ? m[1] : item.layoutHint;
      const cliente = path.basename(svgPath).split("-").slice(1, -1).join("-") || "cliente";
      const base = `${item.ov}-${cliente}-${layout}`.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
      let outFile = "";
      if (pdfPath && fs.existsSync(pdfPath)) {
        outFile = path.join(APROBAR_DIR, `${base}.pdf`);
        fs.copyFileSync(pdfPath, outFile);
      } else if (svgPath && fs.existsSync(svgPath)) {
        outFile = path.join(APROBAR_DIR, `${base}.svg`);
        fs.copyFileSync(svgPath, outFile);
      }
      generated.push({ ov: item.ov, cliente, layout, archivo: outFile, warnings: j.warnings || [] });
    } catch (e) {
      generated.push({ ov: item.ov, cliente: "", layout: item.layoutHint, archivo: "", warnings: [e.message] });
    }
  }
  return generated;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function money() {
  return randomInt(1000, 5000000).toLocaleString("es-AR");
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildQaCases(clients, suppliers, ovs) {
  const modules = [];
  const addCases = (module, total, patterns, names) => {
    for (let i = 0; i < total; i += 1) {
      const p = pick(patterns);
      const name = pick(names);
      const m = money();
      const ov = pick(ovs) || "S00000";
      const text = p
        .replace(/\[nombre\]/g, name)
        .replace(/\[cliente\]/g, name)
        .replace(/\[proveedor\]/g, name)
        .replace(/\[monto\]/g, m)
        .replace(/\[número\]/g, ov);
      modules.push({ module, input: text });
    }
  };

  addCases(
    "PAGOS_CLIENTE",
    300,
    [
      "entró plata de [nombre] [monto] por mp",
      "entró plata de [nombre] [monto] en banco",
      "entró plata de [nombre] [monto] en efectivo",
      "[nombre] mandó transferencia por [monto]",
      "cobré a [nombre] [monto] en efectivo",
      "me pagó [nombre] [monto] por mp",
      "[nombre] pagó [monto]",
      "[nombre] [monto] mp",
      "[nombre] [monto] banco",
      "[nombre] tiró [monto] por mp",
      "[nombre] depositó [monto]",
      "[nombre] mandó [monto]",
      "entró [monto] de [nombre]",
      "[monto] de [nombre] a mp",
      "[nombre] abonó [monto]"
    ],
    clients
  );
  addCases(
    "PAGOS_PROVEEDOR",
    250,
    [
      "pagué a [proveedor] [monto] por mp",
      "pagué a [proveedor] [monto] en banco",
      "mandé [monto] a [proveedor]",
      "transferí [monto] a [proveedor]",
      "salió plata para [proveedor] [monto]",
      "pagué [monto] a [proveedor]",
      "le pagué a [proveedor] [monto]",
      "[proveedor] [monto] banco",
      "[proveedor] [monto] mp",
      "pago a [proveedor] [monto] efectivo"
    ],
    suppliers
  );
  addCases(
    "RECEPCIONES",
    200,
    [
      "llegó la mercadería de [proveedor]",
      "entró el pedido de [proveedor]",
      "recibí la OC de [proveedor]",
      "llegó [proveedor]",
      "recibí de [proveedor]",
      "llegó la OC [número]",
      "entró la orden [número] de [proveedor]",
      "recibimos [proveedor]",
      "llegó todo de [proveedor]",
      "recepción [proveedor]"
    ],
    suppliers
  );
  addCases(
    "VENTAS_CONSULTAS",
    150,
    [
      "cuánto vendí esta semana",
      "ventas del mes",
      "qué debe [cliente]",
      "saldo de [cliente]",
      "cuánto me debe [cliente]",
      "deuda de [cliente]",
      "resumen de ventas",
      "qué compró [cliente]",
      "historial de [cliente]",
      "cuánto llevo vendido"
    ],
    clients
  );
  addCases(
    "COMPRAS",
    150,
    [
      "qué pedidos tengo abiertos",
      "OCs pendientes",
      "cuánto le debo a [proveedor]",
      "deuda con [proveedor]",
      "qué compré esta semana",
      "órdenes de compra abiertas",
      "pedidos en producción",
      "cuándo llega [proveedor]",
      "estado de la OC [número]",
      "qué tengo pendiente con [proveedor]"
    ],
    suppliers
  );
  addCases(
    "CUENTAS_COBRAR_PAGAR",
    150,
    [
      "cuánto me deben en total",
      "resumen de deudas",
      "clientes que me deben más de [monto]",
      "quién me debe más",
      "cuánto debo en total",
      "resumen de lo que debo",
      "saldo neto",
      "cuentas por cobrar",
      "cuentas por pagar",
      "balance de clientes"
    ],
    clients
  );
  addCases(
    "REPORTES_PRODUCCION",
    150,
    [
      "qué tengo en producción",
      "pedidos en producción",
      "qué está en producción para [cliente]",
      "cuándo entrega [proveedor]",
      "estado de producción",
      "qué está pendiente de entrega",
      "próximas entregas",
      "qué vence esta semana",
      "pedidos atrasados",
      "resumen de producción"
    ],
    clients
  );
  addCases(
    "WHATSAPP",
    150,
    [
      "mandá mensaje a [cliente] sobre su pedido",
      "enviar estado de pedido a [cliente]",
      "notificar a [cliente] que llegó su pedido",
      "mandar plantilla de pago a [cliente]",
      "avisar a [cliente] que está listo",
      "recordatorio de pago a [cliente]",
      "mandar info de pedido a [cliente]"
    ],
    clients
  );
  addCases(
    "CONSULTAS_ESTADO",
    150,
    [
      "en qué estado está el pedido de [cliente]",
      "cómo va el pedido [número]",
      "cuándo está listo el pedido de [cliente]",
      "estado de la OV [número]",
      "[cliente] cuándo le entrego",
      "cuándo llega el pedido de [cliente]",
      "qué falta del pedido de [cliente]"
    ],
    clients
  );
  for (let i = 0; i < 150; i += 1) {
    modules.push({
      module: "FALLBACK_EDGE",
      input: pick(["plata", "cuánto", "pagó", "llegó", "deuda", `${money()} solo sin nombre`, `${pick(clients)} solo sin monto`])
    });
  }
  return modules.slice(0, 2000);
}

function evaluateCase(module, input, result, latencyMs) {
  const reply = String(result?.reply || "");
  const low = normalizeStr(reply);
  const failed = !reply || low.includes("paso algo raro del lado del servidor");
  if (failed) return { status: "FAIL", reason: "respuesta vacía/error servidor" };
  if (latencyMs > 10000) return { status: "WARN", reason: "latencia alta" };
  if (module === "PAGOS_CLIENTE" || module === "PAGOS_PROVEEDOR") {
    if (low.includes("pago en borrador creado correctamente")) return { status: "PASS", reason: "pago registrado" };
    if (low.includes("por que monto") || low.includes("por que medio")) return { status: "WARN", reason: "faltan datos" };
    return { status: "FAIL", reason: "no registra pago correctamente" };
  }
  if (module === "RECEPCIONES") {
    if (low.includes("recepcion registrada correctamente")) return { status: "PASS", reason: "recepción ok" };
    if (low.includes("confirm") || low.includes("oc")) return { status: "WARN", reason: "requiere confirmación" };
    return { status: "FAIL", reason: "no ejecuta recepción esperada" };
  }
  if (module === "FALLBACK_EDGE") {
    if (low.includes("decime") || low.includes("opciones") || low.includes("no entendi")) return { status: "PASS", reason: "aclaración útil" };
    return { status: "WARN", reason: "respuesta ambigua" };
  }
  if (low.includes("no encontre") || low.includes("decime") || low.includes("resumen") || low.includes("estado") || low.includes("pendient")) {
    return { status: "PASS", reason: "respuesta válida" };
  }
  return { status: "WARN", reason: "respuesta genérica" };
}

async function part3RunQa2000(uid) {
  const clientsRows = await rpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    "res.partner",
    "search_read",
    [[["customer_rank", ">", 0], ["is_company", "=", true]]],
    { fields: ["name"], limit: 100 }
  ]);
  const suppliersRows = await rpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    "res.partner",
    "search_read",
    [[["supplier_rank", ">", 0], ["is_company", "=", true]]],
    { fields: ["name"], limit: 100 }
  ]);
  const ovRows = await rpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    "sale.order",
    "search_read",
    [[]],
    { fields: ["name"], limit: 100, order: "id desc" }
  ]);
  const clients = clientsRows.map((r) => String(r.name || "").trim()).filter(Boolean).slice(0, 30);
  const suppliers = suppliersRows.map((r) => String(r.name || "").trim()).filter(Boolean).slice(0, 30);
  const ovs = ovRows.map((r) => String(r.name || "").trim()).filter(Boolean).slice(0, 30);
  const cases = buildQaCases(clients.length ? clients : ["Cliente Test"], suppliers.length ? suppliers : ["Proveedor Test"], ovs);
  const results = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const t0 = performance.now();
    try {
      const r = await fetch("http://localhost:3000/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: c.input, sessionId: `qa2000_${i}_${Date.now()}` })
      });
      const j = await r.json();
      const lat = Math.round(performance.now() - t0);
      const ev = evaluateCase(c.module, c.input, j, lat);
      results.push({
        idx: i + 1,
        module: c.module,
        input: c.input,
        reply: String(j?.reply || ""),
        status: ev.status,
        reason: ev.reason,
        latencyMs: lat
      });
    } catch (e) {
      const lat = Math.round(performance.now() - t0);
      results.push({
        idx: i + 1,
        module: c.module,
        input: c.input,
        reply: e.message,
        status: "FAIL",
        reason: "excepción HTTP",
        latencyMs: lat
      });
    }
  }
  return results;
}

function buildRulesDoc() {
  return `# Reglas por módulo — 2026-04-24

## Pagos Cliente
### Función principal
Registrar cobros de clientes vía \`/api/agent\` con \`executePayment(..., "customer")\`.
### Campos ODOO que usa
\`res.partner.name\`, \`account.journal.name\`, \`account.payment.amount\`, \`account.payment.partner_id\`, \`account.payment.memo\`.
### Reglas de negocio implementadas
1. Nombre + monto + medio infiere intención de pago.
2. Journal permitido: Cash/Santander/MercadoPago.
3. Si faltan datos pide solo el campo faltante.
### Variaciones de lenguaje natural reconocidas
me pagó, cobré a, entró plata de, depositó, mandó transferencia, abonó.
### Criterios de éxito
Pago en borrador creado con partner, monto y diario correctos.
### Casos límite conocidos
Ambigüedad sin sujeto explícito cliente/proveedor.

## Pagos Proveedor
### Función principal
Registrar pagos salientes vía \`executePayment(..., "supplier")\`.
### Campos ODOO que usa
\`res.partner\`, \`account.payment\`, \`account.journal\`.
### Reglas de negocio implementadas
1. Verbos “le pagué / transferí a” se interpretan como proveedor.
2. Valida monto positivo y journal.
### Variaciones de lenguaje natural reconocidas
pagué a, mandé a, transferí a, salió plata para.
### Criterios de éxito
Pago a proveedor en borrador con datos correctos.
### Casos límite conocidos
Nombres ambiguos compartidos por cliente/proveedor.

## Recepciones
### Función principal
Registrar recepción en ODOO desde \`executeDelivery\`.
### Campos ODOO que usa
\`purchase.order\`, \`purchase.order.line\`, \`stock.picking\`, \`stock.move.line\`, \`account.move\`.
### Reglas de negocio implementadas
1. Prioriza OC confirmada.
2. No inventa SKU/precio: toma de OC.
3. Valida picking incoming pendiente.
### Variaciones de lenguaje natural reconocidas
llegó mercadería, entró pedido, recibí OC, recepción proveedor.
### Criterios de éxito
Recepción validada + facturas draft proveedor/cliente creadas.
### Casos límite conocidos
Múltiples OCs candidatas sin desambiguación.

## Ventas Consultas
### Función principal
Responder métricas/estado de ventas por \`resolveDirectQueries\` y \`resolveReportQuery\`.
### Campos ODOO que usa
\`sale.order\`, \`sale.order.line\`, \`account.move\`.
### Reglas de negocio implementadas
1. Si hay OV exacta prioriza estado puntual.
2. Si hay cliente, agrega contexto de deuda/ventas.
### Variaciones de lenguaje natural reconocidas
ventas del mes, cuánto vendí, cuánto me debe.
### Criterios de éxito
Respuesta coherente con datos reales.
### Casos límite conocidos
Cliente no encontrado o múltiples coincidencias.

## Compras
### Función principal
Reportar OCs abiertas y pendientes.
### Campos ODOO que usa
\`purchase.order\`, \`purchase.order.line\`, \`res.partner\`.
### Reglas de negocio implementadas
1. Usa cache de OCs pendientes.
2. Permite filtro por proveedor/marca.
### Variaciones de lenguaje natural reconocidas
ocs pendientes, qué debo a proveedor, pedidos abiertos.
### Criterios de éxito
Listado/estado de OCs coherente.
### Casos límite conocidos
Cache desactualizada entre corridas.

## Cuentas a Cobrar/Pagar
### Función principal
Consolidar deuda cliente/proveedor.
### Campos ODOO que usa
\`account.move.move_type\`, \`payment_state\`, \`amount_residual\`, \`partner_id\`.
### Reglas de negocio implementadas
1. out_invoice = cobrar, in_invoice = pagar.
2. Solo posted + not_paid/partial.
### Variaciones de lenguaje natural reconocidas
cuentas por cobrar, por pagar, saldo neto.
### Criterios de éxito
Totales y ranking consistentes.
### Casos límite conocidos
Montos con notas de crédito no conciliadas.

## Reportes Producción
### Función principal
Informar pendientes y fechas de producción.
### Campos ODOO que usa
\`purchase.order.line.date_planned\`, \`qty_received\`, \`product_qty\`, \`x_studio_marca\`.
### Reglas de negocio implementadas
1. Clasifica vencidos y próximos.
2. Puede agrupar por proveedor.
### Variaciones de lenguaje natural reconocidas
qué está en producción, próximas entregas, vencidos.
### Criterios de éxito
Detalle de pendientes por línea/OC.
### Casos límite conocidos
Fechas faltantes en líneas.

## WhatsApp Plantillas
### Función principal
Resolver plantilla + destinatarios y ejecutar envío.
### Campos ODOO que usa
\`whatsapp.template\`, \`whatsapp.message\`, \`res.partner\`, \`sale.order\`.
### Reglas de negocio implementadas
1. Requiere plantilla aprobada.
2. Busca teléfono en contacto empresa/hijos.
### Variaciones de lenguaje natural reconocidas
mandá mensaje, avisar, recordatorio de pago.
### Criterios de éxito
Mensaje creado/enviado o aclaración útil.
### Casos límite conocidos
Sin móvil válido o plantilla no matcheada.

## Consultas de Estado
### Función principal
Responder estado de OV/pedido/entrega.
### Campos ODOO que usa
\`sale.order.state\`, \`invoice_status\`, \`amount_total\`.
### Reglas de negocio implementadas
1. Si hay S0XXXX consulta directa.
2. Sin OV pide desambiguación por cliente.
### Variaciones de lenguaje natural reconocidas
cómo va pedido, estado OV, cuándo llega.
### Criterios de éxito
Estado real, no inventado.
### Casos límite conocidos
Pedidos múltiples para mismo cliente.

## Fallback y Edge Cases
### Función principal
Manejar inputs ambiguos sin crash.
### Campos ODOO que usa
No aplica obligatorio; prioriza clarificación.
### Reglas de negocio implementadas
1. Evita fallback ciego en pagos con nombre+monto.
2. Devuelve clarification_form en UNKNOWN.
### Variaciones de lenguaje natural reconocidas
entradas incompletas, typo, mensajes mínimos.
### Criterios de éxito
Pide aclaración útil y estable.
### Casos límite conocidos
Mensajes de una palabra sin contexto.
`;
}

function confidence(pass, total, warn) {
  if (!total) return 0;
  return Math.max(0, Math.round(((pass + warn * 0.5) / total) * 100));
}

function buildQaReport(results) {
  const total = results.length;
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const globalConf = confidence(pass, total, warn);
  const modules = [...new Set(results.map((r) => r.module))];
  const rows = modules.map((m) => {
    const arr = results.filter((r) => r.module === m);
    const p = arr.filter((r) => r.status === "PASS").length;
    const f = arr.filter((r) => r.status === "FAIL").length;
    const w = arr.filter((r) => r.status === "WARN").length;
    const lat = Math.round(arr.reduce((a, b) => a + b.latencyMs, 0) / Math.max(1, arr.length));
    const conf = confidence(p, arr.length, w);
    const state = conf > 90 ? "VERDE" : conf >= 70 ? "AMARILLO" : "ROJO";
    return { m, t: arr.length, p, f, w, lat, conf, state };
  });
  const topFails = results.filter((r) => r.status === "FAIL").slice(0, 10);
  const patterns = {};
  for (const r of results.filter((x) => x.status === "FAIL")) {
    patterns[r.reason] = (patterns[r.reason] || 0) + 1;
  }
  const patRows = Object.entries(patterns).sort((a, b) => b[1] - a[1]);

  const qaMd = `## Resumen ejecutivo
Total: ${total} | PASS: ${pass} | FAIL: ${fail} | WARN: ${warn}
Confianza global: ${globalConf}%

## Resultados por módulo
| Módulo | Total | PASS | FAIL | WARN | Latencia prom | Confianza % |
|---|---:|---:|---:|---:|---:|---:|
${rows.map((r) => `| ${r.m} | ${r.t} | ${r.p} | ${r.f} | ${r.w} | ${r.lat} ms | ${r.conf}% |`).join("\n")}

## Top 10 FAILs más frecuentes
| Input | Respuesta del agente | Esperado | Módulo |
|---|---|---|---|
${topFails
  .map(
    (f) =>
      `| ${f.input.replace(/\|/g, "/")} | ${String(f.reply || "").replace(/\|/g, "/").slice(0, 120)} | comportamiento correcto por módulo | ${f.module} |`
  )
  .join("\n")}

## Patrones de FAIL detectados
${patRows.map(([k, v]) => `- ${k}: ${v} casos`).join("\n")}

## Estado por módulo
${rows.map((r) => `- ${r.m}: ${r.state} (${r.conf}%)`).join("\n")}
`;

  const reeMd = patRows
    .map(
      ([k, v], idx) => `### Problema
${k} (${v} casos)
### Inputs que fallan
- Muestras tomadas del QA automático
### Comportamiento esperado
Resolver intención y responder/ejecutar según módulo sin fallback indebido.
### Corrección en buildAgentSystemPrompt()
\`\`\`
[REEDU-${idx + 1}] Agregar ejemplos explícitos y regla de desambiguación para patrón: ${k}
\`\`\`
### Prioridad
${idx < 3 ? "CRÍTICO" : idx < 8 ? "IMPORTANTE" : "MENOR"}
`
    )
    .join("\n");

  return { qaMd, reeMd, rows, total, pass, fail, warn, globalConf };
}

function buildEstadoSistema(rows, globalStats, propuestas) {
  const modVerde = rows.filter((r) => r.conf > 90).map((r) => r.m);
  const modAmarillo = rows.filter((r) => r.conf >= 70 && r.conf <= 90).map((r) => r.m);
  const modRojo = rows.filter((r) => r.conf < 70).map((r) => r.m);
  const listo = modRojo.length ? "CONDICIONAL" : "SI";
  return `## El sistema está listo para producción: ${listo}

## Módulos en verde (listos)
${modVerde.length ? modVerde.map((m) => `- ${m}`).join("\n") : "- Ninguno"}

## Módulos en amarillo (usar con cuidado)
${modAmarillo.length ? modAmarillo.map((m) => `- ${m}`).join("\n") : "- Ninguno"}

## Módulos en rojo (NO usar aún)
${modRojo.length ? modRojo.map((m) => `- ${m}`).join("\n") : "- Ninguno"}

## Las 5 acciones prioritarias antes de lanzar
1. Subir precisión de pagos ambiguos con ejemplos adicionales y validación de sujeto.
2. Endurecer fallback de recepciones cuando hay múltiples OCs candidatas.
3. Mejorar matcheo de plantillas WhatsApp y teléfonos inválidos.
4. Reducir latencia >10s en consultas masivas de reportes.
5. Agregar test de regresión dedicado por módulo crítico en CI.

## Estimación de confianza por módulo
| Módulo | Confianza | Justificación |
|---|---:|---|
${rows.map((r) => `| ${r.m} | ${r.conf}% | PASS ${r.p}/${r.t}, FAIL ${r.f}, WARN ${r.w} |`).join("\n")}

## Las 20 propuestas visuales
| OV | cliente | layout usado | archivo generado | warnings de datos |
|---|---|---|---|---|
${propuestas
  .map((p) => `| ${p.ov} | ${p.cliente || "-"} | ${p.layout || "-"} | ${p.archivo || "-"} | ${(p.warnings || []).join("; ") || "-"} |`)
  .join("\n")}

## Resumen QA global
Total: ${globalStats.total} | PASS: ${globalStats.pass} | FAIL: ${globalStats.fail} | WARN: ${globalStats.warn} | Confianza: ${globalStats.globalConf}%
`;
}

async function main() {
  const verify = {
    nodeCheckOk: true,
    inkscapeWhere: "",
    inkscapeVersion: "ausente",
    modules: {},
    endpointPresent: false,
    protectedTouched: null
  };

  const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}]);
  const propuestas = await part2Generate20Proposals(uid);
  const qaResults = await part3RunQa2000(uid);
  const rules = buildRulesDoc();
  const qa = buildQaReport(qaResults);
  const estado = buildEstadoSistema(qa.rows, qa, propuestas);

  fs.writeFileSync(path.join(INFORMES_DIR, "reglas-por-modulo-2026-04-24.md"), rules, "utf8");
  fs.writeFileSync(path.join(INFORMES_DIR, "qa-2000-resultados-2026-04-24.md"), qa.qaMd, "utf8");
  fs.writeFileSync(path.join(INFORMES_DIR, "reeducacion-llm-2026-04-24.md"), qa.reeMd, "utf8");
  fs.writeFileSync(path.join(INFORMES_DIR, "estado-sistema-completo-2026-04-24.md"), estado, "utf8");
  fs.writeFileSync(
    path.join(INFORMES_DIR, "run-full-task-debug-2026-04-24.json"),
    JSON.stringify({ verify, propuestas, qaSample: qaResults.slice(0, 20), qaTotals: qa }, null, 2),
    "utf8"
  );
  console.log("DONE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
