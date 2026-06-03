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

  function setStatus(text) {
    if (statusPill) statusPill.textContent = text;
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
    const prefText = `目标: ${p.goal || "最快到站"} | 电量: ${p.battery || 30}% | 绕路: ${p.detour || 8}km | 功率: ${p.power || 120}kW`;
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
    const battery = Number($("batteryInput").value || 30);
    const detour = Number($("detourInput").value || 8);
    const power = Number($("powerInput").value || 120);
    const hasLLM = Boolean(result?.diagnostics?.usedLLM);
    const intentText = plan.intent === "find_charging_station" ? "找附近更合适的充电站" : "按你的描述做补能推荐";
    const profile = backendPersonalProfile || {};
    const explainTags = profile.tags?.length ? profile.tags.join("、") : "等待后端 AI 识别";
    const facts = [
      `你这次的主要需求是：${goalText}，系统理解为“${intentText}”。`,
      `已按你的条件筛选：当前电量 ${battery}% 、可绕路约 ${detour}km、优先功率不低于 ${power}kW。`,
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
    const textBlob = `${station.name} ${station.address} ${station.type}`;
    if (goal === "queue") {
      score += Math.max(0, 30 - mockQueue * 1.3);
      score -= mockDetourKm * 0.6;
      reasons.push(`预计排队 ${mockQueue} 分钟`);
      reasons.push(`绕路约 ${mockDetourKm}km`);
    }
    if (goal === "cheap") {
      score += Math.max(0, 36 - mockCost);
      score += Math.max(0, 12 - mockDetourKm);
      score -= mockQueue * 0.2;
      reasons.push(`估算费用指数 ${mockCost}`);
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
    $("stationList").innerHTML = items.length
      ? items.map((station, index) => {
          const distanceValue = Number.isFinite(station.userDistance) ? station.userDistance : station.distance;
          const distance = distanceValue ? formatDistance(distanceValue) : "附近";
          return `
            <div class="station-item" data-index="${index}">
              <span class="station-rank">${index + 1}</span>
              <span class="station-main">
                <strong>${station.name}</strong>
                <small>${station.address}</small>
                <span class="station-meta">
                  <span>推荐度 ${station.recommendation.score.toFixed(2)}</span>
                  <span>排队约 ${station.queueMinutes}m</span>
                  <span>绕路约 ${station.detourKm}km</span>
                  <span>费用指数 ${station.costIndex}</span>
                </span>
              </span>
              <span class="station-distance">${distance}</span>
              <button class="nav-station" data-index="${index}" type="button">导航</button>
            </div>
          `;
        }).join("")
      : "<div class='station-item'>暂无站点，请尝试其他条件</div>";

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

    updateExplore(items);
    updateTime();
    selectedStationIndex = 0;
    syncRoutePlanUi();
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
    let score = 45;
    if (distance < 1500) score += 22;
    else if (distance < 4000) score += 12;
    else score += 4;

    if (planType === "fast") {
      score += Math.max(0, 26 - detour * 1.8);
      score += Math.max(0, 18 - queue * 0.7);
    } else if (planType === "cheap") {
      score += Math.max(0, 36 - cost);
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
    const goalText = goalMap[selectedPlanType] || "最快到站";
    const prompt = (message || "").trim() || DEFAULT_KEYWORD;
    lastAssistantPrompt = prompt;
    const personalPref = extractPersonalPreference(prompt);
    personalTags = [];
    backendPersonalProfile = null;
    backendPersonalScoreMap = new Map();
    backendPersonalTagMap = new Map();

    writeProfile({
      goal: goalText,
      battery: Number($("batteryInput").value || 30),
      detour: Number($("detourInput").value || 8),
      power: Number($("powerInput").value || 120)
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
          personalPreference: personalPref,
          visibleStations: currentStations.slice(0, 10).map((s) => ({ name: s.name, address: s.address, distance: s.distance, type: s.type }))
        })
      });

      if (!response.ok) throw new Error("assistant failed");
      const result = await response.json();
      currentPlan = result.plan || currentPlan;
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
    buildPlanCards();
    $("aiFacts").innerHTML = "<li>输入你的需求后，这里会解释为什么推荐这些站点。</li>";

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
