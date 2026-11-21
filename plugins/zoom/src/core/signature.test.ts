import { describe, expect, it } from "vitest";
import { signMeetingSdkJwt } from "./signature.ts";

describe("signMeetingSdkJwt", () => {
  it("matches a JWT computed independently for fixed inputs", async () => {
    // Issued 30 s in the past (clock skew), valid for two hours, with WebRTC video on:
    // the call page has no SharedArrayBuffer, and without it Zoom shows video only over WebRTC.
    const jwt = await signMeetingSdkJwt({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      meetingNumber: "1234567890",
      role: 1,
      nowSeconds: 1700000030,
    });
    expect(jwt).toBe(EXPECTED);
  });
});

const EXPECTED = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBLZXkiOiJ0ZXN0LWNsaWVudC1pZCIsIm1uIjoiMTIzNDU2Nzg5MCIsInJvbGUiOjEsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDA3MjAwLCJ0b2tlbkV4cCI6MTcwMDAwNzIwMCwidmlkZW9fd2VicnRjX21vZGUiOjF9.AC9vmyQxa79tgqk_NnQ3IACGdsSACE35MPtUSaWoU8A";
