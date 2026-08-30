//! Official HTTP provider adapters.

use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use futures_util::StreamExt;
use infinite_ai_core::{
    AiError, AvailabilityReason, Capability, ConnectionInfo, ContentPart, Cost, CostSource,
    DataBoundary, EmbeddingRequest, EmbeddingResult, ErrorCode, EventStream, FinishReason,
    HealthResult, Message, ModelInfo, ObjectRequest, ObjectResult, ProviderAdapter, Role,
    StreamEvent, StructuredOutputSupport, TextRequest, TextResult, ToolCall, ToolChoice,
    ToolDefinition, TranscriptionRequest, TranscriptionResult, Usage,
};
use reqwest::{Client, Response, StatusCode, Url};
use serde_json::{Map, Value, json};

fn now_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

fn model_error(
    code: ErrorCode,
    message: impl Into<String>,
    model: &infinite_ai_core::ModelRef,
) -> AiError {
    AiError::new(code, message).for_model(model)
}

async fn checked(
    response: Result<Response, reqwest::Error>,
    model: Option<&infinite_ai_core::ModelRef>,
    connection_id: &str,
) -> Result<Response, AiError> {
    let response = response.map_err(|error| {
        let code = if error.is_timeout() {
            ErrorCode::Timeout
        } else {
            ErrorCode::ProviderUnavailable
        };
        let mut normalized = AiError::new(
            code,
            if error.is_timeout() {
                "The provider request timed out."
            } else {
                "The configured provider is not reachable."
            },
        )
        .retryable(true);
        normalized.connection_id = Some(connection_id.to_string());
        if let Some(model) = model {
            normalized.model_id = Some(model.model_id.clone());
        }
        normalized
    })?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let code = match status {
        StatusCode::UNAUTHORIZED => ErrorCode::AuthenticationFailed,
        StatusCode::FORBIDDEN => ErrorCode::PermissionDenied,
        StatusCode::TOO_MANY_REQUESTS => ErrorCode::RateLimited,
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => ErrorCode::Timeout,
        StatusCode::PAYLOAD_TOO_LARGE => ErrorCode::ContextOverflow,
        _ => ErrorCode::ProviderError,
    };
    let message = match code {
        ErrorCode::AuthenticationFailed => {
            "The provider rejected the configured credential.".to_string()
        }
        ErrorCode::PermissionDenied => "The provider denied this request.".to_string(),
        ErrorCode::RateLimited => "The provider rate limit was reached.".to_string(),
        ErrorCode::Timeout => "The provider timed out.".to_string(),
        _ if !body.trim().is_empty() => body.chars().take(2_000).collect(),
        _ => format!("Provider request failed with HTTP {status}."),
    };
    let mut error = AiError::new(code, message)
        .retryable(status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS);
    error.connection_id = Some(connection_id.to_string());
    error.model_id = model.map(|value| value.model_id.clone());
    error.provider_code = Some(status.as_u16().to_string());
    Err(error)
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut index = 0;
    while index < input.len() {
        let b0 = input[index];
        let b1 = input.get(index + 1).copied().unwrap_or(0);
        let b2 = input.get(index + 2).copied().unwrap_or(0);
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if index + 1 < input.len() {
            out.push(CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if index + 2 < input.len() {
            out.push(CHARS[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        index += 3;
    }
    out
}

#[derive(Clone, Copy)]
enum ChatStyle {
    OpenAi,
    Ollama,
}

const EXCLUSIVE_MODEL_CAPABILITIES: [Capability; 7] = [
    Capability::Embeddings,
    Capability::Transcription,
    Capability::SpeechGeneration,
    Capability::ImageGeneration,
    Capability::ImageEditing,
    Capability::VideoGeneration,
    Capability::VideoEditing,
];

fn is_embedding_model_id(id: &str) -> bool {
    let value = id.to_ascii_lowercase();
    value.contains("embedding") || value.contains("embed-")
}

fn is_transcription_model_id(id: &str) -> bool {
    let value = id.to_ascii_lowercase();
    value.contains("whisper") || value.contains("transcribe") || value.contains("speech-to-text")
}

fn advertised_openai_model_capabilities(id: &str, connection: &[Capability]) -> Vec<Capability> {
    let surface = connection.iter().copied().filter(|capability| {
        !matches!(
            capability,
            Capability::ProviderHealth | Capability::ModelListing
        )
    });
    if is_embedding_model_id(id) {
        return surface
            .filter(|capability| matches!(capability, Capability::Embeddings))
            .collect();
    }
    if is_transcription_model_id(id) {
        return surface
            .filter(|capability| matches!(capability, Capability::Transcription))
            .collect();
    }
    surface
        .filter(|capability| !EXCLUSIVE_MODEL_CAPABILITIES.contains(capability))
        .collect()
}

fn dropped_part_error(kind: &str) -> AiError {
    AiError::new(
        ErrorCode::UnsupportedCapability,
        format!("{kind} message parts cannot be sent by this adapter."),
    )
}

#[allow(clippy::result_large_err)]
fn api_messages(messages: &[Message], style: ChatStyle) -> Result<Vec<Value>, AiError> {
    let mut encoded = Vec::with_capacity(messages.len());
    for message in messages {
        let role = match message.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        };
        if let Some(ContentPart::ToolResult { result }) = message
            .content
            .iter()
            .find(|part| matches!(part, ContentPart::ToolResult { .. }))
        {
            encoded.push(json!({
                "role": "tool",
                "content": serde_json::to_string(&result.result).unwrap_or_else(|_| "null".into()),
                "tool_call_id": result.call_id,
                "tool_name": result.name,
            }));
            continue;
        }
        let tool_calls = message
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolCall { call } => Some(json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments.to_string() },
                })),
                _ => None,
            })
            .collect::<Vec<_>>();
        let mut value = json!({ "role": role, "content": message.text_content() });
        if !tool_calls.is_empty() {
            value["tool_calls"] = Value::Array(tool_calls);
        }
        match style {
            ChatStyle::OpenAi => {
                let mut content = Vec::new();
                let mut has_media = false;
                for part in &message.content {
                    match part {
                        ContentPart::Text { text } => {
                            content.push(json!({ "type": "text", "text": text }));
                        }
                        ContentPart::Image { media } => {
                            has_media = true;
                            let url = if let Some(url) =
                                media.url.as_ref().filter(|value| !value.is_empty())
                            {
                                url.clone()
                            } else if let Some(data) = &media.data {
                                format!("data:{};base64,{}", media.mime_type, base64_encode(data))
                            } else {
                                return Err(AiError::new(
                                    ErrorCode::InvalidRequest,
                                    "Image parts require either bytes or a URL.",
                                ));
                            };
                            content
                                .push(json!({ "type": "image_url", "image_url": { "url": url } }));
                        }
                        ContentPart::Audio { .. } => return Err(dropped_part_error("audio")),
                        ContentPart::File { .. } => return Err(dropped_part_error("file")),
                        ContentPart::ToolCall { .. } | ContentPart::ToolResult { .. } => {}
                    }
                }
                if has_media {
                    value["content"] = Value::Array(content);
                }
            }
            ChatStyle::Ollama => {
                let mut images = Vec::new();
                for part in &message.content {
                    match part {
                        ContentPart::Image { media } => {
                            let Some(data) = &media.data else {
                                return Err(AiError::new(
                                    ErrorCode::InvalidRequest,
                                    "Ollama image parts require bytes; URL-only image inputs are not sent.",
                                ));
                            };
                            images.push(Value::String(base64_encode(data)));
                        }
                        ContentPart::Audio { .. } => return Err(dropped_part_error("audio")),
                        ContentPart::File { .. } => return Err(dropped_part_error("file")),
                        _ => {}
                    }
                }
                if !images.is_empty() {
                    value["images"] = Value::Array(images);
                }
            }
        }
        encoded.push(value);
    }
    Ok(encoded)
}

