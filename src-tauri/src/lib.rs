mod capture;
mod ingest;
mod models;
mod observability;
mod providers;
mod security;
mod storage;

use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use capture::{CaptureController, CapturePermissions};
use models::{
    AnswerProfile, AnswerStreamEvent, AppSnapshot, KnowledgeDocument, MeetingRecord,
    ModelInvocation, ProviderSettings, ProviderSettingsView, ProviderStatus, SourceCitation,
};
use observability::ModelCallRecorder;
use providers::BailianClient;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use crate::{
    ingest::{chunk_sections, extract_sections},
    storage::Repository,
};

struct AppState {
    repository: Arc<Mutex<Repository>>,
    observability: ModelCallRecorder,
    capture: Mutex<CaptureController>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
            let key = security::vault_key()?;
            let repository = Arc::new(Mutex::new(Repository::open(&data_dir, key)?));
            let observability = ModelCallRecorder::new(Arc::clone(&repository));
            app.manage(AppState {
                repository,
                observability,
                capture: Mutex::new(CaptureController::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            import_documents,
            delete_document,
            rebuild_document,
            save_profile,
            save_meeting_record,
            save_provider_settings,
            test_bailian_connection,
            get_model_invocations,
            request_capture_permissions,
            start_capture,
            stop_capture,
            generate_answer
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                // This app has no menu-bar/tray mode. Closing its sole window
                // must stop capture and exit the process instead of leaving a
                // background process associated with screen sharing.
                if let Ok(mut capture) = window.state::<AppState>().capture.lock() {
                    let _ = capture.stop();
                }
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Meeting Copilot");
}

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    let repository = state.repository.lock().map_err(|_| "资料库正在被占用。")?;
    let settings = security::load_provider_settings()
        .unwrap_or_default()
        .normalized();
    Ok(AppSnapshot {
        workspaces: repository.workspaces()?,
        documents: repository.documents()?,
        profiles: repository.profiles()?,
        meeting_records: repository.meeting_records()?,
        provider_status: ProviderStatus {
            asr_configured: !settings.tencent_app_id.is_empty()
                && !settings.tencent_secret_id.is_empty()
                && !settings.tencent_secret_key.is_empty(),
            bailian_configured: !settings.bailian_api_key.is_empty()
                && !settings.bailian_endpoint.is_empty(),
            key_storage: "keychain".to_owned(),
        },
        provider_settings: ProviderSettingsView::from(&settings),
    })
}

#[tauri::command]
async fn import_documents(
    workspace_id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<KnowledgeDocument>, String> {
    let mut documents = Vec::new();
    for path in paths {
        let document = {
            let repository = state.repository.lock().map_err(|_| "资料库正在被占用。")?;
            repository.import_file(&workspace_id, &path)?
        };
        // Return immediately after local encrypted registration. The UI then starts indexing
        // as a separate task, so a slow or failed cloud embedding request never hides the file.
        documents.push(document);
    }
    Ok(documents)
}

#[tauri::command]
fn delete_document(document_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .repository
        .lock()
        .map_err(|_| "资料库正在被占用。")?
        .delete_document(&document_id)
}

#[tauri::command]
async fn rebuild_document(
    document_id: String,
    state: State<'_, AppState>,
) -> Result<KnowledgeDocument, String> {
    process_document(&state, &document_id).await
}

#[tauri::command]
fn save_profile(
    profile: AnswerProfile,
    state: State<'_, AppState>,
) -> Result<AnswerProfile, String> {
    state
        .repository
        .lock()
        .map_err(|_| "资料库正在被占用。")?
        .upsert_profile(&profile)
}

#[tauri::command]
fn save_meeting_record(
    record: MeetingRecord,
    state: State<'_, AppState>,
) -> Result<MeetingRecord, String> {
    state
        .repository
        .lock()
        .map_err(|_| "资料库正在被占用。")?
        .upsert_meeting_record(&record)
}

#[tauri::command]
fn save_provider_settings(settings: ProviderSettings) -> Result<ProviderStatus, String> {
    let settings = security::save_provider_settings(&settings)?;
    Ok(ProviderStatus {
        asr_configured: !settings.tencent_app_id.is_empty()
            && !settings.tencent_secret_id.is_empty()
            && !settings.tencent_secret_key.is_empty(),
        bailian_configured: !settings.bailian_api_key.is_empty()
            && !settings.bailian_endpoint.is_empty(),
        key_storage: "keychain".to_owned(),
    })
}

#[tauri::command]
async fn test_bailian_connection(state: State<'_, AppState>) -> Result<String, String> {
    let settings = security::load_provider_settings()?.normalized();
    let client = BailianClient::with_observability(settings, state.observability.clone())?;
    let result = client
        .embed(&["connection-check".to_owned()], "query")
        .await?;
    if result.len() == 1 && !result[0].is_empty() {
        Ok("百炼向量服务连接成功。".to_owned())
    } else {
        Err("百炼服务未返回有效向量。".to_owned())
    }
}

#[tauri::command]
fn get_model_invocations(state: State<'_, AppState>) -> Result<Vec<ModelInvocation>, String> {
    state
        .repository
        .lock()
        .map_err(|_| "资料库正在被占用。")?
        .model_invocations(200)
}

#[tauri::command]
fn request_capture_permissions(app: AppHandle) -> Result<CapturePermissions, String> {
    CaptureController::request_permissions(&app)
}

#[tauri::command]
fn start_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let settings = security::load_provider_settings()?.normalized();
    state
        .capture
        .lock()
        .map_err(|_| "音频采集器正在被占用。")?
        .start(&app, settings, state.observability.clone())
}

#[tauri::command]
fn stop_capture(state: State<'_, AppState>) -> Result<(), String> {
    state
        .capture
        .lock()
        .map_err(|_| "音频采集器正在被占用。")?
        .stop()
}

#[tauri::command]
async fn generate_answer(
    app: AppHandle,
    workspace_id: String,
    profile_id: String,
    question: String,
    meeting_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let started = Instant::now();
    let answer_id = uuid::Uuid::new_v4().to_string();
    emit(
        &app,
        AnswerStreamEvent {
            answer_id: answer_id.clone(),
            kind: "started".to_owned(),
            text: None,
            citation: None,
            first_token_ms: None,
            retrieval_ms: None,
            error: None,
        },
    )?;

    let (profile, record) = {
        let repository = state.repository.lock().map_err(|_| "资料库正在被占用。")?;
        let profile = repository.profile(&profile_id)?;
        if profile.workspace_id != workspace_id {
            return Err("回答风格不属于当前工作区。".to_owned());
        }
        let record = match meeting_id {
            Some(id) => {
                let value = repository.meeting_record(&id)?;
                if let Some(value) = &value {
                    if value.workspace_id != workspace_id {
                        return Err("会议/面试记录不属于当前工作区。".to_owned());
                    }
                }
                value
            }
            None => None,
        };
        (profile, record)
    };

    let settings = security::load_provider_settings()?.normalized();
    let client = BailianClient::with_observability(settings, state.observability.clone())?;
    let query_vector = client
        .embed(&[question.clone()], "query")
        .await?
        .into_iter()
        .next()
        .ok_or("向量服务没有返回查询向量。")?;
    let retrieval_started = Instant::now();
    let citations = {
        let repository = state.repository.lock().map_err(|_| "资料库正在被占用。")?;
        repository.hybrid_search(&workspace_id, &question, &query_vector)?
    };
    let citations = match client.rerank(&question, citations.clone()).await {
        Ok(reranked) => reranked,
        Err(_) => citations,
    };
    let retrieval_ms = retrieval_started.elapsed().as_millis();

    if citations.is_empty() {
        emit(&app, AnswerStreamEvent {
            answer_id: answer_id.clone(), kind: "token".to_owned(),
            text: Some("当前知识库没有足够依据支持这个回答。请补充相关简历、项目材料或会议资料；涉及未确认事实时应明确标为“待确认”。".to_owned()),
            citation: None, first_token_ms: Some(started.elapsed().as_millis()), retrieval_ms: Some(retrieval_ms), error: None,
        })?;
        return emit(
            &app,
            AnswerStreamEvent {
                answer_id,
                kind: "completed".to_owned(),
                text: None,
                citation: None,
                first_token_ms: Some(started.elapsed().as_millis()),
                retrieval_ms: Some(retrieval_ms),
                error: None,
            },
        );
    }

    let citations = citations.into_iter().take(6).collect::<Vec<_>>();
    for citation in &citations {
        emit(
            &app,
            AnswerStreamEvent {
                answer_id: answer_id.clone(),
                kind: "citation".to_owned(),
                text: None,
                citation: Some(citation.clone()),
                first_token_ms: None,
                retrieval_ms: None,
                error: None,
            },
        )?;
    }

    let system = answer_system_prompt(&profile);
    let user = answer_user_prompt(&question, record.as_ref(), &citations);
    let first_token = Arc::new(Mutex::new(None::<u128>));
    let first_token_for_stream = Arc::clone(&first_token);
    let app_for_stream = app.clone();
    let answer_id_for_stream = answer_id.clone();
    let stream_started = started;
    let stream_result = client
        .stream_chat(&system, &user, move |token| {
            let mut first = first_token_for_stream.lock().expect("first token lock");
            let first_token_ms = if first.is_none() {
                let value = stream_started.elapsed().as_millis();
                *first = Some(value);
                Some(value)
            } else {
                None
            };
            let _ = emit(
                &app_for_stream,
                AnswerStreamEvent {
                    answer_id: answer_id_for_stream.clone(),
                    kind: "token".to_owned(),
                    text: Some(token),
                    citation: None,
                    first_token_ms,
                    retrieval_ms: Some(retrieval_ms),
                    error: None,
                },
            );
        })
        .await;

    match stream_result {
        Ok(()) => emit(
            &app,
            AnswerStreamEvent {
                answer_id,
                kind: "completed".to_owned(),
                text: None,
                citation: None,
                first_token_ms: *first_token.lock().expect("first token lock"),
                retrieval_ms: Some(retrieval_ms),
                error: None,
            },
        ),
        Err(error) => emit(
            &app,
            AnswerStreamEvent {
                answer_id,
                kind: "failed".to_owned(),
                text: None,
                citation: None,
                first_token_ms: *first_token.lock().expect("first token lock"),
                retrieval_ms: Some(retrieval_ms),
                error: Some(error),
            },
        ),
    }
}

async fn process_document(
    state: &AppState,
    document_id: &str,
) -> Result<KnowledgeDocument, String> {
    let result = async {
        let source_path = {
            let repository = state.repository.lock().map_err(|_| "资料库正在被占用。")?;
            repository.source_path(document_id)?
        };
        let settings = security::load_provider_settings()?.normalized();
        let sections = chunk_sections(
            extract_sections(&source_path, &settings, Some(state.observability.clone())).await?,
        );
        if sections.is_empty() {
            return Err("资料未提取到可索引文字。".to_owned());
        }
        let client = BailianClient::with_observability(settings, state.observability.clone())?;
        let texts = sections
            .iter()
            .map(|section| section.content.clone())
            .collect::<Vec<_>>();
        let vectors = embed_document_batches(&client, &texts).await?;
        let repository = state.repository.lock().map_err(|_| "资料库正在被占用。")?;
        repository.replace_chunks(document_id, &sections, &vectors)?;
        repository.document(document_id)
    }
    .await;
    if let Err(message) = &result {
        if let Ok(repository) = state.repository.lock() {
            let _ = repository.mark_document_failed(document_id, message);
        }
    }
    result
}

async fn embed_document_batches(
    client: &BailianClient,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    // Keep requests below provider batch limits for large PDF/PPT imports.
    const BATCH_SIZE: usize = 10;
    let mut vectors = Vec::with_capacity(texts.len());
    for batch in texts.chunks(BATCH_SIZE) {
        let batch_vectors = client.embed(batch, "document").await?;
        vectors.extend(batch_vectors);
    }
    if vectors.len() != texts.len() {
        return Err(format!(
            "向量服务返回 {} 条结果，预期 {} 条。",
            vectors.len(),
            texts.len()
        ));
    }
    Ok(vectors)
}

fn answer_system_prompt(profile: &AnswerProfile) -> String {
    let structure = match profile.style.as_str() {
        "star" => "先给一行结论，再按 Situation、Task、Action、Result 组织；结果只能引用资料中存在的内容。",
        "business" => "按“结论、价值与方案、待确认项、下一步问题”组织；不把资料缺失的内容写成客户承诺。",
        _ => "直接给出简洁、自然、适合口头表达的回答。",
    };
    format!(
        "你是本地会议与面试助手。只能基于随后提供的证据回答，不能把推断说成资料事实。{} 输出语言：{}；目标时长：{}。{}",
        structure, profile.language, profile.duration, profile.additional_instructions
    )
}

fn answer_user_prompt(
    question: &str,
    record: Option<&MeetingRecord>,
    citations: &[SourceCitation],
) -> String {
    let context = record
        .map(|record| {
            format!(
                "登记背景：\\n主题：{}\\n岗位名称：{}\\n岗位JD：{}\\n备注：{}\\n",
                record.title,
                record.job_title.as_deref().unwrap_or("未填写"),
                record.job_description.as_deref().unwrap_or("未填写"),
                record.notes,
            )
        })
        .unwrap_or_else(|| "未关联会议/面试登记记录。\\n".to_owned());
    let evidence = citations
        .iter()
        .enumerate()
        .map(|(index, citation)| {
            format!(
                "[{}] {} / {}\\n{}",
                index + 1,
                citation.document_name,
                citation.locator,
                citation.excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\\n\\n");
    format!("{context}\\n问题：{question}\\n\\n可用证据：\\n{evidence}\\n\\n请输出可直接口头表达的回答。")
}

fn emit(app: &AppHandle, event: AnswerStreamEvent) -> Result<(), String> {
    app.emit("answer-stream", event)
        .map_err(|error| format!("无法推送回答事件：{error}"))
}
