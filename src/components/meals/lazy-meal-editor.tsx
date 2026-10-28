"use client";
import dynamic from "next/dynamic";
import { LoadingSkeleton } from "@/components/shared/loading-skeleton";

export const MealEditor = dynamic(
  () => import("./meal-editor").then((module) => module.MealEditor),
  {
    loading: () => (
      <LoadingSkeleton label="Opening meal editor…" className="p-5" />
    ),
  },
);
