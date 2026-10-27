"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { downscale } from "@/lib/image/downscale";

export function PhotoInput({
  image,
  disabled,
  onChange,
  onPreparing,
}: {
  image: Blob | undefined;
  disabled: boolean;
  onChange: (image: Blob | undefined) => void;
  onPreparing: (preparing: boolean) => void;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const preview = useRef<HTMLImageElement>(null);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {
    if (!image) return;
    const url = URL.createObjectURL(image);
    if (preview.current) preview.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [image]);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );

  async function choose(file?: File) {
    if (!file) return;
    const current = ++selection.current;
    setPreparing(true);
    onPreparing(true);
    setError("");
    try {
      const result = await downscale(file);
      if (current === selection.current) onChange(result);
    } catch (failure) {
      if (current === selection.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "This photo couldn’t open. Choose another photo to retry.",
        );
    } finally {
      if (current === selection.current) {
        setPreparing(false);
        onPreparing(false);
      }
    }
  }
  return (
    <div className="mb-2">
      {image && (
        <div className="mb-2 flex items-center gap-3">
          {/* Ephemeral object URLs are local previews, not Next image-loader URLs. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={preview}
            width={64}
            height={64}
            alt="Meal photo preview"
            className="h-16 w-16 rounded-xl object-cover"
          />
          <span className="text-sm">Photo ready</span>
          <button
            type="button"
            aria-label="Remove photo"
            disabled={disabled}
            className="chat-icon-button"
            onClick={() => {
              selection.current++;
              setPreparing(false);
              onPreparing(false);
              setError("");
              onChange(undefined);
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <details className="text-sm">
        <summary className="flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-lg px-2 focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]">
          <ImagePlus size={18} />
          Attach photo
        </summary>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="chat-text-button flex items-center gap-2"
            disabled={disabled}
            onClick={() => camera.current?.click()}
          >
            <Camera size={16} />
            Take photo
          </button>
          <button
            type="button"
            className="chat-text-button"
            disabled={disabled}
            onClick={() => library.current?.click()}
          >
            Choose from library
          </button>
        </div>
      </details>
      {[
        {
          ref: camera,
          label: "Take meal photo",
          capture: "environment" as const,
        },
        { ref: library, label: "Choose meal photo", capture: undefined },
      ].map(({ ref, label, capture }) => (
        <input
          key={label}
          ref={ref}
          type="file"
          accept="image/*"
          capture={capture}
          aria-label={label}
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void choose(file);
          }}
        />
      ))}
      {preparing && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Resizing photo…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm">
          {error} Your caption and previous photo are still here. Choose a photo
          to retry.
        </p>
      )}
    </div>
  );
}
