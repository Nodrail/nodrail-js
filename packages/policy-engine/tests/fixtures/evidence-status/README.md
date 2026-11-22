# Evidence status answers

Bodies of the control plane's `GET /api/v1/evidence/status`, in the shape the control plane's `EvidenceStatusDto` defines, with the reason codes of its `evidenceReasons`. Each one mirrors an answer the control plane's own evidence tests assert: met with the verifier's name, `no_event`, `where_unmet`, and `verifier_revoked` with the date the verifier was revoked. Ids and times are fixed examples.

If the control plane changes this DTO, these files must change with it, and `tests/evidence-status.test.ts` will fail until the engine reads the new shape.
