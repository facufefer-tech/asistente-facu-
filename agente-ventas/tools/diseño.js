/**
 * Coordinación con el agente admin (HTTP)
 * ADMIN_AGENT_URL — POST /api/propuesta
 */

/**
 * @param {number} ovId
 * @param {string} especificaciones
 * @returns {Promise<{ pdfPath?: string, pdfUrl?: string, [k: string]: unknown }>}
 */
async function solicitarPropuesta(ovId, especificaciones) {
  const base = process.env.ADMIN_AGENT_URL || "";
  void base;
  void ovId;
  void especificaciones;
  // const axios = require("axios");
  // await axios.post(`${base}/api/propuesta`, { ... })
  throw new Error("Pendiente: implementar (POST al admin, enviar PDF al cliente vía tools/whatsapp)");
}

/**
 * @param {number} ovId
 */
async function consultarEstadoPropuesta(ovId) {
  void ovId;
  throw new Error("Pendiente: implementar (endpoint acordado con el admin)");
}

module.exports = {
  solicitarPropuesta,
  consultarEstadoPropuesta
};
