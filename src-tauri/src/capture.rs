use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::{
    models::{ProviderSettings, TranscriptStreamEvent},
    observability::ModelCallRecorder,
    providers::TencentRealtimeAsrClient,
};

#[derive(Default)]
pub struct CaptureController {
    child: Option<Child>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePermissions {
    pub screen: bool,
    pub microphone: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAudioFrame {
    source: String,
    sample_rate: u32,
    channels: u16,
    pcm_base64: String,
}

#[derive(Deserialize)]
struct NativeCaptureError {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

#[derive(Deserialize)]
struct NativeCaptureStatus {
    #[serde(rename = "type")]
    kind: String,
    source: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NativeBridgeMessage {
    Frame(NativeAudioFrame),
    Error(NativeCaptureError),
    Status(NativeCaptureStatus),
}

impl CaptureController {
    pub fn request_permissions(app: &AppHandle) -> Result<CapturePermissions, String> {
        let helper = helper_path(app)?;
        let output = Command::new(helper)
            .arg("--check-permissions")
            .output()
            .map_err(|error| format!("无法检查 macOS 音频权限：{error}"))?;
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("原生权限桥接返回无效：{error}"))
    }

    pub fn start(
        &mut self,
        app: &AppHandle,
        settings: ProviderSettings,
        observability: ModelCallRecorder,
    ) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        TencentRealtimeAsrClient::new(settings.clone())?;
        // Keep several seconds of PCM while Tencent completes its WebSocket
        // handshake. A short buffer made speech that began immediately after
        // clicking "开始采集" disappear before the ASR stream was ready.
        let (microphone_sender, microphone_frames) = mpsc::channel(160);
        let (system_sender, system_frames) = mpsc::channel(160);
        spawn_asr_stream(
            app.clone(),
            settings.clone(),
            observability.clone(),
            "microphone",
            microphone_frames,
        );
        spawn_asr_stream(
            app.clone(),
            settings,
            observability,
            "system",
            system_frames,
        );
        let helper = helper_path(app)?;
        let mut child = Command::new(helper)
            .arg("--stream")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动 macOS 音频采集：{error}"))?;
        let stdout = child.stdout.take().ok_or("无法读取原生音频采集输出。")?;
        let bridge_app = app.clone();
        std::thread::spawn(move || {
            let received_microphone = Arc::new(AtomicBool::new(false));
            let received_system = Arc::new(AtomicBool::new(false));
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<NativeBridgeMessage>(&line) else {
                    continue;
                };
                let frame = match message {
                    NativeBridgeMessage::Frame(frame) => frame,
                    NativeBridgeMessage::Error(error) => {
                        let details = if error.kind == "capture_error" {
                            format!("macOS 音频采集失败：{}", error.message)
                        } else {
                            format!("原生音频桥接失败：{}", error.message)
                        };
                        emit_transcript_error(&bridge_app, "capture", details);
                        break;
                    }
                    NativeBridgeMessage::Status(status) => {
                        if status.kind == "capture_status" {
                            emit_transcript_status(&bridge_app, &status.source, &status.status);
                        }
                        continue;
                    }
                };
                if frame.sample_rate != 16_000 || frame.channels != 1 {
                    continue;
                }
                let Ok(audio) = BASE64.decode(frame.pcm_base64) else {
                    continue;
                };
                // Raw PCM remains in the trusted Rust process. The webview only
                // receives transcribed text, never audio frames or provider keys.
                let sender = match frame.source.as_str() {
                    "microphone" => &microphone_sender,
                    "system" => &system_sender,
                    _ => continue,
                };
                let received = match frame.source.as_str() {
                    "microphone" => &received_microphone,
                    "system" => &received_system,
                    _ => continue,
                };
                if !received.swap(true, Ordering::Relaxed) {
                    emit_transcript_status(&bridge_app, &frame.source, "audio-receiving");
                }
                let _ = sender.try_send(audio);
            }
        });
        self.child = Some(child);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

impl Drop for CaptureController {
    fn drop(&mut self) {
        // A Tauri shutdown can occur without the webview first invoking
        // `stop_capture`. Do not leave the ScreenCaptureKit bridge orphaned.
        let _ = self.stop();
    }
}

fn spawn_asr_stream(
    app: AppHandle,
    settings: ProviderSettings,
    observability: ModelCallRecorder,
    source: &'static str,
    frames: mpsc::Receiver<Vec<u8>>,
) {
    tauri::async_runtime::spawn(async move {
        let client = match TencentRealtimeAsrClient::with_observability(settings, observability) {
            Ok(client) => client,
            Err(error) => {
                emit_transcript_error(&app, source, error);
                return;
            }
        };
        let stream_app = app.clone();
        emit_transcript_status(&app, source, "connecting");
        let result = client
            .transcribe(
                frames,
                if source == "microphone" {
                    "实时语音转写（本机麦克风）"
                } else {
                    "实时语音转写（系统音频）"
                },
                move |result| {
                    let is_question_candidate =
                        source == "system" && looks_like_question(&result.text);
                    let _ = stream_app.emit(
                        "transcript-stream",
                        TranscriptStreamEvent {
                            id: format!("{source}-{}", result.id),
                            source: source.to_owned(),
                            text: Some(result.text),
                            is_final: result.is_final,
                            is_question_candidate,
                            error: None,
                            status: None,
                        },
                    );
                },
            )
            .await;
        if let Err(error) = result {
            emit_transcript_error(&app, source, error);
        }
    });
}

fn emit_transcript_error(app: &AppHandle, source: &str, error: String) {
    let _ = app.emit(
        "transcript-stream",
        TranscriptStreamEvent {
            id: format!("{source}-error"),
            source: source.to_owned(),
            text: None,
            is_final: true,
            is_question_candidate: false,
            error: Some(error),
            status: None,
        },
    );
}

fn emit_transcript_status(app: &AppHandle, source: &str, status: &str) {
    let _ = app.emit(
        "transcript-stream",
        TranscriptStreamEvent {
            id: format!("{source}-{status}"),
            source: source.to_owned(),
            text: None,
            is_final: false,
            is_question_candidate: false,
            error: None,
            status: Some(status.to_owned()),
        },
    );
}

fn looks_like_question(text: &str) -> bool {
    let normalized = text.trim();
    normalized.ends_with('？')
        || normalized.ends_with('?')
        || normalized.contains("请问")
        || normalized.contains("能否")
        || normalized.contains("怎么")
        || normalized.contains("如何")
        || normalized.contains("是否")
        || normalized.ends_with('吗')
        || normalized.ends_with('么')
}

fn helper_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录：{error}"))?;
    // Tauri preserves the source directory name for array-style `bundle.resources`.
    // Keep the direct lookup as a development-layout fallback.
    let packaged_helper = resource_dir.join("resources").join("MeetingCaptureBridge");
    let development_helper = resource_dir.join("MeetingCaptureBridge");
    [packaged_helper, development_helper]
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            "未找到 MeetingCaptureBridge。请使用 scripts/build-native-bridge.sh 构建并随应用打包。"
                .to_owned()
        })
}
