require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_JOURNALS = [
  "Cash",
  "Banco Santander Milito",
  "MercadoPago"
];

let pendingPurchaseOrders = [];
let allSuppliers = [];
let whatsappTemplates = [];
let saleOrderTemplates = [];
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/agent", async (req, res) => {
  try {
    const message = req.body?.message?.trim();
    const incomingSessionId = req.body?.sessionId?.trim();
    const sessionId = incomingSessionId || `session_${Date.now()}`;
    if (!message) {
      return res.status(400).json({ error: "El mensaje es obligatorio." });
    }

    validateEnv();
    const session = getOrCreateSession(sessionId);
    pushHistory(session, "user", message);

    if (isNegative(message)) {
      session.pendingDelivery = null;
      session.history = [];
      const reply = "Listo, cancelado. Decime qué necesitás.";
      const options = [];
      pushHistory(session, "assistant", reply);
      return res.json({ reply, options, action: "pregunta", sessionId });
    }

    if (session.pendingDelivery) {
      if (isAffirmative(message)) {
        const result = await executeDelivery(session.pendingDelivery.data);
        session.pendingDelivery = null;
        pushHistory(session, "assistant", result.reply);
        return res.json({ reply: result.reply, options: [], action: "ejecutada", sessionId });
      }
    }

    const intentModule = detectIntentModule(message);
    if (intentModule === "UNKNOWN") {
      const cf = {
        type: "clarification_form",
        message: "No entendí bien qué querés hacer. ¿Es alguna de estas opciones?",
        options: ["Pagos", "Recepciones", "Ventas", "Compras", "Reportes", "Precios"]
      };
      pushHistory(session, "assistant", cf.message);
      return res.json({
        type: cf.type,
        reply: cf.message,
        message: cf.message,
        options: cf.options,
        action: "pregunta",
        sessionId
      });
    }
    let detectedDeliveryIntent = false;
    if (intentModule === "RECEPCIONES") {
      const deliveryKeywordIntent = detectDeliveryIntentByKeywords(message);
      if (deliveryKeywordIntent.type === "supplier_only") {
        const reply = `¿${deliveryKeywordIntent.supplier} te entregó mercadería?`;
        pushHistory(session, "assistant", reply);
        return res.json({ reply, options: [], action: "pregunta", sessionId });
      }
      if (deliveryKeywordIntent.type === "supplier_delivery") {
        detectedDeliveryIntent = true;
        const cacheDecisionByKeywords = resolveDeliveryFromCache(session, message, {
          forceFromSupplierMention: true
        });
        if (cacheDecisionByKeywords) {
          pushHistory(session, "assistant", cacheDecisionByKeywords.reply);
          return res.json({
            reply: cacheDecisionByKeywords.reply,
            options: cacheDecisionByKeywords.options || [],
            action: cacheDecisionByKeywords.action || "pregunta",
            sessionId
          });
        }
      }
    }

    if (session.pendingWrite) {
      const writeResult = await continuePendingWriteFlow(session, message);
      pushHistory(session, "assistant", writeResult.reply);
      return res.json({
        reply: writeResult.reply,
        options: writeResult.options || [],
        action: writeResult.action || "pregunta",
        sessionId
      });
    }

    if (session.pendingSoConfirm) {
      const c = await continueConfirmSaleOrderFlow(session, message);
      pushHistory(session, "assistant", c.reply);
      return res.json({ reply: c.reply, options: c.options || [], action: c.action || "pregunta", sessionId });
    }

    if (session.pendingDejarNota) {
      const n = await continueDejarNotaFlow(session, message);
      pushHistory(session, "assistant", n.reply);
      return res.json({ reply: n.reply, options: n.options || [], action: n.action || "pregunta", sessionId });
    }

    if (session.pendingModOc) {
      const modR = await continueModOcDateFlow(session, message);
      pushHistory(session, "assistant", modR.reply);
      return res.json({
        reply: modR.reply,
        options: modR.options || [],
        action: modR.action || "pregunta",
        sessionId
      });
    }

    if (session.creditAdjust) {
      const cr = await continueCreditAdjustFlow(session, message);
      pushHistory(session, "assistant", cr.reply);
      return res.json({
        reply: cr.reply,
        options: cr.options || [],
        action: cr.action || "pregunta",
        sessionId
      });
    }

    if (session.pendingWhatsapp) {
      const w = await continueWhatsappSendFlow(session, message);
      pushHistory(session, "assistant", w.reply);
      return res.json({
        reply: w.reply,
        options: (w.options || []).slice(0, 3),
        action: w.action || "pregunta",
        sessionId
      });
    }

    const preLlm = await runPreLlmChain(message, session, intentModule);
    if (preLlm) {
      pushHistory(session, "assistant", preLlm.reply);
      return res.json({
        reply: preLlm.reply,
        options: (preLlm.options || []).slice(0, 3),
        action: preLlm.action || "consulta",
        sessionId
      });
    }

    if (intentModule !== "PAGOS") {
      const writeStart = await startWriteFlowIfNeeded(session, message);
      if (writeStart) {
        pushHistory(session, "assistant", writeStart.reply);
        return res.json({
          reply: writeStart.reply,
          options: writeStart.options || [],
          action: "pregunta",
          sessionId
        });
      }

      if (detectedDeliveryIntent) {
        const cacheDecision = resolveDeliveryFromCache(session, message, { forceFromSupplierMention: false });
        if (cacheDecision) {
          pushHistory(session, "assistant", cacheDecision.reply);
          return res.json({
            reply: cacheDecision.reply,
            options: cacheDecision.options || [],
            action: cacheDecision.action || "pregunta",
            sessionId
          });
        }
      }
    }

    const agentDecision = await runAgentWithHistory(session, intentModule);
    if (agentDecision && agentDecision.type === "clarification_form") {
      pushHistory(session, "assistant", agentDecision.message);
      return res.json({
        type: "clarification_form",
        reply: agentDecision.message,
        message: agentDecision.message,
        options: agentDecision.options || [],
        action: "pregunta",
        sessionId
      });
    }

    if (!agentDecision.action) {
      const reply = agentDecision.reply || "No te entendí, ¿qué querés hacer?";
      const options = sanitizeAssistantOptions(
        reply,
        Array.isArray(agentDecision.options) ? agentDecision.options : []
      );
      pushHistory(session, "assistant", reply);
      return res.json({ reply, options, action: "pregunta", sessionId });
    }

    let result;
    const core = agentDecision.action;
    if (core === "PAGO_CLIENTE" || core === "PAGO_PROVEEDOR" || core === "RECEPCION") {
      try {
        if (core === "PAGO_CLIENTE") {
          const d = agentDecision.data || {};
          if (!d.clientName) {
            const reply = "¿A nombre de quién registro el cobro?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          if (!d.amount || Number(d.amount) <= 0) {
            const reply = "¿Por qué monto?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          if (!d.journalName) {
            const reply = "¿Por qué medio?";
            pushHistory(session, "assistant", reply);
            return res.json({
              reply,
              options: ["Efectivo", "Santander", "MercadoPago"],
              action: "pregunta",
              sessionId
            });
          }
          agentDecision.data.journalName = normalizeJournalName(d.journalName);
          result = await executePayment(agentDecision.data || {}, "customer");
        } else if (core === "PAGO_PROVEEDOR") {
          const d = agentDecision.data || {};
          if (!d.supplierName) {
            const reply = "¿A qué proveedor le pagaste?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          if (!d.amount || Number(d.amount) <= 0) {
            const reply = "¿Por qué monto?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          if (!d.journalName) {
            const reply = "¿Por qué medio?";
            pushHistory(session, "assistant", reply);
            return res.json({
              reply,
              options: ["Efectivo", "Santander", "MercadoPago"],
              action: "pregunta",
              sessionId
            });
          }
          agentDecision.data.journalName = normalizeJournalName(d.journalName);
          result = await executePayment(agentDecision.data || {}, "supplier");
        } else {
          const d = agentDecision.data || {};
          if (!d.supplierName) {
            const reply = "¿Qué proveedor entregó?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          if (!d.clientName) {
            const reply = "¿De qué cliente o marca es la mercadería?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          if (!d.quantity || Number(d.quantity) <= 0) {
            const reply = "¿Qué cantidad recibiste?";
            pushHistory(session, "assistant", reply);
            return res.json({ reply, options: [], action: "pregunta", sessionId });
          }
          // Nunca pedir SKU ni precio — vienen de la OC
          result = await executeDelivery(agentDecision.data || {});
        }
      } catch (e) {
        const msg = (e && e.message) || String(e);
        const clean =
          msg.includes("Traceback") || msg.includes("  File ")
            ? "Revisá el monto, el contacto o el asiento, o probá de nuevo en un rato."
            : msg;
        result = { reply: `No pude completar el movimiento. ${clean}`.slice(0, 600) };
      }
    } else {
      try {
        const ext = await executeExtendedAgentAction(
          String(agentDecision.action || "").trim(),
          agentDecision.data || {},
          session,
          message
        );
        if (ext && ext.conversational) {
          pushHistory(session, "assistant", ext.reply);
          return res.json({
            reply: ext.reply,
            options: ext.options || [],
            action: "pregunta",
            sessionId
          });
        }
        result = ext || { reply: "Dame un segundo, revisá los datos o probá otra frase." };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        result = {
          reply: `Eso no salió. ${msg.includes("Traceback") || msg.includes("  File ") ? "Revisá la operación o probá otra forma de decirlo." : msg}`
        };
        if (result.reply.length > 500) {
          result.reply = "Eso no salió, pero no es culpa tuya. Probá de nuevo con otros datos o reformulá la pedida.";
        }
      }
    }

    const replyOut = (result && result.reply) || "Dale, avanzá con otro dato o probá otra frase.";
    const optsOut = Array.isArray(result && result.options) ? result.options.slice(0, 3) : [];
    pushHistory(session, "assistant", replyOut);
    return res.json({ reply: replyOut, options: optsOut, action: "ejecutada", sessionId });
  } catch (error) {
    console.error("Error en /api/agent:", error);
    return res.status(200).json({
      reply: "Paso algo raro del lado del servidor. Probá de nuevo en un ratito, y si pasa otra vez avisame qué tocaste.",
      options: [],
      action: "pregunta",
      sessionId: req.body?.sessionId || ""
    });
  }
});

const PROPUESTAS_DIR = path.join(__dirname, "propuestas");
const LOGOS_DIR = path.join(__dirname, "logos");
try {
  fs.mkdirSync(PROPUESTAS_DIR, { recursive: true });
  fs.mkdirSync(LOGOS_DIR, { recursive: true });
} catch (_) {
  /* no bloquea */
}
app.use("/propuestas", express.static(PROPUESTAS_DIR));
app.post("/api/generar-propuesta", handleGenerarPropuestaEndpoint);

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
loadPendingPurchaseOrders();
loadAllSuppliers();
loadWhatsappTemplates();
(async () => {
  try {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    await loadSaleOrderTemplates(odoo, uid);
  } catch {
    saleOrderTemplates = [];
  }
})();
setInterval(loadPendingPurchaseOrders, 30 * 60 * 1000);
setInterval(loadAllSuppliers, 30 * 60 * 1000);
setInterval(loadWhatsappTemplates, 30 * 60 * 1000);
setInterval(async () => {
  try {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    await loadSaleOrderTemplates(odoo, uid);
  } catch {
    saleOrderTemplates = [];
  }
}, 30 * 60 * 1000);

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      history: [],
      pendingDelivery: null,
      pendingWrite: null,
      pendingModOc: null,
      creditAdjust: null,
      pendingSoConfirm: null,
      pendingDejarNota: null,
      pendingWhatsapp: null,
      pendingPriceUpdate: null
    });
  }
  return sessions.get(sessionId);
}

function pushHistory(session, role, content) {
  session.history.push({ role, content: String(content || "") });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
}

function tryParseJson(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function extractJsonObjectFromText(text) {
  const raw = String(text || "").replace(/```json|```/g, "").trim();
  if (!raw) return null;
  const direct = tryParseJson(raw);
  if (direct) return direct;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = raw.slice(start, end + 1);
  return tryParseJson(candidate);
}

function detectIntentModule(message) {
  const n = normalizeStr(String(message || ""));
  const has = (arr) => arr.some((k) => n.includes(k));

  // Selección directa desde clarification_form
  if (n === "pagos") return "PAGOS";
  if (n === "recepciones") return "RECEPCIONES";
  if (n === "ventas") return "VENTAS";
  if (n === "compras") return "COMPRAS";
  if (n === "reportes") return "REPORTES";
  if (n === "precios") return "PRECIOS";

  const pagosKw = [
    "mepago",
    "medio",
    "metransfirio",
    "memando",
    "cobre",
    "cobro",
    "meentro",
    "lepague",
    "lepago",
    "ledi",
    "lemande",
    "letransferi",
    "paguea",
    "pagoa"
  ];
  const recepKw = ["entrego", "llego", "recibi", "vino", "trajo"];
  const ventasKw = ["armacotizacion", "nuevaov", "presupuestopara", "generapropuesta", "confirmalaovde", "propuestade", "propuestapara"];
  const comprasKw = ["cuandoentrega", "postergalaentregade", "pedidosde", "quemedebe"];
  const reportesKw = ["cuantomedebe", "cuentasacobrar", "cajadehoy", "pedidosenproduccion", "quefacture", "reporte", "estadistica"];
  const preciosKw = ["subioun", "aumentaron", "actualizaelcostode", "actualizarcosto", "costo"];

  if (has(pagosKw)) return "PAGOS";
  if (has(recepKw)) return "RECEPCIONES";
  if (has(ventasKw)) return "VENTAS";
  if (has(comprasKw)) return "COMPRAS";
  if (has(reportesKw)) return "REPORTES";
  if (has(preciosKw)) return "PRECIOS";
  return "UNKNOWN";
}

function buildModulePromptContext(moduleHint) {
  const m = String(moduleHint || "FULL").toUpperCase();
  const map = {
    PAGOS: `CONTEXTO ACTIVO: MODULO PAGOS (account.payment).
- Verbos cliente->mi: me pago, me dio, me transfirio, me mando, cobre, cobro, me entro.
- Verbos yo->proveedor: le pague, le di, le mande, le transferi, pague a.
- Campos requeridos: partner_id, amount, journal_id (Cash|Banco Santander Milito|MercadoPago), date, memo/ref.
- Nunca inventar datos; si falta algo, pedir confirmacion.
EJEMPLOS REALES:
- "le pague a carvi 200k en efectivo" → action: PAGO_PROVEEDOR, data: { supplierName: "Carvi", amount: 200000, journalName: "Cash", ref: "pago carvi" }
- "le pague a omar 100k en mp" → action: PAGO_PROVEEDOR, data: { supplierName: "Omar", amount: 100000, journalName: "MercadoPago", ref: "pago omar" }
- "me pago holster 500k en banco" → action: PAGO_CLIENTE, data: { clientName: "Holster", amount: 500000, journalName: "Banco Santander Milito", ref: "pago holster" }
- "calzon quitao me mando 400k por mp" → action: PAGO_CLIENTE, data: { clientName: "Calzon Quitao", amount: 400000, journalName: "MercadoPago", ref: "pago calzon quitao" }
NUNCA preguntar si alguien entregó mercadería cuando el mensaje contiene verbos de pago.`,
    RECEPCIONES: `CONTEXTO ACTIVO: MODULO RECEPCIONES (stock.picking + account.move).
- Verbos: entrego, llego, recibi, vino, trajo.
- Sujeto antes del verbo = proveedor; objeto = producto/cliente.
- No pedir SKU ni precio si se puede resolver por OC.
- Buscar OC por marca/cliente y proveedor; luego validar recepcion + facturas.`,
    VENTAS: `CONTEXTO ACTIVO: MODULO VENTAS (sale.order).
- Verbos: arma cotizacion, nueva OV, presupuesto para, genera propuesta, confirma OV.
- Campos: partner_id, x_studio_marca, sale_order_template_id, pricelist_id (Lista WEB/Lista Facu).`,
    COMPRAS: `CONTEXTO ACTIVO: MODULO COMPRAS (purchase.order).
- Verbos: cuando entrega, postergar entrega, pedidos de, que me debe.
- Priorizar busqueda por cliente/marca y proveedor usando cache pendingPurchaseOrders.`,
    REPORTES: `CONTEXTO ACTIVO: MODULO REPORTES (solo lectura).
- Verbos: cuanto me debe, cuentas a cobrar, caja de hoy, pedidos en produccion, que facture.
- No escribir en ODOO en este modulo.`,
    PRECIOS: `CONTEXTO ACTIVO: MODULO PRECIOS (product.template).
- Verbos: subio X%, aumentaron X pesos, actualiza costo de.
- Solo actualizar standard_price; no tocar listas de precio.`
  };
  return map[m] || "CONTEXTO ACTIVO: COMPLETO (multimodulo).";
}

function buildAgentSystemPrompt(moduleHint = "FULL") {
  const pendingSummary = buildPendingPurchaseOrdersSummary();
  const suppliersSummary = allSuppliers.slice(0, 200).join(", ");
  const moduleContext = buildModulePromptContext(moduleHint);
  return `Sos Facu, el asistente de gestión de Avíos Textiles Argentina.
Tono: español rioplatense, directo, sin formalismos. Respuestas cortas.

NUNCA respondas con error, stack ni "no puedo" por desconocer el pedido. Si no alcanzás, explicá con una frase qué te falta, o ofrecé hasta 3 opciones en "options" (máx 3) para desambiguar (ej: "Cobro de cliente" / "Pago a proveedor").

OPERACIONES EJECUTABLES (action) — SOLO ESTAS:
- PAGO_CLIENTE
- PAGO_PROVEEDOR
- RECEPCION
- BUSCAR_CONTACTO
- DEJAR_NOTA_OV
- CONFIRMAR_OV
- CREAR_PRODUCTO
- MODIFICAR_FECHA_OC
- MODIFICAR_PROPUESTA
- ENVIAR_WHATSAPP_MASIVO
- NADA

CAMPOS ODOO CLAVE (usá estos nombres en data):
- OV: sale.order.name (S0XXXX), sale.order.x_studio_marca, sale.order.partner_id
- OC: purchase.order.name (P0XXXX)
- Producto: product.template.name, categ_id, list_price, x_studio_minimo
- Chatter OV: mail.message.body

REGLAS DE EXTRACCIÓN:
- Si el usuario nombra una OV (S0XXXX), ponela en data.orden_id o data.saleOrderName según action.
- Si no hay código pero habla de cliente/marca, usar BUSCAR_CONTACTO o MODIFICAR_PROPUESTA con orden_id vacío solo si falta confirmar.
- MODIFICAR_PROPUESTA: data obligatorio { "orden_id": "S0XXXX", "cambios": "texto libre o vacío" }.
- Si no alcanza info para ejecutar, responder con options cortas (máx 3) y pedir SOLO el campo faltante.

${moduleContext}

JERGA REAL DEL RUBRO (muy frecuente):
- NP = diseño/nota de producción del cliente (referencia interna, suele llegar por WhatsApp).
- PP = pieza/plano final para proveedor (aprobado para producir).
- "confirmado", "mandar a proveedor", "pasar a producción" implican que el pedido ya está listo para etapa proveedor.
- En diseño/propuesta, frases tipo "fondo", "relieve", "horizontal", "vertical", "sin línea de corte", "mitad tafeta" van a MODIFICAR_PROPUESTA.

ESQUEMAS OBLIGATORIOS POR ACTION (no inventar campos):
- PAGO_CLIENTE:
  data = { "clientName", "amount", "journalName", "ref" }
  journals válidos: Cash | Banco Santander Milito | MercadoPago
- PAGO_PROVEEDOR:
  data = { "supplierName", "amount", "journalName", "ref" }
- NUNCA usar en data: vals.ref directo, lista_gastos, listaGastos — solo los nombres exactos de arriba
- El campo "ref" el servidor lo mapea internamente a memo (account.payment) en ODOO; el LLM siempre usa "ref"
- RECEPCION:
  data = { "supplierName", "sku", "quantity", "supplierUnitPrice", "note" }
  prioridad de rastreo: OC (P0XXXX) -> origin/documento relacionado -> OV (S0XXXX)
- DEJAR_NOTA_OV:
  data = { "saleOrderName", "note" }
- CONFIRMAR_OV:
  data = { "saleOrderName" }
- CREAR_PRODUCTO:
  data = { "productName", "precio", "categoria", "minimo" }
- MODIFICAR_FECHA_OC:
  data = { "poName", "newDateIso" }
- MODIFICAR_PROPUESTA:
  data = { "orden_id", "cambios" }
  si solo piden generar: cambios = ""
- ENVIAR_WHATSAPP_MASIVO:
  data = { "plantilla", "contacts" }

MÍNIMOS DE DATOS (según tablas ODOO que usa el sistema):
- Ventas/OV: sale.order.name, partner_id, x_studio_marca, order_line (producto, cantidad, precio_unitario), fecha esperada.
- Compras/OC: purchase.order.name, partner_id, order_line (producto, cantidad, costo), date_planned, origin/documento origen.
- Facturas: account.move (in/out invoice), partner, lineas, ref/origin, tipo de gasto cuando aplique.
- Pagos: account.payment (fecha, diario, método, contacto, referencia, importe, estado).

CONTACTOS (lógica y prompt):
- Búsqueda: intent BUSCAR_CONTACTO. Reglas: empresa (is_company) si hay CUIT; razón social vs marca; child_ids = contacto interno (persona, WhatsApp, mail); Salada/Flores: en esos polos, la dirección y galería debería reconocerse en el nombre del contacto. Por ahora nunca pidas crear contacto acá, solo búsqueda y lectura (el nombre lo carga otra gente/OTRO flujo).

VENTAS (createOv: conversación o futuro LLM, no toques recepción):
- x_studio_marca en OV (ya existe en ODOO). Lista: solo ["Lista WEB", "Lista Facu"].
- Búsqueda de producto: categ_id, description_sale, x_studio_ecommerce; si hay cantidad mínima luego el back advierte.
- Si no hay producto: ofrecer CREAR_PRODUCTO en borrador (nombre, categoría entre las del sistema, precio).
- Nota: DEJAR_NOTA_OV (chatter) y confirmar: CONFIRMAR_OV. La factura al cliente NUNCA la inventes: siempre nace de la recepción/venta existente (recepción en backend).

PAGOS — PAGO_CLIENTE (el cliente me paga a mí; yo cobro):
  Verbos/ejemplos: "me pagó", "me pago", "me dio", "me transfirió", "me mandó", "cobré", "cobro", "me entró", "entro", "cobraste", "cobraste a".
PAGOS — PAGO_PROVEEDOR (yo pago a proveedor):
  Verbos: "le pagué", "le pague", "pagué a", "pague a", "le di", "le mandé a", "le transferí a", "le mande a".
AMBIGÜEDAD "pago"/"pagó" sin dejar claro el sujeto:
  No des error. Si podés, inferí del contexto; si no, options ["Cobro de cliente", "Pago a proveedor"] o explicá qué te falta.
  (En backend a veces se cruza con account.move y OC: si hay varias pistas, proponé las dos acciones; si no, preguntá con esas options.)
- Diarios permitidos: Cash, Banco Santander Milito, MercadoPago (al usuario: Efectivo, Santander, MercadoPago)

RECEPCION (solo instrucciones LLM; el código de recepción no se toca):
- Búsqueda de OC por producto/mercadería: usá el caché de OCs pendientes (pendingPurchaseOrders) y filtrá por similitud en el nombre de línea (line.name), no le pidas al usuario el SKU: sale de la OC.
- Si menciona proveedor → filtrá por partner; si menciona cliente o marca comercial (x_studio_marca) → filtrá por eso. El precio unitario y el SKU no los inventes: vienen de la línea de OC.
- Varios candidatos: opciones con el formato: "[PRODUCTO] — [CLIENTE] (OC [nombre de OC])" (hasta 3).
- Orden al elegir OV a facturar (ya resuelto en backend, no reimplementar): x_studio_documento_relacionado → marca (x_studio_marca) → SKU (de línea) → fecha.
- Factura al cliente: siempre nace de la lógica existente, no de inventos en JSON.
FACTURAS Y RECEPCIONES (otros):
- Si el usuario recibió mercadería: caché por proveedor, marca, documento relacionado, etc.; sin SKU inventado; sin precio pedido al usuario.

WHATSAPP (stub):
- ENVIAR_WHATSAPP_MASIVO: listar contacto+tél, avisar que el envío masivo es manual / app. Factura o pago suelto: buscar doc reciente, decir que el envío es desde ODOO en esa vista (botón WhatsApp).

MÓDULOS 5–6–9: reportes de cobrar/pagar, caja, producción, estadísticas suelen resolverse ANTES en el chat (el servidor) sin JSON; no inventes totales, si el usuario pide caja/deuda/estadística y no tenés cifra, explicá que el sistema te las va a mostrar o pedí criterio.

RECEPCION — el sujeto es el PROVEEDOR entregando (action RECEPCION):
- Verbos: "entregó", "entrego", "llegó", "llego", "mandó", "vino", "trajo", "recibí"
- Abreviaciones: "carv"=Carvi, "arsl"=Arslanian, "prtm"=Printmax, "mkplast"=MK Plast
- El precio y SKU vienen de la OC, nunca los inventes; cuando confirma, action=RECEPCION con data completa

PAGO_PROVEEDOR: "le pagué", "le pague", "le di", "le mandé", "le transferí" + diario. PAGO_CLIENTE: "me pagó", "me pago"...

Journals permitidos: Cash, Banco Santander Milito, MercadoPago (display Efectivo/Santander/MercadoPago al usuario al elegir)

DESPLIEGUE (para Cursor, no ejecutar en chat): después de tocar el código, git init si falta, railway.json con Nixpacks, .gitignore node_modules .env, README, Railway CLI, variables ODOO_* y GROQ_API_KEY, PORT=process.env.PORT.

PLANTILLAS DE COTIZACIÓN DISPONIBLES:
${(saleOrderTemplates || []).map((t) => `${t.id}: ${t.name}`).join(", ")}

DATOS CACHÉ:
- OCs: ${pendingSummary}
- Proveedores: ${suppliersSummary}

FORMATO — devolvé SOLO JSON, sin markdown ni texto extra:
- Si no podés clasificar el módulo con confianza: { "type": "clarification_form", "message": "No entendí bien qué querés hacer. ¿Es alguna de estas opciones?", "options": ["Pagos","Recepciones","Ventas","Compras","Reportes","Precios"] }
- Solo texto: { "action": "NADA", "data": { "reply": "...", "options": ["máx 3"] } }  O también: { "reply": "...", "options": [] } (sin action)
- Ejecutar pago recepción: { "action": "PAGO_CLIENTE" | "PAGO_PROVEEDOR" | "RECEPCION", "data": { ...mismos campos que antes... } }
- Otras: { "action": "BUSCAR_CONTACTO" | "DEJAR_NOTA_OV" | "CONFIRMAR_OV" | "CREAR_PRODUCTO" | "MODIFICAR_FECHA_OC" | "MODIFICAR_PROPUESTA" | "ENVIAR_WHATSAPP_MASIVO", "data": { ... } }`;
}

const GROQ_JSON_FALLBACK_REPLY =
  "No te entendí bien esa. ¿Me lo explicás de otra forma o querés hacer otra cosa?";

async function runAgentWithHistory(session, moduleHint = "FULL") {
  const fallback = { action: null, reply: GROQ_JSON_FALLBACK_REPLY, options: [] };
  let response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 900,
        messages: [
          { role: "system", content: buildAgentSystemPrompt(moduleHint) },
          ...session.history.slice(-20).map((h) => ({ role: h.role, content: h.content }))
        ]
      })
    });
  } catch (e) {
    return fallback;
  }

  let bodyText;
  try {
    bodyText = await response.text();
  } catch (e) {
    return fallback;
  }
  if (!response.ok) {
    console.error("[Groq] HTTP", response.status, bodyText);
    return fallback;
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    return fallback;
  }
  const content = String(payload?.choices?.[0]?.message?.content ?? "").trim();
  if (!content) {
    return fallback;
  }

  const parsed = extractJsonObjectFromText(content);
  if (!parsed) {
    return fallback;
  }

  if (String(parsed.type || "").trim() === "clarification_form") {
    const msg = String(parsed.message || "").trim();
    const opts = Array.isArray(parsed.options) ? parsed.options.map((x) => String(x)).filter(Boolean) : [];
    if (!msg || !opts.length) return fallback;
    return { type: "clarification_form", message: msg, options: opts };
  }

  if (!parsed.action) {
    if (typeof parsed.reply !== "string" || !String(parsed.reply).trim()) {
      return fallback;
    }
    const reply = String(parsed.reply).trim();
    const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
    const options = sanitizeAssistantOptions(reply, rawOptions.map((x) => String(x)).filter(Boolean));
    return { action: null, reply, options };
  }

  return {
    action: String(parsed.action || "").trim(),
    data: parsed.data || {}
  };
}

function sanitizeAssistantOptions(reply, options) {
  const safeReply = String(reply || "");
  const safeOptions = Array.isArray(options) ? options.map((x) => String(x)).filter(Boolean) : [];
  if (!safeOptions.length) return [];

  const normalizedReply = normalizeStr(safeReply);
  const genericWelcomeTokens = [
    normalizeStr("Recibir mercadería"),
    normalizeStr("Cobro de cliente"),
    normalizeStr("Pago a proveedor")
  ];
  if (safeOptions.some((opt) => genericWelcomeTokens.includes(normalizeStr(opt)))) {
    return [];
  }

  return safeOptions.slice(0, 3);
}

function isAffirmative(text) {
  const n = normalizeStr(text);
  return ["si", "sii", "ok", "dale", "confirmar", "confirmo", "síconfirmar", "siconfirmar"].some((k) => n.includes(k));
}

function isNegative(text) {
  const n = normalizeStr(text);
  return ["no", "cancelar", "cancelo", "nocancelar"].some((k) => n === k || n.includes(k));
}

function normalizeMoney(value) {
  const cleaned = String(value || "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseProductQtyText(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/(.+?)\s*(?:x|por)?\s*(\d+(?:[.,]\d+)?)$/i);
  if (!m) return null;
  const productName = String(m[1] || "").trim();
  const quantity = Number(String(m[2] || "").replace(",", "."));
  if (!productName || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { productName, quantity };
}

function cleanProductLabel(name) {
  return String(name || "").replace(/^\[.*?\]\s*/, "").trim() || "Producto";
}

function buildPendingPoHumanLine(po) {
  const firstLine = (po.lines || [])[0];
  const product = cleanProductLabel(firstLine?.name || firstLine?.default_code || "Producto");
  const pendingQty = firstLine
    ? Math.max(0, Number(firstLine.product_qty || 0) - Number(firstLine.qty_received || 0))
    : 0;
  return `${po.name}: ${product} (pendiente ${pendingQty})`;
}

async function resolveDirectQueries(message) {
  const normalized = normalizeStr(message);
  if (!normalized) return null;

  if (normalized.includes("cuantomedebe")) {
    const clientRaw = String(message || "")
      .replace(/^\s*cu[aá]nto\s+me\s+debe\s+/i, "")
      .replace(/[?]/g, "")
      .trim();
    if (!clientRaw) {
      return { reply: "Decime el cliente para buscar deuda.", options: [] };
    }
    return queryClientDebt(clientRaw);
  }

  if (
    normalized.includes("quetengopendientede") ||
    normalized.includes("pendientede")
  ) {
    const whoRaw = String(message || "")
      .replace(/^\s*qu[eé]\s+tengo\s+pendiente\s+de\s+/i, "")
      .replace(/^\s*pendiente\s+de\s+/i, "")
      .replace(/[?]/g, "")
      .trim();
    if (!whoRaw) {
      return {
        reply: "Decime proveedor o cliente para listar pendientes.",
        options: []
      };
    }
    return queryPendingFromCache(whoRaw);
  }

  if (normalized.includes("comoestalaovde") || normalized.includes("estadoov") || normalized.includes("ov")) {
    if (!normalized.includes("ov")) return null;
    const hint = String(message || "")
      .replace(/^\s*c[oó]mo\s+est[aá]\s+la\s+ov\s+de\s+/i, "")
      .replace(/[?]/g, "")
      .trim();
    if (!hint) return null;
    return querySaleOrderStatus(hint);
  }

  return null;
}

async function queryClientDebt(clientName) {
  validateEnv();
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const partners = await odoo.executeKw(
    uid,
    "res.partner",
    "search_read",
    [[["name", "ilike", clientName]]],
    { fields: ["id", "name"], limit: 5 }
  );
  if (!partners.length) {
    return { reply: `No encontré el cliente "${clientName}".`, options: [] };
  }
  if (partners.length > 1) {
    return {
      reply: "Encontré varios clientes con ese nombre. Decime el nombre completo.",
      options: []
    };
  }

  const partner = partners[0];
  const invoices = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "in", ["not_paid", "partial"]],
      ["partner_id", "=", partner.id]
    ]],
    { fields: ["name", "invoice_date", "amount_residual"], limit: 100 }
  );
  if (!invoices.length) {
    return { reply: `${partner.name} no tiene deuda pendiente.`, options: [] };
  }
  const total = invoices.reduce((acc, inv) => acc + Number(inv.amount_residual || 0), 0);
  const lines = invoices
    .slice(0, 12)
    .map((inv) => `- ${inv.name || "Factura"} (${inv.invoice_date || "sin fecha"}): $${Number(inv.amount_residual || 0).toFixed(2)}`)
    .join("\n");
  return {
    reply: `Deuda pendiente de ${partner.name}:\n${lines}\n\nTotal pendiente: $${total.toFixed(2)}`,
    options: []
  };
}

async function queryPendingFromCache(entityName) {
  const token = normalizeStr(entityName);
  const bySupplier = pendingPurchaseOrders.filter((po) => normalizeStr(po.partnerName).includes(token));
  const byClient = pendingPurchaseOrders.filter((po) => normalizeStr(po.x_studio_marca).includes(token));
  const rows = bySupplier.length ? bySupplier : byClient;
  if (!rows.length) {
    return { reply: `No encontré pendientes para "${entityName}".`, options: [] };
  }
  if (rows.length > 8) {
    return {
      reply: `Encontré ${rows.length} pendientes para ${entityName}. Te muestro los primeros 8:`,
      options: rows.slice(0, 8).map((po) => buildReadableOcOption(po))
    };
  }
  const lines = rows.map((po) => `- ${buildPendingPoHumanLine(po)}`).join("\n");
  return { reply: `Pendientes de ${entityName}:\n${lines}`, options: [] };
}

