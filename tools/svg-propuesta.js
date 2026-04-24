const MM_TO_PX = 3.7795;

function mmToPx(mm, fallback = 0) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n * MM_TO_PX;
}

function esc(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeStr(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function colorNameToHex(v) {
  const raw = String(v || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  const n = normalizeStr(raw);
  const map = {
    negro: "#000000",
    blanco: "#ffffff",
    rojo: "#cc0000",
    azul: "#003399",
    verde: "#2d7a2d",
    amarillo: "#f0c020",
    dorado: "#c8a400",
    plateado: "#aaaaaa",
    rosa: "#e87da8",
    fucsia: "#cc007a",
    naranja: "#d97706",
    violeta: "#6d28d9",
    bordo: "#6b0020",
    gris: "#888888",
    beige: "#c8b89a",
    arena: "#c8b89a",
    marron: "#5c3317",
    cafe: "#5c3317",
    marron1: "#5c3317",
    marron2: "#8b5e3c",
    transparente: "#dddddd"
  };
  return map[n] || "#dddddd";
}

function contrastText(hex) {
  const h = colorNameToHex(hex);
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 145 ? "#ffffff" : "#111111";
}

function detectFamilyAndTermination(datos) {
  const sku = String(datos?.sku || "").toUpperCase();
  const name = String(datos?.nombre || "");
  const blob = `${sku} ${name}`.toUpperCase();
  let family = "generico";
  if (/EBAD|EBAT|EESN|EEAL|BORDAD/.test(blob)) family = "bordada";
  else if (/^BOPO|BOLSA/.test(blob)) family = "bolsa";
  else if (/^BAPU|BADANA/.test(blob)) family = "badana";
  else if (/^PI|^PL|^EP|PLASTISOL/.test(blob)) family = "plastisol";
  else if (/HANG|HTZ|CART/.test(blob)) family = "hangtag";

  let term = "NA";
  if (/R1|R2/.test(blob)) term = "ROLLO";
  else if (/CDE1|CDE2/.test(blob)) term = "CDE";
  else if (/CDM1|CDM2/.test(blob)) term = "CDM";
  else if (/\bCS\b/.test(blob)) term = "CS";
  return { family, term };
}

function resolveOrientation(datos, det) {
  const w = Number(datos?.ancho_mm || 0);
  const h = Number(datos?.alto_mm || 0);
  const hint = normalizeStr(datos?.orientacion || "");
  const isRollo33 = det.term === "ROLLO" && Math.round(w || 0) === 33;
  if (isRollo33) return "vertical";
  if (hint.includes("vertical")) return "vertical";
  if (hint.includes("horizontal")) return "horizontal";
  if (w && h) return h > w ? "vertical" : "horizontal";
  return "horizontal";
}

function resolveLayoutCode(det, orient) {
  if (det.family === "bordada" && orient === "vertical") return "A";
  if (det.family === "bordada") return "B";
  if (det.family === "badana") return "C";
  if (det.family === "bolsa") return "D";
  if (det.family === "plastisol") return "E";
  if (det.family === "hangtag") return "F";
  if (det.term === "CDE" || det.term === "CDM") return "G";
  return "H";
}

function normalizeColors(datos) {
  const inColors = Array.isArray(datos?.colores) ? datos.colores : [];
  const out = inColors
    .map((c) => {
      if (typeof c === "string") {
        const hex = colorNameToHex(c);
        return { nombre: c, hex };
      }
      return {
        nombre: String(c?.nombre || c?.hex || "COMPLETAR"),
        hex: colorNameToHex(c?.hex || c?.nombre || "")
      };
    })
    .filter((c) => c && c.hex);
  return out.length ? out : [{ nombre: "COMPLETAR", hex: "#dddddd" }];
}

function renderMainLabelBlock(x, y, w, h, brandText, talleText, logoHref, bg, fg) {
  const logo = logoHref
    ? `<image href="${esc(logoHref)}" x="${x + w * 0.1}" y="${y + h * 0.04}" width="${w * 0.8}" height="${h * 0.45}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${x + w / 2}" y="${y + h * 0.28}" text-anchor="middle" font-size="${Math.max(10, w * 0.09)}" fill="#cc0000">COMPLETAR LOGO</text>`;
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}" stroke="#333" stroke-width="1.2"/>
  <line x1="${x}" y1="${y + h * 0.5}" x2="${x + w}" y2="${y + h * 0.5}" stroke="#cc0000" stroke-width="1" stroke-dasharray="4,3"/>
  ${logo}
  <text x="${x + w / 2}" y="${y + h * 0.72}" text-anchor="middle" font-size="${Math.max(11, h * 0.12)}" font-weight="700" fill="${fg}">${esc(brandText)}</text>
  <text x="${x + w * 0.92}" y="${y + h * 0.93}" text-anchor="end" font-size="${Math.max(14, h * 0.22)}" font-weight="700" fill="${fg}">${esc(talleText)}</text>`;
}

function buildPropuestaSVG(datos) {
  const det = detectFamilyAndTermination(datos);
  const orientation = resolveOrientation(datos, det);
  const layoutCode = resolveLayoutCode(det, orientation);
  const colors = normalizeColors(datos);
  const talles = (Array.isArray(datos?.talles) ? datos.talles : []).map((t) => String(t || "").trim()).filter(Boolean);
  const brand = String(datos?.texto_escrito || datos?.marca || "COMPLETAR").trim() || "COMPLETAR";
  const logoHref = String(datos?.logo_base64 || "").trim();
  const ov = String(datos?.ov_name || datos?.ov || "COMPLETAR");
  const cliente = String(datos?.partner_name || datos?.cliente || "COMPLETAR");
  const wMm = Number(datos?.ancho_mm || 60) || 60;
  const hMm = Number(datos?.alto_mm || 20) || 20;

  const labelW = mmToPx(wMm);
  const labelH = mmToPx(hMm);
  const colorColW = mmToPx(28);
  const margin = 24;
  const variants = (colors.length >= 2 ? colors : [colors[0]]).slice(0, 4);
  const gap = mmToPx(8);
  const contentW = variants.length * labelW + (variants.length - 1) * gap;
  const pageWRaw = margin * 2 + colorColW + 16 + contentW + 20;
  const pageHRaw = margin * 2 + labelH + 160 + (talles.length ? 120 : 0);
  const maxW = 900;
  const maxH = 700;
  const scale = Math.min(1, maxW / pageWRaw, maxH / pageHRaw);
  const pageW = pageWRaw * scale;
  const pageH = pageHRaw * scale;

  const baseX = (margin + colorColW + 16) * scale;
  const baseY = margin * scale;
  const lW = labelW * scale;
  const lH = labelH * scale;
  const lGap = gap * scale;
  const colorX = margin * scale;
  const tallesY = (baseY + lH + 56) * scale;
  const miniW = 72 * scale;
  const miniH = 96 * scale;

  const muestras = colors
    .slice(0, 8)
    .map((c, i) => {
      const y = (baseY + i * 32 * scale);
      return `<rect x="${colorX}" y="${y}" width="${14 * scale}" height="${8 * scale}" fill="${c.hex}" stroke="#555" stroke-width="1"/>
<text x="${colorX}" y="${y + 20 * scale}" font-size="${8 * scale}" fill="#222">&gt; ${esc(c.nombre)}</text>`;
    })
    .join("");

  const labels = variants
    .map((c, i) => {
      const x = baseX + i * (lW + lGap);
      const fg = contrastText(c.hex);
      const main = renderMainLabelBlock(x, baseY, lW, lH, brand, talles[0] || "COMPLETAR", logoHref, c.hex, fg);
      const cotas =
        i === 0
          ? `<line x1="${x - 18 * scale}" y1="${baseY}" x2="${x - 18 * scale}" y2="${baseY + lH}" stroke="#cc0000" stroke-width="1" stroke-dasharray="4,3"/>
<text x="${x - 24 * scale}" y="${baseY + lH / 2}" transform="rotate(-90 ${x - 24 * scale} ${baseY + lH / 2})" font-size="${9 * scale}" fill="#cc0000">${esc(`${hMm} mm`)}</text>
<line x1="${x}" y1="${baseY + lH + 18 * scale}" x2="${x + lW}" y2="${baseY + lH + 18 * scale}" stroke="#cc0000" stroke-width="1" stroke-dasharray="4,3"/>
<text x="${x + lW / 2}" y="${baseY + lH + 12 * scale}" text-anchor="middle" font-size="${9 * scale}" fill="#cc0000">${esc(`${wMm} mm`)}</text>`
          : "";
      return `<g>${main}${cotas}</g>`;
    })
    .join("");

  const tallesBlock = talles
    .slice(0, 8)
    .map((t, i) => {
      const x = baseX + i * (miniW + 8 * scale);
      const bg = variants[0]?.hex || "#dddddd";
      const fg = contrastText(bg);
      return `<rect x="${x}" y="${tallesY}" width="${miniW}" height="${miniH}" fill="${bg}" stroke="#444" stroke-width="1"/>
<text x="${x + miniW / 2}" y="${tallesY + miniH / 2 + 8 * scale}" text-anchor="middle" font-size="${20 * scale}" font-weight="700" fill="${fg}">${esc(t)}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">
  <rect x="0" y="0" width="${pageW}" height="${pageH}" fill="#ffffff"/>
  <text x="${margin * scale}" y="${16 * scale}" font-size="${12 * scale}" font-weight="700">OV: ${esc(ov)} | Cliente: ${esc(cliente)}</text>
  <text x="${pageW - margin * scale}" y="${16 * scale}" text-anchor="end" font-size="${10 * scale}">Layout ${layoutCode} - ${esc(det.family)} - ${esc(det.term)}</text>
  ${muestras}
  ${labels}
  ${tallesBlock}
</svg>`;
}

module.exports = { buildPropuestaSVG, MM_TO_PX };
