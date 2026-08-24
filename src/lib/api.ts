import { invoke } from "@tauri-apps/api/core";
import type {
  AnswerProfile,
  AnswerStreamEvent,
  AppSnapshot,
  CaptureStopResult,
  KnowledgeDocument,
  MeetingRecord,
  ModelInvocation,
  ProviderStatus,
  QuestionPrefetch,
  TranscriptStreamEvent,
  Workspace,
} from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const demoWorkspaces: Workspace[] = [
  { id: "business", name: "售前商务会议", kind: "business", documentCount: 2, indexedCount: 2 },
];

const demoDocuments: KnowledgeDocument[] = [
  { id: "case", workspaceId: "business", name: "AI解决方案与案例.pptx", extension: "PPTX", status: "ready", segmentCount: 64, updatedAt: "今天 09:25" },
  { id: "proposal", workspaceId: "business", name: "客户需求与交流纪要.docx", extension: "DOCX", status: "ready", segmentCount: 31, updatedAt: "今天 09:18" },
];

const demoProfiles: AnswerProfile[] = [
  { id: "business-default", workspaceId: "business", name: "商务 · 方案回答", language: "zh", duration: "60s", style: "business", additionalInstructions: "未在资料中确认的内容必须标为待确认。" },
];

const demoMeetingRecords: MeetingRecord[] = [
  {
    id: "business-2026-08-05",
    workspaceId: "business",
    kind: "business",
    title: "客户 AI 知识助手交流",
    scenarioContext: "与客户技术负责人交流券商 ToC 智能客服平台，目标是澄清业务范围、技术架构、部署与验收口径。",
    companyName: "示例证券公司",
    notes: "待确认数据范围、系统接口、私有化部署和验收口径。",
    outputRequirements: "按结论、客户价值、建议方案、待确认项和下一步问题组织，不作未经确认的承诺。",
    knowledgeScope: ["case", "proposal"],
    packetVersion: 1,
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

export async function deleteMeetingRecord(meetingId: string): Promise<void> {
  if (isTauri) {
    await invoke("delete_meeting_record", { meetingId });
  }
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
    workspaceId: "business",
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

export async function exportMarkdown(content: string, suggestedName: string): Promise<string | null> {
  if (!isTauri) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = suggestedName;
    link.click();
    URL.revokeObjectURL(url);
    return suggestedName;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return null;
  return invoke<string>("write_markdown_file", { path, content });
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

export async function stopCapture(): Promise<CaptureStopResult> {
  if (isTauri) {
    return invoke<CaptureStopResult>("stop_capture");
  }
  return { outcome: "not-running", message: "浏览器演示模式不包含原生音频桥接。" };
}

export async function prefetchQuestion(workspaceId: string, question: string, meetingId?: string): Promise<QuestionPrefetch> {
  if (isTauri) {
    return invoke<QuestionPrefetch>("prefetch_question", { workspaceId, question, meetingId });
  }
  await new Promise((resolve) => window.setTimeout(resolve, 380));
  return {
    id: "demo-prefetch-" + Date.now(),
    question,
    status: "ready",
    evidenceCount: 2,
    retrievalMs: 218,
    citations: demoDocuments.slice(0, 2).map((document, index) => ({
      documentId: document.id,
      documentName: document.name,
      locator: index === 0 ? "项目案例 / 架构" : "会议资料 / 方案范围",
      excerpt: "已在当前会议勾选的资料范围中找到相关证据。",
      score: 0.9 - index * 0.08,
    })),
  };
}

export async function generateAnswer(workspaceId: string, profileId: string, question: string, meetingId?: string, prefetchId?: string): Promise<void> {
  if (isTauri) {
    await invoke("generate_answer", { workspaceId, profileId, question, meetingId, prefetchId });
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
