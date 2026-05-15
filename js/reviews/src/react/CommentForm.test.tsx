import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommentForm } from "./CommentForm.js";

describe("CommentForm", () => {
  it("disables submit when empty and enables when filled", () => {
    const { getByRole } = render(<CommentForm onSubmit={() => {}} />);
    const button = getByRole("button", { name: /comment/i });
    expect(button).toBeDisabled();
    fireEvent.change(getByRole("textbox"), { target: { value: "hi" } });
    expect(button).not.toBeDisabled();
  });

  it("calls onSubmit with trimmed body and clears the input", () => {
    const onSubmit = vi.fn();
    const { getByRole } = render(<CommentForm onSubmit={onSubmit} />);
    fireEvent.change(getByRole("textbox"), { target: { value: "  hi  " } });
    fireEvent.click(getByRole("button", { name: /comment/i }));
    expect(onSubmit).toHaveBeenCalledWith("hi");
    expect(getByRole("textbox")).toHaveValue("");
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = vi.fn();
    const { getByRole } = render(
      <CommentForm onSubmit={() => {}} onCancel={onCancel} />,
    );
    fireEvent.click(getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("uses initialBody when provided", () => {
    const { getByRole } = render(
      <CommentForm onSubmit={() => {}} initialBody="hello" />,
    );
    expect(getByRole("textbox")).toHaveValue("hello");
  });
});