async function querySaleOrderStatus(rawHint) {
  validateEnv();
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const hint = String(rawHint || "").trim().toUpperCase();
  const ovMatch = hint.match(/S0\d+/i);
  let domain;
  if (ovMatch) {
    domain = [["name", "=", ovMatch[0].toUpperCase()]];
  } else {
    domain = [["partner_id.name", "ilike", rawHint]];
  }
  const orders = await odoo.executeKw(
    uid,
    "sale.order",
    "search_read",
    [[...domain]],
    { fields: ["name", "state", "invoice_status", "partner_id", "amount_total"], limit: 8 }
  );
  if (!orders.length) {
    return { reply: `No encontré OVs para "${rawHint}".`, options: [] };
  }
  if (orders.length > 1 && !ovMatch) {
    return {
      reply: "Encontré varias OVs para ese cliente. Decime el número exacto (S0XXXX).",
      options: []
    };
  }
  const order = orders[0];
  const clientName = Array.isArray(order.partner_id) ? order.partner_id[1] : "Cliente";
  return {
    reply:
      `OV ${order.name}\n` +
      `Cliente: ${clientName}\n` +
      `Estado: ${order.state}\n` +
      `Estado de facturación: ${order.invoice_status}\n` +
      `Total: $${Number(order.amount_total || 0).toFixed(2)}`,
    options: []
  };
}

function buildTextTable(headers, rows) {
  const h = (headers || []).map((c) => String(c || "")).filter(Boolean);
  if (!h.length) return "";
  const cell = (v) => String(v == null ? "" : v);
  const widths = h.map((header, j) => {
    const colW = [cell(header).length, ...rows.map((r) => cell((r && r[j]) != null ? r[j] : "").length)];
    return Math.max(...colW, 4);
  });
  const line = (cells) => cells.map((c, i) => cell(c).padEnd(widths[i])).join("  ");
  return [line(h), ...rows.map((r) => line(h.map((_, i) => (r && r[i]) != null ? r[i] : "")))].join(
    "\n"
  );
}

function parseDateDdMmYyyy(s) {
  const m = String(s || "")
    .trim()
    .match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const y = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const fullY = y < 100 ? 2000 + y : y;
  const date = new Date(fullY, mo, d);
  if (Number.isNaN(date.getTime()) || d < 1 || d > 31) return null;
  return date;
}

function formatDateIsoLocal(d) {
  const p = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(p.getTime())) return "";
  return p.toISOString().slice(0, 10);
}

async function getJournalIdSetForCaja(odoo, uid) {
  const out = new Map();
  for (const jn of ALLOWED_JOURNALS) {
    const j = await findJournalByName(odoo, uid, jn);
    if (j && j.id) out.set(jn, j.id);
  }
  return out;
}

async function loadWhatsappTemplates() {
  try {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const rows = await odoo.executeKw(
      uid,
      "whatsapp.template",
      "search_read",
      [[["status", "=", "approved"]]],
      { fields: ["id", "name", "model"], limit: 50 }
    );
    whatsappTemplates = Array.isArray(rows) ? rows : [];
  } catch {
    whatsappTemplates = [];
  }
}

async function loadSaleOrderTemplates(odoo, uid) {
  try {
    const rows = await odoo.executeKw(
      uid,
      "sale.order.template",
      "search_read",
      [[["active", "=", true]]],
      { fields: ["id", "name"], limit: 50 }
    );
    saleOrderTemplates = Array.isArray(rows) ? rows : [];
  } catch {
    saleOrderTemplates = [];
  }
}

function formatSaleOrderTemplateNameList() {
  const t = Array.isArray(saleOrderTemplates) ? saleOrderTemplates : [];
  if (!t.length) return "(cargando… si no figura, probá de nuevo al ratito)";
  return t.map((x) => x.name).join(", ");
}

function saleOrderTemplateIntentTriggers(s) {
  const raw = String(s || "");
  if (raw.length < 10) return false;
  if (/arm[áa]le\s+una\s+plantilla/i.test(raw)) return true;
  if (/us[áa]\s+la\s+plantilla/i.test(raw)) return true;
  if (/cotizaci[oó]n\s+con\s+plantilla/i.test(raw)) return true;
  if ((/crear|nueva|orden\s+de\s+venta|ov\b/i.test(raw) && /plantilla/i.test(raw)))
    return true;
  return false;
}

function extractTokenForSOTemplate(s) {
  const raw = String(s);
  let m = raw.match(/us[áa]\s+la\s+plantilla\s+["']?(.+?)(?:\.|,|$|para)/i);
  if (m) return m[1].replace(/[.]+$/, "").trim();
  m = raw.match(/arm[áa]le\s+una\s+plantilla\s+de\s+["']?(.+?)(?:\.|,|$|para)/i);
  if (m) return m[1].replace(/[.]+$/, "").trim();
  m = raw.match(/cotizaci[oó]n\s+con\s+plantilla\s+["']?(.+?)(?:\.|,|$|para)/i);
  if (m) return m[1].replace(/[.]+$/, "").trim();
  m = raw.match(/plantilla\s+de\s+["']?(.+?)(?:\.|,|$|para)/i);
  if (m) return m[1].replace(/[.]+$/, "").trim();
  return primaryTokenForContactMessage(raw) || "";
}

function findMatchingSaleOrderTemplates(nameGuess) {
  const n = normalizeStr(nameGuess);
  const list = Array.isArray(saleOrderTemplates) ? saleOrderTemplates : [];
  if (!n) return list.slice(0, 3);
  const scored = list
    .map((t) => {
      const tn = normalizeStr(t.name || "");
      if (!tn) return { t, score: 0 };
      let score = 0;
      if (tn === n) score += 100;
      if (tn.includes(n)) score += 50;
      if (n.includes(tn)) score += 40;
      n.split(/\s+/).forEach((w) => {
        if (w.length > 1 && tn.includes(w)) score += 5;
      });
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length) {
    return scored.map((x) => x.t);
  }
  return list.filter((t) => (t.name || "").toLowerCase().includes((nameGuess || "").toLowerCase().trim()));
}

function matchUserMessageToSaleOrderTemplate(message) {
  const list = Array.isArray(saleOrderTemplates) ? saleOrderTemplates : [];
  const raw = String(message).trim();
  const idN = parseInt(raw, 10);
  if (Number.isFinite(idN) && idN > 0) {
    const byId = list.find((t) => Number(t.id) === idN);
    if (byId) return byId;
  }
  const n = normalizeStr(String(message));
  for (const t of list) {
    if (normalizeStr(t.name) === n) return t;
  }
  for (const t of list) {
    if (n.length > 1 && n.includes(normalizeStr(t.name))) return t;
  }
  for (const t of list) {
    if (n.length > 1 && normalizeStr(t.name).includes(n)) return t;
  }
  return null;
}

function isDeclineTemplateMessage(message) {
  const n = normalizeStr(String(message));
  if (n === "no" || n === "n") return true;
  return (
    n.includes("ninguna") ||
    n.includes("sinplant") ||
    n.includes("sinplantilla") ||
    n.includes("sinninguna")
  );
}

async function resolveSaleOrderTemplateOvIntent(odoo, uid, message, session) {
  void odoo;
  void uid;
  if (!saleOrderTemplateIntentTriggers(String(message))) return null;
  const pw = session.pendingWrite;
  if (pw) {
    if (pw.type !== "OV") return null;
    if (pw.step && !["brand", "ov_template_disambig"].includes(pw.step)) return null;
  }
  const token = extractTokenForSOTemplate(message);
  if (!token || token.length < 1) {
    return {
      reply: `Decime con cuál plantilla. Disponibles: ${formatSaleOrderTemplateNameList()}.`,
      options: []
    };
  }
  const matches = findMatchingSaleOrderTemplates(token);
  if (!matches.length) {
    return {
      reply: `No encontré esa plantilla. Las disponibles son: ${formatSaleOrderTemplateNameList()}.`,
      options: []
    };
  }
  if (matches.length === 1) {
    session.pendingWrite = {
      type: "OV",
      step: "brand",
      data: { saleTemplateId: matches[0].id }
    };
    return {
      reply: `Dale, arrancamos la cotización con la plantilla «${matches[0].name}». ¿Qué marca cargamos?`,
      options: []
    };
  }
  const top = matches.slice(0, 3);
  session.pendingWrite = { type: "OV", step: "ov_template_disambig", data: { templateCandidates: top } };
  return {
    reply: "Encontré varias plantillas parecidas. Elegí una (o tocá en pantalla):",
    options: top.map((t) => t.name)
  };
}

function contactQueryTriggers(m) {
  const s = String(m || "");
  if (s.length < 8) return false;
  return (
    /busc[áa]\s+a\b/i.test(s) ||
    /c[oó]mo\s+est[áa]\s+el\s+contacto/i.test(s) ||
    /contacto\s+de/i.test(s) ||
    /tel[ée]fono\s+de/i.test(s) ||
    /datos\s+de/i.test(s) ||
    (/\bcontacto\b/i.test(s) && (/\bmarca\b/i.test(s) || /\bcliente\b/i.test(s)))
  );
}

function primaryTokenForContactMessage(message) {
  const t = String(message || "");
  let m = t.match(
    /(?:busc[áa]\s+a|tel[ée]fono\s+de|datos\s+de|de\s+la\s+ov\s+de|contacto\s+de|el\s+contacto\s+de)\s+["']?([^"'\n?]{2,50})/i
  );
  if (m) return m[1].trim();
  m = t.match(/["']([^"']{2,40})["']/);
  if (m) return m[1].trim();
  m = t.match(/\b(de|a)\s+([A-Za-zÁáÉéÍíÓóÚúÑñ0-9. ]+)$/i);
  if (m) return m[2].split(/\s+/).slice(0, 4).join(" ").trim();
  return "";
}

async function loadChildContactPhones(odoo, uid, companyId) {
  const ch = await odoo.executeKw(
    uid,
    "res.partner",
    "search_read",
    [[["parent_id", "=", companyId], ["is_company", "=", false]]],
    { fields: ["id", "name", "phone", "mobile"], limit: 20 }
  );
  return ch || [];
}

function formatOnePartnerBlock(odoo, uid) {
  return async (p) => {
    const marca = (p.x_studio_marca && String(p.x_studio_marca)) || "—";
    const cat = Array.isArray(p.category_id) ? p.category_id[1] : p.category_id || "—";
    const children = await loadChildContactPhones(odoo, uid, p.id);
    let phoneLine = (p.mobile || p.phone || "").toString() || "—";
    if (children.length) {
      const inner = children
        .map(
          (c) =>
            `    · ${(c.name || "Contacto").trim()}: ${(c.mobile || c.phone || "—").toString().trim() || "—"}`
        )
        .join("\n");
      phoneLine = `empresa: ${(p.mobile || p.phone || "—").toString()}\n  Contactos (WhatsApp):\n${inner}`;
    } else {
      phoneLine = `${p.mobile || p.phone || "—"}`;
    }
    return [
      `▸ ${p.name || "Sin nombre"}`,
      `  Marca (x_studio_marca): ${marca}`,
      `  CUIT/IVA: ${(p.vat || "—").toString()}`,
      `  Empresa: ${p.is_company ? "sí" : "no"}`,
      `  Teléfono: ${phoneLine}`,
      `  Etiquetas: ${cat}`,
      `  Dirección: ${(p.street || "—").toString()}`,
      ""
    ].join("\n");
  };
}

function hasActionIntent(message) {
  const actionWords = [
    "armar",
    "crear",
    "nueva",
    "nuevo",
    "cotizacion",
    "presupuesto",
    "orden",
    "registrar",
    "cargar",
    "agregar",
    "confirmar",
    "mandar",
    "enviar",
    "modificar",
    "cambiar",
    "actualizar",
    "deja"
  ];
  const normalized = String(message || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (actionWords.some((w) => normalized.includes(w))) return true;
  if (/\bov\b/.test(normalized)) return true;
  if (/\bpedido\b/.test(normalized)) return true;
  return false;
}

async function resolveContactQuery(odoo, uid, message) {
  if (hasActionIntent(message)) return null;
  if (!contactQueryTriggers(message)) return null;
  const token = primaryTokenForContactMessage(message) || String(message).replace(/[^\w\sáéíóúñ]/gi, " ").trim();
  if (token.length < 2) {
    return { reply: "Decime el nombre, marca o razón a buscar.", options: [] };
  }
  let partners;
  const fieldsFull = [
    "id",
    "name",
    "phone",
    "mobile",
    "email",
    "street",
    "x_studio_marca",
    "category_id",
    "child_ids",
    "is_company",
    "vat"
  ];
  const fieldsBase = [
    "id",
    "name",
    "phone",
    "mobile",
    "email",
    "street",
    "category_id",
    "child_ids",
    "is_company",
    "vat"
  ];
  try {
    partners = await odoo.executeKw(
      uid,
      "res.partner",
      "search_read",
      [
        [
          ["name", "ilike", token],
          ["is_company", "=", true]
        ]
      ],
      { fields: fieldsFull, limit: 8 }
    );
  } catch (e) {
    try {
      partners = await odoo.executeKw(
        uid,
        "res.partner",
        "search_read",
        [
          [
            ["name", "ilike", token],
            ["is_company", "=", true]
          ]
        ],
        { fields: fieldsBase, limit: 8 }
      );
    } catch (e2) {
      return { reply: "No pude leer el directorio de contactos en ODOO. Revisá la conexión o probá otra búsqueda.", options: [] };
    }
  }
  if (!partners || !partners.length) {
    return { reply: `No encontré empresas con «${token}». Probá otra búsqueda.`, options: [] };
  }
  const fmt = await formatOnePartnerBlock(odoo, uid);
  const blocks = [];
  for (const p of partners) {
    blocks.push(await fmt(p));
  }
  return {
    reply: `Resultados (solo lectura):\n\n${blocks.join("\n")}`,
    options: []
  };
}

async function resolveAmbiguousPaymentV2(message, odoo, uid) {
  const raw = String(message || "");
  const n = normalizeStr(raw);
  if (!/pago|pagcobr/.test(n) && !n.includes("cobr")) return null;
  if (/me pago|me pag[óo]|me dio|me mando|me transfer|entr[oó]|cobr[éeie]/i.test(raw)) return null;
  if (/le pague|le pag[ée]|pague a|pago a|le di|le mande|le transfer/i.test(raw)) return null;
  if (raw.length > 200) return null;
  const nameGuess = primaryTokenForContactMessage(message) || (raw.split(/\s+/).find((w) => w.length > 3) || "").replace(/[.,]/g, "");
  if (nameGuess.length < 2) {
    return {
      reply: "¿Querés registrar un cobro de cliente o un pago a proveedor?",
      options: ["Cobro de cliente", "Pago a proveedor"]
    };
  }
  let hasAr = false;
  let hasPo = false;
  try {
    const ps = await odoo.executeKw(
      uid,
      "res.partner",
      "search_read",
      [[["name", "ilike", nameGuess]]],
      { fields: ["id", "name"], limit: 3 }
    );
    for (const pr of ps || []) {
      const inv = await odoo.executeKw(
        uid,
        "account.move",
        "search_read",
        [[
          ["move_type", "=", "out_invoice"],
          ["state", "=", "posted"],
          ["payment_state", "in", ["not_paid", "partial"]],
          ["partner_id", "child_of", pr.id]
        ]],
        { fields: ["id"], limit: 1 }
      );
      if (inv && inv.length) hasAr = true;
    }
    hasPo = pendingPurchaseOrders.some(
      (po) =>
        normalizeStr(po.partnerName).includes(normalizeStr(nameGuess)) ||
        normalizeStr(po.x_studio_marca || "").includes(normalizeStr(nameGuess))
    );
  } catch {
    return {
      reply: "¿Era un cobro a vos de un cliente o un pago que hiciste a un proveedor?",
      options: ["Cobro de cliente", "Pago a proveedor"]
    };
  }
  if (hasAr && !hasPo) {
    return { reply: `Parece un **cobro de cliente** (hay facturas adeudadas que coinciden con «${nameGuess}»). Confirmá el monto y el diario.`, options: [] };
  }
  if (hasPo && !hasAr) {
    return { reply: `Parece un **pago a proveedor** (hay OCs en curso vinculadas a «${nameGuess}»). Confirmá monto y diario.`, options: [] };
  }
  if (hasAr && hasPo) {
    return {
      reply: "Hay señal de deuda de cliente y de OC con ese nombre. Elegí qué registrar:",
      options: ["Cobro de cliente", "Pago a proveedor"]
    };
  }
  return {
    reply: "No encontré deuda a cobrar ni OC pendiente con ese dato. ¿Era cobro de cliente o pago a proveedor?",
    options: ["Cobro de cliente", "Pago a proveedor"]
  };
}

function detectPriceUpdateIntent(message) {
  const n = normalizeStr(String(message));
  if (n.length < 6) return false;
  if (/\bver listas? de precios?\b/.test(n)) return false;
  if (n.includes("ver lista") && n.includes("preci")) return false;
  return (
    (n.includes("subi") || n.includes("aument") || n.includes("baj") || n.includes("costo") || n.includes("actualiz")) &&
    (n.includes("porciento") || n.includes("peso") || /%|\$/.test(String(message)) || n.includes("ciento"))
  );
}

function parseCostUpdateOperation(message) {
  const s = String(message);
  const pct = s.match(/(\d+(?:[.,]\d+)?)\s*(?:%|porciento|por ciento|\s*cient)/i);
  if (pct) {
    return { kind: "pct", value: parseFloat(pct[1].replace(",", ".")) };
  }
  const mp = s.match(
    /(\$?\s*\d+(?:[.,]\d+)?)\s*(?:p|peso|pesos|ar|ars)\b/i
  );
  if (mp) {
    return { kind: "add", value: Math.abs(parseFloat(mp[1].replace(/[$\s]/g, "").replace(",", ".")) || 0) };
  }
  const mfix = s.match(/(?:\$\s?|\b)(\d+(?:[.,]\d+)?)(?=\s*[\s$]?$)/m);
  if (mfix && s.toLowerCase().includes("peso")) {
    return { kind: "add", value: Math.abs(parseFloat(mfix[1].replace(",", ".")) || 0) };
  }
  return null;
}

function pickScopeTokenForPriceUpdate(message) {
  const n = normalizeStr(String(message));
  for (const sup of allSuppliers) {
    if (sup && n.includes(normalizeStr(sup))) {
      return String(sup);
    }
  }
  return primaryTokenForContactMessage(message) || "";
}

async function loadProductTemplateCostsForIds(odoo, uid, tmplIds) {
  if (!tmplIds.length) return [];
  const rows = await odoo.executeKw(
    uid,
    "product.template",
    "read",
    [Array.from(new Set(tmplIds))],
    { fields: ["id", "name", "standard_price", "categ_id"] }
  );
  return rows || [];
}

async function collectProductTemplatesForPriceScope(odoo, uid, message) {
  const token = pickScopeTokenForPriceUpdate(message);
  if (!token || token.length < 2) {
    return { err: "No identifiqué proveedor, categoría ni producto. Nombralo en el mensaje." };
  }
  const found = new Map();
  const push = (id, name, cost) => {
    if (!id) return;
    if (!found.has(id)) found.set(id, { id, name, cost: Number(cost) || 0 });
  };
  const partnerRows = await odoo.executeKw(
    uid,
    "res.partner",
    "search_read",
    [
      [
        ["name", "ilike", token],
        ["is_company", "=", true]
      ]
    ],
    { fields: ["id", "name"], limit: 20 }
  );
  if (partnerRows && partnerRows.length) {
    const pids = partnerRows.map((p) => p.id);
    const sinfo = await odoo
      .executeKw(
        uid,
        "product.supplierinfo",
        "search_read",
        [[["partner_id", "in", pids]]],
        { fields: ["id", "product_tmpl_id", "partner_id", "name"], limit: 400 }
      )
      .catch(() => []);
    const tmplSet = new Set();
    (sinfo || []).forEach((r) => {
      const t = r.product_tmpl_id;
      if (Array.isArray(t) && t[0]) tmplSet.add(t[0]);
    });
    for (const tid of tmplSet) {
      const r = (await loadProductTemplateCostsForIds(odoo, uid, [tid]))[0];
      if (r) push(r.id, r.name, r.standard_price);
    }
  }
  if (!found.size) {
    const cats = await odoo
      .executeKw(uid, "product.category", "search_read", [[["name", "ilike", token]]], { fields: ["id", "name"], limit: 8 })
      .catch(() => []);
    if (cats && cats.length) {
      const cids = cats.map((c) => c.id);
      const tm = await odoo
        .executeKw(uid, "product.template", "search_read", [[["categ_id", "in", cids], ["sale_ok", "=", true]]], {
          fields: ["id", "name", "standard_price"],
          limit: 200
        })
        .catch(() => []);
      (tm || []).forEach((r) => push(r.id, r.name, r.standard_price));
    }
  }
  if (!found.size) {
    const tm = await odoo
      .executeKw(
        uid,
        "product.template",
        "search_read",
        [
          [
            ["sale_ok", "=", true],
            ["name", "ilike", token]
          ]
        ],
        { fields: ["id", "name", "standard_price"], limit: 80 }
      )
      .catch(() => []);
    (tm || []).forEach((r) => push(r.id, r.name, r.standard_price));
  }
  if (!found.size) {
    return { err: `No encontré productos (costo) asociados a «${token}». Probá con el nombre de proveedor o de categoría tal cual ODOO.` };
  }
  return { list: Array.from(found.values()) };
}

function applyNewCosts(list, op) {
  return list.map((row) => {
    const oldC = Number(row.cost) || 0;
    let newC = oldC;
    if (op.kind === "pct") {
      newC = oldC * (1 + op.value / 100);
    } else {
      newC = oldC + op.value;
    }
    if (newC < 0) newC = 0;
    return { id: row.id, name: row.name, oldCost: oldC, newCost: newC };
  });
}

function formatPriceUpdatePreviewTable(rows) {
  const h = ["Producto", "Costo act.", "Costo nuevo"];
  const trows = rows.map((r) => [r.name.slice(0, 40), r.oldCost.toFixed(2), r.newCost.toFixed(2)]);
  return buildTextTable(h, trows);
}

async function resolvePriceUpdate(odoo, uid, message, session) {
  if (session.pendingPriceUpdate) {
    return continuePriceUpdateFlow(odoo, uid, message, session);
  }
  const raw = String(message);
  const n = normalizeStr(raw);
  const n0 = n;
  // PRECIO UPDATE: solo interceptar si hay verbo de costo + número de ajuste
  // NO interceptar si el mensaje es un presupuesto/cotización/OV
  const hasCostVerb = (
    n0.includes("subi") || n0.includes("aument") || n0.includes("baj") ||
    n0.includes("subieron") || n0.includes("aumentaron") || n0.includes("bajaron")
  );
  const hasAdjustNumber = (/%/.test(raw) || n0.includes("porciento") || n0.includes("porcient"));
  const isOvContext = (
    n0.includes("presupuesto") || n0.includes("cotizacion") ||
    n0.includes("para") || n0.includes("metros") || n0.includes("mts") ||
    n0.includes("rollo") || n0.includes("listafacu") || n0.includes("listaweb") ||
    n0.includes("mitad") || (n0.includes("color") && !n0.includes("costo"))
  );
  const isMassiveConfirm = String(message || "").trim().toLowerCase() === "confirmo masivo";
  const looksRelevant = isMassiveConfirm || (!isOvContext && hasCostVerb && hasAdjustNumber);
  if (!looksRelevant) return null;
  if (/\blistas?\s+de\s+precios?\b/.test(n) && (n.includes("ver") || n.includes("mostrar"))) {
    return {
      reply: "En ODOO: ventas concretas (órdenes) usan listas; el costo lo definís en producto. Desde el chat ajusto solo el costo standard en el producto (estándar) — los precios de lista que dependan de costo se recalculan con las fórmulas de ODOO.",
      options: []
    };
  }
  if (n.includes("actualiz") && n.includes("costo") && raw.length < 48) {
    return { reply: "Bien, decime qué provisión subió, con nombre de proveedor/categoría/producto y monto: ej. Carvi 10% o bolsas de PP 50 pesos.", options: [] };
  }
  if (/\bver listas? de precios?\b/.test(n) || (n.includes("ver lista") && n.includes("preci") && n.length < 50)) {
    return {
      reply: "Listas: en ODOO bajo Ventas ‣ Listas de precios. Desde el chat ajusto costo, no reescribo listas a mano.",
      options: ["Actualizar costo", "Ver listas de precios"]
    };
  }
  if (/\bprecio\b/.test(raw) && !n.includes("costo") && !n.includes("subi") && !n.includes("aument") && !/%|\$|peso|ciento/.test(raw) && raw.length < 100) {
    return {
      reply: "¿Querés actualizar el costo (standard) del producto o mirar listas de precios de venta en ODOO?",
      options: ["Actualizar costo", "Ver listas de precios"]
    };
  }
  const op = parseCostUpdateOperation(message);
  if (!op && !detectPriceUpdateIntent(message) && n.length < 4) {
    return null;
  }
  if (!op) {
    return { reply: "Necesito un número concreto, ej. 8% o $25 al costo unitario, junto a la categoría o proveedor que subió.", options: [] };
  }
  let res;
  try {
    res = await collectProductTemplatesForPriceScope(odoo, uid, message);
  } catch (e) {
    return { reply: `No pude leer productos: ${(e && e.message) || e}`.slice(0, 350), options: [] };
  }
  if (res && res.err) {
    return { reply: res.err, options: [] };
  }
  const rows = applyNewCosts(res.list, op);
  const requiresMassive = rows.length > 10;
  if (rows.length > 200) {
    return { reply: "Son demasiados productos; acotá (proveedor o categoría) y volvé a probar.", options: [] };
  }
  session.pendingPriceUpdate = { step: "confirm", op, requiresMassive, rows, ts: Date.now() };
  if (requiresMassive) {
    const sub = rows.slice(0, 5);
    const txt = formatPriceUpdatePreviewTable(sub);
    return {
      reply:
        `Ajuste de costo (standard) — previo, por cantidad: ${rows.length} producto(s). Mostrando 5:\n\n${txt}\n\n` +
        `… y ${rows.length - 5} más. Escribí exactamente «confirmo masivo» o cancelá (no).`,
      options: ["No, cancelar"]
    };
  }
    return {
      reply: `Ajuste de costo (standard) — impacta ${rows.length} producto(s). ¿Aplico?\n\n${formatPriceUpdatePreviewTable(rows)}`,
    options: ["Sí, aplicar costos", "No, cancelar"]
  };
}

async function continuePriceUpdateFlow(odoo, uid, message, session) {
  const p = session.pendingPriceUpdate;
  if (!p || p.step !== "confirm" || !p.rows) {
    session.pendingPriceUpdate = null;
    return { reply: "Esa no seguía ningún ajuste. Pedime de nuevo con proveedor o categoría y % o pesos.", options: [] };
  }
  if (isNegative(message)) {
    session.pendingPriceUpdate = null;
    return { reply: "Listo, no toco costos. ¿Necesitás otra cosa?", options: [] };
  }
  if (p.requiresMassive) {
    if (String(message || "").trim().toLowerCase() !== "confirmo masivo") {
      return {
        reply: "Escribí exactamente «confirmo masivo» o cancelá con no.",
        options: ["No, cancelar"]
      };
    }
  } else if (!isAffirmative(message)) {
    return { reply: "Decime si o no, o usá un botón.", options: ["Sí, aplicar costos", "No, cancelar"] };
  }
  const okIds = p.rows;
  const wrote = [];
  for (const r of okIds) {
    try {
      await odoo.executeKw(uid, "product.template", "write", [[r.id], { standard_price: r.newCost }]);
      wrote.push(r);
    } catch (e) {
      console.error("write standard_price", e);
    }
  }
  session.pendingPriceUpdate = null;
  if (!wrote.length) {
    return { reply: "No pude actualizar costos. Revisá permisos o probá con menos productos.", options: [] };
  }
  const avg = wrote.reduce((a, b) => a + b.newCost, 0) / wrote.length;
  return {
    reply: `Actualicé ${wrote.length} producto(s) en el costo standard. Costo promedio nuevo: $${avg.toFixed(2)}. Revisá márgenes en ODOO.`,
    options: []
  };
}

async function runPreLlmChain(message, session, moduleHint = "FULL") {
  let odoo;
  let uid;
  try {
    validateEnv();
    odoo = createOdooClient();
    uid = await odoo.authenticate();
  } catch {
    return null;
  }
  const one = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error("runPreLlmChain", (e && e.message) || e);
      return null;
    }
  };
  let r;
  const mod = String(moduleHint || "FULL").toUpperCase();

  if (mod === "PAGOS") {
    return one(() => resolveAmbiguousPaymentV2(message, odoo, uid));
  }
  if (mod === "RECEPCIONES") {
    return one(() => resolvePendingOrdersReport(message));
  }
  if (mod === "VENTAS") {
    r = await one(() => resolveGenerarPropuestaFromChat(odoo, uid, message, session));
    if (r) return r;
    r = await one(() => resolveSaleOrderTemplateOvIntent(odoo, uid, message, session));
    if (r) return r;
    return one(() => resolveContactQuery(odoo, uid, message));
  }
  if (mod === "COMPRAS") {
    r = await one(() => resolvePendingOrdersReport(message));
    if (r) return r;
    r = await (async () => {
      const t = tryStartModOcIfPattern(message, session);
      if (t && t._async) return await t._async;
      return t;
    })();
    if (r) return r;
    return null;
  }
  if (mod === "REPORTES") {
    r = await one(() => resolveDirectQueries(message));
    if (r) return r;
    r = await one(() => resolveReportQuery(message, odoo, uid));
    if (r) return r;
    r = await one(() => resolvePendingOrdersReport(message));
    if (r) return r;
    return one(() => resolveStatsQuery(message, odoo, uid));
  }
  if (mod === "PRECIOS") {
    return one(() => resolvePriceUpdate(odoo, uid, message, session));
  }

  return null;
}

function tryStartModOcIfPattern(message, session) {
  if (session.pendingModOc) return null;
  const n = normalizeStr(message);
  if (!/p0\d+/i.test(message) && !n.includes("posterg")) return null;
  const mPo = String(message).match(/\bP0\d+\b/i);
  if (!mPo) return null;
  const poName = mPo[0].toUpperCase();
  const d = String(message).match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
  const postponeM = n.match(/posterg[aei]*\s*(\d+)\s*d/);
  if (!d && !postponeM) return null;
  return {
    _async:
      (async () => {
        let newDate;
        if (d) {
          const pd = parseDateDdMmYyyy(d[0]);
          if (pd) newDate = formatDateIsoLocal(pd);
        } else if (postponeM) {
          const add = parseInt(postponeM[1], 10) || 0;
          if (add > 0) {
            const t = new Date();
            t.setDate(t.getDate() + add);
            newDate = formatDateIsoLocal(t);
          }
        }
        if (!newDate) {
          return {
            reply: "No pude leer la nueva fecha. Pasala como DD/MM o DD/MM/AAAA.",
            options: []
          };
        }
        const prep = await prepareModOcConfirm(session, poName, newDate, message);
        return prep;
      })()
  };
}

async function prepareModOcConfirm(session, poName, newDate, message) {
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const pos = await odoo.executeKw(
    uid,
    "purchase.order",
    "search_read",
    [[["name", "=", poName]]],
    { fields: ["id", "name", "date_planned"], limit: 1 }
  );
  if (!pos.length) {
    return { reply: `No encontré la ${poName} en ODOO. Revisá el nombre.`, options: [] };
  }
  const lineIds = await odoo.executeKw(
    uid,
    "purchase.order.line",
    "search",
    [[["order_id", "=", pos[0].id]]]
  );
  const linesR = lineIds.length
    ? await odoo.executeKw(
        uid,
        "purchase.order.line",
        "search_read",
        [[["id", "in", lineIds]]],
        { fields: ["id", "date_planned"], limit: 200 }
      )
    : [];
  const firstLine = linesR[0];
  const oldPlanned = firstLine?.date_planned
    ? String(firstLine.date_planned).slice(0, 10)
    : (pos[0].date_planned && String(pos[0].date_planned).slice(0, 10)) || "(sin planificar en línea)";
  session.pendingModOc = {
    step: "confirm",
    poName,
    newDate,
    lineIds: linesR.map((l) => l.id).filter(Boolean),
    oldPlanned: oldPlanned
  };
  return {
    reply:
      `${poName}: fecha planificada actual en la línea: ${oldPlanned} → nueva: ${newDate}.\n` +
      "¿Confirmás el cambio en las líneas de la OC?",
    options: ["Sí, confirmar", "No, cancelar"]
  };
}

async function continueModOcDateFlow(session, message) {
  const p = session.pendingModOc;
  if (!p) {
    return { reply: "No hay un cambio de fecha pendiente.", options: [] };
  }
  if (isNegative(message)) {
    session.pendingModOc = null;
    return { reply: "Dale, no cambié nada. ¿Otra consulta?", options: [] };
  }
  if (p.step === "confirm") {
    if (!isAffirmative(message)) {
      return {
        reply: "Necesito un sí o no para tocar la OC.",
        options: ["Sí, confirmar", "No, cancelar"]
      };
    }
    return executeModOcDateWrite(session);
  }
  session.pendingModOc = null;
  return { reply: "Esto no aplica, seguí por otro lado.", options: [] };
}

async function executeModOcDateWrite(session) {
  const p = session.pendingModOc;
  session.pendingModOc = null;
  if (!p || p.step !== "confirm" || !p.lineIds || !p.lineIds.length) {
    return { reply: "Faltan datos del cambio de OC.", options: [] };
  }
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  try {
    for (const lid of p.lineIds) {
      await odoo.executeKw(uid, "purchase.order.line", "write", [
        [lid],
        { date_planned: p.newDate + " 12:00:00" }
      ]);
    }
  } catch (e) {
    return { reply: `No pude actualizar la OC: ${(e && e.message) || e}`, options: [] };
  }
  try {
    await loadPendingPurchaseOrders();
  } catch (_) {
    /* no bloquea */
  }
  return {
    reply: `Listo, actualicé la fecha planificada de ${p.poName} a ${p.newDate} en las líneas.`,
    options: []
  };
}

function tryStartCreditAdjustIfPattern(message, session) {
  if (session.creditAdjust) return null;
  const n = normalizeStr(message);
  const isAdjust =
    n.includes("debecero") ||
    n.includes("debe0") ||
    n.includes("nodebenada") ||
    n.includes("yapagotodo") ||
    n.includes("nopagana") ||
    (n.includes("debe") && n.includes("cero")) ||
    (n.includes("ajust") && n.includes("deuda"));
  if (!isAdjust) return null;
  return {
    _async: (async () => {
      const name = extractNameForAccountAdjust(String(message));
      if (!name) {
        return { reply: "No entendí a quién referís. Decime el nombre o razón social a ajustar.", options: [] };
      }
      return loadCreditAdjustPreview(session, name);
    })()
  };
}

function extractNameForAccountAdjust(msg) {
  const raw = String(msg || "");
  const dc = raw.match(/^(.+?)\s+debe\s+cero\b/i);
  if (dc) {
    return dc[1].replace(/[.,;]+$/g, "").trim();
  }
  let t = raw
    .replace(/^\s*ajust[aá]\s+la\s+deuda\s+de\s+/i, "")
    .replace(/^\s*ajust[aá]\s+/i, "")
    .replace(/\b(debe|deber)\s+0\b/i, " ")
    .replace(/\bdebe\s+cero\b/i, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) {
    const m = raw.match(/[“\"']([^"']+)[“\"']/);
    if (m) t = m[1].trim();
  }
  if (t && t.length > 1) return t;
  return "";
}

function buildCreditAdjustConfirm(session, partner, invoices) {
  const total = invoices.reduce((a, b) => a + Number(b.amount_residual || 0), 0);
  if (total <= 0) {
    return { empty: true, reply: `${partner.name} no tiene deuda en facturas abiertas.`, options: [] };
  }
  const nInv = invoices.length;
  const requiresMassive = nInv > 10;
  const preview = invoices.slice(0, requiresMassive ? 5 : nInv);
  const lines = preview.map(
    (inv) => ` · ${inv.name}: $${Number(inv.amount_residual).toFixed(2)}`
  );
  const extra = requiresMassive
    ? `\n…y ${nInv - 5} facturas más. Total residual: $${total.toFixed(2)}.`
    : "";
  session.creditAdjust = {
    step: "confirm",
    partnerId: partner.id,
    partnerName: partner.name,
    amount: total,
    invoiceCount: nInv,
    requiresMassive,
    invoices
  };
  if (requiresMassive) {
    return {
      reply: `Deuda de ${partner.name}:\n${lines.join("\n")}${extra}\n\nPara el borrador de nota de crédito: escribí exactamente «confirmo masivo» o tocá no.`,
      options: ["No, cancelar"]
    };
  }
  return {
    reply:
      `Deuda de ${partner.name}:\n${lines.join("\n")}\nTotal: $${total.toFixed(2)} en ${nInv} factura(s).\n` +
      "¿Confirmás crear una nota de crédito (borrador) por ese monto exacto?",
    options: ["Sí, crear nota de crédito", "No, cancelar"]
  };
}

async function loadCreditAdjustPreview(session, nameFragment) {
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const partners = await odoo.executeKw(
    uid,
    "res.partner",
    "search_read",
    [[["name", "ilike", nameFragment]]],
    { fields: ["id", "name", "parent_id"], limit: 5 }
  );
  if (!partners.length) {
    return { reply: `No encontré contacto con "${nameFragment}". Probá otra búsqueda.`, options: [] };
  }
  if (partners.length > 1) {
    session.creditAdjust = { step: "pick_partner", partners, nameQuery: nameFragment };
    return {
      reply: "Encontré varios contactos. Elegí el correcto o tocá un nombre en pantalla.",
      options: partners.slice(0, 3).map((p) => p.name)
    };
  }
  const partner = partners[0];
  const invoices = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "in", ["not_paid", "partial"]],
      ["partner_id", "child_of", partner.id]
    ]],
    { fields: ["id", "name", "amount_residual"], limit: 200 }
  );
  const out = buildCreditAdjustConfirm(session, partner, invoices);
  if (out.empty) {
    return { reply: out.reply, options: out.options || [] };
  }
  return { reply: out.reply, options: out.options || [] };
}

async function continueCreditAdjustFlow(session, message) {
  const c = session.creditAdjust;
  if (!c) return { reply: "No hay ajuste pendiente.", options: [] };
  if (c.step === "pick_partner") {
    if (isNegative(message)) {
      session.creditAdjust = null;
      return { reply: "Listo, cancelo el ajuste.", options: [] };
    }
    const hit = (c.partners || []).find(
      (p) => normalizeStr(p.name) === normalizeStr(message) || String(message).includes(p.name)
    );
    if (!hit) {
      return {
        reply: "Elegí una de las opciones o escribí el nombre tal cual.",
        options: (c.partners || []).slice(0, 3).map((p) => p.name)
      };
    }
    return loadCreditAdjustForPartnerId(session, hit.id);
  }
  if (c.step === "confirm") {
    if (isNegative(message)) {
      session.creditAdjust = null;
      return { reply: "Listo, no hago el ajuste. ¿Necesitás otra cosa?", options: [] };
    }
    if (c.requiresMassive) {
      if (String(message || "").trim().toLowerCase() === "confirmo masivo") {
        return createCreditNoteDraftForPartner(session, c);
      }
      return {
        reply: "Escribí exactamente «confirmo masivo» o cancelá (no) para no tocar nada.",
        options: ["No, cancelar"]
      };
    }
    if (isAffirmative(message)) {
      return createCreditNoteDraftForPartner(session, c);
    }
    return {
      reply: "¿Confirmo la nota de crédito? Decime sí o no.",
      options: ["Sí, crear nota de crédito", "No, cancelar"]
    };
  }
  session.creditAdjust = null;
  return { reply: "Caso cerrado. ¿Otra consulta?", options: [] };
}

async function loadCreditAdjustForPartnerId(session, partnerId) {
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const pRow = await odoo.executeKw(
    uid,
    "res.partner",
    "read",
    [[partnerId]],
    { fields: ["id", "name"] }
  );
  const partner = (pRow && pRow[0]) || { id: partnerId, name: "Cliente" };
  const invoices = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "in", ["not_paid", "partial"]],
      ["partner_id", "child_of", partnerId]
    ]],
    { fields: ["id", "name", "amount_residual"], limit: 200 }
  );
  const out = buildCreditAdjustConfirm(session, partner, invoices);
  if (out.empty) {
    session.creditAdjust = null;
    return { reply: out.reply, options: out.options || [] };
  }
  return { reply: out.reply, options: out.options || [] };
}

async function createCreditNoteDraftForPartner(session, data) {
  session.creditAdjust = null;
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const partner = await odoo.executeKw(
    uid,
    "res.partner",
    "read",
    [[data.partnerId]],
    { fields: ["property_account_receivable_id", "id", "name"] }
  );
  const p = (partner && partner[0]) || null;
  if (!p) return { reply: "No pude leer el contacto.", options: [] };
  const acc = Array.isArray(p.property_account_receivable_id)
    ? p.property_account_receivable_id[0]
    : p.property_account_receivable_id;
  const amount = Number(data.amount || 0);
  if (!acc || !amount) {
    return { reply: "Faltan datos de cuenta o monto para el asiento. Revisá en ODOO.", options: [] };
  }
  try {
    const moveId = await odoo.executeKw(uid, "account.move", "create", [
      {
        move_type: "out_refund",
        partner_id: p.id,
        invoice_date: formatDateIsoLocal(new Date()),
        invoice_line_ids: [
          [
            0,
            0,
            {
              name: "Ajuste de cuenta (asistente)",
              quantity: 1,
              price_unit: amount,
              account_id: acc
            }
          ]
        ]
      }
    ]);
    const move = await odoo.executeKw(
      uid,
      "account.move",
      "read",
      [[moveId]],
      { fields: ["name"], limit: 1 }
    );
    return {
      reply: `Listo, generé nota de crédito en borrador ${move[0].name} por $${amount.toFixed(2)} para ${p.name}.\nRevisá y validá en ODOO.`,
      options: []
    };
  } catch (e) {
    return {
      reply:
        `No pude crear la nota automáticamente: ${(e && e.message) || e}.\n` +
        "Podés hacer el ajuste desde ODOO (nota de crédito manual).",
      options: []
    };
  }
}

async function resolveReportQuery(message, odooIn, uidIn) {
  if (hasActionIntent(message)) return null;
  let odoo = odooIn;
  let uid = uidIn;
  if (!odoo || !uid) {
    try {
      validateEnv();
      odoo = createOdooClient();
      uid = await odoo.authenticate();
    } catch {
      return null;
    }
  }
  const n = normalizeStr(String(message));
  if (!n) return null;
  const wantsMedia = /\b(foto|pdf|export|imprimir|jpe?g|png|excel|xls)\b/i.test(message);
  if (
    n.includes("cuentasacobrar") ||
    n.includes("cuentasporcobrar") ||
    n.includes("quienmedebe") ||
    n.includes("reportededeudas") ||
    n.includes("deudores") ||
    (n.includes("reportecuentas") && n.includes("cobr")) ||
    (n.includes("deuda") && n.includes("cliente") && n.includes("total"))
  ) {
    if (wantsMedia) {
      return {
        reply:
          "Solo tengo el reporte en texto por ahora. Más adelante se puede exportar. Te mando el resumen ahora.",
        options: []
      };
    }
    return reportCuentasCobrarOtp(odoo, uid);
  }
  if (n.includes("cuentasapagar") || n.includes("cuentasporpagar") || n.includes("quedebo") || (n.includes("deuda") && n.includes("proveed"))) {
    if (wantsMedia) {
      return {
        reply: "Solo tengo el reporte en texto por ahora. Más adelante se puede exportar.",
        options: []
      };
    }
    return reportCuentasPagarOtp(odoo, uid);
  }
  if (n.includes("cajadehoy") || (n.includes("caja") && (n.includes("hoy") || n.includes("semana") || n.includes("entro")))) {
    if (wantsMedia) {
      return { reply: "El reporte de caja es solo texto ahora. Exportación: próximamente.", options: [] };
    }
    return reportCajaOtpFromMessage(String(message), odoo, uid);
  }
  if (n.includes("caja") && (n.includes("reporte") || n.includes("movim") || n.includes("resumen") || n.includes("flujo") || n.includes("periodo") || n.includes("cuantoentro") || n.includes("mercadopago") || n.includes("saldo"))) {
    if (wantsMedia) {
      return { reply: "El reporte de caja es solo texto ahora. Exportación: próximamente.", options: [] };
    }
    return reportCajaOtpFromMessage(String(message), odoo, uid);
  }
  if (n.includes("reporte") && n.includes("caja")) {
    if (wantsMedia) {
      return { reply: "El reporte de caja es solo texto ahora. Exportación: próximamente.", options: [] };
    }
    return reportCajaOtpFromMessage(String(message), odoo, uid);
  }
  return null;
}

async function reportCuentasCobrarOtp(odoo, uid) {
  const moves = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "in", ["not_paid", "partial"]]
    ]],
    { fields: ["partner_id", "amount_residual"], limit: 2000 }
  );
  const byP = new Map();
  for (const m of moves) {
    const p = Array.isArray(m.partner_id) ? m.partner_id[1] : "Cliente";
    byP.set(p, (byP.get(p) || 0) + Number(m.amount_residual || 0));
  }
  const arr = [...byP.entries()].map(([name, debt]) => ({ name, debt: Number(debt) || 0 }));
  arr.sort((a, b) => b.debt - a.debt);
  const total = arr.reduce((a, b) => a + b.debt, 0);
  const t = buildTextTable(
    ["CLIENTE", "DEUDA"],
    arr.map((x) => [x.name, `$${x.debt.toFixed(2)}`])
  );
  return { reply: `Cuentas a cobrar (pendiente)\n\n${t}\n\nTotal: $${total.toFixed(2)}`, options: [] };
}

