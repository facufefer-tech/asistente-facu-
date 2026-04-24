/**
 * Meta WhatsApp Business Cloud API
 */

async function sendMessage(to, text) {
  void to;
  void text;
  throw new Error("Pendiente: implementar");
}

async function sendImage(to, imageUrl, caption) {
  void to;
  void imageUrl;
  void caption;
  throw new Error("Pendiente: implementar");
}

async function sendDocument(to, docUrl, filename) {
  void to;
  void docUrl;
  void filename;
  throw new Error("Pendiente: implementar");
}

async function sendTemplate(to, templateName, params) {
  void to;
  void templateName;
  void params;
  throw new Error("Pendiente: implementar");
}

/**
 * @param {Record<string, unknown>} webhookBody
 * @returns {{ from: string, text?: string, imageBase64?: string, type: string, raw: Record<string, unknown> }}
 */
function parseIncomingMessage(webhookBody) {
  void webhookBody;
  throw new Error("Pendiente: implementar");
}

module.exports = {
  sendMessage,
  sendImage,
  sendDocument,
  sendTemplate,
  parseIncomingMessage
};
