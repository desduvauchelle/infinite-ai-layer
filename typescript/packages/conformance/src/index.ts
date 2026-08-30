import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export function createContractValidator(
  schema: object,
): (value: unknown) => ValidationResult {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate: ValidateFunction = ajv.compile(schema);
  return (value: unknown) => {
    const valid = validate(value);
    return { valid, errors: [...(validate.errors ?? [])] };
  };
}