async function reportCuentasPagarOtp(odoo, uid) {
  const moves = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "in_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "in", ["not_paid", "partial"]]
    ]],
    { fields: ["partner_id", "amount_residual"], limit: 2000 }
  );
  const byP = new Map();
  for (const m of moves) {
    const p = Array.isArray(m.partner_id) ? m.partner_id[1] : "Proveedor";
    byP.set(p, (byP.get(p) || 0) + Number(m.amount_residual || 0));
  }
  const arr = [...byP.entries()].map(([name, debt]) => ({ name, debt: Number(debt) || 0 }));
  arr.sort((a, b) => b.debt - a.debt);
  const total = arr.reduce((a, b) => a + b.debt, 0);
  const t = buildTextTable(
    ["PROVEEDOR", "DEUDA"],
    arr.map((x) => [x.name, `$${x.debt.toFixed(2)}`])
  );
  return { reply: `Cuentas a pagar (pendiente)\n\n${t}\n\nTotal: $${total.toFixed(2)}`, options: [] };
}

function startOfThisMonth() {
  const t = new Date();
  t.setDate(1);
  return formatDateIsoLocal(t);
}

function parseCajaMessageDates(message) {
  const s = String(message);
  const m1 = s.match(/desde\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  const m2 = s.match(/hasta\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  return {
    from: m1 ? parseDateDdMmYyyy(m1[1]) : new Date(startOfThisMonth() + "T00:00:00"),
    to: m2 ? parseDateDdMmYyyy(m2[1]) : new Date()
  };
}

async function reportCajaOtpFromMessage(message, odooIn, uidIn) {
  const { from, to } = parseCajaMessageDates(message);
  const f = formatDateIsoLocal(from);
  const t = formatDateIsoLocal(to);
  let odoo = odooIn;
  let uid = uidIn;
  if (!odoo || !uid) {
    try {
      validateEnv();
      odoo = createOdooClient();
      uid = await odoo.authenticate();
    } catch (e) {
      return { reply: e.message, options: [] };
    }
  }
  const jmap = await getJournalIdSetForCaja(odoo, uid);
  const jids = [...jmap.values()];
  if (!jids.length) {
    return { reply: "No pude mapear los diarios (Cash, Banco Santander Milito, MercadoPago).", options: [] };
  }
  const pays = await odoo.executeKw(
    uid,
    "account.payment",
    "search_read",
    [[
      ["date", ">=", f],
      ["date", "<=", t],
      ["journal_id", "in", jids],
      ["state", "=", "posted"]
    ]],
    { fields: ["date", "partner_id", "ref", "amount", "payment_type", "journal_id", "name"], limit: 2000 }
  );
  const byJ = new Map();
  for (const jn of ALLOWED_JOURNALS) {
    byJ.set(jn, { rows: [], sub: 0 });
  }
  for (const p of pays) {
    const jn = (Array.isArray(p.journal_id) ? p.journal_id[1] : "Diario") || "Diario";
    if (!ALLOWED_JOURNALS.includes(String(jn))) continue;
    const g = byJ.get(jn) || { rows: [], sub: 0 };
    const contact = Array.isArray(p.partner_id) ? p.partner_id[1] : "";
    const m = Math.abs(Number(p.amount || 0));
    const conc = (p.ref || p.name || "").toString().slice(0, 50);
    g.rows.push([p.date, contact, conc, `$${m.toFixed(2)}`, jn]);
    g.sub += m;
    byJ.set(jn, g);
  }
  let text = `Caja (pagos) ${f} → ${t}\n\n`;
  for (const jn of ALLOWED_JOURNALS) {
    const b = byJ.get(jn);
    if (!b || !b.rows.length) continue;
    text += `--- ${jn} (subtotal $${b.sub.toFixed(2)}) ---\n`;
    text += buildTextTable(["FECHA", "CONTACTO", "CONCEPTO", "MONTO", "DIARIO"], b.rows) + "\n\n";
  }
  if (text.length < 80) text += "No hay pagos en ese rango (diarios permitidos, estado publicado).";
  return { reply: text.trim(), options: [] };
}

function parseStatsPeriodForMessage(message) {
  const s = String(message);
  const n = normalizeStr(s);
  const y = new Date().getFullYear();
  if (n.includes("estasemana")) {
    const t = new Date();
    const day = t.getDay() || 7;
    const from = new Date(t);
    from.setDate(t.getDate() - (day - 1));
    return { from, to: new Date(), label: "esta semana" };
  }
  if (n.includes("estean") || n.includes("esteao")) {
    return { from: new Date(y, 0, 1), to: new Date(), label: "este año" };
  }
  if (n.includes("estemes") || n.includes("comovames") || n.includes("elmes")) {
    return { from: new Date(new Date().getFullYear(), new Date().getMonth(), 1), to: new Date(), label: "este mes" };
  }
  const months = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };
  const mesR = s.match(
    /(?:^|\s)en\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(\d{4}))?/i
  );
  if (mesR) {
    const mo = months[mesR[1].toLowerCase()];
    if (mo != null) {
      const yy = mesR[2] ? parseInt(mesR[2], 10) : y;
      const from = new Date(yy, mo, 1);
      const to = new Date(yy, mo + 1, 0, 23, 59, 59, 999);
      return { from, to, label: mesR[0].trim() };
    }
  }
  const m1 = s.match(/desde\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  const m2 = s.match(/hasta\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  const from = m1
    ? parseDateDdMmYyyy(m1[1])
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = m2 ? parseDateDdMmYyyy(m2[1]) : new Date();
  return { from, to, label: "período indicado" };
}

async function resolveStatsQuery(message, odooIn, uidIn) {
  if (hasActionIntent(message)) return null;
  const n = normalizeStr(String(message));
  if (!n) return null;
  const isStats =
    n.includes("margen") ||
    n.includes("gananc") ||
    n.includes("gan") ||
    n.includes("rentabilidad") ||
    n.includes("cashflow") ||
    n.includes("flujodecaja") ||
    n.includes("cuantofactur") ||
    n.includes("comovames") ||
    n.includes("cobr") ||
    n.includes("saldo") && n.includes("caja") ||
    n.includes("estadis") ||
    n.includes("oportunidad");
  if (!isStats) return null;
  let odoo = odooIn;
  let uid = uidIn;
  if (!odoo || !uid) {
    try {
      validateEnv();
      odoo = createOdooClient();
      uid = await odoo.authenticate();
    } catch (e) {
      return { reply: e.message, options: [] };
    }
  }
  return buildStatsOtpForMessage(String(message), odoo, uid);
}

async function buildStatsOtpForMessage(message, odoo, uid) {
  const { from, to, label } = parseStatsPeriodForMessage(message);
  const d1 = formatDateIsoLocal(from);
  const d2 = formatDateIsoLocal(to);
  const outInv = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["invoice_date", ">=", d1],
      ["invoice_date", "<=", d2]
    ]],
    { fields: ["amount_untaxed", "amount_total", "amount_residual", "payment_state", "invoice_date"], limit: 5000 }
  );
  const inInv = await odoo.executeKw(
    uid,
    "account.move",
    "search_read",
    [[
      ["move_type", "=", "in_invoice"],
      ["state", "=", "posted"],
      ["invoice_date", ">=", d1],
      ["invoice_date", "<=", d2]
    ]],
    { fields: ["amount_untaxed", "amount_total", "invoice_date"], limit: 5000 }
  );
  const jmap = await getJournalIdSetForCaja(odoo, uid);
  const jids = [...jmap.values()];
  const payRows = jids.length
    ? await odoo.executeKw(
        uid,
        "account.payment",
        "search_read",
        [[
          ["date", ">=", d1],
          ["date", "<=", d2],
          ["state", "=", "posted"],
          ["journal_id", "in", jids]
        ]],
        { fields: ["amount", "journal_id"], limit: 5000 }
      )
    : [];
  const facturado = outInv.reduce((a, b) => a + Number(b.amount_untaxed != null ? b.amount_untaxed : b.amount_total || 0), 0);
  const cobradoF = outInv
    .filter((b) => (b.payment_state || "") === "paid" || (Number(b.amount_residual || 0) < 0.5 && Number(b.amount_total) > 0))
    .reduce((a, b) => a + Number(b.amount_total || 0), 0);
  const cobradoAprox = outInv.reduce(
    (a, b) => a + (Number(b.amount_total || 0) - Number(b.amount_residual || 0)),
    0
  );
  const porCobrar = outInv.reduce((a, b) => a + Number(b.amount_residual || 0), 0);
  const compras = inInv.reduce((a, b) => a + Number(b.amount_untaxed != null ? b.amount_untaxed : b.amount_total || 0), 0);
  const margen = facturado - compras;
  const margenPct = facturado > 0 ? ((margen / facturado) * 100).toFixed(1) : "0.0";
  const efe = { Cash: 0, "Banco Santander Milito": 0, MercadoPago: 0 };
  for (const p of payRows) {
    const jn = (Array.isArray(p.journal_id) ? p.journal_id[1] : "") || "";
    if (efe[jn] == null) continue;
    efe[jn] += Math.abs(Number(p.amount || 0));
  }
  return {
    reply:
      `💰 RESUMEN ${label} (${d1} a ${d2})\n` +
      `─────────────────────\n` +
      `Facturado:     $${facturado.toFixed(2)}\n` +
      `Cobrado (aprox.):   $${cobradoAprox.toFixed(2)}\n` +
      `Por cobrar:    $${porCobrar.toFixed(2)}\n` +
      `─────────────────────\n` +
      `Compras:       $${compras.toFixed(2)}\n` +
      `─────────────────────\n` +
      `Margen bruto:  $${margen.toFixed(2)} (${margenPct}%)\n` +
      `─────────────────────\n` +
      `SALDOS DE CAJA (pagos en período, por diario)\n` +
      `Efectivo:      $${efe["Cash"].toFixed(2)}\n` +
      `Santander:     $${efe["Banco Santander Milito"].toFixed(2)}\n` +
      `MercadoPago:   $${efe["MercadoPago"].toFixed(2)}\n` +
      `\n⚠️ Los egresos no sistematizados (gastos fijos, sueldos, etc.) no están incluidos. El margen real puede ser menor.\n` +
      `(Cobrado "paid" estricto en líneas: ~$${cobradoF.toFixed(2)})`,
    options: []
  };
}

