#!/usr/bin/env node

/**
 * Mock DSH headless binary for contract testing.
 *
 * Simulates `dsh --profile headless <message>`:
 * - If message starts with "slow:", waits N ms before responding
 * - Otherwise responds immediately with a mock result
 */

const msg = process.argv.slice(2).join(' ');

if (msg.startsWith('slow:')) {
    const ms = parseInt(msg.slice(5), 10) || 500;
    setTimeout(() => {
        process.stdout.write(JSON.stringify({ text: `mock slow response after ${ms}ms` }));
        process.exit(0);
    }, ms);
} else if (msg) {
    process.stdout.write(JSON.stringify({ text: `mock response to: ${msg}` }));
    process.exit(0);
} else {
    process.stdout.write(JSON.stringify({ text: 'mock empty response' }));
    process.exit(0);
}