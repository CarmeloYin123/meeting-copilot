import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  BookOpenText,
  ChatsCircle,
  ChartLineUp,
  CheckCircle,
  CircleNotch,
  Clock,
  GearSix,
  Lightbulb,
  Microphone,
  Moon,
  PaperPlaneTilt,
  Play,
  ShieldCheck,
  Sparkle,
  Stop,
  Sun,
  WarningCircle,
  Waveform,
} from "@phosphor-icons/react";
import {
  deleteDocument,
  generateAnswer,
  getModelInvocations,
  getSnapshot,
  importDocuments,
  listenToEvents,
  listenToTranscriptEvents,
  rebuildDocument,
  requestCapturePermissions,
  saveMeetingRecord,
  saveProfile,
  saveProviderSettings,
  startCapture,
  stopCapture,
  testBailianConnection,
  usingTauri,
} from "./lib/api";
import type {
  Answer,
  AnswerProfile,
  AnswerStreamEvent,
  AppSnapshot,
  AppView,
  KnowledgeDocument,
  MeetingRecord,
  ModelInvocation,
  TranscriptSegment,
  TranscriptStreamEvent,
  Workspace,
} from "./types";

const initialSnapshot: AppSnapshot = {
  workspaces: [],
  documents: [],
  profiles: [],
  meetingRecords: [],
  providerStatus: { asrConfigured: false, bailianConfigured: false, keyStorage: "unavailable" },
  providerSettings: {
    tencentAppId: "", tencentSecretIdConfigured: false, tencentSecretKeyConfigured: false,
    tencentAsrEndpoint: "wss://asr.cloud.tencent.com/asr/v2", bailianApiKeyConfigured: false,
    bailianEndpoint: "", embeddingModel: "text-embedding-v4", rerankModel: "qwen3-rerank",
    chatModel: "qwen3.6-plus", ocrModel: "qwen-vl-plus",
  },
};

type ProviderForm = {
  tencentAppId: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  tencentAsrEndpoint: string;
  bailianApiKey: string;
  bailianEndpoint: string;
  embeddingModel: string;
  rerankModel: string;
  chatModel: string;
  ocrModel: string;
};

type Theme = "dark" | "light";
type ProviderFeedback = { tone: "idle" | "pending" | "success" | "error"; message: string };

const demoTranscript: TranscriptSegment[] = [
  { id: "t1", sessionId: "demo", speaker: "remote", speakerLabel: "远端发言人 A", text: "你能介绍一下在企业 AI 解决方案项目中，你具体负责的工作吗？", isFinal: true, isQuestionCandidate: true, startedAt: "10:24:15" },
  { id: "t2", sessionId: "demo", speaker: "self", speakerLabel: "答题者", text: "可以，我先从客户问题和我的职责开始说明。", isFinal: true, isQuestionCandidate: false, startedAt: "10:24:21" },
  { id: "t3", sessionId: "demo", speaker: "remote", speakerLabel: "远端发言人 B", text: "也请具体说明你如何控制模型回答的准确性。", isFinal: true, isQuestionCandidate: true, startedAt: "10:25:08" },
];

const initialAnswer: Answer = {
  id: "preview",
  question: "你能介绍一下在企业 AI 解决方案项目中，你具体负责的工作吗？",
  status: "complete",
  content: "可以。这个示例项目的核心是将已有业务资料、接口能力和模型服务整合成可供一线人员使用的 AI 助手。\n\n在此类项目中，可以从三部分说明职责：第一，和业务及技术团队梳理真实使用场景、资料范围和验收口径；第二，设计知识检索、模型调用和权限边界，并协调供应商完成方案验证；第三，通过问题集和异常案例持续检查回答是否有来源、是否超出已确认能力。对于尚未确认的接口、数据权限或量化效果，应明确标为待确认，而不是直接写进承诺。",
  citations: [
    { documentId: "project", documentName: "企业 AI 方案案例示例.md", locator: "项目案例 / 职责范围", excerpt: "负责业务场景梳理、供应商协同、方案验证及模型回答质量控制。", score: 0.94 },
    { documentId: "cv", documentName: "候选人项目经历示例.pdf", locator: "项目经历示例", excerpt: "参与企业客户的 AI 解决方案设计与跨团队协同。", score: 0.81 },
  ],
  startedAt: "10:24:16",
  firstTokenMs: 1640,
  retrievalMs: 218,
};

const viewItems: Array<{ id: AppView; label: string; short: string }> = [
  { id: "live", label: "实时助手", short: "01" },
  { id: "knowledge", label: "知识库", short: "02" },
  { id: "profiles", label: "回答风格", short: "03" },
  { id: "history", label: "会话记录", short: "04" },
  { id: "observability", label: "可观测性", short: "05" },
  { id: "settings", label: "设置与隐私", short: "06" },
];

function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem("meeting-copilot-theme") === "light" ? "light" : "dark";
}

function NavigationIcon({ view }: { view: AppView }) {
  const props = { size: 18, weight: "duotone" as const, "aria-hidden": true };
  if (view === "live") return <ChatsCircle {...props} />;
  if (view === "knowledge") return <BookOpenText {...props} />;
  if (view === "profiles") return <Lightbulb {...props} />;
  if (view === "history") return <Clock {...props} />;
  if (view === "observability") return <ChartLineUp {...props} />;
  return <GearSix {...props} />;
}

function formatStatus(status: KnowledgeDocument["status"]): string {
  if (status === "ready") return "可检索";
  if (status === "indexing") return "索引中";
  if (status === "unsupported") return "不支持";
  return "失败";
}