function dateToDdMmYyyy(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  const dd = String(t.getDate()).padStart(2, "0");
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${t.getFullYear()}`;
}

function resolvePendingOrderTriggers(message) {
  const n = normalizeStr(String(message));
  if (!n) return false;
  return (
    (n.includes("pendientes") && (n.includes("producc") || n.includes("entreg") || n.includes("pedido") || n.includes("mercader"))) ||
    n.includes("quemeentreg") ||
    n.includes("damelospedid") ||
    n.includes("reporteproducc") ||
    n.includes("quedebe") ||
    (n.includes("proximos") && n.includes("entreg")) ||
    (n.includes("vencen") && n.includes("dias")) ||
    n.includes("vencidos") ||
    (n.includes("reporte") && n.includes("entreg") && n.includes("producc")) ||
    n.includes("proximoaentreg")
  );
}

function parsePendingReportFilters(msg) {
  const s = String(msg);
  const n = normalizeStr(s);
  const d = s.match(/(\d{1,2})\s*d[ií]as?/i);
  const withinDays = d ? Math.min(365, Math.max(1, parseInt(d[1], 10))) : null;
  const partnerHint = s.match(
    /(?:pedidos?|entregas?|de|por|proveedor)\s+de\s+([A-Za-zÁáÉéÍíÓóÚúÑñ0-9. ]+?)(?=\s*$|\s+venc)/i
  );
  const marca = s.match(/(?:cliente|marca|quedebe)\s+([A-Za-zÁáÉéÍíÓóÚúÑñ0-9. ]{2,})/i);
  const thisWeek = n.includes("estasemana");
  const vencidos = n.includes("vencidos");
  return { withinDays, partner: partnerHint ? partnerHint[1].trim() : "", marca: marca ? marca[1].trim() : "", thisWeek, vencidos };
}

function resolvePendingOrdersReport(message) {
  if (hasActionIntent(message)) return null;
  if (!resolvePendingOrderTriggers(message) && !normalizeStr(message).includes("quemedebe")) {
    if (!normalizeStr(message).includes("producc") && !normalizeStr(message).includes("entreg") && !normalizeStr(message).includes("quedebe")) {
      return null;
    }
  }
  return buildPendingOrdersOtpFromMessage(String(message));
}

function linesPendingFromPoLine(line) {
  return Math.max(0, Number(line.product_qty || 0) - Number(line.qty_received || 0));
}

function buildPendingOrdersOtpFromMessage(message) {
  if (!pendingPurchaseOrders.length) {
    return { reply: "Todavía no tengo OCs en caché. Esperá unos minutos a que sincronice o recargá la página.", options: [] };
  }
  const f = parsePendingReportFilters(message);
  const n = normalizeStr(message);
  const groupByProvider = n.includes("divididoporproveed") || n.includes("porproveed");
  const partnerSlice = f.partner;
  const marcaF = f.marca;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let deadline = null;
  if (f.withinDays) {
    const t = new Date();
    t.setDate(t.getDate() + f.withinDays);
    deadline = t;
  }
  if (f.thisWeek) {
    const t = new Date();
    t.setDate(t.getDate() + 7);
    deadline = t;
  }
  const rowsOut = [];
  for (const po of pendingPurchaseOrders) {
    const supplierName = (po.partnerName || "").trim();
    if (partnerSlice && !normalizeStr(supplierName).includes(normalizeStr(partnerSlice))) continue;
    const marca = (po.x_studio_marca || "").trim() || (po.x_studio_documento_relacionado || "").trim() || "—";
    if (marcaF && !normalizeStr(marca).includes(normalizeStr(marcaF))) continue;
    for (const ln of po.lines || []) {
      const pend = linesPendingFromPoLine(ln);
      if (pend <= 0) continue;
      let dp = null;
      if (ln.date_planned) dp = new Date(ln.date_planned);
      if (f.vencidos) {
        if (!dp || dp.getTime() >= now.getTime()) continue;
      }
      if (deadline && dp) {
        const dpe = new Date(dp);
        dpe.setHours(23, 59, 59, 999);
        if (dpe.getTime() > deadline.getTime()) continue;
      }
      const productTuple = Array.isArray(ln.product_id) ? ln.product_id : [];
      const productLabel = String(
        (productTuple[1] || ln.name || "Producto").replace(/^\[.*?\]\s*/, "")
      );
      const unit = Number(ln.price_unit || 0);
      const st = unit * pend;
      rowsOut.push({
        prov: supplierName,
        po: po.name,
        cli: marca,
        prod: productLabel,
        pend,
        unit,
        subtotal: st,
        d: dateToDdMmYyyy(dp || new Date())
      });
    }
  }
  rowsOut.sort((a, b) => {
    const parse = (r) => {
      const p = (r.d || "").split("/");
      if (p.length < 3) return 0;
      return new Date(`${p[2]}-${p[1]}-${p[0]}`).getTime();
    };
    return parse(a) - parse(b);
  });
  if (!rowsOut.length) {
    return { reply: "No hay líneas con cantidad pendiente en caché bajo esos criterios.", options: [] };
  }
  if (groupByProvider) {
    const byP = new Map();
    for (const r of rowsOut) {
      if (!byP.has(r.prov)) byP.set(r.prov, []);
      byP.get(r.prov).push(r);
    }
    let text = "Pedidos en producción (caché) — por proveedor\n\n";
    let grand = 0;
    for (const [prov, ar] of byP) {
      const subG = ar.reduce((a, b) => a + b.subtotal, 0);
      grand += subG;
      text += `── ${String(prov).toUpperCase()} ─────────\n`;
      for (const r of ar) {
        text += `${r.po} | ${r.cli} | ${r.prod.slice(0, 40)} | pend ${r.pend} | p.u. $${r.unit.toFixed(2)} | $${r.subtotal.toFixed(2)} | ${r.d}\n`;
      }
      text += `Subtotal ${prov}: $${subG.toFixed(2)}\n\n`;
    }
    text += `TOTAL GENERAL: $${grand.toFixed(2)}`;
    return { reply: text.trim(), options: [] };
  }
  const h = ["OC", "PROV", "CLIENTE", "PRODUCTO", "PEND", "PRECIO", "TOTAL", "FECHA"];
  const trows = rowsOut.map((r) => [
    r.po,
    r.prov,
    r.cli,
    r.prod.slice(0, 30),
    r.pend,
    r.unit.toFixed(2),
    r.subtotal.toFixed(2),
    r.d
  ]);
  return { reply: `Pedidos / entregas pendientes (caché, orden por fecha planificada):\n\n${buildTextTable(h, trows)}`, options: [] };
}


async function readProductTemplateMinQty(odoo, uid, templateId) {
  try {
    const rows = await odoo.executeKw(
      uid,
      "product.template",
      "read",
      [[templateId]],
      { fields: ["x_studio_minimo", "id"] }
    );
    const v = rows && rows[0] && rows[0].x_studio_minimo;
    if (v != null && Number(v) > 0) return Number(v);
  } catch {
    /* campo opcional */
  }
  const tryFields = [
    ["min_qty", "x_studio_min_qty", "x_studio_moq", "x_studio_moq"],
    ["min_qty", "x_studio_min_cantidad"]
  ];
  for (const fields of tryFields) {
    try {
      const rows = await odoo.executeKw(
        uid,
        "product.template",
        "read",
        [[templateId]],
        { fields: [...fields, "id"] }
      );
      const row = (rows && rows[0]) || {};
      for (const f of fields) {
        const v = row[f];
        if (v != null && Number(v) > 0) return Number(v);
      }
    } catch {
      // ignore missing fields
    }
  }
  return 0;
}

async function getTopProductCategoryChoices(odoo, uid) {
  const c = await odoo.executeKw(
    uid,
    "product.category",
    "search_read",
    [[]],
    { fields: ["id", "name", "parent_id", "child_id"], limit: 6, order: "id desc" }
  );
  const list = c || [];
  return list.slice(0, 3).map((x) => ({ id: x.id, name: x.name || "Categoría" }));
}

async function executeBuscarContactoAction(data) {
  const nameFragment = String((data && data.nameFragment) || (data && data.name) || "").trim();
  if (!nameFragment) {
    return { reply: "Decime qué contacto o razón buscar.", options: [] };
  }
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  let partners;
  try {
    partners = await odoo.executeKw(
      uid,
      "res.partner",
      "search_read",
      [[["name", "ilike", nameFragment]]],
      {
        fields: [
          "id",
          "name",
          "parent_id",
          "child_ids",
          "phone",
          "mobile",
          "email",
          "street",
          "vat",
          "is_company",
          "type"
        ],
        limit: 12
      }
    );
  } catch (e) {
    return { reply: `No pude buscar contactos: ${(e && e.message) || e}`, options: [] };
  }
  if (!partners.length) {
    return { reply: `No encontré contactos con "${nameFragment}". Probá con otra parte del nombre.`, options: [] };
  }
  const lines = [];
  for (const p of partners) {
    const isComp = p.is_company ? "empresa" : "persona";
    const vat = (p.vat || "").trim();
    const addr = (p.street || "").trim();
    const core = `${p.name} (${isComp}${vat ? ", CUIT " + vat : ""})`;
    if (addr) lines.push(`  - ${core}\n    Dir: ${addr}`);
    else lines.push(`  - ${core}`);
  }
  const reply = `Encontré ${partners.length} registro(s):\n${lines.join("\n")}`;
  return { reply, options: [] };
}

async function postMessageToSaleOrder(odoo, uid, soId, body) {
  try {
    await odoo.executeKw(uid, "sale.order", "message_post", [[soId]], {
      body,
      message_type: "comment",
      subtype_xmlid: "mail.mt_note"
    });
    return true;
  } catch (e) {
    try {
      await odoo.executeKw(uid, "mail.message", "create", [
        { model: "sale.order", res_id: soId, body, message_type: "comment" }
      ]);
      return true;
    } catch (e2) {
      throw e;
    }
  }
}

function extractSaleOrderNameFromText(s) {
  const m = String(s || "").match(/\bS0\d{3,9}\b/i);
  return m ? m[0].toUpperCase() : "";
}

async function findSaleOrderByNameUpper(odoo, uid, name) {
  const rows = await odoo.executeKw(
    uid,
    "sale.order",
    "search_read",
    [[["name", "=", String(name).toUpperCase()]]],
    { fields: ["id", "name", "state"], limit: 1 }
  );
  return rows[0] || null;
}

async function buildSaleOrderSummaryText(odoo, uid, orderId) {
  const rows = await odoo.executeKw(
    uid,
    "sale.order",
    "read",
    [[orderId]],
    { fields: ["id", "name", "state", "amount_total", "order_line", "partner_id", "x_studio_marca"] }
  );
  const o = rows && rows[0];
  if (!o) return "";
  const pName = Array.isArray(o.partner_id) ? o.partner_id[1] : "";
  const lineIds = o.order_line || [];
  const lines = lineIds.length
    ? await odoo.executeKw(
        uid,
        "sale.order.line",
        "read",
        [lineIds],
        { fields: ["name", "product_uom_qty", "price_unit", "price_subtotal"] }
      )
    : [];
  const lineTxt = (lines || [])
    .map((L) => {
      const sub = L.price_subtotal != null ? Number(L.price_subtotal) : Number(L.product_uom_qty) * Number(L.price_unit);
      return ` · ${(L.name || "Línea").toString().trim()} × ${L.product_uom_qty}  @ ${Number(
        L.price_unit || 0
      ).toFixed(2)}  →  $${Number(sub || 0).toFixed(2)}`;
    })
    .join("\n");
  return (
    `Cliente: ${pName || "—"}\n` +
    (o.x_studio_marca ? `Marca (OV): ${o.x_studio_marca}\n` : "") +
    (lineTxt ? `Líneas:\n${lineTxt}\n` : "Sin líneas listadas\n") +
    `Total: $${Number(o.amount_total || 0).toFixed(2)}`
  );
}

async function prepareConfirmSaleOrder(session, saleOrderName) {
  const so = String(saleOrderName || "")
    .trim()
    .toUpperCase();
  if (!so) {
    return { reply: "Necesito el número de OV (formato S0XXXX) para confirmarla.", options: [] };
  }
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const order = await findSaleOrderByNameUpper(odoo, uid, so);
  if (!order) {
    return { reply: `No encontré la ${so} en ODOO.`, options: [] };
  }
  if (order.state !== "draft" && order.state !== "sent") {
    return { reply: `La ${so} ya no está en borrador (estado: ${order.state}). No hace falta confirmar.`, options: [] };
  }
  let summary = "";
  try {
    summary = await buildSaleOrderSummaryText(odoo, uid, order.id);
  } catch {
    summary = "";
  }
  session.pendingSoConfirm = { soName: so, orderId: order.id, step: 1 };
  return {
    conversational: true,
    reply: `Voy a confirmar la ${so} (de cotización a pedido de venta).\n\n${summary || "Resumen no disponible."}\n\n¿Confirmás?`,
    options: ["Sí, confirmar", "No, cancelar"]
  };
}

async function continueConfirmSaleOrderFlow(session, message) {
  const p = session.pendingSoConfirm;
  if (!p) return { reply: "No quedó nada para confirmar.", options: [] };
  if (isNegative(message) || (p.step === 1 && !isAffirmative(message))) {
    session.pendingSoConfirm = null;
    return { reply: "Listo, no toco la OV. ¿Necesitás otra cosa?", options: [] };
  }
  if (p.step === 1 && isAffirmative(message)) {
    return executeSaleOrderConfirmAction(session, p);
  }
  session.pendingSoConfirm = null;
  return { reply: "Cerré eso, seguí con otra consulta.", options: [] };
}

async function executeSaleOrderConfirmAction(session, p) {
  session.pendingSoConfirm = null;
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  try {
    await odoo.executeKw(uid, "sale.order", "action_confirm", [[p.orderId]]);
  } catch (e) {
    return { reply: `No pude confirmar: ${(e && e.message) || e}. Revisá permisos o estado en ODOO.`, options: [] };
  }
  return { reply: `Listo, la ${p.soName} quedó confirmada (pedido de venta).`, options: [] };
}

function parseDejarNotaInMessage(s) {
  const raw = String(s || "");
  const m = raw.match(/\bS0\d{3,9}\b/i);
  const so = m ? m[0].toUpperCase() : "";
  const after = m ? raw.split(m[0])[1] || "" : raw;
  let note = after.replace(/^[\s:,-—]+/, "").trim();
  const colon = raw.indexOf(":");
  const noteFromColon = colon === -1 ? "" : raw.slice(colon + 1).trim();
  if (!note && noteFromColon) note = noteFromColon;
  return { so, note, noteFromColon, raw };
}

function extractClientHintForDejarMessage(s) {
  const raw = String(s || "");
  const pats = [
    /(?:nota|anot[áa]|dej[áa])\s+(?:en\s+)?(?:la\s+)?(?:ov|orden|cotizaci[oó]n)\s+de\s+([^:.\n?]+)/i,
    /(?:ov|orden|cotizaci[oó]n)\s+de\s+([^:.\n?]+)/i
  ];
  for (const re of pats) {
    const m = raw.match(re);
    if (m) return m[1].replace(/[.,;]+$/, "").trim();
  }
  return "";
}

async function resolveDejarSaleOrderName(odoo, uid, message, data) {
  const pin = parseDejarNotaInMessage(String(message));
  if (pin.so) return { so: pin.so };
  const fromData = (data && (data.saleOrderName || data.ov)) || "";
  if (fromData && String(fromData).match(/\bS0\d/i)) {
    return { so: (extractSaleOrderNameFromText(String(fromData)) || String(fromData)).toUpperCase() };
  }
  const clientHint = String((data && (data.clientName || data.cliente)) || extractClientHintForDejarMessage(message) || "").trim();
  if (clientHint.length < 2) return { so: "" };
  const partners = await odoo.executeKw(
    uid,
    "res.partner",
    "search_read",
    [[["name", "ilike", clientHint], ["is_company", "=", true]]],
    { fields: ["id", "name"], limit: 8 }
  );
  if (!partners || !partners.length) return { so: "" };
  const pids = partners.map((p) => p.id);
  const orders = await odoo.executeKw(
    uid,
    "sale.order",
    "search_read",
    [[["partner_id", "in", pids]]],
    { fields: ["id", "name", "state"], order: "id desc", limit: 6 }
  );
  if (!orders || !orders.length) return { so: "" };
  if (orders.length === 1) return { so: String(orders[0].name).toUpperCase() };
  return {
    so: "",
    needPick: true,
    orderNames: orders.slice(0, 3).map((o) => String(o.name).toUpperCase()),
    reply: "Encontré varias OVs para ese cliente. Elegí una (máx. 3 opciones):"
  };
}

async function continueDejarNotaFlow(session, message) {
  const p = session.pendingDejarNota;
  if (!p) return { reply: "No tengo nota pendiente de guardar.", options: [] };
  if (p.step === "pick_so") {
    if (isNegative(message)) {
      session.pendingDejarNota = null;
      return { reply: "Listo, no dejo nota. ¿Necesitás otra cosa?", options: [] };
    }
    const m = String(message || "").trim().toUpperCase();
    const hit = (p.orderNames || []).find((n) => m.includes(n) || n.includes(m));
    if (!hit) {
      return { reply: "Elegí una de las OVs de la lista (tocá un botón).", options: (p.orderNames || []).slice(0, 3) };
    }
    session.pendingDejarNota = { soName: hit, step: "ask_note" };
    return { reply: `Bien, uso la ${hit}. Poneme el texto de la nota.`, options: [] };
  }
  if (p.step === "confirm") {
    if (isNegative(message)) {
      session.pendingDejarNota = null;
      return { reply: "Listo, no dejo nota. ¿Necesitás otra cosa?", options: [] };
    }
    if (isAffirmative(message)) {
      const sn = p.soName;
      const nt = p.note;
      session.pendingDejarNota = null;
      return runDejarNotaPost(sn, nt);
    }
    return { reply: "¿Confirmás dejar la nota en el chatter? Decime sí o no.", options: ["Sí, confirmo", "No, cancelar"] };
  }
  if (isNegative(message)) {
    session.pendingDejarNota = null;
    return { reply: "Listo, no dejo nota. ¿Necesitás otra cosa?", options: [] };
  }
  const note = String(message || "").trim();
  if (!note) {
    return { reply: "Pasame el texto de la nota, en una o dos frases.", options: [] };
  }
  session.pendingDejarNota = { soName: p.soName, note, step: "confirm" };
  return {
    reply: `Voy a dejar esta nota en ${p.soName}:\n«${note}»\n\n¿Confirmás?`,
    options: ["Sí, confirmo", "No, cancelar"]
  };
}

async function runDejarNotaPost(soName, body) {
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const order = await findSaleOrderByNameUpper(odoo, uid, soName);
  if (!order) {
    return { reply: `No encontré la ${soName} en ODOO.`, options: [] };
  }
  try {
    await postMessageToSaleOrder(odoo, uid, order.id, body);
  } catch (e) {
    return { reply: `No pude publicar en el chatter: ${(e && e.message) || e}`, options: [] };
  }
  return { reply: `Listo, dejé la nota en el chatter de ${soName}.`, options: [] };
}

function matchWhatsappTemplateName(needle) {
  const n = normalizeStr(needle || "");
  const list = Array.isArray(whatsappTemplates) ? whatsappTemplates : [];
  if (!list.length) return null;
  if (!n) return null;
  for (const t of list) {
    if (normalizeStr(t.name).includes(n)) return t;
  }
  for (const t of list) {
    if (n.length > 1 && n.includes(normalizeStr(t.name).slice(0, 4))) return t;
  }
  for (const t of list) {
    if (n.length > 2 && normalizeStr(t.name).split(/\s+/).some((p) => p.length > 1 && n.includes(p)))
      return t;
  }
  return null;
}

async function pickPartnerCompanyAndPhone(odoo, uid, nameFragment) {
  const r = await odoo.executeKw(
    uid,
    "res.partner",
    "search_read",
    [
      [
        ["name", "ilike", nameFragment],
        ["is_company", "=", true]
      ]
    ],
    { fields: ["id", "name", "phone", "mobile"], limit: 3 }
  );
  const company = (r && r[0]) || null;
  if (!company) return { company: null, phone: "", children: [] };
  const ch = await loadChildContactPhones(odoo, uid, company.id);
  let phone = "";
  for (const c of ch) {
    const t = (c.mobile || c.phone || "").toString().replace(/\D/g, "");
    if (t && t.length > 5) {
      phone = c.mobile || c.phone;
      break;
    }
  }
  if (!phone) {
    const t0 = (company.mobile || company.phone || "").toString();
    phone = t0;
  }
  return { company, phone, children: ch };
}

async function sendWhatsappTemplate(odoo, uid, params) {
  const { templateId, resModel, resId, partnerId, mobile } = params;
  const mobileNorm = String(mobile || "")
    .replace(/[^\d+]/g, "")
    .replace(/^0+/, "");
  if (!templateId || !resModel || !resId) {
    return { ok: false, err: "Faltan datos de plantilla o registro." };
  }
  if (!mobileNorm || mobileNorm.length < 8) {
    return { ok: false, err: "No hay un número de móvil válido para el envío." };
  }
  try {
    const mid = await odoo.executeKw(uid, "whatsapp.message", "create", [
      {
        wa_template_id: templateId,
        res_model: resModel,
        res_id: resId,
        partner_id: partnerId,
        mobile_number: mobileNorm
      }
    ]);
    try {
      await odoo.executeKw(uid, "whatsapp.message", "button_send", [[mid]]);
    } catch (e1) {
      try {
        await odoo.executeKw(uid, "whatsapp.message", "button_send", [mid]);
      } catch (e2) {
        return { ok: true, err: (e1 && e1.message) || String(e1), id: mid };
      }
    }
    return { ok: true, id: mid };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

async function continueWhatsappSendFlow(session, message) {
  const p = session.pendingWhatsapp;
  if (!p || p.step !== "preview") {
    session.pendingWhatsapp = null;
    return { reply: "No tengo un envío de WhatsApp pendiente.", options: [] };
  }
  if (isNegative(message)) {
    session.pendingWhatsapp = null;
    return { reply: "Listo, no mando nada por WhatsApp.", options: [] };
  }
  if (p.requiresMassive) {
    if (String(message || "").trim().toLowerCase() !== "confirmo masivo") {
      return {
        reply: "Escribí exactamente «confirmo masivo» o cancelá (no).",
        options: ["No, cancelar"]
      };
    }
  } else if (!isAffirmative(message)) {
    return { reply: "¿Lo mando? Decime sí o no.", options: ["Sí, enviar", "No, cancelar"] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const ok = [];
  const fail = [];
  for (const row of p.rows || []) {
    const r = await sendWhatsappTemplate(odoo, uid, row);
    if (r && r.ok) ok.push(row.label || row.name);
    else
      fail.push(
        (row && row.label) || "registro" + (r && r.err ? `: ${r.err}` : "")
      );
  }
  session.pendingWhatsapp = null;
  return {
    reply: `Listo. Envié ${ok.length} mensaje(s)${fail.length ? `. Sin enviar: ${fail.slice(0, 3).join("; ")}` : "."}`,
    options: []
  };
}

async function executeWhatsappStub(data, message, session) {
  const names = Array.isArray(data && data.contacts) ? data.contacts : [];
  const raw = String(
    (data && (data.contactsString || data.namesString)) || message || ""
  );
  const parts = raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const want = (names.length ? names : parts).slice(0, 100);
  if (!want.length) {
    return {
      reply: "Necesito nombres o filtro, y el nombre aproximado de la plantilla. Ej: «mandá difusion a Carvi, Omar» con plantilla en el dato o en el chat.",
      options: []
    };
  }
  if (want.length > 100) {
    return { reply: "Máximo 100 destinatarios por operación. Acotá la lista y repetí.", options: [] };
  }
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const plName = (data && (data.plantilla || data.template)) || "";
  let t = matchWhatsappTemplateName(plName);
  if (!t) {
    t = matchWhatsappTemplateName(String(message).slice(0, 120));
  }
  if (!t) {
    const words = String(message)
      .split(/\s+/)
      .map((w) => w.replace(/[^a-záéíóúñA-ZÁÉÍÓÚÑ0-9]/g, ""))
      .filter((w) => w.length > 3);
    for (const w of words) {
      t = matchWhatsappTemplateName(w);
      if (t) break;
    }
  }
  if (!t) {
    return { reply: "No hay plantillas aprobadas en caché o el nombre no matchea. Cargan al iniciar el servidor; probá otra palabra o revisá ODOO.", options: [] };
  }
  const tModel = t.model || "res.partner";
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const mSo = String(message).match(/\bS0\d{3,9}\b/i);
  const soName = mSo ? mSo[0].toUpperCase() : "";
  const rows = [];
  const preview = [];
  for (const w of want) {
    const hit = await pickPartnerCompanyAndPhone(odoo, uid, w);
    if (!hit || !hit.company) {
      preview.push(`${w} — (no encontré empresa o contacto)`);
      continue;
    }
    const phone = (hit.phone || "").toString();
    let resModel = tModel;
    let resId = hit.company.id;
    if (tModel && tModel.includes("sale.order") && soName) {
      const so = await findSaleOrderByNameUpper(odoo, uid, soName);
      if (so) {
        resModel = "sale.order";
        resId = so.id;
      }
    } else if (tModel && tModel.includes("account.move")) {
      return {
        reply:
          "Esa plantilla pega con un asiento contable. Abrí el asiento en ODOO y enviá desde el botón de WhatsApp; el chat aún no elige asientos sueltos con solo nombre.",
        options: []
      };
    } else {
      resModel = "res.partner";
      resId = hit.company.id;
    }
    if (!phone.replace(/\D/g, "").length || phone.length < 6) {
      preview.push(`${hit.company.name} — sin móvil válido en el contacto interno (child)`);
      continue;
    }
    rows.push({
      templateId: t.id,
      resModel,
      resId,
      partnerId: hit.company.id,
      mobile: phone,
      label: hit.company.name
    });
    preview.push(`${hit.company.name} — ${phone}`);
  }
  if (!rows.length) {
    return { reply: `No armé destinatarios válidos. Previa:\n${preview.join("\n")}`, options: [] };
  }
  const requiresMassive = rows.length > 10;
  if (requiresMassive) {
    session.pendingWhatsapp = { step: "preview", requiresMassive: true, rows };
    return {
      reply:
        `Voy a mandar la plantilla «${t.name}» (${rows.length} contactos, modelo ${tModel}). Primeros 5 destinatarios y teléfono:\n` +
        `${preview
          .filter((l) => !l.includes("("))
          .slice(0, 5)
          .join("\n")}\n` +
        `… total ${rows.length}. Escribí exactamente «confirmo masivo» o no.`,
      options: ["No, cancelar"]
    };
  }
  session.pendingWhatsapp = { step: "preview", requiresMassive: false, rows };
  return {
    reply:
      `Voy a mandar la plantilla «${t.name}» (${tModel}):\n${preview.join(
        "\n"
      )}\n\n¿Confirmás?`,
    options: ["Sí, enviar", "No, cancelar"]
  };
}

async function createProductAsDraft(odoo, uid, { name, categoryId, listPrice, note, minQty }) {
  const vals = {
    name: String(name || "Producto nuevo").trim(),
    list_price: Number(listPrice) || 0,
    categ_id: categoryId,
    type: "consu",
    sale_ok: true,
    purchase_ok: true
  };
  if (note) {
    vals.description_sale = String(note);
  }
  if (minQty != null && Number(minQty) > 0) {
    try {
      vals.x_studio_minimo = Number(minQty);
    } catch {
      /* no bloquea */
    }
  }
  try {
    return await odoo.executeKw(uid, "product.template", "create", [vals]);
  } catch (e) {
    if (vals.x_studio_minimo != null) {
      delete vals.x_studio_minimo;
      return odoo.executeKw(uid, "product.template", "create", [vals]);
    }
    throw e;
  }
}

function applyProposalDesignCambiosToNotas(notas, cambiosText) {
  const add = String(cambiosText || "").trim();
  const base = notas && typeof notas === "object" ? { ...notas } : {};
  if (add) {
    base.instrucciones = [String(base.instrucciones || "").trim(), add]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (add) {
    const fMatch = add.match(
      /fondo\s+(negro|blanco|beige|arena|rojo|azul|gris|marr[oó]n|transparente|amarillo|dorado|plateado|rosa|fucsia|naranja|violeta|bordo)/i
    );
    if (fMatch) base.fondoColor = fMatch[1].toLowerCase();
    const capF = add.match(/FONDO\s+([A-ZÁÉÍÓÚÑa-záéíóú]+)/i);
    if (capF && !fMatch) base.fondoColor = capF[1].toLowerCase();
    if (/letras?\s+blancas?/i.test(add) || /texto\s+blanc[oa]/i.test(add) || /relieve\s+blanc[oa]/i.test(add)) {
      base.relieveColor = "blanco";
    } else if (/letras?\s+negras?/i.test(add) || /texto\s+negr[oa]/i.test(add)) {
      base.relieveColor = "negro";
    } else {
      const tMatch = add.match(
        /(?:texto|relieve|letras?)\s+(negro|blanco|amarillo|rojo|azul|dorado|plateado|verde|gris|fucsia|naranja|violeta|bordo)/i
      );
      if (tMatch) base.relieveColor = tMatch[1].toLowerCase();
    }
  }
  return base;
}

async function executeModificarPropuestaFromAgent(data, userMessage) {
  const cambios = String((data && data.cambios) || "").trim();
  let orden_id = String((data && data.orden_id) || "").toUpperCase().replace(/\s+/g, "");
  if (!orden_id) {
    const fromOv = (data && (data.orden || data.ov || data.saleOrderName)) || "";
    if (fromOv) orden_id = String(fromOv).toUpperCase().replace(/\s+/g, "");
  }
  if (!orden_id) {
    const m = String(userMessage || "").match(/\b(S0\d+)\b/i);
    if (m) orden_id = m[1].toUpperCase();
  }
  if (!orden_id || !/^S0\d+/i.test(orden_id)) {
    return {
      reply: "Necesito el número de OV (ej. S02280).",
      options: []
    };
  }
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  let uid;
  try {
    uid = await odoo.authenticate();
  } catch (e) {
    return { reply: "No pude conectar con ODOO ahora. Probá de nuevo en un rato.", options: [] };
  }
  const orders = await odoo.executeKw(
    uid,
    "sale.order",
    "search_read",
    [[["name", "=", orden_id]]],
    { fields: ["id", "name", "partner_id", "date_order", "user_id", "order_line", "x_studio_marca"], limit: 1 }
  );
  const order = orders && orders[0];
  if (!order) {
    return { reply: `No encontré la OV ${orden_id}.`, options: [] };
  }
  const lineIds = order.order_line || [];
  const lineRows = lineIds.length
    ? await odoo.executeKw(uid, "sale.order.line", "read", [lineIds], {
        fields: ["id", "name", "product_id", "product_uom_qty", "price_unit"]
      })
    : [];
  let chatter = [];
  try {
    chatter = await odoo.executeKw(
      uid,
      "mail.message",
      "search_read",
      [
        [
          ["model", "=", "sale.order"],
          ["res_id", "=", order.id],
          ["message_type", "=", "comment"]
        ]
      ],
      { fields: ["body", "date", "author_id"], limit: 120, order: "date asc" }
    );
  } catch (e) {
    chatter = await odoo.executeKw(
      uid,
      "mail.message",
      "search_read",
      [[["model", "=", "sale.order"], ["res_id", "=", order.id]]],
      { fields: ["body", "date", "author_id", "message_type"], limit: 120, order: "date asc" }
    );
    chatter = (chatter || []).filter((m) => (m.message_type || "comment") === "comment");
  }
  const partnerName = Array.isArray(order.partner_id) ? order.partner_id[1] : "Cliente";
  const partnerId = Array.isArray(order.partner_id) ? order.partner_id[0] : null;
  const logoPath = partnerId ? path.join(LOGOS_DIR, `${partnerId}.png`) : "";
  const marca = String(order.x_studio_marca || "").trim();
  let notas = parseChatterNotes(chatter || []);
  const chatterText = (chatter || []).map((c) => stripHtml(c.body)).join("\n");
  notas = await enrichChatterNotesWithGroqIfNeeded(notas, chatterText);
  if (cambios) {
    notas = applyProposalDesignCambiosToNotas(notas, cambios);
  }
  let lineas = (lineRows || []).map((ln) => {
    const sku = extractSkuCandidateFromLine(ln);
    const skuParsed = parseSKU(sku);
    return { ...ln, sku, skuParsed, qty: ln.product_uom_qty, price_unit: ln.price_unit, name: ln.name || sku };
  });
  if (!lineas.length) {
    lineas.push({ name: "Sin líneas", qty: 0, price_unit: 0, sku: "", skuParsed: parseSKU("") });
  }
  let logoDataUri = null;
  let visionData = { texts: [], colors: [] };
  let logoAdjunto = null;
  try {
    const adjuntos = await odoo.executeKw(
      uid,
      "ir.attachment",
      "search_read",
      [
        [
          ["res_model", "=", "sale.order"],
          ["res_id", "=", order.id],
          ["mimetype", "ilike", "image/"]
        ]
      ],
      { fields: ["id", "name", "datas", "mimetype"], limit: 5, order: "id asc" }
    );
    logoAdjunto = adjuntos && adjuntos.length ? adjuntos[0] : null;
    if (logoAdjunto && logoAdjunto.datas) {
      const mt = String(logoAdjunto.mimetype || "image/png").trim();
      if (/^image\/[a-z0-9.+-]+$/i.test(mt)) {
        logoDataUri = `data:${mt};base64,${String(logoAdjunto.datas).replace(/\s/g, "")}`;
      }
      visionData = await analyzeImageWithVision(
        String(logoAdjunto.datas).replace(/\s/g, ""),
        logoAdjunto.mimetype || "image/jpeg"
      );
    }
  } catch (e) {
    console.log("[agent] MODIFICAR_PROPUESTA adjuntos:", (e && e.message) || e);
  }
  const proposalFontPick = proposalBordadaFontPickFromVision(visionData.texts || []);
  const fileName = nextProposalFilename(orden_id);
  const outPath = path.join(PROPUESTAS_DIR, fileName);
  await generateProposalPDF(
    {
      orden_id,
      partner_name: partnerName,
      marca,
      vendedor: Array.isArray(order.user_id) ? order.user_id[1] : "",
      lineas,
      notas,
      logoPath,
      logoDataUri,
      visionData,
      proposalFontPick
    },
    outPath
  );
  return {
    reply: cambios
      ? `Listo, actualicé la propuesta de ${orden_id}. Descargá: /propuestas/${fileName}`
      : `Listo, generé la propuesta de ${orden_id}. Descargá: /propuestas/${fileName}`,
    options: []
  };
}

async function resolveGenerarPropuestaFromChat(odoo, uid, message, session) {
  void session;
  const m = String(message || "").trim();
  if (!m) return null;
  const isPropIntent =
    /(?:gener[áa]|hac[ée])\s+la\s+propuesta/i.test(m) ||
    /propuesta\s+de\s+S0\d+/i.test(m) ||
    /propuesta\s+para\b/i.test(m);
  if (!isPropIntent) return null;
  const ovM = m.match(/\b(S0\d+)\b/i);
  if (ovM) {
    const orden_id = ovM[1].toUpperCase();
    return await executeModificarPropuestaFromAgent({ orden_id, cambios: "" }, message);
  }
  if (/propuesta\s+para\b/i.test(m)) {
    const after = m.split(/propuesta\s+para/i)[1] || "";
    const name = after.replace(/^\s*[,:\-]?\s*/, "").replace(/\?+$/, "").trim();
    if (!name || name.length < 2) {
      return {
        reply: "¿Para qué cliente o marca querés la propuesta? (nombre o razón social)",
        options: []
      };
    }
    const partners = await odoo.executeKw(
      uid,
      "res.partner",
      "search_read",
      [[["name", "ilike", name]]],
      { fields: ["id", "name"], limit: 12 }
    );
    if (!partners.length) {
      return {
        reply: `No encontré un cliente con «${name}». Pasame un nombre más exacto o el número de OV (S0…).`,
        options: []
      };
    }
    const pids = partners.map((p) => p.id);
    const orders = await odoo.executeKw(
      uid,
      "sale.order",
      "search_read",
      [[["partner_id", "in", pids]]],
      { fields: ["name", "partner_id", "date_order"], order: "date_order desc", limit: 1 }
    );
    if (!orders || !orders.length) {
      return {
        reply: `No hay órdenes de venta recientes para clientes que coincidan con «${name}». Pasame el número de OV (S0…).`,
        options: []
      };
    }
    const orden_id = String(orders[0].name || "").toUpperCase();
    return await executeModificarPropuestaFromAgent({ orden_id, cambios: "" }, message);
  }
  return { reply: "¿De qué OV querés la propuesta? Decime el número (ej. S02203).", options: [] };
}

async function executeExtendedAgentAction(action, data, session, userMessage) {
  const a = String(action || "").trim().toUpperCase();
  if (a === "BUSCAR_CONTACTO") {
    return executeBuscarContactoAction(data);
  }
  if (a === "DEJAR_NOTA_OV" || a === "DEJAR_NOTA") {
    const pin = parseDejarNotaInMessage(userMessage);
    let so =
      (data && (data.saleOrderName || data.saleOrder || data.ov)) ||
      extractSaleOrderNameFromText(userMessage) ||
      pin.so ||
      "";
    so = so ? String(so).toUpperCase() : "";
    let note = String((data && (data.note || data.mensaje || data.body)) || "").trim();
    if (!note && pin.so && (!so || pin.so === so)) {
      note = (pin.note || pin.noteFromColon || "").trim();
    } else if (!note && (pin.note || pin.noteFromColon)) {
      note = (pin.note || pin.noteFromColon || "").trim();
    }
    try {
      validateEnv();
    } catch (e) {
      return { reply: e.message, options: [] };
    }
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    if (!so) {
      const res = await resolveDejarSaleOrderName(odoo, uid, userMessage, data);
      if (res && res.needPick) {
        session.pendingDejarNota = { step: "pick_so", orderNames: res.orderNames || [] };
        return { conversational: true, reply: res.reply, options: (res.orderNames || []).slice(0, 3) };
      }
      so = res && res.so ? res.so : "";
    }
    if (!so) {
      return {
        reply:
          "Necesito el número de la OV o el cliente (ej. «dejá nota en S01234: …» o «en la ov de Nina: …»).",
        options: []
      };
    }
    if (!note) {
      session.pendingDejarNota = { soName: so, step: "ask_note" };
      return { conversational: true, reply: `Poneme el texto de la nota para ${so}.`, options: [] };
    }
    session.pendingDejarNota = { soName: so, note, step: "confirm" };
    return {
      conversational: true,
      reply: `Voy a dejar esta nota en ${so}:\n«${note}»\n\n¿Confirmás?`,
      options: ["Sí, confirmo", "No, cancelar"]
    };
  }
  if (a === "CONFIRMAR_OV" || a === "CONFIRMAR") {
    const so =
      (data && (data.saleOrderName || data.ov)) ||
      extractSaleOrderNameFromText(userMessage) ||
      extractSaleOrderNameFromText(String((data && data.name) || ""));
    return prepareConfirmSaleOrder(session, so);
  }
  if (a === "MODIFICAR_FECHA_OC" || a === "CAMBIAR_FECHA_OC") {
    if (!String(userMessage || "").match(/\bP0\d+\b/i)) {
      return { reply: "Necesito el código de la OC (P0XXXX) y la fecha. Ej: «la OC P01234 pasa a 20/04.»", options: [] };
    }
    const t = tryStartModOcIfPattern(userMessage, session);
    if (t && t._async) return await t._async;
    if (t) return t;
    return { reply: "No vi bien la fecha nueva. Probalo con DD/MM o días: «postergá 5 días P01234.»", options: [] };
  }
  if (a === "CREAR_PRODUCTO" || a === "NUEVO_PRODUCTO") {
    return handleCrearProductoFromAgent(data, userMessage, session);
  }
  if (a === "MODIFICAR_PROPUESTA" || a === "ACTUALIZAR_PROPUESTA") {
    return await executeModificarPropuestaFromAgent(data, userMessage);
  }
  if (a === "ENVIAR_WHATSAPP_MASIVO" || a === "WHATSAPP_MASIVO") {
    return executeWhatsappStub(data, userMessage, session);
  }
  if (a === "NADA" || a === "NINGUNA" || a === "CONSULTA") {
    const d = data || {};
    const opt = d.options || [];
    return {
      reply: String(d.reply || "Contame en una frase qué querés y con qué nombres o números (OV, OC, cliente)."),
      options: Array.isArray(opt) ? opt : []
    };
  }
  return {
    reply: "Eso no se ejecuta automático acá. Decime con más concreto (OV, monto, contacto) o usá un botón si aparece.",
    options: []
  };
}

async function handleCrearProductoFromAgent(data, userMessage) {
  const name = String((data && data.productName) || (data && data.name) || userMessage).trim();
  if (!name || name.length < 2) {
    return { reply: "Decime el nombre del producto a crear (borrador).", options: [] };
  }
  const price = Number((data && (data.precio || data.price)) || normalizeMoney(String((data && data.price) || "0")) || 0);
  if (!price || price <= 0) {
    return { reply: "Falta el precio (lista) del producto en pesos, por ejemplo: 500.", options: [] };
  }
  const minRaw = data && (data.minimo || data.x_studio_minimo || data.moq);
  if (minRaw === undefined || minRaw === null || String(minRaw).trim() === "") {
    return { reply: "Pasame el mínimo de venta (unidades) o 0 si no aplica.", options: [] };
  }
  const minN = Number(normalizeMoney(String(minRaw)));
  if (!Number.isFinite(minN) || minN < 0) {
    return { reply: "El mínimo tiene que ser un número (o 0).", options: [] };
  }
  const cat = String((data && (data.categoria || data.category)) || "").trim();
  try {
    validateEnv();
  } catch (e) {
    return { reply: e.message, options: [] };
  }
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const choices = await getTopProductCategoryChoices(odoo, uid);
  if (!choices.length) {
    return { reply: "No pude leer categorías de producto en ODOO.", options: [] };
  }
  const byLabel = (label) => choices.find((c) => normalizeStr(c.name).includes(normalizeStr(label)));
  const picked = cat ? byLabel(cat) : choices[0];
  if (!picked) {
    return {
      reply: "Decime con cuál categoría guardamos el borrador (elegí una).",
      options: choices.map((c) => c.name).slice(0, 3)
    };
  }
  try {
    await createProductAsDraft(odoo, uid, {
      name,
      categoryId: picked.id,
      listPrice: price,
      minQty: minN > 0 ? minN : 0,
      note: "Borrador (asistente)"
    });
  } catch (e) {
    return { reply: `No pude crear el producto: ${(e && e.message) || e}`, options: [] };
  }
  return {
    reply: `Listo, quedó cargado en sistema como borrador (podés afinar nombre, mínimo y fórmulas desde ODOO). Nombre: ${name}, precio $${price.toFixed(
      2
    )}, mínimo: ${minN > 0 ? minN : "sin mínimo extra"}.`,
    options: []
  };
}

async function startWriteFlowIfNeeded(session, message) {
  const n = normalizeStr(message);
  const isOvNatural =
    n.includes("presupuesto") ||
    n.includes("cotizacion") ||
    (n.includes("nueva") && n.includes("cotizacion")) ||
    (n.includes("armar") && (n.includes("cotizacion") || n.includes("presupuesto")));
  if (isOvNatural && !session.pendingWrite) {
    session.pendingWrite = { type: "OV", step: "brand", data: {} };
    return { reply: "Dale, arrancamos la cotización. ¿Qué marca cargamos?", options: [] };
  }
  if (n.includes("crearov") || n.includes("nuevaov") || n.includes("crearordenventa")) {
    session.pendingWrite = { type: "OV", step: "brand", data: {} };
    return { reply: "Perfecto. ¿Qué marca querés cargar en la OV?", options: [] };
  }
  if (n.includes("crearoc") || n.includes("nuevaoc") || n.includes("crearordencompra")) {
    session.pendingWrite = { type: "OC", step: "supplier", data: {} };
    return { reply: "Perfecto. ¿Para qué proveedor querés crear la OC?", options: [] };
  }
  return null;
}

async function continuePendingWriteFlow(session, message) {
  if (isNegative(message)) {
    session.pendingWrite = null;
    return { reply: "Operación cancelada. Contame qué necesitás.", options: [] };
  }
  const flow = session.pendingWrite;
  if (!flow) return { reply: "No hay ninguna operación pendiente.", options: [] };
  if (flow.type === "OV") {
    return continueCreateOvFlow(session, message);
  }
  if (flow.type === "OC") {
    return continueCreateOcFlow(session, message);
  }
  session.pendingWrite = null;
  return { reply: "No pude continuar el flujo pendiente.", options: [] };
}

async function continueCreateOvFlow(session, message) {
  const flow = session.pendingWrite;
  if (flow.step === "ov_template_disambig") {
    const cands = flow.data.templateCandidates || [];
    const m = String(message || "").trim();
    const hit = cands.find(
      (c) =>
        normalizeStr(c.name) === normalizeStr(m) ||
        m.includes(c.name) ||
        normalizeStr(c.name).includes(normalizeStr(m))
    );
    if (!hit) {
      return {
        reply: "Elegí una de las plantillas (botones).",
        options: cands.slice(0, 3).map((t) => t.name)
      };
    }
    flow.data.saleTemplateId = hit.id;
    delete flow.data.templateCandidates;
    flow.step = "brand";
    return { reply: `Listo, plantilla «${hit.name}». ¿Qué marca cargamos en la cotización?`, options: [] };
  }
  if (flow.step === "template") {
    if (isDeclineTemplateMessage(message)) {
      delete flow.data.saleTemplateId;
      flow.step = "product_query";
      return { reply: "Dale, sin plantilla. ¿Qué producto querés agregar?", options: [] };
    }
    const hit = matchUserMessageToSaleOrderTemplate(message);
    if (hit) {
      flow.data.saleTemplateId = hit.id;
      flow.step = "product_query";
      return { reply: `Uso la plantilla «${hit.name}». ¿Qué producto agregamos?`, options: [] };
    }
    return {
      reply: `No identifiqué la plantilla. Decime un nombre de la lista, o "ninguna". Disponibles: ${formatSaleOrderTemplateNameList()}.`,
      options: []
    };
  }
  if (flow.step === "brand") {
    const brand = String(message || "").trim();
    if (!brand) return { reply: "Decime la marca. Ejemplo: Dafne Fashion.", options: [] };
    flow.data.brandName = brand;
    flow.step = "client";
    return { reply: `Marca: ${brand}. Ahora decime el cliente.`, options: [] };
  }
  if (flow.step === "client") {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    flow.data.clientInputName = String(message || "").trim();
    const partners = await odoo.executeKw(
      uid, "res.partner", "search_read",
      [[["name", "ilike", message]]],
      { fields: ["id", "name"], limit: 6 }
    );
    if (!partners.length) {
      flow.step = "client_create_confirm";
      return { reply: `No encontré "${flow.data.clientInputName}". ¿Querés que cree ese contacto nuevo?`, options: ["Sí, crear contacto", "No, cancelar"] };
    }
    if (partners.length > 1) {
      flow.step = "client_select";
      flow.data.clientCandidates = partners.map((p) => ({ id: p.id, name: p.name }));
      return { reply: "Encontré varios clientes. Decime el nombre completo.", options: [] };
    }
    flow.data.clientId = partners[0].id;
    flow.data.clientName = partners[0].name;
    if (flow.data.saleTemplateId) {
      flow.step = "product_query";
      return { reply: `Cliente: ${partners[0].name}. ¿Qué producto querés agregar?`, options: [] };
    }
    flow.step = "template";
    return {
      reply: `Cliente: ${partners[0].name}. ¿Usás alguna plantilla de cotización? Las disponibles son: ${formatSaleOrderTemplateNameList()}. O decime "ninguna" para crear la OV sin plantilla.`,
      options: []
    };
  }
  if (flow.step === "client_create_confirm") {
    if (!isAffirmative(message)) {
      return { reply: "No avanzo sin cliente. Decime otro cliente o cancelá.", options: [] };
    }
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const newPartnerId = await odoo.executeKw(uid, "res.partner", "create", [{
      name: String(flow.data.clientInputName || "").trim(),
      customer_rank: 1
    }]);
    flow.data.clientId = newPartnerId;
    flow.data.clientName = String(flow.data.clientInputName || "").trim();
    if (flow.data.saleTemplateId) {
      flow.step = "product_query";
      return { reply: `Listo, cliente creado: ${flow.data.clientName}. ¿Qué producto querés agregar?`, options: [] };
    }
    flow.step = "template";
    return {
      reply: `Listo, cliente creado: ${flow.data.clientName}. ¿Usás alguna plantilla de cotización? Las disponibles son: ${formatSaleOrderTemplateNameList()}. O decime "ninguna" para crear la OV sin plantilla.`,
      options: []
    };
  }
  if (flow.step === "client_select") {
    const selected = (flow.data.clientCandidates || []).find((c) => normalizeStr(c.name) === normalizeStr(message));
    if (!selected) return { reply: "No lo pude identificar. Decime el nombre completo del cliente.", options: [] };
    flow.data.clientId = selected.id;
    flow.data.clientName = selected.name;
    if (flow.data.saleTemplateId) {
      flow.step = "product_query";
      return { reply: `Cliente: ${selected.name}. ¿Qué producto querés agregar?`, options: [] };
    }
    flow.step = "template";
    return {
      reply: `Cliente: ${selected.name}. ¿Usás alguna plantilla de cotización? Las disponibles son: ${formatSaleOrderTemplateNameList()}. O decime "ninguna" para crear la OV sin plantilla.`,
      options: []
    };
  }
  if (flow.step === "product_query") {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const candidates = await findProductTemplateCandidatesForOv(odoo, uid, message);
    if (!candidates.length) {
      flow.step = "product_not_found";
      flow.data._lastQuery = String(message || "").trim();
      return {
        reply: "No encontré ese producto. ¿Querés crearlo como borrador (nombre + precio + categoría) o probar otra búsqueda?",
        options: ["Crear producto borrador", "Otra búsqueda"]
      };
    }
    if (candidates.length > 1) {
      flow.step = "product_select";
      flow.data.productCandidates = candidates.slice(0, 3);
      return { reply: "Encontré más de un producto. Elegí uno:", options: flow.data.productCandidates.map((c) => c.label) };
    }
    const minQ = await readProductTemplateMinQty(odoo, uid, candidates[0].templateId);
    flow.data.productTemplateId = candidates[0].templateId;
    flow.data.productName = candidates[0].label;
    flow.data.minOrderQty = minQ || 0;
    flow.step = "quantity";
    let w = `Producto: ${candidates[0].label}.\n¿Qué cantidad querés?`;
    if (minQ > 0) w += `\n(Atención: mínimo habitual del artículo en ODOO: ${minQ} u.)`;
    return { reply: w, options: [] };
  }
  if (flow.step === "product_not_found") {
    if (isNegative(message)) {
      return { reply: "Dale, seguís en la OV. Decime otra búsqueda o cancelá toda la OV con «no».", options: [] };
    }
    if (normalizeStr(message).includes("otra") || normalizeStr(message).includes("otra b")) {
      flow.step = "product_query";
      return { reply: "Pasame otra búsqueda (tipo, medida, color, nombre).", options: [] };
    }
    flow.step = "ov_draft_pname";
    return { reply: "Perfecto, borrador. ¿Cómo querés que se llame el producto?", options: [] };
  }
  if (flow.step === "ov_draft_pname") {
    const n = String(message || "").trim();
    if (n.length < 2) return { reply: "Escribí al menos 2 letras de nombre de producto.", options: [] };
    flow.data._draftPName = n;
    flow.step = "ov_draft_pprice";
    return { reply: "¿Qué precio de lista (ARS) le ponemos a ese borrador?", options: [] };
  }
  if (flow.step === "ov_draft_pprice") {
    const p = normalizeMoney(message);
    if (!Number.isFinite(p) || p <= 0) return { reply: "Pasame un precio válido. Ej: 500 o 1200,50.", options: [] };
    flow.data._draftPPrice = p;
    try {
      validateEnv();
    } catch (e) {
      return { reply: e.message, options: [] };
    }
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const ch = await getTopProductCategoryChoices(odoo, uid);
    if (!ch.length) {
      return { reply: "No pude leer categorías. Cancelá o probá otra búsqueda de producto.", options: [] };
    }
    flow.data._draftCats = ch;
    flow.step = "ov_draft_pcat";
    return {
      reply: "Elegí categoría (una de las primeras de tu catálogo de producto):",
      options: ch.map((c) => c.name).slice(0, 3)
    };
  }
  if (flow.step === "ov_draft_pcat") {
    const ch = flow.data._draftCats || [];
    const hit = ch.find(
      (c) => normalizeStr(c.name) === normalizeStr(message) || normalizeStr(message).includes(normalizeStr(c.name))
    );
    if (!hit) {
      return { reply: "Elegí un nombre de la lista (botones).", options: ch.map((c) => c.name).slice(0, 3) };
    }
    let tid;
    try {
      const odoo = createOdooClient();
      const uid = await odoo.authenticate();
      tid = await createProductAsDraft(odoo, uid, {
        name: flow.data._draftPName,
        categoryId: hit.id,
        listPrice: flow.data._draftPPrice,
        note: "Borrador Asistente Facu (OV)"
      });
    } catch (e) {
      return { reply: `No pude crear el producto: ${(e && e.message) || e}`, options: [] };
    }
    flow.data.productTemplateId = tid;
    flow.data.productName = flow.data._draftPName;
    flow.data.minOrderQty = 0;
    flow.step = "quantity";
    return {
      reply: `Listo, producto borrador creado. ¿Qué cantidad ponemos en la OV?`,
      options: []
    };
  }
  if (flow.step === "product_select") {
    const selected = (flow.data.productCandidates || []).find((c) => normalizeStr(c.label) === normalizeStr(message));
    if (!selected) {
      return {
        reply: "Elegí una de las opciones para continuar.",
        options: (flow.data.productCandidates || []).map((c) => c.label)
      };
    }
    try {
      validateEnv();
    } catch (e) {
      return { reply: e.message, options: [] };
    }
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const minQ = await readProductTemplateMinQty(odoo, uid, selected.templateId);
    flow.data.productTemplateId = selected.templateId;
    flow.data.productName = selected.label;
    flow.data.minOrderQty = minQ || 0;
    flow.step = "quantity";
    let w = `Producto: ${selected.label}.\n¿Qué cantidad querés?`;
    if (minQ > 0) w += `\n(Atención: mínimo habitual: ${minQ} u.)`;
    return { reply: w, options: [] };
  }
  if (flow.step === "quantity") {
    const quantity = Number(String(message || "").replace(",", ".").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(quantity) || quantity <= 0) return { reply: "Decime una cantidad válida.", options: [] };
    const minQ = Number(flow.data.minOrderQty) || 0;
    if (minQ > 0 && quantity < minQ) {
      flow.data._pendingLowQty = quantity;
      flow.step = "quantity_low";
      return {
        reply: `⚠️ El mínimo de este producto es ${minQ}. Querés continuar igual?`,
        options: ["Sí, continuar con esa cantidad", "Cambiar cantidad"]
      };
    }
    flow.data.quantity = quantity;
    flow.step = "pricelist";
    return { reply: "¿Usamos lista WEB o lista Facu?", options: ["Lista WEB", "Lista Facu"] };
  }
  if (flow.step === "quantity_low") {
    const m = normalizeStr(message);
    if (m.includes("cambiar") || m.includes("cantidad") || m.includes("otra")) {
      flow.step = "quantity";
      return {
        reply: `Dale, pasame la cantidad otra vez (mínimo sugerido ${Number(flow.data.minOrderQty) || 0} u.).`,
        options: []
      };
    }
    if (
      m.includes("continuar") ||
      m.includes("scontinu") ||
      m.includes("sicontinu") ||
      m.includes("igual") ||
      isAffirmative(message)
    ) {
      flow.data.quantity = flow.data._pendingLowQty;
    } else {
      return {
        reply: "Elegí con un botón o decime si seguís con la cantidad que dijiste o si querés cambiarla.",
        options: ["Sí, continuar con esa cantidad", "Cambiar cantidad"]
      };
    }
    flow.step = "pricelist";
    return { reply: "¿Usamos lista WEB o lista Facu?", options: ["Lista WEB", "Lista Facu"] };
  }
  if (flow.step === "pricelist") {
    const selectedPricelist = pickPricelistChoice(message);
    if (!selectedPricelist) return { reply: "Decime solo: lista WEB o lista Facu.", options: ["Lista WEB", "Lista Facu"] };
    flow.data.pricelistChoice = selectedPricelist;
    flow.step = "confirm";
    const tpl =
      flow.data.saleTemplateId != null
        ? (() => {
            const tt = (saleOrderTemplates || []).find((x) => x.id === flow.data.saleTemplateId);
            return tt ? `Plantilla: ${tt.name}\n` : "";
          })()
        : "";
    return {
      reply:
        `Resumen OV:\n` +
        `Marca: ${flow.data.brandName}\n` +
        `Cliente: ${flow.data.clientName}\n` +
        tpl +
        `Producto: ${flow.data.productName}\n` +
        `Cantidad: ${flow.data.quantity}\n` +
        `Lista de precios: ${selectedPricelist}\n` +
        `¿Confirmás crear la OV en borrador?`,
      options: ["Sí, confirmar", "No, cancelar"]
    };
  }
  if (flow.step === "confirm") {
    if (!isAffirmative(message)) {
      return { reply: "Para avanzar necesito confirmación.", options: ["Sí, confirmar", "No, cancelar"] };
    }
    let created;
    try {
      created = await createSaleOrderDraft(flow.data);
    } catch (e) {
      return { reply: `No se pudo crear la OV: ${(e && e.message) || e}. Revisá datos o probá otra lista.`, options: [] };
    }
    session.pendingWrite = null;
    return { reply: created.reply, options: [] };
  }
  return { reply: "No pude continuar la creación de OV.", options: [] };
}

async function continueCreateOcFlow(session, message) {
  const flow = session.pendingWrite;
  if (flow.step === "supplier") {
    const supplierName = findBestSupplierInCache(message) || String(message || "").trim();
    if (!supplierName) return { reply: "Decime el proveedor para crear la OC.", options: [] };
    flow.data.supplierName = supplierName;
    flow.step = "linked_ov";
    return { reply: "¿Qué OVs querés vincular? (ej: S01234, S01235)", options: [] };
  }
  if (flow.step === "linked_ov") {
    const ovs = extractSaleOrderNames(message);
    if (!ovs.length) return { reply: "Necesito al menos una OV válida (formato S0XXXX).", options: [] };
    flow.data.linkedOvs = ovs.join(", ");
    flow.step = "product_qty";
    return { reply: "Ahora decime producto y cantidad para la OC (ej: Hang tag simple x500).", options: [] };
  }
  if (flow.step === "product_qty") {
    const parsed = parseProductQtyText(message);
    if (!parsed) return { reply: "Pasamelo como producto + cantidad. Ejemplo: Etiqueta premium x1200.", options: [] };
    flow.data.productName = parsed.productName;
    flow.data.quantity = parsed.quantity;
    flow.step = "price";
    return { reply: `¿Qué precio unitario querés para "${parsed.productName}"?`, options: [] };
  }
  if (flow.step === "price") {
    const unitPrice = normalizeMoney(message);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return { reply: "Indicame un precio válido. Ejemplo: 240 o $240.", options: [] };
    flow.data.unitPrice = unitPrice;
    flow.step = "confirm";
    return {
      reply:
        `Resumen OC:\n` +
        `Proveedor: ${flow.data.supplierName}\n` +
        `OVs vinculadas: ${flow.data.linkedOvs}\n` +
        `Producto: ${flow.data.productName}\n` +
        `Cantidad: ${flow.data.quantity}\n` +
        `Precio unitario: $${unitPrice.toFixed(2)}\n` +
        `¿Confirmás crear la OC en borrador?`,
      options: ["Sí, confirmar", "No, cancelar"]
    };
  }
  if (flow.step === "confirm") {
    if (!isAffirmative(message)) {
      return { reply: "Para avanzar necesito confirmación.", options: ["Sí, confirmar", "No, cancelar"] };
    }
    const created = await createPurchaseOrderDraft(flow.data);
    session.pendingWrite = null;
    return { reply: created.reply, options: [] };
  }
  return { reply: "No pude continuar la creación de OC.", options: [] };
}

async function createSaleOrderDraft(data) {
  validateEnv();
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  if (!data.clientId) {
    throw new Error("No hay cliente válido para crear la OV.");
  }
  const product = await findSingleProductVariantForTemplate(odoo, uid, data.productTemplateId);
  if (!product) throw new Error(`No encontré variante de producto para "${data.productName}".`);
  const pricelistId = await findPricelistIdByChoice(odoo, uid, data.pricelistChoice);
  if (!pricelistId) throw new Error(`No encontré la lista de precios "${data.pricelistChoice}".`);
  const orderVals = {
    partner_id: data.clientId,
    x_studio_marca: String(data.brandName || "").trim(),
    pricelist_id: pricelistId
  };
  if (data.saleTemplateId != null) {
    orderVals.sale_order_template_id = data.saleTemplateId;
  }
  const orderId = await odoo.executeKw(uid, "sale.order", "create", [orderVals]);
  await odoo.executeKw(uid, "sale.order.line", "create", [{
    order_id: orderId,
    product_id: product.id,
    product_uom_qty: data.quantity,
    name: product.name
  }]);
  const created = await odoo.executeKw(
    uid,
    "sale.order",
    "search_read",
    [[["id", "=", orderId]]],
    { fields: ["name"], limit: 1 }
  );
  return { reply: `OV en borrador creada correctamente: ${created?.[0]?.name || orderId}` };
}

async function createPurchaseOrderDraft(data) {
  validateEnv();
  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const supplier = await findPartnerByName(odoo, uid, data.supplierName);
  if (!supplier) throw new Error(`No encontré el proveedor "${data.supplierName}".`);
  const product = await findSingleProductForWrite(odoo, uid, data.productName);
  if (!product) throw new Error(`No encontré el producto "${data.productName}".`);

  const orderId = await odoo.executeKw(uid, "purchase.order", "create", [{
    partner_id: supplier.id,
    x_studio_documento_relacionado: data.linkedOvs
  }]);
  await odoo.executeKw(uid, "purchase.order.line", "create", [{
    order_id: orderId,
    product_id: product.id,
    product_qty: data.quantity,
    price_unit: data.unitPrice,
    name: product.name,
    date_planned: new Date().toISOString().slice(0, 10)
  }]);
  const created = await odoo.executeKw(
    uid,
    "purchase.order",
    "search_read",
    [[["id", "=", orderId]]],
    { fields: ["name"], limit: 1 }
  );
  return { reply: `OC en borrador creada correctamente: ${created?.[0]?.name || orderId}` };
}

async function findSingleProductForWrite(odoo, uid, productName) {
  const products = await odoo.executeKw(
    uid,
    "product.product",
    "search_read",
    [[["name", "ilike", productName]]],
    { fields: ["id", "name"], limit: 10 }
  );
  if (!products.length) return null;
  if (products.length === 1) return products[0];
  const exact = products.find((p) => normalizeStr(p.name) === normalizeStr(productName));
  return exact || products[0];
}

function pickPricelistChoice(message) {
  const n = normalizeStr(message);
  if (n.includes("web")) return "Lista WEB";
  if (n.includes("facu")) return "Lista Facu";
  return "";
}

function buildProductCategoryHints(message) {
  const n = normalizeStr(message);
  const hints = [];
  if (n.includes("bordad")) hints.push("Etiquetas Bordadas");
  if (n.includes("altadefinicion") || n.includes("alta")) hints.push("Alta Definicion");
  if (n.includes("tafeta")) hints.push("Tafeta");
  if (n.includes("hangtag")) hints.push("Hang Tag");
  if (n.includes("badana")) hints.push("Badana");
  if (n.includes("algodon")) hints.push("Algodon");
  if (n.includes("bolsa") && (n.includes("plastico") || n.includes("camiseta"))) hints.push("Bolsas de Plastico");
  if (n.includes("friselina")) hints.push("Bolsas de Friselina");
  if (n.includes("otrasetiquetas")) hints.push("Otras Etiquetas");
  return Array.from(new Set(hints));
}

function buildReadableProductOption(template, categoryName) {
  const productName = cleanProductLabel(template.name || "Producto");
  const categoryTail = String(categoryName || "").split("/").pop()?.trim();
  const desc = String(template.description_sale || "").trim();
  const unitHint = desc ? desc.split(".")[0] : "";
  const parts = [productName];
  if (categoryTail) parts.push(categoryTail);
  if (unitHint) parts.push(unitHint);
  return parts.join(" — ");
}

async function findProductTemplateCandidatesForOv(odoo, uid, userText) {
  const tokens = tokenizeForMatch(userText);
  const primaryToken = tokens[0] || String(userText || "").trim() || "x";
  const base = [
    "&",
    ["sale_ok", "=", true],
    "|",
    ["name", "ilike", primaryToken],
    ["description_sale", "ilike", primaryToken]
  ];
  const domain = [
    "&",
    ["sale_ok", "=", true],
    "|",
    "|",
    ["name", "ilike", primaryToken],
    ["description_sale", "ilike", primaryToken],
    ["x_studio_ecommerce", "ilike", primaryToken]
  ];
  let templates = [];
  try {
    templates = await odoo.executeKw(
      uid,
      "product.template",
      "search_read",
      [domain],
      {
        fields: [
          "id",
          "name",
          "categ_id",
          "description_sale",
          "x_studio_ecommerce",
          "x_studio_minimo"
        ],
        limit: 60
      }
    );
  } catch {
    try {
      templates = await odoo.executeKw(
        uid,
        "product.template",
        "search_read",
        [base],
        {
          fields: [
            "id",
            "name",
            "categ_id",
            "description_sale",
            "x_studio_ecommerce",
            "x_studio_minimo"
          ],
          limit: 60
        }
      );
    } catch {
      try {
        templates = await odoo.executeKw(
          uid,
          "product.template",
          "search_read",
          [base],
          {
            fields: ["id", "name", "categ_id", "description_sale", "x_studio_minimo"],
            limit: 60
          }
        );
      } catch {
        templates = await odoo.executeKw(
          uid,
          "product.template",
          "search_read",
          [base],
          {
            fields: ["id", "name", "categ_id", "description_sale"],
            limit: 60
          }
        );
      }
    }
  }
  if (!templates.length) return [];

  const categIds = Array.from(
    new Set(
      templates
        .map((t) => (Array.isArray(t.categ_id) ? t.categ_id[0] : null))
        .filter(Boolean)
    )
  );
  const categories = categIds.length
    ? await odoo.executeKw(
        uid,
        "product.category",
        "search_read",
        [[["id", "in", categIds]]],
        { fields: ["id", "name", "complete_name"], limit: 200 }
      )
    : [];
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categoryHints = buildProductCategoryHints(userText).map((h) => normalizeStr(h));

  const scored = templates
    .map((template) => {
      const categoryId = Array.isArray(template.categ_id) ? template.categ_id[0] : null;
      const category = categoryId ? categoryById.get(categoryId) : null;
      const categoryName = String(category?.complete_name || category?.name || "");
      const ecommerceText = String(template.x_studio_ecommerce || "");
      const combined = `${template.name || ""} ${template.description_sale || ""} ${ecommerceText} ${categoryName}`;
      let score = scoreByWords(tokens, [combined]);
      if (categoryHints.length) {
        const normCat = normalizeStr(categoryName);
        if (categoryHints.some((hint) => normCat.includes(hint))) score += 4;
      }
      return {
        id: template.id,
        templateId: template.id,
        score,
        label: buildReadableProductOption(template, categoryName)
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0].score;
  const kept = (best > 0 ? scored.filter((row) => row.score > 0) : scored).sort((a, b) => b.score - a.score);
  const uniqueByTemplate = dedupeById(kept);
  return uniqueByTemplate.slice(0, 3);
}

async function findSingleProductVariantForTemplate(odoo, uid, productTemplateId) {
  const products = await odoo.executeKw(
    uid,
    "product.product",
    "search_read",
    [[["product_tmpl_id", "=", productTemplateId]]],
    { fields: ["id", "name"], limit: 5 }
  );
  return products[0] || null;
}

async function findPricelistIdByChoice(odoo, uid, choiceLabel) {
  const wantsWeb = normalizeStr(choiceLabel).includes("web");
  const token = wantsWeb ? "web" : "facu";
  const pricelists = await odoo.executeKw(
    uid,
    "product.pricelist",
    "search_read",
    [[["name", "ilike", token]]],
    { fields: ["id", "name"], limit: 10 }
  );
  const exact = pricelists.find((p) => normalizeStr(p.name).includes(token));
  return exact?.id || pricelists?.[0]?.id || null;
}

function extractEntityFromHistory(session, extractor) {
  const recent = [...(session.history || [])].reverse();
  for (const msg of recent) {
    if (msg.role !== "user") continue;
    const value = extractor(msg.content || "");
    if (value) return value;
  }
  return "";
}

function findBestSupplierInCache(rawText) {
  const tokens = tokenizeForMatch(rawText);
  const scores = pendingPurchaseOrders
    .map((po) => ({
      name: po.partnerName || "",
      score: scoreByWords(tokens, [po.partnerName])
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return scores[0]?.name || "";
}

function findBestClientInCache(rawText) {
  const tokens = tokenizeForMatch(rawText);
  const scores = pendingPurchaseOrders
    .map((po) => ({
      name: po.x_studio_marca || "",
      score: scoreByWords(tokens, [po.x_studio_marca, po.x_studio_documento_relacionado])
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return scores[0]?.name || "";
}

function buildReadableOcOption(po) {
  const firstLine = (po.lines || [])[0];
  const rawProductLabel = firstLine
    ? String(firstLine.name || firstLine.default_code || "").trim()
    : "Producto";
  const productLabel = rawProductLabel.replace(/^\[.*?\]\s*/, "").trim() || "Producto";
  const clientLabel = String(po.x_studio_marca || "Cliente").trim();
  return `${productLabel} — ${clientLabel}`;
}

function resolveDeliveryFromCache(session, message, opts = {}) {
  const normalized = normalizeStr(message);
  const supplierMention = findBestSupplierInCache(message);
  const isDeliveryIntent =
    normalized.includes("entrego") ||
    normalized.includes("entregaron") ||
    normalized.includes("recepcion") ||
    normalized.includes("mercaderia") ||
    normalized.includes("recibirmercaderia") ||
    (opts.forceFromSupplierMention && Boolean(supplierMention));
  if (!isDeliveryIntent) return null;

  const supplier =
    supplierMention ||
    extractEntityFromHistory(session, (t) => findBestSupplierInCache(t));
  if (!supplier) return null;

  const bySupplier = pendingPurchaseOrders.filter(
    (po) => normalizeStr(po.partnerName).includes(normalizeStr(supplier))
  );
  if (!bySupplier.length) return null;

  const client =
    findBestClientInCache(message) ||
    extractEntityFromHistory(session, (t) => findBestClientInCache(t));

  const bySupplierAndClient = client
    ? bySupplier.filter((po) => normalizeStr(po.x_studio_marca).includes(normalizeStr(client)))
    : [];

  const selectedSet = bySupplierAndClient.length ? bySupplierAndClient : bySupplier;
  if (selectedSet.length > 1) {
    const options = [];
    const reply = bySupplierAndClient.length
      ? "Encontré varias OCs para ese proveedor y cliente. Decime cuál es y lo sigo."
      : "Encontré varias OCs pendientes de ese proveedor. Decime cliente o número de OC y lo sigo.";
    return { reply, options, action: "pregunta" };
  }

  const po = selectedSet[0];
  const line = (po.lines || [])[0];
  if (!line) return null;
  const qtyPending = Math.max(0, Number(line.product_qty || 0) - Number(line.qty_received || 0));
  const supplierUnitPrice = Number(line.price_unit || 0);
  const sku = String(line.default_code || "").trim().toUpperCase();
  const data = {
    supplierName: po.partnerName,
    clientName: po.x_studio_marca || "",
    quantity: qtyPending,
    totalAmount: supplierUnitPrice * qtyPending,
    supplierUnitPrice,
    sku,
    purchaseOrderName: po.name,
    saleOrderName: "",
    variant: "",
    partnerName: ""
  };
  session.pendingDelivery = {
    ocId: po.id,
    label: buildReadableOcOption(po),
    data
  };
  const reply =
    `Detecté una recepción para ${buildReadableOcOption(po)}.\n` +
    `Cantidad pendiente: ${qtyPending}\n` +
    `Precio OC: $${supplierUnitPrice.toFixed(2)}\n` +
    `¿Confirmás registrar esta recepción?`;
  return { reply, options: ["Sí, confirmar", "No, cancelar"], action: "pendiente" };
}

function detectDeliveryIntentByKeywords(message) {
  const raw = String(message || "");
  const normalizedRaw = normalizeStr(raw);
  if (!normalizedRaw) return { type: "none", supplier: "" };

  const hasPriceVerb =
    normalizedRaw.includes("subi") ||
    normalizedRaw.includes("aument") ||
    normalizedRaw.includes("subieron") ||
    normalizedRaw.includes("aumentaron") ||
    normalizedRaw.includes("bajaron") ||
    normalizedRaw.includes("usbieron");
  const hasPriceNum =
    /%/.test(raw) ||
    normalizeStr(raw).includes("porciento") ||
    normalizeStr(raw).includes("porcient");
  if (hasPriceVerb && hasPriceNum) return { type: "none", supplier: "" };

  const supplier = findBestSupplierInCache(raw);
  if (!supplier) return { type: "none", supplier: "" };

  const deliveryVerbs = [
    "entrego",
    "llego",
    "recibi",
    "mando",
    "vino"
  ];
  const hasDeliveryVerb = deliveryVerbs.some((v) => normalizedRaw.includes(v));
  if (hasDeliveryVerb) {
    return { type: "supplier_delivery", supplier };
  }
  return { type: "supplier_only", supplier };
}

async function executePayment(data, partnerType) {
  const partnerName = String(data.partnerName || data.clientName || data.supplierName || "").trim();
  const amount = Number(data.amount || 0);
  const journalName = normalizeJournalName(String(data.journalName || "").trim());
  if (!partnerName || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Faltan datos para registrar el pago.");
  }

  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const partner = await findPartnerByName(odoo, uid, partnerName);
  if (!partner) throw new Error(`No se encontró el contacto "${partnerName}" en ODOO.`);
  const journal = await findJournalByName(odoo, uid, journalName);
  if (!journal) throw new Error(`No se encontró el diario "${journalName}" en ODOO.`);

  const paymentFlow = partnerType === "supplier" ? "outbound" : "inbound";
  const paymentMethodLine = await findPaymentMethodLine(odoo, uid, journal.id, paymentFlow);
  if (!paymentMethodLine) {
    throw new Error(`El diario "${journal.name}" no tiene método de pago configurado.`);
  }

  const paymentId = await createDraftPayment(odoo, uid, {
    partnerId: partner.id,
    amount,
    journalId: journal.id,
    paymentMethodLineId: paymentMethodLine.id,
    paymentFlow,
    partnerType,
    ref: String(data.ref || "").trim(),
    memo: String(data.memo || "").trim(),
    listaGastos: ""
  });

  return {
    reply:
      `Pago en borrador creado correctamente.\n` +
      `Tipo: ${partnerType === "supplier" ? "Pago a proveedor" : "Cobro de cliente"}\n` +
      `Contacto: ${partner.name}\n` +
      `Monto: $${amount.toFixed(2)}\n` +
      `Diario: ${journal.name}\n` +
      `ID de pago ODOO: ${paymentId}`
  };
}

async function executeDelivery(data) {
  const parsed = {
    supplierName: String(data.supplierName || "").trim(),
    clientName: String(data.clientName || "").trim(),
    quantity: Number(data.quantity || 0),
    totalAmount: Number(data.totalAmount || 0),
    supplierUnitPrice: Number(data.supplierUnitPrice || 0),
    sku: String(data.sku || "").trim().toUpperCase(),
    purchaseOrderName: String(data.purchaseOrderName || "").trim().toUpperCase(),
    saleOrderName: String(data.saleOrderName || "").trim().toUpperCase(),
    variant: String(data.variant || "").trim()
  };
  if (!parsed.supplierName || !parsed.clientName || !Number.isFinite(parsed.quantity) || parsed.quantity <= 0) {
    throw new Error("Faltan datos para registrar la recepción.");
  }

  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  let purchaseContext;
  const purchaseOrderNameFromMessage = extractPurchaseOrderNameFromMessage(parsed.purchaseOrderName);
  const inferredPurchaseOrderName = purchaseOrderNameFromMessage || parsed.purchaseOrderName;

  if (inferredPurchaseOrderName) {
    purchaseContext = await resolvePurchaseOrderForDeliveryByOcName(odoo, uid, {
      purchaseOrderName: inferredPurchaseOrderName,
      sku: parsed.sku,
      clientName: parsed.clientName,
      message: "",
      variant: parsed.variant,
      quantity: parsed.quantity
    });
  } else {
    purchaseContext = await resolvePurchaseOrderForDeliveryWithoutOcName(
      odoo,
      uid,
      parsed.clientName,
      parsed.supplierName,
      parsed.purchaseOrderName,
      parsed.sku,
      "",
      parsed.variant,
      parsed.quantity
    );
  }
  const supplierUnitPrice = resolveSupplierUnitPriceWithoutOc(parsed, purchaseContext);
  const saleOrderNameToUse = parsed.saleOrderName || purchaseContext.preferredSaleOrderName;
  const saleContext = saleOrderNameToUse
    ? await resolveSaleOrderByName(odoo, uid, {
        saleOrderName: saleOrderNameToUse,
        sku: purchaseContext.sku,
        productNameHint: purchaseContext.productName,
        clientName: parsed.clientName,
        message: "",
        variant: parsed.variant,
        quantity: parsed.quantity
      })
    : await resolveSaleOrderFromOrigin(
        odoo,
        uid,
        purchaseContext.relatedDocuments,
        purchaseContext.sku,
        purchaseContext.productName,
        parsed.clientName,
        "",
        parsed.variant,
        parsed.quantity
      );

  const existingSupplierDraftInvoice = await findDraftSupplierInvoiceByPurchaseOrderRef(
    odoo,
    uid,
    purchaseContext.name
  );
  if (existingSupplierDraftInvoice) {
    throw new Error(
      `Ya existe una factura de proveedor en borrador para OC ${purchaseContext.name}. Revisá en ODOO antes de continuar.`
    );
  }

  const existingCustomerDraftInvoice = await findDraftCustomerInvoiceBySaleOrderOrigin(
    odoo,
    uid,
    saleContext.name
  );
  if (existingCustomerDraftInvoice) {
    throw new Error(`Ya existe una factura de cliente en borrador para OV ${saleContext.name}.`);
  }

  const supplierInvoiceId = await createSupplierInvoiceForDelivery(odoo, uid, {
    supplierId: purchaseContext.partnerId,
    productId: purchaseContext.productId,
    quantity: parsed.quantity,
    supplierUnitPrice,
    clientName: parsed.clientName
  });
  const customerInvoiceId = await createCustomerInvoiceForDelivery(odoo, uid, {
    customerId: saleContext.customerId,
    productId: saleContext.productId,
    quantity: parsed.quantity,
    customerUnitPrice: saleContext.customerUnitPrice,
    saleOrderName: saleContext.name
  });
  const pickingResult = await validateIncomingPickingForPurchaseOrder(odoo, uid, {
    purchaseOrderName: purchaseContext.name,
    sku: purchaseContext.sku,
    productId: purchaseContext.productId,
    quantity: parsed.quantity
  });

  return {
    reply:
      `Recepcion registrada correctamente.\n` +
      `OC encontrada: ${purchaseContext.name}\n` +
      `OV linkeada: ${saleContext.name}\n` +
      `Cliente: ${saleContext.customerName}\n` +
      `Factura proveedor ID: ${supplierInvoiceId}\n` +
      `Factura cliente ID: ${customerInvoiceId}\n` +
      `Recepcion validada: ${pickingResult.pickingName}`
  };
}

function validateEnv() {
  const required = [
    "ODOO_URL",
    "ODOO_DB",
    "ODOO_USERNAME",
    "ODOO_API_KEY",
    "GROQ_API_KEY"
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

function normalizeStr(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function tokenizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

function includesNormalized(haystack, needle) {
  return normalizeStr(haystack).includes(normalizeStr(needle));
}

function scoreByWords(tokens, texts) {
  const normalizedTexts = (texts || []).map((t) => normalizeStr(t)).join(" ");
  let score = 0;
  for (const token of tokens || []) {
    if (token && normalizedTexts.includes(normalizeStr(token))) {
      score += 1;
    }
  }
  return score;
}

function detectVariantHints(message, variant, quantity) {
  const source = `${message || ""} ${variant || ""}`.toLowerCase();
  const measureMatch = source.match(/\d+\s*[,xX]\s*\d+/) || source.match(/\d+[xX]\d+/);
  const measure = measureMatch ? measureMatch[0].replace(/\s+/g, "") : "";
  const normalized = normalizeStr(source);
  return {
    measure: normalizeStr(measure),
    wantsSmall:
      normalized.includes("chico") ||
      normalized.includes("chica") ||
      normalized.includes("pequeno") ||
      normalized.includes("small"),
    wantsBig:
      normalized.includes("grande") ||
      normalized.includes("largo") ||
      normalized.includes("big"),
    quantityHint: Number(quantity || 0)
  };
}

function selectBestLineByVariant(lines, { message, variant, quantity }) {
  if (!lines.length) return null;
  const hints = detectVariantHints(message, variant, quantity);
  console.log("[match] variante seleccionada:", hints);

  const withName = lines.map((line) => {
    const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
    return {
      ...line,
      _name: String(line.name || productTuple[1] || "")
    };
  });

  if (hints.measure) {
    const byMeasure = withName.find((line) => includesNormalized(line._name, hints.measure));
    if (byMeasure) return byMeasure;
  }
  if (hints.wantsSmall) {
    return [...withName].sort((a, b) => Number(a.price_unit || 0) - Number(b.price_unit || 0))[0];
  }
  if (hints.wantsBig) {
    return [...withName].sort((a, b) => Number(b.price_unit || 0) - Number(a.price_unit || 0))[0];
  }
  if (hints.quantityHint > 0) {
    return [...withName].sort((a, b) => {
      const aDiff = Math.abs(Number(a.product_qty || 0) - hints.quantityHint);
      const bDiff = Math.abs(Number(b.product_qty || 0) - hints.quantityHint);
      return aDiff - bDiff;
    })[0];
  }
  return withName[0];
}

function buildPendingPurchaseOrdersSummary() {
  if (!pendingPurchaseOrders.length) {
    return "Sin datos precargados.";
  }
  return pendingPurchaseOrders
    .slice(0, 20)
    .map((po) => {
      const supplier = po.partnerName || "Sin proveedor";
      const marca = po.x_studio_marca || "Sin marca";
      const ovs = po.x_studio_documento_relacionado || "Sin OVs";
      const lineSummary = (po.lines || [])
        .slice(0, 5)
        .map((line) => {
          const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
          const sku = String(line.default_code || "").trim() || "N/A";
          const desc = String(line.name || productTuple[1] || "").trim() || "Sin descripcion";
          const pendingQty = Math.max(0, Number(line.product_qty || 0) - Number(line.qty_received || 0));
          const price = Number(line.price_unit || 0);
          return `${sku} | ${desc} | pend: ${pendingQty} | $${price}`;
        })
        .join(" ; ");
      return `${po.name} - Proveedor: ${supplier} - Marca: ${marca} - OVs: ${ovs} - Lineas: ${lineSummary}`;
    })
    .join("\n");
}

function normalizeJournalName(value) {
  const lowered = value.toLowerCase();
  if (lowered.includes("santander")) return "Banco Santander Milito";
  if (lowered.includes("mercado")) return "MercadoPago";
  if (lowered.includes("efectivo") || lowered.includes("cash") || lowered === "efectivo")
    return "Cash";
  return value;
}


function createOdooClient() {
  const odooUrl = process.env.ODOO_URL.replace(/\/$/, "");

  async function jsonRpc(service, method, args) {
    const response = await fetch(`${odooUrl}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id: Date.now()
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ODOO JSON-RPC HTTP error ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error?.data?.message || data.error?.message || "Error de ODOO");
    }

    return data.result;
  }

  return {
    authenticate() {
      return jsonRpc("common", "authenticate", [
        process.env.ODOO_DB,
        process.env.ODOO_USERNAME,
        process.env.ODOO_API_KEY,
        {}
      ]);
    },
    executeKw(uid, model, method, positionalArgs = [], keywordArgs = {}) {
      return jsonRpc("object", "execute_kw", [
        process.env.ODOO_DB,
        uid,
        process.env.ODOO_API_KEY,
        model,
        method,
        positionalArgs,
        keywordArgs
      ]);
    }
  };
}

