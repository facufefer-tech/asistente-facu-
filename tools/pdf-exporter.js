const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

function run(cmd, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch (_) {}
      reject(new Error(`Timeout ejecutando ${cmd}`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (stdout += String(d || "")));
    p.stderr.on("data", (d) => (stderr += String(d || "")));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exit ${code}. ${stderr || stdout}`));
      resolve({ stdout, stderr });
    });
  });
}

async function resolveInkscapeCommand() {
  if (process.platform === "win32") {
    try {
      await run("where", ["inkscape"], 10000);
      return "inkscape";
    } catch (_) {
      const fallback = "C:\\Program Files\\Inkscape\\bin\\inkscape.com";
      if (fs.existsSync(fallback)) return fallback;
      return null;
    }
  }
  try {
    await run("which", ["inkscape"], 10000);
    return "inkscape";
  } catch (_) {
    return null;
  }
}

function writeBasicPdfWithPng(pngBuffer, outPath, widthPx, heightPx) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    doc.addPage({ size: [widthPx, heightPx], margin: 0 });
    doc.image(pngBuffer, 0, 0, { width: widthPx, height: heightPx });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function exportWithFallback(svgPath, outputPath) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    throw new Error(`Fallback requiere sharp instalado: ${e.message}`);
  }
  try {
    require("pdfkit");
  } catch (e) {
    throw new Error(`Fallback requiere pdfkit instalado: ${e.message}`);
  }
  const pngBuffer = await sharp(svgPath, { density: 300 }).png().toBuffer();
  const meta = await sharp(pngBuffer).metadata();
  const w = meta.width || 1000;
  const h = meta.height || 700;
  await writeBasicPdfWithPng(pngBuffer, outputPath, w, h);
}

async function exportSVGtoPDF(svgString, outputPath) {
  const tmpDir = path.join(os.tmpdir(), "asistente-facu-svg-export");
  fs.mkdirSync(tmpDir, { recursive: true });
  const uid = crypto.randomUUID();
  const tmpSvgPath = path.join(tmpDir, `${uid}.svg`);
  fs.writeFileSync(tmpSvgPath, String(svgString || ""), "utf8");
  try {
    const inkscape = await resolveInkscapeCommand();
    if (inkscape) {
      await run(inkscape, ["--export-type=pdf", `--export-filename=${outputPath}`, tmpSvgPath], 60000);
    } else {
      await exportWithFallback(tmpSvgPath, outputPath);
    }
    if (!fs.existsSync(outputPath)) throw new Error("No se generó el PDF");
    const st = fs.statSync(outputPath);
    if (!st.size) throw new Error("PDF vacío");
  } catch (e) {
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (_) {}
    }
    throw e;
  } finally {
    try {
      fs.unlinkSync(tmpSvgPath);
    } catch (_) {}
  }
}

module.exports = { exportSVGtoPDF, resolveInkscapeCommand };
