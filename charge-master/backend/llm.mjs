const DEFAULT_INTENT = {
  intent: "find_charging_station",
  keyword: "充电站",
  chargerType: "any",
  parkingRequired: false,
  amenity: null,
  destination: null,
  batteryLevel: null,
  sortBy: "balanced",
  radius: 12000
};

export async function inferChargingIntent(payload = {}) {
  if (!process.env.LLM_API_KEY) {
    return fallbackIntent(payload.message);
  }

  try {
    const response = await fetch(`${process.env.LLM_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "gpt-4.1-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "你是充电桩出行规划助手，只输出 JSON。",
              "根据用户中文输入识别找桩意图，并转换成高德 LBS 可执行参数。",
              "JSON 字段：intent, keyword, chargerType, parkingRequired, amenity, destination, batteryLevel, sortBy, radius, reply。",
              "keyword 用于高德周边搜索，例如：充电站、快充充电站、停车场 充电站、商场 充电站。",
              "radius 单位米，常用 8000/12000/18000。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              message: payload.message || "",
              city: payload.city || "",
              location: payload.location || null,
              visibleStations: payload.visibleStations || []
            })
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return normalizeIntent(JSON.parse(content));
  } catch (error) {
    return {
      ...fallbackIntent(payload.message),
      llmFallback: true
    };
  }
}

export async function inferPersonalPreference(payload = {}) {
  const rawText = String(payload.personalPreference || payload.message || "").trim();
  const fallback = fallbackPersonalPreference(rawText, payload.personalTags || []);
  if (!rawText) return fallback;
  if (!process.env.LLM_API_KEY) return fallback;

  try {
    const response = await fetch(`${process.env.LLM_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "gpt-4.1-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "你是出行偏好解析器，只输出 JSON。",
              "将用户偏好解析为：must(必需), prefer(偏好), avoid(规避), tags(关键词), weights(对象: convenience/cost/queue/proximity)。",
              "weights 各字段取值范围 0-1。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({ personalPreference: rawText, personalTags: payload.personalTags || [] })
          }
        ],
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return normalizePersonalPreference({ ...fallback, ...JSON.parse(content), source: "llm" });
  } catch {
    return { ...fallback, source: "fallback" };
  }
}

export function fallbackIntent(message = "") {
  const text = String(message || "");
  const batteryLevel = parseBatteryLevel(text);
  const destination = parseDestination(text);
  const intent = { ...DEFAULT_INTENT, batteryLevel, destination };

  if (/快充|快速|急|赶时间|高速/.test(text)) {
    intent.keyword = "快充充电站";
    intent.chargerType = "fast";
    intent.sortBy = "distance";
  } else if (/停车|停车场|好停车|地下车库/.test(text)) {
    intent.keyword = "停车场 充电站";
    intent.parkingRequired = true;
  } else if (/商场|购物|吃饭|餐厅|美食/.test(text)) {
    intent.keyword = "商场 充电站";
    intent.amenity = "mall";
  } else if (/医院|看病|门诊/.test(text)) {
    intent.keyword = "医院 充电站";
    intent.amenity = "hospital";
  } else if (/酒店|住宿|宾馆/.test(text)) {
    intent.keyword = "酒店 充电站";
    intent.amenity = "hotel";
  }

  if (batteryLevel !== null && batteryLevel <= 15) {
    intent.radius = 18000;
    intent.sortBy = "distance";
  }

  return normalizeIntent(intent);
}

function parseDestination(text) {
  const patterns = [
    /(?:去|到|前往|在)(.+?)(?:附近|周边|旁边|边上).*(?:充电|充电桩|充电站)/,
    /(.+?)(?:附近|周边|旁边|边上).*(?:充电|充电桩|充电站)/,
    /(?:去|到|前往)(.+?)(?:找|查|看).*(?:充电|充电桩|充电站)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].replace(/[，。,.！!？?\s]/g, "").trim() || null;
    }
  }
  return null;
}

function normalizeIntent(intent = {}) {
  const merged = { ...DEFAULT_INTENT, ...intent };
  merged.intent = merged.intent || DEFAULT_INTENT.intent;
  merged.keyword = merged.keyword || DEFAULT_INTENT.keyword;
  merged.chargerType = merged.chargerType || "any";
  merged.parkingRequired = Boolean(merged.parkingRequired);
  merged.batteryLevel = clampBattery(merged.batteryLevel);
  merged.radius = Number.isFinite(Number(merged.radius)) ? Number(merged.radius) : DEFAULT_INTENT.radius;
  merged.sortBy = merged.sortBy || "balanced";
  merged.reply = merged.reply || buildReply(merged);
  return merged;
}

function parseBatteryLevel(text) {
  const match = text.match(/(\d{1,3})\s*%/);
  if (!match) return null;
  return clampBattery(Number(match[1]));
}

function clampBattery(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function buildReply(intent) {
  if (intent.batteryLevel !== null && intent.batteryLevel <= 15) {
    return "电量偏低，我会优先推荐距离近的充电站，并扩大搜索范围。";
  }
  if (intent.chargerType === "fast") return "我会优先查找附近快充站，并按距离推荐。";
  if (intent.parkingRequired) return "我会优先查找带停车场场景的充电站。";
  if (intent.destination) return `我会结合目的地“${intent.destination}”推荐合适的充电站。`;
  return "我会根据你的位置查找附近合适的充电站。";
}

function fallbackPersonalPreference(text = "", tags = []) {
  const inferredTags = [...tags];
  if (/吃饭|餐厅|美食|咖啡|奶茶/.test(text)) inferredTags.push("餐饮便利");
  if (/健身|锻炼|运动|跑步|瑜伽/.test(text)) inferredTags.push("运动健身");
  if (/商场|逛街|购物|超市/.test(text)) inferredTags.push("商圈购物");
  if (/安静|休息|散步|公园/.test(text)) inferredTags.push("休闲环境");

  return normalizePersonalPreference({
    must: [],
    prefer: inferredTags,
    avoid: [],
    tags: [...new Set(inferredTags)].slice(0, 6),
    weights: { convenience: 0.4, cost: 0.2, queue: 0.25, proximity: 0.15 },
    source: "fallback"
  });
}

function normalizePersonalPreference(profile = {}) {
  const weights = profile.weights || {};
  return {
    must: Array.isArray(profile.must) ? profile.must.slice(0, 6) : [],
    prefer: Array.isArray(profile.prefer) ? profile.prefer.slice(0, 6) : [],
    avoid: Array.isArray(profile.avoid) ? profile.avoid.slice(0, 6) : [],
    tags: Array.isArray(profile.tags) ? profile.tags.slice(0, 8) : [],
    weights: {
      convenience: clamp01(Number(weights.convenience ?? 0.4)),
      cost: clamp01(Number(weights.cost ?? 0.2)),
      queue: clamp01(Number(weights.queue ?? 0.25)),
      proximity: clamp01(Number(weights.proximity ?? 0.15))
    },
    source: profile.source || "fallback"
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
