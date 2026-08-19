# dsh-feishu-bridge

把 DeepSeek Harness (DSH) 接到飞书的桥接插件。装上它，你就能在手机飞书里跟运行在电脑上的 DSH 对话——人不在电脑前，也能让它干活。

## 它解决什么问题

- **随时随地用 DSH**：手机 4G/5G 网络下，打开飞书私聊机器人即可驱动电脑上的 DSH（查资料、写代码、跑任务……），回复像打字一样在卡片上逐字刷新。
- **该确认的会弹卡片**：DSH 需要权限或要问你问题时，不会静默卡住，而是在飞书里弹出按钮卡片，点一下就能继续。
- **安全可控**：首次使用需 6 位配对码绑定；工作区外的危险操作会弹审批卡，由你亲自决定放行或拒绝。

## 核心能力

| 能力 | 说明 |
|---|---|
| 流式回复 | AI 回答在飞书卡片上实时逐字刷新（CardKit 流式卡片），不是干等一条长消息 |
| 远程命令 | `/new` 开新会话 · `/clear` 清空 · `/stop` 停止 · `/config` 查看/修改配置 |
| 审批卡片 | 需要授权时弹「✅允许 / ♾️永久允许 / ❌拒绝」三按钮卡 |
| 远程提问 | AI 要问你时弹选项卡，点选按钮或直接回文本即可 |
| 附件收发 | 飞书发图/文件给 DSH 处理，DSH 也能把文件发回飞书 |

## 快速开始