async function findDraftSupplierInvoiceByPurchaseOrderRef(odoo, uid, purchaseOrderName) {
  const invoices = await odoo.executeKw(
    uid, "account.move", "search_read",
    [[
      ["move_type", "=", "in_invoice"],
      ["ref", "=", purchaseOrderName],
      ["state", "=", "draft"]
    ]],
    { fields: ["id"], limit: 1 }
  );
  return invoices[0] || null;
}

async function findDraftCustomerInvoiceBySaleOrderOrigin(odoo, uid, saleOrderName) {
  const invoices = await odoo.executeKw(
    uid, "account.move", "search_read",
    [[
      ["move_type", "=", "out_invoice"],
      ["invoice_origin", "=", saleOrderName],
      ["state", "=", "draft"]
    ]],
    { fields: ["id"], limit: 1 }
  );
  return invoices[0] || null;
}

function extractPurchaseOrderNameFromMessage(message) {
  const match = String(message || "").match(/\bP0\d+\b/i);
  return match ? match[0].toUpperCase() : "";
}

async function resolvePurchaseOrderForDeliveryByOcName(
  odoo,
  uid,
  { purchaseOrderName, sku, clientName, message, variant, quantity }
) {
  let purchaseOrders;
  try {
    purchaseOrders = await odoo.executeKw(
      uid, "purchase.order", "search_read",
      [[["name", "=", purchaseOrderName], ["state", "=", "purchase"]]],
      {
        fields: ["id", "name", "partner_id", "x_studio_documento_relacionado", "origin", "order_line"],
        limit: 1
      }
    );
  } catch (error) {
    throw new Error(`Error al buscar OC ${purchaseOrderName} en ODOO: ${error.message}`);
  }

  const po = purchaseOrders[0];
  if (!po) {
    throw new Error(`No se encontro la OC ${purchaseOrderName} en estado confirmada.`);
  }

  let lines = [];
  try {
    lines = await odoo.executeKw(
      uid, "purchase.order.line", "search_read",
      [[["id", "in", po.order_line || []]]],
      { fields: ["id", "product_id", "product_qty", "qty_received", "name", "price_unit", "date_planned"], limit: 80 }
    );
  } catch (error) {
    throw new Error(`Error al leer lineas de la OC ${po.name}: ${error.message}`);
  }

  const pendingLines = lines.filter((item) => Number(item.qty_received || 0) < Number(item.product_qty || 0));
  const clientTokens = tokenizeForMatch(clientName);
  const filteredByClient = pendingLines.filter(
    (item) => !clientTokens.length || scoreByWords(clientTokens, [item.name]) > 0
  );
  const filteredBySku = (filteredByClient.length ? filteredByClient : pendingLines).filter(
    (item) => !sku || matchSkuInPurchaseLine(item, sku)
  );
  const line = selectBestLineByVariant(
    filteredBySku.length ? filteredBySku : pendingLines,
    { message, variant, quantity }
  );
  if (!line) {
    throw new Error(`No hay lineas pendientes de recibir para SKU ${sku} en la OC ${po.name}.`);
  }

  const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
  const partnerTuple = Array.isArray(po.partner_id) ? po.partner_id : [];
  const productId = productTuple[0];
  const partnerId = partnerTuple[0];
  if (!productId || !partnerId) {
    throw new Error(`La OC ${po.name} no tiene producto o proveedor valido para el SKU ${sku}.`);
  }

  const resolvedSku = sku || (await findProductDefaultCodeById(odoo, uid, productId));
  if (!resolvedSku) {
    throw new Error(`No se pudo determinar SKU en la OC ${po.name}.`);
  }
  console.log("[match] SKU seleccionado:", resolvedSku);

  const preferredSaleOrderName = await findPreferredSaleOrderNameForDelivery(odoo, uid, {
    relatedDocuments: String(po.x_studio_documento_relacionado || ""),
    clientName,
    sku: resolvedSku,
    productNameHint: String(line.name || (Array.isArray(line.product_id) ? line.product_id[1] || "" : "")),
    message,
    variant,
    quantity
  });

  return {
    id: po.id,
    name: po.name,
    relatedDocuments: String(po.x_studio_documento_relacionado || ""),
    partnerId,
    lineId: line.id,
    productId,
    sku: resolvedSku,
    productName: String(line.name || (Array.isArray(line.product_id) ? line.product_id[1] || "" : "")),
    purchaseLineUnitPrice: Number(line.price_unit || 0),
    expectedDate: String(line.date_planned || ""),
    preferredSaleOrderName
  };
}

