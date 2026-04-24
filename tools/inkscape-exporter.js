const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch (_) {}
      reject(new Error(`Timeout ejecutando ${cmd}`));
    }, timeoutMs);
    p.stdout.on("data", (d) => {
      out += String(d || "");
    });
    p.stderr.on("data", (d) => {
      err += String(d || "");
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exit ${code}. ${err || out}`));
      resolve({ out, err });
    });
  });
}

async function verifyInkscape() {
  if (process.platform === "win32") {
    try {
      await runCommand("where", ["inkscape"], 10000);
      return "inkscape";
    } catch (_) {
      const fallback = "C:\\Program Files\\Inkscape\\bin\\inkscape.com";
      if (fs.existsSync(fallback)) return fallback;
      throw new Error("Inkscape no encontrado. Instalar desde inkscape.org");
    }
  }
  await runCommand("which", ["inkscape"], 10000);
  return "inkscape";
}

async function exportSVGtoPDF(svgString, outputPath) {
  const inkscapeCmd = await verifyInkscape();
  const tmpDir = path.join(os.tmpdir(), "asistente-facu-svg");
  fs.mkdirSync(tmpDir, { recursive: true });
  const uid = crypto.randomUUID();
  const tmpSvgPath = path.join(tmpDir, `${uid}.svg`);
  try {
    fs.writeFileSync(tmpSvgPath, String(svgString || ""), "utf8");
    await runCommand(inkscapeCmd, ["--export-type=pdf", `--export-filename=${outputPath}`, tmpSvgPath], 30000);
    if (!fs.existsSync(outputPath)) throw new Error("No se generó PDF de salida");
    const stat = fs.statSync(outputPath);
    if (!stat || stat.size <= 0) throw new Error("PDF generado sin contenido");
  } finally {
    try {
      fs.unlinkSync(tmpSvgPath);
    } catch (_) {}
  }
}

module.exports = { exportSVGtoPDF, verifyInkscape };