fn api_tools(tools: &[ToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "strict": true,
                }
            })
        })
        .collect()
}

fn tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::None => json!("none"),
        ToolChoice::Required => json!("required"),
        ToolChoice::Named(name) => {
            json!({ "type": "function", "function": { "name": name } })
        }
    }
}

fn apply_provider_options(
    body: &mut Value,
    options: &HashMap<String, Map<String, Value>>,
    connection_id: &str,
) {
    let Some(overrides) = options.get(connection_id) else {
        return;
    };
    let Some(target) = body.as_object_mut() else {
        return;
    };
    for (key, value) in overrides {
        target.insert(key.clone(), value.clone());
    }
}

fn parsed_tool_calls(value: &Value, request_id: &str) -> Vec<ToolCall> {
    parsed_tool_calls_from_message(&value["message"], request_id)
}

fn parsed_tool_calls_from_message(message: &Value, request_id: &str) -> Vec<ToolCall> {
    message["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, call)| {
            let function = &call["function"];
            let name = function["name"].as_str()?;
            let arguments = match &function["arguments"] {
                Value::String(raw) => {
                    serde_json::from_str(raw).unwrap_or_else(|_| json!({ "raw": raw }))
                }
                value => value.clone(),
            };
            Some(ToolCall {
                id: call["id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{request_id}-{index}")),
                name: name.into(),
                arguments,
            })
        })
        .collect()
}

fn unavailable_usage(input: Option<u64>, output: Option<u64>) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: Some(input.unwrap_or_default() + output.unwrap_or_default()),
        cost: Some(Cost::unavailable()),
        ..Usage::default()
    }
}

fn ollama_model_capabilities(upstream: Option<&Vec<Value>>) -> Vec<Capability> {
    let Some(upstream) = upstream else {
        return vec![
            Capability::TextGeneration,
            Capability::TextStreaming,
            Capability::ReasoningEvents,
            Capability::StructuredOutput,
            Capability::ToolCalling,
            Capability::Embeddings,
        ];
    };
    let has = |name: &str| upstream.iter().any(|value| value.as_str() == Some(name));
    let mut capabilities = Vec::new();
    if has("completion") {
        capabilities.extend([
            Capability::TextGeneration,
            Capability::TextStreaming,
            Capability::StructuredOutput,
        ]);
    }
    if has("thinking") {
        capabilities.push(Capability::ReasoningEvents);
    }
    if has("tools") {
        capabilities.push(Capability::ToolCalling);
    }
    if has("embedding") {
        capabilities.push(Capability::Embeddings);
    }
    capabilities
}

#[derive(Clone)]
pub struct OllamaAdapter {
    connection: ConnectionInfo,
    base_url: Url,
    client: Client,
}

