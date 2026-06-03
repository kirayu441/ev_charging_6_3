import { buildAmapSkillPlan } from "./amapSkill.mjs";
import { aroundSearch, geocode, hasAmapWebServiceKey } from "./amapWebService.mjs";
import { inferChargingIntent, inferPersonalPreference } from "./llm.mjs";

export async function planChargingQuery(payload = {}) {
  const intent = await inferChargingIntent(payload);
  const personalProfile = await inferPersonalPreference(payload);
  const skill = buildAmapSkillPlan(intent, payload);
  const execution = await executeAmapSkill(intent, skill, payload);
  const personalized = buildPersonalizedStations(execution, personalProfile);

  return {
    reply: intent.reply,
    plan: {
      intent: intent.intent,
      keyword: intent.keyword,
      chargerType: intent.chargerType,
      parkingRequired: intent.parkingRequired,
      amenity: intent.amenity,
      destination: intent.destination,
      batteryLevel: intent.batteryLevel,
      sortBy: intent.sortBy,
      radius: intent.radius
    },
    skill,
    execution: personalized.execution,
    personalProfile,
    personalScoreBreakdown: personalized.breakdown,
    diagnostics: {
      llmSource: intent.llmFallback ? "fallback" : "llm",
      personalSource: personalProfile.source,
      hasLlmKey: Boolean(process.env.LLM_API_KEY),
      model: process.env.LLM_MODEL || "gpt-4.1-mini"
    }
  };
}

async function executeAmapSkill(intent, skill, payload) {
  if (!hasAmapWebServiceKey()) {
    return {
      mode: "client-jsapi-fallback",
      reason: "AMAP_WEB_SERVICE_KEY is not configured"
    };
  }

  const city = payload.city || "南京";
  let center = skill.search.location;
  let destination = null;

  if (intent.destination) {
    destination = await geocode(intent.destination, city);
    if (destination?.location) center = destination.location;
  }

  if (!center) {
    return {
      mode: "client-jsapi-fallback",
      reason: "No search center available",
      destination
    };
  }

  const pois = await aroundSearch({
    keyword: skill.search.keyword,
    location: center,
    city,
    radius: skill.search.radius
  });

  return {
    mode: "amap-web-service",
    destination,
    searchCenter: center,
    pois
  };
}

function buildPersonalizedStations(execution, profile) {
  if (execution?.mode !== "amap-web-service" || !Array.isArray(execution.pois)) {
    return { execution, breakdown: [] };
  }

  const breakdown = [];
  const scored = execution.pois.map((poi) => {
    const text = `${poi.name || ""} ${poi.address || ""} ${poi.type || ""}`;
    let preferenceBonus = 0;
    const matched = [];
    for (const tag of profile.tags || []) {
      if (text.includes(tag)) {
        preferenceBonus += 12;
        matched.push(tag);
      }
    }
    const distanceMeters = Number(poi.distance || 0);
    const costPenalty = Math.min(12, Math.round(distanceMeters / 1800));
    const queuePenalty = Math.min(16, Math.round(distanceMeters / 2200));
    const distancePenalty = Math.min(14, Math.round(distanceMeters / 1400));

    const score =
      60 +
      preferenceBonus * profile.weights.convenience -
      costPenalty * profile.weights.cost -
      queuePenalty * profile.weights.queue -
      distancePenalty * profile.weights.proximity;

    const finalScore = Number(Math.max(0, Math.min(100, score)).toFixed(2));
    breakdown.push({
      stationId: poi.id || poi.name,
      stationName: poi.name || "未命名充电站",
      matchedTags: matched,
      preferenceBonus: Number((preferenceBonus * profile.weights.convenience).toFixed(2)),
      costPenalty: Number((costPenalty * profile.weights.cost).toFixed(2)),
      queuePenalty: Number((queuePenalty * profile.weights.queue).toFixed(2)),
      distancePenalty: Number((distancePenalty * profile.weights.proximity).toFixed(2)),
      finalScore
    });

    return { ...poi, personalScore: finalScore, personalMatchedTags: matched };
  });

  scored.sort((a, b) => (b.personalScore || 0) - (a.personalScore || 0));

  return {
    execution: { ...execution, pois: scored },
    breakdown
  };
}
