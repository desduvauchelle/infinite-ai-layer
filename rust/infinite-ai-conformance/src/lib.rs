use infinite_ai_core::{
    AgentEvent, AgentRequest, AiError, EmbeddingResult, ObjectResult, StreamEvent, TextRequest,
    TranscriptionResult,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub contract_version: String,
    pub kind: String,
    pub value: Value,
}

pub fn validate_fixture(input: &str) -> Result<(), String> {
    let envelope: Envelope = serde_json::from_str(input).map_err(|error| error.to_string())?;
    if envelope.contract_version != infinite_ai_core::CONTRACT_VERSION {
        return Err(format!(
            "unsupported contract version {}",
            envelope.contract_version
        ));
    }
    match envelope.kind.as_str() {
        "text-request" => serde_json::from_value::<TextRequest>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "stream-events" => serde_json::from_value::<Vec<StreamEvent>>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "object-result" => serde_json::from_value::<ObjectResult>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "error" => serde_json::from_value::<AiError>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "agent-request" => serde_json::from_value::<AgentRequest>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "agent-events" => serde_json::from_value::<Vec<AgentEvent>>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "embedding-result" => serde_json::from_value::<EmbeddingResult>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "transcription-result" => serde_json::from_value::<TranscriptionResult>(envelope.value)
            .map(|_| ())
            .map_err(|error| error.to_string()),
        other => Err(format!("unsupported fixture kind {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_shared_fixtures() {
        for fixture in [
            include_str!("../../../spec/fixtures/text-request.json"),
            include_str!("../../../spec/fixtures/stream-events.json"),
            include_str!("../../../spec/fixtures/object-result.json"),
            include_str!("../../../spec/fixtures/error.json"),
            include_str!("../../../spec/fixtures/embedding-result.json"),
            include_str!("../../../spec/fixtures/transcription-result.json"),
            include_str!("../../../spec/fixtures/agent-request.json"),
            include_str!("../../../spec/fixtures/agent-events.json"),
        ] {
            validate_fixture(fixture).unwrap();
        }
    }

    #[test]
    fn rejects_unknown_version() {
        let error =
            validate_fixture(r#"{"contractVersion":"9","kind":"error","value":{}}"#).unwrap_err();
        assert!(error.contains("unsupported contract version"));
    }

    use infinite_ai_core::{
        Capability, ContentPart, ErrorCode, MediaInput, Message, ModelRef, ObjectRequest,
        ProviderAdapter, Role, StreamEvent, TextRequest, ToolDefinition,
    };
    use infinite_ai_providers::OpenAiCompatibleAdapter;
    use serde_json::{Value, json};
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    async fn openai_adapter(server: &MockServer) -> OpenAiCompatibleAdapter {
        OpenAiCompatibleAdapter::new(
            "cloud",
            "openai",
            "OpenAI",
            &format!("{}/", server.uri()),
            "test-key",
        )
        .unwrap()
    }

    #[tokio::test]
    async fn does_not_advertise_embed_or_transcribe_on_chat_models() {
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
        let models = openai_adapter(&server).await.list_models().await.unwrap();
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
    }

    #[tokio::test]
    async fn does_not_silently_drop_required_image_parts() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "ok" }, "finish_reason": "stop" }]
            })))
            .mount(&server)
            .await;
        let adapter = openai_adapter(&server).await;
        adapter
            .generate_text(TextRequest::new(
                ModelRef {
                    connection_id: "cloud".into(),
                    model_id: "gpt-4o".into(),
                },
                vec![Message {
                    role: Role::User,
                    content: vec![
                        ContentPart::Text {
                            text: "Look".into(),
                        },
                        ContentPart::Image {
                            media: MediaInput {
                                mime_type: "image/png".into(),
                                data: Some(vec![1, 2, 3]),
                                url: None,
                            },
                        },
                    ],
                }],
            ))
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert!(body["messages"][0]["content"].is_array());
        assert_eq!(body["messages"][0]["content"][1]["type"], "image_url");
    }

    #[tokio::test]
    async fn tool_strict_and_schema_name_default_result() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "{\"answer\":1}" }, "finish_reason": "stop" }]
            })))
            .mount(&server)
            .await;
        let adapter = openai_adapter(&server).await;
        let mut request = TextRequest::new(
            ModelRef {
                connection_id: "cloud".into(),
                model_id: "gpt-4o".into(),
            },
            vec![Message::text(Role::User, "Hi")],
        );
        request.tools.push(ToolDefinition {
            name: "lookup".into(),
            description: None,
            parameters: serde_json::from_value(json!({ "type": "object" })).unwrap(),
        });
        adapter.generate_text(request).await.unwrap();
        let object_request = ObjectRequest {
            text: TextRequest::new(
                ModelRef {
                    connection_id: "cloud".into(),
                    model_id: "gpt-4o".into(),
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
            schema_name: None,
            repair_attempts: 0,
        };
        adapter.generate_object(object_request).await.unwrap();
        let requests = server.received_requests().await.unwrap();
        let tool_body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(tool_body["tools"][0]["function"]["strict"], true);
        let object_body: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(
            object_body["response_format"]["json_schema"]["name"],
            "result"
        );
    }

    #[tokio::test]
    async fn stream_finish_metadata_and_http_status_mapping() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(
                    "data: {\"id\":\"one\",\"model\":\"demo\",\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
                    "text/event-stream",
                ),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(401))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        let adapter = openai_adapter(&server).await;
        let mut stream = adapter
            .stream_text(TextRequest::new(
                ModelRef {
                    connection_id: "cloud".into(),
                    model_id: "demo".into(),
                },
                vec![Message::text(Role::User, "Hi")],
            ))
            .await
            .unwrap();
        let mut finish = None;
        while let Some(event) = futures_util::StreamExt::next(&mut stream).await {
            if let StreamEvent::Finish {
                provider_metadata, ..
            } = event.unwrap()
            {
                finish = provider_metadata;
            }
        }
        let metadata = finish.expect("finish metadata");
        assert_eq!(
            metadata.get("requestId").and_then(Value::as_str),
            Some("one")
        );
        assert_eq!(
            metadata.get("upstreamModel").and_then(Value::as_str),
            Some("demo")
        );
        let error = adapter.list_models().await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AuthenticationFailed);
    }

    #[tokio::test]
    async fn maps_permission_and_rate_limit_http_statuses() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(403))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;
        let adapter = openai_adapter(&server).await;
        assert_eq!(
            adapter.list_models().await.unwrap_err().code,
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            adapter.list_models().await.unwrap_err().code,
            ErrorCode::RateLimited
        );
    }
}
