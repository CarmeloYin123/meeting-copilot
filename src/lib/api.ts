import { invoke } from "@tauri-apps/api/core";
import type {
  AnswerProfile,
  AnswerStreamEvent,
  AppSnapshot,
  KnowledgeDocument,
  MeetingRecord,
  ModelInvocation,
  ProviderStatus,
  TranscriptStreamEvent,
  Workspace,
} from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const demoWorkspaces: Workspace[] = [
  { id: "interview", name: "面试准备", kind: "interview", documentCount: 4, indexedCount: 4 },
  { id: "business", name: "商务会议", kind: "business", documentCount: 3, indexedCount: 3 },
];

const demoDocuments: KnowledgeDocument[] = [
  { id: "cv", workspaceId: "interview", name: "候选人项目经历示例.pdf", extension: "PDF", status: "ready", segmentCount: 28, updatedAt: "今天 10:12" },
  { id: "project", workspaceId: "interview", name: "企业 AI 方案案例示例.md", extension: "MD", status: "ready", segmentCount: 42, updatedAt: "昨天 21:40" },
  { id: "case", workspaceId: "business", name: "AI解决方案与案例.pptx", extension: "PPTX", status: "ready", segmentCount: 64, updatedAt: "今天 09:25" },
  { id: "proposal", workspaceId: "business", name: "客户需求与交流纪要.docx", extension: "DOCX", status: "ready", segmentCount: 31, updatedAt: "今天 09:18" },
];

const demoProfiles: AnswerProfile[] = [
  { id: "interview-default", workspaceId: "interview", name: "面试 · STAR 60 秒", language: "zh", duration: "60s", style: "star", additionalInstructions: "先给结论，再说明本人负责内容和可核验结果。" },
  { id: "business-default", workspaceId: "business", name: "商务 · 方案回答", language: "zh", duration: "60s", style: "business", additionalInstructions: "未在资料中确认的内容必须标为待确认。" },
];

const demoMeetingRecords: MeetingRecord[] = [
  {
    id: "interview-2026-08-04",
    workspaceId: "interview",
    kind: "interview",
    title: "企业 AI 解决方案架构师 · 模拟面试",
    jobTitle: "AI 解决方案架构师",
    jobDescription: "负责企业客户 AI 解决方案设计、RAG/Agent 落地、售前交流与跨团队协同；要求有云服务、LLM 应用和客户项目经验。",
    notes: "重点准备企业 AI 方案案例、RAG 质量控制和客户需求澄清。",
    scheduledAt: "2026-08-04 14:30",
    status: "scheduled",
    createdAt: "2026-08-04 10:00",
    updatedAt: "2026-08-04 10:00",
  },
  {
    id: "business-2026-08-05",
    workspaceId: "business",
    kind: "business",
    title: "客户 AI 知识助手交流",
    notes: "待确认数据范围、系统接口、私有化部署和验收口径。",
    scheduledAt: "2026-08-05 10:00",
    status: "draft",
    createdAt: "2026-08-04 09:30",
    updatedAt: "2026-08-04 09:30",
  },
];

const demoModelInvocations: ModelInvocation[] = [
  {
    id: "observe-1", provider: "阿里云百炼", model: "qwen3.6-plus", operation: "流式回答生成", status: "success",
    startedAt: "2026-08-05T06:28:36Z", completedAt: "2026-08-05T06:28:38Z", durationMs: 1640,
    inputCount: 2880, inputUnit: "字符（本机估算）", outputCount: 412, outputUnit: "字符（本机估算）",
  },
  {
    id: "observe-2", provider: "阿里云百炼", model: "qwen3-rerank", operation: "证据重排序", status: "success",
    startedAt: "2026-08-05T06:28:35Z", completedAt: "2026-08-05T06:28:35Z", durationMs: 218,
    inputCount: 1840, inputUnit: "字符（本机估算）", outputCount: 12, outputUnit: "候选条数",
  },
  {
    id: "observe-3", provider: "阿里云百炼", model: "text-embedding-v4", operation: "查询向量化", status: "success",
    startedAt: "2026-08-05T06:28:35Z", completedAt: "2026-08-05T06:28:35Z", durationMs: 126,
    inputCount: 42, inputUnit: "字符（本机估算）", outputCount: 1024, outputUnit: "向量维度",
  },
  {
    id: "observe-4", provider: "腾讯云", model: "16k_zh_en", operation: "实时语音转写（本机麦克风）", status: "failed",
    startedAt: "2026-08-05T06:21:02Z", completedAt: "2026-08-05T06:21:17Z", durationMs: 15012,
    inputCount: 0, inputUnit: "音频秒（本机估算）", outputCount: 0, outputUnit: "字符（本机估算）",
    error: "腾讯云实时 ASR 错误 4008：客户端超过 15 秒未发送音频数据。",
  },
];

