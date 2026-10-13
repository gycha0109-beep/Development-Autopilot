// Phase 2 intentionally uses a no-side-effect mock executor.
// Real AI coding execution will require a separate permission-reviewed adapter.
export class MockExecutor {
  async submit(operation) {
    return { accepted: true, simulated: true, operationId: operation.operationId };
  }
}

export class LocalScheduler {
  constructor(store, { executor = new MockExecutor(), now = () => Date.now(), authorizeClaim = () => true } = {}) {
    this.store = store;
    this.executor = executor;
    this.now = now;
    this.authorizeClaim = authorizeClaim;
  }
  // Each tick independently checks workstreams. A running operation never gets resent.
  async tick() {
    const results = [];
    for (const item of this.store.list()) {
      const at = this.now();
      if (item.mode === "observe") {
        const inspected = this.store.observeDue(item.id, at);
        if (inspected) results.push(inspected);
        continue;
      }
      // The optional policy gate can only restrict mock submissions; it never grants real execution.
      if (this.authorizeClaim(item, at) !== true) continue;
      // Database transaction reserves each task revision before any await or side effect.
      const operation = this.store.claimDue(item.id, at);
      if (!operation) continue;
      try {
        const response = await this.executor.submit(operation);
        if (!response || response.accepted !== true) {
          throw new Error("Mock executor did not acknowledge the command.");
        }
        this.store.acknowledged(operation.operationId, this.now());
        results.push({
          kind: "simulated-dispatch",
          operationId: operation.operationId,
          workstreamId: operation.workstreamId,
          state: "WAIT_EXTERNAL"
        });
      } catch (error) {
        // If the process was interrupted between submit and acknowledgment, the
        // startup reconciler keeps UNKNOWN until manually resolved.
        try {
          this.store.resolve(operation.operationId, "failed", this.now());
        } catch {
          // Another handler may have already resolved it.
        }
        results.push({
          kind: "simulation-error",
          operationId: operation.operationId,
          workstreamId: operation.workstreamId,
          error: String(error.message || error)
        });
      }
    }
    return results;
  }
}
