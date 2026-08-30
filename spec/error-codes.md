# Normalized errors

Error codes are stable kebab-case values defined by `contract.schema.json`. Provider messages may be attached only after secrets and authorization data are removed. Applications should branch on `code` and `retryable`, not provider message text.