#[allow(clippy::result_large_err)]
impl OllamaAdapter {
    pub fn new(
        id: impl Into<String>,
        base_url: &str,
        boundary: DataBoundary,
    ) -> Result<Self, AiError> {
        let base_url = Url::parse(base_url)
            .map_err(|_| AiError::new(ErrorCode::InvalidRequest, "Ollama base URL is invalid."))?;
        Ok(Self {
            connection: ConnectionInfo {
                id: id.into(),
                adapter_id: "ollama".into(),
                label: "Ollama".into(),
                boundary,
                capabilities: vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::ReasoningEvents,
                    Capability::StructuredOutput,
                    Capability::ToolCalling,
                    Capability::Embeddings,
                ],
            },
            base_url,
            client: Client::new(),
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url, AiError> {
        self.base_url.join(path).map_err(|_| {
            AiError::new(
                ErrorCode::InvalidRequest,
                "Provider endpoint URL is invalid.",
            )
        })
    }
}

#[async_trait]
impl ProviderAdapter for OllamaAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        let started = Instant::now();
        let result = self
            .client
            .get(self.endpoint("api/version")?)
            .timeout(Duration::from_secs(4))
            .send()
            .await;
        match checked(result, None, &self.connection.id).await {
            Ok(_) => Ok(HealthResult {
                available: true,
                reason: AvailabilityReason::Available,
                message: "Ollama is reachable.".into(),
                checked_at: now_iso(),
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
            Err(error) => Ok(HealthResult {
                available: false,
                reason: AvailabilityReason::Unreachable,
                message: error.message,
                checked_at: now_iso(),
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AiError> {
        let response = checked(
            self.client
                .get(self.endpoint("api/tags")?)
                .timeout(Duration::from_secs(8))
                .send()
                .await,
            None,
            &self.connection.id,
        )
        .await?;
        let body: Value = response.json().await.map_err(|_| {
            AiError::new(
                ErrorCode::ProviderError,
                "Ollama returned invalid model-list JSON.",
            )
        })?;
        Ok(body["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model["model"].as_str().or_else(|| model["name"].as_str())?;
                let upstream_capabilities = model["capabilities"].as_array();
                let capabilities = ollama_model_capabilities(upstream_capabilities);
                let mut metadata = Map::new();
                metadata.insert(
                    "capabilitySource".into(),
                    Value::String(
                        if upstream_capabilities.is_some() {
                            "provider-reported"
                        } else {
                            "connection-default"
                        }
                        .into(),
                    ),
                );
                if let Some(upstream) = upstream_capabilities {
                    metadata.insert(
                        "upstreamCapabilities".into(),
                        Value::Array(upstream.clone()),
                    );
                }
                Some(ModelInfo {
                    id: id.to_string(),
                    name: model["name"]
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| Some(id.to_string())),
                    capabilities: capabilities.clone(),
                    context_window: None,
                    structured_output: Some(
                        if capabilities.contains(&Capability::StructuredOutput) {
                            StructuredOutputSupport::NativeSchema
                        } else {
                            StructuredOutputSupport::Unsupported
                        },
                    ),
                    metadata: Some(metadata),
                })
            })
            .collect())
    }

    async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        if request
            .tool_choice
            .as_ref()
            .is_some_and(|choice| !matches!(choice, ToolChoice::Auto))
        {
            return Err(model_error(
                ErrorCode::UnsupportedCapability,
                "Ollama does not expose portable required or named tool-choice semantics.",
                &request.model,
            ));
        }
        if request
            .cancellation
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(model_error(
                ErrorCode::Cancelled,
                "The request was cancelled before dispatch.",
                &request.model,
            ));
        }
        let request_id = request.resolved_request_id();
        let mut body = json!({
            "model": request.model.model_id,
            "messages": api_messages(&request.messages, ChatStyle::Ollama)?,
            "stream": false,
        });
        if request.temperature.is_some() || request.max_output_tokens.is_some() {
            body["options"] = json!({
                "temperature": request.temperature,
                "num_predict": request.max_output_tokens,
            });
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(api_tools(&request.tools));
        }
        apply_provider_options(&mut body, &request.provider_options, &self.connection.id);
        let response = checked(
            self.client
                .post(self.endpoint("api/chat")?)
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .json(&body)
                .send()
                .await,
            Some(&request.model),
            &self.connection.id,
        )
        .await?;
        let value: Value = response.json().await.map_err(|_| {
            model_error(
                ErrorCode::ProviderError,
                "Ollama returned invalid generation JSON.",
                &request.model,
            )
        })?;
        let usage = unavailable_usage(
            value["prompt_eval_count"].as_u64(),
            value["eval_count"].as_u64(),
        );
        let tool_calls = parsed_tool_calls(&value, &request_id);
        Ok(TextResult {
            request_id,
            model: request.model,
            text: value["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            reasoning: value["message"]["thinking"].as_str().map(str::to_string),
            finish_reason: if !tool_calls.is_empty() {
                FinishReason::ToolCalls
            } else if value["done_reason"].as_str() == Some("length") {
                FinishReason::Length
            } else {
                FinishReason::Stop
            },
            tool_calls,
            usage: Some(usage),
            provider_metadata: None,
        })
    }

    async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        if request
            .tool_choice
            .as_ref()
            .is_some_and(|choice| !matches!(choice, ToolChoice::Auto))
        {
            return Err(model_error(
                ErrorCode::UnsupportedCapability,
                "Ollama does not expose portable required or named tool-choice semantics.",
                &request.model,
            ));
        }
        let request_id = request.resolved_request_id();
        let model = request.model.clone();
        let cancellation = request.cancellation.clone();
        if cancellation
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(model_error(
                ErrorCode::Cancelled,
                "The request was cancelled before dispatch.",
                &model,
            ));
        }
        let mut body = json!({
            "model": model.model_id,
            "messages": api_messages(&request.messages, ChatStyle::Ollama)?,
            "stream": true,
        });
        if request.temperature.is_some() || request.max_output_tokens.is_some() {
            body["options"] = json!({
                "temperature": request.temperature,
                "num_predict": request.max_output_tokens,
            });
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(api_tools(&request.tools));
        }
        apply_provider_options(&mut body, &request.provider_options, &self.connection.id);
        let response = checked(
            self.client
                .post(self.endpoint("api/chat")?)
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .json(&body)
                .send()
                .await,
            Some(&model),
            &self.connection.id,
        )
        .await?;
        Ok(Box::pin(async_stream::try_stream! {
            yield StreamEvent::Start { request_id: request_id.clone(), model: model.clone() };
            let mut bytes = response.bytes_stream();
            let mut buffer = String::new();
            loop {
                let next = if let Some(token) = &cancellation {
                    tokio::select! {
                        _ = token.cancelled() => None,
                        value = bytes.next() => value,
                    }
                } else {
                    bytes.next().await
                };
                if cancellation.as_ref().is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                    Err(model_error(ErrorCode::Cancelled, "The request was cancelled.", &model))?;
                }
                let Some(chunk) = next else { break; };
                let chunk = chunk.map_err(|_| model_error(ErrorCode::ProviderError, "Ollama stream failed after partial output.", &model))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(index) = buffer.find('\n') {
                    let line = buffer[..index].trim().to_string();
                    buffer.drain(..=index);
                    if line.is_empty() { continue; }
                    let value: Value = serde_json::from_str(&line).map_err(|_| model_error(ErrorCode::ProviderError, "Ollama returned malformed NDJSON.", &model))?;
                    if let Some(reasoning) = value["message"]["thinking"].as_str().filter(|value| !value.is_empty()) {
                        yield StreamEvent::ReasoningDelta { delta: reasoning.to_string() };
                    }
                    if let Some(text) = value["message"]["content"].as_str().filter(|value| !value.is_empty()) {
                        yield StreamEvent::TextDelta { delta: text.to_string() };
                    }
                    let tool_calls = parsed_tool_calls(&value, &request_id);
                    for call in &tool_calls {
                        yield StreamEvent::ToolCall { call: call.clone() };
                    }
                    if value["done"].as_bool() == Some(true) {
                        let usage = unavailable_usage(value["prompt_eval_count"].as_u64(), value["eval_count"].as_u64());
                        yield StreamEvent::Usage { usage: usage.clone() };
                        yield StreamEvent::Finish {
                            reason: if !tool_calls.is_empty() { FinishReason::ToolCalls } else if value["done_reason"].as_str() == Some("length") { FinishReason::Length } else { FinishReason::Stop },
                            usage: Some(usage), provider_metadata: None,
                        };
                    }
                }
            }
        }))
    }

