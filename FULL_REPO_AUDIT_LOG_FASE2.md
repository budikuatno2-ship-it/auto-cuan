# AUTO-CUAN FULL REPO AUDIT LOG - FASE 2 (AI & LLM Grounding)
Acuan: AUDIT_RULES.md | Branch: audit/aider-full-restart | Status: TUNTAS

| File | Status | Temuan Bug (ID) | Keterangan |
|---|---|---|---|
| lib/ai-gemini-provider.js | TUNTAS | BUG-AGP-01 s.d. 04 | Tuntas sebelumnya |
| lib/ai-narration.js | TUNTAS | BUG-NAR-01, BUG-NAR-02, BUG-NAR-03 | Failing test di test/ai-narration-bugs.test.js |
| lib/ai-runtime-grounding.js | TUNTAS | BUG-ARG-01, BUG-ARG-02, BUG-ARG-03 | Failing test di test/ai-runtime-grounding-bugs.test.js |
| lib/ai-runtime-grounding-v2.js | TUNTAS | BUG-ARG2-01, BUG-ARG2-02 | Failing test di test/ai-runtime-grounding-v2-bugs.test.js |
| lib/ai-eval-derived-facts.js | TUNTAS | BUG-EDF-01, BUG-EDF-02 | Failing test di test/ai-eval-derived-facts-bugs.test.js |
| lib/ai-narration-validator.js | TUNTAS | BUG-NAV-01, BUG-NAV-02, BUG-NAV-03 | Failing test di test/ai-narration-validator-bugs.test.js |
| lib/ai-narration-cache.js | TUNTAS | BUG-NAC-01, BUG-NAC-02 | Failing test di test/ai-narration-cache-prompts-bugs.test.js |
| lib/ai-narration-prompts.js | TUNTAS | BUG-NAP-01, BUG-NAP-02 | Failing test di test/ai-narration-cache-prompts-bugs.test.js |
| lib/ai-answer-contract.js | TUNTAS | BUG-AAC-01, BUG-AAC-02 | Failing test di test/ai-answer-contract-cache-bugs.test.js |
| lib/ai-analysis-cache.js | TUNTAS | BUG-AC-01, BUG-AC-02 | Failing test di test/ai-answer-contract-cache-bugs.test.js |
| lib/user-ai-credentials.js | TUNTAS | BUG-UAC-01, BUG-UAC-02 | Failing test di test/user-ai-credentials-bugs.test.js |
| lib/analyze-legacy.js | TUNTAS | BUG-AL-01, BUG-AL-02 | Failing test di test/analyze-legacy-bugs.test.js |
| lib/context-ai-router-v4.js | TUNTAS | BUG-CR4-01, BUG-CR4-02 | Failing test di test/context-ai-router-v4-bugs.test.js |
| lib/context-ai-router-v5.js | TUNTAS | BUG-CR5-01, BUG-CR5-02 | Failing test di test/context-ai-router-v5-bugs.test.js |
| lib/context-ai-router-v6.js | TUNTAS | BUG-CR6-01, BUG-CR6-02 | Failing test di test/context-ai-router-v6-bugs.test.js |
| lib/context-ai-router-v7.js | TUNTAS | BUG-CR7-01, BUG-CR7-02 | Failing test di test/context-ai-router-bugs.test.js |
| api/analyze.js | TUNTAS | BUG-ANL-01 | Failing test di test/analyze-api-bugs.test.js |
| api/sector-hot.js (AI section) | TUNTAS | BUG-SH-01, BUG-SH-02 | Failing test di test/analyze-api-bugs.test.js |
| lib/chart-analysis-service.js | TUNTAS | BUG-CAS-01, BUG-CAS-02 | Failing test di test/chart-analysis-bugs.test.js |
| lib/chart-analysis-endpoint.js | TUNTAS | BUG-CAE-01, BUG-CAE-02 | Failing test di test/chart-analysis-endpoint-bugs.test.js |
| lib/chart-analysis-prompt.js | TUNTAS | BUG-CAP-01, BUG-CAP-02 | Failing test di test/chart-analysis-prompt-bugs.test.js |
| lib/ai-context-snapshot-store.js | TUNTAS | BUG-ACSS-01, BUG-ACSS-02 | Failing test di test/ai-context-snapshot-bugs.test.js |
| lib/ai-telemetry.js | TUNTAS | BUG-AIT-01, BUG-AIT-02 | Failing test di test/ai-telemetry-bugs.test.js |
| public/ai-chat-renderer.js | TUNTAS | BUG-ACR-01 | Failing test di test/ai-chat-renderer-bugs.test.js |
| public/portfolio-ai-runtime-v2.js | TUNTAS | BUG-PAIR-01 | Failing test di test/ai-chat-renderer-bugs.test.js |
| public/stock-analysis-ai.js | TUNTAS | BUG-SAI-01 | Failing test di test/ai-chat-renderer-bugs.test.js |
