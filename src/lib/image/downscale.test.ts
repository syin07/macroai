// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downscale } from "./downscale";
import { MAX_IMAGE_BYTES } from "@/lib/validation/chat";

const close = vi.fn();
const drawImage = vi.fn();
let output: Blob | null;
let canvas: HTMLCanvasElement;
beforeEach(() => {
  vi.clearAllMocks();
  output = new Blob(["jpeg"], { type: "image/jpeg" });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 4000, height: 3000, close }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      // Capture the actual canvas to verify the resulting upload dimensions.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      canvas = this;
      return {
        drawImage,
        fillRect: vi.fn(),
        fillStyle: "",
      } as unknown as CanvasRenderingContext2D;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(output),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("compresses a large landscape photo to a 1024 by 768 JPEG", async () => {
  expect(await downscale(new Blob(["original"], { type: "image/png" }))).toBe(
    output,
  );
  expect([canvas.width, canvas.height]).toEqual([1024, 768]);
  expect(canvas.toBlob).toHaveBeenCalledWith(
    expect.any(Function),
    "image/jpeg",
    0.8,
  );
  expect(close).toHaveBeenCalledOnce();
});
it("keeps small photos at their original dimensions", async () => {
  vi.mocked(createImageBitmap).mockResolvedValue({
    width: 100,
    height: 200,
    close,
  } as unknown as ImageBitmap);
  await downscale(new Blob(["photo"]));
  expect([canvas.width, canvas.height]).toEqual([100, 200]);
});
it("rejects oversized compressed output and releases the decoder", async () => {
  output = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], {
    type: "image/jpeg",
  });
  await expect(downscale(new Blob(["photo"]))).rejects.toThrow("over 1.5 MB");
  expect(close).toHaveBeenCalledOnce();
});
it("rejects empty output and releases the decoder", async () => {
  output = null;
  await expect(downscale(new Blob(["photo"]))).rejects.toThrow(
    "couldn’t be resized",
  );
  expect(close).toHaveBeenCalledOnce();
});
it("rejects empty and non-image files before decoding", async () => {
  await expect(downscale(new Blob([]))).rejects.toThrow("Choose a photo");
  await expect(
    downscale(new Blob(["text"], { type: "text/plain" })),
  ).rejects.toThrow("Choose a photo");
  expect(createImageBitmap).not.toHaveBeenCalled();
});
it("falls back to the browser image decoder and revokes its temporary URL", async () => {
  vi.mocked(createImageBitmap).mockRejectedValue(new Error("unsupported"));
  const revoke = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:decode");
  URL.revokeObjectURL = revoke;
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 3000;
      naturalHeight = 4000;
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  await downscale(new Blob(["heic"], { type: "image/heic" }));
  expect([canvas.width, canvas.height]).toEqual([768, 1024]);
  expect(revoke).toHaveBeenCalledWith("blob:decode");
});
