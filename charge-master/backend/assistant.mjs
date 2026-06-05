import { buildAmapSkillPlan } from "./amapSkill.mjs";
import { aroundSearch, geocode, hasAmapWebServiceKey } from "./amapWebService.mjs";
import { inferChargingIntent, inferPersonalPreference } from "./llm.mjs";

const OPERATION_MODES = {
  rush_pickup: {
    label: "高峰接单模式",
    scene: "早晚高峰",
    focus: "减少充电和排队时间，优先接单热区",
    weights: { distance: 1.15, queue: 1.45, cost: 0.65, safety: 0.8, order: 1.35, power: 1.25 }
  },
  midday_recharge: {
    label: "午间补能模式",
    scene: "中午低峰",
    focus: "推荐低价、少排队、适合短休息的站点",
    weights: { distance: 0.9, queue: 1.15, cost: 1.35, safety: 0.9, order: 0.75, power: 0.9 }
  },
  night_saver: {
    label: "夜间低价模式",
    scene: "晚上/凌晨",
    focus: "推荐低价、24小时和安全站点",
    weights: { distance: 0.85, queue: 0.75, cost: 1.55, safety: 1.45, order: 0.55, power: 0.75 }
  },
  low_battery: {
    label: "低电量应急模式",
    scene: "电量低于15%",
    focus: "最近、最快、可达性最高",
    weights: { distance: 1.75, queue: 1.15, cost: 0.35, safety: 0.85, order: 0.45, power: 1.55 }
  },
  transit_hub: {
    label: "机场高铁站模式",
    scene: "长距离订单后",
    focus: "结合返程接单机会推荐",
    weights: { distance: 1.0, queue: 1.0, cost: 0.75, safety: 1.0, order: 1.75, power: 1.0 }
  }
};

export async function planChargingQuery(payload = {}) {
  const intent = await inferChargingIntent(payload);
  const personalProfile = await inferPersonalPreference(payload);
  const operationProfile = buildOperationProfile(payload);
  const batteryRisk = buildBatteryRisk(payload);
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
    operationProfile,
    batteryRisk,
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

function buildOperationProfile(payload = {}) {
  const selected = payload.operationMode || "auto";
  const battery = Number(payload.batteryLevel ?? payload.plan?.batteryLevel ?? 30);
  const hour = Number.isFinite(Number(payload.hour)) ? Number(payload.hour) : new Date().getHours();
  const prompt = String(payload.message || payload.personalPreference || "");
  const manualMode = selected !== "auto" ? selected : "";
  const mode = manualMode || inferOperationMode({ battery, hour, prompt });
  const base = OPERATION_MODES[mode] || OPERATION_MODES.rush_pickup;

  return {
    key: mode,
    label: base.label,
    scene: base.scene,
    focus: base.focus,
    weights: base.weights,
    reason: manualMode ? `已手动切换为${base.label}：${base.focus}` : buildAutoModeReason(mode, { battery, hour }),
    source: manualMode ? "manual" : "auto"
  };
}

function buildBatteryRisk(payload = {}) {
  const battery = Number(payload.batteryLevel ?? payload.plan?.batteryLevel ?? 30);
  const prompt = String(payload.message || payload.personalPreference || "");
  const isTransitOrder = /机场|高铁|火车站|动车|长途|跨城|远距离|返程/.test(prompt);

  if (!Number.isFinite(battery) || battery <= 0) {
    return {
      level: "unknown",
      label: "待评估",
      title: "请输入当前电量",
      text: "系统会根据电量判断是否适合继续接单。",
      actions: ["补充电量后再评估"],
      shouldEnterEmergency: false,
      orderAdvice: "等待电量输入"
    };
  }

  if (battery < 15) {
    return {
      level: "danger",
      label: "高风险",
      title: `当前电量仅剩 ${battery}%`,
      text: "建议优先补能，不建议继续接跨区或长距离订单。系统会优先推荐 3 个可快速到达的快充站。",
      actions: ["先补能", "只接短途单", "避开机场高铁站"],
      shouldEnterEmergency: true,
      orderAdvice: "不建议继续接跨区或长距离订单"
    };
  }

  if (battery < 25) {
    return {
      level: "warn",
      label: "中风险",
      title: `当前电量 ${battery}%`,
      text: isTransitOrder ? "检测到远距离或交通枢纽订单意图，建议先补能后再接单。" : "可以短时间继续运营，但建议只接短途单，并预留到站补能距离。",
      actions: isTransitOrder ? ["先补能", "避开长距离订单"] : ["只接短途单", "顺路补能"],
      shouldEnterEmergency: false,
      orderAdvice: isTransitOrder ? "建议先补能后再接远距离订单" : "建议只接短途单"
    };
  }

  if (battery < 40) {
    return {
      level: "notice",
      label: "可运营",
      title: `当前电量 ${battery}%`,
      text: "可以继续接单，建议优先选择顺路订单，并关注附近可补能站点。",
      actions: ["正常接单", "保留补能备选"],
      shouldEnterEmergency: false,
      orderAdvice: "适合继续接短中途订单"
    };
  }

  return {
    level: "safe",
    label: "低风险",
    title: `当前电量 ${battery}%`,
    text: "电量较充足，可以正常接单。系统仍会结合排队和费用给出补能建议。",
    actions: ["正常接单"],
    shouldEnterEmergency: false,
    orderAdvice: "适合正常接单"
  };
}

function inferOperationMode({ battery, hour, prompt }) {
  if (Number.isFinite(battery) && battery < 15) return "low_battery";
  if (/机场|高铁|火车站|动车|长途|返程|跨城/.test(prompt)) return "transit_hub";
  if (hour >= 20 || hour < 6) return "night_saver";
  if (hour >= 11 && hour < 14) return "midday_recharge";
  if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)) return "rush_pickup";
  return "midday_recharge";
}

function buildAutoModeReason(mode, { battery, hour }) {
  if (mode === "low_battery") return `已自动进入低电量应急模式：当前电量 ${battery || 0}% ，优先保障可达性。`;
  if (mode === "transit_hub") return "已自动进入机场高铁站模式：订单场景包含交通枢纽或长距离返程。";
  if (mode === "night_saver") return `已自动进入夜间低价模式：当前 ${hour}:00 左右，优先低价与安全站点。`;
  if (mode === "midday_recharge") return `已自动进入午间补能模式：当前 ${hour}:00 左右，适合低峰补电。`;
  return `已自动进入高峰接单模式：当前 ${hour}:00 左右，优先少排队和接单热区。`;
}