function outputTitle(profile?: AnswerProfile): string {
  if (!profile) return "未选择回答风格";
  if (profile.style === "star") return "面试回答建议";
  if (profile.style === "business") return "商务会议建议";
  return "简洁回答建议";
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(initialSnapshot);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("interview");
  const [activeMeetingId, setActiveMeetingId] = useState("");
  const [activeView, setActiveView] = useState<AppView>("live");
  const [activeProfileId, setActiveProfileId] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer>(initialAnswer);
  const [expandedSources, setExpandedSources] = useState(false);
  const [notice, setNotice] = useState("正在加载本地工作区…");
  const [isCapturing, setIsCapturing] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSavingProviders, setIsSavingProviders] = useState(false);
  const [isTestingBailian, setIsTestingBailian] = useState(false);
  const [modelInvocations, setModelInvocations] = useState<ModelInvocation[]>([]);
  const [isRefreshingObservability, setIsRefreshingObservability] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>(() => usingTauri() ? [] : demoTranscript);
  const [providerFeedback, setProviderFeedback] = useState<ProviderFeedback>({ tone: "idle", message: "" });
  const [providerForm, setProviderForm] = useState<ProviderForm>({
    tencentAppId: "",
    tencentSecretId: "",
    tencentSecretKey: "",
    tencentAsrEndpoint: "wss://asr.cloud.tencent.com/asr/v2",
    bailianApiKey: "",
    bailianEndpoint: "",
    embeddingModel: "text-embedding-v4",
    rerankModel: "qwen3-rerank",
    chatModel: "qwen3.6-plus",
    ocrModel: "qwen-vl-plus",
  });
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const activeWorkspace = useMemo<Workspace | undefined>(
    () => snapshot.workspaces.find((workspace) => workspace.id === activeWorkspaceId),
    [activeWorkspaceId, snapshot.workspaces],
  );
  const profiles = useMemo(
    () => snapshot.profiles.filter((profile) => profile.workspaceId === activeWorkspaceId),
    [activeWorkspaceId, snapshot.profiles],
  );
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || profiles[0],
    [activeProfileId, profiles],
  );
  const documents = useMemo(
    () => snapshot.documents.filter((document) => document.workspaceId === activeWorkspaceId),
    [activeWorkspaceId, snapshot.documents],
  );
  const meetings = useMemo(
    () => snapshot.meetingRecords.filter((record) => record.workspaceId === activeWorkspaceId),
    [activeWorkspaceId, snapshot.meetingRecords],
  );
  useEffect(() => {
    let cancelled = false;
    getSnapshot()
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setProviderForm((current) => ({
          ...current,
          tencentAppId: data.providerSettings.tencentAppId,
          tencentSecretId: "",
          tencentSecretKey: "",
          tencentAsrEndpoint: data.providerSettings.tencentAsrEndpoint,
          bailianApiKey: "",
          bailianEndpoint: data.providerSettings.bailianEndpoint,
          embeddingModel: data.providerSettings.embeddingModel,
          rerankModel: data.providerSettings.rerankModel,
          chatModel: data.providerSettings.chatModel,
          ocrModel: data.providerSettings.ocrModel,
        }));
        const first = data.workspaces[0];
        if (first) setActiveWorkspaceId(first.id);
        setActiveProfileId(data.profiles.find((profile) => profile.workspaceId === first?.id)?.id || "");
        setActiveMeetingId(data.meetingRecords.find((record) => record.workspaceId === first?.id)?.id || "");
        setNotice(usingTauri() ? "本地资料库已连接" : "浏览器演示模式：请使用 Tauri 启动原生能力");
      })
      .catch((error: unknown) => setNotice("加载失败：" + String(error)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeView === "observability") void refreshModelInvocations();
  }, [activeView]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("meeting-copilot-theme", theme);
  }, [theme]);

  useEffect(() => {
    let unlisten: () => void = () => {};
    listenToEvents(handleAnswerEvent).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten();
  }, []);

  useEffect(() => {
    let unlisten: () => void = () => {};
    listenToTranscriptEvents(handleTranscriptEvent).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten();
  }, []);

  useEffect(() => {
    if (profiles.length && !profiles.some((profile) => profile.id === activeProfileId)) {
      setActiveProfileId(profiles[0].id);
    }
  }, [activeProfileId, profiles]);

  useEffect(() => {
    if (meetings.length && !meetings.some((record) => record.id === activeMeetingId)) {
      setActiveMeetingId(meetings[0].id);
    }
  }, [activeMeetingId, meetings]);

  function handleAnswerEvent(event: AnswerStreamEvent) {
    if (event.kind === "started") {
      setAnswer((current) => ({ ...current, id: event.answerId, content: "", status: "streaming", citations: [] }));
      return;
    }
    if (event.kind === "token") {
      setAnswer((current) => ({ ...current, content: current.content + (event.text || ""), status: "streaming" }));
      return;
    }
    if (event.kind === "citation" && event.citation) {
      setAnswer((current) => ({ ...current, citations: [...current.citations, event.citation!] }));
      return;
    }
    if (event.kind === "completed") {
      setAnswer((current) => ({ ...current, status: "complete", firstTokenMs: event.firstTokenMs, retrievalMs: event.retrievalMs }));
      setIsGenerating(false);
      return;
    }
    if (event.kind === "failed") {
      setAnswer((current) => ({ ...current, status: "failed", error: event.error || "云端回答失败" }));
      setIsGenerating(false);
    }
  }

  function handleTranscriptEvent(event: TranscriptStreamEvent) {
    if (event.error) {
      setNotice("实时转写失败：" + event.error);
      return;
    }
    if (event.status === "connecting") {
      setNotice("正在连接腾讯云实时 ASR…");
      return;
    }
    if (event.status === "audio-receiving") {
      setNotice(event.source === "microphone" ? "已收到本机麦克风音频，正在等待腾讯云实时转写结果…" : "已收到系统音频，正在等待腾讯云实时转写结果…");
      return;
    }
    if (event.status === "capture-started") {
      setNotice(event.source === "microphone" ? "本机麦克风采集已启动，正在等待第一段语音…" : "系统音频采集已启动，正在等待会议声音…");
      return;
    }
    if (!event.text) return;
    const speaker = event.source === "microphone" ? "self" : "remote";
    const segment: TranscriptSegment = {
      id: event.id,
      sessionId: "live",
      speaker,
      speakerLabel: speaker === "self" ? "答题者（本机麦克风）" : "远端会议音频",
      text: event.text,
      isFinal: event.isFinal,
      isQuestionCandidate: event.isQuestionCandidate,
      startedAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    };
    setTranscripts((current) => {
      const index = current.findIndex((item) => item.id === segment.id);
      if (index < 0) return [...current.slice(-39), segment];
      return current.map((item, itemIndex) => itemIndex === index ? { ...item, ...segment, startedAt: item.startedAt } : item);
    });
    if (event.isFinal && event.isQuestionCandidate) {
      setQuestion(event.text);
      setNotice("已检测到疑似问题，已填入“当前问题”；确认后可生成回答。");
    }
  }

  function runDemoAnswer(text: string) {
    const sample = activeWorkspace?.kind === "business"
      ? "建议先确认客户的业务目标、数据边界和现有系统接口。基于当前资料，可以说明我们会以知识检索、模型编排和人工确认组成受控闭环；涉及并发、数据驻留、SLA 或接口改造的具体承诺，应在客户需求澄清后确认。"
      : "可以先用一句结论回答：我负责把业务问题拆成可验证的方案路径，并推动资料、模型和交付团队形成闭环。随后按场景、具体职责、验证方法和结果展开；没有来源支持的具体数据不应补写。";
    const next: Answer = {
      id: "demo-answer-" + Date.now(),
      question: text,
      content: "",
      status: "streaming",
      citations: initialAnswer.citations,
      startedAt: new Date().toISOString(),
      retrievalMs: 180,
    };
    setAnswer(next);
    const pieces = sample.match(/.{1,12}/g) || [sample];
    pieces.forEach((piece, index) => {
      window.setTimeout(() => {
        setAnswer((current) => ({
          ...current,
          content: current.content + piece,
          firstTokenMs: index === 0 ? 640 : current.firstTokenMs,
          status: index === pieces.length - 1 ? "complete" : "streaming",
        }));
        if (index === pieces.length - 1) setIsGenerating(false);
      }, index * 70);
    });
  }

  async function submitQuestion(text = question) {
    const cleaned = text.trim();
    if (!cleaned || !activeWorkspace || !activeProfile) {
      setNotice("请输入问题并选择回答风格。");
      return;
    }
    setIsGenerating(true);
    setExpandedSources(false);
    if (!usingTauri()) {
      runDemoAnswer(cleaned);
      return;
    }
    try {
      await generateAnswer(activeWorkspace.id, activeProfile.id, cleaned, activeMeetingId || undefined);
    } catch (error) {
      setIsGenerating(false);
      setAnswer((current) => ({ ...current, status: "failed", error: String(error) }));
    }
  }

  async function toggleCapture() {
    if (isCapturing) {
      await stopCapture();
      setIsCapturing(false);
      setNotice("已停止采集；本次不会保留原始音频。");
      return;
    }
    if (!consentAccepted) {
      setNotice("开始前请确认已取得参会者对转写和云端处理的必要授权。");
      return;
    }
    try {
      const permissions = await requestCapturePermissions();
      if (!permissions.screen || !permissions.microphone) {
        setNotice("请在系统设置中授予“屏幕录制”和“麦克风”权限后重试。");
        return;
      }
      setTranscripts([]);
      await startCapture();
      setIsCapturing(true);
      setNotice("正在连接腾讯云实时 ASR 并采集系统音频与麦克风；默认不保存原始音频。");
    } catch (error) {
      setNotice("无法开始实时转写：" + readableError(error));
    }
  }

  async function chooseDocuments() {
    if (!usingTauri() || !activeWorkspace) {
      setNotice("浏览器演示模式不读取本机路径；请通过 Tauri 应用导入资料。");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: "支持的资料", extensions: ["pdf", "docx", "pptx", "xlsx", "txt", "md", "png", "jpg", "jpeg"] }],
      });
      if (!selected) return;
      setIsImporting(true);
      const paths = Array.isArray(selected) ? selected : [selected];
      const imported = await importDocuments(activeWorkspace.id, paths);
      setSnapshot((current) => {
        const newlyAdded = imported.filter((item) => !current.documents.some((document) => document.id === item.id));
        return {
          ...current,
          documents: [...imported, ...current.documents.filter((document) => !imported.some((item) => item.id === document.id))],
          workspaces: current.workspaces.map((workspace) => workspace.id === activeWorkspace.id
            ? { ...workspace, documentCount: workspace.documentCount + newlyAdded.filter((document) => document.workspaceId === workspace.id).length }
            : workspace),
        };
      });
      setNotice("已登记 " + imported.length + " 个资料；正在后台提取文字并建立索引。");
      imported
        .filter((document) => document.status === "indexing")
        .forEach((document) => { void onRebuildDocument(document.id, true); });
    } catch (error) {
      setNotice("资料未导入：" + readableError(error));
    } finally {
      setIsImporting(false);
    }
  }

  async function onDeleteDocument(documentId: string) {
    await deleteDocument(documentId);
    setSnapshot((current) => ({ ...current, documents: current.documents.filter((document) => document.id !== documentId) }));
  }

  async function onRebuildDocument(documentId: string, background = false) {
    try {
      const pending = await rebuildDocument(documentId);
      setSnapshot((current) => {
        const previous = current.documents.find((document) => document.id === documentId);
        const becameReady = previous?.status !== "ready" && pending.status === "ready";
        return {
          ...current,
          documents: current.documents.map((document) => document.id === documentId ? { ...document, ...pending } : document),
          workspaces: current.workspaces.map((workspace) => workspace.id === pending.workspaceId && becameReady
            ? { ...workspace, indexedCount: workspace.indexedCount + 1 }
            : workspace),
        };
      });
      if (!background) setNotice("索引已重建，可以用于检索回答。");
    } catch (error) {
      const message = readableError(error);
      setSnapshot((current) => ({
        ...current,
        documents: current.documents.map((document) => document.id === documentId
          ? { ...document, status: "failed", error: message }
          : document),
      }));
      setNotice("资料索引失败：" + message);
    }
  }

  async function onSaveProfile(profile: AnswerProfile) {
    const saved = await saveProfile(profile);
    setSnapshot((current) => ({
      ...current,
      profiles: current.profiles.map((item) => item.id === saved.id ? saved : item),
    }));
    setNotice("回答风格已保存。");
  }

  async function onSaveMeetingRecord(record: MeetingRecord) {
    const saved = await saveMeetingRecord(record);
    setSnapshot((current) => {
      const existing = current.meetingRecords.some((item) => item.id === saved.id);
      return {
        ...current,
        meetingRecords: existing
          ? current.meetingRecords.map((item) => item.id === saved.id ? saved : item)
          : [saved, ...current.meetingRecords],
      };
    });
    setActiveMeetingId(saved.id);
    setNotice("会议/面试信息已保存，后续回答会引用该记录。");
  }

  async function onSaveProviders() {
    const endpointError = validateWorkspaceEndpoint(providerForm.bailianEndpoint);
    if (endpointError) {
      setProviderFeedback({ tone: "error", message: endpointError });
      setNotice(endpointError);
      return false;
    }
    setIsSavingProviders(true);
    setProviderFeedback({ tone: "pending", message: "正在写入 macOS Keychain…" });
    try {
      const status = await saveProviderSettings(providerForm);
      const message = status.keyStorage === "keychain" ? "云端配置已保存到 macOS Keychain。" : "浏览器演示模式不会保存密钥。";
      setSnapshot((current) => ({ ...current, providerStatus: status }));
      setProviderFeedback({ tone: "success", message });
      setNotice(message);
      return true;
    } catch (error) {
      const message = "保存失败：" + readableError(error);
      setProviderFeedback({ tone: "error", message });
      setNotice(message);
      return false;
    } finally {
      setIsSavingProviders(false);
    }
  }

  async function onTestBailian() {
    const endpointError = validateWorkspaceEndpoint(providerForm.bailianEndpoint);
    if (endpointError) {
      setProviderFeedback({ tone: "error", message: endpointError });
      setNotice(endpointError);
      return;
    }
    if (!providerForm.bailianApiKey.trim()) {
      const message = "请先填写百炼 API Key，再保存并测试。";
      setProviderFeedback({ tone: "error", message });
      setNotice(message);
      return;
    }
    setIsTestingBailian(true);
    setProviderFeedback({ tone: "pending", message: "正在保存当前配置并请求百炼向量服务…" });
    try {
      const status = await saveProviderSettings(providerForm);
      setSnapshot((current) => ({ ...current, providerStatus: status }));
      const message = await testBailianConnection();
      setProviderFeedback({ tone: "success", message });
      setNotice(message);
    } catch (error) {
      const message = "连接测试失败：" + readableError(error);
      setProviderFeedback({ tone: "error", message });
      setNotice(message);
    } finally {
      setIsTestingBailian(false);
    }
  }

  async function refreshModelInvocations() {
    setIsRefreshingObservability(true);
    try {
      setModelInvocations(await getModelInvocations());
    } catch (error) {
      setNotice("无法读取模型调用日志：" + readableError(error));
    } finally {
      setIsRefreshingObservability(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkle size={19} weight="fill" aria-hidden="true" /></div>
          <div>
            <strong>Meeting Copilot</strong>
            <span>私有资料 · 云端推理</span>
          </div>
        </div>

        <div className="workspace-list" aria-label="工作区">
          <p className="eyebrow">工作区</p>
          {snapshot.workspaces.map((workspace) => (
            <button
              className={"workspace-button " + (activeWorkspaceId === workspace.id ? "selected" : "")}
              key={workspace.id}
              onClick={() => {
                setActiveWorkspaceId(workspace.id);
                setActiveMeetingId(snapshot.meetingRecords.find((record) => record.workspaceId === workspace.id)?.id || "");
                setActiveView("live");
              }}
            >
              <span className="workspace-dot">{workspace.kind === "interview" ? "面" : "商"}</span>
              <span><b>{workspace.name}</b><small>{workspace.indexedCount}/{workspace.documentCount} 已索引</small></span>
            </button>
          ))}
        </div>

        <nav className="navigation" aria-label="主导航">
          {viewItems.map((item) => (
            <button
              key={item.id}
              className={activeView === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setActiveView(item.id)}
            >
              <span className="nav-icon"><NavigationIcon view={item.id} /></span>
              <span className="nav-label"><small>{item.short}</small>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className={snapshot.providerStatus.keyStorage === "keychain" ? "status-dot online" : "status-dot"} />
          {snapshot.providerStatus.keyStorage === "keychain" ? "密钥库已连接" : "演示模式"}
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeWorkspace?.kind === "business" ? "商务会议工作区" : "面试准备工作区"}</p>
            <h1>{activeView === "live" ? "实时回答助手" : viewItems.find((item) => item.id === activeView)?.label}</h1>
          </div>
          <div className="topbar-session" role="status" aria-live="polite">
            <span className={isCapturing ? "session-indicator active" : "session-indicator"} />
            <Waveform className={isCapturing ? "session-wave live" : "session-wave"} size={22} weight="bold" aria-hidden="true" />
            <span>{isCapturing ? "正在捕捉语音" : "等待开始会议"}</span>
          </div>
          <div className="capture-area">
            <button
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "切换至日间模式" : "切换至夜间模式"}
              aria-label={theme === "dark" ? "切换至日间模式" : "切换至夜间模式"}
            >
              {theme === "dark" ? <Sun size={18} weight="bold" aria-hidden="true" /> : <Moon size={18} weight="fill" aria-hidden="true" />}
              <span>{theme === "dark" ? "日间" : "夜间"}</span>
            </button>
            <button className={isCapturing ? "capture-button recording" : "capture-button"} onClick={toggleCapture}>
              {isCapturing ? <Stop size={15} weight="fill" aria-hidden="true" /> : <Play size={15} weight="fill" aria-hidden="true" />}
              {isCapturing ? "停止采集" : "开始采集"}
            </button>
          </div>
        </header>

        <div className="notice" role="status">{notice}</div>

        {activeView === "live" && (
          <LiveView
            activeProfile={activeProfile}
            profiles={profiles}
            activeProfileId={activeProfileId}
            setActiveProfileId={setActiveProfileId}
            question={question}
            setQuestion={setQuestion}
            submitQuestion={submitQuestion}
            answer={answer}
            expandedSources={expandedSources}
            setExpandedSources={setExpandedSources}
            isGenerating={isGenerating}
            consentAccepted={consentAccepted}
            setConsentAccepted={setConsentAccepted}
            meetings={meetings}
            activeMeetingId={activeMeetingId}
            setActiveMeetingId={setActiveMeetingId}
            isCapturing={isCapturing}
            transcripts={transcripts}
          />
        )}
        {activeView === "knowledge" && (
          <KnowledgeView
            documents={documents}
            onChoose={chooseDocuments}
            onDelete={onDeleteDocument}
            onRebuild={onRebuildDocument}
            isImporting={isImporting}
          />
        )}
        {activeView === "profiles" && activeProfile && (
          <ProfileView profile={activeProfile} onSave={onSaveProfile} />
        )}
        {activeView === "history" && (
          <HistoryView
            workspace={activeWorkspace}
            records={meetings}
            activeRecordId={activeMeetingId}
            onActivate={(record) => {
              setActiveMeetingId(record.id);
              setActiveView("live");
            }}
            onSave={onSaveMeetingRecord}
          />
        )}
        {activeView === "observability" && (
          <ObservabilityView
            invocations={modelInvocations}
            isRefreshing={isRefreshingObservability}
            onRefresh={refreshModelInvocations}
          />
        )}
        {activeView === "settings" && (
          <SettingsView
            providerForm={providerForm}
            setProviderForm={setProviderForm}
            providerStatus={snapshot.providerStatus}
            providerSettings={snapshot.providerSettings}
            onSave={onSaveProviders}
            onTest={onTestBailian}
            isSaving={isSavingProviders}
            isTesting={isTestingBailian}
            feedback={providerFeedback}
          />
        )}
      </section>
    </main>
  );
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking command \w+:\s*/i, "").replace(/^Error:\s*/i, "");
}

function validateWorkspaceEndpoint(value: string): string | null {
  const endpoint = value.trim();
  if (!endpoint) return "请填写百炼 Workspace Endpoint。";
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return "Workspace Endpoint 必须使用 HTTPS。";
    if (url.pathname !== "/" || url.search || url.hash) {
      return "Workspace Endpoint 只填写业务空间根地址，例如 https://{workspace}.cn-beijing.maas.aliyuncs.com；不要包含 /compatible-mode/v1 或 /api/v1。";
    }
    return null;
  } catch {
    return "Workspace Endpoint 格式无效，请填写完整的 HTTPS 业务空间根地址。";
  }
}

