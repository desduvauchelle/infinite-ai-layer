//! Native terminal-agent adapters.

use std::{
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::StreamExt;
use infinite_ai_core::{
    AgentAdapter, AgentEvent, AgentEventStream, AgentPermissions, AgentRequest, AiError,
    AvailabilityReason, Capability, ConnectionInfo, Cost, CostSource, DataBoundary, ErrorCode,
    EventStream, FinishReason, HealthResult, ModelInfo, ProviderAdapter, StreamEvent,
    StructuredOutputSupport, TextRequest, TextResult, Usage,
};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
};

const MINIMUM_CODEX_MINOR: u64 = 100;

pub struct CodexCliAdapter {
    connection: ConnectionInfo,
    executable: String,
}

impl CodexCliAdapter {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            connection: ConnectionInfo {
                id: id.into(),
                adapter_id: "codex-cli".into(),
                label: "Codex CLI".into(),
                boundary: DataBoundary::PublicCloud,
                capabilities: vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::ReasoningEvents,
                    Capability::AgentExecution,
                ],
            },
            executable: "codex".into(),
        }
    }

    pub fn with_executable(mut self, executable: impl Into<String>) -> Self {
        self.executable = executable.into();
        self
    }

    #[allow(clippy::result_large_err)]
    fn validate(&self, request: &AgentRequest) -> Result<(), AiError> {
        if request.prompt.trim().is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "An agent prompt is required.",
            ));
        }
        if !request.permissions.read {
            return Err(AiError::new(
                ErrorCode::PermissionDenied,
                "Codex requires workspace read permission.",
            ));
        }
        if request.permissions.outside_workspace {
            return Err(AiError::new(
                ErrorCode::PermissionDenied,
                "This adapter never grants access outside the selected workspace.",
            ));
        }
        if request.permissions.network {
            return Err(AiError::new(
                ErrorCode::UnsupportedCapability,
                "Codex network permission is not exposed by this safe adapter yet.",
            ));
        }
        if request.permissions.edit && !request.permissions.shell {
            return Err(AiError::new(
                ErrorCode::UnsupportedCapability,
                "Codex workspace editing requires shell permission because the CLI applies edits through its tool runtime.",
            ));
        }
        let workspace = Path::new(&request.workspace);
        if !workspace.is_absolute() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "The agent workspace must be an absolute path.",
            ));
        }
        if !workspace.is_dir() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "The agent workspace must be an existing directory.",
            ));
        }
        if request
            .maximum_boundary
            .is_some_and(|boundary| self.connection.boundary > boundary)
        {
            return Err(AiError::new(
                ErrorCode::DataBoundaryViolation,
                "Codex CLI exceeds the request data boundary.",
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl AgentAdapter for CodexCliAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        let started = Instant::now();
        let result = Command::new(&self.executable)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .await;
        let checked_at = unix_timestamp();
        match result {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let compatible = codex_version_compatible(&version);
                Ok(HealthResult {
                    available: compatible,
                    reason: if compatible {
                        AvailabilityReason::Available
                    } else {
                        AvailabilityReason::IncompatibleVersion
                    },
                    message: if compatible {
                        version
                    } else {
                        format!("Unsupported Codex CLI version: {version}")
                    },
                    checked_at,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                })
            }
            Ok(output) => Ok(HealthResult {
                available: false,
                reason: AvailabilityReason::IncompatibleVersion,
                message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                checked_at,
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HealthResult {
                available: false,
                reason: AvailabilityReason::ExecutableNotFound,
                message: "Codex CLI was not found on PATH.".into(),
                checked_at,
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
            Err(error) => Err(AiError::new(
                ErrorCode::ProviderUnavailable,
                error.to_string(),
            )),
        }
    }

    async fn run_agent(&self, request: AgentRequest) -> Result<AgentEventStream, AiError> {
        self.validate(&request)?;
        let request_id = request.resolved_request_id();
        let cancellation = request
            .cancellation
            .as_ref()
            .map(tokio_util::sync::CancellationToken::child_token)
            .unwrap_or_default();
        let timed_out = Arc::new(AtomicBool::new(false));
        let timeout_task = request.timeout_ms.map(|timeout_ms| {
            let token = cancellation.clone();
            let timed_out = Arc::clone(&timed_out);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                timed_out.store(true, Ordering::Release);
                token.cancel();
            })
        });
        let mut command = Command::new(&self.executable);
        command
            .arg("--sandbox")
            .arg(if request.permissions.edit {
                "workspace-write"
            } else {
                "read-only"
            })
            .arg("--cd")
            .arg(&request.workspace);
        if !request.agent.model_id.trim().is_empty() && request.agent.model_id != "default" {
            command.arg("--model").arg(&request.agent.model_id);
        }
        command
            .arg("exec")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        if let Some(session_id) = &request.session_id {
            command
                .arg("resume")
                .arg("--json")
                .arg("--skip-git-repo-check")
                .arg(session_id);
        } else {
            command.arg("--json").arg("--skip-git-repo-check");
        }
        command.arg(&request.prompt);

        let mut child = command.spawn().map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::ExecutableNotFound
            } else {
                ErrorCode::ProviderUnavailable
            };
            AiError::new(code, error.to_string()).for_model(&request.agent)
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AiError::new(ErrorCode::ProviderError, "Codex stdout was unavailable.")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AiError::new(ErrorCode::ProviderError, "Codex stderr was unavailable.")
        })?;
        let model = request.agent.clone();
        let workspace = request.workspace.clone();
        let stream = try_stream! {
            yield AgentEvent::Start { request_id, agent: model, workspace };
            let mut lines = BufReader::new(stdout).lines();
            loop {
                let selected = tokio::select! {
                    _ = cancellation.cancelled() => None,
                    line = lines.next_line() => Some(line),
                };
                let Some(next_line) = selected else {
                    terminate_child(&mut child).await;
                    if let Some(task) = &timeout_task { task.abort(); }
                    if timed_out.load(Ordering::Acquire) {
                        Err(AiError::new(ErrorCode::Timeout, "Codex CLI exceeded the configured timeout."))?;
                    }
                    yield AgentEvent::Finish { reason: FinishReason::Cancelled, usage: None };
                    return;
                };
                let next_line = next_line
                    .map_err(|error| AiError::new(ErrorCode::ProviderError, error.to_string()))?;
                let Some(line) = next_line else {
                    break;
                };
                let value: Value = serde_json::from_str(&line).map_err(|error| {
                    AiError::new(ErrorCode::ProviderError, format!("Invalid Codex JSONL event: {error}"))
                })?;
                for event in map_codex_event(&value) {
                    yield event;
                }
            }
            if let Some(task) = &timeout_task { task.abort(); }
            let status = child.wait().await.map_err(|error| AiError::new(ErrorCode::ProviderError, error.to_string()))?;
            if status.success() {
                yield AgentEvent::Finish { reason: FinishReason::Stop, usage: None };
            } else {
                let mut error_text = String::new();
                BufReader::new(stderr)
                    .read_to_string(&mut error_text)
                    .await
                    .map_err(|error| AiError::new(ErrorCode::ProviderError, error.to_string()))?;
                Err(AiError::new(
                    ErrorCode::ProviderError,
                    if error_text.trim().is_empty() { "Codex CLI exited unsuccessfully." } else { error_text.trim() },
                ))?;
            }
        };
        Ok(Box::pin(stream))
    }
}

