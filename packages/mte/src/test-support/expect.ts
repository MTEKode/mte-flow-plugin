// Minimal expect() over node:assert so the ported vitest cases keep their assertions verbatim (node:test has no expect).
import assert from 'node:assert/strict'

class Matcher {
  test: (actual: unknown) => boolean
  constructor(test: (actual: unknown) => boolean) {
    this.test = test
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Structural equality; `subset` makes extra keys on `actual` acceptable (toMatchObject / objectContaining). */
function matches(actual: unknown, expected: unknown, subset: boolean): boolean {
  if (expected instanceof Matcher) {
    return expected.test(actual)
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => matches(actual[index], entry, subset))
    )
  }
  if (isRecord(expected)) {
    if (!isRecord(actual) || Array.isArray(actual)) {
      return false
    }
    const expectedKeys = Object.keys(expected).filter((key) => expected[key] !== undefined)
    const actualKeys = Object.keys(actual).filter((key) => actual[key] !== undefined)
    if (!subset && actualKeys.length !== expectedKeys.length) {
      return false
    }
    return expectedKeys.every((key) => matches(actual[key], expected[key], subset))
  }
  return Object.is(actual, expected)
}

function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value)
}

function check(pass: boolean, negate: boolean, message: string): void {
  assert.ok(negate ? !pass : pass, `${negate ? 'expected NOT: ' : ''}${message}`)
}

function throwsWith(fn: () => unknown, expected: unknown): boolean {
  try {
    fn()
  } catch (error) {
    if (expected === undefined) {
      return true
    }
    if (typeof expected === 'function') {
      return error instanceof expected
    }
    const message = error instanceof Error ? error.message : String(error)
    return expected instanceof RegExp ? expected.test(message) : message.includes(String(expected))
  }
  return false
}

function assertions(actual: any, negate: boolean) {
  return {
    toBe: (expected: unknown) =>
      check(Object.is(actual, expected), negate, `${show(actual)} to be ${show(expected)}`),
    toEqual: (expected: unknown) =>
      check(matches(actual, expected, false), negate, `${show(actual)} to equal ${show(expected)}`),
    toMatchObject: (expected: unknown) =>
      check(matches(actual, expected, true), negate, `${show(actual)} to match ${show(expected)}`),
    toBeNull: () => check(actual === null, negate, `${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, negate, `${show(actual)} to be undefined`),
    toHaveLength: (length: number) =>
      check(actual?.length === length, negate, `${show(actual)} to have length ${length}`),
    toContain: (item: unknown) =>
      check(actual.includes(item), negate, `${show(actual)} to contain ${show(item)}`),
    toMatch: (pattern: RegExp | string) =>
      check(
        typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual),
        negate,
        `${show(actual)} to match ${String(pattern)}`
      ),
    toBeGreaterThan: (n: number) => check(actual > n, negate, `${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check(actual >= n, negate, `${actual} >= ${n}`),
    toBeInstanceOf: (ctor: Function) =>
      check(actual instanceof ctor, negate, `${show(actual)} to be instance of ${ctor.name}`),
    toThrow: (expected?: unknown) =>
      check(throwsWith(actual, expected), negate, `function to throw ${String(expected ?? '')}`),
    // Spies are node:test mocks.
    toHaveBeenCalled: () => check(actual.mock.callCount() > 0, negate, 'spy to have been called'),
    toHaveBeenCalledTimes: (n: number) =>
      check(actual.mock.callCount() === n, negate, `spy called ${actual.mock.callCount()}x, not ${n}x`)
  }
}

export function expect(actual: unknown) {
  return {
    ...assertions(actual, false),
    not: assertions(actual, true),
    rejects: {
      toThrow: async (expected?: unknown) => {
        const promise = typeof actual === 'function' ? actual() : actual
        await assert.rejects(Promise.resolve(promise), (error: unknown) =>
          throwsWith(() => {
            throw error
          }, expected)
        )
      }
    }
  }
}

expect.objectContaining = (expected: Record<string, unknown>) =>
  new Matcher((actual) => matches(actual, expected, true))
expect.any = (ctor: Function) =>
  new Matcher((actual) => {
    if (ctor === String) return typeof actual === 'string'
    if (ctor === Number) return typeof actual === 'number'
    if (ctor === Boolean) return typeof actual === 'boolean'
    return actual instanceof ctor
  })
