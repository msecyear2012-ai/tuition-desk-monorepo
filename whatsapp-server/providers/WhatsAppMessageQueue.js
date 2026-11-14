'use strict';

/**
 * WhatsAppMessageQueue
 * Anti-ban rate-limiting queue that processes outbound WhatsApp messages sequentially
 * with humanized, randomized delays (default 3 to 7 seconds).
 */
class WhatsAppMessageQueue {
  /**
   * @param {Object} [options]
   * @param {number} [options.minDelayMs=3000] - Minimum randomized delay in ms
   * @param {number} [options.maxDelayMs=7000] - Maximum randomized delay in ms
   */
  constructor({ minDelayMs = 3000, maxDelayMs = 7000 } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.queue = [];
    this.isProcessing = false;
  }

  /**
   * Enqueues an async task and returns a Promise resolving with the task's outcome.
   * @param {() => Promise<any>} taskFunction
   * @returns {Promise<any>}
   */
  enqueue(taskFunction) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task: taskFunction, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Processes queued tasks sequentially, enforcing a randomized delay after each task before the next.
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const { task, resolve, reject } = this.queue.shift();

    try {
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      if (this.queue.length > 0) {
        // Apply randomized humanized delay between minDelayMs and maxDelayMs
        const delay =
          Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs + 1)) + this.minDelayMs;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
      this.isProcessing = false;
      this.processQueue();
    }
  }

  /**
   * Returns the count of pending tasks in the queue.
   * @returns {number}
   */
  getPendingCount() {
    return this.queue.length;
  }

  /**
   * Safely flushes and rejects all pending in-memory tasks on graceful server shutdown.
   */
  shutdown() {
    this.isProcessing = false;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item && typeof item.reject === 'function') {
        item.reject(new Error('WhatsApp microservice is shutting down. Pending message dispatch aborted safely.'));
      }
    }
  }
}

module.exports = WhatsAppMessageQueue;
