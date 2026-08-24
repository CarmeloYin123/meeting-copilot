import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  ChatsCircle,
  ChartLineUp,
  CheckCircle,
  CircleNotch,
  Clock,
  CornersIn,
  CornersOut,
  DownloadSimple,
  FileText,
  GearSix,
  Lightbulb,
  Microphone,
  Moon,
  PaperPlaneTilt,
  Play,
  Plus,
  ShieldCheck,
  Sparkle,
  Stop,
  Sun,
  WarningCircle,
  Waveform,
} from "@phosphor-icons/react";
import {
  deleteDocument,
  deleteMeetingRecord,
  exportMarkdown,
  generateAnswer,
  getModelInvocations,
  getSnapshot,
  importDocuments,
  listenToEvents,
  listenToTranscriptEvents,
  prefetchQuestion,
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
  QuestionPrefetch,
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
type AudioHealth = { frames: number; seconds: number; state: "idle" | "starting" | "healthy" | "changed" };

const demoTranscript: TranscriptSegment[] = [
  { id: "t1", sessionId: "demo", speaker: "remote", speakerLabel: "远端发言人 A", text: "这套智能客服平台的整体架构是什么？", isFinal: true, isQuestionCandidate: true, startedAt: "10:24:15" },
  { id: "t2", sessionId: "demo", speaker: "self", speakerLabel: "本机发言", text: "我先从业务接入、知识检索和受控生成三个部分说明。", isFinal: true, isQuestionCandidate: false, startedAt: "10:24:21" },
  { id: "t3", sessionId: "demo", speaker: "remote", speakerLabel: "远端发言人 B", text: "私有化部署和现有系统对接如何处理？", isFinal: true, isQuestionCandidate: true, startedAt: "10:25:08" },
];

const initialAnswer: Answer = {
  id: "preview",
  question: "这套智能客服平台的整体架构是什么？",
  status: "complete",
  content: "建议按“渠道接入、智能服务、运营治理”三层说明。前端可接入 App、网页、微信等客户触点；中间层通过意图识别、知识检索和受控大模型生成回答；后端对接券商现有账户、业务办理和工单等系统，并通过知识运营、质检和人工兜底保证回答可追溯。\n\n对于私有化部署、数据驻留、并发规模和具体系统接口，应结合贵司现网架构、数据范围及安全要求进一步确认后再形成实施方案。",
  citations: [
    { documentId: "case", documentName: "AI解决方案与案例.pptx", locator: "方案架构 / 智能客服平台", excerpt: "通过渠道接入、知识检索、模型服务与运营治理构成受控闭环。", score: 0.94 },
    { documentId: "proposal", documentName: "客户需求与交流纪要.docx", locator: "部署与集成要求", excerpt: "私有化部署、数据边界与业务系统接口需在需求澄清后确认。", score: 0.81 },
  ],
  startedAt: "10:24:16",
  firstTokenMs: 1640,
  retrievalMs: 218,
};

const idleAnswer: Answer = {
  id: "idle",
  question: "",
  status: "idle",
  content: "",
  citations: [],
  startedAt: "",
};

const viewItems: Array<{ id: AppView; label: string; short: string }> = [
  { id: "live", label: "实时助手", short: "01" },
  { id: "knowledge", label: "知识库", short: "02" },
  { id: "profiles", label: "回答风格", short: "03" },
  { id: "history", label: "会议", short: "04" },
  { id: "review", label: "深度复盘", short: "05" },
  { id: "observability", label: "可观测性", short: "06" },
  { id: "settings", label: "设置与隐私", short: "07" },
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
  if (view === "review") return <FileText {...props} />;
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
  if (profile.style === "business") return "商务会议建议";
  return "简洁回答建议";
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(initialSnapshot);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("business");
  const [activeMeetingId, setActiveMeetingId] = useState("");
  const [activeView, setActiveView] = useState<AppView>("live");
  const [activeProfileId, setActiveProfileId] = useState("");
  const [question, setQuestion] = useState("");
  const [questionPrefetch, setQuestionPrefetch] = useState<QuestionPrefetch | null>(null);
  const [answer, setAnswer] = useState<Answer>(() => usingTauri() ? idleAnswer : initialAnswer);
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
  const [audioHealth, setAudioHealth] = useState<Record<"microphone" | "system", AudioHealth>>({
    microphone: { frames: 0, seconds: 0, state: "idle" },
    system: { frames: 0, seconds: 0, state: "idle" },
  });
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

  const workspaces = useMemo(
    () => snapshot.workspaces.filter((workspace) => workspace.kind === "business"),
    [snapshot.workspaces],
  );
  const activeWorkspace = useMemo<Workspace | undefined>(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId),
    [activeWorkspaceId, workspaces],
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
        const first = data.workspaces.find((workspace) => workspace.kind === "business");
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
  }, [activeMeetingId, activeWorkspaceId]);

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
      setAudioHealth((current) => ({ ...current, [event.source]: { ...current[event.source], state: "starting" } }));
      setNotice(event.source === "microphone" ? "本机麦克风采集已启动，正在等待第一段语音…" : "系统音频采集已启动，正在等待会议声音…");
      return;
    }
    if (event.status === "audio-healthy") {
      setAudioHealth((current) => ({
        ...current,
        [event.source]: {
          frames: event.audioFrames || current[event.source].frames,
          seconds: event.audioSeconds || current[event.source].seconds,
          state: "healthy",
        },
      }));
      return;
    }
    if (event.status === "device-changed") {
      setAudioHealth((current) => ({ ...current, [event.source]: { ...current[event.source], state: "changed" } }));
      setNotice("检测到麦克风设备或音频格式变化；如转写中断，请暂停后重新开始采集。");
      return;
    }
    if (event.status === "bridge-released") {
      setNotice("音频桥接已释放，macOS 系统共享状态将同步关闭。");
      return;
    }
    if (!event.text) return;
    const speaker = event.source === "microphone" ? "self" : "remote";
    const segment: TranscriptSegment = {
      id: event.id,
      sessionId: "live",
      speaker,
      speakerLabel: speaker === "self" ? "本机发言（麦克风）" : "远端会议音频",
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
    if (event.source === "system" && event.isFinal && event.isQuestionCandidate) {
      beginCandidatePrefetch(event.text);
    }
  }

  function beginCandidatePrefetch(text: string) {
    const cleaned = text.trim();
    if (!cleaned) return;
    setQuestion(cleaned);
    const candidate: QuestionPrefetch = {
      id: "",
      question: cleaned,
      status: "prefetching",
      evidenceCount: 0,
      retrievalMs: 0,
      citations: [],
    };
    setQuestionPrefetch(candidate);
    setNotice("已选择疑似问题，正在本次会议资料范围内预检索；不会自动生成回答。");
    void prefetchQuestion(activeWorkspaceId, cleaned, activeMeetingId || undefined)
      .then((result) => {
        setQuestionPrefetch((current) => current?.question === result.question ? result : current);
        setNotice(result.status === "ready"
          ? `候选预检索完成：找到 ${result.evidenceCount} 条依据，请确认是否生成回答。`
          : "候选预检索完成，但本次资料范围没有足够依据；确认后将给出缺少依据提示。");
      })
      .catch((error) => {
        const message = readableError(error);
        setQuestionPrefetch((current) => current && current.question === cleaned
          ? { ...current, status: "failed", error: message }
          : current);
        setNotice("候选预检索失败：" + message);
      });
  }

  function runDemoAnswer(text: string) {
    const sample = "建议先确认客户的业务目标、数据边界和现有系统接口。基于当前资料，可以说明我们会以知识检索、模型编排和人工确认组成受控闭环；涉及并发、数据驻留、SLA 或接口改造的具体承诺，应在客户需求澄清后确认。";
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

  async function submitQuestion(text = question, requestedPrefetchId?: string) {
    const cleaned = text.trim();
    if (!cleaned || !activeWorkspace || !activeProfile) {
      setNotice("请输入问题并选择回答风格。");
      return;
    }
    setIsGenerating(true);
    setExpandedSources(false);
    setAnswer((current) => ({ ...current, question: cleaned, error: undefined }));
    const reusablePrefetchId = requestedPrefetchId
      || (questionPrefetch?.question.trim() === cleaned ? questionPrefetch.id : undefined);
    if (!usingTauri()) {
      runDemoAnswer(cleaned);
      setQuestionPrefetch(null);
      return;
    }
    try {
      await generateAnswer(activeWorkspace.id, activeProfile.id, cleaned, activeMeetingId || undefined, reusablePrefetchId || undefined);
      setQuestionPrefetch(null);
    } catch (error) {
      setIsGenerating(false);
      setAnswer((current) => ({ ...current, status: "failed", error: String(error) }));
    }
  }

  async function toggleCapture() {
    if (isCapturing) {
      try {
        const result = await stopCapture();
        setIsCapturing(false);
        setNotice(result.outcome === "forced"
          ? "未收到桥接释放确认，已执行强制结束兜底；请在“可观测性”查看详情，并确认 macOS 共享状态已关闭。"
          : "桥接已释放，已停止采集；本次不会保留原始音频。");
      } catch (error) {
        setNotice("无法确认音频桥接已停止，采集状态保持不变：" + readableError(error));
      }
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
      setAudioHealth({
        microphone: { frames: 0, seconds: 0, state: "starting" },
        system: { frames: 0, seconds: 0, state: "starting" },
      });
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
    setNotice("会议配置已保存；后续回答只会使用该会议勾选的资料范围。");
  }

  async function onDeleteMeetingRecord(record: MeetingRecord) {
    if (!window.confirm(`确认删除会议“${record.title}”及其配置快照吗？知识库原文件不会被删除。`)) return;
    try {
      await deleteMeetingRecord(record.id);
      setSnapshot((current) => ({ ...current, meetingRecords: current.meetingRecords.filter((item) => item.id !== record.id) }));
      if (activeMeetingId === record.id) setActiveMeetingId("");
      setNotice("会议配置已删除；知识库资料未受影响。");
    } catch (error) {
      setNotice("会议删除失败：" + readableError(error));
    }
  }

  async function onExportReview(record: MeetingRecord) {
    const selectedDocuments = snapshot.documents.filter((document) => record.knowledgeScope.includes(document.id));
    const meetingTranscripts = transcripts.filter((segment) => segment.sessionId !== "demo");
    const markdown = [
      `# ${record.title}`,
      "",
      "- 会议类型：售前商务会议",
      `- 公司：${record.companyName || "未填写"}`,
      `- 计划时间：${record.scheduledAt || "未安排"}`,
      `- 状态：${record.status}`,
      "",
      "## 场景与背景",
      "",
      record.scenarioContext || "未填写",
      "",
      "## 备注",
      "",
      record.notes || "未填写",
      "",
      "## 输出要求",
      "",
      record.outputRequirements || "使用回答风格默认要求",
      "",
      "## 本次知识范围",
      "",
      ...(selectedDocuments.length ? selectedDocuments.map((document) => `- ${document.name}（${document.status === "ready" ? "可检索" : formatStatus(document.status)}）`) : ["- 未选择资料"]),
      "",
      "## 会议转写",
      "",
      ...(meetingTranscripts.length ? meetingTranscripts.map((segment) => `- **${segment.speakerLabel} ${segment.startedAt}**：${segment.text}`) : ["当前没有可导出的实时转写。"]),
      "",
      "## 深度复盘",
      "",
      "> 云端复盘能力尚未接入。本文件仅导出当前客户端中真实存在的会议配置与转写，不包含 AI 生成的复盘结论。",
      "",
    ].join("\n");
    try {
      const safeName = record.title.replace(/[\\/:*?\"<>|]/g, "-").slice(0, 60) || "会议复盘";
      const path = await exportMarkdown(markdown, `${safeName}-复盘.md`);
      if (path) setNotice("Markdown 已导出：" + path);
    } catch (error) {
      setNotice("Markdown 导出失败：" + readableError(error));
    }
  }

  async function copyAnswer() {
    if (!answer.content.trim()) {
      setNotice("当前没有可复制的回答。");
      return;
    }
    try {
      await navigator.clipboard.writeText(answer.content);
      setNotice("回答已复制到剪贴板；应用不会自动发送或发言。");
    } catch (error) {
      setNotice("复制失败：" + readableError(error));
    }
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

        <div className="workspace-list" aria-label="会议类型">
          <p className="eyebrow">会议类型</p>
          {workspaces.map((workspace) => (
            <button
              className={"workspace-button " + (activeWorkspaceId === workspace.id ? "selected" : "")}
              key={workspace.id}
              onClick={() => {
                setActiveWorkspaceId(workspace.id);
                setActiveMeetingId(snapshot.meetingRecords.find((record) => record.workspaceId === workspace.id)?.id || "");
                setActiveView("live");
              }}
            >
              <span className="workspace-dot">商</span>
              <span><b>{workspace.name}</b><small>{workspace.indexedCount}/{workspace.documentCount} 已索引</small></span>
            </button>
          ))}
          <button className="sidebar-primary" onClick={() => setActiveView("history")}>
            <Plus size={16} weight="bold" aria-hidden="true" />
            配置新会议
          </button>
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
            <p className="eyebrow">售前商务会议</p>
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
            audioHealth={audioHealth}
            questionPrefetch={questionPrefetch}
            onConfirmCandidate={() => questionPrefetch && submitQuestion(questionPrefetch.question, questionPrefetch.id)}
            onDismissCandidate={() => {
              setQuestionPrefetch(null);
              setNotice("已忽略疑似问题；实时转写会继续运行。");
            }}
            onCopyAnswer={copyAnswer}
            onRetryAnswer={() => submitQuestion(answer.question || question)}
            onUseTranscriptQuestion={beginCandidatePrefetch}
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
            documents={documents}
            activeRecordId={activeMeetingId}
            onActivate={(record) => {
              setActiveMeetingId(record.id);
              setActiveView("live");
            }}
            onSave={onSaveMeetingRecord}
            onDelete={onDeleteMeetingRecord}
          />
        )}
        {activeView === "review" && (
          <ReviewView
            records={meetings}
            activeRecordId={activeMeetingId}
            setActiveRecordId={setActiveMeetingId}
            transcripts={transcripts}
            documents={documents}
            onExport={onExportReview}
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
  audioHealth: Record<"microphone" | "system", AudioHealth>;
  questionPrefetch: QuestionPrefetch | null;
  onConfirmCandidate: () => void;
  onDismissCandidate: () => void;
  onCopyAnswer: () => void;
  onRetryAnswer: () => void;
  onUseTranscriptQuestion: (text: string) => void;
}) {
  const [focusMode, setFocusMode] = useState(false);
  const activeMeeting = props.meetings.find((record) => record.id === props.activeMeetingId);
  const audioReady = props.audioHealth.microphone.state === "healthy" || props.audioHealth.system.state === "healthy";

  return (
    <div className={focusMode ? "live-experience focus-mode" : "live-experience"}>
      <section className="meeting-preflight" aria-label="会议准备状态">
        <div className="preflight-title">
          <span className="status-dot online" />
          <div><b>{activeMeeting?.title || "尚未关联会议"}</b><small>回答前快速确认上下文、授权与音频状态</small></div>
        </div>
        <div className={activeMeeting ? "preflight-item ready" : "preflight-item"}>
          <span>01</span><div><b>会议上下文</b><small>{activeMeeting ? "已关联会议配置" : "可在会议模块补充"}</small></div>
        </div>
        <div className={props.consentAccepted ? "preflight-item ready" : "preflight-item"}>
          <span>02</span><div><b>采集授权</b><small>{props.consentAccepted ? "已确认授权" : "开始前需要确认"}</small></div>
        </div>
        <div className={audioReady ? "preflight-item ready" : "preflight-item"}>
          <span>03</span><div><b>双音源</b><small>{audioReady ? "已接收音频帧" : props.isCapturing ? "正在等待音频" : "采集后自动检测"}</small></div>
        </div>
      </section>

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
        <div className="audio-health-grid" aria-label="双音源采集健康">
          {(["microphone", "system"] as const).map((source) => {
            const health = props.audioHealth[source];
            return (
              <div className={"audio-health-item " + health.state} key={source}>
                <span className={health.state === "healthy" ? "status-dot online" : "status-dot"} />
                <div><b>{source === "microphone" ? "本机麦克风" : "系统音频"}</b><small>{health.state === "healthy" ? `${health.frames} 帧 · ${health.seconds.toFixed(1)} 秒` : health.state === "changed" ? "设备已变化" : props.isCapturing ? "等待音频帧" : "尚未采集"}</small></div>
              </div>
            );
          })}
        </div>
        <div className="transcript-list">
          {props.transcripts.map((segment) => (
            <article className={"transcript-item " + (segment.speaker === "self" ? "self" : "")} key={segment.id}>
              <div><span className="speaker-label">{segment.speakerLabel}</span><time>{segment.startedAt}</time></div>
              <p>{segment.text}</p>
              {segment.isQuestionCandidate && <button className="question-tag" onClick={() => props.onUseTranscriptQuestion(segment.text)}><Sparkle size={11} weight="fill" aria-hidden="true" /> 作为候选问题</button>}
            </article>
          ))}
          {!props.transcripts.length && <div className="transcript-empty">{props.isCapturing ? "正在等待第一段语音…" : "开始采集后，实时转写将显示在这里。"}</div>}
        </div>
        <div className="transcript-footer"><Waveform size={17} weight="bold" aria-hidden="true" /><span>{props.isCapturing ? "正在转写，实时内容将出现于此" : "开始采集后显示实时转写"}</span></div>
      </section>

      <section className="answer-panel answer-stage">
        <div className="answer-stage-header">
          <div><p className="eyebrow"><Sparkle size={13} weight="fill" aria-hidden="true" /> AI 回答</p><h2>{outputTitle(props.activeProfile)}</h2></div>
          <div className="answer-header-actions">
            <button className="focus-toggle" onClick={() => setFocusMode((current) => !current)} title={focusMode ? "退出专注模式" : "进入专注模式"}>
              {focusMode ? <CornersIn size={15} weight="bold" aria-hidden="true" /> : <CornersOut size={15} weight="bold" aria-hidden="true" />}
              {focusMode ? "退出专注" : "专注阅读"}
            </button>
            <div className="answer-status">
              <span className={props.answer.status === "streaming" ? "status-dot online breathing" : "status-dot online"} />
              <span>{props.answer.status === "streaming" ? "流式生成中" : "准备就绪"}</span>
            </div>
          </div>
        </div>

        <article className={"answer-card " + props.answer.status}>
          <div className="answer-meta">
            <span><ShieldCheck size={13} weight="fill" aria-hidden="true" /> {props.answer.status === "idle" ? "等待确认问题" : props.answer.status === "streaming" ? "流式输出中" : props.answer.status === "failed" ? "生成失败" : "已基于资料整理"}</span>
            {props.answer.firstTokenMs && <span>首字 {props.answer.firstTokenMs} ms</span>}
            {props.answer.retrievalMs && <span>检索 {props.answer.retrievalMs} ms</span>}
          </div>
          {props.answer.error ? <p className="error-text">{props.answer.error}</p> : <p className="answer-content">{props.answer.content || (props.answer.status === "idle" ? "确认疑似问题或手动输入问题后，回答将在这里流式输出。" : "正在根据资料检索并生成…")}</p>}
          <div className="answer-actions">
            <button disabled={!props.answer.content || props.answer.status === "streaming"} onClick={props.onCopyAnswer}>复制回答</button>
            <button disabled={props.isGenerating || !props.answer.question} onClick={props.onRetryAnswer}>重新生成</button>
          </div>
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
          <div className="control-heading"><span>当前会议</span><Clock size={16} weight="duotone" aria-hidden="true" /></div>
          <select value={props.activeMeetingId} onChange={(event) => props.setActiveMeetingId(event.target.value)} aria-label="选择会议记录">
            <option value="">不关联登记记录</option>
            {props.meetings.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
          </select>
          <p>会议背景、客户信息、备注和本次资料范围会以受控上下文参与回答。</p>
        </section>
        {props.questionPrefetch && (
          <section className={"candidate-card " + props.questionPrefetch.status}>
            <div className="candidate-heading">
              <span>疑似问题 · 等待确认</span>
              {props.questionPrefetch.status === "prefetching" && <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />}
              {props.questionPrefetch.status === "ready" && <CheckCircle size={15} weight="fill" aria-hidden="true" />}
              {(props.questionPrefetch.status === "failed" || props.questionPrefetch.status === "insufficient") && <WarningCircle size={15} weight="fill" aria-hidden="true" />}
            </div>
            <p>{props.questionPrefetch.question}</p>
            <small>
              {props.questionPrefetch.status === "prefetching" && "正在向量化、召回并重排…"}
              {props.questionPrefetch.status === "ready" && `已找到 ${props.questionPrefetch.evidenceCount} 条依据 · ${props.questionPrefetch.retrievalMs} ms`}
              {props.questionPrefetch.status === "insufficient" && "本次资料范围暂无足够依据"}
              {props.questionPrefetch.status === "failed" && (props.questionPrefetch.error || "预检索失败，可在问题框手动重试")}
            </small>
            <div className="candidate-actions">
              <button className="candidate-dismiss" onClick={props.onDismissCandidate}>忽略</button>
              <button disabled={props.questionPrefetch.status === "prefetching" || props.questionPrefetch.status === "failed" || props.isGenerating} onClick={props.onConfirmCandidate}>确认并生成</button>
            </div>
          </section>
        )}
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
        <label>回答时长<select value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value as AnswerProfile["duration"] })}><option value="15s">15 秒</option><option value="30s">30 秒</option><option value="60s">60 秒</option><option value="90s">90 秒</option></select></label>
        <label>组织方式<select value={draft.style} onChange={(event) => setDraft({ ...draft, style: event.target.value as AnswerProfile["style"] })}><option value="business">商务结论与待确认项</option><option value="concise">简洁直答</option></select></label>
        <label className="wide">补充要求<textarea value={draft.additionalInstructions} onChange={(event) => setDraft({ ...draft, additionalInstructions: event.target.value })} /></label>
      </div>
      <button className="primary-button" onClick={() => props.onSave(draft)}>保存回答风格</button>
    </section>
  );
}

function createRecord(workspace?: Workspace): MeetingRecord {
  const timestamp = new Date().toISOString();
  return {
    id: "record-" + Date.now(),
    workspaceId: workspace?.id || "business",
    kind: "business",
    title: "新建售前商务会议",
    scenarioContext: "",
    companyName: "",
    notes: "",
    outputRequirements: "按结论、客户价值、建议方案、待确认项和下一步问题组织，不作未经确认的承诺。",
    knowledgeScope: [],
    resumeDocumentId: undefined,
    resumeConfirmedAt: undefined,
    packetVersion: 1,
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function HistoryView(props: {
  workspace?: Workspace;
  records: MeetingRecord[];
  documents: KnowledgeDocument[];
  activeRecordId: string;
  onActivate: (record: MeetingRecord) => void;
  onSave: (record: MeetingRecord) => Promise<void>;
  onDelete: (record: MeetingRecord) => Promise<void>;
}) {
  const [draft, setDraft] = useState<MeetingRecord>(() => createRecord(props.workspace));
  const [validationError, setValidationError] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(createRecord(props.workspace));
    setValidationError("");
    setStep(1);
  }, [props.workspace?.id]);

  function validateStep(target: 1 | 2 | 3): boolean {
    if (target === 1 && (!draft.title.trim() || !draft.scenarioContext.trim())) {
      setValidationError("请先填写会议主题和场景背景。");
      return false;
    }
    if (target === 3 && !draft.notes.trim()) {
      setValidationError("请填写备注信息，明确本次会议的重点和边界。");
      return false;
    }
    setValidationError("");
    return true;
  }

  function nextStep() {
    if (!validateStep(step)) return;
    setStep((current) => Math.min(3, current + 1) as 1 | 2 | 3);
  }

  function startNew() {
    setDraft(createRecord(props.workspace));
    setValidationError("");
    setStep(1);
  }

  function editRecord(record: MeetingRecord) {
    setDraft(record);
    setValidationError("");
    setStep(1);
  }

  async function save() {
    if (!draft.title.trim() || !draft.scenarioContext.trim() || !draft.notes.trim()) {
      setValidationError("请填写会议主题、场景背景和备注信息。");
      return;
    }
    setValidationError("");
    setIsSaving(true);
    try {
      await props.onSave({ ...draft, updatedAt: new Date().toISOString() });
    } catch (error) {
      setValidationError(readableError(error));
    } finally {
      setIsSaving(false);
    }
  }

  function toggleKnowledge(documentId: string) {
    const selected = draft.knowledgeScope.includes(documentId);
    const knowledgeScope = selected
      ? draft.knowledgeScope.filter((id) => id !== documentId)
      : [...draft.knowledgeScope, documentId];
    setDraft({
      ...draft,
      knowledgeScope,
    });
  }

  return (
    <section className="content-view records-view">
      <div className="section-intro">
        <div><p className="eyebrow">会议准备中心</p><h2>用三步准备一场高质量会议</h2><p>从会议背景、资料范围到回答要求逐步确认。保存后，实时助手会把这些信息作为受控上下文。</p></div>
        <button className="primary-button" onClick={startNew}><Plus size={15} weight="bold" aria-hidden="true" />新建会议</button>
      </div>
      <div className="meeting-studio">
        <aside className="meeting-library">
          <div className="list-heading"><div><p className="eyebrow">会议列表</p><h3>已创建会议</h3></div><span>{props.records.length} 条</span></div>
          {props.records.map((record) => (
            <article className={"record-item " + (props.activeRecordId === record.id ? "selected" : "")} key={record.id}>
              <div className="record-item-top"><span className="status-badge ready">售前商务会议</span><small>{record.scheduledAt || "未安排时间"}</small></div>
              <h4>{record.title}</h4>
              {record.companyName && <p>公司：{record.companyName}</p>}
              <p>{record.notes}</p>
              <p className="record-scope">配置 v{record.packetVersion} · 本次资料：{record.knowledgeScope.length} 项</p>
              <div>
                <button onClick={() => editRecord(record)}>编辑</button>
                <button onClick={() => { setDraft({ ...record, id: "record-" + Date.now(), title: record.title + " 副本", status: "draft", resumeConfirmedAt: undefined, packetVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); setStep(1); }}>复制</button>
                <button className="text-action" onClick={() => props.onActivate(record)}>进入实时助手</button>
                <button className="danger-action" onClick={() => props.onDelete(record)}>删除</button>
              </div>
            </article>
          ))}
          {!props.records.length && <div className="empty-state">当前还没有创建售前商务会议。</div>}
        </aside>

        <section className="meeting-editor">
          <div className="form-title"><div><p className="eyebrow">会前配置</p><h3>{draft.title || "未命名会议"}</h3></div><span>售前商务会议</span></div>
          <div className="preparation-stepper" aria-label="会议配置步骤">
            {[
              { id: 1 as const, title: "背景与目标", hint: "场景、客户、目标" },
              { id: 2 as const, title: "资料范围", hint: "限定 RAG 范围" },
              { id: 3 as const, title: "表达与确认", hint: "风格、备注、保存" },
            ].map((item) => (
              <button className={step === item.id ? "active" : step > item.id ? "complete" : ""} key={item.id} onClick={() => setStep(item.id)} aria-current={step === item.id ? "step" : undefined}>
                <span>{step > item.id ? "✓" : `0${item.id}`}</span><div><b>{item.title}</b><small>{item.hint}</small></div>
              </button>
            ))}
          </div>

          <div className="meeting-step-panel" key={step}>
            {step === 1 && (
              <>
                <div className="step-copy"><span>STEP 01</span><h4>告诉助手这是一场什么会议</h4><p>先补充最影响回答判断的信息，后续仍可随时返回修改。</p></div>
                <div className="form-grid guided-grid">
                  <label className="wide">会议主题<input value={draft.title} placeholder="例如：券商 ToC 智能客服方案交流" onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                  <label className="wide">会议场景、主题与背景<textarea value={draft.scenarioContext} placeholder="说明客户角色、业务现状、交流目标、关注问题和期望结果。" onChange={(event) => setDraft({ ...draft, scenarioContext: event.target.value })} /></label>
                  <label>公司名称<input value={draft.companyName || ""} placeholder="例如：国投证券" onChange={(event) => setDraft({ ...draft, companyName: event.target.value })} /></label>
                  <label>会议类型<input value="售前商务会议" readOnly /></label>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="step-copy"><span>STEP 02</span><h4>限定本次可使用的资料</h4><p>只勾选真正适用于当前客户和议题的材料，避免跨客户、跨项目误用信息。</p></div>
                <div className="meeting-materials guided-materials">
                  <div className="material-heading"><div><h4>本次知识范围</h4><p>只有勾选且完成索引的资料会参与本次 RAG 检索。</p></div><span>{draft.knowledgeScope.length} 项</span></div>
                  <div className="scope-list">
                    {props.documents.map((document) => (
                      <label className={document.status === "ready" ? "scope-item" : "scope-item disabled"} key={document.id}>
                        <input type="checkbox" disabled={document.status !== "ready"} checked={draft.knowledgeScope.includes(document.id)} onChange={() => toggleKnowledge(document.id)} />
                        <span><b>{document.name}</b><small>{document.extension} · {formatStatus(document.status)}</small></span>
                      </label>
                    ))}
                    {!props.documents.length && <div className="empty-state compact">请先在知识库导入资料，再配置本次检索范围。</div>}
                  </div>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="step-copy"><span>STEP 03</span><h4>定义怎样回答，以及哪些信息不能越界</h4><p>把表达偏好和会议边界写清楚，助手会优先生成可直接参考的口语化答案。</p></div>
                <div className="form-grid guided-grid">
                  <label className="wide">备注信息<textarea value={draft.notes} placeholder="补充客户事实、待确认问题、会议目标和不能直接承诺的边界。" onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
                  <label className="wide">其他会议要求（输出风格与格式）<textarea value={draft.outputRequirements} placeholder="例如：中文口语化；先给结论；分点回答；控制在 60 秒；未知信息标记待确认。" onChange={(event) => setDraft({ ...draft, outputRequirements: event.target.value })} /></label>
                  <label>计划时间<input value={draft.scheduledAt || ""} placeholder="2026-08-08 14:30" onChange={(event) => setDraft({ ...draft, scheduledAt: event.target.value })} /></label>
                  <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as MeetingRecord["status"] })}><option value="draft">草稿</option><option value="scheduled">已安排</option><option value="in_progress">进行中</option><option value="completed">已完成</option></select></label>
                </div>
                <div className="meeting-summary">
                  <div><span>当前会议</span><b>{draft.title || "待填写"}</b><small>{draft.companyName || "未填写公司"}</small></div>
                  <div><span>本次资料</span><b>{draft.knowledgeScope.length} 项</b><small>仅使用已勾选且完成索引的资料</small></div>
                  <div><span>可信边界</span><b>受控上下文</b><small>未知信息标记为待确认</small></div>
                </div>
              </>
            )}
          </div>

          {validationError && <p className="error-text meeting-validation" role="alert">{validationError}</p>}
          <div className="meeting-step-actions">
            <button className="secondary-button" disabled={step === 1} onClick={() => setStep((current) => Math.max(1, current - 1) as 1 | 2 | 3)}><ArrowLeft size={14} weight="bold" aria-hidden="true" />上一步</button>
            {step < 3 ? <button className="primary-button" onClick={nextStep}>下一步<ArrowRight size={14} weight="bold" aria-hidden="true" /></button> : <button className="primary-button" disabled={isSaving} onClick={save}>{isSaving ? "正在保存…" : "保存并完成配置"}</button>}
          </div>
        </section>
      </div>
      <div className="metric-grid">
        <article><span>资料范围</span><b>强隔离</b><small>未勾选资料不会进入本次检索</small></article>
        <article><span>配置快照</span><b>自动版本化</b><small>每次保存都会生成新版本</small></article>
        <article><span>转写记录</span><b>本机保存</b><small>原始音频未保留</small></article>
      </div>
    </section>
  );
}

