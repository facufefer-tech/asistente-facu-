/**
 * Entregas y logística (picking / estado OV según módulos Odoo)
 */

/**
 * @param {number} ovId
 */
async function consultarEntrega(ovId) {
  void ovId;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {number} ovId
 */
async function confirmarEntrega(ovId) {
  void ovId;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {string} wppNumber
 * @param {number} ovId
 */
async function notificarCliente(wppNumber, ovId) {
  void wppNumber;
  void ovId;
  throw new Error("Pendiente: implementar (WhatsApp)");
}

module.exports = {
  consultarEntrega,
  confirmarEntrega,
  notificarCliente
};