function LiveView(props: {
  activeProfile?: AnswerProfile;
  profiles: AnswerProfile[];
  activeProfileId: string;
  setActiveProfileId: (id: string) => void;
  question: string;
  setQuestion: (value: string) => void;
  submitQuestion: (question?: string) => void;
  answer: Answer;
  expandedSources: boolean;
  setExpandedSources: (value: boolean) => void;
  isGenerating: boolean;
  consentAccepted: boolean;
  setConsentAccepted: (value: boolean) => void;
  meetings: MeetingRecord[];
  activeMeetingId: string;
  setActiveMeetingId: (id: string) => void;
  isCapturing: boolean;
  transcripts: TranscriptSegment[];
}) {
  return (
    <div className="live-layout command-layout">
      <section className="transcript-panel transcript-rail">
        <div className="panel-heading">
          <div><p className="eyebrow">实时转写</p><h2>会议语境</h2></div>
          <span className="privacy-pill">不保存原始音频</span>
        </div>
        <label className="consent-row">
          <input type="checkbox" checked={props.consentAccepted} onChange={(event) => props.setConsentAccepted(event.target.checked)} />
          <span>我已取得会议转写及必要云端处理的授权。</span>
        </label>
        <div className="transcript-list">
          {props.transcripts.map((segment) => (
            <article className={"transcript-item " + (segment.speaker === "self" ? "self" : "")} key={segment.id}>
              <div><span className="speaker-label">{segment.speakerLabel}</span><time>{segment.startedAt}</time></div>
              <p>{segment.text}</p>
              {segment.isQuestionCandidate && <span className="question-tag"><Sparkle size={11} weight="fill" aria-hidden="true" /> 疑似问题</span>}
            </article>
          ))}
          {!props.transcripts.length && <div className="transcript-empty">{props.isCapturing ? "正在等待第一段语音…" : "开始采集后，实时转写将显示在这里。"}</div>}
        </div>
        <div className="transcript-footer"><Waveform size={17} weight="bold" aria-hidden="true" /><span>{props.isCapturing ? "正在转写，实时内容将出现于此" : "开始采集后显示实时转写"}</span></div>
      </section>

      <section className="answer-panel answer-stage">
        <div className="answer-stage-header">
          <div><p className="eyebrow"><Sparkle size={13} weight="fill" aria-hidden="true" /> AI 回答</p><h2>{outputTitle(props.activeProfile)}</h2></div>
          <div className="answer-status">
            <span className={props.answer.status === "streaming" ? "status-dot online breathing" : "status-dot online"} />
            <span>{props.answer.status === "streaming" ? "流式生成中" : "准备就绪"}</span>
          </div>
        </div>

        <article className={"answer-card " + props.answer.status}>
          <div className="answer-meta">
            <span><ShieldCheck size={13} weight="fill" aria-hidden="true" /> {props.answer.status === "streaming" ? "流式输出中" : props.answer.status === "failed" ? "生成失败" : "已基于资料整理"}</span>
            {props.answer.firstTokenMs && <span>首字 {props.answer.firstTokenMs} ms</span>}
            {props.answer.retrievalMs && <span>检索 {props.answer.retrievalMs} ms</span>}
          </div>
          {props.answer.error ? <p className="error-text">{props.answer.error}</p> : <p className="answer-content">{props.answer.content || "正在根据资料检索并生成…"}</p>}
          <button className="sources-toggle" onClick={() => props.setExpandedSources(!props.expandedSources)}>
            {props.expandedSources ? "收起资料依据" : "展开资料依据"} · {props.answer.citations.length} 条
          </button>
          {props.expandedSources && (
            <div className="sources-list">
              {props.answer.citations.map((citation, index) => (
                <article className="source-item" key={citation.documentId + index}>
                  <div><b>{citation.documentName}</b><span>{citation.locator}</span></div>
                  <p>{citation.excerpt}</p>
                </article>
              ))}
            </div>
          )}
        </article>
        <div className="answer-disclaimer">回答仅基于当前会议上下文和已检索资料；缺少依据的信息会标记为待确认。</div>
      </section>

      <aside className="context-panel control-rail">
        <section className="control-group">
          <div className="control-heading"><span>回答风格</span><Lightbulb size={16} weight="duotone" aria-hidden="true" /></div>
          <select value={props.activeProfileId} onChange={(event) => props.setActiveProfileId(event.target.value)} aria-label="选择回答风格">
            {props.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </section>
        <section className="control-group meeting-control">
          <div className="control-heading"><span>当前会议记录</span><Clock size={16} weight="duotone" aria-hidden="true" /></div>
          <select value={props.activeMeetingId} onChange={(event) => props.setActiveMeetingId(event.target.value)} aria-label="选择会议或面试记录">
            <option value="">不关联登记记录</option>
            {props.meetings.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
          </select>
          <p>岗位 JD、备注及会议背景会以受控上下文参与回答。</p>
        </section>
        <section className="question-box">
          <div className="control-heading"><label htmlFor="question">当前问题</label><Microphone size={16} weight="duotone" aria-hidden="true" /></div>
          <textarea
            id="question"
            value={props.question}
            placeholder="粘贴或输入问题，也可等待实时转写自动填入。"
            onChange={(event) => props.setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                props.submitQuestion();
              }
            }}
          />
          <div className="question-actions">
            <span>⌘ ↵ 发送</span>
            <button disabled={props.isGenerating} onClick={() => props.submitQuestion()}>
              <PaperPlaneTilt size={15} weight="fill" aria-hidden="true" />
              {props.isGenerating ? "生成中" : "提问"}
            </button>
          </div>
        </section>
      </aside>
    </div>
  );
}

