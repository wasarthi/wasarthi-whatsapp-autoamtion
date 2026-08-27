const { ConversationQueue } = require('../src/utils/conversation-queue');

describe('ConversationQueue (Message Ordering & Concurrency Isolation)', () => {
    let queue;

    beforeEach(() => {
        queue = new ConversationQueue();
    });

    afterEach(() => {
        queue.clear();
    });

    test('executes tasks sequentially in strict FIFO order for the same conversation', async () => {
        const executionOrder = [];
        const userId = 1;
        const phone = '919876543210';

        const p1 = queue.enqueue(userId, phone, async () => {
            await new Promise(r => setTimeout(r, 60));
            executionOrder.push('msg1');
            return 'res1';
        });

        const p2 = queue.enqueue(userId, phone, async () => {
            await new Promise(r => setTimeout(r, 20));
            executionOrder.push('msg2');
            return 'res2';
        });

        const p3 = queue.enqueue(userId, phone, async () => {
            executionOrder.push('msg3');
            return 'res3';
        });

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        expect(r1).toBe('res1');
        expect(r2).toBe('res2');
        expect(r3).toBe('res3');
        // Despite msg2 having a shorter delay than msg1, msg1 MUST complete before msg2 starts
        expect(executionOrder).toEqual(['msg1', 'msg2', 'msg3']);
    });

    test('executes different conversations concurrently in parallel', async () => {
        const events = [];

        // Conversation A (slow)
        const pA = queue.enqueue(1, '911111111111', async () => {
            events.push('A:start');
            await new Promise(r => setTimeout(r, 80));
            events.push('A:end');
            return 'A';
        });

        // Conversation B (fast, different phone)
        const pB = queue.enqueue(1, '922222222222', async () => {
            events.push('B:start');
            await new Promise(r => setTimeout(r, 20));
            events.push('B:end');
            return 'B';
        });

        await Promise.all([pA, pB]);

        // Conversation B should finish before Conversation A ends, showing parallel execution
        expect(events[0]).toBe('A:start');
        expect(events[1]).toBe('B:start');
        expect(events[2]).toBe('B:end');
        expect(events[3]).toBe('A:end');
    });

    test('continues processing subsequent tasks if an earlier task throws', async () => {
        const userId = 1;
        const phone = '919876543210';
        const executionOrder = [];

        const p1 = queue.enqueue(userId, phone, async () => {
            executionOrder.push('task1_failed');
            throw new Error('AI API Error');
        });

        const p2 = queue.enqueue(userId, phone, async () => {
            executionOrder.push('task2_success');
            return 'recovered';
        });

        await expect(p1).rejects.toThrow('AI API Error');
        const r2 = await p2;

        expect(r2).toBe('recovered');
        expect(executionOrder).toEqual(['task1_failed', 'task2_success']);
        expect(queue.getDepth(userId, phone)).toBe(0);
    });

    test('enforces task timeout and recovers the queue', async () => {
        const userId = 1;
        const phone = '919876543210';

        const p1 = queue.enqueue(userId, phone, async () => {
            await new Promise(r => setTimeout(r, 200));
            return 'too_slow';
        }, 50); // 50ms timeout

        const p2 = queue.enqueue(userId, phone, async () => {
            return 'next_task';
        });

        await expect(p1).rejects.toThrow(/timed out/);
        const r2 = await p2;
        expect(r2).toBe('next_task');
    });

    test('cleans up queue map entry once idle to prevent memory leaks', async () => {
        const userId = 1;
        const phone = '919876543210';

        await queue.enqueue(userId, phone, async () => 'done');

        expect(queue.getActiveConversationsCount()).toBe(0);
        expect(queue.getDepth(userId, phone)).toBe(0);
    });
});
