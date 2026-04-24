/**
 * Agente de ventas — backend principal
 * Flujo: webhook WhatsApp → identificar cliente → Odoo + sesión → intención → acción → respuesta
 *
 * Intenciones: SALUDO_NUEVO, CONSULTA_PRECIO, PEDIR_PRESUPUESTO, CONFIRMAR_PEDIDO, ENVIAR_COMPROBANTE,
 *              CONSULTAR_ESTADO, PEDIR_DISEÑO, CONSULTA_GENERAL
 */

require("dotenv").config();
const path = require("path");
const express = require("express");

const BUILD_AGENT_SYSTEM_PROMPT = `Sos el asistente de ventas de Avíos Textiles Argentina.
Trabajás 24hs respondiendo consultas de clientes por WhatsApp.
Tu trabajo es: entender qué necesita el cliente, buscar info en ODOO, generar presupuestos, confirmar pedidos,
registrar pagos y coordinar entregas.
Siempre hablás de vos a vos, tono amable y directo.
Nunca inventás precios, fechas ni disponibilidad.
Si no sabés algo, consultás ODOO o escalás a Axel.
Representás a Avíos Textiles de forma profesional.`;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * Webhook — verificación Meta (GET)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  // Pendiente: comparar token con process.env.WHATSAPP_VERIFY_TOKEN
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Webhook — mensajes entrantes (POST)
 * 1) Identificar cliente, 2) contacto Odoo, 3) sesión, 4) intención, 5) acción, 6) WhatsApp
 */
app.post("/webhook", (req, res) => {
  // Responder 200 rápido para Meta; el procesamiento async (parseIncomingMessage, Odoo, Groq) pendiente
  res.sendStatus(200);
  if (req.body) {
    void req.body;
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "agente-ventas" });
});

// Pendiente: panel de monitoreo APIs (conversaciones, estados, pagos, alertas, tomar control)

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[agente-ventas] http://0.0.0.0:${port}`);
  });
}

module.exports = {
  app,
  BUILD_AGENT_SYSTEM_PROMPT
};