export async function getSnapshot(): Promise<AppSnapshot> {
  if (isTauri) {
    return invoke<AppSnapshot>("get_snapshot");
  }
  return {
    workspaces: demoWorkspaces,
    documents: demoDocuments,
    profiles: demoProfiles,
    meetingRecords: demoMeetingRecords,
    providerStatus: { asrConfigured: false, bailianConfigured: false, keyStorage: "unavailable" },
    providerSettings: {
      tencentAppId: "", tencentSecretIdConfigured: false, tencentSecretKeyConfigured: false,
      tencentAsrEndpoint: "wss://asr.cloud.tencent.com/asr/v2", bailianApiKeyConfigured: false,
      bailianEndpoint: "", embeddingModel: "text-embedding-v4", rerankModel: "qwen3-rerank",
      chatModel: "qwen3.6-plus", ocrModel: "qwen-vl-plus",
    },
  };
}

export async function saveMeetingRecord(record: MeetingRecord): Promise<MeetingRecord> {
  if (isTauri) {
    return invoke<MeetingRecord>("save_meeting_record", { record });
  }
  return { ...record, updatedAt: new Date().toLocaleString("zh-CN") };
}

export async function importDocuments(workspaceId: string, paths: string[]): Promise<KnowledgeDocument[]> {
  if (!isTauri) {
    return paths.map((path, index) => ({
      id: "demo-import-" + Date.now() + "-" + index,
      workspaceId,
      name: path.split("/").pop() || "未命名资料",
      extension: path.split(".").pop()?.toUpperCase() || "FILE",
      status: "indexing",
      segmentCount: 0,
      updatedAt: "刚刚",
    }));
  }
  return invoke<KnowledgeDocument[]>("import_documents", { workspaceId, paths });
}

export async function deleteDocument(documentId: string): Promise<void> {
  if (isTauri) {
    await invoke("delete_document", { documentId });
  }
}

export async function rebuildDocument(documentId: string): Promise<KnowledgeDocument> {
  if (isTauri) {
    return invoke<KnowledgeDocument>("rebuild_document", { documentId });
  }
  return {
    id: documentId,
    workspaceId: "interview",
    name: "正在重建索引",
    extension: "FILE",
    status: "indexing",
    segmentCount: 0,
    updatedAt: "刚刚",
  };
}

export async function saveProfile(profile: AnswerProfile): Promise<AnswerProfile> {
  if (isTauri) {
    return invoke<AnswerProfile>("save_profile", { profile });
  }
  return profile;
}

export async function saveProviderSettings(settings: Record<string, string>): Promise<ProviderStatus> {
  if (isTauri) {
    return invoke<ProviderStatus>("save_provider_settings", { settings });
  }
  return { asrConfigured: Boolean(settings.tencentAppId), bailianConfigured: Boolean(settings.bailianApiKey), keyStorage: "unavailable" };
}

export async function testBailianConnection(): Promise<string> {
  if (isTauri) {
    return invoke<string>("test_bailian_connection");
  }
  return "浏览器演示模式不会发送云端请求。";
}

export async function getModelInvocations(): Promise<ModelInvocation[]> {
  if (isTauri) {
    return invoke<ModelInvocation[]>("get_model_invocations");
  }
  return demoModelInvocations;
}

export async function requestCapturePermissions(): Promise<{ screen: boolean; microphone: boolean }> {
  if (isTauri) {
    return invoke("request_capture_permissions");
  }
  return { screen: false, microphone: false };
}

export async function startCapture(): Promise<void> {
  if (isTauri) {
    await invoke("start_capture");
  }
}

export async function stopCapture(): Promise<void> {
  if (isTauri) {
    await invoke("stop_capture");
  }
}

export async function generateAnswer(workspaceId: string, profileId: string, question: string, meetingId?: string): Promise<void> {
  if (isTauri) {
    await invoke("generate_answer", { workspaceId, profileId, question, meetingId });
  }
}

export async function listenToEvents(onEvent: (event: AnswerStreamEvent) => void): Promise<() => void> {
  if (!isTauri) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<AnswerStreamEvent>("answer-stream", (event) => onEvent(event.payload));
  return unlisten;
}

export async function listenToTranscriptEvents(onEvent: (event: TranscriptStreamEvent) => void): Promise<() => void> {
  if (!isTauri) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<TranscriptStreamEvent>("transcript-stream", (event) => onEvent(event.payload));
  return unlisten;
}

export function usingTauri(): boolean {
  return isTauri;
}
