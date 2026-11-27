import { z } from "zod";

const decimalSize = /^(0|[1-9]\d{0,19})$/;

export const Size = z.string().regex(decimalSize);
export type Size = z.infer<typeof Size>;

function requireSize(size: unknown): Size {
  if (typeof size !== "string" || !decimalSize.test(size)) {
    throw new RangeError("Size must be a non-negative integer of at most 20 digits");
  }
  return size;
}

export function toBig(size: Size): bigint {
  return BigInt(requireSize(size));
}

export function fromBig(value: bigint): Size {
  return requireSize(value.toString());
}

export function addSize(a: Size, b: Size): Size {
  return fromBig(toBig(a) + toBig(b));
}
