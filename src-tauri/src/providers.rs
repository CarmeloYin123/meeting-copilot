use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::{
    models::{ProviderSettings, SourceCitation},
    observability::ModelCallRecorder,
};

pub trait AsrProvider {
    fn provider_name(&self) -> &'static str;
    fn audio_packet_duration_ms(&self) -> u16;
}

pub trait OcrProvider {
    fn provider_name(&self) -> &'static str;
}

pub trait EmbeddingProvider {
    fn provider_name(&self) -> &'static str;
}

pub trait RerankProvider {
    fn provider_name(&self) -> &'static str;
}

pub trait ChatProvider {
    fn provider_name(&self) -> &'static str;
}

pub struct TencentRealtimeAsr;
impl AsrProvider for TencentRealtimeAsr {
    fn provider_name(&self) -> &'static str {
        "tencent-realtime-asr"
    }
    fn audio_packet_duration_ms(&self) -> u16 {
        200
    }
}

pub struct TencentRealtimeAsrClient {
    settings: ProviderSettings,
    observability: Option<ModelCallRecorder>,
}

#[derive(Debug, Clone)]
pub struct RealtimeAsrResult {
    pub id: String,
    pub text: String,
    pub is_final: bool,
}

#[derive(Debug, Deserialize)]
struct TencentAsrResponse {
    code: Option<i64>,
    message: Option<String>,
    result: Option<TencentAsrSlice>,
}

#[derive(Debug, Deserialize)]
struct TencentAsrSlice {
    slice_type: i64,
    index: i64,
    voice_text_str: String,
}

impl TencentRealtimeAsrClient {
    pub fn new(settings: ProviderSettings) -> Result<Self, String> {
        if settings.tencent_app_id.trim().is_empty()
            || settings.tencent_secret_id.trim().is_empty()
            || settings.tencent_secret_key.trim().is_empty()
        {
            return Err(
                "请先在设置页保存腾讯云 AppId、SecretId 和 SecretKey，再开始实时转写。".to_owned(),
            );
        }
        Ok(Self {
            settings: settings.normalized(),
            observability: None,
        })
    }

    pub fn with_observability(
        settings: ProviderSettings,
        observability: ModelCallRecorder,
    ) -> Result<Self, String> {
        let mut client = Self::new(settings)?;
        client.observability = Some(observability);
        Ok(client)
    }

