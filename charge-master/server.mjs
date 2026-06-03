import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { drivingRoute } from "./backend/amapWebService.mjs";
import { planChargingQuery } from "./backend/assistant.mjs";
import { loadEnv } from "./backend/env.mjs";
import { getUserByToken, loginUser, logoutUser, registerUser } from "./backend/auth.mjs";

loadEnv();

const root = resolve(".");
const port = Number(process.env.PORT || 5173);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/assistant/plan") {
    try {
      const payload = await readJson(req);
      sendJson(res, 200, await planChargingQuery(payload));
    } catch (error) {
      sendJson(res, 500, { error: "Assistant plan failed", detail: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const payload = await readJson(req);
      const user = registerUser(payload.username, payload.password);
      sendJson(res, 200, { user });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Register failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const payload = await readJson(req);
      const result = loginUser(payload.username, payload.password);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 401, { error: error.message || "Login failed" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    try {
      const payload = await readJson(req);
      logoutUser(payload.token);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: "Logout failed", detail: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const token = readBearerToken(req.headers.authorization);
    const user = getUserByToken(token);
    sendJson(res, 200, { user });
    return;
  }

  if (req.method === "GET" && url.pathname === "/config.js") {
    sendClientConfig(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/amap/route") {
    try {
      const payload = await readJson(req);
      sendJson(res, 200, { route: await drivingRoute(payload) });
    } catch (error) {
      sendJson(res, 500, { error: "AMap route failed", detail: error.message });
    }
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(root, requested));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`Charging map is running at http://127.0.0.1:${port}`);
});

function readJson(req) {
  return new Promise((resolveJson, rejectJson) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        rejectJson(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolveJson(body ? JSON.parse(body) : {});
      } catch (error) {
        rejectJson(error);
      }
    });
    req.on("error", rejectJson);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendClientConfig(res) {
  const config = {
    amapKey: process.env.AMAP_JS_API_KEY || "",
    amapSecurityJsCode: process.env.AMAP_SECURITY_JS_CODE || "",
    defaultCity: normalizeCity(process.env.DEFAULT_CITY || "Nanjing"),
    defaultCenter: parseCenter(process.env.DEFAULT_CENTER) || [118.796877, 32.060255],
    defaultZoom: Number(process.env.DEFAULT_ZOOM || 12)
  };

  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
  res.end(`window.CHONGDIAN_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
}

function parseCenter(value) {
  if (!value) return null;
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts;
}

function normalizeCity(value) {
  if (value === "Nanjing") return "南京";
  return value;
}

function readBearerToken(authorization) {
  if (!authorization) return "";
  const [scheme, token] = String(authorization).split(" ");
  if (scheme !== "Bearer") return "";
  return token || "";
}
