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
}
