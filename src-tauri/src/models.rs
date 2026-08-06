use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub document_count: i64,
    pub indexed_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub extension: String,
    pub status: String,
    pub segment_count: i64,
    pub updated_at: String,
    pub source_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerProfile {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub language: String,
    pub duration: String,
    pub style: String,
    pub additional_instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecord {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub title: String,
    pub job_title: Option<String>,
    pub job_description: Option<String>,
    pub notes: String,
    pub scheduled_at: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub asr_configured: bool,
    pub bailian_configured: bool,
    pub key_storage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsView {
    pub tencent_app_id: String,
    pub tencent_secret_id_configured: bool,
    pub tencent_secret_key_configured: bool,
    pub tencent_asr_endpoint: String,
    pub bailian_api_key_configured: bool,
    pub bailian_endpoint: String,
    pub embedding_model: String,
    pub rerank_model: String,
    pub chat_model: String,
    pub ocr_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub workspaces: Vec<Workspace>,
    pub documents: Vec<KnowledgeDocument>,
    pub profiles: Vec<AnswerProfile>,
    pub meeting_records: Vec<MeetingRecord>,
    pub provider_status: ProviderStatus,
    pub provider_settings: ProviderSettingsView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInvocation {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub operation: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub input_count: i64,
    pub input_unit: String,
    pub output_count: i64,
    pub output_unit: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCitation {
    pub document_id: String,
    pub document_name: String,
    pub locator: String,
    pub excerpt: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerStreamEvent {
    pub answer_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<SourceCitation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_token_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStreamEvent {
    pub id: String,
    pub source: String,
    pub text: Option<String>,
    pub is_final: bool,
    pub is_question_candidate: bool,
    pub error: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub tencent_app_id: String,
    pub tencent_secret_id: String,
    pub tencent_secret_key: String,
    pub tencent_asr_endpoint: String,
    pub bailian_api_key: String,
    pub bailian_endpoint: String,
    pub embedding_model: String,
    pub rerank_model: String,
    pub chat_model: String,
    pub ocr_model: String,
}

impl ProviderSettings {
    pub fn normalized(mut self) -> Self {
        if self.tencent_asr_endpoint.is_empty() {
            self.tencent_asr_endpoint = "wss://asr.cloud.tencent.com/asr/v2".to_owned();
        }
        if self.embedding_model.is_empty() {
            self.embedding_model = "text-embedding-v4".to_owned();
        }
        if self.rerank_model.is_empty() {
            self.rerank_model = "qwen3-rerank".to_owned();
        }
        if self.chat_model.is_empty() {
            self.chat_model = "qwen3.6-plus".to_owned();
        }
        if self.ocr_model.is_empty() {
            self.ocr_model = "qwen-vl-plus".to_owned();
        }
        self
    }
}

impl From<&ProviderSettings> for ProviderSettingsView {
    fn from(settings: &ProviderSettings) -> Self {
        Self {
            tencent_app_id: settings.tencent_app_id.clone(),
            tencent_secret_id_configured: !settings.tencent_secret_id.is_empty(),
            tencent_secret_key_configured: !settings.tencent_secret_key.is_empty(),
            tencent_asr_endpoint: settings.tencent_asr_endpoint.clone(),
            bailian_api_key_configured: !settings.bailian_api_key.is_empty(),
            bailian_endpoint: settings.bailian_endpoint.clone(),
            embedding_model: settings.embedding_model.clone(),
            rerank_model: settings.rerank_model.clone(),
            chat_model: settings.chat_model.clone(),
            ocr_model: settings.ocr_model.clone(),
        }
    }
}
