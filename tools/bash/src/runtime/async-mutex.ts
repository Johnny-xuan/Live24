export class AsyncMutex {
  #locked = false;
  #waiters: Array<() => void> = [];

  get isLocked(): boolean {
    return this.#locked;
  }

  async acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return () => this.#release();
    }

    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return () => this.#release();
  }

  tryAcquire(): (() => void) | undefined {
    if (this.#locked) return undefined;
    this.#locked = true;
    return () => this.#release();
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#locked = false;
  }
}