    pub async fn transcribe<F>(
        &self,
        mut frames: mpsc::Receiver<Vec<u8>>,
        operation: &str,
        mut on_result: F,
    ) -> Result<(), String>
    where
        F: FnMut(RealtimeAsrResult) + Send,
    {
        let span = self.observability.as_ref().map(|recorder| {
            recorder.begin(
                "腾讯云",
                "16k_zh_en",
                operation,
                0,
                "音频秒（本机估算）",
                "字符（本机估算）",
            )
        });
        let input_audio_ms = Arc::new(AtomicI64::new(0));
        let output_characters = Arc::new(AtomicI64::new(0));
        let result: Result<(), String> = async {
            let url = self.signed_url()?;
            let (mut socket, _) = connect_async(url.as_str())
                .await
                .map_err(|error| format!("无法连接腾讯云实时 ASR：{error}"))?;

            let mut deliver = {
                let output_characters = Arc::clone(&output_characters);
                move |result: RealtimeAsrResult| {
                    output_characters.fetch_add(result.text.chars().count() as i64, Ordering::Relaxed);
                    on_result(result);
                }
            };
            let handshake = tokio::time::timeout(Duration::from_secs(12), socket.next())
                .await
                .map_err(|_| {
                    "腾讯云实时 ASR 握手超时，请检查网络、Endpoint 或防火墙设置。".to_owned()
                })?;
            match handshake {
                Some(Ok(Message::Text(payload))) => {
                    self.handle_server_message(&payload, &mut deliver)?
                }
                Some(Ok(Message::Close(frame))) => {
                    return Err(format!("腾讯云实时 ASR 在握手时关闭连接：{frame:?}"));
                }
                Some(Ok(_)) => return Err("腾讯云实时 ASR 未返回有效握手消息。".to_owned()),
                Some(Err(error)) => return Err(format!("腾讯云实时 ASR 握手失败：{error}")),
                None => return Err("腾讯云实时 ASR 在握手时断开连接。".to_owned()),
            }

            let mut ending = false;
            loop {
                tokio::select! {
                    maybe_frame = frames.recv(), if !ending => match maybe_frame {
                        Some(frame) => {
                            input_audio_ms.fetch_add((frame.len() as i64 * 1_000) / 32_000, Ordering::Relaxed);
                            socket.send(Message::Binary(frame.into())).await
                                .map_err(|error| format!("实时音频上传中断：{error}"))?;
                        }
                        None => {
                            socket.send(Message::Text(r#"{"type":"end"}"#.into())).await
                                .map_err(|error| format!("无法结束实时转写：{error}"))?;
                            ending = true;
                        }
                    },
                    server_message = socket.next() => match server_message {
                        Some(Ok(Message::Text(payload))) => {
                            self.handle_server_message(&payload, &mut deliver)?;
                            if ending { return Ok(()); }
                        }
                        Some(Ok(Message::Close(_))) | None => return Ok(()),
                        Some(Ok(_)) => {},
                        Some(Err(error)) => return Err(format!("腾讯云实时 ASR 连接中断：{error}")),
                    },
                }
            }
        }
        .await;
        let input_audio_seconds = input_audio_ms.load(Ordering::Relaxed) / 1_000;
        let result = match result {
            Ok(()) if input_audio_ms.load(Ordering::Relaxed) == 0 => Err(
                "未收到可上传的 16 kHz PCM 音频帧。请确认麦克风权限、当前输入设备，以及是否有其他应用独占麦克风。"
                    .to_owned(),
            ),
            other => other,
        };
        if let Some(span) = span {
            match &result {
                Ok(()) => span.succeed_with_input(
                    input_audio_seconds,
                    output_characters.load(Ordering::Relaxed),
                ),
                Err(error) => span.fail_with_input(input_audio_seconds, error),
            }
        }
        result
    }

    fn signed_url(&self) -> Result<Url, String> {
        let mut endpoint = Url::parse(self.settings.tencent_asr_endpoint.trim())
            .map_err(|error| format!("腾讯云 ASR Endpoint 格式无效：{error}"))?;
        if endpoint.scheme() != "wss" && endpoint.scheme() != "ws" {
            return Err("腾讯云 ASR Endpoint 必须使用 wss:// 或 ws://。".to_owned());
        }
        let original_path = endpoint.path().trim_end_matches('/');
        endpoint.set_path(&format!(
            "{original_path}/{}",
            self.settings.tencent_app_id.trim()
        ));
        endpoint.set_query(None);
        let timestamp = chrono::Utc::now().timestamp();
        let mut parameters = BTreeMap::new();
        parameters.insert("engine_model_type", "16k_zh_en".to_owned());
        parameters.insert("expired", (timestamp + 86_400).to_string());
        parameters.insert("needvad", "1".to_owned());
        parameters.insert("nonce", rand::random::<u32>().to_string());
        parameters.insert("secretid", self.settings.tencent_secret_id.clone());
        parameters.insert("timestamp", timestamp.to_string());
        parameters.insert("voice_format", "1".to_owned());
        parameters.insert("voice_id", uuid::Uuid::new_v4().to_string());
        let query = parameters
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        let host = endpoint
            .host_str()
            .ok_or("腾讯云 ASR Endpoint 缺少主机名。")?;
        let signing_text = format!("{host}{}?{query}", endpoint.path());
        let mut signer = Hmac::<Sha1>::new_from_slice(self.settings.tencent_secret_key.as_bytes())
            .map_err(|error| format!("无法生成腾讯云 ASR 签名：{error}"))?;
        signer.update(signing_text.as_bytes());
        let signature = BASE64.encode(signer.finalize().into_bytes());
        {
            let mut pairs = endpoint.query_pairs_mut();
            for (key, value) in parameters {
                pairs.append_pair(key, &value);
            }
            pairs.append_pair("signature", &signature);
        }
        Ok(endpoint)
    }

    fn handle_server_message<F>(&self, payload: &str, on_result: &mut F) -> Result<(), String>
    where
        F: FnMut(RealtimeAsrResult),
    {
        let response = serde_json::from_str::<TencentAsrResponse>(payload)
            .map_err(|error| format!("腾讯云实时 ASR 返回无效数据：{error}"))?;
        if response.code.unwrap_or(-1) != 0 {
            return Err(format!(
                "腾讯云实时 ASR 错误 {}：{}",
                response.code.unwrap_or(-1),
                response.message.unwrap_or_else(|| "未知错误".to_owned())
            ));
        }
        if let Some(result) = response.result {
            if !result.voice_text_str.trim().is_empty() {
                on_result(RealtimeAsrResult {
                    id: result.index.to_string(),
                    text: result.voice_text_str,
                    is_final: result.slice_type == 2,
                });
            }
        }
        Ok(())
    }
}

pub struct BailianProviders;
impl OcrProvider for BailianProviders {
    fn provider_name(&self) -> &'static str {
        "bailian-vision"
    }
}
impl EmbeddingProvider for BailianProviders {
    fn provider_name(&self) -> &'static str {
        "bailian-embedding"
    }
}
impl RerankProvider for BailianProviders {
    fn provider_name(&self) -> &'static str {
        "bailian-rerank"
    }
}
impl ChatProvider for BailianProviders {
    fn provider_name(&self) -> &'static str {
        "bailian-chat"
    }
}

