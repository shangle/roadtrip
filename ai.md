# Dangerous.Business — AI Agent & Micro-Module Protocol

See `/llms.txt` for the complete specification.

## Quick Reference
- **Patch an existing trip URL:** Append `&ai=<encodeURIComponent(JSON)>` to any `#s=...` or `#e=...` URL.
- **Create a new trip URL:** Link to `https://dangerous.business/#ai=<encodeURIComponent(JSON)>`.
- **Supported Micro-Module types:** `checklist`, `kv`, `poll`, `countdown`.
