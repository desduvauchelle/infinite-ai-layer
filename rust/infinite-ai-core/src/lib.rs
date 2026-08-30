use std::{collections::HashMap, pin::Pin, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_core::Stream;
use futures_util::StreamExt;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const CONTRACT_VERSION: &str = "0.1";
pub type JsonObject = Map<String, Value>;
pub type EventStream = Pin<Box<dyn Stream<Item = Result<StreamEvent, AiError>> + Send>>;
pub type AgentEventStream = Pin<Box<dyn Stream<Item = Result<AgentEvent, AiError>> + Send>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub connection_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum DataBoundary {
    Device,
    LocalNetwork,
    PrivateRemote,
    PublicCloud,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    ProviderHealth,
    ModelListing,
    TextGeneration,
    TextStreaming,
    StructuredOutput,
    ToolCalling,
    ReasoningEvents,
    Embeddings,
    Transcription,
    SpeechGeneration,
    ImageUnderstanding,
    ImageGeneration,
    ImageEditing,
    VideoGeneration,
    VideoEditing,
    AgentExecution,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StructuredOutputSupport {
    NativeSchema,
    JsonOnly,
    BestEffort,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub adapter_id: String,
    pub label: String,
    pub boundary: DataBoundary,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub capabilities: Vec<Capability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<StructuredOutputSupport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AvailabilityReason {
    Available,
    Unreachable,
    AuthenticationFailed,
    NotConfigured,
    ExecutableNotFound,
    IncompatibleVersion,
    ModelNotReady,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    pub available: bool,
    pub reason: AvailabilityReason,
    pub message: String,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub result: Value,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInput {
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ContentPart {
    Text { text: String },
    Image { media: MediaInput },
    Audio { media: MediaInput },
    File { media: MediaInput },
    ToolCall { call: ToolCall },
    ToolResult { result: ToolResult },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentPart>,
}

impl Message {
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            content: vec![ContentPart::Text { text: text.into() }],
        }
    }

    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: JsonObject,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Named(String),
}

impl Serialize for ToolChoice {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Auto => serializer.serialize_str("auto"),
            Self::None => serializer.serialize_str("none"),
            Self::Required => serializer.serialize_str("required"),
            Self::Named(name) => {
                let mut value = Map::new();
                value.insert("name".into(), Value::String(name.clone()));
                value.serialize(serializer)
            }
        }
    }
}

impl<'de> Deserialize<'de> for ToolChoice {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match Value::deserialize(deserializer)? {
            Value::String(value) if value == "auto" => Ok(Self::Auto),
            Value::String(value) if value == "none" => Ok(Self::None),
            Value::String(value) if value == "required" => Ok(Self::Required),
            Value::Object(value) => value
                .get("name")
                .and_then(Value::as_str)
                .map(|name| Self::Named(name.to_string()))
                .ok_or_else(|| D::Error::custom("named tool choice requires a string name")),
            _ => Err(D::Error::custom(
                "tool choice must be auto, none, required, or an object with name",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub model: ModelRef,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_boundary: Option<DataBoundary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub provider_options: HashMap<String, JsonObject>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<ToolChoice>,
    #[serde(skip)]
    pub cancellation: Option<CancellationToken>,
}

impl TextRequest {
    pub fn new(model: ModelRef, messages: Vec<Message>) -> Self {
        Self {
            request_id: None,
            model,
            messages,
            max_output_tokens: None,
            temperature: None,
            timeout_ms: None,
            maximum_boundary: None,
            metadata: None,
            provider_options: HashMap::new(),
            tools: Vec::new(),
            tool_choice: None,
            cancellation: None,
        }
    }

    pub fn resolved_request_id(&self) -> String {
        self.request_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CostSource {
    ProviderReported,
    SdkEstimated,
    HostSupplied,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    pub source: CostSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calculated_at: Option<String>,
}

impl Cost {
    pub fn unavailable() -> Self {
        Self {
            amount: None,
            currency: None,
            source: CostSource::Unavailable,
            pricing_version: None,
            calculated_at: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Cancelled,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextResult {
    pub request_id: String,
    pub model: ModelRef,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: FinishReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<JsonObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    Start {
        request_id: String,
        model: ModelRef,
    },
    TextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolCallStart {
        call_id: String,
        name: String,
    },
    ToolCallDelta {
        call_id: String,
        arguments_delta: String,
    },
    ToolCall {
        call: ToolCall,
    },
    Citation {
        citation: JsonObject,
    },
    Usage {
        usage: Usage,
    },
    Warning {
        code: String,
        message: String,
    },
    Finish {
        reason: FinishReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<JsonObject>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRequest {
    #[serde(flatten)]
    pub text: TextRequest,
    pub schema: JsonObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_name: Option<String>,
    #[serde(default)]
    pub repair_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectResult {
    pub request_id: String,
    pub model: ModelRef,
    pub value: Value,
    pub raw_text: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: FinishReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRequest {
    pub model: ModelRef,
    pub input: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_mode: Option<EmbeddingInputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_boundary: Option<DataBoundary>,
    #[serde(skip)]
    pub cancellation: Option<CancellationToken>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EmbeddingInputMode {
    Query,
    Document,
    Unspecified,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingResult {
    pub vectors: Vec<Vec<f32>>,
    pub model: ModelRef,
    pub dimensions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_mode: Option<EmbeddingInputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRequest {
    pub model: ModelRef,
    pub audio: MediaInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_boundary: Option<DataBoundary>,
    #[serde(skip)]
    pub cancellation: Option<CancellationToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegment {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<TranscriptionSegment>,
    pub model: ModelRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<JsonObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissions {
    pub read: bool,
    pub edit: bool,
    pub shell: bool,
    pub network: bool,
    pub outside_workspace: bool,
}

impl AgentPermissions {
    pub fn read_only() -> Self {
        Self {
            read: true,
            edit: false,
            shell: false,
            network: false,
            outside_workspace: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub agent: ModelRef,
    pub prompt: String,
    pub workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub permissions: AgentPermissions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_boundary: Option<DataBoundary>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub provider_options: HashMap<String, JsonObject>,
    #[serde(skip)]
    pub cancellation: Option<CancellationToken>,
}

impl AgentRequest {
    pub fn new(agent: ModelRef, prompt: impl Into<String>, workspace: impl Into<String>) -> Self {
        Self {
            request_id: None,
            agent,
            prompt: prompt.into(),
            workspace: workspace.into(),
            session_id: None,
            permissions: AgentPermissions::read_only(),
            timeout_ms: None,
            maximum_boundary: Some(DataBoundary::Device),
            provider_options: HashMap::new(),
            cancellation: None,
        }
    }

    pub fn resolved_request_id(&self) -> String {
        self.request_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Start {
        request_id: String,
        agent: ModelRef,
        workspace: String,
    },
    Session {
        session_id: String,
    },
    TextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    Command {
        command: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    FileChange {
        path: String,
        kind: String,
    },
    Warning {
        code: String,
        message: String,
    },
    Usage {
        usage: Usage,
    },
    Finish {
        reason: FinishReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    InvalidRequest,
    UnsupportedCapability,
    ProviderUnavailable,
    AuthenticationFailed,
    PermissionDenied,
    RateLimited,
    QuotaExceeded,
    ContentBlocked,
    ContextOverflow,
    Timeout,
    Cancelled,
    ExecutableNotFound,
    IncompatibleVersion,
    SchemaValidationFailed,
    DataBoundaryViolation,
    ProviderError,
}

#[derive(Debug, Clone, Error, Serialize, Deserialize, PartialEq)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<JsonObject>,
}

impl AiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: redact_secrets(&message.into()),
            retryable: false,
            connection_id: None,
            model_id: None,
            retry_after_ms: None,
            provider_code: None,
            details: None,
        }
    }

    pub fn for_model(mut self, model: &ModelRef) -> Self {
        self.connection_id = Some(model.connection_id.clone());
        self.model_id = Some(model.model_id.clone());
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

pub fn redact_secrets(value: &str) -> String {
    value
        .split_whitespace()
        .scan(false, |redact_next, token| {
            if *redact_next {
                *redact_next = false;
                return Some("[REDACTED]".to_string());
            }
            if token.eq_ignore_ascii_case("bearer")
                || token.to_ascii_lowercase().contains("api_key=")
            {
                *redact_next = token.eq_ignore_ascii_case("bearer");
                return Some(if token.eq_ignore_ascii_case("bearer") {
                    "Bearer".to_string()
                } else {
                    "[REDACTED]".to_string()
                });
            }
            if token.starts_with("sk-") {
                Some("[REDACTED]".to_string())
            } else {
                Some(token.to_string())
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn connection(&self) -> &ConnectionInfo;
    async fn health(&self) -> Result<HealthResult, AiError>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>, AiError>;

    async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        Err(unsupported(&request.model, Capability::TextGeneration))
    }

    async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        Err(unsupported(&request.model, Capability::TextStreaming))
    }

    async fn generate_object(&self, request: ObjectRequest) -> Result<ObjectResult, AiError> {
        Err(unsupported(
            &request.text.model,
            Capability::StructuredOutput,
        ))
    }

    async fn embed(&self, request: EmbeddingRequest) -> Result<EmbeddingResult, AiError> {
        Err(unsupported(&request.model, Capability::Embeddings))
    }

    async fn transcribe(
        &self,
        request: TranscriptionRequest,
    ) -> Result<TranscriptionResult, AiError> {
        Err(unsupported(&request.model, Capability::Transcription))
    }
}

#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn connection(&self) -> &ConnectionInfo;
    async fn health(&self) -> Result<HealthResult, AiError>;
    async fn run_agent(&self, request: AgentRequest) -> Result<AgentEventStream, AiError>;
}

fn unsupported(model: &ModelRef, capability: Capability) -> AiError {
    AiError::new(
        ErrorCode::UnsupportedCapability,
        format!(
            "Connection '{}' does not support {capability:?}.",
            model.connection_id
        ),
    )
    .for_model(model)
}

#[derive(Default)]
pub struct AiClient {
    adapters: HashMap<String, Arc<dyn ProviderAdapter>>,
}

// Normalized errors intentionally carry portable provider metadata; boxing them would make every
// public call site less ergonomic for a size tradeoff that is irrelevant on these I/O boundaries.
#[allow(clippy::result_large_err)]
impl AiClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, adapter: Arc<dyn ProviderAdapter>) -> Result<(), AiError> {
        if adapter.connection().id.trim().is_empty()
            || adapter.connection().adapter_id.trim().is_empty()
            || adapter.connection().label.trim().is_empty()
        {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "Connections require non-empty id, adapterId, and label values.",
            ));
        }
        let id = adapter.connection().id.clone();
        if self.adapters.contains_key(&id) {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                format!("Connection '{id}' is already registered."),
            ));
        }
        self.adapters.insert(id, adapter);
        Ok(())
    }

    pub fn unregister(&mut self, connection_id: &str) -> bool {
        self.adapters.remove(connection_id).is_some()
    }

    pub fn connections(&self) -> Vec<ConnectionInfo> {
        self.adapters
            .values()
            .map(|adapter| adapter.connection().clone())
            .collect()
    }

    pub async fn health(&self, connection_id: &str) -> Result<HealthResult, AiError> {
        self.adapter(connection_id)?.health().await
    }

    pub async fn list_models(&self, connection_id: &str) -> Result<Vec<ModelInfo>, AiError> {
        self.adapter(connection_id)?.list_models().await
    }

    pub async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        ensure_not_cancelled(&request.model, request.cancellation.as_ref())?;
        let adapter = self.preflight_text(&request, Capability::TextGeneration)?;
        adapter.generate_text(request).await
    }

    pub async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        ensure_not_cancelled(&request.model, request.cancellation.as_ref())?;
        let adapter = self.preflight_text(&request, Capability::TextStreaming)?;
        adapter.stream_text(request).await
    }

    pub async fn generate_object(&self, request: ObjectRequest) -> Result<ObjectResult, AiError> {
        ensure_not_cancelled(&request.text.model, request.text.cancellation.as_ref())?;
        let adapter = self.preflight_text(&request.text, Capability::StructuredOutput)?;
        adapter.generate_object(request).await
    }

    pub async fn embed(&self, request: EmbeddingRequest) -> Result<EmbeddingResult, AiError> {
        if request.input.is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "Embedding input cannot be empty.",
            )
            .for_model(&request.model));
        }
        if request.timeout_ms == Some(0) {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "timeoutMs must be a positive integer.",
            )
            .for_model(&request.model));
        }
        ensure_not_cancelled(&request.model, request.cancellation.as_ref())?;
        let adapter = self.preflight(
            &request.model,
            request.maximum_boundary,
            Capability::Embeddings,
        )?;
        adapter.embed(request).await
    }

    pub async fn transcribe(
        &self,
        request: TranscriptionRequest,
    ) -> Result<TranscriptionResult, AiError> {
        if request.audio.mime_type.trim().is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "Transcription audio requires a MIME type.",
            )
            .for_model(&request.model));
        }
        if request.audio.data.is_some() == request.audio.url.is_some() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "Media input requires exactly one of data or url.",
            )
            .for_model(&request.model));
        }
        if request.timeout_ms == Some(0) {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "timeoutMs must be a positive integer.",
            )
            .for_model(&request.model));
        }
        ensure_not_cancelled(&request.model, request.cancellation.as_ref())?;
        let adapter = self.preflight(
            &request.model,
            request.maximum_boundary,
            Capability::Transcription,
        )?;
        adapter.transcribe(request).await
    }

    pub async fn collect_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        let model = request.model.clone();
        let request_id = request.resolved_request_id();
        let mut stream = self.stream_text(request).await?;
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls = Vec::new();
        let mut finish_reason = FinishReason::Unknown;
        let mut usage = None;
        let mut provider_metadata = None;
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::TextDelta { delta } => text.push_str(&delta),
                StreamEvent::ReasoningDelta { delta } => reasoning.push_str(&delta),
                StreamEvent::ToolCall { call } => tool_calls.push(call),
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
            tool_calls,
            finish_reason,
            usage,
            provider_metadata,
        })
    }

    fn adapter(&self, connection_id: &str) -> Result<Arc<dyn ProviderAdapter>, AiError> {
        self.adapters.get(connection_id).cloned().ok_or_else(|| {
            AiError::new(
                ErrorCode::InvalidRequest,
                format!("Connection '{connection_id}' is not registered."),
            )
        })
    }

    fn preflight(
        &self,
        model: &ModelRef,
        maximum_boundary: Option<DataBoundary>,
        capability: Capability,
    ) -> Result<Arc<dyn ProviderAdapter>, AiError> {
        if model.connection_id.trim().is_empty() || model.model_id.trim().is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "A non-empty connection ID and model ID are required.",
            ));
        }
        let adapter = self.adapter(&model.connection_id)?;
        if maximum_boundary.is_some_and(|boundary| adapter.connection().boundary > boundary) {
            return Err(AiError::new(
                ErrorCode::DataBoundaryViolation,
                format!(
                    "Connection '{}' exceeds the request data boundary.",
                    model.connection_id
                ),
            )
            .for_model(model));
        }
        if !adapter.connection().capabilities.contains(&capability) {
            return Err(unsupported(model, capability));
        }
        Ok(adapter)
    }

    fn preflight_text(
        &self,
        request: &TextRequest,
        capability: Capability,
    ) -> Result<Arc<dyn ProviderAdapter>, AiError> {
        if request.messages.is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "At least one message is required.",
            )
            .for_model(&request.model));
        }
        if request.max_output_tokens == Some(0) {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "maxOutputTokens must be a positive integer.",
            )
            .for_model(&request.model));
        }
        if request.temperature.is_some_and(|value| !value.is_finite()) {
            return Err(
                AiError::new(ErrorCode::InvalidRequest, "temperature must be finite.")
                    .for_model(&request.model),
            );
        }
        if request.timeout_ms == Some(0) {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "timeoutMs must be a positive integer.",
            )
            .for_model(&request.model));
        }
        let tool_names = request
            .tools
            .iter()
            .map(|tool| tool.name.trim())
            .collect::<Vec<_>>();
        let unique_tool_names = tool_names
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        if tool_names.iter().any(|name| name.is_empty())
            || unique_tool_names.len() != tool_names.len()
        {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "Tool names must be non-empty and unique.",
            )
            .for_model(&request.model));
        }
        let adapter = self.preflight(&request.model, request.maximum_boundary, capability)?;
        let uses_tools = !request.tools.is_empty()
            || request.tool_choice.is_some()
            || request.messages.iter().any(|message| {
                message.content.iter().any(|part| {
                    matches!(
                        part,
                        ContentPart::ToolCall { .. } | ContentPart::ToolResult { .. }
                    )
                })
            });
        if uses_tools
            && !adapter
                .connection()
                .capabilities
                .contains(&Capability::ToolCalling)
        {
            return Err(unsupported(&request.model, Capability::ToolCalling));
        }
        if request.tool_choice.is_some() && request.tools.is_empty() {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                "toolChoice requires at least one tool definition.",
            )
            .for_model(&request.model));
        }
        if let Some(ToolChoice::Named(name)) = &request.tool_choice
            && !request.tools.iter().any(|tool| tool.name == *name)
        {
            return Err(AiError::new(
                ErrorCode::InvalidRequest,
                format!("Named tool choice '{name}' is not present in tools."),
            )
            .for_model(&request.model));
        }
        for part in request
            .messages
            .iter()
            .flat_map(|message| message.content.iter())
        {
            match part {
                ContentPart::Image { .. }
                    if !adapter
                        .connection()
                        .capabilities
                        .contains(&Capability::ImageUnderstanding) =>
                {
                    return Err(unsupported(&request.model, Capability::ImageUnderstanding));
                }
                ContentPart::Audio { .. } | ContentPart::File { .. } => {
                    return Err(AiError::new(
                        ErrorCode::UnsupportedCapability,
                        "Audio and file message parts are not supported by this connection.",
                    )
                    .for_model(&request.model));
                }
                _ => {}
            }
        }
        Ok(adapter)
    }
}