function KnowledgeView(props: {
  documents: KnowledgeDocument[];
  onChoose: () => void;
  onDelete: (id: string) => void;
  onRebuild: (id: string) => void | Promise<void>;
  isImporting: boolean;
}) {
  return (
    <section className="content-view">
      <div className="section-intro">
        <div><p className="eyebrow">本地加密资料库</p><h2>资料、标签与索引</h2><p>原始文件不会进入云端知识库。扫描件仅在需要 OCR 时按页发送到所选模型。</p></div>
        <button className="primary-button" disabled={props.isImporting} onClick={props.onChoose}>{props.isImporting ? "正在登记…" : "导入资料"}</button>
      </div>
      <div className="document-table" role="table">
        <div className="document-row table-header" role="row"><span>资料</span><span>状态</span><span>分段</span><span>最近更新</span><span>操作</span></div>
        {props.documents.map((document) => (
          <div className="document-row" role="row" key={document.id}>
            <span className="document-name"><b>{document.name}</b><small>{document.extension}</small>{document.error && <small className="document-error">{document.error}</small>}</span>
            <span className={"status-badge " + document.status}>{formatStatus(document.status)}</span>
            <span>{document.segmentCount}</span>
            <span>{document.updatedAt}</span>
            <span className="row-actions">
              <button onClick={() => props.onRebuild(document.id)}>重建</button>
              <button className="danger" onClick={() => props.onDelete(document.id)}>删除</button>
            </span>
          </div>
        ))}
      </div>
      <div className="callout"><b>索引规则：</b>按页、幻灯片或工作表保留来源定位；文件变化后标为待重建，删除不会影响用户原始文件。</div>
    </section>
  );
}

