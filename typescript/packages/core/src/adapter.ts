import type {
  ConnectionInfo,
  EmbeddingRequest,
  EmbeddingResult,
  HealthResult,
  ModelInfo,
  ObjectRequest,
  ObjectResult,
  StreamEvent,
  TextRequest,
  TextResult,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types.js";

export interface ProviderAdapter {
  readonly connection: ConnectionInfo;
  health(): Promise<HealthResult>;
  listModels(): Promise<ModelInfo[]>;
  generateText?(request: TextRequest): Promise<TextResult>;
  streamText?(request: TextRequest): AsyncIterable<StreamEvent>;
  generateObject?(request: ObjectRequest): Promise<ObjectResult>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResult>;
  transcribe?(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