// The shared normalized error intentionally carries portable provider details. Boxing it only in
// the CLI adapter would make this public implementation inconsistent with the core API.
#[allow(clippy::result_large_err)]
#[async_trait]
impl ProviderAdapter for CodexCliAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        <Self as AgentAdapter>::health(self).await
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AiError> {
        Ok(vec![ModelInfo {
            id: "default".into(),
            name: Some("Configured Codex model".into()),
            capabilities: vec![
                Capability::TextGeneration,
                Capability::TextStreaming,
                Capability::ReasoningEvents,
                Capability::AgentExecution,
            ],
            context_window: None,
            structured_output: Some(StructuredOutputSupport::Unsupported),
            metadata: None,
        }])
    }

    async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        let request_id = request.resolved_request_id();
        let model = request.model.clone();
        let mut stream = <Self as ProviderAdapter>::stream_text(self, request).await?;
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut finish_reason = FinishReason::Unknown;
        let mut usage = None;
        let mut provider_metadata = None;
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::TextDelta { delta } => text.push_str(&delta),
                StreamEvent::ReasoningDelta { delta } => reasoning.push_str(&delta),
                StreamEvent::Usage { usage: next } => usage = Some(next),
                StreamEvent::Finish {
                    reason,
                    usage: final_usage,
                    provider_metadata: metadata,
                } => {
                    finish_reason = reason;
                    usage = final_usage.or(usage);
                    provider_metadata = metadata;
                }
                _ => {}
            }
        }
        Ok(TextResult {
            request_id,
            model,
            text,
            reasoning: (!reasoning.is_empty()).then_some(reasoning),
            tool_calls: Vec::new(),
            finish_reason,
            usage,
            provider_metadata,
        })
    }

    async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        let request_id = request.resolved_request_id();
        let workspace = request
            .provider_options
            .get("codex-cli")
            .and_then(|options| options.get("workspace"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .map(Ok)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        AiError::new(
                            ErrorCode::InvalidRequest,
                            format!("Could not resolve the current workspace: {error}"),
                        )
                    })
            })?;
        let prompt = request
            .messages
            .iter()
            .map(|message| format!("{:?}: {}", message.role, message.text_content()))
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut agent_request = AgentRequest::new(request.model.clone(), prompt, workspace);
        agent_request.request_id = Some(request_id.clone());
        agent_request.permissions = AgentPermissions::read_only();
        agent_request.timeout_ms = request.timeout_ms;
        agent_request.maximum_boundary = request.maximum_boundary;
        agent_request.provider_options = request.provider_options;
        agent_request.cancellation = request.cancellation;
        let mut agent_stream = <Self as AgentAdapter>::run_agent(self, agent_request).await?;
        let model = request.model;
        Ok(Box::pin(try_stream! {
            let mut session_id = None;
            while let Some(event) = agent_stream.next().await {
                match event? {
                    AgentEvent::Start { .. } => yield StreamEvent::Start { request_id: request_id.clone(), model: model.clone() },
                    AgentEvent::Session { session_id: next } => session_id = Some(next),
                    AgentEvent::TextDelta { delta } => yield StreamEvent::TextDelta { delta },
                    AgentEvent::ReasoningDelta { delta } => yield StreamEvent::ReasoningDelta { delta },
                    AgentEvent::Usage { usage } => yield StreamEvent::Usage { usage },
                    AgentEvent::Warning { code, message } => yield StreamEvent::Warning { code, message },
                    AgentEvent::Command { status, .. } => yield StreamEvent::Warning {
                        code: "agent-command".into(),
                        message: format!("Codex reported a read-only command with status '{status}'."),
                    },
                    AgentEvent::FileChange { .. } => yield StreamEvent::Warning {
                        code: "unexpected-file-change".into(),
                        message: "Codex reported a file change during read-only text execution.".into(),
                    },
                    AgentEvent::Finish { reason, usage } => {
                        let metadata = session_id.as_ref().map(|id| {
                            let mut value = serde_json::Map::new();
                            value.insert("sessionId".into(), Value::String(id.clone()));
                            value
                        });
                        yield StreamEvent::Finish { reason, usage, provider_metadata: metadata };
                    }
                }
            }
        }))
    }
}

