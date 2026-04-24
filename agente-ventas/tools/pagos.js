/**
 * Pagos y deuda (integración Odoo)
 */

/**
 * @param {number} clienteId
 * @param {number} monto
 * @param {string} medio
 * @param {string} [referencia]
 */
async function registrarPago(clienteId, monto, medio, referencia) {
  void clienteId;
  void monto;
  void medio;
  void referencia;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {string} wppNumber
 */
async function pedirComprobante(wppNumber) {
  void wppNumber;
  throw new Error("Pendiente: implementar (WhatsApp: pedir foto)");
}

/**
 * @param {number} clienteId
 */
async function verificarPagosPendientes(clienteId) {
  void clienteId;
  throw new Error("Pendiente: implementar (facturas / saldo en Odoo)");
}

module.exports = {
  registrarPago,
  pedirComprobante,
  verificarPagosPendientes
};
