# Asistente Facu — Avíos Textiles

Variables de entorno requeridas:

- ODOO_URL
- ODOO_DB
- ODOO_USERNAME
- ODOO_API_KEY
- GROQ_API_KEY
- GOOGLE_VISION_API_KEY

## Deploy en Fly.io

- **Dockerfile** y **fly.toml** en la raíz; región `gru` (São Paulo), puerto 3000, Chromium embebido para Puppeteer.
- Instalar CLI: en PowerShell, `iwr https://fly.io/install.ps1 -useb | iex` (añadir `~\.fly\bin` al PATH).
- Iniciar sesión: `fly auth login` (se abre el navegador; completar el mail de verificación).
- Crear app sin desplegar aún: `fly launch --no-deploy --name asistente-facu` (si el nombre está tomado, usar `asistente-facu-avtx` y el mismo nombre en `fly.toml` → `app = "..."`).
- Secretos (mismos valores que en `.env` local), sustituir comillas y caracteres seguros:  
  `fly secrets set ODOO_URL="..." ODOO_DB="..." ODOO_USERNAME="..." ODOO_API_KEY="..." GROQ_API_KEY="..." GOOGLE_VISION_API_KEY="..."`
- Desplegar: `fly deploy`
- Comprobar: `fly status`, `fly logs` y en el navegador `https://<nombre-app>.fly.dev/`