pub struct ClaudeCliAdapter {
    connection: ConnectionInfo,
    executable: String,
}

impl ClaudeCliAdapter {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            connection: ConnectionInfo {
                id: id.into(),
                adapter_id: "claude-cli".into(),
                label: "Claude Code CLI".into(),
                boundary: DataBoundary::PublicCloud,
                capabilities: vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::ReasoningEvents,
                    Capability::AgentExecution,
                ],
            },
            executable: "claude".into(),
        }
    }

    pub fn with_executable(mut self, executable: impl Into<String>) -> Self {
        self.executable = executable.into();
        self
    }

    #[allow(clippy::result_large_err)]
    fn validate(&self, request: &AgentRequest) -> Result<(), AiError> {
        if request.prompt.trim().is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "An agent prompt is required.",
            ));
        }
        if !request.permissions.read {
            return Err(AiError::new(
                ErrorCode::PermissionDenied,
                "Claude Code requires workspace read permission.",
            ));
        }
        if request.permissions.outside_workspace {
            return Err(AiError::new(
                ErrorCode::PermissionDenied,
                "This adapter never grants access outside the selected workspace.",
            ));
        }
        if request.permissions.network {
            return Err(AiError::new(
                ErrorCode::UnsupportedCapability,
                "Explicit Claude Code network permission is not exposed yet.",
            ));
        }
        if request.permissions.edit && !request.permissions.shell {
            return Err(AiError::new(
                ErrorCode::UnsupportedCapability,
                "Claude Code workspace editing requires shell permission.",
            ));
        }
        let workspace = Path::new(&request.workspace);
        if !workspace.is_absolute() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "The agent workspace must be an absolute path.",
            ));
        }
        if !workspace.is_dir() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "The agent workspace must be an existing directory.",
            ));
        }
        if request
            .maximum_boundary
            .is_some_and(|boundary| self.connection.boundary > boundary)
        {
            return Err(AiError::new(
                ErrorCode::DataBoundaryViolation,
                "Claude Code CLI exceeds the request data boundary.",
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl AgentAdapter for ClaudeCliAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        let started = Instant::now();
        let result = Command::new(&self.executable)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .await;
        let checked_at = unix_timestamp();
        match result {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let compatible = claude_version_compatible(&version);
                Ok(HealthResult {
                    available: compatible,
                    reason: if compatible {
                        AvailabilityReason::Available
                    } else {
                        AvailabilityReason::IncompatibleVersion
                    },
                    message: if compatible {
                        version
                    } else {
                        format!("Unsupported Claude Code CLI version: {version}")
                    },
                    checked_at,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                })
            }
            Ok(output) => Ok(HealthResult {
                available: false,
                reason: AvailabilityReason::IncompatibleVersion,
                message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                checked_at,
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HealthResult {
                available: false,
                reason: AvailabilityReason::ExecutableNotFound,
                message: "Claude Code CLI was not found on PATH.".into(),
                checked_at,
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
            Err(error) => Err(AiError::new(
                ErrorCode::ProviderUnavailable,
                error.to_string(),
            )),
        }
    }

    async fn run_agent(&self, request: AgentRequest) -> Result<AgentEventStream, AiError> {
        self.validate(&request)?;
        let request_id = request.resolved_request_id();
        let cancellation = request
            .cancellation
            .as_ref()
            .map(tokio_util::sync::CancellationToken::child_token)
            .unwrap_or_default();
        let timed_out = Arc::new(AtomicBool::new(false));
        let timeout_task = request.timeout_ms.map(|timeout_ms| {
            let token = cancellation.clone();
            let timed_out = Arc::clone(&timed_out);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                timed_out.store(true, Ordering::Release);
                token.cancel();
            })
        });
        let mut command = Command::new(&self.executable);
        command
            .current_dir(&request.workspace)
            .arg("--print")
            .arg(&request.prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose");
        if !request.agent.model_id.trim().is_empty() && request.agent.model_id != "default" {
            command.arg("--model").arg(&request.agent.model_id);
        }
        if let Some(session_id) = &request.session_id {
            command.arg("--resume").arg(session_id);
        }
        if request.permissions.edit {
            command.arg("--permission-mode").arg("acceptEdits");
        } else {
            command
                .arg("--permission-mode")
                .arg("plan")
                .arg("--allowedTools")
                .arg("Read,Glob,Grep")
                .arg("--disallowedTools")
                .arg("Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::ExecutableNotFound
            } else {
                ErrorCode::ProviderUnavailable
            };
            AiError::new(code, error.to_string()).for_model(&request.agent)
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AiError::new(
                ErrorCode::ProviderError,
                "Claude Code stdout was unavailable.",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AiError::new(
                ErrorCode::ProviderError,
                "Claude Code stderr was unavailable.",
            )
        })?;
        let model = request.agent.clone();
        let workspace = request.workspace.clone();
        let stream = try_stream! {
            yield AgentEvent::Start { request_id, agent: model, workspace };
            let mut lines = BufReader::new(stdout).lines();
            loop {
                let selected = tokio::select! {
                    _ = cancellation.cancelled() => None,
                    line = lines.next_line() => Some(line),
                };
                let Some(next_line) = selected else {
                    terminate_child(&mut child).await;
                    if let Some(task) = &timeout_task { task.abort(); }
                    if timed_out.load(Ordering::Acquire) {
                        Err(AiError::new(ErrorCode::Timeout, "Claude Code CLI exceeded the configured timeout."))?;
                    }
                    yield AgentEvent::Finish { reason: FinishReason::Cancelled, usage: None };
                    return;
                };
                let next_line = next_line
                    .map_err(|error| AiError::new(ErrorCode::ProviderError, error.to_string()))?;
                let Some(line) = next_line else { break; };
                let value: Value = serde_json::from_str(&line).map_err(|error| {
                    AiError::new(ErrorCode::ProviderError, format!("Invalid Claude Code JSONL event: {error}"))
                })?;
                for event in map_claude_event(&value) {
                    yield event;
                }
            }
            if let Some(task) = &timeout_task { task.abort(); }
            let status = child.wait().await.map_err(|error| AiError::new(ErrorCode::ProviderError, error.to_string()))?;
            if status.success() {
                yield AgentEvent::Finish { reason: FinishReason::Stop, usage: None };
            } else {
                let mut error_text = String::new();
                BufReader::new(stderr)
                    .read_to_string(&mut error_text)
                    .await
                    .map_err(|error| AiError::new(ErrorCode::ProviderError, error.to_string()))?;
                Err(AiError::new(
                    ErrorCode::ProviderError,
                    if error_text.trim().is_empty() { "Claude Code CLI exited unsuccessfully." } else { error_text.trim() },
                ))?;
            }
        };
        Ok(Box::pin(stream))
    }
}

#[allow(clippy::result_large_err)]
#[async_trait]
impl ProviderAdapter for ClaudeCliAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        <Self as AgentAdapter>::health(self).await
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AiError> {
        Ok(vec![ModelInfo {
            id: "default".into(),
            name: Some("Configured Claude Code model".into()),
            capabilities: vec![
                Capability::TextGeneration,
                Capability::TextStreaming,
                Capability::ReasoningEvents,
                Capability::AgentExecution,
            ],
            context_window: None,
            structured_output: Some(StructuredOutputSupport::Unsupported),
            metadata: None,
        }])
    }

    async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        let request_id = request.resolved_request_id();
        let model = request.model.clone();
        let mut stream = <Self as ProviderAdapter>::stream_text(self, request).await?;
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut finish_reason = FinishReason::Unknown;
        let mut usage = None;
        let mut provider_metadata = None;
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::TextDelta { delta } => text.push_str(&delta),
                StreamEvent::ReasoningDelta { delta } => reasoning.push_str(&delta),
                StreamEvent::Usage { usage: next } => usage = Some(next),
                StreamEvent::Finish {
                    reason,
                    usage: final_usage,
                    provider_metadata: metadata,
                } => {
                    finish_reason = reason;
                    usage = final_usage.or(usage);
                    provider_metadata = metadata;
                }
                _ => {}
            }
        }
        Ok(TextResult {
            request_id,
            model,
            text,
            reasoning: (!reasoning.is_empty()).then_some(reasoning),
            tool_calls: Vec::new(),
            finish_reason,
            usage,
            provider_metadata,
        })
    }

    async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        let request_id = request.resolved_request_id();
        let workspace = request
            .provider_options
            .get("claude-cli")
            .and_then(|options| options.get("workspace"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .map(Ok)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| {
                        AiError::new(
                            ErrorCode::InvalidRequest,
                            format!("Could not resolve the current workspace: {error}"),
                        )
                    })
            })?;
        let prompt = request
            .messages
            .iter()
            .map(|message| format!("{:?}: {}", message.role, message.text_content()))
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut agent_request = AgentRequest::new(request.model.clone(), prompt, workspace);
        agent_request.request_id = Some(request_id.clone());
        agent_request.permissions = AgentPermissions::read_only();
        agent_request.timeout_ms = request.timeout_ms;
        agent_request.maximum_boundary = request.maximum_boundary;
        agent_request.provider_options = request.provider_options;
        agent_request.cancellation = request.cancellation;
        let mut agent_stream = <Self as AgentAdapter>::run_agent(self, agent_request).await?;
        let model = request.model;
        Ok(Box::pin(try_stream! {
            let mut session_id = None;
            while let Some(event) = agent_stream.next().await {
                match event? {
                    AgentEvent::Start { .. } => yield StreamEvent::Start { request_id: request_id.clone(), model: model.clone() },
                    AgentEvent::Session { session_id: next } => session_id = Some(next),
                    AgentEvent::TextDelta { delta } => yield StreamEvent::TextDelta { delta },
                    AgentEvent::ReasoningDelta { delta } => yield StreamEvent::ReasoningDelta { delta },
                    AgentEvent::Usage { usage } => yield StreamEvent::Usage { usage },
                    AgentEvent::Warning { code, message } => yield StreamEvent::Warning { code, message },
                    AgentEvent::Command { status, .. } => yield StreamEvent::Warning {
                        code: "agent-command".into(),
                        message: format!("Claude Code reported a read-only command with status '{status}'."),
                    },
                    AgentEvent::FileChange { .. } => yield StreamEvent::Warning {
                        code: "unexpected-file-change".into(),
                        message: "Claude Code reported a file change during read-only text execution.".into(),
                    },
                    AgentEvent::Finish { reason, usage } => {
                        let metadata = session_id.as_ref().map(|id| {
                            let mut value = serde_json::Map::new();
                            value.insert("sessionId".into(), Value::String(id.clone()));
                            value
                        });
                        yield StreamEvent::Finish { reason, usage, provider_metadata: metadata };
                    }
                }
            }
        }))
    }
}

async fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(id as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn codex_version_compatible(value: &str) -> bool {
    let Some(version) = value.split_whitespace().find(|part| {
        part.chars()
            .next()
            .is_some_and(|value| value.is_ascii_digit())
    }) else {
        return false;
    };
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok());
    matches!((parts.next(), parts.next()), (Some(0), Some(minor)) if minor >= MINIMUM_CODEX_MINOR)
}

fn claude_version_compatible(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        let mut pieces = part.split('.');
        matches!(
            (pieces.next(), pieces.next(), pieces.next()),
            (Some(major), Some(minor), Some(patch))
                if major.parse::<u64>().is_ok()
                    && minor.parse::<u64>().is_ok()
                    && patch.parse::<u64>().is_ok()
        )
    })
}

fn map_codex_event(value: &Value) -> Vec<AgentEvent> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "thread.started" => string_at(value, &["thread_id"])
            .map(|session_id| AgentEvent::Session { session_id })
            .into_iter()
            .collect(),
        "item.started" | "item.completed" | "item.updated" => map_item(value),
        "turn.completed" => value
            .get("usage")
            .and_then(usage_from_codex)
            .map(|usage| AgentEvent::Usage { usage })
            .into_iter()
            .collect(),
        "error" => vec![AgentEvent::Warning {
            code: "codex-error".into(),
            message: string_at(value, &["message"])
                .unwrap_or_else(|| "Codex reported an error.".into()),
        }],
        _ => Vec::new(),
    }
}

