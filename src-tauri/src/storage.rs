use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        AnswerProfile, KnowledgeDocument, MeetingRecord, ModelInvocation, SourceCitation, Workspace,
    },
    security::encrypt_bytes,
};

#[derive(Debug, Clone)]
pub struct ExtractedSection {
    pub locator: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct StoredChunk {
    pub id: String,
    pub document_id: String,
    pub document_name: String,
    pub locator: String,
    pub content: String,
    pub vector: Option<Vec<f32>>,
    pub lexical_score: f64,
    pub vector_score: f64,
}

pub struct Repository {
    connection: Connection,
    vault_dir: PathBuf,
    key: [u8; 32],
}

impl Repository {
    pub fn open(data_dir: &Path, key: [u8; 32]) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
        let vault_dir = data_dir.join("encrypted-documents");
        fs::create_dir_all(&vault_dir).map_err(|error| format!("无法创建加密资料目录：{error}"))?;
        let database_path = data_dir.join("meeting-copilot.sqlite3");
        let connection =
            Connection::open(database_path).map_err(|error| format!("无法打开资料库：{error}"))?;

        // SQLCipher accepts this statement when linked with bundled-sqlcipher.
        // The same key is separately used for encrypted imported file copies.
        let key_hex = key
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{key_hex}'\"; PRAGMA foreign_keys = ON;"
            ))
            .map_err(|error| format!("无法解锁本地资料库：{error}"))?;
        connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS workspaces (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  kind TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                  id TEXT PRIMARY KEY,
                  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  extension TEXT NOT NULL,
                  status TEXT NOT NULL,
                  segment_count INTEGER NOT NULL DEFAULT 0,
                  updated_at TEXT NOT NULL,
                  source_path TEXT,
                  encrypted_path TEXT,
                  error TEXT
                );
                CREATE TABLE IF NOT EXISTS chunks (
                  id TEXT PRIMARY KEY,
                  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                  locator TEXT NOT NULL,
                  content TEXT NOT NULL,
                  vector_json TEXT
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                  chunk_id UNINDEXED,
                  content,
                  tokenize='unicode61'
                );
                CREATE TABLE IF NOT EXISTS profiles (
                  id TEXT PRIMARY KEY,
                  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  language TEXT NOT NULL,
                  duration TEXT NOT NULL,
                  style TEXT NOT NULL,
                  additional_instructions TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS meeting_records (
                  id TEXT PRIMARY KEY,
                  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                  kind TEXT NOT NULL,
                  title TEXT NOT NULL,
                  job_title TEXT,
                  job_description TEXT,
                  notes TEXT NOT NULL,
                  scheduled_at TEXT,
                  status TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS model_invocations (
                  id TEXT PRIMARY KEY,
                  provider TEXT NOT NULL,
                  model TEXT NOT NULL,
                  operation TEXT NOT NULL,
                  status TEXT NOT NULL,
                  started_at TEXT NOT NULL,
                  completed_at TEXT,
                  duration_ms INTEGER,
                  input_count INTEGER NOT NULL DEFAULT 0,
                  input_unit TEXT NOT NULL,
                  output_count INTEGER NOT NULL DEFAULT 0,
                  output_unit TEXT NOT NULL,
                  error TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_model_invocations_started_at
                  ON model_invocations(started_at DESC);
                ",
            )
            .map_err(|error| format!("无法初始化资料库结构：{error}"))?;

        let repository = Self {
            connection,
            vault_dir,
            key,
        };
        repository.seed_defaults()?;
        Ok(repository)
    }

    fn seed_defaults(&self) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT OR IGNORE INTO workspaces (id, name, kind) VALUES (?1, ?2, ?3)",
                params!["interview", "面试准备", "interview"],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO workspaces (id, name, kind) VALUES (?1, ?2, ?3)",
                params!["business", "商务会议", "business"],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO profiles (id, workspace_id, name, language, duration, style, additional_instructions) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params!["interview-default", "interview", "面试 · STAR 60 秒", "zh", "60s", "star", "先给结论，再说明本人负责内容和可核验结果。"],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT OR IGNORE INTO profiles (id, workspace_id, name, language, duration, style, additional_instructions) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params!["business-default", "business", "商务 · 方案回答", "zh", "60s", "business", "未在资料中确认的内容必须标为待确认。"],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn workspaces(&self) -> Result<Vec<Workspace>, String> {
        let mut statement = self.connection.prepare(
            "
            SELECT w.id, w.name, w.kind,
                   (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id),
                   (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id AND d.status = 'ready')
              FROM workspaces w ORDER BY CASE w.id WHEN 'interview' THEN 0 ELSE 1 END
            ",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(Workspace {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    document_count: row.get(3)?,
                    indexed_count: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn documents(&self) -> Result<Vec<KnowledgeDocument>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, workspace_id, name, extension, status, segment_count, updated_at, source_path, error FROM documents ORDER BY updated_at DESC",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], document_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn profiles(&self) -> Result<Vec<AnswerProfile>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, workspace_id, name, language, duration, style, additional_instructions FROM profiles ORDER BY workspace_id, name",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(AnswerProfile {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    name: row.get(2)?,
                    language: row.get(3)?,
                    duration: row.get(4)?,
                    style: row.get(5)?,
                    additional_instructions: row.get(6)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn meeting_records(&self) -> Result<Vec<MeetingRecord>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, workspace_id, kind, title, job_title, job_description, notes, scheduled_at, status, created_at, updated_at FROM meeting_records ORDER BY COALESCE(scheduled_at, updated_at) DESC",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], meeting_record_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn start_model_invocation(
        &self,
        provider: &str,
        model: &str,
        operation: &str,
        input_count: i64,
        input_unit: &str,
        output_unit: &str,
    ) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        self.connection
            .execute(
                "INSERT INTO model_invocations (id, provider, model, operation, status, started_at, input_count, input_unit, output_unit) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8)",
                params![id, provider, model, operation, Utc::now().to_rfc3339(), input_count, input_unit, output_unit],
            )
            .map_err(|error| format!("无法记录模型调用：{error}"))?;
        Ok(id)
    }

    pub fn finish_model_invocation(
        &self,
        id: &str,
        status: &str,
        duration_ms: i64,
        input_count: Option<i64>,
        output_count: i64,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE model_invocations SET status=?2, completed_at=?3, duration_ms=?4, input_count=COALESCE(?5, input_count), output_count=?6, error=?7 WHERE id=?1",
                params![id, status, Utc::now().to_rfc3339(), duration_ms, input_count, output_count, error.map(compact_observability_error)],
            )
            .map_err(|error| format!("无法更新模型调用记录：{error}"))?;
        Ok(())
    }

    pub fn model_invocations(&self, limit: usize) -> Result<Vec<ModelInvocation>, String> {
        let mut statement = self.connection.prepare(
            "SELECT id, provider, model, operation, status, started_at, completed_at, duration_ms, input_count, input_unit, output_count, output_unit, error FROM model_invocations ORDER BY started_at DESC LIMIT ?1",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(ModelInvocation {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    operation: row.get(3)?,
                    status: row.get(4)?,
                    started_at: row.get(5)?,
                    completed_at: row.get(6)?,
                    duration_ms: row.get(7)?,
                    input_count: row.get(8)?,
                    input_unit: row.get(9)?,
                    output_count: row.get(10)?,
                    output_unit: row.get(11)?,
                    error: row.get(12)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn upsert_profile(&self, profile: &AnswerProfile) -> Result<AnswerProfile, String> {
        self.connection.execute(
            "INSERT INTO profiles (id, workspace_id, name, language, duration, style, additional_instructions)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, language=excluded.language, duration=excluded.duration, style=excluded.style, additional_instructions=excluded.additional_instructions",
            params![profile.id, profile.workspace_id, profile.name, profile.language, profile.duration, profile.style, profile.additional_instructions],
        ).map_err(|error| format!("无法保存回答风格：{error}"))?;
        Ok(profile.clone())
    }

    pub fn upsert_meeting_record(&self, record: &MeetingRecord) -> Result<MeetingRecord, String> {
        if record.kind == "interview"
            && (record.job_title.as_deref().unwrap_or("").trim().is_empty()
                || record
                    .job_description
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                || record.notes.trim().is_empty())
        {
            return Err("面试登记必须包含岗位名称、岗位 JD 和备注信息。".to_owned());
        }
        self.connection.execute(
            "INSERT INTO meeting_records (id, workspace_id, kind, title, job_title, job_description, notes, scheduled_at, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, job_title=excluded.job_title, job_description=excluded.job_description, notes=excluded.notes, scheduled_at=excluded.scheduled_at, status=excluded.status, updated_at=excluded.updated_at",
            params![record.id, record.workspace_id, record.kind, record.title, record.job_title, record.job_description, record.notes, record.scheduled_at, record.status, record.created_at, record.updated_at],
        ).map_err(|error| format!("无法保存会议/面试记录：{error}"))?;
        Ok(record.clone())
    }

    pub fn import_file(&self, workspace_id: &str, path: &str) -> Result<KnowledgeDocument, String> {
        let source = Path::new(path);
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("资料路径无效")?
            .to_owned();
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        let supported = [
            "pdf", "docx", "pptx", "xlsx", "txt", "md", "png", "jpg", "jpeg",
        ]
        .contains(&extension.as_str());
        let id = Uuid::new_v4().to_string();
        let updated_at = Utc::now().to_rfc3339();
        let bytes = fs::read(source).map_err(|error| format!("无法读取资料：{error}"))?;
        let encrypted_path = self.vault_dir.join(format!("{id}.bin"));
        fs::write(&encrypted_path, encrypt_bytes(&self.key, &bytes)?)
            .map_err(|error| format!("无法保存加密资料副本：{error}"))?;
        let status = if supported { "indexing" } else { "unsupported" };
        let error = if supported {
            None
        } else {
            Some("当前版本不支持该文件类型。".to_owned())
        };
        self.connection.execute(
            "INSERT INTO documents (id, workspace_id, name, extension, status, segment_count, updated_at, source_path, encrypted_path, error)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9)",
            params![id, workspace_id, name, extension.to_uppercase(), status, updated_at, path, encrypted_path.to_string_lossy(), error],
        ).map_err(|error| format!("无法登记资料：{error}"))?;
        self.document(&id)
    }

    pub fn document(&self, id: &str) -> Result<KnowledgeDocument, String> {
        self.connection.query_row(
            "SELECT id, workspace_id, name, extension, status, segment_count, updated_at, source_path, error FROM documents WHERE id=?1",
            [id],
            document_from_row,
        ).map_err(|error| format!("找不到资料：{error}"))
    }

    pub fn source_path(&self, id: &str) -> Result<String, String> {
        self.connection
            .query_row(
                "SELECT source_path FROM documents WHERE id=?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|error| format!("找不到资料路径：{error}"))?
            .ok_or("资料原路径不可用".to_owned())
    }

    pub fn delete_document(&self, id: &str) -> Result<(), String> {
        let encrypted_path = self
            .connection
            .query_row(
                "SELECT encrypted_path FROM documents WHERE id=?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        self.connection.execute("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?1)", [id]).map_err(|error| error.to_string())?;
        self.connection
            .execute("DELETE FROM documents WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
        if let Some(path) = encrypted_path {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    pub fn replace_chunks(
        &self,
        document_id: &str,
        sections: &[ExtractedSection],
        vectors: &[Vec<f32>],
    ) -> Result<(), String> {
        if sections.len() != vectors.len() {
            return Err("资料切片与向量数量不一致。".to_owned());
        }
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?1)", [document_id]).map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM chunks WHERE document_id=?1", [document_id])
            .map_err(|error| error.to_string())?;
        for (section, vector) in sections.iter().zip(vectors.iter()) {
            let id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO chunks (id, document_id, locator, content, vector_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, document_id, section.locator, section.content, serde_json::to_string(vector).map_err(|error| error.to_string())?],
            ).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO chunks_fts (chunk_id, content) VALUES (?1, ?2)",
                    params![id, section.content],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.execute(
            "UPDATE documents SET status='ready', segment_count=?2, updated_at=?3, error=NULL WHERE id=?1",
            params![document_id, sections.len() as i64, Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn mark_document_failed(&self, id: &str, message: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE documents SET status='failed', error=?2, updated_at=?3 WHERE id=?1",
                params![id, message, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn profile(&self, id: &str) -> Result<AnswerProfile, String> {
        self.connection.query_row(
            "SELECT id, workspace_id, name, language, duration, style, additional_instructions FROM profiles WHERE id=?1",
            [id],
            |row| Ok(AnswerProfile { id: row.get(0)?, workspace_id: row.get(1)?, name: row.get(2)?, language: row.get(3)?, duration: row.get(4)?, style: row.get(5)?, additional_instructions: row.get(6)? }),
        ).map_err(|error| format!("找不到回答风格：{error}"))
    }

    pub fn meeting_record(&self, id: &str) -> Result<Option<MeetingRecord>, String> {
        self.connection.query_row(
            "SELECT id, workspace_id, kind, title, job_title, job_description, notes, scheduled_at, status, created_at, updated_at FROM meeting_records WHERE id=?1",
            [id],
            meeting_record_from_row,
        ).optional().map_err(|error| error.to_string())
    }

    pub fn hybrid_search(
        &self,
        workspace_id: &str,
        query: &str,
        query_vector: &[f32],
    ) -> Result<Vec<SourceCitation>, String> {
        let mut candidates: HashMap<String, StoredChunk> = HashMap::new();
        let phrase = format!("\"{}\"", query.replace('"', " ").replace('*', " "));
        let mut lexical = self.connection.prepare(
            "SELECT c.id, c.document_id, d.name, c.locator, c.content, c.vector_json, -bm25(chunks_fts) AS score
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE d.workspace_id=?1 AND d.status='ready' AND chunks_fts MATCH ?2
             ORDER BY score DESC LIMIT 50",
        ).map_err(|error| error.to_string())?;
        if let Ok(rows) = lexical.query_map(params![workspace_id, phrase], |row| {
            let vector_json: Option<String> = row.get(5)?;
            Ok(StoredChunk {
                id: row.get(0)?,
                document_id: row.get(1)?,
                document_name: row.get(2)?,
                locator: row.get(3)?,
                content: row.get(4)?,
                vector: vector_json.and_then(|value| serde_json::from_str(&value).ok()),
                lexical_score: row.get(6)?,
                vector_score: 0.0,
            })
        }) {
            for candidate in rows.filter_map(Result::ok) {
                candidates.insert(candidate.id.clone(), candidate);
            }
        }

        let mut vectors = self
            .connection
            .prepare(
                "SELECT c.id, c.document_id, d.name, c.locator, c.content, c.vector_json
             FROM chunks c JOIN documents d ON d.id=c.document_id
             WHERE d.workspace_id=?1 AND d.status='ready' AND c.vector_json IS NOT NULL",
            )
            .map_err(|error| error.to_string())?;
        let mut vector_candidates = vectors
            .query_map([workspace_id], |row| {
                let vector_json: String = row.get(5)?;
                Ok(StoredChunk {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    document_name: row.get(2)?,
                    locator: row.get(3)?,
                    content: row.get(4)?,
                    vector: serde_json::from_str(&vector_json).ok(),
                    lexical_score: 0.0,
                    vector_score: 0.0,
                })
            })
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|mut value| {
                value.vector_score = value
                    .vector
                    .as_deref()
                    .map(|vector| cosine(query_vector, vector))
                    .unwrap_or(0.0);
                value
            })
            .collect::<Vec<_>>();
        vector_candidates.sort_by(|left, right| {
            right
                .vector_score
                .partial_cmp(&left.vector_score)
                .unwrap_or(Ordering::Equal)
        });
        for candidate in vector_candidates.into_iter().take(50) {
            candidates
                .entry(candidate.id.clone())
                .and_modify(|existing| existing.vector_score = candidate.vector_score)
                .or_insert(candidate);
        }

        let mut values = candidates.into_values().collect::<Vec<_>>();
        values.sort_by(|left, right| {
            let left_score = left.lexical_score + left.vector_score;
            let right_score = right.lexical_score + right.vector_score;
            right_score
                .partial_cmp(&left_score)
                .unwrap_or(Ordering::Equal)
        });
        Ok(values
            .into_iter()
            .take(12)
            .map(|value| SourceCitation {
                document_id: value.document_id,
                document_name: value.document_name,
                locator: value.locator,
                excerpt: truncate(&value.content, 420),
                score: value.lexical_score + value.vector_score,
            })
            .collect())
    }
}

fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeDocument> {
    Ok(KnowledgeDocument {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        extension: row.get(3)?,
        status: row.get(4)?,
        segment_count: row.get(5)?,
        updated_at: row.get(6)?,
        source_path: row.get(7)?,
        error: row.get(8)?,
    })
}

fn meeting_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRecord> {
    Ok(MeetingRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        job_title: row.get(4)?,
        job_description: row.get(5)?,
        notes: row.get(6)?,
        scheduled_at: row.get(7)?,
        status: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (a, b) in left.iter().zip(right) {
        dot += f64::from(*a) * f64::from(*b);
        left_norm += f64::from(*a) * f64::from(*a);
        right_norm += f64::from(*b) * f64::from(*b);
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        return 0.0;
    }
    dot / (left_norm.sqrt() * right_norm.sqrt())
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    value.chars().take(max).collect::<String>() + "…"
}

fn compact_observability_error(value: &str) -> String {
    value.chars().take(600).collect()
}
