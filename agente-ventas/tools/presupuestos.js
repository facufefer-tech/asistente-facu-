/**
 * Generar y enviar presupuestos (Odoo + WhatsApp)
 * Reutilizar lógica del agente admin donde exista.
 */

/**
 * @param {{ ovId?: number, items?: Array<{ productId: number, qty: number }> }} opt
 * @returns {Promise<{ presupuestoId: number, pdfPath?: string, pdfUrl?: string }>}
 */
async function generarPresupuesto(opt) {
  void opt;
  throw new Error("Pendiente: implementar (reporte/PDF Odoo)");
}

/**
 * @param {string} clienteWpp
 * @param {number} presupuestoId
 */
async function enviarPresupuesto(clienteWpp, presupuestoId) {
  void clienteWpp;
  void presupuestoId;
  throw new Error("Pendiente: implementar (documento vía WhatsApp)");
}

module.exports = {
  generarPresupuesto,
  enviarPresupuesto
};
