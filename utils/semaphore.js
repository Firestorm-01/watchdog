export class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.count++;
  }

  release() {
    this.count--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export const fetchSemaphore = new Semaphore(3);
