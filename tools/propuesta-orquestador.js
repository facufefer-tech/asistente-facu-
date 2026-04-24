const fs = require("fs");
const path = require("path");
const { buildPropuestaSVG } = require("./svg-propuesta");
const { exportSVGtoPDF } = require("./pdf-exporter");

function normalizeStr(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function safeName(v) {
  return String(v || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function pickSkuFromLine(line) {
  const name = String(line?.name || "");
  const byCode = String(line?.product_default_code || "").trim();
  if (byCode) return byCode.toUpperCase();
  const m = name.match(/\[([^\]]+)\]/);
  if (m && m[1]) return String(m[1]).trim().toUpperCase();
  const m2 = name.match(/\b(EBAD|EBAT|EESN|EEAL|BOPO|BAPU|PI|PL|EP)[A-Z0-9.xX-]*/i);
  if (m2 && m2[0]) return String(m2[0]).trim().toUpperCase();
  return "";
}

function parseMmFromSkuOrName(sku, name) {
  const s = `${sku || ""} ${name || ""}`;
  const m = s.match(/(\d+[.,]?\d*)\s*[xX]\s*(\d+[.,]?\d*)/);
  if (m) {
    return {
      ancho: Number(String(m[1]).replace(",", ".")),
      alto: Number(String(m[2]).replace(",", "."))
    };
  }
  const m2 = String(sku || "").match(/^[A-Z]+(\d{2,3})/);
  if (m2) {
    return { ancho: Number(m2[1]), alto: null };
  }
  return { ancho: null, alto: null };
}

function parseTalles(orderNote, lineName) {
  const src = `${orderNote || ""}\n${lineName || ""}`;
  const raw = src.match(/\b(XS|S|M|L|XL|XXL|XXXL|\d{1,2})\b/gi) || [];
  const uniq = [];
  const seen = new Set();
  for (const t of raw) {
    const k = String(t).toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
  }
  return uniq;
}

async function buildLogoDataUri(odoo, uid, saleOrderId, warnings) {
  try {
    const att = await odoo.executeKw(
      uid,
      "ir.attachment",
      "search_read",
      [[["res_model", "=", "sale.order"], ["res_id", "=", saleOrderId], ["mimetype", "ilike", "image/"]]],
      { fields: ["id", "name", "datas", "mimetype"], limit: 1, order: "id desc" }
    );
    const row = att?.[0];
    if (!row?.datas) return "";
    const mime = String(row.mimetype || "image/png");
    return `data:${mime};base64,${String(row.datas).replace(/\s/g, "")}`;
  } catch (e) {
    warnings.push(`logo no disponible: ${e.message}`);
    return "";
  }
}

async function generarPropuesta(ovId, deps = {}) {
  const warnings = [];
  const createOdooClient = deps.createOdooClient || global.createOdooClient;
  const parseSKU = deps.parseSKU || global.parseSKU;
  const analyzeImageWithVision = deps.analyzeImageWithVision || global.analyzeImageWithVision;
  const productDesignDB = deps.productDesignDB || global.productDesignDB || [];
  const desktopDir =
    deps.desktopDir || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), "Desktop", "aprobar");
  fs.mkdirSync(desktopDir, { recursive: true });

  const odoo = createOdooClient();
  const uid = await odoo.authenticate();
  const ovName = /^S0\d+/i.test(String(ovId || "")) ? String(ovId).toUpperCase() : "";
  let order;
  if (ovName) {
    const rows = await odoo.executeKw(uid, "sale.order", "search_read", [[["name", "=", ovName]]], {
      fields: ["id", "name", "partner_id", "note", "x_studio_marca", "order_line"],
      limit: 1
    });
    order = rows?.[0];
  } else {
    const rows = await odoo.executeKw(uid, "sale.order", "read", [[Number(ovId)]], {
      fields: ["id", "name", "partner_id", "note", "x_studio_marca", "order_line"]
    });
    order = rows?.[0];
  }
  if (!order?.id) throw new Error(`OV no encontrada: ${ovId}`);

  const lineIds = Array.isArray(order.order_line) ? order.order_line : [];
  const lines = lineIds.length
    ? await odoo.executeKw(uid, "sale.order.line", "read", [lineIds], {
        fields: ["id", "name", "product_id", "product_uom_qty"]
      })
    : [];
  if (!lines.length) throw new Error(`OV ${order.name}: sin líneas`);
  const first = lines[0];
  const productId = Array.isArray(first.product_id) ? first.product_id[0] : null;
  let productCode = "";
  if (productId) {
    const pp = await odoo.executeKw(uid, "product.product", "read", [[productId]], {
      fields: ["id", "default_code", "name"]
    });
    productCode = String(pp?.[0]?.default_code || "").toUpperCase();
  }
  const sku = pickSkuFromLine({ ...first, product_default_code: productCode });
  const skuParsed = parseSKU ? parseSKU(sku) : {};
  const design =
    productDesignDB.find((r) => String(r?.sku || "").toUpperCase() === sku) ||
    productDesignDB.find((r) => sku && String(r?.sku || "").toUpperCase().includes(sku.slice(0, 5))) ||
    null;

  const logoDataUri = await buildLogoDataUri(odoo, uid, order.id, warnings);
  let visionColors = [];
  if (!design?.colores?.length && logoDataUri && analyzeImageWithVision) {
    try {
      const base64 = logoDataUri.split("base64,")[1] || "";
      const mime = logoDataUri.split(";")[0].replace("data:", "") || "image/png";
      const vis = await analyzeImageWithVision(base64, mime);
      visionColors = Array.isArray(vis?.colors) ? vis.colors.map((c) => c.hex).filter(Boolean) : [];
    } catch (e) {
      warnings.push(`vision fallback error: ${e.message}`);
    }
  }

  const mm = parseMmFromSkuOrName(sku, first.name);
  const ancho = Number(design?.tamano_mm?.ancho || skuParsed?.ancho || mm.ancho || 60);
  const alto = Number(design?.tamano_mm?.alto || skuParsed?.alto || mm.alto || Math.round(ancho * 0.35));
  const talles = parseTalles(order.note, first.name);
  if (!talles.length) warnings.push("sin talles claros: usar COMPLETAR");

  const colorList = Array.isArray(design?.colores) && design.colores.length ? design.colores : visionColors;
  if (!colorList.length) warnings.push("sin colores de designDB/vision: usando placeholder");
  const colors = (colorList.length ? colorList : ["COMPLETAR"]).map((c) => ({ nombre: String(c), hex: String(c) }));

  const datos = {
    ov_name: order.name,
    ov: order.name,
    partner_name: Array.isArray(order.partner_id) ? order.partner_id[1] : "",
    cliente: Array.isArray(order.partner_id) ? order.partner_id[1] : "",
    marca: String(order.x_studio_marca || "").trim() || (Array.isArray(order.partner_id) ? order.partner_id[1] : ""),
    sku,
    nombre: first.name || "",
    qty: first.product_uom_qty || 0,
    ancho_mm: ancho,
    alto_mm: alto,
    texto_escrito: String(design?.texto_escrito || order.x_studio_marca || "COMPLETAR"),
    tipografia: String(design?.tipografia || "Arial"),
    orientacion: "",
    logo_base64: logoDataUri,
    material: String(skuParsed?.familia || ""),
    colores: colors,
    talles
  };

  console.log("LOGO DEBUG:", {
    logo_base64_length: datos.logo_base64?.length || 0,
    logo_base64_prefix: datos.logo_base64?.substring(0, 30) || "VACÍO"
  });

  const svgString = buildPropuestaSVG(datos);
  const clientSafe = safeName(datos.cliente || "cliente");
  const ovSafe = safeName(order.name);
  const svgPath = path.join(desktopDir, `${ovSafe}-${clientSafe}-propuesta.svg`);
  const pdfPath = path.join(desktopDir, `${ovSafe}-${clientSafe}-propuesta.pdf`);
  fs.writeFileSync(svgPath, svgString, "utf8");
  await exportSVGtoPDF(svgString, pdfPath);
  return { pdfPath, svgPath, warnings };
}

module.exports = { generarPropuesta };