async function resolvePurchaseOrderForDeliveryWithoutOcName(
  odoo,
  uid,
  clientName,
  supplierName,
  purchaseOrderName,
  skuHint,
  message,
  variant,
  quantity
) {
  if (purchaseOrderName) {
    return resolvePurchaseOrderForDeliveryByOcName(odoo, uid, {
      purchaseOrderName,
      sku: skuHint,
      clientName,
      message,
      variant,
      quantity
    });
  }
  console.log("[delivery] buscando OC:", { supplierName, clientName });
  const supplierMatch = await findBestSupplierPartner(odoo, uid, supplierName);
  const purchaseOrders = await odoo.executeKw(
    uid,
    "purchase.order",
    "search_read",
    [[["state", "=", "purchase"], ["partner_id", "=", supplierMatch.partnerId]]],
    {
      fields: [
        "id",
        "name",
        "partner_id",
        "date_order",
        "x_studio_marca",
        "x_studio_documento_relacionado",
        "order_line"
      ],
      limit: 60
    }
  );

  if (!purchaseOrders.length) {
    throw new Error(
      `No se encontraron OCs confirmadas para cliente ${clientName} en proveedor ${supplierName}.`
    );
  }
  console.log("[delivery] OCs encontradas:", purchaseOrders.map((o) => o.name));

  const candidates = [];
  for (const po of purchaseOrders) {
    let lines = [];
    try {
      lines = await odoo.executeKw(
        uid, "purchase.order.line", "search_read",
        [[["order_id", "=", po.id]]],
        {
          fields: ["id", "product_id", "product_qty", "qty_received", "price_unit", "name", "date_planned"],
          limit: 40
        }
      );
    } catch (error) {
      throw new Error(`Error al leer lineas de la OC ${po.name}: ${error.message}`);
    }

    const clientTokens = tokenizeForMatch(clientName);
    const poClientScore = scoreByWords(clientTokens, [po.x_studio_marca, po.partner_id?.[1]]);
    const matchingLines = lines.filter((item) => {
      const isPending = Number(item.qty_received || 0) < Number(item.product_qty || 0);
      const lineClientScore = scoreByWords(clientTokens, [item.name]);
      const skuMatch = skuHint ? matchSkuInPurchaseLine(item, skuHint) : true;
      return isPending && (lineClientScore > 0 || poClientScore > 0 || !clientTokens.length) && skuMatch;
    });
    if (!matchingLines.length) {
      continue;
    }

    const line = selectBestLineByVariant(matchingLines, { message, variant, quantity });
    const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
    const partnerTuple = Array.isArray(po.partner_id) ? po.partner_id : [];
    const productId = productTuple[0];
    const partnerId = partnerTuple[0];
    if (!productId || !partnerId) {
      throw new Error(`La OC ${po.name} no tiene producto o proveedor valido para el cliente ${clientName}.`);
    }

    const sku = await findProductDefaultCodeById(odoo, uid, productId);
    if (!sku) {
      throw new Error(`No se pudo determinar SKU del producto ${productId} en la OC ${po.name}.`);
    }
    console.log("[match] SKU seleccionado:", sku);

    const pendingQty = matchingLines.reduce(
      (acc, item) => acc + Math.max(0, Number(item.product_qty || 0) - Number(item.qty_received || 0)),
      0
    );
    const expectedDate = matchingLines
      .map((item) => item.date_planned)
      .filter(Boolean)
      .sort()[0] || "";

    const preferredSaleOrderName = await findPreferredSaleOrderNameForDelivery(odoo, uid, {
      relatedDocuments: String(po.x_studio_documento_relacionado || ""),
      clientName,
      sku,
      productNameHint: String(line.name || (Array.isArray(line.product_id) ? line.product_id[1] || "" : "")),
      message,
      variant,
      quantity
    });
    console.log("[match] cliente encontrado:", { oc: po.name, line: line.name, marca: po.x_studio_marca });

    candidates.push({
      id: po.id,
      name: po.name,
      relatedDocuments: String(po.x_studio_documento_relacionado || ""),
      partnerId,
      lineId: line.id,
      productId,
      sku,
      productName: String(line.name || (Array.isArray(line.product_id) ? line.product_id[1] || "" : "")),
      purchaseLineUnitPrice: Number(line.price_unit || 0),
      expectedDate,
      pendingQty,
      preferredSaleOrderName
    });
  }

  if (candidates.length) {
    candidates.sort((a, b) => {
      const aDate = a.expectedDate ? Date.parse(a.expectedDate) : Number.POSITIVE_INFINITY;
      const bDate = b.expectedDate ? Date.parse(b.expectedDate) : Number.POSITIVE_INFINITY;
      if (aDate !== bDate) return aDate - bDate;
      return (b.pendingQty || 0) - (a.pendingQty || 0);
    });
    return candidates[0];
  }

  // Fallback extra: si no hubo match por linea, intentar por campos de cabecera de OC.
  const clientTokens = tokenizeForMatch(clientName);
  const poHeaderCandidates = purchaseOrders
    .map((po) => ({
      po,
      score: scoreByWords(clientTokens, [
        po.x_studio_marca,
        po.x_studio_documento_relacionado
      ])
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const row of poHeaderCandidates) {
    const po = row.po;
    let lines = [];
    try {
      lines = await odoo.executeKw(
        uid, "purchase.order.line", "search_read",
        [[["order_id", "=", po.id]]],
        {
          fields: ["id", "product_id", "product_qty", "qty_received", "price_unit", "name", "date_planned"],
          limit: 40
        }
      );
    } catch (error) {
      throw new Error(`Error al leer lineas fallback de la OC ${po.name}: ${error.message}`);
    }

    const pendingLines = lines.filter((item) => Number(item.qty_received || 0) < Number(item.product_qty || 0));
    const skuFiltered = skuHint
      ? pendingLines.filter((item) => matchSkuInPurchaseLine(item, skuHint))
      : pendingLines;
    const line = selectBestLineByVariant(
      skuFiltered.length ? skuFiltered : pendingLines,
      { message, variant, quantity }
    );
    if (!line) continue;

    const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
    const partnerTuple = Array.isArray(po.partner_id) ? po.partner_id : [];
    const productId = productTuple[0];
    const partnerId = partnerTuple[0];
    if (!productId || !partnerId) continue;

    const sku = await findProductDefaultCodeById(odoo, uid, productId);
    if (!sku) continue;

    const preferredSaleOrderName = await findPreferredSaleOrderNameForDelivery(odoo, uid, {
      relatedDocuments: String(po.x_studio_documento_relacionado || ""),
      clientName,
      sku,
      productNameHint: String(line.name || (Array.isArray(line.product_id) ? line.product_id[1] || "" : ""))
    });

    return {
      id: po.id,
      name: po.name,
      relatedDocuments: String(po.x_studio_documento_relacionado || ""),
      partnerId,
      lineId: line.id,
      productId,
      sku,
      productName: String(line.name || (Array.isArray(line.product_id) ? line.product_id[1] || "" : "")),
      purchaseLineUnitPrice: Number(line.price_unit || 0),
      expectedDate: String(line.date_planned || ""),
      pendingQty: Math.max(0, Number(line.product_qty || 0) - Number(line.qty_received || 0)),
      preferredSaleOrderName
    };
  }

  throw new Error(
    `No se encontro una linea pendiente en OCs de ${supplierName} que matchee cliente ${clientName}.`
  );
}

function dedupeById(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.id)) {
      map.set(row.id, row);
    }
  }
  return Array.from(map.values());
}

async function findBestSupplierPartner(odoo, uid, supplierName) {
  const words = tokenizeForMatch(supplierName);
  const candidates = [];
  for (const word of words) {
    const partners = await odoo.executeKw(
      uid,
      "res.partner",
      "search_read",
      [[["name", "ilike", word]]],
      { fields: ["id", "name"], limit: 30 }
    );
    candidates.push(...partners);
  }
  const deduped = dedupeById(candidates);
  const scores = deduped
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: scoreByWords(words, [p.name])
    }))
    .sort((a, b) => b.score - a.score);
  console.log("[match] proveedor score:", scores.slice(0, 10));
  const best = scores[0];
  if (!best || best.score <= 0) {
    throw new Error(`No pude matchear proveedor "${supplierName}" en ODOO.`);
  }
  return { partnerId: best.id, partnerName: best.name };
}

async function findPreferredSaleOrderNameForDelivery(
  odoo,
  uid,
  { relatedDocuments, clientName, sku, productNameHint }
) {
  const saleOrderNamesFromPurchase = extractSaleOrderNames(relatedDocuments);
  if (saleOrderNamesFromPurchase.length) {
    let firstExistingSaleOrderName = "";
    for (const saleName of saleOrderNamesFromPurchase) {
      const saleOrders = await odoo.executeKw(
        uid, "sale.order", "search_read",
        [[["name", "=", saleName], ["state", "=", "sale"], ["invoice_status", "!=", "invoiced"]]],
        { fields: ["id", "name", "order_line"], limit: 1 }
      );
      const saleOrder = saleOrders[0];
      if (!saleOrder) continue;
      if (!firstExistingSaleOrderName) {
        firstExistingSaleOrderName = saleOrder.name;
      }
      if (!sku) {
        console.log("[delivery] OV encontrada por criterio:", "oc_documento_relacionado_fallback", saleOrder.name);
        return saleOrder.name;
      }
      const saleLines = await odoo.executeKw(
        uid, "sale.order.line", "search_read",
        [[["id", "in", saleOrder.order_line || []]]],
        { fields: ["id", "name", "product_id", "price_unit", "product_uom_qty"], limit: 200 }
      );
      if (filterSaleLinesForSkuOrName(saleLines, sku, productNameHint).length) {
        console.log("[delivery] OV encontrada por criterio:", "oc_documento_relacionado_sku", saleOrder.name);
        return saleOrder.name;
      }
    }
    if (firstExistingSaleOrderName) {
      console.log(
        "[delivery] OV encontrada por criterio:",
        "oc_documento_relacionado_primera",
        firstExistingSaleOrderName
      );
      return firstExistingSaleOrderName;
    }
  }

  const criteria = [
    { key: "a_partner_name", field: "partner_id.name" },
    { key: "b_x_studio_marca", field: "x_studio_marca" }
  ];
  const clientTokens = tokenizeForMatch(clientName);

  for (const criterion of criteria) {
    const token = clientTokens[0] || clientName;
    const saleOrders = await odoo.executeKw(
      uid, "sale.order", "search_read",
      [[
        ["state", "=", "sale"],
        ["invoice_status", "!=", "invoiced"],
        [criterion.field, "ilike", token]
      ]],
      {
        fields: ["id", "name", "partner_id", "x_studio_marca"],
        limit: 30
      }
    );
    const scored = saleOrders
      .map((so) => ({
        so,
        score: scoreByWords(clientTokens, [
          so.partner_id?.[1],
          so.x_studio_marca
        ])
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      console.log("[delivery] OV encontrada por criterio:", criterion.key, scored[0].so.name);
      return scored[0].so.name;
    }
  }

  if (sku) {
    const saleLines = await odoo.executeKw(
      uid, "sale.order.line", "search_read",
      [[
        ["product_id.default_code", "=", sku],
        ["order_id.state", "=", "sale"],
        ["qty_delivered", "<", "product_uom_qty"]
      ]],
      { fields: ["id", "order_id"], limit: 20 }
    );
    for (const line of saleLines) {
      const orderTuple = Array.isArray(line.order_id) ? line.order_id : [];
      const orderId = orderTuple[0];
      if (!orderId) continue;
      const saleOrders = await odoo.executeKw(
        uid, "sale.order", "search_read",
        [[["id", "=", orderId], ["state", "=", "sale"], ["invoice_status", "!=", "invoiced"]]],
        { fields: ["id", "name"], limit: 1 }
      );
      if (saleOrders.length) {
        console.log("[delivery] OV encontrada por criterio:", "d_sale_order_line_sku", saleOrders[0].name);
        return saleOrders[0].name;
      }
    }
  }

  return "";
}

function matchSkuInPurchaseLine(line, sku) {
  if (!sku) return true;
  const normalizedSku = normalizeStr(sku);
  const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
  const productName = String(productTuple[1] || "");
  const lineName = String(line.name || "");
  return includesNormalized(productName, normalizedSku) || includesNormalized(lineName, normalizedSku);
}

function filterSaleLinesForSkuOrName(lines, sku, productNameHint) {
  const normalizedSku = normalizeStr(sku);
  const normalizedNameHint = normalizeStr(productNameHint);
  return (lines || []).filter((line) => {
    const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
    const productName = String(productTuple[1] || "");
    const lineName = String(line.name || "");
    const skuMatch = normalizedSku
      ? includesNormalized(productName, normalizedSku) || includesNormalized(lineName, normalizedSku)
      : true;
    const nameMatch = normalizedNameHint
      ? includesNormalized(productName, normalizedNameHint) || includesNormalized(lineName, normalizedNameHint)
      : true;
    return skuMatch || nameMatch;
  });
}

async function loadPendingPurchaseOrders() {
  try {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const purchaseOrders = await odoo.executeKw(
      uid,
      "purchase.order",
      "search_read",
      [[["state", "=", "purchase"]]],
      {
        fields: [
          "id",
          "name",
          "partner_id",
          "x_studio_marca",
          "x_studio_documento_relacionado",
          "order_line"
        ],
        limit: 200
      }
    );

    const pendingRows = [];
    for (const po of purchaseOrders) {
      const lines = await odoo.executeKw(
        uid,
        "purchase.order.line",
        "search_read",
        [[["id", "in", po.order_line || []]]],
        {
          fields: ["id", "product_id", "product_qty", "qty_received", "price_unit", "name", "date_planned"],
          limit: 100
        }
      );
      const pendingLines = lines.filter(
        (line) => Number(line.qty_received || 0) < Number(line.product_qty || 0)
      );
      if (!pendingLines.length) continue;
      for (const line of pendingLines) {
        const productTuple = Array.isArray(line.product_id) ? line.product_id : [];
        const productId = productTuple[0];
        if (productId) {
          line.default_code = await findProductDefaultCodeById(odoo, uid, productId);
        } else {
          line.default_code = "";
        }
      }

      const partnerTuple = Array.isArray(po.partner_id) ? po.partner_id : [];
      pendingRows.push({
        id: po.id,
        name: po.name,
        partnerId: partnerTuple[0] || null,
        partnerName: partnerTuple[1] || "",
        x_studio_marca: String(po.x_studio_marca || ""),
        x_studio_documento_relacionado: String(po.x_studio_documento_relacionado || ""),
        order_line: po.order_line || [],
        lines: pendingLines
      });
    }

    pendingPurchaseOrders = pendingRows;
    console.log("OCs pendientes cargadas:", pendingPurchaseOrders.length);
  } catch (error) {
    console.error("Error cargando OCs pendientes:", error.message);
  }
}

async function loadAllSuppliers() {
  try {
    validateEnv();
    const odoo = createOdooClient();
    const uid = await odoo.authenticate();
    const partners = await odoo.executeKw(
      uid,
      "res.partner",
      "search_read",
      [[["supplier_rank", ">", 0]]],
      { fields: ["id", "name"], limit: 200 }
    );
    allSuppliers = partners
      .map((partner) => String(partner.name || "").trim())
      .filter(Boolean);
    console.log("Proveedores cargados:", allSuppliers.length);
  } catch (error) {
    console.error("Error cargando proveedores:", error.message);
  }
}

async function resolveSaleOrderByName(
  odoo,
  uid,
  { saleOrderName, sku, productNameHint, clientName, message, variant, quantity }
) {
  const saleOrders = await odoo.executeKw(
    uid, "sale.order", "search_read",
    [[["name", "=", saleOrderName]]],
    { fields: ["id", "name", "partner_id", "order_line"], limit: 1 }
  );
  const saleOrder = saleOrders[0];
  if (!saleOrder) {
    throw new Error(`No se encontro la OV ${saleOrderName}.`);
  }

  const saleLines = await odoo.executeKw(
    uid, "sale.order.line", "search_read",
    [[["id", "in", saleOrder.order_line || []]]],
    { fields: ["id", "name", "product_id", "price_unit", "product_uom_qty"], limit: 200 }
  );
  const filtered = filterSaleLinesForSkuOrName(saleLines, sku, productNameHint);
  const saleLine = selectBestLineByVariant(
    filtered.length ? filtered : saleLines,
    { message, variant, quantity }
  );
  if (!saleLine) {
    throw new Error(`La OV ${saleOrderName} no tiene una linea para SKU ${sku}.`);
  }

  const customerTuple = Array.isArray(saleOrder.partner_id) ? saleOrder.partner_id : [];
  const productTuple = Array.isArray(saleLine.product_id) ? saleLine.product_id : [];
  const customerId = customerTuple[0];
  const customerName = customerTuple[1] || "Cliente sin nombre";
  const productId = productTuple[0];
  if (!customerId || !productId) {
    throw new Error(`La OV ${saleOrderName} no tiene cliente o producto valido para el SKU ${sku}.`);
  }
  console.log("[match] cliente encontrado:", {
    ov: saleOrderName,
    customerName,
    score: scoreByWords(tokenizeForMatch(clientName), [customerName])
  });

  return {
    id: saleOrder.id,
    name: saleOrder.name,
    customerId,
    customerName,
    productId,
    customerUnitPrice: Number(saleLine.price_unit || 0),
    orderedQty: Number(saleLine.product_uom_qty || 0)
  };
}

function resolveSupplierUnitPriceWithoutOc(parsed, purchaseContext) {
  if (Number.isFinite(parsed.supplierUnitPrice) && parsed.supplierUnitPrice > 0) {
    return parsed.supplierUnitPrice;
  }
  if (
    Number.isFinite(purchaseContext?.purchaseLineUnitPrice) &&
    purchaseContext.purchaseLineUnitPrice > 0
  ) {
    return purchaseContext.purchaseLineUnitPrice;
  }
  if (Number.isFinite(parsed.totalAmount) && parsed.totalAmount > 0 && parsed.quantity > 0) {
    return parsed.totalAmount / parsed.quantity;
  }
  throw new Error(
    "No pude resolver el precio unitario de proveedor (ni por OC ni por total/cantidad)."
  );
}

async function findProductDefaultCodeById(odoo, uid, productId) {
  const products = await odoo.executeKw(
    uid, "product.product", "search_read",
    [[["id", "=", productId]]],
    { fields: ["default_code"], limit: 1 }
  );
  return String(products?.[0]?.default_code || "").trim().toUpperCase();
}

function extractSaleOrderNames(origin) {
  const matches = String(origin || "").match(/S0\d+/g) || [];
  return Array.from(new Set(matches));
}

async function resolveSaleOrderFromOrigin(
  odoo,
  uid,
  origin,
  sku,
  productNameHint,
  clientName,
  message,
  variant,
  quantity
) {
  const saleOrderNames = extractSaleOrderNames(origin);
  if (!saleOrderNames.length) {
    throw new Error("La OC no tiene OVs validas en origin (formato S0XXXX).");
  }

  for (const saleName of saleOrderNames) {
    let saleOrders = [];
    try {
      saleOrders = await odoo.executeKw(
        uid, "sale.order", "search_read",
        [[["name", "=", saleName]]],
        { fields: ["id", "name", "partner_id", "order_line"], limit: 1 }
      );
    } catch (error) {
      throw new Error(`Error al buscar la OV ${saleName}: ${error.message}`);
    }

    const saleOrder = saleOrders[0];
    if (!saleOrder) {
      continue;
    }

    let saleLines = [];
    try {
      saleLines = await odoo.executeKw(
        uid, "sale.order.line", "search_read",
        [[["id", "in", saleOrder.order_line || []]]],
        { fields: ["id", "name", "product_id", "price_unit", "product_uom_qty"], limit: 200 }
      );
    } catch (error) {
      throw new Error(`Error al buscar linea SKU ${sku} en OV ${saleName}: ${error.message}`);
    }

    const filtered = filterSaleLinesForSkuOrName(saleLines, sku, productNameHint);
    const saleLine = selectBestLineByVariant(
      filtered.length ? filtered : saleLines,
      { message, variant, quantity }
    );
    if (!saleLine) {
      continue;
    }

    const customerTuple = Array.isArray(saleOrder.partner_id) ? saleOrder.partner_id : [];
    const productTuple = Array.isArray(saleLine.product_id) ? saleLine.product_id : [];
    const customerId = customerTuple[0];
    const customerName = customerTuple[1] || "Cliente sin nombre";
    const productId = productTuple[0];
    if (!customerId || !productId) {
      throw new Error(`La OV ${saleName} no tiene cliente o producto valido para el SKU ${sku}.`);
    }
    const clientScore = scoreByWords(tokenizeForMatch(clientName), [customerName]);
    if (tokenizeForMatch(clientName).length && clientScore <= 0) {
      continue;
    }

    return {
      id: saleOrder.id,
      name: saleOrder.name,
      customerId,
      customerName,
      productId,
      customerUnitPrice: Number(saleLine.price_unit || 0),
      orderedQty: Number(saleLine.product_uom_qty || 0)
    };
  }

  throw new Error(`No se encontro una OV en origin con SKU ${sku}.`);
}

async function createSupplierInvoiceForDelivery(
  odoo,
  uid,
  { supplierId, productId, quantity, supplierUnitPrice, clientName }
) {
  try {
    return await odoo.executeKw(uid, "account.move", "create", [{
      move_type: "in_invoice",
      partner_id: supplierId,
      ref: clientName,
      invoice_date: new Date().toISOString().slice(0, 10),
      x_studio_tipo_de_gasto: "Mercaderia",
      x_studio_lista_de_gastos: "Mercaderia",
      invoice_line_ids: [[0, 0, {
        product_id: productId,
        quantity,
        price_unit: supplierUnitPrice
      }]]
    }]);
  } catch (error) {
    throw new Error(`Error al crear factura de proveedor: ${error.message}`);
  }
}

async function createCustomerInvoiceForDelivery(
  odoo,
  uid,
  { customerId, productId, quantity, customerUnitPrice, saleOrderName }
) {
  try {
    return await odoo.executeKw(uid, "account.move", "create", [{
      move_type: "out_invoice",
      partner_id: customerId,
      invoice_origin: String(saleOrderName || "").trim(),
      invoice_date: new Date().toISOString().slice(0, 10),
      invoice_line_ids: [[0, 0, {
        product_id: productId,
        quantity,
        price_unit: customerUnitPrice
      }]]
    }]);
  } catch (error) {
    throw new Error(`Error al crear factura de cliente: ${error.message}`);
  }
}

async function validateIncomingPickingForPurchaseOrder(
  odoo,
  uid,
  { purchaseOrderName, sku, productId, quantity }
) {
  let pickings = [];
  try {
    pickings = await odoo.executeKw(
      uid, "stock.picking", "search_read",
      [[
        ["origin", "ilike", purchaseOrderName],
        ["picking_type_code", "=", "incoming"],
        ["state", "!=", "done"]
      ]],
      { fields: ["id", "name", "state", "origin"], limit: 1 }
    );
  } catch (error) {
    throw new Error(`Error al buscar picking de recepcion para ${purchaseOrderName}: ${error.message}`);
  }

  const picking = pickings[0];
  if (!picking) {
    throw new Error(`No se encontro un picking incoming pendiente para la OC ${purchaseOrderName}.`);
  }

  let allMoveLines = [];
  try {
    allMoveLines = await odoo.executeKw(
      uid, "stock.move.line", "search_read",
      [[["picking_id", "=", picking.id]]],
      { fields: ["id", "qty_done", "quantity", "product_id", "picking_id"], limit: 200 }
    );
  } catch (error) {
    throw new Error(`Error al leer movimientos del picking ${picking.name}: ${error.message}`);
  }

  if (!allMoveLines.length) {
    throw new Error(`No se encontraron lineas de movimiento en el picking ${picking.name}.`);
  }

  const productIds = Array.from(
    new Set(
      allMoveLines
        .map((line) => (Array.isArray(line.product_id) ? line.product_id[0] : null))
        .filter(Boolean)
    )
  );
  let productsById = new Map();
  if (productIds.length) {
    const products = await odoo.executeKw(
      uid,
      "product.product",
      "search_read",
      [[["id", "in", productIds]]],
      { fields: ["id", "default_code"], limit: 500 }
    );
    productsById = new Map(products.map((p) => [p.id, p]));
  }

  const normalizedSku = normalizeStr(sku);
  let moveLines = allMoveLines.filter((line) => {
    const pid = Array.isArray(line.product_id) ? line.product_id[0] : null;
    const code = pid ? productsById.get(pid)?.default_code : "";
    return normalizedSku && normalizeStr(code) === normalizedSku;
  });

  if (!moveLines.length && productId) {
    moveLines = allMoveLines.filter((line) => {
      const pid = Array.isArray(line.product_id) ? line.product_id[0] : null;
      return Number(pid || 0) === Number(productId || 0);
    });
  }

  if (!moveLines.length) {
    if (allMoveLines.length === 1) {
      moveLines = [allMoveLines[0]];
      console.warn(
        `[delivery] Advertencia: sin match por SKU ${sku} en picking ${picking.name}. Se usa unica linea disponible.`
      );
    } else {
      const sorted = [...allMoveLines].sort(
        (a, b) => Number(b.quantity || 0) - Number(a.quantity || 0)
      );
      if (sorted.length) {
        moveLines = [sorted[0]];
        console.warn(
          `[delivery] Advertencia: sin match por SKU ${sku} en picking ${picking.name}. Se usa linea con mayor cantidad pendiente.`
        );
      }
    }
  }
  if (!moveLines.length) {
    throw new Error(`No se pudieron resolver lineas de movimiento para el picking ${picking.name}.`);
  }

  try {
    for (const line of moveLines) {
      await odoo.executeKw(uid, "stock.move.line", "write", [[line.id], { qty_done: quantity }]);
    }
  } catch (error) {
    throw new Error(`Error al actualizar qty_done en picking ${picking.name}: ${error.message}`);
  }

  try {
    await odoo.executeKw(uid, "stock.picking", "button_validate", [[picking.id]]);
  } catch (error) {
    throw new Error(`Error al validar recepcion en picking ${picking.name}: ${error.message}`);
  }

  return { pickingId: picking.id, pickingName: picking.name };
}

async function findPartnerByName(odoo, uid, clientName) {
  const partners = await odoo.executeKw(
    uid, "res.partner", "search_read",
    [[["name", "ilike", clientName]]],
    { fields: ["id", "name"], limit: 1 }
  );
  return partners[0] || null;
}

async function findJournalByName(odoo, uid, journalName) {
  const journals = await odoo.executeKw(
    uid,
    "account.journal",
    "search_read",
    [[["name", "ilike", journalName]]],
    { fields: ["id", "name"], limit: 10 }
  );
  const needle = (journalName || "").toLowerCase().trim();
  const list = journals || [];
  return (
    list.find((j) => (j.name || "").toLowerCase() === needle) ||
    list.find((j) => (j.name || "").toLowerCase().includes(needle)) ||
    null
  );
}

async function findPaymentMethodLine(odoo, uid, journalId, flow) {
  const lines = await odoo.executeKw(
    uid, "account.payment.method.line", "search_read",
    [[["journal_id", "=", journalId], ["payment_type", "=", flow]]],
    { fields: ["id", "name"], limit: 1 }
  );
  return lines[0] || null;
}

async function createDraftPayment(
  odoo,
  uid,
  { partnerId, amount, journalId, paymentMethodLineId, paymentFlow, partnerType, ref, memo, listaGastos }
) {
  const vals = {
    payment_type: paymentFlow,
    partner_type: partnerType,
    partner_id: partnerId,
    amount,
    journal_id: journalId,
    payment_method_line_id: paymentMethodLineId,
    date: new Date().toISOString().slice(0, 10),
    memo: ref || memo || ""
  };
  if (listaGastos) {
    vals.x_studio_lista_de_gastos = listaGastos;
  }
  return odoo.executeKw(uid, "account.payment", "create", [vals]);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSkuCandidateFromLine(line) {
  const name = String(line.name || "");
  const br = name.match(/\[([^\]]+)\]/);
  if (br && br[1]) return br[1].trim();
  const pid = line.product_id;
  if (Array.isArray(pid) && pid[1]) return String(pid[1]).trim();
  const m = name.match(/\b(BoPo[A-Za-z0-9]+|EB[A-Z]{2,4}\d+[A-Z0-9]*|EESN\d+|EEAL\d+|BaPUFr|EP\d+x\d+|HTZ|CART|Cart[A-Za-z0-9]*)\b/i);
  return m ? m[1] : name.split(/\s+/)[0] || "";
}

function parseBadanaSkuResult(skuRaw, sku) {
  const med = sku.match(/(\d+[.,]?\d*)\s*[xX]\s*(\d+[.,]?\d*)/);
  const an = med ? parseFloat(String(med[1]).replace(",", ".")) : null;
  const al = med ? parseFloat(String(med[2]).replace(",", ".")) : null;
  return {
    raw: sku,
    familia: "Badana",
    subtipo: sku.includes("PU") ? "PU cuerito" : "Badana",
    ancho: Number.isFinite(an) && an > 0 ? an : null,
    alto: Number.isFinite(al) && al > 0 ? al : null,
    terminacion: "",
    colores: "1",
    layoutFamily: "badana",
    bolsaTipo: "",
    bolsaAncho: null,
    bolsaAlto: null,
    materialChecks: { pp: false, oxi: false, bio: false, friselina: false }
  };
}

function parseSKU(skuRaw) {
  const sku = String(skuRaw || "").trim().toUpperCase();
  const skTrim = String(skuRaw || "").trim();
  const out = {
    raw: sku,
    familia: "Desconocido",
    subtipo: "",
    ancho: null,
    alto: null,
    terminacion: "",
    colores: null,
    layoutFamily: "generico",
    bolsaTipo: "",
    bolsaAncho: null,
    bolsaAlto: null,
    materialChecks: { pp: false, oxi: false, bio: false, friselina: false }
  };
  if (!sku) return out;

  if (
    !/^BOPO/i.test(sku) &&
    (/^BaPU/i.test(sku) ||
      /^BADANA/i.test(sku) ||
      /^\[B\]/i.test(skTrim) ||
      /^B(?!OPO)/i.test(sku))
  ) {
    return parseBadanaSkuResult(skTrim, sku);
  }

  if (/^(EBAD|EBAT|EESN|EEAL)/i.test(sku)) {
    out.layoutFamily = "bordada";
    let m = sku.match(/^(EBAD)(\d+)/i);
    if (m) {
      out.familia = "Bordada Alta Definición";
      out.subtipo = "Alta Definición";
      out.ancho = parseInt(m[2], 10) || null;
    } else if ((m = sku.match(/^(EBAT)(\d+)/i))) {
      out.familia = "Bordada mitad Alta Def / Tafeta";
      out.subtipo = "Mitad & AD / Tafeta";
      out.ancho = parseInt(m[2], 10) || null;
    } else if ((m = sku.match(/^(EESN)(\d+)/i))) {
      out.familia = "Estampada Satén Negro";
      out.subtipo = "Satén Negro";
      out.ancho = parseInt(m[2], 10) || null;
    } else if ((m = sku.match(/^(EEAL)(\d+)/i))) {
      out.familia = "Estampada Algodón";
      out.subtipo = "Algodón";
      out.ancho = parseInt(m[2], 10) || null;
    }
    if (/R[12]\b/i.test(sku)) {
      out.terminacion = /R1\b/i.test(sku) ? "Rollo, 1 color" : "Rollo, 2 colores";
      out.colores = /R1\b/i.test(sku) ? 1 : 2;
    } else if (/CDE[12]/i.test(sku)) {
      out.terminacion = /CDE1/i.test(sku) ? "Cortada y Doblada Extremos, 1 color" : "Cortada y Doblada Extremos, 2 colores";
      out.colores = /CDE1/i.test(sku) ? 1 : 2;
    } else if (/CDM[12]/i.test(sku)) {
      out.terminacion = /CDM1/i.test(sku) ? "Cortada y Doblada Medio, 1 color" : "Cortada y Doblada Medio, 2 colores";
      out.colores = /CDM1/i.test(sku) ? 1 : 2;
    } else if (/CS\b/i.test(sku)) {
      out.terminacion = "Cortada y Soldada";
    } else if (/(^|[^A-Z0-9])C$/i.test(sku)) {
      out.terminacion = "Cortada simple";
    }
    return out;
  }

  if (/^BOPO/i.test(sku)) {
    out.layoutFamily = "bolsa";
    if (/BOPOCA/i.test(sku)) {
      out.familia = "Bolsa Camiseta";
      out.bolsaTipo = "camiseta";
    } else if (/BOPOFO/i.test(sku)) {
      out.familia = "Bolsa Fondo";
      out.bolsaTipo = "fondo";
    } else if (/BOPORI/i.test(sku)) {
      out.familia = "Bolsa Riñón";
      out.bolsaTipo = "rinon";
    } else if (/BOPOLS/i.test(sku)) {
      out.familia = "Bolsa La Salada";
      out.bolsaTipo = "salada";
    } else {
      out.familia = "Bolsa";
      out.bolsaTipo = "simple";
    }
    const dim = sku.match(/(\d+)\s*[xX]\s*(\d+)/);
    if (dim) {
      out.bolsaAncho = parseInt(dim[1], 10);
      out.bolsaAlto = parseInt(dim[2], 10);
    }
    if (/PP/i.test(sku)) out.materialChecks.pp = true;
    if (/OXI/i.test(sku)) out.materialChecks.oxi = true;
    if (/BIO/i.test(sku)) out.materialChecks.bio = true;
    if (/FRIS/i.test(sku)) out.materialChecks.friselina = true;
    return out;
  }

  // Plastisol — múltiples prefijos posibles (EP legacy, PI / Pl en Odoo)
  if (/^EP/i.test(sku) || /^PI/i.test(sku) || /^PL/i.test(sku)) {
    const medidas = sku.match(/(\d+[.,]?\d*)\s*[xX]\s*(\d+[.,]?\d*)/);
    out.familia = "Plastisol";
    out.subtipo = "Troquelado";
    out.ancho = medidas ? String(medidas[1]).replace(",", ".") : "";
    out.alto = medidas ? String(medidas[2]).replace(",", ".") : "";
    out.terminacion = "";
    const colorM = sku.match(/(\d+)\s*COLOR/i);
    out.colores = colorM ? colorM[1] : "1";
    out.layoutFamily = "plastisol";
    return out;
  }
  if (/^HTZ/i.test(sku)) {
    out.familia = "Hangtag/Troquelado";
    out.layoutFamily = "generico";
    return out;
  }
  if (/CART/i.test(sku)) {
    out.familia = "Cartón/Caja";
    out.layoutFamily = "generico";
    return out;
  }
  return out;
}

function isProposalChatterColorWord(w) {
  const n = normalizeStr(w);
  if (n.length < 3) return false;
  const known = [
    "amarillo",
    "naranja",
    "plateado",
    "fucsia",
    "violeta",
    "verde",
    "negro",
    "blanco",
    "rojo",
    "azul",
    "gris",
    "beige",
    "arena",
    "dorado",
    "rosa",
    "bordo",
    "marron",
    "cafe",
    "pantone"
  ];
  return known.some((k) => n === k || n.includes(k));
}

function extractProposalChatterColors(full) {
  const colores = [];
  const seen = new Set();
  const add = (s) => {
    const t = String(s || "")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length < 2) return;
    const key = normalizeStr(t);
    if (seen.has(key)) return;
    seen.add(key);
    colores.push(t);
  };

  if (/\bdos\s+marrones\b/i.test(full) || /\bmarrones\s+distintos\b/i.test(full)) {
    add("marrón 1");
    add("marrón 2");
  }

  const patterns = [
    /fondo\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)/gi,
    /relieve\s+([a-záéíóúñ0-9]+(?:\s+[a-záéíóúñ0-9]+)*)/gi,
    /colores?\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)*)/gi,
    /en\s+colores?\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)*)/gi,
    /([a-záéíóúñ]+)\s+y\s+([a-záéíóúñ]+)/gi,
    /([a-záéíóúñ]+)\s*\d{3,4}\b/gi,
    /pantone\s+(\d{3,4})/gi,
    /([a-záéíóúñ]+)\s+distintos/gi
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(full)) !== null) {
      for (let i = 1; i < m.length; i++) {
        const raw = m[i];
        if (!raw) continue;
        const parts = raw.split(/\s*,\s*|\s+y\s+/i);
        for (const p of parts) {
          const w = p.trim();
          if (!w || w.length < 3) continue;
          if (normalizeStr(w) === "dos") continue;
          if (isProposalChatterColorWord(w)) {
            add(w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
          }
        }
      }
    }
  }

  const pantRe = /pantone\s+(\d{3,4})\b/gi;
  let pm;
  while ((pm = pantRe.exec(full)) !== null) {
    add(`Pantone ${pm[1]}`);
  }

  const capRe = /\b(Negro|Blanco|Rojo|Azul|Verde|Amarillo|Gris|Beige|Arena|Marron|Marrón|Café|Cafe|Dorado|Plateado|Rosa|Fucsia|Naranja|Violeta|Bordo)\b/gi;
  let cm;
  while ((cm = capRe.exec(full)) !== null) add(cm[1]);

  return colores;
}

