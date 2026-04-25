/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    // Resolve .js extensions in TypeScript imports to .ts source files
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
}