function ReviewView(props: {
  records: MeetingRecord[];
  activeRecordId: string;
  setActiveRecordId: (id: string) => void;
  transcripts: TranscriptSegment[];
  documents: KnowledgeDocument[];
  onExport: (record: MeetingRecord) => Promise<void>;
}) {
  const [tab, setTab] = useState<"summary" | "ledger" | "evidence" | "concerns" | "actions">("summary");
  const active = props.records.find((record) => record.id === props.activeRecordId) || props.records[0];
  const scopedDocuments = active ? props.documents.filter((document) => active.knowledgeScope.includes(document.id)) : [];
  const realTranscripts = props.transcripts.filter((segment) => segment.sessionId !== "demo");
  const tabs = [
    { id: "summary" as const, label: "会议概览" },
    { id: "ledger" as const, label: "问题账本" },
    { id: "evidence" as const, label: "回答与证据" },
    { id: "concerns" as const, label: "关注点" },
    { id: "actions" as const, label: "行动项" },
  ];

  return (
    <section className="content-view review-view">
      <div className="section-intro review-intro">
        <div><p className="eyebrow">云端会议复盘</p><h2>深度会议复盘</h2><p>当前版本先提供完整前端结构与本地 Markdown 导出；云端分析尚未接入，因此不会展示虚构评分或结论。</p></div>
        <button className="primary-button" disabled={!active} onClick={() => active && props.onExport(active)}><DownloadSimple size={16} weight="bold" aria-hidden="true" /> 导出本地记录 Markdown</button>
      </div>

      <div className="review-status"><CircleNotch size={16} weight="bold" aria-hidden="true" /><div><b>云端复盘待接入</b><span>前端界面已就绪；后续版本将基于用户主动提交的转写和会议配置生成分析。</span></div></div>

      <div className="review-toolbar">
        <label>选择会议
          <select value={active?.id || ""} onChange={(event) => props.setActiveRecordId(event.target.value)}>
            {!props.records.length && <option value="">暂无会议</option>}
            {props.records.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
          </select>
        </label>
        <div className="review-tabs" role="tablist">
          {tabs.map((item) => <button role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </div>
      </div>

      {!active ? <div className="empty-state">请先在“会议”模块创建一场会议，再进入复盘。</div> : (
        <div className="review-layout">
          <aside className="review-context-card">
            <p className="eyebrow">输入完整度</p>
            <h3>{active.title}</h3>
            <ul>
              <li className={active.scenarioContext ? "ready" : ""}><span />会议背景{active.scenarioContext ? "已填写" : "待补充"}</li>
              <li className="ready"><span />会议类型售前商务会议</li>
              <li className={scopedDocuments.length ? "ready" : ""}><span />资料范围{scopedDocuments.length} 项</li>
              <li className={realTranscripts.length ? "ready" : ""}><span />会议转写{realTranscripts.length} 段</li>
            </ul>
          </aside>

          <section className="review-result-card">
            <div className="review-result-heading">
              <div><p className="eyebrow">{tabs.find((item) => item.id === tab)?.label}</p><h3>{tab === "summary" ? "等待生成会议概览" : tab === "ledger" ? "等待整理会议问题账本" : tab === "evidence" ? "等待核对回答与资料证据" : tab === "concerns" ? "等待提炼关注点与待确认项" : "等待整理行动项与下一步"}</h3></div>
              <span className="status-badge indexing">待接入</span>
            </div>
            <div className="review-placeholder">
              <FileText size={31} weight="duotone" aria-hidden="true" />
              <b>此区域不会显示演示性复盘结论</b>
              <p>接入云端复盘后，只有在用户主动确认上传本次转写时才会开始分析；原始音频仍不上传、不保留。</p>
            </div>
          </section>

          <aside className="review-data-card">
            <p className="eyebrow">本次可用输入</p>
            <dl>
              <div><dt>公司</dt><dd>{active.companyName || "未填写"}</dd></div>
              <div><dt>会议类型</dt><dd>售前商务会议</dd></div>
              <div><dt>资料</dt><dd>{scopedDocuments.length} 项</dd></div>
              <div><dt>转写</dt><dd>{realTranscripts.length} 段</dd></div>
              <div><dt>导出</dt><dd>仅 Markdown</dd></div>
            </dl>
            <div className="privacy-note"><ShieldCheck size={15} weight="fill" aria-hidden="true" /><span>云端复盘未接入前，页面不会发送会议内容。</span></div>
          </aside>
        </div>
      )}
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
