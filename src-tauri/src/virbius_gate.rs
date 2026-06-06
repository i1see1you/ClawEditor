use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use virbius_core::{EffectiveAction, ScanContext, VirbiusEdge, VirbiusError};

static EDGE: Mutex<Option<VirbiusEdge>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirbiusConfigureArgs {
    pub data_dir: String,
    pub tenant_id: Option<String>,
    pub app_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirbiusOutboundPart {
    pub key: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirbiusGateOutboundArgs {
    pub scene: String,
    pub parts: Vec<VirbiusOutboundPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirbiusGateOutboundResult {
    pub trace_id: String,
    pub parts: Vec<VirbiusOutboundPart>,
    pub blocked: bool,
    pub block_reason: Option<String>,
    pub review_hit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirbiusGateInboundArgs {
    pub trace_id: String,
    pub content: String,
    pub scene: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirbiusGateInboundResult {
    pub content: String,
    pub unresolved_tokens: Vec<String>,
}

fn ensure_edge(data_dir: &str, tenant_id: &str, app_id: &str) -> Result<(), String> {
    let mut guard = EDGE.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    // SAFETY: set before first VirbiusEdge::new on this process; no other threads read these yet.
    unsafe {
        std::env::set_var("VIRBIUS_DATA_DIR", data_dir);
        std::env::set_var("VIRBIUS_TENANT_ID", tenant_id);
        std::env::set_var("VIRBIUS_APP_ID", app_id);
    }
    *guard = Some(VirbiusEdge::new());
    Ok(())
}

fn with_edge<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&VirbiusEdge) -> Result<T, String>,
{
    let guard = EDGE.lock().map_err(|e| e.to_string())?;
    let edge = guard.as_ref().ok_or_else(|| {
        "Virbius 未初始化：请先调用 virbius_configure".to_string()
    })?;
    f(edge)
}

fn virbius_err(label: &str, err: VirbiusError) -> String {
    match err {
        VirbiusError::EmptyContent => format!("{label}: empty"),
        VirbiusError::InvalidTraceId => format!("{label}: invalid trace_id"),
    }
}

fn project_virbius_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/virbius")
}

fn canonical_dir(path: PathBuf) -> Result<String, String> {
    Ok(path
        .canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned())
}

/// Default Virbius data root shipped with ClawEditor (`data/virbius` in repo; bundled in release).
#[tauri::command]
pub fn virbius_default_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return canonical_dir(project_virbius_data_dir());
    }
    let resource = app
        .path()
        .resolve("virbius", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    if resource.exists() {
        return canonical_dir(resource);
    }
    canonical_dir(project_virbius_data_dir())
}

#[tauri::command]
pub fn virbius_configure(args: VirbiusConfigureArgs) -> Result<(), String> {
    let tenant = args.tenant_id.unwrap_or_else(|| "default".into());
    let app = args.app_id.unwrap_or_else(|| "ClawEditor".into());
    ensure_edge(&args.data_dir, &tenant, &app)
}

#[tauri::command]
pub fn virbius_reload() -> Result<(), String> {
    with_edge(|edge| {
        edge.reload();
        Ok(())
    })
}

#[tauri::command]
pub fn virbius_gate_outbound(args: VirbiusGateOutboundArgs) -> Result<VirbiusGateOutboundResult, String> {
    with_edge(|edge| {
        let scene = args.scene.trim();
        let scene_opt = if scene.is_empty() {
            None
        } else {
            Some(scene.to_string())
        };

        let mut ctx = ScanContext {
            scene: scene_opt.clone(),
            ..Default::default()
        };

        let mut blocked = false;
        let mut block_reason: Option<String> = None;
        let mut review_hit = false;
        let mut trace_id = String::new();

        for part in &args.parts {
            if part.text.is_empty() {
                continue;
            }
            let out = edge
                .scan_with(ctx.clone(), &part.text)
                .map_err(|e| virbius_err(&part.key, e))?;
            if trace_id.is_empty() {
                trace_id = out.trace_id.clone();
                ctx.trace_id = Some(trace_id.clone());
            }
            match out.action {
                EffectiveAction::Block => {
                    blocked = true;
                    block_reason = Some(format!(
                        "Virbius 拦截（{}）：{}",
                        part.key,
                        out.primary
                            .as_ref()
                            .map(|h| h.reason_code.as_str())
                            .unwrap_or("EDGE_DENY")
                    ));
                    break;
                }
                EffectiveAction::Review => review_hit = true,
                EffectiveAction::Allow | EffectiveAction::Captcha => {}
            }
        }

        if blocked {
            return Ok(VirbiusGateOutboundResult {
                trace_id,
                parts: args.parts,
                blocked: true,
                block_reason,
                review_hit,
            });
        }

        if trace_id.is_empty() {
            let seed = args
                .parts
                .iter()
                .find(|p| !p.text.is_empty())
                .map(|p| p.text.as_str())
                .unwrap_or(" ");
            let out = edge
                .scan_with(ctx.clone(), seed)
                .map_err(|e| virbius_err("bootstrap", e))?;
            trace_id = out.trace_id.clone();
            ctx.trace_id = Some(trace_id.clone());
        }

        let mut gated_parts = Vec::with_capacity(args.parts.len());
        for part in &args.parts {
            if part.text.is_empty() {
                gated_parts.push(part.clone());
                continue;
            }
            let masked = edge
                .desensitize_in_with(ctx.clone(), &part.text)
                .map_err(|e| virbius_err(&part.key, e))?;
            gated_parts.push(VirbiusOutboundPart {
                key: part.key.clone(),
                text: masked.text,
            });
        }

        Ok(VirbiusGateOutboundResult {
            trace_id,
            parts: gated_parts,
            blocked: false,
            block_reason: None,
            review_hit,
        })
    })
}

#[tauri::command]
pub fn virbius_gate_inbound(args: VirbiusGateInboundArgs) -> Result<VirbiusGateInboundResult, String> {
    with_edge(|edge| {
        let ctx = ScanContext {
            scene: args.scene.filter(|s| !s.trim().is_empty()),
            trace_id: Some(args.trace_id.clone()),
            ..Default::default()
        };
        let restored = edge.desensitize_out_with(&args.trace_id, &args.content, ctx);
        Ok(VirbiusGateInboundResult {
            content: restored.text,
            unresolved_tokens: restored.unresolved_tokens,
        })
    })
}
