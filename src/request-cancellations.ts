/** Stateless callers may share a key. Ambiguous IDs are never used to cancel multiple requests. */
export class RequestCancellations {
  private readonly active = new Map<string, Set<AbortController>>();

  track(owner: string, id: unknown) {
    const controller = new AbortController();
    const key = this.key(owner, id);
    if (key) {
      const requests = this.active.get(key) ?? new Set<AbortController>();
      requests.add(controller);
      this.active.set(key, requests);
    }
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      finish: () => {
        if (!key) return;
        const requests = this.active.get(key);
        requests?.delete(controller);
        if (!requests?.size) this.active.delete(key);
      },
    };
  }

  cancel(owner: string, id: unknown): boolean {
    const key = this.key(owner, id);
    const requests = key ? this.active.get(key) : undefined;
    if (requests?.size !== 1) return false;
    requests.values().next().value!.abort();
    return true;
  }

  close() {
    for (const requests of this.active.values()) for (const request of requests) request.abort();
    this.active.clear();
  }

  private key(owner: string, id: unknown) {
    return (typeof id === 'string' && id.length <= 512) ||
      (typeof id === 'number' && Number.isFinite(id))
      ? JSON.stringify([owner, id])
      : undefined;
  }
}
