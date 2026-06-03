export function buildAmapSkillPlan(intent, payload = {}) {
  const location = normalizeLocation(payload.location);

  return {
    provider: "amap-lbs-skill",
    mode: process.env.AMAP_SKILL_MODE || "jsapi",
    search: {
      tool: "aroundSearch",
      keyword: intent.keyword,
      location,
      city: payload.city || "南京",
      radius: intent.radius,
      sortBy: intent.sortBy
    },
    route: {
      tool: "drivingRoute",
      origin: location,
      destination: null,
      strategy: intent.batteryLevel !== null && intent.batteryLevel <= 15 ? "least_time" : "balanced"
    }
  };
}

function normalizeLocation(location) {
  if (Array.isArray(location)) return location;
  if (location && Number.isFinite(Number(location.lng)) && Number.isFinite(Number(location.lat))) {
    return [Number(location.lng), Number(location.lat)];
  }
  return null;
}