    async fn generate_object(&self, request: ObjectRequest) -> Result<ObjectResult, AiError> {
        if request.repair_attempts > 0 {
            return Err(model_error(
                ErrorCode::UnsupportedCapability,
                "Automatic structured-output repair is not implemented; set repairAttempts to 0 and retry explicitly in the host when appropriate.",
                &request.text.model,
            ));
        }
        let schema = Value::Object(request.schema.clone());
        let schema_for_check = schema.clone();
        tokio::task::spawn_blocking(move || {
            jsonschema::validator_for(&schema_for_check)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Schema validation task failed: {error}"),
                &request.text.model,
            )
        })?
        .map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("The requested JSON Schema is invalid: {error}"),
                &request.text.model,
            )
        })?;

        let mut text_request = request.text;
        text_request
            .provider_options
            .entry(self.connection.id.clone())
            .or_default()
            .insert("format".into(), schema.clone());
        let result = self.generate_text(text_request).await?;
        let parsed: Value = serde_json::from_str(&result.text).map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Ollama output was not valid JSON: {error}"),
                &result.model,
            )
        })?;
        let schema_for_validation = schema;
        let value_for_validation = parsed.clone();
        let validation = tokio::task::spawn_blocking(move || {
            let validator = jsonschema::validator_for(&schema_for_validation)
                .map_err(|error| error.to_string())?;
            validator
                .validate(&value_for_validation)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Output validation task failed: {error}"),
                &result.model,
            )
        })?;
        if let Err(error) = validation {
            return Err(model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Ollama output did not match the requested schema: {error}"),
                &result.model,
            ));
        }
        Ok(ObjectResult {
            request_id: result.request_id,
            model: result.model,
            value: parsed,
            raw_text: result.text,
            tool_calls: result.tool_calls,
            finish_reason: result.finish_reason,
            usage: result.usage,
        })
    }

    async fn embed(&self, request: EmbeddingRequest) -> Result<EmbeddingResult, AiError> {
        let response = checked(
            self.client
                .post(self.endpoint("api/embed")?)
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .json(&json!({ "model": request.model.model_id, "input": request.input }))
                .send()
                .await,
            Some(&request.model),
            &self.connection.id,
        )
        .await?;
        let value: Value = response.json().await.map_err(|_| {
            model_error(
                ErrorCode::ProviderError,
                "Ollama returned invalid embedding JSON.",
                &request.model,
            )
        })?;
        let vectors: Vec<Vec<f32>> =
            serde_json::from_value(value["embeddings"].clone()).map_err(|_| {
                model_error(
                    ErrorCode::ProviderError,
                    "Ollama returned invalid embedding vectors.",
                    &request.model,
                )
            })?;
        let dimensions = vectors.first().map_or(0, Vec::len);
        if vectors.len() != request.input.len()
            || vectors.iter().any(|vector| vector.len() != dimensions)
        {
            return Err(model_error(
                ErrorCode::ProviderError,
                "Ollama returned incompatible embedding dimensions.",
                &request.model,
            ));
        }
        Ok(EmbeddingResult {
            vectors,
            model: request.model,
            dimensions,
            normalized: None,
            input_mode: request.input_mode,
            usage: Some(unavailable_usage(value["prompt_eval_count"].as_u64(), None)),
        })
    }
}

#[derive(Clone)]
pub struct OpenAiCompatibleAdapter {
    connection: ConnectionInfo,
    base_url: Url,
    api_key: String,
    client: Client,
}

