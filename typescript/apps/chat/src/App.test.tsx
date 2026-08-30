// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./App.js";
import { saveConnection, type ConnectionSummary } from "./api.js";

vi.mock("./api.js", () => ({
  checkHealth: vi.fn(),
  listConnections: vi.fn(),
  listModels: vi.fn(),
  removeConnection: vi.fn(),
  saveConnection: vi.fn(),
  streamChat: vi.fn(),
}));

const connection: ConnectionSummary = {
  id: "production-openai",
  kind: "openai",
  label: "Production OpenAI",
  boundary: "public-cloud",
  baseUrl: "https://api.openai.com/v1",
  hasCredential: true,
  capabilities: ["text-generation"],
};

beforeEach(() => {
  vi.mocked(saveConnection).mockReset();
});

describe("connection editing", () => {
  it("prefills a line and keeps its stored credential when the key is blank", async () => {
    const onConnectionsChange = vi.fn();
    vi.mocked(saveConnection).mockResolvedValue({
      ...connection,
      label: "Primary OpenAI",
    });
    render(
      <ConnectionsPage
        connections={[connection]}
        onConnectionsChange={onConnectionsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit line" }));

    expect(
      screen.getByRole("heading", { name: "Edit Production OpenAI" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Provider") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText(/Connection ID/) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("API key") as HTMLInputElement).placeholder,
    ).toBe("Leave blank to keep the stored key");

    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Primary OpenAI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(saveConnection).toHaveBeenCalledWith({
        id: "production-openai",
        kind: "openai",
        label: "Primary OpenAI",
        boundary: "public-cloud",
        baseUrl: "https://api.openai.com/v1",
      });
    });
    expect(onConnectionsChange).toHaveBeenCalledWith([
      { ...connection, label: "Primary OpenAI" },
    ]);
  });
});
