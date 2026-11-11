# 本分支说明：服务器实际运行的版本（v1.0.2 + 本地补丁）

本分支 `runtime/1.0.2-patched` = 上游标签 **v1.0.2**（b470cb1）加上本机在跑的小鲸实例所做的 8 处代码改动 + 1 个新人格。

- 用途：给「现在服务器上真正跑的代码」留一份可追溯的公开副本（原来只存在于 `C:\dsh-home02\profiles\web\node_modules\dsh-aurabot-qq`，重装即丢）。
- **不是**给上游提的功能分支：上游 main 已是 1.3.0-beta.1 一系，结构变化很大，直接基于 1.0.2 提 PR 会把 1.3 的 170 多个文件"回退"掉。要往上合并，见文末「怎么并回上游」。
- 数据与密钥不在本分支：`config.json`、`memories.json`、`logs/`、`*.bak`、`local/out/`、任何 `secrets.*` 一律不入库。

## 八处改动

| # | 文件 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `src/chat/access.js` | 白名单里写 `*` 时，私聊/群聊全部放行 | 单人自用，懒得逐个加 QQ 号 |
| 2 | `src/chat/commands.js` | 支持中文命令前缀（`/猜谜`、`/成语接龙`、`/今日`、`/随机人格` 等），并允许外部模块注册中文命令前缀 | 主人习惯说中文，英文斜杠命令记不住 |
| 3 | `src/chat/hub.js` | 收到图片改为调本机 `powershell -File C:\dsh-deploy\vision.ps1 -Image <tmp>` 用 GLM 视觉转文字；`__imgBusy` 并发计数，忙时先回一句"排队"；可用内存 < 250 MB 跳过看图；一轮最多看 2 张 | 主模型是纯文本的 deepseek-v4-flash，看不了图；用本机已付费的智谱视觉兜底 |
| 4 | `src/core/config.js` | 新默认值：`persona:{current,daily,pool}`、`model:{provider,model,reasoningEffort,hardProvider,hardModel,routeHard,glmText}`、`voice.volc`；**密钥外部化**：`SECRETS_FILE`（默认 `C:\dsh-deploy\secrets.env`，可用 `DSH_SECRETS_FILE` 覆盖）+ `SECRET_KEYS` 映射 `SNOWLUMA_WEBUI_PASSWORD / SNOWLUMA_HTTP_TOKEN / SNOWLUMA_WS_TOKEN`；`readSnowlumaTokens()` 直接读 `C:\SnowLuma\config\onebot*.json`；`persistExternalSecret()` 写回外部文件 | 原来密码/token 存 `config.json` 明文，会被备份和日志带走；改成外部 secrets + 从 SnowLuma 配置读 |
| 5 | `src/core/llm.js` | 新增 GLM 文本路由：`GLM_ENDPOINT=https://open.bigmodel.cn/api/paas/v4/chat/completions`、`GLM_MODEL=glm-5.3-flash`，key 从 secrets.env 或 `secrets.ps1` 取（spawn powershell） | 便宜活儿（闲聊、轻任务）走 GLM，省钱也省 DSH 推理配额 |
| 6 | `src/host.js` | 新增 `/personas`、`/persona/today`、`/persona/daily` 路由与切人格逻辑；`savePassword` 改写到外部 secrets | 面板上能看今天是谁、能开/关每日随机人格 |
| 7 | `src/persona/personas.js` | `resolvePersonaId(cfg)`：`daily=true` 时按日期 hash 从 `pool` 抽当天人格（池空则全部人格） | 「百变马丁」：每天换个人格说话，不至于一个腔调 |
| 8 | `src/voice/tts.js` | 接入火山引擎 TTS（`speaker`、`volume`、`sampleRate`），+94 行 | 本地 edge-tts 音色少，火山音色更像人 |

## 新增文件

- `personas/tianmei.md`——新人格「天美」（6.9 KB），服务器在用。

## 上游有没有这些功能（对照 main = a138d14 / 1.3.0-beta.1）

在 a138d14 的 `src/` 里搜索 `vision.ps1`、`glm-5`、`bigmodel`、`persistExternalSecret`、`DSH_SECRETS_FILE`、`resolvePersonaId`、`persona.daily`、`routeHard`、`通配` —— **0 命中**，这些都是本机自造的。

但 1.3.x 自己用别的办法解决了一部分同类问题（见 `CHANGELOG.md`），并回上游前要先看：

- 看图：1.3.x 已支持"群友图片一起看（最多 2 张）"、按聊天模型判断视觉能力、不可用如实说明——**与 #3 的思路重叠但实现不同**（上游靠模型自身视觉，本机靠外部 GLM）。
- 云 TTS：1.3.x 的「其他 HTTP 接口」已能配请求头/请求体接火山/阿里/讯飞——**#8 的刚需部分上游已有**，本机版只多了 `volc` 专用字段。
- 人格：1.3.x 有按节编辑、AI 润色——**没有"每日随机人格"（#7 仍独有）**。
- 密钥外部化（#4）、GLM 路由（#5）、中文命令（#2）、`*` 通配（#1）：上游均无。

## 怎么并回上游

1. 从 main 拉分支，先把 #1 #2 #4 #7 这类与架构无关的小改动移植过去（改动小、冲突少）。
2. #3 #8 属于"本机环境特定"（依赖 `C:\dsh-deploy\vision.ps1`、火山账号），**不建议提上游**；要提就提成"可插拔的图片转述接口 / 云 TTS 适配器"。
3. #5 GLM 路由同理：上游若愿意，做成 provider 插件更合适。
4. 提 PR 前先跑 `node --test "test/**/*.test.js"`（1.0.2 的测试目录内有 6 个用例）。

---
生成时间：2026-11-12 · 生成方式：对 `C:\dsh-home02\profiles\web\node_modules\dsh-aurabot-qq` 与标签 v1.0.2 做 sha256 逐文件对比（81 个共有文件，差异 8 个）。