#[allow(clippy::result_large_err)]
fn ensure_not_cancelled(
    model: &ModelRef,
    cancellation: Option<&CancellationToken>,
) -> Result<(), AiError> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Err(AiError::new(
            ErrorCode::Cancelled,
            "The request was cancelled before dispatch.",
        )
        .for_model(model));
    }
    Ok(())
}

pub struct MockAdapter {
    connection: ConnectionInfo,
    response: String,
    delay: Duration,
}

impl MockAdapter {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            connection: ConnectionInfo {
                id: id.into(),
                adapter_id: "mock".into(),
                label: "Demo line".into(),
                boundary: DataBoundary::Device,
                capabilities: vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::ReasoningEvents,
                ],
            },
            response: "The deterministic demo route is working.".into(),
            delay: Duration::from_millis(5),
        }
    }

    pub fn with_response(mut self, response: impl Into<String>) -> Self {
        self.response = response.into();
        self
    }
}

#[async_trait]
impl ProviderAdapter for MockAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        Ok(HealthResult {
            available: true,
            reason: AvailabilityReason::Available,
            message: "Deterministic demo adapter is ready.".into(),
            checked_at: "1970-01-01T00:00:00Z".into(),
            latency_ms: Some(0),
        })
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AiError> {
        Ok(vec![ModelInfo {
            id: "fixture-chat".into(),
            name: Some("Fixture Chat".into()),
            capabilities: vec![
                Capability::TextGeneration,
                Capability::TextStreaming,
                Capability::ReasoningEvents,
            ],
            context_window: None,
            structured_output: Some(StructuredOutputSupport::Unsupported),
            metadata: None,
        }])
    }

    async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        Ok(TextResult {
            request_id: request.resolved_request_id(),
            model: request.model,
            text: self.response.clone(),
            reasoning: Some("Following the deterministic route.".into()),
            tool_calls: Vec::new(),
            finish_reason: FinishReason::Stop,
            usage: Some(Usage {
                input_tokens: Some(4),
                output_tokens: Some(7),
                total_tokens: Some(11),
                cost: Some(Cost::unavailable()),
                ..Usage::default()
            }),
            provider_metadata: None,
        })
    }

    async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        let response = self.response.clone();
        let delay = self.delay;
        let request_id = request.resolved_request_id();
        let model = request.model;
        let cancellation = request.cancellation;
        Ok(Box::pin(async_stream::try_stream! {
            yield StreamEvent::Start { request_id, model };
            yield StreamEvent::ReasoningDelta { delta: "Following the deterministic route.".into() };
            for word in response.split_inclusive(' ') {
                if cancellation.as_ref().is_some_and(CancellationToken::is_cancelled) {
                    Err(AiError::new(ErrorCode::Cancelled, "The request was cancelled."))?;
                }
                tokio::time::sleep(delay).await;
                yield StreamEvent::TextDelta { delta: word.to_string() };
            }
            let usage = Usage {
                input_tokens: Some(4), output_tokens: Some(7), total_tokens: Some(11),
                cost: Some(Cost::unavailable()), ..Usage::default()
            };
            yield StreamEvent::Usage { usage: usage.clone() };
            yield StreamEvent::Finish { reason: FinishReason::Stop, usage: Some(usage), provider_metadata: None };
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn client_streams_and_collects() {
        let mut client = AiClient::new();
        client
            .register(Arc::new(
                MockAdapter::new("mock").with_response("Route ready."),
            ))
            .unwrap();
        let request = TextRequest::new(
            ModelRef {
                connection_id: "mock".into(),
                model_id: "fixture-chat".into(),
            },
            vec![Message::text(Role::User, "Hello")],
        );
        let result = client.collect_text(request).await.unwrap();
        assert_eq!(result.text, "Route ready.");
        assert_eq!(result.finish_reason, FinishReason::Stop);
    }

    #[tokio::test]
    async fn boundary_failure_precedes_dispatch() {
        let mut adapter = MockAdapter::new("cloud");
        adapter.connection.boundary = DataBoundary::PublicCloud;
        let mut client = AiClient::new();
        client.register(Arc::new(adapter)).unwrap();
        let mut request = TextRequest::new(
            ModelRef {
                connection_id: "cloud".into(),
                model_id: "fixture-chat".into(),
            },
            vec![Message::text(Role::User, "Private")],
        );
        request.maximum_boundary = Some(DataBoundary::Device);
        let error = client.generate_text(request).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::DataBoundaryViolation);
    }

    #[tokio::test]
    async fn unsupported_content_fails_before_dispatch() {
        let mut client = AiClient::new();
        client.register(Arc::new(MockAdapter::new("mock"))).unwrap();
        let request = TextRequest::new(
            ModelRef {
                connection_id: "mock".into(),
                model_id: "fixture-chat".into(),
            },
            vec![Message {
                role: Role::User,
                content: vec![ContentPart::Image {
                    media: MediaInput {
                        mime_type: "image/png".into(),
                        data: Some(vec![1]),
                        url: None,
                    },
                }],
            }],
        );
        let error = client.generate_text(request).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    }

    #[test]
    fn redacts_bearer_and_keys() {
        assert_eq!(
            redact_secrets("Bearer very-secret sk-1234567890"),
            "Bearer [REDACTED] [REDACTED]"
        );
    }
}