fn map_claude_event(value: &Value) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
        events.push(AgentEvent::Session {
            session_id: session_id.into(),
        });
    }
    if value.get("type").and_then(Value::as_str) == Some("assistant")
        && let Some(content) = value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
    {
        for block in content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(delta) = block.get("text").and_then(Value::as_str) {
                        events.push(AgentEvent::TextDelta {
                            delta: delta.into(),
                        });
                    }
                }
                Some("thinking") => {
                    if let Some(delta) = block.get("thinking").and_then(Value::as_str) {
                        events.push(AgentEvent::ReasoningDelta {
                            delta: delta.into(),
                        });
                    }
                }
                Some("tool_use") => {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").unwrap_or(&Value::Null);
                    if name == "Bash" {
                        events.push(AgentEvent::Command {
                            command: input
                                .get("command")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .into(),
                            status: "started".into(),
                            output: None,
                        });
                    }
                    if matches!(name, "Edit" | "Write" | "NotebookEdit")
                        && let Some(path) = input.get("file_path").and_then(Value::as_str)
                    {
                        events.push(AgentEvent::FileChange {
                            path: path.into(),
                            kind: name.to_ascii_lowercase(),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("result") {
        if let Some(usage) = usage_from_claude(value) {
            events.push(AgentEvent::Usage { usage });
        }
        if value.get("is_error").and_then(Value::as_bool) == Some(true) {
            events.push(AgentEvent::Warning {
                code: "claude-error".into(),
                message: value
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude Code reported an error.")
                    .into(),
            });
        }
    }
    events
}

fn map_item(value: &Value) -> Vec<AgentEvent> {
    let item = match value.get("item") {
        Some(item) => item,
        None => return Vec::new(),
    };
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match item_type {
        "agent_message" => string_at(item, &["text", "content"])
            .map(|delta| AgentEvent::TextDelta { delta })
            .into_iter()
            .collect(),
        "reasoning" => string_at(item, &["text", "content"])
            .map(|delta| AgentEvent::ReasoningDelta { delta })
            .into_iter()
            .collect(),
        "command_execution" => vec![AgentEvent::Command {
            command: string_at(item, &["command"]).unwrap_or_default(),
            status: string_at(item, &["status"]).unwrap_or_else(|| "unknown".into()),
            output: string_at(item, &["aggregated_output", "output"]),
        }],
        "file_change" => item
            .get("changes")
            .and_then(Value::as_array)
            .map(|changes| {
                changes
                    .iter()
                    .filter_map(|change| {
                        string_at(change, &["path"]).map(|path| AgentEvent::FileChange {
                            path,
                            kind: string_at(change, &["kind"]).unwrap_or_else(|| "update".into()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|next| match next {
            Value::String(value) => Some(value.clone()),
            Value::Array(values) => Some(
                values
                    .iter()
                    .filter_map(|value| value.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
    })
}

fn usage_from_codex(value: &Value) -> Option<Usage> {
    let input_tokens = value.get("input_tokens").and_then(Value::as_u64);
    let output_tokens = value.get("output_tokens").and_then(Value::as_u64);
    let cached_input_tokens = value.get("cached_input_tokens").and_then(Value::as_u64);
    if input_tokens.is_none() && output_tokens.is_none() && cached_input_tokens.is_none() {
        return None;
    }
    Some(Usage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens
            .zip(output_tokens)
            .map(|(input, output)| input + output),
        cached_input_tokens,
        reasoning_tokens: None,
        requests: Some(1),
        cost: Some(Cost::unavailable()),
    })
}

fn usage_from_claude(value: &Value) -> Option<Usage> {
    let usage = value.get("usage")?;
    let input_tokens = usage.get("input_tokens").and_then(Value::as_u64);
    let output_tokens = usage.get("output_tokens").and_then(Value::as_u64);
    let cost = value.get("total_cost_usd").and_then(Value::as_f64);
    if input_tokens.is_none() && output_tokens.is_none() && cost.is_none() {
        return None;
    }
    Some(Usage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens
            .zip(output_tokens)
            .map(|(input, output)| input + output),
        cached_input_tokens: usage.get("cache_read_input_tokens").and_then(Value::as_u64),
        reasoning_tokens: None,
        requests: Some(1),
        cost: Some(match cost {
            Some(amount) => Cost {
                amount: Some(amount.to_string()),
                currency: Some("USD".into()),
                source: CostSource::ProviderReported,
                pricing_version: None,
                calculated_at: None,
            },
            None => Cost::unavailable(),
        }),
    })
}

fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    static FAKE_CLI_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[cfg(unix)]
    fn fake_cli(body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "infinite-ai-codex-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("codex-fixture");
        std::fs::write(&executable, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        executable
    }

    #[test]
    fn maps_codex_messages_and_commands() {
        let message = serde_json::json!({
            "type": "item.completed",
            "item": { "type": "agent_message", "text": "Done." }
        });
        assert_eq!(
            map_codex_event(&message),
            vec![AgentEvent::TextDelta {
                delta: "Done.".into()
            }]
        );

        let command = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "command": "cargo test",
                "status": "completed",
                "aggregated_output": "ok"
            }
        });
        assert!(
            matches!(map_codex_event(&command).as_slice(), [AgentEvent::Command { command, .. }] if command == "cargo test")
        );
    }

    #[tokio::test]
    async fn missing_cli_is_reported_as_health_state() {
        let adapter = CodexCliAdapter::new("codex").with_executable("infinite-ai-missing-codex");
        let health = AgentAdapter::health(&adapter).await.expect("health result");
        assert!(!health.available);
        assert_eq!(health.reason, AvailabilityReason::ExecutableNotFound);
    }

    #[test]
    fn enforces_the_published_codex_version_range() {
        assert!(codex_version_compatible("codex-cli 0.139.0"));
        assert!(!codex_version_compatible("codex-cli 0.99.0"));
        assert!(!codex_version_compatible("not-a-version"));
    }

    #[test]
    fn maps_claude_messages_tools_usage_and_cost() {
        let message = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "thinking", "thinking": "Checking." },
                { "type": "text", "text": "Done." },
                { "type": "tool_use", "name": "Bash", "input": { "command": "cargo test" } }
            ] }
        });
        let events = map_claude_event(&message);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::TextDelta { delta } if delta == "Done."))
        );
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::ReasoningDelta { delta } if delta == "Checking.")
        ));
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Command { command, .. } if command == "cargo test")
        ));

        let result = serde_json::json!({
            "type": "result",
            "session_id": "claude-session",
            "total_cost_usd": 0.004,
            "usage": { "input_tokens": 4, "output_tokens": 2 }
        });
        let events = map_claude_event(&result);
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Session { session_id } if session_id == "claude-session")
        ));
        assert!(events.iter().any(|event| {
            matches!(event, AgentEvent::Usage { usage }
                if usage.total_tokens == Some(6)
                    && usage.cost.as_ref().and_then(|cost| cost.amount.as_deref()) == Some("0.004"))
        }));
    }

    #[test]
    fn accepts_semantic_claude_versions() {
        assert!(claude_version_compatible("2.1.80 (Claude Code)"));
        assert!(claude_version_compatible("claude 1.0.0"));
        assert!(!claude_version_compatible("not-a-version"));
    }

    #[tokio::test]
    async fn missing_claude_cli_is_reported_as_health_state() {
        let adapter = ClaudeCliAdapter::new("claude").with_executable("infinite-ai-missing-claude");
        let health = AgentAdapter::health(&adapter).await.expect("health result");
        assert!(!health.available);
        assert_eq!(health.reason, AvailabilityReason::ExecutableNotFound);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_claude_cli_streams_normalized_agent_events() {
        let _guard = FAKE_CLI_TEST_LOCK.lock().await;
        let executable = fake_cli(
            r#"if [ "$1" = "--version" ]; then
  echo "2.1.80 (Claude Code)"
  exit 0
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Checking."},{"type":"text","text":"Done."}]}}'
printf '%s\n' '{"type":"result","subtype":"success","session_id":"claude-session","total_cost_usd":0.004,"usage":{"input_tokens":4,"output_tokens":2},"result":"Done."}'"#,
        );
        let workspace = executable.parent().unwrap().to_string_lossy().into_owned();
        let adapter = ClaudeCliAdapter::new("claude")
            .with_executable(executable.to_string_lossy().into_owned());
        let mut request = AgentRequest::new(
            infinite_ai_core::ModelRef {
                connection_id: "claude".into(),
                model_id: "default".into(),
            },
            "Inspect",
            workspace,
        );
        request.maximum_boundary = Some(DataBoundary::PublicCloud);
        let events = AgentAdapter::run_agent(&adapter, request)
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Session { session_id } if session_id == "claude-session")
        ));
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::TextDelta { delta } if delta == "Done."))
        );
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Usage { usage } if usage.total_tokens == Some(6))
        ));
        std::fs::remove_dir_all(executable.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_cli_streams_normalized_agent_events() {
        let _guard = FAKE_CLI_TEST_LOCK.lock().await;
        let executable = fake_cli(
            r#"if [ "$1" = "--version" ]; then
  echo "codex-cli 0.139.0"
  exit 0
fi
printf '%s\n' '{"type":"thread.started","thread_id":"session-1"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"reasoning","text":"Checking."}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'"#,
        );
        let workspace = executable.parent().unwrap().to_string_lossy().into_owned();
        let adapter = CodexCliAdapter::new("codex")
            .with_executable(executable.to_string_lossy().into_owned());
        let mut request = AgentRequest::new(
            infinite_ai_core::ModelRef {
                connection_id: "codex".into(),
                model_id: "default".into(),
            },
            "Inspect",
            workspace,
        );
        request.maximum_boundary = Some(DataBoundary::PublicCloud);
        let events = AgentAdapter::run_agent(&adapter, request)
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Session { session_id } if session_id == "session-1")
        ));
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::TextDelta { delta } if delta == "Done."))
        );
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Usage { usage } if usage.total_tokens == Some(3))
        ));
        std::fs::remove_dir_all(executable.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates_the_cli_process_group() {
        let _guard = FAKE_CLI_TEST_LOCK.lock().await;
        let executable = fake_cli("sleep 30");
        let workspace = executable.parent().unwrap().to_string_lossy().into_owned();
        let adapter = CodexCliAdapter::new("codex")
            .with_executable(executable.to_string_lossy().into_owned());
        let mut request = AgentRequest::new(
            infinite_ai_core::ModelRef {
                connection_id: "codex".into(),
                model_id: "default".into(),
            },
            "Inspect",
            workspace,
        );
        request.maximum_boundary = Some(DataBoundary::PublicCloud);
        request.timeout_ms = Some(30);
        let mut stream = AgentAdapter::run_agent(&adapter, request).await.unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            AgentEvent::Start { .. }
        ));
        let error = stream.next().await.unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        std::fs::remove_dir_all(executable.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_finishes_with_a_stable_reason() {
        let _guard = FAKE_CLI_TEST_LOCK.lock().await;
        let executable = fake_cli("sleep 30");
        let workspace = executable.parent().unwrap().to_string_lossy().into_owned();
        let adapter = CodexCliAdapter::new("codex")
            .with_executable(executable.to_string_lossy().into_owned());
        let token = tokio_util::sync::CancellationToken::new();
        let mut request = AgentRequest::new(
            infinite_ai_core::ModelRef {
                connection_id: "codex".into(),
                model_id: "default".into(),
            },
            "Inspect",
            workspace,
        );
        request.maximum_boundary = Some(DataBoundary::PublicCloud);
        request.cancellation = Some(token.clone());
        let mut stream = AgentAdapter::run_agent(&adapter, request).await.unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            AgentEvent::Start { .. }
        ));
        token.cancel();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            AgentEvent::Finish {
                reason: FinishReason::Cancelled,
                ..
            }
        ));
        std::fs::remove_dir_all(executable.parent().unwrap()).unwrap();
    }
}
