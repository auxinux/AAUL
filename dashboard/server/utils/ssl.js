// Loads SSL certificates and builds HTTPS/HTTP servers. Supports Let's
// Encrypt, commercial certificates, and self-signed certificates.

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveCertPath(certPath) {
  if (!certPath) {
    return null;
  }
  if (path.isAbsolute(certPath)) {
    return certPath;
  }
  return path.join(__dirname, "..", certPath);
}

export function loadCertificates(sslConfig) {
  if (!sslConfig || !sslConfig.enabled) {
    return null;
  }

  const keyPath = resolveCertPath(sslConfig.keyPath);
  const certPath = resolveCertPath(sslConfig.certPath);
  const caPath = resolveCertPath(sslConfig.caPath);

  if (!keyPath || !certPath) {
    console.error("[SSL] Missing keyPath or certPath in configuration");
    return null;
  }

  if (!fs.existsSync(keyPath)) {
    console.error(`[SSL] Private key file not found: ${keyPath}`);
    return null;
  }

  if (!fs.existsSync(certPath)) {
    console.error(`[SSL] Certificate file not found: ${certPath}`);
    return null;
  }

  try {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    if (caPath && fs.existsSync(caPath)) {
      options.ca = fs.readFileSync(caPath);
    }

    if (sslConfig.rejectUnauthorized === false) {
      options.rejectUnauthorized = false;
    }

    console.log("[SSL] Certificates loaded successfully");
    return options;
  } catch (err) {
    console.error("[SSL] Failed to load certificates:", err.message);
    return null;
  }
}

export function createSecureServer(app, sslConfig) {
  const httpsOptions = loadCertificates(sslConfig);

  if (!httpsOptions) {
    console.log("[SSL] Falling back to HTTP server");
    return {
      server: http.createServer(app),
      type: "http",
      port: sslConfig?.httpPort || 3001
    };
  }

  const httpsServer = https.createServer(httpsOptions, app);

  return {
    server: httpsServer,
    type: "https",
    port: sslConfig.httpsPort || 443
  };
}

export function createRedirectServer(httpPort, httpsPort, host) {
  const redirectApp = (req, res) => {
    const targetHost = host === "0.0.0.0" ? req.headers.host?.split(":")[0] : host;
    const targetPort = httpsPort === 443 ? "" : `:${httpsPort}`;
    const redirectUrl = `https://${targetHost}${targetPort}${req.url}`;

    res.writeHead(301, { Location: redirectUrl });
    res.end();
  };

  return http.createServer(redirectApp);
}

// Watches the certificate file for changes so a Let's Encrypt renewal
// (or any cert rotation) can be picked up without restarting the process.
export function watchCertificates(sslConfig, onReload) {
  if (!sslConfig || !sslConfig.enabled) {
    return;
  }

  const certPath = resolveCertPath(sslConfig.certPath);
  if (!certPath || !fs.existsSync(certPath)) {
    return;
  }

  let debounceTimer = null;

  fs.watch(certPath, (eventType) => {
    if (eventType === "change") {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        console.log("[SSL] Certificate file changed, reloading...");
        const newOptions = loadCertificates(sslConfig);
        if (newOptions && typeof onReload === "function") {
          onReload(newOptions);
        }
      }, 1000);
    }
  });

  console.log("[SSL] Watching certificate files for changes");
}

export function getSelfSignedCommand(domain = "localhost", outputDir = "./server/ssl") {
  return `openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\
  -keyout ${outputDir}/server.key \\
  -out ${outputDir}/server.crt \\
  -subj "/C=CA/ST=Quebec/L=Montreal/O=AutoUpdateLinux/CN=${domain}"`;
}

export default {
  loadCertificates,
  createSecureServer,
  createRedirectServer,
  watchCertificates,
  getSelfSignedCommand
};
