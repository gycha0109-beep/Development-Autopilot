import { createHash } from "node:crypto";

// Phase 4 contract v1. Adapters receive a bounded, immutable request and return
// an opaque receipt. Accepted != completed; inspect() is a separate operation.
export const ADAPTER_CONTRACT_VERSION = 1;
export const MOCK_ADAPTER_ID = "deterministic-mock-v1";
const digest = data => createHash("sha256").update(data).digest("hex");

export function executionRequest(workstream, plan, operation) {
  if (!workstream || !plan || !operation ||
      operation.workstreamId !== workstream.id ||
      operation.taskRevision !== plan.task_revision ||
      plan.workstream_id !== workstream.id) {
    throw new Error("EXECUTION_REQUEST_IDENTITY_MISMATCH");
  }
  return Object.freeze({
    contractVersion: ADAPTER_CONTRACT_VERSION,
    adapterId: MOCK_ADAPTER_ID,
    operationId: operation.operationId,
    workstreamId: workstream.id,
    taskRevision: operation.taskRevision,
    repository: workstream.repository,
    planId: plan.id,
    fingerprint: plan.fingerprint,
    action: "simulate-proof",
    expectedMarker: plan.expected_marker
  });
}

export function expectedMockProof(request) {
  return digest(JSON.stringify({
    operationId: request.operationId,
    planId: request.planId,
    fingerprint: request.fingerprint,
    repository: request.repository,
    taskRevision: request.taskRevision,
    marker: request.expectedMarker
  }));
}

export function verifyMockResult(request, receipt, observation) {
  if (!receipt || receipt.adapterId !== MOCK_ADAPTER_ID ||
      receipt.operationId !== request.operationId ||
      receipt.fingerprint !== request.fingerprint ||
      typeof receipt.receiptId !== "string" ||
      receipt.receiptId !== "mock:" + request.operationId) {
    return { verified: false, reason: "RECEIPT_IDENTITY_MISMATCH" };
  }
  if (!observation || observation.adapterId !== MOCK_ADAPTER_ID ||
      observation.receiptId !== receipt.receiptId ||
      observation.operationId !== request.operationId ||
      observation.fingerprint !== request.fingerprint) {
    return { verified: false, reason: "RESULT_IDENTITY_MISMATCH" };
  }
  if (observation.status === "pending") {
    return { verified: false, pending: true, reason: "MOCK_RESULT_PENDING" };
  }
  if (observation.status === "failed") {
    return { verified: false, reason: "MOCK_RESULT_FAILED" };
  }
  if (observation.status !== "succeeded" ||
      observation.marker !== request.expectedMarker ||
      observation.proof !== expectedMockProof(request)) {
    return { verified: false, reason: "MOCK_PROOF_NOT_VERIFIED" };
  }
  return { verified: true, reason: "SIMULATED_PROOF_VERIFIED" };
}

// Deliberately side-effect free. A real provider must implement submit/inspect
// with its supported API and independent evidence. This mock makes NO AI calls.
export class DeterministicMockAdapter {
  constructor({ outcome = "succeeded" } = {}) {
    if (!["succeeded", "failed", "pending"].includes(outcome))
      throw new Error("Unsupported mock outcome");
    this.id = MOCK_ADAPTER_ID;
    this.outcome = outcome;
    this.capabilities = Object.freeze({
      contractVersion: ADAPTER_CONTRACT_VERSION,
      sideEffects: false,
      supportedActions: Object.freeze(["simulate-proof"]),
      supportsInspection: true,
      supportsCancellation: false
    });
  }
  async submit(request) {
    if (request.contractVersion !== ADAPTER_CONTRACT_VERSION ||
        request.adapterId !== this.id || request.action !== "simulate-proof") {
      throw new Error("UNSUPPORTED_ADAPTER_REQUEST");
    }
    return Object.freeze({
      accepted: true, adapterId: this.id,
      operationId: request.operationId, fingerprint: request.fingerprint,
      receiptId: "mock:" + request.operationId
    });
  }
  async inspect(receipt, request) {
    return {
      status: this.outcome, adapterId: this.id,
      receiptId: receipt.receiptId, operationId: request.operationId,
      fingerprint: request.fingerprint,
      marker: this.outcome === "succeeded" ? request.expectedMarker : null,
      proof: this.outcome === "succeeded" ? expectedMockProof(request) : null
    };
  }
}