function ProfileView(props: { profile: AnswerProfile; onSave: (profile: AnswerProfile) => void }) {
  const [draft, setDraft] = useState(props.profile);
  useEffect(() => setDraft(props.profile), [props.profile]);
  return (
    <section className="content-view profile-view">
      <div className="section-intro"><div><p className="eyebrow">回答配置</p><h2>{draft.name}</h2><p>回答只基于检索到的资料；缺少依据时应说明待确认或请求补充。</p></div></div>
      <div className="form-grid">
        <label>配置名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>输出语言<select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value as AnswerProfile["language"] })}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英双语</option></select></label>
        <label>回答时长<select value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value as AnswerProfile["duration"] })}><option value="30s">30 秒</option><option value="60s">60 秒</option><option value="90s">90 秒</option></select></label>
        <label>组织方式<select value={draft.style} onChange={(event) => setDraft({ ...draft, style: event.target.value as AnswerProfile["style"] })}><option value="star">STAR 面试结构</option><option value="business">商务结论与待确认项</option><option value="concise">简洁直答</option></select></label>
        <label className="wide">补充要求<textarea value={draft.additionalInstructions} onChange={(event) => setDraft({ ...draft, additionalInstructions: event.target.value })} /></label>
      </div>
      <button className="primary-button" onClick={() => props.onSave(draft)}>保存回答风格</button>
    </section>
  );
}

