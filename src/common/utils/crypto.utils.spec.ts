import { decryptSecret, encryptSecret } from "./crypto.utils";

describe("crypto.utils", () => {
  const KEY = "unit-test-encryption-key";

  describe("encryptSecret / decryptSecret", () => {
    it("round-trips a plaintext secret", () => {
      const plainText = "JBSWY3DPEHPK3PXP";
      const encrypted = encryptSecret(plainText, KEY);

      expect(encrypted).not.toBe(plainText);
      expect(decryptSecret(encrypted, KEY)).toBe(plainText);
    });

    it("produces a different ciphertext each time (random IV) even for the same input", () => {
      const plainText = "same-secret";
      const first = encryptSecret(plainText, KEY);
      const second = encryptSecret(plainText, KEY);

      expect(first).not.toBe(second);
      expect(decryptSecret(first, KEY)).toBe(plainText);
      expect(decryptSecret(second, KEY)).toBe(plainText);
    });

    it("throws when decrypting with the wrong key (GCM auth tag mismatch)", () => {
      const encrypted = encryptSecret("top-secret", KEY);

      expect(() => decryptSecret(encrypted, "a-different-key")).toThrow();
    });

    it("throws when the ciphertext has been tampered with", () => {
      const encrypted = encryptSecret("top-secret", KEY);
      const [iv, authTag, data] = encrypted.split(":");
      const tamperedData =
        data.slice(0, -2) + (data.slice(-2) === "00" ? "11" : "00");
      const tampered = [iv, authTag, tamperedData].join(":");

      expect(() => decryptSecret(tampered, KEY)).toThrow();
    });

    it("throws on malformed ciphertext (missing segments)", () => {
      expect(() => decryptSecret("not-a-valid-payload", KEY)).toThrow(
        "Malformed encrypted payload"
      );
    });
  });
});
