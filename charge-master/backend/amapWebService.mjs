const AMAP_REST_BASE = "https://restapi.amap.com";

export function hasAmapWebServiceKey() {
  return Boolean(process.env.AMAP_WEB_SERVICE_KEY);
}

export async function geocode(address, city) {
  const data = await requestAmap("/v3/geocode/geo", {
    address,
    city,
    output: "JSON"
  });
  const first = data.geocodes?.[0];
  if (!first?.location) return null;

  return {
    name: first.formatted_address || address,
    location: parseLocation(first.location),
    raw: first
  };
}

export async function aroundSearch({ keyword, location, city, radius = 12000, offset = 20 }) {
  const data = await requestAmap("/v5/place/around", {
    keywords: keyword,
    location: formatLocation(location),
    city,
    radius,
    page_size: offset,
    page_num: 1,
    output: "JSON"
  });

  return (data.pois || []).map(normalizePoi);
}

export async function drivingRoute({ origin, destination }) {
  const data = await requestAmap("/v3/direction/driving", {
    origin: formatLocation(origin),
    destination: formatLocation(destination),
    strategy: 0,
    extensions: "base",
    output: "JSON"
  });

  const path = data.route?.paths?.[0];
  if (!path) return null;

  return {
    distance: Number(path.distance || 0),
    duration: Number(path.duration || 0),
    polyline: (path.steps || [])
      .flatMap((step) => String(step.polyline || "").split(";"))
      .filter(Boolean)
      .map(parseLocation)
  };
}

async function requestAmap(path, params) {
  if (!process.env.AMAP_WEB_SERVICE_KEY) {
    throw new Error("AMAP_WEB_SERVICE_KEY is not configured");
  }

  const url = new URL(path, AMAP_REST_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("key", process.env.AMAP_WEB_SERVICE_KEY);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`AMap Web Service request failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.status && data.status !== "1") {
    throw new Error(`AMap Web Service error: ${data.info || data.infocode || "unknown"}`);
  }
  return data;
}

function normalizePoi(poi) {
  const location = parseLocation(poi.location);
  return {
    id: poi.id,
    name: poi.name,
    address: poi.address || poi.pname || poi.cityname || "",
    position: location,
    distance: poi.distance ? Number(poi.distance) : null,
    tel: poi.tel || "",
    type: poi.type || "",
    source: "amap-web-service"
  };
}

function parseLocation(value) {
  if (Array.isArray(value)) return value.map(Number);
  const [lng, lat] = String(value).split(",").map(Number);
  return [lng, lat];
}

function formatLocation(value) {
  if (Array.isArray(value)) return value.join(",");
  if (value && Number.isFinite(Number(value.lng)) && Number.isFinite(Number(value.lat))) {
    return `${value.lng},${value.lat}`;
  }
  return value;
}
