const MM_TO_PX = 3.7795;

function mmToPx(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * MM_TO_PX;
}

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeHex(hex) {
  const v = String(hex || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return null;
}

function textContrast(hex) {
  const h = normalizeHex(hex) || "#1a1a1a";
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 140 ? "#ffffff" : "#000000";
}

function codeFromColorName(nombre) {
  const raw = String(nombre || "").trim();
  const m = raw.match(/(\d{2,6})\s*$/);
  return m ? m[1] : "COMPLETAR";
}

function buildBordadaSVG(datos) {
  const warnings = [];
  const anchoMm = Number(datos?.ancho_mm) > 0 ? Number(datos.ancho_mm) : null;
  const altoMm = Number(datos?.alto_mm) > 0 ? Number(datos.alto_mm) : null;
  const anchoPx = mmToPx(anchoMm || 60);
  const altoPx = mmToPx(altoMm || 20);
  if (!anchoMm) warnings.push("ancho_mm faltante");
  if (!altoMm) warnings.push("alto_mm faltante");

  const coloresIn = Array.isArray(datos?.colores) ? datos.colores : [];
  const colores = coloresIn.length
    ? coloresIn.map((c) => ({
        nombre: String(c?.nombre || "").trim() || "COMPLETAR",
        hex: normalizeHex(c?.hex) || "#1a1a1a"
      }))
    : [{ nombre: "COMPLETAR", hex: "#1a1a1a" }];
  if (!coloresIn.length) warnings.push("colores faltantes");

  const talles = Array.isArray(datos?.talles) ? datos.talles : [];
  const safeTalles = talles.length
    ? talles.map((t) => ({
        talle: String(t?.talle || "").trim() || "COMPLETAR",
        metros: String(t?.metros ?? "").trim() || "COMPLETAR"
      }))
    : [{ talle: "COMPLETAR", metros: "COMPLETAR" }];
  if (!talles.length) warnings.push("talles faltantes");

  const logoDataUri = String(datos?.logo_base64 || "").trim();
  const tipografia = String(datos?.tipografia || "").trim() || "Arial";
  const textoEscrito = String(datos?.texto_escrito || "").trim() || "COMPLETAR";
  if (!String(datos?.texto_escrito || "").trim()) warnings.push("texto_escrito faltante");

  const colorPrincipal = colores[0].hex;
  const txtColor = textContrast(colorPrincipal);
  const variantes = colores.length >= 2 ? colores : [colores[0]];
  const gapPx = mmToPx(10);
  const colLeftW = mmToPx(30);
  const topMargin = 24;
  const leftMargin = 24;
  const etiquetasW = variantes.length * anchoPx + (variantes.length - 1) * gapPx;
  const tallesGap = 12;
  const miniW = 80;
  const miniH = 100;
  const tallesBlockH = miniH + 28;
  const totalW = leftMargin + colLeftW + 24 + etiquetasW + 32;
  const totalH = topMargin + Math.max(altoPx, safeTalles.length ? tallesBlockH + 24 : 0) + tallesBlockH + 36;

  const baseX = leftMargin + colLeftW + 24;
  const baseY = topMargin;

  const muestras = colores
    .map((c, i) => {
      const y = baseY + i * (mmToPx(8) + 18);
      const nombre = c.nombre || "COMPLETAR";
      const codigo = codeFromColorName(nombre);
      return `
      <rect x="${leftMargin}" y="${y}" width="${mmToPx(15)}" height="${mmToPx(8)}" fill="${c.hex}" stroke="#444" stroke-width="1"/>
      <text x="${leftMargin}" y="${y + mmToPx(8) + 10}" font-size="8" fill="#111">&gt; ${esc(nombre)} ${esc(codigo)}</text>`;
    })
    .join("");

  const etiquetas = variantes
    .map((c, idx) => {
      const x = baseX + idx * (anchoPx + gapPx);
      const y = baseY;
      const fg = textContrast(c.hex);
      const logoBlock = logoDataUri
        ? `<image href="${esc(logoDataUri)}" x="${x + anchoPx * 0.1}" y="${y + altoPx * 0.03}" width="${anchoPx * 0.8}" height="${altoPx * 0.55}" preserveAspectRatio="xMidYMid meet"/>`
        : `<text x="${x + anchoPx / 2}" y="${y + altoPx * 0.28}" text-anchor="middle" font-size="${Math.max(10, anchoPx * 0.08)}" fill="#ff0000">COMPLETAR</text>`;
      const marcaTxt = textoEscrito || "COMPLETAR";
      const talleTxt = safeTalles[0]?.talle || "COMPLETAR";
      const cotas =
        idx === 0
          ? `
        <line x1="${x - 18}" y1="${y}" x2="${x - 18}" y2="${y + altoPx}" stroke="#cc0000" stroke-width="1" stroke-dasharray="4,3"/>
        <text x="${x - 24}" y="${y + altoPx / 2}" transform="rotate(-90 ${x - 24} ${y + altoPx / 2})" fill="#cc0000" font-size="9">${esc(altoMm != null ? `${altoMm} mm` : "COMPLETAR")}</text>
        <line x1="${x}" y1="${y + altoPx + 18}" x2="${x + anchoPx}" y2="${y + altoPx + 18}" stroke="#cc0000" stroke-width="1" stroke-dasharray="4,3"/>
        <text x="${x + anchoPx / 2}" y="${y + altoPx + 14}" text-anchor="middle" fill="#cc0000" font-size="9">${esc(
              anchoMm != null ? `${anchoMm} mm` : "COMPLETAR"
            )}</text>`
          : "";
      return `
      <g>
        <rect x="${x}" y="${y}" width="${anchoPx}" height="${altoPx}" fill="${c.hex}" stroke="#444" stroke-width="1.2"/>
        <line x1="${x}" y1="${y + altoPx / 2}" x2="${x + anchoPx}" y2="${y + altoPx / 2}" stroke="#cc0000" stroke-width="1" stroke-dasharray="4,3"/>
        ${logoBlock}
        <text x="${x + anchoPx / 2}" y="${y + altoPx * 0.72}" text-anchor="middle" font-family="${esc(
          tipografia
        )}" font-size="${Math.max(11, altoPx * 0.12)}" font-weight="700" fill="${fg}">${esc(marcaTxt)}</text>
        <text x="${x + anchoPx * 0.92}" y="${y + altoPx * 0.94}" text-anchor="end" font-family="${esc(
          tipografia
        )}" font-size="${Math.max(14, altoPx * 0.22)}" font-weight="700" fill="${fg}">${esc(talleTxt)}</text>
        ${cotas}
      </g>`;
    })
    .join("");

  const tallesY = baseY + altoPx + 56;
  const tallesSvg = safeTalles
    .map((t, i) => {
      const x = baseX + i * (miniW + tallesGap);
      return `
      <g>
        <rect x="${x}" y="${tallesY}" width="${miniW}" height="${miniH}" fill="${colorPrincipal}" stroke="#444" stroke-width="1"/>
        <text x="${x + miniW / 2}" y="${tallesY + miniH / 2 + 8}" text-anchor="middle" font-size="26" font-weight="700" fill="${txtColor}">${esc(
          t.talle || "COMPLETAR"
        )}</text>
        <text x="${x + miniW / 2}" y="${tallesY + miniH + 16}" text-anchor="middle" font-size="9" fill="#111">${esc(
          t.metros || "COMPLETAR"
        )} mts</text>
      </g>`;
    })
    .join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
  <rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#fff"/>
  <text x="${leftMargin}" y="16" font-size="12" font-weight="700">OV: ${esc(datos?.ov_name || "COMPLETAR")}</text>
  <text x="${leftMargin + 220}" y="16" font-size="12">Cliente: ${esc(datos?.partner_name || "COMPLETAR")}</text>
  ${muestras}
  ${etiquetas}
  ${tallesSvg}
</svg>`;

  return { svg, warnings };
}

module.exports = { buildBordadaSVG };
