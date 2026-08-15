module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: ['src/**/*.js'],
    coverageDirectory: 'coverage',
    verbose: true,
    testTimeout: 30000,
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
    moduleFileExtensions: ['js', 'json'],
    transform: {},

    // Replace the real whatsapp-web.js everywhere it is required.
    //
    // This keeps src/whatsapp-client.js — session isolation, SSE caps,
    // backoff, JID construction — under test while removing Chrome, the
    // network, and ~20 seconds per launch from the suite. See
    // tests/mocks/whatsapp-web.js for why the seam is here and not around
    // our own module.
    moduleNameMapper: {
        '^whatsapp-web\\.js$': '<rootDir>/tests/mocks/whatsapp-web.js'
    },

    // Each test file gets a clean module registry, which matters because
    // src/database.js, src/auth.js and the rate limiter all hold state in
    // module scope. Without this, one file's users and buckets leak into the
    // next and failures become order-dependent.
    resetModules: true,

    // Surface a handle leak (an un-unref'd timer, an open SSE response, a
    // socket) as a warning instead of a silent 30s hang at the end of a run.
    detectOpenHandles: false,
    forceExit: false,

    // Serial by default. Several suites benchmark timing (event-loop lag,
    // login timing equalisation, persistence latency); running them in
    // parallel on a loaded machine produces flaky numbers rather than useful
    // signal. Override with --maxWorkers when iterating locally.
    maxWorkers: 1
};
