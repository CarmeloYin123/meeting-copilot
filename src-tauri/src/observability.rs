use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use crate::storage::Repository;

/// A local-only audit trail for cloud model calls. It intentionally stores only
/// model metadata, timings, counters, and compact error messages.
#[derive(Clone)]
pub struct ModelCallRecorder {
    repository: Arc<Mutex<Repository>>,
}

impl ModelCallRecorder {
    pub fn new(repository: Arc<Mutex<Repository>>) -> Self {
        Self { repository }
    }

    pub fn begin(
        &self,
        provider: &str,
        model: &str,
        operation: &str,
        input_count: i64,
        input_unit: &str,
        output_unit: &str,
    ) -> ModelCallSpan {
        let id = self.repository.lock().ok().and_then(|repository| {
            repository
                .start_model_invocation(
                    provider,
                    model,
                    operation,
                    input_count,
                    input_unit,
                    output_unit,
                )
                .ok()
        });
        ModelCallSpan {
            recorder: self.clone(),
            id,
            started: Instant::now(),
        }
    }

    fn finish(
        &self,
        id: &str,
        status: &str,
        duration_ms: i64,
        input_count: Option<i64>,
        output_count: i64,
        error: Option<&str>,
    ) {
        if let Ok(repository) = self.repository.lock() {
            let _ = repository.finish_model_invocation(
                id,
                status,
                duration_ms,
                input_count,
                output_count,
                error,
            );
        }
    }
}

pub struct ModelCallSpan {
    recorder: ModelCallRecorder,
    id: Option<String>,
    started: Instant,
}

impl ModelCallSpan {
    pub fn succeed(self, output_count: i64) {
        if let Some(id) = self.id.as_deref() {
            self.recorder.finish(
                id,
                "success",
                self.started.elapsed().as_millis() as i64,
                None,
                output_count,
                None,
            );
        }
    }

    pub fn succeed_with_input(self, input_count: i64, output_count: i64) {
        if let Some(id) = self.id.as_deref() {
            self.recorder.finish(
                id,
                "success",
                self.started.elapsed().as_millis() as i64,
                Some(input_count),
                output_count,
                None,
            );
        }
    }

    pub fn fail(self, error: &str) {
        if let Some(id) = self.id.as_deref() {
            self.recorder.finish(
                id,
                "failed",
                self.started.elapsed().as_millis() as i64,
                None,
                0,
                Some(error),
            );
        }
    }

    pub fn fail_with_input(self, input_count: i64, error: &str) {
        if let Some(id) = self.id.as_deref() {
            self.recorder.finish(
                id,
                "failed",
                self.started.elapsed().as_millis() as i64,
                Some(input_count),
                0,
                Some(error),
            );
        }
    }
}
