import { isCancel } from "@clack/prompts";

export function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    process.exit(1);
  }
}

export function bail(message: string): never {
  throw new Error(message);
}
