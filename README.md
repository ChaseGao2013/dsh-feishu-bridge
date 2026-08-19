# dsh-feishu-bridge

飞书 (Feishu/Lark) IM 桥接插件，为 DeepSeek Harness (DSH) 提供飞书消息收发、CardKit 流式卡片、权限审批交互卡、远程提问卡等能力。

## 状态：MVP + P2 审批卡片 + P4 远程命令 + P2.5 提问远程化

- 照搬自 [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha)（claude-code-im-adapters，MIT License）的飞书 SDK 封装层，位于 `src/feishu/`：
  - `cardkit.ts` — CardKit 五步流程（create → send → stream → settings → update）
  - `streaming-card.ts` — 流式卡片生命周期状态机（含 patch 降级、节流、错误码处理）
  - `markdown-style.ts` — 飞书卡片 markdown 预处理（标题降级/表格限数/图片 key 校验）
  - `flush-controller.ts` — 节流 + mutex + 冲突重刷调度原语
  - `card-errors.ts` — CardKit 错误码解析（230020/230099/11310）
  - `extract-payload.ts` — 入站消息解析（text/post/image/file）
  - `media.ts` — 附件上传/下载/图片消息
  - `path-safety.ts` — 跨目录检测
  - `attachment/` — 附件本地暂存（来自 CChh common 层，已解耦）
- 适配层（本插件自有实现）：
  - `src/index.ts` — Cordis 插件入口：config、WSClient 长连接（`im.message.receive_v1` + `card.action.trigger`）、配对码初始化、teardown
  - `src/bridge.ts` — DSH 会话桥接：chatId ↔ session 映射（持久化可 resume）、`ctx.agents.create/resume` + `followup()` 注入、`session/event` → StreamingCard 路由（文本/reasoning 增量、工具轨迹、turn 收尾）；create/resume 均装配 preset（工具集）+ 远程专用工具
  - `src/pairing.ts` — 配对核心：6 位安全码、60 分钟一次性、速率限制、原子 JSON 持久化（`$DSH_HOME/feishu-bridge/pairing.json`）
  - `src/inbound.ts` — 入站分发：去重、私聊过滤、未授权 → 配对流程、已授权 → 提问自由输入消费 → 命令拦截/桥接转发
  - `src/commands.ts` — 远程命令体系（命令消息不进入 DSH 会话）：
    `/help` 帮助 · `/status` 状态 · `/new <路径>` 新会话 · `/clear` 清空 · `/stop` 停止 · `/config` 远程配置 · `/projects` 项目列表（暂未支持）
  - `src/dedup.ts` — 事件去重（滚动窗口）
  - `src/approval-cards.ts` — 审批卡片（P2）：监听 `approval/request` waterfall（模式照 DSH 内置 apiproxy 的挂起通道），把权限请求转成飞书 Schema 2.0 三按钮卡（✅允许/♾️永久允许/❌拒绝），`card.action.trigger` 应答 → resolve；超时（默认 5 分钟，可配置 `approvalTimeoutSeconds`）自动拒绝；「永久允许」映射为 allowed-once（DSH 无跨次永久授权）；teardown 时挂起全部 settle cancelled
  - `src/question-bridge.ts` — 远程提问卡（P2.5）：DSH `ask_user_question` → 飞书交互卡（每题选项按钮 + ✏️自定义回答）；选项按钮一次点击即该题答案，自定义按钮后用户直接回文本即答案；多题全部答齐才 resolve；超时（默认 10 分钟，可配置 `questionTimeoutSeconds`）/abort 取消
  - `src/remote-ask-tool.ts` — agent 装配时在 agent scope 注册同名 `ask_user_question`（shadow preset 层官方版本，仅远程会话生效，GUI 不受影响）
  - `src/remote-guidance.ts` — 远程会话 systemPrompt 注入（order 200）：告知 AI `/config` 是配置权威入口（remotePermissionPreset/sessionCwd），遇到配置请求直接引导用户发 `/config`，不绕圈不自创配置项

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

## 联调步骤

1. 在飞书开放平台创建企业自建应用，开启「机器人」能力，获取 App ID/Secret。
2. 将 App ID/Secret 填入 web profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/`），重启 `dsh web`。
3. 从 dsh 日志中读取配对码（`[dsh-feishu-bridge] 配对码：XXXXXX`）。
4. 在飞书中私聊机器人，发送配对码完成配对，然后直接发消息即可与 DSH 对话（回复为流式卡片）。

## 构建与测试

```bash
pnpm install
pnpm build      # tsc → lib/
pnpm test       # vitest run（397 个用例全绿）
```

## 安装（web profile）

在 DSH 仓库根目录执行：

```bash
node apps/cli/lib/bin.js plugin --profile web add dsh-feishu-bridge@npm:dsh-feishu-bridge
# 或本地开发时 link 安装：
# node apps/cli/lib/bin.js plugin --profile web add dsh-feishu-bridge@link:<本插件目录绝对路径>
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `dsh-feishu-bridge` 条目填入飞书应用
`appId` / `appSecret`（飞书开放平台创建企业自建应用、开启机器人能力后获得），重启 `dsh web` 生效。
依赖 `@deepseek-ai/*`（cordis / dsh-agent / dsh-llm / dsh-session / dsh-user-approval）由 DSH 宿主环境提供（peerDependencies）。

## 后置项

- 附件（图片/文件）下载与转发
- 群聊 @bot 模式
- `/projects` 项目选择器
- 审批「永久允许」跨次授权（需 DSH approval 侧支持 per-tool 持久规则）

## 许可

MIT。`src/feishu/` 飞书 SDK 封装层（CardKit 流式卡 / 媒体 / 解析）照搬自
[NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha)（Claude Code Haha，MIT License），各文件头已注明来源；
其余模块（DSH 会话桥接、配对、审批卡、远程提问、命令体系、附件、限流审计）为
dsh-feishu-bridge 针对 DeepSeek Harness 生态的独立实现，不涉及任何 Claude Code 内部逻辑。

## 致谢

Thanks to [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) (Claude Code Haha)
for the original Feishu IM adapter design (MIT).