#[allow(clippy::result_large_err)]
impl OpenAiCompatibleAdapter {
    pub fn new(
        id: impl Into<String>,
        adapter_id: impl Into<String>,
        label: impl Into<String>,
        base_url: &str,
        api_key: impl Into<String>,
    ) -> Result<Self, AiError> {
        Ok(Self {
            connection: ConnectionInfo {
                id: id.into(),
                adapter_id: adapter_id.into(),
                label: label.into(),
                boundary: DataBoundary::PublicCloud,
                capabilities: vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::ReasoningEvents,
                    Capability::StructuredOutput,
                    Capability::ToolCalling,
                    Capability::Embeddings,
                    Capability::Transcription,
                ],
            },
            base_url: Url::parse(base_url).map_err(|_| {
                AiError::new(ErrorCode::InvalidRequest, "Provider base URL is invalid.")
            })?,
            api_key: api_key.into(),
            client: Client::new(),
        })
    }

    pub fn openai(id: impl Into<String>, api_key: impl Into<String>) -> Result<Self, AiError> {
        Self::new(
            id,
            "openai",
            "OpenAI",
            "https://api.openai.com/v1/",
            api_key,
        )
    }

    pub fn openrouter(id: impl Into<String>, api_key: impl Into<String>) -> Result<Self, AiError> {
        Self::new(
            id,
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1/",
            api_key,
        )
    }

    pub fn vercel_ai_gateway(
        id: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Result<Self, AiError> {
        Self::new(
            id,
            "vercel-ai-gateway",
            "Vercel AI Gateway",
            "https://ai-gateway.vercel.sh/v1/",
            api_key,
        )
    }

    pub fn lm_studio(id: impl Into<String>) -> Result<Self, AiError> {
        Self::new(
            id,
            "lm-studio",
            "LM Studio",
            "http://127.0.0.1:1234/v1/",
            "",
        )
        .map(|adapter| {
            adapter
                .with_boundary(DataBoundary::Device)
                .with_capabilities(vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::StructuredOutput,
                    Capability::ToolCalling,
                    Capability::Embeddings,
                ])
        })
    }

    pub fn llama_cpp(id: impl Into<String>) -> Result<Self, AiError> {
        Self::new(
            id,
            "llama-cpp",
            "llama.cpp",
            "http://127.0.0.1:8080/v1/",
            "",
        )
        .map(|adapter| {
            adapter
                .with_boundary(DataBoundary::Device)
                .with_capabilities(vec![
                    Capability::ProviderHealth,
                    Capability::ModelListing,
                    Capability::TextGeneration,
                    Capability::TextStreaming,
                    Capability::StructuredOutput,
                    Capability::ToolCalling,
                    Capability::Embeddings,
                ])
        })
    }

    pub fn with_boundary(mut self, boundary: DataBoundary) -> Self {
        self.connection.boundary = boundary;
        self
    }

    pub fn with_capabilities(mut self, capabilities: Vec<Capability>) -> Self {
        self.connection.capabilities = capabilities;
        self
    }

    fn endpoint(&self, path: &str) -> Result<Url, AiError> {
        self.base_url.join(path).map_err(|_| {
            AiError::new(
                ErrorCode::InvalidRequest,
                "Provider endpoint URL is invalid.",
            )
        })
    }

    #[allow(clippy::result_large_err)]
    fn chat_body(&self, request: &TextRequest, stream: bool) -> Result<Value, AiError> {
        let mut body = json!({
            "model": request.model.model_id,
            "messages": api_messages(&request.messages, ChatStyle::OpenAi)?,
            "stream": stream,
        });
        if stream {
            body["stream_options"] = json!({ "include_usage": true });
        }
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = request.max_output_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(api_tools(&request.tools));
        }
        if let Some(choice) = &request.tool_choice {
            body["tool_choice"] = tool_choice(choice);
        }
        apply_provider_options(&mut body, &request.provider_options, &self.connection.id);
        Ok(body)
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder, AiError> {
        let request = self.client.request(method, self.endpoint(path)?);
        Ok(if self.api_key.is_empty() {
            request
        } else {
            request.bearer_auth(&self.api_key)
        })
    }
}

fn chat_usage(value: &Value) -> Option<Usage> {
    let source = &value["usage"];
    if source.is_null() {
        return None;
    }
    let mut usage = unavailable_usage(
        source["prompt_tokens"].as_u64(),
        source["completion_tokens"].as_u64(),
    );
    let amount = source["cost"]
        .as_str()
        .map(str::to_string)
        .or_else(|| source["cost"].as_f64().map(|value| value.to_string()));
    if let Some(amount) = amount {
        usage.cost = Some(Cost {
            amount: Some(amount),
            currency: Some("USD".into()),
            source: CostSource::ProviderReported,
            pricing_version: None,
            calculated_at: None,
        });
    }
    usage.reasoning_tokens = source["completion_tokens_details"]["reasoning_tokens"].as_u64();
    Some(usage)
}

