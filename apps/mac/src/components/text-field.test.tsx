import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { TextField } from "./text-field.js";

afterEach(cleanup);

test("replaces the field hint with a validation error", () => {
  const { rerender } = render(
    <TextField label="Email" hint="Use your work email." />,
  );

  expect(
    screen.getByRole("textbox", {
      name: "Email",
      description: "Use your work email.",
    }),
  ).toBeTruthy();

  rerender(
    <TextField
      label="Email"
      hint="Use your work email."
      error="Enter a valid email address."
    />,
  );

  expect(screen.getByRole("alert").textContent).toContain(
    "Enter a valid email address.",
  );
  expect(screen.queryByText("Use your work email.")).toBeNull();
  expect(
    screen.getByRole("textbox", {
      name: "Email",
      description: "Enter a valid email address.",
    }),
  ).toBeTruthy();
});
