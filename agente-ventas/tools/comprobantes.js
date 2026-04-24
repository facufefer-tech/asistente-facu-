/**
 * Leer comprobante de transferencia (Google Cloud Vision)
 * @param {string} imageBase64
 * @returns {Promise<{
 *   banco?: string,
 *   monto?: number,
 *   fecha?: string,
 *   cbuOAlias?: string,
 *   referencia?: string,
 *   rawText?: string
 * }>}
 */
async function readComprobante(imageBase64) {
  void imageBase64;
  throw new Error("Pendiente: implementar (Vision API + parseo a campos ODOO)");
}

module.exports = { readComprobante };
