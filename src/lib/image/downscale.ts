import { MAX_IMAGE_BYTES } from "@/lib/validation/chat";

async function decode(
  file: Blob,
): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      /* Safari can decode some formats through an image element instead. */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(
          new Error(
            "This photo couldn’t open. Try a JPEG, PNG, or WebP photo.",
          ),
        );
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Browser-only conversion. Neither the original nor the result is persisted. */
export async function downscale(file: Blob): Promise<Blob> {
  if (!file.size || (file.type && !file.type.startsWith("image/")))
    throw new Error("Choose a photo to attach.");
  const decoded = await decode(file);
  try {
    if (!decoded.width || !decoded.height)
      throw new Error("This photo has no readable dimensions.");
    const scale = Math.min(1, 1024 / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error(
        "Photo processing is unavailable. Try again in another browser.",
      );
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
    if (!blob || !blob.size || blob.type !== "image/jpeg")
      throw new Error("This photo couldn’t be resized. Choose another photo.");
    if (blob.size > MAX_IMAGE_BYTES)
      throw new Error(
        "This photo is still over 1.5 MB after resizing. Choose a smaller photo.",
      );
    return blob;
  } finally {
    decoded.dispose();
  }
}
