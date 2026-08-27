/**
 * conversation-queue.js — Per-conversation FIFO message serialization.
 *
 * Problem:
 * When a WhatsApp contact sends multiple messages in rapid succession,
 * asynchronous handlers (especially those calling AI/Gemini or awaiting
 * database operations) can finish out-of-order. This leads to swapped replies,
 * race conditions in conversation state, and corrupted message history.
 *
 * Solution:
 * This module provides an in-memory sequential task queue per (userId, phone).
 * All messages belonging to the SAME conversation execute strictly in FIFO
 * order, while different conversations and different tenants execute in full
 * parallel concurrency.
 */

const MAX_QUEUE_PER_CHAT = 20; // Max pending messages queued for a single chat
const DEFAULT_TASK_TIMEOUT_MS = 45000;

class ConversationQueue {
    constructor() {
        // key: `${userId}:${phone}` -> { chain: Promise, depth: number }
        this.queues = new Map();
    }

    /**
     * Enqueues a task for a specific (userId, phone) conversation.
     * Guarantees FIFO execution order per conversation.
     *
     * @param {string|number} userId
     * @param {string} phone
     * @param {Function} taskFn - async function to execute
     * @param {number} timeoutMs - max time allowed for this task
     * @returns {Promise<any>} resolves/rejects with the result of taskFn
     */
    enqueue(userId, phone, taskFn, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
        const uid = Number(userId) || 1;
        const cleanPhone = String(phone || '').replace(/\D/g, '') || 'default';
        const key = `${uid}:${cleanPhone}`;
        let queue = this.queues.get(key);

        if (!queue) {
            queue = { chain: Promise.resolve(), depth: 0 };
            this.queues.set(key, queue);
        }

        if (queue.depth >= MAX_QUEUE_PER_CHAT) {
            const err = new Error(`Conversation message queue full (${MAX_QUEUE_PER_CHAT} messages in flight)`);
            err.code = 'QUEUE_OVERFLOW';
            return Promise.reject(err);
        }

        queue.depth++;

        // Wrap execution with timeout & guarantee next task runs even if current throws
        const taskPromise = new Promise((resolve, reject) => {
            queue.chain = queue.chain.then(async () => {
                let timer = null;
                try {
                    const timeoutPromise = new Promise((_, rej) => {
                        timer = setTimeout(() => {
                            const tErr = new Error(`Conversation task timed out after ${timeoutMs}ms`);
                            tErr.code = 'TASK_TIMEOUT';
                            rej(tErr);
                        }, timeoutMs);
                        if (timer.unref) timer.unref();
                    });

                    const result = await Promise.race([taskFn(), timeoutPromise]);
                    resolve(result);
                } catch (err) {
                    reject(err);
                } finally {
                    if (timer) clearTimeout(timer);
                    queue.depth--;
                    // Clean up map entry if idle to prevent memory leak
                    if (queue.depth <= 0) {
                        this.queues.delete(key);
                    }
                }
            }).catch(() => {
                // Prevent unhandled rejection on the internal chain
                // (the caller's promise already handles its own rejection via taskPromise)
            });
        });

        return taskPromise;
    }

    /**
     * Get queue depth for a specific conversation.
     */
    getDepth(userId, phone) {
        const key = `${userId}:${phone}`;
        return this.queues.get(key)?.depth || 0;
    }

    /**
     * Get total active queues count across the system.
     */
    getActiveConversationsCount() {
        return this.queues.size;
    }

    /**
     * Clear all queues (used during shutdown / testing).
     */
    clear() {
        this.queues.clear();
    }
}

const defaultConversationQueue = new ConversationQueue();

module.exports = {
    ConversationQueue,
    conversationQueue: defaultConversationQueue
};
