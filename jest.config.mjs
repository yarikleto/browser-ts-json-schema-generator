export default {
    testEnvironment: "jsdom",
    testMatch: ["<rootDir>/browser-test/**/*.test.ts"],
    preset: "ts-jest/presets/default-esm",
    extensionsToTreatAsEsm: [".ts"],
    globals: {
        "ts-jest": {
            useESM: true,
            tsconfig: "<rootDir>/tsconfig.jest.json",
        },
    },
    moduleNameMapper: {
        // Allow TS/ESM-style imports in source (ending with .js) to resolve in tests.
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
};
