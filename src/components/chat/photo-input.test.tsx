// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downscale } from "@/lib/image/downscale";
import { PhotoInput } from "./photo-input";

vi.mock("@/lib/image/downscale", () => ({ downscale: vi.fn() }));
const prepared = new Blob(["jpeg"], { type: "image/jpeg" });
beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:thumbnail");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(downscale).mockResolvedValue(prepared);
});
afterEach(cleanup);
function Harness() {
  const [image, setImage] = useState<Blob>();
  return (
    <PhotoInput
      image={image}
      disabled={false}
      onChange={setImage}
      onPreparing={() => {}}
    />
  );
}
function choose() {
  fireEvent.change(screen.getByLabelText("Choose meal photo"), {
    target: { files: [new File(["raw"], "meal.heic", { type: "image/heic" })] },
  });
}
it("offers separate camera and library inputs, and releases a removed thumbnail", async () => {
  const view = render(<Harness />);
  expect(screen.getByLabelText("Take meal photo").getAttribute("capture")).toBe(
    "environment",
  );
  expect(
    screen.getByLabelText("Choose meal photo").hasAttribute("capture"),
  ).toBe(false);
  expect(
    screen.getByLabelText("Choose meal photo").getAttribute("accept"),
  ).toBe("image/*");
  choose();
  await screen.findByAltText("Meal photo preview");
  fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
  expect(screen.queryByAltText("Meal photo preview")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail");
  choose();
  await screen.findByAltText("Meal photo preview");
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
it("keeps the previous thumbnail when a replacement cannot decode", async () => {
  render(<Harness />);
  choose();
  await screen.findByAltText("Meal photo preview");
  vi.mocked(downscale).mockRejectedValueOnce(new Error("Unsupported format"));
  choose();
  await screen.findByRole("alert");
  expect(screen.getByAltText("Meal photo preview").getAttribute("src")).toBe(
    "blob:thumbnail",
  );
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});
it("ignores a stale decode after a newer selection completes", async () => {
  let finish!: (blob: Blob) => void;
  vi.mocked(downscale).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const changed = vi.fn();
  render(
    <PhotoInput
      image={undefined}
      disabled={false}
      onChange={changed}
      onPreparing={() => {}}
    />,
  );
  choose();
  choose();
  await waitFor(() => expect(changed).toHaveBeenCalledWith(prepared));
  await act(async () => finish(new Blob(["stale"])));
  expect(changed).toHaveBeenCalledOnce();
});