#[derive(Clone)]
pub struct BailianClient {
    client: Client,
    settings: ProviderSettings,
    endpoint: String,
    observability: Option<ModelCallRecorder>,
}

impl BailianClient {
    pub fn new(settings: ProviderSettings) -> Result<Self, String> {
        Self::new_with_observability(settings, None)
    }

    pub fn with_observability(
        settings: ProviderSettings,
        observability: ModelCallRecorder,
    ) -> Result<Self, String> {
        Self::new_with_observability(settings, Some(observability))
    }

    fn new_with_observability(
        settings: ProviderSettings,
        observability: Option<ModelCallRecorder>,
    ) -> Result<Self, String> {
        if settings.bailian_api_key.trim().is_empty() || settings.bailian_endpoint.trim().is_empty()
        {
            return Err("请先在设置页配置百炼 API Key 和 Workspace Endpoint。".to_owned());
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|error| format!("无法创建云端请求客户端：{error}"))?;
        Ok(Self {
            client,
            endpoint: settings.bailian_endpoint.trim_end_matches('/').to_owned(),
            settings: settings.normalized(),
            observability,
        })
    }

    fn request(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}{}", self.endpoint, path))
            .bearer_auth(&self.settings.bailian_api_key)
            .header("Content-Type", "application/json")
    }

    pub async fn embed(&self, texts: &[String], text_type: &str) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let span = self.observability.as_ref().map(|recorder| {
            recorder.begin(
                "阿里云百炼",
                &self.settings.embedding_model,
                if text_type == "query" {
                    "查询向量化"
                } else {
                    "资料向量化"
                },
                texts.iter().map(|text| text.chars().count() as i64).sum(),
                "字符（本机估算）",
                "向量维度",
            )
        });
        let result = async {
            let response = self
                .request("/api/v1/services/embeddings/text-embedding/text-embedding")
                .json(&json!({
                    "model": self.settings.embedding_model,
                    "input": { "texts": texts },
                    "parameters": { "dimension": 1024, "text_type": text_type }
                }))
                .send()
                .await
                .map_err(|error| format!("向量请求失败：{error}"))?;
            let value = response_json(response, "向量服务").await?;
            let vectors = collect_named_vectors(&value);
            if vectors.len() != texts.len() {
                return Err(format!(
                    "向量服务返回 {} 条结果，预期 {} 条。",
                    vectors.len(),
                    texts.len()
                ));
            }
            Ok(vectors)
        }
        .await;
        if let Some(span) = span {
            match &result {
                Ok(vectors) => span.succeed(vectors.iter().map(|vector| vector.len() as i64).sum()),
                Err(error) => span.fail(error),
            }
        }
        result
    }

    pub async fn rerank(
        &self,
        query: &str,
        citations: Vec<SourceCitation>,
    ) -> Result<Vec<SourceCitation>, String> {
        if citations.is_empty() {
            return Ok(citations);
        }
        let documents = citations
            .iter()
            .map(|item| item.excerpt.clone())
            .collect::<Vec<_>>();
        let span = self.observability.as_ref().map(|recorder| {
            recorder.begin(
                "阿里云百炼",
                &self.settings.rerank_model,
                "证据重排序",
                query.chars().count() as i64
                    + documents
                        .iter()
                        .map(|item| item.chars().count() as i64)
                        .sum::<i64>(),
                "字符（本机估算）",
                "候选条数",
            )
        });
        let result: Result<Vec<SourceCitation>, String> = async {
            let response = self
                .request("/api/v1/services/rerank/text-rerank/text-rerank")
                .json(&json!({
                    "model": self.settings.rerank_model,
                    "input": { "query": query, "documents": documents }
                }))
                .send()
                .await
                .map_err(|error| format!("重排序请求失败：{error}"))?;
            let value = response_json(response, "重排序服务").await?;
            let results = find_array(&value, "results").unwrap_or_default();
            if results.is_empty() {
                return Ok(citations);
            }
            let mut sorted = Vec::new();
            for result in results {
                let index = result
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(usize::MAX as u64) as usize;
                if let Some(mut citation) = citations.get(index).cloned() {
                    citation.score = result
                        .get("relevance_score")
                        .and_then(Value::as_f64)
                        .unwrap_or(citation.score);
                    sorted.push(citation);
                }
            }
            Ok(if sorted.is_empty() { citations } else { sorted })
        }
        .await;
        if let Some(span) = span {
            match &result {
                Ok(citations) => span.succeed(citations.len() as i64),
                Err(error) => span.fail(error),
            }
        }
        result
    }

    pub async fn ocr_image(&self, mime: &str, bytes: &[u8]) -> Result<String, String> {
        let span = self.observability.as_ref().map(|recorder| {
            recorder.begin(
                "阿里云百炼",
                &self.settings.ocr_model,
                "OCR 图片转写",
                ((bytes.len() as i64) + 1023) / 1024,
                "KB（本机估算）",
                "字符（本机估算）",
            )
        });
        let result = async {
            let image_url = format!("data:{mime};base64,{}", BASE64.encode(bytes));
            let response = self.request("/compatible-mode/v1/chat/completions")
                .json(&json!({
                    "model": self.settings.ocr_model,
                    "messages": [{
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "请忠实提取图片或扫描页中的文字和结构化要点。不要补充图片中不存在的事实。" },
                            { "type": "image_url", "image_url": { "url": image_url } }
                        ]
                    }],
                    "stream": false
                }))
                .send().await.map_err(|error| format!("OCR 请求失败：{error}"))?;
            let value = response_json(response, "OCR 服务").await?;
            extract_chat_content(&value).ok_or("OCR 服务没有返回可用文字。".to_owned())
        }.await;
        if let Some(span) = span {
            match &result {
                Ok(content) => span.succeed(content.chars().count() as i64),
                Err(error) => span.fail(error),
            }
        }
        result
    }

    pub async fn stream_chat<F>(
        &self,
        system: &str,
        user: &str,
        mut on_token: F,
    ) -> Result<(), String>
    where
        F: FnMut(String) + Send,
    {
        let span = self.observability.as_ref().map(|recorder| {
            recorder.begin(
                "阿里云百炼",
                &self.settings.chat_model,
                "流式回答生成",
                (system.chars().count() + user.chars().count()) as i64,
                "字符（本机估算）",
                "字符（本机估算）",
            )
        });
        let mut output_characters = 0_i64;
        let result = async {
            let response = self
                .request("/compatible-mode/v1/chat/completions")
                .json(&json!({
                    "model": self.settings.chat_model,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user }
                    ],
                    "stream": true,
                    "stream_options": { "include_usage": true },
                    "temperature": 0.25
                }))
                .send()
                .await
                .map_err(|error| format!("回答请求失败：{error}"))?;
            if response.status() != StatusCode::OK {
                return Err(read_error(response, "生成服务").await);
            }
            let mut stream = response.bytes_stream();
            let mut pending = String::new();
            while let Some(next) = stream.next().await {
                let bytes = next.map_err(|error| format!("生成流中断：{error}"))?;
                pending.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(end) = pending.find('\n') {
                    let line = pending.drain(..=end).collect::<String>();
                    let payload = line.trim().strip_prefix("data:").map(str::trim);
                    let Some(payload) = payload else {
                        continue;
                    };
                    if payload == "[DONE]" {
                        return Ok(());
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(payload) {
                        if let Some(token) = extract_stream_token(&value) {
                            output_characters += token.chars().count() as i64;
                            on_token(token);
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        if let Some(span) = span {
            match &result {
                Ok(()) => span.succeed(output_characters),
                Err(error) => span.fail(error),
            }
        }
        result
    }
}

async fn response_json(response: reqwest::Response, service: &str) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(read_error(response, service).await);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("{service}返回格式无效：{error}"))
}

async fn read_error(response: reqwest::Response, service: &str) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let compact = body.chars().take(500).collect::<String>();
    format!("{service}请求失败（HTTP {status}）：{compact}")
}

