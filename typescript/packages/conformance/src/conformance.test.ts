import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createContractValidator } from "./index.js";

async function json(relative: string): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`../../../../spec/${relative}`, import.meta.url),
  );
  return JSON.parse(await readFile(path, "utf8"));
}

describe("portable contract", () => {
  it("accepts every shared fixture", async () => {
    const schema = (await json("schemas/contract.schema.json")) as object;
    const validate = createContractValidator(schema);
    for (const fixture of [
      "fixtures/text-request.json",
      "fixtures/stream-events.json",
      "fixtures/object-result.json",
      "fixtures/error.json",
      "fixtures/embedding-result.json",
      "fixtures/transcription-result.json",
      "fixtures/agent-request.json",
      "fixtures/agent-events.json",
    ]) {
      const result = validate(await json(fixture));
      expect(result.errors, fixture).toEqual([]);
      expect(result.valid, fixture).toBe(true);
    }
  });

  it("rejects an invalid contract version", async () => {
    const schema = (await json("schemas/contract.schema.json")) as object;
    const validate = createContractValidator(schema);
    expect(
      validate({ contractVersion: "9", kind: "error", value: {} }).valid,
    ).toBe(false);
  });
});
