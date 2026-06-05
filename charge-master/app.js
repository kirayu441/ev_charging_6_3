(function () {
  const config = window.CHONGDIAN_CONFIG || {};
  const DEFAULT_CITY = "Nanjing";
  const DEFAULT_KEYWORD = "充电站";
  const SEARCH_RADIUS = 12000;
  const STORAGE_KEY_PREFIX = "charge_ai_profile_v1";
  const AUTH_TOKEN_KEY = "charge_auth_token_v1";

  let map;
  let placeSearch;
  let geolocation;
  let driving;
  let stationMarkers = [];
  let top5Markers = [];
  let nearbyPreferenceMarkers = [];
  let nearbyPreferenceInfoWindow = null;
  let top5MapVisible = false;
  let currentStations = [];
  let rawStations = [];
  let userLocation;
  let lastSearchCenter;
  let activeKeyword = DEFAULT_KEYWORD;
  let currentPlan = { intent: "find_charging_station", sortBy: "distance" };
  let selectedPlanType = "fast";
  let selectedOperationMode = "auto";
  let activeOperationProfile = null;
  let activeBatteryRisk = null;
  let selectedStationIndex = 0;
  let planTopPick = { fast: null, cheap: null, queue: null };
  let personalTags = [];
  let backendPersonalProfile = null;
  let backendPersonalScoreMap = new Map();
  let backendPersonalTagMap = new Map();
  let currentUser = null;
  let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || "";
  let lastAssistantPrompt = "";

  const $ = (id) => document.getElementById(id);
  const statusPill = $("statusPill");
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

  function setStatus(text) {
    if (statusPill) statusPill.textContent = text;
  }

  function buildOperationProfile(input = {}) {
    const battery = Number(input.battery ?? $("batteryInput")?.value ?? 30);
    const prompt = String(input.prompt ?? lastAssistantPrompt ?? $("searchInput")?.value ?? "");
    const hour = Number.isFinite(Number(input.hour)) ? Number(input.hour) : new Date().getHours();
    const selected = input.mode || selectedOperationMode || "auto";
    const manualMode = selected !== "auto" ? selected : "";
    const inferredMode = manualMode || inferOperationMode({ battery, prompt, hour });
    const base = OPERATION_MODES[inferredMode] || OPERATION_MODES.rush_pickup;
    const reason = manualMode
      ? `已手动切换为${base.label}：${base.focus}`
      : buildAutoModeReason(inferredMode, { battery, prompt, hour });

    return {
      key: inferredMode,
      label: base.label,
      scene: base.scene,
      focus: base.focus,
      weights: base.weights,
      reason,
      source: manualMode ? "manual" : "auto"
    };
  }

  function inferOperationMode({ battery, prompt, hour }) {
    const text = String(prompt || "");
    if (Number.isFinite(battery) && battery < 15) return "low_battery";
    if (/机场|高铁|火车站|动车|长途|返程|跨城/.test(text)) return "transit_hub";
    if (hour >= 20 || hour < 6) return "night_saver";
    if (hour >= 11 && hour < 14) return "midday_recharge";
    if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)) return "rush_pickup";
    return "midday_recharge";
  }

  function buildAutoModeReason(mode, { battery, prompt, hour }) {
    if (mode === "low_battery") return `已自动进入低电量应急模式：当前电量 ${battery || 0}% ，优先保障可达性。`;
    if (mode === "transit_hub") return "已自动进入机场高铁站模式：订单场景包含交通枢纽或长距离返程。";
    if (mode === "night_saver") return `已自动进入夜间低价模式：当前 ${hour}:00 左右，优先低价与安全站点。`;
    if (mode === "midday_recharge") return `已自动进入午间补能模式：当前 ${hour}:00 左右，适合低峰补电。`;
    return `已自动进入高峰接单模式：当前 ${hour}:00 左右，优先少排队和接单热区。`;
  }

  function renderOperationMode(profile = activeOperationProfile) {
    const mode = profile || buildOperationProfile();
    activeOperationProfile = mode;
    const reasonNode = $("operationModeReason");
    const tagsNode = $("operationModeTags");
    const dashMode = $("dashMode");
    if (reasonNode) reasonNode.textContent = mode.reason;
    if (dashMode) dashMode.textContent = mode.label;
    if (tagsNode) {
      tagsNode.innerHTML = [
        mode.label,
        mode.scene,
        mode.focus,
        mode.source === "auto" ? "自动识别" : "手动指定"
      ].map((text) => `<span>${text}</span>`).join("");
    }
    syncOperationModeCards(mode);
    return mode;
  }

  function syncOperationModeCards(mode = activeOperationProfile) {
    const selectValue = $("operationModeSelect")?.value || "auto";
    const activeMode = selectValue === "auto" ? "auto" : mode?.key || selectValue;
    document.querySelectorAll("#operationModeCards button[data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === activeMode);
    });
  }

  function buildBatteryRisk(input = {}) {
    const battery = Number(input.battery ?? $("batteryInput")?.value ?? 30);
    const prompt = String(input.prompt ?? lastAssistantPrompt ?? $("searchInput")?.value ?? "");
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
        text: isTransitOrder
          ? "检测到远距离或交通枢纽订单意图，建议先补能后再接单。"
          : "可以短时间继续运营，但建议只接短途单，并预留到站补能距离。",
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

  function renderBatteryRisk(risk = activeBatteryRisk) {
    const next = risk || buildBatteryRisk();
    activeBatteryRisk = next;
    const card = $("batteryRiskCard");
    const level = $("batteryRiskLevel");
    const title = $("batteryRiskTitle");
    const text = $("batteryRiskText");
    const actions = $("batteryRiskActions");
    if (!card || !level || !title || !text || !actions) return next;

    card.className = `battery-risk-card ${next.level}`;
    level.textContent = next.label;
    title.textContent = next.title;
    text.textContent = next.text;
    actions.innerHTML = next.actions.map((item) => `<button type="button" data-risk-action="${item}">${item}</button>`).join("");
    const dashBattery = $("dashBattery");
    const dashAdvice = $("dashAdvice");
    if (dashBattery) dashBattery.textContent = `${Number($("batteryInput")?.value || 30)}%`;
    if (dashAdvice) dashAdvice.textContent = next.orderAdvice;
    return next;
  }

  function readCostSettings() {
    return {
      hourlyIncome: Number($("incomeInput")?.value || 80),
      detourCostPerKm: Number($("detourCostInput")?.value || 1.5),
      targetKwh: estimateTargetKwh()
    };
  }

  function estimateTargetKwh() {
    const battery = Number($("batteryInput")?.value || 30);
    const targetBattery = battery < 15 ? 55 : battery < 25 ? 50 : 45;
    const batteryGap = Math.max(10, targetBattery - battery);
    const assumedPackKwh = 60;
    return Number((assumedPackKwh * batteryGap / 100).toFixed(1));
  }

  function estimateStationUnitPrice(station, detourKm, queueMinutes) {
    const hour = new Date().getHours();
    let base = hour >= 20 || hour < 6 ? 0.95 : hour >= 11 && hour < 14 ? 1.05 : 1.28;
    const text = `${station.name || ""} ${station.address || ""} ${station.type || ""}`;
    if (/商场|广场|中心|CBD|酒店/.test(text)) base += 0.12;
    if (/停车场|服务区|园区/.test(text)) base -= 0.06;
    if (queueMinutes <= 6) base += 0.04;
    if (detourKm <= 2) base += 0.03;
    return Number(Math.max(0.75, Math.min(1.8, base)).toFixed(2));
  }

  function buildOperationCost(station, queueMinutes, detourKm) {
    const settings = readCostSettings();
    const unitPrice = estimateStationUnitPrice(station, detourKm, queueMinutes);
    const chargingFee = unitPrice * settings.targetKwh;
    const queueTimeCost = queueMinutes / 60 * settings.hourlyIncome;
    const detourCost = detourKm * settings.detourCostPerKm;
    const chargingMinutes = Math.max(8, Math.round(settings.targetKwh / 1.8));
    const opportunityLoss = (queueMinutes + chargingMinutes) / 60 * settings.hourlyIncome * 0.65;
    const total = chargingFee + queueTimeCost + detourCost + opportunityLoss;

    return {
      total: Number(total.toFixed(1)),
      chargingFee: Number(chargingFee.toFixed(1)),
      queueTimeCost: Number(queueTimeCost.toFixed(1)),
      detourCost: Number(detourCost.toFixed(1)),
      opportunityLoss: Number(opportunityLoss.toFixed(1)),
      unitPrice,
      targetKwh: settings.targetKwh,
      chargingMinutes
    };
  }

  function applyBatteryRiskAction(action) {
    const battery = Number($("batteryInput").value || 30);
    const promptByAction = {
      "先补能": "当前电量偏低，先找最近可快速到达的快充站",
      "只接短途单": "当前电量偏低，建议只接短途单，并找顺路快充备选",
      "避开机场高铁站": "当前电量偏低，避开机场高铁站等远距离区域，找附近快充",
      "避开长距离订单": "当前电量不足，避开长距离订单，找附近可补能站点",
      "顺路补能": "继续接短途单，同时推荐顺路可补能站点",
      "正常接单": "当前电量允许正常接单，推荐兼顾效率和排队的补能备选",
      "保留补能备选": "当前可以继续接单，请保留附近可快速补能的备选站点",
      "补充电量后再评估": "请先补充电量，推荐最近可达快充站"
    };
    const prompt = promptByAction[action] || action;

    if (["先补能", "避开机场高铁站", "避开长距离订单", "补充电量后再评估"].includes(action)) {
      const modeSelect = $("operationModeSelect");
      if (modeSelect) {
        modeSelect.value = "low_battery";
        selectedOperationMode = "low_battery";
      }
      activeOperationProfile = renderOperationMode(buildOperationProfile({
        mode: "low_battery",
        battery,
        prompt
      }));
      selectedPlanType = "fast";
      if ($("goalSelect")) $("goalSelect").value = "fast";
      buildPlanCards();
    } else if (action === "顺路补能" || action === "保留补能备选") {
      selectedPlanType = "personal";
      if ($("goalSelect")) $("goalSelect").value = "personal";
      buildPlanCards();
    }

    $("searchInput").value = prompt;
    activeBatteryRisk = renderBatteryRisk(buildBatteryRisk({ battery, prompt }));
    rerankBySelectedPlan();
    runAssistantPlan(prompt);
  }

  function operationSignals(station, distance, queue, detour, cost) {
    const text = `${station.name || ""} ${station.address || ""} ${station.type || ""}`;
    const safeHits = ["24小时", "商场", "广场", "酒店", "停车场", "服务区", "大厦"].filter((kw) => text.includes(kw)).length;
    const orderHits = ["机场", "高铁", "火车", "车站", "商圈", "广场", "医院", "学校", "大学", "CBD", "中心"].filter((kw) => text.includes(kw)).length;
    const distanceScore = Math.max(0, 24 - (distance || 2500) / 260);
    const queueScore = Math.max(0, 24 - queue * 0.9);
    const costScore = Math.max(0, 22 - cost);
    const safetyScore = 8 + safeHits * 5;
    const orderScore = 6 + orderHits * 6;
    const powerScore = Math.max(4, 18 - detour * 0.7);
    return { distanceScore, queueScore, costScore, safetyScore, orderScore, powerScore, safeHits, orderHits };
  }

  function getDefaultCenter() {
    return config.defaultCenter || [118.796877, 32.060255];
  }

  function toLngLat(position) {
    if (!position) return getDefaultCenter();
    if (Array.isArray(position)) return position;
    if (typeof position.getLng === "function") return [position.getLng(), position.getLat()];
    return [position.lng, position.lat];
  }

  function readProfile() {
    const key = getProfileStorageKey();
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  }

  function writeProfile(patch) {
    const key = getProfileStorageKey();
    const next = { ...readProfile(), ...patch };
    localStorage.setItem(key, JSON.stringify(next));
    renderMeCenter();
  }

  function pushHistory(text) {
    const key = getProfileStorageKey();
    const profile = readProfile();
    const history = Array.isArray(profile.history) ? profile.history : [];
    history.unshift({ text, time: new Date().toISOString() });
    profile.history = history.slice(0, 20);
    localStorage.setItem(key, JSON.stringify(profile));
    renderMeCenter();
  }

  function getProfileStorageKey() {
    if (currentUser?.id) return `${STORAGE_KEY_PREFIX}_${currentUser.id}`;
    return `${STORAGE_KEY_PREFIX}_guest`;
  }

  function renderMeCenter() {
    const p = readProfile();
    const prefText = `目标: ${p.goal || "最快到站"} | 运营模式: ${p.operationModeLabel || "自动识别"} | 接单建议: ${p.orderAdvice || "待评估"} | 电量: ${p.battery || 30}% | 绕路: ${p.detour || 8}km | 功率: ${p.power || 120}kW | 机会收入: ${p.hourlyIncome || 80}元/h`;
    $("prefView").textContent = prefText;
    const list = $("historyList");
    const history = Array.isArray(p.history) ? p.history : [];
    list.innerHTML = history.length
      ? history.map((h) => `<li>${h.text}<small> (${new Date(h.time).toLocaleString()})</small></li>`).join("")
      : "<li>暂无记录</li>";

    const authStatus = $("authStatus");
    if (authStatus) {
      authStatus.textContent = currentUser ? `当前：已登录 ${currentUser.username}` : "当前：匿名模式";
    }
  }

  async function authRequest(path, body, method = "POST") {
    const headers = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const response = await fetch(path, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  async function loadCurrentUser() {
    if (!authToken) {
      currentUser = null;
      renderMeCenter();
      return;
    }
    try {
      const data = await authRequest("/api/auth/me", null, "GET");
      currentUser = data.user || null;
      if (!currentUser) {
        authToken = "";
        localStorage.removeItem(AUTH_TOKEN_KEY);
      }
    } catch {
      currentUser = null;
      authToken = "";
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
    renderMeCenter();
  }

  function bindTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((n) => n.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((n) => n.classList.remove("active"));
        btn.classList.add("active");
        $(`tab-${btn.dataset.tab}`).classList.add("active");
      });
    });
  }

  function loadAmap() {
    if (!config.amapKey) {
      setStatus("请配置高德 AMAP_JS_API_KEY");
      return;
    }
    if (config.amapSecurityJsCode) {
      window._AMapSecurityConfig = { securityJsCode: config.amapSecurityJsCode };
    }
    const plugins = ["AMap.PlaceSearch", "AMap.Geolocation", "AMap.Driving", "AMap.GeometryUtil"].join(",");
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.amapKey)}&plugin=${plugins}`;
    script.onload = initMap;
    script.onerror = () => setStatus("高德地图加载失败");
    document.head.appendChild(script);
  }

  function initMap() {
    $("mapFallback").style.display = "none";
    map = new AMap.Map("map", {
      viewMode: "2D",
      zoom: config.defaultZoom || 12,
      center: getDefaultCenter(),
      mapStyle: "amap://styles/normal"
    });

    placeSearch = new AMap.PlaceSearch({ city: config.defaultCity || DEFAULT_CITY, pageSize: 20, extensions: "all" });
    geolocation = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 7000, zoomToAccuracy: true });
    driving = new AMap.Driving({ map, hideMarkers: false, policy: AMap.DrivingPolicy.LEAST_TIME });

    locateAndSearch(true);
  }

  function clearStationMarkers() {
    stationMarkers.forEach((m) => m.setMap(null));
    stationMarkers = [];
  }

  function clearTop5Markers() {
    top5Markers.forEach((m) => m.setMap(null));
    top5Markers = [];
  }

  function clearNearbyPreferenceMarkers() {
    nearbyPreferenceMarkers.forEach((m) => m.setMap(null));
    nearbyPreferenceMarkers = [];
    if (nearbyPreferenceInfoWindow) nearbyPreferenceInfoWindow.close();
  }

  function inferPreferenceKeywords() {
    const keywords = [];
    const profileTags = Array.isArray(backendPersonalProfile?.tags) ? backendPersonalProfile.tags : [];
    const sourceText = `${lastAssistantPrompt} ${profileTags.join(" ")} ${personalTags.join(" ")}`.toLowerCase();
    const pushKeyword = (kw) => {
      if (!keywords.includes(kw)) keywords.push(kw);
    };

    if (sourceText.includes("吃饭") || sourceText.includes("餐厅") || sourceText.includes("美食")) pushKeyword("餐厅");
    if (sourceText.includes("咖啡")) pushKeyword("咖啡厅");
    if (sourceText.includes("健身") || sourceText.includes("运动")) pushKeyword("健身房");
    if (sourceText.includes("商场") || sourceText.includes("购物")) pushKeyword("商场");
    if (sourceText.includes("休息")) pushKeyword("便利店");
    if (!keywords.length) pushKeyword("餐厅");
    return keywords;
  }

  function showNearbyPreferenceSpots(station) {
    if (!station || !placeSearch || !map || !window.AMap || !AMap.GeometryUtil) return;
    const preferenceKeywords = inferPreferenceKeywords();
    const keyword = preferenceKeywords[0];
    const radius = 1800;
    clearNearbyPreferenceMarkers();

    placeSearch.searchNearBy(keyword, station.position, radius, (status, result) => {
      const pois = result && result.poiList && result.poiList.pois ? result.poiList.pois : [];
      if (status !== "complete" || !pois.length) {
        setStatus(`已选中 ${station.name}，附近未找到“${keyword}”推荐点`);
        return;
      }

      nearbyPreferenceInfoWindow = nearbyPreferenceInfoWindow || new AMap.InfoWindow({ offset: new AMap.Pixel(0, -24) });
      nearbyPreferenceMarkers = pois
        .filter((poi) => poi.location)
        .slice(0, 6)
        .map((poi) => {
          const poiPos = toLngLat(poi.location);
          const dist = Math.round(AMap.GeometryUtil.distance(station.position, poiPos));
          const walkMinutes = Math.max(1, Math.round(dist / 75));
          const rawRating = poi.biz_ext?.rating || poi.rating;
          const ratingNum = Number(rawRating);
          const ratingText = Number.isFinite(ratingNum) && ratingNum > 0 ? `${ratingNum.toFixed(1)} / 5` : "暂无";
          const marker = new AMap.Marker({
            position: poiPos,
            title: poi.name || keyword,
            content: '<div class="nearby-pref-marker"></div>',
            offset: new AMap.Pixel(-10, -10),
            zIndex: 135
          });
          marker.on("mouseover", () => {
            nearbyPreferenceInfoWindow.setContent(
              `<strong>${poi.name || keyword}</strong><br>评分: ${ratingText}<br>距充电站: ${formatDistance(dist)}<br>预计步行: ${walkMinutes} 分钟`
            );
            nearbyPreferenceInfoWindow.open(map, poiPos);
          });
          marker.on("mouseout", () => nearbyPreferenceInfoWindow && nearbyPreferenceInfoWindow.close());
          marker.setMap(map);
          return marker;
        });

      setStatus(`已为 ${station.name} 高亮周边“${keyword}”推荐点（悬停可看距离和预计时间）`);
    });
  }

  function renderTop5Markers() {
    if (!map || !window.AMap) return;
    clearTop5Markers();
    const top = currentStations.slice(0, 5);
    const usedPositions = [];
    top5Markers = top.map((station, idx) => {
      const offsetPos = getDeoverlappedPosition(station.position, usedPositions, idx);
      usedPositions.push(offsetPos);
      const marker = new AMap.Marker({
        position: offsetPos,
        title: `TOP${idx + 1} ${station.name}`,
        content: `<div class="top5-badge-marker">${idx + 1}</div>`,
        offset: new AMap.Pixel(-19, -19),
        zIndex: 130
      });
      marker.on("click", () => focusStation(station));
      marker.setMap(map);
      return marker;
    });
  }

  function getDeoverlappedPosition(position, usedPositions, idx) {
    if (!window.AMap || !AMap.GeometryUtil || !position) return position;
    const base = Array.isArray(position) ? position : [position.lng, position.lat];
    const closeThreshold = 180;
    const isTooClose = usedPositions.some((p) => AMap.GeometryUtil.distance(base, p) < closeThreshold);
    if (!isTooClose) return base;

    // Nearby markers are shifted in a larger radial pattern to avoid overlap.
    const ring = [
      [0, 0.00042],
      [0.00036, 0.00024],
      [0.00036, -0.00024],
      [0, -0.00042],
      [-0.00036, -0.00024],
      [-0.00036, 0.00024],
      [0.00052, 0],
      [-0.00052, 0]
    ];

    for (let i = 0; i < ring.length; i++) {
      const step = ring[(idx + i) % ring.length];
      const candidate = [base[0] + step[0], base[1] + step[1]];
      const ok = usedPositions.every((p) => AMap.GeometryUtil.distance(candidate, p) >= closeThreshold);
      if (ok) return candidate;
    }
    return [base[0] + ring[idx % ring.length][0], base[1] + ring[idx % ring.length][1]];
  }

  function syncTop5MapLayer() {
    if (top5MapVisible) renderTop5Markers();
    else clearTop5Markers();

    const btn = $("toggleTopMapButton");
    if (btn) btn.classList.toggle("active", top5MapVisible);
  }

  function normalizePoi(poi) {
    const position = toLngLat(poi.location || poi.position);
    return {
      id: poi.id || `${poi.name}-${position.join(",")}`,
      name: poi.name || "未命名充电站",
      address: poi.address || poi.district || "暂无地址",
      position,
      distance: poi.distance ? Number(poi.distance) : null,
      type: poi.type || "充电站",
      tel: poi.tel || ""
    };
  }

  function updateAiFacts(result, goalText) {
    const plan = result?.plan || {};
    const operationProfile = result?.operationProfile || activeOperationProfile || buildOperationProfile();
    if (result?.operationProfile) renderOperationMode(result.operationProfile);
    const batteryRisk = result?.batteryRisk || activeBatteryRisk || buildBatteryRisk();
    if (result?.batteryRisk) renderBatteryRisk(result.batteryRisk);
    const battery = Number($("batteryInput").value || 30);
    const detour = Number($("detourInput").value || 8);
    const power = Number($("powerInput").value || 120);
    const costSettings = readCostSettings();
    const hasLLM = Boolean(result?.diagnostics?.usedLLM);
    const intentText = plan.intent === "find_charging_station" ? "找附近更合适的充电站" : "按你的描述做补能推荐";
    const profile = backendPersonalProfile || {};
    const explainTags = profile.tags?.length ? profile.tags.join("、") : "等待后端 AI 识别";
    const facts = [
      `你这次的主要需求是：${goalText}，系统理解为“${intentText}”。`,
      `当前司机运营模式：${operationProfile.label}。${operationProfile.reason || operationProfile.focus}`,
      `低电量接单风险：${batteryRisk.label}。${batteryRisk.orderAdvice}。${batteryRisk.text}`,
      `已按你的条件筛选：当前电量 ${battery}% 、可绕路约 ${detour}km、优先功率不低于 ${power}kW。`,
      `接单机会成本计算：综合运营成本 = 充电费用 + 排队时间成本 + 绕路成本 + 接单机会损失；本次按每小时机会收入 ${costSettings.hourlyIncome} 元、每公里绕路成本 ${costSettings.detourCostPerKm} 元估算。`,
      `个性化偏好关键词：${explainTags}。`,
      "排序时会先估算你到每个站要多快能到，再比较绕路和费用压力，最后用排队时长做风险修正：同等条件下，优先推荐到得更快、绕路更少、排队更短的站点。",
      profile.source === "llm" ? "个性化推荐由后端 AI 偏好解析驱动。" : "个性化推荐当前由规则兜底驱动。",
      hasLLM
        ? "本次结果由大模型结合地图数据生成，解释性更强。"
        : "本次结果由规则策略结合地图数据生成，可继续追问优化。"
    ];
    $("aiFacts").innerHTML = facts.map((f) => `<li>${f}</li>`).join("");
  }

  function buildPlanCards() {
    const plans = [
      { key: "fast", title: "A 最快", desc: "优先到站时间", hint: "适合低电量紧急补能" },
      { key: "cheap", title: "B 最省", desc: "优先费用和绕路", hint: "适合日常通勤补电" },
      { key: "queue", title: "C 最稳", desc: "优先低排队风险", hint: "适合高峰时段" },
      { key: "personal", title: "D 个性化", desc: "结合你的偏好场景", hint: personalTags.length ? `AI识别偏好：${personalTags.join("、")}` : "输入偏好后由 AI 自动识别关键词" }
    ];
    $("planCards").innerHTML = plans
      .map(
        (p) => `
      <article class="plan-card ${selectedPlanType === p.key ? "active" : ""}" data-plan="${p.key}">
        <strong>${p.title}</strong>
        <small>${p.desc}</small>
        <p>${p.hint}</p>
        <button type="button" data-plan="${p.key}">选择该线路</button>
      </article>
    `
      )
      .join("");
    wirePlanCardActions();
    syncRoutePlanUi();
  }

  function wirePlanCardActions() {
    $("planCards").querySelectorAll("[data-plan]").forEach((node) => {
      node.addEventListener("click", () => {
        const next = node.dataset.plan;
        applySelectedPlan(next, true);
      });
    });
  }

  function applySelectedPlan(planType, fromFindTab) {
    selectedPlanType = planType;
    if ($("goalSelect").querySelector(`option[value='${planType}']`)) $("goalSelect").value = planType;
    buildPlanCards();
    syncRoutePlanUi();
    rerankBySelectedPlan();
    if (fromFindTab) {
      setStatus(`已切换到${planLabel(planType)}线路`);
    }
  }

  function planLabel(planType) {
    if (planType === "cheap") return "B 最省";
    if (planType === "queue") return "C 最稳";
    if (planType === "personal") return "D 个性化";
    return "A 最快";
  }

  function syncRoutePlanUi() {
    document.querySelectorAll(".route-mode").forEach((node) => {
      node.classList.toggle("active", node.dataset.plan === selectedPlanType);
    });
    const title = $("routeTitle");
    const desc = $("routeDesc");
    if (!title || !desc) return;
    if (selectedPlanType === "cheap") {
      title.textContent = "当前线路：B 最省";
      desc.textContent = "优先费用和绕路，适合通勤补电。";
    } else if (selectedPlanType === "queue") {
      title.textContent = "当前线路：C 最稳";
      desc.textContent = "优先低排队风险，适合高峰时段。";
    } else if (selectedPlanType === "personal") {
      title.textContent = "当前线路：D 个性化";
      desc.textContent = personalTags.length ? `结合你的偏好：${personalTags.join("、")}。` : "结合你的个性化偏好关键词。";
    } else {
      title.textContent = "当前线路：A 最快";
      desc.textContent = "优先到站时间，适合低电量补能。";
    }

    const routeHintNode = $("routeHint");
    if (routeHintNode) {
      const station = currentStations[selectedStationIndex];
      routeHintNode.textContent = station
        ? `当前推荐站：${station.name}，预计排队 ${station.queueMinutes} 分钟。`
        : "等待生成站点后显示推荐线路。";
    }
  }

  function withRecommendation(station) {
    const distance = Number.isFinite(station.userDistance) ? station.userDistance : station.distance;
    const goal = selectedPlanType;
    let score = 45;
    const reasons = [];

    if (Number.isFinite(distance)) {
      if (distance < 1500) { score += 22; reasons.push("距离较近"); }
      else if (distance < 4000) { score += 12; reasons.push("距离适中"); }
      else { score += 4; reasons.push("距离偏远"); }
    }

    const mockQueue = Math.max(2, Math.min(30, Math.round((distance || 2500) / 320 + (new Date().getHours() % 6) * 2)));
    const mockDetourKm = Math.max(1, Math.round((distance || 2000) / 700));
    const mockCost = Math.max(8, Math.round(12 + mockDetourKm * 1.6 + mockQueue * 0.2));
    const operationCost = buildOperationCost(station, mockQueue, mockDetourKm);
    score += Math.max(-12, 18 - operationCost.total / 5);
    const operationProfile = activeOperationProfile || renderOperationMode();
    const operationWeight = operationProfile.weights || OPERATION_MODES.rush_pickup.weights;
    const signals = operationSignals(station, distance, mockQueue, mockDetourKm, mockCost);
    const operationScore =
      signals.distanceScore * operationWeight.distance +
      signals.queueScore * operationWeight.queue +
      signals.costScore * operationWeight.cost +
      signals.safetyScore * operationWeight.safety +
      signals.orderScore * operationWeight.order +
      signals.powerScore * operationWeight.power;
    score += operationScore * 0.18;
    reasons.push(operationProfile.label);
    if (signals.orderHits > 0) reasons.push("靠近潜在接单区域");
    if (signals.safeHits > 0) reasons.push("站点环境更稳定");
    const textBlob = `${station.name} ${station.address} ${station.type}`;
    if (goal === "queue") {
      score += Math.max(0, 30 - mockQueue * 1.3);
      score -= mockDetourKm * 0.6;
      reasons.push(`预计排队 ${mockQueue} 分钟`);
      reasons.push(`绕路约 ${mockDetourKm}km`);
    }
    if (goal === "cheap") {
      score += Math.max(0, 36 - mockCost);
      score += Math.max(-10, 24 - operationCost.total / 3.8);
      score += Math.max(0, 12 - mockDetourKm);
      score -= mockQueue * 0.2;
      reasons.push(`综合运营成本约 ${operationCost.total}元`);
      reasons.push(`绕路约 ${mockDetourKm}km`);
    }
    if (goal === "fast") {
      score += Math.max(0, 26 - mockDetourKm * 1.8);
      score += Math.max(0, 18 - mockQueue * 0.7);
      reasons.push(`到站优先，绕路约 ${mockDetourKm}km`);
      reasons.push(`预计排队 ${mockQueue} 分钟`);
    }
    if (goal === "personal") {
      const stationId = station.id || station.name;
      const backendScore = backendPersonalScoreMap.get(stationId);
      const backendTags = backendPersonalTagMap.get(stationId) || [];
      if (Number.isFinite(backendScore)) {
        score = backendScore;
        if (backendTags.length) reasons.push(`后端个性化命中：${backendTags.join("、")}`);
        else reasons.push("后端个性化评分已生效");
      } else {
        score += Math.max(0, 14 - mockQueue * 0.5);
        reasons.push("等待后端 AI 个性化评分，当前先按基础策略展示");
      }
    }

    return {
      ...station,
      queueMinutes: mockQueue,
      detourKm: mockDetourKm,
      costIndex: mockCost,
      operationCost,
      operationMode: operationProfile.label,
      recommendation: { score: Number(Math.min(99, score).toFixed(2)), reasons }
    };
  }

  function rerankBySelectedPlan() {
    if (!rawStations.length) return;
    clearNearbyPreferenceMarkers();
    currentStations = rawStations.map(withUserDistance).map(withRecommendation).sort((a, b) => b.recommendation.score - a.recommendation.score);
    const fixedTopId = planTopPick[selectedPlanType];
    if (fixedTopId) {
      const idx = currentStations.findIndex((s) => s.id === fixedTopId);
      if (idx > 0) {
        const [picked] = currentStations.splice(idx, 1);
        currentStations.unshift(picked);
      }
    }
    renderStationList(currentStations);
    clearStationMarkers();
    stationMarkers = currentStations.map((station) => {
      const marker = new AMap.Marker({
        position: station.position,
        title: station.name,
        content: '<div class="charge-marker"><span>电</span></div>',
        offset: new AMap.Pixel(-17, -34)
      });
      marker.on("click", () => focusStation(station));
      marker.setMap(map);
      return marker;
    });
    syncTop5MapLayer();
  }

  function renderStationList(items) {
    const stationList = $("stationList");
    stationList.classList.remove("expanded");
    $("stationList").innerHTML = items.length
      ? items.map((station, index) => {
          const distanceValue = Number.isFinite(station.userDistance) ? station.userDistance : station.distance;
          const distance = distanceValue ? formatDistance(distanceValue) : "附近";
          return `
            <div class="station-item" data-index="${index}">
              <div class="station-top">
                <span class="station-rank">TOP ${index + 1}</span>
                <span class="station-cost">运营成本约 <strong>${station.operationCost?.total ?? "--"}元</strong></span>
              </div>
              <div class="station-main">
                <strong>${station.name}</strong>
                <small>${station.address}</small>
              </div>
              <div class="station-meta">
                <span>推荐度 ${station.recommendation.score.toFixed(2)}</span>
                <span>${distance}</span>
                <span>排队 ${station.queueMinutes}min</span>
                <span>绕路 ${station.detourKm}km</span>
                <span>${station.operationMode || activeOperationProfile?.label || "运营模式"}</span>
              </div>
              ${station.operationCost ? `
                <div class="cost-breakdown">
                  <span><small>充电费</small>${station.operationCost.chargingFee}元</span>
                  <span><small>排队损失</small>${station.operationCost.queueTimeCost}元</span>
                  <span><small>绕路成本</small>${station.operationCost.detourCost}元</span>
                  <span><small>机会损失</small>${station.operationCost.opportunityLoss}元</span>
                </div>
              ` : ""}
              <div class="station-actions">
                <button class="nav-station" data-index="${index}" type="button">导航</button>
                <button class="detail-station" data-index="${index}" type="button">详情</button>
                <button class="reserve-station" data-index="${index}" type="button">设为备选</button>
              </div>
            </div>
          `;
        }).join("")
      : "<div class='station-item'>暂无站点，请尝试其他条件</div>";

    const showMoreStationsButton = $("showMoreStationsButton");
    if (showMoreStationsButton) {
      showMoreStationsButton.classList.toggle("hidden", items.length <= 3);
      showMoreStationsButton.textContent = "查看全部候选站点";
    }

    document.querySelectorAll(".station-item").forEach((n) => {
      n.addEventListener("click", () => {
        selectedStationIndex = Number(n.dataset.index);
        focusStation(items[selectedStationIndex]);
        syncRoutePlanUi();
      });
    });
    document.querySelectorAll(".nav-station").forEach((n) => {
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        openNavigation(items[Number(n.dataset.index)]);
      });
    });
    document.querySelectorAll(".detail-station").forEach((n) => {
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        openStationDetail(items[Number(n.dataset.index)]);
      });
    });
    document.querySelectorAll(".reserve-station").forEach((n) => {
      n.addEventListener("click", (e) => {
        e.stopPropagation();
        const station = items[Number(n.dataset.index)];
        if (!station) return;
        selectedStationIndex = Number(n.dataset.index);
        focusStation(station);
        setStatus(`已将 ${station.name} 设为补能备选`);
      });
    });

    updateExplore(items);
    updateTime();
    selectedStationIndex = 0;
    syncRoutePlanUi();
  }

  function openStationDetail(station) {
    if (!station) return;
    const modal = $("stationDetailModal");
    const title = $("stationDetailTitle");
    const body = $("stationDetailBody");
    if (!modal || !title || !body) return;
    title.textContent = station.name;
    const cost = station.operationCost;
    const reasons = station.recommendation?.reasons || [];
    body.innerHTML = `
      <div class="detail-summary">
        <strong>运营成本约 ${cost?.total ?? "--"} 元</strong>
        <span>推荐度 ${station.recommendation?.score?.toFixed?.(2) || "--"} · 排队 ${station.queueMinutes || "--"}min · 绕路 ${station.detourKm || "--"}km</span>
      </div>
      <div class="detail-address">${station.address || "暂无地址"}</div>
      ${cost ? `
        <div class="detail-cost-grid">
          <div><span>充电费用</span><strong>${cost.chargingFee}元</strong></div>
          <div><span>排队时间成本</span><strong>${cost.queueTimeCost}元</strong></div>
          <div><span>绕路成本</span><strong>${cost.detourCost}元</strong></div>
          <div><span>接单机会损失</span><strong>${cost.opportunityLoss}元</strong></div>
        </div>
      ` : ""}
      <div class="detail-reasons">
        <h3>推荐原因</h3>
        <ul>${reasons.map((reason) => `<li>${reason}</li>`).join("") || "<li>系统正在等待更多站点数据。</li>"}</ul>
      </div>
      <div class="detail-actions">
        <button type="button" id="detailNavigateButton">导航前往</button>
        <button type="button" id="detailReserveButton" class="ghost-action">设为备选</button>
      </div>
    `;
    modal.classList.remove("hidden");
    $("detailNavigateButton")?.addEventListener("click", () => openNavigation(station));
    $("detailReserveButton")?.addEventListener("click", () => {
      setStatus(`已将 ${station.name} 设为补能备选`);
      focusStation(station);
    });
  }

  function renderStations(stations) {
    rawStations = stations.slice();
    clearNearbyPreferenceMarkers();
    currentStations = rawStations.map(withUserDistance).map(withRecommendation).sort((a, b) => b.recommendation.score - a.recommendation.score);
    buildPlanTopPick();
    const fixedTopId = planTopPick[selectedPlanType];
    if (fixedTopId) {
      const idx = currentStations.findIndex((s) => s.id === fixedTopId);
      if (idx > 0) {
        const [picked] = currentStations.splice(idx, 1);
        currentStations.unshift(picked);
      }
    }
    clearStationMarkers();

    stationMarkers = currentStations.map((station) => {
      const marker = new AMap.Marker({
        position: station.position,
        title: station.name,
        content: '<div class="charge-marker"><span>电</span></div>',
        offset: new AMap.Pixel(-17, -34)
      });
      marker.on("click", () => focusStation(station));
      marker.setMap(map);
      return marker;
    });

    if (stationMarkers.length) map.setFitView(stationMarkers, false, [100, 80, 80, 460]);
    renderStationList(currentStations);
    syncTop5MapLayer();
  }

  function buildPlanTopPick() {
    const byFast = rawStations
      .map(withUserDistance)
      .map((s) => ({ ...s, _fast: scoreByPlan(s, "fast") }))
      .sort((a, b) => b._fast - a._fast);
    const byCheap = rawStations
      .map(withUserDistance)
      .map((s) => ({ ...s, _cheap: scoreByPlan(s, "cheap") }))
      .sort((a, b) => b._cheap - a._cheap);
    const byQueue = rawStations
      .map(withUserDistance)
      .map((s) => ({ ...s, _queue: scoreByPlan(s, "queue") }))
      .sort((a, b) => b._queue - a._queue);
    const byPersonal = rawStations
      .map(withUserDistance)
      .map((s) => ({ ...s, _personal: scoreByPlan(s, "personal") }))
      .sort((a, b) => b._personal - a._personal);

    const pickFast = byFast[0]?.id || null;
    const pickCheap = byCheap.find((s) => s.id !== pickFast)?.id || byCheap[0]?.id || null;
    const pickQueue = byQueue.find((s) => s.id !== pickFast && s.id !== pickCheap)?.id || byQueue[0]?.id || null;
    const pickPersonal = byPersonal.find((s) => s.id !== pickFast && s.id !== pickCheap && s.id !== pickQueue)?.id || byPersonal[0]?.id || null;

    planTopPick = { fast: pickFast, cheap: pickCheap, queue: pickQueue, personal: pickPersonal };
  }

  function scoreByPlan(station, planType) {
    const distance = Number.isFinite(station.userDistance) ? station.userDistance : station.distance || 2500;
    const queue = Math.max(2, Math.min(30, Math.round(distance / 320 + (new Date().getHours() % 6) * 2)));
    const detour = Math.max(1, Math.round(distance / 700));
    const cost = Math.max(8, Math.round(12 + detour * 1.6 + queue * 0.2));
    const operationCost = buildOperationCost(station, queue, detour);
    const operationProfile = activeOperationProfile || buildOperationProfile();
    const operationWeight = operationProfile.weights || OPERATION_MODES.rush_pickup.weights;
    const signals = operationSignals(station, distance, queue, detour, cost);
    let score = 45;
    if (distance < 1500) score += 22;
    else if (distance < 4000) score += 12;
    else score += 4;
    score += Math.max(-12, 18 - operationCost.total / 5);

    score +=
      (signals.distanceScore * operationWeight.distance +
        signals.queueScore * operationWeight.queue +
        signals.costScore * operationWeight.cost +
        signals.safetyScore * operationWeight.safety +
        signals.orderScore * operationWeight.order +
        signals.powerScore * operationWeight.power) * 0.18;

    if (planType === "fast") {
      score += Math.max(0, 26 - detour * 1.8);
      score += Math.max(0, 18 - queue * 0.7);
    } else if (planType === "cheap") {
      score += Math.max(0, 36 - cost);
      score += Math.max(-10, 24 - operationCost.total / 3.8);
      score += Math.max(0, 12 - detour);
      score -= queue * 0.2;
    } else {
      score += Math.max(0, 30 - queue * 1.3);
      score -= detour * 0.6;
    }
    if (planType === "personal") {
      const backendScore = backendPersonalScoreMap.get(station.id || station.name);
      if (Number.isFinite(backendScore)) return backendScore;
      score += Math.max(0, 14 - queue * 0.5);
    }
    return score;
  }

  function withUserDistance(station) {
    if (!userLocation || !window.AMap || !station.position) return station;
    return { ...station, userDistance: Math.round(AMap.GeometryUtil.distance(userLocation, station.position)) };
  }

  function updateExplore(items) {
    const top = items.slice(0, 5);
    $("topStations").innerHTML = top
      .map(
        (s, idx) => `
      <li>
        <span class="rank-badge">${idx + 1}</span>
        <span class="top-name">${s.name}</span>
        <span class="top-meta">排队约 ${s.queueMinutes}m</span>
      </li>
    `
      )
      .join("");
    $("heatList").innerHTML = top
      .map((s) => {
        const level = s.queueMinutes >= 16 ? "high" : s.queueMinutes >= 9 ? "mid" : "low";
        const label = level === "high" ? "高" : level === "mid" ? "中" : "低";
        return `<div class="heat-row"><span class="heat-name">${s.name}</span><strong class="heat-level ${level}">${label}风险</strong></div>`;
      })
      .join("");
  }

  function searchNearbyStations(center, keyword, statusText) {
    activeKeyword = normalizeKeyword(keyword);
    lastSearchCenter = center;
    setStatus(statusText || `正在搜索: ${activeKeyword}`);

    if (!placeSearch || !map) {
      setStatus("地图尚未加载完成");
      return;
    }

    placeSearch.searchNearBy(activeKeyword, center, SEARCH_RADIUS, (status, result) => {
      const pois = result && result.poiList && result.poiList.pois ? result.poiList.pois : [];
      if (status === "complete" && pois.length) {
        renderStations(pois.filter((poi) => poi.location).map(normalizePoi));
        setStatus(`已找到 ${pois.length} 个附近充电站`);
      } else {
        $("stationList").innerHTML = "<div class='station-item'>附近暂未找到充电站</div>";
        setStatus("暂无结果，请调整条件");
      }
    });
  }

  async function runAssistantPlan(message) {
    const goalMap = { fast: "最快到站", cheap: "最低费用", queue: "最少排队", personal: "个性化偏好" };
    selectedPlanType = $("goalSelect").value;
    selectedOperationMode = $("operationModeSelect")?.value || "auto";
    const goalText = goalMap[selectedPlanType] || "最快到站";
    const prompt = (message || "").trim() || DEFAULT_KEYWORD;
    lastAssistantPrompt = prompt;
    activeBatteryRisk = renderBatteryRisk(buildBatteryRisk({
      battery: Number($("batteryInput").value || 30),
      prompt
    }));
    activeOperationProfile = renderOperationMode(buildOperationProfile({
      mode: selectedOperationMode,
      battery: Number($("batteryInput").value || 30),
      prompt
    }));
    const personalPref = extractPersonalPreference(prompt);
    personalTags = [];
    backendPersonalProfile = null;
    backendPersonalScoreMap = new Map();
    backendPersonalTagMap = new Map();

    writeProfile({
      goal: goalText,
      operationMode: activeOperationProfile.key,
      operationModeLabel: activeOperationProfile.label,
      orderAdvice: activeBatteryRisk.orderAdvice,
      battery: Number($("batteryInput").value || 30),
      detour: Number($("detourInput").value || 8),
      power: Number($("powerInput").value || 120),
      hourlyIncome: Number($("incomeInput").value || 80),
      detourCostPerKm: Number($("detourCostInput").value || 1.5)
    });
    pushHistory(prompt);

    setStatus("AI 正在生成最优补能方案");

    try {
      const response = await fetch("/api/assistant/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `${prompt}。目标:${goalText}，当前电量${$("batteryInput").value}%，可绕路${$("detourInput").value}公里，最低功率${$("powerInput").value}kW。个性化偏好:${personalPref || "无"}`,
          city: config.defaultCity || DEFAULT_CITY,
          location: userLocation || lastSearchCenter || getDefaultCenter(),
          operationMode: selectedOperationMode,
          operationProfile: activeOperationProfile,
          batteryRisk: activeBatteryRisk,
          hour: new Date().getHours(),
          batteryLevel: Number($("batteryInput").value || 30),
          hourlyIncome: Number($("incomeInput").value || 80),
          detourCostPerKm: Number($("detourCostInput").value || 1.5),
          personalPreference: personalPref,
          visibleStations: currentStations.slice(0, 10).map((s) => ({ name: s.name, address: s.address, distance: s.distance, type: s.type }))
        })
      });

      if (!response.ok) throw new Error("assistant failed");
      const result = await response.json();
      currentPlan = result.plan || currentPlan;
      if (result.operationProfile) {
        activeOperationProfile = renderOperationMode(result.operationProfile);
      }
      if (result.personalProfile) {
        backendPersonalProfile = result.personalProfile;
        personalTags = Array.isArray(result.personalProfile.tags) ? result.personalProfile.tags : [];
      }
      if (Array.isArray(result.personalScoreBreakdown)) {
        for (const item of result.personalScoreBreakdown) {
          const id = item.stationId || item.stationName;
          backendPersonalScoreMap.set(id, Number(item.finalScore));
          backendPersonalTagMap.set(id, item.matchedTags || []);
        }
      }
      updateAiFacts(result, goalText);
      buildPlanCards();

      if (result.execution?.mode === "amap-web-service" && Array.isArray(result.execution.pois)) {
        renderStations(result.execution.pois.map(normalizePoi));
      } else {
        const center = userLocation || lastSearchCenter || (map ? toLngLat(map.getCenter()) : getDefaultCenter());
        const key = result.skill?.search?.keyword || result.plan?.keyword || DEFAULT_KEYWORD;
        searchNearbyStations(center, key, result.reply || "已按 AI 策略检索");
      }
      setStatus(result.reply || "AI 方案已生成");
    } catch {
      updateAiFacts(null, goalText);
      buildPlanCards();
      searchNearbyStations(userLocation || lastSearchCenter || getDefaultCenter(), prompt, "助手暂不可用，已切换规则检索");
    }
  }

  function locateAndSearch(initial) {
    if (!geolocation) {
      searchNearbyStations(getDefaultCenter(), DEFAULT_KEYWORD, "正在查找附近充电站");
      return;
    }
    setStatus(initial ? "正在定位并查找附近充电站" : "正在重新定位");
    geolocation.getCurrentPosition((status, result) => {
      if (status === "complete" && result && result.position) {
        userLocation = toLngLat(result.position);
        map.setZoomAndCenter(14, userLocation);
        searchNearbyStations(userLocation, DEFAULT_KEYWORD, "已定位，正在查找附近充电站");
      } else {
        const fallback = getDefaultCenter();
        map.setZoomAndCenter(config.defaultZoom || 12, fallback);
        searchNearbyStations(fallback, DEFAULT_KEYWORD, "定位失败，已展示默认区域站点");
      }
    });
  }

  function focusStation(station) {
    if (!station || !map || !window.AMap) return;
    map.setZoomAndCenter(16, station.position);
    const dist = Number.isFinite(station.userDistance) ? formatDistance(station.userDistance) : "";
    new AMap.InfoWindow({
      content: `<strong>${station.name}</strong><br>${station.address}<br>预计排队: ${station.queueMinutes}分钟 ${dist ? `<br>距离: ${dist}` : ""}`,
      offset: new AMap.Pixel(0, -30)
    }).open(map, station.position);
    setStatus(`已聚焦: ${station.name}`);
  }

  function openNavigation(station) {
    if (!map || !driving || !station) return;
    showNearbyPreferenceSpots(station);
    const start = userLocation || lastSearchCenter || toLngLat(map.getCenter());
    const end = station.position;
    setStatus(`正在规划到 ${station.name} 的路线`);
    driving.clear();
    driving.search(start, end, (status, result) => {
      if (status === "complete" && result.routes && result.routes.length) {
        const r = result.routes[0];
        const minutes = Math.max(1, Math.round((r.time || 0) / 60));
        setStatus(`路线已生成: 约 ${minutes} 分钟，排队约 ${station.queueMinutes} 分钟`);
      } else {
        setStatus("路线规划失败，请稍后重试");
      }
    });
  }

  function normalizeKeyword(keyword) {
    const text = (keyword || "").trim();
    if (!text) return DEFAULT_KEYWORD;
    if (text.includes("怎么") || text.includes("如何") || text.includes("充电")) return DEFAULT_KEYWORD;
    return text;
  }

  function extractPersonalPreference(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const match = raw.match(/(?:偏好|个性化偏好)\s*[：:]\s*(.+)$/);
    return match && match[1] ? match[1].trim() : "";
  }

  function updateTime() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    $("updatedAt").textContent = `更新时间 ${hh}:${mm}`;
  }

  function formatDistance(distance) {
    if (distance >= 1000) return `${(distance / 1000).toFixed(1)}km`;
    return `${Math.round(distance)}m`;
  }

  function wireUi() {
    bindTabs();
    renderMeCenter();
    renderOperationMode();
    renderBatteryRisk();
    buildPlanCards();
    $("aiFacts").innerHTML = "<li>输入你的需求后，这里会解释为什么推荐这些站点。</li>";

    const operationModeSelect = $("operationModeSelect");
    if (operationModeSelect) {
      operationModeSelect.addEventListener("change", () => {
        selectedOperationMode = operationModeSelect.value;
        activeOperationProfile = renderOperationMode(buildOperationProfile({
          mode: selectedOperationMode,
          battery: Number($("batteryInput").value || 30),
          prompt: $("searchInput").value
        }));
        rerankBySelectedPlan();
        setStatus(`已切换到${activeOperationProfile.label}`);
      });
    }

    const operationModeCards = $("operationModeCards");
    if (operationModeCards && operationModeSelect) {
      operationModeCards.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-mode]");
        if (!button) return;
        operationModeSelect.value = button.dataset.mode;
        operationModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    const strategyModal = $("strategyModal");
    const openStrategyButton = $("strategySettingsButton");
    const closeStrategyButton = $("closeStrategyModalButton");
    const applyStrategyButton = $("applyStrategyButton");
    const strategyBackdrop = $("strategyModalBackdrop");
    const openStrategyModal = () => strategyModal && strategyModal.classList.remove("hidden");
    const closeStrategyModal = () => strategyModal && strategyModal.classList.add("hidden");
    openStrategyButton?.addEventListener("click", openStrategyModal);
    closeStrategyButton?.addEventListener("click", closeStrategyModal);
    strategyBackdrop?.addEventListener("click", closeStrategyModal);
    applyStrategyButton?.addEventListener("click", () => {
      closeStrategyModal();
      activeBatteryRisk = renderBatteryRisk(buildBatteryRisk({
        battery: Number($("batteryInput").value || 30),
        prompt: $("searchInput").value
      }));
      activeOperationProfile = renderOperationMode(buildOperationProfile({
        mode: $("operationModeSelect")?.value || "auto",
        battery: Number($("batteryInput").value || 30),
        prompt: $("searchInput").value
      }));
      rerankBySelectedPlan();
      setStatus("策略已应用，推荐已刷新");
    });

    const stationDetailModal = $("stationDetailModal");
    const closeStationDetail = () => stationDetailModal && stationDetailModal.classList.add("hidden");
    $("closeStationDetailButton")?.addEventListener("click", closeStationDetail);
    $("stationDetailBackdrop")?.addEventListener("click", closeStationDetail);

    const showMoreStationsButton = $("showMoreStationsButton");
    showMoreStationsButton?.addEventListener("click", () => {
      const list = $("stationList");
      const expanded = list.classList.toggle("expanded");
      showMoreStationsButton.textContent = expanded ? "收起候选站点" : "查看全部候选站点";
    });

    const batteryRiskActions = $("batteryRiskActions");
    if (batteryRiskActions) {
      batteryRiskActions.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-risk-action]");
        if (!button) return;
        applyBatteryRiskAction(button.dataset.riskAction);
      });
    }

    ["batteryInput", "searchInput", "incomeInput", "detourCostInput"].forEach((id) => {
      const node = $(id);
      if (!node) return;
      node.addEventListener("input", () => {
        activeBatteryRisk = renderBatteryRisk(buildBatteryRisk({
          battery: Number($("batteryInput").value || 30),
          prompt: $("searchInput").value
        }));
        if (($("operationModeSelect")?.value || "auto") !== "auto") return;
        activeOperationProfile = renderOperationMode(buildOperationProfile({
          mode: "auto",
          battery: Number($("batteryInput").value || 30),
          prompt: $("searchInput").value
        }));
        rerankBySelectedPlan();
      });
    });

    $("searchButton").addEventListener("click", () => runAssistantPlan($("searchInput").value));
    $("searchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runAssistantPlan(e.currentTarget.value);
    });

    $("quickActions").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-prompt]");
      if (!b) return;
      $("searchInput").value = b.dataset.prompt;
      runAssistantPlan(b.dataset.prompt);
    });

    $("locateButton").addEventListener("click", () => locateAndSearch(false));
    $("zoomInButton").addEventListener("click", () => map && map.zoomIn());
    $("zoomOutButton").addEventListener("click", () => map && map.zoomOut());

    $("avoidCrowdButton").addEventListener("click", () => {
      const best = [...currentStations].sort((a, b) => a.queueMinutes - b.queueMinutes)[0];
      if (!best) return setStatus("当前无可用站点");
      focusStation(best);
      setStatus(`建议前往 ${best.name}，预计排队 ${best.queueMinutes} 分钟`);
    });

    const topBtn = $("toggleTopMapButton");
    if (topBtn) {
      topBtn.addEventListener("click", () => {
        top5MapVisible = !top5MapVisible;
        syncTop5MapLayer();
        setStatus(top5MapVisible ? "已在地图标出热门站点 TOP5" : "已关闭 TOP5 地图标记");
      });
    }

    document.querySelectorAll(".route-mode").forEach((node) => {
      node.addEventListener("click", () => {
        applySelectedPlan(node.dataset.plan, false);
      });
    });

    const routeNavigateButton = $("routeNavigateButton");
    if (routeNavigateButton) {
      routeNavigateButton.addEventListener("click", () => {
        const station = currentStations[selectedStationIndex];
        if (!station) {
          setStatus("请先在 AI找桩 生成并选择候选站点");
          return;
        }
        openNavigation(station);
      });
    }

    const panelToggle = $("aiPanelToggle");
    const panelNode = document.querySelector(".ai-panel");
    panelToggle.setAttribute("aria-expanded", panelNode.classList.contains("collapsed") ? "false" : "true");
    panelToggle.addEventListener("click", () => {
      const collapsed = panelNode.classList.toggle("collapsed");
      panelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

    const registerButton = $("registerButton");
    const loginButton = $("loginButton");
    const logoutButton = $("logoutButton");
    const registerUsernameInput = $("registerUsername");
    const registerPasswordInput = $("registerPassword");
    const loginUsernameInput = $("loginUsername");
    const loginPasswordInput = $("loginPassword");

    const entryTabs = document.querySelectorAll(".me-entry-tab");
    function switchMeEntry(mode) {
      entryTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.entry === mode));
      $("authBoxRegister").classList.toggle("hidden", mode !== "register");
      $("authBoxLogin").classList.toggle("hidden", mode !== "login");
      $("authBoxGuest").classList.toggle("hidden", mode !== "guest");
    }

    entryTabs.forEach((tab) => {
      tab.addEventListener("click", () => switchMeEntry(tab.dataset.entry));
    });
    switchMeEntry(currentUser ? "login" : "register");

    const mePage = $("mePage");
    const mePageButton = $("mePageButton");
    const closeMePageButton = $("closeMePageButton");
    if (mePageButton && mePage) {
      mePageButton.addEventListener("click", () => {
        mePage.classList.remove("hidden");
      });
    }
    if (closeMePageButton && mePage) {
      closeMePageButton.addEventListener("click", () => {
        mePage.classList.add("hidden");
      });
    }

    if (registerButton) {
      registerButton.addEventListener("click", async () => {
        try {
          await authRequest("/api/auth/register", {
            username: registerUsernameInput.value.trim(),
            password: registerPasswordInput.value
          });
          setStatus("注册成功，请切换到登录");
          const authStatus = $("authStatus");
          if (authStatus) {
            authStatus.textContent = `注册成功：${registerUsernameInput.value.trim()}，请登录继续。`;
          }
          switchMeEntry("login");
          if (loginUsernameInput) loginUsernameInput.value = registerUsernameInput.value.trim();
        } catch (error) {
          setStatus(error.message);
        }
      });
    }

    if (loginButton) {
      loginButton.addEventListener("click", async () => {
        try {
          const data = await authRequest("/api/auth/login", {
            username: loginUsernameInput.value.trim(),
            password: loginPasswordInput.value
          });
          authToken = data.token || "";
          localStorage.setItem(AUTH_TOKEN_KEY, authToken);
          currentUser = data.user || null;
          renderMeCenter();
          setStatus(`登录成功：${currentUser?.username || ""}`);
        } catch (error) {
          setStatus(error.message);
        }
      });
    }

    if (logoutButton) {
      logoutButton.addEventListener("click", async () => {
        try {
          await authRequest("/api/auth/logout", { token: authToken });
        } catch {}
        authToken = "";
        currentUser = null;
        localStorage.removeItem(AUTH_TOKEN_KEY);
        renderMeCenter();
        setStatus("已退出登录");
      });
    }
  }

  wireUi();
  loadCurrentUser();
  loadAmap();
})();
