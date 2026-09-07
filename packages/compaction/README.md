# Compaction

一个给 [Pi](https://github.com/earendil-works/pi) 使用的可配置上下文压缩扩展。它允许你把“整理长对话、生成续聊摘要”交给更便宜、更快的模型，同时继续用能力更强、价格更高的模型完成主要工作。

## 为什么要用

长会话会反复把大量历史上下文发送给主模型。上下文越长，通常意味着：

- 输入 token 成本更高；
- 首 token 和整轮响应更慢；
- 模型更容易被已经过时的细节干扰；
- 接近上下文上限时，工具调用链更容易被压缩打断。

Compaction 在安全边界把较旧历史整理成结构化摘要，只保留摘要和最近对话。最适合的组合是：

```text
昂贵/强能力模型：编码、推理、执行主要任务
便宜/快速模型：生成 compaction 摘要
```

实际节省多少取决于 provider 定价、缓存策略、会话长度和压缩频率；它不是固定比例的费用承诺。它主要减少后续轮次需要重复输入给主模型的历史 token，并通常改善长会话的响应速度。

## 工作方式

```text
上下文达到配置阈值
        ↓
等待当前 Agent 运行完全结束（不打断工具调用链）
        ↓
默认 Compaction 模型生成结构化摘要
        ↓ 失败
按 fallbackLevel 从小到大尝试备用模型
        ↓ 全部失败
回退到 Pi 原生 Compaction
```

手动 `/compact` 和 Context Overflow 不等待主动阈值，会立即进入压缩流程。

每份摘要必须包含 Goal、Constraints、Progress、Key Decisions、Next Steps 和 Critical Context 等必要章节；缺章节、超时或模型异常都会触发下一 fallback，而不会把残缺摘要写入会话。

## 安装

```bash
git clone https://github.com/Johnny-xuan/Live24.git
pi install ./Live24/packages/compaction
```

在已打开的 Pi 中执行：

```text
/reload
```

扩展配置位于：

```text
~/.pi/agent/compaction-models.json
```

首次使用时，如果配置文件不存在，扩展会用当前活动模型创建一份可工作的配置，默认 thinking 为 `off`。配置文件只保存 provider、模型 ID 和策略，不保存 API Key；认证仍由 Pi 的 Auth 管理。

## 添加 Compaction 模型

编辑 `~/.pi/agent/compaction-models.json`：

```json
{
  "default": "provider-a/cheap-fast-model",
  "models": [
    {
      "provider": "provider-a",
      "model": "cheap-fast-model",
      "label": "Cheap Fast Model",
      "thinkingLevel": "off",
      "fallbackLevel": 0
    },
    {
      "provider": "provider-b",
      "model": "backup-model",
      "label": "Backup Model",
      "thinkingLevel": "low",
      "fallbackLevel": 1
    }
  ],
  "trigger": {
    "contextUsagePercent": 95,
    "maximumContextTokens": 500000
  }
}
```

字段说明：

| 字段 | 作用 |
|---|---|
| `default` | 首选模型，格式必须是 `provider/model`，并存在于 `models` 中 |
| `provider` | Pi 中显示的 provider ID |
| `model` | Pi 中显示的模型 ID；可用 `pi --list-models` 查询 |
| `label` | 选择菜单里显示的名字，可省略 |
| `thinkingLevel` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |
| `fallbackLevel` | 备用顺序；首选模型失败后按数字从小到大尝试 |

`default` 模型始终最先尝试，不受它自己的 `fallbackLevel` 影响。没有 reasoning 能力的模型会自动使用 `off`；模型不支持所选 thinking level 时，扩展会降到该模型支持的级别。

修改配置后无需重启；下一次压缩或斜杠命令会重新读取配置。也可以直接运行 `/compaction-model`，立即打开模型选择器确认配置。

## 设置什么时候压缩

主动压缩阈值由两项共同决定：

```text
实际阈值 = min(
  当前模型 contextWindow × contextUsagePercent,
  maximumContextTokens
)
```

默认配置：

```json
{
  "trigger": {
    "contextUsagePercent": 95,
    "maximumContextTokens": 500000
  }
}
```

示例：

- context window 为 200K：默认在约 190K 时压缩；
- context window 为 1M：95% 是 950K，但受绝对上限约束，会在 500K 时压缩；
- 希望更早压缩：把百分比改成 `85` 或降低绝对上限；
- 希望保留更长原始上下文：提高百分比或绝对上限，但必须给模型输出和下一轮请求留足空间。

也可以用命令设置：

```text
/compaction-threshold 90 400000
```

表示达到上下文的 90%，或达到 400K token（取较早者）时主动压缩。只传百分比会保留现有绝对上限：

```text
/compaction-threshold 90
```

不传参数则查看当前值：

```text
/compaction-threshold
```

### 压缩后保留多少最近上下文

触发阈值决定“什么时候压缩”，Pi 自身的 `keepRecentTokens` 决定“压缩后留下多少最近对话”。在 `~/.pi/agent/settings.json` 中配置：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

- `keepRecentTokens: 20000`：压缩后尽量保留最近约 20K token 原文，其余旧历史进入摘要；
- `reserveTokens`：Pi 原生阈值的安全余量。扩展会在原生阈值早于自定义阈值时暂时取消那次 threshold 压缩；手动压缩和 Context Overflow 不会被取消；
- 不要把 `keepRecentTokens` 设得过大，否则压缩后仍会留下很多上下文，节省效果变弱。

## 斜杠命令

| 命令 | 作用 |
|---|---|
| `/compaction-model` | 打开模型选择器，设置首选 Compaction 模型 |
| `/compaction-model provider/model` | 不打开选择器，直接切换到配置中的指定模型 |
| `/compaction-thinking` | 打开 thinking level 选择器 |
| `/compaction-thinking low` | 直接设置当前首选模型的 thinking level |
| `/compaction-threshold` | 查看当前主动压缩阈值 |
| `/compaction-threshold 90` | 把触发比例设为 90%，保留当前绝对上限 |
| `/compaction-threshold 90 400000` | 同时设置比例和绝对 token 上限 |
| `/compact` | Pi 原生命令：立即手动压缩当前会话 |

前三组命令由本扩展提供；`/compact` 是 Pi 自带命令。

## 失败与回退

每个配置模型最多等待 5 分钟，摘要输出最多 65,536 token，同时受模型自身 `maxTokens` 限制。以下情况会自动尝试下一 fallback：

- provider 或模型当前不可用；
- 请求失败或超时；
- 模型没有正常结束；
- 摘要为空或缺少必要章节。

所有配置模型都失败后，扩展不阻止压缩，而是让 Pi 使用原生 Compaction。

## 更新与卸载

更新仓库后重新加载即可：

```text
/reload
```

卸载本地包：

```bash
pi remove ./Live24/packages/compaction
```

卸载扩展不会删除 `~/.pi/agent/compaction-models.json`，方便以后重新安装继续使用。