function parseChatterNotes(messages) {
  const bodies = (messages || [])
    .map((m) => {
      const texto = String(m.body || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      return texto;
    })
    .filter(Boolean);
  const full = bodies.join("\n");
  const colores = extractProposalChatterColors(full);
  const talles = [];
  const metrosPorTalle = {};
  let instruccionesParts = [];

  let fondoColor = null;
  const fondoMatch = full.match(
    /fondo\s+(negro|blanco|beige|arena|rojo|azul|gris|marr[oó]n|transparente)/i
  );
  if (fondoMatch) fondoColor = fondoMatch[1].toLowerCase();

  let relieveColor = null;
  const relieveMatch = full.match(
    /(?:relieve|letras?|texto)\s+(negro|blanco|amarillo|rojo|azul|dorado|plateado|[\w\u00C0-\u024F]+\s*\d{3,4})/i
  );
  if (relieveMatch) relieveColor = relieveMatch[1].toLowerCase();
  if (!relieveColor && /letras?\s+blancas?/i.test(full)) relieveColor = "blanco";
  if (!relieveColor && /letras?\s+negras?/i.test(full)) relieveColor = "negro";

  const pantoneMatch = full.match(/(?:pantone\s+)?([a-záéíóúñ]+)\s+(\d{3,4})/i);
  if (pantoneMatch && !relieveColor) {
    relieveColor = `${pantoneMatch[1].toLowerCase()} ${pantoneMatch[2]}`;
  }

  const fondoCaps = full.match(/FONDO\s+([A-ZÁÉÍÓÚÑ]+)/i);
  if (fondoCaps) fondoColor = fondoCaps[1].toLowerCase();

  const nroRel = full.match(/Nro\.?\s+([A-ZÁÉÍÓÚÑ]+)/i);
  if (nroRel) relieveColor = nroRel[1].toLowerCase();

  for (const cm of full.matchAll(/\b(relieve|fondo|letras?|número|numero)\s*:\s*([a-záéíóúñ]+)/gi)) {
    const kw = cm[1].toLowerCase();
    const col = cm[2].toLowerCase();
    if (kw === "fondo") fondoColor = col;
    else relieveColor = col;
  }

  const sobreMatch = full.match(/([a-záéíóúñ]+)\s+sobre\s+([a-záéíóúñ]+)/i);
  if (sobreMatch) {
    relieveColor = sobreMatch[1].toLowerCase();
    fondoColor = sobreMatch[2].toLowerCase();
  }

  const fondoRe = /fondo\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)/gi;
  const relieveRe = /relieve\s+([a-záéíóúñ0-9\s]+?)(?=\.|,|;|$|\n)/gi;

  const extractChatterAltoMm = (str) => {
    const s = String(str || "").replace(/\s+/g, " ");
    if (!s.trim()) return null;
    const parsePairAlto = (aStr, bStr, unit) => {
      const a = parseFloat(String(aStr).replace(",", "."));
      let al = parseFloat(String(bStr).replace(",", "."));
      if (!Number.isFinite(a) || !Number.isFinite(al) || a <= 0 || al <= 0) return null;
      const u = unit ? String(unit).toLowerCase() : "";
      if (u === "cm") al *= 10;
      else if (u === "mm") {
        /* mm: sin conversión */
      } else {
        const maxD = Math.max(a, al);
        if (maxD < 20) al *= 10;
      }
      return Math.round(al * 100) / 100;
    };

    const ru = s.match(/(\d+[.,]?\d*)\s*[xX]\s*(\d+[.,]?\d*)\s*(mm|cm)\b/i);
    if (ru) {
      const al = parsePairAlto(ru[1], ru[2], ru[3]);
      if (al != null) return al;
    }

    const reEt = s.match(
      /etiqueta\s+de\s+(\d+[.,]?\d*)\s*[xX]\s*(\d+[.,]?\d*)(?:\s*(mm|cm))?\b/i
    );
    if (reEt) {
      const u = reEt[3];
      const a = parseFloat(reEt[1].replace(",", "."));
      let al = parseFloat(reEt[2].replace(",", "."));
      if (!Number.isFinite(a) || !Number.isFinite(al) || a <= 0 || al <= 0) return null;
      if (u && String(u).toLowerCase() === "cm") al *= 10;
      else if (!u) {
        const maxD = Math.max(a, al);
        if (maxD < 20) al *= 10;
      }
      return Math.round(al * 100) / 100;
    }

    const runu = s.match(/(\d+[.,]?\d*)\s*[xX]\s*(\d+[.,]?\d*)(?!\s*(?:mm|cm)\b)/i);
    if (runu) {
      const al = parsePairAlto(runu[1], runu[2], null);
      if (al != null) return al;
    }
    return null;
  };

  let medidas = null;
  let altoMm = extractChatterAltoMm(full);
  if (altoMm == null) {
    for (const b of bodies) {
      altoMm = extractChatterAltoMm(b);
      if (altoMm != null) break;
    }
  }
  if (altoMm != null) medidas = { alto: altoMm };

  const tallesLetraRaw = full.match(/\b(XS|S|M|L|XL|XXL|XXXL)\b/gi) || [];
  const tallesLetra = tallesLetraRaw.map((t) => t.toUpperCase());

  const tallesNum = [];
  const numRegex = /\b(\d{1,2})\b(?!\s*(?:mts|metros|cm|mm|%|\$))/gi;
  let nm;
  while ((nm = numRegex.exec(full)) !== null) {
    const n = parseInt(nm[1], 10);
    if ((n >= 1 && n <= 6) || (n >= 36 && n <= 50)) tallesNum.push(String(n));
  }

  talles.push(...tallesLetra, ...tallesNum);

  let rm;
  const pMetro1 = /(\d+)\s*mts?\s*[:–-]?\s*talle\s+(\d+)/gi;
  while ((rm = pMetro1.exec(full)) !== null) {
    metrosPorTalle[String(rm[2]).trim().toUpperCase()] = rm[1];
  }
  const pMetro2 = /(\d+)\s*mts?\s*[:–-]\s*([A-Za-z0-9]{1,6})\b/gi;
  while ((rm = pMetro2.exec(full)) !== null) {
    const tal = String(rm[2]).trim();
    if (/^talle$/i.test(tal)) continue;
    if (/^\d+$/.test(tal) && parseInt(tal, 10) > 100) continue;
    metrosPorTalle[tal.toUpperCase()] = rm[1];
  }
  const pMetro3 = /\b([A-Za-z0-9]{1,6})\s*[:–]\s*(\d+)\s*mts?\b/gi;
  while ((rm = pMetro3.exec(full)) !== null) {
    metrosPorTalle[rm[1].toUpperCase()] = rm[2];
  }
  const pMetro4 = /(\d+)\s+mts?\s+([A-Za-z0-9]{1,6})\b/gi;
  while ((rm = pMetro4.exec(full)) !== null) {
    metrosPorTalle[rm[2].toUpperCase()] = rm[1];
  }

  let variantes = [];
  const cwVar =
    "(negro|blanco|amarillo|rojo|azul|verde|gris|beige|arena|marr[oó]n|cafe|café|dorado|plateado|rosa|fucsia|naranja|violeta|bordo)";
  let vm = full.match(new RegExp(`una\\s+en\\s+${cwVar}\\s+y\\s+otra\\s+en\\s+${cwVar}`, "i"));
  if (vm) variantes = [vm[1].toLowerCase(), vm[2].toLowerCase()];
  if (!variantes.length) {
    vm = full.match(new RegExp(`en\\s+${cwVar}\\s+y\\s+en\\s+${cwVar}`, "i"));
    if (vm) variantes = [vm[1].toLowerCase(), vm[2].toLowerCase()];
  }
  if (!variantes.length) {
    vm = full.match(new RegExp(`\\b${cwVar}\\s+y\\s+${cwVar}\\b`, "i"));
    if (vm) variantes = [vm[1].toLowerCase(), vm[2].toLowerCase()];
  }

  let cantidad_variante_txt = null;
  const ucv = full.match(/(\d[\d.,]*)\s*(?:mil)?\s*unidades?\s+x\s+color/i);
  if (ucv) cantidad_variante_txt = `${String(ucv[1]).trim()} unidades x color`;

  const used = new Set();
  instruccionesParts = bodies.filter((b) => {
    const stripped = b.replace(fondoRe, "").replace(relieveRe, "");
    return stripped.length > 3;
  });
  void used;

  const hasSpecific =
    colores.length > 0 || talles.length > 0 || Object.keys(metrosPorTalle).length > 0;
  const instrucciones = hasSpecific
    ? instruccionesParts.join("\n\n").trim()
    : full;

  return {
    colores: Array.from(new Set(colores)),
    talles: Array.from(new Set(talles)),
    metros_por_talle: metrosPorTalle,
    medidas,
    fondoColor,
    relieveColor,
    variantes,
    cantidad_variante_txt,
    instrucciones
  };
}

async function enrichChatterNotesWithGroqIfNeeded(notas, rawText) {
  const hasRelevant =
    (notas.colores && notas.colores.length) ||
    (notas.talles && notas.talles.length) ||
    Object.keys(notas.metros_por_talle || {}).length;
  if (hasRelevant || !rawText || rawText.length < 8) return notas;
  const key = process.env.GROQ_API_KEY;
  if (!key) return notas;
  try {
    console.log("[propuesta] Groq: extrayendo notas del chatter…");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `Respondé SOLO JSON válido sin markdown, con esta forma exacta:
{"colores":[],"talles":[],"metros_por_talle":{},"instrucciones":""}
Extraé colores, talles y metros del siguiente texto. metros_por_talle: objeto con clave talle y valor string de metros.
Texto:\n${rawText.slice(0, 3500)}`
          }
        ]
      })
    });
    if (!res.ok) return notas;
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content?.trim();
    if (!txt) return notas;
    const j = JSON.parse(txt.replace(/```json|```/g, "").trim());
    if (j && typeof j === "object") {
      return {
        colores: Array.isArray(j.colores) ? j.colores : notas.colores,
        talles: Array.isArray(j.talles) ? j.talles : notas.talles,
        metros_por_talle:
          j.metros_por_talle && typeof j.metros_por_talle === "object"
            ? j.metros_por_talle
            : notas.metros_por_talle,
        medidas:
          notas.medidas && typeof notas.medidas === "object"
            ? notas.medidas
            : j.medidas && typeof j.medidas === "object"
              ? j.medidas
              : null,
        fondoColor: notas.fondoColor != null ? notas.fondoColor : null,
        relieveColor: notas.relieveColor != null ? notas.relieveColor : null,
        variantes: Array.isArray(notas.variantes) ? notas.variantes : [],
        cantidad_variante_txt: notas.cantidad_variante_txt || null,
        instrucciones: typeof j.instrucciones === "string" ? j.instrucciones : notas.instrucciones
      };
    }
  } catch (e) {
    console.error("[propuesta] Groq notas:", (e && e.message) || e);
  }
  return notas;
}

function isColorDarkProposal(r, g, b) {
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance < 128;
}

function visionChannelTo255(v) {
  if (v == null || Number.isNaN(Number(v))) return 0;
  const n = Number(v);
  if (n >= 0 && n <= 1) return Math.round(n * 255);
  return Math.min(255, Math.max(0, Math.round(n)));
}

function proposalBordadaFontPickFromVision(texts) {
  const tx = (texts || []).map((t) => String(t || "").trim()).filter(Boolean);
  let sample =
    tx.find((s, i) => i > 0 && s.length >= 4 && s.length < 200) ||
    tx.find((s) => s.length >= 4 && s.length < 200) ||
    "";
  if (!sample && tx.length) {
    const head = String(tx[0]).split(/\s+/).slice(0, 8).join(" ");
    sample = head.length >= 4 ? head : String(tx[0]).slice(0, 80);
  }
  const hasLower = /[a-záéíóú]/.test(sample);
  const hasUpper = /[A-ZÁÉÍÓÚ]/.test(sample);
  const looksAllCaps =
    sample.length >= 4 &&
    sample === sample.toUpperCase() &&
    hasUpper &&
    (!hasLower || sample.replace(/\s/g, "").length < 24);
  const pre =
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
  if (looksAllCaps) {
    return {
      family: "Oswald",
      linkHref: `${pre}<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap" rel="stylesheet">`
    };
  }
  if (/serif|clásica|clásico|elegante|boutique|paris|london/i.test(sample)) {
    return {
      family: "Playfair Display",
      linkHref: `${pre}<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">`
    };
  }
  if (hasLower && hasUpper && sample.length > 10 && /[a-z]{4,}/i.test(sample)) {
    return {
      family: "Raleway",
      linkHref: `${pre}<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;700&display=swap" rel="stylesheet">`
    };
  }
  return {
    family: "Montserrat",
    linkHref: `${pre}<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap" rel="stylesheet">`
  };
}

async function analyzeImageWithVision(imageBase64Raw, mimeType) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return { texts: [], colors: [] };

  let imageBase64 = String(imageBase64Raw || "").replace(/\s/g, "");
  if (imageBase64.includes("base64,")) {
    imageBase64 = imageBase64.split("base64,").pop() || "";
  }

  try {
    const response = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        requests: [
          {
            image: { content: imageBase64 },
            features: [
              { type: "TEXT_DETECTION", maxResults: 10 },
              { type: "IMAGE_PROPERTIES", maxResults: 5 },
              { type: "LOGO_DETECTION", maxResults: 3 }
            ]
          }
        ]
      }
    );

    const result = response.data.responses && response.data.responses[0];
    if (!result) return { texts: [], colors: [] };

    const texts = (result.textAnnotations || [])
      .map((t) => t.description)
      .filter(Boolean)
      .slice(0, 10);

    const colors = (result.imagePropertiesAnnotation?.dominantColors?.colors || [])
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 5)
      .map((c) => {
        const r = visionChannelTo255(c.color?.red);
        const g = visionChannelTo255(c.color?.green);
        const b = visionChannelTo255(c.color?.blue);
        const hex =
          "#" +
          [r, g, b]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("");
        return { r, g, b, score: c.score, hex };
      });

    console.log("[vision] textos detectados:", texts.slice(0, 3));
    console.log("[vision] colores dominantes:", colors.slice(0, 3).map((c) => c.hex));

    return { texts, colors };
  } catch (e) {
    console.error("[vision] error:", (e && e.message) || e);
    return { texts: [], colors: [] };
  }
}

function escapeHtmlProposal(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function proposalHeaderLeftHtml() {
  return `<div class="header-left" style="display:flex;align-items:center;gap:10px;">
<svg width="60" height="40" viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg">
  <rect width="60" height="40" fill="#000"/>
  <text x="4" y="16" font-family="Arial" font-weight="bold" font-size="14" fill="#8db43e">AV</text>
  <text x="4" y="32" font-family="Arial" font-weight="bold" font-size="14" fill="#8db43e">TX</text>
  <line x1="30" y1="4" x2="30" y2="36" stroke="#8db43e" stroke-width="1"/>
</svg>
<span style="font-size:18px;font-weight:bold;letter-spacing:2px;color:#fff;">AVÍOS TEXTILES</span>
</div>`;
}

function proposalColorCssFromLabel(label) {
  const n = normalizeStr(String(label || ""));
  if (n.includes("marron1") || n.includes("marrn1")) return { bg: "#5c3317", fg: "#ffffff" };
  if (n.includes("marron2") || n.includes("marrn2")) return { bg: "#8b5e3c", fg: "#ffffff" };
  if (n.includes("negro")) return { bg: "#000000", fg: "#ffffff" };
  if (n.includes("blanco")) return { bg: "#ffffff", fg: "#000000", border: "1px solid #bbb" };
  if (n.includes("rojo")) return { bg: "#cc0000", fg: "#ffffff" };
  if (n.includes("amarillo")) return { bg: "#f0c020", fg: "#000000" };
  if (n.includes("dorado")) return { bg: "#c8a400", fg: "#000000" };
  if (n.includes("azul")) return { bg: "#003399", fg: "#ffffff" };
  if (n.includes("verde")) return { bg: "#2d6a2d", fg: "#ffffff" };
  if (n.includes("gris")) return { bg: "#888888", fg: "#ffffff" };
  if (n.includes("beige") || n.includes("arena")) return { bg: "#c8b89a", fg: "#000000" };
  if (n.includes("marron") || n.includes("cafe")) return { bg: "#5c3317", fg: "#ffffff" };
  if (n.includes("rosa")) return { bg: "#e87da8", fg: "#000000" };
  if (n.includes("fucsia")) return { bg: "#cc007a", fg: "#ffffff" };
  if (n.includes("naranja")) return { bg: "#e87820", fg: "#ffffff" };
  if (n.includes("violeta")) return { bg: "#6600aa", fg: "#ffffff" };
  if (n.includes("bordo")) return { bg: "#6b0020", fg: "#ffffff" };
  if (n.includes("plateado")) return { bg: "#aaaaaa", fg: "#000000" };
  return { bg: "#dddddd", fg: "#000000" };
}

function chk(on) {
  return on ? "checked" : "";
}

function checkboxHtmlProposal(label, isChecked) {
  const cls = isChecked ? "checkbox checked" : "checkbox";
  const mark = isChecked ? "✓" : " ";
  return `<span class="${cls}">${mark}</span> ${escapeHtmlProposal(label)}`;
}

function proposalLogoReferenceBlockHtml(logoDataUri) {
  if (!logoDataUri || !String(logoDataUri).startsWith("data:")) return "";
  return `<div style="text-align:center;margin-bottom:8px;">
  <div style="font-size:9px;color:#666;margin-bottom:4px;">Referencia de logo (adjunto del chatter)</div>
  <img src="${logoDataUri}" style="max-height:80px;max-width:200px;object-fit:contain;border:1px solid #ddd;padding:4px;" alt="">
</div>`;
}

function logoInnerHtmlProposal(logoPath, logoDataUri) {
  if (logoDataUri && String(logoDataUri).startsWith("data:")) {
    return `<img src="${logoDataUri}" style="max-width:85%;max-height:85%;object-fit:contain" alt="">`;
  }
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      const b64 = fs.readFileSync(logoPath).toString("base64");
      return `<img src="data:image/png;base64,${b64}" style="max-width:80%;max-height:80%;object-fit:contain" alt="">`;
    } catch (_) {
      return "[LOGO PENDIENTE]";
    }
  }
  return "[LOGO PENDIENTE]";
}

function bordadaTejidoState(skuParsed) {
  const sub = String(skuParsed.subtipo || "");
  const subN = normalizeStr(sub);
  const rawU = String(skuParsed.raw || "").toUpperCase();
  let tafeta = false;
  let ad = false;
  let mitad = false;
  if (/EBAT/i.test(rawU) || (subN.includes("tafeta") && subN.includes("alta"))) {
    mitad = true;
  } else if (subN.includes("alta definicion") || /EBAD/i.test(rawU)) {
    ad = true;
  } else if (subN.includes("tafeta")) {
    tafeta = true;
  }
  return { tafeta, ad, mitad };
}

function bordadaTermState(skuParsed) {
  const rawU = String(skuParsed.raw || "").toUpperCase();
  const termU = String(skuParsed.terminacion || "").toUpperCase();
  const blob = `${rawU} ${termU}`;
  let rollo = false;
  let cs = false;
  let cde = false;
  let cdm = false;
  if (/\bR1\b|\bR2\b/.test(blob)) rollo = true;
  else if (/\bCS\b/.test(blob)) cs = true;
  else if (/CDE1|CDE2/i.test(blob)) cde = true;
  else if (/CDM1|CDM2/i.test(blob)) cdm = true;
  return { rollo, cs, cde, cdm };
}

function buildTallesHtmlProposal(notas) {
  const t = (notas && notas.talles) || [];
  const mpt = (notas && notas.metros_por_talle) || {};
  if (!t.length) return "";
  const dist = Object.keys(mpt).length
    ? ` — distribución: ${Object.entries(mpt)
        .map(([k, v]) => `${escapeHtmlProposal(k)}:${escapeHtmlProposal(String(v))}mts`)
        .join(" ")}`
    : "";
  return `<div style="margin-top:8px;font-size:10px;">Talles: ${escapeHtmlProposal(t.join(" / "))}${dist}</div>`;
}

function buildColoresCombinacionesHtmlProposal(notas, marcaRect) {
  const list = (notas && notas.colores) || [];
  const brandTxt = String(marcaRect || "").trim() || "MARCA";
  if (!list.length) {
    return `<div class="color-muestra"><div class="color-rect" style="background:#eeeeee;color:#333;border:1px solid #ccc;">${escapeHtmlProposal(brandTxt)}</div><div>Sin datos</div></div>`;
  }
  return list
    .map((c) => {
      const st = proposalColorCssFromLabel(c);
      const bd = st.border ? st.border : "1px solid #999";
      return `<div class="color-muestra">
    <div class="color-rect" style="background:${st.bg};color:${st.fg};border:${bd};">${escapeHtmlProposal(brandTxt)}</div>
    <div>${escapeHtmlProposal(c)}</div>
  </div>`;
    })
    .join("");
}

function mmToPxProposal(mm, fallback) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n * 3.5);
}