fn chat_finish(value: Option<&str>) -> FinishReason {
    match value {
        Some("stop") => FinishReason::Stop,
        Some("length") => FinishReason::Length,
        Some("tool_calls") => FinishReason::ToolCalls,
        Some("content_filter") => FinishReason::ContentFilter,
        _ => FinishReason::Unknown,
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiCompatibleAdapter {
    fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    async fn health(&self) -> Result<HealthResult, AiError> {
        let started = Instant::now();
        let result = self
            .request(reqwest::Method::GET, "models")?
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        match checked(result, None, &self.connection.id).await {
            Ok(_) => Ok(HealthResult {
                available: true,
                reason: AvailabilityReason::Available,
                message: format!("{} is reachable and authenticated.", self.connection.label),
                checked_at: now_iso(),
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
            Err(error) => Ok(HealthResult {
                available: false,
                reason: if error.code == ErrorCode::AuthenticationFailed {
                    AvailabilityReason::AuthenticationFailed
                } else {
                    AvailabilityReason::Unreachable
                },
                message: error.message,
                checked_at: now_iso(),
                latency_ms: Some(started.elapsed().as_millis() as u64),
            }),
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AiError> {
        let response = checked(
            self.request(reqwest::Method::GET, "models")?
                .timeout(Duration::from_secs(15))
                .send()
                .await,
            None,
            &self.connection.id,
        )
        .await?;
        let value: Value = response.json().await.map_err(|_| {
            AiError::new(
                ErrorCode::ProviderError,
                "Provider returned invalid model-list JSON.",
            )
        })?;
        Ok(value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                model["id"].as_str().map(|id| {
                    let capabilities =
                        advertised_openai_model_capabilities(id, &self.connection.capabilities);
                    let specialized = is_embedding_model_id(id) || is_transcription_model_id(id);
                    ModelInfo {
                        id: id.into(),
                        name: model["name"]
                            .as_str()
                            .map(str::to_string)
                            .or_else(|| Some(id.into())),
                        structured_output: Some(
                            if capabilities.contains(&Capability::StructuredOutput) {
                                StructuredOutputSupport::NativeSchema
                            } else {
                                StructuredOutputSupport::Unsupported
                            },
                        ),
                        capabilities,
                        context_window: model["context_length"].as_u64(),
                        metadata: Some(Map::from_iter([(
                            "capabilitySource".into(),
                            Value::String(
                                (if specialized {
                                    "model-id-heuristic"
                                } else {
                                    "adapter-surface"
                                })
                                .to_string(),
                            ),
                        )])),
                    }
                })
            })
            .collect())
    }

    async fn generate_text(&self, request: TextRequest) -> Result<TextResult, AiError> {
        if request
            .cancellation
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(model_error(
                ErrorCode::Cancelled,
                "The request was cancelled before dispatch.",
                &request.model,
            ));
        }
        let request_id = request.resolved_request_id();
        let body = self.chat_body(&request, false)?;
        let response = checked(
            self.request(reqwest::Method::POST, "chat/completions")?
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .json(&body)
                .send()
                .await,
            Some(&request.model),
            &self.connection.id,
        )
        .await?;
        let value: Value = response.json().await.map_err(|_| {
            model_error(
                ErrorCode::ProviderError,
                "Provider returned invalid generation JSON.",
                &request.model,
            )
        })?;
        let choice = &value["choices"][0];
        let tool_calls = parsed_tool_calls_from_message(&choice["message"], &request_id);
        Ok(TextResult {
            request_id,
            model: request.model,
            text: choice["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .into(),
            reasoning: choice["message"]["reasoning"].as_str().map(str::to_string),
            finish_reason: if tool_calls.is_empty() {
                chat_finish(choice["finish_reason"].as_str())
            } else {
                FinishReason::ToolCalls
            },
            tool_calls,
            usage: chat_usage(&value),
            provider_metadata: Some(Map::from_iter([
                ("requestId".into(), value["id"].clone()),
                ("upstreamModel".into(), value["model"].clone()),
            ])),
        })
    }

    async fn stream_text(&self, request: TextRequest) -> Result<EventStream, AiError> {
        let request_id = request.resolved_request_id();
        let model = request.model.clone();
        let cancellation = request.cancellation.clone();
        if cancellation
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(model_error(
                ErrorCode::Cancelled,
                "The request was cancelled before dispatch.",
                &model,
            ));
        }
        let body = self.chat_body(&request, true)?;
        let response = checked(
            self.request(reqwest::Method::POST, "chat/completions")?
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .json(&body)
                .send()
                .await,
            Some(&model),
            &self.connection.id,
        )
        .await?;
        Ok(Box::pin(async_stream::try_stream! {
            yield StreamEvent::Start { request_id, model: model.clone() };
            let mut bytes = response.bytes_stream();
            let mut buffer = String::new();
            let mut final_usage = None;
            let mut final_reason = FinishReason::Unknown;
            let mut provider_id = None;
            let mut upstream_model = None;
            let mut tool_calls = HashMap::<usize, (String, String, String)>::new();
            loop {
                let next = if let Some(token) = &cancellation {
                    tokio::select! {
                        _ = token.cancelled() => None,
                        value = bytes.next() => value,
                    }
                } else {
                    bytes.next().await
                };
                if cancellation.as_ref().is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                    Err(model_error(ErrorCode::Cancelled, "The request was cancelled.", &model))?;
                }
                let Some(chunk) = next else { break; };
                let chunk = chunk.map_err(|_| model_error(ErrorCode::ProviderError, "Provider stream failed after partial output.", &model))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(index) = buffer.find("\n\n") {
                    let event = buffer[..index].to_string();
                    buffer.drain(..index + 2);
                    for line in event.lines().filter_map(|line| line.strip_prefix("data: ")) {
                        if line == "[DONE]" { continue; }
                        let value: Value = serde_json::from_str(line).map_err(|_| model_error(ErrorCode::ProviderError, "Provider returned malformed SSE JSON.", &model))?;
                        if provider_id.is_none()
                            && let Some(id) = value["id"].as_str()
                        {
                            provider_id = Some(id.to_string());
                        }
                        if upstream_model.is_none()
                            && let Some(name) = value["model"].as_str()
                        {
                            upstream_model = Some(name.to_string());
                        }
                        let choice = &value["choices"][0];
                        if let Some(reasoning) = choice["delta"]["reasoning"].as_str().filter(|value| !value.is_empty()) { yield StreamEvent::ReasoningDelta { delta: reasoning.into() }; }
                        if let Some(text) = choice["delta"]["content"].as_str().filter(|value| !value.is_empty()) { yield StreamEvent::TextDelta { delta: text.into() }; }
                        for call in choice["delta"]["tool_calls"].as_array().into_iter().flatten() {
                            let index = call["index"].as_u64().unwrap_or_default() as usize;
                            let existing = tool_calls.get(&index);
                            let id = call["id"].as_str().map(str::to_string).or_else(|| existing.map(|value| value.0.clone())).unwrap_or_else(|| format!("tool-{index}"));
                            let name_delta = call["function"]["name"].as_str().unwrap_or_default();
                            let name = format!("{}{name_delta}", existing.map(|value| value.1.as_str()).unwrap_or_default());
                            let arguments_delta = call["function"]["arguments"].as_str().unwrap_or_default();
                            let arguments = format!("{}{arguments_delta}", existing.map(|value| value.2.as_str()).unwrap_or_default());
                            if existing.is_none() { yield StreamEvent::ToolCallStart { call_id: id.clone(), name: name.clone() }; }
                            if !arguments_delta.is_empty() { yield StreamEvent::ToolCallDelta { call_id: id.clone(), arguments_delta: arguments_delta.into() }; }
                            tool_calls.insert(index, (id, name, arguments));
                        }
                        if let Some(reason) = choice["finish_reason"].as_str() { final_reason = chat_finish(Some(reason)); }
                        if let Some(usage) = chat_usage(&value) { final_usage = Some(usage.clone()); yield StreamEvent::Usage { usage }; }
                    }
                }
            }
            let had_tool_calls = !tool_calls.is_empty();
            let mut calls = tool_calls.into_iter().collect::<Vec<_>>();
            calls.sort_by_key(|(index, _)| *index);
            for (_, (id, name, arguments)) in calls {
                yield StreamEvent::ToolCall { call: ToolCall {
                    id,
                    name,
                    arguments: serde_json::from_str(&arguments).unwrap_or_else(|_| json!({ "raw": arguments })),
                }};
            }
            let mut metadata = Map::new();
            if let Some(id) = provider_id {
                metadata.insert("requestId".into(), Value::String(id));
            }
            if let Some(name) = upstream_model {
                metadata.insert("upstreamModel".into(), Value::String(name));
            }
            yield StreamEvent::Finish { reason: if had_tool_calls { FinishReason::ToolCalls } else if final_reason == FinishReason::Unknown { FinishReason::Stop } else { final_reason }, usage: final_usage, provider_metadata: (!metadata.is_empty()).then_some(metadata) };
        }))
    }

    async fn generate_object(&self, request: ObjectRequest) -> Result<ObjectResult, AiError> {
        if request.repair_attempts > 0 {
            return Err(model_error(
                ErrorCode::UnsupportedCapability,
                "Automatic structured-output repair is not implemented; set repairAttempts to 0 and retry explicitly in the host when appropriate.",
                &request.text.model,
            ));
        }
        let schema = Value::Object(request.schema.clone());
        let schema_for_check = schema.clone();
        tokio::task::spawn_blocking(move || {
            jsonschema::validator_for(&schema_for_check)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Schema validation task failed: {error}"),
                &request.text.model,
            )
        })?
        .map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("The requested JSON Schema is invalid: {error}"),
                &request.text.model,
            )
        })?;

        let request_id = request.text.resolved_request_id();
        let mut body = self.chat_body(&request.text, false)?;
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {
                "name": request.schema_name.as_deref().unwrap_or("result"),
                "strict": true,
                "schema": schema,
            }
        });
        apply_provider_options(
            &mut body,
            &request.text.provider_options,
            &self.connection.id,
        );
        let response = checked(
            self.request(reqwest::Method::POST, "chat/completions")?
                .timeout(Duration::from_millis(
                    request.text.timeout_ms.unwrap_or(120_000),
                ))
                .json(&body)
                .send()
                .await,
            Some(&request.text.model),
            &self.connection.id,
        )
        .await?;
        let response_value: Value = response.json().await.map_err(|_| {
            model_error(
                ErrorCode::ProviderError,
                "Provider returned invalid structured-output JSON.",
                &request.text.model,
            )
        })?;
        let choice = &response_value["choices"][0];
        let raw_text = choice["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let parsed: Value = serde_json::from_str(&raw_text).map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Provider output was not valid JSON: {error}"),
                &request.text.model,
            )
        })?;
        let schema_for_validation = Value::Object(request.schema);
        let value_for_validation = parsed.clone();
        let validation = tokio::task::spawn_blocking(move || {
            let validator = jsonschema::validator_for(&schema_for_validation)
                .map_err(|error| error.to_string())?;
            validator
                .validate(&value_for_validation)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| {
            model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Output validation task failed: {error}"),
                &request.text.model,
            )
        })?;
        if let Err(error) = validation {
            return Err(model_error(
                ErrorCode::SchemaValidationFailed,
                format!("Provider output did not match the requested schema: {error}"),
                &request.text.model,
            ));
        }
        let tool_calls = parsed_tool_calls_from_message(&choice["message"], &request_id);
        Ok(ObjectResult {
            request_id,
            model: request.text.model,
            value: parsed,
            raw_text,
            tool_calls,
            finish_reason: chat_finish(choice["finish_reason"].as_str()),
            usage: chat_usage(&response_value),
        })
    }

    async fn embed(&self, request: EmbeddingRequest) -> Result<EmbeddingResult, AiError> {
        let response = checked(
            self.request(reqwest::Method::POST, "embeddings")?
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .json(&json!({ "model": request.model.model_id, "input": request.input }))
                .send()
                .await,
            Some(&request.model),
            &self.connection.id,
        )
        .await?;
        let value: Value = response.json().await.map_err(|_| {
            model_error(
                ErrorCode::ProviderError,
                "Provider returned invalid embedding JSON.",
                &request.model,
            )
        })?;
        let mut rows = value["data"].as_array().cloned().unwrap_or_default();
        rows.sort_by_key(|row| row["index"].as_u64().unwrap_or_default());
        let vectors = rows
            .into_iter()
            .map(|row| serde_json::from_value::<Vec<f32>>(row["embedding"].clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                model_error(
                    ErrorCode::ProviderError,
                    "Provider returned invalid embedding vectors.",
                    &request.model,
                )
            })?;
        let dimensions = vectors.first().map_or(0, Vec::len);
        if vectors.len() != request.input.len()
            || vectors.iter().any(|vector| vector.len() != dimensions)
        {
            return Err(model_error(
                ErrorCode::ProviderError,
                "Provider returned incompatible embedding dimensions.",
                &request.model,
            ));
        }
        Ok(EmbeddingResult {
            vectors,
            model: request.model,
            dimensions,
            normalized: None,
            input_mode: request.input_mode,
            usage: chat_usage(&value),
        })
    }

    async fn transcribe(
        &self,
        request: TranscriptionRequest,
    ) -> Result<TranscriptionResult, AiError> {
        let bytes = request.audio.data.clone().ok_or_else(|| {
            model_error(
                ErrorCode::InvalidRequest,
                "Transcription requires audio bytes.",
                &request.model,
            )
        })?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name("audio")
            .mime_str(&request.audio.mime_type)
            .map_err(|_| {
                model_error(
                    ErrorCode::InvalidRequest,
                    "Audio MIME type is invalid.",
                    &request.model,
                )
            })?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", request.model.model_id.clone());
        if let Some(language) = request.language {
            form = form.text("language", language);
        }
        if let Some(prompt) = request.prompt {
            form = form.text("prompt", prompt);
        }
        let response = checked(
            self.request(reqwest::Method::POST, "audio/transcriptions")?
                .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(120_000)))
                .multipart(form)
                .send()
                .await,
            Some(&request.model),
            &self.connection.id,
        )
        .await?;
        let value: Value = response.json().await.map_err(|_| {
            model_error(
                ErrorCode::ProviderError,
                "Provider returned invalid transcription JSON.",
                &request.model,
            )
        })?;
        Ok(TranscriptionResult {
            text: value["text"].as_str().unwrap_or_default().into(),
            segments: Vec::new(),
            model: request.model,
            usage: None,
            provider_metadata: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use infinite_ai_core::{AiClient, Message, ModelRef, ObjectRequest, ToolDefinition};
    use std::sync::Arc;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    #[tokio::test]
    async fn ollama_lists_and_generates() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "models": [{
                    "name": "demo",
                    "capabilities": ["completion", "tools"]
                }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/api/chat")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "model": "demo", "message": { "content": "Hello" }, "done": true, "prompt_eval_count": 1, "eval_count": 1 }))).mount(&server).await;
        let adapter =
            OllamaAdapter::new("local", &format!("{}/", server.uri()), DataBoundary::Device)
                .unwrap();
        let models = adapter.list_models().await.unwrap();
        assert_eq!(models[0].id, "demo");
        assert_eq!(
            models[0].capabilities,
            vec![
                Capability::TextGeneration,
                Capability::TextStreaming,
                Capability::StructuredOutput,
                Capability::ToolCalling,
            ]
        );
        let mut client = AiClient::new();
        client.register(Arc::new(adapter)).unwrap();
        let result = client
            .generate_text(TextRequest::new(
                ModelRef {
                    connection_id: "local".into(),
                    model_id: "demo".into(),
                },
                vec![Message::text(Role::User, "Hi")],
            ))
            .await
            .unwrap();
        assert_eq!(result.text, "Hello");
    }

    #[tokio::test]
    async fn ollama_requests_and_validates_structured_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "demo",
                "message": { "content": "{\"answer\":42}" },
                "done": true
            })))
            .mount(&server)
            .await;
        let adapter =
            OllamaAdapter::new("local", &format!("{}/", server.uri()), DataBoundary::Device)
                .unwrap();
        let request = ObjectRequest {
            text: TextRequest::new(
                ModelRef {
                    connection_id: "local".into(),
                    model_id: "demo".into(),
                },
                vec![Message::text(Role::User, "Return an answer")],
            ),
            schema: serde_json::from_value(json!({
                "type": "object",
                "properties": { "answer": { "type": "integer" } },
                "required": ["answer"],
                "additionalProperties": false
            }))
            .unwrap(),
            schema_name: Some("answer".into()),
            repair_attempts: 0,
        };
        let result = adapter.generate_object(request).await.unwrap();
        assert_eq!(result.value["answer"], 42);
        let requests = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["format"]["type"], "object");
    }

    #[tokio::test]
    async fn openai_transports_tools_and_provider_reported_cost() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "provider-request",
                "model": "demo",
                "choices": [{ "message": { "content": "Hello" }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 2, "completion_tokens": 1, "cost": 0.0003 }
            })))
            .mount(&server)
            .await;
        let adapter = OpenAiCompatibleAdapter::new(
            "cloud",
            "openrouter",
            "OpenRouter",
            &format!("{}/", server.uri()),
            "test-key",
        )
        .unwrap();
        let mut request = TextRequest::new(
            ModelRef {
                connection_id: "cloud".into(),
                model_id: "demo".into(),
            },
            vec![Message::text(Role::User, "Hi")],
        );
        request.tools.push(ToolDefinition {
            name: "weather".into(),
            description: Some("Read weather".into()),
            parameters: serde_json::from_value(json!({
                "type": "object",
                "properties": { "city": { "type": "string" } }
            }))
            .unwrap(),
        });
        request.tool_choice = Some(ToolChoice::Named("weather".into()));
        let result = adapter.generate_text(request).await.unwrap();
        assert_eq!(
            result.usage.unwrap().cost.unwrap().source,
            CostSource::ProviderReported
        );
        let requests = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["tools"][0]["function"]["name"], "weather");
        assert_eq!(body["tools"][0]["function"]["strict"], true);
        assert_eq!(body["tool_choice"]["function"]["name"], "weather");
    }

    #[tokio::test]
    async fn openai_validates_structured_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "{\"answer\":42}" }, "finish_reason": "stop" }]
            })))
            .mount(&server)
            .await;
        let adapter = OpenAiCompatibleAdapter::new(
            "cloud",
            "openai",
            "OpenAI",
            &format!("{}/", server.uri()),
            "test-key",
        )
        .unwrap();
        let request = ObjectRequest {
            text: TextRequest::new(
                ModelRef {
                    connection_id: "cloud".into(),
                    model_id: "demo".into(),
                },
                vec![Message::text(Role::User, "Return an answer")],
            ),
            schema: serde_json::from_value(json!({
                "type": "object",
                "properties": { "answer": { "type": "integer" } },
                "required": ["answer"],
                "additionalProperties": false
            }))
            .unwrap(),
            schema_name: Some("answer".into()),
            repair_attempts: 0,
        };
        let result = adapter.generate_object(request).await.unwrap();
        assert_eq!(result.value["answer"], 42);
    }

    #[tokio::test]
    async fn openai_does_not_advertise_embed_or_transcribe_on_chat_models() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [
                    { "id": "gpt-4o" },
                    { "id": "text-embedding-3-small" },
                    { "id": "whisper-1" }
                ]
            })))
            .mount(&server)
            .await;
        let adapter = OpenAiCompatibleAdapter::new(
            "cloud",
            "openai",
            "OpenAI",
            &format!("{}/", server.uri()),
            "test-key",
        )
        .unwrap();
        let models = adapter.list_models().await.unwrap();
        let chat = models.iter().find(|model| model.id == "gpt-4o").unwrap();
        assert!(!chat.capabilities.contains(&Capability::Embeddings));
        assert!(!chat.capabilities.contains(&Capability::Transcription));
        assert_eq!(
            models
                .iter()
                .find(|model| model.id == "text-embedding-3-small")
                .unwrap()
                .capabilities,
            vec![Capability::Embeddings]
        );
        assert_eq!(
            models
                .iter()
                .find(|model| model.id == "whisper-1")
                .unwrap()
                .capabilities,
            vec![Capability::Transcription]
        );
    }
}