function createRecord(workspace?: Workspace): MeetingRecord {
  const isInterview = workspace?.kind !== "business";
  const timestamp = new Date().toISOString();
  return {
    id: "record-" + Date.now(),
    workspaceId: workspace?.id || "interview",
    kind: isInterview ? "interview" : "business",
    title: isInterview ? "新建面试记录" : "新建商务会议",
    jobTitle: "",
    jobDescription: "",
    notes: "",
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function HistoryView(props: {
  workspace?: Workspace;
  records: MeetingRecord[];
  activeRecordId: string;
  onActivate: (record: MeetingRecord) => void;
  onSave: (record: MeetingRecord) => void;
}) {
  const [draft, setDraft] = useState<MeetingRecord>(() => createRecord(props.workspace));
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    setDraft(createRecord(props.workspace));
    setValidationError("");
  }, [props.workspace?.id]);

  const isInterview = draft.kind === "interview";

  function save() {
    if (!draft.title.trim() || !draft.notes.trim()) {
      setValidationError("请填写会议/面试主题和备注信息。");
      return;
    }
    if (isInterview && (!draft.jobTitle?.trim() || !draft.jobDescription?.trim())) {
      setValidationError("面试登记必须填写岗位名称和岗位 JD。");
      return;
    }
    setValidationError("");
    props.onSave({ ...draft, updatedAt: new Date().toISOString() });
  }

  return (
    <section className="content-view records-view">
      <div className="section-intro">
        <div><p className="eyebrow">会议与面试档案</p><h2>登记、查看与复用上下文</h2><p>将岗位 JD、会议主题和备注与资料库绑定；实时回答仅使用当前工作区和已选择记录。</p></div>
        <button className="secondary-button" onClick={() => setDraft(createRecord(props.workspace))}>新建记录</button>
      </div>
      <div className="records-layout">
        <section className="record-form">
          <div className="form-title"><h3>{draft.id.startsWith("record-") ? "登记新记录" : "编辑记录"}</h3><span>{isInterview ? "面试" : "商务会议"}</span></div>
          <div className="form-grid">
            <label>记录类型<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MeetingRecord["kind"] })}><option value="interview">面试</option><option value="business">商务会议</option></select></label>
            <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as MeetingRecord["status"] })}><option value="draft">草稿</option><option value="scheduled">已安排</option><option value="in_progress">进行中</option><option value="completed">已完成</option></select></label>
            <label className="wide">会议/面试主题<input value={draft.title} placeholder={isInterview ? "例如：AI 解决方案架构师 · 一面" : "例如：客户 AI 方案交流"} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            {isInterview && <label>岗位名称<input value={draft.jobTitle || ""} placeholder="例如：AI 解决方案架构师" onChange={(event) => setDraft({ ...draft, jobTitle: event.target.value })} /></label>}
            <label>计划时间<input value={draft.scheduledAt || ""} placeholder="2026-08-04 14:30" onChange={(event) => setDraft({ ...draft, scheduledAt: event.target.value })} /></label>
            {isInterview && <label className="wide">岗位 JD<textarea value={draft.jobDescription || ""} placeholder="填写职位职责、任职要求、技术/业务重点。会作为回答的场景约束，不会替代知识库事实。" onChange={(event) => setDraft({ ...draft, jobDescription: event.target.value })} /></label>}
            <label className="wide">备注信息<textarea value={draft.notes} placeholder={isInterview ? "例如：重点准备项目经验、技术问题和业务成果。" : "例如：客户背景、待确认问题、沟通目标。"} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
          </div>
          {validationError && <p className="error-text">{validationError}</p>}
          <button className="primary-button" onClick={save}>保存并关联当前工作区</button>
        </section>

        <section className="record-list">
          <div className="list-heading"><h3>已登记记录</h3><span>{props.records.length} 条</span></div>
          {props.records.map((record) => (
            <article className={"record-item " + (props.activeRecordId === record.id ? "selected" : "")} key={record.id}>
              <div className="record-item-top"><span className="status-badge ready">{record.kind === "interview" ? "面试" : "会议"}</span><small>{record.scheduledAt || "未安排时间"}</small></div>
              <h4>{record.title}</h4>
              {record.jobTitle && <p>岗位：{record.jobTitle}</p>}
              <p>{record.notes}</p>
              <div><button onClick={() => setDraft(record)}>编辑</button><button className="text-action" onClick={() => props.onActivate(record)}>用于实时回答</button></div>
            </article>
          ))}
          {!props.records.length && <div className="empty-state">当前工作区还没有登记记录。</div>}
        </section>
      </div>
      <div className="metric-grid">
        <article><span>问题结束至首字</span><b>1.64 s</b><small>目标 P95 ≤ 3.00 s</small></article>
        <article><span>本次检索</span><b>218 ms</b><small>FTS、向量召回与重排</small></article>
        <article><span>转写记录</span><b>本机保存</b><small>原始音频未保留</small></article>
      </div>
    </section>
  );
}

