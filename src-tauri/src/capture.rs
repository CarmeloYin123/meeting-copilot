use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
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
    process: Option<CaptureProcess>,
    observability: Option<ModelCallRecorder>,
}

struct CaptureProcess {
    child: Child,
    stdin: ChildStdin,
}

const BRIDGE_STOP_TIMEOUT: Duration = Duration::from_secs(3);
const BRIDGE_STOP_POLL_INTERVAL: Duration = Duration::from_millis(50);
const BRIDGE_FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStopResult {
    pub outcome: String,
    pub message: String,
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
        if self.process.is_some() {
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
            observability.clone(),
            "system",
            system_frames,
        );
        let helper = helper_path(app)?;
        let mut child = Command::new(helper)
            .arg("--stream")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动 macOS 音频采集：{error}"))?;
        let stdout = child.stdout.take().ok_or("无法读取原生音频采集输出。")?;
        let stdin = child.stdin.take().ok_or("无法控制原生音频采集。")?;
        let bridge_app = app.clone();
        std::thread::spawn(move || {
            let received_microphone = Arc::new(AtomicBool::new(false));
            let received_system = Arc::new(AtomicBool::new(false));
            let mut microphone_frames = 0_u64;
            let mut microphone_bytes = 0_u64;
            let mut system_frames = 0_u64;
            let mut system_bytes = 0_u64;
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
                let (frame_count, byte_count) = match frame.source.as_str() {
                    "microphone" => (&mut microphone_frames, &mut microphone_bytes),
                    "system" => (&mut system_frames, &mut system_bytes),
                    _ => continue,
                };
                *frame_count += 1;
                *byte_count += audio.len() as u64;
                if *frame_count == 1 || *frame_count % 25 == 0 {
                    emit_transcript_health(
                        &bridge_app,
                        &frame.source,
                        *frame_count,
                        *byte_count as f64 / 32_000.0,
                    );
                }
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
        self.process = Some(CaptureProcess { child, stdin });
        self.observability = Some(observability);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<CaptureStopResult, String> {
        let Some(mut process) = self.process.take() else {
            return Ok(CaptureStopResult {
                outcome: "not-running".to_owned(),
                message: "当前没有正在运行的音频桥接。".to_owned(),
            });
        };

        let observability = self.observability.take();
        let release_span = observability.as_ref().map(|recorder| {
            recorder.begin(
                "本地 macOS",
                "MeetingCaptureBridge",
                "音频桥接释放",
                0,
                "音频秒（本机估算）",
                "释放状态",
            )
        });

        match process.child.try_wait() {
            Ok(Some(status)) => {
                let message = format!("桥接进程已退出（状态：{status}），无需重复释放。");
                if status.success() {
                    if let Some(span) = release_span {
                        span.succeed(1);
                    }
                    return Ok(CaptureStopResult {
                        outcome: "already-exited".to_owned(),
                        message,
                    });
                }
                if let Some(span) = release_span {
                    span.fail(&message);
                }
                return Err(message);
            }
            Ok(None) => {}
            Err(error) => {
                let message = format!("无法检查音频桥接状态：{error}");
                if let Some(span) = release_span {
                    span.fail(&message);
                }
                self.restore_process(process, observability);
                return Err(message);
            }
        }

        let graceful_stop = process
            .stdin
            .write_all(b"{\"type\":\"stop\"}\n")
            .and_then(|_| process.stdin.flush());

        if let Err(error) = graceful_stop {
            let message = format!("无法向音频桥接发送停止命令：{error}");
            return self.force_stop(process, observability, release_span, &message);
        }

        match wait_for_child_exit(&mut process.child, BRIDGE_STOP_TIMEOUT) {
            Ok(Some(status)) if status.success() => {
                if let Some(span) = release_span {
                    span.succeed(1);
                }
                Ok(CaptureStopResult {
                    outcome: "released".to_owned(),
                    message: "桥接已释放 ScreenCaptureKit 和麦克风采集。".to_owned(),
                })
            }
            Ok(Some(status)) => {
                let message = format!("音频桥接释放失败（状态：{status}）。");
                if let Some(span) = release_span {
                    span.fail(&message);
                }
                Err(message)
            }
            Ok(None) => self.force_stop(
                process,
                observability,
                release_span,
                "等待音频桥接释放超过 3 秒。",
            ),
            Err(error) => self.force_stop(
                process,
                observability,
                release_span,
                &format!("检查音频桥接释放状态失败：{error}"),
            ),
        }
    }

    fn force_stop(
        &mut self,
        mut process: CaptureProcess,
        observability: Option<ModelCallRecorder>,
        release_span: Option<crate::observability::ModelCallSpan>,
        reason: &str,
    ) -> Result<CaptureStopResult, String> {
        if let Some(span) = release_span {
            span.fail(reason);
        }
        let fallback_span = observability.as_ref().map(|recorder| {
            recorder.begin(
                "本地 macOS",
                "MeetingCaptureBridge",
                "音频桥接强制结束兜底",
                0,
                "音频秒（本机估算）",
                "结束状态",
            )
        });
        match process.child.kill() {
            Ok(()) => match wait_for_child_exit(&mut process.child, BRIDGE_FORCE_STOP_TIMEOUT) {
                Ok(Some(status)) => {
                    let message = format!("{reason} 已执行强制结束兜底（状态：{status}）。");
                    if let Some(span) = fallback_span {
                        span.fail(&message);
                    }
                    Ok(CaptureStopResult {
                        outcome: "forced".to_owned(),
                        message,
                    })
                }
                Ok(None) => {
                    let message = format!("{reason} 强制结束已发出，但 1 秒内未确认桥接退出。");
                    if let Some(span) = fallback_span {
                        span.fail(&message);
                    }
                    self.restore_process(process, observability);
                    Err(message)
                }
                Err(error) => {
                    let message = format!("{reason} 无法确认强制结束结果：{error}");
                    if let Some(span) = fallback_span {
                        span.fail(&message);
                    }
                    self.restore_process(process, observability);
                    Err(message)
                }
            },
            Err(error) => {
                let message = format!("{reason} 强制结束音频桥接失败：{error}");
                if let Some(span) = fallback_span {
                    span.fail(&message);
                }
                self.restore_process(process, observability);
                Err(message)
            }
        }
    }

    fn restore_process(
        &mut self,
        process: CaptureProcess,
        observability: Option<ModelCallRecorder>,
    ) {
        self.process = Some(process);
        self.observability = observability;
    }
}

fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(BRIDGE_STOP_POLL_INTERVAL);
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
                            audio_frames: None,
                            audio_seconds: None,
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
            audio_frames: None,
            audio_seconds: None,
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
            audio_frames: None,
            audio_seconds: None,
        },
    );
}

fn emit_transcript_health(app: &AppHandle, source: &str, audio_frames: u64, audio_seconds: f64) {
    let _ = app.emit(
        "transcript-stream",
        TranscriptStreamEvent {
            id: format!("{source}-audio-health"),
            source: source.to_owned(),
            text: None,
            is_final: false,
            is_question_candidate: false,
            error: None,
            status: Some("audio-healthy".to_owned()),
            audio_frames: Some(audio_frames),
            audio_seconds: Some(audio_seconds),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_sends_the_graceful_bridge_command_before_process_exit() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                r#"IFS= read -r command; [ "$command" = '{"type":"stop"}' ]"#,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test bridge should start");
        let stdin = child.stdin.take().expect("test bridge stdin should exist");
        let mut controller = CaptureController {
            process: Some(CaptureProcess { child, stdin }),
            observability: None,
        };

        let result = controller.stop().expect("bridge should exit gracefully");
        assert_eq!(result.outcome, "released");
    }
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
