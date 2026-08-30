# Contributing

Changes to shared behavior begin with a versioned schema or conformance fixture. Rust and TypeScript implementations must pass the same fixtures before an adapter or capability is considered complete.

Provider credentials, live model calls, and installed CLIs are never required for the default test suite. Keep live tests behind explicit environment flags.
