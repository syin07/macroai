"use client";

import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

// Local browser preview only; account appearance preferences are implemented in A12.
export function ThemePreview() {
  const { setTheme } = useTheme();
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Theme preview"
    >
      <span className="mr-2 text-sm text-muted-foreground">Theme preview</span>
      {(["light", "dark", "system"] as const).map((theme) => (
        <Button key={theme} variant="outline" onClick={() => setTheme(theme)}>
          Preview {theme} theme
        </Button>
      ))}
    </div>
  );
}
