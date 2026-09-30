# dsh-mimo-tts

**给 DeepSeek Harness 的小米 MiMo 语音插件** —— 把回复念出来、在输入框里说话、随时切换音色，还能用一段短录音克隆你自己的声音。
[English](README.md)

她说话和听话都走 **小米 MiMo**（合成 TTS + 识别 ASR），用的是 token-plan 端点，也就是你 LLM provider 已经在用的那把 key。除了发给小米自己的 API，数据不出本机。

## 能做什么

| | |
|---|---|
| 🔊 **自动朗读** | 每段回答说完就念出来。念之前会剥掉代码块、表格、链接和 markdown 符号，长文按上限截断，免得一段文字念三分钟。 |
| 🎙 **点一下说话** | 输入框右侧控件行里有个麦克风按钮（就在模型选择器旁边）。点一下开始，再点一下结束 —— 或者说完停顿一下就自动结束 —— 识别出来的文字直接落进输入框，按回车发送。 |
| ⏹ **停止** | 她一开始说话，麦克风旁就出现红色停止按钮，`Esc` 同样有效。停止会**连同后面排队的句子一起丢掉**；你点麦克风开口时，她也会自动闭嘴。 |
| 🗣 **音色** | MiMo 的 9 个内置音色，外加一个**克隆音色**槽位（用本机 5～15 秒参考音频驱动）。 |
| 🎛 **面板** | *插件 → MiMo 语音*（*设置 → 内置插件* 里也有）：切音色并当场试听、开关自动朗读、打字试听、重念最后一条、查看队列与状态。 |

## 前置条件

- DeepSeek Harness **0.2.0-rc.1 或更新**（`engines.dsh`）
- 一把小米 MiMo **token-plan** key，来源二选一：
  - 环境变量 `XIAOMI_TOKEN_PLAN_CN_API_KEY`，或
  - `$DSH_HOME/.credentials.yaml` 的 `refs:` 段（和宿主 LLM provider 读的是同一处）。
- key 只发给 `token-plan-cn.xiaomimimo.com`。注意：token-plan 的 key **不能**用于公开的 `api.xiaomimimo.com`，反之亦然。

## 安装

```bash
dsh plugin --profile web add dsh-mimo-tts      # 或 --profile desktop
# 重启宿主（dsh web / 桌面端）
```

## 用法

1. **自动朗读**：在面板里打开一次即可，之后每段回答都会排队依次念出。
2. **说话**：点输入框里的麦克风 → 说话 → 停顿（或再点一下）→ 文字进输入框 → 回车发送。
3. **停止**：点红色停止按钮，或按 `Esc`。

## 音色与克隆

内置 9 个音色：`mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean。

想用自己的声音，就放一段 **5～15 秒、干净、单人**的音频到：

```
$DSH_HOME/.dsh-mimo-tts/voice-clone.mp3      # mp3 或 wav
```

然后在面板里选 **「克隆音色」**。宿主直接读这个文件；它不会被打进插件包，除了每次请求必须携带的参考样本之外也不会离开你的机器。

> 克隆会带来延迟：每次请求都要带上参考样本（10 秒约 105 KB），所以一句话约 3 秒，而内置音色约 1 秒。另外请只克隆你有权使用的声音。

## 配置

`$DSH_HOME/.dsh-mimo-tts/config.json`（面板会写这个文件）：

```jsonc
{
  "voice": "冰糖",       // 任意内置音色，或克隆槽位
  "autoRead": true,      // 每段回答都念
  "maxChars": 600,       // 念之前截断长文
  "format": "mp3"        // mp3 | wav
}
```

## HTTP 接口

全部挂在宿主 webserver 的 `/dsh-mimo-tts` 前缀下：

| 路由 | 作用 |
|---|---|
| `GET /status` | key 是否存在、模型名、音色列表、克隆样本状态、队列深度 |
| `GET /voices` | 音色列表 |
| `POST /config` | `{ voice?, autoRead?, maxChars? }` |
| `POST /speak` | `{ text, voice?, queue? }` → 音频（data URL） |
| `POST /speak-last` | 念某个会话最后一条完成的回答 |
| `POST /asr` | 原始 `audio/wav`（16 kHz 单声道）或 `audio/mpeg` → `{ text }` |
| `GET /pending?since=N` | 拉取自动朗读队列（游标式，不会重复播） |
| `POST /stop` | 立刻停止：前端暂停，宿主清空队列 |

**安全**：带跨站 `Origin` 的请求一律 `403`；loopback、`dsh-app://`、`file://` 以及不带 Origin 的调用方放行。若你的部署从别的主机提供 GUI，可用 `DSH_MIMO_TTS_ORIGINS` 追加白名单。

## 开发

```bash
node test/smoke.mjs                       # 离线：路由、同源防护、文本清洗、参数校验
DSH_MIMO_TTS_LIVE=1 node test/smoke.mjs   # 额外跑一次真实合成 + 识别
```

浏览器半区（`lib/client.js`）是手写的 `__ModuleLoader__` 包，**没有构建步骤**，React 由宿主的模块表提供。

## 许可

MIT，见 [LICENSE](LICENSE)。