function getProposalBaseCss() {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #222; }
  .sheet { page-break-after: always; position: relative; padding-bottom: 48px; min-height: 260mm; }
  .sheet:last-of-type { page-break-after: auto; }
  .header {
    background: #000;
    color: #fff;
    padding: 12px 20px;
    display: grid;
    grid-template-columns: 1fr 2fr 1fr;
    align-items: center;
    gap: 12px;
  }
  .header-title { font-size: 13px; font-weight: bold; text-align: center; }
  .ov-title {
    padding: 10px 20px;
    font-size: 13px;
    font-weight: bold;
    border-bottom: 1px solid #ccc;
  }
  .ficha {
    padding: 12px 20px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 20px;
    border-bottom: 1px solid #ccc;
  }
  .ficha-row {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 10px;
    flex-wrap: wrap;
  }
  .ficha-label { font-weight: bold; min-width: 100px; }
  .checkbox {
    display: inline-block;
    width: 10px; height: 10px;
    border: 1px solid #333;
    margin-right: 3px;
    vertical-align: middle;
    text-align: center;
    line-height: 10px;
    font-size: 8px;
  }
  .checkbox.checked { background: #333; color: #fff; }
  .seccion-disenio {
    margin: 15px 20px;
    border: 1.5px solid #8db43e;
    border-radius: 8px;
    padding: 15px;
    min-height: 300px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .etiqueta-container { position: relative; margin: 20px auto; }
  .etiqueta-rect {
    border: 2px solid #000;
    background: #f5f5f5;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    color: #999;
  }
  .cota-horizontal {
    text-align: center;
    color: #8db43e;
    font-size: 10px;
    font-weight: bold;
    margin-top: 4px;
  }
  .cota-vertical-container {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cota-vertical {
    color: #8db43e;
    font-size: 10px;
    font-weight: bold;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
  }
  .linea-cota {
    border-left: 1.5px solid #8db43e;
    height: 100%;
  }
  .combinaciones { width: 100%; margin-top: 15px; }
  .combinaciones-titulo { font-size: 10px; font-weight: bold; margin-bottom: 6px; }
  .combinaciones-grid { display: flex; gap: 10px; flex-wrap: wrap; }
  .color-muestra { text-align: center; font-size: 9px; }
  .color-rect {
    width: 80px; height: 55px;
    border: 1px solid #999;
    margin-bottom: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: bold;
  }
  .instrucciones {
    width: 100%;
    margin-top: 10px;
    font-size: 9px;
    font-style: italic;
    color: #555;
    border-top: 1px solid #eee;
    padding-top: 6px;
  }
  .footer {
    background: #000;
    color: #fff;
    text-align: center;
    padding: 8px;
    font-size: 11px;
    letter-spacing: 3px;
    font-weight: bold;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
  }
  .bolsa-flex { display: flex; align-items: flex-start; gap: 16px; margin-top: 12px; }
  .dim-roja { color: #8db43e; font-size: 10px; font-weight: bold; }
  table.prop-gen { width: 100%; border-collapse: collapse; font-size: 10px; margin: 12px 20px; }
  table.prop-gen th, table.prop-gen td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
  table.prop-gen th { background: #eee; }
`;
}

function wrapProposalHtmlDocument(bodyInner, headExtra = "") {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
${headExtra}
<style>${getProposalBaseCss()}</style>
</head>
<body>
${bodyInner}
</body>
</html>`;
}

function buildOvTitleLineHtmlProposal(orden_id, marca) {
  const m = String(marca || "").trim();
  if (!m) return escapeHtmlProposal(orden_id);
  return `${escapeHtmlProposal(orden_id)} — ${escapeHtmlProposal(m)}`;
}

function buildBordadaSheetHtml(
  orden_id,
  marca,
  marcaRect,
  line,
  skuParsed,
  notas,
  logoPath,
  logoDataUri,
  visionData,
  proposalFontPick
) {
  visionData = visionData || { texts: [], colors: [] };
  const fontPick = proposalFontPick || proposalBordadaFontPickFromVision(visionData.texts || []);
  const fontFamilyCss = `'${String(fontPick.family || "Montserrat").replace(/'/g, "")}', sans-serif`;

  function colorNameToCss(nombre) {
    if (!nombre || typeof nombre !== "string") return "#dddddd";
    const map = {
      negro: "#000000",
      blanco: "#ffffff",
      beige: "#c8b89a",
      arena: "#c8b89a",
      rojo: "#cc0000",
      azul: "#003399",
      gris: "#888888",
      marron: "#5c3317",
      "marrón": "#5c3317",
      transparente: "transparent",
      amarillo: "#f0c020",
      dorado: "#c8a400",
      plateado: "#aaaaaa",
      fucsia: "#cc007a",
      rosa: "#e87da8"
    };
    const nombreBase = String(nombre)
      .replace(/\s*\d+/g, "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return map[nombreBase] || "#dddddd";
  }

  function contrasteTexto(bgCss) {
    const oscuros = ["#000000", "#003399", "#cc0000", "#5c3317", "#cc007a", "#6600aa", "#6b0020"];
    if (bgCss === "transparent") return "#000000";
    return oscuros.includes(bgCss) ? "#ffffff" : "#000000";
  }

  function truncInstruccionesProposal(text) {
    const s = String(text || "").trim();
    if (!s) return "";
    const lines = s.split(/\r?\n/);
    if (lines.length <= 3) return s;
    return lines.slice(0, 3).join("\n") + "...";
  }

  function relieveColorToCss(relieveRaw, bgCss) {
    if (!relieveRaw || !String(relieveRaw).trim()) return contrasteTexto(bgCss);
    const hex = colorNameToCss(relieveRaw);
    if (hex !== "#dddddd") return hex;
    return contrasteTexto(bgCss);
  }

  function contrasteHexFromBgHex(bgHex) {
    const m = String(bgHex || "").match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return "#000000";
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return isColorDarkProposal(r, g, b) ? "#ffffff" : "#000000";
  }

  const tej = bordadaTejidoState(skuParsed);
  const term = bordadaTermState(skuParsed);
  const med = (notas && notas.medidas) || {};
  const numMm = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const rawSku = String(line.sku || skuParsed.raw || "");
  const skuU = rawSku.toUpperCase();
  const ew = skuU.match(/^E[A-Z]+(\d+)/i);
  let anchoEtqMm = ew ? parseInt(ew[1], 10) : null;
  if (anchoEtqMm == null || !Number.isFinite(anchoEtqMm) || anchoEtqMm <= 0) {
    anchoEtqMm = numMm(skuParsed.ancho != null && skuParsed.ancho !== "" ? skuParsed.ancho : null);
  }

  let largoEtqMm = numMm(med.alto != null && med.alto !== "" ? med.alto : null);
  if (anchoEtqMm != null && largoEtqMm == null && anchoEtqMm > 0) {
    largoEtqMm = Math.round(anchoEtqMm * 3.5);
  }

  const orientHint = normalizeStr(String((notas && notas.instrucciones) || ""));
  const forceVertical =
    /\bvertical\b/.test(orientHint) ||
    /\bcuello\b/.test(orientHint) ||
    /\bmas\s+alta\s+que\s+ancha\b/.test(orientHint);
  const forceHorizontal = /\bhorizontal\b/.test(orientHint) || /\bapaisad/.test(orientHint);

  if (anchoEtqMm != null && largoEtqMm != null) {
    // Default: horizontal (ancho >= alto), salvo indicación explícita en notas/chatter.
    if (forceVertical && anchoEtqMm > largoEtqMm) {
      const tmp = anchoEtqMm;
      anchoEtqMm = largoEtqMm;
      largoEtqMm = tmp;
    } else if (!forceVertical || forceHorizontal) {
      if (largoEtqMm > anchoEtqMm) {
        const tmp = anchoEtqMm;
        anchoEtqMm = largoEtqMm;
        largoEtqMm = tmp;
      }
    }
  }

  const ANCHO_PX = anchoEtqMm != null ? Math.round(anchoEtqMm * 3.5) : 200;
  const ALTO_PX = largoEtqMm != null ? Math.round(largoEtqMm * 3.5) : 120;

  let bordadaTituloMm = "BORDADA";
  if (anchoEtqMm != null && largoEtqMm != null) {
    bordadaTituloMm = `BORDADA ${anchoEtqMm}mm x ${largoEtqMm}mm`;
  } else if (anchoEtqMm != null) {
    bordadaTituloMm = `BORDADA ${anchoEtqMm}mm`;
  } else if (largoEtqMm != null) {
    bordadaTituloMm = `BORDADA ${largoEtqMm}mm`;
  }

  const anchoDisp = anchoEtqMm != null ? `${anchoEtqMm}mm` : "—";
  const largoDisp = largoEtqMm != null ? `${largoEtqMm}mm` : "—";
  const anchoSkuDisp =
    anchoEtqMm != null
      ? String(anchoEtqMm)
      : skuParsed.ancho != null && skuParsed.ancho !== "" && !Number.isNaN(Number(skuParsed.ancho))
        ? String(skuParsed.ancho)
        : "—";
  const coloresSku = skuParsed.colores != null && skuParsed.colores !== "" ? String(skuParsed.colores) : "—";

  const varr = (notas && notas.variantes) || [];
  const visCols = visionData.colors || [];
  const hexD1 = visCols[0] && visCols[0].hex;
  const hexD2 = visCols[1] && visCols[1].hex;

  const fondoRaw = notas && notas.fondoColor;
  const relieveRaw = notas && notas.relieveColor;
  let bgCss;
  if (fondoRaw) {
    bgCss = colorNameToCss(fondoRaw);
  } else if (varr[0]) {
    bgCss = colorNameToCss(varr[0]);
  } else {
    bgCss = hexD1 || "#f0f0f0";
  }
  let relieveCss;
  if (relieveRaw) {
    relieveCss = relieveColorToCss(relieveRaw, bgCss);
  } else if (hexD2) {
    relieveCss = hexD2;
  } else {
    relieveCss = /^#/.test(String(bgCss)) ? contrasteHexFromBgHex(bgCss) : contrasteTexto(bgCss);
  }

  const marcaTxt =
    String(marca || "").trim() ||
    String((line && line._partnerName) || "").trim() ||
    "MARCA";
  const fontEtq = Math.max(10, Math.round(ANCHO_PX / 6));
  const doblez = term.cde || term.cdm;
  const dualVariantes = varr.length >= 2;
  const cantVarTxt = (notas && notas.cantidad_variante_txt) || "";

  const hasRefLogo = logoDataUri && String(logoDataUri).startsWith("data:");
  const refLogoSrcEsc = hasRefLogo ? escapeHtmlProposal(logoDataUri) : "";
  const refClienteBlock = hasRefLogo
    ? `<div style="flex:0 0 auto;text-align:center;padding-left:12px;">
  <img src="${refLogoSrcEsc}" alt="" style="max-height:80px;max-width:120px;object-fit:contain;border:1px solid #ddd;">
  <div style="font-size:8px;color:#666;margin-top:4px;">Ref. cliente</div>
</div>`
    : "";

  const coloresList = (notas && notas.colores) || [];
  const brandTxtComb = escapeHtmlProposal(marcaTxt);
  let combinacionesBlock = "";
  if (coloresList.length) {
    combinacionesBlock = `<div class="combinaciones" style="width:100%;margin-top:14px;">
  <div class="combinaciones-titulo">Combinaciones de color</div>
  <div class="combinaciones-grid">
    ${coloresList
      .map((c) => {
        const st = proposalColorCssFromLabel(c);
        const bd = st.border ? st.border : "1px solid #999";
        return `<div class="color-muestra">
    <div class="color-rect" style="background:${st.bg};color:${st.fg};border:${bd};">${brandTxtComb}</div>
    <div style="font-size:9px;">${escapeHtmlProposal(c)}</div>
  </div>`;
      })
      .join("")}
  </div>
</div>`;
  }

  const tallesArr = (notas && notas.talles) || [];
  const mpt = (notas && notas.metros_por_talle) || {};
  const miniW = 60;
  const ratio = anchoEtqMm && largoEtqMm ? largoEtqMm / anchoEtqMm : ALTO_PX / Math.max(ANCHO_PX, 1);
  const miniH = Math.max(24, Math.round(miniW * ratio));
  const tallePrincipal = tallesArr.length ? String(tallesArr[0]).trim() : "";
  const marcaMiniPx = Math.max(6, Math.round(miniW / 10));
  const talleMiniPx = Math.max(10, Math.round(miniW / 3.2));
  const tallesBlock =
    tallesArr.length > 0
      ? `<div style="width:100%;margin-top:14px;">
  <div style="font-weight:bold;font-size:10px;margin-bottom:6px;">Distribución por talle:</div>
  <div style="display:grid;grid-template-columns:repeat(6,60px);gap:10px;width:100%;justify-content:start;">
    ${tallesArr
      .map((t) => {
        const tk = String(t).trim();
        const mts = mpt[tk] || mpt[tk.toUpperCase()] || mpt[tk.toLowerCase()];
        const mtsLine =
          mts != null && String(mts) !== ""
            ? `<div style="font-size:8px;color:#444;margin-top:2px;">${escapeHtmlProposal(String(mts))}mts</div>`
            : "";
        return `<div style="text-align:center;width:${miniW}px;">
      <div style="position:relative;width:${miniW}px;height:${miniH}px;border:2px solid #333;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${bgCss};color:${relieveCss};font-family:${fontFamilyCss};font-weight:bold;padding:4px;gap:2px;">
      <span style="font-size:${marcaMiniPx}px;line-height:1;">${escapeHtmlProposal(marcaTxt)}</span>
      <span style="font-size:${talleMiniPx}px;line-height:1;">${escapeHtmlProposal(tk)}</span>${
        doblez
          ? `<div style="position:absolute;left:0;right:0;top:50%;border-top:1px dashed #555;pointer-events:none;"></div>`
          : ""
      }</div>
      ${mtsLine}
    </div>`;
      })
      .join("")}
  </div>
</div>`
      : "";

  const txs = (visionData.texts || []).map((t) => String(t).trim()).filter((t) => t.length > 3);
  const refDetected =
    txs.find((s, i) => i > 0 && s.length < 180) ||
    txs.find((s) => s.length >= 4 && s.length < 180) ||
    "";
  const visionInstrExtra =
    refDetected !== ""
      ? `\n\nTexto detectado en la referencia: ${refDetected}`
      : "";
  const instrRaw = ((notas && notas.instrucciones) || "") + visionInstrExtra;
  const instrTrunc = truncInstruccionesProposal(instrRaw);
  const instrBlock =
    instrTrunc !== ""
      ? `<div class="instrucciones" style="width:100%;margin-top:10px;font-size:9px;font-style:italic;color:#555;border-top:1px solid #eee;padding-top:6px;white-space:pre-line;">${escapeHtmlProposal(instrTrunc)}</div>`
      : "";

  const foldHtml = doblez
    ? `<div style="position:absolute;left:0;right:0;top:50%;border-top:1px dashed #666;pointer-events:none;z-index:1;"></div>`
    : "";

  const marcaLabelPx = tallesArr.length ? Math.max(8, Math.round(fontEtq * 0.42)) : fontEtq;
  const talleLabelPx = Math.max(10, Math.round(fontEtq * 1.15));
  const innerMarcaTalle =
    tallesArr.length > 0
      ? `<span style="position:relative;z-index:2;font-size:${marcaLabelPx}px;line-height:1.1;">${escapeHtmlProposal(marcaTxt)}</span><span style="position:relative;z-index:2;font-size:${talleLabelPx}px;line-height:1;">${escapeHtmlProposal(tallePrincipal)}</span>`
      : `<span style="position:relative;z-index:2;font-size:${fontEtq}px;line-height:1.15;">${escapeHtmlProposal(marcaTxt)}</span>`;

  const cotaVHtml = (h) => `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:${h}px;width:22px;color:#cc0000;font-size:10px;font-weight:bold;margin-right:6px;flex-shrink:0;">
          <span style="line-height:1;">▲</span>
          <div style="flex:1;width:0;border-left:2px dashed #cc0000;margin:2px 0;"></div>
          <div style="writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;line-height:1.1;">${escapeHtmlProposal(largoDisp)}</div>
          <div style="flex:1;width:0;border-left:2px dashed #cc0000;margin:2px 0;"></div>
          <span style="line-height:1;">▼</span>
        </div>`;

  const cotaHHtml = (wExtra) => `<div style="display:flex;align-items:center;justify-content:center;margin-top:6px;color:#cc0000;font-size:10px;font-weight:bold;width:${wExtra}px;">
        <span style="line-height:1;">◀</span>
        <div style="flex:1;height:0;border-bottom:2px dashed #cc0000;margin:0 6px;"></div>
        <span>${escapeHtmlProposal(anchoDisp)}</span>
        <div style="flex:1;height:0;border-bottom:2px dashed #cc0000;margin:0 6px;"></div>
        <span style="line-height:1;">▶</span>
      </div>`;

  let vistaEtiquetaPrincipal = "";
  if (dualVariantes) {
    const cantVarRow =
      cantVarTxt !== ""
        ? `<div style="width:100%;text-align:center;margin-bottom:8px;font-size:10px;font-weight:bold;">${escapeHtmlProposal(cantVarTxt)}</div>`
        : `<div style="width:100%;text-align:center;margin-bottom:4px;font-size:9px;color:#555;">Variantes de color</div>`;
    const cols = [0, 1]
      .map((i) => {
        const bgV = colorNameToCss(varr[i]);
        const fgV = relieveRaw ? relieveColorToCss(relieveRaw, bgV) : contrasteHexFromBgHex(bgV);
        const innerVar =
          tallesArr.length > 0
            ? `<span style="position:relative;z-index:2;font-size:${marcaLabelPx}px;line-height:1.1;">${escapeHtmlProposal(marcaTxt)}</span><span style="position:relative;z-index:2;font-size:${talleLabelPx}px;line-height:1;">${escapeHtmlProposal(tallePrincipal)}</span>`
            : `<span style="position:relative;z-index:2;font-size:${fontEtq}px;line-height:1.15;">${escapeHtmlProposal(marcaTxt)}</span>`;
        return `<div style="display:flex;flex-direction:column;align-items:center;">
      <div style="display:flex;flex-direction:row;align-items:flex-end;">
        ${cotaVHtml(ALTO_PX)}
        <div style="position:relative;border:2px solid #333;box-sizing:border-box;width:${ANCHO_PX}px;height:${ALTO_PX}px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${bgV};color:${fgV};font-weight:bold;text-align:center;padding:8px;gap:4px;overflow:hidden;font-family:${fontFamilyCss};">
          ${foldHtml}
          ${innerVar}
        </div>
      </div>
      ${cotaHHtml(ANCHO_PX + 28)}
    </div>`;
      })
      .join("");
    vistaEtiquetaPrincipal = `${cantVarRow}<div style="display:flex;flex-direction:row;gap:16px;justify-content:center;align-items:flex-start;flex-wrap:wrap;width:100%;">${cols}</div>`;
  } else {
    vistaEtiquetaPrincipal = `<div style="display:flex;flex-direction:column;align-items:center;">
    <div style="display:flex;flex-direction:row;align-items:flex-end;">
        ${cotaVHtml(ALTO_PX)}
        <div style="position:relative;border:2px solid #333;box-sizing:border-box;width:${ANCHO_PX}px;height:${ALTO_PX}px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${bgCss};color:${relieveCss};font-weight:bold;text-align:center;padding:8px;gap:4px;overflow:hidden;font-family:${fontFamilyCss};">
          ${foldHtml}
          ${innerMarcaTalle}
        </div>
      </div>
      ${cotaHHtml(ANCHO_PX + 28)}
    </div>`;
  }

  return `<div class="sheet">
<div class="header">
  ${proposalHeaderLeftHtml()}
  <div class="header-title">PROPUESTA BORDADA - ${escapeHtmlProposal(orden_id)}</div>
  <div></div>
</div>
<div class="ov-title">${buildOvTitleLineHtmlProposal(orden_id, marca)}</div>
<div class="ficha">
  <div class="ficha-row">
    <span class="ficha-label">Tipo de tejido:</span>
    ${checkboxHtmlProposal("Tafeta", tej.tafeta)}
    ${checkboxHtmlProposal("Alta Def.", tej.ad)}
    ${checkboxHtmlProposal("½ Taf & AD", tej.mitad)}
  </div>
  <div class="ficha-row">
    <span class="ficha-label">Ancho:</span> ${escapeHtmlProposal(anchoSkuDisp)} mm
  </div>
  <div class="ficha-row">
    <span class="ficha-label">Terminación:</span>
    ${checkboxHtmlProposal("Rollo", term.rollo)}
    ${checkboxHtmlProposal("C.Sold.", term.cs)}
    ${checkboxHtmlProposal("C.Dob.Ext.", term.cde)}
    ${checkboxHtmlProposal("C.Dob.Med.", term.cdm)}
  </div>
  <div class="ficha-row">
    <span class="ficha-label">Cant. Colores:</span> ${escapeHtmlProposal(coloresSku)}
  </div>
  <div class="ficha-row">
    <span class="ficha-label">Cantidad:</span> ${escapeHtmlProposal(String(line.qty ?? ""))}
  </div>
</div>
<div class="seccion-disenio" style="align-items:stretch;">
  <div style="font-weight:bold;font-size:11px;margin-bottom:10px;width:100%;">
    ${escapeHtmlProposal(bordadaTituloMm)}
  </div>
  <div style="display:flex;flex-direction:row;align-items:flex-start;justify-content:center;width:100%;flex-wrap:wrap;">
    ${vistaEtiquetaPrincipal}
    ${refClienteBlock}
  </div>
  ${tallesBlock}
  ${combinacionesBlock}
  ${instrBlock}
</div>
<div class="footer">AVÍOS TEXTILES</div>
</div>`;
}

function buildBadanaSheetHtml(orden_id, marca, marcaRect, line, skuParsed, notas, logoPath, logoDataUri) {
  const nAn = Number(skuParsed.ancho);
  const nAl = Number(skuParsed.alto);
  const aw = Number.isFinite(nAn) && nAn > 0 ? nAn : null;
  const ah = Number.isFinite(nAl) && nAl > 0 ? nAl : null;
  const awS = aw != null ? String(aw) : "—";
  const ahS = ah != null ? String(ah) : "—";
  const ANCHO_PX = aw != null ? Math.round(aw * 3.5) : 180;
  const ALTO_PX = ah != null ? Math.round(ah * 3.5) : 120;
  const subN = normalizeStr(String(skuParsed.subtipo || ""));
  let material = "Otro";
  if (subN.includes("pu") || String(skuParsed.raw || "").includes("PU")) material = "PU";
  else if (subN.includes("cuero")) material = "cuero";
  const brandShow = String(marcaRect || "").trim() || "MARCA";

  const hasRefLogo = logoDataUri && String(logoDataUri).startsWith("data:");
  const refLogoSrcEsc = hasRefLogo ? escapeHtmlProposal(logoDataUri) : "";
  let innerEtiqueta = escapeHtmlProposal(brandShow);
  if (hasRefLogo) {
    innerEtiqueta = `<img src="${refLogoSrcEsc}" style="width:90%;height:90%;object-fit:contain;" alt="">`;
  } else if (logoPath && fs.existsSync(logoPath)) {
    try {
      const b64 = fs.readFileSync(logoPath).toString("base64");
      innerEtiqueta = `<img src="data:image/png;base64,${b64}" style="width:90%;height:90%;object-fit:contain;" alt="">`;
    } catch (_) {
      innerEtiqueta = escapeHtmlProposal(brandShow);
    }
  }

  const brandTxtComb = String(marcaRect || "").trim() || "MARCA";
  const coloresList = (notas && notas.colores) || [];
  let combinacionesInner = "";
  if (!coloresList.length) {
    combinacionesInner = `<div class="color-muestra"><div class="color-rect" style="background:#eeeeee;color:#333;border:1px solid #ccc;">${escapeHtmlProposal(brandTxtComb)}</div><div>Sin datos</div></div>`;
  } else {
    combinacionesInner = coloresList
      .map((c) => {
        const st = proposalColorCssFromLabel(c);
        const bd = st.border ? st.border : "1px solid #999";
        if (hasRefLogo) {
          return `<div class="color-muestra">
    <div style="position:relative;width:80px;height:55px;">
      <img src="${refLogoSrcEsc}" style="width:100%;height:100%;object-fit:cover;border-radius:2px;" alt="">
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:${st.bg};opacity:0.5;border-radius:2px;"></div>
    </div>
    <div style="font-size:9px;text-align:center;">${escapeHtmlProposal(c)}</div>
  </div>`;
        }
        return `<div class="color-muestra">
    <div class="color-rect" style="background:${st.bg};color:${st.fg};border:${bd};">${escapeHtmlProposal(brandTxtComb)}</div>
    <div>${escapeHtmlProposal(c)}</div>
  </div>`;
      })
      .join("");
  }

  return `<div class="sheet">
<div class="header">
  ${proposalHeaderLeftHtml()}
  <div class="header-title">PROPUESTA BADANA - ${escapeHtmlProposal(orden_id)}</div>
  <div></div>
</div>
<div class="ov-title">${buildOvTitleLineHtmlProposal(orden_id, marca)}</div>
<div class="ficha">
  <div class="ficha-row"><span class="ficha-label">Medidas (cm):</span> ${escapeHtmlProposal(awS)} × ${escapeHtmlProposal(ahS)}</div>
  <div class="ficha-row"><span class="ficha-label">Cantidad:</span> ${escapeHtmlProposal(String(line.qty ?? ""))}</div>
  <div class="ficha-row"><span class="ficha-label">Material:</span> ${escapeHtmlProposal(material)}</div>
</div>
<div class="seccion-disenio">
  <div style="font-weight:bold;font-size:11px;margin-bottom:8px;">BADANA</div>
  ${
    hasRefLogo
      ? `<div style="font-size:9px;color:#666;margin-bottom:8px;">Diseño basado en referencia del cliente</div>`
      : ""
  }
  <div class="cota-vertical-container">
    <div class="cota-vertical">${escapeHtmlProposal(ahS)} cm</div>
    <div class="linea-cota" style="height:${ALTO_PX}px;"></div>
    <div style="border:2px solid #8db43e;border-radius:8px;padding:10px;display:flex;align-items:center;justify-content:center;">
      <div style="border:2px solid #000;background:#fff;width:${ANCHO_PX}px;min-width:80px;height:${ALTO_PX}px;min-height:60px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:11px;text-align:center;color:#000;">
        ${innerEtiqueta}
      </div>
    </div>
  </div>
  <div class="cota-horizontal">${escapeHtmlProposal(awS)} cm</div>
  <div class="combinaciones">
    <div class="combinaciones-titulo">Colores</div>
    <div class="combinaciones-grid">
      ${combinacionesInner}
    </div>
  </div>
  <div class="instrucciones">${escapeHtmlProposal((notas && notas.instrucciones) || "")}</div>
</div>
<div class="footer">AVÍOS TEXTILES</div>
</div>`;
}

function buildBolsaSvgHtml(skuParsed) {
  const w = 120;
  const h = 100;
  const tipo = skuParsed.bolsaTipo || "simple";
  if (tipo === "camiseta") {
    return `<svg width="160" height="150" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 150">
  <rect x="30" y="35" width="100" height="100" fill="none" stroke="#000" stroke-width="2"/>
  <path d="M 45 35 Q 45 15 58 35" fill="none" stroke="#000" stroke-width="2"/>
  <path d="M 115 35 Q 115 15 102 35" fill="none" stroke="#000" stroke-width="2"/>
</svg>`;
  }
  if (tipo === "fondo") {
    return `<svg width="160" height="120" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">
  <rect x="20" y="15" width="120" height="90" fill="none" stroke="#000" stroke-width="2"/>
  <line x1="55" y1="15" x2="55" y2="105" stroke="#000" stroke-width="1.5"/>
  <line x1="105" y1="15" x2="105" y2="105" stroke="#000" stroke-width="1.5"/>
</svg>`;
  }
  if (tipo === "rinon") {
    return `<svg width="160" height="120" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">
  <rect x="25" y="20" width="110" height="80" rx="38" ry="38" fill="none" stroke="#000" stroke-width="2"/>
</svg>`;
  }
  return `<svg width="140" height="100" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100">
  <rect x="15" y="15" width="110" height="70" fill="none" stroke="#000" stroke-width="2"/>
</svg>`;
}

function buildBolsaSheetHtml(orden_id, marca, line, skuParsed, notas, logoPath) {
  const mc = skuParsed.materialChecks || {};
  const mats = ["PP", "OXI", "BIO", "Friselina"]
    .map((label) => {
      const on =
        (label === "PP" && mc.pp) ||
        (label === "OXI" && mc.oxi) ||
        (label === "BIO" && mc.bio) ||
        (label === "Friselina" && mc.friselina);
      return checkboxHtmlProposal(label, on);
    })
    .join(" ");
  const ba = skuParsed.bolsaAncho != null ? String(skuParsed.bolsaAncho) : "—";
  const bo = skuParsed.bolsaAlto != null ? String(skuParsed.bolsaAlto) : "—";
  const dims = ba !== "—" && bo !== "—" ? `${ba}x${bo}` : "";

  return `<div class="sheet">
<div class="header">
  ${proposalHeaderLeftHtml()}
  <div class="header-title">PROPUESTA BOLSA - ${escapeHtmlProposal(orden_id)}</div>
  <div></div>
</div>
<div class="ov-title">${buildOvTitleLineHtmlProposal(orden_id, marca)}</div>
<div class="ficha">
  <div class="ficha-row"><span class="ficha-label">Ancho:</span> ${escapeHtmlProposal(ba)}</div>
  <div class="ficha-row"><span class="ficha-label">Alto:</span> ${escapeHtmlProposal(bo)}</div>
  <div class="ficha-row"><span class="ficha-label">Material:</span> ${mats}</div>
  <div class="ficha-row"><span class="ficha-label">Tipo:</span> ${escapeHtmlProposal(skuParsed.familia || "Bolsa")}</div>
  <div class="ficha-row"><span class="ficha-label">Cantidad:</span> ${escapeHtmlProposal(String(line.qty ?? ""))}</div>
</div>
<div class="seccion-disenio">
  <div style="font-weight:bold;font-size:11px;margin-bottom:8px;">Diseño — ${escapeHtmlProposal(skuParsed.familia || "")}</div>
  <div class="bolsa-flex">
    <div>${buildBolsaSvgHtml(skuParsed)}</div>
    <div class="dim-roja" style="padding-top:20px;">${escapeHtmlProposal(dims)}</div>
  </div>
  <div class="instrucciones">${escapeHtmlProposal((notas && notas.instrucciones) || "")}</div>
</div>
<div class="footer">AVÍOS TEXTILES</div>
</div>`;
}

function buildPlastisolSheetHtml(orden_id, marca, line, skuParsed, notas, logoPath) {
  const aw = skuParsed.ancho !== "" && skuParsed.ancho != null ? String(skuParsed.ancho) : "—";
  const ah = skuParsed.alto !== "" && skuParsed.alto != null ? String(skuParsed.alto) : "—";
  const cols = skuParsed.colores != null && skuParsed.colores !== "" ? String(skuParsed.colores) : "—";
  return `<div class="sheet">
<div class="header">
  ${proposalHeaderLeftHtml()}
  <div class="header-title">PROPUESTA PLASTISOL - ${escapeHtmlProposal(orden_id)}</div>
  <div></div>
</div>
<div class="ov-title">${buildOvTitleLineHtmlProposal(orden_id, marca)}</div>
<div class="ficha">
  <div class="ficha-row"><span class="ficha-label">Medidas (cm):</span> ${escapeHtmlProposal(aw)} × ${escapeHtmlProposal(ah)}</div>
  <div class="ficha-row"><span class="ficha-label">Colores:</span> ${escapeHtmlProposal(cols)}</div>
  <div class="ficha-row"><span class="ficha-label">Cantidad:</span> ${escapeHtmlProposal(String(line.qty ?? ""))}</div>
</div>
<div class="seccion-disenio">
  <div style="font-weight:bold;font-size:12px;margin-bottom:10px;">Diseño</div>
  <div class="etiqueta-rect" style="width:320px;height:120px;border-radius:8px;">
    ${aw !== "—" && ah !== "—" ? `${escapeHtmlProposal(aw)} cm × ${escapeHtmlProposal(ah)} cm` : "Medidas según SKU"}
  </div>
  <div class="instrucciones" style="margin-top:16px;">${escapeHtmlProposal((notas && notas.instrucciones) || "")}</div>
</div>
<div class="footer">AVÍOS TEXTILES</div>
</div>`;
}

function buildGenericSheetHtml(orden_id, marca, line, skuParsed, notas, logoPath) {
  return `<div class="sheet">
<div class="header">
  ${proposalHeaderLeftHtml()}
  <div class="header-title">PROPUESTA - ${escapeHtmlProposal(orden_id)}</div>
  <div></div>
</div>
<div class="ov-title">${buildOvTitleLineHtmlProposal(orden_id, marca)}</div>
<table class="prop-gen">
  <thead><tr><th>Producto</th><th>Cantidad</th></tr></thead>
  <tbody>
    <tr>
      <td>${escapeHtmlProposal(line.name || skuParsed.raw || "")}</td>
      <td>${escapeHtmlProposal(String(line.qty ?? ""))}</td>
    </tr>
  </tbody>
</table>
<div class="instrucciones" style="margin:0 20px 40px;">${escapeHtmlProposal((notas && notas.instrucciones) || "")}</div>
<div class="footer">AVÍOS TEXTILES</div>
</div>`;
}

function proposalLayoutKey(skuParsed) {
  if (skuParsed.familia === "Plastisol") return "plastisol";
  if (skuParsed.layoutFamily === "bolsa") return "bolsa";
  if (skuParsed.layoutFamily === "badana" || skuParsed.familia === "Badana") return "badana";
  const raw = String(skuParsed.raw || "");
  if (skuParsed.layoutFamily === "bordada" || /^(BAD|EBAD|EBAT|EESN|EEAL)/i.test(raw)) {
    return "bordada";
  }
  return "generico";
}

async function htmlToPdf(htmlContent, outputPath) {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" }
    });
  } finally {
    await browser.close();
  }
}

async function generateProposalPDF(data, outputPath) {
  const { orden_id, partner_name, lineas, notas } = data;
  const marca = String(data.marca || "").trim();
  const marcaRect = marca || "MARCA";
  const logoPath = data.logoPath || "";
  const logoDataUri = data.logoDataUri || null;
  const visionData = data.visionData || { texts: [], colors: [] };
  const proposalFontPick =
    data.proposalFontPick || proposalBordadaFontPickFromVision(visionData.texts || []);
  const sheets = [];
  for (const line of lineas || []) {
    line._partnerName = partner_name;
    line._logoPath = logoPath;
    const skuParsed = line.skuParsed || parseSKU(line.sku || "");
    const key = proposalLayoutKey(skuParsed);
    console.log("[propuesta] generando HTML para familia:", skuParsed.familia || key);
    if (key === "plastisol") {
      sheets.push(buildPlastisolSheetHtml(orden_id, marca, line, skuParsed, notas, logoPath));
    } else if (key === "bolsa") {
      sheets.push(buildBolsaSheetHtml(orden_id, marca, line, skuParsed, notas, logoPath));
    } else if (key === "badana") {
      sheets.push(buildBadanaSheetHtml(orden_id, marca, marcaRect, line, skuParsed, notas, logoPath, logoDataUri));
    } else if (key === "bordada") {
      sheets.push(
        buildBordadaSheetHtml(
          orden_id,
          marca,
          marcaRect,
          line,
          skuParsed,
          notas,
          logoPath,
          logoDataUri,
          visionData,
          proposalFontPick
        )
      );
    } else {
      sheets.push(buildGenericSheetHtml(orden_id, marca, line, skuParsed, notas, logoPath));
    }
  }
  const html = wrapProposalHtmlDocument(sheets.join("\n"), proposalFontPick.linkHref || "");
  await htmlToPdf(html, outputPath);
  console.log("[propuesta] PDF guardado en:", outputPath);
}

function nextProposalFilename(ordenId) {
  const base = `${ordenId}-propuesta`;
  for (let v = 1; v < 99; v++) {
    const ver = `v${String(v).padStart(2, "0")}`;
    const name = `${base}-${ver}.pdf`;
    const fp = path.join(PROPUESTAS_DIR, name);
    if (!fs.existsSync(fp)) return name;
  }
  return `${base}-v99.pdf`;
}

async function handleGenerarPropuestaEndpoint(req, res) {
  const ordenRaw = String(req.body?.orden_id || "").trim();
  const orden_id = ordenRaw.toUpperCase().replace(/\s+/g, "");
  if (!orden_id || !/^S0\d+/i.test(orden_id)) {
    return res.status(400).json({ success: false, error: "orden_id inválido (ej: S02281)" });
  }
  try {
    validateEnv();
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || "Config incompleta" });
  }
  const odoo = createOdooClient();
  let uid;
  try {
    uid = await odoo.authenticate();
  } catch (e) {
    return res.status(500).json({ success: false, error: "No pude autenticar con ODOO" });
  }
  try {
    console.log("[propuesta] leyendo OV…", orden_id);
    const orders = await odoo.executeKw(
      uid,
      "sale.order",
      "search_read",
      [[["name", "=", orden_id]]],
      {
        fields: ["id", "name", "partner_id", "date_order", "user_id", "order_line", "x_studio_marca"],
        limit: 1
      }
    );
    const order = orders && orders[0];
    if (!order) {
      return res.status(404).json({ success: false, error: `No encontré la OV ${orden_id}` });
    }
    const marca = String(order.x_studio_marca || "").trim();
    const lineIds = order.order_line || [];
    console.log("[propuesta] leyendo líneas…", lineIds.length);
    const lineRows = lineIds.length
      ? await odoo.executeKw(uid, "sale.order.line", "read", [lineIds], {
          fields: ["id", "name", "product_id", "product_uom_qty", "price_unit"]
        })
      : [];
    console.log("[propuesta] leyendo chatter…");
    let chatter = [];
    try {
      chatter = await odoo.executeKw(
        uid,
        "mail.message",
        "search_read",
        [
          [
            ["model", "=", "sale.order"],
            ["res_id", "=", order.id],
            ["message_type", "=", "comment"]
          ]
        ],
        { fields: ["body", "date", "author_id"], limit: 120, order: "date asc" }
      );
    } catch (e) {
      console.log("[propuesta] chatter sin filtro message_type, reintento…");
      chatter = await odoo.executeKw(
        uid,
        "mail.message",
        "search_read",
        [[["model", "=", "sale.order"], ["res_id", "=", order.id]]],
        { fields: ["body", "date", "author_id", "message_type"], limit: 120, order: "date asc" }
      );
      chatter = (chatter || []).filter((m) => (m.message_type || "comment") === "comment");
    }
    const partnerName = Array.isArray(order.partner_id) ? order.partner_id[1] : "Cliente";
    const vendedor = Array.isArray(order.user_id) ? order.user_id[1] : "";
    const date = order.date_order
      ? String(order.date_order).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const partnerId = Array.isArray(order.partner_id) ? order.partner_id[0] : null;
    const logoPath = partnerId ? path.join(LOGOS_DIR, `${partnerId}.png`) : "";

    let notas = parseChatterNotes(chatter || []);
    const chatterText = (chatter || []).map((c) => stripHtml(c.body)).join("\n");
    notas = await enrichChatterNotesWithGroqIfNeeded(notas, chatterText);

    let lineas = (lineRows || []).map((ln) => {
      const sku = extractSkuCandidateFromLine(ln);
      const skuParsed = parseSKU(sku);
      return {
        ...ln,
        sku,
        skuParsed,
        qty: ln.product_uom_qty,
        price_unit: ln.price_unit,
        name: ln.name || sku
      };
    });
    if (!lineas.length) {
      lineas.push({
        name: "Sin líneas",
        qty: 0,
        price_unit: 0,
        sku: "",
        skuParsed: parseSKU("")
      });
    }
    let logoDataUri = null;
    let visionData = { texts: [], colors: [] };
    let logoAdjunto = null;
    try {
      const adjuntos = await odoo.executeKw(
        uid,
        "ir.attachment",
        "search_read",
        [
          [
            ["res_model", "=", "sale.order"],
            ["res_id", "=", order.id],
            ["mimetype", "ilike", "image/"]
          ]
        ],
        { fields: ["id", "name", "datas", "mimetype"], limit: 5, order: "id asc" }
      );
      logoAdjunto = adjuntos && adjuntos.length ? adjuntos[0] : null;
      if (logoAdjunto && logoAdjunto.datas) {
        const mt = String(logoAdjunto.mimetype || "image/png").trim();
        if (/^image\/[a-z0-9.+-]+$/i.test(mt)) {
          logoDataUri = `data:${mt};base64,${String(logoAdjunto.datas).replace(/\s/g, "")}`;
        }
        console.log("[propuesta] analizando imagen con Google Vision...");
        visionData = await analyzeImageWithVision(
          String(logoAdjunto.datas).replace(/\s/g, ""),
          logoAdjunto.mimetype || "image/jpeg"
        );
      }
    } catch (e) {
      console.log("[propuesta] adjuntos imagen:", (e && e.message) || e);
    }

    const proposalFontPick = proposalBordadaFontPickFromVision(visionData.texts || []);
    if (logoAdjunto && logoAdjunto.datas) {
      console.log("[vision] tipografía seleccionada:", proposalFontPick.family);
      const visTop = (visionData.colors || [])[0];
      if (visTop && visTop.hex) {
        console.log("[vision] fondo detectado:", visTop.hex);
      }
    }

    const fileName = nextProposalFilename(orden_id);
    const outPath = path.join(PROPUESTAS_DIR, fileName);
    console.log("[propuesta] generando PDF…", fileName);
    await generateProposalPDF(
      {
        orden_id,
        partner_name: partnerName,
        marca,
        vendedor,
        lineas,
        notas,
        logoPath,
        logoDataUri,
        visionData,
        proposalFontPick
      },
      outPath
    );
    console.log("[propuesta] listo:", fileName);
    return res.json({ success: true, pdf_url: `/propuestas/${fileName}`, orden_id });
  } catch (e) {
    console.error("[propuesta] error:", e);
    return res.status(500).json({ success: false, error: (e && e.message) || String(e) });
  }
}
