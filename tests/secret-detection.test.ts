import { describe, it, expect } from "vitest";
import { scan } from "../src/secret-detection/index";

describe("Secret Detection Agent", () => {
  it("should detect OpenAI API keys via TruffleHog", async () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const result = await scan(key);
    expect(result.verdict).toBe("secret");
    expect(result.source).toBe("trufflehog");
    expect(result.secret_type).toBe("api_key");
    expect(result.evidence.trufflehog_detector).toBe("openai_api_key");
  });

  it("should detect high-entropy strings as likely secrets via password model", async () => {
    // A string that looks like a password but doesn't match a known API key pattern
    const password = "P@ssw0rd123!456";
    const result = await scan(password);
    expect(result.verdict).toBe("likely_secret");
    expect(result.source).toBe("sap_password_model");
    expect(result.secret_type).toBe("password");
  });

  it("should not flag normal text", async () => {
    const text = "Hello, this is just a normal sentence with no secrets.";
    const result = await scan(text);
    expect(result.verdict).toBe("not_secret");
  });

  it("should detect Stripe API keys", async () => {
    const key = "sk_live_51Mabc123xyz789ABCDEF012";
    const result = await scan(key);
    expect(result.verdict).toBe("secret");
    expect(result.evidence.trufflehog_detector).toBe("stripe_api_key");
  });
  
  it("should handle JWT tokens", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = await scan(jwt);
    expect(result.verdict).toBe("secret");
    expect(result.secret_type).toBe("token");
  });

  it("should not flag normal long text as a secret", async () => {
    const text = "This is a long sentence that should not be detected as an AWS secret key or anything else, even though it is quite long and contains many alphanumeric characters.";
    const result = await scan(text);
    expect(result.verdict).toBe("not_secret");
  });
});
