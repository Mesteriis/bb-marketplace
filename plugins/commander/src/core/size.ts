import { z } from "zod";

const decimalSize = /^(0|[1-9]\d{0,19})$/;

export const Size = z.string().regex(decimalSize);
export type Size = z.infer<typeof Size>;

export function toBig(size: Size): bigint {
  return BigInt(size);
}

export function fromBig(value: bigint): Size {
  const size = value.toString();
  if (!decimalSize.test(size)) {
    throw new RangeError("Size must be a non-negative integer of at most 20 digits");
  }
  return size;
}

export function addSize(a: Size, b: Size): Size {
  return fromBig(toBig(a) + toBig(b));
}
