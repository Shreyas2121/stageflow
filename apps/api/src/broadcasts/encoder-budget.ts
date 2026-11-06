// In-process recording slots. A full budget rejects the attempt; it does not queue work.
export class EncoderBudget {
  private inUse = 0;
  private readonly byPrincipal = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly principalLimit: number,
  ) {}

  get active(): number {
    return this.inUse;
  }

  get principals(): number {
    return this.byPrincipal.size;
  }

  tryAcquire(principalId: string): (() => void) | null {
    if (!principalId) return null;
    const owned = this.byPrincipal.get(principalId) ?? 0;
    if (this.inUse >= this.globalLimit || owned >= this.principalLimit) return null;
    this.inUse += 1;
    this.byPrincipal.set(principalId, owned + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= 1;
      const next = (this.byPrincipal.get(principalId) ?? 1) - 1;
      if (next <= 0) this.byPrincipal.delete(principalId);
      else this.byPrincipal.set(principalId, next);
    };
  }
}
