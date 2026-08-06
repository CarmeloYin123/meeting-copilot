# Meeting Copilot

面向销售、售前等前端业务人员的 macOS 本地会议助手，也可用于面试及其他需要即时组织表达的场景。应用在本机维护资料、转写、答案与模型调用审计；云端模型由用户使用自己的 API Key 直连，默认不保存原始音频。

> 在会议中，将分散的资料转换为可追溯、可编辑的回答建议；回答仅供用户参考，不会代替用户发言、发送消息或作出对外承诺。

## 项目介绍

[产品项目介绍](docs/product-introduction.zh-CN.md) 说明了产品设计初衷、目标用户与痛点、产品定位、核心设计思路及未来迭代方向。

当前构建版本：`0.1.8`（Apple Silicon / macOS 14+）。此版本完成了本机麦克风实时转写链路的缓冲与零音频诊断修复；真实端到端效果仍取决于系统权限、当前输入设备、网络和用户的腾讯云配置。

## V1 已实现范围

- 面试准备、商务会议两个隔离工作区；资料、回答风格和会话记录按工作区保存。
- 会议/面试记录管理；可登记岗位名称、岗位 JD、备注和会议背景，并将其作为回答上下文。
- 本地资料导入、分段、全文/向量混合检索、来源定位、删除和重建索引。
- PDF 本地文字提取；图片及扫描件按需调用云端 OCR。原文件不上传至托管知识库。
- 腾讯云实时 ASR；百炼 Embedding、Rerank、OCR 和 Qwen 流式回答适配。
- 打包的本地 Web UI：实时转写、疑似问题、中央答案画布、来源展开、回答模板、日/夜主题和隐私状态。
- macOS 原生音频桥接：ScreenCaptureKit 采集获授权的系统音频，AVAudioEngine 独立采集本机麦克风。
- 模型可观测性：查看 ASR、OCR、向量、重排和生成调用的状态、耗时、本机估算用量及脱敏错误摘要。

## 安装与更新

每个 DMG 文件名均携带版本号，例如 `Meeting Copilot_0.1.8_aarch64.dmg`。

1. 退出正在运行的旧版 Meeting Copilot，并弹出旧 DMG。
2. 打开新版 DMG，将 `Meeting Copilot.app` 拖入“应用程序”目录；如提示，选择替换旧版本。
3. 从“应用程序”启动，而不是直接从挂载的 DMG 中运行。
4. 首次采集时，在“系统设置 → 隐私与安全性”中授予 **麦克风** 和 **屏幕录制** 权限，并确认已获得参会者的必要授权。

首版未做 Developer ID 签名和公证时，macOS 可能要求通过 Finder 右键“打开”完成首次启动确认。

## 实时转写工作方式

```text
系统音频（ScreenCaptureKit） ─┐
                              ├─ MeetingCaptureBridge ─ 16 kHz / 单声道 PCM
本机麦克风（AVAudioEngine） ──┘                         │
                                                        ▼
                                  Rust 缓冲与腾讯云实时 ASR WebSocket
                                                        ▼
                                  转写事件 / 问题候选 / 本地 RAG 回答
```

麦克风按照 macOS 实际硬件格式采集，再转换为 16 kHz、单声道 PCM；不会强制 tap 使用某个硬件不支持的格式。ASR WebSocket 建连期间，Rust 保留最多 160 帧音频，避免用户刚点击“开始采集”就说话时丢失开头语音。

本机麦克风固定标为“答题者”。系统音频只能代表匿名远端发言片段，不能可靠识别远端真实姓名。

## 提供商配置

在“设置与隐私”页配置：

| 能力 | 默认提供商 | 必填配置 |
| --- | --- | --- |
| 实时 ASR | 腾讯云 | AppId、SecretId、SecretKey、WebSocket Endpoint |
| 向量、重排、OCR、回答 | 阿里云百炼 | API Key、Workspace Endpoint、已开通的模型名 |

默认模型名可替换：Embedding `text-embedding-v4`、Rerank `qwen3-rerank`、Chat `qwen3.6-plus`、OCR `qwen-vl-plus`。模型名、地域与 Endpoint 必须与账户实际开通情况一致。

密钥保存在 macOS Keychain，不返回给前端，不写入导出、调用日志或仓库。调用审计只记录模型元数据、时长、估算计数和紧凑错误摘要；不记录密钥、原始 PCM、提示词正文、资料正文或转写正文。

## 实时转写验收与排障

开始采集后，完整说一句话并等待约 2 秒再停止。进入“可观测性”，选择“实时语音转写（本机麦克风）”查看结果。

| 观测结果 | 含义 | 下一步 |
| --- | --- | --- |
| 输入音频秒数大于 0，且有输出字符 | 本机采集与腾讯 ASR 已产生结果 | 继续验证问题检测与 RAG 回答。 |
| `未收到可上传的 16 kHz PCM 音频帧` | 腾讯连接可以建立，但本机采集链路未产生有效帧 | 检查麦克风权限、系统输入设备、静音状态及是否有应用独占麦克风。 |
| 腾讯云 4002 | AppId 与鉴权签名中的 AppId 不一致 | 核对设置页的 AppId、SecretId、SecretKey 是否来自同一腾讯云项目。 |
| 腾讯云 4008 | 已建立 ASR 连接但长时间未上传音频 | 保持采集状态并检查本机音频输入、系统权限和桥接错误。 |
| 连接/握手超时 | 网络或 Endpoint 无法访问 | 检查网络、企业代理、防火墙和 `wss://` Endpoint。 |

“成功但输入 0 音频秒”在 `0.1.8` 起不再被视为成功，会作为可操作的采集失败显示。

## 本地开发

前置条件：Rust stable、完整 Xcode（含命令行工具）和 Node.js 18+。

```bash
npm install
npm run tauri -- dev
```

`npm run dev` 仅启动前端演示模式；资料库、Keychain、原生音频和云模型调用必须通过 Tauri 运行。`npm run build` 会先构建 Swift 原生桥接，再构建 TypeScript/Vite 前端。

## 验证与打包

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run build:native-bridges
npx tsc -b && npx vite build
npm run tauri -- build
hdiutil verify "src-tauri/target/release/bundle/dmg/Meeting Copilot_0.1.8_aarch64.dmg"
```

打包前必须同步更新 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 的版本，确保 DMG 名称、应用版本与代码版本一致。

## 已知边界

- “问题结束至答案首字 P95 ≤ 3 秒”是待压测工程目标，不是当前承诺；其受网络、资料规模、上下文长度与模型配置影响。
- 系统音频与本机麦克风为两路独立流。系统音频受屏幕录制授权、会议软件输出路径和 macOS 路由影响，需在真实会议软件中单独验收。
- 首版不含账号体系、团队协作、云端同步、统一计费、托管模型代理或自动跨供应商故障切换。
- 应用不提供隐蔽录音、规避会议平台检测或绕过参会者知情的功能。

详见 [架构与数据边界](docs/architecture.md)。