fn collect_named_vectors(value: &Value) -> Vec<Vec<f32>> {
    let mut vectors = Vec::new();
    collect_vectors_recursive(value, &mut vectors);
    vectors
}

fn collect_vectors_recursive(value: &Value, output: &mut Vec<Vec<f32>>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::Array(values)) = map.get("embedding") {
                let vector = values
                    .iter()
                    .filter_map(Value::as_f64)
                    .map(|value| value as f32)
                    .collect::<Vec<_>>();
                if !vector.is_empty() {
                    output.push(vector);
                }
                return;
            }
            for value in map.values() {
                collect_vectors_recursive(value, output);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_vectors_recursive(value, output);
            }
        }
        _ => {}
    }
}

fn find_array(value: &Value, key: &str) -> Option<Vec<Value>> {
    match value {
        Value::Object(map) => {
            if let Some(Value::Array(values)) = map.get(key) {
                return Some(values.clone());
            }
            map.values().find_map(|value| find_array(value, key))
        }
        Value::Array(values) => values.iter().find_map(|value| find_array(value, key)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::TencentRealtimeAsrClient;
    use crate::models::ProviderSettings;

    fn asr_settings() -> ProviderSettings {
        ProviderSettings {
            tencent_app_id: "1000000000".to_owned(),
            tencent_secret_id: "test-secret-id".to_owned(),
            tencent_secret_key: "test-secret-key".to_owned(),
            tencent_asr_endpoint: "wss://asr.cloud.tencent.com/asr/v2".to_owned(),
            ..ProviderSettings::default()
        }
    }

    #[test]
    fn tencent_asr_url_has_signed_required_parameters() {
        let client = TencentRealtimeAsrClient::new(asr_settings()).expect("client");
        let url = client.signed_url().expect("signed url");
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.path(), "/asr/v2/1000000000");
        let parameters = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(parameters.get("voice_format"), Some(&"1".into()));
        assert_eq!(
            parameters.get("engine_model_type"),
            Some(&"16k_zh_en".into())
        );
        assert!(parameters.contains_key("signature"));
        assert!(parameters.contains_key("voice_id"));
    }
}

fn extract_chat_content(value: &Value) -> Option<String> {
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .pointer("/output/text")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
}

fn extract_stream_token(value: &Value) -> Option<String> {
    value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .pointer("/output/text")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
}
