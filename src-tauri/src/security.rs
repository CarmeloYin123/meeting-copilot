use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use keyring::Entry;
use rand::RngCore;

use crate::models::ProviderSettings;

const SERVICE: &str = "com.meetingcopilot.desktop";
const VAULT_KEY_ACCOUNT: &str = "knowledge-vault-key";
const PROVIDER_SETTINGS_ACCOUNT: &str = "provider-settings";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|error| format!("无法访问 macOS Keychain：{error}"))
}

pub fn vault_key() -> Result<[u8; 32], String> {
    let item = entry(VAULT_KEY_ACCOUNT)?;
    let encoded = match item.get_password() {
        Ok(value) => value,
        Err(_) => {
            let mut bytes = [0_u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let value = BASE64.encode(bytes);
            item.set_password(&value)
                .map_err(|error| format!("无法将资料库密钥写入 Keychain：{error}"))?;
            value
        }
    };
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("资料库密钥格式无效：{error}"))?;
    bytes
        .try_into()
        .map_err(|_| "资料库密钥长度无效".to_owned())
}

pub fn load_provider_settings() -> Result<ProviderSettings, String> {
    let item = entry(PROVIDER_SETTINGS_ACCOUNT)?;
    match item.get_password() {
        Ok(value) => serde_json::from_str::<ProviderSettings>(&value)
            .map(|settings| settings.normalized())
            .map_err(|error| format!("已保存的模型配置无法读取：{error}")),
        Err(_) => Ok(ProviderSettings::default().normalized()),
    }
}

pub fn save_provider_settings(draft: &ProviderSettings) -> Result<ProviderSettings, String> {
    // The frontend never receives stored secrets. Empty secret fields therefore mean
    // “keep the Keychain value”, rather than “erase it on the next settings save”.
    let saved = load_provider_settings()?;
    let settings = ProviderSettings {
        tencent_app_id: keep_saved(&draft.tencent_app_id, &saved.tencent_app_id),
        tencent_secret_id: keep_saved(&draft.tencent_secret_id, &saved.tencent_secret_id),
        tencent_secret_key: keep_saved(&draft.tencent_secret_key, &saved.tencent_secret_key),
        tencent_asr_endpoint: keep_saved(&draft.tencent_asr_endpoint, &saved.tencent_asr_endpoint),
        bailian_api_key: keep_saved(&draft.bailian_api_key, &saved.bailian_api_key),
        bailian_endpoint: keep_saved(&draft.bailian_endpoint, &saved.bailian_endpoint),
        embedding_model: keep_saved(&draft.embedding_model, &saved.embedding_model),
        rerank_model: keep_saved(&draft.rerank_model, &saved.rerank_model),
        chat_model: keep_saved(&draft.chat_model, &saved.chat_model),
        ocr_model: keep_saved(&draft.ocr_model, &saved.ocr_model),
    }
    .normalized();
    let value =
        serde_json::to_string(&settings).map_err(|error| format!("模型配置无法序列化：{error}"))?;
    entry(PROVIDER_SETTINGS_ACCOUNT)?
        .set_password(&value)
        .map_err(|error| format!("无法将模型配置写入 Keychain：{error}"))?;
    Ok(settings)
}

fn keep_saved(draft: &str, saved: &str) -> String {
    if draft.trim().is_empty() {
        saved.to_owned()
    } else {
        draft.to_owned()
    }
}

pub fn encrypt_bytes(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|error| format!("加密器初始化失败：{error}"))?;
    let mut nonce = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|error| format!("资料加密失败：{error}"))?;
    let mut result = nonce.to_vec();
    result.extend(encrypted);
    Ok(result)
}
