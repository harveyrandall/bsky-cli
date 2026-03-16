import { describe, it, expect, vi, beforeEach } from "vitest";

describe("promptPassword", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads from stdin when piped (non-TTY)", async () => {
    // Mock stdin as non-TTY
    const mockStdin = {
      isTTY: false,
    };

    vi.mock("node:process", () => ({
      stdin: mockStdin,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    }));

    const mockRl = {
      question: vi.fn().mockResolvedValue("piped-password"),
      close: vi.fn(),
    };

    vi.mock("node:readline/promises", () => ({
      createInterface: vi.fn(() => mockRl),
    }));

    const { promptPassword } = await import("./auth");
    const result = await promptPassword();
    expect(result).toBe("piped-password");
    expect(mockRl.close).toHaveBeenCalled();
  });
});

describe("prompt2FA", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("prompts for 2FA code and returns trimmed input", async () => {
    const mockRl = {
      question: vi.fn().mockResolvedValue("  123456  "),
      close: vi.fn(),
    };

    vi.mock("node:readline/promises", () => ({
      createInterface: vi.fn(() => mockRl),
    }));

    vi.mock("node:process", () => ({
      stdin: { isTTY: true },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    }));

    const { prompt2FA } = await import("./auth");
    const result = await prompt2FA();
    expect(result).toBe("123456");
    expect(mockRl.close).toHaveBeenCalled();
  });
});
