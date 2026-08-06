export type WorkspaceKind = "interview" | "business";
export type AppView = "live" | "knowledge" | "profiles" | "history" | "observability" | "settings";
export type Speaker = "remote" | "self" | "system";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  documentCount: number;
  indexedCount: number;
}

export interface KnowledgeDocument {
  id: string;
  workspaceId: string;
  name: string;
  extension: string;
  status: "ready" | "indexing" | "failed" | "unsupported";
  segmentCount: number;
  updatedAt: string;
  sourcePath?: string;
  error?: string;
}

export interface SourceCitation {
  documentId: string;
  documentName: string;
  locator: string;
  excerpt: string;
  score: number;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  speaker: Speaker;
  speakerLabel: string;
  text: string;
  isFinal: boolean;
  isQuestionCandidate: boolean;
  startedAt: string;
}

export interface TranscriptStreamEvent {
  id: string;
  source: "microphone" | "system";
  text?: string;
  isFinal: boolean;
  isQuestionCandidate: boolean;
  error?: string;
  status?: "connecting" | "capture-started" | "audio-receiving";
}

export interface AnswerProfile {
  id: string;
  workspaceId: string;
  name: string;
  language: "zh" | "en" | "bilingual";
  duration: "30s" | "60s" | "90s";
  style: "star" | "business" | "concise";
  additionalInstructions: string;
}

export interface MeetingRecord {
  id: string;
  workspaceId: string;
  kind: WorkspaceKind;
  title: string;
  jobTitle?: string;
  jobDescription?: string;
  notes: string;
  scheduledAt?: string;
  status: "draft" | "scheduled" | "in_progress" | "completed";
  createdAt: string;
  updatedAt: string;
}

export interface Answer {
  id: string;
  question: string;
  content: string;
  status: "idle" | "streaming" | "complete" | "insufficient_evidence" | "failed";
  citations: SourceCitation[];
  startedAt: string;
  firstTokenMs?: number;
  retrievalMs?: number;
  error?: string;
}

export interface ProviderStatus {
  asrConfigured: boolean;
  bailianConfigured: boolean;
  keyStorage: "keychain" | "unavailable";
}

export interface ProviderSettingsView {
  tencentAppId: string;
  tencentSecretIdConfigured: boolean;
  tencentSecretKeyConfigured: boolean;
  tencentAsrEndpoint: string;
  bailianApiKeyConfigured: boolean;
  bailianEndpoint: string;
  embeddingModel: string;
  rerankModel: string;
  chatModel: string;
  ocrModel: string;
}

export interface AppSnapshot {
  workspaces: Workspace[];
  documents: KnowledgeDocument[];
  profiles: AnswerProfile[];
  meetingRecords: MeetingRecord[];
  providerStatus: ProviderStatus;
  providerSettings: ProviderSettingsView;
}

export interface ModelInvocation {
  id: string;
  provider: string;
  model: string;
  operation: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  inputCount: number;
  inputUnit: string;
  outputCount: number;
  outputUnit: string;
  error?: string;
}

export interface AnswerStreamEvent {
  answerId: string;
  kind: "started" | "token" | "citation" | "completed" | "failed";
  text?: string;
  citation?: SourceCitation;
  firstTokenMs?: number;
  retrievalMs?: number;
  error?: string;
}
