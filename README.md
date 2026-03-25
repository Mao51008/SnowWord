# 雪语

雪语是一个运行在微信 `iLink` Bot 之上的 AI 伴侣项目。

它面向“长期陪伴”场景，提供持续对话、长期记忆、定时提醒、主动消息、时间查询、可插拔天气查询等能力。当前默认运行方式为宿主机直跑，便于开发、调试和二次扩展。

## 功能

- 微信 `iLink` Bot 接入
- SQLite 持久化存储账号、消息、提醒与伴侣状态
- 长短期记忆
- 定时提醒与主动关心
- 当前时间查询
- 可插拔天气查询
- 可持续演化的人格、情绪、关系与生活流状态

## 项目结构

```text
src/
  index.ts
  ilink.ts
  agent-runner.ts
  agent-tools.ts
  companion-state.ts
  companion-life.ts
  task-scheduler.ts
  db.ts
  weather.ts
skills/
  reminder/
    SKILL.md
```

## 环境要求

- Node.js 20+
- npm
- 可用的微信 `iLink` Bot

## 配置

将 [`.env.example`](./.env.example) 复制为 `.env` 后按需填写。

常用配置包括：

- 模型相关
  - `AGENT_MODEL`
  - `OPENAI_API_KEY`
  - `OPENAI_BASE_URL`
  - `OPENAI_MODEL`
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_MODEL`
- 助手基础信息
  - `ASSISTANT_NAME`
  - `ASSISTANT_HAS_OWN_NUMBER`
  - `TZ`
- 天气能力
  - `WEATHER_BASE_URL`
  - `WEATHER_API_KEY`
  - `WEATHER_AUTH_PARAM`
  - `WEATHER_LOCATION_PARAM`
  - `WEATHER_ADCODE_PARAM`

## 安装与运行

安装依赖：

```bash
npm install
```

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

构建后运行：

```bash
npm start
```

## 账号与状态

登录微信 Bot：

```bash
npm run login
```

查看账号：

```bash
npm run accounts
```

删除账号：

```bash
npm run account:remove -- 1
```

查看伴侣状态：

```bash
npm run state
```

## 本地数据

运行时会生成以下目录或文件：

- `store/messages.db`
- `data/`
- `logs/`

这些内容包含本地状态、聊天记录和运行日志，不建议提交到版本库。

## 开发说明

如果你想继续扩展雪语，通常会改这些位置：

- `src/agent-runner.ts`
  调整系统人格与模型调用
- `src/agent-tools.ts`
  增加或修改工具能力
- `src/companion-state.ts`
  调整关系、情绪和主动状态
- `src/companion-life.ts`
  扩展生活流与日常素材
- `src/task-scheduler.ts`
  调整提醒与主动触达逻辑
- `skills/`
  增加技能说明与行为约束

## 许可证

见 [LICENSE](./LICENSE)。