function ObservabilityView(props: {
  invocations: ModelInvocation[];
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const [status, setStatus] = useState<"all" | ModelInvocation["status"]>("all");
  const [model, setModel] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const models = useMemo(() => [...new Set(props.invocations.map((item) => item.model))], [props.invocations]);
  const filtered = useMemo(() => props.invocations.filter((item) => {
    return (status === "all" || item.status === status) && (model === "all" || item.model === model);
  }), [model, props.invocations, status]);
  const selected = filtered.find((item) => item.id === selectedId) || filtered.find((item) => item.status === "failed") || filtered[0];
  const completed = props.invocations.filter((item) => item.status !== "running");
  const successful = props.invocations.filter((item) => item.status === "success").length;
  const averageLatency = completed.length
    ? Math.round(completed.reduce((total, item) => total + (item.durationMs || 0), 0) / completed.length)
    : 0;
  const failures = props.invocations.filter((item) => item.status === "failed").length;

  return (
    <section className="content-view observability-view">
      <div className="section-intro observability-intro">
        <div>
          <p className="eyebrow">本机调用审计</p>
          <h2>模型可观测性</h2>
          <p>查看每一次云模型调用的状态、耗时、用量估算与错误原因。不会记录密钥、提示词正文、资料内容或原始音频。</p>
        </div>
        <button className="secondary-button" onClick={props.onRefresh} disabled={props.isRefreshing}>
          {props.isRefreshing ? <><CircleNotch className="spin" size={15} aria-hidden="true" />刷新中…</> : "刷新日志"}
        </button>
      </div>

      <div className="observability-metrics" aria-label="调用摘要">
        <article><span>已记录调用</span><b>{props.invocations.length}</b><small>最近 200 条本机记录</small></article>
        <article><span>成功率</span><b>{completed.length ? Math.round(successful / completed.length * 100) : 0}%</b><small>{successful} 次成功 / {completed.length} 次已结束</small></article>
        <article><span>平均耗时</span><b>{formatDuration(averageLatency)}</b><small>仅统计已结束调用</small></article>
        <article className={failures ? "metric-alert" : ""}><span>失败调用</span><b>{failures}</b><small>{failures ? "可在下方查看错误详情" : "当前没有失败记录"}</small></article>
      </div>

      <div className="observability-toolbar">
        <div className="filter-group" aria-label="调用日志筛选">
          <label>状态<select value={status} onChange={(event) => setStatus(event.target.value as "all" | ModelInvocation["status"])}><option value="all">全部状态</option><option value="success">成功</option><option value="failed">失败</option><option value="running">进行中</option></select></label>
          <label>模型<select value={model} onChange={(event) => setModel(event.target.value)}><option value="all">全部模型</option>{models.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        </div>
        <span className="observability-hint">用量为本机估算值，不等同于云服务账单。</span>
      </div>

      <div className="observability-layout">
        <section className="invocation-table-wrap">
          <div className="invocation-table" role="table" aria-label="模型调用日志">
            <div className="invocation-row invocation-header" role="row"><span>模型 / 操作</span><span>状态</span><span>耗时</span><span>用量估算</span><span>发生时间</span></div>
            {filtered.map((item) => (
              <button className={"invocation-row " + (selected?.id === item.id ? "selected" : "")} role="row" key={item.id} onClick={() => setSelectedId(item.id)}>
                <span className="invocation-model"><b>{item.model}</b><small>{item.provider} · {item.operation}</small></span>
                <span><InvocationStatus status={item.status} /></span>
                <span className="invocation-duration">{item.durationMs === undefined ? "—" : formatDuration(item.durationMs)}</span>
                <span className="invocation-usage"><b>↓ {formatCount(item.inputCount)} {item.inputUnit}</b><small>↑ {formatCount(item.outputCount)} {item.outputUnit}</small></span>
                <span className="invocation-time">{formatInvocationTime(item.startedAt)}</span>
              </button>
            ))}
          </div>
          {!filtered.length && <div className="empty-state observability-empty">还没有符合筛选条件的调用记录。完成一次资料索引、生成回答、OCR 或实时转写后会自动出现。</div>}
        </section>
        <aside className="invocation-detail">
          {selected ? <>
            <div className="detail-heading"><div><span className="eyebrow">调用详情</span><h3>{selected.operation}</h3></div><InvocationStatus status={selected.status} /></div>
            <dl>
              <div><dt>服务 / 模型</dt><dd>{selected.provider} · {selected.model}</dd></div>
              <div><dt>开始时间</dt><dd>{formatInvocationTime(selected.startedAt, true)}</dd></div>
              <div><dt>调用耗时</dt><dd>{selected.durationMs === undefined ? "进行中" : formatDuration(selected.durationMs)}</dd></div>
              <div><dt>输入用量</dt><dd>{formatCount(selected.inputCount)} {selected.inputUnit}</dd></div>
              <div><dt>输出用量</dt><dd>{formatCount(selected.outputCount)} {selected.outputUnit}</dd></div>
            </dl>
            {selected.error ? <div className="invocation-error"><b>错误详情</b><pre>{selected.error}</pre></div> : <div className="invocation-success"><CheckCircle size={17} weight="fill" aria-hidden="true" />调用已完成；本地未保存请求正文。</div>}
          </> : <div className="empty-state">选择一条调用记录以查看详情。</div>}
        </aside>
      </div>
    </section>
  );
}

function InvocationStatus({ status }: { status: ModelInvocation["status"] }) {
  const label = status === "success" ? "成功" : status === "failed" ? "失败" : "进行中";
  return <span className={"invocation-status " + status}><i />{label}</span>;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(durationMs: number): string {
  if (!durationMs) return "0 ms";
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 1 : 2)} s` : `${durationMs} ms`;
}

function formatInvocationTime(value: string, detailed = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", detailed
    ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    : { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function SettingsView(props: {
  providerForm: ProviderForm;
  setProviderForm: Dispatch<SetStateAction<ProviderForm>>;
  providerStatus: AppSnapshot["providerStatus"];
  providerSettings: AppSnapshot["providerSettings"];
  onSave: () => void | Promise<boolean>;
  onTest: () => void | Promise<void>;
  isSaving: boolean;
  isTesting: boolean;
  feedback: ProviderFeedback;
}) {
  function setField(field: string, value: string) {
    props.setProviderForm({ ...props.providerForm, [field]: value } as ProviderForm);
  }
  return (
    <section className="content-view settings-view">
      <div className="section-intro"><div><p className="eyebrow">连接与隐私</p><h2>云模型与本机保护</h2><p>密钥由 macOS Keychain 保存，应用日志和界面均不会回显密钥。</p></div><span className="privacy-pill">{props.providerStatus.keyStorage === "keychain" ? "Keychain 已启用" : "等待原生应用"}</span></div>
      <div className="provider-grid">
        <section className="provider-card"><h3>腾讯云 · 实时 ASR</h3><p>用于中英混合音频的 WebSocket 实时转写，可替换为兼容适配器端点。</p><label>AppId<input value={props.providerForm.tencentAppId} onChange={(event) => setField("tencentAppId", event.target.value)} /></label><label>SecretId<input type="password" value={props.providerForm.tencentSecretId} placeholder={props.providerSettings.tencentSecretIdConfigured ? "已保存；留空则保持不变" : "尚未配置"} onChange={(event) => setField("tencentSecretId", event.target.value)} /></label><label>SecretKey<input type="password" value={props.providerForm.tencentSecretKey} placeholder={props.providerSettings.tencentSecretKeyConfigured ? "已保存；留空则保持不变" : "尚未配置"} onChange={(event) => setField("tencentSecretKey", event.target.value)} /></label><label>ASR Endpoint<input value={props.providerForm.tencentAsrEndpoint} onChange={(event) => setField("tencentAsrEndpoint", event.target.value)} /></label></section>
        <section className="provider-card"><h3>阿里云百炼 · RAG 与生成</h3><p>用于 OCR、向量、重排和流式 Qwen 回答。模型名可按已开通的模型直接替换。</p><label>API Key<input type="password" value={props.providerForm.bailianApiKey} placeholder={props.providerSettings.bailianApiKeyConfigured ? "已保存；留空则保持不变" : "尚未配置"} onChange={(event) => setField("bailianApiKey", event.target.value)} /><small className="field-hint">为避免前端读取密钥，已保存的 Key 不会回显；重新填写可替换它。</small></label><label>Workspace Endpoint<input placeholder="https://{workspace}.cn-beijing.maas.aliyuncs.com" value={props.providerForm.bailianEndpoint} onChange={(event) => setField("bailianEndpoint", event.target.value)} /><small className="field-hint">仅填写业务空间根地址，不要包含 <code>/compatible-mode/v1</code> 或 <code>/api/v1</code>。</small></label><label>Embedding Model<input value={props.providerForm.embeddingModel} onChange={(event) => setField("embeddingModel", event.target.value)} /></label><label>Rerank Model<input value={props.providerForm.rerankModel} onChange={(event) => setField("rerankModel", event.target.value)} /></label><label>Chat Model<input value={props.providerForm.chatModel} onChange={(event) => setField("chatModel", event.target.value)} /></label><label>OCR Model<input value={props.providerForm.ocrModel} onChange={(event) => setField("ocrModel", event.target.value)} /></label></section>
      </div>
      <div className="settings-actions"><button className="primary-button" disabled={props.isSaving || props.isTesting} onClick={props.onSave}>{props.isSaving ? <><CircleNotch className="spin" size={15} aria-hidden="true" />保存中…</> : "保存到 Keychain"}</button><button className="secondary-button" disabled={props.isSaving || props.isTesting} onClick={props.onTest}>{props.isTesting ? <><CircleNotch className="spin" size={15} aria-hidden="true" />测试中…</> : "保存并测试百炼"}</button></div>
      {props.feedback.tone !== "idle" && <div className={"provider-feedback " + props.feedback.tone} role="status" aria-live="polite">{props.feedback.tone === "pending" && <CircleNotch className="spin" size={16} aria-hidden="true" />}{props.feedback.tone === "success" && <CheckCircle size={16} weight="fill" aria-hidden="true" />}{props.feedback.tone === "error" && <WarningCircle size={16} weight="fill" aria-hidden="true" />}<span>{props.feedback.message}</span></div>}
      <div className="callout"><b>同意与边界：</b>开始采集前必须取得必要授权。远端多人只显示匿名标签；应用不提供隐蔽录制、规避检测或自动跨供应商切换。</div>
    </section>
  );
}