1. 在飞书开放平台创建企业自建应用，开启「机器人」能力，获取 App ID / App Secret。
2. 将 App ID/Secret 填入 web profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/`），重启 `dsh web`。
3. 从 dsh 日志中读取配对码（`[dsh-feishu-bridge] 配对码：XXXXXX`）。
4. 在飞书中私聊机器人，发送配对码完成配对，然后直接发消息即可与 DSH 对话（回复为流式卡片）。

首次上手约 5 分钟。

## 配置（cordis.patch.yml 的 dsh-feishu-bridge 条目）

| 字段 | 必填 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 是 | 飞书开放平台应用凭据；留空则插件跳过飞书连接（日志提示） |
| `encryptKey` / `verificationToken` | 否 | 事件加密 key / 校验 token（WS 模式下可选） |
| `pairingCode` | 否 | 预置配对码；留空启动时自动生成并打印到 dsh 日志 |
| `allowedUsers` | 否 | 允许用户 open_id 白名单（与配对并集） |
| `sessionCwd` | 否 | DSH 会话工作目录，默认用户主目录（建议显式配置为实际工作目录） |
| `stateDir` | 否 | 状态目录，默认 `$DSH_HOME/feishu-bridge` |
| `approvalTimeoutSeconds` | 否 | 审批卡挂起超时（秒），默认 300（5 分钟），超时自动拒绝 |
| `questionTimeoutSeconds` | 否 | 远程提问卡挂起超时（秒），默认 600（10 分钟），超时自动取消 |

## 安装

本插件是 **DSH 生态插件**：`@deepseek-ai/*`（cordis / dsh-agent / dsh-llm / dsh-session / dsh-user-approval）
由 DSH 宿主环境提供（peerDependencies，非独立安装）。标准安装方式是经 DSH 的插件命令（link 安装）：

```bash
# 在 DSH 仓库根目录执行
node apps/cli/lib/bin.js plugin --profile web add dsh-feishu-bridge@link:<本插件目录绝对路径>
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `dsh-feishu-bridge` 条目填入飞书应用
`appId` / `appSecret`（飞书开放平台创建企业自建应用、开启机器人能力后获得），重启 `dsh web` 生效。

> **注意**：不要在本仓库目录直接 `pnpm install`——`@deepseek-ai/*` 的 npm 发布链不完整
> （`@deepseek-ai/dsh-session` → `@deepseek-ai/dsh-type-meta` 未发布，上游问题），
> 且这些包本就该由 DSH 宿主提供。clone 本仓库用于源码阅读 / 二次开发；构建与测试需在
> 已安装 DSH 的环境中进行（link 安装后，插件目录的 node_modules 即包含宿主提供的依赖）。

## 构建与测试

```bash
pnpm install
pnpm build      # tsc → lib/
pnpm test       # vitest run（397 个用例全绿）
```

## 模块结构（开发者）

- 复用层（`src/feishu/`，来自 [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) 的飞书 SDK 封装，MIT）：
  - `cardkit.ts` — CardKit 五步流程（create → send → stream → settings → update）
  - `streaming-card.ts` — 流式卡片生命周期状态机（含 patch 降级、节流、错误码处理）
  - `markdown-style.ts` — 飞书卡片 markdown 预处理（标题降级/表格限数/图片 key 校验）
  - `flush-controller.ts` — 节流 + mutex + 冲突重刷调度原语
  - `card-errors.ts` — CardKit 错误码解析（230020/230099/11310）
  - `extract-payload.ts` — 入站消息解析（text/post/image/file）
  - `media.ts` — 附件上传/下载/图片消息
  - `path-safety.ts` — 跨目录检测
  - `attachment/` — 附件本地暂存（来自 cc-haha common 层，已解耦）
- 适配层（本插件自有实现）：
  - `src/index.ts` — Cordis 插件入口：config、WSClient 长连接（`im.message.receive_v1` + `card.action.trigger`）、配对码初始化、teardown
  - `src/bridge.ts` — DSH 会话桥接：chatId ↔ session 映射（持久化可 resume）、`ctx.agents.create/resume` + `followup()` 注入、`session/event` → StreamingCard 路由（文本/reasoning 增量、工具轨迹、turn 收尾）；create/resume 均装配 preset（工具集）+ 远程专用工具
  - `src/pairing.ts` — 配对核心：6 位安全码、60 分钟一次性、速率限制、原子 JSON 持久化（`$DSH_HOME/feishu-bridge/pairing.json`）
  - `src/inbound.ts` — 入站分发：去重、私聊过滤、未授权 → 配对流程、已授权 → 提问自由输入消费 → 命令拦截/桥接转发
  - `src/commands.ts` — 远程命令体系（命令消息不进入 DSH 会话）
  - `src/dedup.ts` — 事件去重（滚动窗口）
  - `src/approval-cards.ts` — 审批卡片：监听 `approval/request` waterfall，把权限请求转成飞书 Schema 2.0 三按钮卡，`card.action.trigger` 应答 → resolve；超时（默认 5 分钟，可配置 `approvalTimeoutSeconds`）自动拒绝；teardown 时挂起全部 settle cancelled
  - `src/question-bridge.ts` — 远程提问卡：DSH `ask_user_question` → 飞书交互卡（选项按钮 + 自定义回答）；多题全部答齐才 resolve；超时（默认 10 分钟，可配置 `questionTimeoutSeconds`）/abort 取消
  - `src/remote-ask-tool.ts` — agent 装配时在 agent scope 注册同名 `ask_user_question`（shadow preset 层官方版本，仅远程会话生效，GUI 不受影响）
  - `src/remote-guidance.ts` — 远程会话 systemPrompt 注入：告知 AI `/config` 是配置权威入口，遇到配置请求直接引导用户发 `/config`

## 后置项

- 群聊 @bot 模式
- `/projects` 项目选择器
- 审批「永久允许」跨次授权（需 DSH approval 侧支持 per-tool 持久规则）

## 许可

MIT。`src/feishu/` 飞书 SDK 封装层（CardKit 流式卡 / 媒体 / 解析）来自
[NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha)（MIT License），各文件头已注明来源；
其余模块为 dsh-feishu-bridge 针对 DeepSeek Harness 生态独立开发。

## 致谢

Thanks to [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) (Claude Code Haha)
for the original Feishu IM adapter design (MIT).
