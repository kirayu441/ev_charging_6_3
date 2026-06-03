# 充电桩智能查找助手

一个基于高德地图的充电桩查找原型页面。用户可以用自然语言表达需求，例如“我要去德基广场附近的充电桩”“我只有 12% 电，找最近的快充”，系统会识别意图、查找真实充电站，并在地图中展示点位和路线。

## 当前能力

- 高德地图 Web 端展示
- 自动获取用户定位
- 自然语言输入找桩需求
- LLM 意图识别，未配置模型时自动走本地规则兜底
- 目的地识别，例如“德基广场附近”
- 高德 Web Service 后端调用：
  - 地理编码
  - 周边 POI 搜索
  - 驾车路线规划
- 高德 JS API 前端展示：
  - 地图
  - Marker
  - InfoWindow
  - 路线绘制
- 推荐度排序
- 每个推荐站点可展开查看推荐原因
- 导航后地图自动切换为路线全览

## 项目结构

```text
.
├── index.html
├── styles.css
├── app.js
├── server.mjs
├── backend/
│   ├── assistant.mjs
│   ├── amapSkill.mjs
│   ├── amapWebService.mjs
│   ├── env.mjs
│   └── llm.mjs
├── .env.example
└── .gitignore
```

## 前后端分工

```text
前端
  - 展示地图
  - 获取浏览器定位
  - 接收用户输入
  - 展示推荐列表
  - 展示路径全览

后端
  - 读取环境变量
  - 调用 LLM 做意图识别
  - 组织高德 LBS Skill 风格动作
  - 调用高德 Web Service
  - 返回推荐结果和规划信息
```

## 配置

复制 `.env.example` 为 `.env`：

```bash
PORT=5173
DEFAULT_CITY=Nanjing
DEFAULT_CENTER=118.796877,32.060255
DEFAULT_ZOOM=12

AMAP_JS_API_KEY=你的高德 Web端(JS API) Key
AMAP_SECURITY_JS_CODE=你的高德 JS API 安全密钥
AMAP_WEB_SERVICE_KEY=你的高德 Web服务 Key

LLM_API_BASE=http://你的模型服务地址
LLM_API_KEY=你的模型 Key
LLM_MODEL=你的模型名称
AMAP_SKILL_MODE=jsapi
```

说明：

- `AMAP_JS_API_KEY`：前端加载高德地图使用
- `AMAP_SECURITY_JS_CODE`：高德 Web端 JS API 安全密钥
- `AMAP_WEB_SERVICE_KEY`：后端调用高德 Web 服务使用
- `LLM_API_KEY`：后端调用语言模型使用
- `.env` 已被 `.gitignore` 排除，不要提交真实 key

## 启动

```bash
node server.mjs
```

访问：

```text
http://127.0.0.1:5173/
```

## API

### 助手规划

```text
POST /api/assistant/plan
```

请求示例：

```json
{
  "message": "我要去德基广场附近的充电桩",
  "city": "南京",
  "location": [118.796877, 32.060255]
}
```

返回内容包含：

- `reply`：给用户看的回答
- `plan`：LLM 识别出的意图
- `skill`：高德 LBS Skill 风格动作
- `execution`：高德 Web Service 执行结果
- `diagnostics`：是否调用 LLM、使用的模型等调试信息

### 路线规划

```text
POST /api/amap/route
```

请求示例：

```json
{
  "origin": [118.796877, 32.060255],
  "destination": [118.783, 32.047]
}
```

## 关于高德 Skill

高德 SKILL 专区里的 `amap-lbs-skill` / `amap-jsapi-skill` 更偏 AI 工具能力规范，不是普通 Web 项目里直接运行的 npm 业务包。

本项目当前采用实际可运行的方式实现同等能力：

- 后端使用高德 Web Service 执行 LBS 能力
- 前端使用高德 JS API 执行地图展示和路线可视化
- `backend/amapSkill.mjs` 保留高德 Skill 风格动作结构，方便后续接入真正的 Agent / MCP 工具链

## 注意事项

- 浏览器需要允许定位，否则只能使用默认中心点
- 没有配置 `LLM_API_KEY` 时，系统会使用本地规则识别常见表达
- 没有配置 `AMAP_WEB_SERVICE_KEY` 时，后端不能真正调用高德 Web Service，会回退到前端 JS API 搜索能力
- 高德 POI 通常不直接返回实时空闲桩数和价格，当前页面不伪造这些数据
